/**
 * 払い出し先の Server Action の状態。
 * "use server" ファイルは async 関数しか export できないため、
 * 型と定数は actions.ts から分離してここに置く（ログイン画面と同じ構成）。
 */

export type PaymentSourceActionState = {
  /** 失敗時のみメッセージが入る。成功時は null */
  error: string | null;
};

export const initialPaymentSourceActionState: PaymentSourceActionState = { error: null };

/** useActionState に渡せる Server Action の形 */
export type PaymentSourceFormAction = (
  prevState: PaymentSourceActionState,
  formData: FormData,
) => PaymentSourceActionState | Promise<PaymentSourceActionState>;

/** 一覧ページ */
export const PAYMENT_SOURCES_PATH = "/settings/payment-sources";

/** 編集ページ */
export function paymentSourceDetailPath(id: string): string {
  return `${PAYMENT_SOURCES_PATH}/${encodeURIComponent(id)}`;
}
