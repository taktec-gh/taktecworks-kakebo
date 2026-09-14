// @vitest-environment node
//
// src/lib/income-validation.ts の収入フォーム入力検証（純粋関数）を検証する。
//
// 期待値の根拠:
// - docs/steps/step-6.md「3-2. src/lib/income-validation.ts」
//   （下限1円・上限99,999,999円・ラベル20文字・空欄はエラー）
// - docs/steps/step-6.md「tester への引き継ぎ > 公開インターフェース」の
//   INCOME_VALIDATION_ERRORS の文言
// - src/lib/amount-input.ts の正規化仕様（全角数字・カンマ・空白を受け入れる）

import { describe, expect, it } from "vitest";

import { YEAR_MONTH_ERRORS } from "@/lib/year-month";
import {
  INCOME_AMOUNT_MAX_YEN,
  INCOME_AMOUNT_MIN_YEN,
  INCOME_LABEL_MAX_LENGTH,
  INCOME_VALIDATION_ERRORS,
  validateIncomeAmount,
  validateIncomeId,
  validateIncomeInput,
  validateIncomeLabel,
} from "@/lib/income-validation";

describe("定数", () => {
  it("金額の下限は1円（予算と違い0円の収入は無い）", () => {
    expect(INCOME_AMOUNT_MIN_YEN).toBe(1);
  });

  it("金額の上限は99,999,999円", () => {
    expect(INCOME_AMOUNT_MAX_YEN).toBe(99_999_999);
  });

  it("ラベルは20文字まで", () => {
    expect(INCOME_LABEL_MAX_LENGTH).toBe(20);
  });

  it("エラー文言は日本語で固定されている", () => {
    expect(INCOME_VALIDATION_ERRORS).toEqual({
      amountRequired: "金額を入力してください。",
      amountInvalid: "金額は数字で入力してください。",
      amountNotInteger: "金額は1円単位の整数で入力してください。",
      amountTooSmall: "金額は1円以上で入力してください。",
      amountTooLarge: "金額は99,999,999円以下で入力してください。",
      labelTooLong: "ラベルは20文字以内で入力してください。",
      idRequired: "対象の収入が指定されていません。",
    });
  });
});

describe("validateIncomeAmount", () => {
  it("空欄はエラー（予算と違い『未設定の収入』は無い）", () => {
    expect(validateIncomeAmount("")).toEqual({
      ok: false,
      error: INCOME_VALIDATION_ERRORS.amountRequired,
    });
  });

  it("空白のみもエラー", () => {
    expect(validateIncomeAmount("   ")).toEqual({
      ok: false,
      error: INCOME_VALIDATION_ERRORS.amountRequired,
    });
  });

  it("0円はエラー（下限1円）", () => {
    expect(validateIncomeAmount("0")).toEqual({
      ok: false,
      error: INCOME_VALIDATION_ERRORS.amountTooSmall,
    });
  });

  it("マイナスはエラー（1円以上でと案内する）", () => {
    expect(validateIncomeAmount("-5")).toEqual({
      ok: false,
      error: INCOME_VALIDATION_ERRORS.amountTooSmall,
    });
  });

  it("小数はエラー", () => {
    expect(validateIncomeAmount("1000.5")).toEqual({
      ok: false,
      error: INCOME_VALIDATION_ERRORS.amountNotInteger,
    });
  });

  it("数字として読めない文字列はエラー", () => {
    expect(validateIncomeAmount("abc")).toEqual({
      ok: false,
      error: INCOME_VALIDATION_ERRORS.amountInvalid,
    });
  });

  it("下限ちょうど（1円）は通る", () => {
    expect(validateIncomeAmount("1")).toEqual({ ok: true, value: 1 });
  });

  it("上限ちょうど（99,999,999円）は通る", () => {
    expect(validateIncomeAmount("99999999")).toEqual({ ok: true, value: 99_999_999 });
  });

  it("上限+1円は拒否する", () => {
    expect(validateIncomeAmount("100000000")).toEqual({
      ok: false,
      error: INCOME_VALIDATION_ERRORS.amountTooLarge,
    });
  });

  it("全角数字を受け入れる", () => {
    expect(validateIncomeAmount("１２３")).toEqual({ ok: true, value: 123 });
  });

  it("カンマ区切りを受け入れる", () => {
    expect(validateIncomeAmount("1,000")).toEqual({ ok: true, value: 1_000 });
  });

  it("前後の空白を許容する", () => {
    expect(validateIncomeAmount(" 500 ")).toEqual({ ok: true, value: 500 });
  });
});

describe("validateIncomeLabel", () => {
  it("null は許容し、null を返す", () => {
    expect(validateIncomeLabel(null)).toEqual({ ok: true, value: null });
  });

  it("undefined は許容し、null を返す", () => {
    expect(validateIncomeLabel(undefined)).toEqual({ ok: true, value: null });
  });

  it("空文字は trim 後に空なので null", () => {
    expect(validateIncomeLabel("")).toEqual({ ok: true, value: null });
  });

  it("空白だけの入力は null（trim して空になる）", () => {
    expect(validateIncomeLabel("   ")).toEqual({ ok: true, value: null });
  });

  it("前後の空白を落とす", () => {
    expect(validateIncomeLabel("  給与  ")).toEqual({ ok: true, value: "給与" });
  });

  it("20文字ちょうどは通る", () => {
    const label = "あ".repeat(20);
    expect(validateIncomeLabel(label)).toEqual({ ok: true, value: label });
  });

  it("21文字はエラー", () => {
    const label = "あ".repeat(21);
    expect(validateIncomeLabel(label)).toEqual({
      ok: false,
      error: INCOME_VALIDATION_ERRORS.labelTooLong,
    });
  });

  it("文字数はコードポイント単位で数える（サロゲートペアの絵文字20個は通る）", () => {
    const label = "😀".repeat(20);
    expect(validateIncomeLabel(label)).toEqual({ ok: true, value: label });
  });

  it("サロゲートペアの絵文字21個はエラー", () => {
    const label = "😀".repeat(21);
    expect(validateIncomeLabel(label)).toEqual({
      ok: false,
      error: INCOME_VALIDATION_ERRORS.labelTooLong,
    });
  });
});

describe("validateIncomeId", () => {
  it("空文字はエラー", () => {
    expect(validateIncomeId("")).toEqual({
      ok: false,
      error: INCOME_VALIDATION_ERRORS.idRequired,
    });
  });

  it("空白だけもエラー", () => {
    expect(validateIncomeId("   ")).toEqual({
      ok: false,
      error: INCOME_VALIDATION_ERRORS.idRequired,
    });
  });

  it("文字列以外はエラー", () => {
    expect(validateIncomeId(null)).toEqual({
      ok: false,
      error: INCOME_VALIDATION_ERRORS.idRequired,
    });
    expect(validateIncomeId(123)).toEqual({
      ok: false,
      error: INCOME_VALIDATION_ERRORS.idRequired,
    });
  });

  it("有効な文字列はそのまま通る", () => {
    expect(validateIncomeId("income_1")).toEqual({ ok: true, value: "income_1" });
  });
});

describe("validateIncomeInput", () => {
  it("すべて正しければ検証済みの値を返す", () => {
    const result = validateIncomeInput({
      yearMonth: "2026-08",
      amount: "300000",
      label: "給与",
    });
    expect(result).toEqual({
      ok: true,
      value: { yearMonth: "2026-08", amountYen: 300_000, label: "給与" },
    });
  });

  it("検証順は金額が最初（利用者が直せる欄を先に見せる）", () => {
    const result = validateIncomeInput({
      yearMonth: "invalid",
      amount: "",
      label: "あ".repeat(30),
    });
    expect(result).toEqual({ ok: false, error: INCOME_VALIDATION_ERRORS.amountRequired });
  });

  it("金額が正しければ、次にラベルのエラーを返す", () => {
    const result = validateIncomeInput({
      yearMonth: "invalid",
      amount: "1000",
      label: "あ".repeat(30),
    });
    expect(result).toEqual({ ok: false, error: INCOME_VALIDATION_ERRORS.labelTooLong });
  });

  it("金額・ラベルが正しく、対象月だけ不正なら年月のエラーを返す", () => {
    const result = validateIncomeInput({
      yearMonth: "invalid",
      amount: "1000",
      label: "給与",
    });
    expect(result).toEqual({ ok: false, error: YEAR_MONTH_ERRORS.invalid });
  });

  it("ラベル未入力でも通る（任意項目）", () => {
    const result = validateIncomeInput({
      yearMonth: "2026-08",
      amount: "1000",
      label: "",
    });
    expect(result).toEqual({
      ok: true,
      value: { yearMonth: "2026-08", amountYen: 1_000, label: null },
    });
  });
});
