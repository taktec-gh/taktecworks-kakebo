import type { Metadata } from "next";

import { loginAction } from "./actions";
import { LoginForm } from "./login-form";
import { startPasskeyLoginAction, verifyPasskeyLoginAction } from "./passkey-actions";
import { PasskeyLoginButton } from "./passkey-login-button";

export const metadata: Metadata = {
  title: "ログイン | 家計簿",
};

/**
 * ログイン画面。
 *
 * パスキーを主動線にし、パスワードは折りたたんだ下に置く
 * （docs/steps/step-7.md「画面 > /login」）。
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

        <hr className="border-black/15 dark:border-white/20" />

        {/* 既定は閉じる。details にしておくと JavaScript 無しでも開ける */}
        <details className="flex w-full flex-col gap-4">
          <summary className="cursor-pointer list-none text-sm font-medium underline underline-offset-4">
            パスワードでログイン
          </summary>
          <div className="pt-4">
            <LoginForm action={loginAction} />
          </div>
        </details>
      </div>
    </main>
  );
}
