"use client";

import { browserSupportsWebAuthn, startAuthentication } from "@simplewebauthn/browser";
import { useState, useSyncExternalStore } from "react";

import { LOGIN_ERROR_MESSAGE } from "@/lib/auth-messages";

import type {
  PasskeyAuthenticationOptionsResult,
  PasskeyVerificationResult,
} from "@/lib/passkey";
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/server";

/**
 * 「パスキーでログイン」ボタン（ログイン画面の主動線）。
 *
 * 流れ: 認証用オプションを取る → ブラウザに署名させる → サーバで検証 → "/" へ。
 *
 * - **失敗の理由は出さない。** サーバから返る LOGIN_ERROR_MESSAGE をそのまま出し、
 *   ブラウザ側で失敗した場合（利用者の取り消しを含む）も同じ文言にする
 * - パスキーが未登録でも見た目を変えない。登録の有無を画面から推測させないため
 * - **ブラウザが未対応のときだけ**理由を出す。これは秘密ではないので出してよい
 *
 * Server Action は props で受け取る（LoginForm と同じ形。テストから差し替えられる）。
 */

/** ブラウザが WebAuthn を持たないときの案内。これは秘密ではない */
export const PASSKEY_UNSUPPORTED_MESSAGE = "この端末はパスキーに対応していません。";

export type PasskeyLoginButtonProps = {
  /** 認証用オプションの生成。通常は startPasskeyLoginAction */
  start: () => Promise<PasskeyAuthenticationOptionsResult>;
  /** 認証応答の検証。通常は verifyPasskeyLoginAction */
  verify: (response: AuthenticationResponseJSON) => Promise<PasskeyVerificationResult>;
  /** ブラウザ側の署名。既定は @simplewebauthn/browser の startAuthentication */
  authenticate?: (
    optionsJSON: PublicKeyCredentialRequestOptionsJSON,
  ) => Promise<AuthenticationResponseJSON>;
  /** 成功後の遷移。既定はダッシュボードへの再読み込み */
  onSuccess?: () => void;
  /** WebAuthn 対応判定。既定は @simplewebauthn/browser の browserSupportsWebAuthn */
  supportsWebAuthn?: () => boolean;
};

function defaultAuthenticate(
  optionsJSON: PublicKeyCredentialRequestOptionsJSON,
): Promise<AuthenticationResponseJSON> {
  return startAuthentication({ optionsJSON });
}

function defaultOnSuccess(): void {
  // Server Action が発行したセッション Cookie を確実に載せるため、
  // クライアント側のルータ遷移ではなく通常のナビゲーションでダッシュボードを開く。
  // ここはログイン直後の1回だけで、体感速度より確実さを優先する。
  // eslint-disable-next-line @next/next/no-location-assign-relative-destination
  window.location.assign("/");
}

/** WebAuthn 対応判定は購読するものが無いので、解除だけを返す空の subscribe */
function subscribeNothing(): () => void {
  return () => {};
}

/** サーバ描画時は「対応している」とみなす。判定はブラウザでしかできない */
function assumeSupported(): boolean {
  return true;
}

export function PasskeyLoginButton({
  start,
  verify,
  authenticate = defaultAuthenticate,
  onSuccess = defaultOnSuccess,
  supportsWebAuthn = browserSupportsWebAuthn,
}: PasskeyLoginButtonProps) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // 判定はブラウザでしかできない。サーバ描画（true）とクライアント描画の
  // 食い違いを React に扱わせるため useSyncExternalStore を使う
  const supported = useSyncExternalStore(subscribeNothing, supportsWebAuthn, assumeSupported);

  async function handleClick(): Promise<void> {
    setError(null);
    setPending(true);
    try {
      const started = await start();
      if (!started.ok) {
        setError(started.error);
        return;
      }

      const response = await authenticate(started.options);
      const verified = await verify(response);
      if (!verified.ok) {
        setError(verified.error);
        return;
      }

      onSuccess();
    } catch {
      // 利用者の取り消し・端末側のエラーも同じ文言にする
      setError(LOGIN_ERROR_MESSAGE);
    } finally {
      setPending(false);
    }
  }

  const describedBy = error ? "passkey-login-error" : supported ? undefined : "passkey-unsupported";

  return (
    <div className="flex w-full flex-col gap-2">
      <button
        type="button"
        onClick={handleClick}
        disabled={pending || !supported}
        aria-describedby={describedBy}
        className="h-14 w-full rounded-lg bg-foreground text-lg font-bold text-background disabled:opacity-60"
      >
        {pending ? "確認中…" : "パスキーでログイン"}
      </button>

      {supported ? null : (
        <p id="passkey-unsupported" className="text-sm opacity-70">
          {PASSKEY_UNSUPPORTED_MESSAGE}
        </p>
      )}

      {error ? (
        <p
          id="passkey-login-error"
          role="alert"
          className="text-sm text-red-600 dark:text-red-400"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}
