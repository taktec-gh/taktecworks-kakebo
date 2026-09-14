/**
 * 「2グループ + 上下移動」の並べ替え計算（純粋関数・汎用）。
 *
 * 払い出し先（有効 / 無効）とカテゴリ（表示 / 非表示）は、グループ分けに使うフラグが
 * 違うだけで並べ替えの規則が完全に同じ。同じロジックを2箇所に複製すると
 * 片方だけ壊れる余地が生まれるため、ここに一本化して各モジュールが委譲する
 * （docs/steps/step-4.md「並べ替えロジックは共通化する」）。
 *
 * 共通の規則:
 * - 先に表示するグループ → 後のグループの順。各グループ内は sortOrder 昇順
 * - 移動は同一グループ内のみ。グループの端では移動できない
 * - sortOrder は隙間を作らず 1 からの連番を保つ（結果は常に全件 1..n）
 *
 * DB にも Next.js にも依存しない。反映は各データ層の担当。
 */

/** 並べ替えに必要な最小限の形 */
export type OrderItem = {
  id: string;
  sortOrder: number;
};

export type MoveDirection = "up" | "down";

/** id に対する新しい sortOrder */
export type SortOrderAssignment = {
  id: string;
  sortOrder: number;
};

export type ReorderResult =
  | { ok: true; assignments: SortOrderAssignment[] }
  | { ok: false; error: string };

/** 移動を拒否したときに画面へ出す文言。対象ごとに言葉が違うので外から与える */
export type OrderErrorMessages = {
  notFound: string;
  cannotMoveUp: string;
  cannotMoveDown: string;
  invalidDirection: string;
};

/** 値が MoveDirection か */
export function isMoveDirection(value: unknown): value is MoveDirection {
  return value === "up" || value === "down";
}

export type OrderingOptions<TItem extends OrderItem> = {
  /**
   * 先に表示するグループなら true。
   * 払い出し先は `(item) => item.isActive`、カテゴリは `(item) => !item.isHidden`。
   */
  isPrimaryGroup: (item: TItem) => boolean;
  errors: OrderErrorMessages;
};

export type Ordering<TItem extends OrderItem> = {
  /** 拒否時の文言（呼び出し側が同じ定数を参照できるように公開する） */
  errors: OrderErrorMessages;
  /** 表示順の比較関数。先のグループが前、次に sortOrder 昇順、同値なら id 昇順 */
  compare(a: TItem, b: TItem): number;
  /** 表示順に並べ替えた新しい配列を返す。引数は変更しない */
  sort<T extends TItem>(items: readonly T[]): T[];
  /** 表示順のまま 1 からの連番を割り当てる */
  assignSequentialSortOrder(items: readonly TItem[]): SortOrderAssignment[];
  /** 指定方向へ動かせるか。対象が存在しない場合も false */
  canMove(items: readonly TItem[], id: string, direction: MoveDirection): boolean;
  /** 並べ替え後の sortOrder の割り当て。成功時は一覧の全件を含む */
  calculateReorder(
    items: readonly TItem[],
    id: string,
    direction: MoveDirection,
  ): ReorderResult;
};

/**
 * グループ判定と文言を束ねた並べ替えロジックを作る。
 * 対象ごとに1つだけ作り、モジュールスコープに置いて使い回す。
 */
export function createOrdering<TItem extends OrderItem>(
  options: OrderingOptions<TItem>,
): Ordering<TItem> {
  const { isPrimaryGroup, errors } = options;

  function compare(a: TItem, b: TItem): number {
    const aPrimary = isPrimaryGroup(a);
    const bPrimary = isPrimaryGroup(b);
    if (aPrimary !== bPrimary) return aPrimary ? -1 : 1;
    if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  }

  function sort<T extends TItem>(items: readonly T[]): T[] {
    return [...items].sort(compare);
  }

  /**
   * 入れ替え相手の位置。グループをまたぐ場合と一覧の端に達した場合は null。
   */
  function findSwapPartnerIndex(
    sorted: readonly TItem[],
    index: number,
    direction: MoveDirection,
  ): number | null {
    const partnerIndex = direction === "up" ? index - 1 : index + 1;
    const target = sorted[index];
    const partner = sorted[partnerIndex];
    if (target === undefined || partner === undefined) return null;
    if (isPrimaryGroup(partner) !== isPrimaryGroup(target)) return null;
    return partnerIndex;
  }

  function assignSequentialSortOrder(items: readonly TItem[]): SortOrderAssignment[] {
    return sort(items).map((item, index) => ({ id: item.id, sortOrder: index + 1 }));
  }

  function canMove(
    items: readonly TItem[],
    id: string,
    direction: MoveDirection,
  ): boolean {
    const sorted = sort(items);
    const index = sorted.findIndex((item) => item.id === id);
    if (index < 0) return false;
    return findSwapPartnerIndex(sorted, index, direction) !== null;
  }

  function calculateReorder(
    items: readonly TItem[],
    id: string,
    direction: MoveDirection,
  ): ReorderResult {
    if (!isMoveDirection(direction)) {
      return { ok: false, error: errors.invalidDirection };
    }

    const sorted = sort(items);
    const index = sorted.findIndex((item) => item.id === id);
    if (index < 0) {
      return { ok: false, error: errors.notFound };
    }

    const partnerIndex = findSwapPartnerIndex(sorted, index, direction);
    if (partnerIndex === null) {
      return {
        ok: false,
        error: direction === "up" ? errors.cannotMoveUp : errors.cannotMoveDown,
      };
    }

    const swapped = [...sorted];
    const target = swapped[index];
    const partner = swapped[partnerIndex];
    swapped[index] = partner;
    swapped[partnerIndex] = target;

    return {
      ok: true,
      assignments: swapped.map((item, position) => ({
        id: item.id,
        sortOrder: position + 1,
      })),
    };
  }

  return { errors, compare, sort, assignSequentialSortOrder, canMove, calculateReorder };
}
