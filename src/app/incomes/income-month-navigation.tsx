import { MonthNavigation as SharedMonthNavigation } from "@/components/month-navigation";

import { incomesPath } from "./action-state";

export type IncomeMonthNavigationProps = {
  /** 表示中の「受け取った月」 "YYYY-MM" */
  yearMonth: string;
  /** 今月（JST）。表示中の月と違うときだけ「今月へ」を出す */
  currentYearMonth: string;
};

/**
 * 収入画面の月ナビゲーション。
 * 表示そのものは src/components/month-navigation.tsx（予算・支出・ダッシュボードと共通）。
 */
export function IncomeMonthNavigation({
  yearMonth,
  currentYearMonth,
}: IncomeMonthNavigationProps) {
  return (
    <SharedMonthNavigation
      yearMonth={yearMonth}
      currentYearMonth={currentYearMonth}
      hrefForMonth={incomesPath}
    />
  );
}
