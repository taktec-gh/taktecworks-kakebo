// @vitest-environment node
//
// src/lib/category-validation.ts の入力検証（純粋関数）を検証する。
//
// 期待値の根拠:
// - docs/steps/step-4.md「実装内容 > 2. カテゴリ管理」「名前は20文字（払い出し先は30文字）」
// - docs/steps/step-3.md「入力値の検証」（trim・コードポイント単位のカウント方針はカテゴリでも同じ）

import { describe, expect, it } from "vitest";

import { CostType } from "@/generated/prisma/enums";
import {
  CATEGORY_NAME_MAX_LENGTH,
  CATEGORY_NAME_MIN_LENGTH,
  CATEGORY_VALIDATION_ERRORS,
  COST_TYPE_LABELS,
  COST_TYPE_OPTIONS,
  isCostType,
  validateCategoryId,
  validateCategoryInput,
  validateCategoryName,
  validateCostType,
} from "@/lib/category-validation";

describe("定数", () => {
  it("名前の最大文字数は20（payment-source の30より短い）", () => {
    expect(CATEGORY_NAME_MAX_LENGTH).toBe(20);
  });

  it("名前の最小文字数は1", () => {
    expect(CATEGORY_NAME_MIN_LENGTH).toBe(1);
  });
});

describe("isCostType", () => {
  it.each([CostType.FIXED, CostType.VARIABLE])("%s は正しい CostType", (value) => {
    expect(isCostType(value)).toBe(true);
  });

  it.each(["fixed", "", null, undefined, 1, "FIXED_COST"])("%s は不正な CostType", (value) => {
    expect(isCostType(value)).toBe(false);
  });
});

describe("COST_TYPE_LABELS / COST_TYPE_OPTIONS", () => {
  it("FIXED は「固定費」、VARIABLE は「変動費」", () => {
    expect(COST_TYPE_LABELS[CostType.FIXED]).toBe("固定費");
    expect(COST_TYPE_LABELS[CostType.VARIABLE]).toBe("変動費");
  });

  it("選択肢は FIXED・VARIABLE の2件で、値とラベルが対応している", () => {
    expect(COST_TYPE_OPTIONS).toHaveLength(2);
    const values = COST_TYPE_OPTIONS.map((o) => o.value).sort();
    expect(values).toEqual([CostType.FIXED, CostType.VARIABLE].sort());
    for (const option of COST_TYPE_OPTIONS) {
      expect(option.label).toBe(COST_TYPE_LABELS[option.value]);
    }
  });
});

describe("validateCategoryName", () => {
  it("通常の名前は trim されずそのまま通る", () => {
    expect(validateCategoryName("食費")).toEqual({ ok: true, value: "食費" });
  });

  it("前後の空白は trim される", () => {
    expect(validateCategoryName("  日用品  ")).toEqual({ ok: true, value: "日用品" });
  });

  it("空文字は拒否される", () => {
    expect(validateCategoryName("")).toEqual({
      ok: false,
      error: CATEGORY_VALIDATION_ERRORS.nameRequired,
    });
  });

  it("空白のみは trim 後に空になり拒否される", () => {
    expect(validateCategoryName("   ")).toEqual({
      ok: false,
      error: CATEGORY_VALIDATION_ERRORS.nameRequired,
    });
  });

  it("文字列以外は拒否される", () => {
    expect(validateCategoryName(null)).toEqual({
      ok: false,
      error: CATEGORY_VALIDATION_ERRORS.nameRequired,
    });
    expect(validateCategoryName(undefined)).toEqual({
      ok: false,
      error: CATEGORY_VALIDATION_ERRORS.nameRequired,
    });
    expect(validateCategoryName(123)).toEqual({
      ok: false,
      error: CATEGORY_VALIDATION_ERRORS.nameRequired,
    });
  });

  it("ちょうど20文字（コードポイント単位）は通る（境界値）", () => {
    const name = "あ".repeat(20);
    expect(validateCategoryName(name)).toEqual({ ok: true, value: name });
  });

  it("21文字は拒否される（境界値）", () => {
    const name = "あ".repeat(21);
    expect(validateCategoryName(name)).toEqual({
      ok: false,
      error: CATEGORY_VALIDATION_ERRORS.nameTooLong,
    });
  });

  it("サロゲートペアの絵文字はコードポイント単位で1文字と数える", () => {
    // U+1F389 (🎉) はUTF-16で2コードユニットだが、コードポイントは1つ
    const name = "🎉".repeat(20);
    expect(Array.from(name).length).toBe(20);
    expect(validateCategoryName(name)).toEqual({ ok: true, value: name });

    const tooLong = "🎉".repeat(21);
    expect(validateCategoryName(tooLong)).toEqual({
      ok: false,
      error: CATEGORY_VALIDATION_ERRORS.nameTooLong,
    });
  });

  it("1文字は通る（最小境界）", () => {
    expect(validateCategoryName("A")).toEqual({ ok: true, value: "A" });
  });
});

describe("validateCostType", () => {
  it("FIXED / VARIABLE は成功する", () => {
    expect(validateCostType(CostType.FIXED)).toEqual({ ok: true, value: CostType.FIXED });
    expect(validateCostType(CostType.VARIABLE)).toEqual({ ok: true, value: CostType.VARIABLE });
  });

  it("それ以外の文字列は拒否される", () => {
    expect(validateCostType("SEMI_FIXED")).toEqual({
      ok: false,
      error: CATEGORY_VALIDATION_ERRORS.costTypeRequired,
    });
  });

  it("未指定（null/undefined）は拒否される", () => {
    expect(validateCostType(null)).toEqual({
      ok: false,
      error: CATEGORY_VALIDATION_ERRORS.costTypeRequired,
    });
    expect(validateCostType(undefined)).toEqual({
      ok: false,
      error: CATEGORY_VALIDATION_ERRORS.costTypeRequired,
    });
  });
});

describe("validateCategoryId", () => {
  it("空でない文字列は成功する", () => {
    expect(validateCategoryId("cat_1")).toEqual({ ok: true, value: "cat_1" });
  });

  it("空文字・空白のみは拒否される", () => {
    expect(validateCategoryId("")).toEqual({
      ok: false,
      error: CATEGORY_VALIDATION_ERRORS.idRequired,
    });
    expect(validateCategoryId("   ")).toEqual({
      ok: false,
      error: CATEGORY_VALIDATION_ERRORS.idRequired,
    });
  });

  it("文字列以外は拒否される", () => {
    expect(validateCategoryId(null)).toEqual({
      ok: false,
      error: CATEGORY_VALIDATION_ERRORS.idRequired,
    });
    expect(validateCategoryId(42)).toEqual({
      ok: false,
      error: CATEGORY_VALIDATION_ERRORS.idRequired,
    });
  });
});

describe("validateCategoryInput", () => {
  it("両方正しければ trim 済みの名前と costType を返す", () => {
    expect(
      validateCategoryInput({ name: "  保険  ", costType: CostType.FIXED }),
    ).toEqual({ ok: true, value: { name: "保険", costType: CostType.FIXED } });
  });

  it("名前が不正なら costType を見るまでもなく名前のエラーを返す", () => {
    expect(validateCategoryInput({ name: "", costType: CostType.FIXED })).toEqual({
      ok: false,
      error: CATEGORY_VALIDATION_ERRORS.nameRequired,
    });
  });

  it("名前は正しいが costType が不正ならそのエラーを返す", () => {
    expect(validateCategoryInput({ name: "食費", costType: "INVALID" })).toEqual({
      ok: false,
      error: CATEGORY_VALIDATION_ERRORS.costTypeRequired,
    });
  });
});
