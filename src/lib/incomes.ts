import type { Income, PrismaClient } from "@/generated/prisma/client";

import { sumAmounts } from "@/lib/budget-calculation";
import { INCOME_AMOUNT_MAX_YEN, INCOME_AMOUNT_MIN_YEN } from "@/lib/income-validation";
import type { UserId } from "@/lib/user-id";
import { isYearMonth } from "@/lib/year-month";

/**
 * 収入のデータ層。
 *
 * PrismaClient は引数で受け取る（src/lib/budgets.ts と同じ方針）。
 * このモジュールはサーバー専用で、Client Component から import しないこと。
 *
 * 仕様（docs/steps/step-6.md「設計判断 2」）:
 * - `Income.yearMonth` は「**受け取った月**」。7/25 に振り込まれた給与は "2026-07"
 * - 1ヶ月に複数件登録できる（ユニーク制約は無い）
 * - **更新（updateIncome）は作らない。** 追加・一覧・削除のみ。
 *   金額とラベルだけの小さなレコードなので、直したいときは消して入れ直すほうが
 *   手数が少なく、画面も1つで済む
 *
 * **全操作を userId で絞る（docs/steps/pub-1.md 設計判断 6）。**
 * 他人の収入IDには、存在しないIDと同じ notFound を返す。
 *
 * 失敗は例外ではなく { ok: false, error } で返す。
 */

export type IncomeResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** 操作を拒否したときに画面へ出す文言 */
export const INCOME_ERRORS = {
  notFound: "対象の収入が見つかりません。",
  invalidYearMonth: "対象月の指定が不正です。",
  invalidAmount: "金額が不正です。",
} as const;

function getPrismaErrorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  const code = (error as { code: unknown }).code;
  return typeof code === "string" ? code : null;
}

/** 保存できる金額か（整数円・1〜99,999,999） */
function isStorableAmount(amountYen: number): boolean {
  return (
    Number.isInteger(amountYen) &&
    amountYen >= INCOME_AMOUNT_MIN_YEN &&
    amountYen <= INCOME_AMOUNT_MAX_YEN
  );
}

/**
 * その月に受け取った収入。**新しい順**（createdAt 降順）。
 * 同じ createdAt でも順序が揺れないよう id を最後のキーに足す。
 */
export async function listIncomes(
  client: PrismaClient,
  userId: UserId,
  yearMonth: string,
): Promise<Income[]> {
  return client.income.findMany({
    where: { userId, yearMonth },
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
  });
}

export type CreateIncomeInput = {
  /** 「受け取った月」 "YYYY-MM" */
  yearMonth: string;
  amountYen: number;
  /** 「給与」「賞与」など。未入力は null */
  label: string | null;
};

/** その利用者の収入として1件追加する。userId は引数から設定する */
export async function createIncome(
  client: PrismaClient,
  userId: UserId,
  input: CreateIncomeInput,
): Promise<IncomeResult<Income>> {
  if (!isYearMonth(input.yearMonth)) {
    return { ok: false, error: INCOME_ERRORS.invalidYearMonth };
  }
  if (!isStorableAmount(input.amountYen)) {
    return { ok: false, error: INCOME_ERRORS.invalidAmount };
  }

  const created = await client.income.create({
    data: {
      userId,
      yearMonth: input.yearMonth,
      amountYen: input.amountYen,
      label: input.label,
    },
  });
  return { ok: true, value: created };
}

/**
 * 1件削除する（物理削除）。
 * Income は他から参照されないので無効化の概念は要らない。
 * 誤タップ対策の2段階確認は画面側の責任。
 */
export async function deleteIncome(
  client: PrismaClient,
  userId: UserId,
  id: string,
): Promise<IncomeResult<null>> {
  try {
    await client.income.delete({ where: { id, userId } });
    return { ok: true, value: null };
  } catch (error) {
    if (getPrismaErrorCode(error) === "P2025") {
      return { ok: false, error: INCOME_ERRORS.notFound };
    }
    throw error;
  }
}

/**
 * 収入の合計（純粋関数）。
 * 中身は既存の sumAmounts。**新しい合計関数を作らない**ための薄い別名。
 */
export function sumIncomeAmounts(incomes: readonly { amountYen: number }[]): number {
  return sumAmounts(incomes);
}
