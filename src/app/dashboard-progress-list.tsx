import { formatYen } from "@/lib/budget-calculation";
import { COST_TYPE_LABELS } from "@/lib/category-validation";
import {
  getUsageBarPercent,
  PACE_STATUS_LABELS,
  type CategoryProgressRow,
  type PaceStatus,
  type PaymentSourceProgressRow,
} from "@/lib/dashboard";
import { PAYMENT_SOURCE_TYPE_LABELS } from "@/lib/payment-source-validation";

/**
 * 消化率バーの一覧（払い出し先別 / カテゴリ別）。
 *
 * 並べ替えは純粋関数の担当で、ここは受け取った順にそのまま描く
 * （docs/features.md「消化率順に並べる＝一番危ない払い出し先が一番上」）。
 *
 * バーは CSS の幅（%）だけで描く。グラフライブラリは Step 8 まで入れない。
 * 100% を超えたらバーは 100% で止め、超過は色で示す。
 */

/** ペースごとのバーの色 */
const BAR_COLOR_CLASS: Record<PaceStatus, string> = {
  under: "fill-emerald-600",
  warning: "fill-amber-500",
  over: "fill-red-600",
  unknown: "fill-black/30 dark:fill-white/40",
};

/** ペースごとの文字色。数字と判定文言に使う */
export const PACE_TEXT_CLASS: Record<PaceStatus, string> = {
  under: "text-emerald-700 dark:text-emerald-400",
  warning: "text-amber-700 dark:text-amber-400",
  over: "text-red-600 dark:text-red-400",
  unknown: "opacity-70",
};

export type DashboardProgressBarProps = {
  /** 消化率。null（予算未設定）ならバーを描かない */
  usageRatio: number | null;
  status: PaceStatus;
};

/**
 * 消化率バー。数字は各行が別に出しているので、バー自体は装飾として扱う。
 *
 * 幅は SVG の `<rect width="N%">`（プレゼンテーション属性）で決める。
 * インラインの `style` 属性は CSP の style-src に 'unsafe-inline' が無いとブロックされるため使わない
 * （docs/steps/pub-4.md 設計判断 3）。
 */
export function DashboardProgressBar({ usageRatio, status }: DashboardProgressBarProps) {
  if (usageRatio === null) return null;

  return (
    <div
      aria-hidden="true"
      className="h-2 w-full overflow-hidden rounded-full bg-black/10 dark:bg-white/15"
    >
      <svg className="block h-full w-full" focusable="false">
        <rect
          x="0"
          y="0"
          width={`${getUsageBarPercent(usageRatio)}%`}
          height="100%"
          rx="4"
          ry="4"
          className={BAR_COLOR_CLASS[status]}
        />
      </svg>
    </div>
  );
}

export type PaymentSourceProgressListProps = {
  /** 消化率の降順（予算未設定は末尾） */
  rows: readonly PaymentSourceProgressRow[];
};

/**
 * 払い出し先別の予算バー。
 *
 * 目安は**その払い出し先だけの単純日割り**（利用者が決めた方式。
 * 固定費 / 変動費で分けない）。銀行引き落としが引き落とし直後に「超過」になるのは想定内で、
 * その払い出し先の中に閉じるため他の判断を濁さない（docs/steps/step-6.md 設計判断 1）。
 */
export function PaymentSourceProgressList({ rows }: PaymentSourceProgressListProps) {
  if (rows.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-black/20 px-4 py-6 text-center text-sm opacity-70 dark:border-white/25">
        有効な払い出し先がありません。先に払い出し先を登録してください。
      </p>
    );
  }

  return (
    <ul className="flex flex-col gap-3">
      {rows.map((row) => (
        <li key={row.paymentSourceId} className="flex flex-col gap-1.5">
          <div className="flex flex-wrap items-baseline justify-between gap-x-2">
            <span className="flex flex-wrap items-center gap-1.5">
              <span className="text-sm font-medium break-words">{row.name}</span>
              <span className="rounded-full bg-black/8 px-2 py-0.5 text-[10px] leading-none dark:bg-white/15">
                {PAYMENT_SOURCE_TYPE_LABELS[row.type]}
              </span>
              {row.isActive ? null : (
                <span className="rounded-full bg-black/8 px-2 py-0.5 text-[10px] leading-none dark:bg-white/15">
                  無効
                </span>
              )}
            </span>
            <span className="text-sm tabular-nums">
              <span className={`font-bold ${PACE_TEXT_CLASS[row.status]}`}>
                {formatYen(row.spentYen)}
              </span>
              {row.budgetYen === null ? null : (
                <span className="opacity-70"> / {formatYen(row.budgetYen)}</span>
              )}
            </span>
          </div>

          {row.budgetYen === null ? (
            <p className="text-xs opacity-70">予算未設定</p>
          ) : (
            <>
              <DashboardProgressBar usageRatio={row.usageRatio} status={row.status} />
              <p className="text-xs opacity-70 tabular-nums">
                目安 {formatYen(row.expectedYen ?? 0)} ・ 残り {formatYen(row.remainingYen ?? 0)}
                <span className={`ml-2 ${PACE_TEXT_CLASS[row.status]}`}>
                  {PACE_STATUS_LABELS[row.status]}
                </span>
              </p>
            </>
          )}
        </li>
      ))}
    </ul>
  );
}

export type CategoryProgressListProps = {
  /** カテゴリ予算が設定されているカテゴリだけ。消化率の降順 */
  rows: readonly CategoryProgressRow[];
};

/**
 * カテゴリ別の予算バー。
 * **カテゴリ予算は任意の補助上限**で、総予算にも残高にも足さない
 * （docs/features.md「予算の持ち方」）。
 */
export function CategoryProgressList({ rows }: CategoryProgressListProps) {
  return (
    <ul className="flex flex-col gap-3">
      {rows.map((row) => (
        <li key={row.categoryId} className="flex flex-col gap-1.5">
          <div className="flex flex-wrap items-baseline justify-between gap-x-2">
            <span className="flex flex-wrap items-center gap-1.5">
              <span className="text-sm font-medium break-words">{row.name}</span>
              <span className="rounded-full bg-black/8 px-2 py-0.5 text-[10px] leading-none dark:bg-white/15">
                {COST_TYPE_LABELS[row.costType]}
              </span>
            </span>
            <span className="text-sm tabular-nums">
              <span className={`font-bold ${PACE_TEXT_CLASS[row.status]}`}>
                {formatYen(row.spentYen)}
              </span>
              <span className="opacity-70"> / {formatYen(row.budgetYen)}</span>
            </span>
          </div>

          <DashboardProgressBar usageRatio={row.usageRatio} status={row.status} />
          <p className="text-xs opacity-70 tabular-nums">
            目安 {formatYen(row.expectedYen)} ・ 残り {formatYen(row.remainingYen)}
            <span className={`ml-2 ${PACE_TEXT_CLASS[row.status]}`}>
              {PACE_STATUS_LABELS[row.status]}
            </span>
          </p>
        </li>
      ))}
    </ul>
  );
}
