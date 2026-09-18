import { connection } from "next/server";

import { WasteTag } from "@/generated/prisma/enums";
import {
  buildCategoryProgressRows,
  buildDashboardSummary,
  buildIncomeBalance,
  getMonthProgress,
  summarizeIncomes,
} from "@/lib/dashboard";
import { getDashboardData } from "@/lib/dashboard-data";
import { getCurrentDate } from "@/lib/expense-date";
import { summarizeExpenses } from "@/lib/expense-summary";
import { prisma } from "@/lib/prisma";
import { requireUserId } from "@/lib/session";
import { getCurrentYearMonth, resolveYearMonth } from "@/lib/year-month";

import { logoutAction } from "./(auth)/login/actions";
import { YEAR_MONTH_PARAM } from "./dashboard-path";
import { DashboardView } from "./dashboard-view";

/**
 * ダッシュボード（＝アプリのトップ画面）。
 *
 * docs/features.md 冒頭の2つの問い「今月、予算内で生活できているか」
 * 「無駄使いはないか」に、この1画面で答える。
 *
 * - 対象月は ?month=YYYY-MM。指定が無い・壊れている場合は今月（JST）
 * - 「今日」は getCurrentDate(new Date()) でここだけが求め、計算する純粋関数へ渡す
 *   （関数の中で new Date() を呼ばない。月末・年またぎがテストできなくなるため）
 * - 集計は src/lib/dashboard.ts、取得は src/lib/dashboard-data.ts の担当
 *
 * connection() でプリレンダリングを止める。この画面は常に DB の最新状態を出す必要があり、
 * ビルド時に DB へ接続させないため。
 */
export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  await connection();
  // proxy とは別に、ここで利用者IDを得てデータ層へ渡す（proxy はユーザーIDを渡せない）
  const userId = await requireUserId();

  const params = await searchParams;
  const now = new Date();
  const currentYearMonth = getCurrentYearMonth(now);
  const yearMonth = resolveYearMonth(params[YEAR_MONTH_PARAM], now);
  const progress = getMonthProgress(yearMonth, getCurrentDate(now));

  const data = await getDashboardData(prisma, userId, yearMonth);

  const summary = buildDashboardSummary({
    paymentSources: data.paymentSources,
    budgets: data.budgets,
    expenses: data.expenses,
    progress,
  });
  const categoryRows = buildCategoryProgressRows({
    categories: data.categories,
    categoryBudgets: data.categoryBudgets,
    expenses: data.expenses,
    progress,
  });

  // 浪費タグ別の内訳は既存の集計関数をそのまま使う
  const expenseSummary = summarizeExpenses(data.expenses);
  const waste = expenseSummary.byWasteTag[WasteTag.WASTE];

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col gap-5 px-4 py-6">
      <h1 className="text-2xl font-bold">家計簿</h1>

      <DashboardView
        yearMonth={yearMonth}
        currentYearMonth={currentYearMonth}
        summary={summary}
        categoryRows={categoryRows}
        wasteTotalYen={waste.totalYen}
        wasteCount={waste.count}
        incomeSummary={summarizeIncomes(yearMonth, data.incomes)}
        incomeBalance={buildIncomeBalance(
          yearMonth,
          data.previousMonthIncomes,
          summary.totalSpentYen,
        )}
      />

      <form action={logoutAction} className="mt-auto">
        <button
          type="submit"
          className="h-12 w-full rounded-lg border border-black/20 text-base font-medium dark:border-white/25"
        >
          ログアウト
        </button>
      </form>
    </main>
  );
}
