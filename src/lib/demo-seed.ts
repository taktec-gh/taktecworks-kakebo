import type { Prisma } from "@/generated/prisma/client";

import type { DemoDataPlan } from "@/lib/demo-data";
import { toDbDate } from "@/lib/expense-date";
import type { SeedResult } from "@/lib/seed";
import type { UserId } from "@/lib/user-id";

/**
 * デモのサンプルデータを DB に投入する（docs/steps/pub-3.md 設計判断 8「作り方」）。
 *
 * 計画（src/lib/demo-data.ts の buildDemoData）は払い出し先・カテゴリを**名前で**参照している。
 * ここでその名前を、**このユーザーの**プリセット（と、ここで作る払い出し先）の ID に解決して書き込む。
 *
 * - **全行の userId は引数の userId**（今作ったデモユーザー）。計画に userId は含まれない
 * - 関連先はこのユーザーの行だけから引く。複合外部キーが DB でも同じことを強制する
 * - 名前が解決できなければ例外を投げる（呼び出し側のトランザクションごと戻る）
 * - トランザクションの中で呼ぶ（src/lib/users.ts の createDemoUser）。単独で呼ばない
 */

export type DemoSeedCounts = {
  paymentSources: number;
  budgets: number;
  categoryBudgets: number;
  incomes: number;
  expenses: number;
};

function resolve(map: ReadonlyMap<string, string>, name: string, kind: string): string {
  const id = map.get(name);
  // 名前はコードの定数なので、ここに来るのは実装の誤り。値（名前）は出さない
  if (id === undefined) throw new Error(`demo seed: unknown ${kind}`);
  return id;
}

/**
 * 計画をそのユーザーのデータとして書き込む。
 *
 * @param tx デモユーザー作成と同じトランザクション
 * @param userId 今作ったデモユーザー
 * @param plan buildDemoData の戻り値
 * @param presets 同じトランザクションで投入したプリセット（seedUserPresets の戻り値）
 * @returns 書き込んだ件数
 * @throws 名前が解決できない・DB のエラー
 */
export async function insertDemoData(
  tx: Prisma.TransactionClient,
  userId: UserId,
  plan: DemoDataPlan,
  presets: SeedResult,
): Promise<DemoSeedCounts> {
  const paymentSourceIds = new Map<string, string>();
  for (const source of presets.paymentSources) {
    paymentSourceIds.set(source.name, source.id);
  }
  for (const source of plan.paymentSources) {
    const created = await tx.paymentSource.create({
      data: {
        userId,
        name: source.name,
        type: source.type,
        sortOrder: source.sortOrder,
        // 既定はプリセットの「現金」のまま（ユーザーごとに1件の部分ユニーク）
        isDefault: false,
      },
      select: { id: true },
    });
    paymentSourceIds.set(source.name, created.id);
  }

  const categoryIds = new Map<string, string>();
  for (const category of presets.categories) {
    categoryIds.set(category.name, category.id);
  }

  const budgets = await tx.budget.createMany({
    data: plan.budgets.map((budget) => ({
      userId,
      paymentSourceId: resolve(paymentSourceIds, budget.paymentSourceName, "payment source"),
      yearMonth: budget.yearMonth,
      amountYen: budget.amountYen,
    })),
  });

  const categoryBudgets = await tx.categoryBudget.createMany({
    data: plan.categoryBudgets.map((categoryBudget) => ({
      userId,
      categoryId: resolve(categoryIds, categoryBudget.categoryName, "category"),
      yearMonth: categoryBudget.yearMonth,
      amountYen: categoryBudget.amountYen,
    })),
  });

  const incomes = await tx.income.createMany({
    data: plan.incomes.map((income) => ({
      userId,
      yearMonth: income.yearMonth,
      amountYen: income.amountYen,
      label: income.label,
    })),
  });

  const expenses = await tx.expense.createMany({
    data: plan.expenses.map((expense) => ({
      userId,
      // @db.Date は UTC 深夜で渡す（JST の +9 時間を足さない）
      date: toDbDate(expense.date),
      amountYen: expense.amountYen,
      categoryId: resolve(categoryIds, expense.categoryName, "category"),
      paymentSourceId: resolve(paymentSourceIds, expense.paymentSourceName, "payment source"),
      storeName: expense.storeName,
      memo: expense.memo,
      wasteTag: expense.wasteTag,
    })),
  });

  return {
    paymentSources: plan.paymentSources.length,
    budgets: budgets.count,
    categoryBudgets: categoryBudgets.count,
    incomes: incomes.count,
    expenses: expenses.count,
  };
}
