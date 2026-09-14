"use client";

import { useActionState, useState } from "react";

import {
  isPaymentSourceType,
  PAYMENT_SOURCE_NAME_MAX_LENGTH,
  PAYMENT_SOURCE_TYPE_OPTIONS,
} from "@/lib/payment-source-validation";

import {
  initialPaymentSourceActionState,
  type PaymentSourceFormAction,
} from "./action-state";

export type PaymentSourceCreateFormProps = {
  /** 通常は Server Action の createPaymentSourceAction を渡す */
  action: PaymentSourceFormAction;
};

/**
 * 払い出し先の追加フォーム。
 * 入力は名前とタイプの2つだけ。sortOrder は末尾、既定にするかは編集画面の別操作。
 */
export function PaymentSourceCreateForm({ action }: PaymentSourceCreateFormProps) {
  const [state, formAction, pending] = useActionState(action, initialPaymentSourceActionState);

  // タイプの選択値を state で持ち、それを <select> の key と defaultValue の両方に渡す。
  //
  // React 19 の <form action={関数}> は、アクション完了時に必ずネイティブの form.reset() を
  // 実行する。reset() は <select> を defaultSelected へ戻すが、**React は defaultSelected を
  // マウント時にしか書かない**ため、defaultValue を渡していてもマウント時の値（＝先頭の
  // 選択肢）へ巻き戻る（docs/tech-stack.md 参照）。
  //
  // 実害: 名前が重複して追加に失敗したとき（アクションは完了しているので reset() は走る）、
  // タイプだけが先頭の選択肢に戻る。利用者が名前を直して押し直すと、意図と違うタイプで作られる。
  //
  // key が変わると <select> が作り直され、マウント時の defaultSelected が現在の選択値になる。
  //
  // 挙動の変更点（意図的）: 追加に成功したあとも <select> は先頭に戻らず、直前に選んだ値の
  // ままになる。PaymentSourceActionState は { error } しか持たず「成功した」ことを画面側から
  // 判別できないため。同じタイプを続けて追加する場面ではむしろ都合が良い。
  const [selectedType, setSelectedType] = useState(PAYMENT_SOURCE_TYPE_OPTIONS[0]?.value);

  return (
    <form action={formAction} className="flex w-full flex-col gap-3" noValidate>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="new-payment-source-name" className="text-sm font-medium">
          名前
        </label>
        {/* text-base(16px) 未満にすると iOS でフォーカス時に画面が拡大するため下げない */}
        <input
          id="new-payment-source-name"
          name="name"
          type="text"
          required
          maxLength={PAYMENT_SOURCE_NAME_MAX_LENGTH}
          enterKeyHint="done"
          placeholder="例: Aカード"
          aria-describedby={state.error ? "create-payment-source-error" : undefined}
          aria-invalid={state.error ? true : undefined}
          className="h-12 w-full rounded-lg border border-black/20 bg-white px-3 text-base text-black outline-none focus:border-black/60 dark:border-white/25 dark:bg-black dark:text-white dark:focus:border-white/70"
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="new-payment-source-type" className="text-sm font-medium">
          タイプ
        </label>
        <select
          key={selectedType}
          id="new-payment-source-type"
          name="type"
          defaultValue={selectedType}
          onChange={(event) => {
            const { value } = event.target;
            if (isPaymentSourceType(value)) setSelectedType(value);
          }}
          className="h-12 w-full rounded-lg border border-black/20 bg-white px-3 text-base text-black outline-none focus:border-black/60 dark:border-white/25 dark:bg-black dark:text-white dark:focus:border-white/70"
        >
          {PAYMENT_SOURCE_TYPE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>

      {state.error ? (
        <p
          id="create-payment-source-error"
          role="alert"
          className="text-sm text-red-600 dark:text-red-400"
        >
          {state.error}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={pending}
        className="h-12 w-full rounded-lg bg-foreground text-base font-medium text-background disabled:opacity-60"
      >
        {pending ? "追加中…" : "追加する"}
      </button>
    </form>
  );
}
