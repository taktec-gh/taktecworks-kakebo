/**
 * 対象月 "YYYY-MM" の生成・移動・検証（純粋関数）。
 *
 * - **JST 固定**。UTC で月を求めると日本時間の月初9時間が前月に落ちる
 *   （.claude/agents/implementer.md「日付・月境界は JST 固定」）
 * - 「今月」を求める関数は現在時刻を**引数で受け取る**。関数の中で new Date() を呼ばない。
 *   月末・年またぎの境界がテストできなくなるため（docs/steps/step-4.md）
 * - 形式の保証はアプリ層の責任。DB の VarChar(7) は形式を検証しない（docs/steps/step-2.md）
 *
 * 不正な "YYYY-MM" を渡した場合は **RangeError を投げる**。
 * 外から来た値は必ず先に validateYearMonth / isYearMonth / resolveYearMonth を通すこと。
 */

/** JST は UTC+9。夏時間はない */
export const JST_OFFSET_MINUTES = 9 * 60;

const MS_PER_MINUTE = 60_000;

/** "YYYY-MM"。月は 01〜12 のみ。桁数固定なので辞書順ソートが暦順と一致する */
const YEAR_MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

/** 扱える最小の対象月（4桁年の下限） */
export const MIN_YEAR_MONTH = "0000-01";

/** 扱える最大の対象月（4桁年の上限） */
export const MAX_YEAR_MONTH = "9999-12";

export const YEAR_MONTH_ERRORS = {
  invalid: "対象月の指定が不正です。",
  outOfRange: "その月は扱えません。",
} as const;

export type YearMonthResult<T> = { ok: true; value: T } | { ok: false; error: string };

export type YearMonthParts = {
  /** 西暦。0〜9999 */
  year: number;
  /** 1〜12 */
  month: number;
};

/** 値が "YYYY-MM" 形式か */
export function isYearMonth(value: unknown): value is string {
  return typeof value === "string" && YEAR_MONTH_PATTERN.test(value);
}

/** "YYYY-MM" を年と月に分解する。形式が不正なら null */
export function parseYearMonth(value: unknown): YearMonthParts | null {
  if (!isYearMonth(value)) return null;
  return {
    year: Number(value.slice(0, 4)),
    month: Number(value.slice(5, 7)),
  };
}

/**
 * 年と月から "YYYY-MM" を組み立てる。
 * 年は 0〜9999、月は 1〜12。範囲外は RangeError。
 */
export function formatYearMonth(year: number, month: number): string {
  if (!Number.isInteger(year) || !Number.isInteger(month)) {
    throw new RangeError(`invalid year-month: ${year}-${month}`);
  }
  if (year < 0 || year > 9999 || month < 1 || month > 12) {
    throw new RangeError(`year-month out of range: ${year}-${month}`);
  }
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`;
}

/**
 * 現在時刻（JST）の対象月。
 * now は必ず引数で受け取る（テストで月末・年またぎを再現できるようにするため）。
 */
export function getCurrentYearMonth(now: Date): string {
  const time = now.getTime();
  if (Number.isNaN(time)) throw new RangeError("invalid date");

  // UTC のまま +9 時間して UTC ゲッターで読むと JST の暦日になる
  const jst = new Date(time + JST_OFFSET_MINUTES * MS_PER_MINUTE);
  return formatYearMonth(jst.getUTCFullYear(), jst.getUTCMonth() + 1);
}

/**
 * 対象月を months ヶ月ずらす。負数で過去へ。
 * 不正な yearMonth、および 0000-01〜9999-12 を外れる結果は RangeError。
 */
export function shiftYearMonth(yearMonth: string, months: number): string {
  const parts = parseYearMonth(yearMonth);
  if (!parts) throw new RangeError(`invalid year-month: ${String(yearMonth)}`);
  if (!Number.isInteger(months)) throw new RangeError(`invalid months: ${String(months)}`);

  // 0 起点の通算月に直してから足すと、年またぎを条件分岐なしで扱える
  const total = parts.year * 12 + (parts.month - 1) + months;
  if (total < 0 || total > 9999 * 12 + 11) {
    throw new RangeError(`year-month out of range: ${yearMonth} ${months >= 0 ? "+" : ""}${months}`);
  }
  return formatYearMonth(Math.floor(total / 12), (total % 12) + 1);
}

/** その月だけずらせるか。前月 / 翌月ボタンの活性判定に使う */
export function canShiftYearMonth(yearMonth: string, months: number): boolean {
  try {
    shiftYearMonth(yearMonth, months);
    return true;
  } catch {
    return false;
  }
}

/** 前月 */
export function previousYearMonth(yearMonth: string): string {
  return shiftYearMonth(yearMonth, -1);
}

/** 翌月 */
export function nextYearMonth(yearMonth: string): string {
  return shiftYearMonth(yearMonth, 1);
}

/** 画面見出し用の表示。"2026-08" → "2026年8月"（月の先頭 0 は落とす） */
export function formatYearMonthLabel(yearMonth: string): string {
  const parts = parseYearMonth(yearMonth);
  if (!parts) throw new RangeError(`invalid year-month: ${String(yearMonth)}`);
  return `${parts.year}年${parts.month}月`;
}

/** 外から来た値の検証。成功なら "YYYY-MM" をそのまま返す */
export function validateYearMonth(input: unknown): YearMonthResult<string> {
  if (!isYearMonth(input)) return { ok: false, error: YEAR_MONTH_ERRORS.invalid };
  return { ok: true, value: input };
}

/**
 * クエリ文字列などの指定から対象月を決める。
 * 指定がない・形式が不正なときは今月（JST）へ落とす。
 * 配列（?month=a&month=b）は指定なし扱い。
 */
export function resolveYearMonth(input: unknown, now: Date): string {
  return isYearMonth(input) ? input : getCurrentYearMonth(now);
}
