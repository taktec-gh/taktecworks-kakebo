import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { RECOVERY_PATH } from "@/lib/recovery-messages";
import { getRecoverySession } from "@/lib/recovery-session";
import { isServerActionRerender } from "@/lib/server-action-request";

import {
  finishRecoveryPasskeyRegistrationAction,
  startRecoveryPasskeyRegistrationAction,
} from "../actions";
import { RecoveryPasskeyForm } from "./recovery-passkey-form";

export const metadata: Metadata = {
  title: "新しいパスキーの登録 | 家計簿",
};

/**
 * リカバリー中の新しいパスキーの登録画面（公開パス。docs/steps/pub-5.md 設計判断 4・5）。
 *
 * - **リカバリー用トークンが無ければ /recovery へ移す**（無い・期限切れ・改竄・通常のセッションだけ）
 * - この画面は家計データを出さない。利用者について出すものも無い（登録のボタンだけ）
 * - 例外: 登録の完了の Server Action の後の再描画（リカバリー用トークンを消した直後）では移さない。
 *   移すと、一度しか表示しない新しいコードの表示が消えてしまうため（src/lib/server-action-request.ts）。
 *   Server Action 自身がリカバリー用トークンを検証するので、ここで省いても登録はできない
 */
export default async function RecoveryPasskeyPage() {
  const recovery = await getRecoverySession();
  if (!recovery && !(await isServerActionRerender())) redirect(RECOVERY_PATH);

  return (
    <main className="flex min-h-dvh w-full items-center justify-center px-5 py-10">
      <div className="flex w-full max-w-sm flex-col gap-6">
        <h1 className="text-2xl font-bold">新しいパスキーの登録</h1>

        <RecoveryPasskeyForm
          start={startRecoveryPasskeyRegistrationAction}
          finish={finishRecoveryPasskeyRegistrationAction}
          intro={
            <section aria-label="登録について" className="flex flex-col gap-3 text-sm leading-relaxed">
              <p>
                リカバリーコードを確認しました。この端末のパスキー（指紋・顔・PIN）を登録すると、元のアカウントに戻れます。
              </p>
              <p className="opacity-80">
                登録が終わるまで、リカバリーコードは使われません。登録を取り消しても、もう一度やり直せます（10分以内）。
              </p>
            </section>
          }
          footer={
            <div className="flex flex-col gap-1 border-t border-black/10 pt-5 text-sm dark:border-white/15">
              <Link href={RECOVERY_PATH} className="font-semibold underline underline-offset-4">
                リカバリーコードを入力し直す
              </Link>
            </div>
          }
        />
      </div>
    </main>
  );
}
