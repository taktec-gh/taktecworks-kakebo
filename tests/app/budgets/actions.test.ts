// @vitest-environment node
//
// src/app/budgets/actions.ts の Server Action を検証する。
// データ層（@/lib/budgets・@/lib/payment-sources・@/lib/categories）と
// 副作用（session / next/cache / next/navigation）をモックする。
//
// 期待値の根拠:
// - docs/steps/step-4.md「実装完了後の引き継ぎ」（予算の state は { error, saved }）
// - docs/steps/step-4.md「特に確認したい観点」5.
//   「saveBudgetsAction が formData.has で行を選ぶこと。フィールドが無い払い出し先の
//    予算を消してしまわないこと」
// - 同 11.（全 Server Action が getSession() を呼ぶこと）

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Category, PaymentSource } from "@/generated/prisma/client";
import { PaymentSourceType, CostType } from "@/generated/prisma/enums";
import { BUDGET_AMOUNT_ERRORS } from "@/lib/budget-calculation";
import { BUDGET_ERRORS } from "@/lib/budgets";
import { PAYMENT_SOURCE_VALIDATION_ERRORS } from "@/lib/payment-source-validation";
import type { UserId } from "@/lib/user-id";
import { YEAR_MONTH_ERRORS } from "@/lib/year-month";
import {
  BUDGETS_PATH,
  budgetAmountFieldName,
  categoryBudgetAmountFieldName,
} from "@/app/budgets/action-state";

const USER_ID = "user_1" as UserId;

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
const requireUserId = vi.fn<() => Promise<UserId>>();

const saveBudgets = vi.fn();
const saveCategoryBudgets = vi.fn();
const deleteBudget = vi.fn();
const listPaymentSources = vi.fn();
const listCategories = vi.fn();

vi.mock("next/navigation", () => ({ redirect: (url: string) => redirect(url) }));
vi.mock("next/cache", () => ({ revalidatePath: (path: string) => revalidatePath(path) }));
vi.mock("@/lib/session", () => ({ requireUserId: () => requireUserId() }));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/budgets", async () => {
  const actual = await vi.importActual<typeof import("@/lib/budgets")>("@/lib/budgets");
  return {
    ...actual,
    saveBudgets: (...args: unknown[]) => saveBudgets(...args),
    saveCategoryBudgets: (...args: unknown[]) => saveCategoryBudgets(...args),
    deleteBudget: (...args: unknown[]) => deleteBudget(...args),
  };
});
vi.mock("@/lib/payment-sources", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/payment-sources")>("@/lib/payment-sources");
  return {
    ...actual,
    listPaymentSources: (...args: unknown[]) => listPaymentSources(...args),
  };
});
vi.mock("@/lib/categories", async () => {
  const actual = await vi.importActual<typeof import("@/lib/categories")>("@/lib/categories");
  return {
    ...actual,
    listCategories: (...args: unknown[]) => listCategories(...args),
  };
});

const { saveBudgetsAction, saveCategoryBudgetsAction, deleteBudgetAction } = await import(
  "@/app/budgets/actions"
);
const { initialBudgetActionState } = await import("@/app/budgets/action-state");

function makePaymentSource(overrides: Partial<PaymentSource> = {}): PaymentSource {
  return {
    id: "ps_1",
    userId: USER_ID,
    name: "現金",
    type: PaymentSourceType.CASH,
    sortOrder: 1,
    isActive: true,
    isDefault: false,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

function makeCategory(overrides: Partial<Category> = {}): Category {
  return {
    id: "cat_1",
    userId: USER_ID,
    name: "食費",
    costType: CostType.VARIABLE,
    sortOrder: 1,
    isHidden: false,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

function formDataOf(entries: Record<string, string>): FormData {
  const formData = new FormData();
  for (const [key, value] of Object.entries(entries)) {
    formData.set(key, value);
  }
  return formData;
}

beforeEach(() => {
  redirect.mockClear();
  revalidatePath.mockClear();
  requireUserId.mockReset();
  requireUserId.mockResolvedValue(USER_ID);
  saveBudgets.mockReset();
  saveCategoryBudgets.mockReset();
  deleteBudget.mockReset();
  listPaymentSources.mockReset();
  listCategories.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

/** requireUserId() が未ログインのときの実際の挙動（redirect(LOGIN_PATH) を呼んで例外を投げる）を再現する */
function mockUnauthenticated(): void {
  requireUserId.mockImplementation(() => {
    redirect("/login");
    throw new Error("unreachable");
  });
}

describe("認証なしアクセスの拒否", () => {
  const cases: Array<[string, () => Promise<unknown>, ReturnType<typeof vi.fn>]> = [
    [
      "saveBudgetsAction",
      () =>
        saveBudgetsAction(
          initialBudgetActionState,
          formDataOf({ yearMonth: "2026-08" }),
        ),
      saveBudgets,
    ],
    [
      "saveCategoryBudgetsAction",
      () =>
        saveCategoryBudgetsAction(
          initialBudgetActionState,
          formDataOf({ yearMonth: "2026-08" }),
        ),
      saveCategoryBudgets,
    ],
    [
      "deleteBudgetAction",
      () =>
        deleteBudgetAction(
          initialBudgetActionState,
          formDataOf({ yearMonth: "2026-08", paymentSourceId: "ps_1" }),
        ),
      deleteBudget,
    ],
  ];

  it.each(cases)(
    "%s はセッションが無ければ /login へ redirect し、データ層を呼ばない",
    async (_label, run, dataFn) => {
      mockUnauthenticated();
      await expect(run()).rejects.toThrow("NEXT_REDIRECT");
      expect(redirect).toHaveBeenCalledWith("/login");
      expect(dataFn).not.toHaveBeenCalled();
      expect(listPaymentSources).not.toHaveBeenCalled();
      expect(listCategories).not.toHaveBeenCalled();
    },
  );
});

describe("saveBudgetsAction", () => {
  it("yearMonth が不正なら検証エラーを返し、払い出し先の一覧すら取得しない", async () => {
    const result = await saveBudgetsAction(
      initialBudgetActionState,
      formDataOf({ yearMonth: "invalid" }),
    );
    expect(result).toEqual({ error: YEAR_MONTH_ERRORS.invalid, saved: false });
    expect(listPaymentSources).not.toHaveBeenCalled();
    expect(saveBudgets).not.toHaveBeenCalled();
  });

  it("formData.has が真の払い出し先だけを保存対象にする（無い行は変更しない）", async () => {
    listPaymentSources.mockResolvedValue([
      makePaymentSource({ id: "ps_1", name: "現金" }),
      makePaymentSource({ id: "ps_2", name: "Aカード" }),
      makePaymentSource({ id: "ps_3", name: "A銀行" }),
    ]);
    saveBudgets.mockResolvedValue({ ok: true, value: null });

    const formData = formDataOf({
      yearMonth: "2026-08",
      [budgetAmountFieldName("ps_1")]: "40000",
      [budgetAmountFieldName("ps_2")]: "",
      // ps_3 のフィールドは送らない → 変更対象に含めない
    });

    await saveBudgetsAction(initialBudgetActionState, formData);

    expect(saveBudgets).toHaveBeenCalledWith(expect.anything(), USER_ID, "2026-08", [
      { paymentSourceId: "ps_1", amountYen: 40000 },
      { paymentSourceId: "ps_2", amountYen: null },
    ]);
  });

  it("金額が不正な行があれば、その払い出し先名を含めたエラーを返し保存しない", async () => {
    listPaymentSources.mockResolvedValue([makePaymentSource({ id: "ps_1", name: "現金" })]);

    const formData = formDataOf({
      yearMonth: "2026-08",
      [budgetAmountFieldName("ps_1")]: "-100",
    });

    const result = await saveBudgetsAction(initialBudgetActionState, formData);

    expect(result).toEqual({
      error: `現金：${BUDGET_AMOUNT_ERRORS.negative}`,
      saved: false,
    });
    expect(saveBudgets).not.toHaveBeenCalled();
  });

  it("成功時は revalidate して { error: null, saved: true } を返す", async () => {
    listPaymentSources.mockResolvedValue([makePaymentSource({ id: "ps_1" })]);
    saveBudgets.mockResolvedValue({ ok: true, value: null });

    const result = await saveBudgetsAction(
      initialBudgetActionState,
      formDataOf({ yearMonth: "2026-08", [budgetAmountFieldName("ps_1")]: "1000" }),
    );

    expect(revalidatePath).toHaveBeenCalledWith(BUDGETS_PATH);
    expect(result).toEqual({ error: null, saved: true });
  });

  it("データ層が拒否した場合はそのメッセージを返し、saved は false", async () => {
    listPaymentSources.mockResolvedValue([makePaymentSource({ id: "ps_1" })]);
    saveBudgets.mockResolvedValue({ ok: false, error: BUDGET_ERRORS.paymentSourceNotFound });

    const result = await saveBudgetsAction(
      initialBudgetActionState,
      formDataOf({ yearMonth: "2026-08", [budgetAmountFieldName("ps_1")]: "1000" }),
    );

    expect(result).toEqual({ error: BUDGET_ERRORS.paymentSourceNotFound, saved: false });
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

describe("saveCategoryBudgetsAction", () => {
  it("yearMonth が不正なら検証エラーを返し、カテゴリの一覧すら取得しない", async () => {
    const result = await saveCategoryBudgetsAction(
      initialBudgetActionState,
      formDataOf({ yearMonth: "invalid" }),
    );
    expect(result).toEqual({ error: YEAR_MONTH_ERRORS.invalid, saved: false });
    expect(listCategories).not.toHaveBeenCalled();
    expect(saveCategoryBudgets).not.toHaveBeenCalled();
  });

  it("formData.has が真のカテゴリだけを保存対象にする", async () => {
    listCategories.mockResolvedValue([
      makeCategory({ id: "cat_1", name: "食費" }),
      makeCategory({ id: "cat_2", name: "日用品" }),
    ]);
    saveCategoryBudgets.mockResolvedValue({ ok: true, value: null });

    const formData = formDataOf({
      yearMonth: "2026-08",
      [categoryBudgetAmountFieldName("cat_1")]: "5000",
      // cat_2 は送らない
    });

    await saveCategoryBudgetsAction(initialBudgetActionState, formData);

    expect(saveCategoryBudgets).toHaveBeenCalledWith(expect.anything(), USER_ID, "2026-08", [
      { categoryId: "cat_1", amountYen: 5000 },
    ]);
  });

  it("金額が不正な行があればカテゴリ名を含めたエラーを返し保存しない", async () => {
    listCategories.mockResolvedValue([makeCategory({ id: "cat_1", name: "食費" })]);

    const formData = formDataOf({
      yearMonth: "2026-08",
      [categoryBudgetAmountFieldName("cat_1")]: "abc",
    });

    const result = await saveCategoryBudgetsAction(initialBudgetActionState, formData);

    expect(result).toEqual({
      error: `食費：${BUDGET_AMOUNT_ERRORS.invalid}`,
      saved: false,
    });
    expect(saveCategoryBudgets).not.toHaveBeenCalled();
  });

  it("成功時は revalidate して { error: null, saved: true } を返す", async () => {
    listCategories.mockResolvedValue([makeCategory({ id: "cat_1" })]);
    saveCategoryBudgets.mockResolvedValue({ ok: true, value: null });

    const result = await saveCategoryBudgetsAction(
      initialBudgetActionState,
      formDataOf({ yearMonth: "2026-08", [categoryBudgetAmountFieldName("cat_1")]: "3000" }),
    );

    expect(revalidatePath).toHaveBeenCalledWith(BUDGETS_PATH);
    expect(result).toEqual({ error: null, saved: true });
  });
});

describe("deleteBudgetAction", () => {
  it("yearMonth が不正なら検証エラーを返し、データ層を呼ばない", async () => {
    const result = await deleteBudgetAction(
      initialBudgetActionState,
      formDataOf({ yearMonth: "invalid", paymentSourceId: "ps_1" }),
    );
    expect(result).toEqual({ error: YEAR_MONTH_ERRORS.invalid, saved: false });
    expect(deleteBudget).not.toHaveBeenCalled();
  });

  it("paymentSourceId が無ければ検証エラーを返す", async () => {
    const result = await deleteBudgetAction(
      initialBudgetActionState,
      formDataOf({ yearMonth: "2026-08" }),
    );
    expect(result).toEqual({ error: PAYMENT_SOURCE_VALIDATION_ERRORS.idRequired, saved: false });
    expect(deleteBudget).not.toHaveBeenCalled();
  });

  it("成功時は id と yearMonth を渡し、revalidate して { error: null, saved: true } を返す", async () => {
    deleteBudget.mockResolvedValue({ ok: true, value: null });

    const result = await deleteBudgetAction(
      initialBudgetActionState,
      formDataOf({ yearMonth: "2026-08", paymentSourceId: "ps_1" }),
    );

    expect(deleteBudget).toHaveBeenCalledWith(expect.anything(), USER_ID, "ps_1", "2026-08");
    expect(revalidatePath).toHaveBeenCalledWith(BUDGETS_PATH);
    expect(result).toEqual({ error: null, saved: true });
  });

  it("データ層が拒否した場合はそのメッセージを返す", async () => {
    deleteBudget.mockResolvedValue({ ok: false, error: BUDGET_ERRORS.invalidYearMonth });

    const result = await deleteBudgetAction(
      initialBudgetActionState,
      formDataOf({ yearMonth: "2026-08", paymentSourceId: "ps_1" }),
    );

    expect(result).toEqual({ error: BUDGET_ERRORS.invalidYearMonth, saved: false });
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});
