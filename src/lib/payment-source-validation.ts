import { PaymentSourceType } from "@/generated/prisma/enums";

/**
 * 払い出し先のフォーム入力の検証（純粋関数）。
 *
 * - DB にも Next.js にも依存しない。例外で制御せず、必ず結果オブジェクトを返す
 * - 名前の重複は DB の @unique に任せる。ここでは判定しない
 *   （大文字小文字・全角半角の正規化もしない。利用者は本人1人だけなので過剰なため）
 * - このモジュールは Client Component からも import される。
 *   enum は `@/generated/prisma/enums`（ブラウザ安全）から取る
 */

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** 名前の最大文字数。1〜30文字（docs/steps/step-3.md） */
export const PAYMENT_SOURCE_NAME_MAX_LENGTH = 30;

/** 名前の最小文字数（trim 後） */
export const PAYMENT_SOURCE_NAME_MIN_LENGTH = 1;

/** 画面に出す検証エラー文言 */
export const PAYMENT_SOURCE_VALIDATION_ERRORS = {
  nameRequired: "名前を入力してください。",
  nameTooLong: `名前は${PAYMENT_SOURCE_NAME_MAX_LENGTH}文字以内で入力してください。`,
  typeRequired: "払い出し先のタイプを選択してください。",
  idRequired: "対象の払い出し先が指定されていません。",
} as const;

/** タイプの日本語表示。一覧・編集画面で共用する */
export const PAYMENT_SOURCE_TYPE_LABELS: Record<PaymentSourceType, string> = {
  [PaymentSourceType.CASH]: "現金",
  [PaymentSourceType.CREDIT_CARD]: "クレジットカード",
  [PaymentSourceType.BANK_DEBIT]: "銀行引き落とし",
};

export type PaymentSourceTypeOption = {
  value: PaymentSourceType;
  label: string;
};

/** セレクトボックスの選択肢。features.md「払い出し先のタイプは3種類」の記載順 */
export const PAYMENT_SOURCE_TYPE_OPTIONS: readonly PaymentSourceTypeOption[] = [
  { value: PaymentSourceType.CASH, label: PAYMENT_SOURCE_TYPE_LABELS[PaymentSourceType.CASH] },
  {
    value: PaymentSourceType.CREDIT_CARD,
    label: PAYMENT_SOURCE_TYPE_LABELS[PaymentSourceType.CREDIT_CARD],
  },
  {
    value: PaymentSourceType.BANK_DEBIT,
    label: PAYMENT_SOURCE_TYPE_LABELS[PaymentSourceType.BANK_DEBIT],
  },
] as const;

/** 値が PaymentSourceType のいずれかか */
export function isPaymentSourceType(value: unknown): value is PaymentSourceType {
  return (
    value === PaymentSourceType.CASH ||
    value === PaymentSourceType.CREDIT_CARD ||
    value === PaymentSourceType.BANK_DEBIT
  );
}

/**
 * 名前を検証する。前後の空白を trim してから判定し、成功時は trim 済みの値を返す。
 *
 * 文字数は「見た目の文字数」に近づけるためコードポイント単位で数える
 * （絵文字などのサロゲートペアを2文字と数えない）。
 */
export function validatePaymentSourceName(input: unknown): ValidationResult<string> {
  if (typeof input !== "string") {
    return { ok: false, error: PAYMENT_SOURCE_VALIDATION_ERRORS.nameRequired };
  }

  const name = input.trim();
  const length = Array.from(name).length;

  if (length < PAYMENT_SOURCE_NAME_MIN_LENGTH) {
    return { ok: false, error: PAYMENT_SOURCE_VALIDATION_ERRORS.nameRequired };
  }
  if (length > PAYMENT_SOURCE_NAME_MAX_LENGTH) {
    return { ok: false, error: PAYMENT_SOURCE_VALIDATION_ERRORS.nameTooLong };
  }

  return { ok: true, value: name };
}

/** フォームから来た文字列を PaymentSourceType に照合する。外れていれば拒否する */
export function validatePaymentSourceType(input: unknown): ValidationResult<PaymentSourceType> {
  if (!isPaymentSourceType(input)) {
    return { ok: false, error: PAYMENT_SOURCE_VALIDATION_ERRORS.typeRequired };
  }
  return { ok: true, value: input };
}

/** 対象レコードの id。空文字・文字列以外は拒否する */
export function validatePaymentSourceId(input: unknown): ValidationResult<string> {
  if (typeof input !== "string" || input.trim().length === 0) {
    return { ok: false, error: PAYMENT_SOURCE_VALIDATION_ERRORS.idRequired };
  }
  return { ok: true, value: input };
}

export type PaymentSourceFormInput = {
  name: unknown;
  type: unknown;
};

export type ValidatedPaymentSourceInput = {
  name: string;
  type: PaymentSourceType;
};

/**
 * 追加・編集フォームの入力をまとめて検証する。
 * 最初に見つかった1件のエラーだけを返す（画面のエラー表示が1行のため）。
 */
export function validatePaymentSourceInput(
  input: PaymentSourceFormInput,
): ValidationResult<ValidatedPaymentSourceInput> {
  const name = validatePaymentSourceName(input.name);
  if (!name.ok) return name;

  const type = validatePaymentSourceType(input.type);
  if (!type.ok) return type;

  return { ok: true, value: { name: name.value, type: type.value } };
}
