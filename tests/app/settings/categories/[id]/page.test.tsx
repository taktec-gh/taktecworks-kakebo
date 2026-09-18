// src/app/settings/categories/[id]/page.tsx（カテゴリの編集ページ）の「配線」を検証する。
//
// フォーム自体の挙動は tests/app/settings/categories/[id]/category-edit-form.test.tsx で
// 検証済みのため、ここでは重複させず page.tsx だけが持つ配線だけを見る。
//
// 期待値の根拠:
// - docs/steps/pub-1.md「実装内容 > 4. ページ」
//   「proxy のガードとは別に requireUserId() を呼び、データ層へ渡す」
// - docs/steps/pub-1.md「その他の観点」2.
//   「[id] の3ページで他人のIDが notFound() になること」
// - src/app/settings/categories/[id]/page.tsx の実装（getCategoryDetail が null なら notFound()）

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { UserId } from "@/lib/user-id";

const USER_ID = "user_1" as UserId;
const OTHER_USER_CATEGORY_ID = "cat_other_user";

class NotFoundError extends Error {
  digest = "NEXT_NOT_FOUND";
  constructor() {
    super("NEXT_NOT_FOUND");
  }
}

const notFound = vi.fn((): never => {
  throw new NotFoundError();
});

const getCategoryDetailMock = vi.fn();

vi.mock("next/server", () => ({ connection: async () => undefined }));
vi.mock("next/navigation", () => ({ notFound: () => notFound() }));
vi.mock("@/lib/session", () => ({ requireUserId: async () => USER_ID }));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));

vi.mock("@/lib/categories", async () => {
  const actual = await vi.importActual<typeof import("@/lib/categories")>("@/lib/categories");
  return {
    ...actual,
    getCategoryDetail: (...args: unknown[]) => getCategoryDetailMock(...args),
  };
});

vi.mock("@/app/settings/categories/[id]/category-edit-form", () => ({
  CategoryEditForm: ({ id }: { id: string }) => <div data-testid="category-edit-form">{id}</div>,
}));

const { default: CategoryEditPage } = await import("@/app/settings/categories/[id]/page");
const { CostType } = await import("@/generated/prisma/enums");

function makeDetail() {
  const now = new Date("2026-01-01T00:00:00.000Z");
  return {
    category: {
      id: "cat_1",
      userId: USER_ID,
      name: "食費",
      costType: CostType.VARIABLE,
      sortOrder: 1,
      isHidden: false,
      createdAt: now,
      updatedAt: now,
    },
    expenseCount: 0,
    budgetCount: 0,
  };
}

beforeEach(() => {
  notFound.mockClear();
  getCategoryDetailMock.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("CategoryEditPage", () => {
  it("requireUserId() の戻り値を getCategoryDetail へ渡す", async () => {
    getCategoryDetailMock.mockResolvedValue(makeDetail());

    const jsx = await CategoryEditPage({ params: Promise.resolve({ id: "cat_1" }) });
    render(jsx);

    expect(getCategoryDetailMock).toHaveBeenCalledWith(expect.anything(), USER_ID, "cat_1");
  });

  it("自分のカテゴリIDなら notFound() を呼ばずに描画する", async () => {
    getCategoryDetailMock.mockResolvedValue(makeDetail());

    const jsx = await CategoryEditPage({ params: Promise.resolve({ id: "cat_1" }) });
    render(jsx);

    expect(notFound).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "食費" })).toBeInTheDocument();
    expect(screen.getByTestId("category-edit-form")).toHaveTextContent("cat_1");
  });

  it("他人のカテゴリID（getCategoryDetail が null）は notFound() になる。存在しないIDと同じ応答", async () => {
    getCategoryDetailMock.mockResolvedValue(null);

    await expect(
      CategoryEditPage({ params: Promise.resolve({ id: OTHER_USER_CATEGORY_ID }) }),
    ).rejects.toThrow("NEXT_NOT_FOUND");

    expect(notFound).toHaveBeenCalledTimes(1);
    expect(getCategoryDetailMock).toHaveBeenCalledWith(
      expect.anything(),
      USER_ID,
      OTHER_USER_CATEGORY_ID,
    );
  });
});
