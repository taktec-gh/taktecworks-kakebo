import type { PaymentSource, PaymentSourceType, PrismaClient } from "@/generated/prisma/client";

import {
  assignSequentialSortOrder,
  calculateReorder,
  type MoveDirection,
} from "@/lib/payment-source-order";

/**
 * 払い出し先のデータ層。
 *
 * PrismaClient は引数で受け取る（src/lib/seed.ts と同じ方針。
 * テストからモックを差し込めるようにするため）。このモジュールはサーバー専用で、
 * Client Component から import しないこと。
 *
 * 禁止条件（docs/steps/step-3.md「設計判断」）:
 * - 既定の払い出し先は常にちょうど1件。既定は無効化も削除もできない
 * - 無効な払い出し先は既定にできない
 * - 有効な払い出し先が1件しかないとき、それは無効化できない
 * - 削除は Expense も Budget も参照していないときだけ
 *
 * これらに触れた操作は例外を投げず { ok: false, error } を返す。
 */

export type PaymentSourceResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** 操作を拒否したときに画面へ出す文言 */
export const PAYMENT_SOURCE_ERRORS = {
  notFound: "対象の払い出し先が見つかりません。",
  duplicateName: "同じ名前の払い出し先がすでに登録されています。",
  defaultMustBeActive: "無効な払い出し先は既定にできません。先に有効に戻してください。",
  deactivateDefault:
    "既定の払い出し先は無効にできません。先に別の払い出し先を既定にしてください。",
  deactivateLastActive:
    "有効な払い出し先が1件だけのため無効にできません。先に別の払い出し先を追加してください。",
  deleteDefault: "既定の払い出し先は削除できません。先に別の払い出し先を既定にしてください。",
  deleteReferencedByExpense:
    "この払い出し先には支出が記録されているため削除できません。無効化してください。",
  deleteReferencedByBudget:
    "この払い出し先には予算が設定されているため削除できません。無効化してください。",
} as const;

/**
 * Prisma のエラーコードを取り出す。
 *
 * ドライバアダプタ経由では従来と異なるコードが返る（docs/steps/step-2.md の実測）。
 * - 名前の重複 → P2002
 * - 参照がある行の削除 → P2039（P2003 ではない）
 */
function getPrismaErrorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  const code = (error as { code: unknown }).code;
  return typeof code === "string" ? code : null;
}

/**
 * 一覧を取得する。有効→無効の順、各グループ内は sortOrder 昇順。
 * 同じ sortOrder があっても順序が揺れないよう id を最後のキーにする。
 */
export async function listPaymentSources(client: PrismaClient): Promise<PaymentSource[]> {
  return client.paymentSource.findMany({
    orderBy: [{ isActive: "desc" }, { sortOrder: "asc" }, { id: "asc" }],
  });
}

/** 1件取得。存在しなければ null */
export async function getPaymentSource(
  client: PrismaClient,
  id: string,
): Promise<PaymentSource | null> {
  return client.paymentSource.findUnique({ where: { id } });
}

export type PaymentSourceDetail = {
  paymentSource: PaymentSource;
  /** この払い出し先を参照している支出の件数 */
  expenseCount: number;
  /** この払い出し先に設定されている月次予算の件数 */
  budgetCount: number;
  /** 有効な払い出し先の総数（自分を含む） */
  activeCount: number;
};

/**
 * 編集画面用に、1件と「削除・無効化してよいか」の判断材料をまとめて取得する。
 * 存在しなければ null。
 */
export async function getPaymentSourceDetail(
  client: PrismaClient,
  id: string,
): Promise<PaymentSourceDetail | null> {
  const paymentSource = await client.paymentSource.findUnique({ where: { id } });
  if (!paymentSource) return null;

  const [expenseCount, budgetCount, activeCount] = await Promise.all([
    client.expense.count({ where: { paymentSourceId: id } }),
    client.budget.count({ where: { paymentSourceId: id } }),
    client.paymentSource.count({ where: { isActive: true } }),
  ]);

  return { paymentSource, expenseCount, budgetCount, activeCount };
}

/** 削除できない理由。削除してよければ null（純粋関数） */
export function getDeleteBlockedReason(detail: PaymentSourceDetail): string | null {
  if (detail.paymentSource.isDefault) return PAYMENT_SOURCE_ERRORS.deleteDefault;
  if (detail.expenseCount > 0) return PAYMENT_SOURCE_ERRORS.deleteReferencedByExpense;
  // Budget は onDelete: Cascade なので、消すと予算が黙って消える。予算があれば削除は拒否する
  if (detail.budgetCount > 0) return PAYMENT_SOURCE_ERRORS.deleteReferencedByBudget;
  return null;
}

/** 無効化できない理由。無効化してよければ（すでに無効な場合も）null（純粋関数） */
export function getDeactivateBlockedReason(detail: PaymentSourceDetail): string | null {
  if (!detail.paymentSource.isActive) return null;
  if (detail.paymentSource.isDefault) return PAYMENT_SOURCE_ERRORS.deactivateDefault;
  if (detail.activeCount <= 1) return PAYMENT_SOURCE_ERRORS.deactivateLastActive;
  return null;
}

/** 既定にできない理由。既定にしてよければ（すでに既定の場合も）null（純粋関数） */
export function getSetDefaultBlockedReason(detail: PaymentSourceDetail): string | null {
  if (detail.paymentSource.isDefault) return null;
  if (!detail.paymentSource.isActive) return PAYMENT_SOURCE_ERRORS.defaultMustBeActive;
  return null;
}

export type CreatePaymentSourceInput = {
  name: string;
  type: PaymentSourceType;
};

/**
 * 追加する。sortOrder は既存の最大 + 1（一覧の末尾）。
 * isDefault は常に false。既定にするのは別操作。
 */
export async function createPaymentSource(
  client: PrismaClient,
  input: CreatePaymentSourceInput,
): Promise<PaymentSourceResult<PaymentSource>> {
  const aggregate = await client.paymentSource.aggregate({ _max: { sortOrder: true } });
  const nextSortOrder = (aggregate._max.sortOrder ?? 0) + 1;

  try {
    const created = await client.paymentSource.create({
      data: {
        name: input.name,
        type: input.type,
        sortOrder: nextSortOrder,
        isDefault: false,
      },
    });
    return { ok: true, value: created };
  } catch (error) {
    if (getPrismaErrorCode(error) === "P2002") {
      return { ok: false, error: PAYMENT_SOURCE_ERRORS.duplicateName };
    }
    throw error;
  }
}

export type UpdatePaymentSourceInput = {
  id: string;
  name: string;
  type: PaymentSourceType;
};

/**
 * 名前とタイプを更新する（リネーム / タイプ変更）。
 * isActive・isDefault・sortOrder はここでは変えない。
 */
export async function updatePaymentSource(
  client: PrismaClient,
  input: UpdatePaymentSourceInput,
): Promise<PaymentSourceResult<PaymentSource>> {
  try {
    const updated = await client.paymentSource.update({
      where: { id: input.id },
      data: { name: input.name, type: input.type },
    });
    return { ok: true, value: updated };
  } catch (error) {
    const code = getPrismaErrorCode(error);
    if (code === "P2002") return { ok: false, error: PAYMENT_SOURCE_ERRORS.duplicateName };
    if (code === "P2025") return { ok: false, error: PAYMENT_SOURCE_ERRORS.notFound };
    throw error;
  }
}

/**
 * 既定を切り替える。
 *
 * 部分ユニークインデックス（isDefault = true は最大1件）に衝突しないよう、
 * 必ずトランザクション内で「旧既定を false にしてから」新既定を true にする。
 */
export async function setDefaultPaymentSource(
  client: PrismaClient,
  id: string,
): Promise<PaymentSourceResult<PaymentSource>> {
  const target = await client.paymentSource.findUnique({ where: { id } });
  if (!target) return { ok: false, error: PAYMENT_SOURCE_ERRORS.notFound };
  if (!target.isActive) {
    return { ok: false, error: PAYMENT_SOURCE_ERRORS.defaultMustBeActive };
  }
  if (target.isDefault) return { ok: true, value: target };

  const [, updated] = await client.$transaction([
    client.paymentSource.updateMany({ where: { isDefault: true }, data: { isDefault: false } }),
    client.paymentSource.update({ where: { id }, data: { isDefault: true } }),
  ]);

  return { ok: true, value: updated };
}

/**
 * 有効 / 無効を切り替える。
 *
 * 無効化できないのは次の場合:
 * - 既定の払い出し先（先に別のものを既定にしてもらう）
 * - 有効なものが自分しかない（支出登録に有効な払い出し先が最低1件必要なため）
 */
export async function setPaymentSourceActive(
  client: PrismaClient,
  id: string,
  isActive: boolean,
): Promise<PaymentSourceResult<PaymentSource>> {
  const target = await client.paymentSource.findUnique({ where: { id } });
  if (!target) return { ok: false, error: PAYMENT_SOURCE_ERRORS.notFound };
  if (target.isActive === isActive) return { ok: true, value: target };

  if (!isActive) {
    if (target.isDefault) {
      return { ok: false, error: PAYMENT_SOURCE_ERRORS.deactivateDefault };
    }
    const activeCount = await client.paymentSource.count({ where: { isActive: true } });
    if (activeCount <= 1) {
      return { ok: false, error: PAYMENT_SOURCE_ERRORS.deactivateLastActive };
    }
  }

  const updated = await client.paymentSource.update({ where: { id }, data: { isActive } });
  return { ok: true, value: updated };
}

/**
 * 同一グループ内で1つ上 / 下へ動かす。
 * 並び順の計算は純粋関数（calculateReorder）に任せ、ここは反映だけを行う。
 *
 * @returns 反映後の全件（表示順）
 */
export async function movePaymentSource(
  client: PrismaClient,
  id: string,
  direction: MoveDirection,
): Promise<PaymentSourceResult<PaymentSource[]>> {
  const sources = await listPaymentSources(client);
  const reordered = calculateReorder(sources, id, direction);
  if (!reordered.ok) return { ok: false, error: reordered.error };

  const updated = await client.$transaction(
    reordered.assignments.map((assignment) =>
      client.paymentSource.update({
        where: { id: assignment.id },
        data: { sortOrder: assignment.sortOrder },
      }),
    ),
  );

  return { ok: true, value: updated };
}

/**
 * 削除する。Expense も Budget も1件も紐づいていないときだけ許す。
 * それ以外は無効化を案内する（過去の家計の履歴を壊さないため）。
 *
 * 削除後に残りの sortOrder を 1 からの連番に振り直す（隙間を作らない）。
 */
export async function deletePaymentSource(
  client: PrismaClient,
  id: string,
): Promise<PaymentSourceResult<null>> {
  const sources = await listPaymentSources(client);
  const target = sources.find((source) => source.id === id);
  if (!target) return { ok: false, error: PAYMENT_SOURCE_ERRORS.notFound };
  if (target.isDefault) return { ok: false, error: PAYMENT_SOURCE_ERRORS.deleteDefault };

  const [expenseCount, budgetCount] = await Promise.all([
    client.expense.count({ where: { paymentSourceId: id } }),
    client.budget.count({ where: { paymentSourceId: id } }),
  ]);
  if (expenseCount > 0) {
    return { ok: false, error: PAYMENT_SOURCE_ERRORS.deleteReferencedByExpense };
  }
  if (budgetCount > 0) {
    return { ok: false, error: PAYMENT_SOURCE_ERRORS.deleteReferencedByBudget };
  }

  const assignments = assignSequentialSortOrder(sources.filter((source) => source.id !== id));

  try {
    await client.$transaction([
      client.paymentSource.delete({ where: { id } }),
      ...assignments.map((assignment) =>
        client.paymentSource.update({
          where: { id: assignment.id },
          data: { sortOrder: assignment.sortOrder },
        }),
      ),
    ]);
    return { ok: true, value: null };
  } catch (error) {
    const code = getPrismaErrorCode(error);
    // 件数を数えたあとに支出が入った場合のフォールバック。
    // Budget は Cascade なので Restrict で弾かれるのは Expense だけ
    if (code === "P2039" || code === "P2003") {
      return { ok: false, error: PAYMENT_SOURCE_ERRORS.deleteReferencedByExpense };
    }
    if (code === "P2025") return { ok: false, error: PAYMENT_SOURCE_ERRORS.notFound };
    throw error;
  }
}
