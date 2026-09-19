import type {
  Category,
  Expense,
  PaymentSource,
  PrismaClient,
  WasteTag,
} from "@/generated/prisma/client";

import { addDaysToDate, getCurrentDate, getMonthDateRange, toDbDate } from "@/lib/expense-date";
import type { ExpenseListFilter } from "@/lib/expense-filter";
import {
  dedupeStoreNames,
  QUICK_PICK_CATEGORY_LIMIT,
  QUICK_PICK_WINDOW_DAYS,
  RECENT_STORE_NAME_LIMIT,
  RECENT_STORE_NAME_SCAN_LIMIT,
  selectQuickPickCategoryIds,
} from "@/lib/expense-suggestions";
import {
  EXPENSE_AMOUNT_MAX_YEN,
  EXPENSE_AMOUNT_MIN_YEN,
  isWasteTag,
} from "@/lib/expense-validation";
import type { UserId } from "@/lib/user-id";
import { isYearMonth } from "@/lib/year-month";

/**
 * 支出のデータ層。
 *
 * PrismaClient は引数で受け取る（src/lib/payment-sources.ts と同じ方針）。
 * このモジュールはサーバー専用で、Client Component から import しないこと。
 *
 * **月の絞り込みは `@db.Date` を UTC 深夜で範囲指定する**
 * （src/lib/expense-date.ts の getMonthDateRange。JST の +9 時間を足さない）。
 *
 * **全操作を userId で絞る（docs/steps/pub-1.md 設計判断 6）。** 取得・更新・削除は
 * `where: { id, userId }`、一覧・サジェストの集計も `where` に userId を付ける。
 * 他人の支出IDには、存在しないIDと同じ notFound を返す。
 * 登録・更新で受け取る categoryId / paymentSourceId は、その利用者のものか先に確認する
 * （DB の複合外部キーでも拒否されるが、どちらが悪いかを文言で返すため）。
 *
 * 失敗は例外ではなく { ok: false, error } で返す。
 */

export type ExpenseResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** 一覧・編集画面で使う、カテゴリと払い出し先を含んだ支出 */
export type ExpenseWithRelations = Expense & {
  category: Category;
  paymentSource: PaymentSource;
};

/** 操作を拒否したときに画面へ出す文言 */
export const EXPENSE_ERRORS = {
  notFound: "対象の支出が見つかりません。",
  invalidYearMonth: "対象月の指定が不正です。",
  invalidDate: "日付が不正です。",
  invalidAmount: "金額が不正です。",
  invalidWasteTag: "必要 / 浪費 / 投資 の指定が不正です。",
  categoryNotFound: "選択したカテゴリが見つかりません。",
  paymentSourceNotFound: "選択した払い出し先が見つかりません。",
} as const;

/**
 * Prisma のエラーコードを取り出す。
 *
 * ドライバアダプタ経由では従来と異なるコードが返る（docs/steps/step-2.md の実測）。
 * - 参照先が無い / 参照がある行の削除 → P2039（P2003 ではない）
 */
function getPrismaErrorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  const code = (error as { code: unknown }).code;
  return typeof code === "string" ? code : null;
}

/** 保存できる金額か（整数円・1〜99,999,999） */
function isStorableAmount(amountYen: number): boolean {
  return (
    Number.isInteger(amountYen) &&
    amountYen >= EXPENSE_AMOUNT_MIN_YEN &&
    amountYen <= EXPENSE_AMOUNT_MAX_YEN
  );
}

/**
 * 一覧を取得する。
 *
 * - 月の範囲は UTC 深夜で組み立てる（getMonthDateRange）
 * - 並べ替えは日付の新しい順（既定）か金額の高い順。
 *   同値のときの順序が揺れないよう createdAt / id を後ろのキーに足す
 */
export async function listExpenses(
  client: PrismaClient,
  userId: UserId,
  filter: ExpenseListFilter,
): Promise<ExpenseResult<ExpenseWithRelations[]>> {
  if (!isYearMonth(filter.yearMonth)) {
    return { ok: false, error: EXPENSE_ERRORS.invalidYearMonth };
  }
  if (filter.wasteTag !== null && !isWasteTag(filter.wasteTag)) {
    return { ok: false, error: EXPENSE_ERRORS.invalidWasteTag };
  }

  const range = getMonthDateRange(filter.yearMonth);

  const expenses = await client.expense.findMany({
    where: {
      userId,
      date: { gte: range.gte, lt: range.lt },
      ...(filter.categoryId ? { categoryId: filter.categoryId } : {}),
      ...(filter.paymentSourceId ? { paymentSourceId: filter.paymentSourceId } : {}),
      ...(filter.wasteTag ? { wasteTag: filter.wasteTag } : {}),
    },
    include: { category: true, paymentSource: true },
    orderBy:
      filter.sort === "amount"
        ? [{ amountYen: "desc" }, { date: "desc" }, { createdAt: "desc" }, { id: "asc" }]
        : [{ date: "desc" }, { createdAt: "desc" }, { id: "asc" }],
  });

  return { ok: true, value: expenses };
}

/** 1件取得（編集画面用）。存在しない・他人の支出なら null */
export async function getExpense(
  client: PrismaClient,
  userId: UserId,
  id: string,
): Promise<ExpenseWithRelations | null> {
  return client.expense.findFirst({
    where: { id, userId },
    include: { category: true, paymentSource: true },
  });
}

/** 登録・更新で受け取る値。date は "YYYY-MM-DD"（UTC 深夜への変換はここで行う） */
export type ExpenseInput = {
  date: string;
  amountYen: number;
  categoryId: string;
  paymentSourceId: string;
  wasteTag: WasteTag;
  storeName: string | null;
  memo: string | null;
};

/** 保存前の共通チェック。問題があればメッセージ、無ければ null */
function checkInput(input: ExpenseInput): string | null {
  if (!isStorableAmount(input.amountYen)) return EXPENSE_ERRORS.invalidAmount;
  if (!isWasteTag(input.wasteTag)) return EXPENSE_ERRORS.invalidWasteTag;
  return null;
}

/**
 * Prisma へ渡すデータへ直す。date は @db.Date 用に UTC 深夜へ変換する。
 * 項目を1つずつ拾う（入力オブジェクトをスプレッドしない。userId が紛れ込む余地を作らないため）。
 * userId はここでは入れない（更新の data に userId を入れないため。作成時に呼び出し側で足す）。
 */
function toExpenseData(input: ExpenseInput) {
  return {
    date: toDbDate(input.date),
    amountYen: input.amountYen,
    categoryId: input.categoryId,
    paymentSourceId: input.paymentSourceId,
    wasteTag: input.wasteTag,
    storeName: input.storeName,
    memo: input.memo,
  };
}

/**
 * 選択されたカテゴリ・払い出し先が、その利用者のものかを確認する。
 * 見つからなければ（他人のものも含む）それぞれの notFound の文言、両方あれば null。
 */
async function checkRelationOwnership(
  client: PrismaClient,
  userId: UserId,
  input: ExpenseInput,
): Promise<string | null> {
  const [category, paymentSource] = await Promise.all([
    client.category.findFirst({
      where: { id: input.categoryId, userId },
      select: { id: true },
    }),
    client.paymentSource.findFirst({
      where: { id: input.paymentSourceId, userId },
      select: { id: true },
    }),
  ]);
  if (!category) return EXPENSE_ERRORS.categoryNotFound;
  if (!paymentSource) return EXPENSE_ERRORS.paymentSourceNotFound;
  return null;
}

/**
 * 参照先が見つからないエラーを利用者向けの文言に直す。
 * 持ち主の確認（checkRelationOwnership）のあとで参照先が消えた場合のフォールバック。
 */
function toRelationError(error: unknown): string | null {
  const code = getPrismaErrorCode(error);
  if (code === "P2003" || code === "P2039" || code === "P2025") {
    // どちらの参照が壊れているかまでは Prisma のコードから判別できないため、
    // 選び直せる側（カテゴリ・払い出し先の両方）を1つの文言で案内する
    return EXPENSE_ERRORS.categoryNotFound;
  }
  return null;
}

/** その利用者の支出として登録する。userId は引数から設定する */
export async function createExpense(
  client: PrismaClient,
  userId: UserId,
  input: ExpenseInput,
): Promise<ExpenseResult<Expense>> {
  const invalid = checkInput(input);
  if (invalid) return { ok: false, error: invalid };

  let data: ReturnType<typeof toExpenseData>;
  try {
    data = toExpenseData(input);
  } catch {
    return { ok: false, error: EXPENSE_ERRORS.invalidDate };
  }

  const ownershipError = await checkRelationOwnership(client, userId, input);
  if (ownershipError) return { ok: false, error: ownershipError };

  try {
    const created = await client.expense.create({ data: { ...data, userId } });
    return { ok: true, value: created };
  } catch (error) {
    const relationError = toRelationError(error);
    if (relationError) return { ok: false, error: relationError };
    throw error;
  }
}

/** 更新する。存在しない・他人の支出なら notFound。userId は更新しない */
export async function updateExpense(
  client: PrismaClient,
  userId: UserId,
  id: string,
  input: ExpenseInput,
): Promise<ExpenseResult<Expense>> {
  const invalid = checkInput(input);
  if (invalid) return { ok: false, error: invalid };

  let data: ReturnType<typeof toExpenseData>;
  try {
    data = toExpenseData(input);
  } catch {
    return { ok: false, error: EXPENSE_ERRORS.invalidDate };
  }

  const ownershipError = await checkRelationOwnership(client, userId, input);
  if (ownershipError) return { ok: false, error: ownershipError };

  try {
    const updated = await client.expense.update({ where: { id, userId }, data });
    return { ok: true, value: updated };
  } catch (error) {
    if (getPrismaErrorCode(error) === "P2025") {
      return { ok: false, error: EXPENSE_ERRORS.notFound };
    }
    const relationError = toRelationError(error);
    if (relationError) return { ok: false, error: relationError };
    throw error;
  }
}

/**
 * 削除する（物理削除）。
 * Expense は他から参照されないので無効化の概念は要らない。
 * 誤タップ対策の2段階確認は画面側の責任（docs/steps/step-5.md）。
 */
export async function deleteExpense(
  client: PrismaClient,
  userId: UserId,
  id: string,
): Promise<ExpenseResult<null>> {
  try {
    await client.expense.delete({ where: { id, userId } });
    return { ok: true, value: null };
  } catch (error) {
    if (getPrismaErrorCode(error) === "P2025") {
      return { ok: false, error: EXPENSE_ERRORS.notFound };
    }
    throw error;
  }
}

export type QuickPickOptions = {
  /** 集計期間（日）。今日を含む直近この日数 */
  windowDays?: number;
  /** 最大件数 */
  limit?: number;
};

/**
 * 直近よく使うカテゴリの id を「よく使う順」で返す。
 *
 * @param orderedCategoryIds 選択肢に出せるカテゴリ id を表示順で並べたもの
 * @param now 現在時刻。今日（JST）を求めるためだけに使う
 *
 * 集計の窓は「今日（JST）を含む直近 windowDays 日」。
 * 支出が1件も無ければ空配列を返す（呼び出し側はクイック選択の枠ごと出さないこと）。
 */
export async function listQuickPickCategoryIds(
  client: PrismaClient,
  userId: UserId,
  orderedCategoryIds: readonly string[],
  now: Date,
  options: QuickPickOptions = {},
): Promise<string[]> {
  const windowDays = options.windowDays ?? QUICK_PICK_WINDOW_DAYS;
  const limit = options.limit ?? QUICK_PICK_CATEGORY_LIMIT;
  if (orderedCategoryIds.length === 0 || limit <= 0 || windowDays <= 0) return [];

  // 今日（JST）を求めてから、日付そのものの計算は UTC 深夜で行う
  const today = getCurrentDate(now);
  const gte = toDbDate(addDaysToDate(today, -(windowDays - 1)));
  const lt = toDbDate(addDaysToDate(today, 1));

  const rows = await client.expense.findMany({
    where: { userId, date: { gte, lt } },
    select: { categoryId: true },
  });

  return selectQuickPickCategoryIds(
    rows.map((row) => row.categoryId),
    orderedCategoryIds,
    limit,
  );
}

export type RecentStoreNameOptions = {
  /** 返す最大件数 */
  limit?: number;
  /** 候補を拾うために遡って読む支出の件数 */
  scanLimit?: number;
};

/**
 * 直近の店名を、重複を除いて新しい順に返す。
 * 入力欄の datalist に出して2回目以降の入力を短くするためのもの。
 * **その利用者の支出だけから拾う**（他人の店名をサジェストに出さない）。
 */
export async function listRecentStoreNames(
  client: PrismaClient,
  userId: UserId,
  options: RecentStoreNameOptions = {},
): Promise<string[]> {
  const limit = options.limit ?? RECENT_STORE_NAME_LIMIT;
  const scanLimit = options.scanLimit ?? RECENT_STORE_NAME_SCAN_LIMIT;
  if (limit <= 0 || scanLimit <= 0) return [];

  const rows = await client.expense.findMany({
    where: { userId, storeName: { not: null } },
    select: { storeName: true },
    orderBy: [{ date: "desc" }, { createdAt: "desc" }],
    take: scanLimit,
  });

  return dedupeStoreNames(
    rows.map((row) => row.storeName),
    limit,
  );
}
