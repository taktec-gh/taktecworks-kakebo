import type { Category, CostType, PrismaClient } from "@/generated/prisma/client";

import {
  assignSequentialCategorySortOrder,
  calculateCategoryReorder,
  type MoveDirection,
} from "@/lib/category-order";

/**
 * カテゴリのデータ層。
 *
 * PrismaClient は引数で受け取る（src/lib/payment-sources.ts と同じ方針。
 * テストからモックを差し込めるようにするため）。このモジュールはサーバー専用で、
 * Client Component から import しないこと。
 *
 * 禁止条件（docs/steps/step-4.md「カテゴリの削除は払い出し先と同じ規則」）:
 * - 削除は Expense も CategoryBudget も参照していないときだけ
 * - CategoryBudget は onDelete: Cascade なので、予算が付いたまま消すと予算が黙って消える。
 *   カテゴリ予算が1件でもあれば削除は拒否する
 * - カテゴリに「既定」は無く、「最後の1件は消せない」という制限も設けない
 *
 * これらに触れた操作は例外を投げず { ok: false, error } を返す。
 */

export type CategoryResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** 操作を拒否したときに画面へ出す文言 */
export const CATEGORY_ERRORS = {
  notFound: "対象のカテゴリが見つかりません。",
  duplicateName: "同じ名前のカテゴリがすでに登録されています。",
  deleteReferencedByExpense:
    "このカテゴリには支出が記録されているため削除できません。非表示にしてください。",
  deleteReferencedByBudget:
    "このカテゴリにはカテゴリ予算が設定されているため削除できません。非表示にしてください。",
} as const;

/**
 * Prisma のエラーコードを取り出す。
 *
 * ドライバアダプタ経由では従来と異なるコードが返る（docs/steps/step-2.md の実測）。
 * - 名前の重複 → P2002
 * - 参照がある行の削除 → P2039（P2003 ではない）
 */
function getPrismaErrorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  const code = (error as { code: unknown }).code;
  return typeof code === "string" ? code : null;
}

/**
 * 一覧を取得する。表示→非表示の順、各グループ内は sortOrder 昇順。
 * 同じ sortOrder があっても順序が揺れないよう id を最後のキーにする。
 */
export async function listCategories(client: PrismaClient): Promise<Category[]> {
  return client.category.findMany({
    orderBy: [{ isHidden: "asc" }, { sortOrder: "asc" }, { id: "asc" }],
  });
}

/** 表示中（非表示でない）のカテゴリのみ。支出入力・カテゴリ予算の選択肢に使う */
export async function listVisibleCategories(client: PrismaClient): Promise<Category[]> {
  return client.category.findMany({
    where: { isHidden: false },
    orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
  });
}

/** 1件取得。存在しなければ null */
export async function getCategory(client: PrismaClient, id: string): Promise<Category | null> {
  return client.category.findUnique({ where: { id } });
}

export type CategoryDetail = {
  category: Category;
  /** このカテゴリを参照している支出の件数 */
  expenseCount: number;
  /** このカテゴリに設定されているカテゴリ予算の件数 */
  budgetCount: number;
};

/**
 * 編集画面用に、1件と「削除してよいか」の判断材料をまとめて取得する。
 * 存在しなければ null。
 */
export async function getCategoryDetail(
  client: PrismaClient,
  id: string,
): Promise<CategoryDetail | null> {
  const category = await client.category.findUnique({ where: { id } });
  if (!category) return null;

  const [expenseCount, budgetCount] = await Promise.all([
    client.expense.count({ where: { categoryId: id } }),
    client.categoryBudget.count({ where: { categoryId: id } }),
  ]);

  return { category, expenseCount, budgetCount };
}

/** 削除できない理由。削除してよければ null（純粋関数） */
export function getCategoryDeleteBlockedReason(detail: CategoryDetail): string | null {
  if (detail.expenseCount > 0) return CATEGORY_ERRORS.deleteReferencedByExpense;
  // CategoryBudget は onDelete: Cascade なので、消すと予算が黙って消える。予算があれば拒否する
  if (detail.budgetCount > 0) return CATEGORY_ERRORS.deleteReferencedByBudget;
  return null;
}

export type CreateCategoryInput = {
  name: string;
  costType: CostType;
};

/**
 * 追加する。sortOrder は既存の最大 + 1（一覧の末尾）。
 * isHidden は常に false（追加した直後から使えるようにする）。
 */
export async function createCategory(
  client: PrismaClient,
  input: CreateCategoryInput,
): Promise<CategoryResult<Category>> {
  const aggregate = await client.category.aggregate({ _max: { sortOrder: true } });
  const nextSortOrder = (aggregate._max.sortOrder ?? 0) + 1;

  try {
    const created = await client.category.create({
      data: {
        name: input.name,
        costType: input.costType,
        sortOrder: nextSortOrder,
        isHidden: false,
      },
    });
    return { ok: true, value: created };
  } catch (error) {
    if (getPrismaErrorCode(error) === "P2002") {
      return { ok: false, error: CATEGORY_ERRORS.duplicateName };
    }
    throw error;
  }
}

export type UpdateCategoryInput = {
  id: string;
  name: string;
  costType: CostType;
};

/**
 * 名前と固定費/変動費を更新する（リネーム / 属性変更）。
 * isHidden・sortOrder はここでは変えない。
 */
export async function updateCategory(
  client: PrismaClient,
  input: UpdateCategoryInput,
): Promise<CategoryResult<Category>> {
  try {
    const updated = await client.category.update({
      where: { id: input.id },
      data: { name: input.name, costType: input.costType },
    });
    return { ok: true, value: updated };
  } catch (error) {
    const code = getPrismaErrorCode(error);
    if (code === "P2002") return { ok: false, error: CATEGORY_ERRORS.duplicateName };
    if (code === "P2025") return { ok: false, error: CATEGORY_ERRORS.notFound };
    throw error;
  }
}

/**
 * 表示 / 非表示を切り替える。
 *
 * 払い出し先と違い禁止条件は無い（既定という概念が無く、
 * 「最後の1件」も制限しない。docs/steps/step-4.md）。
 */
export async function setCategoryHidden(
  client: PrismaClient,
  id: string,
  isHidden: boolean,
): Promise<CategoryResult<Category>> {
  const target = await client.category.findUnique({ where: { id } });
  if (!target) return { ok: false, error: CATEGORY_ERRORS.notFound };
  if (target.isHidden === isHidden) return { ok: true, value: target };

  const updated = await client.category.update({ where: { id }, data: { isHidden } });
  return { ok: true, value: updated };
}

/**
 * 同一グループ内で1つ上 / 下へ動かす。
 * 並び順の計算は純粋関数（calculateCategoryReorder）に任せ、ここは反映だけを行う。
 *
 * @returns 反映後の全件（表示順）
 */
export async function moveCategory(
  client: PrismaClient,
  id: string,
  direction: MoveDirection,
): Promise<CategoryResult<Category[]>> {
  const categories = await listCategories(client);
  const reordered = calculateCategoryReorder(categories, id, direction);
  if (!reordered.ok) return { ok: false, error: reordered.error };

  const updated = await client.$transaction(
    reordered.assignments.map((assignment) =>
      client.category.update({
        where: { id: assignment.id },
        data: { sortOrder: assignment.sortOrder },
      }),
    ),
  );

  return { ok: true, value: updated };
}

/**
 * 削除する。Expense も CategoryBudget も1件も紐づいていないときだけ許す。
 * それ以外は非表示を案内する（過去の家計の履歴と設定した予算を壊さないため）。
 *
 * 削除後に残りの sortOrder を 1 からの連番に振り直す（隙間を作らない）。
 */
export async function deleteCategory(
  client: PrismaClient,
  id: string,
): Promise<CategoryResult<null>> {
  const categories = await listCategories(client);
  const target = categories.find((category) => category.id === id);
  if (!target) return { ok: false, error: CATEGORY_ERRORS.notFound };

  const [expenseCount, budgetCount] = await Promise.all([
    client.expense.count({ where: { categoryId: id } }),
    client.categoryBudget.count({ where: { categoryId: id } }),
  ]);
  if (expenseCount > 0) {
    return { ok: false, error: CATEGORY_ERRORS.deleteReferencedByExpense };
  }
  if (budgetCount > 0) {
    return { ok: false, error: CATEGORY_ERRORS.deleteReferencedByBudget };
  }

  const assignments = assignSequentialCategorySortOrder(
    categories.filter((category) => category.id !== id),
  );

  try {
    await client.$transaction([
      client.category.delete({ where: { id } }),
      ...assignments.map((assignment) =>
        client.category.update({
          where: { id: assignment.id },
          data: { sortOrder: assignment.sortOrder },
        }),
      ),
    ]);
    return { ok: true, value: null };
  } catch (error) {
    const code = getPrismaErrorCode(error);
    // 件数を数えたあとに支出が入った場合のフォールバック。
    // CategoryBudget は Cascade なので Restrict で弾かれるのは Expense だけ
    if (code === "P2039" || code === "P2003") {
      return { ok: false, error: CATEGORY_ERRORS.deleteReferencedByExpense };
    }
    if (code === "P2025") return { ok: false, error: CATEGORY_ERRORS.notFound };
    throw error;
  }
}
