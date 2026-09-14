import Link from "next/link";

import { MonthNavigation } from "@/components/month-navigation";
import { formatYen } from "@/lib/budget-calculation";
import {
  formatSignedYen,
  PACE_STATUS_LABELS,
  type CategoryProgressRow,
  type DashboardSummary,
  type IncomeBalance,
  type IncomeSummary,
} from "@/lib/dashboard";
import { formatYearMonthLabel } from "@/lib/year-month";

import { BUDGETS_PATH, budgetsPath } from "./budgets/action-state";
import { dashboardPath } from "./dashboard-path";
import { IncomeBalanceCard, MonthlyIncomeCard } from "./dashboard-income";
import {
  CategoryProgressList,
  PACE_TEXT_CLASS,
  PaymentSourceProgressList,
} from "./dashboard-progress-list";
import { EXPENSES_PATH, NEW_EXPENSE_PATH } from "./expenses/action-state";
import { INCOMES_PATH } from "./incomes/action-state";
import { CATEGORIES_PATH } from "./settings/categories/action-state";
import { PASSKEYS_PATH } from "./settings/passkeys/action-state";
import { PAYMENT_SOURCES_PATH } from "./settings/payment-sources/action-state";

/**
 * ダッシュボードの本体（表示だけ。データ取得と集計は page.tsx と src/lib/dashboard.ts の担当）。
 *
 * 並び（docs/steps/step-6.md「3-5. 画面」）:
 * 1. 残り使える金額（最も大きく） 2. ペース判定 3. 月末着地見込み 4. 今月の無駄使い
 * 5. 払い出し先別バー 6. カテゴリ別バー 7. 収支 8. 今月の収入 9. 主要な画面へのリンク
 *
 * 総予算が 0（予算を1つも入れていない）ときは 2 と 3 を出さない。
 * 0 で割った結果や「0円の予算に対して超過」を初回起動でいきなり見せないため。
 */

export type DashboardViewProps = {
  /** 表示中の対象月 "YYYY-MM" */
  yearMonth: string;
  /** 今月（JST） */
  currentYearMonth: string;
  summary: DashboardSummary;
  /** カテゴリ予算があるカテゴリだけ。空なら節ごと出さない */
  categoryRows: readonly CategoryProgressRow[];
  /** 表示中の月の浪費（WASTE）合計。0 円でも必ず出す */
  wasteTotalYen: number;
  /** 浪費の件数 */
  wasteCount: number;
  /** 表示中の月に受け取った収入 */
  incomeSummary: IncomeSummary;
  /** 前月の収入が0件なら null。そのときは収支の枠ごと出さない */
  incomeBalance: IncomeBalance | null;
};

const linkRowClass =
  "flex h-12 w-full items-center justify-between rounded-lg border border-black/20 px-4 text-base font-medium dark:border-white/25";

export function DashboardView({
  yearMonth,
  currentYearMonth,
  summary,
  categoryRows,
  wasteTotalYen,
  wasteCount,
  incomeSummary,
  incomeBalance,
}: DashboardViewProps) {
  const { progress, totalStatus } = summary;
  const monthLabel = formatYearMonthLabel(yearMonth);
  const hasBudget = summary.totalBudgetYen > 0;

  return (
    <>
      <MonthNavigation
        yearMonth={yearMonth}
        currentYearMonth={currentYearMonth}
        hrefForMonth={dashboardPath}
      />

      {/* 1. 残り使える金額。この画面で最も大きい数字 */}
      <section className="flex flex-col gap-1 rounded-xl bg-black/5 px-4 py-4 dark:bg-white/10">
        <h2 className="text-sm font-medium">{monthLabel}の残り使える金額</h2>
        <p
          className={`text-4xl font-bold tabular-nums ${
            summary.remainingYen < 0 ? "text-red-600 dark:text-red-400" : ""
          }`}
        >
          {formatSignedYen(summary.remainingYen)}
        </p>
        <p className="text-xs opacity-70 tabular-nums">
          総予算 {formatYen(summary.totalBudgetYen)} ・ 支出{" "}
          {formatYen(summary.totalSpentYen)}
        </p>
      </section>

      {hasBudget ? null : (
        <p className="rounded-lg border border-amber-500/60 px-4 py-3 text-sm">
          この月の予算がまだ設定されていません。
          <Link
            href={budgetsPath(yearMonth)}
            className="ml-1 underline underline-offset-4"
          >
            まず予算を設定してください
          </Link>
          。
        </p>
      )}

      {summary.unsetBudgetCount > 0 ? (
        <p className="rounded-lg border border-amber-500/60 px-4 py-3 text-sm">
          予算が未設定の払い出し先が {summary.unsetBudgetCount} 件あります。
          <Link
            href={budgetsPath(yearMonth)}
            className="ml-1 underline underline-offset-4"
          >
            月次予算を開く
          </Link>
        </p>
      ) : null}

      {/* 2・3. ペース判定と月末着地見込み。予算が1円も無い月は出さない */}
      {hasBudget ? (
        <section className="flex flex-col gap-2 rounded-xl border border-black/15 px-4 py-3 dark:border-white/20">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="text-base font-semibold">ペース</h2>
            <span className={`text-lg font-bold ${PACE_TEXT_CLASS[totalStatus]}`}>
              {PACE_STATUS_LABELS[totalStatus]}
            </span>
          </div>

          <dl className="flex flex-col gap-1 text-sm">
            <div className="flex items-baseline justify-between gap-3">
              <dt>今日までの目安</dt>
              <dd className="tabular-nums">{formatYen(summary.totalExpectedYen)}</dd>
            </div>
            <div className="flex items-baseline justify-between gap-3">
              <dt>実績</dt>
              <dd className={`font-bold tabular-nums ${PACE_TEXT_CLASS[totalStatus]}`}>
                {formatYen(summary.totalSpentYen)}
              </dd>
            </div>
            <div className="flex items-baseline justify-between gap-3">
              <dt>経過</dt>
              <dd className="tabular-nums">
                {progress.elapsedDays} / {progress.daysInMonth} 日
              </dd>
            </div>
          </dl>

          {summary.totalProjectedYen === null ? (
            <p className="text-xs opacity-70">
              まだ経過日数が 0 日のため、月末の着地見込みは出せません。
            </p>
          ) : (
            <div className="flex flex-col gap-0.5 border-t border-black/10 pt-2 dark:border-white/15">
              <div className="flex items-baseline justify-between gap-3 text-sm">
                <span className="font-medium">月末の着地見込み</span>
                <span className="text-lg font-bold tabular-nums">
                  {formatYen(summary.totalProjectedYen)}
                </span>
              </div>
              <p className="self-end text-xs opacity-70 tabular-nums">
                総予算との差{" "}
                {formatSignedYen(summary.totalBudgetYen - summary.totalProjectedYen)}
              </p>
            </div>
          )}
        </section>
      ) : null}

      {/* 4. 今月の無駄使い。0 円でも必ず出す（0 であることに意味がある） */}
      <section className="flex items-baseline justify-between gap-3 rounded-xl border border-black/15 px-4 py-3 dark:border-white/20">
        <div className="flex flex-col">
          <h2 className="text-base font-semibold">今月の無駄使い</h2>
          <p className="text-xs opacity-70 tabular-nums">
            {monthLabel} ・ {wasteCount}件
          </p>
        </div>
        <span className="text-2xl font-bold text-red-600 tabular-nums dark:text-red-400">
          {formatYen(wasteTotalYen)}
        </span>
      </section>

      {/* 5. 払い出し先別バー。消化率順＝一番危ない払い出し先が一番上 */}
      <section className="flex flex-col gap-3">
        <h2 className="text-base font-semibold">払い出し先別</h2>
        <PaymentSourceProgressList rows={summary.rows} />
      </section>

      {/* 6. カテゴリ別バー。カテゴリ予算が1件も無ければ節ごと出さない */}
      {categoryRows.length === 0 ? null : (
        <section className="flex flex-col gap-3">
          <div className="flex flex-col gap-0.5">
            <h2 className="text-base font-semibold">カテゴリ別</h2>
            <p className="text-xs opacity-70">
              カテゴリ予算は任意の補助上限です。総予算には含まれません。
            </p>
          </div>
          <CategoryProgressList rows={categoryRows} />
        </section>
      )}

      {/* 7. 収支。前月の収入が0件なら枠ごと出さない */}
      {incomeBalance === null ? null : (
        <IncomeBalanceCard yearMonth={yearMonth} balance={incomeBalance} />
      )}

      {/* 8. 今月の収入。0件でも枠は残す（記録を促すため） */}
      <MonthlyIncomeCard summary={incomeSummary} />

      {/* 9. 主要な画面へのリンク。支出の記録は毎日触るので最後に大きく置く */}
      <nav className="flex flex-col gap-2">
        <Link href={EXPENSES_PATH} className={linkRowClass}>
          支出一覧
          <span aria-hidden="true">›</span>
        </Link>
        <Link href={BUDGETS_PATH} className={linkRowClass}>
          月次予算
          <span aria-hidden="true">›</span>
        </Link>
        <Link href={INCOMES_PATH} className={linkRowClass}>
          収入
          <span aria-hidden="true">›</span>
        </Link>
        <Link href={PAYMENT_SOURCES_PATH} className={linkRowClass}>
          払い出し先の設定
          <span aria-hidden="true">›</span>
        </Link>
        <Link href={CATEGORIES_PATH} className={linkRowClass}>
          カテゴリの設定
          <span aria-hidden="true">›</span>
        </Link>
        <Link href={PASSKEYS_PATH} className={linkRowClass}>
          パスキーの設定
          <span aria-hidden="true">›</span>
        </Link>
      </nav>

      <Link
        href={NEW_EXPENSE_PATH}
        className="flex h-16 w-full items-center justify-center rounded-xl bg-foreground text-lg font-bold text-background"
      >
        支出を記録する
      </Link>
    </>
  );
}
