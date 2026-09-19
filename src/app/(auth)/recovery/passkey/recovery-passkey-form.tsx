"use client";

import { browserSupportsWebAuthn, startRegistration } from "@simplewebauthn/browser";
import { useState, useSyncExternalStore, type FormEvent, type ReactNode } from "react";

import { RecoveryCodeDisplay } from "@/components/recovery-code-display";
import { DEVICE_NAME_MAX_LENGTH, PASSKEY_ERRORS } from "@/lib/passkey-messages";
import { RECOVERY_COMPLETE_PATH, RECOVERY_ERRORS } from "@/lib/recovery-messages";

import type { PasskeyRegistrationOptionsResult } from "@/lib/passkey";
import type { RecoveryCodeIssuedResult } from "@/lib/recovery-messages";
import type {
  PublicKeyCredentialCreationOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";

/**
 * リカバリー中の新しいパスキーの登録（/recovery/passkey。docs/steps/pub-5.md 設計判断 4）。
 *
 * 流れ: 登録用オプションを取る → ブラウザに鍵を作らせる → サーバで検証し、資格情報の作成とコードの差し替え →
 * **新しいリカバリーコードを一度だけ表示する** → 「控えました」の後に "/" へ。
 *
 * - 生体認証を取り消してもコードは消費されない（サーバーは登録の完了まで差し替えない）。そのままやり直せる
 * - 完了の表示では「なくした端末のパスキーは、設定 > パスキー から削除してください」と伝える（設計判断 7）
 * - コードは state に持つだけで、どこにも保存しない
 */

export const RECOVERY_PASSKEY_UNSUPPORTED_MESSAGE = "この端末はパスキーに対応していません。";

/** リカバリーコードの表示で「控えました」の後に押すボタン */
export const RECOVERY_CONTINUE_LABEL = "家計簿をひらく";

/** 完了の表示の冒頭 */
export const RECOVERY_COMPLETED_LEAD = "新しいパスキーを登録し、アカウントに戻りました。";

/** 完了の表示での古いパスキーの案内（古いパスキーは自動で消さない。設計判断 7） */
export const RECOVERY_OLD_PASSKEY_NOTICE =
  "なくした端末のパスキーは、設定 > パスキー から削除してください。";

export type RecoveryPasskeyFormProps = {
  /** 登録用オプションの生成。通常は startRecoveryPasskeyRegistrationAction */
  start: () => Promise<PasskeyRegistrationOptionsResult>;
  /** 応答の検証と完了。通常は finishRecoveryPasskeyRegistrationAction。成功時は新しいコード（平文）を返す */
  finish: (
    response: RegistrationResponseJSON,
    deviceName: string,
  ) => Promise<RecoveryCodeIssuedResult>;
  /** ブラウザ側の鍵生成。既定は @simplewebauthn/browser の startRegistration */
  register?: (
    optionsJSON: PublicKeyCredentialCreationOptionsJSON,
  ) => Promise<RegistrationResponseJSON>;
  /**
   * 新しいコードを控えた後（「控えました」にチェックしてボタンを押したとき）の遷移。
   * 既定は RECOVERY_COMPLETE_PATH への通常のナビゲーション。**登録の成功の直後には呼ばない**
   */
  onComplete?: () => void;
  /** WebAuthn 対応判定。既定は @simplewebauthn/browser の browserSupportsWebAuthn */
  supportsWebAuthn?: () => boolean;
  /** 登録の前の説明。完了の表示に切り替わったら出さない */
  intro?: ReactNode;
  /** フォームの下（コードの入力画面へのリンクなど）。完了の表示に切り替わったら出さない */
  footer?: ReactNode;
};

function defaultRegister(
  optionsJSON: PublicKeyCredentialCreationOptionsJSON,
): Promise<RegistrationResponseJSON> {
  return startRegistration({ optionsJSON });
}

function defaultOnComplete(): void {
  // Server Action が発行したセッション Cookie を確実に載せるため、通常のナビゲーションで開く
  // （サインアップ・ログインと同じ理由）
  window.location.assign(RECOVERY_COMPLETE_PATH);
}

/** WebAuthn 対応判定は購読するものが無いので、解除だけを返す空の subscribe */
function subscribeNothing(): () => void {
  return () => {};
}

/** サーバ描画時は「対応している」とみなす。判定はブラウザでしかできない */
function assumeSupported(): boolean {
  return true;
}

export function RecoveryPasskeyForm({
  start,
  finish,
  register = defaultRegister,
  onComplete = defaultOnComplete,
  supportsWebAuthn = browserSupportsWebAuthn,
  intro,
  footer,
}: RecoveryPasskeyFormProps) {
  const [deviceName, setDeviceName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // 成功時に一度だけ受け取る新しいリカバリーコード。画面に出すだけで保存しない
  const [recoveryCode, setRecoveryCode] = useState<string | null>(null);
  const supported = useSyncExternalStore(subscribeNothing, supportsWebAuthn, assumeSupported);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);

    // 名前が空のまま生体認証を出さないよう、ここで先に弾く（本判定はサーバ側）
    if (deviceName.trim().length === 0) {
      setError(PASSKEY_ERRORS.deviceNameRequired);
      return;
    }

    setPending(true);
    try {
      const started = await start();
      if (!started.ok) {
        setError(started.error);
        return;
      }

      const response = await register(started.options);
      const finished = await finish(response, deviceName);
      if (!finished.ok) {
        setError(finished.error);
        return;
      }

      // ここではまだ遷移しない。コードを表示し、「控えました」の後に onComplete を呼ぶ
      setRecoveryCode(finished.recoveryCode);
    } catch {
      // 利用者の取り消し・端末側のエラー。コードは消費されていないので、もう一度押せばやり直せる
      setError(RECOVERY_ERRORS.verificationFailed);
    } finally {
      setPending(false);
    }
  }

  if (recoveryCode !== null) {
    return (
      <RecoveryCodeDisplay
        code={recoveryCode}
        lead={RECOVERY_COMPLETED_LEAD}
        notice={RECOVERY_OLD_PASSKEY_NOTICE}
        continueLabel={RECOVERY_CONTINUE_LABEL}
        onContinue={onComplete}
      />
    );
  }

  const describedBy = error
    ? "recovery-passkey-error"
    : supported
      ? undefined
      : "recovery-passkey-unsupported";

  return (
    <>
      {intro}
      <form onSubmit={handleSubmit} className="flex w-full flex-col gap-3" noValidate>
        <div className="flex flex-col gap-2">
          <label htmlFor="recovery-device-name" className="text-sm font-medium">
            この端末の名前
          </label>
          {/* text-base(16px) 未満にすると iOS でフォーカス時に画面が拡大するため下げない */}
          <input
            id="recovery-device-name"
            name="deviceName"
            type="text"
            value={deviceName}
            onChange={(event) => setDeviceName(event.target.value)}
            maxLength={DEVICE_NAME_MAX_LENGTH}
            autoComplete="off"
            placeholder="iPhone"
            className="h-12 w-full rounded-lg border border-black/20 bg-white px-4 text-base text-black outline-none focus:border-black/60 dark:border-white/25 dark:bg-black dark:text-white dark:focus:border-white/70"
          />
          <p className="text-xs opacity-70">
            あとで「設定 &gt; パスキー」で、どの端末のパスキーか見分けるための名前です。
          </p>
        </div>

        <button
          type="submit"
          disabled={pending || !supported}
          aria-describedby={describedBy}
          className="h-14 w-full rounded-lg bg-foreground text-lg font-bold text-background disabled:opacity-60"
        >
          {pending ? "登録中…" : "この端末を登録"}
        </button>

        {supported ? null : (
          <p id="recovery-passkey-unsupported" className="text-sm opacity-70">
            {RECOVERY_PASSKEY_UNSUPPORTED_MESSAGE}
          </p>
        )}

        {error ? (
          <p id="recovery-passkey-error" role="alert" className="text-sm text-red-600 dark:text-red-400">
            {error}
          </p>
        ) : null}
      </form>
      {footer}
    </>
  );
}
