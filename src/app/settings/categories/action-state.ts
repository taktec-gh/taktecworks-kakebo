/**
 * カテゴリの Server Action の状態。
 * "use server" ファイルは async 関数しか export できないため、
 * 型と定数は actions.ts から分離してここに置く（払い出し先の設定画面と同じ構成）。
 */

export type CategoryActionState = {
  /** 失敗時のみメッセージが入る。成功時は null */
  error: string | null;
};

export const initialCategoryActionState: CategoryActionState = { error: null };

/** useActionState に渡せる Server Action の形 */
export type CategoryFormAction = (
  prevState: CategoryActionState,
  formData: FormData,
) => CategoryActionState | Promise<CategoryActionState>;

/** 一覧ページ */
export const CATEGORIES_PATH = "/settings/categories";

/** 編集ページ */
export function categoryDetailPath(id: string): string {
  return `${CATEGORIES_PATH}/${encodeURIComponent(id)}`;
}
