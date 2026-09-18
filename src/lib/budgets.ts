import type {
  Budget,
  Category,
  CategoryBudget,
  PaymentSource,
  PrismaClient,
} from "@/generated/prisma/client";

import {
  BUDGET_AMOUNT_MAX_YEN,
  BUDGET_AMOUNT_MIN_YEN,
} from "@/lib/budget-calculation";
import type { UserId } from "@/lib/user-id";
import { isYearMonth } from "@/lib/year-month";

/**
 * 月次予算のデータ層。
 *
 * PrismaClient は引数で受け取る（src/lib/payment-sources.ts と同じ方針）。
 * このモジュールはサーバー専用で、Client Component から import しないこと。
 *
 * 仕様（docs/steps/step-4.md）:
 * - 予算の主軸は払い出し先（Budget）。CategoryBudget は任意の補助上限
 * - 金額 null は「未設定」。レコードを作らず、すでにあれば削除する
 * - 0 は「0円の予算」としてレコードを作る
 * - 保存は1回のトランザクションでまとめて反映する（途中まで保存された状態を作らない）
 *
 * **全操作を userId で絞る（docs/steps/pub-1.md 設計判断 6）。**
 * Budget / CategoryBudget のユニークキーは (払い出し先 or カテゴリ, 年月) で userId を含まないが、
 * upsert・deleteMany の where には必ず userId を足す。付け忘れると、他人の払い出し先IDを
 * 渡したときに他人の予算を上書き・削除できてしまう。
 * 保存する払い出し先・カテゴリは、その利用者のものか先に確認する。
 */

export type BudgetResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** 操作を拒否したときに画面へ出す文言 */
export const BUDGET_ERRORS = {
  invalidYearMonth: "対象月の指定が不正です。",
  invalidAmount: "金額が不正です。",
  paymentSourceNotFound: "対象の払い出し先が見つかりません。",
  categoryNotFound: "対象のカテゴリが見つかりません。",
} as const;

function getPrismaErrorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  const code = (error as { code: unknown }).code;
  return typeof code === "string" ? code : null;
}

/** 保存できる金額か（整数円・0〜99,999,999）。null は「未設定」なので対象外 */
function isStorableAmount(amountYen: number): boolean {
  return (
    Number.isInteger(amountYen) &&
    amountYen >= BUDGET_AMOUNT_MIN_YEN &&
    amountYen <= BUDGET_AMOUNT_MAX_YEN
  );
}

/** その利用者の対象月の払い出し先予算 */
export async function listBudgets(
  client: PrismaClient,
  userId: UserId,
  yearMonth: string,
): Promise<Budget[]> {
  return client.budget.findMany({ where: { userId, yearMonth } });
}

/** その利用者の対象月のカテゴリ予算 */
export async function listCategoryBudgets(
  client: PrismaClient,
  userId: UserId,
  yearMonth: string,
): Promise<CategoryBudget[]> {
  return client.categoryBudget.findMany({ where: { userId, yearMonth } });
}

export type MonthlyBudgetData = {
  yearMonth: string;
  /** 有効・無効を含む全件（無効な払い出し先に残った予算も表示するため） */
  paymentSources: PaymentSource[];
  budgets: Budget[];
  /** 表示・非表示を含む全件 */
  categories: Category[];
  categoryBudgets: CategoryBudget[];
};

/** 予算画面が必要とするデータをまとめて取得する */
export async function getMonthlyBudgetData(
  client: PrismaClient,
  userId: UserId,
  yearMonth: string,
): Promise<MonthlyBudgetData> {
  const [paymentSources, budgets, categories, categoryBudgets] = await Promise.all([
    client.paymentSource.findMany({
      where: { userId },
      orderBy: [{ isActive: "desc" }, { sortOrder: "asc" }, { id: "asc" }],
    }),
    client.budget.findMany({ where: { userId, yearMonth } }),
    client.category.findMany({
      where: { userId },
      orderBy: [{ isHidden: "asc" }, { sortOrder: "asc" }, { id: "asc" }],
    }),
    client.categoryBudget.findMany({ where: { userId, yearMonth } }),
  ]);

  return { yearMonth, paymentSources, budgets, categories, categoryBudgets };
}

/** 金額を保存する（null でない）入力の ID を重複なしで集める */
function collectIdsToSave<T>(
  inputs: readonly T[],
  getId: (input: T) => string,
  getAmount: (input: T) => number | null,
): string[] {
  return [...new Set(inputs.filter((input) => getAmount(input) !== null).map(getId))];
}

/** 保存する1件。amountYen が null なら「未設定」＝レコードを削除する */
export type BudgetAmountInput = {
  paymentSourceId: string;
  amountYen: number | null;
};

/**
 * 払い出し先の予算をまとめて保存する。
 *
 * スマホで複数の金額を入れて1回で保存できるよう一括にする。
 * 1つのトランザクションで反映するので、一部だけ保存された状態にはならない。
 * 対象に含めなかった払い出し先の予算は変更しない。
 *
 * 金額を保存する払い出し先が1つでもその利用者のものでなければ（他人のもの・存在しないもの）、
 * 何も保存せず paymentSourceNotFound を返す。null（未設定）の削除は userId で絞るので、
 * 他人の払い出し先IDを渡しても何も消えない。
 */
export async function saveBudgets(
  client: PrismaClient,
  userId: UserId,
  yearMonth: string,
  inputs: readonly BudgetAmountInput[],
): Promise<BudgetResult<null>> {
  if (!isYearMonth(yearMonth)) {
    return { ok: false, error: BUDGET_ERRORS.invalidYearMonth };
  }
  for (const input of inputs) {
    if (input.amountYen !== null && !isStorableAmount(input.amountYen)) {
      return { ok: false, error: BUDGET_ERRORS.invalidAmount };
    }
  }
  if (inputs.length === 0) return { ok: true, value: null };

  const idsToSave = collectIdsToSave(
    inputs,
    (input) => input.paymentSourceId,
    (input) => input.amountYen,
  );
  if (idsToSave.length > 0) {
    const owned = await client.paymentSource.findMany({
      where: { id: { in: idsToSave }, userId },
      select: { id: true },
    });
    if (owned.length !== idsToSave.length) {
      return { ok: false, error: BUDGET_ERRORS.paymentSourceNotFound };
    }
  }

  const operations = inputs.map((input) =>
    input.amountYen === null
      ? client.budget.deleteMany({
          where: { userId, paymentSourceId: input.paymentSourceId, yearMonth },
        })
      : client.budget.upsert({
          where: {
            paymentSourceId_yearMonth: {
              paymentSourceId: input.paymentSourceId,
              yearMonth,
            },
            userId,
          },
          create: {
            userId,
            paymentSourceId: input.paymentSourceId,
            yearMonth,
            amountYen: input.amountYen,
          },
          update: { amountYen: input.amountYen },
        }),
  );

  try {
    await client.$transaction(operations);
    return { ok: true, value: null };
  } catch (error) {
    const code = getPrismaErrorCode(error);
    if (code === "P2003" || code === "P2039" || code === "P2025") {
      return { ok: false, error: BUDGET_ERRORS.paymentSourceNotFound };
    }
    throw error;
  }
}

/** 保存する1件。amountYen が null なら「未設定」＝レコードを削除する */
export type CategoryBudgetAmountInput = {
  categoryId: string;
  amountYen: number | null;
};

/**
 * カテゴリ予算をまとめて保存する。
 * 任意の補助上限であり、総予算には足さない（docs/features.md「予算の持ち方」）。
 *
 * 金額を保存するカテゴリが1つでもその利用者のものでなければ、何も保存せず
 * categoryNotFound を返す（saveBudgets と同じ扱い）。
 */
export async function saveCategoryBudgets(
  client: PrismaClient,
  userId: UserId,
  yearMonth: string,
  inputs: readonly CategoryBudgetAmountInput[],
): Promise<BudgetResult<null>> {
  if (!isYearMonth(yearMonth)) {
    return { ok: false, error: BUDGET_ERRORS.invalidYearMonth };
  }
  for (const input of inputs) {
    if (input.amountYen !== null && !isStorableAmount(input.amountYen)) {
      return { ok: false, error: BUDGET_ERRORS.invalidAmount };
    }
  }
  if (inputs.length === 0) return { ok: true, value: null };

  const idsToSave = collectIdsToSave(
    inputs,
    (input) => input.categoryId,
    (input) => input.amountYen,
  );
  if (idsToSave.length > 0) {
    const owned = await client.category.findMany({
      where: { id: { in: idsToSave }, userId },
      select: { id: true },
    });
    if (owned.length !== idsToSave.length) {
      return { ok: false, error: BUDGET_ERRORS.categoryNotFound };
    }
  }

  const operations = inputs.map((input) =>
    input.amountYen === null
      ? client.categoryBudget.deleteMany({
          where: { userId, categoryId: input.categoryId, yearMonth },
        })
      : client.categoryBudget.upsert({
          where: {
            categoryId_yearMonth: { categoryId: input.categoryId, yearMonth },
            userId,
          },
          create: {
            userId,
            categoryId: input.categoryId,
            yearMonth,
            amountYen: input.amountYen,
          },
          update: { amountYen: input.amountYen },
        }),
  );

  try {
    await client.$transaction(operations);
    return { ok: true, value: null };
  } catch (error) {
    const code = getPrismaErrorCode(error);
    if (code === "P2003" || code === "P2039" || code === "P2025") {
      return { ok: false, error: BUDGET_ERRORS.categoryNotFound };
    }
    throw error;
  }
}

/**
 * 払い出し先の予算を1件削除する。
 * 無効な払い出し先に残った予算を、その場で消せるようにするためのもの。
 * 対象が無い場合も成功として扱う（deleteMany なので二重送信で失敗しない）。
 * 他人の払い出し先IDでも同じく成功を返し、何も消さない（応答から存在が漏れない）。
 */
export async function deleteBudget(
  client: PrismaClient,
  userId: UserId,
  paymentSourceId: string,
  yearMonth: string,
): Promise<BudgetResult<null>> {
  if (!isYearMonth(yearMonth)) {
    return { ok: false, error: BUDGET_ERRORS.invalidYearMonth };
  }

  await client.budget.deleteMany({ where: { userId, paymentSourceId, yearMonth } });
  return { ok: true, value: null };
}
