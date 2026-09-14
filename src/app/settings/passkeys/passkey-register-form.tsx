"use client";

import { browserSupportsWebAuthn, startRegistration } from "@simplewebauthn/browser";
import { useState, useSyncExternalStore, type FormEvent } from "react";

import { PASSKEY_ERRORS } from "@/lib/passkey-messages";

import type {
  PasskeyRegistrationOptionsResult,
  PasskeyVerificationResult,
} from "@/lib/passkey";
import type {
  PublicKeyCredentialCreationOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";

/**
 * この端末をパスキーとして登録するフォーム。
 *
 * 流れ: 登録用オプションを取る → ブラウザに鍵を作らせる → サーバで検証して保存。
 *
 * Server Action は props で受け取る（他の画面と同じ形。テストから差し替えられる）。
 * ブラウザが WebAuthn 未対応のときはボタンを無効にして理由を出す。
 */

export const PASSKEY_UNSUPPORTED_MESSAGE = "この端末はパスキーに対応していません。";
export const PASSKEY_REGISTERED_MESSAGE = "登録しました。";

export type PasskeyRegisterFormProps = {
  /** 登録用オプションの生成。通常は startPasskeyRegistrationAction */
  start: () => Promise<PasskeyRegistrationOptionsResult>;
  /** 応答の検証と保存。通常は finishPasskeyRegistrationAction */
  finish: (
    response: RegistrationResponseJSON,
    deviceName: string,
  ) => Promise<PasskeyVerificationResult>;
  /** ブラウザ側の鍵生成。既定は @simplewebauthn/browser の startRegistration */
  register?: (
    optionsJSON: PublicKeyCredentialCreationOptionsJSON,
  ) => Promise<RegistrationResponseJSON>;
  /** WebAuthn 対応判定。既定は @simplewebauthn/browser の browserSupportsWebAuthn */
  supportsWebAuthn?: () => boolean;
};

function defaultRegister(
  optionsJSON: PublicKeyCredentialCreationOptionsJSON,
): Promise<RegistrationResponseJSON> {
  return startRegistration({ optionsJSON });
}

/** WebAuthn 対応判定は購読するものが無いので、解除だけを返す空の subscribe */
function subscribeNothing(): () => void {
  return () => {};
}

/** サーバ描画時は「対応している」とみなす。判定はブラウザでしかできない */
function assumeSupported(): boolean {
  return true;
}

export function PasskeyRegisterForm({
  start,
  finish,
  register = defaultRegister,
  supportsWebAuthn = browserSupportsWebAuthn,
}: PasskeyRegisterFormProps) {
  const [deviceName, setDeviceName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [pending, setPending] = useState(false);
  // 判定はブラウザでしかできない。サーバ描画（true）とクライアント描画の
  // 食い違いを React に扱わせるため useSyncExternalStore を使う
  const supported = useSyncExternalStore(subscribeNothing, supportsWebAuthn, assumeSupported);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    setDone(false);

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

      setDeviceName("");
      setDone(true);
    } catch {
      // 利用者の取り消し・端末側のエラー
      setError(PASSKEY_ERRORS.verificationFailed);
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex w-full flex-col gap-3" noValidate>
      <div className="flex flex-col gap-2">
        <label htmlFor="deviceName" className="text-sm font-medium">
          端末の名前
        </label>
        {/* text-base(16px) 未満にすると iOS でフォーカス時に画面が拡大するため下げない */}
        <input
          id="deviceName"
          name="deviceName"
          type="text"
          value={deviceName}
          onChange={(event) => setDeviceName(event.target.value)}
          maxLength={30}
          autoComplete="off"
          placeholder="iPhone"
          className="h-12 w-full rounded-lg border border-black/20 bg-white px-4 text-base text-black outline-none focus:border-black/60 dark:border-white/25 dark:bg-black dark:text-white dark:focus:border-white/70"
        />
      </div>

      <button
        type="submit"
        disabled={pending || !supported}
        className="h-12 w-full rounded-lg bg-foreground text-base font-bold text-background disabled:opacity-60"
      >
        {pending ? "登録中…" : "この端末を登録"}
      </button>

      {supported ? null : <p className="text-sm opacity-70">{PASSKEY_UNSUPPORTED_MESSAGE}</p>}

      {error ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : null}

      {done ? (
        <p role="status" className="text-sm text-green-700 dark:text-green-400">
          {PASSKEY_REGISTERED_MESSAGE}
        </p>
      ) : null}
    </form>
  );
}
