import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";

import { formatYen } from "@/lib/budget-calculation";
import { listIncomes, sumIncomeAmounts } from "@/lib/incomes";
import { prisma } from "@/lib/prisma";
import { formatYearMonthLabel, getCurrentYearMonth, resolveYearMonth } from "@/lib/year-month";

import { YEAR_MONTH_PARAM } from "./action-state";
import { createIncomeAction, deleteIncomeAction } from "./actions";
import { IncomeForm } from "./income-form";
import { IncomeList, type IncomeListItem } from "./income-list";
import { IncomeMonthNavigation } from "./income-month-navigation";

export const metadata: Metadata = {
  title: "収入",
};

/**
 * 収入の記録。追加・一覧・削除のみ（編集は無い。docs/steps/step-6.md「編集画面は作らない」）。
 *
 * **`Income.yearMonth` は「受け取った月」。** 7/25 に振り込まれた給与は 2026-07 として
 * 記録する。ダッシュボードの収支は「表示中の月の**前月**の収入 − 表示中の月の支出」なので、
 * ここを取り違えると数字が黙って1ヶ月ずれる。検証では防げないため見出しで明示する。
 *
 * connection() でプリレンダリングを止める。この画面は常に DB の最新状態を出す必要があり、
 * ビルド時に DB へ接続させないため。
 */
export default async function IncomesPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  await connection();

  const params = await searchParams;
  const now = new Date();
  const currentYearMonth = getCurrentYearMonth(now);
  const yearMonth = resolveYearMonth(params[YEAR_MONTH_PARAM], now);

  const incomes = await listIncomes(prisma, yearMonth);
  const totalYen = sumIncomeAmounts(incomes);
  const items: IncomeListItem[] = incomes.map((income) => ({
    id: income.id,
    amountYen: income.amountYen,
    label: income.label,
  }));

  return (
    <main className="mx-auto flex w-full max-w-md flex-col gap-6 px-4 py-6">
      <header className="flex flex-col gap-2">
        <Link href="/" className="text-sm underline underline-offset-4 opacity-70">
          ← ホーム
        </Link>
        <h1 className="text-xl font-bold">収入</h1>
      </header>

      <IncomeMonthNavigation yearMonth={yearMonth} currentYearMonth={currentYearMonth} />

      <section className="flex flex-col gap-2">
        <h2 className="text-base font-semibold">
          {formatYearMonthLabel(yearMonth)}に受け取った収入
        </h2>
        <div className="flex items-baseline justify-between rounded-xl bg-black/5 px-4 py-3 dark:bg-white/10">
          <span className="text-sm font-medium">
            合計
            <span className="ml-2 text-xs opacity-70 tabular-nums">{incomes.length}件</span>
          </span>
          <span className="text-2xl font-bold tabular-nums">{formatYen(totalYen)}</span>
        </div>
        <p className="text-xs opacity-70">
          給与が振り込まれた月に記録します（7/25 に振り込まれた給与は 7 月）。
          この月の収入は<strong>翌月の原資</strong>として扱います。
        </p>
      </section>

      <IncomeList items={items} deleteAction={deleteIncomeAction} />

      <section className="flex flex-col gap-3 border-t border-black/10 pt-5 dark:border-white/15">
        <h2 className="text-base font-semibold">収入を追加</h2>
        <IncomeForm
          key={`income-form-${yearMonth}`}
          yearMonth={yearMonth}
          action={createIncomeAction}
        />
      </section>
    </main>
  );
}
