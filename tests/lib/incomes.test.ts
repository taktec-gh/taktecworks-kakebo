// @vitest-environment node
//
// src/lib/incomes.ts のデータ層を検証する。
// 実データベースには接続せず、PrismaClient をモックする（tests/lib/budgets.test.ts と同じ方針）。
//
// 期待値の根拠:
// - docs/steps/step-6.md「3-3. src/lib/incomes.ts」
// - docs/steps/step-6.md「tester への引き継ぎ > 公開インターフェース > src/lib/incomes.ts」
//   （listIncomes の where/orderBy、createIncome/deleteIncome の Result 型、
//    deleteIncome は P2025 を notFound に変換する）

import { describe, expect, it, vi } from "vitest";

import type { PrismaClient } from "@/generated/prisma/client";
import {
  createIncome,
  deleteIncome,
  INCOME_ERRORS,
  listIncomes,
  sumIncomeAmounts,
} from "@/lib/incomes";
import type { UserId } from "@/lib/user-id";

const USER_ID = "user_1" as UserId;

function prismaError(code: string): Error {
  return Object.assign(new Error(`mock prisma error ${code}`), { code });
}

function createMockClient() {
  const incomeFindMany = vi.fn();
  const incomeCreate = vi.fn();
  const incomeDelete = vi.fn();

  const client = {
    income: {
      findMany: incomeFindMany,
      create: incomeCreate,
      delete: incomeDelete,
    },
  } as unknown as PrismaClient;

  return { client, incomeFindMany, incomeCreate, incomeDelete };
}

describe("listIncomes", () => {
  it("userId・yearMonth で絞り込み、createdAt 降順・id 昇順で取得する", async () => {
    const { client, incomeFindMany } = createMockClient();
    incomeFindMany.mockResolvedValue([]);

    await listIncomes(client, USER_ID, "2026-08");

    expect(incomeFindMany).toHaveBeenCalledWith({
      where: { userId: USER_ID, yearMonth: "2026-08" },
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    });
  });
});

describe("createIncome", () => {
  it("不正な yearMonth のときは DB を呼ばずに invalidYearMonth を返す", async () => {
    const { client, incomeCreate } = createMockClient();

    const result = await createIncome(client, USER_ID, {
      yearMonth: "invalid",
      amountYen: 1_000,
      label: null,
    });

    expect(result).toEqual({ ok: false, error: INCOME_ERRORS.invalidYearMonth });
    expect(incomeCreate).not.toHaveBeenCalled();
  });

  it("金額が0円のときは DB を呼ばずに invalidAmount を返す（下限1円）", async () => {
    const { client, incomeCreate } = createMockClient();

    const result = await createIncome(client, USER_ID, {
      yearMonth: "2026-08",
      amountYen: 0,
      label: null,
    });

    expect(result).toEqual({ ok: false, error: INCOME_ERRORS.invalidAmount });
    expect(incomeCreate).not.toHaveBeenCalled();
  });

  it("金額が負数のときは invalidAmount", async () => {
    const { client } = createMockClient();

    const result = await createIncome(client, USER_ID, {
      yearMonth: "2026-08",
      amountYen: -100,
      label: null,
    });

    expect(result).toEqual({ ok: false, error: INCOME_ERRORS.invalidAmount });
  });

  it("金額が上限（99,999,999円）を超えるときは invalidAmount", async () => {
    const { client } = createMockClient();

    const result = await createIncome(client, USER_ID, {
      yearMonth: "2026-08",
      amountYen: 100_000_000,
      label: null,
    });

    expect(result).toEqual({ ok: false, error: INCOME_ERRORS.invalidAmount });
  });

  it("金額が非整数のときは invalidAmount", async () => {
    const { client } = createMockClient();

    const result = await createIncome(client, USER_ID, {
      yearMonth: "2026-08",
      amountYen: 100.5,
      label: null,
    });

    expect(result).toEqual({ ok: false, error: INCOME_ERRORS.invalidAmount });
  });

  it("正しい入力なら create を呼び、結果をそのまま返す。data.userId は引数の userId から設定する", async () => {
    const { client, incomeCreate } = createMockClient();
    const created = { id: "income_1", yearMonth: "2026-08", amountYen: 300_000, label: "給与" };
    incomeCreate.mockResolvedValue(created);

    const result = await createIncome(client, USER_ID, {
      yearMonth: "2026-08",
      amountYen: 300_000,
      label: "給与",
    });

    expect(incomeCreate).toHaveBeenCalledWith({
      data: { userId: USER_ID, yearMonth: "2026-08", amountYen: 300_000, label: "給与" },
    });
    expect(result).toEqual({ ok: true, value: created });
  });
});

describe("deleteIncome", () => {
  it("成功したら ok: true を返す。where は { id, userId }", async () => {
    const { client, incomeDelete } = createMockClient();
    incomeDelete.mockResolvedValue({ id: "income_1" });

    const result = await deleteIncome(client, USER_ID, "income_1");

    expect(incomeDelete).toHaveBeenCalledWith({ where: { id: "income_1", userId: USER_ID } });
    expect(result).toEqual({ ok: true, value: null });
  });

  it("対象が見つからない（P2025）場合は notFound エラーを返す", async () => {
    const { client, incomeDelete } = createMockClient();
    incomeDelete.mockRejectedValue(prismaError("P2025"));

    const result = await deleteIncome(client, USER_ID, "income_missing");

    expect(result).toEqual({ ok: false, error: INCOME_ERRORS.notFound });
  });

  it("それ以外のエラーはそのまま再送出する", async () => {
    const { client, incomeDelete } = createMockClient();
    incomeDelete.mockRejectedValue(prismaError("P9999"));

    await expect(deleteIncome(client, USER_ID, "income_1")).rejects.toThrow();
  });
});

describe("sumIncomeAmounts", () => {
  it("空配列は0円", () => {
    expect(sumIncomeAmounts([])).toBe(0);
  });

  it("複数件の合計", () => {
    expect(sumIncomeAmounts([{ amountYen: 300_000 }, { amountYen: 50_000 }])).toBe(350_000);
  });
});
