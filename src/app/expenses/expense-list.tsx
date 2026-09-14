import Link from "next/link";

import { WasteTag } from "@/generated/prisma/enums";
import { formatYen } from "@/lib/budget-calculation";
import { formatDateLabel } from "@/lib/expense-date";
import { WASTE_TAG_LABELS } from "@/lib/expense-validation";

import { expenseDetailPath } from "./action-state";

/** 一覧の1行に必要な項目だけを受け取る（Prisma の型そのものに縛られないため） */
export type ExpenseListItem = {
  id: string;
  /** "YYYY-MM-DD" */
  date: string;
  amountYen: number;
  categoryName: string;
  paymentSourceName: string;
  wasteTag: WasteTag;
  storeName: string | null;
  memo: string | null;
};

export type ExpenseListProps = {
  items: readonly ExpenseListItem[];
  /** 1件も無いときに出す文言。絞り込みの有無で言い分ける */
  emptyMessage: string;
};

/**
 * 支出の一覧。1行まるごとが編集ページへのリンク（スマホでタップを外さないため）。
 *
 * ページングは入れない。1ヶ月分は多くても数百件でスクロールで足りる
 * （docs/steps/step-5.md）。
 */
export function ExpenseList({ items, emptyMessage }: ExpenseListProps) {
  if (items.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-black/20 px-4 py-8 text-center text-sm opacity-70 dark:border-white/25">
        {emptyMessage}
      </p>
    );
  }

  return (
    <ul className="flex flex-col gap-2">
      {items.map((item) => (
        <li key={item.id}>
          <Link
            href={expenseDetailPath(item.id)}
            className="flex min-h-14 items-center gap-3 rounded-lg border border-black/15 px-3 py-2 dark:border-white/20"
          >
            <span className="w-14 shrink-0 text-xs opacity-70 tabular-nums">
              {formatDateLabel(item.date)}
            </span>

            <span className="flex min-w-0 flex-1 flex-col">
              <span className="flex flex-wrap items-center gap-1.5">
                <span className="text-sm font-medium break-words">{item.categoryName}</span>
                {item.wasteTag === WasteTag.NECESSARY ? null : (
                  <span
                    className={`rounded-full px-1.5 py-0.5 text-[10px] leading-none ${
                      item.wasteTag === WasteTag.WASTE
                        ? "bg-red-600 text-white"
                        : "bg-black/10 dark:bg-white/20"
                    }`}
                  >
                    {WASTE_TAG_LABELS[item.wasteTag]}
                  </span>
                )}
              </span>
              <span className="truncate text-xs opacity-70">
                {item.storeName ?? item.memo ?? item.paymentSourceName}
              </span>
            </span>

            <span className="flex shrink-0 flex-col items-end">
              <span className="text-base font-bold tabular-nums">
                {formatYen(item.amountYen)}
              </span>
              <span className="text-[10px] opacity-70">{item.paymentSourceName}</span>
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
