import { MonthNavigation as SharedMonthNavigation } from "@/components/month-navigation";

import { budgetsPath } from "./action-state";

export type MonthNavigationProps = {
  /** 表示中の対象月 "YYYY-MM" */
  yearMonth: string;
  /** 今月（JST）。表示中の月と違うときだけ「今月へ」を出す */
  currentYearMonth: string;
};

/**
 * 予算画面の月ナビゲーション。
 *
 * 表示そのものは src/components/month-navigation.tsx が持つ（支出一覧・ダッシュボードと共通）。
 * ここは「リンク先は budgetsPath」だけを与える薄いラッパー
 * （docs/steps/step-6.md「月ナビゲーションを共通化する」。
 *  公開インターフェースと描画結果は Step 4 のまま）。
 */
export function MonthNavigation({ yearMonth, currentYearMonth }: MonthNavigationProps) {
  return (
    <SharedMonthNavigation
      yearMonth={yearMonth}
      currentYearMonth={currentYearMonth}
      hrefForMonth={budgetsPath}
    />
  );
}
