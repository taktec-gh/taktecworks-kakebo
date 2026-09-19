// @vitest-environment node
//
// src/app/settings/payment-sources/actions.ts の Server Action を検証する。
// データ層（@/lib/payment-sources）と副作用（session / next/cache / next/navigation）を
// モックし、検証（@/lib/payment-source-validation・order）は実物を使う
// （tests/app/(auth)/login/actions.test.ts と同じ方針）。
//
// 期待値の根拠:
// - docs/steps/step-3.md「Server Actions」「Server Action のテストに必要なモック」
// - docs/steps/step-3.md「特に確認したい観点」6.（削除失敗時に redirect しないこと）

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PaymentSource } from "@/generated/prisma/client";
import { PaymentSourceType } from "@/generated/prisma/enums";
import { PAYMENT_SOURCE_ORDER_ERRORS } from "@/lib/payment-source-order";
import { PAYMENT_SOURCE_VALIDATION_ERRORS } from "@/lib/payment-source-validation";
import { PAYMENT_SOURCE_ERRORS } from "@/lib/payment-sources";
import type { UserId } from "@/lib/user-id";
import { PAYMENT_SOURCES_PATH, paymentSourceDetailPath } from "@/app/settings/payment-sources/action-state";

const USER_ID = "user_1" as UserId;

/** redirect は本来 NEXT_REDIRECT を throw して制御を打ち切る。その挙動を再現する */
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

const createPaymentSource = vi.fn();
const updatePaymentSource = vi.fn();
const setDefaultPaymentSource = vi.fn();
const setPaymentSourceActive = vi.fn();
const movePaymentSource = vi.fn();
const deletePaymentSource = vi.fn();

vi.mock("next/navigation", () => ({ redirect: (url: string) => redirect(url) }));
vi.mock("next/cache", () => ({ revalidatePath: (path: string) => revalidatePath(path) }));
vi.mock("@/lib/session", () => ({ requireUserId: () => requireUserId() }));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/payment-sources", async () => {
  const actual = await vi.importActual<typeof import("@/lib/payment-sources")>(
    "@/lib/payment-sources",
  );
  return {
    ...actual,
    createPaymentSource: (...args: unknown[]) => createPaymentSource(...args),
    updatePaymentSource: (...args: unknown[]) => updatePaymentSource(...args),
    setDefaultPaymentSource: (...args: unknown[]) => setDefaultPaymentSource(...args),
    setPaymentSourceActive: (...args: unknown[]) => setPaymentSourceActive(...args),
    movePaymentSource: (...args: unknown[]) => movePaymentSource(...args),
    deletePaymentSource: (...args: unknown[]) => deletePaymentSource(...args),
  };
});

const {
  createPaymentSourceAction,
  updatePaymentSourceAction,
  setDefaultPaymentSourceAction,
  setPaymentSourceActiveAction,
  movePaymentSourceAction,
  deletePaymentSourceAction,
} = await import("@/app/settings/payment-sources/actions");
const { initialPaymentSourceActionState } = await import(
  "@/app/settings/payment-sources/action-state"
);

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
  createPaymentSource.mockReset();
  updatePaymentSource.mockReset();
  setDefaultPaymentSource.mockReset();
  setPaymentSourceActive.mockReset();
  movePaymentSource.mockReset();
  deletePaymentSource.mockReset();
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

/** 全 Server Action に共通する認証ガードのテスト */
describe("認証なしアクセスの拒否", () => {
  const cases: Array<
    [string, () => Promise<unknown>, ReturnType<typeof vi.fn>]
  > = [
    [
      "createPaymentSourceAction",
      () =>
        createPaymentSourceAction(
          initialPaymentSourceActionState,
          formDataOf({ name: "現金", type: PaymentSourceType.CASH }),
        ),
      createPaymentSource,
    ],
    [
      "updatePaymentSourceAction",
      () =>
        updatePaymentSourceAction(
          initialPaymentSourceActionState,
          formDataOf({ id: "ps_1", name: "現金", type: PaymentSourceType.CASH }),
        ),
      updatePaymentSource,
    ],
    [
      "setDefaultPaymentSourceAction",
      () =>
        setDefaultPaymentSourceAction(initialPaymentSourceActionState, formDataOf({ id: "ps_1" })),
      setDefaultPaymentSource,
    ],
    [
      "setPaymentSourceActiveAction",
      () =>
        setPaymentSourceActiveAction(
          initialPaymentSourceActionState,
          formDataOf({ id: "ps_1", isActive: "false" }),
        ),
      setPaymentSourceActive,
    ],
    [
      "movePaymentSourceAction",
      () =>
        movePaymentSourceAction(
          initialPaymentSourceActionState,
          formDataOf({ id: "ps_1", direction: "up" }),
        ),
      movePaymentSource,
    ],
    [
      "deletePaymentSourceAction",
      () => deletePaymentSourceAction(initialPaymentSourceActionState, formDataOf({ id: "ps_1" })),
      deletePaymentSource,
    ],
  ];

  it.each(cases)("%s はセッションが無ければ /login へ redirect し、データ層を呼ばない", async (_label, run, dataFn) => {
    mockUnauthenticated();
    await expect(run()).rejects.toThrow("NEXT_REDIRECT");
    expect(redirect).toHaveBeenCalledWith("/login");
    expect(dataFn).not.toHaveBeenCalled();
  });
});

describe("createPaymentSourceAction", () => {
  it("名前が空なら検証エラーを返し、データ層を呼ばない", async () => {
    const result = await createPaymentSourceAction(
      initialPaymentSourceActionState,
      formDataOf({ name: "", type: PaymentSourceType.CASH }),
    );
    expect(result).toEqual({ error: PAYMENT_SOURCE_VALIDATION_ERRORS.nameRequired });
    expect(createPaymentSource).not.toHaveBeenCalled();
  });

  it("タイプが不正なら検証エラーを返し、データ層を呼ばない", async () => {
    const result = await createPaymentSourceAction(
      initialPaymentSourceActionState,
      formDataOf({ name: "現金", type: "SUICA" }),
    );
    expect(result).toEqual({ error: PAYMENT_SOURCE_VALIDATION_ERRORS.typeRequired });
    expect(createPaymentSource).not.toHaveBeenCalled();
  });

  it("成功時は trim された名前でデータ層を呼び、一覧を revalidate して error: null を返す", async () => {
    createPaymentSource.mockResolvedValue({ ok: true, value: makePaymentSource() });

    const result = await createPaymentSourceAction(
      initialPaymentSourceActionState,
      formDataOf({ name: "  Aカード  ", type: PaymentSourceType.CREDIT_CARD }),
    );

    expect(createPaymentSource).toHaveBeenCalledWith(expect.anything(), USER_ID, {
      name: "Aカード",
      type: PaymentSourceType.CREDIT_CARD,
    });
    expect(revalidatePath).toHaveBeenCalledWith(PAYMENT_SOURCES_PATH);
    expect(result).toEqual({ error: null });
  });

  it("データ層が拒否した場合はそのメッセージを返し、revalidate しない", async () => {
    createPaymentSource.mockResolvedValue({
      ok: false,
      error: PAYMENT_SOURCE_ERRORS.duplicateName,
    });

    const result = await createPaymentSourceAction(
      initialPaymentSourceActionState,
      formDataOf({ name: "現金", type: PaymentSourceType.CASH }),
    );

    expect(result).toEqual({ error: PAYMENT_SOURCE_ERRORS.duplicateName });
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

describe("updatePaymentSourceAction", () => {
  it("id が無ければ検証エラーを返す", async () => {
    const result = await updatePaymentSourceAction(
      initialPaymentSourceActionState,
      formDataOf({ name: "現金", type: PaymentSourceType.CASH }),
    );
    expect(result).toEqual({ error: PAYMENT_SOURCE_VALIDATION_ERRORS.idRequired });
    expect(updatePaymentSource).not.toHaveBeenCalled();
  });

  it("成功時は一覧と編集ページの両方を revalidate する", async () => {
    updatePaymentSource.mockResolvedValue({ ok: true, value: makePaymentSource() });

    const result = await updatePaymentSourceAction(
      initialPaymentSourceActionState,
      formDataOf({ id: "ps_1", name: "A銀行", type: PaymentSourceType.BANK_DEBIT }),
    );

    expect(updatePaymentSource).toHaveBeenCalledWith(expect.anything(), USER_ID, {
      id: "ps_1",
      name: "A銀行",
      type: PaymentSourceType.BANK_DEBIT,
    });
    expect(revalidatePath).toHaveBeenCalledWith(PAYMENT_SOURCES_PATH);
    expect(revalidatePath).toHaveBeenCalledWith(paymentSourceDetailPath("ps_1"));
    expect(result).toEqual({ error: null });
  });

  it("データ層が拒否した場合はそのメッセージを返す", async () => {
    updatePaymentSource.mockResolvedValue({ ok: false, error: PAYMENT_SOURCE_ERRORS.notFound });

    const result = await updatePaymentSourceAction(
      initialPaymentSourceActionState,
      formDataOf({ id: "ps_1", name: "現金", type: PaymentSourceType.CASH }),
    );

    expect(result).toEqual({ error: PAYMENT_SOURCE_ERRORS.notFound });
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

describe("setDefaultPaymentSourceAction", () => {
  it("id が無ければ検証エラーを返す", async () => {
    const result = await setDefaultPaymentSourceAction(
      initialPaymentSourceActionState,
      formDataOf({}),
    );
    expect(result).toEqual({ error: PAYMENT_SOURCE_VALIDATION_ERRORS.idRequired });
    expect(setDefaultPaymentSource).not.toHaveBeenCalled();
  });

  it("成功時は一覧と編集ページを revalidate する", async () => {
    setDefaultPaymentSource.mockResolvedValue({
      ok: true,
      value: makePaymentSource({ isDefault: true }),
    });

    const result = await setDefaultPaymentSourceAction(
      initialPaymentSourceActionState,
      formDataOf({ id: "ps_1" }),
    );

    expect(setDefaultPaymentSource).toHaveBeenCalledWith(expect.anything(), USER_ID, "ps_1");
    expect(revalidatePath).toHaveBeenCalledWith(PAYMENT_SOURCES_PATH);
    expect(revalidatePath).toHaveBeenCalledWith(paymentSourceDetailPath("ps_1"));
    expect(result).toEqual({ error: null });
  });

  it("無効な払い出し先を既定にしようとした場合のメッセージを返す", async () => {
    setDefaultPaymentSource.mockResolvedValue({
      ok: false,
      error: PAYMENT_SOURCE_ERRORS.defaultMustBeActive,
    });

    const result = await setDefaultPaymentSourceAction(
      initialPaymentSourceActionState,
      formDataOf({ id: "ps_1" }),
    );

    expect(result).toEqual({ error: PAYMENT_SOURCE_ERRORS.defaultMustBeActive });
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

describe("setPaymentSourceActiveAction", () => {
  it("id が無ければ検証エラーを返す", async () => {
    const result = await setPaymentSourceActiveAction(
      initialPaymentSourceActionState,
      formDataOf({ isActive: "true" }),
    );
    expect(result).toEqual({ error: PAYMENT_SOURCE_VALIDATION_ERRORS.idRequired });
    expect(setPaymentSourceActive).not.toHaveBeenCalled();
  });

  it("isActive='true' のときだけ有効化として扱う", async () => {
    setPaymentSourceActive.mockResolvedValue({ ok: true, value: makePaymentSource() });

    await setPaymentSourceActiveAction(
      initialPaymentSourceActionState,
      formDataOf({ id: "ps_1", isActive: "true" }),
    );

    expect(setPaymentSourceActive).toHaveBeenCalledWith(expect.anything(), USER_ID, "ps_1", true);
  });

  it.each(["false", "", "TRUE", "1"])(
    "isActive='%s' は有効化ではなく無効化として扱う",
    async (value) => {
      setPaymentSourceActive.mockResolvedValue({ ok: true, value: makePaymentSource() });

      await setPaymentSourceActiveAction(
        initialPaymentSourceActionState,
        formDataOf({ id: "ps_1", isActive: value }),
      );

      expect(setPaymentSourceActive).toHaveBeenCalledWith(expect.anything(), USER_ID, "ps_1", false);
    },
  );

  it("isActive フィールドが無ければ無効化として扱う", async () => {
    setPaymentSourceActive.mockResolvedValue({ ok: true, value: makePaymentSource() });

    await setPaymentSourceActiveAction(initialPaymentSourceActionState, formDataOf({ id: "ps_1" }));

    expect(setPaymentSourceActive).toHaveBeenCalledWith(expect.anything(), USER_ID, "ps_1", false);
  });

  it("データ層が拒否した場合（有効が1件だけ等）はそのメッセージを返す", async () => {
    setPaymentSourceActive.mockResolvedValue({
      ok: false,
      error: PAYMENT_SOURCE_ERRORS.deactivateLastActive,
    });

    const result = await setPaymentSourceActiveAction(
      initialPaymentSourceActionState,
      formDataOf({ id: "ps_1", isActive: "false" }),
    );

    expect(result).toEqual({ error: PAYMENT_SOURCE_ERRORS.deactivateLastActive });
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

describe("movePaymentSourceAction", () => {
  it("id が無ければ検証エラーを返す", async () => {
    const result = await movePaymentSourceAction(
      initialPaymentSourceActionState,
      formDataOf({ direction: "up" }),
    );
    expect(result).toEqual({ error: PAYMENT_SOURCE_VALIDATION_ERRORS.idRequired });
    expect(movePaymentSource).not.toHaveBeenCalled();
  });

  it("direction が不正なら invalidDirection エラーを返し、データ層を呼ばない", async () => {
    const result = await movePaymentSourceAction(
      initialPaymentSourceActionState,
      formDataOf({ id: "ps_1", direction: "sideways" }),
    );
    expect(result).toEqual({ error: PAYMENT_SOURCE_ORDER_ERRORS.invalidDirection });
    expect(movePaymentSource).not.toHaveBeenCalled();
  });

  it("成功時は id と方向を渡し、一覧と編集ページを revalidate する", async () => {
    movePaymentSource.mockResolvedValue({ ok: true, value: [makePaymentSource()] });

    const result = await movePaymentSourceAction(
      initialPaymentSourceActionState,
      formDataOf({ id: "ps_1", direction: "down" }),
    );

    expect(movePaymentSource).toHaveBeenCalledWith(expect.anything(), USER_ID, "ps_1", "down");
    expect(revalidatePath).toHaveBeenCalledWith(PAYMENT_SOURCES_PATH);
    expect(revalidatePath).toHaveBeenCalledWith(paymentSourceDetailPath("ps_1"));
    expect(result).toEqual({ error: null });
  });

  it("グループの端で拒否された場合のメッセージを返す", async () => {
    movePaymentSource.mockResolvedValue({
      ok: false,
      error: PAYMENT_SOURCE_ORDER_ERRORS.cannotMoveDown,
    });

    const result = await movePaymentSourceAction(
      initialPaymentSourceActionState,
      formDataOf({ id: "ps_1", direction: "down" }),
    );

    expect(result).toEqual({ error: PAYMENT_SOURCE_ORDER_ERRORS.cannotMoveDown });
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

describe("deletePaymentSourceAction", () => {
  it("id が無ければ検証エラーを返し、redirect しない", async () => {
    const result = await deletePaymentSourceAction(initialPaymentSourceActionState, formDataOf({}));
    expect(result).toEqual({ error: PAYMENT_SOURCE_VALIDATION_ERRORS.idRequired });
    expect(deletePaymentSource).not.toHaveBeenCalled();
    expect(redirect).not.toHaveBeenCalled();
  });

  it("成功時は一覧を revalidate してから一覧ページへ redirect する", async () => {
    deletePaymentSource.mockResolvedValue({ ok: true, value: null });

    await expect(
      deletePaymentSourceAction(initialPaymentSourceActionState, formDataOf({ id: "ps_1" })),
    ).rejects.toThrow("NEXT_REDIRECT");

    expect(revalidatePath).toHaveBeenCalledWith(PAYMENT_SOURCES_PATH);
    expect(redirect).toHaveBeenCalledWith(PAYMENT_SOURCES_PATH);
  });

  it("失敗時（既定・支出あり・予算あり等）は redirect せずエラーメッセージを返す", async () => {
    deletePaymentSource.mockResolvedValue({
      ok: false,
      error: PAYMENT_SOURCE_ERRORS.deleteReferencedByExpense,
    });

    const result = await deletePaymentSourceAction(
      initialPaymentSourceActionState,
      formDataOf({ id: "ps_1" }),
    );

    expect(result).toEqual({ error: PAYMENT_SOURCE_ERRORS.deleteReferencedByExpense });
    expect(redirect).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it.each([
    PAYMENT_SOURCE_ERRORS.deleteDefault,
    PAYMENT_SOURCE_ERRORS.deleteReferencedByExpense,
    PAYMENT_SOURCE_ERRORS.deleteReferencedByBudget,
  ])("拒否理由 '%s' のいずれでも redirect しない", async (error) => {
    deletePaymentSource.mockResolvedValue({ ok: false, error });

    await deletePaymentSourceAction(initialPaymentSourceActionState, formDataOf({ id: "ps_1" }));

    expect(redirect).not.toHaveBeenCalled();
  });
});
