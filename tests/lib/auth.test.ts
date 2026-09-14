// @vitest-environment node
//
// jose は Web Crypto の Uint8Array を realm 越しに instanceof で判定するため、
// jsdom 環境で動かすと "payload must be an instance of Uint8Array" で落ちる。
// 実際の Next.js は Node / Edge ランタイムで動くので、この層は node 環境で検証する。

import { SignJWT, generateKeyPair } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  LOGIN_ERROR_MESSAGE,
  LOGIN_PATH,
  SESSION_COOKIE_NAME,
  SESSION_JWT_ALG,
  SESSION_MAX_AGE_SECONDS,
  SESSION_SUBJECT,
  createSessionToken,
  getAppPassword,
  getAuthSecret,
  getSessionCookieOptions,
  isPublicPath,
  safeEqual,
  verifyPassword,
  verifySessionToken,
} from "@/lib/auth";

/** テスト用の署名鍵。実運用では十分に長いランダム文字列 */
const SECRET = "test-auth-secret-0123456789abcdef";
const OTHER_SECRET = "another-auth-secret-fedcba9876543210";

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

  it("Cookie 名・sub・アルゴリズム・ログインパスが仕様どおり", () => {
    expect(SESSION_COOKIE_NAME).toBe("kakeibo_session");
    expect(SESSION_SUBJECT).toBe("owner");
    expect(SESSION_JWT_ALG).toBe("HS256");
    expect(LOGIN_PATH).toBe("/login");
  });

  it("ログイン失敗メッセージは失敗の原因を推測させない", () => {
    // 仕様: 「パスワードが未設定」「文字数が違う」等を推測させない単一の文言
    expect(LOGIN_ERROR_MESSAGE.length).toBeGreaterThan(0);
    for (const leak of ["APP_PASSWORD", "AUTH_SECRET", "未設定", "設定されて", "空", "文字数"]) {
      expect(LOGIN_ERROR_MESSAGE).not.toContain(leak);
    }
  });
});

describe("safeEqual", () => {
  it("同じ文字列は true", () => {
    expect(safeEqual("password", "password")).toBe(true);
  });

  it("異なる文字列は false", () => {
    expect(safeEqual("password", "passworD")).toBe(false);
    expect(safeEqual("password", "Password")).toBe(false);
  });

  it("長さが違えば false（片方がもう片方の接頭辞でも）", () => {
    expect(safeEqual("pass", "password")).toBe(false);
    expect(safeEqual("password", "pass")).toBe(false);
    expect(safeEqual("password", "password ")).toBe(false);
  });

  it("空文字どうしは true（空パスワードの拒否は verifyPassword 側の責務）", () => {
    expect(safeEqual("", "")).toBe(true);
  });

  it("片方だけ空文字なら false", () => {
    expect(safeEqual("", "password")).toBe(false);
    expect(safeEqual("password", "")).toBe(false);
  });

  it("マルチバイト文字を UTF-8 バイト単位で正しく比較する", () => {
    expect(safeEqual("ひみつのパスワード", "ひみつのパスワード")).toBe(true);
    expect(safeEqual("ぱすわーど", "パスワード")).toBe(false);
    // 濁点1つの違い（UTF-8 では3バイト目だけが異なる）
    expect(safeEqual("あ", "ぁ")).toBe(false);
    // 絵文字（サロゲートペア）
    expect(safeEqual("🔑鍵", "🔑鍵")).toBe(true);
    expect(safeEqual("🔑鍵", "🔒鍵")).toBe(false);
  });

  it("末尾1文字だけ違う長い文字列も false（早期 return しないことの確認）", () => {
    const base = "a".repeat(1000);
    expect(safeEqual(base + "x", base + "y")).toBe(false);
    expect(safeEqual(base + "x", base + "x")).toBe(true);
  });
});

describe("verifyPassword", () => {
  it("一致すれば true", () => {
    expect(verifyPassword("correct-horse", "correct-horse")).toBe(true);
  });

  it("不一致なら false", () => {
    expect(verifyPassword("wrong", "correct-horse")).toBe(false);
  });

  it("期待値が空文字なら、どんな入力でも false（APP_PASSWORD 未設定で全通しになる事故の防止）", () => {
    expect(verifyPassword("", "")).toBe(false);
    expect(verifyPassword("anything", "")).toBe(false);
    expect(verifyPassword(" ", "")).toBe(false);
    expect(verifyPassword("0", "")).toBe(false);
  });

  it("入力が空文字なら false", () => {
    expect(verifyPassword("", "correct-horse")).toBe(false);
  });

  it("前後の空白を trim しない", () => {
    expect(verifyPassword(" pw", "pw")).toBe(false);
    expect(verifyPassword("pw ", "pw")).toBe(false);
    expect(verifyPassword("pw", " pw")).toBe(false);
    expect(verifyPassword(" pw ", " pw ")).toBe(true);
  });

  it("大文字小文字を区別する", () => {
    expect(verifyPassword("PassWord", "password")).toBe(false);
  });

  it("日本語パスワードで一致／不一致を判定できる", () => {
    expect(verifyPassword("ひみつの合言葉", "ひみつの合言葉")).toBe(true);
    expect(verifyPassword("ひみつの合言葉", "ひみつの合言薬")).toBe(false);
  });

  it("入力が期待値の接頭辞でも false", () => {
    expect(verifyPassword("correct", "correct-horse")).toBe(false);
    expect(verifyPassword("correct-horse-battery", "correct-horse")).toBe(false);
  });
});

describe("getAppPassword", () => {
  it("注入した env から値を返す", () => {
    expect(getAppPassword({ APP_PASSWORD: "pw" })).toBe("pw");
  });

  it("未定義なら throw", () => {
    expect(() => getAppPassword({})).toThrow("APP_PASSWORD is not set");
  });

  it("空文字なら throw", () => {
    expect(() => getAppPassword({ APP_PASSWORD: "" })).toThrow("APP_PASSWORD is not set");
  });

  it("引数の env が優先され、process.env にフォールバックしない", () => {
    vi.stubEnv("APP_PASSWORD", "from-process-env");
    expect(() => getAppPassword({})).toThrow("APP_PASSWORD is not set");
  });

  it("引数省略時は process.env を読む", () => {
    vi.stubEnv("APP_PASSWORD", "from-process-env");
    expect(getAppPassword()).toBe("from-process-env");
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
    const token = await createSessionToken(SECRET, { now: FIXED_NOW });
    expect(token.split(".")).toHaveLength(3);
  });

  it("ヘッダの alg が HS256", async () => {
    const token = await createSessionToken(SECRET, { now: FIXED_NOW });
    expect(decodeSegment(token, 0).alg).toBe("HS256");
  });

  it("sub / iat / exp が仕様どおり（iat=1768435200, exp=iat+2592000）", async () => {
    const token = await createSessionToken(SECRET, { now: FIXED_NOW });
    const payload = decodeSegment(token, 1);
    expect(payload.sub).toBe("owner");
    expect(payload.iat).toBe(FIXED_IAT);
    expect(payload.exp).toBe(FIXED_DEFAULT_EXP);
  });

  it("ペイロードに余計な情報（パスワード等）を載せない", async () => {
    const token = await createSessionToken(SECRET, { now: FIXED_NOW });
    expect(Object.keys(decodeSegment(token, 1)).sort()).toEqual(["exp", "iat", "sub"]);
  });

  it("iat はミリ秒を切り捨てる（整数秒。小数にならない）", async () => {
    const token = await createSessionToken(SECRET, {
      now: new Date("2026-01-15T00:00:00.999Z"),
    });
    const payload = decodeSegment(token, 1);
    expect(payload.iat).toBe(FIXED_IAT);
    expect(Number.isInteger(payload.iat)).toBe(true);
    expect(Number.isInteger(payload.exp)).toBe(true);
  });

  it("同じ UTC 時刻であれば JST 表記で渡しても iat は同じ（epoch はタイムゾーン非依存）", async () => {
    // 2026-01-15T09:00:00+09:00 は 2026-01-15T00:00:00Z と同じ瞬間
    const jst = await createSessionToken(SECRET, { now: new Date("2026-01-15T09:00:00+09:00") });
    expect(decodeSegment(jst, 1).iat).toBe(FIXED_IAT);
  });

  it("maxAgeSeconds を指定すると exp = iat + 指定値", async () => {
    const token = await createSessionToken(SECRET, { now: FIXED_NOW, maxAgeSeconds: 60 });
    const payload = decodeSegment(token, 1);
    // 手計算: 1768435200 + 60 = 1768435260
    expect(payload.exp).toBe(1768435260);
  });

  it("secret が空文字なら throw", async () => {
    await expect(createSessionToken("")).rejects.toThrow("AUTH_SECRET is not set");
  });
});

describe("verifySessionToken", () => {
  it("正しい鍵で発行したトークンを往復できる", async () => {
    const token = await createSessionToken(SECRET, { now: FIXED_NOW });
    const payload = await verifySessionToken(token, SECRET, { now: FIXED_NOW });
    expect(payload).toEqual({ sub: "owner", iat: FIXED_IAT, exp: FIXED_DEFAULT_EXP });
  });

  it("別の鍵で署名されたトークンは null", async () => {
    const token = await createSessionToken(OTHER_SECRET, { now: FIXED_NOW });
    await expect(verifySessionToken(token, SECRET, { now: FIXED_NOW })).resolves.toBeNull();
  });

  it("署名部を1文字改竄すると null", async () => {
    const token = await createSessionToken(SECRET, { now: FIXED_NOW });
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
    const token = await createSessionToken(SECRET, { now: FIXED_NOW });
    const [header, , signature] = token.split(".");
    const forged = encodeSegment({
      sub: SESSION_SUBJECT,
      iat: FIXED_IAT,
      exp: FIXED_IAT + 60 * 60 * 24 * 3650,
    });
    await expect(
      verifySessionToken(`${header}.${forged}.${signature}`, SECRET, { now: FIXED_NOW }),
    ).resolves.toBeNull();
  });

  it("有効期限内なら通る（exp の1秒前）", async () => {
    const token = await createSessionToken(SECRET, { now: FIXED_NOW, maxAgeSeconds: 60 });
    // 手計算: iat=1768435200, exp=1768435260。その1秒前 = 1768435259
    const justBefore = new Date(1768435259 * 1000);
    await expect(verifySessionToken(token, SECRET, { now: justBefore })).resolves.not.toBeNull();
  });

  it("有効期限を過ぎると null", async () => {
    const token = await createSessionToken(SECRET, { now: FIXED_NOW, maxAgeSeconds: 60 });
    // exp=1768435260 の1秒後 = 1768435261
    const justAfter = new Date(1768435261 * 1000);
    await expect(verifySessionToken(token, SECRET, { now: justAfter })).resolves.toBeNull();
  });

  it("30日の既定有効期間: 30日後-1秒は通り、30日後+1秒は null", async () => {
    const token = await createSessionToken(SECRET, { now: FIXED_NOW });
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
    const payload = encodeSegment({ sub: SESSION_SUBJECT, iat: FIXED_IAT, exp: FIXED_DEFAULT_EXP });
    await expect(
      verifySessionToken(`${header}.${payload}.`, SECRET, { now: FIXED_NOW }),
    ).resolves.toBeNull();
  });

  it("RS256 で署名されたトークンは null", async () => {
    const { privateKey } = await generateKeyPair("RS256", { extractable: true });
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "RS256" })
      .setSubject(SESSION_SUBJECT)
      .setIssuedAt(FIXED_IAT)
      .setExpirationTime(FIXED_DEFAULT_EXP)
      .sign(privateKey);
    await expect(verifySessionToken(token, SECRET, { now: FIXED_NOW })).resolves.toBeNull();
  });

  it("同じ鍵でも HS512 で署名されたトークンは null（alg 混同）", async () => {
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "HS512" })
      .setSubject(SESSION_SUBJECT)
      .setIssuedAt(FIXED_IAT)
      .setExpirationTime(FIXED_DEFAULT_EXP)
      .sign(new TextEncoder().encode(SECRET));
    await expect(verifySessionToken(token, SECRET, { now: FIXED_NOW })).resolves.toBeNull();
  });

  it("sub が owner 以外なら null（正しい鍵で署名されていても）", async () => {
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: SESSION_JWT_ALG })
      .setSubject("attacker")
      .setIssuedAt(FIXED_IAT)
      .setExpirationTime(FIXED_DEFAULT_EXP)
      .sign(new TextEncoder().encode(SECRET));
    await expect(verifySessionToken(token, SECRET, { now: FIXED_NOW })).resolves.toBeNull();
  });

  it("sub が無いトークンは null", async () => {
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: SESSION_JWT_ALG })
      .setIssuedAt(FIXED_IAT)
      .setExpirationTime(FIXED_DEFAULT_EXP)
      .sign(new TextEncoder().encode(SECRET));
    await expect(verifySessionToken(token, SECRET, { now: FIXED_NOW })).resolves.toBeNull();
  });

  it("exp が無いトークンは null（無期限セッションを作らせない）", async () => {
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: SESSION_JWT_ALG })
      .setSubject(SESSION_SUBJECT)
      .setIssuedAt(FIXED_IAT)
      .sign(new TextEncoder().encode(SECRET));
    await expect(verifySessionToken(token, SECRET, { now: FIXED_NOW })).resolves.toBeNull();
  });

  it("exp が数値でない（文字列）トークンは null", async () => {
    const token = await new SignJWT({ exp: "9999999999" as unknown as number })
      .setProtectedHeader({ alg: SESSION_JWT_ALG })
      .setSubject(SESSION_SUBJECT)
      .setIssuedAt(FIXED_IAT)
      .sign(new TextEncoder().encode(SECRET));
    await expect(verifySessionToken(token, SECRET, { now: FIXED_NOW })).resolves.toBeNull();
  });

  it("iat が無いトークンは null", async () => {
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: SESSION_JWT_ALG })
      .setSubject(SESSION_SUBJECT)
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
    const token = await createSessionToken(SECRET, { now: FIXED_NOW });
    await expect(verifySessionToken(token, "")).rejects.toThrow("AUTH_SECRET is not set");
    await expect(verifySessionToken("", "")).rejects.toThrow("AUTH_SECRET is not set");
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
    const token = await createSessionToken(SECRET, { now: FIXED_NOW });
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
