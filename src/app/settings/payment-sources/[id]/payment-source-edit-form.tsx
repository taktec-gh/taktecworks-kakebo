"use client";

import { useActionState, useState } from "react";

import type { PaymentSourceType } from "@/generated/prisma/enums";
import {
  isPaymentSourceType,
  PAYMENT_SOURCE_NAME_MAX_LENGTH,
  PAYMENT_SOURCE_TYPE_OPTIONS,
} from "@/lib/payment-source-validation";

import {
  initialPaymentSourceActionState,
  type PaymentSourceFormAction,
} from "../action-state";

export type PaymentSourceEditFormProps = {
  id: string;
  name: string;
  type: PaymentSourceType;
  isActive: boolean;
  isDefault: boolean;
  /** 既定にできない理由。できるなら null（すでに既定の場合も null） */
  setDefaultBlockedReason: string | null;
  /** 無効化できない理由。できるなら null（すでに無効の場合も null） */
  deactivateBlockedReason: string | null;
  /** 削除できない理由。できるなら null */
  deleteBlockedReason: string | null;
  /** 通常は Server Action の updatePaymentSourceAction */
  updateAction: PaymentSourceFormAction;
  /** 通常は Server Action の setDefaultPaymentSourceAction */
  setDefaultAction: PaymentSourceFormAction;
  /** 通常は Server Action の setPaymentSourceActiveAction */
  setActiveAction: PaymentSourceFormAction;
  /** 通常は Server Action の deletePaymentSourceAction */
  deleteAction: PaymentSourceFormAction;
};

const fieldClass =
  "h-12 w-full rounded-lg border border-black/20 bg-white px-3 text-base text-black outline-none focus:border-black/60 dark:border-white/25 dark:bg-black dark:text-white dark:focus:border-white/70";

const secondaryButtonClass =
  "h-12 w-full rounded-lg border border-black/20 text-base font-medium disabled:opacity-40 dark:border-white/25";

/**
 * 払い出し先の編集。
 *
 * 操作ごとに form を分ける（リネーム・既定にする・有効/無効・削除）。
 * 実行できない操作はボタンを非活性にし、理由をその場に出す。
 * 押せてしまった場合も Server Action 側が同じ理由で拒否する。
 */
export function PaymentSourceEditForm({
  id,
  name,
  type,
  isActive,
  isDefault,
  setDefaultBlockedReason,
  deactivateBlockedReason,
  deleteBlockedReason,
  updateAction,
  setDefaultAction,
  setActiveAction,
  deleteAction,
}: PaymentSourceEditFormProps) {
  const [updateState, updateFormAction, updatePending] = useActionState(
    updateAction,
    initialPaymentSourceActionState,
  );
  const [defaultState, defaultFormAction, defaultPending] = useActionState(
    setDefaultAction,
    initialPaymentSourceActionState,
  );
  const [activeState, activeFormAction, activePending] = useActionState(
    setActiveAction,
    initialPaymentSourceActionState,
  );
  const [deleteState, deleteFormAction, deletePending] = useActionState(
    deleteAction,
    initialPaymentSourceActionState,
  );
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  // タイプの選択値を state で持ち、それを <select> の key と defaultValue の両方に渡す。
  //
  // React 19 の <form action={関数}> は、アクション完了時に必ずネイティブの form.reset() を
  // 実行する。reset() は各コントロールを defaultValue / defaultChecked / defaultSelected へ
  // 戻すが、**<select> の defaultSelected は React がマウント時にしか書かない**。
  // そのため defaultValue に今の値を渡していても、リセット後は「マウント時の値」へ巻き戻る
  // （text 入力は更新のたびに defaultValue が同期されるので実害がない。docs/tech-stack.md 参照）。
  //
  // 実害: タイプを変えて保存 → 画面の表示は新しい値になるが DOM の defaultSelected は
  // 古いまま。名前だけ直してもう一度保存すると、送信される type が古い値に戻る。
  //
  // key が変わると <select> が作り直され、マウント時の defaultSelected が現在の選択値になる。
  // 以後の reset() は実質何もしなくなる。
  //
  // key に props の type や保存回数の世代番号を使ってはいけない。保存が名前の重複などで
  // 失敗したときにどちらも動かず（または元の値に戻り）、利用者が選び直した未保存の値を
  // 黙って捨てることになる。これは今直している不具合と同じ形。
  const [selectedType, setSelectedType] = useState(type);

  // サーバーから来た値が変わったら state を追従させる。
  // レンダー中に前回の props と比べて調整する（expense-form.tsx の handledSavedCount と同じ書き方。
  // useEffect で書くと一度古い値を描いてから再描画することになる）。
  const [lastType, setLastType] = useState(type);
  if (lastType !== type) {
    setLastType(type);
    setSelectedType(type);
  }

  return (
    <div className="flex flex-col gap-6">
      <form action={updateFormAction} className="flex flex-col gap-3" noValidate>
        <input type="hidden" name="id" value={id} />

        <div className="flex flex-col gap-1.5">
          <label htmlFor="payment-source-name" className="text-sm font-medium">
            名前
          </label>
          {/* text-base(16px) 未満にすると iOS でフォーカス時に画面が拡大するため下げない */}
          <input
            id="payment-source-name"
            name="name"
            type="text"
            required
            defaultValue={name}
            maxLength={PAYMENT_SOURCE_NAME_MAX_LENGTH}
            enterKeyHint="done"
            aria-describedby={updateState.error ? "payment-source-update-error" : undefined}
            aria-invalid={updateState.error ? true : undefined}
            className={fieldClass}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="payment-source-type" className="text-sm font-medium">
            タイプ
          </label>
          <select
            key={selectedType}
            id="payment-source-type"
            name="type"
            defaultValue={selectedType}
            onChange={(event) => {
              const { value } = event.target;
              if (isPaymentSourceType(value)) setSelectedType(value);
            }}
            className={fieldClass}
          >
            {PAYMENT_SOURCE_TYPE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        {updateState.error ? (
          <p
            id="payment-source-update-error"
            role="alert"
            className="text-sm text-red-600 dark:text-red-400"
          >
            {updateState.error}
          </p>
        ) : null}

        <button
          type="submit"
          disabled={updatePending}
          className="h-12 w-full rounded-lg bg-foreground text-base font-medium text-background disabled:opacity-60"
        >
          {updatePending ? "保存中…" : "保存する"}
        </button>
      </form>

      <section className="flex flex-col gap-3 border-t border-black/10 pt-5 dark:border-white/15">
        <h2 className="text-base font-semibold">この払い出し先の状態</h2>

        {isDefault ? (
          <p className="text-sm opacity-70">
            この払い出し先が既定です。支出入力で最初に選ばれます。
          </p>
        ) : (
          <form action={defaultFormAction} className="flex flex-col gap-2">
            <input type="hidden" name="id" value={id} />
            <button
              type="submit"
              disabled={defaultPending || setDefaultBlockedReason !== null}
              className={secondaryButtonClass}
            >
              {defaultPending ? "変更中…" : "既定にする"}
            </button>
            {setDefaultBlockedReason ? (
              <p className="text-sm opacity-70">{setDefaultBlockedReason}</p>
            ) : null}
            {defaultState.error ? (
              <p role="alert" className="text-sm text-red-600 dark:text-red-400">
                {defaultState.error}
              </p>
            ) : null}
          </form>
        )}

        <form action={activeFormAction} className="flex flex-col gap-2">
          <input type="hidden" name="id" value={id} />
          <input type="hidden" name="isActive" value={isActive ? "false" : "true"} />
          <button
            type="submit"
            disabled={activePending || (isActive && deactivateBlockedReason !== null)}
            className={secondaryButtonClass}
          >
            {activePending ? "変更中…" : isActive ? "無効にする" : "有効に戻す"}
          </button>
          {isActive && deactivateBlockedReason ? (
            <p className="text-sm opacity-70">{deactivateBlockedReason}</p>
          ) : null}
          {activeState.error ? (
            <p role="alert" className="text-sm text-red-600 dark:text-red-400">
              {activeState.error}
            </p>
          ) : null}
        </form>
      </section>

      <section className="flex flex-col gap-2 border-t border-black/10 pt-5 dark:border-white/15">
        <h2 className="text-base font-semibold">削除</h2>
        <p className="text-sm opacity-70">
          支出や予算が1件でも紐づいている払い出し先は削除できません。使わなくなった場合は無効にしてください。
        </p>

        {confirmingDelete ? (
          <form action={deleteFormAction} className="flex flex-col gap-2">
            <input type="hidden" name="id" value={id} />
            <p className="text-sm font-medium">「{name}」を削除します。元に戻せません。</p>
            <button
              type="submit"
              disabled={deletePending}
              className="h-12 w-full rounded-lg bg-red-600 text-base font-medium text-white disabled:opacity-60"
            >
              {deletePending ? "削除中…" : "削除する"}
            </button>
            <button
              type="button"
              onClick={() => setConfirmingDelete(false)}
              className={secondaryButtonClass}
            >
              やめる
            </button>
            {deleteState.error ? (
              <p role="alert" className="text-sm text-red-600 dark:text-red-400">
                {deleteState.error}
              </p>
            ) : null}
          </form>
        ) : (
          <>
            <button
              type="button"
              onClick={() => setConfirmingDelete(true)}
              disabled={deleteBlockedReason !== null}
              className="h-12 w-full rounded-lg border border-red-600/60 text-base font-medium text-red-600 disabled:opacity-40 dark:text-red-400"
            >
              削除する
            </button>
            {deleteBlockedReason ? (
              <p className="text-sm opacity-70">{deleteBlockedReason}</p>
            ) : null}
          </>
        )}
      </section>
    </div>
  );
}
