// @vitest-environment node
//
// src/lib/year-month.ts の "YYYY-MM" 生成・移動・検証（純粋関数）を検証する。
//
// 期待値の根拠:
// - docs/steps/step-4.md「設計判断 > 月の決定は JST 固定」
// - docs/steps/step-4.md「実装完了後の引き継ぎ > 特に確認したい観点」1・9
//   「getCurrentYearMonth の JST 境界」「shiftYearMonth の年またぎと範囲端」
// - JST = UTC+9 固定（.claude/agents/implementer.md）
//
// getCurrentYearMonth の境界値は手計算:
// - JST 2026-09-01T00:00:00 は UTC 2026-08-31T15:00:00（-9時間）
// - その1秒前 JST 2026-08-31T23:59:59 は UTC 2026-08-31T14:59:59

import { describe, expect, it } from "vitest";

import {
  canShiftYearMonth,
  formatYearMonth,
  formatYearMonthLabel,
  getCurrentYearMonth,
  isYearMonth,
  MAX_YEAR_MONTH,
  MIN_YEAR_MONTH,
  nextYearMonth,
  parseYearMonth,
  previousYearMonth,
  resolveYearMonth,
  shiftYearMonth,
  validateYearMonth,
  YEAR_MONTH_ERRORS,
} from "@/lib/year-month";

describe("getCurrentYearMonth — JST 境界", () => {
  it("UTC 2026-08-31T15:00:00Z（JST 9/1 0:00）は '2026-09'", () => {
    expect(getCurrentYearMonth(new Date("2026-08-31T15:00:00.000Z"))).toBe("2026-09");
  });

  it("UTC 2026-08-31T14:59:59Z（JST 8/31 23:59:59、1秒前）は '2026-08'", () => {
    expect(getCurrentYearMonth(new Date("2026-08-31T14:59:59.000Z"))).toBe("2026-08");
  });

  it("UTC のまま計算すると誤るケース: 2026-01-01T00:00:00Z は JST 1/1 9:00 なので '2026-01'", () => {
    // UTC実装だと year=2025 の 12月 と誤りうるケースの反例（1日ではなく元日を跨がない例）
    expect(getCurrentYearMonth(new Date("2026-01-01T00:00:00.000Z"))).toBe("2026-01");
  });

  it("年をまたぐ: UTC 2025-12-31T15:00:00Z（JST 2026-01-01 0:00）は '2026-01'", () => {
    expect(getCurrentYearMonth(new Date("2025-12-31T15:00:00.000Z"))).toBe("2026-01");
  });

  it("年をまたぐ直前: UTC 2025-12-31T14:59:59Z（JST 2025-12-31 23:59:59）は '2025-12'", () => {
    expect(getCurrentYearMonth(new Date("2025-12-31T14:59:59.000Z"))).toBe("2025-12");
  });

  it("不正な Date（Invalid Date）は RangeError", () => {
    expect(() => getCurrentYearMonth(new Date("not-a-date"))).toThrow(RangeError);
  });
});

describe("formatYearMonth", () => {
  it("年4桁・月2桁の文字列を組み立てる", () => {
    expect(formatYearMonth(2026, 8)).toBe("2026-08");
    expect(formatYearMonth(2026, 12)).toBe("2026-12");
    expect(formatYearMonth(2026, 1)).toBe("2026-01");
  });

  it("年0（下限）・月1〜12は通る", () => {
    expect(formatYearMonth(0, 1)).toBe("0000-01");
    expect(formatYearMonth(9999, 12)).toBe("9999-12");
  });

  it("月が0または13は RangeError", () => {
    expect(() => formatYearMonth(2026, 0)).toThrow(RangeError);
    expect(() => formatYearMonth(2026, 13)).toThrow(RangeError);
  });

  it("年が範囲外（負数・10000以上）は RangeError", () => {
    expect(() => formatYearMonth(-1, 1)).toThrow(RangeError);
    expect(() => formatYearMonth(10000, 1)).toThrow(RangeError);
  });

  it("非整数は RangeError", () => {
    expect(() => formatYearMonth(2026.5, 8)).toThrow(RangeError);
    expect(() => formatYearMonth(2026, 8.5)).toThrow(RangeError);
  });
});

describe("isYearMonth / parseYearMonth", () => {
  it("正しい形式は true", () => {
    expect(isYearMonth("2026-08")).toBe(true);
    expect(isYearMonth("0000-01")).toBe(true);
    expect(isYearMonth("9999-12")).toBe(true);
  });

  it("月が00または13以上は false", () => {
    expect(isYearMonth("2026-00")).toBe(false);
    expect(isYearMonth("2026-13")).toBe(false);
  });

  it("ゼロ埋めされていない・年が4桁でないものは false", () => {
    expect(isYearMonth("2026-8")).toBe(false);
    expect(isYearMonth("26-08")).toBe(false);
  });

  it("文字列以外・空文字・配列は false", () => {
    expect(isYearMonth(null)).toBe(false);
    expect(isYearMonth(undefined)).toBe(false);
    expect(isYearMonth("")).toBe(false);
    expect(isYearMonth(["2026-08"])).toBe(false);
  });

  it("parseYearMonth は正しい形式を年月に分解する", () => {
    expect(parseYearMonth("2026-08")).toEqual({ year: 2026, month: 8 });
  });

  it("parseYearMonth は不正な形式で null を返す", () => {
    expect(parseYearMonth("invalid")).toBeNull();
    expect(parseYearMonth(123)).toBeNull();
  });
});

describe("shiftYearMonth", () => {
  it("通常の前月移動", () => {
    expect(shiftYearMonth("2026-08", -1)).toBe("2026-07");
  });

  it("通常の翌月移動", () => {
    expect(shiftYearMonth("2026-08", 1)).toBe("2026-09");
  });

  it("年をまたぐ前月移動: 2026-01 の1ヶ月前は 2025-12", () => {
    expect(shiftYearMonth("2026-01", -1)).toBe("2025-12");
  });

  it("年をまたぐ翌月移動: 2026-12 の1ヶ月後は 2027-01", () => {
    expect(shiftYearMonth("2026-12", 1)).toBe("2027-01");
  });

  it("0ヶ月移動は同じ値を返す", () => {
    expect(shiftYearMonth("2026-08", 0)).toBe("2026-08");
  });

  it("複数ヶ月の移動（年を複数またぐ）", () => {
    expect(shiftYearMonth("2026-08", 18)).toBe("2028-02");
    expect(shiftYearMonth("2026-08", -20)).toBe("2024-12");
  });

  it("下限ちょうど（MIN_YEAR_MONTH）はそのまま", () => {
    expect(shiftYearMonth(MIN_YEAR_MONTH, 0)).toBe(MIN_YEAR_MONTH);
  });

  it("下限を1ヶ月下回ると RangeError", () => {
    expect(() => shiftYearMonth(MIN_YEAR_MONTH, -1)).toThrow(RangeError);
  });

  it("上限ちょうど（MAX_YEAR_MONTH）はそのまま", () => {
    expect(shiftYearMonth(MAX_YEAR_MONTH, 0)).toBe(MAX_YEAR_MONTH);
  });

  it("上限を1ヶ月上回ると RangeError", () => {
    expect(() => shiftYearMonth(MAX_YEAR_MONTH, 1)).toThrow(RangeError);
  });

  it("不正な yearMonth は RangeError", () => {
    expect(() => shiftYearMonth("invalid", 1)).toThrow(RangeError);
    expect(() => shiftYearMonth("2026-13", 1)).toThrow(RangeError);
  });

  it("非整数の months は RangeError", () => {
    expect(() => shiftYearMonth("2026-08", 1.5)).toThrow(RangeError);
  });
});

describe("canShiftYearMonth", () => {
  it("通常範囲内は true", () => {
    expect(canShiftYearMonth("2026-08", -1)).toBe(true);
    expect(canShiftYearMonth("2026-08", 1)).toBe(true);
  });

  it("下限を割り込む移動は false", () => {
    expect(canShiftYearMonth(MIN_YEAR_MONTH, -1)).toBe(false);
  });

  it("上限を超える移動は false", () => {
    expect(canShiftYearMonth(MAX_YEAR_MONTH, 1)).toBe(false);
  });

  it("不正な yearMonth は false（例外を投げない）", () => {
    expect(canShiftYearMonth("invalid", 1)).toBe(false);
  });
});

describe("previousYearMonth / nextYearMonth", () => {
  it("previousYearMonth は shiftYearMonth(-1) と同じ", () => {
    expect(previousYearMonth("2026-08")).toBe("2026-07");
    expect(previousYearMonth("2026-01")).toBe("2025-12");
  });

  it("nextYearMonth は shiftYearMonth(+1) と同じ", () => {
    expect(nextYearMonth("2026-08")).toBe("2026-09");
    expect(nextYearMonth("2026-12")).toBe("2027-01");
  });
});

describe("formatYearMonthLabel", () => {
  it("'2026-08' は '2026年8月'（月の先頭0は落ちる）", () => {
    expect(formatYearMonthLabel("2026-08")).toBe("2026年8月");
  });

  it("'2026-12' は '2026年12月'", () => {
    expect(formatYearMonthLabel("2026-12")).toBe("2026年12月");
  });

  it("不正な形式は RangeError", () => {
    expect(() => formatYearMonthLabel("invalid")).toThrow(RangeError);
  });
});

describe("validateYearMonth", () => {
  it("正しい形式は ok:true でそのまま返す", () => {
    expect(validateYearMonth("2026-08")).toEqual({ ok: true, value: "2026-08" });
  });

  it("不正な形式は invalid エラー", () => {
    expect(validateYearMonth("2026/08")).toEqual({
      ok: false,
      error: YEAR_MONTH_ERRORS.invalid,
    });
  });

  it("未指定は invalid エラー", () => {
    expect(validateYearMonth(null)).toEqual({ ok: false, error: YEAR_MONTH_ERRORS.invalid });
    expect(validateYearMonth(undefined)).toEqual({
      ok: false,
      error: YEAR_MONTH_ERRORS.invalid,
    });
  });
});

describe("resolveYearMonth", () => {
  const now = new Date("2026-08-13T00:00:00.000Z"); // JST 2026-08-13、今月は '2026-08'

  it("正しい形式が指定されていればそれを使う", () => {
    expect(resolveYearMonth("2026-05", now)).toBe("2026-05");
  });

  it("未指定（undefined）は今月（JST）に落ちる", () => {
    expect(resolveYearMonth(undefined, now)).toBe(getCurrentYearMonth(now));
  });

  it("不正な形式は今月（JST）に落ちる", () => {
    expect(resolveYearMonth("not-a-month", now)).toBe(getCurrentYearMonth(now));
  });

  it("配列（?month=a&month=b 相当）は指定なし扱いで今月に落ちる", () => {
    expect(resolveYearMonth(["2026-05", "2026-06"], now)).toBe(getCurrentYearMonth(now));
  });
});
