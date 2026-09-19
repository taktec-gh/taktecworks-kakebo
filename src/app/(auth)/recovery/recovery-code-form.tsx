"use client";

import { useActionState, useState } from "react";

import {
  initialRecoveryCodeFormState,
  RECOVERY_CODE_FIELD_NAME,
  type RecoveryCodeFormState,
} from "@/lib/recovery-messages";

/**
 * リカバリーコードの入力フォーム（/recovery。docs/steps/pub-5.md 設計判断 9）。
 *
 * - Server Action は props で受け取る（他の画面と同じ形。テストから差し替えられる）
 * - 成功時は Server Action が /recovery/passkey へ redirect するので、ここでは失敗の文言だけを出す
 * - 入力欄は `autocomplete="off"`、`text-base` 以上（iOS の拡大を避ける）。区切りのハイフン・空白・小文字は
 *   サーバーで正規化するので、そのまま入力してよい
 * - 入力は state で持つ（React 19 のフォームの自動リセットで、失敗したときに打ち直しにならないように）
 */

export const RECOVERY_CODE_INPUT_LABEL = "リカバリーコード";
export const RECOVERY_CODE_SUBMIT_LABEL = "次へ";

export type RecoveryCodeFormProps = {
  /** 通常は verifyRecoveryCodeAction */
  verify: (
    prevState: RecoveryCodeFormState,
    formData: FormData,
  ) => Promise<RecoveryCodeFormState>;
};

export function RecoveryCodeForm({ verify }: RecoveryCodeFormProps) {
  const [state, formAction, pending] = useActionState(verify, initialRecoveryCodeFormState);
  const [code, setCode] = useState("");

  return (
    <form action={formAction} className="flex w-full flex-col gap-3">
      <div className="flex flex-col gap-2">
        <label htmlFor="recovery-code" className="text-sm font-medium">
          {RECOVERY_CODE_INPUT_LABEL}
        </label>
        {/* text-base(16px) 未満にすると iOS でフォーカス時に画面が拡大するため下げない */}
        <input
          id="recovery-code"
          name={RECOVERY_CODE_FIELD_NAME}
          type="text"
          value={code}
          onChange={(event) => setCode(event.target.value)}
          autoComplete="off"
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          placeholder="XXXXX-XXXXX-XXXXX-XXXXX"
          aria-describedby={state.error ? "recovery-code-error" : undefined}
          className="h-12 w-full rounded-lg border border-black/20 bg-white px-4 font-mono text-base tracking-wider text-black outline-none focus:border-black/60 dark:border-white/25 dark:bg-black dark:text-white dark:focus:border-white/70"
        />
        <p className="text-xs opacity-70">ハイフンや空白は入れても入れなくてもかまいません。小文字でも大丈夫です。</p>
      </div>

      <button
        type="submit"
        disabled={pending}
        className="h-14 w-full rounded-lg bg-foreground text-lg font-bold text-background disabled:opacity-60"
      >
        {pending ? "確認中…" : RECOVERY_CODE_SUBMIT_LABEL}
      </button>

      {state.error ? (
        <p id="recovery-code-error" role="alert" className="text-sm text-red-600 dark:text-red-400">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}
