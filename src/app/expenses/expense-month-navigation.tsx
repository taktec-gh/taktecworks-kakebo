import { MonthNavigation } from "@/components/month-navigation";

import { type ExpenseListFilter, withExpenseFilter } from "@/lib/expense-filter";

import { expensesPath } from "./action-state";

export type ExpenseMonthNavigationProps = {
  /** 表示中の絞り込み条件。月以外の条件は移動後も引き継ぐ */
  filter: ExpenseListFilter;
  /** 今月（JST）。表示中の月と違うときだけ「今月へ」を出す */
  currentYearMonth: string;
};

/**
 * 支出一覧の月ナビゲーション。
 *
 * 表示そのものは src/components/month-navigation.tsx が持つ（予算・ダッシュボードと共通）。
 * ここは「リンク先は**絞り込みと並べ替えを引き継いだ** expensesPath」だけを与える薄いラッパー。
 * 「外食だけ」を見たまま月をまたいで比べられるのはこのためで、
 * 他の画面とはここだけが違う（docs/steps/step-6.md「月ナビゲーションを共通化する」。
 * 公開インターフェースと描画結果は Step 5 のまま）。
 */
export function ExpenseMonthNavigation({
  filter,
  currentYearMonth,
}: ExpenseMonthNavigationProps) {
  return (
    <MonthNavigation
      yearMonth={filter.yearMonth}
      currentYearMonth={currentYearMonth}
      hrefForMonth={(yearMonth) => expensesPath(withExpenseFilter(filter, { yearMonth }))}
    />
  );
}
