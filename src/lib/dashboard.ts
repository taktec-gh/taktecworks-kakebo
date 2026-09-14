import type { CostType, PaymentSourceType } from "@/generated/prisma/enums";
import type { BudgetRecordInput, CategoryBudgetRecordInput } from "@/lib/budget-calculation";
import { formatYen, sumAmounts } from "@/lib/budget-calculation";
import { sortCategories, type CategoryOrderItem } from "@/lib/category-order";
import { getDaysInMonth, getYearMonthOfDate } from "@/lib/expense-date";
import { groupExpenseTotals } from "@/lib/expense-summary";
import { sortPaymentSources, type PaymentSourceOrderItem } from "@/lib/payment-source-order";
import { parseYearMonth, previousYearMonth } from "@/lib/year-month";

/**
 * ダッシュボードの計算（純粋関数・DB非依存）。**Step 6 の中心。**
 *
 * 仕様の出典: docs/features.md「4. ダッシュボード」/ docs/steps/step-6.md「設計判断」。
 *
 * 利用者が決めた計算方法（勝手に例外を足さないこと）:
 *
 * 1. **ペースは払い出し先ごとの単純日割り。**
 *    今日までの目安 = その払い出し先の予算 × 経過日数 ÷ その月の日数。
 *    固定費 / 変動費で分けない。カテゴリ単位でも計算しない。
 *    銀行引き落としの払い出し先が引き落とし直後に「超過」になるのは**想定内**で、
 *    その払い出し先の中に閉じるため現金・クレジットカードの判断を濁さない。
 * 2. **収支は「先月の総収入 − 今月の総支出」だけ。** 予算とは一切関連付けない。
 *    給与は前月に振り込まれ、それで今月を暮らすという見方をするため。
 *
 * 「今日」は**必ず引数で受け取る**（getCurrentDate(now) と同じ流儀）。
 * 関数の中で new Date() を呼ぶと月末・年またぎがテストできなくなる。
 *
 * 集計は既存の純粋関数を使い回す（sumAmounts / groupExpenseTotals / getDaysInMonth）。
 * 同じ計算をここに書き直さない。
 */

/* ------------------------------------------------------------------ *
 * 月の進み具合
 * ------------------------------------------------------------------ */

export type MonthKind = "past" | "current" | "future";

export type MonthProgress = {
  yearMonth: string;
  /** その月の日数 */
  daysInMonth: number;
  /** 経過日数。当月は「今日の日」、過去月は daysInMonth、未来月は 0 */
  elapsedDays: number;
  /** elapsedDays / daysInMonth（0〜1） */
  elapsedRatio: number;
  kind: MonthKind;
};

/**
 * 対象月の進み具合を求める。
 *
 * - 当月の経過日数は**「今日の日」そのもの**（8/14 なら 14）。今日はもう使える日なので含める
 * - 未来月は 0 日、過去月は月の日数（＝すべて経過）
 *
 * @param yearMonth "YYYY-MM"
 * @param today "YYYY-MM-DD"。呼び出し側が getCurrentDate(now) で作る
 */
export function getMonthProgress(yearMonth: string, today: string): MonthProgress {
  const parts = parseYearMonth(yearMonth);
  if (!parts) throw new RangeError(`invalid year-month: ${String(yearMonth)}`);

  const daysInMonth = getDaysInMonth(parts.year, parts.month);
  // "YYYY-MM" は桁数固定なので辞書順の比較が暦順と一致する
  const todayYearMonth = getYearMonthOfDate(today);

  const kind: MonthKind =
    todayYearMonth === yearMonth ? "current" : todayYearMonth > yearMonth ? "past" : "future";

  const elapsedDays =
    kind === "current"
      ? Number(today.slice(8, 10))
      : kind === "past"
        ? daysInMonth
        : 0;

  return {
    yearMonth,
    daysInMonth,
    elapsedDays,
    elapsedRatio: elapsedDays / daysInMonth,
    kind,
  };
}

/* ------------------------------------------------------------------ *
 * ペース判定
 * ------------------------------------------------------------------ */

/** 予算未設定は "unknown"。判定も目安も出さない */
export type PaceStatus = "under" | "warning" | "over" | "unknown";

/** 目安のこの割合を超えたら要注意 */
export const PACE_WARNING_RATIO = 0.9;

/** 画面に出すペースの日本語（docs/features.md「予算内 / 要注意 / 超過 を色分け」） */
export const PACE_STATUS_LABELS: Record<PaceStatus, string> = {
  under: "予算内",
  warning: "要注意",
  over: "超過",
  unknown: "予算未設定",
};

/**
 * ペースを判定する。上から順に評価する（docs/steps/step-6.md の表）。
 *
 * | 予算が未設定（null）       | unknown |
 * | 実績 > 予算                | over（月内のどこであっても予算超過は超過） |
 * | 実績 > 目安                | over |
 * | 実績 > 目安 × 0.9          | warning |
 * | それ以外                   | under |
 */
export function judgePaceStatus(
  budgetYen: number | null,
  spentYen: number,
  expectedYen: number | null,
): PaceStatus {
  if (budgetYen === null || expectedYen === null) return "unknown";
  if (spentYen > budgetYen) return "over";
  if (spentYen > expectedYen) return "over";
  if (spentYen > expectedYen * PACE_WARNING_RATIO) return "warning";
  return "under";
}

/**
 * 今日までの目安額。**切り捨て**（「使ってよい額」なので少なめに見る）。
 * 予算未設定なら null。
 */
export function calculateExpectedYen(
  budgetYen: number | null,
  progress: MonthProgress,
): number | null {
  if (budgetYen === null) return null;
  return Math.floor((budgetYen * progress.elapsedDays) / progress.daysInMonth);
}

/**
 * 月末の着地見込み。**切り上げ**（「このままだといくらになるか」なので多めに見る）。
 * 経過日数が 0（未来月）なら割れないので null。
 */
export function calculateProjectedYen(
  spentYen: number,
  progress: MonthProgress,
): number | null {
  if (progress.elapsedDays === 0) return null;
  return Math.ceil((spentYen / progress.elapsedDays) * progress.daysInMonth);
}

/**
 * 消化率。並べ替えのキー。
 *
 * | 予算が未設定          | null                      |
 * | 予算 > 0              | 実績 ÷ 予算               |
 * | 予算 = 0 かつ 実績 = 0 | 0                         |
 * | 予算 = 0 かつ 実績 > 0 | Number.POSITIVE_INFINITY |
 *
 * **最後の行を null や 0 にしてはいけない。** 0円の予算に対して使ってしまった
 * 払い出し先が最も危険であり、降順に並べたとき先頭へ来る必要がある。
 */
export function calculateUsageRatio(
  budgetYen: number | null,
  spentYen: number,
): number | null {
  if (budgetYen === null) return null;
  if (budgetYen > 0) return spentYen / budgetYen;
  if (spentYen > 0) return Number.POSITIVE_INFINITY;
  return 0;
}

/**
 * バーの幅（%）。0〜100 に丸める。
 * 100% を超えたらバーは 100% で止め、超過は色で示す（docs/steps/step-6.md）。
 * 消化率が null（予算未設定）ならバーを出さないので 0。
 */
export function getUsageBarPercent(usageRatio: number | null): number {
  if (usageRatio === null || !(usageRatio > 0)) return 0;
  if (usageRatio >= 1) return 100;
  return Math.round(usageRatio * 100);
}

/**
 * 符号付きの金額表示。
 *
 * ダッシュボードは「残り使える金額」も「収支の差額」もマイナスになり得る。
 * formatYen だけだと "¥-52,400" と通貨記号の後ろに符号が来て読みにくいため、
 * マイナス記号を前に出して "-¥52,400" にする。符号は ASCII のハイフンマイナス。
 */
export function formatSignedYen(amountYen: number): string {
  return amountYen < 0 ? `-${formatYen(-amountYen)}` : formatYen(amountYen);
}

/* ------------------------------------------------------------------ *
 * 払い出し先ごとの行
 * ------------------------------------------------------------------ */

/** 払い出し先のうち、ダッシュボードの計算に必要な項目 */
export type DashboardPaymentSourceInput = PaymentSourceOrderItem & {
  name: string;
  type: PaymentSourceType;
};

/** 支出のうち、払い出し先別の集計に必要な項目 */
export type PaymentSourceSpendInput = {
  paymentSourceId: string;
  amountYen: number;
};

/** 支出のうち、カテゴリ別の集計に必要な項目 */
export type CategorySpendInput = {
  categoryId: string;
  amountYen: number;
};

export type PaymentSourceProgressRow = {
  paymentSourceId: string;
  name: string;
  type: PaymentSourceType;
  isActive: boolean;
  /** 未設定は null。0 は「0円の予算」であり null とは区別する */
  budgetYen: number | null;
  spentYen: number;
  count: number;
  /** 予算 − 実績。マイナスもあり得る。予算未設定なら null */
  remainingYen: number | null;
  /** 今日までの目安。予算未設定なら null */
  expectedYen: number | null;
  /** 消化率。並べ替えのキー */
  usageRatio: number | null;
  /** 月末着地見込み。経過日数 0 なら null */
  projectedYen: number | null;
  status: PaceStatus;
};

/**
 * 消化率の降順。Infinity 同士・null 同士は同率（0 を返す）。
 * **null（予算未設定）は必ず末尾**へ送る。
 */
function compareUsageRatioDesc(a: number | null, b: number | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a > b ? -1 : 1;
}

export type PaymentSourceProgressInput = {
  paymentSources: readonly DashboardPaymentSourceInput[];
  /** 対象月の Budget レコード（対象月での絞り込みは呼び出し側の責任） */
  budgets: readonly BudgetRecordInput[];
  /** 対象月の支出 */
  expenses: readonly PaymentSourceSpendInput[];
  progress: MonthProgress;
};

/**
 * 払い出し先別の行を組み立てる。
 *
 * 行に含める払い出し先:
 * - 有効な払い出し先は**全件**（予算も支出も無くても出す。入れ忘れが見えるように）
 * - 無効な払い出し先は、**予算か支出のどちらかがある場合だけ**出す
 *
 * 並び順: 消化率の降順（一番危ない払い出し先が一番上）。同率なら表示順。
 * 予算未設定は末尾にまとめ、その中は表示順。
 */
export function buildPaymentSourceProgressRows(
  input: PaymentSourceProgressInput,
): PaymentSourceProgressRow[] {
  const { paymentSources, budgets, expenses, progress } = input;

  const budgetBySourceId = new Map<string, number>();
  for (const budget of budgets) {
    budgetBySourceId.set(budget.paymentSourceId, budget.amountYen);
  }
  const spentBySourceId = groupExpenseTotals(expenses, (expense) => expense.paymentSourceId);

  const rows: PaymentSourceProgressRow[] = [];

  // 先に表示順へ並べておく。以降の安定ソートで「同率なら表示順」が保たれる
  for (const source of sortPaymentSources(paymentSources)) {
    const budgetYen = budgetBySourceId.get(source.id) ?? null;
    const spent = spentBySourceId.get(source.id);
    const spentYen = spent?.totalYen ?? 0;

    // 無効な払い出し先は、予算も支出も無ければ画面に出さない
    if (!source.isActive && budgetYen === null && spent === undefined) continue;

    const expectedYen = calculateExpectedYen(budgetYen, progress);

    rows.push({
      paymentSourceId: source.id,
      name: source.name,
      type: source.type,
      isActive: source.isActive,
      budgetYen,
      spentYen,
      count: spent?.count ?? 0,
      remainingYen: budgetYen === null ? null : budgetYen - spentYen,
      expectedYen,
      usageRatio: calculateUsageRatio(budgetYen, spentYen),
      projectedYen: calculateProjectedYen(spentYen, progress),
      status: judgePaceStatus(budgetYen, spentYen, expectedYen),
    });
  }

  // Array.prototype.sort は安定なので、同率は上で作った表示順のまま残る
  return rows.sort((a, b) => compareUsageRatioDesc(a.usageRatio, b.usageRatio));
}

/* ------------------------------------------------------------------ *
 * カテゴリごとの行
 * ------------------------------------------------------------------ */

/** カテゴリのうち、ダッシュボードの計算に必要な項目 */
export type DashboardCategoryInput = CategoryOrderItem & {
  name: string;
  costType: CostType;
};

export type CategoryProgressRow = {
  categoryId: string;
  name: string;
  costType: CostType;
  budgetYen: number;
  spentYen: number;
  count: number;
  remainingYen: number;
  expectedYen: number;
  usageRatio: number;
  status: PaceStatus;
};

export type CategoryProgressInput = {
  categories: readonly DashboardCategoryInput[];
  /** 対象月の CategoryBudget レコード */
  categoryBudgets: readonly CategoryBudgetRecordInput[];
  /** 対象月の支出 */
  expenses: readonly CategorySpendInput[];
  progress: MonthProgress;
};

/**
 * カテゴリ別の行を組み立てる。
 *
 * **カテゴリ予算が設定されているカテゴリだけ**が対象（docs/features.md
 * 「カテゴリ予算を設定している場合のみ」）。未設定のカテゴリは行に出さないので
 * budgetYen は必ず数値になる。非表示カテゴリでも予算があれば出す。
 *
 * **この合計を総予算やダッシュボードの残高に足さないこと**（払い出し先の予算と二重計上になる）。
 */
export function buildCategoryProgressRows(
  input: CategoryProgressInput,
): CategoryProgressRow[] {
  const { categories, categoryBudgets, expenses, progress } = input;

  const budgetByCategoryId = new Map<string, number>();
  for (const budget of categoryBudgets) {
    budgetByCategoryId.set(budget.categoryId, budget.amountYen);
  }
  const spentByCategoryId = groupExpenseTotals(expenses, (expense) => expense.categoryId);

  const rows: CategoryProgressRow[] = [];

  for (const category of sortCategories(categories)) {
    const budgetYen = budgetByCategoryId.get(category.id);
    if (budgetYen === undefined) continue;

    const spent = spentByCategoryId.get(category.id);
    const spentYen = spent?.totalYen ?? 0;
    // 予算は必ず数値なので expected も必ず数値になる
    const expectedYen = calculateExpectedYen(budgetYen, progress) ?? 0;

    rows.push({
      categoryId: category.id,
      name: category.name,
      costType: category.costType,
      budgetYen,
      spentYen,
      count: spent?.count ?? 0,
      remainingYen: budgetYen - spentYen,
      expectedYen,
      usageRatio: calculateUsageRatio(budgetYen, spentYen) ?? 0,
      status: judgePaceStatus(budgetYen, spentYen, expectedYen),
    });
  }

  return rows.sort((a, b) => compareUsageRatioDesc(a.usageRatio, b.usageRatio));
}

/* ------------------------------------------------------------------ *
 * 全体の集計
 * ------------------------------------------------------------------ */

export type DashboardSummary = {
  progress: MonthProgress;
  /** その月の Budget レコードの合計 = 総予算。無効な払い出し先の分も含む */
  totalBudgetYen: number;
  /** その月の支出合計 */
  totalSpentYen: number;
  /** 総予算 − 実績。画面最上部に大きく出す「残り使える金額」。マイナスもあり得る */
  remainingYen: number;
  totalExpectedYen: number;
  totalProjectedYen: number | null;
  totalStatus: PaceStatus;
  rows: PaymentSourceProgressRow[];
  /** 有効な払い出し先のうち予算が未設定の件数。0 なら注意を出さない */
  unsetBudgetCount: number;
};

export type DashboardSummaryInput = {
  paymentSources: readonly DashboardPaymentSourceInput[];
  /** 対象月の Budget レコード */
  budgets: readonly BudgetRecordInput[];
  /** 対象月の支出 */
  expenses: readonly PaymentSourceSpendInput[];
  progress: MonthProgress;
};

/**
 * ダッシュボードの全体集計。
 *
 * 総予算が 0（予算を1つも入れていない）のときは totalStatus を "unknown" にし、
 * ペースも着地見込みも画面に出さない。0 で割った結果や「0円の予算に対して超過」を
 * 初回起動でいきなり見せないため。代わりに unsetBudgetCount で予算の設定を促す。
 */
export function buildDashboardSummary(input: DashboardSummaryInput): DashboardSummary {
  const { budgets, expenses, progress } = input;

  const rows = buildPaymentSourceProgressRows(input);

  // 合計はレコードをすべて足す（無効な払い出し先の分も含む）。
  // 画面に出ない行があっても合計から落とさない（buildBudgetSummary と同じ考え方）
  const totalBudgetYen = sumAmounts(budgets);
  const totalSpentYen = sumAmounts(expenses);
  const totalExpectedYen = calculateExpectedYen(totalBudgetYen, progress) ?? 0;

  return {
    progress,
    totalBudgetYen,
    totalSpentYen,
    remainingYen: totalBudgetYen - totalSpentYen,
    totalExpectedYen,
    totalProjectedYen: calculateProjectedYen(totalSpentYen, progress),
    totalStatus:
      totalBudgetYen === 0
        ? "unknown"
        : judgePaceStatus(totalBudgetYen, totalSpentYen, totalExpectedYen),
    rows,
    unsetBudgetCount: rows.filter((row) => row.isActive && row.budgetYen === null).length,
  };
}

/* ------------------------------------------------------------------ *
 * 収入と収支
 * ------------------------------------------------------------------ */

export type IncomeSummary = {
  yearMonth: string;
  totalYen: number;
  count: number;
};

/** その月の収入の合計と件数。0 件でも枠は出す（入れ忘れに気づけるように） */
export function summarizeIncomes(
  yearMonth: string,
  incomes: readonly { amountYen: number }[],
): IncomeSummary {
  return { yearMonth, totalYen: sumAmounts(incomes), count: incomes.length };
}

export type IncomeBalance = {
  /** 収入を見た月 = 表示中の月の前月 */
  incomeYearMonth: string;
  incomeTotalYen: number;
  /** 表示中の月の支出合計 */
  spentYen: number;
  /** incomeTotalYen − spentYen。マイナスもあり得る */
  balanceYen: number;
};

/**
 * 収支 =「**前月**の総収入 − 表示中の月の総支出」。
 *
 * 給与は前月に振り込まれ、それで今月を暮らす。だから今月の生活の原資は先月の収入
 * という見方をする（Income.yearMonth は「受け取った月」）。
 * **予算とは一切関連付けない。** 総予算や消化率と混ぜない。
 *
 * 前月の収入が0件なら null を返す（画面は枠ごと出さない）。
 *
 * **空判定を previousYearMonth より先に行う。** 順序が逆だと、扱える範囲の先頭
 * （"0000-01"）で shiftYearMonth が RangeError を投げてダッシュボードが落ちる。
 */
export function buildIncomeBalance(
  yearMonth: string,
  previousMonthIncomes: readonly { amountYen: number }[],
  totalSpentYen: number,
): IncomeBalance | null {
  if (previousMonthIncomes.length === 0) return null;

  const incomeTotalYen = sumAmounts(previousMonthIncomes);
  return {
    incomeYearMonth: previousYearMonth(yearMonth),
    incomeTotalYen,
    spentYen: totalSpentYen,
    balanceYen: incomeTotalYen - totalSpentYen,
  };
}
