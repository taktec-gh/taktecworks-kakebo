"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import {
  createCategory,
  deleteCategory,
  moveCategory,
  setCategoryHidden,
  updateCategory,
} from "@/lib/categories";
import { CATEGORY_ORDER_ERRORS, isMoveDirection } from "@/lib/category-order";
import {
  CATEGORY_VALIDATION_ERRORS,
  validateCategoryId,
  validateCategoryInput,
} from "@/lib/category-validation";
import { prisma } from "@/lib/prisma";
import { requireUserId } from "@/lib/session";

import {
  CATEGORIES_PATH,
  categoryDetailPath,
  type CategoryActionState,
} from "./action-state";

/**
 * カテゴリの Server Action。
 *
 * すべて useActionState から呼ぶ前提のシグネチャ (prevState, formData) => state で、
 * 失敗時は例外を投げずに利用者向けの日本語メッセージを返す（払い出し先と同じ形）。
 *
 * Server Action は POST エンドポイントとして直接叩けるため、
 * 画面側のガード（proxy）とは別に各アクションの先頭で requireUserId() を呼び、
 * データ層へは必ずその戻り値（ログイン中の利用者ID）を渡す（docs/steps/pub-1.md）。
 */

/** 一覧と編集ページの両方を最新化する */
function revalidateCategories(id?: string): void {
  revalidatePath(CATEGORIES_PATH);
  if (id) revalidatePath(categoryDetailPath(id));
}

/** 追加。成功時は一覧を更新して { error: null } */
export async function createCategoryAction(
  _prevState: CategoryActionState,
  formData: FormData,
): Promise<CategoryActionState> {
  const userId = await requireUserId();

  const validated = validateCategoryInput({
    name: formData.get("name"),
    costType: formData.get("costType"),
  });
  if (!validated.ok) return { error: validated.error };

  const result = await createCategory(prisma, userId, validated.value);
  if (!result.ok) return { error: result.error };

  revalidateCategories();
  return { error: null };
}

/** リネーム / 固定費・変動費の変更 */
export async function updateCategoryAction(
  _prevState: CategoryActionState,
  formData: FormData,
): Promise<CategoryActionState> {
  const userId = await requireUserId();

  const id = validateCategoryId(formData.get("id"));
  if (!id.ok) return { error: id.error };

  const validated = validateCategoryInput({
    name: formData.get("name"),
    costType: formData.get("costType"),
  });
  if (!validated.ok) return { error: validated.error };

  const result = await updateCategory(prisma, userId, {
    id: id.value,
    name: validated.value.name,
    costType: validated.value.costType,
  });
  if (!result.ok) return { error: result.error };

  revalidateCategories(id.value);
  return { error: null };
}

/**
 * 非表示 / 再表示の切り替え。
 * formData の isHidden は "true" のときだけ非表示、それ以外は再表示として扱う。
 */
export async function setCategoryHiddenAction(
  _prevState: CategoryActionState,
  formData: FormData,
): Promise<CategoryActionState> {
  const userId = await requireUserId();

  const id = validateCategoryId(formData.get("id"));
  if (!id.ok) return { error: id.error };

  const isHidden = formData.get("isHidden") === "true";

  const result = await setCategoryHidden(prisma, userId, id.value, isHidden);
  if (!result.ok) return { error: result.error };

  revalidateCategories(id.value);
  return { error: null };
}

/** 並べ替え（上へ / 下へ） */
export async function moveCategoryAction(
  _prevState: CategoryActionState,
  formData: FormData,
): Promise<CategoryActionState> {
  const userId = await requireUserId();

  const id = validateCategoryId(formData.get("id"));
  if (!id.ok) return { error: id.error };

  const direction = formData.get("direction");
  if (!isMoveDirection(direction)) {
    return { error: CATEGORY_ORDER_ERRORS.invalidDirection };
  }

  const result = await moveCategory(prisma, userId, id.value, direction);
  if (!result.ok) return { error: result.error };

  revalidateCategories(id.value);
  return { error: null };
}

/**
 * 削除。参照がゼロのときだけ成功し、そのまま一覧へ戻る。
 * 拒否されたときは編集ページに留まって理由を表示する。
 */
export async function deleteCategoryAction(
  _prevState: CategoryActionState,
  formData: FormData,
): Promise<CategoryActionState> {
  const userId = await requireUserId();

  const id = validateCategoryId(formData.get("id"));
  if (!id.ok) return { error: CATEGORY_VALIDATION_ERRORS.idRequired };

  const result = await deleteCategory(prisma, userId, id.value);
  if (!result.ok) return { error: result.error };

  revalidateCategories();
  redirect(CATEGORIES_PATH);
}
