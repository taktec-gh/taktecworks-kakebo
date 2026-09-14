/**
 * 支出日（"YYYY-MM-DD"）の生成・検証・変換と、@db.Date の検索範囲の組み立て（純粋関数）。
 *
 * **ここが Step 5 で最も壊れやすい箇所。用途ごとに関数を分けてある。**
 *
 * 1. 「今日は何日か」を求める処理（getCurrentDate）は **JST 固定**。
 *    UTC で求めると日本時間の 0:00〜8:59 が前日に落ちる。
 * 2. 保存された Expense.date は `@db.Date` で**時刻を持たない純粋な日付**であり、
 *    Prisma は UTC 深夜の Date として読み書きする。したがって
 *    「2026年8月の支出」の検索範囲は `2026-08-01T00:00:00.000Z` 以上
 *    `2026-09-01T00:00:00.000Z` 未満になる。
 *    **ここで JST の +9 時間を足してはいけない。** 足すと月初・月末が1日ずれる
 *    （docs/steps/step-5.md「@db.Date の月範囲検索は UTC 基準で組み立てる」）。
 *
 * DB にも Next.js にも依存しない。
 */

import { formatYearMonth, JST_OFFSET_MINUTES, parseYearMonth } from "@/lib/year-month";

const MS_PER_MINUTE = 60_000;

/** "YYYY-MM-DD"。桁数固定なので辞書順ソートが暦順と一致する */
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** 曜日の表示。getUTCDay() の 0（日曜）始まりに合わせる */
const WEEKDAY_LABELS = ["日", "月", "火", "水", "木", "金", "土"] as const;

export type DateParts = {
  /** 西暦。0〜9999 */
  year: number;
  /** 1〜12 */
  month: number;
  /** 1〜31 */
  day: number;
};

/** @db.Date の検索範囲。gte 以上 lt 未満（lt は翌月の1日） */
export type DateRange = {
  gte: Date;
  lt: Date;
};

/**
 * 年・月・日から UTC 深夜の Date を作る。
 *
 * `Date.UTC` は年 0〜99 を 1900 年代に写してしまうため使わない。
 * 月・日のはみ出し（month=13 など）は繰り上がりとして扱われる。
 */
function utcMidnight(year: number, month: number, day: number): Date {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(0, 0, 0, 0);
  return date;
}

/** その年月の日数。month は 1〜12 */
export function getDaysInMonth(year: number, month: number): number {
  // 翌月の 0 日目 = 当月の末日
  return utcMidnight(year, month + 1, 0).getUTCDate();
}

/** 値が "YYYY-MM-DD" 形式で、かつ実在する日付か */
export function isDateString(value: unknown): value is string {
  if (typeof value !== "string" || !DATE_PATTERN.test(value)) return false;

  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));

  if (month < 1 || month > 12) return false;
  if (day < 1 || day > getDaysInMonth(year, month)) return false;
  return true;
}

/** "YYYY-MM-DD" を年・月・日に分解する。形式が不正・実在しない日付なら null */
export function parseDateString(value: unknown): DateParts | null {
  if (!isDateString(value)) return null;
  return {
    year: Number(value.slice(0, 4)),
    month: Number(value.slice(5, 7)),
    day: Number(value.slice(8, 10)),
  };
}

/**
 * 年・月・日から "YYYY-MM-DD" を組み立てる。
 * 実在しない日付（2026-02-30 など）と範囲外は RangeError。
 */
export function formatDateString(year: number, month: number, day: number): string {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    throw new RangeError(`invalid date: ${year}-${month}-${day}`);
  }
  if (year < 0 || year > 9999 || month < 1 || month > 12) {
    throw new RangeError(`date out of range: ${year}-${month}-${day}`);
  }
  if (day < 1 || day > getDaysInMonth(year, month)) {
    throw new RangeError(`date out of range: ${year}-${month}-${day}`);
  }
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * 今日（JST）の日付を "YYYY-MM-DD" で返す。
 *
 * now は必ず引数で受け取る（日付境界をテストできるようにするため）。
 * **この関数だけが JST の +9 時間を使う。** 保存済みの日付の解釈には使わない。
 */
export function getCurrentDate(now: Date): string {
  const time = now.getTime();
  if (Number.isNaN(time)) throw new RangeError("invalid date");

  // UTC のまま +9 時間して UTC ゲッターで読むと JST の暦日になる
  const jst = new Date(time + JST_OFFSET_MINUTES * MS_PER_MINUTE);
  return formatDateString(jst.getUTCFullYear(), jst.getUTCMonth() + 1, jst.getUTCDate());
}

/**
 * "YYYY-MM-DD" を `@db.Date` に渡す Date（**UTC 深夜**）へ変換する。
 * 不正な日付は RangeError。外から来た値は先に validateExpenseDate を通すこと。
 */
export function toDbDate(dateString: string): Date {
  const parts = parseDateString(dateString);
  if (!parts) throw new RangeError(`invalid date: ${String(dateString)}`);
  return utcMidnight(parts.year, parts.month, parts.day);
}

/**
 * `@db.Date` から読んだ Date を "YYYY-MM-DD" に戻す。
 *
 * **UTC ゲッターで読む。** ローカルタイムゾーンのゲッターを使うと、
 * UTC より西のタイムゾーンで実行したときに1日前になる。
 */
export function fromDbDate(date: Date): string {
  const time = date.getTime();
  if (Number.isNaN(time)) throw new RangeError("invalid date");
  return formatDateString(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

/** "YYYY-MM-DD" の属する対象月 "YYYY-MM" */
export function getYearMonthOfDate(dateString: string): string {
  const parts = parseDateString(dateString);
  if (!parts) throw new RangeError(`invalid date: ${String(dateString)}`);
  return formatYearMonth(parts.year, parts.month);
}

/**
 * 対象月 "YYYY-MM" から `@db.Date` の検索範囲を組み立てる。
 *
 * **UTC 深夜で組み立てる。現在時刻にもタイムゾーンにも依存しない。**
 * `@db.Date` は時刻を持たない日付なので、JST の +9 時間を足すと
 * 月初（1日）が前月に、月末が翌月に落ちる。
 *
 * 例: "2026-08" → gte 2026-08-01T00:00:00.000Z / lt 2026-09-01T00:00:00.000Z
 */
export function getMonthDateRange(yearMonth: string): DateRange {
  const parts = parseYearMonth(yearMonth);
  if (!parts) throw new RangeError(`invalid year-month: ${String(yearMonth)}`);

  return {
    gte: utcMidnight(parts.year, parts.month, 1),
    // 月のはみ出しは繰り上がる（12月なら翌年1月1日）
    lt: utcMidnight(parts.year, parts.month + 1, 1),
  };
}

/**
 * 日付を days 日ずらす。負数で過去へ。
 * 結果が 0000-01-01〜9999-12-31 を外れる場合は RangeError。
 */
export function addDaysToDate(dateString: string, days: number): string {
  const parts = parseDateString(dateString);
  if (!parts) throw new RangeError(`invalid date: ${String(dateString)}`);
  if (!Number.isInteger(days)) throw new RangeError(`invalid days: ${String(days)}`);

  const shifted = utcMidnight(parts.year, parts.month, parts.day + days);
  return fromDbDate(shifted);
}

/**
 * 日付を years 年ずらす。
 * 2月29日のように移動先に存在しない日は、その月の末日へ丸める（3月1日にしない）。
 */
export function addYearsToDate(dateString: string, years: number): string {
  const parts = parseDateString(dateString);
  if (!parts) throw new RangeError(`invalid date: ${String(dateString)}`);
  if (!Number.isInteger(years)) throw new RangeError(`invalid years: ${String(years)}`);

  const year = parts.year + years;
  if (year < 0 || year > 9999) {
    throw new RangeError(`date out of range: ${dateString} ${years >= 0 ? "+" : ""}${years}y`);
  }
  const day = Math.min(parts.day, getDaysInMonth(year, parts.month));
  return formatDateString(year, parts.month, day);
}

/**
 * 日付の比較。"YYYY-MM-DD" は桁数固定なので辞書順が暦順と一致する。
 * a < b なら負、a > b なら正、同じなら 0。
 */
export function compareDateStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * 一覧用の短い表示。"2026-08-13" → "8/13(木)"。
 * 曜日は `@db.Date` と同じく UTC の暦で求める（タイムゾーンで1日ずれないため）。
 */
export function formatDateLabel(dateString: string): string {
  const parts = parseDateString(dateString);
  if (!parts) throw new RangeError(`invalid date: ${String(dateString)}`);

  const weekday = WEEKDAY_LABELS[utcMidnight(parts.year, parts.month, parts.day).getUTCDay()];
  return `${parts.month}/${parts.day}(${weekday ?? ""})`;
}

/** 年を含む表示。"2026-08-13" → "2026/8/13(木)" */
export function formatDateFullLabel(dateString: string): string {
  const parts = parseDateString(dateString);
  if (!parts) throw new RangeError(`invalid date: ${String(dateString)}`);
  return `${parts.year}/${formatDateLabel(dateString)}`;
}
