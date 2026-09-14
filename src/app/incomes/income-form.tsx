"use client";

import { useActionState, useState } from "react";

import { formatYen } from "@/lib/budget-calculation";
import { formatYearMonthLabel } from "@/lib/year-month";
import {
  INCOME_LABEL_MAX_LENGTH,
  validateIncomeAmount,
} from "@/lib/income-validation";

import { initialIncomeActionState, type IncomeFormAction } from "./action-state";

export type IncomeFormProps = {
  /** 「受け取った月」 "YYYY-MM"。ダッシュボードの収支はこの月を前提に前月分を読む */
  yearMonth: string;
  /** 通常は Server Action の createIncomeAction */
  action: IncomeFormAction;
};

const fieldClass =
  "h-12 w-full rounded-lg border border-black/20 bg-white px-3 text-base text-black outline-none focus:border-black/60 dark:border-white/25 dark:bg-black dark:text-white dark:focus:border-white/70";

/**
 * 収入の追加フォーム。入力は金額とラベル（任意）だけ。
 *
 * 対象月は URL（＝画面の月ナビゲーション）で決まるので選ばせない。
 * **その月は「受け取った月」**であり、ラベルで明示する（docs/steps/step-6.md 設計判断 2）。
 *
 * `<select>` も radio も使っていないため、React 19 の form 自動リセットによる
 * 巻き戻り（docs/tech-stack.md）は起きない。text 入力は React が更新のたびに
 * defaultValue を現在値へ同期するので、リセットされても値が変わらない。
 * 追加が成功したときだけ savedCount の変化を見て明示的にクリアする。
 */
export function IncomeForm({ yearMonth, action }: IncomeFormProps) {
  const [state, formAction, pending] = useActionState(action, initialIncomeActionState);
  const [amount, setAmount] = useState("");
  const [label, setLabel] = useState("");
  const [handledSavedCount, setHandledSavedCount] = useState(state.savedCount);

  // 保存が1件通るたびに入力欄を空へ戻す。
  // レンダー中に前回値と比べて調整する（useEffect で setState すると
  // 一度クリア前の値を描いてから再描画することになる）。
  if (state.savedCount !== handledSavedCount) {
    setHandledSavedCount(state.savedCount);
    setAmount("");
    setLabel("");
  }

  const amountResult = validateIncomeAmount(amount);
  const amountTouched = amount.trim().length > 0;
  const amountError = amountTouched && !amountResult.ok ? amountResult.error : null;
  const saved = state.savedCount > 0 && state.error === null;

  return (
    <form action={formAction} className="flex flex-col gap-4" noValidate>
      <input type="hidden" name="yearMonth" value={yearMonth} />

      <div className="flex flex-col gap-1.5">
        <label htmlFor="income-amount" className="text-sm font-medium">
          金額
        </label>
        <div className="flex items-center gap-2">
          <span aria-hidden="true" className="text-2xl font-bold">
            ¥
          </span>
          {/* text-base(16px) 未満にすると iOS でフォーカス時に画面が拡大するため下げない */}
          <input
            id="income-amount"
            name="amount"
            type="text"
            inputMode="numeric"
            enterKeyHint="done"
            autoComplete="off"
            placeholder="0"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            aria-describedby={amountError ? "income-amount-error" : undefined}
            aria-invalid={amountError ? true : undefined}
            className="h-14 w-full rounded-lg border border-black/20 bg-white px-3 text-right text-2xl font-bold text-black tabular-nums outline-none focus:border-black/60 dark:border-white/25 dark:bg-black dark:text-white dark:focus:border-white/70"
          />
        </div>
        {amountError ? (
          <p id="income-amount-error" role="alert" className="text-sm text-red-600 dark:text-red-400">
            {amountError}
          </p>
        ) : amountResult.ok ? (
          <p className="text-right text-sm opacity-70">{formatYen(amountResult.value)}</p>
        ) : null}
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="income-label" className="text-sm font-medium">
          ラベル（任意）
        </label>
        <input
          id="income-label"
          name="label"
          type="text"
          maxLength={INCOME_LABEL_MAX_LENGTH}
          enterKeyHint="done"
          autoComplete="off"
          placeholder="例: 給与"
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          className={fieldClass}
        />
      </div>

      <p className="text-xs opacity-70">
        {formatYearMonthLabel(yearMonth)}に<strong>受け取った</strong>収入として記録します。
      </p>

      {state.error ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {state.error}
        </p>
      ) : null}
      {saved ? (
        <p role="status" className="text-sm text-emerald-700 dark:text-emerald-400">
          保存しました。
        </p>
      ) : null}

      <button
        type="submit"
        disabled={pending}
        className="h-14 w-full rounded-lg bg-foreground text-base font-semibold text-background disabled:opacity-60"
      >
        {pending ? "保存中…" : "収入を追加する"}
      </button>
    </form>
  );
}
