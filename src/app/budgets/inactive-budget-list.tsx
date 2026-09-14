"use client";

import { useActionState } from "react";

import { formatYen } from "@/lib/budget-calculation";

import { initialBudgetActionState, type BudgetFormAction } from "./action-state";

export type InactiveBudgetRow = {
  paymentSourceId: string;
  name: string;
  amountYen: number;
};

export type InactiveBudgetListProps = {
  yearMonth: string;
  rows: readonly InactiveBudgetRow[];
  /** 通常は Server Action の deleteBudgetAction を渡す */
  deleteAction: BudgetFormAction;
};

/**
 * 無効な払い出し先に残っている予算の警告。
 *
 * 合計（総予算）にはこの分も含めている。合計から黙って除外すると
 * 画面の合計と実データが食い違うため（docs/steps/step-4.md）。
 * 不要ならその場で削除できるようにする。
 */
export function InactiveBudgetList({ yearMonth, rows, deleteAction }: InactiveBudgetListProps) {
  if (rows.length === 0) return null;

  return (
    <section className="flex flex-col gap-3 rounded-xl border border-amber-500/60 bg-amber-500/10 p-4">
      <h2 className="text-base font-semibold">無効な払い出し先に予算が残っています</h2>
      <p className="text-sm opacity-80">
        下の予算は総予算に含まれていますが、払い出し先が無効なため入力欄には出ません。
        使わないなら削除してください。
      </p>
      <ul className="flex flex-col gap-2">
        {rows.map((row) => (
          <InactiveBudgetItem
            key={row.paymentSourceId}
            yearMonth={yearMonth}
            row={row}
            deleteAction={deleteAction}
          />
        ))}
      </ul>
    </section>
  );
}

function InactiveBudgetItem({
  yearMonth,
  row,
  deleteAction,
}: {
  yearMonth: string;
  row: InactiveBudgetRow;
  deleteAction: BudgetFormAction;
}) {
  const [state, formAction, pending] = useActionState(deleteAction, initialBudgetActionState);

  return (
    <li className="flex flex-col gap-1">
      <form action={formAction} className="flex items-center gap-2">
        <input type="hidden" name="yearMonth" value={yearMonth} />
        <input type="hidden" name="paymentSourceId" value={row.paymentSourceId} />
        <span className="min-w-0 flex-1 text-sm break-words">{row.name}</span>
        <span className="text-sm font-medium tabular-nums">{formatYen(row.amountYen)}</span>
        <button
          type="submit"
          disabled={pending}
          aria-label={`${row.name} の予算を削除`}
          className="h-11 shrink-0 rounded-lg border border-red-600/60 px-3 text-sm font-medium text-red-700 disabled:opacity-40 dark:text-red-300"
        >
          {pending ? "削除中…" : "削除"}
        </button>
      </form>
      {state.error ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {state.error}
        </p>
      ) : null}
    </li>
  );
}
