import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";

import { listPaymentSources } from "@/lib/payment-sources";
import { prisma } from "@/lib/prisma";

import { createPaymentSourceAction, movePaymentSourceAction } from "./actions";
import { PaymentSourceCreateForm } from "./payment-source-create-form";
import { PaymentSourceList } from "./payment-source-list";

export const metadata: Metadata = {
  title: "払い出し先の設定",
};

/**
 * 払い出し先の一覧 + 新規追加。
 *
 * connection() でプリレンダリングを止める。この画面は常に DB の最新状態を出す必要があり、
 * ビルド時に DB へ接続させないため。
 */
export default async function PaymentSourcesPage() {
  await connection();
  const sources = await listPaymentSources(prisma);

  return (
    <main className="mx-auto flex w-full max-w-md flex-col gap-6 px-4 py-6">
      <header className="flex flex-col gap-2">
        <Link href="/" className="text-sm underline underline-offset-4 opacity-70">
          ← ホーム
        </Link>
        <h1 className="text-xl font-bold">払い出し先</h1>
        <p className="text-sm opacity-70">
          支出を「どこから出したか」の選択肢です。月次予算はこの単位で設定します。
        </p>
      </header>

      <PaymentSourceList sources={sources} moveAction={movePaymentSourceAction} />

      <section className="flex flex-col gap-3 border-t border-black/10 pt-5 dark:border-white/15">
        <h2 className="text-base font-semibold">払い出し先を追加</h2>
        <PaymentSourceCreateForm action={createPaymentSourceAction} />
      </section>
    </main>
  );
}
