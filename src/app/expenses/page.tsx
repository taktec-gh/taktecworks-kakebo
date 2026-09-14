import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";

import { listCategories } from "@/lib/categories";
import { fromDbDate } from "@/lib/expense-date";
import { hasActiveExpenseFilter, parseExpenseListFilter } from "@/lib/expense-filter";
import { summarizeExpenses } from "@/lib/expense-summary";
import { listExpenses } from "@/lib/expenses";
import { listPaymentSources } from "@/lib/payment-sources";
import { prisma } from "@/lib/prisma";
import { getCurrentYearMonth } from "@/lib/year-month";

import { NEW_EXPENSE_PATH } from "./action-state";
import { ExpenseFilterPanel } from "./expense-filter-panel";
import { ExpenseList, type ExpenseListItem } from "./expense-list";
import { ExpenseMonthNavigation } from "./expense-month-navigation";
import { ExpenseSummaryCard } from "./expense-summary-card";

export const metadata: Metadata = {
  title: "支出一覧",
};

/**
 * 支出の一覧。
 *
 * 月・絞り込み・並べ替えはすべて URL のクエリで持つ（docs/steps/step-5.md）。
 * 月の範囲は @db.Date を UTC 深夜で引く（データ層 listExpenses の担当）。
 *
 * connection() でプリレンダリングを止める。この画面は常に DB の最新状態を出す必要があり、
 * ビルド時に DB へ接続させないため。
 */
export default async function ExpensesPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  await connection();

  const params = await searchParams;
  const now = new Date();
  const currentYearMonth = getCurrentYearMonth(now);
  const filter = parseExpenseListFilter(params, now);

  const [listed, categories, paymentSources] = await Promise.all([
    listExpenses(prisma, filter),
    listCategories(prisma),
    listPaymentSources(prisma),
  ]);

  const expenses = listed.ok ? listed.value : [];
  const summary = summarizeExpenses(expenses);
  const filtering = hasActiveExpenseFilter(filter);

  const items: ExpenseListItem[] = expenses.map((expense) => ({
    id: expense.id,
    date: fromDbDate(expense.date),
    amountYen: expense.amountYen,
    categoryName: expense.category.name,
    paymentSourceName: expense.paymentSource.name,
    wasteTag: expense.wasteTag,
    storeName: expense.storeName,
    memo: expense.memo,
  }));

  return (
    <main className="mx-auto flex w-full max-w-md flex-col gap-5 px-4 py-6">
      <header className="flex flex-col gap-2">
        <Link href="/" className="text-sm underline underline-offset-4 opacity-70">
          ← ホーム
        </Link>
        <div className="flex items-baseline justify-between gap-3">
          <h1 className="text-xl font-bold">支出一覧</h1>
          <Link
            href={NEW_EXPENSE_PATH}
            className="text-sm underline underline-offset-4 opacity-70"
          >
            支出を記録
          </Link>
        </div>
      </header>

      <ExpenseMonthNavigation filter={filter} currentYearMonth={currentYearMonth} />

      {listed.ok ? null : (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {listed.error}
        </p>
      )}

      <ExpenseSummaryCard summary={summary} filtering={filtering} />

      <ExpenseFilterPanel
        filter={filter}
        categories={categories.map((category) => ({
          id: category.id,
          name: category.name,
        }))}
        paymentSources={paymentSources.map((source) => ({
          id: source.id,
          name: source.name,
          type: source.type,
        }))}
      />

      <ExpenseList
        items={items}
        emptyMessage={
          filtering
            ? "条件に合う支出がありません。絞り込みを見直してください。"
            : "この月の支出はまだありません。"
        }
      />

      <Link
        href={NEW_EXPENSE_PATH}
        className="flex h-14 w-full items-center justify-center rounded-lg bg-foreground text-base font-semibold text-background"
      >
        支出を記録する
      </Link>
    </main>
  );
}
