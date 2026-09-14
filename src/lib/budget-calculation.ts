import type { PaymentSourceType } from "@/generated/prisma/enums";
import { formatGroupedNumber, normalizeAmountInput } from "@/lib/amount-input";
import { sortCategories, type CategoryOrderItem } from "@/lib/category-order";
import { sortPaymentSources, type PaymentSourceOrderItem } from "@/lib/payment-source-order";

/**
 * 月次予算の計算と入力値の正規化（純粋関数・DB非依存）。
 *
 * 仕様の要点（docs/features.md「設計判断 > 予算の持ち方」/ docs/steps/step-4.md）:
 * - **総予算 = その月の Budget（払い出し先の予算）の合計。** 総予算を手入力する欄は無い
 * - **CategoryBudget は任意の補助上限で、総予算には一切足さない**（足すと二重計上）
 * - 「未設定」（レコード無し = null）と「0円の予算」（レコード有り = 0）を区別する
 * - 合計にはその月の Budget レコードを**すべて**含める（払い出し先が無効でも）。
 *   黙って除外すると画面の合計と実データが食い違う。入力欄に並べるのは有効な払い出し先のみ
 */

/** 金額の下限（円）。0 円の予算は「使わない月」の意思表示として認める */
export const BUDGET_AMOUNT_MIN_YEN = 0;

/** 金額の上限（円）。桁の入れすぎ（打ち間違い）を検出するための上限 */
export const BUDGET_AMOUNT_MAX_YEN = 99_999_999;

export const BUDGET_AMOUNT_ERRORS = {
  invalid: "金額は数字で入力してください。",
  notInteger: "金額は1円単位の整数で入力してください。",
  negative: "金額は0以上で入力してください。",
  tooLarge: `金額は${formatGrouped(BUDGET_AMOUNT_MAX_YEN)}円以下で入力してください。`,
} as const;

/** 成功時の value は「未設定」なら null、金額なら整数円 */
export type BudgetAmountResult =
  | { ok: true; value: number | null }
  | { ok: false; error: string };

/**
 * 金額入力を整数円に正規化する。
 *
 * - 空欄（空白のみを含む）は **未設定** として null を返す。0 円の予算とは区別する
 * - 全角数字・桁区切りのカンマ（半角/全角）・前後の空白は正規化して受け入れる
 * - 小数、マイナス、その他の文字は**拒否する**（丸めて黙って別の金額を保存しない）
 * - 範囲は BUDGET_AMOUNT_MIN_YEN 〜 BUDGET_AMOUNT_MAX_YEN
 *
 * 書式の正規化そのものは src/lib/amount-input.ts に共通化してある
 * （支出の金額と受け入れる書き方を一致させるため）。ここは予算固有の
 * 「空欄 = 未設定」「下限 0」と、利用者向けの文言だけを持つ。
 */
export function parseBudgetAmountInput(input: unknown): BudgetAmountResult {
  const normalized = normalizeAmountInput(input);
  if (!normalized.ok) {
    return { ok: false, error: BUDGET_AMOUNT_ERRORS[normalized.reason] };
  }
  // 空欄は「未設定」。0 円の予算とは区別する
  if (normalized.value === null) return { ok: true, value: null };

  if (normalized.value < BUDGET_AMOUNT_MIN_YEN) {
    return { ok: false, error: BUDGET_AMOUNT_ERRORS.negative };
  }
  if (normalized.value > BUDGET_AMOUNT_MAX_YEN) {
    return { ok: false, error: BUDGET_AMOUNT_ERRORS.tooLarge };
  }

  return { ok: true, value: normalized.value };
}

/**
 * 3桁区切り。Intl に頼らず結果を環境非依存にする。
 * BUDGET_AMOUNT_ERRORS の組み立てより前に使われるため関数宣言のまま置く（巻き上げが要る）。
 */
function formatGrouped(value: number): string {
  return formatGroupedNumber(value);
}

/** 画面表示用の金額。"¥40,000" */
export function formatYen(amountYen: number): string {
  return `¥${formatGrouped(amountYen)}`;
}

/** 入力欄に戻す値。空文字は未設定 */
export function formatAmountInputValue(amountYen: number | null): string {
  return amountYen === null ? "" : String(amountYen);
}

/** 払い出し先のうち、予算の計算に必要な項目 */
export type BudgetPaymentSourceInput = PaymentSourceOrderItem & {
  name: string;
  type: PaymentSourceType;
};

/** Budget レコードのうち、計算に必要な項目 */
export type BudgetRecordInput = {
  paymentSourceId: string;
  amountYen: number;
};

export type BudgetRow = {
  paymentSourceId: string;
  name: string;
  type: PaymentSourceType;
  isActive: boolean;
  /** 未設定なら null。0 は「0円の予算」であり null とは区別する */
  amountYen: number | null;
};

/** 無効な払い出し先に残っている予算。必ず金額を持つ（警告表示用） */
export type InactiveBudgetRow = BudgetRow & { amountYen: number };

export type BudgetSummary = {
  /** 入力欄に並べる行。有効な払い出し先のみ、表示順 */
  rows: BudgetRow[];
  /** 無効な払い出し先に残っている予算。表示順 */
  inactiveRows: InactiveBudgetRow[];
  /** その月の Budget レコードの合計 = 総予算。無効な払い出し先の分も含む */
  totalYen: number;
  /** 有効な払い出し先のうち予算が未設定の件数 */
  unsetCount: number;
};

/**
 * 払い出し先の一覧とその月の Budget から、画面に出す行と総予算を組み立てる。
 *
 * @param paymentSources 有効・無効を含む全件
 * @param budgets 対象月の Budget レコード（対象月での絞り込みは呼び出し側の責任）
 */
export function buildBudgetSummary(
  paymentSources: readonly BudgetPaymentSourceInput[],
  budgets: readonly BudgetRecordInput[],
): BudgetSummary {
  const amountBySourceId = new Map<string, number>();
  for (const budget of budgets) {
    amountBySourceId.set(budget.paymentSourceId, budget.amountYen);
  }

  const sorted = sortPaymentSources(paymentSources);
  const rows: BudgetRow[] = [];
  const inactiveRows: InactiveBudgetRow[] = [];

  for (const source of sorted) {
    const amountYen = amountBySourceId.get(source.id);
    if (source.isActive) {
      rows.push({
        paymentSourceId: source.id,
        name: source.name,
        type: source.type,
        isActive: true,
        amountYen: amountYen ?? null,
      });
      continue;
    }
    // 無効な払い出し先は、予算が残っているものだけ警告として出す
    if (amountYen !== undefined) {
      inactiveRows.push({
        paymentSourceId: source.id,
        name: source.name,
        type: source.type,
        isActive: false,
        amountYen,
      });
    }
  }

  return {
    rows,
    inactiveRows,
    // 合計はレコードをすべて足す。画面に出ない行があっても合計から落とさない
    totalYen: sumAmounts(budgets),
    unsetCount: rows.filter((row) => row.amountYen === null).length,
  };
}

/** カテゴリのうち、カテゴリ予算の計算に必要な項目 */
export type CategoryBudgetCategoryInput = CategoryOrderItem & {
  name: string;
};

/** CategoryBudget レコードのうち、計算に必要な項目 */
export type CategoryBudgetRecordInput = {
  categoryId: string;
  amountYen: number;
};

export type CategoryBudgetRow = {
  categoryId: string;
  name: string;
  isHidden: boolean;
  /** 未設定なら null。0 は「0円の上限」であり null とは区別する */
  amountYen: number | null;
};

export type CategoryBudgetSummary = {
  /** 表示中のカテゴリ全件 + 非表示でも予算が残っているカテゴリ。表示順 */
  rows: CategoryBudgetRow[];
  /**
   * カテゴリ予算の合計。**総予算には足さない**（あくまで設定状況の参考値）。
   * 足すと払い出し先の予算と二重計上になる
   */
  totalYen: number;
  /** 予算が設定されているカテゴリの件数 */
  setCount: number;
};

/**
 * カテゴリの一覧とその月の CategoryBudget から、画面に出す行を組み立てる。
 *
 * 非表示のカテゴリは入力欄に出さないが、予算が残っている場合だけは行に含める
 * （非表示にしたあとも金額を消せるようにするため）。
 */
export function buildCategoryBudgetSummary(
  categories: readonly CategoryBudgetCategoryInput[],
  categoryBudgets: readonly CategoryBudgetRecordInput[],
): CategoryBudgetSummary {
  const amountByCategoryId = new Map<string, number>();
  for (const budget of categoryBudgets) {
    amountByCategoryId.set(budget.categoryId, budget.amountYen);
  }

  const rows: CategoryBudgetRow[] = [];
  for (const category of sortCategories(categories)) {
    const amountYen = amountByCategoryId.get(category.id);
    if (category.isHidden && amountYen === undefined) continue;
    rows.push({
      categoryId: category.id,
      name: category.name,
      isHidden: category.isHidden,
      amountYen: amountYen ?? null,
    });
  }

  return {
    rows,
    totalYen: sumAmounts(categoryBudgets),
    setCount: rows.filter((row) => row.amountYen !== null).length,
  };
}

/** 金額の単純合計。空配列は 0 */
export function sumAmounts(records: readonly { amountYen: number }[]): number {
  return records.reduce((total, record) => total + record.amountYen, 0);
}
