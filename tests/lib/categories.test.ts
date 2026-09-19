// @vitest-environment node
//
// src/lib/categories.ts のデータ層を検証する。
// 実データベースには接続せず、PrismaClient をモックする
// （docs/steps/step-4.md「テストの方針」・「単体テストから実データベースに接続しない」）。
//
// 期待値の根拠:
// - docs/steps/step-4.md「設計判断 > カテゴリの削除は払い出し先と同じ規則」
// - docs/steps/step-4.md「実装完了後の引き継ぎ > 特に確認したい観点」10.
//   「deleteCategory の判定順（支出 → カテゴリ予算）と、削除後に残りが 1..n へ再採番されること」
// - docs/steps/pub-1.md 設計判断 6（全データ操作関数のシグネチャを (client, userId, ...) にする。
//   1件取得は findFirst({ where: { id, userId } })。トランザクション内の各 update も userId で絞る）

import { describe, expect, it, vi } from "vitest";

import { CostType, type Category, type PrismaClient } from "@/generated/prisma/client";
import {
  CATEGORY_ERRORS,
  createCategory,
  deleteCategory,
  getCategory,
  getCategoryDeleteBlockedReason,
  getCategoryDetail,
  listCategories,
  listVisibleCategories,
  moveCategory,
  setCategoryHidden,
  updateCategory,
  type CategoryDetail,
} from "@/lib/categories";
import type { UserId } from "@/lib/user-id";

const NOW = new Date("2026-08-13T00:00:00.000Z");
const USER_ID = "user_1" as UserId;
const OTHER_USER_ID = "user_2" as UserId;

function makeCategory(overrides: Partial<Category> = {}): Category {
  return {
    id: "cat_1",
    userId: USER_ID,
    name: "食費",
    costType: CostType.VARIABLE,
    sortOrder: 1,
    isHidden: false,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as Category;
}

function makeDetail(overrides: Partial<CategoryDetail> = {}): CategoryDetail {
  return {
    category: makeCategory(),
    expenseCount: 0,
    budgetCount: 0,
    ...overrides,
  };
}

/** P2002 (一意制約違反) のような Prisma エラーを再現する */
function prismaError(code: string): Error {
  return Object.assign(new Error(`mock prisma error ${code}`), { code });
}

function createMockClient() {
  const findMany = vi.fn();
  const findFirst = vi.fn();
  const aggregate = vi.fn();
  const create = vi.fn();
  const update = vi.fn();
  const deleteFn = vi.fn();
  const expenseCount = vi.fn();
  const categoryBudgetCount = vi.fn();
  const transaction = vi.fn(async (ops: unknown[]) => Promise.all(ops));

  const client = {
    category: { findMany, findFirst, aggregate, create, update, delete: deleteFn },
    expense: { count: expenseCount },
    categoryBudget: { count: categoryBudgetCount },
    $transaction: transaction,
  } as unknown as PrismaClient;

  return {
    client,
    findMany,
    findFirst,
    aggregate,
    create,
    update,
    deleteFn,
    expenseCount,
    categoryBudgetCount,
    transaction,
  };
}

describe("listCategories", () => {
  it("表示→非表示、各グループ内は sortOrder 昇順で findMany に orderBy を渡し、userId で絞る", async () => {
    const { client, findMany } = createMockClient();
    findMany.mockResolvedValue([]);

    await listCategories(client, USER_ID);

    expect(findMany).toHaveBeenCalledWith({
      where: { userId: USER_ID },
      orderBy: [{ isHidden: "asc" }, { sortOrder: "asc" }, { id: "asc" }],
    });
  });

  it("findMany の結果をそのまま返す", async () => {
    const { client, findMany } = createMockClient();
    const categories = [makeCategory({ id: "a" }), makeCategory({ id: "b" })];
    findMany.mockResolvedValue(categories);

    await expect(listCategories(client, USER_ID)).resolves.toBe(categories);
  });

  it("1件も無い場合は空配列", async () => {
    const { client, findMany } = createMockClient();
    findMany.mockResolvedValue([]);

    await expect(listCategories(client, USER_ID)).resolves.toEqual([]);
  });
});

describe("listVisibleCategories", () => {
  it("userId と isHidden:false で絞り込み、sortOrder 昇順で取得する", async () => {
    const { client, findMany } = createMockClient();
    findMany.mockResolvedValue([]);

    await listVisibleCategories(client, USER_ID);

    expect(findMany).toHaveBeenCalledWith({
      where: { userId: USER_ID, isHidden: false },
      orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
    });
  });
});

describe("getCategory", () => {
  it("存在すればそのレコードを返す。where は { id, userId }", async () => {
    const { client, findFirst } = createMockClient();
    const category = makeCategory();
    findFirst.mockResolvedValue(category);

    await expect(getCategory(client, USER_ID, "cat_1")).resolves.toBe(category);
    expect(findFirst).toHaveBeenCalledWith({ where: { id: "cat_1", userId: USER_ID } });
  });

  it("存在しなければ null", async () => {
    const { client, findFirst } = createMockClient();
    findFirst.mockResolvedValue(null);

    await expect(getCategory(client, USER_ID, "no-such-id")).resolves.toBeNull();
  });

  it("他人の userId を渡すと where に他人の userId が渡る", async () => {
    const { client, findFirst } = createMockClient();
    findFirst.mockResolvedValue(null);

    await getCategory(client, OTHER_USER_ID, "cat_1");
    expect(findFirst).toHaveBeenCalledWith({ where: { id: "cat_1", userId: OTHER_USER_ID } });
  });
});

describe("getCategoryDetail", () => {
  it("存在しない場合は null（カウント系は呼ばない）", async () => {
    const { client, findFirst, expenseCount, categoryBudgetCount } = createMockClient();
    findFirst.mockResolvedValue(null);

    await expect(getCategoryDetail(client, USER_ID, "no-such-id")).resolves.toBeNull();
    expect(expenseCount).not.toHaveBeenCalled();
    expect(categoryBudgetCount).not.toHaveBeenCalled();
  });

  it("存在する場合は支出数・予算数をまとめて返し、各カウントを userId で絞る", async () => {
    const { client, findFirst, expenseCount, categoryBudgetCount } = createMockClient();
    const category = makeCategory({ id: "cat_1" });
    findFirst.mockResolvedValue(category);
    expenseCount.mockResolvedValue(3);
    categoryBudgetCount.mockResolvedValue(1);

    await expect(getCategoryDetail(client, USER_ID, "cat_1")).resolves.toEqual({
      category,
      expenseCount: 3,
      budgetCount: 1,
    });
    expect(expenseCount).toHaveBeenCalledWith({ where: { userId: USER_ID, categoryId: "cat_1" } });
    expect(categoryBudgetCount).toHaveBeenCalledWith({
      where: { userId: USER_ID, categoryId: "cat_1" },
    });
  });
});

describe("getCategoryDeleteBlockedReason（純粋関数、判定順序: 支出あり → 予算あり）", () => {
  it("支出も予算も無ければ null（削除できる）", () => {
    expect(getCategoryDeleteBlockedReason(makeDetail())).toBeNull();
  });

  it("支出参照がある場合は deleteReferencedByExpense（予算より優先）", () => {
    const detail = makeDetail({ expenseCount: 1, budgetCount: 1 });
    expect(getCategoryDeleteBlockedReason(detail)).toBe(
      CATEGORY_ERRORS.deleteReferencedByExpense,
    );
  });

  it("支出は無いが予算参照がある場合は deleteReferencedByBudget", () => {
    const detail = makeDetail({ expenseCount: 0, budgetCount: 1 });
    expect(getCategoryDeleteBlockedReason(detail)).toBe(CATEGORY_ERRORS.deleteReferencedByBudget);
  });
});

describe("createCategory", () => {
  it("既存の最大 sortOrder + 1 を割り当て、isHidden は false で作成する。aggregate は userId で絞る", async () => {
    const { client, aggregate, create } = createMockClient();
    aggregate.mockResolvedValue({ _max: { sortOrder: 4 } });
    create.mockResolvedValue(makeCategory({ sortOrder: 5 }));

    await createCategory(client, USER_ID, { name: "保険", costType: CostType.FIXED });

    expect(aggregate).toHaveBeenCalledWith({
      where: { userId: USER_ID },
      _max: { sortOrder: true },
    });
    expect(create).toHaveBeenCalledWith({
      data: { userId: USER_ID, name: "保険", costType: CostType.FIXED, sortOrder: 5, isHidden: false },
    });
  });

  it("空テーブル（_max.sortOrder が null）では sortOrder = 1 になる", async () => {
    const { client, aggregate, create } = createMockClient();
    aggregate.mockResolvedValue({ _max: { sortOrder: null } });
    create.mockResolvedValue(makeCategory({ sortOrder: 1 }));

    await createCategory(client, USER_ID, { name: "食費", costType: CostType.VARIABLE });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ sortOrder: 1 }) }),
    );
  });

  it("data.userId は引数の userId から設定する", async () => {
    const { client, aggregate, create } = createMockClient();
    aggregate.mockResolvedValue({ _max: { sortOrder: null } });
    create.mockResolvedValue(makeCategory());

    await createCategory(client, USER_ID, { name: "食費", costType: CostType.VARIABLE });

    expect(create.mock.calls[0][0].data.userId).toBe(USER_ID);
  });

  it("成功時は ok:true とレコードを返す", async () => {
    const { client, aggregate, create } = createMockClient();
    aggregate.mockResolvedValue({ _max: { sortOrder: null } });
    const created = makeCategory();
    create.mockResolvedValue(created);

    await expect(
      createCategory(client, USER_ID, { name: "食費", costType: CostType.VARIABLE }),
    ).resolves.toEqual({ ok: true, value: created });
  });

  it("名前重複（P2002）は利用者向けメッセージに変換する", async () => {
    const { client, aggregate, create } = createMockClient();
    aggregate.mockResolvedValue({ _max: { sortOrder: 1 } });
    create.mockRejectedValue(prismaError("P2002"));

    await expect(
      createCategory(client, USER_ID, { name: "食費", costType: CostType.VARIABLE }),
    ).resolves.toEqual({ ok: false, error: CATEGORY_ERRORS.duplicateName });
  });

  it("P2002 以外のエラーはそのまま再送出する", async () => {
    const { client, aggregate, create } = createMockClient();
    aggregate.mockResolvedValue({ _max: { sortOrder: 1 } });
    create.mockRejectedValue(prismaError("P9999"));

    await expect(
      createCategory(client, USER_ID, { name: "食費", costType: CostType.VARIABLE }),
    ).rejects.toThrow();
  });
});

describe("updateCategory", () => {
  it("name と costType だけを更新する。where は { id, userId }", async () => {
    const { client, update } = createMockClient();
    update.mockResolvedValue(makeCategory({ name: "外食" }));

    await updateCategory(client, USER_ID, { id: "cat_1", name: "外食", costType: CostType.VARIABLE });

    expect(update).toHaveBeenCalledWith({
      where: { id: "cat_1", userId: USER_ID },
      data: { name: "外食", costType: CostType.VARIABLE },
    });
  });

  it("成功時は ok:true と更新後のレコードを返す", async () => {
    const { client, update } = createMockClient();
    const updated = makeCategory({ name: "外食" });
    update.mockResolvedValue(updated);

    await expect(
      updateCategory(client, USER_ID, { id: "cat_1", name: "外食", costType: CostType.VARIABLE }),
    ).resolves.toEqual({ ok: true, value: updated });
  });

  it("名前重複（P2002）はエラーメッセージを返す", async () => {
    const { client, update } = createMockClient();
    update.mockRejectedValue(prismaError("P2002"));

    await expect(
      updateCategory(client, USER_ID, { id: "cat_1", name: "食費", costType: CostType.VARIABLE }),
    ).resolves.toEqual({ ok: false, error: CATEGORY_ERRORS.duplicateName });
  });

  it("対象が存在しない（P2025）は notFound", async () => {
    const { client, update } = createMockClient();
    update.mockRejectedValue(prismaError("P2025"));

    await expect(
      updateCategory(client, USER_ID, {
        id: "no-such-id",
        name: "食費",
        costType: CostType.VARIABLE,
      }),
    ).resolves.toEqual({ ok: false, error: CATEGORY_ERRORS.notFound });
  });
});

describe("setCategoryHidden", () => {
  it("対象が存在しなければ notFound", async () => {
    const { client, findFirst, update } = createMockClient();
    findFirst.mockResolvedValue(null);

    await expect(setCategoryHidden(client, USER_ID, "no-such-id", true)).resolves.toEqual({
      ok: false,
      error: CATEGORY_ERRORS.notFound,
    });
    expect(update).not.toHaveBeenCalled();
  });

  it("すでに同じ状態なら何もせず ok（update を呼ばない）", async () => {
    const target = makeCategory({ isHidden: false });
    const { client, findFirst, update } = createMockClient();
    findFirst.mockResolvedValue(target);

    await expect(setCategoryHidden(client, USER_ID, "cat_1", false)).resolves.toEqual({
      ok: true,
      value: target,
    });
    expect(update).not.toHaveBeenCalled();
  });

  it("非表示にする（isHidden: false → true）", async () => {
    const { client, findFirst, update } = createMockClient();
    findFirst.mockResolvedValue(makeCategory({ isHidden: false }));
    const updated = makeCategory({ isHidden: true });
    update.mockResolvedValue(updated);

    await expect(setCategoryHidden(client, USER_ID, "cat_1", true)).resolves.toEqual({
      ok: true,
      value: updated,
    });
    expect(update).toHaveBeenCalledWith({
      where: { id: "cat_1", userId: USER_ID },
      data: { isHidden: true },
    });
  });

  it("再表示する（isHidden: true → false）。最後の1件でも制限は無い", async () => {
    const { client, findFirst, update } = createMockClient();
    findFirst.mockResolvedValue(makeCategory({ isHidden: true }));
    const updated = makeCategory({ isHidden: false });
    update.mockResolvedValue(updated);

    await expect(setCategoryHidden(client, USER_ID, "cat_1", false)).resolves.toEqual({
      ok: true,
      value: updated,
    });
  });
});

describe("moveCategory", () => {
  it("計算結果をトランザクションで反映し、反映後の全件を返す。各 update の where に userId がある", async () => {
    const categories = [
      makeCategory({ id: "a1", sortOrder: 1, isHidden: false }),
      makeCategory({ id: "a2", sortOrder: 2, isHidden: false }),
    ];
    const { client, findMany, update, transaction } = createMockClient();
    findMany.mockResolvedValue(categories);
    update.mockImplementation(
      async (args: { where: { id: string; userId: UserId }; data: { sortOrder: number } }) =>
        makeCategory({ id: args.where.id, sortOrder: args.data.sortOrder }),
    );

    const result = await moveCategory(client, USER_ID, "a1", "down");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.map((c) => [c.id, c.sortOrder])).toEqual([
        ["a2", 1],
        ["a1", 2],
      ]);
    }
    expect(transaction).toHaveBeenCalledTimes(1);
    for (const call of update.mock.calls) {
      expect(call[0].where.userId).toBe(USER_ID);
    }
  });

  it("移動できない場合はエラーを返し、トランザクションを起こさない", async () => {
    const categories = [makeCategory({ id: "a1", sortOrder: 1, isHidden: false })];
    const { client, findMany, transaction } = createMockClient();
    findMany.mockResolvedValue(categories);

    const result = await moveCategory(client, USER_ID, "a1", "up");

    expect(result.ok).toBe(false);
    expect(transaction).not.toHaveBeenCalled();
  });
});

describe("deleteCategory — 判定順序: 支出あり → 予算あり", () => {
  it("対象が存在しなければ notFound", async () => {
    const { client, findMany, expenseCount, categoryBudgetCount } = createMockClient();
    findMany.mockResolvedValue([]);

    await expect(deleteCategory(client, USER_ID, "no-such-id")).resolves.toEqual({
      ok: false,
      error: CATEGORY_ERRORS.notFound,
    });
    expect(expenseCount).not.toHaveBeenCalled();
    expect(categoryBudgetCount).not.toHaveBeenCalled();
  });

  it("支出が1件でもあれば削除できない（予算より先に判定される）。カウントは userId で絞る", async () => {
    const target = makeCategory({ id: "cat_1" });
    const { client, findMany, expenseCount, categoryBudgetCount } = createMockClient();
    findMany.mockResolvedValue([target]);
    expenseCount.mockResolvedValue(1);
    categoryBudgetCount.mockResolvedValue(1);

    await expect(deleteCategory(client, USER_ID, "cat_1")).resolves.toEqual({
      ok: false,
      error: CATEGORY_ERRORS.deleteReferencedByExpense,
    });
    expect(expenseCount).toHaveBeenCalledWith({ where: { userId: USER_ID, categoryId: "cat_1" } });
  });

  it("支出は無いがカテゴリ予算があれば削除できない", async () => {
    const target = makeCategory({ id: "cat_1" });
    const { client, findMany, expenseCount, categoryBudgetCount } = createMockClient();
    findMany.mockResolvedValue([target]);
    expenseCount.mockResolvedValue(0);
    categoryBudgetCount.mockResolvedValue(1);

    await expect(deleteCategory(client, USER_ID, "cat_1")).resolves.toEqual({
      ok: false,
      error: CATEGORY_ERRORS.deleteReferencedByBudget,
    });
  });

  it("支出も予算も無ければ削除でき、残りの sortOrder を 1..n の連番に振り直す。where は { id, userId }", async () => {
    const target = makeCategory({ id: "cat_1", sortOrder: 1 });
    const other = makeCategory({ id: "cat_2", sortOrder: 2 });
    const { client, findMany, expenseCount, categoryBudgetCount, deleteFn, update, transaction } =
      createMockClient();
    findMany.mockResolvedValue([target, other]);
    expenseCount.mockResolvedValue(0);
    categoryBudgetCount.mockResolvedValue(0);
    deleteFn.mockResolvedValue(target);
    update.mockResolvedValue(makeCategory({ id: "cat_2", sortOrder: 1 }));

    await expect(deleteCategory(client, USER_ID, "cat_1")).resolves.toEqual({
      ok: true,
      value: null,
    });

    expect(deleteFn).toHaveBeenCalledWith({ where: { id: "cat_1", userId: USER_ID } });
    expect(update).toHaveBeenCalledWith({
      where: { id: "cat_2", userId: USER_ID },
      data: { sortOrder: 1 },
    });
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it("競合で参照が発生していた場合のフォールバック（P2039）も同じ理由を返す", async () => {
    const target = makeCategory({ id: "cat_1" });
    const { client, findMany, expenseCount, categoryBudgetCount, transaction } =
      createMockClient();
    findMany.mockResolvedValue([target]);
    expenseCount.mockResolvedValue(0);
    categoryBudgetCount.mockResolvedValue(0);
    transaction.mockRejectedValue(prismaError("P2039"));

    await expect(deleteCategory(client, USER_ID, "cat_1")).resolves.toEqual({
      ok: false,
      error: CATEGORY_ERRORS.deleteReferencedByExpense,
    });
  });

  it("対象が削除の直前に消えていた場合（P2025）は notFound", async () => {
    const target = makeCategory({ id: "cat_1" });
    const { client, findMany, expenseCount, categoryBudgetCount, transaction } =
      createMockClient();
    findMany.mockResolvedValue([target]);
    expenseCount.mockResolvedValue(0);
    categoryBudgetCount.mockResolvedValue(0);
    transaction.mockRejectedValue(prismaError("P2025"));

    await expect(deleteCategory(client, USER_ID, "cat_1")).resolves.toEqual({
      ok: false,
      error: CATEGORY_ERRORS.notFound,
    });
  });
});
