// @vitest-environment node
//
// src/app/expenses/actions.ts の Server Action を検証する。
// データ層（@/lib/expenses）と副作用（session / next/cache / next/navigation）をモックし、
// 検証（@/lib/expense-validation）は実物を使う。
//
// 期待値の根拠:
// - docs/steps/step-5.md「実装完了後の引き継ぎ > Step 3・4 との違い」
//   「state は { error, savedCount }。savedCount は成功のたびに+1」
// - docs/steps/step-5.md「特に確認したい観点」11.
//   「全アクションの認証」「savedCount が成功時のみ+1」
//   「deleteExpenseAction が失敗時に redirect しないこと」
// - docs/steps/step-5.md「設計判断 > 登録後は入力画面に留まる」（createExpenseAction は
//   成功しても redirect しない）

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WasteTag } from "@/generated/prisma/enums";
import { EXPENSE_ERRORS } from "@/lib/expenses";
import { EXPENSE_VALIDATION_ERRORS } from "@/lib/expense-validation";
import { EXPENSES_PATH } from "@/app/expenses/action-state";

class RedirectError extends Error {
  digest: string;
  constructor(url: string) {
    super(`NEXT_REDIRECT;${url}`);
    this.digest = `NEXT_REDIRECT;replace;${url};307;`;
  }
}

const redirect = vi.fn((url: string): never => {
  throw new RedirectError(url);
});
const revalidatePath = vi.fn();
const getSession = vi.fn<() => Promise<{ sub: string; iat: number; exp: number } | null>>();

const createExpense = vi.fn();
const updateExpense = vi.fn();
const deleteExpense = vi.fn();

vi.mock("next/navigation", () => ({ redirect: (url: string) => redirect(url) }));
vi.mock("next/cache", () => ({ revalidatePath: (path: string) => revalidatePath(path) }));
vi.mock("@/lib/session", () => ({ getSession: () => getSession() }));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/expenses", async () => {
  const actual = await vi.importActual<typeof import("@/lib/expenses")>("@/lib/expenses");
  return {
    ...actual,
    createExpense: (...args: unknown[]) => createExpense(...args),
    updateExpense: (...args: unknown[]) => updateExpense(...args),
    deleteExpense: (...args: unknown[]) => deleteExpense(...args),
  };
});

const { createExpenseAction, deleteExpenseAction, updateExpenseAction } = await import(
  "@/app/expenses/actions"
);
const { initialExpenseActionState } = await import("@/app/expenses/action-state");

const SESSION = { sub: "owner", iat: 0, exp: 9_999_999_999 };

function validFormData(overrides: Record<string, string> = {}): FormData {
  const formData = new FormData();
  const entries: Record<string, string> = {
    date: "2026-08-13",
    amount: "1234",
    categoryId: "cat_1",
    paymentSourceId: "ps_1",
    wasteTag: WasteTag.NECESSARY,
    storeName: "スーパー",
    memo: "",
    ...overrides,
  };
  for (const [key, value] of Object.entries(entries)) {
    formData.set(key, value);
  }
  return formData;
}

beforeEach(() => {
  redirect.mockClear();
  revalidatePath.mockClear();
  getSession.mockReset();
  getSession.mockResolvedValue(SESSION);
  createExpense.mockReset();
  updateExpense.mockReset();
  deleteExpense.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("認証なしアクセスの拒否", () => {
  const cases: Array<[string, () => Promise<unknown>, ReturnType<typeof vi.fn>]> = [
    ["createExpenseAction", () => createExpenseAction(initialExpenseActionState, validFormData()), createExpense],
    [
      "updateExpenseAction",
      () =>
        updateExpenseAction(initialExpenseActionState, validFormData({ id: "exp_1" })),
      updateExpense,
    ],
    [
      "deleteExpenseAction",
      () => deleteExpenseAction(initialExpenseActionState, validFormData({ id: "exp_1" })),
      deleteExpense,
    ],
  ];

  it.each(cases)(
    "%s はセッションが無ければ /login へ redirect し、データ層を呼ばない",
    async (_label, run, dataFn) => {
      getSession.mockResolvedValue(null);
      await expect(run()).rejects.toThrow("NEXT_REDIRECT");
      expect(redirect).toHaveBeenCalledWith("/login");
      expect(dataFn).not.toHaveBeenCalled();
    },
  );
});

describe("createExpenseAction", () => {
  it("検証エラーがあれば savedCount を増やさずエラーを返す。データ層は呼ばない", async () => {
    const result = await createExpenseAction(
      initialExpenseActionState,
      validFormData({ amount: "" }),
    );
    expect(result).toEqual({
      error: EXPENSE_VALIDATION_ERRORS.amountRequired,
      savedCount: 0,
    });
    expect(createExpense).not.toHaveBeenCalled();
  });

  it("成功したら revalidate して savedCount を+1し、redirect しない（登録後も画面に留まる）", async () => {
    createExpense.mockResolvedValue({ ok: true, value: { id: "exp_1" } });

    const result = await createExpenseAction(initialExpenseActionState, validFormData());

    expect(result).toEqual({ error: null, savedCount: 1 });
    expect(revalidatePath).toHaveBeenCalledWith(EXPENSES_PATH);
    expect(redirect).not.toHaveBeenCalled();
  });

  it("2件連続で保存すると savedCount が 1 → 2 と増える", async () => {
    createExpense.mockResolvedValue({ ok: true, value: { id: "exp_1" } });

    const first = await createExpenseAction(initialExpenseActionState, validFormData());
    expect(first.savedCount).toBe(1);

    const second = await createExpenseAction(first, validFormData());
    expect(second.savedCount).toBe(2);
  });

  it("データ層が拒否した場合はそのメッセージを返し、savedCount は増えない", async () => {
    createExpense.mockResolvedValue({ ok: false, error: EXPENSE_ERRORS.categoryNotFound });

    const result = await createExpenseAction(initialExpenseActionState, validFormData());

    expect(result).toEqual({ error: EXPENSE_ERRORS.categoryNotFound, savedCount: 0 });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("失敗しても直前の savedCount は保たれる（既に1件保存済みの状態で失敗した場合）", async () => {
    createExpense.mockResolvedValueOnce({ ok: false, error: EXPENSE_ERRORS.categoryNotFound });

    const result = await createExpenseAction(
      { error: null, savedCount: 3 },
      validFormData(),
    );

    expect(result).toEqual({ error: EXPENSE_ERRORS.categoryNotFound, savedCount: 3 });
  });
});

describe("updateExpenseAction", () => {
  it("id が無ければ検証エラーを返し、データ層を呼ばない", async () => {
    const formData = validFormData();
    formData.delete("id");

    const result = await updateExpenseAction(initialExpenseActionState, formData);

    expect(result.error).toBe(EXPENSE_VALIDATION_ERRORS.idRequired);
    expect(updateExpense).not.toHaveBeenCalled();
  });

  it("検証エラーがあれば savedCount を増やさない", async () => {
    const result = await updateExpenseAction(
      initialExpenseActionState,
      validFormData({ id: "exp_1", amount: "-1" }),
    );
    expect(result).toEqual({
      error: EXPENSE_VALIDATION_ERRORS.amountTooSmall,
      savedCount: 0,
    });
    expect(updateExpense).not.toHaveBeenCalled();
  });

  it("成功したら id を渡して更新し、savedCount を+1、redirect しない（編集後も画面に留まる）", async () => {
    updateExpense.mockResolvedValue({ ok: true, value: { id: "exp_1" } });

    const result = await updateExpenseAction(
      initialExpenseActionState,
      validFormData({ id: "exp_1" }),
    );

    expect(updateExpense).toHaveBeenCalledWith(expect.anything(), "exp_1", expect.anything());
    expect(result).toEqual({ error: null, savedCount: 1 });
    expect(redirect).not.toHaveBeenCalled();
  });

  it("データ層が拒否した場合はそのメッセージを返す", async () => {
    updateExpense.mockResolvedValue({ ok: false, error: EXPENSE_ERRORS.notFound });

    const result = await updateExpenseAction(
      initialExpenseActionState,
      validFormData({ id: "exp_missing" }),
    );

    expect(result).toEqual({ error: EXPENSE_ERRORS.notFound, savedCount: 0 });
  });
});

describe("deleteExpenseAction", () => {
  it("id が無ければ検証エラーを返し、データ層を呼ばない", async () => {
    const formData = new FormData();
    const result = await deleteExpenseAction(initialExpenseActionState, formData);

    expect(result.error).toBe(EXPENSE_VALIDATION_ERRORS.idRequired);
    expect(deleteExpense).not.toHaveBeenCalled();
  });

  it("成功したら revalidate して一覧へ redirect する", async () => {
    deleteExpense.mockResolvedValue({ ok: true, value: null });

    const formData = new FormData();
    formData.set("id", "exp_1");

    await expect(deleteExpenseAction(initialExpenseActionState, formData)).rejects.toThrow(
      "NEXT_REDIRECT",
    );

    expect(deleteExpense).toHaveBeenCalledWith(expect.anything(), "exp_1");
    expect(revalidatePath).toHaveBeenCalledWith(EXPENSES_PATH);
    expect(redirect).toHaveBeenCalledWith(EXPENSES_PATH);
  });

  it("データ層が拒否した場合は redirect せずエラーを返す（誤操作からの復帰を許す）", async () => {
    deleteExpense.mockResolvedValue({ ok: false, error: EXPENSE_ERRORS.notFound });

    const formData = new FormData();
    formData.set("id", "exp_missing");

    const result = await deleteExpenseAction(initialExpenseActionState, formData);

    expect(result).toEqual({ error: EXPENSE_ERRORS.notFound, savedCount: 0 });
    expect(redirect).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});
