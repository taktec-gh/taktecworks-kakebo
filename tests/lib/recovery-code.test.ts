// @vitest-environment node
//
// src/lib/recovery-code.ts（リカバリーコードの生成・整形・正規化・ハッシュ）を検証する。
// node:crypto を使うため node 環境（tests/lib/auth.test.ts 冒頭のコメントと同じ理由）。
//
// 期待値の根拠:
// - docs/steps/pub-5.md 設計判断 1「コードの形」
//   「20文字、紛らわしい文字を除いた32種類の文字」「実装での決定: 文字は
//   `23456789ABCDEFGHJKMNPQRSTUVWXYZ#`」「表示は5文字ずつハイフンで区切る」
//   「入力は、前後と途中の空白・ハイフンを取り除き、英字を大文字にしてから照合する（正規化）。
//   それ以外の文字が残れば照合せずに失敗」「平文はどこにも保存しない」
// - docs/steps/pub-5.md 設計判断 2「DB にはハッシュだけを保存する。ハッシュは鍵なしの SHA-256」
//   「正規化したコードの SHA-256（16進）」
// - docs/steps/pub-5.md「実装完了後の引き継ぎ」
//   「RECOVERY_CODE_ALPHABET（32文字、# を含む）/ RECOVERY_CODE_LENGTH = 20。
//   generateRecoveryCode()（区切り無し20文字）、formatRecoveryCode(code)（5文字ずつハイフン）、
//   normalizeRecoveryCode(input: unknown): string | null（空白（全角含む \s）と ASCII ハイフンを除き、
//   ASCII 英小文字だけ大文字に。20文字・許可文字のみ・100文字以下の入力でなければ null）、
//   hashRecoveryCode(code)（正規化後の SHA-256 16進64文字。正規化できなければ例外）、
//   isRecoveryCodeHash(v)、issueRecoveryCode(): { code, hash }」
// - docs/steps/pub-5.md「tester 向けの方針」3・4
//   「平文を保存しない」「正規化: 小文字・ハイフン・空白の有無で同じハッシュになる。
//   許可しない文字（0 O 1 I L など）を含むと照合しない」

import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  formatRecoveryCode,
  generateRecoveryCode,
  hashRecoveryCode,
  isRecoveryCodeHash,
  issueRecoveryCode,
  normalizeRecoveryCode,
  RECOVERY_CODE_ALPHABET,
  RECOVERY_CODE_GROUP_SIZE,
  RECOVERY_CODE_LENGTH,
  RECOVERY_CODE_SEPARATOR,
} from "@/lib/recovery-code";

describe("定数", () => {
  it("RECOVERY_CODE_ALPHABET は32文字（手計算: 100ビット / 20文字 = 5ビット/文字 → 2^5 = 32種類）", () => {
    expect(RECOVERY_CODE_ALPHABET).toHaveLength(32);
  });

  it("RECOVERY_CODE_ALPHABET は紛らわしい文字（0/O/1/I/L）を含まない", () => {
    for (const confusing of ["0", "O", "1", "I", "L"]) {
      expect(RECOVERY_CODE_ALPHABET).not.toContain(confusing);
    }
  });

  it("RECOVERY_CODE_ALPHABET は実装の決定どおり # を含み、重複文字が無い", () => {
    expect(RECOVERY_CODE_ALPHABET).toContain("#");
    expect(new Set(RECOVERY_CODE_ALPHABET).size).toBe(32);
  });

  it("RECOVERY_CODE_LENGTH は20文字（20文字 * 5ビット = 100ビット）", () => {
    expect(RECOVERY_CODE_LENGTH).toBe(20);
  });

  it("表示の区切りは5文字ずつハイフン", () => {
    expect(RECOVERY_CODE_GROUP_SIZE).toBe(5);
    expect(RECOVERY_CODE_SEPARATOR).toBe("-");
  });
});

describe("generateRecoveryCode", () => {
  it("20文字を返す", () => {
    expect(generateRecoveryCode()).toHaveLength(RECOVERY_CODE_LENGTH);
  });

  it("すべての文字が RECOVERY_CODE_ALPHABET に含まれる", () => {
    const code = generateRecoveryCode();
    for (const char of code) {
      expect(RECOVERY_CODE_ALPHABET).toContain(char);
    }
  });

  it("呼ぶたびに違う値になる（暗号学的乱数）", () => {
    const codes = new Set(Array.from({ length: 20 }, () => generateRecoveryCode()));
    expect(codes.size).toBe(20);
  });
});

describe("formatRecoveryCode", () => {
  it("20文字を5文字ずつハイフンで区切る（K7Q2M-9XP4H-TR8WN-B3D6F の形）", () => {
    expect(formatRecoveryCode("K7Q2M9XP4HTR8WNB3D6F")).toBe("K7Q2M-9XP4H-TR8WN-B3D6F");
  });

  it("区切り・空白・小文字を含む入力も、正規化してから整形する", () => {
    expect(formatRecoveryCode("k7q2m 9xp4h-tr8wn-b3d6f")).toBe("K7Q2M-9XP4H-TR8WN-B3D6F");
  });

  it("正規化できない入力（文字数違い）は throw する", () => {
    expect(() => formatRecoveryCode("SHORT")).toThrow("invalid recovery code");
  });

  it("正規化できない入力（許可されない文字）は throw する", () => {
    expect(() => formatRecoveryCode("O0O0O0O0O0O0O0O0O0O0")).toThrow("invalid recovery code");
  });
});

describe("normalizeRecoveryCode（正規化。docs/steps/pub-5.md 設計判断 1・tester 向けの方針 4）", () => {
  const VALID = "K7Q2M9XP4HTR8WNB3D6F"; // 20文字・RECOVERY_CODE_ALPHABET のみ

  it("正しい形の入力はそのまま返す", () => {
    expect(normalizeRecoveryCode(VALID)).toBe(VALID);
  });

  it("ASCII ハイフンを取り除く", () => {
    expect(normalizeRecoveryCode("K7Q2M-9XP4H-TR8WN-B3D6F")).toBe(VALID);
  });

  it("前後・途中の半角空白を取り除く", () => {
    expect(normalizeRecoveryCode("  K7Q2M 9XP4H TR8WN B3D6F  ")).toBe(VALID);
  });

  it("全角空白も取り除く（\\s に含まれる）", () => {
    expect(normalizeRecoveryCode("K7Q2M　9XP4HTR8WNB3D6F")).toBe(VALID);
  });

  it("ASCII 英小文字を大文字にする", () => {
    expect(normalizeRecoveryCode("k7q2m9xp4htr8wnb3d6f")).toBe(VALID);
  });

  it("区切り・空白・小文字が混在していても、同じ元のコードなら同じ正規化結果になる", () => {
    expect(normalizeRecoveryCode("k7q2m-9xp4h-tr8wn-b3d6f")).toBe(VALID);
    expect(normalizeRecoveryCode(" k7q2m 9xp4h-tr8wn-b3d6f ")).toBe(VALID);
  });

  it("20文字に満たない（区切りを除いた後）入力は null", () => {
    expect(normalizeRecoveryCode("K7Q2M-9XP4H-TR8WN-B3D6")).toBeNull();
  });

  it("20文字を超える入力は null", () => {
    expect(normalizeRecoveryCode(`${VALID}X`)).toBeNull();
  });

  it.each(["0", "O", "1", "I", "L"])("許可されない文字 %s を含むと null", (char) => {
    const tampered = char + VALID.slice(1);
    expect(normalizeRecoveryCode(tampered)).toBeNull();
  });

  it("全角英数字を含むと null（ASCII 変換しかしない）", () => {
    expect(normalizeRecoveryCode(`Ｋ${VALID.slice(1)}`)).toBeNull();
  });

  it("記号（# 以外）を含むと null", () => {
    expect(normalizeRecoveryCode(`!${VALID.slice(1)}`)).toBeNull();
  });

  it("文字列でない入力（number, null, undefined, object）は null", () => {
    expect(normalizeRecoveryCode(12345)).toBeNull();
    expect(normalizeRecoveryCode(null)).toBeNull();
    expect(normalizeRecoveryCode(undefined)).toBeNull();
    expect(normalizeRecoveryCode({})).toBeNull();
  });

  it("空文字は null", () => {
    expect(normalizeRecoveryCode("")).toBeNull();
  });

  it("100文字を超える入力は（正規化を試みる前に）null（巨大な入力を弾く）", () => {
    expect(normalizeRecoveryCode("A".repeat(101))).toBeNull();
  });

  it("100文字ちょうどの入力（区切り・空白込みで20文字に収まらなければ）は null", () => {
    // 100文字の空白+20文字の有効なコードは正規化後20文字になるので通る
    const spaced = " ".repeat(80) + VALID;
    expect(spaced.length).toBe(100);
    expect(normalizeRecoveryCode(spaced)).toBe(VALID);
  });
});

describe("hashRecoveryCode（DB に保存する値。docs/steps/pub-5.md 設計判断 2）", () => {
  const VALID = "K7Q2M9XP4HTR8WNB3D6F";

  it("正規化後の文字列の SHA-256（16進64文字・小文字）を返す", () => {
    const expected = createHash("sha256").update(VALID, "utf8").digest("hex");
    expect(hashRecoveryCode(VALID)).toBe(expected);
    expect(hashRecoveryCode(VALID)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("区切り・空白・小文字が違っても、同じコードなら同じハッシュになる（正規化してからハッシュする）", () => {
    const a = hashRecoveryCode("K7Q2M-9XP4H-TR8WN-B3D6F");
    const b = hashRecoveryCode("k7q2m 9xp4h-tr8wn-b3d6f");
    const c = hashRecoveryCode(VALID);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it("異なるコードは異なるハッシュになる", () => {
    const other = "9XP4HTR8WNB3D6FK7Q2M"; // VALID の文字を並べ替えた別の20文字
    expect(hashRecoveryCode(VALID)).not.toBe(hashRecoveryCode(other));
  });

  it("正規化できない入力は throw する（平文を保存する側での取り違えを避ける）", () => {
    expect(() => hashRecoveryCode("SHORT")).toThrow("invalid recovery code");
    expect(() => hashRecoveryCode("O0O0O0O0O0O0O0O0O0O0")).toThrow("invalid recovery code");
  });
});

describe("isRecoveryCodeHash", () => {
  it("64文字の16進小文字は true", () => {
    expect(isRecoveryCodeHash("a".repeat(64))).toBe(true);
    expect(isRecoveryCodeHash(hashRecoveryCode("K7Q2M9XP4HTR8WNB3D6F"))).toBe(true);
  });

  it("63文字・65文字は false（長さ違い）", () => {
    expect(isRecoveryCodeHash("a".repeat(63))).toBe(false);
    expect(isRecoveryCodeHash("a".repeat(65))).toBe(false);
  });

  it("大文字の16進は false（保存形式は小文字のみ）", () => {
    expect(isRecoveryCodeHash("A".repeat(64))).toBe(false);
  });

  it("16進でない文字を含むと false", () => {
    expect(isRecoveryCodeHash("g".repeat(64))).toBe(false);
  });

  it("平文のコード（20文字）は false（平文とハッシュを取り違えない）", () => {
    expect(isRecoveryCodeHash("K7Q2M9XP4HTR8WNB3D6F")).toBe(false);
  });

  it("文字列でない値・空文字は false", () => {
    expect(isRecoveryCodeHash(null)).toBe(false);
    expect(isRecoveryCodeHash(undefined)).toBe(false);
    expect(isRecoveryCodeHash(12345)).toBe(false);
    expect(isRecoveryCodeHash("")).toBe(false);
  });
});

describe("issueRecoveryCode（サインアップ・リカバリー完了・作り直しの共通入口）", () => {
  it("code は区切り済みの表示形式（ハイフンを含む）、hash はそのコードの hashRecoveryCode と一致する", () => {
    const issued = issueRecoveryCode();
    expect(issued.code).toContain(RECOVERY_CODE_SEPARATOR);
    expect(issued.code.replace(/-/g, "")).toHaveLength(RECOVERY_CODE_LENGTH);
    expect(hashRecoveryCode(issued.code)).toBe(issued.hash);
    expect(isRecoveryCodeHash(issued.hash)).toBe(true);
  });

  it("hash は平文（code）と一致しない（平文をそのまま保存しない）", () => {
    const issued = issueRecoveryCode();
    expect(issued.hash).not.toBe(issued.code);
    expect(issued.hash).not.toContain(issued.code.replace(/-/g, ""));
  });

  it("呼ぶたびに違う code・hash になる", () => {
    const first = issueRecoveryCode();
    const second = issueRecoveryCode();
    expect(first.code).not.toBe(second.code);
    expect(first.hash).not.toBe(second.hash);
  });
});
