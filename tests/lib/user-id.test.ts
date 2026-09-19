// @vitest-environment node
//
// src/lib/user-id.ts の brandUserIdFromTrustedSource を検証する。
//
// 期待値の根拠:
// - docs/steps/pub-1.md 設計判断 7「UserId はブランド型にし、作れる場所を3箇所に限る」
//   「フォームから来た string を渡すとコンパイルが通らない。ただし as UserId はどこでも
//   書けてしまうので、string を UserId に変える箇所を1つの関数に集め」
//   「@throws 空文字・文字列以外の場合 Error（空のユーザーIDで全件に触れる事故を防ぐ）」
//   （src/lib/user-id.ts の JSDoc より）
//
// UserId を作ってよい場所の許可リスト（src/ の走査によるチェック）は分離テストの回で扱う
// （pub-1.md「その他の観点」1）。ここでは変換関数そのものの入出力を検証する。

import { describe, expect, it } from "vitest";

import { brandUserIdFromTrustedSource } from "@/lib/user-id";

describe("brandUserIdFromTrustedSource", () => {
  it("空でない文字列はそのまま UserId として返す", () => {
    expect(brandUserIdFromTrustedSource("clx1234567890")).toBe("clx1234567890");
  });

  it("空文字は throw する", () => {
    expect(() => brandUserIdFromTrustedSource("")).toThrow(
      "user id must be a non-empty string",
    );
  });

  it("文字列以外（null / undefined / 数値）は throw する", () => {
    expect(() => brandUserIdFromTrustedSource(null as unknown as string)).toThrow();
    expect(() => brandUserIdFromTrustedSource(undefined as unknown as string)).toThrow();
    expect(() => brandUserIdFromTrustedSource(123 as unknown as string)).toThrow();
  });

  it("空白のみの文字列は（長さ>0なので）throw しない。トリムしない", () => {
    // JSDoc の契約は「空文字・文字列以外」のみを拒否する。前後の空白を trim して
    // 空文字判定する仕様は無いため、空白1文字はそのまま通る。
    expect(brandUserIdFromTrustedSource(" ")).toBe(" ");
  });

  it("同じ入力に対して同じ値を返す（値の変換や正規化をしない）", () => {
    const input = "cuid-abcdefg";
    expect(brandUserIdFromTrustedSource(input)).toBe(input);
  });
});
