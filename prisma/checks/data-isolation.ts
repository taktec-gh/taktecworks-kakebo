/**
 * 実DB（ローカルの Docker PostgreSQL）でのデータ分離の検証（docs/steps/pub-1.md 設計判断 9）。
 *
 *   npx tsx prisma/checks/data-isolation.ts
 *
 * 単体テストはモックなので、複合外部キー・部分ユニーク・カスケードが PostgreSQL 上で
 * 効くことは保証できない。このスクリプトはそこを実DBで確かめる。
 *
 * - **接続先のホストが localhost / 127.0.0.1 以外なら何もせず終了コード1で終わる**
 * - 自分で作ったユーザー A・B（と 7. のサインアップで作るユーザー）のデータだけを使い、
 *   成否にかかわらず finally で削除する。SignupEvent は userId を持たないので、
 *   このスクリプト専用の ipHash（CHECK_IP_HASH）で記録し、その ipHash の行を消す
 * - 出力は検査項目ごとの OK / NG だけ。接続文字列・金額・ID などは出さない
 */
import "dotenv/config";

import {
  PaymentSourceType,
  WasteTag,
  type PrismaClient,
} from "@/generated/prisma/client";
import { BUDGET_ERRORS, deleteBudget, listBudgets, saveBudgets } from "@/lib/budgets";
import {
  CATEGORY_ERRORS,
  deleteCategory,
  getCategory,
  getCategoryDetail,
  moveCategory,
  setCategoryHidden,
  updateCategory,
} from "@/lib/categories";
import { createCredential, deleteCredential, listCredentials } from "@/lib/credentials";
import {
  createExpense,
  EXPENSE_ERRORS,
  deleteExpense,
  getExpense,
  listExpenses,
  listRecentStoreNames,
  updateExpense,
  type ExpenseInput,
} from "@/lib/expenses";
import { createIncome, deleteIncome, INCOME_ERRORS, listIncomes } from "@/lib/incomes";
import {
  createPaymentSource,
  deletePaymentSource,
  getPaymentSource,
  getPaymentSourceDetail,
  movePaymentSource,
  PAYMENT_SOURCE_ERRORS,
  setDefaultPaymentSource,
  setPaymentSourceActive,
  updatePaymentSource,
} from "@/lib/payment-sources";
import { PASSKEY_ERRORS } from "@/lib/passkey";
import { createPrismaClient } from "@/lib/prisma";
import { PRESET_CATEGORIES, seedUserPresets } from "@/lib/seed";
import type { UserId } from "@/lib/user-id";
import { createUserWithPasskey, createUserWithPresets } from "@/lib/users";
import { generateWebauthnUserId } from "@/lib/webauthn-user-id";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1"]);

/** 7. のサインアップで SignupEvent に記録する ipHash。後片付けでこの値の行だけを消す */
const CHECK_IP_HASH = "data-isolation-check";

const YEAR_MONTH = "2026-09";
const EXPENSE_DATE = "2026-09-10";

type CheckResult = { label: string; ok: boolean };

const results: CheckResult[] = [];

function record(label: string, ok: boolean): void {
  results.push({ label, ok });
  console.log(`${ok ? "OK" : "NG"}  ${label}`);
}

/** 例外を NG として記録する。例外の中身（値を含みうる）は出さず、エラーコードだけを出す */
async function check(label: string, run: () => Promise<boolean>): Promise<void> {
  try {
    record(label, await run());
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String((error as { code: unknown }).code)
        : "unknown";
    record(`${label}（例外: ${code}）`, false);
  }
}

/** 拒否され、その文言が期待どおり（＝存在しないIDと同じ文言）なら true */
function failedWith(result: { ok: true } | { ok: false; error: string }, expected: string): boolean {
  return !result.ok && result.error === expected;
}

/** 実行して例外で拒否されれば true */
async function rejects(run: () => Promise<unknown>): Promise<boolean> {
  try {
    await run();
    return false;
  } catch {
    return true;
  }
}

/** その利用者の全テーブルの行数 */
async function countRows(prisma: PrismaClient, userId: string): Promise<number[]> {
  const where = { userId };
  return Promise.all([
    prisma.user.count({ where: { id: userId } }),
    prisma.paymentSource.count({ where }),
    prisma.category.count({ where }),
    prisma.expense.count({ where }),
    prisma.budget.count({ where }),
    prisma.categoryBudget.count({ where }),
    prisma.income.count({ where }),
    prisma.credential.count({ where }),
  ]);
}

/** その利用者の全行のスナップショット（変わっていないことの比較用） */
async function snapshot(prisma: PrismaClient, userId: string): Promise<string> {
  const where = { userId };
  const orderBy = { id: "asc" } as const;
  const rows = await Promise.all([
    prisma.paymentSource.findMany({ where, orderBy }),
    prisma.category.findMany({ where, orderBy }),
    prisma.expense.findMany({ where, orderBy }),
    prisma.budget.findMany({ where, orderBy }),
    prisma.categoryBudget.findMany({ where, orderBy }),
    prisma.income.findMany({ where, orderBy }),
    prisma.credential.findMany({ where, orderBy }),
  ]);
  return JSON.stringify(rows, (_key, value: unknown) =>
    typeof value === "bigint" ? value.toString() : value,
  );
}

async function findPreset(prisma: PrismaClient, userId: UserId) {
  const [category, paymentSource] = await Promise.all([
    prisma.category.findFirstOrThrow({ where: { userId, name: PRESET_CATEGORIES[0].name } }),
    prisma.paymentSource.findFirstOrThrow({ where: { userId, isDefault: true } }),
  ]);
  return { category, paymentSource };
}

function expenseInput(categoryId: string, paymentSourceId: string, storeName: string): ExpenseInput {
  return {
    date: EXPENSE_DATE,
    amountYen: 1000,
    categoryId,
    paymentSourceId,
    wasteTag: WasteTag.NECESSARY,
    storeName,
    memo: null,
  };
}

async function run(prisma: PrismaClient, createdUserIds: string[]): Promise<void> {
  // ---- 1. ユニーク制約がユーザー単位 ----
  const userA = await createUserWithPresets(prisma, generateWebauthnUserId());
  createdUserIds.push(userA);
  const userB = await createUserWithPresets(prisma, generateWebauthnUserId());
  createdUserIds.push(userB);

  await check("1. A・B とも createUserWithPresets でき、同名のカテゴリ・払い出し先を持てる", async () => {
    const [categoryCount, cashCount] = await Promise.all([
      prisma.category.count({
        where: { userId: { in: [userA, userB] }, name: PRESET_CATEGORIES[0].name },
      }),
      prisma.paymentSource.count({ where: { userId: { in: [userA, userB] }, name: "現金" } }),
    ]);
    const [aCategories, bCategories] = await Promise.all([
      prisma.category.count({ where: { userId: userA } }),
      prisma.category.count({ where: { userId: userB } }),
    ]);
    return (
      categoryCount === 2 &&
      cashCount === 2 &&
      aCategories === PRESET_CATEGORIES.length &&
      bCategories === PRESET_CATEGORIES.length
    );
  });

  await check("1b. seedUserPresets を再実行しても件数が変わらない（冪等）", async () => {
    await seedUserPresets(prisma, userA);
    const [categories, sources] = await Promise.all([
      prisma.category.count({ where: { userId: userA } }),
      prisma.paymentSource.count({ where: { userId: userA } }),
    ]);
    return categories === PRESET_CATEGORIES.length && sources === 1;
  });

  // ---- 2. 既定の部分ユニークがユーザー単位 ----
  await check("2. A・B が既定の払い出し先を1件ずつ持ち、A に既定を2件作ろうとすると拒否される", async () => {
    const [aDefaults, bDefaults] = await Promise.all([
      prisma.paymentSource.count({ where: { userId: userA, isDefault: true } }),
      prisma.paymentSource.count({ where: { userId: userB, isDefault: true } }),
    ]);
    const rejected = await rejects(() =>
      prisma.paymentSource.create({
        data: {
          userId: userA,
          name: "Aカード",
          type: PaymentSourceType.CREDIT_CARD,
          sortOrder: 99,
          isDefault: true,
        },
      }),
    );
    const aDefaultsAfter = await prisma.paymentSource.count({
      where: { userId: userA, isDefault: true },
    });
    return aDefaults === 1 && bDefaults === 1 && rejected && aDefaultsAfter === 1;
  });

  const a = await findPreset(prisma, userA);
  const b = await findPreset(prisma, userB);

  // ---- 3. 複合外部キー ----
  await check("3a. A の userId で B のカテゴリを参照する支出を直接作ると拒否される", async () => {
    const rejected = await rejects(() =>
      prisma.expense.create({
        data: {
          userId: userA,
          categoryId: b.category.id,
          paymentSourceId: a.paymentSource.id,
          date: new Date(`${EXPENSE_DATE}T00:00:00.000Z`),
          amountYen: 1,
          wasteTag: WasteTag.NECESSARY,
        },
      }),
    );
    return rejected && (await prisma.expense.count({ where: { userId: userA } })) === 0;
  });

  await check("3b. A の userId で B の払い出し先を参照する支出を直接作ると拒否される", async () => {
    const rejected = await rejects(() =>
      prisma.expense.create({
        data: {
          userId: userA,
          categoryId: a.category.id,
          paymentSourceId: b.paymentSource.id,
          date: new Date(`${EXPENSE_DATE}T00:00:00.000Z`),
          amountYen: 1,
          wasteTag: WasteTag.NECESSARY,
        },
      }),
    );
    return rejected && (await prisma.expense.count({ where: { userId: userA } })) === 0;
  });

  await check("3c. A の userId で B の払い出し先を参照する予算を直接作ると拒否される", async () => {
    const rejected = await rejects(() =>
      prisma.budget.create({
        data: {
          userId: userA,
          paymentSourceId: b.paymentSource.id,
          yearMonth: YEAR_MONTH,
          amountYen: 1,
        },
      }),
    );
    return rejected && (await prisma.budget.count({ where: { userId: userA } })) === 0;
  });

  await check("3d. A の userId で B のカテゴリを参照するカテゴリ予算を直接作ると拒否される", async () => {
    const rejected = await rejects(() =>
      prisma.categoryBudget.create({
        data: {
          userId: userA,
          categoryId: b.category.id,
          yearMonth: YEAR_MONTH,
          amountYen: 1,
        },
      }),
    );
    return rejected && (await prisma.categoryBudget.count({ where: { userId: userA } })) === 0;
  });

  // ---- 4. データ層の関数で他人のIDに触れない ----
  // B のデータを一通り作る
  const bExpense = await createExpense(
    prisma,
    userB,
    expenseInput(b.category.id, b.paymentSource.id, "店B"),
  );
  const bIncome = await createIncome(prisma, userB, {
    yearMonth: YEAR_MONTH,
    amountYen: 1000,
    label: "収入B",
  });
  const bCredential = await createCredential(prisma, userB, {
    credentialId: `data-isolation-check-${userB}`,
    publicKey: new Uint8Array([1, 2, 3]),
    counter: 0,
    transports: [],
    deviceName: "端末B",
  });
  const bBudget = await saveBudgets(prisma, userB, YEAR_MONTH, [
    { paymentSourceId: b.paymentSource.id, amountYen: 1000 },
  ]);
  if (!bExpense.ok || !bIncome.ok || !bCredential.ok || !bBudget.ok) {
    record("4. 前準備（B のデータ作成）", false);
    return;
  }
  // A にも自分の支出を作る（6. の削除でカスケードを確かめるため）
  const aExpense = await createExpense(
    prisma,
    userA,
    expenseInput(a.category.id, a.paymentSource.id, "店A"),
  );
  const aBudget = await saveBudgets(prisma, userA, YEAR_MONTH, [
    { paymentSourceId: a.paymentSource.id, amountYen: 1000 },
  ]);
  if (!aExpense.ok || !aBudget.ok) {
    record("4. 前準備（A のデータ作成）", false);
    return;
  }

  const bBefore = await snapshot(prisma, userB);

  await check("4a. 支出: A から B の支出は取得 null・更新/削除 notFound・一覧/店名に出ない", async () => {
    const got = await getExpense(prisma, userA, bExpense.value.id);
    const updated = await updateExpense(
      prisma,
      userA,
      bExpense.value.id,
      expenseInput(a.category.id, a.paymentSource.id, "店A"),
    );
    const deleted = await deleteExpense(prisma, userA, bExpense.value.id);
    const listed = await listExpenses(prisma, userA, {
      yearMonth: YEAR_MONTH,
      categoryId: null,
      paymentSourceId: null,
      wasteTag: null,
      sort: "date",
    });
    const storeNames = await listRecentStoreNames(prisma, userA);
    return (
      got === null &&
      failedWith(updated, EXPENSE_ERRORS.notFound) &&
      failedWith(deleted, EXPENSE_ERRORS.notFound) &&
      listed.ok &&
      listed.value.every((expense) => expense.userId === userA) &&
      !storeNames.includes("店B")
    );
  });

  await check("4b. 支出: A の支出に B のカテゴリ / 払い出し先を指定すると拒否される", async () => {
    const withBCategory = await createExpense(
      prisma,
      userA,
      expenseInput(b.category.id, a.paymentSource.id, "店A"),
    );
    const withBSource = await updateExpense(
      prisma,
      userA,
      aExpense.value.id,
      expenseInput(a.category.id, b.paymentSource.id, "店A"),
    );
    return (
      failedWith(withBCategory, EXPENSE_ERRORS.categoryNotFound) &&
      failedWith(withBSource, EXPENSE_ERRORS.paymentSourceNotFound)
    );
  });

  await check("4c. 収入: A から B の収入は削除 notFound・一覧に出ない", async () => {
    const deleted = await deleteIncome(prisma, userA, bIncome.value.id);
    const listed = await listIncomes(prisma, userA, YEAR_MONTH);
    return (
      failedWith(deleted, INCOME_ERRORS.notFound) &&
      listed.every((income) => income.userId === userA)
    );
  });

  await check("4d. カテゴリ: A から B のカテゴリは取得 null・更新/非表示/移動/削除が拒否される", async () => {
    const got = await getCategory(prisma, userA, b.category.id);
    const detail = await getCategoryDetail(prisma, userA, b.category.id);
    const updated = await updateCategory(prisma, userA, {
      id: b.category.id,
      name: "改名",
      costType: b.category.costType,
    });
    const hidden = await setCategoryHidden(prisma, userA, b.category.id, true);
    const moved = await moveCategory(prisma, userA, b.category.id, "down");
    const deleted = await deleteCategory(prisma, userA, b.category.id);
    return (
      got === null &&
      detail === null &&
      failedWith(updated, CATEGORY_ERRORS.notFound) &&
      failedWith(hidden, CATEGORY_ERRORS.notFound) &&
      failedWith(moved, CATEGORY_ERRORS.notFound) &&
      failedWith(deleted, CATEGORY_ERRORS.notFound)
    );
  });

  await check("4e. 払い出し先: A から B の払い出し先は取得 null・更新/有効化/既定/移動/削除が拒否される", async () => {
    const got = await getPaymentSource(prisma, userA, b.paymentSource.id);
    const detail = await getPaymentSourceDetail(prisma, userA, b.paymentSource.id);
    const updated = await updatePaymentSource(prisma, userA, {
      id: b.paymentSource.id,
      name: "改名",
      type: b.paymentSource.type,
    });
    const deactivated = await setPaymentSourceActive(prisma, userA, b.paymentSource.id, false);
    const defaulted = await setDefaultPaymentSource(prisma, userA, b.paymentSource.id);
    const moved = await movePaymentSource(prisma, userA, b.paymentSource.id, "down");
    const deleted = await deletePaymentSource(prisma, userA, b.paymentSource.id);
    return (
      got === null &&
      detail === null &&
      failedWith(updated, PAYMENT_SOURCE_ERRORS.notFound) &&
      failedWith(deactivated, PAYMENT_SOURCE_ERRORS.notFound) &&
      failedWith(defaulted, PAYMENT_SOURCE_ERRORS.notFound) &&
      failedWith(moved, PAYMENT_SOURCE_ERRORS.notFound) &&
      failedWith(deleted, PAYMENT_SOURCE_ERRORS.notFound)
    );
  });

  await check("4f. 予算: A から B の払い出し先の予算は保存拒否・削除は成功扱いで何も消えない", async () => {
    const saved = await saveBudgets(prisma, userA, YEAR_MONTH, [
      { paymentSourceId: b.paymentSource.id, amountYen: 1 },
    ]);
    const cleared = await saveBudgets(prisma, userA, YEAR_MONTH, [
      { paymentSourceId: b.paymentSource.id, amountYen: null },
    ]);
    const deleted = await deleteBudget(prisma, userA, b.paymentSource.id, YEAR_MONTH);
    const listed = await listBudgets(prisma, userA, YEAR_MONTH);
    return (
      failedWith(saved, BUDGET_ERRORS.paymentSourceNotFound) &&
      cleared.ok &&
      deleted.ok &&
      listed.every((budget) => budget.userId === userA)
    );
  });

  await check("4g. パスキー: A から B のパスキーは削除 notFound・一覧に出ない", async () => {
    const deleted = await deleteCredential(prisma, userA, bCredential.value.id);
    const listed = await listCredentials(prisma, userA);
    return failedWith(deleted, PASSKEY_ERRORS.notFound) && listed.length === 0;
  });

  await check("4h. 4a〜4g のあとも B の行が1つも変わっていない", async () => {
    return (await snapshot(prisma, userB)) === bBefore;
  });

  // ---- 5. 既定の切り替えが他人に波及しない ----
  await check("5. A の setDefaultPaymentSource が B の既定を外さない", async () => {
    const created = await createPaymentSource(prisma, userA, {
      name: "A銀行",
      type: PaymentSourceType.BANK_DEBIT,
    });
    if (!created.ok) return false;
    const switched = await setDefaultPaymentSource(prisma, userA, created.value.id);
    const [aDefault, bDefault] = await Promise.all([
      prisma.paymentSource.findMany({ where: { userId: userA, isDefault: true } }),
      prisma.paymentSource.findMany({ where: { userId: userB, isDefault: true } }),
    ]);
    return (
      switched.ok &&
      aDefault.length === 1 &&
      aDefault[0]?.id === created.value.id &&
      bDefault.length === 1 &&
      bDefault[0]?.id === b.paymentSource.id
    );
  });

  // ---- 6. ユーザー削除のカスケード ----
  await check("6a. 支出が参照しているカテゴリ・払い出し先の単体削除は DB が拒否する（Restrict）", async () => {
    const categoryRejected = await rejects(() =>
      prisma.category.delete({ where: { id: a.category.id } }),
    );
    const sourceRejected = await rejects(() =>
      prisma.paymentSource.delete({ where: { id: a.paymentSource.id } }),
    );
    return categoryRejected && sourceRejected;
  });

  await check("6b. 支出・予算のある A を削除でき、A の全行が消え、B のデータは残る", async () => {
    const [aExpenses, aBudgets] = await Promise.all([
      prisma.expense.count({ where: { userId: userA } }),
      prisma.budget.count({ where: { userId: userA } }),
    ]);
    const bBeforeDelete = await snapshot(prisma, userB);
    await prisma.user.delete({ where: { id: userA } });
    const aCounts = await countRows(prisma, userA);
    const [bUser, bExpenses] = await Promise.all([
      prisma.user.count({ where: { id: userB } }),
      prisma.expense.count({ where: { userId: userB } }),
    ]);
    return (
      aExpenses > 0 &&
      aBudgets > 0 &&
      aCounts.every((count) => count === 0) &&
      bUser === 1 &&
      bExpenses > 0 &&
      (await snapshot(prisma, userB)) === bBeforeDelete
    );
  });

  // ---- 7. サインアップのトランザクション（docs/steps/pub-2.md 設計判断 2・5） ----
  const signupCredentialId = `data-isolation-check-signup-${Date.now()}`;
  const signupCredential = {
    credentialId: signupCredentialId,
    publicKey: new Uint8Array([4, 5, 6]),
    counter: 0,
    transports: [],
    deviceName: "端末C",
  };

  await check("7a. createUserWithPasskey でユーザー・プリセット・資格情報・SignupEvent が1件ずつ作られる", async () => {
    const eventsBefore = await prisma.signupEvent.count({ where: { ipHash: CHECK_IP_HASH } });
    const result = await createUserWithPasskey(prisma, {
      webauthnUserId: generateWebauthnUserId(),
      credential: signupCredential,
      ipHash: CHECK_IP_HASH,
    });
    if (!result.ok) return false;
    createdUserIds.push(result.userId);
    const [categories, sources, credentials, eventsAfter] = await Promise.all([
      prisma.category.count({ where: { userId: result.userId } }),
      prisma.paymentSource.count({ where: { userId: result.userId } }),
      prisma.credential.count({ where: { userId: result.userId } }),
      prisma.signupEvent.count({ where: { ipHash: CHECK_IP_HASH } }),
    ]);
    return (
      categories === PRESET_CATEGORIES.length &&
      sources === 1 &&
      credentials === 1 &&
      eventsAfter === eventsBefore + 1
    );
  });

  await check("7b. 資格情報IDが重複すると duplicate になり、ユーザー・プリセット・SignupEvent が1件も増えない", async () => {
    const [usersBefore, categoriesBefore, eventsBefore] = await Promise.all([
      prisma.user.count(),
      prisma.category.count(),
      prisma.signupEvent.count(),
    ]);
    const result = await createUserWithPasskey(prisma, {
      webauthnUserId: generateWebauthnUserId(),
      credential: signupCredential,
      ipHash: CHECK_IP_HASH,
    });
    if (result.ok) createdUserIds.push(result.userId);
    const [usersAfter, categoriesAfter, eventsAfter] = await Promise.all([
      prisma.user.count(),
      prisma.category.count(),
      prisma.signupEvent.count(),
    ]);
    return (
      !result.ok &&
      result.reason === "duplicate" &&
      usersAfter === usersBefore &&
      categoriesAfter === categoriesBefore &&
      eventsAfter === eventsBefore
    );
  });

  await check("7c. webauthnUserId が同じユーザーは作れない（一意）", async () => {
    const webauthnUserId = generateWebauthnUserId();
    const first = await createUserWithPresets(prisma, webauthnUserId);
    createdUserIds.push(first);
    const usersBefore = await prisma.user.count();
    const rejected = await rejects(() => createUserWithPresets(prisma, webauthnUserId));
    return rejected && (await prisma.user.count()) === usersBefore;
  });
}

async function main(): Promise<number> {
  const url = process.env.DATABASE_URL;
  if (typeof url !== "string" || url.length === 0) {
    console.error("DATABASE_URL が未設定のため中止しました");
    return 1;
  }
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    console.error("DATABASE_URL を解釈できないため中止しました");
    return 1;
  }
  if (!LOCAL_HOSTS.has(hostname)) {
    // 接続文字列そのものは出さない
    console.error("接続先が localhost / 127.0.0.1 ではないため、何もせず中止しました");
    return 1;
  }

  const prisma = createPrismaClient(url);
  const createdUserIds: string[] = [];
  try {
    await run(prisma, createdUserIds);
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String((error as { code: unknown }).code)
        : "unknown";
    record(`検証の途中で例外（${code}）`, false);
  } finally {
    // 成否にかかわらず、作ったユーザーを消す（カスケードで全データが消える）
    try {
      if (createdUserIds.length > 0) {
        await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
      }
      // SignupEvent は userId を持たずカスケードで消えないので、専用の ipHash で消す
      await prisma.signupEvent.deleteMany({ where: { ipHash: CHECK_IP_HASH } });
      record(
        "後片付け: このスクリプトの SignupEvent が残っていない",
        (await prisma.signupEvent.count({ where: { ipHash: CHECK_IP_HASH } })) === 0,
      );
      const remaining = await Promise.all(createdUserIds.map((id) => countRows(prisma, id)));
      record(
        "後片付け: 作成したユーザーとその全行が残っていない",
        remaining.every((counts) => counts.every((count) => count === 0)),
      );
    } catch {
      record("後片付け: 作成したユーザーの削除", false);
    }
    await prisma.$disconnect();
  }

  const failed = results.filter((result) => !result.ok).length;
  console.log(failed === 0 ? "\nすべて OK" : `\nNG が ${failed} 件あります`);
  return failed === 0 ? 0 : 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch(() => {
    console.error("検証スクリプトが異常終了しました");
    process.exitCode = 1;
  });
