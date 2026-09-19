// @vitest-environment node
//
// src/app/settings/categories/actions.ts の Server Action を検証する。
// データ層（@/lib/categories）と副作用（session / next/cache / next/navigation）を
// モックし、検証（@/lib/category-validation・category-order）は実物を使う
// （tests/app/settings/payment-sources/actions.test.ts と同じ方針）。
//
// 期待値の根拠:
// - docs/steps/step-4.md「実装完了後の引き継ぎ」の Server Action の約束ごと
//   （カテゴリ側の state は Step3 と同じ { error } のみ）
// - docs/steps/step-4.md「特に確認したい観点」11.（全 Server Action が getSession() を呼ぶこと）

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CostType, type Category } from "@/generated/prisma/client";
import { CATEGORY_ORDER_ERRORS } from "@/lib/category-order";
import { CATEGORY_VALIDATION_ERRORS } from "@/lib/category-validation";
import { CATEGORY_ERRORS } from "@/lib/categories";
import type { UserId } from "@/lib/user-id";
import { CATEGORIES_PATH, categoryDetailPath } from "@/app/settings/categories/action-state";

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

const createCategory = vi.fn();
const updateCategory = vi.fn();
const setCategoryHidden = vi.fn();
const moveCategory = vi.fn();
const deleteCategory = vi.fn();

vi.mock("next/navigation", () => ({ redirect: (url: string) => redirect(url) }));
vi.mock("next/cache", () => ({ revalidatePath: (path: string) => revalidatePath(path) }));
vi.mock("@/lib/session", () => ({ requireUserId: () => requireUserId() }));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/categories", async () => {
  const actual = await vi.importActual<typeof import("@/lib/categories")>("@/lib/categories");
  return {
    ...actual,
    createCategory: (...args: unknown[]) => createCategory(...args),
    updateCategory: (...args: unknown[]) => updateCategory(...args),
    setCategoryHidden: (...args: unknown[]) => setCategoryHidden(...args),
    moveCategory: (...args: unknown[]) => moveCategory(...args),
    deleteCategory: (...args: unknown[]) => deleteCategory(...args),
  };
});

const {
  createCategoryAction,
  updateCategoryAction,
  setCategoryHiddenAction,
  moveCategoryAction,
  deleteCategoryAction,
} = await import("@/app/settings/categories/actions");
const { initialCategoryActionState } = await import("@/app/settings/categories/action-state");

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
  createCategory.mockReset();
  updateCategory.mockReset();
  setCategoryHidden.mockReset();
  moveCategory.mockReset();
  deleteCategory.mockReset();
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
      "createCategoryAction",
      () =>
        createCategoryAction(
          initialCategoryActionState,
          formDataOf({ name: "食費", costType: CostType.VARIABLE }),
        ),
      createCategory,
    ],
    [
      "updateCategoryAction",
      () =>
        updateCategoryAction(
          initialCategoryActionState,
          formDataOf({ id: "cat_1", name: "食費", costType: CostType.VARIABLE }),
        ),
      updateCategory,
    ],
    [
      "setCategoryHiddenAction",
      () =>
        setCategoryHiddenAction(
          initialCategoryActionState,
          formDataOf({ id: "cat_1", isHidden: "true" }),
        ),
      setCategoryHidden,
    ],
    [
      "moveCategoryAction",
      () =>
        moveCategoryAction(
          initialCategoryActionState,
          formDataOf({ id: "cat_1", direction: "up" }),
        ),
      moveCategory,
    ],
    [
      "deleteCategoryAction",
      () => deleteCategoryAction(initialCategoryActionState, formDataOf({ id: "cat_1" })),
      deleteCategory,
    ],
  ];

  it.each(cases)(
    "%s はセッションが無ければ /login へ redirect し、データ層を呼ばない",
    async (_label, run, dataFn) => {
      mockUnauthenticated();
      await expect(run()).rejects.toThrow("NEXT_REDIRECT");
      expect(redirect).toHaveBeenCalledWith("/login");
      expect(dataFn).not.toHaveBeenCalled();
    },
  );
});

describe("createCategoryAction", () => {
  it("名前が空なら検証エラーを返し、データ層を呼ばない", async () => {
    const result = await createCategoryAction(
      initialCategoryActionState,
      formDataOf({ name: "", costType: CostType.VARIABLE }),
    );
    expect(result).toEqual({ error: CATEGORY_VALIDATION_ERRORS.nameRequired });
    expect(createCategory).not.toHaveBeenCalled();
  });

  it("costType が不正なら検証エラーを返し、データ層を呼ばない", async () => {
    const result = await createCategoryAction(
      initialCategoryActionState,
      formDataOf({ name: "食費", costType: "SEMI_FIXED" }),
    );
    expect(result).toEqual({ error: CATEGORY_VALIDATION_ERRORS.costTypeRequired });
    expect(createCategory).not.toHaveBeenCalled();
  });

  it("成功時は trim された名前でデータ層を呼び、一覧を revalidate して error: null を返す", async () => {
    createCategory.mockResolvedValue({ ok: true, value: makeCategory() });

    const result = await createCategoryAction(
      initialCategoryActionState,
      formDataOf({ name: "  保険  ", costType: CostType.FIXED }),
    );

    expect(createCategory).toHaveBeenCalledWith(expect.anything(), USER_ID, {
      name: "保険",
      costType: CostType.FIXED,
    });
    expect(revalidatePath).toHaveBeenCalledWith(CATEGORIES_PATH);
    expect(result).toEqual({ error: null });
  });

  it("データ層が拒否した場合はそのメッセージを返し、revalidate しない", async () => {
    createCategory.mockResolvedValue({ ok: false, error: CATEGORY_ERRORS.duplicateName });

    const result = await createCategoryAction(
      initialCategoryActionState,
      formDataOf({ name: "食費", costType: CostType.VARIABLE }),
    );

    expect(result).toEqual({ error: CATEGORY_ERRORS.duplicateName });
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

describe("updateCategoryAction", () => {
  it("id が無ければ検証エラーを返す", async () => {
    const result = await updateCategoryAction(
      initialCategoryActionState,
      formDataOf({ name: "食費", costType: CostType.VARIABLE }),
    );
    expect(result).toEqual({ error: CATEGORY_VALIDATION_ERRORS.idRequired });
    expect(updateCategory).not.toHaveBeenCalled();
  });

  it("成功時は一覧と編集ページの両方を revalidate する", async () => {
    updateCategory.mockResolvedValue({ ok: true, value: makeCategory() });

    const result = await updateCategoryAction(
      initialCategoryActionState,
      formDataOf({ id: "cat_1", name: "外食", costType: CostType.VARIABLE }),
    );

    expect(updateCategory).toHaveBeenCalledWith(expect.anything(), USER_ID, {
      id: "cat_1",
      name: "外食",
      costType: CostType.VARIABLE,
    });
    expect(revalidatePath).toHaveBeenCalledWith(CATEGORIES_PATH);
    expect(revalidatePath).toHaveBeenCalledWith(categoryDetailPath("cat_1"));
    expect(result).toEqual({ error: null });
  });

  it("データ層が拒否した場合はそのメッセージを返す", async () => {
    updateCategory.mockResolvedValue({ ok: false, error: CATEGORY_ERRORS.notFound });

    const result = await updateCategoryAction(
      initialCategoryActionState,
      formDataOf({ id: "cat_1", name: "食費", costType: CostType.VARIABLE }),
    );

    expect(result).toEqual({ error: CATEGORY_ERRORS.notFound });
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

describe("setCategoryHiddenAction", () => {
  it("id が無ければ検証エラーを返す", async () => {
    const result = await setCategoryHiddenAction(
      initialCategoryActionState,
      formDataOf({ isHidden: "true" }),
    );
    expect(result).toEqual({ error: CATEGORY_VALIDATION_ERRORS.idRequired });
    expect(setCategoryHidden).not.toHaveBeenCalled();
  });

  it("isHidden='true' のときだけ非表示として扱う", async () => {
    setCategoryHidden.mockResolvedValue({ ok: true, value: makeCategory() });

    await setCategoryHiddenAction(
      initialCategoryActionState,
      formDataOf({ id: "cat_1", isHidden: "true" }),
    );

    expect(setCategoryHidden).toHaveBeenCalledWith(expect.anything(), USER_ID, "cat_1", true);
  });

  it.each(["false", "", "TRUE", "1"])(
    "isHidden='%s' は非表示ではなく再表示として扱う",
    async (value) => {
      setCategoryHidden.mockResolvedValue({ ok: true, value: makeCategory() });

      await setCategoryHiddenAction(
        initialCategoryActionState,
        formDataOf({ id: "cat_1", isHidden: value }),
      );

      expect(setCategoryHidden).toHaveBeenCalledWith(expect.anything(), USER_ID, "cat_1", false);
    },
  );

  it("isHidden フィールドが無ければ再表示として扱う", async () => {
    setCategoryHidden.mockResolvedValue({ ok: true, value: makeCategory() });

    await setCategoryHiddenAction(initialCategoryActionState, formDataOf({ id: "cat_1" }));

    expect(setCategoryHidden).toHaveBeenCalledWith(expect.anything(), USER_ID, "cat_1", false);
  });

  it("成功時は一覧と編集ページを revalidate する", async () => {
    setCategoryHidden.mockResolvedValue({ ok: true, value: makeCategory({ isHidden: true }) });

    await setCategoryHiddenAction(
      initialCategoryActionState,
      formDataOf({ id: "cat_1", isHidden: "true" }),
    );

    expect(revalidatePath).toHaveBeenCalledWith(CATEGORIES_PATH);
    expect(revalidatePath).toHaveBeenCalledWith(categoryDetailPath("cat_1"));
  });

  it("データ層が拒否した場合はそのメッセージを返す", async () => {
    setCategoryHidden.mockResolvedValue({ ok: false, error: CATEGORY_ERRORS.notFound });

    const result = await setCategoryHiddenAction(
      initialCategoryActionState,
      formDataOf({ id: "cat_1", isHidden: "true" }),
    );

    expect(result).toEqual({ error: CATEGORY_ERRORS.notFound });
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

describe("moveCategoryAction", () => {
  it("id が無ければ検証エラーを返す", async () => {
    const result = await moveCategoryAction(
      initialCategoryActionState,
      formDataOf({ direction: "up" }),
    );
    expect(result).toEqual({ error: CATEGORY_VALIDATION_ERRORS.idRequired });
    expect(moveCategory).not.toHaveBeenCalled();
  });

  it("direction が不正なら invalidDirection エラーを返し、データ層を呼ばない", async () => {
    const result = await moveCategoryAction(
      initialCategoryActionState,
      formDataOf({ id: "cat_1", direction: "sideways" }),
    );
    expect(result).toEqual({ error: CATEGORY_ORDER_ERRORS.invalidDirection });
    expect(moveCategory).not.toHaveBeenCalled();
  });

  it("成功時は id と方向を渡し、一覧と編集ページを revalidate する", async () => {
    moveCategory.mockResolvedValue({ ok: true, value: [makeCategory()] });

    const result = await moveCategoryAction(
      initialCategoryActionState,
      formDataOf({ id: "cat_1", direction: "down" }),
    );

    expect(moveCategory).toHaveBeenCalledWith(expect.anything(), USER_ID, "cat_1", "down");
    expect(revalidatePath).toHaveBeenCalledWith(CATEGORIES_PATH);
    expect(revalidatePath).toHaveBeenCalledWith(categoryDetailPath("cat_1"));
    expect(result).toEqual({ error: null });
  });

  it("グループの端で拒否された場合のメッセージを返す", async () => {
    moveCategory.mockResolvedValue({ ok: false, error: CATEGORY_ORDER_ERRORS.cannotMoveDown });

    const result = await moveCategoryAction(
      initialCategoryActionState,
      formDataOf({ id: "cat_1", direction: "down" }),
    );

    expect(result).toEqual({ error: CATEGORY_ORDER_ERRORS.cannotMoveDown });
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

describe("deleteCategoryAction", () => {
  it("id が無ければ検証エラーを返し、redirect しない", async () => {
    const result = await deleteCategoryAction(initialCategoryActionState, formDataOf({}));
    expect(result).toEqual({ error: CATEGORY_VALIDATION_ERRORS.idRequired });
    expect(deleteCategory).not.toHaveBeenCalled();
    expect(redirect).not.toHaveBeenCalled();
  });

  it("成功時は一覧を revalidate してから一覧ページへ redirect する", async () => {
    deleteCategory.mockResolvedValue({ ok: true, value: null });

    await expect(
      deleteCategoryAction(initialCategoryActionState, formDataOf({ id: "cat_1" })),
    ).rejects.toThrow("NEXT_REDIRECT");

    expect(revalidatePath).toHaveBeenCalledWith(CATEGORIES_PATH);
    expect(redirect).toHaveBeenCalledWith(CATEGORIES_PATH);
  });

  it("失敗時（支出あり・予算あり等）は redirect せずエラーメッセージを返す", async () => {
    deleteCategory.mockResolvedValue({
      ok: false,
      error: CATEGORY_ERRORS.deleteReferencedByExpense,
    });

    const result = await deleteCategoryAction(
      initialCategoryActionState,
      formDataOf({ id: "cat_1" }),
    );

    expect(result).toEqual({ error: CATEGORY_ERRORS.deleteReferencedByExpense });
    expect(redirect).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it.each([CATEGORY_ERRORS.deleteReferencedByExpense, CATEGORY_ERRORS.deleteReferencedByBudget])(
    "拒否理由 '%s' のいずれでも redirect しない",
    async (error) => {
      deleteCategory.mockResolvedValue({ ok: false, error });

      await deleteCategoryAction(initialCategoryActionState, formDataOf({ id: "cat_1" }));

      expect(redirect).not.toHaveBeenCalled();
    },
  );
});
