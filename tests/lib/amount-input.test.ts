// @vitest-environment node
//
// src/lib/amount-input.ts の金額正規化の共通処理を検証する。
//
// 期待値の根拠:
// - docs/steps/step-5.md「モジュール構成」（Step 4 の parseBudgetAmountInput もここへ委譲）
// - docs/steps/step-5.md「特に確認したい観点」6.
//   「parseBudgetAmountInput が Step 4 と完全に同じ挙動のままであること」
// - tests/lib/budget-calculation.test.ts の既存ケース（同じ書式を受け入れる規則）
//
// 範囲チェック（上限・下限）はここでは扱わない仕様（呼び出し側の責任）ため、
// ここでは書式の正規化と「空欄→null」「範囲外の判別」だけを確認する。

import { describe, expect, it } from "vitest";

import { formatGroupedNumber, normalizeAmountInput } from "@/lib/amount-input";

describe("normalizeAmountInput — 空欄", () => {
  it("空文字は value: null", () => {
    expect(normalizeAmountInput("")).toEqual({ ok: true, value: null });
  });

  it("半角空白のみは value: null", () => {
    expect(normalizeAmountInput("   ")).toEqual({ ok: true, value: null });
  });

  it("全角空白のみは value: null", () => {
    expect(normalizeAmountInput("　　")).toEqual({ ok: true, value: null });
  });
});

describe("normalizeAmountInput — 正常系", () => {
  it("'0' は 0", () => {
    expect(normalizeAmountInput("0")).toEqual({ ok: true, value: 0 });
  });

  it("通常の整数文字列", () => {
    expect(normalizeAmountInput("1234")).toEqual({ ok: true, value: 1234 });
  });

  it("全角数字は半角に正規化する", () => {
    expect(normalizeAmountInput("１２３４")).toEqual({ ok: true, value: 1234 });
  });

  it("半角カンマ区切りは除去して受け入れる", () => {
    expect(normalizeAmountInput("1,234")).toEqual({ ok: true, value: 1234 });
  });

  it("全角カンマ区切りは除去して受け入れる", () => {
    expect(normalizeAmountInput("1，234")).toEqual({ ok: true, value: 1234 });
  });

  it("前後の空白（半角・全角）は trim する", () => {
    expect(normalizeAmountInput("　1234　")).toEqual({ ok: true, value: 1234 });
  });

  it("極端に大きい額でも安全な整数の範囲内なら受け入れる", () => {
    expect(normalizeAmountInput("99999999")).toEqual({ ok: true, value: 99_999_999 });
  });
});

describe("normalizeAmountInput — 拒否", () => {
  it("マイナスは拒否（negative）", () => {
    expect(normalizeAmountInput("-100")).toEqual({ ok: false, reason: "negative" });
  });

  it.each(["-100", "−100", "－100"])("マイナス記号の異表記 '%s' も拒否する", (value) => {
    expect(normalizeAmountInput(value)).toEqual({ ok: false, reason: "negative" });
  });

  it("小数は拒否（notInteger）", () => {
    expect(normalizeAmountInput("100.5")).toEqual({ ok: false, reason: "notInteger" });
  });

  it("全角の小数点も拒否（notInteger）", () => {
    expect(normalizeAmountInput("１００．５")).toEqual({ ok: false, reason: "notInteger" });
  });

  it("数字でない文字列は拒否（invalid）", () => {
    expect(normalizeAmountInput("abc")).toEqual({ ok: false, reason: "invalid" });
  });

  it("指数表記は拒否（invalid）", () => {
    expect(normalizeAmountInput("1e5")).toEqual({ ok: false, reason: "invalid" });
  });

  it("文字列以外は拒否（invalid）", () => {
    expect(normalizeAmountInput(null)).toEqual({ ok: false, reason: "invalid" });
    expect(normalizeAmountInput(undefined)).toEqual({ ok: false, reason: "invalid" });
    expect(normalizeAmountInput(1234)).toEqual({ ok: false, reason: "invalid" });
  });

  it("安全な整数を超える桁数は拒否（tooLarge）", () => {
    expect(normalizeAmountInput("99999999999999999999")).toEqual({
      ok: false,
      reason: "tooLarge",
    });
  });
});

describe("formatGroupedNumber", () => {
  it("3桁区切りでカンマが入る", () => {
    expect(formatGroupedNumber(1234567)).toBe("1,234,567");
  });

  it("3桁以下はカンマ無し", () => {
    expect(formatGroupedNumber(999)).toBe("999");
  });

  it("0は '0'", () => {
    expect(formatGroupedNumber(0)).toBe("0");
  });

  it("負数は符号付きで区切る", () => {
    expect(formatGroupedNumber(-1234)).toBe("-1,234");
  });
});
