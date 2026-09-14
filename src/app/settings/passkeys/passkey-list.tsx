"use client";

import { useActionState, useState } from "react";

import {
  initialPasskeyActionState,
  type PasskeyFormAction,
  type PasskeyListItem,
} from "./action-state";

/**
 * 登録済みパスキーの一覧と削除。
 *
 * 削除は支出・払い出し先と同じ**2段階確認**（スマホでの誤タップ対策）。
 * 必須状態で最後の1本を消そうとした場合はサーバ側が拒否し、
 * その理由をそのまま出す（ここはログイン画面ではないので理由を出してよい）。
 */

export type PasskeyListProps = {
  items: readonly PasskeyListItem[];
  /** 通常は Server Action の deletePasskeyAction */
  deleteAction: PasskeyFormAction;
};

export function PasskeyList({ items, deleteAction }: PasskeyListProps) {
  if (items.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-black/20 px-4 py-6 text-center text-sm opacity-70 dark:border-white/25">
        登録された端末はまだありません。下のフォームから登録してください。
      </p>
    );
  }

  return (
    <ul className="flex flex-col gap-2">
      {items.map((item) => (
        <PasskeyRow key={item.id} item={item} deleteAction={deleteAction} />
      ))}
    </ul>
  );
}

type PasskeyRowProps = {
  item: PasskeyListItem;
  deleteAction: PasskeyFormAction;
};

function PasskeyRow({ item, deleteAction }: PasskeyRowProps) {
  const [state, formAction, pending] = useActionState(deleteAction, initialPasskeyActionState);
  const [confirming, setConfirming] = useState(false);

  return (
    <li className="flex flex-col gap-2 rounded-xl border border-black/15 px-4 py-3 dark:border-white/20">
      <div className="flex flex-col gap-0.5">
        <span className="text-base font-semibold">{item.deviceName}</span>
        <span className="text-xs opacity-70">登録 {item.createdAtLabel}</span>
        <span className="text-xs opacity-70">
          最終利用 {item.lastUsedAtLabel ?? "まだ使っていません"}
        </span>
      </div>

      {confirming ? (
        <form action={formAction} className="flex flex-col gap-2">
          <input type="hidden" name="id" value={item.id} />
          <p className="text-sm font-medium">
            「{item.deviceName}」を削除します。この端末からはログインできなくなります。
          </p>
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
            className="h-12 w-full rounded-lg border border-black/20 text-base font-medium dark:border-white/25"
          >
            やめる
          </button>
        </form>
      ) : (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          className="h-11 w-full rounded-lg border border-red-600/60 text-base font-medium text-red-600 dark:text-red-400"
        >
          削除する
        </button>
      )}

      {state.error ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {state.error}
        </p>
      ) : null}
    </li>
  );
}
