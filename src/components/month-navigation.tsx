import Link from "next/link";

import {
  canShiftYearMonth,
  formatYearMonthLabel,
  nextYearMonth,
  previousYearMonth,
} from "@/lib/year-month";

/**
 * 対象月の表示と前月 / 翌月の移動（画面をまたいで共通）。
 *
 * 予算・支出一覧・ダッシュボードの3画面で使う。3つとも
 * **リンク先の組み立て方以外は完全に同一**なので、ここに一本化して
 * 各画面は hrefForMonth を渡すだけの薄いラッパーにする
 * （docs/steps/step-6.md「月ナビゲーションを共通化する」。
 *  Step 4 で並べ替えを src/lib/ordering.ts に共通化したのと同じ判断）。
 *
 * ルーティング対象にしないため src/app/ の外に置く。
 *
 * 月は URL のクエリ（?month=YYYY-MM）で持つ。リンクなので戻る操作でも月が戻り、
 * 特定の月をブックマークできる。扱える範囲の端では移動リンクを出さない。
 */

export type MonthNavigationProps = {
  /** 表示中の対象月 "YYYY-MM" */
  yearMonth: string;
  /** 今月（JST）。表示中の月と違うときだけ「今月へ」を出す */
  currentYearMonth: string;
  /** 対象月へのリンク先を組み立てる。画面ごとの唯一の違い */
  hrefForMonth: (yearMonth: string) => string;
};

const buttonClass =
  "flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-black/20 text-lg leading-none dark:border-white/25";

export function MonthNavigation({
  yearMonth,
  currentYearMonth,
  hrefForMonth,
}: MonthNavigationProps) {
  const canGoPrevious = canShiftYearMonth(yearMonth, -1);
  const canGoNext = canShiftYearMonth(yearMonth, 1);

  return (
    <nav className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        {canGoPrevious ? (
          <Link
            href={hrefForMonth(previousYearMonth(yearMonth))}
            aria-label="前月へ"
            className={buttonClass}
          >
            ←
          </Link>
        ) : (
          <span aria-hidden="true" className={`${buttonClass} opacity-30`}>
            ←
          </span>
        )}

        <h2 className="text-lg font-bold tabular-nums">{formatYearMonthLabel(yearMonth)}</h2>

        {canGoNext ? (
          <Link
            href={hrefForMonth(nextYearMonth(yearMonth))}
            aria-label="翌月へ"
            className={buttonClass}
          >
            →
          </Link>
        ) : (
          <span aria-hidden="true" className={`${buttonClass} opacity-30`}>
            →
          </span>
        )}
      </div>

      {yearMonth === currentYearMonth ? null : (
        <Link
          href={hrefForMonth(currentYearMonth)}
          className="self-center text-sm underline underline-offset-4 opacity-70"
        >
          今月（{formatYearMonthLabel(currentYearMonth)}）へ
        </Link>
      )}
    </nav>
  );
}
