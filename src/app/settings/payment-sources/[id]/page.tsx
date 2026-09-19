import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";

import { PAYMENT_SOURCE_TYPE_LABELS } from "@/lib/payment-source-validation";
import {
  getDeactivateBlockedReason,
  getDeleteBlockedReason,
  getPaymentSourceDetail,
  getSetDefaultBlockedReason,
} from "@/lib/payment-sources";
import { prisma } from "@/lib/prisma";
import { requireUserId } from "@/lib/session";

import { PAYMENT_SOURCES_PATH } from "../action-state";
import {
  deletePaymentSourceAction,
  setDefaultPaymentSourceAction,
  setPaymentSourceActiveAction,
  updatePaymentSourceAction,
} from "../actions";
import { PaymentSourceEditForm } from "./payment-source-edit-form";

export const metadata: Metadata = {
  title: "払い出し先の編集",
};

/**
 * 払い出し先の編集。
 * 「削除できるか」「無効にできるか」は参照件数・既定かどうかで決まるため、
 * サーバー側で理由を求めて画面に渡す。実行時は Server Action 側でも再判定する。
 */
export default async function PaymentSourceEditPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await connection();
  // proxy とは別に、ここで利用者IDを得てデータ層へ渡す（proxy はユーザーIDを渡せない）
  const userId = await requireUserId();
  const { id } = await params;
  const detail = await getPaymentSourceDetail(prisma, userId, id);
  if (!detail) notFound();

  const { paymentSource } = detail;

  return (
    <main className="mx-auto flex w-full max-w-md flex-col gap-6 px-4 py-6">
      <header className="flex flex-col gap-2">
        <Link
          href={PAYMENT_SOURCES_PATH}
          className="text-sm underline underline-offset-4 opacity-70"
        >
          ← 払い出し先の一覧
        </Link>
        <h1 className="text-xl font-bold break-words">{paymentSource.name}</h1>
        <p className="text-sm opacity-70">
          {PAYMENT_SOURCE_TYPE_LABELS[paymentSource.type]}
          {paymentSource.isDefault ? " / 既定" : ""}
          {paymentSource.isActive ? "" : " / 無効"}
        </p>
      </header>

      <PaymentSourceEditForm
        id={paymentSource.id}
        name={paymentSource.name}
        type={paymentSource.type}
        isActive={paymentSource.isActive}
        isDefault={paymentSource.isDefault}
        setDefaultBlockedReason={getSetDefaultBlockedReason(detail)}
        deactivateBlockedReason={getDeactivateBlockedReason(detail)}
        deleteBlockedReason={getDeleteBlockedReason(detail)}
        updateAction={updatePaymentSourceAction}
        setDefaultAction={setDefaultPaymentSourceAction}
        setActiveAction={setPaymentSourceActiveAction}
        deleteAction={deletePaymentSourceAction}
      />
    </main>
  );
}
