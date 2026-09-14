import { WasteTag } from "@/generated/prisma/enums";
import { formatGroupedNumber, normalizeAmountInput } from "@/lib/amount-input";
import {
  addYearsToDate,
  compareDateStrings,
  getCurrentDate,
  isDateString,
} from "@/lib/expense-date";

/**
 * 支出のフォーム入力の検証（純粋関数）。
 *
 * - DB にも Next.js にも依存しない。例外で制御せず、必ず結果オブジェクトを返す
 * - このモジュールは Client Component からも import される。
 *   enum は `@/generated/prisma/enums`（ブラウザ安全）から取る
 * - 「今日」が要る検証（日付の上限）は現在時刻を**引数で受け取る**
 */

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * 金額の下限（円）。**支出に0円は無い**（予算は0円を認めるが支出は認めない。
 * docs/steps/step-5.md「金額は1円以上」）。
 */
export const EXPENSE_AMOUNT_MIN_YEN = 1;

/** 金額の上限（円）。桁の入れすぎ（打ち間違い）を検出するための上限 */
export const EXPENSE_AMOUNT_MAX_YEN = 99_999_999;

/** 日付の下限。打ち間違いを弾くための緩い下限 */
export const EXPENSE_DATE_MIN = "2000-01-01";

/**
 * 日付の上限は「今日 + この年数」。
 * 未来日そのものは拒否しない（前払いを記録したい場合がある）。
 * "2206-08-13" のような桁の打ち間違いだけを弾く（docs/steps/step-5.md）。
 */
export const EXPENSE_DATE_MAX_YEARS_AHEAD = 1;

/** 店名の最大文字数（コードポイント単位）。0 文字（未入力）も許す */
export const STORE_NAME_MAX_LENGTH = 50;

/** メモの最大文字数（コードポイント単位）。0 文字（未入力）も許す */
export const MEMO_MAX_LENGTH = 200;

/** 画面に出す検証エラー文言 */
export const EXPENSE_VALIDATION_ERRORS = {
  amountRequired: "金額を入力してください。",
  amountInvalid: "金額は数字で入力してください。",
  amountNotInteger: "金額は1円単位の整数で入力してください。",
  amountTooSmall: `金額は${EXPENSE_AMOUNT_MIN_YEN}円以上で入力してください。`,
  amountTooLarge: `金額は${formatGroupedNumber(EXPENSE_AMOUNT_MAX_YEN)}円以下で入力してください。`,
  dateRequired: "日付を入力してください。",
  dateInvalid: "日付の形式が正しくありません。",
  dateOutOfRange: "日付が扱える範囲を超えています。入力を確認してください。",
  categoryRequired: "カテゴリを選択してください。",
  paymentSourceRequired: "払い出し先を選択してください。",
  wasteTagRequired: "必要 / 浪費 / 投資 を選択してください。",
  storeNameTooLong: `店名は${STORE_NAME_MAX_LENGTH}文字以内で入力してください。`,
  memoTooLong: `メモは${MEMO_MAX_LENGTH}文字以内で入力してください。`,
  idRequired: "対象の支出が指定されていません。",
} as const;

/** 浪費フラグの日本語表示（features.md「必要・浪費・投資 の3択」） */
export const WASTE_TAG_LABELS: Record<WasteTag, string> = {
  [WasteTag.NECESSARY]: "必要",
  [WasteTag.WASTE]: "浪費",
  [WasteTag.INVESTMENT]: "投資",
};

export type WasteTagOption = {
  value: WasteTag;
  label: string;
};

/** 選択肢。features.md の記載順（必要 → 浪費 → 投資） */
export const WASTE_TAG_OPTIONS: readonly WasteTagOption[] = [
  { value: WasteTag.NECESSARY, label: WASTE_TAG_LABELS[WasteTag.NECESSARY] },
  { value: WasteTag.WASTE, label: WASTE_TAG_LABELS[WasteTag.WASTE] },
  { value: WasteTag.INVESTMENT, label: WASTE_TAG_LABELS[WasteTag.INVESTMENT] },
] as const;

/**
 * 新規登録時の既定。
 * 大半の支出は「必要」であり、浪費のときだけ1タップ増やすほうが総タップ数が少ない
 * （docs/steps/step-5.md）。
 */
export const DEFAULT_WASTE_TAG: WasteTag = WasteTag.NECESSARY;

/** 拒否理由 → 支出向けの文言。空欄（null）はここでは扱わない */
const AMOUNT_ERROR_BY_REASON = {
  invalid: EXPENSE_VALIDATION_ERRORS.amountInvalid,
  notInteger: EXPENSE_VALIDATION_ERRORS.amountNotInteger,
  // 支出の下限は 1 円なので、マイナスも「1円以上で」と案内するのが分かりやすい
  negative: EXPENSE_VALIDATION_ERRORS.amountTooSmall,
  tooLarge: EXPENSE_VALIDATION_ERRORS.amountTooLarge,
} as const;

/**
 * 金額を検証する。1〜99,999,999 の整数円。
 *
 * 書式の正規化（全角数字・カンマの受け入れ、小数・マイナスの拒否）は予算と共通
 * （src/lib/amount-input.ts）。**空欄は予算と違いエラー**で、支出に「未設定」は無い。
 */
export function validateExpenseAmount(input: unknown): ValidationResult<number> {
  const normalized = normalizeAmountInput(input);
  if (!normalized.ok) {
    return { ok: false, error: AMOUNT_ERROR_BY_REASON[normalized.reason] };
  }
  if (normalized.value === null) {
    return { ok: false, error: EXPENSE_VALIDATION_ERRORS.amountRequired };
  }
  if (normalized.value < EXPENSE_AMOUNT_MIN_YEN) {
    return { ok: false, error: EXPENSE_VALIDATION_ERRORS.amountTooSmall };
  }
  if (normalized.value > EXPENSE_AMOUNT_MAX_YEN) {
    return { ok: false, error: EXPENSE_VALIDATION_ERRORS.amountTooLarge };
  }
  return { ok: true, value: normalized.value };
}

/** その時点で入力できる日付の上限 "YYYY-MM-DD"（今日(JST) + 1年） */
export function getMaxExpenseDate(now: Date): string {
  return addYearsToDate(getCurrentDate(now), EXPENSE_DATE_MAX_YEARS_AHEAD);
}

/**
 * 日付を検証する。"YYYY-MM-DD" で、EXPENSE_DATE_MIN 〜 今日(JST)+1年 の範囲。
 *
 * 未来日そのものは拒否しない（前払いを記録したい場合がある）。
 * 上限は "2206-08-13" のような桁の打ち間違いを弾くための緩いもの。
 */
export function validateExpenseDate(input: unknown, now: Date): ValidationResult<string> {
  if (typeof input !== "string" || input.trim().length === 0) {
    return { ok: false, error: EXPENSE_VALIDATION_ERRORS.dateRequired };
  }
  const date = input.trim();
  if (!isDateString(date)) {
    return { ok: false, error: EXPENSE_VALIDATION_ERRORS.dateInvalid };
  }
  if (compareDateStrings(date, EXPENSE_DATE_MIN) < 0) {
    return { ok: false, error: EXPENSE_VALIDATION_ERRORS.dateOutOfRange };
  }
  if (compareDateStrings(date, getMaxExpenseDate(now)) > 0) {
    return { ok: false, error: EXPENSE_VALIDATION_ERRORS.dateOutOfRange };
  }
  return { ok: true, value: date };
}

/** 値が WasteTag のいずれかか */
export function isWasteTag(value: unknown): value is WasteTag {
  return (
    value === WasteTag.NECESSARY ||
    value === WasteTag.WASTE ||
    value === WasteTag.INVESTMENT
  );
}

/** フォームから来た文字列を WasteTag に照合する。外れていれば拒否する */
export function validateWasteTag(input: unknown): ValidationResult<WasteTag> {
  if (!isWasteTag(input)) {
    return { ok: false, error: EXPENSE_VALIDATION_ERRORS.wasteTagRequired };
  }
  return { ok: true, value: input };
}

/** カテゴリの選択。未選択（空文字）は拒否する */
export function validateExpenseCategoryId(input: unknown): ValidationResult<string> {
  if (typeof input !== "string" || input.trim().length === 0) {
    return { ok: false, error: EXPENSE_VALIDATION_ERRORS.categoryRequired };
  }
  return { ok: true, value: input };
}

/** 払い出し先の選択。未選択（空文字）は拒否する */
export function validateExpensePaymentSourceId(input: unknown): ValidationResult<string> {
  if (typeof input !== "string" || input.trim().length === 0) {
    return { ok: false, error: EXPENSE_VALIDATION_ERRORS.paymentSourceRequired };
  }
  return { ok: true, value: input };
}

/** 対象レコードの id。空文字・文字列以外は拒否する */
export function validateExpenseId(input: unknown): ValidationResult<string> {
  if (typeof input !== "string" || input.trim().length === 0) {
    return { ok: false, error: EXPENSE_VALIDATION_ERRORS.idRequired };
  }
  return { ok: true, value: input };
}

/**
 * 店名。未入力は null（DB も nullable）。前後の空白は trim する。
 * 文字数はコードポイント単位で数える（絵文字を2文字と数えない）。
 */
export function validateStoreName(input: unknown): ValidationResult<string | null> {
  if (input === null || input === undefined) return { ok: true, value: null };
  if (typeof input !== "string") {
    return { ok: false, error: EXPENSE_VALIDATION_ERRORS.storeNameTooLong };
  }

  const storeName = input.trim();
  if (storeName.length === 0) return { ok: true, value: null };
  if (Array.from(storeName).length > STORE_NAME_MAX_LENGTH) {
    return { ok: false, error: EXPENSE_VALIDATION_ERRORS.storeNameTooLong };
  }
  return { ok: true, value: storeName };
}

/** メモ。未入力は null。前後の空白は trim する */
export function validateMemo(input: unknown): ValidationResult<string | null> {
  if (input === null || input === undefined) return { ok: true, value: null };
  if (typeof input !== "string") {
    return { ok: false, error: EXPENSE_VALIDATION_ERRORS.memoTooLong };
  }

  const memo = input.trim();
  if (memo.length === 0) return { ok: true, value: null };
  if (Array.from(memo).length > MEMO_MAX_LENGTH) {
    return { ok: false, error: EXPENSE_VALIDATION_ERRORS.memoTooLong };
  }
  return { ok: true, value: memo };
}

export type ExpenseFormInput = {
  date: unknown;
  amount: unknown;
  categoryId: unknown;
  paymentSourceId: unknown;
  wasteTag: unknown;
  storeName: unknown;
  memo: unknown;
};

export type ValidatedExpenseInput = {
  /** "YYYY-MM-DD"。@db.Date へ渡すときは toDbDate で UTC 深夜に変換する */
  date: string;
  amountYen: number;
  categoryId: string;
  paymentSourceId: string;
  wasteTag: WasteTag;
  storeName: string | null;
  memo: string | null;
};

/**
 * 登録・編集フォームの入力をまとめて検証する。
 * 最初に見つかった1件のエラーだけを返す（画面のエラー表示が1行のため）。
 *
 * 検証の順番は入力欄の並び順に合わせる（金額 → カテゴリ → …）。
 * 「金額を入れてカテゴリを選ぶ」が主動線なので、そこのエラーを先に見せる。
 */
export function validateExpenseInput(
  input: ExpenseFormInput,
  now: Date,
): ValidationResult<ValidatedExpenseInput> {
  const amount = validateExpenseAmount(input.amount);
  if (!amount.ok) return amount;

  const categoryId = validateExpenseCategoryId(input.categoryId);
  if (!categoryId.ok) return categoryId;

  const wasteTag = validateWasteTag(input.wasteTag);
  if (!wasteTag.ok) return wasteTag;

  const paymentSourceId = validateExpensePaymentSourceId(input.paymentSourceId);
  if (!paymentSourceId.ok) return paymentSourceId;

  const date = validateExpenseDate(input.date, now);
  if (!date.ok) return date;

  const storeName = validateStoreName(input.storeName);
  if (!storeName.ok) return storeName;

  const memo = validateMemo(input.memo);
  if (!memo.ok) return memo;

  return {
    ok: true,
    value: {
      date: date.value,
      amountYen: amount.value,
      categoryId: categoryId.value,
      paymentSourceId: paymentSourceId.value,
      wasteTag: wasteTag.value,
      storeName: storeName.value,
      memo: memo.value,
    },
  };
}
