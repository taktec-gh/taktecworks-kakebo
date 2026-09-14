/**
 * 収入画面の Server Action の状態とパス。
 * "use server" ファイルは async 関数しか export できないため、
 * 型と定数は actions.ts から分離してここに置く（予算・支出画面と同じ構成）。
 */

export type IncomeActionState = {
  /** 失敗時のみメッセージが入る。成功時は null */
  error: string | null;
  /**
   * 保存に成功した回数。
   *
   * 追加後は画面に留まる（続けて2件目を入れることがある）ため、
   * 「また1件保存された」を画面側が検出して入力欄をクリアできる必要がある。
   * 真偽値だと2件目の保存で値が変わらずクリアが走らない（支出画面と同じ理由）。
   */
  savedCount: number;
};

export const initialIncomeActionState: IncomeActionState = { error: null, savedCount: 0 };

/** useActionState に渡せる Server Action の形 */
export type IncomeFormAction = (
  prevState: IncomeActionState,
  formData: FormData,
) => IncomeActionState | Promise<IncomeActionState>;

/** 収入画面 */
export const INCOMES_PATH = "/incomes";

/** 対象月のクエリ名 */
export const YEAR_MONTH_PARAM = "month";

/** 対象月（＝受け取った月）を指定した収入画面の URL */
export function incomesPath(yearMonth: string): string {
  return `${INCOMES_PATH}?${YEAR_MONTH_PARAM}=${encodeURIComponent(yearMonth)}`;
}
