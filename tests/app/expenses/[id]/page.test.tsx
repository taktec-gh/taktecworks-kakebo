// src/app/expenses/[id]/page.tsx（支出の編集ページ）の「配線」を検証する。
//
// フォーム自体の挙動は tests/app/expenses/expense-form.test.tsx・
// tests/app/expenses/[id]/expense-delete-form.test.tsx で検証済みのため、
// ここでは重複させず、page.tsx だけが持つ配線だけを見る
// （tests/app/page.test.tsx・tests/app/incomes/page.test.tsx と同じ方針）:
//
// - proxy とは別に requireUserId() を呼び、その戻り値をデータ層（getExpense 等）へ渡すこと
// - 他人の支出ID（getExpense が null を返す）は notFound() になること
//   （存在しないIDと同じ応答。docs/steps/pub-1.md 設計判断 11・「その他の観点」2）
//
// 期待値の根拠:
// - docs/steps/pub-1.md「実装内容 > 4. ページ」
//   「proxy のガードとは別に requireUserId() を呼び、データ層へ渡す」
// - docs/steps/pub-1.md「その他の観点」2.
//   「[id] の3ページで他人のIDが notFound() になること」
// - src/app/expenses/[id]/page.tsx の実装（getExpense が null なら notFound()）

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { UserId } from "@/lib/user-id";

const USER_ID = "user_1" as UserId;
const OTHER_USER_EXPENSE_ID = "exp_other_user";

class NotFoundError extends Error {
  digest = "NEXT_NOT_FOUND";
  constructor() {
    super("NEXT_NOT_FOUND");
  }
}

const notFound = vi.fn((): never => {
  throw new NotFoundError();
});

const getExpenseMock = vi.fn();
const listCategoriesMock = vi.fn();
const listPaymentSourcesMock = vi.fn();
const listRecentStoreNamesMock = vi.fn();

vi.mock("next/server", () => ({ connection: async () => undefined }));
vi.mock("next/navigation", () => ({ notFound: () => notFound() }));
vi.mock("@/lib/session", () => ({ requireUserId: async () => USER_ID }));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));

vi.mock("@/lib/expenses", async () => {
  const actual = await vi.importActual<typeof import("@/lib/expenses")>("@/lib/expenses");
  return {
    ...actual,
    getExpense: (...args: unknown[]) => getExpenseMock(...args),
    listRecentStoreNames: (...args: unknown[]) => listRecentStoreNamesMock(...args),
  };
});
vi.mock("@/lib/categories", async () => {
  const actual = await vi.importActual<typeof import("@/lib/categories")>("@/lib/categories");
  return {
    ...actual,
    listCategories: (...args: unknown[]) => listCategoriesMock(...args),
  };
});
vi.mock("@/lib/payment-sources", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/payment-sources")>("@/lib/payment-sources");
  return {
    ...actual,
    listPaymentSources: (...args: unknown[]) => listPaymentSourcesMock(...args),
  };
});

// フォーム本体の詳細は別ファイルで検証済み。ここでは配線だけを見るため軽量なスタブにする
vi.mock("@/app/expenses/expense-form", () => ({
  ExpenseForm: ({ expenseId }: { expenseId?: string }) => (
    <div data-testid="expense-form">{expenseId}</div>
  ),
}));
vi.mock("@/app/expenses/[id]/expense-delete-form", () => ({
  ExpenseDeleteForm: ({ id }: { id: string }) => <div data-testid="expense-delete-form">{id}</div>,
}));

const { default: ExpenseEditPage } = await import("@/app/expenses/[id]/page");
const { PaymentSourceType, WasteTag, CostType } = await import("@/generated/prisma/enums");

function makeExpense() {
  return {
    id: "exp_1",
    userId: USER_ID,
    date: new Date("2026-08-05T00:00:00.000Z"),
    amountYen: 1200,
    categoryId: "cat_1",
    paymentSourceId: "ps_1",
    storeName: "スーパー",
    memo: null,
    wasteTag: WasteTag.NECESSARY,
    createdAt: new Date("2026-08-05T00:00:00.000Z"),
    updatedAt: new Date("2026-08-05T00:00:00.000Z"),
    category: {
      id: "cat_1",
      userId: USER_ID,
      name: "食費",
      costType: CostType.VARIABLE,
      sortOrder: 1,
      isHidden: false,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    },
    paymentSource: {
      id: "ps_1",
      userId: USER_ID,
      name: "現金",
      type: PaymentSourceType.CASH,
      sortOrder: 1,
      isActive: true,
      isDefault: true,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    },
  };
}

beforeEach(() => {
  notFound.mockClear();
  getExpenseMock.mockReset();
  listCategoriesMock.mockReset().mockResolvedValue([]);
  listPaymentSourcesMock.mockReset().mockResolvedValue([]);
  listRecentStoreNamesMock.mockReset().mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
});

describe("ExpenseEditPage", () => {
  it("requireUserId() の戻り値を getExpense へ渡す", async () => {
    getExpenseMock.mockResolvedValue(makeExpense());

    const jsx = await ExpenseEditPage({ params: Promise.resolve({ id: "exp_1" }) });
    render(jsx);

    expect(getExpenseMock).toHaveBeenCalledWith(expect.anything(), USER_ID, "exp_1");
    expect(listCategoriesMock).toHaveBeenCalledWith(expect.anything(), USER_ID);
    expect(listPaymentSourcesMock).toHaveBeenCalledWith(expect.anything(), USER_ID);
    expect(listRecentStoreNamesMock).toHaveBeenCalledWith(expect.anything(), USER_ID);
  });

  it("自分の支出IDなら notFound() を呼ばずに描画する", async () => {
    getExpenseMock.mockResolvedValue(makeExpense());

    const jsx = await ExpenseEditPage({ params: Promise.resolve({ id: "exp_1" }) });
    render(jsx);

    expect(notFound).not.toHaveBeenCalled();
    expect(screen.getByTestId("expense-form")).toHaveTextContent("exp_1");
    expect(screen.getByTestId("expense-delete-form")).toHaveTextContent("exp_1");
  });

  it("他人の支出ID（getExpense が null）は notFound() になる。存在しないIDと同じ応答", async () => {
    getExpenseMock.mockResolvedValue(null);

    await expect(
      ExpenseEditPage({ params: Promise.resolve({ id: OTHER_USER_EXPENSE_ID }) }),
    ).rejects.toThrow("NEXT_NOT_FOUND");

    expect(notFound).toHaveBeenCalledTimes(1);
    expect(getExpenseMock).toHaveBeenCalledWith(
      expect.anything(),
      USER_ID,
      OTHER_USER_EXPENSE_ID,
    );
  });
});
