// @vitest-environment node
//
// src/lib/webauthn-user-id.ts（WebAuthn のユーザーID・表示名・userHandle の照合）を検証する。
// node:crypto を使うため node 環境（tests/lib/auth.test.ts 冒頭のコメントと同じ理由）。
//
// 期待値の根拠:
// - docs/steps/pub-2.md 設計判断 3「WebAuthn のユーザーID（user handle）をユーザーごとの
//   ランダム値にする」「User に webauthnUserId（一意）を足す。32バイトの暗号学的乱数を
//   base64url にした文字列（WebAuthn の上限は64バイト）」
//   「表示名は webauthnUserId から決まる短い識別子にする。例: 家計簿 #K7Q2
//   （webauthnUserId の SHA-256 から、紛らわしい文字を除いた4文字）」
//   「利用者の入力（名前・メールアドレス）を使わない」
//   「同じユーザーなら、サインアップ時も設定画面での追加登録時も同じ表示名になること」
// - docs/steps/pub-2.md 設計判断 4「応答の userHandle が資格情報の持ち主の webauthnUserId と
//   一致しないならログイン失敗」
// - docs/steps/pub-2.md「tester 向けの方針」6.
//   「32バイト相当の長さ、base64url、呼ぶたびに違う値。表示名が決定的で、同じ値から同じ表示名に
//   なり、紛らわしい文字を含まない」
// - docs/steps/pub-2.md「実装完了後の引き継ぎ」
//   「generateWebauthnUserId()（32バイト乱数の base64url、43文字。作る関数はこれ1つ）、
//   isValidWebauthnUserId、webauthnUserIdToBytes、getPasskeyDisplayName（家計簿 #XXXX。
//   SHA-256 由来で決定的。アルファベットは PASSKEY_DISPLAY_CODE_ALPHABET）、
//   userHandleMatches(userHandle, webauthnUserId)」

import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  generateWebauthnUserId,
  getPasskeyDisplayName,
  isValidWebauthnUserId,
  PASSKEY_DISPLAY_CODE_ALPHABET,
  PASSKEY_DISPLAY_CODE_LENGTH,
  PASSKEY_DISPLAY_NAME_PREFIX,
  userHandleMatches,
  webauthnUserIdToBytes,
  WEBAUTHN_USER_ID_BYTES,
  WEBAUTHN_USER_ID_LENGTH,
} from "@/lib/webauthn-user-id";

// 32バイトの手元生成済み固定値（node -e "Buffer.from([1..32]).toString('base64url')"）
const FIXED_ID_A = "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA";
const FIXED_ID_B = "__79_Pv6-fj39vX08_Lx8O_u7ezr6uno5-bl5OPi4eA";

describe("定数", () => {
  it("32バイト・base64url43文字（手計算: ceil(32*8/6)=43、余り2bitはパディング無し）", () => {
    expect(WEBAUTHN_USER_ID_BYTES).toBe(32);
    expect(WEBAUTHN_USER_ID_LENGTH).toBe(43);
  });
});

describe("generateWebauthnUserId", () => {
  it("43文字（32バイトの base64url）を返す", () => {
    const id = generateWebauthnUserId();
    expect(id).toHaveLength(43);
  });

  it("isValidWebauthnUserId を満たす値を返す", () => {
    expect(isValidWebauthnUserId(generateWebauthnUserId())).toBe(true);
  });

  it("呼ぶたびに違う値になる（暗号学的乱数）", () => {
    const values = new Set(Array.from({ length: 20 }, () => generateWebauthnUserId()));
    expect(values.size).toBe(20);
  });

  it("base64url のみで構成される（+ / = を含まない）", () => {
    const id = generateWebauthnUserId();
    expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(id).not.toMatch(/[+/=]/);
  });
});

describe("isValidWebauthnUserId", () => {
  it("正しい43文字の base64url は true", () => {
    expect(isValidWebauthnUserId(FIXED_ID_A)).toBe(true);
    expect(isValidWebauthnUserId(FIXED_ID_B)).toBe(true);
  });

  it("42文字（1文字短い）は false", () => {
    expect(isValidWebauthnUserId(FIXED_ID_A.slice(0, 42))).toBe(false);
  });

  it("44文字（1文字長い）は false", () => {
    expect(isValidWebauthnUserId(`${FIXED_ID_A}A`)).toBe(false);
  });

  it("base64url に無い文字（+ / =）を含むと false", () => {
    const tampered = `${FIXED_ID_A.slice(0, 42)}+`;
    expect(isValidWebauthnUserId(tampered)).toBe(false);
    expect(isValidWebauthnUserId(`${FIXED_ID_A.slice(0, 42)}=`)).toBe(false);
  });

  it("文字列でない値は false", () => {
    expect(isValidWebauthnUserId(undefined)).toBe(false);
    expect(isValidWebauthnUserId(null)).toBe(false);
    expect(isValidWebauthnUserId(12345)).toBe(false);
    expect(isValidWebauthnUserId({})).toBe(false);
  });

  it("空文字は false", () => {
    expect(isValidWebauthnUserId("")).toBe(false);
  });
});

describe("webauthnUserIdToBytes", () => {
  it("32バイトの Uint8Array を返す", () => {
    const bytes = webauthnUserIdToBytes(FIXED_ID_A);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBe(32);
  });

  it("元の文字列を decode したバイト列と一致する（往復可能）", () => {
    const bytes = webauthnUserIdToBytes(FIXED_ID_A);
    expect(Buffer.from(bytes).toString("base64url")).toBe(FIXED_ID_A);
    // 手元生成の値: [1,2,...,32]
    expect(Array.from(bytes)).toEqual(Array.from({ length: 32 }, (_, i) => i + 1));
  });

  it("不正な形式なら throw する", () => {
    expect(() => webauthnUserIdToBytes("not-valid")).toThrow("invalid webauthnUserId");
  });
});

describe("getPasskeyDisplayName（決定的。SHA-256の先頭4バイトから作る）", () => {
  /** 実装の仕様を独立に再計算する（getPasskeyDisplayName を呼ばずに検証するため） */
  function computeExpected(webauthnUserId: string): string {
    const digest = createHash("sha256").update(webauthnUserId).digest();
    let code = "";
    for (let i = 0; i < PASSKEY_DISPLAY_CODE_LENGTH; i += 1) {
      code += PASSKEY_DISPLAY_CODE_ALPHABET[digest[i] % PASSKEY_DISPLAY_CODE_ALPHABET.length];
    }
    return `${PASSKEY_DISPLAY_NAME_PREFIX} #${code}`;
  }

  it("独立に計算した SHA-256 由来の値と一致する（固定値A）", () => {
    expect(getPasskeyDisplayName(FIXED_ID_A)).toBe(computeExpected(FIXED_ID_A));
  });

  it("独立に計算した SHA-256 由来の値と一致する（固定値B）", () => {
    expect(getPasskeyDisplayName(FIXED_ID_B)).toBe(computeExpected(FIXED_ID_B));
  });

  it("同じ webauthnUserId なら常に同じ表示名（決定的。サインアップ時と追加登録時で揃う）", () => {
    expect(getPasskeyDisplayName(FIXED_ID_A)).toBe(getPasskeyDisplayName(FIXED_ID_A));
  });

  it("プレフィックスは「家計簿 #」+ 4文字", () => {
    const name = getPasskeyDisplayName(FIXED_ID_A);
    expect(name).toMatch(/^家計簿 #.{4}$/u);
  });

  it("識別子の4文字はすべて PASSKEY_DISPLAY_CODE_ALPHABET に含まれる文字だけで構成される", () => {
    const name = getPasskeyDisplayName(FIXED_ID_A);
    const code = name.slice(`${PASSKEY_DISPLAY_NAME_PREFIX} #`.length);
    expect(code).toHaveLength(PASSKEY_DISPLAY_CODE_LENGTH);
    for (const ch of code) {
      expect(PASSKEY_DISPLAY_CODE_ALPHABET).toContain(ch);
    }
  });

  it("紛らわしい文字（0, 1, I, L, O）をアルファベットに含まない", () => {
    for (const confusing of ["0", "1", "I", "L", "O"]) {
      expect(PASSKEY_DISPLAY_CODE_ALPHABET).not.toContain(confusing);
    }
  });

  it("異なる webauthnUserId からは（通常）異なる表示名になる", () => {
    expect(getPasskeyDisplayName(FIXED_ID_A)).not.toBe(getPasskeyDisplayName(FIXED_ID_B));
  });

  it("利用者の入力を使わない（同じ入力なら環境・時刻に依存せず同じ結果）", () => {
    const first = getPasskeyDisplayName(FIXED_ID_A);
    const second = getPasskeyDisplayName(FIXED_ID_A);
    expect(first).toBe(second);
  });
});

describe("userHandleMatches（ログイン時の user handle 照合。設計判断 4）", () => {
  it("完全に一致すれば true", () => {
    expect(userHandleMatches(FIXED_ID_A, FIXED_ID_A)).toBe(true);
  });

  it("異なる値なら false", () => {
    expect(userHandleMatches(FIXED_ID_A, FIXED_ID_B)).toBe(false);
  });

  it("userHandle が無い（undefined/null）なら false", () => {
    expect(userHandleMatches(undefined, FIXED_ID_A)).toBe(false);
    expect(userHandleMatches(null, FIXED_ID_A)).toBe(false);
  });

  it("userHandle が空文字なら false", () => {
    expect(userHandleMatches("", FIXED_ID_A)).toBe(false);
  });

  it("webauthnUserId が空文字なら false（比較先が空でも一致させない）", () => {
    expect(userHandleMatches("", "")).toBe(false);
    expect(userHandleMatches(FIXED_ID_A, "")).toBe(false);
  });

  it("末尾の base64url パディング（=）の有無だけの違いは吸収する", () => {
    expect(userHandleMatches(`${FIXED_ID_A}=`, FIXED_ID_A)).toBe(true);
    expect(userHandleMatches(FIXED_ID_A, `${FIXED_ID_A}==`)).toBe(true);
  });

  it("他人の資格情報に自分の user handle を付けた応答は不一致になる", () => {
    // A の資格情報（webauthnUserId=FIXED_ID_A）に対し、B の user handle（FIXED_ID_B）を
    // 応答として送ってきた状況を想定する
    expect(userHandleMatches(FIXED_ID_B, FIXED_ID_A)).toBe(false);
  });
});
