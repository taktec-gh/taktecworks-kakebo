import { buildExpenseListQuery, type ExpenseListFilter } from "@/lib/expense-filter";

/**
 * 支出画面の Server Action の状態とパス。
 * "use server" ファイルは async 関数しか export できないため、
 * 型と定数は actions.ts から分離してここに置く（予算・設定画面と同じ構成）。
 */

export type ExpenseActionState = {
  /** 失敗時のみメッセージが入る。成功時は null */
  error: string | null;
  /**
   * 保存に成功した回数。
   *
   * 登録後は一覧へ飛ばさず入力画面に留まるため（レジで続けて2件入れる）、
   * 「また1件保存された」を画面側が検出できる必要がある。真偽値だと
   * 2件目の保存で値が変わらず、金額とカテゴリのクリアが走らない。
   */
  savedCount: number;
};

export const initialExpenseActionState: ExpenseActionState = { error: null, savedCount: 0 };

/** useActionState に渡せる Server Action の形 */
export type ExpenseFormAction = (
  prevState: ExpenseActionState,
  formData: FormData,
) => ExpenseActionState | Promise<ExpenseActionState>;

/** 一覧ページ */
export const EXPENSES_PATH = "/expenses";

/** 登録ページ。アプリで最も使う画面 */
export const NEW_EXPENSE_PATH = "/expenses/new";

/** 編集ページ */
export function expenseDetailPath(id: string): string {
  return `${EXPENSES_PATH}/${encodeURIComponent(id)}`;
}

/** 絞り込み条件付きの一覧ページ URL */
export function expensesPath(filter: ExpenseListFilter): string {
  const query = buildExpenseListQuery(filter);
  return query.length === 0 ? EXPENSES_PATH : `${EXPENSES_PATH}?${query}`;
}
