import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { LOGIN_PATH } from "@/lib/auth";
import { isServerActionRerender } from "@/lib/server-action-request";
import { getSession } from "@/lib/session";

import { finishSignupAction, startSignupAction } from "./actions";
import { SignupForm } from "./signup-form";

export const metadata: Metadata = {
  title: "アカウントを作る | 家計簿",
};

/**
 * サインアップ画面（公開パス。docs/steps/pub-2.md 設計判断 6・8）。
 *
 * - ログイン中に開いたら "/" へ移す。ただしサインアップの完了の Server Action の後の再描画
 *   （セッションを発行した直後）では移さない。移すと、一度しか表示しないリカバリーコードの表示が消えてしまうため
 *   （src/lib/server-action-request.ts。docs/steps/pub-5.md 設計判断 3）
 * - 登録ボタンの**前に**、パスキーだけで作ること・端末をなくしたときのこと・デモであること・
 *   既存のアカウントがあるならログイン画面から入ることを読める位置に出す
 * - 登録の後にリカバリーコードを一度だけ表示することと、別の端末の登録を勧めることを登録の前に伝える
 *   （docs/steps/pub-5.md 設計判断 3・9）。コードの表示に切り替わったら、説明とリンクは SignupForm が隠す
 */
export default async function SignupPage() {
  const session = await getSession();
  if (session && !(await isServerActionRerender())) redirect("/");

  return (
    <main className="flex min-h-dvh w-full items-center justify-center px-5 py-10">
      <div className="flex w-full max-w-sm flex-col gap-6">
        <h1 className="text-2xl font-bold">アカウントを作る</h1>

        <SignupForm
          start={startSignupAction}
          finish={finishSignupAction}
          intro={
            <section aria-label="登録の前に" className="flex flex-col gap-3 text-sm leading-relaxed">
              <p>
                メールアドレスもパスワードも要りません。この端末のパスキー（指紋・顔・PIN）でアカウントを作ります。
              </p>

              <p className="rounded-lg border border-amber-500/60 px-4 py-3">
                登録のあとに<span className="font-semibold">リカバリーコード</span>を一度だけ表示します。パスキーをなくしたときにアカウントへ戻るためのものなので、必ず控えてください。
                「設定 &gt; パスキー」から別の端末も登録しておくと安心です。
              </p>

              <p className="rounded-lg border border-black/15 px-4 py-3 dark:border-white/20">
                これはデモです。実在の家計の情報は入力しないでください。データは予告なく削除されることがあります。
              </p>

              <p className="opacity-80">
                すでにアカウントをお持ちなら、ここではなく
                <Link href={LOGIN_PATH} className="font-semibold underline underline-offset-4">
                  ログイン画面
                </Link>
                から入ってください。ここで登録すると別のアカウントになります。別の端末では、スマホのパスキーを QR コードで使ってログインできます。
              </p>
            </section>
          }
          footer={
            <div className="flex flex-col gap-1 border-t border-black/10 pt-5 text-sm dark:border-white/15">
              <p className="opacity-70">アカウントをお持ちの方</p>
              <Link href={LOGIN_PATH} className="font-semibold underline underline-offset-4">
                ログインする
              </Link>
            </div>
          }
        />
      </div>
    </main>
  );
}
