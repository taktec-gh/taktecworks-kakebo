import { WasteTag } from "@/generated/prisma/enums";

/**
 * 支出の集計（純粋関数・DB非依存）。
 *
 * Step 6 のダッシュボードでも同じ関数を使うため、Prisma にも Next.js にも依存させない
 * （docs/steps/step-5.md「集計 src/lib/expense-summary.ts」）。
 *
 * 絞り込んだ結果の合計と件数を一覧の先頭に出すのは
 * 「今月の外食はいくらか」「浪費だけでいくらか」をその場で見るため。
 */

/** 集計に必要な最小限の形。Expense はこれを満たす */
export type SummarizableExpense = {
  amountYen: number;
  wasteTag: WasteTag;
};

export type AmountTotal = {
  count: number;
  totalYen: number;
};

export type ExpenseSummary = AmountTotal & {
  /** 浪費タグ別の内訳。該当が無いタグも 0 件 0 円で必ず入る */
  byWasteTag: Record<WasteTag, AmountTotal>;
};

const EMPTY_TOTAL: AmountTotal = { count: 0, totalYen: 0 };

/**
 * 合計金額・件数・浪費タグ別の内訳を求める。
 *
 * byWasteTag は全タグ分のキーを必ず持つ（該当が無ければ 0）。
 * 「今月の無駄使い: ¥0」を出せるようにするため、キーの有無で分岐させない。
 */
export function summarizeExpenses(
  expenses: readonly SummarizableExpense[],
): ExpenseSummary {
  const byWasteTag: Record<WasteTag, AmountTotal> = {
    [WasteTag.NECESSARY]: { ...EMPTY_TOTAL },
    [WasteTag.WASTE]: { ...EMPTY_TOTAL },
    [WasteTag.INVESTMENT]: { ...EMPTY_TOTAL },
  };

  let count = 0;
  let totalYen = 0;

  for (const expense of expenses) {
    count += 1;
    totalYen += expense.amountYen;

    const bucket = byWasteTag[expense.wasteTag];
    // 未知のタグ（DB に後から値が増えた等）は内訳から落とすが、合計には残す
    if (bucket) {
      bucket.count += 1;
      bucket.totalYen += expense.amountYen;
    }
  }

  return { count, totalYen, byWasteTag };
}

/**
 * 任意のキーで合計する。カテゴリ別・払い出し先別の消化額に使う（Step 6 で再利用）。
 * 戻り値は Map で、キーの出現順は入力の出現順。
 */
export function groupExpenseTotals<T extends { amountYen: number }>(
  expenses: readonly T[],
  keyOf: (expense: T) => string,
): Map<string, AmountTotal> {
  const totals = new Map<string, AmountTotal>();

  for (const expense of expenses) {
    const key = keyOf(expense);
    const current = totals.get(key);
    if (current) {
      current.count += 1;
      current.totalYen += expense.amountYen;
    } else {
      totals.set(key, { count: 1, totalYen: expense.amountYen });
    }
  }

  return totals;
}
