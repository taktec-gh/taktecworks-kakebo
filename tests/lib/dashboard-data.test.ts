// @vitest-environment node
//
// src/lib/dashboard-data.ts のデータ層を検証する。
// 実データベースには接続せず、PrismaClient をモックする。
//
// 期待値の根拠:
// - docs/steps/step-6.md「3-4. src/lib/dashboard-data.ts」
// - docs/steps/step-6.md「tester への引き継ぎ」の発行クエリ一覧の表
//   （where / orderBy と、"0000-01" では7本目を発行しないこと）
// - src/lib/expense-date.ts「@db.Date の月範囲検索は UTC 基準で組み立てる」
//   （+9h を足さない。2026-08 なら 2026-08-01T00:00:00.000Z 以上
//    2026-09-01T00:00:00.000Z 未満）

import { describe, expect, it, vi } from "vitest";

import type { PrismaClient } from "@/generated/prisma/client";
import { getDashboardData } from "@/lib/dashboard-data";
import { MIN_YEAR_MONTH } from "@/lib/year-month";

function createMockClient() {
  const paymentSourceFindMany = vi.fn();
  const categoryFindMany = vi.fn();
  const budgetFindMany = vi.fn();
  const categoryBudgetFindMany = vi.fn();
  const expenseFindMany = vi.fn();
  const incomeFindMany = vi.fn();

  const client = {
    paymentSource: { findMany: paymentSourceFindMany },
    category: { findMany: categoryFindMany },
    budget: { findMany: budgetFindMany },
    categoryBudget: { findMany: categoryBudgetFindMany },
    expense: { findMany: expenseFindMany },
    income: { findMany: incomeFindMany },
  } as unknown as PrismaClient;

  return {
    client,
    paymentSourceFindMany,
    categoryFindMany,
    budgetFindMany,
    categoryBudgetFindMany,
    expenseFindMany,
    incomeFindMany,
  };
}

function resolveAllEmpty(mocks: ReturnType<typeof createMockClient>) {
  mocks.paymentSourceFindMany.mockResolvedValue([]);
  mocks.categoryFindMany.mockResolvedValue([]);
  mocks.budgetFindMany.mockResolvedValue([]);
  mocks.categoryBudgetFindMany.mockResolvedValue([]);
  mocks.expenseFindMany.mockResolvedValue([]);
  mocks.incomeFindMany.mockResolvedValue([]);
}

describe("getDashboardData", () => {
  it("払い出し先・カテゴリを全件、表示順で取得する", async () => {
    const mocks = createMockClient();
    resolveAllEmpty(mocks);

    await getDashboardData(mocks.client, "2026-08");

    expect(mocks.paymentSourceFindMany).toHaveBeenCalledWith({
      orderBy: [{ isActive: "desc" }, { sortOrder: "asc" }, { id: "asc" }],
    });
    expect(mocks.categoryFindMany).toHaveBeenCalledWith({
      orderBy: [{ isHidden: "asc" }, { sortOrder: "asc" }, { id: "asc" }],
    });
  });

  it("budget・categoryBudget は対象月で絞り込む", async () => {
    const mocks = createMockClient();
    resolveAllEmpty(mocks);

    await getDashboardData(mocks.client, "2026-08");

    expect(mocks.budgetFindMany).toHaveBeenCalledWith({ where: { yearMonth: "2026-08" } });
    expect(mocks.categoryBudgetFindMany).toHaveBeenCalledWith({
      where: { yearMonth: "2026-08" },
    });
  });

  it("expense は月範囲を UTC 深夜で組み立てる（+9h を足さない）", async () => {
    const mocks = createMockClient();
    resolveAllEmpty(mocks);

    await getDashboardData(mocks.client, "2026-08");

    expect(mocks.expenseFindMany).toHaveBeenCalledWith({
      where: {
        date: {
          gte: new Date("2026-08-01T00:00:00.000Z"),
          lt: new Date("2026-09-01T00:00:00.000Z"),
        },
      },
    });
  });

  it("12月は年をまたいだ範囲になる（2026-12 → lt は 2027-01-01T00:00:00.000Z）", async () => {
    const mocks = createMockClient();
    resolveAllEmpty(mocks);

    await getDashboardData(mocks.client, "2026-12");

    expect(mocks.expenseFindMany).toHaveBeenCalledWith({
      where: {
        date: {
          gte: new Date("2026-12-01T00:00:00.000Z"),
          lt: new Date("2027-01-01T00:00:00.000Z"),
        },
      },
    });
  });

  it("表示中の月の収入は yearMonth で絞り込み、新しい順（createdAt desc, id asc）", async () => {
    const mocks = createMockClient();
    resolveAllEmpty(mocks);

    await getDashboardData(mocks.client, "2026-08");

    expect(mocks.incomeFindMany).toHaveBeenNthCalledWith(1, {
      where: { yearMonth: "2026-08" },
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    });
  });

  it("前月の収入も同条件で取得する（2件目の income.findMany）", async () => {
    const mocks = createMockClient();
    resolveAllEmpty(mocks);

    await getDashboardData(mocks.client, "2026-08");

    expect(mocks.incomeFindMany).toHaveBeenCalledTimes(2);
    expect(mocks.incomeFindMany).toHaveBeenNthCalledWith(2, {
      where: { yearMonth: "2026-07" },
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    });
  });

  it("前月が扱える範囲の外（0000-01）なら income.findMany は1回だけ発行し、previousMonthIncomes は空配列", async () => {
    const mocks = createMockClient();
    resolveAllEmpty(mocks);

    const data = await getDashboardData(mocks.client, MIN_YEAR_MONTH);

    expect(mocks.incomeFindMany).toHaveBeenCalledTimes(1);
    expect(data.previousMonthIncomes).toEqual([]);
  });

  it("戻り値に yearMonth と各データをまとめて返す", async () => {
    const mocks = createMockClient();
    const paymentSources = [{ id: "ps_1" }];
    const categories = [{ id: "cat_1" }];
    const budgets = [{ paymentSourceId: "ps_1", amountYen: 1000 }];
    const categoryBudgets = [{ categoryId: "cat_1", amountYen: 500 }];
    const expenses = [{ id: "exp_1", amountYen: 100 }];
    const incomes = [{ id: "income_1", amountYen: 300_000 }];
    const previousIncomes = [{ id: "income_0", amountYen: 280_000 }];

    mocks.paymentSourceFindMany.mockResolvedValue(paymentSources);
    mocks.categoryFindMany.mockResolvedValue(categories);
    mocks.budgetFindMany.mockResolvedValue(budgets);
    mocks.categoryBudgetFindMany.mockResolvedValue(categoryBudgets);
    mocks.expenseFindMany.mockResolvedValue(expenses);
    mocks.incomeFindMany.mockResolvedValueOnce(incomes).mockResolvedValueOnce(previousIncomes);

    const data = await getDashboardData(mocks.client, "2026-08");

    expect(data).toEqual({
      yearMonth: "2026-08",
      paymentSources,
      categories,
      budgets,
      categoryBudgets,
      expenses,
      incomes,
      previousMonthIncomes: previousIncomes,
    });
  });
});
