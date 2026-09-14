import Link from "next/link";

import { formatYen } from "@/lib/budget-calculation";
import { formatSignedYen, type IncomeBalance, type IncomeSummary } from "@/lib/dashboard";
import { formatYearMonthLabel } from "@/lib/year-month";

import { incomesPath } from "./incomes/action-state";

/**
 * 収支と今月の収入。
 *
 * 収支は「**前月**の総収入 − 表示中の月の総支出」だけ（docs/steps/step-6.md 設計判断 2）。
 * 給与は前月に振り込まれ、それで今月を暮らすという見方をするため。
 * **予算とは一切関連付けない。** 総予算や消化率と混ぜない。
 *
 * 画面上部の「残り使える金額」（総予算 − 支出）と数字が2つ並ぶので、
 * **必ず月名を明示する**。ラベルが曖昧だと取り違える。
 */

export type IncomeBalanceCardProps = {
  /** 表示中の月 "YYYY-MM"（支出を見た月） */
  yearMonth: string;
  /** 前月の収入が0件のときは null が来る想定で、その場合このカードを出さない */
  balance: IncomeBalance;
};

/** 収支。前月の収入が0件なら**枠ごと出さない**（呼び出し側で判定する） */
export function IncomeBalanceCard({ yearMonth, balance }: IncomeBalanceCardProps) {
  const negative = balance.balanceYen < 0;

  return (
    <section className="flex flex-col gap-2 rounded-xl border border-black/15 px-4 py-3 dark:border-white/20">
      <h2 className="text-base font-semibold">収支</h2>

      <dl className="flex flex-col gap-1 text-sm">
        <div className="flex items-baseline justify-between gap-3">
          <dt>{formatYearMonthLabel(balance.incomeYearMonth)}の収入</dt>
          <dd className="tabular-nums">{formatYen(balance.incomeTotalYen)}</dd>
        </div>
        <div className="flex items-baseline justify-between gap-3">
          <dt>{formatYearMonthLabel(yearMonth)}の支出</dt>
          <dd className="tabular-nums">{formatSignedYen(-balance.spentYen)}</dd>
        </div>
        <div className="flex items-baseline justify-between gap-3 border-t border-black/10 pt-1 dark:border-white/15">
          <dt className="font-medium">差額</dt>
          <dd
            className={`text-lg font-bold tabular-nums ${
              negative ? "text-red-600 dark:text-red-400" : ""
            }`}
          >
            {formatSignedYen(balance.balanceYen)}
          </dd>
        </div>
      </dl>

      <p className="text-xs opacity-70">
        {formatYearMonthLabel(balance.incomeYearMonth)}に受け取った収入で
        {formatYearMonthLabel(yearMonth)}を暮らす、という見方です。予算とは別の数字です。
      </p>
    </section>
  );
}

export type MonthlyIncomeCardProps = {
  /** 表示中の月の収入。0件でも枠は出す（記録を促すため） */
  summary: IncomeSummary;
};

/**
 * 表示中の月に受け取った収入。**来月の原資**になるので、入れ忘れに気づけるように出す。
 * **総予算との比較や注意文は出さない**（docs/steps/step-6.md 設計判断 2）。
 */
export function MonthlyIncomeCard({ summary }: MonthlyIncomeCardProps) {
  return (
    <section className="flex flex-col gap-2 rounded-xl border border-black/15 px-4 py-3 dark:border-white/20">
      <h2 className="text-base font-semibold">今月の収入</h2>

      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm">{formatYearMonthLabel(summary.yearMonth)}</span>
        <span className="text-lg font-bold tabular-nums">
          {formatYen(summary.totalYen)}
          {summary.count === 0 ? (
            <span className="ml-1 text-xs font-normal opacity-70">（未記入）</span>
          ) : (
            <span className="ml-1 text-xs font-normal opacity-70">（{summary.count}件）</span>
          )}
        </span>
      </div>

      <p className="text-xs opacity-70">※ 来月の原資になります。</p>

      <Link
        href={incomesPath(summary.yearMonth)}
        className="self-start text-sm underline underline-offset-4"
      >
        収入を記録する →
      </Link>
    </section>
  );
}
