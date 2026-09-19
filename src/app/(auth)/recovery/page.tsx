import type { Metadata } from "next";
import Link from "next/link";

import { LOGIN_PATH } from "@/lib/auth";

import { verifyRecoveryCodeAction } from "./actions";
import { RecoveryCodeForm } from "./recovery-code-form";

export const metadata: Metadata = {
  title: "パスキーをなくした場合 | 家計簿",
};

/**
 * リカバリーコードの入力画面（公開パス。docs/steps/pub-5.md 設計判断 4・9）。
 *
 * コードが正しければ、新しいパスキーの登録画面（/recovery/passkey）へ移る。
 * この画面は状態を読まず、誰に対しても同じものを出す（ログイン画面と同じ）。
 */
export default function RecoveryPage() {
  return (
    <main className="flex min-h-dvh w-full items-center justify-center px-5 py-10">
      <div className="flex w-full max-w-sm flex-col gap-6">
        <h1 className="text-2xl font-bold">パスキーをなくした場合</h1>

        <section aria-label="リカバリーについて" className="flex flex-col gap-3 text-sm leading-relaxed">
          <p>
            アカウントを作ったときに表示された<span className="font-semibold">リカバリーコード</span>
            を入力してください。この端末で新しいパスキーを登録して、元のアカウントに戻れます。
          </p>
          <p className="opacity-80">
            コードは一度使うと使えなくなり、新しいコードが表示されます。
          </p>
        </section>

        <RecoveryCodeForm verify={verifyRecoveryCodeAction} />

        <div className="flex flex-col gap-1 border-t border-black/10 pt-5 text-sm dark:border-white/15">
          <p className="opacity-70">パスキーが手元にある方</p>
          <Link href={LOGIN_PATH} className="font-semibold underline underline-offset-4">
            ログイン画面に戻る
          </Link>
        </div>
      </div>
    </main>
  );
}
