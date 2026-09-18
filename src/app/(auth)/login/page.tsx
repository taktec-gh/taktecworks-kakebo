import type { Metadata } from "next";

import { startPasskeyLoginAction, verifyPasskeyLoginAction } from "./passkey-actions";
import { PasskeyLoginButton } from "./passkey-login-button";

export const metadata: Metadata = {
  title: "ログイン | 家計簿",
};

/**
 * ログイン画面。
 *
 * ログイン手段はパスキーのみ。パスワードログインは公開版で廃止した
 * （docs/steps/pub-1.md 設計判断 1）。
 *
 * **パスキーが未登録でもこの見た目は変えない。**
 * 登録の有無を画面から推測させないため、状態を読んで出し分けることはしない。
 */
export default function LoginPage() {
  return (
    <main className="flex min-h-dvh w-full items-center justify-center px-5 py-10">
      <div className="flex w-full max-w-sm flex-col gap-6">
        <h1 className="text-2xl font-bold">家計簿</h1>

        <PasskeyLoginButton start={startPasskeyLoginAction} verify={verifyPasskeyLoginAction} />
      </div>
    </main>
  );
}
