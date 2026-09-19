// @vitest-environment node
//
// src/lib/budgets.ts のデータ層を検証する。
// 実データベースには接続せず、PrismaClient をモックする。
//
// 期待値の根拠:
// - docs/steps/step-4.md「設計判断 > 予算の『未設定』と『0円』を区別する」
// - docs/steps/step-4.md「実装完了後の引き継ぎ > 特に確認したい観点」6.
//   「saveBudgets が、月・金額が不正なときに DB を一切呼ばないこと。null は削除・数値は
//    upsert で、1回の $transaction に渡ること」
// - docs/steps/pub-1.md「実装完了後の引き継ぎ > 仕様から補足・判断した点」
//   「saveBudgets / saveCategoryBudgets の持ち主確認 — 金額を保存する入力の id を
//    findMany({ where: { id: { in }, userId } }) で確かめ、1件でも自分のものでなければ
//    何も保存せず paymentSourceNotFound / categoryNotFound を返す」
//   「upsert の where は { paymentSourceId_yearMonth: {...}, userId }」
// - 同「その他の観点」6.「予算の保存 — 他人の払い出し先・カテゴリの入力欄を送っても
//   無視されること、upsert の where / create に userId」

import { describe, expect, it, vi } from "vitest";

import type { PrismaClient } from "@/generated/prisma/client";
import {
  BUDGET_ERRORS,
  deleteBudget,
  getMonthlyBudgetData,
  listBudgets,
  listCategoryBudgets,
  saveBudgets,
  saveCategoryBudgets,
  type BudgetAmountInput,
  type CategoryBudgetAmountInput,
} from "@/lib/budgets";
import type { UserId } from "@/lib/user-id";

const USER_ID = "user_1" as UserId;

/** P2003 (外部キー制約違反) のような Prisma エラーを再現する */
function prismaError(code: string): Error {
  return Object.assign(new Error(`mock prisma error ${code}`), { code });
}

function createMockClient() {
  const budgetFindMany = vi.fn();
  const budgetDeleteMany = vi.fn();
  const budgetUpsert = vi.fn();
  const categoryBudgetFindMany = vi.fn();
  const categoryBudgetDeleteMany = vi.fn();
  const categoryBudgetUpsert = vi.fn();
  const paymentSourceFindMany = vi.fn();
  const categoryFindMany = vi.fn();
  const transaction = vi.fn(async (ops: unknown[]) => Promise.all(ops));

  const client = {
    budget: { findMany: budgetFindMany, deleteMany: budgetDeleteMany, upsert: budgetUpsert },
    categoryBudget: {
      findMany: categoryBudgetFindMany,
      deleteMany: categoryBudgetDeleteMany,
      upsert: categoryBudgetUpsert,
    },
    paymentSource: { findMany: paymentSourceFindMany },
    category: { findMany: categoryFindMany },
    $transaction: transaction,
  } as unknown as PrismaClient;

  return {
    client,
    budgetFindMany,
    budgetDeleteMany,
    budgetUpsert,
    categoryBudgetFindMany,
    categoryBudgetDeleteMany,
    categoryBudgetUpsert,
    paymentSourceFindMany,
    categoryFindMany,
    transaction,
  };
}

describe("listBudgets", () => {
  it("userId と yearMonth で絞り込んで取得する", async () => {
    const { client, budgetFindMany } = createMockClient();
    budgetFindMany.mockResolvedValue([]);

    await listBudgets(client, USER_ID, "2026-08");

    expect(budgetFindMany).toHaveBeenCalledWith({
      where: { userId: USER_ID, yearMonth: "2026-08" },
    });
  });
});

describe("listCategoryBudgets", () => {
  it("userId と yearMonth で絞り込んで取得する", async () => {
    const { client, categoryBudgetFindMany } = createMockClient();
    categoryBudgetFindMany.mockResolvedValue([]);

    await listCategoryBudgets(client, USER_ID, "2026-08");

    expect(categoryBudgetFindMany).toHaveBeenCalledWith({
      where: { userId: USER_ID, yearMonth: "2026-08" },
    });
  });
});

describe("getMonthlyBudgetData", () => {
  it("払い出し先・予算・カテゴリ・カテゴリ予算をまとめて取得する。全クエリを userId で絞る", async () => {
    const {
      client,
      paymentSourceFindMany,
      budgetFindMany,
      categoryFindMany,
      categoryBudgetFindMany,
    } = createMockClient();
    paymentSourceFindMany.mockResolvedValue([]);
    budgetFindMany.mockResolvedValue([]);
    categoryFindMany.mockResolvedValue([]);
    categoryBudgetFindMany.mockResolvedValue([]);

    const result = await getMonthlyBudgetData(client, USER_ID, "2026-08");

    expect(paymentSourceFindMany).toHaveBeenCalledWith({
      where: { userId: USER_ID },
      orderBy: [{ isActive: "desc" }, { sortOrder: "asc" }, { id: "asc" }],
    });
    expect(budgetFindMany).toHaveBeenCalledWith({
      where: { userId: USER_ID, yearMonth: "2026-08" },
    });
    expect(categoryFindMany).toHaveBeenCalledWith({
      where: { userId: USER_ID },
      orderBy: [{ isHidden: "asc" }, { sortOrder: "asc" }, { id: "asc" }],
    });
    expect(categoryBudgetFindMany).toHaveBeenCalledWith({
      where: { userId: USER_ID, yearMonth: "2026-08" },
    });
    expect(result).toEqual({
      yearMonth: "2026-08",
      paymentSources: [],
      budgets: [],
      categories: [],
      categoryBudgets: [],
    });
  });

  it("無効な払い出し先も含めて全件取得する（where に isActive を含めない。userId のみ）", async () => {
    const { client, paymentSourceFindMany, budgetFindMany, categoryFindMany, categoryBudgetFindMany } =
      createMockClient();
    paymentSourceFindMany.mockResolvedValue([]);
    budgetFindMany.mockResolvedValue([]);
    categoryFindMany.mockResolvedValue([]);
    categoryBudgetFindMany.mockResolvedValue([]);

    await getMonthlyBudgetData(client, USER_ID, "2026-08");

    const callArgs = paymentSourceFindMany.mock.calls[0]?.[0];
    expect(callArgs.where).toEqual({ userId: USER_ID });
    expect("isActive" in callArgs.where).toBe(false);
  });
});

describe("saveBudgets", () => {
  it("不正な yearMonth のときは DB を一切呼ばない", async () => {
    const { client, transaction, budgetUpsert, budgetDeleteMany } = createMockClient();

    const result = await saveBudgets(client, USER_ID, "invalid", [
      { paymentSourceId: "ps_1", amountYen: 1000 },
    ]);

    expect(result).toEqual({ ok: false, error: BUDGET_ERRORS.invalidYearMonth });
    expect(transaction).not.toHaveBeenCalled();
    expect(budgetUpsert).not.toHaveBeenCalled();
    expect(budgetDeleteMany).not.toHaveBeenCalled();
  });

  it("金額が範囲外（負数）のときは DB を一切呼ばない", async () => {
    const { client, transaction } = createMockClient();

    const result = await saveBudgets(client, USER_ID, "2026-08", [
      { paymentSourceId: "ps_1", amountYen: -1 },
    ]);

    expect(result).toEqual({ ok: false, error: BUDGET_ERRORS.invalidAmount });
    expect(transaction).not.toHaveBeenCalled();
  });

  it("金額が範囲外（上限超過）のときは DB を一切呼ばない", async () => {
    const { client, transaction } = createMockClient();

    const result = await saveBudgets(client, USER_ID, "2026-08", [
      { paymentSourceId: "ps_1", amountYen: 100_000_000 },
    ]);

    expect(result).toEqual({ ok: false, error: BUDGET_ERRORS.invalidAmount });
    expect(transaction).not.toHaveBeenCalled();
  });

  it("金額が非整数のときは DB を一切呼ばない", async () => {
    const { client, transaction } = createMockClient();

    const result = await saveBudgets(client, USER_ID, "2026-08", [
      { paymentSourceId: "ps_1", amountYen: 100.5 },
    ]);

    expect(result).toEqual({ ok: false, error: BUDGET_ERRORS.invalidAmount });
    expect(transaction).not.toHaveBeenCalled();
  });

  it("空配列は何もせず ok（トランザクションを起こさない）", async () => {
    const { client, transaction } = createMockClient();

    await expect(saveBudgets(client, USER_ID, "2026-08", [])).resolves.toEqual({
      ok: true,
      value: null,
    });
    expect(transaction).not.toHaveBeenCalled();
  });

  it("金額を保存する払い出し先の持ち主を { id: { in }, userId } で確認する", async () => {
    const { client, paymentSourceFindMany, budgetDeleteMany, budgetUpsert } = createMockClient();
    paymentSourceFindMany.mockResolvedValue([{ id: "ps_2" }, { id: "ps_3" }]);
    budgetDeleteMany.mockResolvedValue({ count: 1 });
    budgetUpsert.mockResolvedValue({});

    const inputs: BudgetAmountInput[] = [
      { paymentSourceId: "ps_1", amountYen: null },
      { paymentSourceId: "ps_2", amountYen: 40_000 },
      { paymentSourceId: "ps_3", amountYen: 0 },
    ];

    await saveBudgets(client, USER_ID, "2026-08", inputs);

    // amountYen が null（未設定への削除）の ps_1 は持ち主確認の対象に含めない
    expect(paymentSourceFindMany).toHaveBeenCalledWith({
      where: { id: { in: ["ps_2", "ps_3"] }, userId: USER_ID },
      select: { id: true },
    });
  });

  it("保存対象に他人の払い出し先IDが1件でもあれば、何も保存せず paymentSourceNotFound を返す", async () => {
    const { client, paymentSourceFindMany, transaction, budgetUpsert, budgetDeleteMany } =
      createMockClient();
    // ps_2 だけ自分のもの、ps_3（他人の払い出し先）は返らない
    paymentSourceFindMany.mockResolvedValue([{ id: "ps_2" }]);

    const inputs: BudgetAmountInput[] = [
      { paymentSourceId: "ps_2", amountYen: 40_000 },
      { paymentSourceId: "ps_3", amountYen: 5_000 },
    ];

    const result = await saveBudgets(client, USER_ID, "2026-08", inputs);

    expect(result).toEqual({ ok: false, error: BUDGET_ERRORS.paymentSourceNotFound });
    expect(transaction).not.toHaveBeenCalled();
    expect(budgetUpsert).not.toHaveBeenCalled();
    expect(budgetDeleteMany).not.toHaveBeenCalled();
  });

  it("amountYen が null の行は userId で絞った deleteMany、数値の行は where/create に userId を含む upsert になり、1回の $transaction にまとめて渡る", async () => {
    const { client, transaction, budgetDeleteMany, budgetUpsert, paymentSourceFindMany } =
      createMockClient();
    paymentSourceFindMany.mockResolvedValue([{ id: "ps_2" }, { id: "ps_3" }]);
    budgetDeleteMany.mockResolvedValue({ count: 1 });
    budgetUpsert.mockResolvedValue({});

    const inputs: BudgetAmountInput[] = [
      { paymentSourceId: "ps_1", amountYen: null },
      { paymentSourceId: "ps_2", amountYen: 40_000 },
      { paymentSourceId: "ps_3", amountYen: 0 },
    ];

    await expect(saveBudgets(client, USER_ID, "2026-08", inputs)).resolves.toEqual({
      ok: true,
      value: null,
    });

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(transaction.mock.calls[0]?.[0]).toHaveLength(3);
    expect(budgetDeleteMany).toHaveBeenCalledWith({
      where: { userId: USER_ID, paymentSourceId: "ps_1", yearMonth: "2026-08" },
    });
    expect(budgetUpsert).toHaveBeenCalledWith({
      where: {
        paymentSourceId_yearMonth: { paymentSourceId: "ps_2", yearMonth: "2026-08" },
        userId: USER_ID,
      },
      create: { userId: USER_ID, paymentSourceId: "ps_2", yearMonth: "2026-08", amountYen: 40_000 },
      update: { amountYen: 40_000 },
    });
    // 0円の予算も upsert される（未設定=null と区別される）
    expect(budgetUpsert).toHaveBeenCalledWith({
      where: {
        paymentSourceId_yearMonth: { paymentSourceId: "ps_3", yearMonth: "2026-08" },
        userId: USER_ID,
      },
      create: { userId: USER_ID, paymentSourceId: "ps_3", yearMonth: "2026-08", amountYen: 0 },
      update: { amountYen: 0 },
    });
  });

  it("Prisma のエラー（P2003/P2039/P2025）は paymentSourceNotFound に変換する", async () => {
    const { client, transaction, paymentSourceFindMany } = createMockClient();
    paymentSourceFindMany.mockResolvedValue([{ id: "ps_1" }]);
    transaction.mockRejectedValue(prismaError("P2003"));

    await expect(
      saveBudgets(client, USER_ID, "2026-08", [{ paymentSourceId: "ps_1", amountYen: 1000 }]),
    ).resolves.toEqual({ ok: false, error: BUDGET_ERRORS.paymentSourceNotFound });
  });

  it("それ以外のエラーはそのまま再送出する", async () => {
    const { client, transaction, paymentSourceFindMany } = createMockClient();
    paymentSourceFindMany.mockResolvedValue([{ id: "ps_1" }]);
    transaction.mockRejectedValue(prismaError("P9999"));

    await expect(
      saveBudgets(client, USER_ID, "2026-08", [{ paymentSourceId: "ps_1", amountYen: 1000 }]),
    ).rejects.toThrow();
  });
});

describe("saveCategoryBudgets", () => {
  it("不正な yearMonth のときは DB を一切呼ばない", async () => {
    const { client, transaction } = createMockClient();

    const result = await saveCategoryBudgets(client, USER_ID, "invalid", [
      { categoryId: "cat_1", amountYen: 1000 },
    ]);

    expect(result).toEqual({ ok: false, error: BUDGET_ERRORS.invalidYearMonth });
    expect(transaction).not.toHaveBeenCalled();
  });

  it("金額が範囲外のときは DB を一切呼ばない", async () => {
    const { client, transaction } = createMockClient();

    const result = await saveCategoryBudgets(client, USER_ID, "2026-08", [
      { categoryId: "cat_1", amountYen: -1 },
    ]);

    expect(result).toEqual({ ok: false, error: BUDGET_ERRORS.invalidAmount });
    expect(transaction).not.toHaveBeenCalled();
  });

  it("空配列は何もせず ok", async () => {
    const { client, transaction } = createMockClient();

    await expect(saveCategoryBudgets(client, USER_ID, "2026-08", [])).resolves.toEqual({
      ok: true,
      value: null,
    });
    expect(transaction).not.toHaveBeenCalled();
  });

  it("保存対象に他人のカテゴリIDが1件でもあれば、何も保存せず categoryNotFound を返す", async () => {
    const { client, categoryFindMany, transaction } = createMockClient();
    categoryFindMany.mockResolvedValue([]); // cat_1 は自分のものではない

    const result = await saveCategoryBudgets(client, USER_ID, "2026-08", [
      { categoryId: "cat_1", amountYen: 1000 },
    ]);

    expect(result).toEqual({ ok: false, error: BUDGET_ERRORS.categoryNotFound });
    expect(transaction).not.toHaveBeenCalled();
  });

  it("null は userId で絞った deleteMany、数値は where/create に userId を含む upsert で1回の $transaction にまとめて渡る", async () => {
    const { client, transaction, categoryBudgetDeleteMany, categoryBudgetUpsert, categoryFindMany } =
      createMockClient();
    categoryFindMany.mockResolvedValue([{ id: "cat_2" }]);
    categoryBudgetDeleteMany.mockResolvedValue({ count: 1 });
    categoryBudgetUpsert.mockResolvedValue({});

    const inputs: CategoryBudgetAmountInput[] = [
      { categoryId: "cat_1", amountYen: null },
      { categoryId: "cat_2", amountYen: 5_000 },
    ];

    await expect(saveCategoryBudgets(client, USER_ID, "2026-08", inputs)).resolves.toEqual({
      ok: true,
      value: null,
    });

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(transaction.mock.calls[0]?.[0]).toHaveLength(2);
    expect(categoryBudgetDeleteMany).toHaveBeenCalledWith({
      where: { userId: USER_ID, categoryId: "cat_1", yearMonth: "2026-08" },
    });
    expect(categoryBudgetUpsert).toHaveBeenCalledWith({
      where: {
        categoryId_yearMonth: { categoryId: "cat_2", yearMonth: "2026-08" },
        userId: USER_ID,
      },
      create: { userId: USER_ID, categoryId: "cat_2", yearMonth: "2026-08", amountYen: 5_000 },
      update: { amountYen: 5_000 },
    });
  });

  it("Prisma のエラー（P2003/P2039/P2025）は categoryNotFound に変換する", async () => {
    const { client, transaction, categoryFindMany } = createMockClient();
    categoryFindMany.mockResolvedValue([{ id: "cat_1" }]);
    transaction.mockRejectedValue(prismaError("P2025"));

    await expect(
      saveCategoryBudgets(client, USER_ID, "2026-08", [{ categoryId: "cat_1", amountYen: 1000 }]),
    ).resolves.toEqual({ ok: false, error: BUDGET_ERRORS.categoryNotFound });
  });
});

describe("deleteBudget", () => {
  it("不正な yearMonth のときは deleteMany を呼ばない", async () => {
    const { client, budgetDeleteMany } = createMockClient();

    const result = await deleteBudget(client, USER_ID, "ps_1", "invalid");

    expect(result).toEqual({ ok: false, error: BUDGET_ERRORS.invalidYearMonth });
    expect(budgetDeleteMany).not.toHaveBeenCalled();
  });

  it("正しい指定では userId・paymentSourceId・yearMonth で deleteMany する", async () => {
    const { client, budgetDeleteMany } = createMockClient();
    budgetDeleteMany.mockResolvedValue({ count: 1 });

    await expect(deleteBudget(client, USER_ID, "ps_1", "2026-08")).resolves.toEqual({
      ok: true,
      value: null,
    });
    expect(budgetDeleteMany).toHaveBeenCalledWith({
      where: { userId: USER_ID, paymentSourceId: "ps_1", yearMonth: "2026-08" },
    });
  });

  it("対象が既に無い場合（count: 0）でも成功として扱う（二重送信で失敗しない）。他人のIDでも同じ応答", async () => {
    const { client, budgetDeleteMany } = createMockClient();
    budgetDeleteMany.mockResolvedValue({ count: 0 });

    await expect(deleteBudget(client, USER_ID, "ps_other_user", "2026-08")).resolves.toEqual({
      ok: true,
      value: null,
    });
  });
});
