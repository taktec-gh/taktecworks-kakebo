// @vitest-environment node
//
// src/app/incomes/actions.ts の Server Action を検証する。
// データ層（@/lib/incomes）と副作用（session / next/cache / next/navigation）をモックし、
// 検証（@/lib/income-validation）は実物を使う
// （tests/app/expenses/actions.test.ts・tests/app/budgets/actions.test.ts と同じ方針）。
//
// 期待値の根拠:
// - docs/steps/step-6.md「3-5. 画面 > Server Action」
//   「(prevState, formData) => state」「失敗時は例外を投げず日本語メッセージを返す」
//   「各アクションで getSession() を確認する」
//   「成功時は revalidatePath で / と /incomes の両方を更新する」
// - docs/steps/step-6.md「tester への引き継ぎ > Server Action」
//   「createIncomeAction: 成功 → { error: null, savedCount: prev+1 } ＋
//    revalidatePath("/incomes") と revalidatePath("/")」
//   「deleteIncomeAction: 成功時も画面遷移しない（redirect しない）」
//   「どちらも先頭で getSession() を確認し、未ログインなら redirect(LOGIN_PATH)」
// - docs/steps/step-6.md「編集画面は作らない」（updateIncome が無いことに対応し、
//   このファイルのテストも追加・削除のみを対象にする）

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LOGIN_PATH } from "@/lib/auth";
import { INCOME_ERRORS } from "@/lib/incomes";
import { INCOME_VALIDATION_ERRORS } from "@/lib/income-validation";
import type { UserId } from "@/lib/user-id";
import { YEAR_MONTH_ERRORS } from "@/lib/year-month";
import { DASHBOARD_PATH } from "@/app/dashboard-path";
import { INCOMES_PATH } from "@/app/incomes/action-state";

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

const createIncome = vi.fn();
const deleteIncome = vi.fn();

vi.mock("next/navigation", () => ({ redirect: (url: string) => redirect(url) }));
vi.mock("next/cache", () => ({ revalidatePath: (path: string) => revalidatePath(path) }));
vi.mock("@/lib/session", () => ({ requireUserId: () => requireUserId() }));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/incomes", async () => {
  const actual = await vi.importActual<typeof import("@/lib/incomes")>("@/lib/incomes");
  return {
    ...actual,
    createIncome: (...args: unknown[]) => createIncome(...args),
    deleteIncome: (...args: unknown[]) => deleteIncome(...args),
  };
});

const { createIncomeAction, deleteIncomeAction } = await import("@/app/incomes/actions");
const { initialIncomeActionState } = await import("@/app/incomes/action-state");

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
  createIncome.mockReset();
  deleteIncome.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

/** requireUserId() が未ログインのときの実際の挙動（redirect(LOGIN_PATH) を呼んで例外を投げる）を再現する */
function mockUnauthenticated(): void {
  requireUserId.mockImplementation(() => {
    redirect(LOGIN_PATH);
    throw new Error("unreachable");
  });
}

describe("認証なしアクセスの拒否", () => {
  const cases: Array<[string, () => Promise<unknown>, ReturnType<typeof vi.fn>]> = [
    [
      "createIncomeAction",
      () =>
        createIncomeAction(
          initialIncomeActionState,
          formDataOf({ yearMonth: "2026-08", amount: "1000", label: "" }),
        ),
      createIncome,
    ],
    [
      "deleteIncomeAction",
      () => deleteIncomeAction(initialIncomeActionState, formDataOf({ id: "income_1" })),
      deleteIncome,
    ],
  ];

  it.each(cases)(
    "%s はセッションが無ければ /login へ redirect し、データ層を呼ばない",
    async (_label, run, dataFn) => {
      mockUnauthenticated();
      await expect(run()).rejects.toThrow("NEXT_REDIRECT");
      expect(redirect).toHaveBeenCalledWith(LOGIN_PATH);
      expect(dataFn).not.toHaveBeenCalled();
    },
  );
});

describe("createIncomeAction", () => {
  it("yearMonth が不正なら検証エラーを返し、データ層を呼ばない", async () => {
    const result = await createIncomeAction(
      initialIncomeActionState,
      formDataOf({ yearMonth: "invalid", amount: "1000", label: "" }),
    );
    expect(result).toEqual({ error: YEAR_MONTH_ERRORS.invalid, savedCount: 0 });
    expect(createIncome).not.toHaveBeenCalled();
  });

  it("金額が空欄なら検証エラーを返す（予算と違い空欄は不可）", async () => {
    const result = await createIncomeAction(
      initialIncomeActionState,
      formDataOf({ yearMonth: "2026-08", amount: "", label: "" }),
    );
    expect(result).toEqual({ error: INCOME_VALIDATION_ERRORS.amountRequired, savedCount: 0 });
    expect(createIncome).not.toHaveBeenCalled();
  });

  it("金額が0円なら検証エラーを返す（下限1円）", async () => {
    const result = await createIncomeAction(
      initialIncomeActionState,
      formDataOf({ yearMonth: "2026-08", amount: "0", label: "" }),
    );
    expect(result).toEqual({ error: INCOME_VALIDATION_ERRORS.amountTooSmall, savedCount: 0 });
    expect(createIncome).not.toHaveBeenCalled();
  });

  it("ラベルが21文字なら検証エラーを返す（上限20文字）", async () => {
    const result = await createIncomeAction(
      initialIncomeActionState,
      formDataOf({ yearMonth: "2026-08", amount: "1000", label: "あ".repeat(21) }),
    );
    expect(result).toEqual({ error: INCOME_VALIDATION_ERRORS.labelTooLong, savedCount: 0 });
    expect(createIncome).not.toHaveBeenCalled();
  });

  it("成功時は yearMonth・金額・ラベルを createIncome に渡し、/incomes と / の両方を revalidate する", async () => {
    createIncome.mockResolvedValue({ ok: true, value: { id: "income_1" } });

    const result = await createIncomeAction(
      initialIncomeActionState,
      formDataOf({ yearMonth: "2026-08", amount: "300000", label: "給与" }),
    );

    expect(createIncome).toHaveBeenCalledWith(expect.anything(), USER_ID, {
      yearMonth: "2026-08",
      amountYen: 300_000,
      label: "給与",
    });
    expect(revalidatePath).toHaveBeenCalledWith(INCOMES_PATH);
    expect(revalidatePath).toHaveBeenCalledWith(DASHBOARD_PATH);
    expect(result).toEqual({ error: null, savedCount: 1 });
  });

  it("savedCount は成功のたびに+1（0円到達は無いが2件目以降の増分を確認）", async () => {
    createIncome.mockResolvedValue({ ok: true, value: { id: "income_2" } });

    const result = await createIncomeAction(
      { error: null, savedCount: 1 },
      formDataOf({ yearMonth: "2026-08", amount: "1000", label: "" }),
    );

    expect(result).toEqual({ error: null, savedCount: 2 });
  });

  it("データ層が拒否した場合はそのメッセージを返し、savedCount は増えず revalidate もしない", async () => {
    createIncome.mockResolvedValue({ ok: false, error: INCOME_ERRORS.invalidAmount });

    const result = await createIncomeAction(
      initialIncomeActionState,
      formDataOf({ yearMonth: "2026-08", amount: "1000", label: "" }),
    );

    expect(result).toEqual({ error: INCOME_ERRORS.invalidAmount, savedCount: 0 });
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

describe("deleteIncomeAction", () => {
  it("id が無ければ検証エラーを返し、データ層を呼ばない", async () => {
    const result = await deleteIncomeAction(initialIncomeActionState, formDataOf({ id: "" }));
    expect(result).toEqual({ error: INCOME_VALIDATION_ERRORS.idRequired, savedCount: 0 });
    expect(deleteIncome).not.toHaveBeenCalled();
  });

  it("成功時は id で deleteIncome を呼び、/incomes と / の両方を revalidate する。redirect はしない", async () => {
    deleteIncome.mockResolvedValue({ ok: true, value: null });

    const result = await deleteIncomeAction(
      initialIncomeActionState,
      formDataOf({ id: "income_1" }),
    );

    expect(deleteIncome).toHaveBeenCalledWith(expect.anything(), USER_ID, "income_1");
    expect(revalidatePath).toHaveBeenCalledWith(INCOMES_PATH);
    expect(revalidatePath).toHaveBeenCalledWith(DASHBOARD_PATH);
    expect(result).toEqual({ error: null, savedCount: 1 });
    expect(redirect).not.toHaveBeenCalled();
  });

  it("対象が見つからない場合はエラーを返し、savedCount は増えず revalidate もしない", async () => {
    deleteIncome.mockResolvedValue({ ok: false, error: INCOME_ERRORS.notFound });

    const result = await deleteIncomeAction(
      initialIncomeActionState,
      formDataOf({ id: "income_missing" }),
    );

    expect(result).toEqual({ error: INCOME_ERRORS.notFound, savedCount: 0 });
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});
