"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { isMoveDirection, PAYMENT_SOURCE_ORDER_ERRORS } from "@/lib/payment-source-order";
import {
  PAYMENT_SOURCE_VALIDATION_ERRORS,
  validatePaymentSourceId,
  validatePaymentSourceInput,
} from "@/lib/payment-source-validation";
import {
  createPaymentSource,
  deletePaymentSource,
  movePaymentSource,
  setDefaultPaymentSource,
  setPaymentSourceActive,
  updatePaymentSource,
} from "@/lib/payment-sources";
import { prisma } from "@/lib/prisma";
import { requireUserId } from "@/lib/session";

import {
  PAYMENT_SOURCES_PATH,
  paymentSourceDetailPath,
  type PaymentSourceActionState,
} from "./action-state";

/**
 * 払い出し先の Server Action。
 *
 * すべて useActionState から呼ぶ前提のシグネチャ (prevState, formData) => state で、
 * 失敗時は例外を投げずに利用者向けの日本語メッセージを返す（ログイン画面と同じ形）。
 *
 * Server Action は POST エンドポイントとして直接叩けるため、
 * 画面側のガード（proxy）とは別に各アクションの先頭で requireUserId() を呼び、
 * データ層へは必ずその戻り値（ログイン中の利用者ID）を渡す（docs/steps/pub-1.md）。
 */

/** 一覧と編集ページの両方を最新化する */
function revalidatePaymentSources(id?: string): void {
  revalidatePath(PAYMENT_SOURCES_PATH);
  if (id) revalidatePath(paymentSourceDetailPath(id));
}

/** 追加。成功時は一覧を更新して { error: null } */
export async function createPaymentSourceAction(
  _prevState: PaymentSourceActionState,
  formData: FormData,
): Promise<PaymentSourceActionState> {
  const userId = await requireUserId();

  const validated = validatePaymentSourceInput({
    name: formData.get("name"),
    type: formData.get("type"),
  });
  if (!validated.ok) return { error: validated.error };

  const result = await createPaymentSource(prisma, userId, validated.value);
  if (!result.ok) return { error: result.error };

  revalidatePaymentSources();
  return { error: null };
}

/** リネーム / タイプ変更 */
export async function updatePaymentSourceAction(
  _prevState: PaymentSourceActionState,
  formData: FormData,
): Promise<PaymentSourceActionState> {
  const userId = await requireUserId();

  const id = validatePaymentSourceId(formData.get("id"));
  if (!id.ok) return { error: id.error };

  const validated = validatePaymentSourceInput({
    name: formData.get("name"),
    type: formData.get("type"),
  });
  if (!validated.ok) return { error: validated.error };

  const result = await updatePaymentSource(prisma, userId, {
    id: id.value,
    name: validated.value.name,
    type: validated.value.type,
  });
  if (!result.ok) return { error: result.error };

  revalidatePaymentSources(id.value);
  return { error: null };
}

/** 既定にする */
export async function setDefaultPaymentSourceAction(
  _prevState: PaymentSourceActionState,
  formData: FormData,
): Promise<PaymentSourceActionState> {
  const userId = await requireUserId();

  const id = validatePaymentSourceId(formData.get("id"));
  if (!id.ok) return { error: id.error };

  const result = await setDefaultPaymentSource(prisma, userId, id.value);
  if (!result.ok) return { error: result.error };

  revalidatePaymentSources(id.value);
  return { error: null };
}

/**
 * 有効 / 無効の切り替え。
 * formData の isActive は "true" のときだけ有効化、それ以外は無効化として扱う。
 */
export async function setPaymentSourceActiveAction(
  _prevState: PaymentSourceActionState,
  formData: FormData,
): Promise<PaymentSourceActionState> {
  const userId = await requireUserId();

  const id = validatePaymentSourceId(formData.get("id"));
  if (!id.ok) return { error: id.error };

  const isActive = formData.get("isActive") === "true";

  const result = await setPaymentSourceActive(prisma, userId, id.value, isActive);
  if (!result.ok) return { error: result.error };

  revalidatePaymentSources(id.value);
  return { error: null };
}

/** 並べ替え（上へ / 下へ） */
export async function movePaymentSourceAction(
  _prevState: PaymentSourceActionState,
  formData: FormData,
): Promise<PaymentSourceActionState> {
  const userId = await requireUserId();

  const id = validatePaymentSourceId(formData.get("id"));
  if (!id.ok) return { error: id.error };

  const direction = formData.get("direction");
  if (!isMoveDirection(direction)) {
    return { error: PAYMENT_SOURCE_ORDER_ERRORS.invalidDirection };
  }

  const result = await movePaymentSource(prisma, userId, id.value, direction);
  if (!result.ok) return { error: result.error };

  revalidatePaymentSources(id.value);
  return { error: null };
}

/**
 * 削除。参照がゼロのときだけ成功し、そのまま一覧へ戻る。
 * 拒否されたときは編集ページに留まって理由を表示する。
 */
export async function deletePaymentSourceAction(
  _prevState: PaymentSourceActionState,
  formData: FormData,
): Promise<PaymentSourceActionState> {
  const userId = await requireUserId();

  const id = validatePaymentSourceId(formData.get("id"));
  if (!id.ok) return { error: PAYMENT_SOURCE_VALIDATION_ERRORS.idRequired };

  const result = await deletePaymentSource(prisma, userId, id.value);
  if (!result.ok) return { error: result.error };

  revalidatePaymentSources();
  redirect(PAYMENT_SOURCES_PATH);
}
