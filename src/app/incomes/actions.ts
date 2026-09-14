"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { LOGIN_PATH } from "@/lib/auth";
import { validateIncomeId, validateIncomeInput } from "@/lib/income-validation";
import { createIncome, deleteIncome } from "@/lib/incomes";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/session";

import { DASHBOARD_PATH } from "../dashboard-path";
import { INCOMES_PATH, type IncomeActionState } from "./action-state";

/**
 * 収入の Server Action。
 *
 * すべて useActionState から呼ぶ前提のシグネチャ (prevState, formData) => state で、
 * 失敗時は例外を投げずに利用者向けの日本語メッセージを返す。
 *
 * Server Action は POST エンドポイントとして直接叩けるため、
 * 画面側のガード（proxy）とは別に各アクションでもセッションを確認する。
 *
 * **更新は無い。** 追加と削除だけ（docs/steps/step-6.md「編集画面は作らない」）。
 */

async function requireSession(): Promise<void> {
  const session = await getSession();
  if (!session) redirect(LOGIN_PATH);
}

/**
 * 収入画面とダッシュボードの両方を更新する。
 * ダッシュボードは収支（前月の収入 − 今月の支出）と「今月の収入」を出しているため、
 * ここを忘れると収入を入れてもトップの数字が古いままになる。
 */
function revalidateIncomes(): void {
  revalidatePath(INCOMES_PATH);
  revalidatePath(DASHBOARD_PATH);
}

/**
 * 1件追加する。
 *
 * 成功しても画面を移動しない（給与と賞与のように続けて2件入れることがある）。
 * 入力欄のクリアは画面側の担当。
 */
export async function createIncomeAction(
  prevState: IncomeActionState,
  formData: FormData,
): Promise<IncomeActionState> {
  await requireSession();

  const validated = validateIncomeInput({
    yearMonth: formData.get("yearMonth"),
    amount: formData.get("amount"),
    label: formData.get("label"),
  });
  if (!validated.ok) return { error: validated.error, savedCount: prevState.savedCount };

  const result = await createIncome(prisma, validated.value);
  if (!result.ok) return { error: result.error, savedCount: prevState.savedCount };

  revalidateIncomes();
  return { error: null, savedCount: prevState.savedCount + 1 };
}

/** 1件削除する（物理削除）。誤操作を防ぐ確認は画面側で1段挟む */
export async function deleteIncomeAction(
  prevState: IncomeActionState,
  formData: FormData,
): Promise<IncomeActionState> {
  await requireSession();

  const id = validateIncomeId(formData.get("id"));
  if (!id.ok) return { error: id.error, savedCount: prevState.savedCount };

  const result = await deleteIncome(prisma, id.value);
  if (!result.ok) return { error: result.error, savedCount: prevState.savedCount };

  revalidateIncomes();
  return { error: null, savedCount: prevState.savedCount + 1 };
}
