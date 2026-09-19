"use client";

import { browserSupportsWebAuthn, startRegistration } from "@simplewebauthn/browser";
import { useState, useSyncExternalStore, type FormEvent } from "react";

import { DEVICE_NAME_MAX_LENGTH, PASSKEY_ERRORS } from "@/lib/passkey-messages";
import { SIGNUP_COMPLETE_PATH, SIGNUP_ERRORS } from "@/lib/signup-messages";

import type {
  PasskeyRegistrationOptionsResult,
  PasskeyVerificationResult,
} from "@/lib/passkey";
import type {
  PublicKeyCredentialCreationOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";

/**
 * サインアップのフォーム（端末の名前 + 「パスキーでアカウントを作る」）。
 *
 * 流れ: 登録用オプションを取る → ブラウザに鍵を作らせる → サーバで検証し、ユーザーを作る → "/" へ。
 *
 * - Server Action は props で受け取る（設定画面の登録フォームと同じ形。テストから差し替えられる）
 * - 失敗理由はサーバから返った文言をそのまま出す（サインアップでは理由を出してよい。
 *   内部事情はサーバ側で一般的な文言にしてある）
 * - ブラウザ側での取り消し・失敗は SIGNUP_ERRORS.verificationFailed
 * - ブラウザが WebAuthn 未対応のときはボタンを無効にして理由を出す
 */

export const SIGNUP_UNSUPPORTED_MESSAGE = "この端末はパスキーに対応していません。";

export type SignupFormProps = {
  /** 登録用オプションの生成。通常は startSignupAction */
  start: () => Promise<PasskeyRegistrationOptionsResult>;
  /** 応答の検証とユーザー作成。通常は finishSignupAction */
  finish: (
    response: RegistrationResponseJSON,
    deviceName: string,
  ) => Promise<PasskeyVerificationResult>;
  /** ブラウザ側の鍵生成。既定は @simplewebauthn/browser の startRegistration */
  register?: (
    optionsJSON: PublicKeyCredentialCreationOptionsJSON,
  ) => Promise<RegistrationResponseJSON>;
  /** 成功後の遷移。既定は SIGNUP_COMPLETE_PATH への通常のナビゲーション */
  onSuccess?: () => void;
  /** WebAuthn 対応判定。既定は @simplewebauthn/browser の browserSupportsWebAuthn */
  supportsWebAuthn?: () => boolean;
};

function defaultRegister(
  optionsJSON: PublicKeyCredentialCreationOptionsJSON,
): Promise<RegistrationResponseJSON> {
  return startRegistration({ optionsJSON });
}

function defaultOnSuccess(): void {
  // Server Action が発行したセッション Cookie を確実に載せるため、
  // クライアント側のルータ遷移ではなく通常のナビゲーションで開く（PasskeyLoginButton と同じ理由）。
  // 遷移先は SIGNUP_COMPLETE_PATH の1箇所で決める（リカバリーコードの画面を後で挟むため）
  // eslint-disable-next-line @next/next/no-location-assign-relative-destination
  window.location.assign(SIGNUP_COMPLETE_PATH);
}

/** WebAuthn 対応判定は購読するものが無いので、解除だけを返す空の subscribe */
function subscribeNothing(): () => void {
  return () => {};
}

/** サーバ描画時は「対応している」とみなす。判定はブラウザでしかできない */
function assumeSupported(): boolean {
  return true;
}

export function SignupForm({
  start,
  finish,
  register = defaultRegister,
  onSuccess = defaultOnSuccess,
  supportsWebAuthn = browserSupportsWebAuthn,
}: SignupFormProps) {
  const [deviceName, setDeviceName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
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

      onSuccess();
    } catch {
      // 利用者の取り消し・端末側のエラー
      setError(SIGNUP_ERRORS.verificationFailed);
    } finally {
      setPending(false);
    }
  }

  const describedBy = error ? "signup-error" : supported ? undefined : "signup-unsupported";

  return (
    <form onSubmit={handleSubmit} className="flex w-full flex-col gap-3" noValidate>
      <div className="flex flex-col gap-2">
        <label htmlFor="signup-device-name" className="text-sm font-medium">
          この端末の名前
        </label>
        {/* text-base(16px) 未満にすると iOS でフォーカス時に画面が拡大するため下げない */}
        <input
          id="signup-device-name"
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
        {pending ? "作成中…" : "パスキーでアカウントを作る"}
      </button>

      {supported ? null : (
        <p id="signup-unsupported" className="text-sm opacity-70">
          {SIGNUP_UNSUPPORTED_MESSAGE}
        </p>
      )}

      {error ? (
        <p id="signup-error" role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : null}
    </form>
  );
}
