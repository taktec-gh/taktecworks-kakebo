// @vitest-environment node
//
// jose は Web Crypto の Uint8Array を realm 越しに instanceof で判定するため、
// jsdom 環境で動かすと "payload must be an instance of Uint8Array" で落ちる。
// 実際の Next.js は Node / Edge ランタイムで動くので、この層は node 環境で検証する。
//
// 期待値の根拠:
// - docs/steps/pub-1.md 設計判断 1「パスワードログインと RECOVERY_MODE はこの Step で
//   廃止する」「削除するもの: getAppPassword / verifyPassword / safeEqual（他で使っていなければ）」
//   → safeEqual / verifyPassword / getAppPassword のテストは削除する
// - docs/steps/pub-1.md 設計判断 8
//   「createSessionToken(secret, userId: UserId, options)。JWT の sub にユーザーIDを入れる。
//    SESSION_SUBJECT = "owner" は削除する」
//   「verifySessionToken は { userId: UserId; iat; exp } | null を返す。sub が文字列でない・
//    空文字なら null」
// - docs/steps/pub-1.md「実装完了後の引き継ぎ > 仕様から補足・判断した点」
//   「セッション JWT は typ ヘッダに SESSION_JWT_TYP = "kakebo-session+jwt" を付け、検証で
//    一致を必須にしている。チャレンジ JWT には typ を付けない」
//   「LOGIN_ERROR_MESSAGE の文言を変更した。新しい文言は『ログインできませんでした。
//    もう一度お試しください。』」

import { SignJWT, generateKeyPair } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  LOGIN_ERROR_MESSAGE,
  LOGIN_PATH,
  SESSION_COOKIE_NAME,
  SESSION_JWT_ALG,
  SESSION_JWT_TYP,
  SESSION_MAX_AGE_SECONDS,
  createSessionToken,
  getAuthSecret,
  getSessionCookieOptions,
  isPublicPath,
  verifySessionToken,
} from "@/lib/auth";
import type { UserId } from "@/lib/user-id";

/** テスト用の署名鍵。実運用では十分に長いランダム文字列 */
const SECRET = "test-auth-secret-0123456789abcdef";
const OTHER_SECRET = "another-auth-secret-fedcba9876543210";
const USER_ID = "clx1234567890" as UserId;
const OTHER_USER_ID = "clx0987654321" as UserId;

/**
 * 固定時刻。2026-01-15T00:00:00.000Z。
 *
 * 手計算した UNIX 秒:
 *   1970-01-01 から 2026-01-01 までの日数
 *     = 56年 * 365日 + 閏日14日（1972,1976,...,2024。2000年は400で割れるので閏年）
 *     = 20440 + 14 = 20454 日
 *   2026-01-15 は そこから +14 日 → 20468 日
 *   20468 * 86400 = 1,768,435,200 秒
 */
const FIXED_NOW = new Date("2026-01-15T00:00:00.000Z");
const FIXED_IAT = 1768435200;
/** 既定の有効期間 30日 = 2,592,000 秒 を足した値。1768435200 + 2592000 */
const FIXED_DEFAULT_EXP = 1771027200;

/** JWT のペイロード部を検証なしで取り出す（テスト用のデコード） */
function decodeSegment(token: string, index: 0 | 1): Record<string, unknown> {
  const segment = token.split(".")[index];
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
}

function decodeHeader(token: string): Record<string, unknown> {
  return decodeSegment(token, 0);
}

function encodeSegment(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

/**
 * JWS の署名（base64url）を「デコード後のバイト列が必ず変わる」形で改竄する。
 *
 * 末尾の1文字だけを差し替える方法は使わない。HS256 の32バイト署名は base64url で
 * 43文字になり、末尾の1文字は上位4bitしか意味を持たない（下位2bitは未使用のパディング）。
 * そのため末尾を A/B/C/D の間で置換してもデコード結果のバイト列は変わらず、
 * 改竄になっていないことがある（実測で確認済み）。
 * 先頭の1文字は常に完全な6bitを占有するため、別の文字に変えれば必ずバイト列が変わる。
 */
function tamperSignature(signature: string): string {
  const replacement = signature[0] === "A" ? "B" : "A";
  const tampered = replacement + signature.slice(1);
  const originalBytes = Buffer.from(signature, "base64url");
  const tamperedBytes = Buffer.from(tampered, "base64url");
  if (tamperedBytes.equals(originalBytes)) {
    // ここに来ることは無いはずだが、来た場合はテスト自体が改竄になっていない
    throw new Error("tamperSignature: バイト列が変化していません（テスト側の不備）");
  }
  return tampered;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("定数", () => {
  it("セッション有効期間は30日（手計算: 30 * 24 * 60 * 60 = 2592000 秒）", () => {
    expect(SESSION_MAX_AGE_SECONDS).toBe(2592000);
  });

  it("Cookie 名・アルゴリズム・ログインパス・typ が仕様どおり", () => {
    expect(SESSION_COOKIE_NAME).toBe("kakeibo_session");
    expect(SESSION_JWT_ALG).toBe("HS256");
    expect(LOGIN_PATH).toBe("/login");
    expect(SESSION_JWT_TYP).toBe("kakebo-session+jwt");
  });

  it("ログイン失敗メッセージは失敗の原因を推測させない", () => {
    // 仕様: 「パスワードが未設定」「文字数が違う」等を推測させない単一の文言
    expect(LOGIN_ERROR_MESSAGE.length).toBeGreaterThan(0);
    for (const leak of ["APP_PASSWORD", "AUTH_SECRET", "未設定", "設定されて", "空", "文字数"]) {
      expect(LOGIN_ERROR_MESSAGE).not.toContain(leak);
    }
  });

  it("ログイン失敗メッセージは新しい文言（パスワード欄が無くなったため）", () => {
    expect(LOGIN_ERROR_MESSAGE).toBe("ログインできませんでした。もう一度お試しください。");
  });
});

describe("getAuthSecret", () => {
  it("注入した env から値を返す", () => {
    expect(getAuthSecret({ AUTH_SECRET: SECRET })).toBe(SECRET);
  });

  it("未定義なら throw", () => {
    expect(() => getAuthSecret({})).toThrow("AUTH_SECRET is not set");
  });

  it("空文字なら throw", () => {
    expect(() => getAuthSecret({ AUTH_SECRET: "" })).toThrow("AUTH_SECRET is not set");
  });

  it("引数省略時は process.env を読む", () => {
    vi.stubEnv("AUTH_SECRET", SECRET);
    expect(getAuthSecret()).toBe(SECRET);
  });
});

describe("createSessionToken", () => {
  it("ドット区切り3セグメントの JWT を返す", async () => {
    const token = await createSessionToken(SECRET, USER_ID, { now: FIXED_NOW });
    expect(token.split(".")).toHaveLength(3);
  });

  it("ヘッダの alg が HS256、typ が SESSION_JWT_TYP", async () => {
    const token = await createSessionToken(SECRET, USER_ID, { now: FIXED_NOW });
    const header = decodeHeader(token);
    expect(header.alg).toBe("HS256");
    expect(header.typ).toBe(SESSION_JWT_TYP);
  });

  it("sub / iat / exp が仕様どおり（sub は渡した userId、iat=1768435200, exp=iat+2592000）", async () => {
    const token = await createSessionToken(SECRET, USER_ID, { now: FIXED_NOW });
    const payload = decodeSegment(token, 1);
    expect(payload.sub).toBe(USER_ID);
    expect(payload.iat).toBe(FIXED_IAT);
    expect(payload.exp).toBe(FIXED_DEFAULT_EXP);
  });

  it("ペイロードに余計な情報（パスワード等）を載せない", async () => {
    const token = await createSessionToken(SECRET, USER_ID, { now: FIXED_NOW });
    expect(Object.keys(decodeSegment(token, 1)).sort()).toEqual(["exp", "iat", "sub"]);
  });

  it("iat はミリ秒を切り捨てる（整数秒。小数にならない）", async () => {
    const token = await createSessionToken(SECRET, USER_ID, {
      now: new Date("2026-01-15T00:00:00.999Z"),
    });
    const payload = decodeSegment(token, 1);
    expect(payload.iat).toBe(FIXED_IAT);
    expect(Number.isInteger(payload.iat)).toBe(true);
    expect(Number.isInteger(payload.exp)).toBe(true);
  });

  it("同じ UTC 時刻であれば JST 表記で渡しても iat は同じ（epoch はタイムゾーン非依存）", async () => {
    // 2026-01-15T09:00:00+09:00 は 2026-01-15T00:00:00Z と同じ瞬間
    const jst = await createSessionToken(SECRET, USER_ID, {
      now: new Date("2026-01-15T09:00:00+09:00"),
    });
    expect(decodeSegment(jst, 1).iat).toBe(FIXED_IAT);
  });

  it("maxAgeSeconds を指定すると exp = iat + 指定値", async () => {
    const token = await createSessionToken(SECRET, USER_ID, { now: FIXED_NOW, maxAgeSeconds: 60 });
    const payload = decodeSegment(token, 1);
    // 手計算: 1768435200 + 60 = 1768435260
    expect(payload.exp).toBe(1768435260);
  });

  it("secret が空文字なら throw", async () => {
    await expect(createSessionToken("", USER_ID)).rejects.toThrow("AUTH_SECRET is not set");
  });

  it("userId が空文字なら throw（誰でもないセッションを発行しない）", async () => {
    await expect(createSessionToken(SECRET, "" as UserId)).rejects.toThrow(
      "user id must be a non-empty string",
    );
  });
});

describe("verifySessionToken", () => {
  it("正しい鍵で発行したトークンを往復でき、userId に渡した UserId が入る", async () => {
    const token = await createSessionToken(SECRET, USER_ID, { now: FIXED_NOW });
    const payload = await verifySessionToken(token, SECRET, { now: FIXED_NOW });
    expect(payload).toEqual({ userId: USER_ID, iat: FIXED_IAT, exp: FIXED_DEFAULT_EXP });
  });

  it("別のユーザーIDで発行すれば、そのユーザーIDが返る（取り違えない）", async () => {
    const token = await createSessionToken(SECRET, OTHER_USER_ID, { now: FIXED_NOW });
    const payload = await verifySessionToken(token, SECRET, { now: FIXED_NOW });
    expect(payload?.userId).toBe(OTHER_USER_ID);
    expect(payload?.userId).not.toBe(USER_ID);
  });

  it("別の鍵で署名されたトークンは null", async () => {
    const token = await createSessionToken(OTHER_SECRET, USER_ID, { now: FIXED_NOW });
    await expect(verifySessionToken(token, SECRET, { now: FIXED_NOW })).resolves.toBeNull();
  });

  it("署名部を1文字改竄すると null", async () => {
    const token = await createSessionToken(SECRET, USER_ID, { now: FIXED_NOW });
    const [header, payload, signature] = token.split(".");
    const tamperedSignature = tamperSignature(signature);
    // 改竄が「文字列として違う」だけでなく「デコード後のバイト列として違う」ことを保証する。
    // 末尾1文字だけの書き換えだと base64url の余りビットにより同一バイト列になり得るため
    // （signature.endsWith("A") ? "B" : "A" の形は不十分。詳細は tamperSignature 参照）
    expect(Buffer.from(tamperedSignature, "base64url")).not.toEqual(
      Buffer.from(signature, "base64url"),
    );
    const tampered = `${header}.${payload}.${tamperedSignature}`;
    await expect(verifySessionToken(tampered, SECRET, { now: FIXED_NOW })).resolves.toBeNull();
  });

  it("ペイロードを差し替えると null（署名はそのまま）", async () => {
    const token = await createSessionToken(SECRET, USER_ID, { now: FIXED_NOW });
    const [header, , signature] = token.split(".");
    const forged = encodeSegment({
      sub: OTHER_USER_ID,
      iat: FIXED_IAT,
      exp: FIXED_IAT + 60 * 60 * 24 * 3650,
    });
    await expect(
      verifySessionToken(`${header}.${forged}.${signature}`, SECRET, { now: FIXED_NOW }),
    ).resolves.toBeNull();
  });

  it("有効期限内なら通る（exp の1秒前）", async () => {
    const token = await createSessionToken(SECRET, USER_ID, { now: FIXED_NOW, maxAgeSeconds: 60 });
    // 手計算: iat=1768435200, exp=1768435260。その1秒前 = 1768435259
    const justBefore = new Date(1768435259 * 1000);
    await expect(verifySessionToken(token, SECRET, { now: justBefore })).resolves.not.toBeNull();
  });

  it("有効期限を過ぎると null", async () => {
    const token = await createSessionToken(SECRET, USER_ID, { now: FIXED_NOW, maxAgeSeconds: 60 });
    // exp=1768435260 の1秒後 = 1768435261
    const justAfter = new Date(1768435261 * 1000);
    await expect(verifySessionToken(token, SECRET, { now: justAfter })).resolves.toBeNull();
  });

  it("30日の既定有効期間: 30日後-1秒は通り、30日後+1秒は null", async () => {
    const token = await createSessionToken(SECRET, USER_ID, { now: FIXED_NOW });
    // exp = 1768435200 + 2592000 = 1771027200
    await expect(
      verifySessionToken(token, SECRET, { now: new Date((FIXED_DEFAULT_EXP - 1) * 1000) }),
    ).resolves.not.toBeNull();
    await expect(
      verifySessionToken(token, SECRET, { now: new Date((FIXED_DEFAULT_EXP + 1) * 1000) }),
    ).resolves.toBeNull();
  });

  it('alg: "none" のトークンは null（アルゴリズムのダウングレード）', async () => {
    const header = encodeSegment({ alg: "none" });
    const payload = encodeSegment({ sub: USER_ID, iat: FIXED_IAT, exp: FIXED_DEFAULT_EXP });
    await expect(
      verifySessionToken(`${header}.${payload}.`, SECRET, { now: FIXED_NOW }),
    ).resolves.toBeNull();
  });

  it("RS256 で署名されたトークンは null", async () => {
    const { privateKey } = await generateKeyPair("RS256", { extractable: true });
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "RS256", typ: SESSION_JWT_TYP })
      .setSubject(USER_ID)
      .setIssuedAt(FIXED_IAT)
      .setExpirationTime(FIXED_DEFAULT_EXP)
      .sign(privateKey);
    await expect(verifySessionToken(token, SECRET, { now: FIXED_NOW })).resolves.toBeNull();
  });

  it("同じ鍵でも HS512 で署名されたトークンは null（alg 混同）", async () => {
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "HS512", typ: SESSION_JWT_TYP })
      .setSubject(USER_ID)
      .setIssuedAt(FIXED_IAT)
      .setExpirationTime(FIXED_DEFAULT_EXP)
      .sign(new TextEncoder().encode(SECRET));
    await expect(verifySessionToken(token, SECRET, { now: FIXED_NOW })).resolves.toBeNull();
  });

  it("sub が無いトークンは null", async () => {
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: SESSION_JWT_ALG, typ: SESSION_JWT_TYP })
      .setIssuedAt(FIXED_IAT)
      .setExpirationTime(FIXED_DEFAULT_EXP)
      .sign(new TextEncoder().encode(SECRET));
    await expect(verifySessionToken(token, SECRET, { now: FIXED_NOW })).resolves.toBeNull();
  });

  it("sub が空文字のトークンは null", async () => {
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: SESSION_JWT_ALG, typ: SESSION_JWT_TYP })
      .setSubject("")
      .setIssuedAt(FIXED_IAT)
      .setExpirationTime(FIXED_DEFAULT_EXP)
      .sign(new TextEncoder().encode(SECRET));
    await expect(verifySessionToken(token, SECRET, { now: FIXED_NOW })).resolves.toBeNull();
  });

  it("exp が無いトークンは null（無期限セッションを作らせない）", async () => {
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: SESSION_JWT_ALG, typ: SESSION_JWT_TYP })
      .setSubject(USER_ID)
      .setIssuedAt(FIXED_IAT)
      .sign(new TextEncoder().encode(SECRET));
    await expect(verifySessionToken(token, SECRET, { now: FIXED_NOW })).resolves.toBeNull();
  });

  it("exp が数値でない（文字列）トークンは null", async () => {
    const token = await new SignJWT({ exp: "9999999999" as unknown as number })
      .setProtectedHeader({ alg: SESSION_JWT_ALG, typ: SESSION_JWT_TYP })
      .setSubject(USER_ID)
      .setIssuedAt(FIXED_IAT)
      .sign(new TextEncoder().encode(SECRET));
    await expect(verifySessionToken(token, SECRET, { now: FIXED_NOW })).resolves.toBeNull();
  });

  it("iat が無いトークンは null", async () => {
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: SESSION_JWT_ALG, typ: SESSION_JWT_TYP })
      .setSubject(USER_ID)
      .setExpirationTime(FIXED_DEFAULT_EXP)
      .sign(new TextEncoder().encode(SECRET));
    await expect(verifySessionToken(token, SECRET, { now: FIXED_NOW })).resolves.toBeNull();
  });

  it.each([
    ["空文字", ""],
    ["undefined", undefined],
    ["null", null],
    ["a.b.c", "a.b.c"],
    ["JWT ですらない文字列", "not-a-jwt"],
    ["セグメント数が2つ", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJvd25lciJ9"],
    ["空白のみ", "   "],
  ])("不正な token (%s) は throw せず null", async (_label, token) => {
    await expect(
      verifySessionToken(token as string | undefined | null, SECRET, { now: FIXED_NOW }),
    ).resolves.toBeNull();
  });

  it("secret が空文字のときだけ throw する", async () => {
    const token = await createSessionToken(SECRET, USER_ID, { now: FIXED_NOW });
    await expect(verifySessionToken(token, "")).rejects.toThrow("AUTH_SECRET is not set");
    await expect(verifySessionToken("", "")).rejects.toThrow("AUTH_SECRET is not set");
  });

  describe("typ ヘッダ（チャレンジ JWT との取り違え対策。設計判断 8）", () => {
    it("typ が SESSION_JWT_TYP でないトークンは null", async () => {
      const token = await new SignJWT({})
        .setProtectedHeader({ alg: SESSION_JWT_ALG, typ: "something-else" })
        .setSubject(USER_ID)
        .setIssuedAt(FIXED_IAT)
        .setExpirationTime(FIXED_DEFAULT_EXP)
        .sign(new TextEncoder().encode(SECRET));
      await expect(verifySessionToken(token, SECRET, { now: FIXED_NOW })).resolves.toBeNull();
    });

    it("typ ヘッダが無いトークン（チャレンジ JWT はこの形）は null。sub・鍵・期限が正しくても通さない", async () => {
      // src/lib/passkey.ts の createChallengeToken は typ を付けない。
      // ここではチャレンジ JWT をセッションとして渡した状況を直接再現する
      // （チャレンジの sub 値 "passkey-register" を使っても、typ が無い時点で拒否されること）。
      const token = await new SignJWT({})
        .setProtectedHeader({ alg: SESSION_JWT_ALG }) // typ を付けない
        .setSubject("passkey-register")
        .setIssuedAt(FIXED_IAT)
        .setExpirationTime(FIXED_IAT + 120)
        .sign(new TextEncoder().encode(SECRET));
      await expect(
        verifySessionToken(token, SECRET, { now: FIXED_NOW }),
      ).resolves.toBeNull();
    });

    it("実際にチャレンジ JWT を作って（createChallengeToken）セッションとして渡しても null", async () => {
      const { createChallengeToken } = await import("@/lib/passkey");
      const challengeToken = await createChallengeToken("some-challenge", "authenticate", SECRET, {
        now: FIXED_NOW,
      });
      await expect(
        verifySessionToken(challengeToken, SECRET, { now: FIXED_NOW }),
      ).resolves.toBeNull();
    });
  });
});

describe("getSessionCookieOptions", () => {
  it("isProduction: false なら secure: false", () => {
    expect(getSessionCookieOptions({ isProduction: false }).secure).toBe(false);
  });

  it("isProduction: true なら secure: true", () => {
    expect(getSessionCookieOptions({ isProduction: true }).secure).toBe(true);
  });

  it("httpOnly / sameSite / path は常に固定", () => {
    for (const isProduction of [true, false]) {
      const options = getSessionCookieOptions({ isProduction });
      // httpOnly: JS から読めない（XSS でセッションを盗まれない）
      expect(options.httpOnly).toBe(true);
      // sameSite lax: 外部サイトからの POST に Cookie を付けない
      expect(options.sameSite).toBe("lax");
      expect(options.path).toBe("/");
    }
  });

  it("maxAge の既定はセッション有効期間と同じ 2592000 秒", () => {
    expect(getSessionCookieOptions({ isProduction: false }).maxAge).toBe(2592000);
    expect(getSessionCookieOptions({ isProduction: false }).maxAge).toBe(SESSION_MAX_AGE_SECONDS);
  });

  it("maxAgeSeconds を指定するとその値になる", () => {
    expect(getSessionCookieOptions({ isProduction: false, maxAgeSeconds: 60 }).maxAge).toBe(60);
    expect(getSessionCookieOptions({ isProduction: false, maxAgeSeconds: 0 }).maxAge).toBe(0);
  });

  it("Cookie の寿命が JWT の寿命を超えない", async () => {
    const token = await createSessionToken(SECRET, USER_ID, { now: FIXED_NOW });
    const payload = decodeSegment(token, 1) as { iat: number; exp: number };
    const tokenLifetime = payload.exp - payload.iat;
    expect(getSessionCookieOptions({ isProduction: true }).maxAge).toBeLessThanOrEqual(
      tokenLifetime,
    );
  });

  it("既定は NODE_ENV === 'production' のときだけ secure: true", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(getSessionCookieOptions().secure).toBe(true);

    vi.stubEnv("NODE_ENV", "development");
    expect(getSessionCookieOptions().secure).toBe(false);

    vi.stubEnv("NODE_ENV", "test");
    expect(getSessionCookieOptions().secure).toBe(false);
  });
});

describe("isPublicPath", () => {
  it('"/" は認証必須（ダッシュボードが無防備になるため）', () => {
    expect(isPublicPath("/")).toBe(false);
  });

  it.each([
    "/expenses",
    "/expenses/new",
    "/settings",
    "/settings/payment-sources",
    "/api/expenses",
    "/dashboard",
  ])("保護対象のパス %s は false", (pathname) => {
    expect(isPublicPath(pathname)).toBe(false);
  });

  it.each([
    "/login",
    "/favicon.ico",
    "/robots.txt",
    "/manifest.webmanifest",
    "/_next/static/chunks/main.js",
    "/_next/image",
  ])("認証不要のパス %s は true", (pathname) => {
    expect(isPublicPath(pathname)).toBe(true);
  });

  it("前方一致で通り抜けられない", () => {
    // "/login" で始まるだけの別パスを公開扱いにしない
    expect(isPublicPath("/loginx")).toBe(false);
    expect(isPublicPath("/login-secret")).toBe(false);
    expect(isPublicPath("/_nextdoor")).toBe(false);
    // 逆に "/login/" 配下は公開
    expect(isPublicPath("/login/")).toBe(true);
  });

  it("大文字小文字を区別する", () => {
    expect(isPublicPath("/LOGIN")).toBe(false);
    expect(isPublicPath("/Login")).toBe(false);
  });

  it("空文字は false", () => {
    expect(isPublicPath("")).toBe(false);
  });
});
