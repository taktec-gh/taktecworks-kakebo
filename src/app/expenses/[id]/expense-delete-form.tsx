"use client";

import { useActionState, useState } from "react";

import { initialExpenseActionState, type ExpenseFormAction } from "../action-state";

export type ExpenseDeleteFormProps = {
  id: string;
  /** 確認文に出す説明（例「8/13(木) 食費 ¥1,200」） */
  description: string;
  /** 通常は Server Action の deleteExpenseAction */
  action: ExpenseFormAction;
};

const secondaryButtonClass =
  "h-12 w-full rounded-lg border border-black/20 text-base font-medium disabled:opacity-40 dark:border-white/25";

/**
 * 支出の削除。
 *
 * Expense は他から参照されないので物理削除でよいが、
 * **スマホでの誤タップを防ぐため2段階**にする（払い出し先の削除と同じ形。
 * docs/steps/step-5.md「削除は確認を挟んだ物理削除」）。
 */
export function ExpenseDeleteForm({ id, description, action }: ExpenseDeleteFormProps) {
  const [state, formAction, pending] = useActionState(action, initialExpenseActionState);
  const [confirming, setConfirming] = useState(false);

  return (
    <section className="flex flex-col gap-2 border-t border-black/10 pt-5 dark:border-white/15">
      <h2 className="text-base font-semibold">削除</h2>

      {confirming ? (
        <form action={formAction} className="flex flex-col gap-2">
          <input type="hidden" name="id" value={id} />
          <p className="text-sm font-medium">「{description}」を削除します。元に戻せません。</p>
          <button
            type="submit"
            disabled={pending}
            className="h-12 w-full rounded-lg bg-red-600 text-base font-medium text-white disabled:opacity-60"
          >
            {pending ? "削除中…" : "削除する"}
          </button>
          <button
            type="button"
            onClick={() => setConfirming(false)}
            className={secondaryButtonClass}
          >
            やめる
          </button>
          {state.error ? (
            <p role="alert" className="text-sm text-red-600 dark:text-red-400">
              {state.error}
            </p>
          ) : null}
        </form>
      ) : (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          className="h-12 w-full rounded-lg border border-red-600/60 text-base font-medium text-red-600 dark:text-red-400"
        >
          削除する
        </button>
      )}
    </section>
  );
}
