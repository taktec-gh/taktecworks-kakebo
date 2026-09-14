"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { LOGIN_PATH } from "@/lib/auth";
import { validateExpenseId, validateExpenseInput } from "@/lib/expense-validation";
import { createExpense, deleteExpense, updateExpense } from "@/lib/expenses";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/session";

import {
  EXPENSES_PATH,
  expenseDetailPath,
  NEW_EXPENSE_PATH,
  type ExpenseActionState,
} from "./action-state";

/**
 * 支出の Server Action。
 *
 * すべて useActionState から呼ぶ前提のシグネチャ (prevState, formData) => state で、
 * 失敗時は例外を投げずに利用者向けの日本語メッセージを返す。
 *
 * Server Action は POST エンドポイントとして直接叩けるため、
 * 画面側のガード（proxy）とは別に各アクションでもセッションを確認する。
 */

async function requireSession(): Promise<void> {
  const session = await getSession();
  if (!session) redirect(LOGIN_PATH);
}

/** 一覧・登録・編集のいずれからも最新の内容が見えるようにする */
function revalidateExpenses(id?: string): void {
  revalidatePath(EXPENSES_PATH);
  revalidatePath(NEW_EXPENSE_PATH);
  if (id) revalidatePath(expenseDetailPath(id));
}

/** フォームから検証済みの入力を取り出す */
function readInput(formData: FormData, now: Date) {
  return validateExpenseInput(
    {
      date: formData.get("date"),
      amount: formData.get("amount"),
      categoryId: formData.get("categoryId"),
      paymentSourceId: formData.get("paymentSourceId"),
      wasteTag: formData.get("wasteTag"),
      storeName: formData.get("storeName"),
      memo: formData.get("memo"),
    },
    now,
  );
}

/**
 * 登録する。
 *
 * **成功しても画面を移動しない。** レジで続けて2件入力することがあるため、
 * 入力画面に留まって金額とカテゴリだけをクリアする（画面側の担当）。
 * 一覧へ飛ばすと2件目の入力で毎回戻る操作が要る（docs/steps/step-5.md）。
 */
export async function createExpenseAction(
  prevState: ExpenseActionState,
  formData: FormData,
): Promise<ExpenseActionState> {
  await requireSession();

  const validated = readInput(formData, new Date());
  if (!validated.ok) return { error: validated.error, savedCount: prevState.savedCount };

  const result = await createExpense(prisma, validated.value);
  if (!result.ok) return { error: result.error, savedCount: prevState.savedCount };

  revalidateExpenses();
  return { error: null, savedCount: prevState.savedCount + 1 };
}

/** 編集する。成功しても編集画面に留まる（続けて直せるようにするため） */
export async function updateExpenseAction(
  prevState: ExpenseActionState,
  formData: FormData,
): Promise<ExpenseActionState> {
  await requireSession();

  const id = validateExpenseId(formData.get("id"));
  if (!id.ok) return { error: id.error, savedCount: prevState.savedCount };

  const validated = readInput(formData, new Date());
  if (!validated.ok) return { error: validated.error, savedCount: prevState.savedCount };

  const result = await updateExpense(prisma, id.value, validated.value);
  if (!result.ok) return { error: result.error, savedCount: prevState.savedCount };

  revalidateExpenses(id.value);
  return { error: null, savedCount: prevState.savedCount + 1 };
}

/**
 * 削除する（物理削除）。
 * 成功したら一覧へ戻る。拒否されたときは編集画面に留まって理由を表示する。
 */
export async function deleteExpenseAction(
  prevState: ExpenseActionState,
  formData: FormData,
): Promise<ExpenseActionState> {
  await requireSession();

  const id = validateExpenseId(formData.get("id"));
  if (!id.ok) return { error: id.error, savedCount: prevState.savedCount };

  const result = await deleteExpense(prisma, id.value);
  if (!result.ok) return { error: result.error, savedCount: prevState.savedCount };

  revalidateExpenses(id.value);
  redirect(EXPENSES_PATH);
}
