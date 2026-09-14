"use client";

import { useActionState, useState } from "react";

import type { PaymentSourceType } from "@/generated/prisma/enums";
import {
  BUDGET_AMOUNT_MAX_YEN,
  formatAmountInputValue,
  formatYen,
  parseBudgetAmountInput,
} from "@/lib/budget-calculation";
import { PAYMENT_SOURCE_TYPE_LABELS } from "@/lib/payment-source-validation";

import {
  budgetAmountFieldName,
  initialBudgetActionState,
  type BudgetFormAction,
} from "./action-state";

export type BudgetFormRow = {
  paymentSourceId: string;
  name: string;
  type: PaymentSourceType;
  /** 未設定なら null */
  amountYen: number | null;
};

export type BudgetFormProps = {
  yearMonth: string;
  /** 有効な払い出し先の行（表示順） */
  rows: readonly BudgetFormRow[];
  /**
   * 入力欄に出ない予算の合計（無効な払い出し先に残っている分）。
   * 総予算はこれも含めた額にする。画面の合計と実データを食い違わせないため
   */
  otherTotalYen: number;
  /** 通常は Server Action の saveBudgetsAction を渡す */
  action: BudgetFormAction;
};

const fieldClass =
  "h-12 w-full rounded-lg border border-black/20 bg-white px-3 text-right text-base text-black outline-none focus:border-black/60 dark:border-white/25 dark:bg-black dark:text-white dark:focus:border-white/70";

/**
 * 払い出し先の月次予算（＝予算の主軸）。
 *
 * 合計がその月の総予算になるため、入力中の合計をその場で大きく出す
 * （総予算を別に手入力する欄は作らない。docs/features.md「予算の持ち方」）。
 * 保存はセクション単位の一括保存。スマホで数個入れて1タップで終わらせるため。
 */
export function BudgetForm({ yearMonth, rows, otherTotalYen, action }: BudgetFormProps) {
  const [state, formAction, pending] = useActionState(action, initialBudgetActionState);
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      rows.map((row) => [row.paymentSourceId, formatAmountInputValue(row.amountYen)]),
    ),
  );

  const parsed = rows.map((row) => ({
    row,
    result: parseBudgetAmountInput(values[row.paymentSourceId] ?? ""),
  }));
  const hasInvalid = parsed.some((entry) => !entry.result.ok);
  const total = parsed.reduce(
    (sum, entry) => (entry.result.ok ? sum + (entry.result.value ?? 0) : sum),
    otherTotalYen,
  );

  return (
    <form action={formAction} className="flex flex-col gap-4" noValidate>
      <input type="hidden" name="yearMonth" value={yearMonth} />

      {rows.length === 0 ? (
        <p className="rounded-xl border border-dashed border-black/20 px-4 py-6 text-center text-sm opacity-70 dark:border-white/25">
          有効な払い出し先がありません。先に払い出し先を登録してください。
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {parsed.map(({ row, result }) => {
            const fieldId = `budget-${row.paymentSourceId}`;
            const errorId = `${fieldId}-error`;
            const invalid = !result.ok;
            return (
              <li key={row.paymentSourceId} className="flex flex-col gap-1.5">
                <label htmlFor={fieldId} className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-medium break-words">{row.name}</span>
                  <span className="rounded-full bg-black/8 px-2 py-0.5 text-xs dark:bg-white/15">
                    {PAYMENT_SOURCE_TYPE_LABELS[row.type]}
                  </span>
                </label>
                {/* text-base(16px) 未満にすると iOS でフォーカス時に画面が拡大するため下げない */}
                <input
                  id={fieldId}
                  name={budgetAmountFieldName(row.paymentSourceId)}
                  type="text"
                  inputMode="numeric"
                  enterKeyHint="done"
                  placeholder="未設定"
                  value={values[row.paymentSourceId] ?? ""}
                  onChange={(event) =>
                    setValues((current) => ({
                      ...current,
                      [row.paymentSourceId]: event.target.value,
                    }))
                  }
                  aria-describedby={invalid ? errorId : undefined}
                  aria-invalid={invalid ? true : undefined}
                  className={fieldClass}
                />
                {!result.ok ? (
                  <p id={errorId} role="alert" className="text-sm text-red-600 dark:text-red-400">
                    {result.error}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      <div className="flex items-baseline justify-between rounded-xl bg-black/5 px-4 py-3 dark:bg-white/10">
        <span className="text-sm font-medium">総予算</span>
        <span className="text-2xl font-bold tabular-nums">{formatYen(total)}</span>
      </div>
      <p className="text-xs opacity-70">
        空欄は「未設定」です。0 を入れると「0円の予算」として保存します。1件あたり
        {formatYen(BUDGET_AMOUNT_MAX_YEN)}まで。
      </p>

      {state.error ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {state.error}
        </p>
      ) : null}
      {state.saved && !state.error ? (
        <p role="status" className="text-sm text-emerald-700 dark:text-emerald-400">
          保存しました。
        </p>
      ) : null}

      <button
        type="submit"
        disabled={pending || hasInvalid || rows.length === 0}
        className="h-12 w-full rounded-lg bg-foreground text-base font-medium text-background disabled:opacity-60"
      >
        {pending ? "保存中…" : "予算を保存する"}
      </button>
    </form>
  );
}
