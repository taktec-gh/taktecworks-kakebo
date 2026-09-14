// @vitest-environment node
//
// src/lib/expense-validation.ts の支出フォーム入力検証（純粋関数）を検証する。
//
// 期待値の根拠:
// - docs/steps/step-5.md「設計判断 > 金額は1円以上」（範囲 1〜99,999,999）
// - docs/steps/step-5.md「設計判断 > 日付の範囲は 2000-01-01 〜 今日+1年」
//   「未来日そのものは拒否しない」
// - docs/features.md「1. 支出の記録（手入力）」（浪費フラグは必要・浪費・投資の3択）
// - docs/steps/step-5.md「実装完了後の引き継ぎ > 特に確認したい観点」5・7
//
// 金額・日付の境界値には手計算の根拠をコメントで残す。

import { describe, expect, it } from "vitest";

import { WasteTag } from "@/generated/prisma/enums";
import {
  DEFAULT_WASTE_TAG,
  EXPENSE_AMOUNT_MAX_YEN,
  EXPENSE_AMOUNT_MIN_YEN,
  EXPENSE_DATE_MAX_YEARS_AHEAD,
  EXPENSE_DATE_MIN,
  EXPENSE_VALIDATION_ERRORS,
  getMaxExpenseDate,
  isWasteTag,
  MEMO_MAX_LENGTH,
  STORE_NAME_MAX_LENGTH,
  validateExpenseAmount,
  validateExpenseCategoryId,
  validateExpenseDate,
  validateExpenseId,
  validateExpenseInput,
  validateExpensePaymentSourceId,
  validateMemo,
  validateStoreName,
  validateWasteTag,
  WASTE_TAG_OPTIONS,
} from "@/lib/expense-validation";

describe("定数", () => {
  it("金額の下限は1円（予算の0円と違い、支出に0円は無い）", () => {
    expect(EXPENSE_AMOUNT_MIN_YEN).toBe(1);
  });

  it("金額の上限は99,999,999円", () => {
    expect(EXPENSE_AMOUNT_MAX_YEN).toBe(99_999_999);
  });

  it("日付の下限は2000-01-01", () => {
    expect(EXPENSE_DATE_MIN).toBe("2000-01-01");
  });

  it("日付の上限は今日+1年", () => {
    expect(EXPENSE_DATE_MAX_YEARS_AHEAD).toBe(1);
  });

  it("店名は50文字、メモは200文字まで", () => {
    expect(STORE_NAME_MAX_LENGTH).toBe(50);
    expect(MEMO_MAX_LENGTH).toBe(200);
  });

  it("新規登録の既定の浪費フラグは NECESSARY（必要）", () => {
    // docs/steps/step-5.md「浪費フラグの既定を『必要』にするのは、大半の支出が
    // 必要な支出であり、浪費のときだけ1タップ増やすほうが総タップ数が少ないため」
    expect(DEFAULT_WASTE_TAG).toBe(WasteTag.NECESSARY);
  });

  it("浪費フラグの選択肢は features.md の記載順（必要 → 浪費 → 投資）", () => {
    expect(WASTE_TAG_OPTIONS.map((option) => option.value)).toEqual([
      WasteTag.NECESSARY,
      WasteTag.WASTE,
      WasteTag.INVESTMENT,
    ]);
  });
});

describe("validateExpenseAmount — 金額の境界", () => {
  it("0円は拒否する（支出に0円は無い）", () => {
    const result = validateExpenseAmount("0");
    expect(result).toEqual({ ok: false, error: EXPENSE_VALIDATION_ERRORS.amountTooSmall });
  });

  it("1円（下限ちょうど）は可", () => {
    expect(validateExpenseAmount("1")).toEqual({ ok: true, value: 1 });
  });

  it("99,999,999円（上限ちょうど）は可", () => {
    expect(validateExpenseAmount("99999999")).toEqual({ ok: true, value: 99_999_999 });
  });

  it("100,000,000円（上限+1）は拒否する", () => {
    expect(validateExpenseAmount("100000000")).toEqual({
      ok: false,
      error: EXPENSE_VALIDATION_ERRORS.amountTooLarge,
    });
  });

  it("空欄は『エラー』（予算と違い『未設定』にはならない）", () => {
    expect(validateExpenseAmount("")).toEqual({
      ok: false,
      error: EXPENSE_VALIDATION_ERRORS.amountRequired,
    });
    expect(validateExpenseAmount("   ")).toEqual({
      ok: false,
      error: EXPENSE_VALIDATION_ERRORS.amountRequired,
    });
  });

  it("負数は拒否する", () => {
    expect(validateExpenseAmount("-1")).toEqual({
      ok: false,
      error: EXPENSE_VALIDATION_ERRORS.amountTooSmall,
    });
  });

  it("小数は拒否する（1円単位の整数のみ）", () => {
    expect(validateExpenseAmount("1.5")).toEqual({
      ok: false,
      error: EXPENSE_VALIDATION_ERRORS.amountNotInteger,
    });
  });

  it("数字でない文字列は拒否する", () => {
    expect(validateExpenseAmount("abc")).toEqual({
      ok: false,
      error: EXPENSE_VALIDATION_ERRORS.amountInvalid,
    });
  });

  it("全角数字・カンマは Step 4 と同じ規則で受け入れる", () => {
    expect(validateExpenseAmount("１，２３４")).toEqual({ ok: true, value: 1234 });
  });

  it("極端に大きい額（安全な整数を超える）は拒否する", () => {
    expect(validateExpenseAmount("99999999999999999999")).toEqual({
      ok: false,
      error: EXPENSE_VALIDATION_ERRORS.amountTooLarge,
    });
  });
});

describe("getMaxExpenseDate", () => {
  it("今日(JST)から1年後の日付を返す", () => {
    // 2026-08-13T00:00:00Z は JST 2026-08-13 9:00 なので今日は 2026-08-13
    expect(getMaxExpenseDate(new Date("2026-08-13T00:00:00.000Z"))).toBe("2027-08-13");
  });

  it("うるう年の2/29から1年後は2/28に丸める", () => {
    // JST 2024-02-29 9:00 = UTC 2024-02-29T00:00:00Z
    expect(getMaxExpenseDate(new Date("2024-02-29T00:00:00.000Z"))).toBe("2025-02-28");
  });
});

describe("validateExpenseDate — 範囲", () => {
  const NOW = new Date("2026-08-13T00:00:00.000Z"); // JST 2026-08-13

  it("下限ちょうど（2000-01-01）は可", () => {
    expect(validateExpenseDate("2000-01-01", NOW)).toEqual({ ok: true, value: "2000-01-01" });
  });

  it("下限を1日下回ると拒否する", () => {
    expect(validateExpenseDate("1999-12-31", NOW)).toEqual({
      ok: false,
      error: EXPENSE_VALIDATION_ERRORS.dateOutOfRange,
    });
  });

  it("今日+1年ちょうど（上限）は可（未来日は拒否しない）", () => {
    expect(validateExpenseDate("2027-08-13", NOW)).toEqual({ ok: true, value: "2027-08-13" });
  });

  it("今日+1年を1日超えると拒否する", () => {
    expect(validateExpenseDate("2027-08-14", NOW)).toEqual({
      ok: false,
      error: EXPENSE_VALIDATION_ERRORS.dateOutOfRange,
    });
  });

  it("桁の打ち間違い（'2206-08-13'）は拒否する", () => {
    expect(validateExpenseDate("2206-08-13", NOW)).toEqual({
      ok: false,
      error: EXPENSE_VALIDATION_ERRORS.dateOutOfRange,
    });
  });

  it("実在しない日付（2026-02-30）は拒否する", () => {
    expect(validateExpenseDate("2026-02-30", NOW)).toEqual({
      ok: false,
      error: EXPENSE_VALIDATION_ERRORS.dateInvalid,
    });
  });

  it("うるう年ではない2026年の2/29は拒否する", () => {
    expect(validateExpenseDate("2026-02-29", NOW)).toEqual({
      ok: false,
      error: EXPENSE_VALIDATION_ERRORS.dateInvalid,
    });
  });

  it("うるう年の2024年の2/29は可", () => {
    expect(validateExpenseDate("2024-02-29", NOW)).toEqual({ ok: true, value: "2024-02-29" });
  });

  it("空欄は拒否する", () => {
    expect(validateExpenseDate("", NOW)).toEqual({
      ok: false,
      error: EXPENSE_VALIDATION_ERRORS.dateRequired,
    });
  });

  it("文字列以外は拒否する", () => {
    expect(validateExpenseDate(null, NOW)).toEqual({
      ok: false,
      error: EXPENSE_VALIDATION_ERRORS.dateRequired,
    });
  });

  it("形式が不正な文字列は拒否する", () => {
    expect(validateExpenseDate("2026/08/13", NOW)).toEqual({
      ok: false,
      error: EXPENSE_VALIDATION_ERRORS.dateInvalid,
    });
  });
});

describe("isWasteTag / validateWasteTag", () => {
  it("NECESSARY / WASTE / INVESTMENT は true", () => {
    expect(isWasteTag(WasteTag.NECESSARY)).toBe(true);
    expect(isWasteTag(WasteTag.WASTE)).toBe(true);
    expect(isWasteTag(WasteTag.INVESTMENT)).toBe(true);
  });

  it("それ以外の文字列・未指定は false", () => {
    expect(isWasteTag("necessary")).toBe(false);
    expect(isWasteTag("")).toBe(false);
    expect(isWasteTag(null)).toBe(false);
    expect(isWasteTag(undefined)).toBe(false);
  });

  it("validateWasteTag は正しい値をそのまま返す", () => {
    expect(validateWasteTag(WasteTag.WASTE)).toEqual({ ok: true, value: WasteTag.WASTE });
  });

  it("validateWasteTag は不正な値を拒否する", () => {
    expect(validateWasteTag("invalid")).toEqual({
      ok: false,
      error: EXPENSE_VALIDATION_ERRORS.wasteTagRequired,
    });
  });
});

describe("validateExpenseCategoryId / validateExpensePaymentSourceId / validateExpenseId", () => {
  it("値があればそのまま通す", () => {
    expect(validateExpenseCategoryId("cat_1")).toEqual({ ok: true, value: "cat_1" });
    expect(validateExpensePaymentSourceId("ps_1")).toEqual({ ok: true, value: "ps_1" });
    expect(validateExpenseId("exp_1")).toEqual({ ok: true, value: "exp_1" });
  });

  it("未選択（空文字）は拒否する", () => {
    expect(validateExpenseCategoryId("")).toEqual({
      ok: false,
      error: EXPENSE_VALIDATION_ERRORS.categoryRequired,
    });
    expect(validateExpensePaymentSourceId("")).toEqual({
      ok: false,
      error: EXPENSE_VALIDATION_ERRORS.paymentSourceRequired,
    });
    expect(validateExpenseId("")).toEqual({
      ok: false,
      error: EXPENSE_VALIDATION_ERRORS.idRequired,
    });
  });

  it("文字列以外は拒否する", () => {
    expect(validateExpenseCategoryId(null)).toEqual({
      ok: false,
      error: EXPENSE_VALIDATION_ERRORS.categoryRequired,
    });
  });
});

describe("validateStoreName — 0〜50文字", () => {
  it("未入力（null/undefined）は null", () => {
    expect(validateStoreName(null)).toEqual({ ok: true, value: null });
    expect(validateStoreName(undefined)).toEqual({ ok: true, value: null });
  });

  it("空文字・空白のみは null に正規化する", () => {
    expect(validateStoreName("")).toEqual({ ok: true, value: null });
    expect(validateStoreName("   ")).toEqual({ ok: true, value: null });
  });

  it("前後の空白は trim する", () => {
    expect(validateStoreName("  スーパー  ")).toEqual({ ok: true, value: "スーパー" });
  });

  it("50文字（上限ちょうど）は可", () => {
    const name = "あ".repeat(50);
    expect(validateStoreName(name)).toEqual({ ok: true, value: name });
  });

  it("51文字（上限+1）は拒否する", () => {
    const name = "あ".repeat(51);
    expect(validateStoreName(name)).toEqual({
      ok: false,
      error: EXPENSE_VALIDATION_ERRORS.storeNameTooLong,
    });
  });

  it("文字数はコードポイント単位で数える（絵文字を2文字と数えない）", () => {
    // サロゲートペアの絵文字1文字を50個並べても50文字（コードポイント）扱いで可
    const name = "🍣".repeat(50);
    expect(validateStoreName(name)).toEqual({ ok: true, value: name });
  });
});

describe("validateMemo — 0〜200文字", () => {
  it("未入力は null", () => {
    expect(validateMemo(null)).toEqual({ ok: true, value: null });
    expect(validateMemo("")).toEqual({ ok: true, value: null });
  });

  it("200文字（上限ちょうど）は可", () => {
    const memo = "あ".repeat(200);
    expect(validateMemo(memo)).toEqual({ ok: true, value: memo });
  });

  it("201文字（上限+1）は拒否する", () => {
    const memo = "あ".repeat(201);
    expect(validateMemo(memo)).toEqual({
      ok: false,
      error: EXPENSE_VALIDATION_ERRORS.memoTooLong,
    });
  });
});

describe("validateExpenseInput — まとめて検証", () => {
  const NOW = new Date("2026-08-13T00:00:00.000Z");

  function baseInput() {
    return {
      date: "2026-08-13",
      amount: "1234",
      categoryId: "cat_1",
      paymentSourceId: "ps_1",
      wasteTag: WasteTag.NECESSARY,
      storeName: "スーパー",
      memo: "牛乳など",
    };
  }

  it("すべて正しければ正規化済みの値を返す", () => {
    const result = validateExpenseInput(baseInput(), NOW);
    expect(result).toEqual({
      ok: true,
      value: {
        date: "2026-08-13",
        amountYen: 1234,
        categoryId: "cat_1",
        paymentSourceId: "ps_1",
        wasteTag: WasteTag.NECESSARY,
        storeName: "スーパー",
        memo: "牛乳など",
      },
    });
  });

  it("店名・メモが空なら null になる", () => {
    const result = validateExpenseInput({ ...baseInput(), storeName: "", memo: "" }, NOW);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.storeName).toBeNull();
      expect(result.value.memo).toBeNull();
    }
  });

  it("最初に見つかったエラーだけを返す（金額が最優先）", () => {
    const result = validateExpenseInput(
      { ...baseInput(), amount: "", categoryId: "" },
      NOW,
    );
    expect(result).toEqual({ ok: false, error: EXPENSE_VALIDATION_ERRORS.amountRequired });
  });

  it("金額が正しくカテゴリが未選択なら、カテゴリのエラーを返す", () => {
    const result = validateExpenseInput({ ...baseInput(), categoryId: "" }, NOW);
    expect(result).toEqual({ ok: false, error: EXPENSE_VALIDATION_ERRORS.categoryRequired });
  });

  it("金額・カテゴリが正しく浪費フラグが不正なら、浪費フラグのエラーを返す", () => {
    const result = validateExpenseInput({ ...baseInput(), wasteTag: "invalid" }, NOW);
    expect(result).toEqual({ ok: false, error: EXPENSE_VALIDATION_ERRORS.wasteTagRequired });
  });

  it("日付が範囲外ならそのエラーを返す（他が正しくても）", () => {
    const result = validateExpenseInput({ ...baseInput(), date: "1999-12-31" }, NOW);
    expect(result).toEqual({ ok: false, error: EXPENSE_VALIDATION_ERRORS.dateOutOfRange });
  });
});
