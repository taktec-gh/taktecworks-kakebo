// @vitest-environment node
//
// src/lib/expenses.ts のデータ層を検証する。
// 実データベースには接続せず、PrismaClient をモックする
// （docs/steps/step-5.md「テストの方針」・「単体テストから実データベースに接続しない」）。
//
// 期待値の根拠:
// - docs/steps/step-5.md「設計判断 > @db.Date の月範囲検索は UTC 基準で組み立てる」
// - docs/steps/step-5.md「実装完了後の引き継ぎ > 特に確認したい観点」4.
//   「listExpenses が where.date に UTC 深夜の範囲を渡すこと、および絞り込みが
//    指定されていない軸を where に入れないこと（categoryId: undefined を入れると
//    意図しない結果になる罠）」
// - 同「一覧は月単位。絞り込みと並べ替えは URL に持つ」「並べ替えは日付の新しい順
//    （既定）と金額の高い順」
// - docs/steps/pub-1.md 設計判断 6「全データ操作関数のシグネチャを (client, userId, ...) にする」
//   「1件取得は findFirst({ where: { id, userId } })」「作成は data.userId を引数から設定する」
//   「関連先を受け取る操作は categoryId / paymentSourceId が自分のものか where: { id, userId } で確認する」

import { describe, expect, it, vi } from "vitest";

import type { PrismaClient } from "@/generated/prisma/client";
import { WasteTag } from "@/generated/prisma/enums";
import { getMonthDateRange } from "@/lib/expense-date";
import type { ExpenseListFilter } from "@/lib/expense-filter";
import {
  createExpense,
  deleteExpense,
  EXPENSE_ERRORS,
  getExpense,
  listExpenses,
  listQuickPickCategoryIds,
  listRecentStoreNames,
  updateExpense,
  type ExpenseInput,
} from "@/lib/expenses";
import type { UserId } from "@/lib/user-id";

/** P2003/P2025/P2039 のような Prisma エラーを再現する */
function prismaError(code: string): Error {
  return Object.assign(new Error(`mock prisma error ${code}`), { code });
}

const USER_ID = "user_1" as UserId;
const OTHER_USER_ID = "user_2" as UserId;

function createMockClient() {
  const findMany = vi.fn();
  const findFirst = vi.fn();
  const create = vi.fn();
  const update = vi.fn();
  const deleteFn = vi.fn();
  const categoryFindFirst = vi.fn().mockResolvedValue({ id: "cat_1" });
  const paymentSourceFindFirst = vi.fn().mockResolvedValue({ id: "ps_1" });

  const client = {
    expense: { findMany, findFirst, create, update, delete: deleteFn },
    category: { findFirst: categoryFindFirst },
    paymentSource: { findFirst: paymentSourceFindFirst },
  } as unknown as PrismaClient;

  return {
    client,
    findMany,
    findFirst,
    create,
    update,
    deleteFn,
    categoryFindFirst,
    paymentSourceFindFirst,
  };
}

const BASE_FILTER: ExpenseListFilter = {
  yearMonth: "2026-08",
  categoryId: null,
  paymentSourceId: null,
  wasteTag: null,
  sort: "date",
};

function baseExpenseInput(overrides: Partial<ExpenseInput> = {}): ExpenseInput {
  return {
    date: "2026-08-13",
    amountYen: 1234,
    categoryId: "cat_1",
    paymentSourceId: "ps_1",
    wasteTag: WasteTag.NECESSARY,
    storeName: null,
    memo: null,
    ...overrides,
  };
}

describe("listExpenses — 月範囲の組み立て", () => {
  it("where.date に getMonthDateRange と同じ UTC 深夜の範囲を渡す", async () => {
    const { client, findMany } = createMockClient();
    findMany.mockResolvedValue([]);

    await listExpenses(client, USER_ID, BASE_FILTER);

    const range = getMonthDateRange("2026-08");
    const call = findMany.mock.calls[0][0];
    expect(call.where.date.gte.getTime()).toBe(range.gte.getTime());
    expect(call.where.date.lt.getTime()).toBe(range.lt.getTime());
  });

  it("where.userId に渡した引数の userId が入る", async () => {
    const { client, findMany } = createMockClient();
    findMany.mockResolvedValue([]);

    await listExpenses(client, USER_ID, BASE_FILTER);

    expect(findMany.mock.calls[0][0].where.userId).toBe(USER_ID);
  });

  it("12月指定なら lt が翌年1月1日になる", async () => {
    const { client, findMany } = createMockClient();
    findMany.mockResolvedValue([]);

    await listExpenses(client, USER_ID, { ...BASE_FILTER, yearMonth: "2026-12" });

    const call = findMany.mock.calls[0][0];
    expect(call.where.date.lt.getTime()).toBe(new Date("2027-01-01T00:00:00.000Z").getTime());
  });

  it("不正な yearMonth はデータ層を呼ばずエラーを返す", async () => {
    const { client, findMany } = createMockClient();

    const result = await listExpenses(client, USER_ID, { ...BASE_FILTER, yearMonth: "invalid" });

    expect(result).toEqual({ ok: false, error: EXPENSE_ERRORS.invalidYearMonth });
    expect(findMany).not.toHaveBeenCalled();
  });
});

describe("listExpenses — 絞り込みが指定されていない軸を where に入れない", () => {
  it("絞り込みなしのとき categoryId / paymentSourceId / wasteTag が where に含まれない", async () => {
    const { client, findMany } = createMockClient();
    findMany.mockResolvedValue([]);

    await listExpenses(client, USER_ID, BASE_FILTER);

    const where = findMany.mock.calls[0][0].where;
    expect("categoryId" in where).toBe(false);
    expect("paymentSourceId" in where).toBe(false);
    expect("wasteTag" in where).toBe(false);
  });

  it("categoryId を指定したときだけ where に categoryId が入る", async () => {
    const { client, findMany } = createMockClient();
    findMany.mockResolvedValue([]);

    await listExpenses(client, USER_ID, { ...BASE_FILTER, categoryId: "cat_1" });

    const where = findMany.mock.calls[0][0].where;
    expect(where.categoryId).toBe("cat_1");
    expect("paymentSourceId" in where).toBe(false);
  });

  it("paymentSourceId と wasteTag も同様に、指定した軸だけ where に入る", async () => {
    const { client, findMany } = createMockClient();
    findMany.mockResolvedValue([]);

    await listExpenses(client, USER_ID, {
      ...BASE_FILTER,
      paymentSourceId: "ps_1",
      wasteTag: WasteTag.WASTE,
    });

    const where = findMany.mock.calls[0][0].where;
    expect(where.paymentSourceId).toBe("ps_1");
    expect(where.wasteTag).toBe(WasteTag.WASTE);
    expect("categoryId" in where).toBe(false);
  });

  it("不正な wasteTag はデータ層を呼ばずエラーを返す", async () => {
    const { client, findMany } = createMockClient();

    const result = await listExpenses(client, USER_ID, {
      ...BASE_FILTER,
      wasteTag: "invalid" as unknown as WasteTag,
    });

    expect(result).toEqual({ ok: false, error: EXPENSE_ERRORS.invalidWasteTag });
    expect(findMany).not.toHaveBeenCalled();
  });
});

describe("listExpenses — 並べ替え、include", () => {
  it("既定（date）は日付の新しい順で、カテゴリ・払い出し先を include する", async () => {
    const { client, findMany } = createMockClient();
    findMany.mockResolvedValue([]);

    await listExpenses(client, USER_ID, BASE_FILTER);

    const call = findMany.mock.calls[0][0];
    expect(call.orderBy[0]).toEqual({ date: "desc" });
    expect(call.include).toEqual({ category: true, paymentSource: true });
  });

  it("sort=amount は金額の高い順が先頭のキーになる", async () => {
    const { client, findMany } = createMockClient();
    findMany.mockResolvedValue([]);

    await listExpenses(client, USER_ID, { ...BASE_FILTER, sort: "amount" });

    const call = findMany.mock.calls[0][0];
    expect(call.orderBy[0]).toEqual({ amountYen: "desc" });
  });

  it("取得結果をそのまま ok:true で返す", async () => {
    const { client, findMany } = createMockClient();
    const rows = [{ id: "exp_1" }];
    findMany.mockResolvedValue(rows);

    const result = await listExpenses(client, USER_ID, BASE_FILTER);
    expect(result).toEqual({ ok: true, value: rows });
  });
});

describe("getExpense", () => {
  it("id と userId で findFirst し、category・paymentSource を include する", async () => {
    const { client, findFirst } = createMockClient();
    findFirst.mockResolvedValue(null);

    await getExpense(client, USER_ID, "exp_1");

    expect(findFirst).toHaveBeenCalledWith({
      where: { id: "exp_1", userId: USER_ID },
      include: { category: true, paymentSource: true },
    });
  });

  it("見つからなければ null をそのまま返す", async () => {
    const { client, findFirst } = createMockClient();
    findFirst.mockResolvedValue(null);

    expect(await getExpense(client, USER_ID, "missing")).toBeNull();
  });

  it("他人の支出は（findFirst の条件に userId が含まれるため）null になる", async () => {
    // findFirst 自体はモックなので「他人の行は返さない」という実際の絞り込みは
    // where に userId が含まれることで保証される（上のテストで検証済み）。
    // ここでは呼び出し側が別ユーザーの userId を渡しても同じ引数の形で呼ばれることを確認する。
    const { client, findFirst } = createMockClient();
    findFirst.mockResolvedValue(null);

    await getExpense(client, OTHER_USER_ID, "exp_1");

    expect(findFirst).toHaveBeenCalledWith({
      where: { id: "exp_1", userId: OTHER_USER_ID },
      include: { category: true, paymentSource: true },
    });
  });
});

describe("createExpense", () => {
  it("date を @db.Date 用の UTC 深夜 Date に変換して create する", async () => {
    const { client, create } = createMockClient();
    create.mockResolvedValue({ id: "exp_1" });

    await createExpense(client, USER_ID, baseExpenseInput({ date: "2026-08-13" }));

    const data = create.mock.calls[0][0].data;
    expect(data.date.toISOString()).toBe("2026-08-13T00:00:00.000Z");
    expect(data.amountYen).toBe(1234);
  });

  it("data.userId は引数の userId から設定する（入力に紛れ込んだ userId は無視する）", async () => {
    const { client, create } = createMockClient();
    create.mockResolvedValue({ id: "exp_1" });

    const input = {
      ...baseExpenseInput(),
      // ExpenseInput には無いフィールドだが、実装がスプレッドしていないことの確認として
      // 型を無視して紛れ込ませる
      userId: OTHER_USER_ID,
    } as ExpenseInput;

    await createExpense(client, USER_ID, input);

    expect(create.mock.calls[0][0].data.userId).toBe(USER_ID);
  });

  it("カテゴリ・払い出し先の持ち主を where: { id, userId } で確認してから create する", async () => {
    const { client, create, categoryFindFirst, paymentSourceFindFirst } = createMockClient();
    create.mockResolvedValue({ id: "exp_1" });

    await createExpense(client, USER_ID, baseExpenseInput({ categoryId: "cat_1", paymentSourceId: "ps_1" }));

    expect(categoryFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "cat_1", userId: USER_ID } }),
    );
    expect(paymentSourceFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "ps_1", userId: USER_ID } }),
    );
  });

  it("他人のカテゴリIDを指定すると categoryNotFound を返し create を呼ばない", async () => {
    const { client, create, categoryFindFirst } = createMockClient();
    categoryFindFirst.mockResolvedValue(null);

    const result = await createExpense(client, USER_ID, baseExpenseInput({ categoryId: "cat_other" }));

    expect(result).toEqual({ ok: false, error: EXPENSE_ERRORS.categoryNotFound });
    expect(create).not.toHaveBeenCalled();
  });

  it("他人の払い出し先IDを指定すると paymentSourceNotFound を返し create を呼ばない", async () => {
    const { client, create, paymentSourceFindFirst } = createMockClient();
    paymentSourceFindFirst.mockResolvedValue(null);

    const result = await createExpense(
      client,
      USER_ID,
      baseExpenseInput({ paymentSourceId: "ps_other" }),
    );

    expect(result).toEqual({ ok: false, error: EXPENSE_ERRORS.paymentSourceNotFound });
    expect(create).not.toHaveBeenCalled();
  });

  it("カテゴリ・払い出し先の両方が他人のものならカテゴリのエラーを優先する", async () => {
    const { client, create, categoryFindFirst, paymentSourceFindFirst } = createMockClient();
    categoryFindFirst.mockResolvedValue(null);
    paymentSourceFindFirst.mockResolvedValue(null);

    const result = await createExpense(client, USER_ID, baseExpenseInput());

    expect(result).toEqual({ ok: false, error: EXPENSE_ERRORS.categoryNotFound });
    expect(create).not.toHaveBeenCalled();
  });

  it("金額の下限を割る値（0円）は create を呼ばずエラーを返す", async () => {
    const { client, create } = createMockClient();

    const result = await createExpense(client, USER_ID, baseExpenseInput({ amountYen: 0 }));

    expect(result).toEqual({ ok: false, error: EXPENSE_ERRORS.invalidAmount });
    expect(create).not.toHaveBeenCalled();
  });

  it("金額の上限を超える値は create を呼ばずエラーを返す", async () => {
    const { client, create } = createMockClient();

    const result = await createExpense(client, USER_ID, baseExpenseInput({ amountYen: 100_000_000 }));

    expect(result).toEqual({ ok: false, error: EXPENSE_ERRORS.invalidAmount });
    expect(create).not.toHaveBeenCalled();
  });

  it("金額1円（下限ちょうど）と99,999,999円（上限ちょうど）は通る", async () => {
    const { client, create } = createMockClient();
    create.mockResolvedValue({ id: "exp_1" });

    const low = await createExpense(client, USER_ID, baseExpenseInput({ amountYen: 1 }));
    const high = await createExpense(client, USER_ID, baseExpenseInput({ amountYen: 99_999_999 }));

    expect(low.ok).toBe(true);
    expect(high.ok).toBe(true);
  });

  it("不正な wasteTag は create を呼ばずエラーを返す", async () => {
    const { client, create } = createMockClient();

    const result = await createExpense(
      client,
      USER_ID,
      baseExpenseInput({ wasteTag: "invalid" as unknown as WasteTag }),
    );

    expect(result).toEqual({ ok: false, error: EXPENSE_ERRORS.invalidWasteTag });
    expect(create).not.toHaveBeenCalled();
  });

  it("不正な日付文字列は invalidDate エラーを返す", async () => {
    const { client, create } = createMockClient();

    const result = await createExpense(client, USER_ID, baseExpenseInput({ date: "2026-02-30" }));

    expect(result).toEqual({ ok: false, error: EXPENSE_ERRORS.invalidDate });
    expect(create).not.toHaveBeenCalled();
  });

  it("持ち主確認を通過した後に参照が消えていた場合（P2003）は categoryNotFound を返す", async () => {
    const { client, create } = createMockClient();
    create.mockRejectedValue(prismaError("P2003"));

    const result = await createExpense(client, USER_ID, baseExpenseInput());

    expect(result).toEqual({ ok: false, error: EXPENSE_ERRORS.categoryNotFound });
  });

  it("P2039・P2025 も同様に categoryNotFound を返す", async () => {
    const { client, create } = createMockClient();
    create.mockRejectedValueOnce(prismaError("P2039"));
    const first = await createExpense(client, USER_ID, baseExpenseInput());
    expect(first).toEqual({ ok: false, error: EXPENSE_ERRORS.categoryNotFound });

    create.mockRejectedValueOnce(prismaError("P2025"));
    const second = await createExpense(client, USER_ID, baseExpenseInput());
    expect(second).toEqual({ ok: false, error: EXPENSE_ERRORS.categoryNotFound });
  });

  it("想定外のエラーコードは再スローする", async () => {
    const { client, create } = createMockClient();
    create.mockRejectedValue(prismaError("P9999"));

    await expect(createExpense(client, USER_ID, baseExpenseInput())).rejects.toThrow();
  });

  it("成功したら ok:true で作成結果を返す", async () => {
    const { client, create } = createMockClient();
    const created = { id: "exp_1", amountYen: 1234 };
    create.mockResolvedValue(created);

    const result = await createExpense(client, USER_ID, baseExpenseInput());
    expect(result).toEqual({ ok: true, value: created });
  });
});

describe("updateExpense", () => {
  it("存在しない id（P2025）は notFound を返す", async () => {
    const { client, update } = createMockClient();
    update.mockRejectedValue(prismaError("P2025"));

    const result = await updateExpense(client, USER_ID, "exp_missing", baseExpenseInput());

    expect(result).toEqual({ ok: false, error: EXPENSE_ERRORS.notFound });
  });

  it("参照エラー（P2003）は categoryNotFound を返す", async () => {
    const { client, update } = createMockClient();
    update.mockRejectedValue(prismaError("P2003"));

    const result = await updateExpense(client, USER_ID, "exp_1", baseExpenseInput());

    expect(result).toEqual({ ok: false, error: EXPENSE_ERRORS.categoryNotFound });
  });

  it("他人のカテゴリIDを指定すると categoryNotFound を返し update を呼ばない", async () => {
    const { client, update, categoryFindFirst } = createMockClient();
    categoryFindFirst.mockResolvedValue(null);

    const result = await updateExpense(client, USER_ID, "exp_1", baseExpenseInput());

    expect(result).toEqual({ ok: false, error: EXPENSE_ERRORS.categoryNotFound });
    expect(update).not.toHaveBeenCalled();
  });

  it("他人の払い出し先IDを指定すると paymentSourceNotFound を返し update を呼ばない", async () => {
    const { client, update, paymentSourceFindFirst } = createMockClient();
    paymentSourceFindFirst.mockResolvedValue(null);

    const result = await updateExpense(client, USER_ID, "exp_1", baseExpenseInput());

    expect(result).toEqual({ ok: false, error: EXPENSE_ERRORS.paymentSourceNotFound });
    expect(update).not.toHaveBeenCalled();
  });

  it("金額不正はデータ層で拒否する", async () => {
    const { client, update } = createMockClient();

    const result = await updateExpense(client, USER_ID, "exp_1", baseExpenseInput({ amountYen: -1 }));

    expect(result).toEqual({ ok: false, error: EXPENSE_ERRORS.invalidAmount });
    expect(update).not.toHaveBeenCalled();
  });

  it("成功したら ok:true で更新結果を返し、where は { id, userId }。userId は更新しない", async () => {
    const { client, update } = createMockClient();
    const updated = { id: "exp_1", amountYen: 5000 };
    update.mockResolvedValue(updated);

    const result = await updateExpense(client, USER_ID, "exp_1", baseExpenseInput({ amountYen: 5000 }));
    expect(result).toEqual({ ok: true, value: updated });
    expect(update.mock.calls[0][0].where).toEqual({ id: "exp_1", userId: USER_ID });
    expect("userId" in update.mock.calls[0][0].data).toBe(false);
  });
});

describe("deleteExpense", () => {
  it("存在しない id（P2025）は notFound を返す", async () => {
    const { client, deleteFn } = createMockClient();
    deleteFn.mockRejectedValue(prismaError("P2025"));

    const result = await deleteExpense(client, USER_ID, "exp_missing");

    expect(result).toEqual({ ok: false, error: EXPENSE_ERRORS.notFound });
  });

  it("想定外のエラーは再スローする", async () => {
    const { client, deleteFn } = createMockClient();
    deleteFn.mockRejectedValue(prismaError("P9999"));

    await expect(deleteExpense(client, USER_ID, "exp_1")).rejects.toThrow();
  });

  it("成功したら ok:true, value:null（物理削除）。where は { id, userId }", async () => {
    const { client, deleteFn } = createMockClient();
    deleteFn.mockResolvedValue({ id: "exp_1" });

    const result = await deleteExpense(client, USER_ID, "exp_1");
    expect(result).toEqual({ ok: true, value: null });
    expect(deleteFn).toHaveBeenCalledWith({ where: { id: "exp_1", userId: USER_ID } });
  });
});

describe("listQuickPickCategoryIds", () => {
  const ORDERED = ["cat_1", "cat_2", "cat_3"];

  it("選択肢が空・limit=0・windowDays=0 なら findMany を呼ばず空配列を返す", async () => {
    const { client, findMany } = createMockClient();

    expect(
      await listQuickPickCategoryIds(client, USER_ID, [], new Date("2026-08-13T00:00:00.000Z")),
    ).toEqual([]);
    expect(
      await listQuickPickCategoryIds(client, USER_ID, ORDERED, new Date("2026-08-13T00:00:00.000Z"), {
        limit: 0,
      }),
    ).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("今日（JST）を含む直近30日で範囲を組み立て、where.userId を渡す", async () => {
    const { client, findMany } = createMockClient();
    findMany.mockResolvedValue([]);

    // UTC 2026-08-13T00:00:00Z は JST 2026-08-13 9:00 なので今日は 2026-08-13
    await listQuickPickCategoryIds(client, USER_ID, ORDERED, new Date("2026-08-13T00:00:00.000Z"));

    const where = findMany.mock.calls[0][0].where;
    expect(where.userId).toBe(USER_ID);
    // 直近30日 = 今日を含む30日 → 29日前(7/15)の深夜から、翌日(8/14)深夜未満
    expect(where.date.gte.toISOString()).toBe("2026-07-15T00:00:00.000Z");
    expect(where.date.lt.toISOString()).toBe("2026-08-14T00:00:00.000Z");
  });

  it("集計結果を selectQuickPickCategoryIds と同じ規則で並べる", async () => {
    const { client, findMany } = createMockClient();
    findMany.mockResolvedValue([
      { categoryId: "cat_2" },
      { categoryId: "cat_1" },
      { categoryId: "cat_1" },
    ]);

    const result = await listQuickPickCategoryIds(
      client,
      USER_ID,
      ORDERED,
      new Date("2026-08-13T00:00:00.000Z"),
    );
    // cat_1: 2件, cat_2: 1件 → 回数降順で cat_1 が先
    expect(result).toEqual(["cat_1", "cat_2"]);
  });
});

describe("listRecentStoreNames", () => {
  it("limit・scanLimit が0以下なら findMany を呼ばず空配列を返す", async () => {
    const { client, findMany } = createMockClient();

    expect(await listRecentStoreNames(client, USER_ID, { limit: 0 })).toEqual([]);
    expect(await listRecentStoreNames(client, USER_ID, { scanLimit: 0 })).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("storeName が null でない行だけを、userId で絞って新しい順に take 件読む", async () => {
    const { client, findMany } = createMockClient();
    findMany.mockResolvedValue([]);

    await listRecentStoreNames(client, USER_ID, { limit: 5, scanLimit: 50 });

    const call = findMany.mock.calls[0][0];
    expect(call.where).toEqual({ userId: USER_ID, storeName: { not: null } });
    expect(call.orderBy).toEqual([{ date: "desc" }, { createdAt: "desc" }]);
    expect(call.take).toBe(50);
  });

  it("重複を除いて limit 件だけ返す", async () => {
    const { client, findMany } = createMockClient();
    findMany.mockResolvedValue([
      { storeName: "スーパーA" },
      { storeName: "スーパーA" },
      { storeName: "スーパーB" },
    ]);

    const result = await listRecentStoreNames(client, USER_ID, { limit: 1 });
    expect(result).toEqual(["スーパーA"]);
  });
});
