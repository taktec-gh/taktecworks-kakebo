import type {
  Budget,
  Category,
  CategoryBudget,
  Expense,
  Income,
  PaymentSource,
  PrismaClient,
} from "@/generated/prisma/client";

import { getMonthDateRange } from "@/lib/expense-date";
import { canShiftYearMonth, previousYearMonth } from "@/lib/year-month";

/**
 * ダッシュボードのデータ層。
 *
 * 1画面に必要なものを1関数で集める（src/lib/budgets.ts の getMonthlyBudgetData と同じ流儀）。
 * PrismaClient は引数で受け取る。このモジュールはサーバー専用。
 *
 * 集計そのものは行わない。計算は純粋関数（src/lib/dashboard.ts）の担当。
 */

export type DashboardData = {
  yearMonth: string;
  /** 有効・無効を含む全件（無効な払い出し先に残った予算・支出も出すため） */
  paymentSources: PaymentSource[];
  /** 表示・非表示を含む全件 */
  categories: Category[];
  budgets: Budget[];
  categoryBudgets: CategoryBudget[];
  /** その月の全支出 */
  expenses: Expense[];
  /** 表示中の月に受け取った収入（新しい順） */
  incomes: Income[];
  /** 前月に受け取った収入。前月が扱える範囲の外なら空配列 */
  previousMonthIncomes: Income[];
};

/**
 * ダッシュボード1画面ぶんのデータをまとめて取得する。
 *
 * - 月の範囲は getMonthDateRange（**UTC 深夜**で組み立てる。ここに +9h を足さない。
 *   `@db.Date` は UTC 深夜の Date として読み書きされる）
 * - 前月を求める前に canShiftYearMonth で確認する。previousYearMonth は範囲外で
 *   RangeError を投げるため、確認せずに呼ぶと "0000-01" を表示したときに画面が落ちる
 */
export async function getDashboardData(
  client: PrismaClient,
  yearMonth: string,
): Promise<DashboardData> {
  const range = getMonthDateRange(yearMonth);
  const hasPreviousMonth = canShiftYearMonth(yearMonth, -1);

  const [
    paymentSources,
    categories,
    budgets,
    categoryBudgets,
    expenses,
    incomes,
    previousMonthIncomes,
  ] = await Promise.all([
    client.paymentSource.findMany({
      orderBy: [{ isActive: "desc" }, { sortOrder: "asc" }, { id: "asc" }],
    }),
    client.category.findMany({
      orderBy: [{ isHidden: "asc" }, { sortOrder: "asc" }, { id: "asc" }],
    }),
    client.budget.findMany({ where: { yearMonth } }),
    client.categoryBudget.findMany({ where: { yearMonth } }),
    client.expense.findMany({ where: { date: { gte: range.gte, lt: range.lt } } }),
    client.income.findMany({
      where: { yearMonth },
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    }),
    hasPreviousMonth
      ? client.income.findMany({
          where: { yearMonth: previousYearMonth(yearMonth) },
          orderBy: [{ createdAt: "desc" }, { id: "asc" }],
        })
      : Promise.resolve<Income[]>([]),
  ]);

  return {
    yearMonth,
    paymentSources,
    categories,
    budgets,
    categoryBudgets,
    expenses,
    incomes,
    previousMonthIncomes,
  };
}
