import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";

import { listCredentials } from "@/lib/credentials";
import { formatDateFullLabel, getCurrentDate } from "@/lib/expense-date";
import { prisma } from "@/lib/prisma";
import { requireUserId } from "@/lib/session";

import { deletePasskeyAction, finishPasskeyRegistrationAction, startPasskeyRegistrationAction } from "./actions";
import type { PasskeyListItem } from "./action-state";
import { PasskeyList } from "./passkey-list";
import { PasskeyRegisterForm } from "./passkey-register-form";

export const metadata: Metadata = {
  title: "パスキー",
};

/**
 * 登録済みパスキーの一覧 + 登録 + 削除。
 *
 * connection() でプリレンダリングを止める。この画面は常に DB の最新状態を出す必要があり、
 * ビルド時に DB へ接続させないため。
 *
 * **1本しか無いときは追加登録を促す。** 1台を失うと締め出されるため
 * （docs/steps/step-7.md「設計判断 2. 締め出し対策」）。
 */

/** 日時（UTC の瞬間）を JST の暦日ラベルにする */
function toJstLabel(date: Date): string {
  return formatDateFullLabel(getCurrentDate(date));
}

export default async function PasskeysPage() {
  await connection();
  // proxy とは別に、ここで利用者IDを得てデータ層へ渡す（proxy はユーザーIDを渡せない）
  const userId = await requireUserId();

  const credentials = await listCredentials(prisma, userId);
  // publicKey / counter はクライアントへ渡さない
  const items: PasskeyListItem[] = credentials.map((credential) => ({
    id: credential.id,
    deviceName: credential.deviceName,
    createdAtLabel: toJstLabel(credential.createdAt),
    lastUsedAtLabel: credential.lastUsedAt ? toJstLabel(credential.lastUsedAt) : null,
  }));

  return (
    <main className="mx-auto flex w-full max-w-md flex-col gap-6 px-4 py-6">
      <header className="flex flex-col gap-2">
        <Link href="/" className="text-sm underline underline-offset-4 opacity-70">
          ← ホーム
        </Link>
        <h1 className="text-xl font-bold">パスキー</h1>
        <p className="text-sm opacity-70">
          パスキーを1台でも登録すると、登録した端末からしかログインできなくなります。
        </p>
      </header>

      <PasskeyList items={items} deleteAction={deletePasskeyAction} />

      {items.length === 1 ? (
        <p className="rounded-lg border border-amber-500/60 px-4 py-3 text-sm">
          ⚠ バックアップ用にもう1台登録してください。
          <br />
          この1台を失うと、ログインできなくなります。
        </p>
      ) : null}

      <section className="flex flex-col gap-3 border-t border-black/10 pt-5 dark:border-white/15">
        <h2 className="text-base font-semibold">この端末を登録</h2>
        <PasskeyRegisterForm
          start={startPasskeyRegistrationAction}
          finish={finishPasskeyRegistrationAction}
        />
      </section>
    </main>
  );
}
