// 分離テスト専用の小さな偽 Prisma クライアント。
//
// tests/app/data-isolation.test.ts から使う。目的は「where の userId を外したら
// 本当に他人の行が返ってくる／書き換わる」ことを直接検出すること。モック
// （toHaveBeenCalledWith で呼び出し引数だけを見る）では、データ層の関数が
// 実際に返す値までは確認できないため、A・B 2人分のデータを持ち、where を
// 実際に解釈するこの偽クライアントを使う（docs/steps/pub-1.md「分離テスト」）。
//
// 対応している操作: findMany / findFirst / findUnique / count / aggregate（_max のみ）/
//   create / update / updateMany / delete / deleteMany / upsert / $transaction
//   （配列を渡す形・コールバックを渡す対話型トランザクションの両方）
// 対応している where 条件: プリミティブの等価比較、{ in: [...] }、{ not: 値 | null }、
//   { gte / lte / gt / lt }（Date・number。日付範囲や大小比較に使う）、
//   1階層のみの複合ユニークキーのグルーピング
//   （例: { paymentSourceId_yearMonth: { paymentSourceId, yearMonth }, userId }）。
//
// **対応していない条件（未知の演算子・配列の where など）は、黙って無視せず例外を投げる。**
// 対応していない条件を無視すると、userId の絞り込みを外しても「たまたま」テストが
// 通ってしまい、分離テストとして意味を持たなくなるため。

type Row = Record<string, unknown>;

export type TableName =
  | "user"
  | "paymentSource"
  | "category"
  | "expense"
  | "budget"
  | "categoryBudget"
  | "income"
  | "credential";

const COMPARISON_OPERATORS = new Set(["in", "not", "gte", "lte", "gt", "lt"]);

/**
 * schema.prisma の @default() に相当する既定値。データ層の create() 呼び出しは
 * 実DBが埋める既定値（例: PaymentSource.isActive）を明示的に渡さないことがあるため、
 * この偽クライアントでも create 時に補う（そうしないと、その後の orderBy で
 * isActive が undefined になり、比較不能で例外になる）。
 */
const TABLE_CREATE_DEFAULTS: Partial<Record<TableName, Row>> = {
  paymentSource: { isActive: true },
};

/** Prisma のエラーコードを模した例外。データ層の getPrismaErrorCode() が拾える形にする */
export class FakePrismaError extends Error {
  code: string;
  constructor(code: string, message: string = code) {
    super(message);
    this.code = code;
    this.name = "FakePrismaError";
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !(value instanceof Date);
}

function compareOrderable(a: unknown, b: unknown): number {
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
  if (typeof a === "number" && typeof b === "number") return a - b;
  return NaN;
}

function matchOperator(value: unknown, op: string, opValue: unknown): boolean {
  switch (op) {
    case "in":
      if (!Array.isArray(opValue)) {
        throw new Error('fake prisma client: "in" の値は配列である必要があります');
      }
      return opValue.includes(value);
    case "not":
      if (opValue === null) return value !== null && value !== undefined;
      return value !== opValue;
    case "gte":
    case "lte":
    case "gt":
    case "lt": {
      const result = compareOrderable(value, opValue);
      if (Number.isNaN(result)) {
        throw new Error(
          `fake prisma client: "${op}" は Date・number の値だけに対応しています`,
        );
      }
      if (op === "gte") return result >= 0;
      if (op === "lte") return result <= 0;
      if (op === "gt") return result > 0;
      return result < 0;
    }
    default:
      // ここに来るのは COMPARISON_OPERATORS に無い演算子が来たとき（本来は呼ばれない）
      throw new Error(`fake prisma client: 未対応の演算子 "${op}" です`);
  }
}

/**
 * 複合ユニークキーのグルーピングとして扱ってよい where のキー名の許可リスト。
 *
 * それ以外のキーでオブジェクトが来た場合は「演算子オブジェクト」として扱い、
 * 未知の演算子（例: startsWith）は例外を投げる。ここを許可リスト方式にしないと、
 * 「amountYen: { startsWith: "1" }」のような未対応の演算子が、たまたま
 * 複合キーのグルーピングとして解釈されてしまい、恒偽（常に false）または
 * 偶然の一致を静かに返してしまう（＝分離テストとして検出力を失う）。
 */
const COMPOSITE_KEY_NAMES = new Set([
  "userId_name",
  "paymentSourceId_yearMonth",
  "categoryId_yearMonth",
]);

function matchCondition(row: Row, key: string, condition: unknown): boolean {
  if (condition === null) return row[key] === null;
  if (Array.isArray(condition)) {
    throw new Error(`fake prisma client: where.${key} に配列は対応していません`);
  }
  if (isPlainObject(condition)) {
    if (COMPOSITE_KEY_NAMES.has(key)) {
      // 複合ユニークキーのグルーピング（例: paymentSourceId_yearMonth: { paymentSourceId, yearMonth }）。
      // サブフィールドを同じ行に対して再帰的に照合する（1階層のみ想定）。
      return matchWhere(row, condition);
    }
    const keys = Object.keys(condition);
    if (keys.length === 0) {
      throw new Error(`fake prisma client: where.${key} が空のオブジェクトです`);
    }
    return keys.every((op) => {
      if (!COMPARISON_OPERATORS.has(op)) {
        throw new Error(`fake prisma client: 未対応の演算子 "${op}"（where.${key}）です`);
      }
      return matchOperator(row[key], op, condition[op]);
    });
  }
  return row[key] === condition;
}

/** where オブジェクト全体を1行に対して評価する。未対応の形は例外を投げる */
export function matchWhere(row: Row, where: Record<string, unknown> | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([key, condition]) => matchCondition(row, key, condition));
}

type OrderByEntry = Record<string, "asc" | "desc">;

function sortRows(rows: Row[], orderBy: OrderByEntry | OrderByEntry[]): Row[] {
  const criteria = Array.isArray(orderBy) ? orderBy : [orderBy];
  const copy = [...rows];
  copy.sort((a, b) => {
    for (const criterion of criteria) {
      const entries = Object.entries(criterion);
      if (entries.length !== 1) {
        throw new Error("fake prisma client: orderBy の各要素は1フィールドだけを想定しています");
      }
      const [field, direction] = entries[0];
      const diff = compareForSort(a[field], b[field]);
      if (diff !== 0) return direction === "asc" ? diff : -diff;
    }
    return 0;
  });
  return copy;
}

function compareForSort(a: unknown, b: unknown): number {
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b);
  if (typeof a === "string" && typeof b === "string") return a < b ? -1 : a > b ? 1 : 0;
  throw new Error("fake prisma client: orderBy に対応していない値の型です");
}

type QueryArgs = {
  where?: Record<string, unknown>;
  orderBy?: OrderByEntry | OrderByEntry[];
  take?: number;
  select?: Record<string, boolean>;
  include?: Record<string, boolean>;
};

function project(client: FakePrismaClient, row: Row, args: QueryArgs): Row {
  let result: Row = { ...row };
  if (args.include) {
    for (const key of Object.keys(args.include)) {
      if (!args.include[key]) continue;
      result = { ...result, [key]: client.resolveRelation(row, key) };
    }
  }
  if (args.select) {
    const projected: Row = {};
    for (const key of Object.keys(args.select)) {
      if (args.select[key]) projected[key] = result[key];
    }
    return projected;
  }
  return result;
}

/**
 * 偽の PrismaClient。テーブルは userId で区別しない単一の配列に全ユーザーの行を混ぜて持つ
 * （複数ユーザーのデータを本物に近い形で1つのテーブルに同居させるのが分離テストの要点）。
 */
export class FakePrismaClient {
  private tables: Record<TableName, Row[]>;
  private idCounters: Partial<Record<TableName, number>> = {};

  constructor(seed: Partial<Record<TableName, Row[]>> = {}) {
    this.tables = {
      user: [],
      paymentSource: [],
      category: [],
      expense: [],
      budget: [],
      categoryBudget: [],
      income: [],
      credential: [],
    };
    for (const [table, rows] of Object.entries(seed)) {
      this.tables[table as TableName] = [...(rows ?? [])];
    }
  }

  private nextId(table: TableName): string {
    const next = (this.idCounters[table] ?? 0) + 1;
    this.idCounters[table] = next;
    return `${table}_gen_${next}`;
  }

  /** include の解決先（この偽クライアントが知っている関連だけに対応する） */
  resolveRelation(row: Row, key: string): Row | undefined {
    if (key === "category") {
      return this.tables.category.find((c) => c.id === row.categoryId);
    }
    if (key === "paymentSource") {
      return this.tables.paymentSource.find((p) => p.id === row.paymentSourceId);
    }
    throw new Error(`fake prisma client: 未対応の include "${key}" です`);
  }

  /** テストの検証用に、指定テーブルの現在の内容のコピーを返す */
  snapshot(table: TableName): Row[] {
    return this.tables[table].map((row) => ({ ...row }));
  }

  private model(table: TableName) {
    const rows = () => this.tables[table];

    const findMany = async (args: QueryArgs = {}): Promise<Row[]> => {
      let matched = rows().filter((row) => matchWhere(row, args.where));
      if (args.orderBy) matched = sortRows(matched, args.orderBy);
      if (args.take !== undefined) matched = matched.slice(0, args.take);
      return matched.map((row) => project(this, row, args));
    };

    const findFirst = async (args: QueryArgs = {}): Promise<Row | null> => {
      let matched = rows().filter((row) => matchWhere(row, args.where));
      if (args.orderBy) matched = sortRows(matched, args.orderBy);
      return matched.length > 0 ? project(this, matched[0], args) : null;
    };

    const count = async (args: QueryArgs = {}): Promise<number> =>
      rows().filter((row) => matchWhere(row, args.where)).length;

    const aggregate = async (args: {
      where?: Record<string, unknown>;
      _max?: Record<string, boolean>;
    }): Promise<{ _max: Record<string, unknown> }> => {
      const matched = rows().filter((row) => matchWhere(row, args.where));
      const _max: Record<string, unknown> = {};
      for (const field of Object.keys(args._max ?? {})) {
        const values = matched
          .map((row) => row[field])
          .filter((v): v is number => typeof v === "number");
        _max[field] = values.length > 0 ? Math.max(...values) : null;
      }
      return { _max };
    };

    const create = async (args: {
      data: Row;
      select?: Record<string, boolean>;
    }): Promise<Row> => {
      const now = new Date();
      const row: Row = {
        id: this.nextId(table),
        createdAt: now,
        updatedAt: now,
        ...(TABLE_CREATE_DEFAULTS[table] ?? {}),
        ...args.data,
      };
      rows().push(row);
      return project(this, row, { select: args.select });
    };

    const update = async (args: { where: Record<string, unknown>; data: Row }): Promise<Row> => {
      const matched = rows().filter((row) => matchWhere(row, args.where));
      if (matched.length === 0) throw new FakePrismaError("P2025", "Record not found");
      Object.assign(matched[0], args.data, { updatedAt: new Date() });
      return project(this, matched[0], {});
    };

    const updateMany = async (args: {
      where?: Record<string, unknown>;
      data: Row;
    }): Promise<{ count: number }> => {
      const matched = rows().filter((row) => matchWhere(row, args.where));
      for (const row of matched) Object.assign(row, args.data, { updatedAt: new Date() });
      return { count: matched.length };
    };

    const del = async (args: { where: Record<string, unknown> }): Promise<Row> => {
      const matched = rows().filter((row) => matchWhere(row, args.where));
      if (matched.length === 0) throw new FakePrismaError("P2025", "Record not found");
      const [target] = matched;
      this.tables[table] = rows().filter((row) => row !== target);
      return project(this, target, {});
    };

    const deleteMany = async (
      args: { where?: Record<string, unknown> } = {},
    ): Promise<{ count: number }> => {
      const matched = rows().filter((row) => matchWhere(row, args.where));
      const matchedSet = new Set(matched);
      this.tables[table] = rows().filter((row) => !matchedSet.has(row));
      return { count: matched.length };
    };

    const upsert = async (args: {
      where: Record<string, unknown>;
      create: Row;
      update: Row;
    }): Promise<Row> => {
      const matched = rows().filter((row) => matchWhere(row, args.where));
      if (matched.length > 0) {
        Object.assign(matched[0], args.update, { updatedAt: new Date() });
        return project(this, matched[0], {});
      }
      const now = new Date();
      const row: Row = {
        id: this.nextId(table),
        createdAt: now,
        updatedAt: now,
        ...args.create,
      };
      rows().push(row);
      return project(this, row, {});
    };

    return {
      findMany,
      findFirst,
      findUnique: findFirst,
      count,
      aggregate,
      create,
      update,
      updateMany,
      delete: del,
      deleteMany,
      upsert,
    };
  }

  get user() {
    return this.model("user");
  }
  get paymentSource() {
    return this.model("paymentSource");
  }
  get category() {
    return this.model("category");
  }
  get expense() {
    return this.model("expense");
  }
  get budget() {
    return this.model("budget");
  }
  get categoryBudget() {
    return this.model("categoryBudget");
  }
  get income() {
    return this.model("income");
  }
  get credential() {
    return this.model("credential");
  }

  /**
   * 配列を渡す形（各要素はすでに実行済みの Promise）と、対話型トランザクション
   * （コールバックに tx を渡す形。この偽クライアントでは tx = this）の両方に対応する。
   */
  async $transaction<T>(
    arg: Promise<T>[] | ((tx: FakePrismaClient) => Promise<T>),
    _options?: unknown,
  ): Promise<T[] | T> {
    if (typeof arg === "function") {
      return arg(this);
    }
    return Promise.all(arg);
  }
}
