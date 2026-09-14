import { WasteTag } from "@/generated/prisma/enums";
import { formatYen } from "@/lib/budget-calculation";
import type { ExpenseSummary } from "@/lib/expense-summary";
import { WASTE_TAG_LABELS } from "@/lib/expense-validation";

export type ExpenseSummaryCardProps = {
  summary: ExpenseSummary;
  /** 絞り込みが掛かっているか。合計が何の合計なのかを言い分けるために使う */
  filtering: boolean;
};

/**
 * 絞り込み結果の合計金額と件数。**一覧の先頭に出す。**
 *
 * 「今月の外食はいくらか」「浪費だけでいくらか」がその場で分かるようにするため
 * （docs/steps/step-5.md）。浪費の額は目的の半分なので必ず併記する。
 */
export function ExpenseSummaryCard({ summary, filtering }: ExpenseSummaryCardProps) {
  const waste = summary.byWasteTag[WasteTag.WASTE];

  return (
    <section className="flex flex-col gap-2 rounded-xl bg-black/5 px-4 py-3 dark:bg-white/10">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm font-medium">
          {filtering ? "絞り込んだ合計" : "この月の合計"}
          <span className="ml-2 text-xs opacity-70 tabular-nums">{summary.count}件</span>
        </span>
        <span className="text-2xl font-bold tabular-nums">{formatYen(summary.totalYen)}</span>
      </div>

      <dl className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
        {[WasteTag.NECESSARY, WasteTag.WASTE, WasteTag.INVESTMENT].map((tag) => {
          const isWaste = tag === WasteTag.WASTE;
          return (
            <div key={tag} className="flex items-baseline gap-1">
              <dt className={isWaste ? "font-semibold" : "opacity-70"}>
                {WASTE_TAG_LABELS[tag]}
              </dt>
              <dd
                className={`tabular-nums ${
                  isWaste ? "font-semibold text-red-600 dark:text-red-400" : "opacity-70"
                }`}
              >
                {formatYen(summary.byWasteTag[tag].totalYen)}
              </dd>
            </div>
          );
        })}
      </dl>

      <p className="text-xs opacity-70 tabular-nums">浪費は {waste.count}件</p>
    </section>
  );
}
