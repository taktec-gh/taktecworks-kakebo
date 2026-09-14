import Link from "next/link";

import type { PaymentSourceType } from "@/generated/prisma/enums";
import {
  clearExpenseFilter,
  EXPENSE_FILTER_PARAMS,
  EXPENSE_SORT_KEYS,
  EXPENSE_SORT_LABELS,
  hasActiveExpenseFilter,
  withExpenseFilter,
  type ExpenseListFilter,
} from "@/lib/expense-filter";
import { WASTE_TAG_OPTIONS } from "@/lib/expense-validation";
import { PAYMENT_SOURCE_TYPE_LABELS } from "@/lib/payment-source-validation";

import { EXPENSES_PATH, expensesPath } from "./action-state";

export type ExpenseFilterOption = {
  id: string;
  name: string;
};

export type ExpenseFilterPaymentSourceOption = ExpenseFilterOption & {
  type: PaymentSourceType;
};

export type ExpenseFilterPanelProps = {
  filter: ExpenseListFilter;
  /** 絞り込みに出すカテゴリ（表示順）。絞り込み中の値は隠れていても含めること */
  categories: readonly ExpenseFilterOption[];
  /** 絞り込みに出す払い出し先（表示順） */
  paymentSources: readonly ExpenseFilterPaymentSourceOption[];
};

const selectClass =
  "h-12 w-full rounded-lg border border-black/20 bg-white px-3 text-base text-black outline-none focus:border-black/60 dark:border-white/25 dark:bg-black dark:text-white dark:focus:border-white/70";

/**
 * 並べ替えと絞り込み。
 *
 * どちらも **URL のクエリに持つ**（docs/steps/step-5.md）。戻るが効き、
 * 「今月の外食だけ」の URL をそのまま開き直せる。
 *
 * 並べ替えはリンク（1タップ）。「高額順で見ると無駄使いが即座に目に入る」ため
 * 金額順への切り替えを手数の少ない場所に置く。
 * 絞り込みは項目が多いので GET フォームにまとめ、既定では畳んでおく。
 */
export function ExpenseFilterPanel({
  filter,
  categories,
  paymentSources,
}: ExpenseFilterPanelProps) {
  const filtering = hasActiveExpenseFilter(filter);

  return (
    <section className="flex flex-col gap-3">
      <div className="flex gap-2" role="group" aria-label="並べ替え">
        {EXPENSE_SORT_KEYS.map((sort) => {
          const selected = filter.sort === sort;
          return (
            <Link
              key={sort}
              href={expensesPath(withExpenseFilter(filter, { sort }))}
              aria-current={selected ? "true" : undefined}
              className={`flex min-h-11 flex-1 items-center justify-center rounded-lg border px-3 text-sm ${
                selected
                  ? "border-transparent bg-foreground font-semibold text-background"
                  : "border-black/20 dark:border-white/25"
              }`}
            >
              {EXPENSE_SORT_LABELS[sort]}
            </Link>
          );
        })}
      </div>

      <details
        open={filtering}
        className="rounded-lg border border-black/15 dark:border-white/20"
      >
        <summary className="flex min-h-11 cursor-pointer items-center px-3 text-sm">
          絞り込み
          {filtering ? (
            <span className="ml-2 rounded-full bg-foreground px-2 py-0.5 text-xs text-background">
              適用中
            </span>
          ) : null}
        </summary>

        <form method="get" action={EXPENSES_PATH} className="flex flex-col gap-3 px-3 pt-1 pb-4">
          <input type="hidden" name={EXPENSE_FILTER_PARAMS.month} value={filter.yearMonth} />
          <input type="hidden" name={EXPENSE_FILTER_PARAMS.sort} value={filter.sort} />

          <div className="flex flex-col gap-1.5">
            <label htmlFor="expense-filter-category" className="text-sm font-medium">
              カテゴリ
            </label>
            <select
              id="expense-filter-category"
              name={EXPENSE_FILTER_PARAMS.category}
              defaultValue={filter.categoryId ?? ""}
              className={selectClass}
            >
              <option value="">すべて</option>
              {categories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="expense-filter-payment-source" className="text-sm font-medium">
              払い出し先
            </label>
            <select
              id="expense-filter-payment-source"
              name={EXPENSE_FILTER_PARAMS.paymentSource}
              defaultValue={filter.paymentSourceId ?? ""}
              className={selectClass}
            >
              <option value="">すべて</option>
              {paymentSources.map((source) => (
                <option key={source.id} value={source.id}>
                  {source.name}（{PAYMENT_SOURCE_TYPE_LABELS[source.type]}）
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="expense-filter-waste" className="text-sm font-medium">
              必要 / 浪費 / 投資
            </label>
            <select
              id="expense-filter-waste"
              name={EXPENSE_FILTER_PARAMS.waste}
              defaultValue={filter.wasteTag ?? ""}
              className={selectClass}
            >
              <option value="">すべて</option>
              {WASTE_TAG_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>

          <button
            type="submit"
            className="h-12 w-full rounded-lg bg-foreground text-base font-medium text-background"
          >
            絞り込む
          </button>

          {filtering ? (
            <Link
              href={expensesPath(clearExpenseFilter(filter))}
              className="self-center text-sm underline underline-offset-4 opacity-70"
            >
              絞り込みを解除
            </Link>
          ) : null}
        </form>
      </details>
    </section>
  );
}
