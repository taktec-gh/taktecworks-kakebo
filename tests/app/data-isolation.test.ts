// @vitest-environment node
//
// 公開版 Step 1「データ分離」の中心となるテスト（docs/steps/pub-1.md「分離テスト」）。
//
// 利用者A・Bを用意し、全 Server Action について、Aのセッション（＝ requireUserId() が
// 返した userId）から Bの支出・収入・予算・カテゴリ・払い出し先・パスキーを
// 閲覧・編集・削除できないことを検証する。
//
// **モックではなく、A・B 2人分のデータを持ち where を実際に解釈する偽の Prisma
// クライアント（tests/support/fake-prisma-client.ts）を使う。** 呼び出し引数の形だけを
// 見る toHaveBeenCalledWith 系のテスト（tests/lib/*.test.ts に既にある）では、
// 「where の userId を外したときに本当に他人の行が返る／書き変わる」ことまでは
// 確認できないため。データ層の関数自体は本物（モックしない）。
//
// 満たすべき性質（docs/steps/pub-1.md「tester 向けの方針 > 分離テスト」）:
// - 表の行が全 Server Action を網羅していることを、テスト自身が検査する
//   （src/app/**/actions.ts・passkey-actions.ts の export を静的に列挙して比較する）
// - 各行で、A のセッションから B のIDを指定したとき、B のデータが返らない・変わらないこと、
//   応答が存在しないIDを指定したときと同じであること
// - データ層の関数から userId の絞り込みを1箇所外したら落ちること
//   （偽クライアントが where を実際に解釈するので、外すと B の行が返ってしまい検出できる）
//
// 期待値の根拠:
// - docs/design-decisions.md「4. データ分離」「分離テスト」
// - docs/steps/pub-1.md 設計判断 6（データ層の規則）・11（他人のIDには notFound と同じ応答）
// - 各データ層ファイルの JSDoc（src/lib/expenses.ts・payment-sources.ts・categories.ts・
//   budgets.ts・incomes.ts・credentials.ts）に書かれた「全操作を userId で絞る」規則

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { CostType, PaymentSourceType, WasteTag } from "@/generated/prisma/enums";
import {
  BUDGET_ERRORS,
  deleteBudget,
  saveBudgets,
  saveCategoryBudgets,
} from "@/lib/budgets";
import {
  CATEGORY_ERRORS,
  createCategory,
  deleteCategory,
  getCategoryDetail,
  listCategories,
  moveCategory,
  setCategoryHidden,
  updateCategory,
} from "@/lib/categories";
import { CATEGORY_ORDER_ERRORS } from "@/lib/category-order";
import { createCredential, deleteCredential, listCredentials } from "@/lib/credentials";
import {
  createExpense,
  deleteExpense,
  EXPENSE_ERRORS,
  getExpense,
  updateExpense,
} from "@/lib/expenses";
import { createIncome, deleteIncome, listIncomes } from "@/lib/incomes";
import { PASSKEY_ERRORS } from "@/lib/passkey";
import {
  createPaymentSource,
  deletePaymentSource,
  getPaymentSourceDetail,
  listPaymentSources,
  movePaymentSource,
  PAYMENT_SOURCE_ERRORS,
  setDefaultPaymentSource,
  setPaymentSourceActive,
  updatePaymentSource,
} from "@/lib/payment-sources";
import { PAYMENT_SOURCE_ORDER_ERRORS } from "@/lib/payment-source-order";
import type { UserId } from "@/lib/user-id";

import { FakePrismaClient, matchWhere, type TableName } from "../support/fake-prisma-client";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

// ---------------------------------------------------------------------------
// 1. 表が全 Server Action を網羅していることの自己検査
// ---------------------------------------------------------------------------

/** src/app 以下を再帰的に走査し、actions.ts / passkey-actions.ts を集める */
function findActionFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...findActionFiles(full));
    } else if (entry.name === "actions.ts" || entry.name === "passkey-actions.ts") {
      found.push(full);
    }
  }
  return found;
}

/** ファイルからトップレベルの `export async function 名前` を抜き出す */
function extractExportedActionNames(filePath: string): string[] {
  const content = readFileSync(filePath, "utf8");
  return [...content.matchAll(/^export async function (\w+)/gm)].map((m) => m[1]);
}

const SRC_APP_DIR = join(REPO_ROOT, "src", "app");

describe("分離テストの表が全 Server Action を網羅している", () => {
  it("src/app/**/actions.ts・passkey-actions.ts の export と、この表の行が一致する", () => {
    const files = findActionFiles(SRC_APP_DIR);
    expect(files.length).toBeGreaterThan(0); // 走査自体が空振りしていないことの確認

    const actualActionNames = new Set(files.flatMap(extractExportedActionNames));
    const tableActionNames = new Set(ISOLATION_TABLE.map((row) => row.action));

    const missingFromTable = [...actualActionNames].filter((name) => !tableActionNames.has(name));
    const staleInTable = [...tableActionNames].filter((name) => !actualActionNames.has(name));

    expect(
      missingFromTable,
      `分離テストの表に無い Server Action があります（追加漏れ）: ${missingFromTable.join(", ")}`,
    ).toEqual([]);
    expect(
      staleInTable,
      `分離テストの表に、もう存在しない Server Action の行が残っています: ${staleInTable.join(", ")}`,
    ).toEqual([]);

    // 重複行が無いことも確認する（同じ行を2回数えて網羅したふりをしないため）
    expect(ISOLATION_TABLE.length).toBe(tableActionNames.size);
  });
});

// ---------------------------------------------------------------------------
// 2. 偽 Prisma クライアントの自己検査
//    （「未対応の条件を黙って無視しない」ことを、このテストファイル自身が確かめる）
// ---------------------------------------------------------------------------

describe("偽 Prisma クライアント（tests/support/fake-prisma-client.ts）の自己検査", () => {
  it("対応していない演算子は例外を投げる（黙って無視しない）", () => {
    expect(() => matchWhere({ amountYen: 100 }, { amountYen: { startsWith: "1" } })).toThrow();
  });

  it("where に配列を渡すと例外を投げる", () => {
    expect(() => matchWhere({ id: "a" }, { id: ["a", "b"] } as never)).toThrow();
  });

  it("in / not / gte・lt は正しく解釈する", () => {
    expect(matchWhere({ id: "a" }, { id: { in: ["a", "b"] } })).toBe(true);
    expect(matchWhere({ id: "c" }, { id: { in: ["a", "b"] } })).toBe(false);
    expect(matchWhere({ storeName: "x" }, { storeName: { not: null } })).toBe(true);
    expect(matchWhere({ storeName: null }, { storeName: { not: null } })).toBe(false);
    const row = { date: new Date("2026-08-15T00:00:00.000Z") };
    expect(
      matchWhere(row, {
        date: { gte: new Date("2026-08-01T00:00:00.000Z"), lt: new Date("2026-09-01T00:00:00.000Z") },
      }),
    ).toBe(true);
    expect(
      matchWhere(row, {
        date: { gte: new Date("2026-09-01T00:00:00.000Z"), lt: new Date("2026-10-01T00:00:00.000Z") },
      }),
    ).toBe(false);
  });

  it("複合ユニークキーのグルーピング（例: paymentSourceId_yearMonth）を1階層だけ展開して照合する", () => {
    const row = { paymentSourceId: "ps_1", yearMonth: "2026-08", userId: "user_a" };
    expect(
      matchWhere(row, {
        paymentSourceId_yearMonth: { paymentSourceId: "ps_1", yearMonth: "2026-08" },
        userId: "user_a",
      }),
    ).toBe(true);
    expect(
      matchWhere(row, {
        paymentSourceId_yearMonth: { paymentSourceId: "ps_1", yearMonth: "2026-08" },
        userId: "user_b",
      }),
    ).toBe(false);
  });

  it("userId を外した where は、他人の行にも一致してしまう（この性質を分離テストが使う）", () => {
    const row = { id: "ps_shared_looking_id", userId: "user_b" };
    // { id, userId: A } なら一致しないが、userId を落とすと一致してしまう、という
    // ちょうど「絞り込みを外したときに何が起きるか」を確かめるテスト
    expect(matchWhere(row, { id: "ps_shared_looking_id", userId: "user_a" })).toBe(false);
    expect(matchWhere(row, { id: "ps_shared_looking_id" })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. フィクスチャ（利用者A・B、それぞれ一式のデータ）
// ---------------------------------------------------------------------------

const USER_A = "user_a" as UserId;
const USER_B = "user_b" as UserId;

const YEAR_MONTH = "2026-08";

function buildFixture() {
  const now = new Date("2026-08-01T00:00:00.000Z");

  const paymentSource = [
    {
      id: "ps_a_1",
      userId: USER_A,
      name: "現金A",
      type: PaymentSourceType.CASH,
      sortOrder: 1,
      isActive: true,
      isDefault: true,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "ps_a_2",
      userId: USER_A,
      name: "AカードA",
      type: PaymentSourceType.CREDIT_CARD,
      sortOrder: 2,
      isActive: true,
      isDefault: false,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "ps_b_1",
      userId: USER_B,
      name: "現金B",
      type: PaymentSourceType.CASH,
      sortOrder: 1,
      isActive: true,
      isDefault: true,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "ps_b_2",
      userId: USER_B,
      name: "AカードB",
      type: PaymentSourceType.CREDIT_CARD,
      sortOrder: 2,
      isActive: true,
      isDefault: false,
      createdAt: now,
      updatedAt: now,
    },
  ];

  const category = [
    {
      id: "cat_a_1",
      userId: USER_A,
      name: "食費A",
      costType: CostType.VARIABLE,
      sortOrder: 1,
      isHidden: false,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "cat_a_2",
      userId: USER_A,
      name: "日用品A",
      costType: CostType.VARIABLE,
      sortOrder: 2,
      isHidden: false,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "cat_b_1",
      userId: USER_B,
      name: "食費B",
      costType: CostType.VARIABLE,
      sortOrder: 1,
      isHidden: false,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "cat_b_2",
      userId: USER_B,
      name: "日用品B",
      costType: CostType.VARIABLE,
      sortOrder: 2,
      isHidden: false,
      createdAt: now,
      updatedAt: now,
    },
  ];

  const expense = [
    {
      id: "exp_a_1",
      userId: USER_A,
      date: new Date("2026-08-05T00:00:00.000Z"),
      amountYen: 1000,
      categoryId: "cat_a_1",
      paymentSourceId: "ps_a_1",
      storeName: "スーパーA",
      memo: null,
      wasteTag: WasteTag.NECESSARY,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "exp_b_1",
      userId: USER_B,
      date: new Date("2026-08-05T00:00:00.000Z"),
      amountYen: 2000,
      categoryId: "cat_b_1",
      paymentSourceId: "ps_b_1",
      storeName: "スーパーB",
      memo: null,
      wasteTag: WasteTag.NECESSARY,
      createdAt: now,
      updatedAt: now,
    },
  ];

  const budget = [
    {
      id: "budget_a_1",
      userId: USER_A,
      paymentSourceId: "ps_a_1",
      yearMonth: YEAR_MONTH,
      amountYen: 30_000,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "budget_b_1",
      userId: USER_B,
      paymentSourceId: "ps_b_1",
      yearMonth: YEAR_MONTH,
      amountYen: 40_000,
      createdAt: now,
      updatedAt: now,
    },
  ];

  const categoryBudget = [
    {
      id: "cb_a_1",
      userId: USER_A,
      categoryId: "cat_a_1",
      yearMonth: YEAR_MONTH,
      amountYen: 5_000,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "cb_b_1",
      userId: USER_B,
      categoryId: "cat_b_1",
      yearMonth: YEAR_MONTH,
      amountYen: 6_000,
      createdAt: now,
      updatedAt: now,
    },
  ];

  const income = [
    {
      id: "income_a_1",
      userId: USER_A,
      yearMonth: YEAR_MONTH,
      amountYen: 300_000,
      label: "給与A",
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "income_b_1",
      userId: USER_B,
      yearMonth: YEAR_MONTH,
      amountYen: 400_000,
      label: "給与B",
      createdAt: now,
      updatedAt: now,
    },
  ];

  const credential = [
    {
      id: "cred_a_1",
      userId: USER_A,
      credentialId: "cred-a-1",
      publicKey: new Uint8Array([1]),
      counter: BigInt(0),
      transports: ["internal"],
      deviceName: "iPhoneA1",
      createdAt: now,
      updatedAt: now,
      lastUsedAt: null,
    },
    {
      id: "cred_a_2",
      userId: USER_A,
      credentialId: "cred-a-2",
      publicKey: new Uint8Array([2]),
      counter: BigInt(0),
      transports: ["internal"],
      deviceName: "iPhoneA2",
      createdAt: now,
      updatedAt: now,
      lastUsedAt: null,
    },
    {
      id: "cred_b_1",
      userId: USER_B,
      credentialId: "cred-b-1",
      publicKey: new Uint8Array([3]),
      counter: BigInt(0),
      transports: ["internal"],
      deviceName: "iPhoneB1",
      createdAt: now,
      updatedAt: now,
      lastUsedAt: null,
    },
    {
      id: "cred_b_2",
      userId: USER_B,
      credentialId: "cred-b-2",
      publicKey: new Uint8Array([4]),
      counter: BigInt(0),
      transports: ["internal"],
      deviceName: "iPhoneB2",
      createdAt: now,
      updatedAt: now,
      lastUsedAt: null,
    },
  ];

  const seed: Partial<Record<TableName, Record<string, unknown>[]>> = {
    paymentSource,
    category,
    expense,
    budget,
    categoryBudget,
    income,
    credential,
  };

  // eslint 的な any を避けるため、データ層が期待する PrismaClient 形へ最終的にキャストする
  const client = new FakePrismaClient(seed);

  return { client };
}

type Fixture = ReturnType<typeof buildFixture>;

/** データ層の関数へ渡す PrismaClient 型へのキャスト（既存の *.test.ts と同じ流儀） */
function asPrismaClient(client: FakePrismaClient) {
  return client as unknown as Parameters<typeof listPaymentSources>[0];
}

// ---------------------------------------------------------------------------
// 4. 分離テストの表
// ---------------------------------------------------------------------------

type IsolationCase = {
  /** Server Action の関数名（src/app/**\/actions.ts の export と一致させる） */
  action: string;
  file: string;
  /** レポート用: 対象データ */
  target: string;
  /** レポート用: 操作 */
  operation: string;
  /** このケースが検証すること */
  scenario: string;
  run: (fx: Fixture) => Promise<void>;
};

const ISOLATION_TABLE: IsolationCase[] = [
  // --- 払い出し先 -----------------------------------------------------
  {
    action: "createPaymentSourceAction",
    file: "src/app/settings/payment-sources/actions.ts",
    target: "PaymentSource",
    operation: "作成",
    scenario: "作成した行の userId は引数（A）になり、Bの一覧には現れない",
    run: async ({ client }) => {
      const result = await createPaymentSource(asPrismaClient(client), USER_A, {
        name: "新しい払い出し先",
        type: PaymentSourceType.CASH,
      });
      expect(result.ok).toBe(true);

      const forA = await listPaymentSources(asPrismaClient(client), USER_A);
      const forB = await listPaymentSources(asPrismaClient(client), USER_B);
      expect(forA.some((p) => p.name === "新しい払い出し先")).toBe(true);
      expect(forB.some((p) => p.name === "新しい払い出し先")).toBe(false);
    },
  },
  {
    action: "updatePaymentSourceAction",
    file: "src/app/settings/payment-sources/actions.ts",
    target: "PaymentSource",
    operation: "更新",
    scenario: "AがBの払い出し先IDを更新しようとすると notFound。Bの行は変わらない",
    run: async ({ client }) => {
      const result = await updatePaymentSource(asPrismaClient(client), USER_A, {
        id: "ps_b_1",
        name: "乗っ取り",
        type: PaymentSourceType.BANK_DEBIT,
      });
      expect(result).toEqual({ ok: false, error: PAYMENT_SOURCE_ERRORS.notFound });

      const bRow = client.snapshot("paymentSource").find((r) => r.id === "ps_b_1");
      expect(bRow?.name).toBe("現金B");
      expect(bRow?.type).toBe(PaymentSourceType.CASH);
    },
  },
  {
    action: "setDefaultPaymentSourceAction",
    file: "src/app/settings/payment-sources/actions.ts",
    target: "PaymentSource",
    operation: "既定にする",
    scenario:
      "AがBの払い出し先IDを既定にしようとすると notFound。さらに、Aが自分の別の払い出し先を" +
      "既定にしても、Bの既定は外れない（変異#3: updateMany の userId を外すと落ちる）",
    run: async ({ client }) => {
      const blocked = await setDefaultPaymentSource(asPrismaClient(client), USER_A, "ps_b_1");
      expect(blocked).toEqual({ ok: false, error: PAYMENT_SOURCE_ERRORS.notFound });

      const result = await setDefaultPaymentSource(asPrismaClient(client), USER_A, "ps_a_2");
      expect(result.ok).toBe(true);

      const aOld = client.snapshot("paymentSource").find((r) => r.id === "ps_a_1");
      const aNew = client.snapshot("paymentSource").find((r) => r.id === "ps_a_2");
      const bDefault = client.snapshot("paymentSource").find((r) => r.id === "ps_b_1");
      expect(aOld?.isDefault).toBe(false);
      expect(aNew?.isDefault).toBe(true);
      expect(bDefault?.isDefault).toBe(true); // Bの既定は影響を受けない
    },
  },
  {
    action: "setPaymentSourceActiveAction",
    file: "src/app/settings/payment-sources/actions.ts",
    target: "PaymentSource",
    operation: "有効/無効の切り替え",
    scenario: "AがBの払い出し先IDを無効化しようとすると notFound。Bの行は変わらない",
    run: async ({ client }) => {
      const result = await setPaymentSourceActive(asPrismaClient(client), USER_A, "ps_b_2", false);
      expect(result).toEqual({ ok: false, error: PAYMENT_SOURCE_ERRORS.notFound });

      const bRow = client.snapshot("paymentSource").find((r) => r.id === "ps_b_2");
      expect(bRow?.isActive).toBe(true);
    },
  },
  {
    action: "movePaymentSourceAction",
    file: "src/app/settings/payment-sources/actions.ts",
    target: "PaymentSource",
    operation: "並べ替え",
    scenario:
      "AがBの払い出し先IDを並べ替えようとすると notFound（＝存在しないIDと同じ応答）。" +
      "さらにAが自分の払い出し先を並べ替えても、Bの並び順（sortOrder）は変わらない（変異#12）",
    run: async ({ client }) => {
      const blocked = await movePaymentSource(asPrismaClient(client), USER_A, "ps_b_1", "down");
      expect(blocked).toEqual({ ok: false, error: PAYMENT_SOURCE_ORDER_ERRORS.notFound });
      expect(blocked).toEqual({ ok: false, error: PAYMENT_SOURCE_ERRORS.notFound }); // 文言はnotFoundと同一

      const beforeB = client.snapshot("paymentSource").filter((r) => r.userId === USER_B);

      const result = await movePaymentSource(asPrismaClient(client), USER_A, "ps_a_1", "down");
      expect(result.ok).toBe(true);

      const afterB = client.snapshot("paymentSource").filter((r) => r.userId === USER_B);
      expect(afterB).toEqual(beforeB); // Bの行のsortOrderは一切変化しない
    },
  },
  {
    action: "deletePaymentSourceAction",
    file: "src/app/settings/payment-sources/actions.ts",
    target: "PaymentSource",
    operation: "削除",
    scenario: "AがBの払い出し先IDを削除しようとすると notFound。Bの行は残る",
    run: async ({ client }) => {
      const result = await deletePaymentSource(asPrismaClient(client), USER_A, "ps_b_2");
      expect(result).toEqual({ ok: false, error: PAYMENT_SOURCE_ERRORS.notFound });

      expect(client.snapshot("paymentSource").some((r) => r.id === "ps_b_2")).toBe(true);
    },
  },

  // --- カテゴリ ---------------------------------------------------------
  {
    action: "createCategoryAction",
    file: "src/app/settings/categories/actions.ts",
    target: "Category",
    operation: "作成",
    scenario: "作成した行の userId は引数（A）になり、Bの一覧には現れない",
    run: async ({ client }) => {
      const result = await createCategory(asPrismaClient(client), USER_A, {
        name: "新しいカテゴリ",
        costType: CostType.VARIABLE,
      });
      expect(result.ok).toBe(true);

      const forA = await listCategories(asPrismaClient(client), USER_A);
      const forB = await listCategories(asPrismaClient(client), USER_B);
      expect(forA.some((c) => c.name === "新しいカテゴリ")).toBe(true);
      expect(forB.some((c) => c.name === "新しいカテゴリ")).toBe(false);
    },
  },
  {
    action: "updateCategoryAction",
    file: "src/app/settings/categories/actions.ts",
    target: "Category",
    operation: "更新",
    scenario: "AがBのカテゴリIDを更新しようとすると notFound。Bの行は変わらない",
    run: async ({ client }) => {
      const result = await updateCategory(asPrismaClient(client), USER_A, {
        id: "cat_b_1",
        name: "乗っ取り",
        costType: CostType.FIXED,
      });
      expect(result).toEqual({ ok: false, error: CATEGORY_ERRORS.notFound });

      const bRow = client.snapshot("category").find((r) => r.id === "cat_b_1");
      expect(bRow?.name).toBe("食費B");
      expect(bRow?.costType).toBe(CostType.VARIABLE);
    },
  },
  {
    action: "setCategoryHiddenAction",
    file: "src/app/settings/categories/actions.ts",
    target: "Category",
    operation: "非表示/再表示の切り替え",
    scenario: "AがBのカテゴリIDを非表示にしようとすると notFound。Bの行は変わらない",
    run: async ({ client }) => {
      const result = await setCategoryHidden(asPrismaClient(client), USER_A, "cat_b_1", true);
      expect(result).toEqual({ ok: false, error: CATEGORY_ERRORS.notFound });

      const bRow = client.snapshot("category").find((r) => r.id === "cat_b_1");
      expect(bRow?.isHidden).toBe(false);
    },
  },
  {
    action: "moveCategoryAction",
    file: "src/app/settings/categories/actions.ts",
    target: "Category",
    operation: "並べ替え",
    scenario:
      "AがBのカテゴリIDを並べ替えようとすると notFound（存在しないIDと同じ応答）。" +
      "Aが自分のカテゴリを並べ替えても、Bのsort順は変わらない",
    run: async ({ client }) => {
      const blocked = await moveCategory(asPrismaClient(client), USER_A, "cat_b_1", "down");
      expect(blocked).toEqual({ ok: false, error: CATEGORY_ORDER_ERRORS.notFound });
      expect(blocked).toEqual({ ok: false, error: CATEGORY_ERRORS.notFound });

      const beforeB = client.snapshot("category").filter((r) => r.userId === USER_B);
      const result = await moveCategory(asPrismaClient(client), USER_A, "cat_a_1", "down");
      expect(result.ok).toBe(true);
      const afterB = client.snapshot("category").filter((r) => r.userId === USER_B);
      expect(afterB).toEqual(beforeB);
    },
  },
  {
    action: "deleteCategoryAction",
    file: "src/app/settings/categories/actions.ts",
    target: "Category",
    operation: "削除",
    scenario: "AがBのカテゴリIDを削除しようとすると notFound。Bの行は残る",
    run: async ({ client }) => {
      const result = await deleteCategory(asPrismaClient(client), USER_A, "cat_b_2");
      expect(result).toEqual({ ok: false, error: CATEGORY_ERRORS.notFound });
      expect(client.snapshot("category").some((r) => r.id === "cat_b_2")).toBe(true);
    },
  },

  // --- 支出 ---------------------------------------------------------
  {
    action: "createExpenseAction",
    file: "src/app/expenses/actions.ts",
    target: "Expense",
    operation: "作成（他人のカテゴリ/払い出し先を指定）",
    scenario:
      "Bのcategory/paymentSourceを指定して作成しようとすると、それぞれ" +
      "categoryNotFound/paymentSourceNotFoundになり、支出は作られない（変異#7）",
    run: async ({ client }) => {
      const before = client.snapshot("expense").length;

      const withBCategory = await createExpense(asPrismaClient(client), USER_A, {
        date: "2026-08-10",
        amountYen: 500,
        categoryId: "cat_b_1",
        paymentSourceId: "ps_a_1",
        wasteTag: WasteTag.NECESSARY,
        storeName: null,
        memo: null,
      });
      expect(withBCategory).toEqual({ ok: false, error: EXPENSE_ERRORS.categoryNotFound });

      const withBPaymentSource = await createExpense(asPrismaClient(client), USER_A, {
        date: "2026-08-10",
        amountYen: 500,
        categoryId: "cat_a_1",
        paymentSourceId: "ps_b_1",
        wasteTag: WasteTag.NECESSARY,
        storeName: null,
        memo: null,
      });
      expect(withBPaymentSource).toEqual({ ok: false, error: EXPENSE_ERRORS.paymentSourceNotFound });

      expect(client.snapshot("expense").length).toBe(before);
    },
  },
  {
    action: "updateExpenseAction",
    file: "src/app/expenses/actions.ts",
    target: "Expense",
    operation: "更新",
    scenario:
      "AがBの支出IDを（Aの正しいカテゴリ/払い出し先で）更新しようとすると notFound。" +
      "Bの支出は変わらない（変異#2）",
    run: async ({ client }) => {
      const result = await updateExpense(asPrismaClient(client), USER_A, "exp_b_1", {
        date: "2026-08-11",
        amountYen: 999,
        categoryId: "cat_a_1",
        paymentSourceId: "ps_a_1",
        wasteTag: WasteTag.WASTE,
        storeName: "乗っ取り",
        memo: null,
      });
      expect(result).toEqual({ ok: false, error: EXPENSE_ERRORS.notFound });

      const bRow = client.snapshot("expense").find((r) => r.id === "exp_b_1");
      expect(bRow?.amountYen).toBe(2000);
      expect(bRow?.storeName).toBe("スーパーB");
    },
  },
  {
    action: "deleteExpenseAction",
    file: "src/app/expenses/actions.ts",
    target: "Expense",
    operation: "削除",
    scenario: "AがBの支出IDを削除しようとすると notFound。Bの支出は残る（変異#1）",
    run: async ({ client }) => {
      const result = await deleteExpense(asPrismaClient(client), USER_A, "exp_b_1");
      expect(result).toEqual({ ok: false, error: EXPENSE_ERRORS.notFound });
      expect(client.snapshot("expense").some((r) => r.id === "exp_b_1")).toBe(true);
    },
  },

  // --- 予算 ---------------------------------------------------------
  {
    action: "saveBudgetsAction",
    file: "src/app/budgets/actions.ts",
    target: "Budget",
    operation: "一括保存",
    scenario:
      "Bの払い出し先IDを含めて保存しようとすると何も保存せずpaymentSourceNotFound。" +
      "Bの予算額は変わらない（変異#6）",
    run: async ({ client }) => {
      const rejected = await saveBudgets(asPrismaClient(client), USER_A, YEAR_MONTH, [
        { paymentSourceId: "ps_b_1", amountYen: 99_999 },
      ]);
      expect(rejected).toEqual({ ok: false, error: BUDGET_ERRORS.paymentSourceNotFound });

      const bRow = client.snapshot("budget").find((r) => r.id === "budget_b_1");
      expect(bRow?.amountYen).toBe(40_000);

      // 自分の払い出し先の保存は成功し、Bの予算には影響しない
      const accepted = await saveBudgets(asPrismaClient(client), USER_A, YEAR_MONTH, [
        { paymentSourceId: "ps_a_1", amountYen: 12_345 },
      ]);
      expect(accepted).toEqual({ ok: true, value: null });
      const bRowAfter = client.snapshot("budget").find((r) => r.id === "budget_b_1");
      expect(bRowAfter?.amountYen).toBe(40_000);
    },
  },
  {
    action: "saveCategoryBudgetsAction",
    file: "src/app/budgets/actions.ts",
    target: "CategoryBudget",
    operation: "一括保存",
    scenario: "Bのカテゴリを含めて保存しようとすると何も保存せずcategoryNotFound。Bの予算額は変わらない",
    run: async ({ client }) => {
      const rejected = await saveCategoryBudgets(asPrismaClient(client), USER_A, YEAR_MONTH, [
        { categoryId: "cat_b_1", amountYen: 1 },
      ]);
      expect(rejected).toEqual({ ok: false, error: BUDGET_ERRORS.categoryNotFound });

      const bRow = client.snapshot("categoryBudget").find((r) => r.id === "cb_b_1");
      expect(bRow?.amountYen).toBe(6_000);
    },
  },
  {
    action: "deleteBudgetAction",
    file: "src/app/budgets/actions.ts",
    target: "Budget",
    operation: "1件削除",
    scenario:
      "Bの払い出し先IDを指定して削除しても、仕様どおり成功は返す（二重送信対策）が" +
      "何も消えない。Bの予算は残る",
    run: async ({ client }) => {
      const result = await deleteBudget(asPrismaClient(client), USER_A, "ps_b_1", YEAR_MONTH);
      expect(result).toEqual({ ok: true, value: null });

      expect(client.snapshot("budget").some((r) => r.id === "budget_b_1")).toBe(true);
    },
  },

  // --- 収入 ---------------------------------------------------------
  {
    action: "createIncomeAction",
    file: "src/app/incomes/actions.ts",
    target: "Income",
    operation: "作成",
    scenario: "作成した行の userId は引数（A）になり、Bの一覧には現れない",
    run: async ({ client }) => {
      const result = await createIncome(asPrismaClient(client), USER_A, {
        yearMonth: YEAR_MONTH,
        amountYen: 1,
        label: null,
      });
      expect(result.ok).toBe(true);

      const forA = await listIncomes(asPrismaClient(client), USER_A, YEAR_MONTH);
      const forB = await listIncomes(asPrismaClient(client), USER_B, YEAR_MONTH);
      expect(forA.some((i) => i.amountYen === 1)).toBe(true);
      expect(forB.some((i) => i.amountYen === 1)).toBe(false);
    },
  },
  {
    action: "deleteIncomeAction",
    file: "src/app/incomes/actions.ts",
    target: "Income",
    operation: "削除",
    scenario: "AがBの収入IDを削除しようとすると notFound。Bの収入は残る",
    run: async ({ client }) => {
      const result = await deleteIncome(asPrismaClient(client), USER_A, "income_b_1");
      expect(result).toEqual({ ok: false, error: "対象の収入が見つかりません。" });
      expect(client.snapshot("income").some((r) => r.id === "income_b_1")).toBe(true);
    },
  },

  // --- パスキー -------------------------------------------------------
  {
    action: "startPasskeyRegistrationAction",
    file: "src/app/settings/passkeys/actions.ts",
    target: "Credential",
    operation: "一覧（excludeCredentialsの元データ）",
    scenario: "listCredentials(client, A) はAの2本だけを返し、Bの資格情報IDを含まない",
    run: async ({ client }) => {
      const forA = await listCredentials(asPrismaClient(client), USER_A);
      expect(forA.map((c) => c.credentialId).sort()).toEqual(["cred-a-1", "cred-a-2"]);
    },
  },
  {
    action: "finishPasskeyRegistrationAction",
    file: "src/app/settings/passkeys/actions.ts",
    target: "Credential",
    operation: "作成",
    scenario: "作成した資格情報の userId は引数（A）になり、Bの一覧には現れない",
    run: async ({ client }) => {
      const result = await createCredential(asPrismaClient(client), USER_A, {
        credentialId: "cred-a-new",
        publicKey: new Uint8Array([9]),
        counter: 0,
        transports: ["internal"],
        deviceName: "新しい端末",
      });
      expect(result.ok).toBe(true);

      const forA = await listCredentials(asPrismaClient(client), USER_A);
      const forB = await listCredentials(asPrismaClient(client), USER_B);
      expect(forA.some((c) => c.credentialId === "cred-a-new")).toBe(true);
      expect(forB.some((c) => c.credentialId === "cred-a-new")).toBe(false);
    },
  },
  {
    action: "deletePasskeyAction",
    file: "src/app/settings/passkeys/actions.ts",
    target: "Credential",
    operation: "削除",
    scenario:
      "AがBのパスキーIDを削除しようとすると notFound。Bのパスキーは残る（変異#8）",
    run: async ({ client }) => {
      const result = await deleteCredential(asPrismaClient(client), USER_A, "cred_b_1");
      expect(result).toEqual({ ok: false, error: PASSKEY_ERRORS.notFound });
      expect(client.snapshot("credential").some((r) => r.id === "cred_b_1")).toBe(true);
    },
  },

  // --- 認証前・データ操作を伴わないもの --------------------------------
  //
  // 以下の3つは「Aのセッションで…」という枠組みが構造的に当てはまらない
  // （ログイン前で誰のセッションも無い／セッションだけを扱いデータには触れない）。
  // 別ファイルの既存テストで検証済みのため、ここでは重複させず、
  // その検証が実在すること自体を確認する（it.skip にはしない）。
  {
    action: "logoutAction",
    file: "src/app/(auth)/login/actions.ts",
    target: "（セッションのみ。家計データには触れない）",
    operation: "ログアウト",
    scenario:
      "対象データが無いため分離の懸念自体が無い。" +
      "tests/app/(auth)/login/actions.test.ts で検証済みであることを確認する",
    run: async () => {
      const content = readFileSync(
        join(REPO_ROOT, "tests", "app", "(auth)", "login", "actions.test.ts"),
        "utf8",
      );
      expect(content).toContain("セッションを破棄して /login へリダイレクトする");
    },
  },
  {
    action: "startPasskeyLoginAction",
    file: "src/app/(auth)/login/passkey-actions.ts",
    target: "（未ログイン。誰のセッションも無い）",
    operation: "認証オプションの発行",
    scenario:
      "allowCredentials を渡さない（渡すと登録済み資格情報IDが晒れる）ことが" +
      "既存テストで検証済みであることを確認する",
    run: async () => {
      const content = readFileSync(
        join(REPO_ROOT, "tests", "app", "(auth)", "login", "passkey-actions.test.ts"),
        "utf8",
      );
      expect(content).toContain(
        "認証時に allowCredentials/excludeCredentials を渡さない（情報を晒さない）",
      );
    },
  },
  {
    action: "verifyPasskeyLoginAction",
    file: "src/app/(auth)/login/passkey-actions.ts",
    target: "（未ログイン。検証成功後にCredential.userIdの持ち主としてセッション発行）",
    operation: "ログイン検証",
    scenario:
      "セッションは検証した資格情報の持ち主に対して発行され、利用者IDをリクエストから" +
      "受け取らないことが既存テストで検証済みであることを確認する",
    run: async () => {
      const content = readFileSync(
        join(REPO_ROOT, "tests", "app", "(auth)", "login", "passkey-actions.test.ts"),
        "utf8",
      );
      expect(content).toContain(
        "セッションは、検証した資格情報の持ち主（Credential.userId）に対して発行する。利用者IDはリクエストから受け取らない",
      );
    },
  },
  // サインアップ（docs/steps/pub-2.md）はログイン前の操作で、まだ誰のセッションも無いため
  // 「Aのセッションで…」という分離の枠組み自体が当てはまらない。ログインの2行と同じ形で、
  // 「他人のデータに触れない」ことに相当する性質（webauthnUserId の出どころ・今作った
  // ユーザーにだけセッションが発行されること）が既存テストで検証済みであることを確認する
  // （docs/steps/pub-2.md「tester 向けの方針」11）。
  {
    action: "startSignupAction",
    file: "src/app/(auth)/signup/actions.ts",
    target: "（未ログイン。誰のセッションも無い。DBには何も書かない）",
    operation: "登録用オプションの発行",
    scenario:
      "DB には何も書かず、呼ぶたびに新しい webauthnUserId を Cookie に載せる" +
      "（既存アカウントに紐付かない・他人の値を使わない）ことが既存テストで検証済みであることを確認する",
    run: async () => {
      const content = readFileSync(
        join(REPO_ROOT, "tests", "app", "(auth)", "signup", "actions.test.ts"),
        "utf8",
      );
      expect(content).toContain(
        "成功時はオプションを返し、チャレンジと webauthnUserId を Cookie に載せる。DB は書かない",
      );
      expect(content).toContain("呼ぶたびに違う webauthnUserId になる");
    },
  },
  {
    action: "finishSignupAction",
    file: "src/app/(auth)/signup/actions.ts",
    target: "（未ログイン。署名付き Cookie の webauthnUserId で今作ったユーザーにセッション発行）",
    operation: "登録応答の検証とユーザー作成",
    scenario:
      "作るユーザーの webauthnUserId は署名付き Cookie の値であり応答・フォームの値ではないこと、" +
      "セッションは今作ったユーザーに対してのみ発行されることが既存テストで検証済みであることを確認する",
    run: async () => {
      const content = readFileSync(
        join(REPO_ROOT, "tests", "app", "(auth)", "signup", "actions.test.ts"),
        "utf8",
      );
      expect(content).toContain(
        "createUserWithPasskey には Cookie から取り出した webauthnUserId を渡す（応答・フォームの値ではない）",
      );
      expect(content).toContain(
        "応答に webauthnUserId らしき余分なフィールドが付いていても無視する（Cookie の値だけを使う）",
      );
      expect(content).toContain(
        "成功したら、今作ったユーザー（createUserWithPasskey の戻り値の userId）に対してセッションを発行する",
      );
    },
  },
  // デモ（docs/steps/pub-3.md）もログイン前の操作で、サインアップと同じく「Aのセッションで…」
  // という分離の枠組み自体が当てはまらない。絶対条件（design-decisions.md 決定事項2）は
  // 「デモ用の入口は、デモ用に作ったユーザー以外のセッションを発行できないように作る」こと。
  // FormData にユーザーIDらしき値を入れても使わないこと・セッションは createDemoUser の
  // 戻り値のユーザーにだけ発行されることが既存テストで検証済みであることを確認する
  // （docs/steps/pub-3.md「tester 向けの方針」3・13）。
  {
    action: "startDemoAction",
    file: "src/app/(auth)/login/actions.ts",
    target: "（未ログイン。DB には createDemoUser が今作ったデモユーザー以外何も触らない）",
    operation: "デモアカウントの作成とセッション発行",
    scenario:
      "FormData にユーザーIDらしき値を入れて呼んでも無視され、セッションは createDemoUser の" +
      "戻り値のユーザーにだけ発行されることが既存テストで検証済みであることを確認する",
    run: async () => {
      const content = readFileSync(
        join(REPO_ROOT, "tests", "app", "(auth)", "login", "actions.test.ts"),
        "utf8",
      );
      expect(content).toContain(
        "FormData を伴って呼ばれても（useActionState 経由を模して）無視され、createDemoUser の戻り値のユーザーにだけセッションを発行する",
      );
      expect(content).toContain("セッションは createDemoUser の戻り値の userId にだけ発行される");
    },
  },
];

// ---------------------------------------------------------------------------
// 5. 表の実行
// ---------------------------------------------------------------------------

describe("Server Action ごとの分離テスト（表）", () => {
  for (const testCase of ISOLATION_TABLE) {
    it(`${testCase.action} — ${testCase.target} / ${testCase.operation}: ${testCase.scenario}`, async () => {
      const fixture = buildFixture();
      await testCase.run(fixture);
    });
  }
});

// ---------------------------------------------------------------------------
// 6. 編集ページ（[id]）が使うデータ取得の分離
//    （その他の観点2。ページのnotFoundは各 [id] page.test.tsx で検証する。
//    ここではその根拠となるデータ層の戻り値が null になることを直接確認する）
// ---------------------------------------------------------------------------

describe("[id] 編集ページのデータ取得（他人のIDは null）", () => {
  it("getExpense: Bの支出IDをAで取得すると null", async () => {
    const { client } = buildFixture();
    expect(await getExpense(asPrismaClient(client), USER_A, "exp_b_1")).toBeNull();
  });

  it("getCategoryDetail: BのカテゴリIDをAで取得すると null", async () => {
    const { client } = buildFixture();
    expect(await getCategoryDetail(asPrismaClient(client), USER_A, "cat_b_1")).toBeNull();
  });

  it("getPaymentSourceDetail: Bの払い出し先IDをAで取得すると null", async () => {
    const { client } = buildFixture();
    expect(await getPaymentSourceDetail(asPrismaClient(client), USER_A, "ps_b_1")).toBeNull();
  });
});
