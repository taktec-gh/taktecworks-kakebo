// @vitest-environment node
// jose を使うため node 環境（理由は tests/lib/auth.test.ts 冒頭のコメント参照）

import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SESSION_COOKIE_NAME, createSessionToken } from "@/lib/auth";
import { config, proxy } from "@/proxy";

const SECRET = "test-auth-secret-0123456789abcdef";
const OTHER_SECRET = "another-auth-secret-fedcba9876543210";

const ORIGIN = "http://localhost:3000";

function requestFor(pathname: string, token?: string): NextRequest {
  const headers = new Headers();
  if (token !== undefined) headers.set("cookie", `${SESSION_COOKIE_NAME}=${token}`);
  return new NextRequest(`${ORIGIN}${pathname}`, { headers });
}

/** NextResponse.next() は 200 で location を持たない */
function expectPassedThrough(response: Response) {
  expect(response.status).toBe(200);
  expect(response.headers.get("location")).toBeNull();
}

/** 未認証は 307 で /login へ。クエリは落とす */
function expectRedirectedToLogin(response: Response) {
  expect(response.status).toBe(307);
  const location = new URL(response.headers.get("location")!);
  expect(location.pathname).toBe("/login");
  expect(location.search).toBe("");
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

beforeEach(() => {
  vi.stubEnv("AUTH_SECRET", SECRET);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("認証不要なパス", () => {
  it.each(["/login", "/favicon.ico", "/_next/static/chunks/main.js", "/robots.txt"])(
    "%s はセッションが無くても通す",
    async (pathname) => {
      expectPassedThrough(await proxy(requestFor(pathname)));
    },
  );

  it("AUTH_SECRET が未設定でもログインページは開ける", async () => {
    vi.stubEnv("AUTH_SECRET", "");
    expectPassedThrough(await proxy(requestFor("/login")));
  });
});

describe("未認証で保護対象にアクセスした場合", () => {
  it.each(["/", "/expenses", "/expenses/new", "/settings"])(
    "%s は Cookie が無ければ /login へリダイレクト",
    async (pathname) => {
      expectRedirectedToLogin(await proxy(requestFor(pathname)));
    },
  );

  it("Cookie が無い場合は Cookie 削除ヘッダを付けない", async () => {
    const response = await proxy(requestFor("/"));
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("リダイレクト時にクエリ文字列を落とす", async () => {
    const response = await proxy(requestFor("/expenses?month=2026-01&category=food"));
    expectRedirectedToLogin(response);
  });

  it("リダイレクト先は同じホスト（オープンリダイレクトにしない）", async () => {
    const response = await proxy(requestFor("/expenses"));
    expect(new URL(response.headers.get("location")!).origin).toBe(ORIGIN);
  });

  it("パス正規化で公開パスを偽装できない（/login/../expenses）", async () => {
    // URL パース時点で "/expenses" に正規化される
    const request = new NextRequest(`${ORIGIN}/login/../expenses`);
    expect(request.nextUrl.pathname).toBe("/expenses");
    expectRedirectedToLogin(await proxy(request));
  });
});

describe("Cookie はあるがセッションが無効な場合", () => {
  it("改竄されたトークンはリダイレクトし、Cookie を削除する", async () => {
    const token = await createSessionToken(SECRET);
    const [header, payload, signature] = token.split(".");
    const tamperedSignature = tamperSignature(signature);
    expect(Buffer.from(tamperedSignature, "base64url")).not.toEqual(
      Buffer.from(signature, "base64url"),
    );
    const tampered = `${header}.${payload}.${tamperedSignature}`;

    const response = await proxy(requestFor("/", tampered));
    expectRedirectedToLogin(response);
    const setCookie = response.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(`${SESSION_COOKIE_NAME}=;`);
    expect(setCookie).toContain("1970");
  });

  it("別の鍵で署名されたトークンはリダイレクトする", async () => {
    const forged = await createSessionToken(OTHER_SECRET);
    const response = await proxy(requestFor("/", forged));
    expectRedirectedToLogin(response);
    expect(response.headers.get("set-cookie")).toContain(`${SESSION_COOKIE_NAME}=;`);
  });

  it("期限切れのトークンはリダイレクトする", async () => {
    // 10秒前に発行した有効期間1秒のトークン → 現在時刻では失効済み
    const expired = await createSessionToken(SECRET, {
      now: new Date(Date.now() - 10_000),
      maxAgeSeconds: 1,
    });
    expectRedirectedToLogin(await proxy(requestFor("/", expired)));
  });

  it("JWT でない値が入っていてもリダイレクトする（throw しない）", async () => {
    expectRedirectedToLogin(await proxy(requestFor("/", "garbage")));
  });

  it("空の Cookie でもリダイレクトする", async () => {
    expectRedirectedToLogin(await proxy(requestFor("/", "")));
  });
});

describe("有効なセッションがある場合", () => {
  it.each(["/", "/expenses", "/settings/payment-sources"])("%s を通す", async (pathname) => {
    const token = await createSessionToken(SECRET);
    expectPassedThrough(await proxy(requestFor(pathname, token)));
  });

  it("Cookie 名が違えばセッションとして扱わない", async () => {
    const token = await createSessionToken(SECRET);
    const headers = new Headers({ cookie: `other_session=${token}` });
    expectRedirectedToLogin(await proxy(new NextRequest(`${ORIGIN}/`, { headers })));
  });
});

describe("AUTH_SECRET 未設定（fail-closed）", () => {
  it("保護対象パスでは throw して素通りさせない", async () => {
    vi.stubEnv("AUTH_SECRET", "");
    await expect(proxy(requestFor("/"))).rejects.toThrow("AUTH_SECRET is not set");
  });

  it("Cookie を持っていても throw する", async () => {
    const token = await createSessionToken(SECRET);
    vi.stubEnv("AUTH_SECRET", "");
    await expect(proxy(requestFor("/expenses", token))).rejects.toThrow("AUTH_SECRET is not set");
  });
});

describe("matcher 設定", () => {
  it("保護対象のパスが matcher に含まれる（含まれないと proxy 自体が動かない）", () => {
    const matcher = new RegExp(`^${config.matcher[0]}$`);
    for (const pathname of ["/", "/expenses", "/settings", "/login"]) {
      expect(matcher.test(pathname)).toBe(true);
    }
  });

  it("静的アセットは matcher から除外されている", () => {
    const matcher = new RegExp(`^${config.matcher[0]}$`);
    for (const pathname of ["/_next/static/chunks/main.js", "/_next/image", "/favicon.ico"]) {
      expect(matcher.test(pathname)).toBe(false);
    }
  });
});
