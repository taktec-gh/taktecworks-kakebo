import { CostType } from "@/generated/prisma/enums";

/**
 * カテゴリのフォーム入力の検証（純粋関数）。
 *
 * - DB にも Next.js にも依存しない。例外で制御せず、必ず結果オブジェクトを返す
 * - 名前の重複は DB の @unique に任せる。ここでは判定しない
 *   （大文字小文字・全角半角の正規化もしない。利用者は本人1人だけなので過剰なため）
 * - このモジュールは Client Component からも import される。
 *   enum は `@/generated/prisma/enums`（ブラウザ安全）から取る
 */

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * 名前の最大文字数。カテゴリは 20 文字（払い出し先は 30 文字）。
 * 「食費」「日用品」のように短く、一覧で折り返さないほうが読みやすいため（docs/steps/step-4.md）。
 */
export const CATEGORY_NAME_MAX_LENGTH = 20;

/** 名前の最小文字数（trim 後） */
export const CATEGORY_NAME_MIN_LENGTH = 1;

/** 画面に出す検証エラー文言 */
export const CATEGORY_VALIDATION_ERRORS = {
  nameRequired: "名前を入力してください。",
  nameTooLong: `名前は${CATEGORY_NAME_MAX_LENGTH}文字以内で入力してください。`,
  costTypeRequired: "固定費 / 変動費を選択してください。",
  idRequired: "対象のカテゴリが指定されていません。",
} as const;

/** 固定費 / 変動費の日本語表示。一覧・編集画面で共用する */
export const COST_TYPE_LABELS: Record<CostType, string> = {
  [CostType.FIXED]: "固定費",
  [CostType.VARIABLE]: "変動費",
};

export type CostTypeOption = {
  value: CostType;
  label: string;
};

/** セレクトボックスの選択肢。新規カテゴリの既定は先頭の「変動費」 */
export const COST_TYPE_OPTIONS: readonly CostTypeOption[] = [
  { value: CostType.VARIABLE, label: COST_TYPE_LABELS[CostType.VARIABLE] },
  { value: CostType.FIXED, label: COST_TYPE_LABELS[CostType.FIXED] },
] as const;

/** 値が CostType のいずれかか */
export function isCostType(value: unknown): value is CostType {
  return value === CostType.FIXED || value === CostType.VARIABLE;
}

/**
 * 名前を検証する。前後の空白を trim してから判定し、成功時は trim 済みの値を返す。
 *
 * 文字数は「見た目の文字数」に近づけるためコードポイント単位で数える
 * （絵文字などのサロゲートペアを2文字と数えない）。
 */
export function validateCategoryName(input: unknown): ValidationResult<string> {
  if (typeof input !== "string") {
    return { ok: false, error: CATEGORY_VALIDATION_ERRORS.nameRequired };
  }

  const name = input.trim();
  const length = Array.from(name).length;

  if (length < CATEGORY_NAME_MIN_LENGTH) {
    return { ok: false, error: CATEGORY_VALIDATION_ERRORS.nameRequired };
  }
  if (length > CATEGORY_NAME_MAX_LENGTH) {
    return { ok: false, error: CATEGORY_VALIDATION_ERRORS.nameTooLong };
  }

  return { ok: true, value: name };
}

/** フォームから来た文字列を CostType に照合する。外れていれば拒否する */
export function validateCostType(input: unknown): ValidationResult<CostType> {
  if (!isCostType(input)) {
    return { ok: false, error: CATEGORY_VALIDATION_ERRORS.costTypeRequired };
  }
  return { ok: true, value: input };
}

/** 対象レコードの id。空文字・文字列以外は拒否する */
export function validateCategoryId(input: unknown): ValidationResult<string> {
  if (typeof input !== "string" || input.trim().length === 0) {
    return { ok: false, error: CATEGORY_VALIDATION_ERRORS.idRequired };
  }
  return { ok: true, value: input };
}

export type CategoryFormInput = {
  name: unknown;
  costType: unknown;
};

export type ValidatedCategoryInput = {
  name: string;
  costType: CostType;
};

/**
 * 追加・編集フォームの入力をまとめて検証する。
 * 最初に見つかった1件のエラーだけを返す（画面のエラー表示が1行のため）。
 */
export function validateCategoryInput(
  input: CategoryFormInput,
): ValidationResult<ValidatedCategoryInput> {
  const name = validateCategoryName(input.name);
  if (!name.ok) return name;

  const costType = validateCostType(input.costType);
  if (!costType.ok) return costType;

  return { ok: true, value: { name: name.value, costType: costType.value } };
}
