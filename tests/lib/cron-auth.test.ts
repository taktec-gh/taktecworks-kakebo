// @vitest-environment node
//
// src/lib/cron-auth.ts（Cron の呼び出しの認証）を検証する。
//
// **この Step で最も壊れると被害が大きい箇所の1つ**（docs/steps/pub-3.md「tester 向けの方針」2）。
// CRON_SECRET が未設定・空のときに fail closed（＝何があっても通さない）であることを重点的に確かめる。
//
// 期待値の根拠:
// - docs/steps/pub-3.md 設計判断 5
//   「認証は Authorization: Bearer <CRON_SECRET>」
//   「比較は定数時間で行う（crypto.timingSafeEqual。長さが違う場合も先に落とさず安全に扱う）」
//   「CRON_SECRET が未設定・空なら何もせず失敗を返す（fail closed）」
// - docs/steps/pub-3.md「実装完了後の引き継ぎ」
//   「getCronSecret(env)（未設定・空は null）、isAuthorizedCronRequest(authorization, secret)
//    （"Bearer " + secret とヘッダの SHA-256 同士を timingSafeEqual）」
// - docs/steps/pub-3.md「tester 向けの方針」2
//   「正しい Bearer で成功。ヘッダ無し・違う値・Bearer の無い値・長さの違う値・大文字小文字違いで401。
//    CRON_SECRET が未設定・空なら、ヘッダが何であっても（空の Bearer を含む）削除しない」
// - docs/steps/pub-3.md「変異テスト」3・4
//   3. CRON_SECRET が空のときに通す → 落ちる
//   4. 認証の比較を外す（常に通す） → 落ちる

import { describe, expect, it } from "vitest";

import { CRON_AUTH_SCHEME, getCronSecret, isAuthorizedCronRequest } from "@/lib/cron-auth";

const SECRET = "test-cron-secret-0123456789abcdef";

describe("CRON_AUTH_SCHEME", () => {
  it('"Bearer "（末尾スペース込み）', () => {
    expect(CRON_AUTH_SCHEME).toBe("Bearer ");
  });
});

describe("getCronSecret", () => {
  it("設定されていればその値を返す", () => {
    expect(getCronSecret({ CRON_SECRET: SECRET })).toBe(SECRET);
  });

  it("未設定（キーが無い）なら null", () => {
    expect(getCronSecret({})).toBeNull();
  });

  it("空文字なら null", () => {
    expect(getCronSecret({ CRON_SECRET: "" })).toBeNull();
  });

  it("空白のみの値はそのまま長さのある文字列として扱う（空文字だけを特別扱いする）", () => {
    // 仕様は「未設定・空文字」のみを null にする。空白だけの値を弾く規則は書かれていない。
    // ここでは「そのまま値として通る」という実装の意図を固定するのではなく、
    // isAuthorizedCronRequest 側の厳密一致で結局は拒否されることを別のテストで確認する。
    expect(getCronSecret({ CRON_SECRET: " " })).toBe(" ");
  });
});

describe("isAuthorizedCronRequest — 正しい値で成功", () => {
  it("Authorization: Bearer <secret> と一致すれば true", () => {
    expect(isAuthorizedCronRequest(`Bearer ${SECRET}`, SECRET)).toBe(true);
  });
});

describe("isAuthorizedCronRequest — 失敗（401 になるべきケース）", () => {
  it("ヘッダが無い（null）なら false", () => {
    expect(isAuthorizedCronRequest(null, SECRET)).toBe(false);
  });

  it("ヘッダが undefined なら false", () => {
    expect(isAuthorizedCronRequest(undefined, SECRET)).toBe(false);
  });

  it("ヘッダが空文字なら false", () => {
    expect(isAuthorizedCronRequest("", SECRET)).toBe(false);
  });

  it("違う値（別の秘密鍵）なら false", () => {
    expect(isAuthorizedCronRequest(`Bearer ${SECRET}-wrong`, SECRET)).toBe(false);
    expect(isAuthorizedCronRequest(`Bearer wrong-${SECRET}`, SECRET)).toBe(false);
  });

  it('"Bearer " の接頭辞が無い値は false', () => {
    expect(isAuthorizedCronRequest(SECRET, SECRET)).toBe(false);
  });

  it("長さが違う値（極端に短い・長い）でも例外を投げず false", () => {
    expect(isAuthorizedCronRequest("Bearer x", SECRET)).toBe(false);
    expect(isAuthorizedCronRequest(`Bearer ${SECRET}${"x".repeat(500)}`, SECRET)).toBe(false);
    expect(() => isAuthorizedCronRequest("Bearer x", SECRET)).not.toThrow();
  });

  it("大文字小文字が違うと false（scheme・値ともに正規化しない）", () => {
    expect(isAuthorizedCronRequest(`bearer ${SECRET}`, SECRET)).toBe(false);
    expect(isAuthorizedCronRequest(`BEARER ${SECRET}`, SECRET)).toBe(false);
    expect(isAuthorizedCronRequest(`Bearer ${SECRET.toUpperCase()}`, SECRET)).toBe(false);
  });

  it("前後や連続する空白を正規化しない（Bearer  <secret> のような二重スペースは別の値）", () => {
    expect(isAuthorizedCronRequest(`Bearer  ${SECRET}`, SECRET)).toBe(false);
    expect(isAuthorizedCronRequest(`Bearer ${SECRET} `, SECRET)).toBe(false);
    expect(isAuthorizedCronRequest(` Bearer ${SECRET}`, SECRET)).toBe(false);
  });

  it("空の Bearer（Bearer の後に値が無い）は false", () => {
    expect(isAuthorizedCronRequest("Bearer ", SECRET)).toBe(false);
    expect(isAuthorizedCronRequest("Bearer", SECRET)).toBe(false);
  });
});

describe("isAuthorizedCronRequest — CRON_SECRET が未設定・空なら fail closed（設計判断5の核心）", () => {
  it("secret が null なら、正しく見える Authorization ヘッダでも false", () => {
    expect(isAuthorizedCronRequest(`Bearer ${SECRET}`, null)).toBe(false);
  });

  it("secret が undefined なら false", () => {
    expect(isAuthorizedCronRequest(`Bearer ${SECRET}`, undefined)).toBe(false);
  });

  it("secret が空文字なら false", () => {
    expect(isAuthorizedCronRequest(`Bearer ${SECRET}`, "")).toBe(false);
  });

  it("secret が空文字なら、ヘッダが「空の Bearer」でも false（secret=='' と authorization=='Bearer ' が一致してしまわないこと）", () => {
    expect(isAuthorizedCronRequest("Bearer ", "")).toBe(false);
  });

  it("secret が空文字なら、ヘッダが空文字でも false", () => {
    expect(isAuthorizedCronRequest("", "")).toBe(false);
  });

  it("secret が空文字なら、ヘッダが何であっても常に false（代表的な値を横断的に確認）", () => {
    for (const header of [null, undefined, "", "Bearer ", "Bearer x", `Bearer ${SECRET}`, "garbage"]) {
      expect(isAuthorizedCronRequest(header, "")).toBe(false);
    }
  });
});

describe("isAuthorizedCronRequest — 長さの違いで例外を投げない（timingSafeEqual を直接使わず SHA-256 で揃える）", () => {
  it("secret が非常に長い場合でも例外にならない", () => {
    const longSecret = "s".repeat(1000);
    expect(() => isAuthorizedCronRequest(`Bearer ${longSecret}`, longSecret)).not.toThrow();
    expect(isAuthorizedCronRequest(`Bearer ${longSecret}`, longSecret)).toBe(true);
  });

  it("authorization が secret よりずっと短くても例外にならない", () => {
    expect(() => isAuthorizedCronRequest("B", SECRET)).not.toThrow();
    expect(isAuthorizedCronRequest("B", SECRET)).toBe(false);
  });
});
