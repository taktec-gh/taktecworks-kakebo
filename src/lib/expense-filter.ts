import type { WasteTag } from "@/generated/prisma/enums";
import { isWasteTag } from "@/lib/expense-validation";
import { resolveYearMonth } from "@/lib/year-month";

/**
 * 支出一覧の絞り込み・並べ替え条件（純粋関数・DB非依存）。
 *
 * 条件は**すべて URL のクエリに持つ**。ブラウザの戻るが効き、URL を共有・
 * ブックマークできるため（docs/steps/step-5.md「一覧は月単位。絞り込みと
 * 並べ替えは URL に持つ」）。
 *
 * 不正な値はエラーにせず既定値へ落とす。URL は手で編集されうるもので、
 * 壊れた値で画面をエラーにしても利用者にできることが無いため。
 */

/** クエリのキー。月は /budgets と同じ "month" に揃える */
export const EXPENSE_FILTER_PARAMS = {
  month: "month",
  category: "category",
  paymentSource: "paymentSource",
  waste: "waste",
  sort: "sort",
} as const;

/**
 * 並べ替え。
 * - "date": 日付の新しい順（既定）
 * - "amount": 金額の高い順。features.md「高額順で見ると無駄使いが即座に目に入る」
 */
export const EXPENSE_SORT_KEYS = ["date", "amount"] as const;

export type ExpenseSortKey = (typeof EXPENSE_SORT_KEYS)[number];

export const DEFAULT_EXPENSE_SORT: ExpenseSortKey = "date";

export const EXPENSE_SORT_LABELS: Record<ExpenseSortKey, string> = {
  date: "日付順",
  amount: "金額順",
};

export type ExpenseListFilter = {
  /** 対象月 "YYYY-MM" */
  yearMonth: string;
  /** 絞り込まないなら null */
  categoryId: string | null;
  /** 絞り込まないなら null */
  paymentSourceId: string | null;
  /** 絞り込まないなら null */
  wasteTag: WasteTag | null;
  sort: ExpenseSortKey;
};

/** searchParams の形。Next.js の SearchParams をそのまま渡せる */
export type ExpenseSearchParams = {
  [key: string]: string | string[] | undefined;
};

/** 値が ExpenseSortKey か */
export function isExpenseSortKey(value: unknown): value is ExpenseSortKey {
  return EXPENSE_SORT_KEYS.some((key) => key === value);
}

/**
 * 単一の文字列だけを採用する。
 * 配列（?category=a&category=b）と空文字は「指定なし」扱い。
 */
function singleParam(value: string | string[] | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * クエリから絞り込み条件を組み立てる。
 *
 * - 月が未指定・不正なら今月（JST）
 * - 並べ替えが未指定・不正なら日付の新しい順
 * - 浪費タグが不正な値なら絞り込まない
 */
export function parseExpenseListFilter(
  params: ExpenseSearchParams,
  now: Date,
): ExpenseListFilter {
  const waste = singleParam(params[EXPENSE_FILTER_PARAMS.waste]);
  const sort = singleParam(params[EXPENSE_FILTER_PARAMS.sort]);

  return {
    yearMonth: resolveYearMonth(params[EXPENSE_FILTER_PARAMS.month], now),
    categoryId: singleParam(params[EXPENSE_FILTER_PARAMS.category]),
    paymentSourceId: singleParam(params[EXPENSE_FILTER_PARAMS.paymentSource]),
    wasteTag: isWasteTag(waste) ? waste : null,
    sort: isExpenseSortKey(sort) ? sort : DEFAULT_EXPENSE_SORT,
  };
}

/** 一部だけ差し替えた新しい条件を返す。引数は変更しない */
export function withExpenseFilter(
  filter: ExpenseListFilter,
  patch: Partial<ExpenseListFilter>,
): ExpenseListFilter {
  return { ...filter, ...patch };
}

/** 月と並べ替え以外に絞り込みが掛かっているか。「絞り込み中」の表示に使う */
export function hasActiveExpenseFilter(filter: ExpenseListFilter): boolean {
  return (
    filter.categoryId !== null || filter.paymentSourceId !== null || filter.wasteTag !== null
  );
}

/** 月だけを残して絞り込みを解除する */
export function clearExpenseFilter(filter: ExpenseListFilter): ExpenseListFilter {
  return {
    yearMonth: filter.yearMonth,
    categoryId: null,
    paymentSourceId: null,
    wasteTag: null,
    sort: filter.sort,
  };
}

/**
 * 条件をクエリ文字列（"?" は含まない）に直す。
 * 既定値（絞り込みなし・日付順）は省き、URL を短く保つ。
 */
export function buildExpenseListQuery(filter: ExpenseListFilter): string {
  const query = new URLSearchParams();
  query.set(EXPENSE_FILTER_PARAMS.month, filter.yearMonth);

  if (filter.categoryId) query.set(EXPENSE_FILTER_PARAMS.category, filter.categoryId);
  if (filter.paymentSourceId) {
    query.set(EXPENSE_FILTER_PARAMS.paymentSource, filter.paymentSourceId);
  }
  if (filter.wasteTag) query.set(EXPENSE_FILTER_PARAMS.waste, filter.wasteTag);
  if (filter.sort !== DEFAULT_EXPENSE_SORT) {
    query.set(EXPENSE_FILTER_PARAMS.sort, filter.sort);
  }

  return query.toString();
}
