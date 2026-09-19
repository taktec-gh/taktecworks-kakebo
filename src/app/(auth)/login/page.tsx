import type { Metadata } from "next";
import Link from "next/link";

import { SIGNUP_PATH } from "@/lib/signup-messages";

import { startDemoAction } from "./actions";
import { DemoStartButton } from "./demo-start-button";
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
 * 「デモで試す」を最も目立つ位置に置く（閲覧者の主な入口。docs/steps/pub-3.md 設計判断 9）。
 *
 * **パスキーが未登録でもこの見た目は変えない。**
 * 登録の有無を画面から推測させないため、状態を読んで出し分けることはしない。
 */
export default function LoginPage() {
  return (
    <main className="flex min-h-dvh w-full items-center justify-center px-5 py-10">
      <div className="flex w-full max-w-sm flex-col gap-6">
        <h1 className="text-2xl font-bold">家計簿</h1>

        {/* 閲覧者の主な入口なので、パスキーのログインより先に置く（docs/steps/pub-3.md 設計判断 9） */}
        <section aria-label="デモ" className="flex flex-col gap-2">
          <DemoStartButton start={startDemoAction} />
        </section>

        <p className="border-t border-black/10 pt-5 text-sm opacity-70 dark:border-white/15">
          アカウントをお持ちの方
        </p>

        <PasskeyLoginButton start={startPasskeyLoginAction} verify={verifyPasskeyLoginAction} />

        <p className="text-sm opacity-70">
          別の端末に保存したパスキーも、QR コードを使ってログインに使えます。
        </p>

        <div className="flex flex-col gap-1 border-t border-black/10 pt-5 text-sm dark:border-white/15">
          <p className="opacity-70">はじめて使う方</p>
          <Link href={SIGNUP_PATH} className="font-semibold underline underline-offset-4">
            アカウントを作る
          </Link>
        </div>
      </div>
    </main>
  );
}
