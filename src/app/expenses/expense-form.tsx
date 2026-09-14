"use client";

import { useActionState, useEffect, useRef, useState } from "react";

import type { PaymentSourceType, WasteTag } from "@/generated/prisma/enums";
import { formatYen } from "@/lib/budget-calculation";
import { formatDateFullLabel, isDateString } from "@/lib/expense-date";
import {
  MEMO_MAX_LENGTH,
  STORE_NAME_MAX_LENGTH,
  validateExpenseAmount,
  WASTE_TAG_OPTIONS,
} from "@/lib/expense-validation";
import { PAYMENT_SOURCE_TYPE_LABELS } from "@/lib/payment-source-validation";

import { initialExpenseActionState, type ExpenseFormAction } from "./action-state";

/**
 * 支出の登録・編集フォーム。**アプリで最も使う画面。**
 *
 * 設計の要点（docs/steps/step-5.md）:
 * - 通常は「金額を入れて、カテゴリを選んで、保存」で終わる。日付・払い出し先・
 *   浪費フラグは初期値のままで良い並びにする
 * - 浪費フラグの既定は「必要」。ただし「浪費」は押しやすい位置に置く
 *   （無駄使いの検出がこのアプリの目的の半分で、押しにくいと記録されなくなる）
 * - 登録後は画面に留まり、**金額とカテゴリだけ**クリアする。
 *   レジで続けて2件入力することがあるため
 */

export type ExpenseFormCategory = {
  id: string;
  name: string;
};

export type ExpenseFormPaymentSource = {
  id: string;
  name: string;
  type: PaymentSourceType;
};

export type ExpenseFormValues = {
  /** "YYYY-MM-DD" */
  date: string;
  /** 入力途中の文字列をそのまま持つ（正規化は検証側の担当） */
  amount: string;
  categoryId: string;
  paymentSourceId: string;
  wasteTag: WasteTag;
  storeName: string;
  memo: string;
};

export type ExpenseFormProps = {
  /** "create" のときだけ保存後に金額とカテゴリをクリアする */
  mode: "create" | "edit";
  /** 編集時に必要。Server Action へ id を渡す */
  expenseId?: string;
  /** 選択肢に出すカテゴリ（表示順） */
  categories: readonly ExpenseFormCategory[];
  /** クイック選択に出すカテゴリ id（よく使う順）。空なら枠ごと出さない */
  quickPickCategoryIds: readonly string[];
  /** 選択肢に出す払い出し先（表示順） */
  paymentSources: readonly ExpenseFormPaymentSource[];
  /** 店名の入力候補（新しい順） */
  storeNameSuggestions: readonly string[];
  initialValues: ExpenseFormValues;
  /** 通常は createExpenseAction / updateExpenseAction */
  action: ExpenseFormAction;
};

const fieldClass =
  "h-12 w-full rounded-lg border border-black/20 bg-white px-3 text-base text-black outline-none focus:border-black/60 dark:border-white/25 dark:bg-black dark:text-white dark:focus:border-white/70";

/** タップ領域を 44px 以上に保つ。スマホで押し外さないため */
const chipBaseClass =
  "flex min-h-11 cursor-pointer items-center justify-center rounded-lg border px-2 py-2 text-center text-sm leading-tight break-words";

const chipOffClass = "border-black/20 dark:border-white/25";

const chipOnClass = "border-transparent bg-foreground font-semibold text-background";

function chipClass(selected: boolean): string {
  return `${chipBaseClass} ${selected ? chipOnClass : chipOffClass}`;
}

/** 浪費だけは選択時の色を変える。あとから一覧で見て目に入るようにするため */
function wasteChipClass(selected: boolean, value: WasteTag): string {
  if (!selected) return `${chipBaseClass} ${chipOffClass}`;
  if (value === "WASTE") {
    return `${chipBaseClass} border-transparent bg-red-600 font-semibold text-white`;
  }
  return `${chipBaseClass} ${chipOnClass}`;
}

export function ExpenseForm({
  mode,
  expenseId,
  categories,
  quickPickCategoryIds,
  paymentSources,
  storeNameSuggestions,
  initialValues,
  action,
}: ExpenseFormProps) {
  const [state, formAction, pending] = useActionState(action, initialExpenseActionState);
  const [values, setValues] = useState<ExpenseFormValues>(initialValues);
  const [handledSavedCount, setHandledSavedCount] = useState(state.savedCount);
  const amountRef = useRef<HTMLInputElement>(null);

  // 保存が1件通るたびに、金額とカテゴリだけを空に戻して次の入力へ備える。
  // 日付・払い出し先・浪費フラグ・店名・メモは直前の値を保つ（続けて2件入れる場面のため）。
  //
  // savedCount は保存のたびに増えるので、2件続けて保存してもここが動く。
  // レンダー中に前回値と比べて調整する（useEffect で setState すると
  // 一度クリア前の値を描いてから再描画することになる）。
  if (state.savedCount !== handledSavedCount) {
    setHandledSavedCount(state.savedCount);
    if (mode === "create") {
      setValues((current) => ({ ...current, amount: "", categoryId: "" }));
    }
  }

  // 続けて入力できるよう、保存のたびに金額欄へ戻す
  useEffect(() => {
    if (mode !== "create" || state.savedCount === 0) return;
    amountRef.current?.focus();
  }, [state.savedCount, mode]);

  const amountResult = validateExpenseAmount(values.amount);
  const amountTouched = values.amount.trim().length > 0;
  const amountError = amountTouched && !amountResult.ok ? amountResult.error : null;

  const categoryById = new Map(categories.map((category) => [category.id, category]));
  const quickPickCategories = quickPickCategoryIds
    .map((id) => categoryById.get(id))
    .filter((category): category is ExpenseFormCategory => category !== undefined);

  const saved = state.savedCount > 0 && state.error === null;

  // ラジオを保存のたびに作り直すための世代番号。
  //
  // React 19 の <form action={fn}> は、アクション完了時に必ずネイティブの form.reset() を
  // 実行する（react-dom の startHostTransition が requestFormReset を呼ぶ）。
  // reset() は各コントロールを defaultValue / defaultChecked へ戻す。
  //
  // text 入力は React が更新のたびに defaultValue を現在値へ同期する（updateInput の
  // setDefaultValue）ので実害がないが、**radio / checkbox の defaultChecked は
  // マウント時にしか設定されない**（updateInput は `checked == null` のときしか
  // defaultChecked を書かない）。そのため保存のたびにラジオの DOM checked だけが
  // マウント時点の値へ巻き戻り、見た目（React ステート）と送信内容（FormData）が食い違う。
  //
  // 実測した被害:
  // - create: クリアしたはずのカテゴリが再送され、「浪費」「Aカード」が
  //   「必要」「現金」に戻って保存される
  // - edit: 保存後にもう一度保存すると、支出がマウント時の値に丸ごと戻る
  //
  // key を変えてラジオを作り直すと、マウント時に defaultChecked が現在値で設定し直され、
  // 以後の reset() が実質何もしなくなる。DOM の checked と React ステートが一致する。
  const radioGeneration = state.savedCount;

  return (
    <form action={formAction} className="flex flex-col gap-5" noValidate>
      {expenseId ? <input type="hidden" name="id" value={expenseId} /> : null}

      {/* 1. 金額。最初に触る欄なので一番上、一番大きく */}
      <div className="flex flex-col gap-1.5">
        <label htmlFor="expense-amount" className="text-sm font-medium">
          金額
        </label>
        <div className="flex items-center gap-2">
          <span aria-hidden="true" className="text-2xl font-bold">
            ¥
          </span>
          {/* text-base(16px) 未満にすると iOS でフォーカス時に画面が拡大するため下げない */}
          <input
            ref={amountRef}
            id="expense-amount"
            name="amount"
            type="text"
            inputMode="numeric"
            enterKeyHint="done"
            autoComplete="off"
            autoFocus={mode === "create"}
            placeholder="0"
            value={values.amount}
            onChange={(event) =>
              setValues((current) => ({ ...current, amount: event.target.value }))
            }
            aria-describedby={amountError ? "expense-amount-error" : undefined}
            aria-invalid={amountError ? true : undefined}
            className="h-14 w-full rounded-lg border border-black/20 bg-white px-3 text-right text-2xl font-bold text-black tabular-nums outline-none focus:border-black/60 dark:border-white/25 dark:bg-black dark:text-white dark:focus:border-white/70"
          />
        </div>
        {amountError ? (
          <p id="expense-amount-error" role="alert" className="text-sm text-red-600 dark:text-red-400">
            {amountError}
          </p>
        ) : amountResult.ok ? (
          <p className="text-right text-sm opacity-70">{formatYen(amountResult.value)}</p>
        ) : null}
      </div>

      {/* 2. カテゴリ。必ず選ばせる。よく使う順を先頭に出して1タップで終わらせる */}
      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium">カテゴリ</legend>

        {quickPickCategories.length > 0 ? (
          <div className="flex flex-col gap-1.5">
            <p className="text-xs opacity-70">よく使う</p>
            <div className="grid grid-cols-3 gap-2">
              {quickPickCategories.map((category) => (
                <button
                  key={`quick-${category.id}`}
                  type="button"
                  onClick={() =>
                    setValues((current) => ({ ...current, categoryId: category.id }))
                  }
                  aria-pressed={values.categoryId === category.id}
                  className={chipClass(values.categoryId === category.id)}
                >
                  {category.name}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {categories.length === 0 ? (
          <p className="text-sm opacity-70">表示中のカテゴリがありません。</p>
        ) : (
          <div className="grid grid-cols-3 gap-2">
            {categories.map((category) => {
              const selected = values.categoryId === category.id;
              return (
                <label key={`${category.id}#${radioGeneration}`} className={chipClass(selected)}>
                  <input
                    type="radio"
                    name="categoryId"
                    value={category.id}
                    checked={selected}
                    onChange={() =>
                      setValues((current) => ({ ...current, categoryId: category.id }))
                    }
                    className="sr-only"
                  />
                  {category.name}
                </label>
              );
            })}
          </div>
        )}
      </fieldset>

      {/* 3. 浪費フラグ。既定は「必要」だが「浪費」を押しやすい位置に置く */}
      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium">必要 / 浪費 / 投資</legend>
        <div className="grid grid-cols-3 gap-2">
          {WASTE_TAG_OPTIONS.map((option) => {
            const selected = values.wasteTag === option.value;
            return (
              <label
                key={`${option.value}#${radioGeneration}`}
                className={wasteChipClass(selected, option.value)}
              >
                <input
                  type="radio"
                  name="wasteTag"
                  value={option.value}
                  checked={selected}
                  onChange={() =>
                    setValues((current) => ({ ...current, wasteTag: option.value }))
                  }
                  className="sr-only"
                />
                {option.label}
              </label>
            );
          })}
        </div>
      </fieldset>

      {/* 4. 払い出し先。既定が最初から選ばれているので通常は触らない */}
      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium">払い出し先</legend>
        {paymentSources.length === 0 ? (
          <p className="text-sm opacity-70">有効な払い出し先がありません。</p>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            {paymentSources.map((source) => {
              const selected = values.paymentSourceId === source.id;
              return (
                <label key={`${source.id}#${radioGeneration}`} className={chipClass(selected)}>
                  <input
                    type="radio"
                    name="paymentSourceId"
                    value={source.id}
                    checked={selected}
                    onChange={() =>
                      setValues((current) => ({ ...current, paymentSourceId: source.id }))
                    }
                    className="sr-only"
                  />
                  <span className="flex flex-col">
                    <span>{source.name}</span>
                    <span className="text-xs font-normal opacity-70">
                      {PAYMENT_SOURCE_TYPE_LABELS[source.type]}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>
        )}
      </fieldset>

      {/* 5. 日付・店名・メモ。通常は触らないので畳んでおき、保存ボタンを近くに保つ */}
      <details open={mode === "edit"} className="rounded-lg border border-black/15 dark:border-white/20">
        <summary className="flex min-h-11 cursor-pointer items-center px-3 text-sm">
          日付・店名・メモ
          <span className="ml-auto opacity-70">
            {isDateString(values.date) ? formatDateFullLabel(values.date) : values.date}
          </span>
        </summary>

        <div className="flex flex-col gap-4 px-3 pt-1 pb-4">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="expense-date" className="text-sm font-medium">
              日付
            </label>
            <input
              id="expense-date"
              name="date"
              type="date"
              value={values.date}
              onChange={(event) =>
                setValues((current) => ({ ...current, date: event.target.value }))
              }
              className={fieldClass}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="expense-store-name" className="text-sm font-medium">
              店名（任意）
            </label>
            <input
              id="expense-store-name"
              name="storeName"
              type="text"
              list="expense-store-name-options"
              maxLength={STORE_NAME_MAX_LENGTH}
              enterKeyHint="done"
              autoComplete="off"
              value={values.storeName}
              onChange={(event) =>
                setValues((current) => ({ ...current, storeName: event.target.value }))
              }
              className={fieldClass}
            />
            <datalist id="expense-store-name-options">
              {storeNameSuggestions.map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="expense-memo" className="text-sm font-medium">
              メモ（任意）
            </label>
            <textarea
              id="expense-memo"
              name="memo"
              rows={2}
              maxLength={MEMO_MAX_LENGTH}
              value={values.memo}
              onChange={(event) =>
                setValues((current) => ({ ...current, memo: event.target.value }))
              }
              className="w-full rounded-lg border border-black/20 bg-white px-3 py-2 text-base text-black outline-none focus:border-black/60 dark:border-white/25 dark:bg-black dark:text-white dark:focus:border-white/70"
            />
          </div>
        </div>
      </details>

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
        {pending ? "保存中…" : mode === "create" ? "保存する" : "変更を保存する"}
      </button>
    </form>
  );
}
