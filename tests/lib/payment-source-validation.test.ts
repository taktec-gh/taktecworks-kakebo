// @vitest-environment node
//
// src/lib/payment-source-validation.ts の純粋関数を検証する。
// DB にも Next.js にも依存しないため、モックは不要（docs/steps/step-3.md）。
//
// 期待値の根拠:
// - docs/steps/step-3.md「name: 前後の空白を trim してから検証。1〜30文字。空は不可」
// - docs/steps/step-3.md「type: CASH / CREDIT_CARD / BANK_DEBIT のいずれか」
// - docs/steps/step-3.md「文字数は Array.from(name).length（コードポイント単位）で数える」

import { describe, expect, it } from "vitest";

import { PaymentSourceType } from "@/generated/prisma/enums";
import {
  isPaymentSourceType,
  PAYMENT_SOURCE_NAME_MAX_LENGTH,
  PAYMENT_SOURCE_TYPE_LABELS,
  PAYMENT_SOURCE_TYPE_OPTIONS,
  PAYMENT_SOURCE_VALIDATION_ERRORS,
  validatePaymentSourceId,
  validatePaymentSourceInput,
  validatePaymentSourceName,
  validatePaymentSourceType,
} from "@/lib/payment-source-validation";

describe("validatePaymentSourceName", () => {
  it("通常の名前は trim されて成功する", () => {
    expect(validatePaymentSourceName("Aカード")).toEqual({ ok: true, value: "Aカード" });
  });

  it("前後の空白は trim される", () => {
    expect(validatePaymentSourceName("  現金  ")).toEqual({ ok: true, value: "現金" });
  });

  it("1文字（境界値）は成功する", () => {
    expect(validatePaymentSourceName("A")).toEqual({ ok: true, value: "A" });
  });

  it(`${PAYMENT_SOURCE_NAME_MAX_LENGTH}文字（境界値）は成功する`, () => {
    const name = "あ".repeat(PAYMENT_SOURCE_NAME_MAX_LENGTH);
    expect(validatePaymentSourceName(name)).toEqual({ ok: true, value: name });
  });

  it(`${PAYMENT_SOURCE_NAME_MAX_LENGTH + 1}文字（境界値の1つ上）は拒否される`, () => {
    const name = "あ".repeat(PAYMENT_SOURCE_NAME_MAX_LENGTH + 1);
    expect(validatePaymentSourceName(name)).toEqual({
      ok: false,
      error: PAYMENT_SOURCE_VALIDATION_ERRORS.nameTooLong,
    });
  });

  it("空文字は拒否される", () => {
    expect(validatePaymentSourceName("")).toEqual({
      ok: false,
      error: PAYMENT_SOURCE_VALIDATION_ERRORS.nameRequired,
    });
  });

  it("空白のみは trim 後に空になるため拒否される", () => {
    expect(validatePaymentSourceName("   ")).toEqual({
      ok: false,
      error: PAYMENT_SOURCE_VALIDATION_ERRORS.nameRequired,
    });
  });

  it("文字列以外（null）は拒否される", () => {
    expect(validatePaymentSourceName(null)).toEqual({
      ok: false,
      error: PAYMENT_SOURCE_VALIDATION_ERRORS.nameRequired,
    });
  });

  it("文字列以外（undefined）は拒否される", () => {
    expect(validatePaymentSourceName(undefined)).toEqual({
      ok: false,
      error: PAYMENT_SOURCE_VALIDATION_ERRORS.nameRequired,
    });
  });

  it("文字列以外（File。フォームの入力ミス相当）は拒否される", () => {
    const file = new File(["dummy"], "a.txt");
    expect(validatePaymentSourceName(file)).toEqual({
      ok: false,
      error: PAYMENT_SOURCE_VALIDATION_ERRORS.nameRequired,
    });
  });

  it("サロゲートペア文字（絵文字）はコードポイント単位で1文字と数える", () => {
    // 😀 は UTF-16 上は2コードユニットだが、Array.from ではコードポイント1個
    const name = "😀".repeat(PAYMENT_SOURCE_NAME_MAX_LENGTH);
    expect(validatePaymentSourceName(name)).toEqual({ ok: true, value: name });

    const tooLong = "😀".repeat(PAYMENT_SOURCE_NAME_MAX_LENGTH + 1);
    expect(validatePaymentSourceName(tooLong)).toEqual({
      ok: false,
      error: PAYMENT_SOURCE_VALIDATION_ERRORS.nameTooLong,
    });
  });
});

describe("isPaymentSourceType", () => {
  it.each([PaymentSourceType.CASH, PaymentSourceType.CREDIT_CARD, PaymentSourceType.BANK_DEBIT])(
    "%s は正しい値",
    (value) => {
      expect(isPaymentSourceType(value)).toBe(true);
    },
  );

  it("未知の文字列は不正", () => {
    expect(isPaymentSourceType("PAYPAY")).toBe(false);
  });

  it("空文字は不正", () => {
    expect(isPaymentSourceType("")).toBe(false);
  });

  it("null/undefined は不正", () => {
    expect(isPaymentSourceType(null)).toBe(false);
    expect(isPaymentSourceType(undefined)).toBe(false);
  });
});

describe("validatePaymentSourceType", () => {
  it("正しい値は成功する", () => {
    expect(validatePaymentSourceType(PaymentSourceType.CREDIT_CARD)).toEqual({
      ok: true,
      value: PaymentSourceType.CREDIT_CARD,
    });
  });

  it("外れた文字列は拒否される", () => {
    expect(validatePaymentSourceType("SUICA")).toEqual({
      ok: false,
      error: PAYMENT_SOURCE_VALIDATION_ERRORS.typeRequired,
    });
  });

  it("未指定は拒否される", () => {
    expect(validatePaymentSourceType(null)).toEqual({
      ok: false,
      error: PAYMENT_SOURCE_VALIDATION_ERRORS.typeRequired,
    });
  });
});

describe("validatePaymentSourceId", () => {
  it("空でない文字列は成功する", () => {
    expect(validatePaymentSourceId("ps_123")).toEqual({ ok: true, value: "ps_123" });
  });

  it("空文字は拒否される", () => {
    expect(validatePaymentSourceId("")).toEqual({
      ok: false,
      error: PAYMENT_SOURCE_VALIDATION_ERRORS.idRequired,
    });
  });

  it("空白のみは拒否される", () => {
    expect(validatePaymentSourceId("   ")).toEqual({
      ok: false,
      error: PAYMENT_SOURCE_VALIDATION_ERRORS.idRequired,
    });
  });

  it("文字列以外（null）は拒否される", () => {
    expect(validatePaymentSourceId(null)).toEqual({
      ok: false,
      error: PAYMENT_SOURCE_VALIDATION_ERRORS.idRequired,
    });
  });
});

describe("validatePaymentSourceInput", () => {
  it("name・type がともに正しければ成功し、値が正規化される", () => {
    expect(
      validatePaymentSourceInput({ name: "  Aカード  ", type: PaymentSourceType.CREDIT_CARD }),
    ).toEqual({ ok: true, value: { name: "Aカード", type: PaymentSourceType.CREDIT_CARD } });
  });

  it("name が先に検証され、失敗するとそのエラーだけを返す", () => {
    expect(validatePaymentSourceInput({ name: "", type: PaymentSourceType.CASH })).toEqual({
      ok: false,
      error: PAYMENT_SOURCE_VALIDATION_ERRORS.nameRequired,
    });
  });

  it("name が正しく type が不正なら type のエラーを返す", () => {
    expect(validatePaymentSourceInput({ name: "現金", type: "FOO" })).toEqual({
      ok: false,
      error: PAYMENT_SOURCE_VALIDATION_ERRORS.typeRequired,
    });
  });

  it("両方不正でも1件だけエラーを返す（画面のエラー表示が1行のため）", () => {
    const result = validatePaymentSourceInput({ name: "", type: "FOO" });
    expect(result.ok).toBe(false);
  });
});

describe("PAYMENT_SOURCE_TYPE_OPTIONS / PAYMENT_SOURCE_TYPE_LABELS", () => {
  it("features.md の記載順（現金・クレジットカード・銀行引き落とし）で3件ある", () => {
    expect(PAYMENT_SOURCE_TYPE_OPTIONS.map((o) => o.value)).toEqual([
      PaymentSourceType.CASH,
      PaymentSourceType.CREDIT_CARD,
      PaymentSourceType.BANK_DEBIT,
    ]);
  });

  it("それぞれの表示ラベルが一目で分かる日本語になっている", () => {
    expect(PAYMENT_SOURCE_TYPE_LABELS[PaymentSourceType.CASH]).toBe("現金");
    expect(PAYMENT_SOURCE_TYPE_LABELS[PaymentSourceType.CREDIT_CARD]).toBe("クレジットカード");
    expect(PAYMENT_SOURCE_TYPE_LABELS[PaymentSourceType.BANK_DEBIT]).toBe("銀行引き落とし");
  });
});
