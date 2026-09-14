/**
 * 予算画面の Server Action の状態。
 * "use server" ファイルは async 関数しか export できないため、
 * 型と定数は actions.ts から分離してここに置く（設定画面と同じ構成）。
 */

export type BudgetActionState = {
  /** 失敗時のみメッセージが入る。成功時は null */
  error: string | null;
  /** 保存が成功した直後だけ true。「保存しました」の表示に使う */
  saved: boolean;
};

export const initialBudgetActionState: BudgetActionState = { error: null, saved: false };

/** useActionState に渡せる Server Action の形 */
export type BudgetFormAction = (
  prevState: BudgetActionState,
  formData: FormData,
) => BudgetActionState | Promise<BudgetActionState>;

/** 予算画面 */
export const BUDGETS_PATH = "/budgets";

/** 対象月のクエリ名 */
export const YEAR_MONTH_PARAM = "month";

/** 対象月を指定した予算画面の URL */
export function budgetsPath(yearMonth: string): string {
  return `${BUDGETS_PATH}?${YEAR_MONTH_PARAM}=${encodeURIComponent(yearMonth)}`;
}

/**
 * 払い出し先の金額入力欄の name。
 * 画面（Client Component）と Server Action の両方がこの関数で同じ名前を作る。
 */
export function budgetAmountFieldName(paymentSourceId: string): string {
  return `amount:${paymentSourceId}`;
}

/** カテゴリ予算の金額入力欄の name */
export function categoryBudgetAmountFieldName(categoryId: string): string {
  return `category-amount:${categoryId}`;
}
