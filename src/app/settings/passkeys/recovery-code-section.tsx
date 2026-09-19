"use client";

import { useState } from "react";

import { RecoveryCodeDisplay } from "@/components/recovery-code-display";
import { RECOVERY_REGENERATE_ERRORS, type RecoveryCodeIssuedResult } from "@/lib/recovery-messages";

/**
 * 設定画面（/settings/passkeys）の「リカバリーコード」の欄（docs/steps/pub-5.md 設計判断 8）。
 *
 * - 発行済みかどうか（`recoveryCodeHash` の有無）と、「作り直す」ボタン
 * - 作り直すと古いコードは使えなくなるので、ボタンの後に確認を1回挟む
 * - 作り直したら新しいコードを一度だけ表示する（RecoveryCodeDisplay）。「控えました」の後に閉じる
 * - **デモユーザーには出さない**（ページ側で出し分ける。Server Action でも拒否する）
 */

export const RECOVERY_SECTION_HEADING = "リカバリーコード";
export const RECOVERY_STATUS_ISSUED = "発行済みです。";
export const RECOVERY_STATUS_NOT_ISSUED = "まだありません。作っておいてください。";
export const RECOVERY_REGENERATE_LABEL = "作り直す";
/** 未発行のとき（パスキーが使えない利用者はいないが、発行前のアカウントに備える） */
export const RECOVERY_CREATE_LABEL = "作る";
export const RECOVERY_REGENERATE_CONFIRM_MESSAGE =
  "作り直すと、今のリカバリーコードは使えなくなります。作り直しますか？";
export const RECOVERY_REGENERATE_CONFIRM_LABEL = "作り直す（今のコードは使えなくなります）";
export const RECOVERY_REGENERATE_CANCEL_LABEL = "やめる";
export const RECOVERY_REGENERATE_DONE_LABEL = "閉じる";

export type RecoveryCodeSectionProps = {
  /** 発行済みか（User.recoveryCodeHash が null でない） */
  hasCode: boolean;
  /** 通常は regenerateRecoveryCodeAction */
  regenerate: () => Promise<RecoveryCodeIssuedResult>;
};

export function RecoveryCodeSection({ hasCode, regenerate }: RecoveryCodeSectionProps) {
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 作り直しで一度だけ受け取るコード。画面に出すだけで保存しない
  const [recoveryCode, setRecoveryCode] = useState<string | null>(null);

  async function handleRegenerate(): Promise<void> {
    setError(null);
    setPending(true);
    try {
      const result = await regenerate();
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setRecoveryCode(result.recoveryCode);
      setConfirming(false);
    } catch {
      setError(RECOVERY_REGENERATE_ERRORS.unavailable);
    } finally {
      setPending(false);
    }
  }

  return (
    <section
      aria-label={RECOVERY_SECTION_HEADING}
      className="flex flex-col gap-3 border-t border-black/10 pt-5 dark:border-white/15"
    >
      <h2 className="text-base font-semibold">{RECOVERY_SECTION_HEADING}</h2>

      {recoveryCode !== null ? (
        <RecoveryCodeDisplay
          code={recoveryCode}
          lead="リカバリーコードを作り直しました。前のコードはもう使えません。"
          continueLabel={RECOVERY_REGENERATE_DONE_LABEL}
          onContinue={() => setRecoveryCode(null)}
        />
      ) : (
        <>
          <p className="text-sm">{hasCode ? RECOVERY_STATUS_ISSUED : RECOVERY_STATUS_NOT_ISSUED}</p>
          <p className="text-sm opacity-70">
            パスキーを登録した端末をすべてなくしたときに、ログイン画面の「パスキーをなくした場合」から使います。
            コードを控えていない・なくした場合は、作り直してください。
          </p>

          {confirming ? (
            <div className="flex flex-col gap-2 rounded-lg border border-amber-500/60 px-4 py-3">
              <p className="text-sm">{RECOVERY_REGENERATE_CONFIRM_MESSAGE}</p>
              <button
                type="button"
                onClick={handleRegenerate}
                disabled={pending}
                className="h-12 w-full rounded-lg bg-foreground text-base font-bold text-background disabled:opacity-60"
              >
                {pending ? "作り直し中…" : RECOVERY_REGENERATE_CONFIRM_LABEL}
              </button>
              <button
                type="button"
                onClick={() => setConfirming(false)}
                disabled={pending}
                className="h-11 w-full rounded-lg border border-black/20 text-base dark:border-white/25"
              >
                {RECOVERY_REGENERATE_CANCEL_LABEL}
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => {
                // 未発行なら確認は要らない（使えなくなる古いコードが無い）
                if (hasCode) setConfirming(true);
                else void handleRegenerate();
              }}
              disabled={pending}
              className="h-12 w-full rounded-lg border border-black/20 text-base font-semibold disabled:opacity-60 dark:border-white/25"
            >
              {pending ? "作成中…" : hasCode ? RECOVERY_REGENERATE_LABEL : RECOVERY_CREATE_LABEL}
            </button>
          )}

          {error ? (
            <p role="alert" className="text-sm text-red-600 dark:text-red-400">
              {error}
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}
