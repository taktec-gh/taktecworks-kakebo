// @vitest-environment node
//
// src/lib/payment-sources.ts のデータ層を検証する。
// 実データベースには接続せず、PrismaClient をモックする
// （docs/steps/step-3.md「テストの方針」・「単体テストから実データベースに接続しない」）。
//
// 期待値の根拠:
// - docs/steps/step-3.md「設計判断」（既定は常に1件・削除は参照ゼロのときだけ 等）
// - docs/steps/step-3.md「実装完了後の引き継ぎ」の「特に確認したい観点」1・4・5・8
// - docs/steps/pub-1.md 設計判断 5・6（ユニーク制約・採番・既定をユーザー単位に、
//   全データ操作関数のシグネチャを (client, userId, ...) にする）。
//   「setDefaultPaymentSource の updateMany({ where: { isDefault: true } }) に userId を
//   付け忘れると、全ユーザーの既定が外れる」という名指しの注意があるため、
//   updateMany の where は特に厳密に検証する

import { describe, expect, it, vi } from "vitest";

import {
  PaymentSourceType,
  type PaymentSource,
  type PrismaClient,
} from "@/generated/prisma/client";
import {
  createPaymentSource,
  deletePaymentSource,
  getDeactivateBlockedReason,
  getDeleteBlockedReason,
  getPaymentSource,
  getPaymentSourceDetail,
  getSetDefaultBlockedReason,
  listPaymentSources,
  movePaymentSource,
  PAYMENT_SOURCE_ERRORS,
  setDefaultPaymentSource,
  setPaymentSourceActive,
  updatePaymentSource,
  type PaymentSourceDetail,
} from "@/lib/payment-sources";
import type { UserId } from "@/lib/user-id";

const NOW = new Date("2026-08-13T00:00:00.000Z");
const USER_ID = "user_1" as UserId;
const OTHER_USER_ID = "user_2" as UserId;

function makePaymentSource(overrides: Partial<PaymentSource> = {}): PaymentSource {
  return {
    id: "ps_1",
    userId: USER_ID,
    name: "現金",
    type: PaymentSourceType.CASH,
    sortOrder: 1,
    isActive: true,
    isDefault: false,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as PaymentSource;
}

function makeDetail(overrides: Partial<PaymentSourceDetail> = {}): PaymentSourceDetail {
  return {
    paymentSource: makePaymentSource(),
    expenseCount: 0,
    budgetCount: 0,
    activeCount: 1,
    ...overrides,
  };
}

/** P2002 (一意制約違反) のような Prisma エラーを再現する */
function prismaError(code: string): Error {
  return Object.assign(new Error(`mock prisma error ${code}`), { code });
}

/** テストで使う範囲だけを備えた PrismaClient のモック */
function createMockClient() {
  const findMany = vi.fn();
  const findFirst = vi.fn();
  const aggregate = vi.fn();
  const create = vi.fn();
  const update = vi.fn();
  const updateMany = vi.fn();
  const deleteFn = vi.fn();
  const count = vi.fn();
  const transaction = vi.fn(async (ops: unknown[]) => Promise.all(ops));
  const expenseCount = vi.fn();
  const budgetCount = vi.fn();

  const client = {
    paymentSource: {
      findMany,
      findFirst,
      aggregate,
      create,
      update,
      updateMany,
      delete: deleteFn,
      count,
    },
    expense: { count: expenseCount },
    budget: { count: budgetCount },
    $transaction: transaction,
  } as unknown as PrismaClient;

  return {
    client,
    findMany,
    findFirst,
    aggregate,
    create,
    update,
    updateMany,
    deleteFn,
    count,
    transaction,
    expenseCount,
    budgetCount,
  };
}

describe("listPaymentSources", () => {
  it("有効→無効、各グループ内は sortOrder 昇順で findMany に orderBy を渡し、userId で絞る", async () => {
    const { client, findMany } = createMockClient();
    findMany.mockResolvedValue([]);

    await listPaymentSources(client, USER_ID);

    expect(findMany).toHaveBeenCalledWith({
      where: { userId: USER_ID },
      orderBy: [{ isActive: "desc" }, { sortOrder: "asc" }, { id: "asc" }],
    });
  });

  it("findMany の結果をそのまま返す", async () => {
    const { client, findMany } = createMockClient();
    const sources = [makePaymentSource({ id: "a" }), makePaymentSource({ id: "b" })];
    findMany.mockResolvedValue(sources);

    await expect(listPaymentSources(client, USER_ID)).resolves.toBe(sources);
  });

  it("1件も無い場合は空配列を返す", async () => {
    const { client, findMany } = createMockClient();
    findMany.mockResolvedValue([]);

    await expect(listPaymentSources(client, USER_ID)).resolves.toEqual([]);
  });
});

describe("getPaymentSource", () => {
  it("存在すればそのレコードを返す。where は { id, userId }", async () => {
    const { client, findFirst } = createMockClient();
    const source = makePaymentSource();
    findFirst.mockResolvedValue(source);

    await expect(getPaymentSource(client, USER_ID, "ps_1")).resolves.toBe(source);
    expect(findFirst).toHaveBeenCalledWith({ where: { id: "ps_1", userId: USER_ID } });
  });

  it("存在しなければ null を返す", async () => {
    const { client, findFirst } = createMockClient();
    findFirst.mockResolvedValue(null);

    await expect(getPaymentSource(client, USER_ID, "no-such-id")).resolves.toBeNull();
  });

  it("他人の userId を渡すと where に他人の userId が渡る（findFirst が絞り込みを担う）", async () => {
    const { client, findFirst } = createMockClient();
    findFirst.mockResolvedValue(null);

    await getPaymentSource(client, OTHER_USER_ID, "ps_1");
    expect(findFirst).toHaveBeenCalledWith({ where: { id: "ps_1", userId: OTHER_USER_ID } });
  });
});

describe("getPaymentSourceDetail", () => {
  it("存在しない場合は null（カウント系は呼ばない）", async () => {
    const { client, findFirst, expenseCount, budgetCount, count } = createMockClient();
    findFirst.mockResolvedValue(null);

    await expect(getPaymentSourceDetail(client, USER_ID, "no-such-id")).resolves.toBeNull();
    expect(expenseCount).not.toHaveBeenCalled();
    expect(budgetCount).not.toHaveBeenCalled();
    expect(count).not.toHaveBeenCalled();
  });

  it("存在する場合は支出数・予算数・有効件数をまとめて返し、各カウントを userId で絞る", async () => {
    const { client, findFirst, expenseCount, budgetCount, count } = createMockClient();
    const source = makePaymentSource({ id: "ps_1" });
    findFirst.mockResolvedValue(source);
    expenseCount.mockResolvedValue(3);
    budgetCount.mockResolvedValue(1);
    count.mockResolvedValue(2);

    await expect(getPaymentSourceDetail(client, USER_ID, "ps_1")).resolves.toEqual({
      paymentSource: source,
      expenseCount: 3,
      budgetCount: 1,
      activeCount: 2,
    });
    expect(expenseCount).toHaveBeenCalledWith({
      where: { userId: USER_ID, paymentSourceId: "ps_1" },
    });
    expect(budgetCount).toHaveBeenCalledWith({
      where: { userId: USER_ID, paymentSourceId: "ps_1" },
    });
    expect(count).toHaveBeenCalledWith({ where: { userId: USER_ID, isActive: true } });
  });
});

describe("getDeleteBlockedReason（純粋関数、判定順序: 既定 → 支出あり → 予算あり）", () => {
  it("削除できる（すべてゼロ・既定でない）なら null", () => {
    expect(getDeleteBlockedReason(makeDetail())).toBeNull();
  });

  it("既定の場合は他の条件を満たしていても deleteDefault を返す", () => {
    const detail = makeDetail({
      paymentSource: makePaymentSource({ isDefault: true }),
      expenseCount: 5,
      budgetCount: 5,
    });
    expect(getDeleteBlockedReason(detail)).toBe(PAYMENT_SOURCE_ERRORS.deleteDefault);
  });

  it("既定でなく支出参照がある場合は deleteReferencedByExpense（予算より優先）", () => {
    const detail = makeDetail({ expenseCount: 1, budgetCount: 1 });
    expect(getDeleteBlockedReason(detail)).toBe(PAYMENT_SOURCE_ERRORS.deleteReferencedByExpense);
  });

  it("支出参照は無いが予算参照がある場合は deleteReferencedByBudget", () => {
    const detail = makeDetail({ expenseCount: 0, budgetCount: 1 });
    expect(getDeleteBlockedReason(detail)).toBe(PAYMENT_SOURCE_ERRORS.deleteReferencedByBudget);
  });
});

describe("getDeactivateBlockedReason（無効化の境界）", () => {
  it("すでに無効なら（他の条件によらず）null", () => {
    const detail = makeDetail({
      paymentSource: makePaymentSource({ isActive: false, isDefault: false }),
      activeCount: 0,
    });
    expect(getDeactivateBlockedReason(detail)).toBeNull();
  });

  it("既定は常に拒否される（有効件数が複数あっても）", () => {
    const detail = makeDetail({
      paymentSource: makePaymentSource({ isActive: true, isDefault: true }),
      activeCount: 5,
    });
    expect(getDeactivateBlockedReason(detail)).toBe(PAYMENT_SOURCE_ERRORS.deactivateDefault);
  });

  it("有効な払い出し先が自分1件だけなら拒否される", () => {
    const detail = makeDetail({
      paymentSource: makePaymentSource({ isActive: true, isDefault: false }),
      activeCount: 1,
    });
    expect(getDeactivateBlockedReason(detail)).toBe(PAYMENT_SOURCE_ERRORS.deactivateLastActive);
  });

  it("有効な払い出し先が2件以上あれば無効化できる", () => {
    const detail = makeDetail({
      paymentSource: makePaymentSource({ isActive: true, isDefault: false }),
      activeCount: 2,
    });
    expect(getDeactivateBlockedReason(detail)).toBeNull();
  });
});

describe("getSetDefaultBlockedReason", () => {
  it("すでに既定なら null", () => {
    const detail = makeDetail({ paymentSource: makePaymentSource({ isDefault: true }) });
    expect(getSetDefaultBlockedReason(detail)).toBeNull();
  });

  it("無効な払い出し先は既定にできない", () => {
    const detail = makeDetail({
      paymentSource: makePaymentSource({ isActive: false, isDefault: false }),
    });
    expect(getSetDefaultBlockedReason(detail)).toBe(PAYMENT_SOURCE_ERRORS.defaultMustBeActive);
  });

  it("有効かつ既定でなければ既定にできる", () => {
    const detail = makeDetail({
      paymentSource: makePaymentSource({ isActive: true, isDefault: false }),
    });
    expect(getSetDefaultBlockedReason(detail)).toBeNull();
  });
});

describe("createPaymentSource", () => {
  it("既存の最大 sortOrder + 1 を割り当てる。aggregate は userId で絞る", async () => {
    const { client, aggregate, create } = createMockClient();
    aggregate.mockResolvedValue({ _max: { sortOrder: 4 } });
    create.mockResolvedValue(makePaymentSource({ sortOrder: 5 }));

    await createPaymentSource(client, USER_ID, {
      name: "Aカード",
      type: PaymentSourceType.CREDIT_CARD,
    });

    expect(aggregate).toHaveBeenCalledWith({
      where: { userId: USER_ID },
      _max: { sortOrder: true },
    });
    expect(create).toHaveBeenCalledWith({
      data: {
        userId: USER_ID,
        name: "Aカード",
        type: PaymentSourceType.CREDIT_CARD,
        sortOrder: 5,
        isDefault: false,
      },
    });
  });

  it("空テーブル（_max.sortOrder が null）では sortOrder = 1 になる", async () => {
    const { client, aggregate, create } = createMockClient();
    aggregate.mockResolvedValue({ _max: { sortOrder: null } });
    create.mockResolvedValue(makePaymentSource({ sortOrder: 1 }));

    await createPaymentSource(client, USER_ID, { name: "現金", type: PaymentSourceType.CASH });

    expect(create).toHaveBeenCalledWith({
      data: {
        userId: USER_ID,
        name: "現金",
        type: PaymentSourceType.CASH,
        sortOrder: 1,
        isDefault: false,
      },
    });
  });

  it("isDefault は常に false で作成する", async () => {
    const { client, aggregate, create } = createMockClient();
    aggregate.mockResolvedValue({ _max: { sortOrder: null } });
    create.mockResolvedValue(makePaymentSource());

    await createPaymentSource(client, USER_ID, { name: "現金", type: PaymentSourceType.CASH });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ isDefault: false }) }),
    );
  });

  it("data.userId は引数の userId から設定する", async () => {
    const { client, aggregate, create } = createMockClient();
    aggregate.mockResolvedValue({ _max: { sortOrder: null } });
    create.mockResolvedValue(makePaymentSource());

    await createPaymentSource(client, USER_ID, { name: "現金", type: PaymentSourceType.CASH });

    expect(create.mock.calls[0][0].data.userId).toBe(USER_ID);
  });

  it("成功時は ok: true とレコードを返す", async () => {
    const { client, aggregate, create } = createMockClient();
    aggregate.mockResolvedValue({ _max: { sortOrder: null } });
    const created = makePaymentSource();
    create.mockResolvedValue(created);

    await expect(
      createPaymentSource(client, USER_ID, { name: "現金", type: PaymentSourceType.CASH }),
    ).resolves.toEqual({ ok: true, value: created });
  });

  it("名前重複（P2002）は利用者向けメッセージに変換する", async () => {
    const { client, aggregate, create } = createMockClient();
    aggregate.mockResolvedValue({ _max: { sortOrder: 1 } });
    create.mockRejectedValue(prismaError("P2002"));

    await expect(
      createPaymentSource(client, USER_ID, { name: "現金", type: PaymentSourceType.CASH }),
    ).resolves.toEqual({ ok: false, error: PAYMENT_SOURCE_ERRORS.duplicateName });
  });

  it("P2002 以外のエラーはそのまま再送出する", async () => {
    const { client, aggregate, create } = createMockClient();
    aggregate.mockResolvedValue({ _max: { sortOrder: 1 } });
    create.mockRejectedValue(prismaError("P9999"));

    await expect(
      createPaymentSource(client, USER_ID, { name: "現金", type: PaymentSourceType.CASH }),
    ).rejects.toThrow();
  });
});

describe("updatePaymentSource", () => {
  it("name と type だけを更新する。where は { id, userId }", async () => {
    const { client, update } = createMockClient();
    update.mockResolvedValue(makePaymentSource({ name: "A銀行" }));

    await updatePaymentSource(client, USER_ID, {
      id: "ps_1",
      name: "A銀行",
      type: PaymentSourceType.BANK_DEBIT,
    });

    expect(update).toHaveBeenCalledWith({
      where: { id: "ps_1", userId: USER_ID },
      data: { name: "A銀行", type: PaymentSourceType.BANK_DEBIT },
    });
  });

  it("成功時は ok: true と更新後のレコードを返す", async () => {
    const { client, update } = createMockClient();
    const updated = makePaymentSource({ name: "A銀行" });
    update.mockResolvedValue(updated);

    await expect(
      updatePaymentSource(client, USER_ID, {
        id: "ps_1",
        name: "A銀行",
        type: PaymentSourceType.BANK_DEBIT,
      }),
    ).resolves.toEqual({ ok: true, value: updated });
  });

  it("名前重複（P2002）はエラーメッセージを返す", async () => {
    const { client, update } = createMockClient();
    update.mockRejectedValue(prismaError("P2002"));

    await expect(
      updatePaymentSource(client, USER_ID, { id: "ps_1", name: "現金", type: PaymentSourceType.CASH }),
    ).resolves.toEqual({ ok: false, error: PAYMENT_SOURCE_ERRORS.duplicateName });
  });

  it("対象が存在しない（P2025）は notFound を返す", async () => {
    const { client, update } = createMockClient();
    update.mockRejectedValue(prismaError("P2025"));

    await expect(
      updatePaymentSource(client, USER_ID, {
        id: "no-such-id",
        name: "現金",
        type: PaymentSourceType.CASH,
      }),
    ).resolves.toEqual({ ok: false, error: PAYMENT_SOURCE_ERRORS.notFound });
  });
});

describe("setDefaultPaymentSource", () => {
  it("対象が存在しなければ notFound。findFirst の where は { id, userId }", async () => {
    const { client, findFirst, transaction } = createMockClient();
    findFirst.mockResolvedValue(null);

    await expect(setDefaultPaymentSource(client, USER_ID, "no-such-id")).resolves.toEqual({
      ok: false,
      error: PAYMENT_SOURCE_ERRORS.notFound,
    });
    expect(findFirst).toHaveBeenCalledWith({ where: { id: "no-such-id", userId: USER_ID } });
    expect(transaction).not.toHaveBeenCalled();
  });

  it("無効な払い出し先は既定にできない", async () => {
    const { client, findFirst, transaction } = createMockClient();
    findFirst.mockResolvedValue(makePaymentSource({ isActive: false, isDefault: false }));

    await expect(setDefaultPaymentSource(client, USER_ID, "ps_1")).resolves.toEqual({
      ok: false,
      error: PAYMENT_SOURCE_ERRORS.defaultMustBeActive,
    });
    expect(transaction).not.toHaveBeenCalled();
  });

  it("すでに既定なら何もせず ok を返す（トランザクションを起こさない）", async () => {
    const target = makePaymentSource({ isActive: true, isDefault: true });
    const { client, findFirst, transaction } = createMockClient();
    findFirst.mockResolvedValue(target);

    await expect(setDefaultPaymentSource(client, USER_ID, "ps_1")).resolves.toEqual({
      ok: true,
      value: target,
    });
    expect(transaction).not.toHaveBeenCalled();
  });

  it("旧既定を false にしてから新既定を true にする。updateMany の where に userId がある（この where が無いと全ユーザーの既定が外れる）", async () => {
    const { client, findFirst, updateMany, update, transaction } = createMockClient();
    findFirst.mockResolvedValue(
      makePaymentSource({ id: "ps_2", isActive: true, isDefault: false }),
    );
    updateMany.mockResolvedValue({ count: 1 });
    const updated = makePaymentSource({ id: "ps_2", isDefault: true });
    update.mockResolvedValue(updated);

    const result = await setDefaultPaymentSource(client, USER_ID, "ps_2");

    expect(result).toEqual({ ok: true, value: updated });
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(updateMany).toHaveBeenCalledWith({
      where: { userId: USER_ID, isDefault: true },
      data: { isDefault: false },
    });
    expect(update).toHaveBeenCalledWith({
      where: { id: "ps_2", userId: USER_ID },
      data: { isDefault: true },
    });
    // $transaction に渡る配列の順序そのもの: updateMany が先、update が後
    expect(updateMany.mock.invocationCallOrder[0]).toBeLessThan(update.mock.invocationCallOrder[0]);
  });
});

describe("setPaymentSourceActive", () => {
  it("対象が存在しなければ notFound", async () => {
    const { client, findFirst, update } = createMockClient();
    findFirst.mockResolvedValue(null);

    await expect(setPaymentSourceActive(client, USER_ID, "no-such-id", false)).resolves.toEqual({
      ok: false,
      error: PAYMENT_SOURCE_ERRORS.notFound,
    });
    expect(update).not.toHaveBeenCalled();
  });

  it("すでに同じ状態なら何もせず ok（update を呼ばない）", async () => {
    const target = makePaymentSource({ isActive: true });
    const { client, findFirst, update, count } = createMockClient();
    findFirst.mockResolvedValue(target);

    await expect(setPaymentSourceActive(client, USER_ID, "ps_1", true)).resolves.toEqual({
      ok: true,
      value: target,
    });
    expect(update).not.toHaveBeenCalled();
    expect(count).not.toHaveBeenCalled();
  });

  it("既定の払い出し先は無効化できない", async () => {
    const { client, findFirst, update } = createMockClient();
    findFirst.mockResolvedValue(makePaymentSource({ isActive: true, isDefault: true }));

    await expect(setPaymentSourceActive(client, USER_ID, "ps_1", false)).resolves.toEqual({
      ok: false,
      error: PAYMENT_SOURCE_ERRORS.deactivateDefault,
    });
    expect(update).not.toHaveBeenCalled();
  });

  it("有効な払い出し先が1件（自分）だけのときは無効化できない。count は userId で絞る", async () => {
    const { client, findFirst, count, update } = createMockClient();
    findFirst.mockResolvedValue(makePaymentSource({ isActive: true, isDefault: false }));
    count.mockResolvedValue(1);

    await expect(setPaymentSourceActive(client, USER_ID, "ps_1", false)).resolves.toEqual({
      ok: false,
      error: PAYMENT_SOURCE_ERRORS.deactivateLastActive,
    });
    expect(count).toHaveBeenCalledWith({ where: { userId: USER_ID, isActive: true } });
    expect(update).not.toHaveBeenCalled();
  });

  it("有効な払い出し先が2件あれば無効化できる（境界値: 1件はNG・2件はOK）", async () => {
    const { client, findFirst, count, update } = createMockClient();
    findFirst.mockResolvedValue(makePaymentSource({ isActive: true, isDefault: false }));
    count.mockResolvedValue(2);
    const updated = makePaymentSource({ isActive: false });
    update.mockResolvedValue(updated);

    await expect(setPaymentSourceActive(client, USER_ID, "ps_1", false)).resolves.toEqual({
      ok: true,
      value: updated,
    });
    expect(update).toHaveBeenCalledWith({
      where: { id: "ps_1", userId: USER_ID },
      data: { isActive: false },
    });
  });

  it("有効化のときは有効件数を検査しない（count を呼ばない）", async () => {
    const { client, findFirst, count, update } = createMockClient();
    findFirst.mockResolvedValue(makePaymentSource({ isActive: false, isDefault: false }));
    const updated = makePaymentSource({ isActive: true });
    update.mockResolvedValue(updated);

    await expect(setPaymentSourceActive(client, USER_ID, "ps_1", true)).resolves.toEqual({
      ok: true,
      value: updated,
    });
    expect(count).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith({
      where: { id: "ps_1", userId: USER_ID },
      data: { isActive: true },
    });
  });
});

describe("movePaymentSource", () => {
  it("計算結果をトランザクションで反映し、反映後の全件を返す。各 update の where に userId がある", async () => {
    const sources = [
      makePaymentSource({ id: "a1", sortOrder: 1, isActive: true }),
      makePaymentSource({ id: "a2", sortOrder: 2, isActive: true }),
    ];
    const { client, findMany, update, transaction } = createMockClient();
    findMany.mockResolvedValue(sources);
    update.mockImplementation(
      async (args: { where: { id: string; userId: UserId }; data: { sortOrder: number } }) =>
        makePaymentSource({ id: args.where.id, sortOrder: args.data.sortOrder }),
    );

    const result = await movePaymentSource(client, USER_ID, "a1", "down");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.map((s) => [s.id, s.sortOrder])).toEqual([
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
    const sources = [makePaymentSource({ id: "a1", sortOrder: 1, isActive: true })];
    const { client, findMany, transaction } = createMockClient();
    findMany.mockResolvedValue(sources);

    const result = await movePaymentSource(client, USER_ID, "a1", "up");

    expect(result.ok).toBe(false);
    expect(transaction).not.toHaveBeenCalled();
  });
});

describe("deletePaymentSource — 判定順序: 既定 → 支出あり → 予算あり", () => {
  it("対象が存在しなければ notFound", async () => {
    const { client, findMany, expenseCount, budgetCount } = createMockClient();
    findMany.mockResolvedValue([]);

    await expect(deletePaymentSource(client, USER_ID, "no-such-id")).resolves.toEqual({
      ok: false,
      error: PAYMENT_SOURCE_ERRORS.notFound,
    });
    expect(expenseCount).not.toHaveBeenCalled();
    expect(budgetCount).not.toHaveBeenCalled();
  });

  it("既定の払い出し先は、他の条件を見るまでもなく削除できない", async () => {
    const target = makePaymentSource({ id: "ps_1", isDefault: true });
    const { client, findMany, expenseCount, budgetCount } = createMockClient();
    findMany.mockResolvedValue([target]);

    await expect(deletePaymentSource(client, USER_ID, "ps_1")).resolves.toEqual({
      ok: false,
      error: PAYMENT_SOURCE_ERRORS.deleteDefault,
    });
    expect(expenseCount).not.toHaveBeenCalled();
    expect(budgetCount).not.toHaveBeenCalled();
  });

  it("支出が1件でもあれば削除できない（予算より先に判定される）。カウントは userId で絞る", async () => {
    const target = makePaymentSource({ id: "ps_1", isDefault: false });
    const { client, findMany, expenseCount, budgetCount } = createMockClient();
    findMany.mockResolvedValue([target]);
    expenseCount.mockResolvedValue(1);
    budgetCount.mockResolvedValue(1);

    await expect(deletePaymentSource(client, USER_ID, "ps_1")).resolves.toEqual({
      ok: false,
      error: PAYMENT_SOURCE_ERRORS.deleteReferencedByExpense,
    });
    expect(expenseCount).toHaveBeenCalledWith({
      where: { userId: USER_ID, paymentSourceId: "ps_1" },
    });
  });

  it("支出は無いが予算があれば削除できない", async () => {
    const target = makePaymentSource({ id: "ps_1", isDefault: false });
    const { client, findMany, expenseCount, budgetCount } = createMockClient();
    findMany.mockResolvedValue([target]);
    expenseCount.mockResolvedValue(0);
    budgetCount.mockResolvedValue(1);

    await expect(deletePaymentSource(client, USER_ID, "ps_1")).resolves.toEqual({
      ok: false,
      error: PAYMENT_SOURCE_ERRORS.deleteReferencedByBudget,
    });
  });

  it("支出も予算も無ければ削除でき、残りの sortOrder を連番に振り直す。where は { id, userId }", async () => {
    const target = makePaymentSource({ id: "ps_1", sortOrder: 1, isDefault: false });
    const other = makePaymentSource({ id: "ps_2", sortOrder: 2 });
    const { client, findMany, expenseCount, budgetCount, deleteFn, update, transaction } =
      createMockClient();
    findMany.mockResolvedValue([target, other]);
    expenseCount.mockResolvedValue(0);
    budgetCount.mockResolvedValue(0);
    deleteFn.mockResolvedValue(target);
    update.mockResolvedValue(makePaymentSource({ id: "ps_2", sortOrder: 1 }));

    await expect(deletePaymentSource(client, USER_ID, "ps_1")).resolves.toEqual({
      ok: true,
      value: null,
    });

    expect(deleteFn).toHaveBeenCalledWith({ where: { id: "ps_1", userId: USER_ID } });
    expect(update).toHaveBeenCalledWith({
      where: { id: "ps_2", userId: USER_ID },
      data: { sortOrder: 1 },
    });
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it("競合で参照が発生していた場合のフォールバック（P2039）も同じ理由を返す", async () => {
    const target = makePaymentSource({ id: "ps_1", isDefault: false });
    const { client, findMany, expenseCount, budgetCount, transaction } = createMockClient();
    findMany.mockResolvedValue([target]);
    expenseCount.mockResolvedValue(0);
    budgetCount.mockResolvedValue(0);
    transaction.mockRejectedValue(prismaError("P2039"));

    await expect(deletePaymentSource(client, USER_ID, "ps_1")).resolves.toEqual({
      ok: false,
      error: PAYMENT_SOURCE_ERRORS.deleteReferencedByExpense,
    });
  });

  it("対象が削除の直前に消えていた場合（P2025）は notFound", async () => {
    const target = makePaymentSource({ id: "ps_1", isDefault: false });
    const { client, findMany, expenseCount, budgetCount, transaction } = createMockClient();
    findMany.mockResolvedValue([target]);
    expenseCount.mockResolvedValue(0);
    budgetCount.mockResolvedValue(0);
    transaction.mockRejectedValue(prismaError("P2025"));

    await expect(deletePaymentSource(client, USER_ID, "ps_1")).resolves.toEqual({
      ok: false,
      error: PAYMENT_SOURCE_ERRORS.notFound,
    });
  });
});
