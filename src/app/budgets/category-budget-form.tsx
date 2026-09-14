"use client";

import { useActionState, useState } from "react";

import {
  formatAmountInputValue,
  formatYen,
  parseBudgetAmountInput,
} from "@/lib/budget-calculation";

import {
  categoryBudgetAmountFieldName,
  initialBudgetActionState,
  type BudgetFormAction,
} from "./action-state";

export type CategoryBudgetFormRow = {
  categoryId: string;
  name: string;
  /** 非表示のカテゴリは、予算が残っている場合だけ行に出る */
  isHidden: boolean;
  /** 未設定なら null */
  amountYen: number | null;
};

export type CategoryBudgetFormProps = {
  yearMonth: string;
  rows: readonly CategoryBudgetFormRow[];
  /** 通常は Server Action の saveCategoryBudgetsAction を渡す */
  action: BudgetFormAction;
};

const fieldClass =
  "h-12 w-full rounded-lg border border-black/20 bg-white px-3 text-right text-base text-black outline-none focus:border-black/60 dark:border-white/25 dark:bg-black dark:text-white dark:focus:border-white/70";

/**
 * カテゴリ予算（＝任意の補助上限）。
 *
 * **総予算には一切足さない。** 足すと払い出し先の予算と二重計上になる
 * （docs/features.md「設計判断 > 予算の持ち方」）。画面上も別セクションに分け、
 * 合計は「参考」として控えめに出す。
 */
export function CategoryBudgetForm({ yearMonth, rows, action }: CategoryBudgetFormProps) {
  const [state, formAction, pending] = useActionState(action, initialBudgetActionState);
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(rows.map((row) => [row.categoryId, formatAmountInputValue(row.amountYen)])),
  );

  const parsed = rows.map((row) => ({
    row,
    result: parseBudgetAmountInput(values[row.categoryId] ?? ""),
  }));
  const hasInvalid = parsed.some((entry) => !entry.result.ok);
  const total = parsed.reduce(
    (sum, entry) => (entry.result.ok ? sum + (entry.result.value ?? 0) : sum),
    0,
  );

  return (
    <form action={formAction} className="flex flex-col gap-4" noValidate>
      <input type="hidden" name="yearMonth" value={yearMonth} />

      {rows.length === 0 ? (
        <p className="rounded-xl border border-dashed border-black/20 px-4 py-6 text-center text-sm opacity-70 dark:border-white/25">
          表示中のカテゴリがありません。
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {parsed.map(({ row, result }) => {
            const fieldId = `category-budget-${row.categoryId}`;
            const errorId = `${fieldId}-error`;
            const invalid = !result.ok;
            return (
              <li key={row.categoryId} className="flex flex-col gap-1.5">
                <label htmlFor={fieldId} className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-medium break-words">{row.name}</span>
                  {row.isHidden ? (
                    <span className="rounded-full bg-black/8 px-2 py-0.5 text-xs opacity-70 dark:bg-white/15">
                      非表示
                    </span>
                  ) : null}
                </label>
                <input
                  id={fieldId}
                  name={categoryBudgetAmountFieldName(row.categoryId)}
                  type="text"
                  inputMode="numeric"
                  enterKeyHint="done"
                  placeholder="未設定"
                  value={values[row.categoryId] ?? ""}
                  onChange={(event) =>
                    setValues((current) => ({
                      ...current,
                      [row.categoryId]: event.target.value,
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

      <p className="text-sm opacity-70">
        カテゴリ予算の合計 {formatYen(total)}（参考値。総予算には含まれません）
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
        className="h-12 w-full rounded-lg border border-black/20 text-base font-medium disabled:opacity-40 dark:border-white/25"
      >
        {pending ? "保存中…" : "カテゴリ予算を保存する"}
      </button>
    </form>
  );
}
