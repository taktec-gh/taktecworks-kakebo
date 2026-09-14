/**
 * ダッシュボード（src/app/page.tsx）のパスとクエリ名。
 *
 * 月ナビゲーションと Server Action の revalidatePath が同じ文字列を参照できるよう、
 * ページ本体から分離して置く（予算・支出画面の action-state.ts と同じ役割）。
 */

/** ダッシュボード＝トップ画面 */
export const DASHBOARD_PATH = "/";

/** 対象月のクエリ名 */
export const YEAR_MONTH_PARAM = "month";

/** 対象月を指定したダッシュボードの URL */
export function dashboardPath(yearMonth: string): string {
  return `${DASHBOARD_PATH}?${YEAR_MONTH_PARAM}=${encodeURIComponent(yearMonth)}`;
}
