import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";

import { buildBudgetSummary, buildCategoryBudgetSummary } from "@/lib/budget-calculation";
import { getMonthlyBudgetData } from "@/lib/budgets";
import { prisma } from "@/lib/prisma";
import { getCurrentYearMonth, resolveYearMonth } from "@/lib/year-month";

import { CATEGORIES_PATH } from "../settings/categories/action-state";
import { YEAR_MONTH_PARAM } from "./action-state";
import { deleteBudgetAction, saveBudgetsAction, saveCategoryBudgetsAction } from "./actions";
import { BudgetForm } from "./budget-form";
import { CategoryBudgetForm } from "./category-budget-form";
import { InactiveBudgetList } from "./inactive-budget-list";
import { MonthNavigation } from "./month-navigation";

export const metadata: Metadata = {
  title: "月次予算",
};

/**
 * 月次予算。
 *
 * - 主軸は払い出し先の予算。その合計が総予算（docs/features.md「予算の持ち方」）
 * - カテゴリ予算は任意の補助上限で、総予算には足さない
 * - 対象月は ?month=YYYY-MM。指定が無い・壊れている場合は今月（JST）
 *
 * connection() でプリレンダリングを止める。この画面は常に DB の最新状態を出す必要があり、
 * ビルド時に DB へ接続させないため。
 */
export default async function BudgetsPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  await connection();

  const params = await searchParams;
  // 「今月」は純粋関数に現在時刻を渡して求める（JST 固定）
  const currentYearMonth = getCurrentYearMonth(new Date());
  const yearMonth = resolveYearMonth(params[YEAR_MONTH_PARAM], new Date());

  const data = await getMonthlyBudgetData(prisma, yearMonth);
  const summary = buildBudgetSummary(data.paymentSources, data.budgets);
  const categorySummary = buildCategoryBudgetSummary(data.categories, data.categoryBudgets);

  const inactiveTotalYen = summary.inactiveRows.reduce((sum, row) => sum + row.amountYen, 0);

  return (
    <main className="mx-auto flex w-full max-w-md flex-col gap-6 px-4 py-6">
      <header className="flex flex-col gap-2">
        <Link href="/" className="text-sm underline underline-offset-4 opacity-70">
          ← ホーム
        </Link>
        <h1 className="text-xl font-bold">月次予算</h1>
      </header>

      <MonthNavigation yearMonth={yearMonth} currentYearMonth={currentYearMonth} />

      <section className="flex flex-col gap-3">
        <h2 className="text-base font-semibold">払い出し先の予算</h2>
        <p className="text-sm opacity-70">
          この合計が今月の総予算です。空欄のままでも構いませんが、未設定の払い出し先は予算 0
          として扱われます。
        </p>
        <BudgetForm
          key={`budget-${yearMonth}`}
          yearMonth={yearMonth}
          rows={summary.rows}
          otherTotalYen={inactiveTotalYen}
          action={saveBudgetsAction}
        />
      </section>

      <InactiveBudgetList
        yearMonth={yearMonth}
        rows={summary.inactiveRows}
        deleteAction={deleteBudgetAction}
      />

      <section className="flex flex-col gap-3 border-t border-black/10 pt-5 dark:border-white/15">
        <h2 className="text-base font-semibold">カテゴリ予算（任意）</h2>
        <p className="text-sm opacity-70">
          設定しなくても構いません。<strong>総予算には含まれません。</strong>
          「食費を使いすぎていないか」を見るための上限です。
        </p>
        <CategoryBudgetForm
          key={`category-budget-${yearMonth}`}
          yearMonth={yearMonth}
          rows={categorySummary.rows}
          action={saveCategoryBudgetsAction}
        />
        <Link href={CATEGORIES_PATH} className="text-sm underline underline-offset-4 opacity-70">
          カテゴリの設定へ
        </Link>
      </section>
    </main>
  );
}
