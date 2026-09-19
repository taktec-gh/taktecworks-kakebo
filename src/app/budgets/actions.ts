"use server";

import { revalidatePath } from "next/cache";

import { parseBudgetAmountInput } from "@/lib/budget-calculation";
import {
  deleteBudget,
  saveBudgets,
  saveCategoryBudgets,
  type BudgetAmountInput,
  type CategoryBudgetAmountInput,
} from "@/lib/budgets";
import { listCategories } from "@/lib/categories";
import { validatePaymentSourceId } from "@/lib/payment-source-validation";
import { listPaymentSources } from "@/lib/payment-sources";
import { prisma } from "@/lib/prisma";
import { requireUserId } from "@/lib/session";
import { validateYearMonth } from "@/lib/year-month";

import {
  BUDGETS_PATH,
  budgetAmountFieldName,
  categoryBudgetAmountFieldName,
  type BudgetActionState,
} from "./action-state";

/**
 * 予算の Server Action。
 *
 * 払い出し先の予算とカテゴリ予算は、それぞれ**セクション単位で一括保存**する。
 * スマホで金額を数個入れて1回のタップで保存できるほうが速いため（docs/steps/step-4.md）。
 * 保存はデータ層の1トランザクションで反映されるので、途中まで保存された状態にはならない。
 *
 * 失敗時は例外を投げず、利用者向けの日本語メッセージを返す。
 * Server Action は POST エンドポイントとして直接叩けるため、各アクションの先頭で requireUserId() を呼び、
 * データ層へは必ずその戻り値（ログイン中の利用者ID）を渡す（docs/steps/pub-1.md）。
 */

/** どの行の入力が悪いのか分かるように、名前を添えて返す */
function fieldError(name: string, error: string): string {
  return `${name}：${error}`;
}

/**
 * 払い出し先の予算をまとめて保存する。
 *
 * 入力欄名は**その利用者の**払い出し先の一覧から組み立てる。他人の払い出し先IDの
 * 入力欄を送られても読まない。
 *
 * - 送られてこなかった払い出し先の予算は変更しない
 * - 空欄は「未設定」としてレコードを削除する（0 は 0 円の予算として保存する）
 */
export async function saveBudgetsAction(
  _prevState: BudgetActionState,
  formData: FormData,
): Promise<BudgetActionState> {
  const userId = await requireUserId();

  const yearMonth = validateYearMonth(formData.get("yearMonth"));
  if (!yearMonth.ok) return { error: yearMonth.error, saved: false };

  const paymentSources = await listPaymentSources(prisma, userId);
  const inputs: BudgetAmountInput[] = [];

  for (const source of paymentSources) {
    const field = budgetAmountFieldName(source.id);
    if (!formData.has(field)) continue;

    const parsed = parseBudgetAmountInput(formData.get(field));
    if (!parsed.ok) return { error: fieldError(source.name, parsed.error), saved: false };

    inputs.push({ paymentSourceId: source.id, amountYen: parsed.value });
  }

  const result = await saveBudgets(prisma, userId, yearMonth.value, inputs);
  if (!result.ok) return { error: result.error, saved: false };

  revalidatePath(BUDGETS_PATH);
  return { error: null, saved: true };
}

/**
 * カテゴリ予算をまとめて保存する。
 * 任意の補助上限であり、総予算には足さない。
 * 入力欄名は**その利用者の**カテゴリの一覧から組み立てる（他人のカテゴリIDの入力欄は読まない）。
 */
export async function saveCategoryBudgetsAction(
  _prevState: BudgetActionState,
  formData: FormData,
): Promise<BudgetActionState> {
  const userId = await requireUserId();

  const yearMonth = validateYearMonth(formData.get("yearMonth"));
  if (!yearMonth.ok) return { error: yearMonth.error, saved: false };

  const categories = await listCategories(prisma, userId);
  const inputs: CategoryBudgetAmountInput[] = [];

  for (const category of categories) {
    const field = categoryBudgetAmountFieldName(category.id);
    if (!formData.has(field)) continue;

    const parsed = parseBudgetAmountInput(formData.get(field));
    if (!parsed.ok) return { error: fieldError(category.name, parsed.error), saved: false };

    inputs.push({ categoryId: category.id, amountYen: parsed.value });
  }

  const result = await saveCategoryBudgets(prisma, userId, yearMonth.value, inputs);
  if (!result.ok) return { error: result.error, saved: false };

  revalidatePath(BUDGETS_PATH);
  return { error: null, saved: true };
}

/**
 * 予算を1件削除する。
 * 無効な払い出し先に残った予算を、その場で消すためのもの。
 */
export async function deleteBudgetAction(
  _prevState: BudgetActionState,
  formData: FormData,
): Promise<BudgetActionState> {
  const userId = await requireUserId();

  const yearMonth = validateYearMonth(formData.get("yearMonth"));
  if (!yearMonth.ok) return { error: yearMonth.error, saved: false };

  const paymentSourceId = validatePaymentSourceId(formData.get("paymentSourceId"));
  if (!paymentSourceId.ok) return { error: paymentSourceId.error, saved: false };

  const result = await deleteBudget(prisma, userId, paymentSourceId.value, yearMonth.value);
  if (!result.ok) return { error: result.error, saved: false };

  revalidatePath(BUDGETS_PATH);
  return { error: null, saved: true };
}
