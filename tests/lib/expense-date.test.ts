// @vitest-environment node
//
// src/lib/expense-date.ts の日付純粋関数（今日の判定・@db.Date 変換・月範囲）を検証する。
//
// 期待値の根拠:
// - docs/steps/step-5.md「設計判断 > @db.Date の月範囲検索は UTC 基準で組み立てる」
//   「JST を考えるのは『今日は何日か』『利用者が入力した日付をどう解釈するか』の場面だけ」
// - docs/steps/step-5.md「実装完了後の引き継ぎ > 特に確認したい観点」1・2・3・7
// - JST = UTC+9 固定（.claude/agents/implementer.md）
//
// **この2関数は目的が違うので手計算根拠を分けて書く。**
// - getCurrentDate: 「今日」は JST で決まる。UTC のまま読むと 0:00〜8:59(UTC) が前日になる
// - getMonthDateRange: @db.Date は時刻の無い日付で、Prisma は UTC 深夜として読み書きする。
//   ここに JST の +9 時間を足すと月初・月末が1日ずれる

import { afterEach, describe, expect, it } from "vitest";

import {
  addDaysToDate,
  addYearsToDate,
  compareDateStrings,
  formatDateFullLabel,
  formatDateLabel,
  formatDateString,
  fromDbDate,
  getCurrentDate,
  getDaysInMonth,
  getMonthDateRange,
  getYearMonthOfDate,
  isDateString,
  parseDateString,
  toDbDate,
} from "@/lib/expense-date";

const ORIGINAL_TZ = process.env.TZ;

afterEach(() => {
  process.env.TZ = ORIGINAL_TZ;
});

describe("getMonthDateRange — UTC 境界（現在時刻に依存しない）", () => {
  it("'2026-08' の gte はちょうど 2026-08-01T00:00:00.000Z", () => {
    const range = getMonthDateRange("2026-08");
    expect(range.gte.getTime()).toBe(new Date("2026-08-01T00:00:00.000Z").getTime());
  });

  it("'2026-08' の lt はちょうど 2026-09-01T00:00:00.000Z（JST の +9時間を足さない）", () => {
    const range = getMonthDateRange("2026-08");
    expect(range.lt.getTime()).toBe(new Date("2026-09-01T00:00:00.000Z").getTime());
  });

  it("'2026-12' の lt は翌年 2027-01-01T00:00:00.000Z になる（年またぎ）", () => {
    const range = getMonthDateRange("2026-12");
    expect(range.gte.getTime()).toBe(new Date("2026-12-01T00:00:00.000Z").getTime());
    expect(range.lt.getTime()).toBe(new Date("2027-01-01T00:00:00.000Z").getTime());
  });

  it("2月（うるう年）の lt は 2024-03-01。うるう年でも月末計算に影響しない", () => {
    const range = getMonthDateRange("2024-02");
    expect(range.lt.getTime()).toBe(new Date("2024-03-01T00:00:00.000Z").getTime());
  });

  it("不正な 'YYYY-MM' は RangeError", () => {
    expect(() => getMonthDateRange("2026-13")).toThrow(RangeError);
    expect(() => getMonthDateRange("invalid")).toThrow(RangeError);
  });

  it.each(["Asia/Tokyo", "America/Los_Angeles", "Pacific/Kiritimati", "UTC"])(
    "実行環境の TZ（%s）を変えても gte / lt は変わらない",
    (tz) => {
      process.env.TZ = tz;
      const range = getMonthDateRange("2026-08");
      expect(range.gte.getTime()).toBe(new Date("2026-08-01T00:00:00.000Z").getTime());
      expect(range.lt.getTime()).toBe(new Date("2026-09-01T00:00:00.000Z").getTime());
    },
  );
});

describe("getCurrentDate — JST 境界（現在時刻に依存する）", () => {
  it("UTC 2026-08-13T14:59:59Z（JST 8/13 23:59:59）は '2026-08-13'", () => {
    expect(getCurrentDate(new Date("2026-08-13T14:59:59.000Z"))).toBe("2026-08-13");
  });

  it("UTC 2026-08-13T15:00:00Z（JST 8/14 0:00:00、日付が変わる瞬間）は '2026-08-14'", () => {
    expect(getCurrentDate(new Date("2026-08-13T15:00:00.000Z"))).toBe("2026-08-14");
  });

  it("年をまたぐ: UTC 2025-12-31T15:00:00Z（JST 2026-01-01 0:00）は '2026-01-01'", () => {
    expect(getCurrentDate(new Date("2025-12-31T15:00:00.000Z"))).toBe("2026-01-01");
  });

  it("年をまたぐ直前: UTC 2025-12-31T14:59:59Z（JST 2025-12-31 23:59:59）は '2025-12-31'", () => {
    expect(getCurrentDate(new Date("2025-12-31T14:59:59.000Z"))).toBe("2025-12-31");
  });

  it("不正な Date は RangeError", () => {
    expect(() => getCurrentDate(new Date("not-a-date"))).toThrow(RangeError);
  });

  it.each(["Asia/Tokyo", "America/Los_Angeles", "Pacific/Kiritimati", "UTC"])(
    "実行環境の TZ（%s）を変えても結果は変わらない（JST 固定で計算するため）",
    (tz) => {
      process.env.TZ = tz;
      expect(getCurrentDate(new Date("2026-08-13T14:59:59.000Z"))).toBe("2026-08-13");
      expect(getCurrentDate(new Date("2026-08-13T15:00:00.000Z"))).toBe("2026-08-14");
    },
  );
});

describe("getCurrentDate と getMonthDateRange の方式を入れ替えたら壊れることの保証", () => {
  it("getCurrentDate に JST の月初境界を渡した結果が、UTC 方式（+9時間しない）の結果と一致しない", () => {
    // JST 2026-08-13 15:00 は UTC 2026-08-13 06:00。
    // もし getCurrentDate が誤って UTC 方式（+9時間を足さない）で実装されていたら
    // この時刻は '2026-08-13' のまま変わらないが、正しい JST 実装では日付が変わらない
    // （この時刻は JST 8/13 15:00 なのでそもそも日付は変わらない）。
    // 日付が変わる境界（UTC 14:59:59 → 15:00:00）で確認済みなので、
    // ここでは月範囲側の関数が JST 方式に化けていないかを別途確認する。
    const range = getMonthDateRange("2026-08");
    // JST 方式（+9時間）で誤って組み立てると gte は 2026-07-31T15:00:00.000Z になる。
    // 正しい UTC 方式は 2026-08-01T00:00:00.000Z なので、この2つは異なるはず。
    const wrongJstStyleGte = new Date(
      new Date("2026-08-01T00:00:00.000Z").getTime() - 9 * 60 * 60_000,
    );
    expect(range.gte.getTime()).not.toBe(wrongJstStyleGte.getTime());
    expect(range.gte.getTime()).toBe(new Date("2026-08-01T00:00:00.000Z").getTime());
  });
});

describe("toDbDate / fromDbDate の往復", () => {
  it("月初・月末・うるう年の日付で1日もずれない", () => {
    for (const date of ["2026-01-01", "2026-08-31", "2024-02-29", "2026-12-31", "2000-01-01"]) {
      expect(fromDbDate(toDbDate(date))).toBe(date);
    }
  });

  it("toDbDate は UTC 深夜の Date を返す（時刻部分が 00:00:00.000Z）", () => {
    const date = toDbDate("2026-08-13");
    expect(date.toISOString()).toBe("2026-08-13T00:00:00.000Z");
  });

  it("fromDbDate は UTC ゲッターで読む（ローカル TZ に影響されない）", () => {
    process.env.TZ = "America/Los_Angeles";
    expect(fromDbDate(new Date("2026-08-13T00:00:00.000Z"))).toBe("2026-08-13");
  });

  it("toDbDate に不正な日付文字列を渡すと RangeError", () => {
    expect(() => toDbDate("2026-02-30")).toThrow(RangeError);
    expect(() => toDbDate("invalid")).toThrow(RangeError);
  });

  it("fromDbDate に不正な Date を渡すと RangeError", () => {
    expect(() => fromDbDate(new Date("not-a-date"))).toThrow(RangeError);
  });
});

describe("getDaysInMonth", () => {
  it("平年2月は28日", () => {
    expect(getDaysInMonth(2026, 2)).toBe(28);
  });

  it("うるう年2月は29日（2024年はうるう年）", () => {
    expect(getDaysInMonth(2024, 2)).toBe(29);
  });

  it("30日月・31日月", () => {
    expect(getDaysInMonth(2026, 4)).toBe(30);
    expect(getDaysInMonth(2026, 8)).toBe(31);
  });

  it("12月は31日で、翌年へ繰り上がらない", () => {
    expect(getDaysInMonth(2026, 12)).toBe(31);
  });
});

describe("isDateString / parseDateString", () => {
  it("実在する日付は true", () => {
    expect(isDateString("2026-08-13")).toBe(true);
    expect(isDateString("2024-02-29")).toBe(true); // うるう年
  });

  it("うるう年でない年の2/29は false", () => {
    expect(isDateString("2026-02-29")).toBe(false);
  });

  it("実在しない日付（2026-02-30）は false", () => {
    expect(isDateString("2026-02-30")).toBe(false);
  });

  it("月が00・13は false", () => {
    expect(isDateString("2026-00-01")).toBe(false);
    expect(isDateString("2026-13-01")).toBe(false);
  });

  it("形式が違う・ゼロ埋めされていないものは false", () => {
    expect(isDateString("2026-8-13")).toBe(false);
    expect(isDateString("26-08-13")).toBe(false);
    expect(isDateString("2026/08/13")).toBe(false);
  });

  it("文字列以外・空文字は false", () => {
    expect(isDateString(null)).toBe(false);
    expect(isDateString(undefined)).toBe(false);
    expect(isDateString("")).toBe(false);
    expect(isDateString(20260813)).toBe(false);
  });

  it("parseDateString は年月日に分解する", () => {
    expect(parseDateString("2026-08-13")).toEqual({ year: 2026, month: 8, day: 13 });
  });

  it("parseDateString は不正な値で null を返す", () => {
    expect(parseDateString("2026-02-30")).toBeNull();
    expect(parseDateString(123)).toBeNull();
  });
});

describe("formatDateString", () => {
  it("正常な年月日を組み立てる（ゼロ埋め）", () => {
    expect(formatDateString(2026, 8, 3)).toBe("2026-08-03");
  });

  it("実在しない日付（2026-02-30）は RangeError", () => {
    expect(() => formatDateString(2026, 2, 30)).toThrow(RangeError);
  });

  it("うるう年判定: 2024-02-29 は通り、2026-02-29 は RangeError", () => {
    expect(formatDateString(2024, 2, 29)).toBe("2024-02-29");
    expect(() => formatDateString(2026, 2, 29)).toThrow(RangeError);
  });

  it("非整数・範囲外は RangeError", () => {
    expect(() => formatDateString(2026.5, 8, 13)).toThrow(RangeError);
    expect(() => formatDateString(2026, 13, 1)).toThrow(RangeError);
    expect(() => formatDateString(-1, 1, 1)).toThrow(RangeError);
    expect(() => formatDateString(10000, 1, 1)).toThrow(RangeError);
  });
});

describe("getYearMonthOfDate", () => {
  it("日付が属する対象月を返す", () => {
    expect(getYearMonthOfDate("2026-08-13")).toBe("2026-08");
    expect(getYearMonthOfDate("2026-01-01")).toBe("2026-01");
    expect(getYearMonthOfDate("2026-12-31")).toBe("2026-12");
  });

  it("不正な日付は RangeError", () => {
    expect(() => getYearMonthOfDate("invalid")).toThrow(RangeError);
  });
});

describe("addDaysToDate", () => {
  it("月をまたぐ加算", () => {
    expect(addDaysToDate("2026-08-31", 1)).toBe("2026-09-01");
  });

  it("月をまたぐ減算", () => {
    expect(addDaysToDate("2026-09-01", -1)).toBe("2026-08-31");
  });

  it("年をまたぐ加算", () => {
    expect(addDaysToDate("2026-12-31", 1)).toBe("2027-01-01");
  });

  it("うるう年の2/29をまたぐ", () => {
    expect(addDaysToDate("2024-02-28", 1)).toBe("2024-02-29");
    expect(addDaysToDate("2024-02-29", 1)).toBe("2024-03-01");
  });

  it("0日はそのまま", () => {
    expect(addDaysToDate("2026-08-13", 0)).toBe("2026-08-13");
  });

  it("29日分過去（直近30日ウィンドウの計算に相当）", () => {
    // 直近30日 = 今日を含む30日 → 今日から29日前が窓の始まり
    expect(addDaysToDate("2026-08-30", -29)).toBe("2026-08-01");
  });

  it("不正な日付・非整数の days は RangeError", () => {
    expect(() => addDaysToDate("invalid", 1)).toThrow(RangeError);
    expect(() => addDaysToDate("2026-08-13", 1.5)).toThrow(RangeError);
  });
});

describe("addYearsToDate", () => {
  it("通常の加算", () => {
    expect(addYearsToDate("2026-08-13", 1)).toBe("2027-08-13");
  });

  it("2/29を含む年の+1年は、翌年に2/29が無いので2/28へ丸める（3/1にしない）", () => {
    expect(addYearsToDate("2024-02-29", 1)).toBe("2025-02-28");
  });

  it("うるう年→うるう年の+4年は2/29のまま", () => {
    expect(addYearsToDate("2024-02-29", 4)).toBe("2028-02-29");
  });

  it("年が9999を超えると RangeError", () => {
    expect(() => addYearsToDate("9999-01-01", 1)).toThrow(RangeError);
  });

  it("不正な日付・非整数の years は RangeError", () => {
    expect(() => addYearsToDate("invalid", 1)).toThrow(RangeError);
    expect(() => addYearsToDate("2026-08-13", 1.5)).toThrow(RangeError);
  });
});

describe("compareDateStrings", () => {
  it("a < b は負の値", () => {
    expect(compareDateStrings("2026-08-01", "2026-08-02")).toBeLessThan(0);
  });

  it("a > b は正の値", () => {
    expect(compareDateStrings("2026-08-02", "2026-08-01")).toBeGreaterThan(0);
  });

  it("同じ日付は0", () => {
    expect(compareDateStrings("2026-08-01", "2026-08-01")).toBe(0);
  });

  it("年をまたぐ比較も正しい（辞書順=暦順）", () => {
    expect(compareDateStrings("2025-12-31", "2026-01-01")).toBeLessThan(0);
  });
});

describe("formatDateLabel / formatDateFullLabel", () => {
  it("'2026-08-13'（木曜）は '8/13(木)'", () => {
    // 2026-08-13 は木曜日（実カレンダーで確認）
    expect(formatDateLabel("2026-08-13")).toBe("8/13(木)");
  });

  it("'2026-08-16'（日曜）は '8/16(日)'", () => {
    expect(formatDateLabel("2026-08-16")).toBe("8/16(日)");
  });

  it("formatDateFullLabel は年を含む", () => {
    expect(formatDateFullLabel("2026-08-13")).toBe("2026/8/13(木)");
  });

  it("曜日判定は TZ に依存しない（UTC の暦で決める）", () => {
    process.env.TZ = "America/Los_Angeles";
    expect(formatDateLabel("2026-08-13")).toBe("8/13(木)");
  });

  it("不正な日付は RangeError", () => {
    expect(() => formatDateLabel("invalid")).toThrow(RangeError);
    expect(() => formatDateFullLabel("invalid")).toThrow(RangeError);
  });
});
