/**
 * カテゴリの並び順の計算（純粋関数）。
 *
 * 計算そのものは src/lib/ordering.ts の汎用モジュールが持つ。ここは
 * 「グループ分けは isHidden」「文言はカテゴリ向け」を束ねて公開するだけの薄い層
 * （払い出し先と同じロジックを2つ書かないため。docs/steps/step-4.md）。
 *
 * 表示順の規則:
 * - 「表示」グループ → 「非表示」グループの順。各グループ内は sortOrder 昇順
 * - 移動は同一グループ内のみ。グループの端では移動できない
 * - sortOrder は隙間を作らず 1 からの連番を保つ
 */

import {
  createOrdering,
  isMoveDirection as isMoveDirectionValue,
  type MoveDirection,
  type ReorderResult,
  type SortOrderAssignment,
} from "@/lib/ordering";

/** 並び替えに必要な最小限の形。Category はこれを満たす */
export type CategoryOrderItem = {
  id: string;
  sortOrder: number;
  isHidden: boolean;
};

export type { MoveDirection, ReorderResult, SortOrderAssignment };

export const CATEGORY_ORDER_ERRORS = {
  notFound: "対象のカテゴリが見つかりません。",
  cannotMoveUp: "これ以上、上へ移動できません。",
  cannotMoveDown: "これ以上、下へ移動できません。",
  invalidDirection: "移動方向が不正です。",
} as const;

/** 非表示でないカテゴリを先に並べる */
const categoryOrdering = createOrdering<CategoryOrderItem>({
  isPrimaryGroup: (category) => !category.isHidden,
  errors: CATEGORY_ORDER_ERRORS,
});

/** 値が MoveDirection か */
export function isMoveDirection(value: unknown): value is MoveDirection {
  return isMoveDirectionValue(value);
}

/**
 * 表示順の比較関数。
 * 表示中が先、次に sortOrder 昇順、同値なら id 昇順（入力順に依らず結果を一定にするため）。
 */
export function compareCategoryOrder(a: CategoryOrderItem, b: CategoryOrderItem): number {
  return categoryOrdering.compare(a, b);
}

/** 表示順に並べ替えた新しい配列を返す。引数は変更しない */
export function sortCategories<T extends CategoryOrderItem>(categories: readonly T[]): T[] {
  return categoryOrdering.sort(categories);
}

/**
 * 表示順のまま 1 からの連番を割り当てる。
 * 既存データに欠番や重複があっても、この結果を反映すれば連番に直る。
 */
export function assignSequentialCategorySortOrder(
  categories: readonly CategoryOrderItem[],
): SortOrderAssignment[] {
  return categoryOrdering.assignSequentialSortOrder(categories);
}

/**
 * 指定方向へ動かせるか。動かせないボタンを非活性にするために使う。
 * 対象が存在しない場合も false。
 */
export function canMoveCategory(
  categories: readonly CategoryOrderItem[],
  id: string,
  direction: MoveDirection,
): boolean {
  return categoryOrdering.canMove(categories, id, direction);
}

/**
 * 並べ替え後の sortOrder の割り当てを求める。
 *
 * 成功時の assignments は**一覧の全件**を含む（動かなかった行も連番を保つため）。
 * 失敗時は利用者向けの日本語メッセージを返し、例外は投げない。
 */
export function calculateCategoryReorder(
  categories: readonly CategoryOrderItem[],
  id: string,
  direction: MoveDirection,
): ReorderResult {
  return categoryOrdering.calculateReorder(categories, id, direction);
}
