"use client";

import { useActionState, useState } from "react";

import { formatYen } from "@/lib/budget-calculation";

import { initialIncomeActionState, type IncomeFormAction } from "./action-state";

/** 一覧の1行に必要な項目だけを受け取る（Prisma の型そのものに縛られないため） */
export type IncomeListItem = {
  id: string;
  amountYen: number;
  /** 未入力なら null */
  label: string | null;
};

export type IncomeListProps = {
  /** 新しい順 */
  items: readonly IncomeListItem[];
  /** 通常は Server Action の deleteIncomeAction */
  deleteAction: IncomeFormAction;
};

/**
 * その月に受け取った収入の一覧。
 *
 * **編集は無い。** 直したいときは消して入れ直す（docs/steps/step-6.md「編集画面は作らない」）。
 * そのぶん削除を押す機会が多くなるので、**確認を1段挟む**（支出の削除と同じ形）。
 */
export function IncomeList({ items, deleteAction }: IncomeListProps) {
  const [state, formAction, pending] = useActionState(deleteAction, initialIncomeActionState);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  if (items.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-black/20 px-4 py-8 text-center text-sm opacity-70 dark:border-white/25">
        この月に受け取った収入はまだ記録されていません。
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <ul className="flex flex-col gap-2">
        {items.map((item) => {
          const confirming = confirmingId === item.id;
          const description = `${item.label ?? "収入"} ${formatYen(item.amountYen)}`;
          return (
            <li
              key={item.id}
              className="flex flex-col gap-2 rounded-lg border border-black/15 px-3 py-2 dark:border-white/20"
            >
              <div className="flex min-h-11 items-center gap-3">
                <span className="min-w-0 flex-1 truncate text-sm">
                  {item.label ?? <span className="opacity-70">（ラベルなし）</span>}
                </span>
                <span className="shrink-0 text-base font-bold tabular-nums">
                  {formatYen(item.amountYen)}
                </span>
                {confirming ? null : (
                  <button
                    type="button"
                    onClick={() => setConfirmingId(item.id)}
                    aria-label={`${description} を削除`}
                    className="h-11 shrink-0 rounded-lg border border-red-600/60 px-3 text-sm font-medium text-red-600 dark:text-red-400"
                  >
                    削除
                  </button>
                )}
              </div>

              {confirming ? (
                <form action={formAction} className="flex flex-col gap-2">
                  <input type="hidden" name="id" value={item.id} />
                  <p className="text-sm font-medium">
                    「{description}」を削除します。元に戻せません。
                  </p>
                  <div className="flex gap-2">
                    <button
                      type="submit"
                      disabled={pending}
                      className="h-11 flex-1 rounded-lg bg-red-600 text-sm font-medium text-white disabled:opacity-60"
                    >
                      {pending ? "削除中…" : "削除する"}
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmingId(null)}
                      className="h-11 flex-1 rounded-lg border border-black/20 text-sm font-medium dark:border-white/25"
                    >
                      やめる
                    </button>
                  </div>
                </form>
              ) : null}
            </li>
          );
        })}
      </ul>

      {state.error ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {state.error}
        </p>
      ) : null}
    </div>
  );
}
