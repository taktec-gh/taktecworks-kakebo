/**
 * 払い出し先の並び順の計算（純粋関数）。
 *
 * 計算そのものは src/lib/ordering.ts の汎用モジュールが持つ。ここは
 * 「グループ分けは isActive」「文言は払い出し先向け」を束ねて公開するだけの薄い層
 * （docs/steps/step-4.md「並べ替えロジックは共通化する」。公開インターフェースは Step 3 のまま）。
 *
 * 表示順の規則（docs/steps/step-3.md）:
 * - 「有効」グループ → 「無効」グループの順。各グループ内は sortOrder 昇順
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

/** 並び替えに必要な最小限の形。PaymentSource はこれを満たす */
export type PaymentSourceOrderItem = {
  id: string;
  sortOrder: number;
  isActive: boolean;
};

export type { MoveDirection, ReorderResult, SortOrderAssignment };

export const PAYMENT_SOURCE_ORDER_ERRORS = {
  notFound: "対象の払い出し先が見つかりません。",
  cannotMoveUp: "これ以上、上へ移動できません。",
  cannotMoveDown: "これ以上、下へ移動できません。",
  invalidDirection: "移動方向が不正です。",
} as const;

/** 有効な払い出し先を先に並べる */
const paymentSourceOrdering = createOrdering<PaymentSourceOrderItem>({
  isPrimaryGroup: (source) => source.isActive,
  errors: PAYMENT_SOURCE_ORDER_ERRORS,
});

/** 値が MoveDirection か */
export function isMoveDirection(value: unknown): value is MoveDirection {
  return isMoveDirectionValue(value);
}

/**
 * 表示順の比較関数。
 * 有効が先、次に sortOrder 昇順、同値なら id 昇順（入力順に依らず結果を一定にするため）。
 */
export function comparePaymentSourceOrder(
  a: PaymentSourceOrderItem,
  b: PaymentSourceOrderItem,
): number {
  return paymentSourceOrdering.compare(a, b);
}

/** 表示順に並べ替えた新しい配列を返す。引数は変更しない */
export function sortPaymentSources<T extends PaymentSourceOrderItem>(
  sources: readonly T[],
): T[] {
  return paymentSourceOrdering.sort(sources);
}

/**
 * 表示順のまま 1 からの連番を割り当てる。
 * 既存データに欠番や重複があっても、この結果を反映すれば連番に直る。
 */
export function assignSequentialSortOrder(
  sources: readonly PaymentSourceOrderItem[],
): SortOrderAssignment[] {
  return paymentSourceOrdering.assignSequentialSortOrder(sources);
}

/**
 * 指定方向へ動かせるか。動かせないボタンを非活性にするために使う。
 * 対象が存在しない場合も false。
 */
export function canMovePaymentSource(
  sources: readonly PaymentSourceOrderItem[],
  id: string,
  direction: MoveDirection,
): boolean {
  return paymentSourceOrdering.canMove(sources, id, direction);
}

/**
 * 並べ替え後の sortOrder の割り当てを求める。
 *
 * 成功時の assignments は**一覧の全件**を含む（動かなかった行も連番を保つため）。
 * 失敗時は利用者向けの日本語メッセージを返し、例外は投げない。
 */
export function calculateReorder(
  sources: readonly PaymentSourceOrderItem[],
  id: string,
  direction: MoveDirection,
): ReorderResult {
  return paymentSourceOrdering.calculateReorder(sources, id, direction);
}
