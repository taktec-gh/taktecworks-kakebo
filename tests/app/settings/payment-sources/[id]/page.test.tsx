// src/app/settings/payment-sources/[id]/page.tsx（払い出し先の編集ページ）の「配線」を検証する。
//
// フォーム自体の挙動は
// tests/app/settings/payment-sources/[id]/payment-source-edit-form.test.tsx で検証済みのため、
// ここでは重複させず page.tsx だけが持つ配線だけを見る。
//
// 期待値の根拠:
// - docs/steps/pub-1.md「実装内容 > 4. ページ」
//   「proxy のガードとは別に requireUserId() を呼び、データ層へ渡す」
// - docs/steps/pub-1.md「その他の観点」2.
//   「[id] の3ページで他人のIDが notFound() になること」
// - src/app/settings/payment-sources/[id]/page.tsx の実装
//   （getPaymentSourceDetail が null なら notFound()）

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { UserId } from "@/lib/user-id";

const USER_ID = "user_1" as UserId;
const OTHER_USER_PAYMENT_SOURCE_ID = "ps_other_user";

class NotFoundError extends Error {
  digest = "NEXT_NOT_FOUND";
  constructor() {
    super("NEXT_NOT_FOUND");
  }
}

const notFound = vi.fn((): never => {
  throw new NotFoundError();
});

const getPaymentSourceDetailMock = vi.fn();

vi.mock("next/server", () => ({ connection: async () => undefined }));
vi.mock("next/navigation", () => ({ notFound: () => notFound() }));
vi.mock("@/lib/session", () => ({ requireUserId: async () => USER_ID }));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));

vi.mock("@/lib/payment-sources", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/payment-sources")>("@/lib/payment-sources");
  return {
    ...actual,
    getPaymentSourceDetail: (...args: unknown[]) => getPaymentSourceDetailMock(...args),
  };
});

vi.mock("@/app/settings/payment-sources/[id]/payment-source-edit-form", () => ({
  PaymentSourceEditForm: ({ id }: { id: string }) => (
    <div data-testid="payment-source-edit-form">{id}</div>
  ),
}));

const { default: PaymentSourceEditPage } = await import(
  "@/app/settings/payment-sources/[id]/page"
);
const { PaymentSourceType } = await import("@/generated/prisma/enums");

function makeDetail() {
  const now = new Date("2026-01-01T00:00:00.000Z");
  return {
    paymentSource: {
      id: "ps_1",
      userId: USER_ID,
      name: "現金",
      type: PaymentSourceType.CASH,
      sortOrder: 1,
      isActive: true,
      isDefault: true,
      createdAt: now,
      updatedAt: now,
    },
    expenseCount: 0,
    budgetCount: 0,
    activeCount: 1,
  };
}

beforeEach(() => {
  notFound.mockClear();
  getPaymentSourceDetailMock.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("PaymentSourceEditPage", () => {
  it("requireUserId() の戻り値を getPaymentSourceDetail へ渡す", async () => {
    getPaymentSourceDetailMock.mockResolvedValue(makeDetail());

    const jsx = await PaymentSourceEditPage({ params: Promise.resolve({ id: "ps_1" }) });
    render(jsx);

    expect(getPaymentSourceDetailMock).toHaveBeenCalledWith(expect.anything(), USER_ID, "ps_1");
  });

  it("自分の払い出し先IDなら notFound() を呼ばずに描画する", async () => {
    getPaymentSourceDetailMock.mockResolvedValue(makeDetail());

    const jsx = await PaymentSourceEditPage({ params: Promise.resolve({ id: "ps_1" }) });
    render(jsx);

    expect(notFound).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "現金" })).toBeInTheDocument();
    expect(screen.getByTestId("payment-source-edit-form")).toHaveTextContent("ps_1");
  });

  it("他人の払い出し先ID（getPaymentSourceDetail が null）は notFound() になる。存在しないIDと同じ応答", async () => {
    getPaymentSourceDetailMock.mockResolvedValue(null);

    await expect(
      PaymentSourceEditPage({ params: Promise.resolve({ id: OTHER_USER_PAYMENT_SOURCE_ID }) }),
    ).rejects.toThrow("NEXT_NOT_FOUND");

    expect(notFound).toHaveBeenCalledTimes(1);
    expect(getPaymentSourceDetailMock).toHaveBeenCalledWith(
      expect.anything(),
      USER_ID,
      OTHER_USER_PAYMENT_SOURCE_ID,
    );
  });
});
