import { formatGroupedNumber, normalizeAmountInput } from "@/lib/amount-input";
import { BUDGET_AMOUNT_MAX_YEN } from "@/lib/budget-calculation";
import { validateYearMonth } from "@/lib/year-month";

/**
 * 収入のフォーム入力の検証（純粋関数）。
 *
 * - DB にも Next.js にも依存しない。例外で制御せず、必ず結果オブジェクトを返す
 * - このモジュールは Client Component からも import される
 * - 金額の書式（全角数字・カンマ・空白）の正規化は予算・支出と共通
 *   （src/lib/amount-input.ts）。違うのは**空欄の意味と下限**だけ
 *
 * 収入は「未設定の収入」という概念が無いので**空欄はエラー**、
 * 0円の収入を登録する意味も無いので**下限は 1 円**（docs/steps/step-6.md）。
 */

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** 金額の下限（円）。0円の収入を登録する意味が無い */
export const INCOME_AMOUNT_MIN_YEN = 1;

/** 金額の上限（円）。予算と同じ（桁の入れすぎを検出するための上限） */
export const INCOME_AMOUNT_MAX_YEN = BUDGET_AMOUNT_MAX_YEN;

/** ラベルの最大文字数（コードポイント単位）。未入力（null）も許す */
export const INCOME_LABEL_MAX_LENGTH = 20;

/** 画面に出す検証エラー文言 */
export const INCOME_VALIDATION_ERRORS = {
  amountRequired: "金額を入力してください。",
  amountInvalid: "金額は数字で入力してください。",
  amountNotInteger: "金額は1円単位の整数で入力してください。",
  amountTooSmall: `金額は${INCOME_AMOUNT_MIN_YEN}円以上で入力してください。`,
  amountTooLarge: `金額は${formatGroupedNumber(INCOME_AMOUNT_MAX_YEN)}円以下で入力してください。`,
  labelTooLong: `ラベルは${INCOME_LABEL_MAX_LENGTH}文字以内で入力してください。`,
  idRequired: "対象の収入が指定されていません。",
} as const;

/** 拒否理由 → 収入向けの文言。空欄（null）はここでは扱わない */
const AMOUNT_ERROR_BY_REASON = {
  invalid: INCOME_VALIDATION_ERRORS.amountInvalid,
  notInteger: INCOME_VALIDATION_ERRORS.amountNotInteger,
  // 下限は 1 円なので、マイナスも「1円以上で」と案内するのが分かりやすい
  negative: INCOME_VALIDATION_ERRORS.amountTooSmall,
  tooLarge: INCOME_VALIDATION_ERRORS.amountTooLarge,
} as const;

/** 金額を検証する。1〜99,999,999 の整数円。**空欄はエラー** */
export function validateIncomeAmount(input: unknown): ValidationResult<number> {
  const normalized = normalizeAmountInput(input);
  if (!normalized.ok) {
    return { ok: false, error: AMOUNT_ERROR_BY_REASON[normalized.reason] };
  }
  if (normalized.value === null) {
    return { ok: false, error: INCOME_VALIDATION_ERRORS.amountRequired };
  }
  if (normalized.value < INCOME_AMOUNT_MIN_YEN) {
    return { ok: false, error: INCOME_VALIDATION_ERRORS.amountTooSmall };
  }
  if (normalized.value > INCOME_AMOUNT_MAX_YEN) {
    return { ok: false, error: INCOME_VALIDATION_ERRORS.amountTooLarge };
  }
  return { ok: true, value: normalized.value };
}

/**
 * ラベル（「給与」「賞与」など）。任意。
 * 前後の空白を落とし、空文字なら null。文字数はコードポイント単位で数える。
 */
export function validateIncomeLabel(input: unknown): ValidationResult<string | null> {
  if (input === null || input === undefined) return { ok: true, value: null };
  if (typeof input !== "string") {
    return { ok: false, error: INCOME_VALIDATION_ERRORS.labelTooLong };
  }

  const label = input.trim();
  if (label.length === 0) return { ok: true, value: null };
  if (Array.from(label).length > INCOME_LABEL_MAX_LENGTH) {
    return { ok: false, error: INCOME_VALIDATION_ERRORS.labelTooLong };
  }
  return { ok: true, value: label };
}

/** 対象レコードの id。空文字・文字列以外は拒否する */
export function validateIncomeId(input: unknown): ValidationResult<string> {
  if (typeof input !== "string" || input.trim().length === 0) {
    return { ok: false, error: INCOME_VALIDATION_ERRORS.idRequired };
  }
  return { ok: true, value: input };
}

export type IncomeFormInput = {
  /** 「受け取った月」。7/25 に振り込まれた給与は "2026-07" */
  yearMonth: unknown;
  amount: unknown;
  label: unknown;
};

export type ValidatedIncomeInput = {
  yearMonth: string;
  amountYen: number;
  label: string | null;
};

/**
 * 追加フォームの入力をまとめて検証する。
 * 最初に見つかった1件のエラーだけを返す（画面のエラー表示が1行のため）。
 *
 * 順番は入力欄の並び（金額 → ラベル）に合わせ、隠しフィールドの対象月は最後に見る。
 * 利用者が直せる欄のエラーを先に見せるため。
 */
export function validateIncomeInput(
  input: IncomeFormInput,
): ValidationResult<ValidatedIncomeInput> {
  const amountYen = validateIncomeAmount(input.amount);
  if (!amountYen.ok) return amountYen;

  const label = validateIncomeLabel(input.label);
  if (!label.ok) return label;

  const yearMonth = validateYearMonth(input.yearMonth);
  if (!yearMonth.ok) return yearMonth;

  return {
    ok: true,
    value: {
      yearMonth: yearMonth.value,
      amountYen: amountYen.value,
      label: label.value,
    },
  };
}
