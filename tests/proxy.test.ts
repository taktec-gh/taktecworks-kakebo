// @vitest-environment node
// jose を使うため node 環境（理由は tests/lib/auth.test.ts 冒頭のコメント参照）

import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CRON_CLEANUP_PATH,
  SESSION_COOKIE_NAME,
  SIGNUP_PATH,
  createSessionToken,
} from "@/lib/auth";
import { config, proxy } from "@/proxy";
import { CSP_HEADER_NAME, isValidNonce, NONCE_HEADER_NAME } from "@/lib/csp";
import type { UserId } from "@/lib/user-id";

const SECRET = "test-auth-secret-0123456789abcdef";
const OTHER_SECRET = "another-auth-secret-fedcba9876543210";
const USER_ID = "user_1" as UserId;

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

/** CSP 文字列から `'nonce-…'` の値だけを取り出す */
function extractNonce(csp: string): string {
  const match = csp.match(/'nonce-([^']+)'/);
  expect(match, `CSP に nonce が見つかりません: ${csp}`).not.toBeNull();
  return match![1];
}

/** CSP 文字列から指定ディレクティブの値部分だけを取り出す（tests/lib/csp.test.ts と同じ考え方） */
function extractDirective(csp: string, name: string): string {
  const directive = csp.split("; ").find((d) => d.startsWith(`${name} `) || d === name);
  expect(directive, `ディレクティブ ${name} が見つかりません: ${csp}`).not.toBeUndefined();
  return directive!;
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
    const token = await createSessionToken(SECRET, USER_ID);
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
    const forged = await createSessionToken(OTHER_SECRET, USER_ID);
    const response = await proxy(requestFor("/", forged));
    expectRedirectedToLogin(response);
    expect(response.headers.get("set-cookie")).toContain(`${SESSION_COOKIE_NAME}=;`);
  });

  it("期限切れのトークンはリダイレクトする", async () => {
    // 10秒前に発行した有効期間1秒のトークン → 現在時刻では失効済み
    const expired = await createSessionToken(SECRET, USER_ID, {
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
    const token = await createSessionToken(SECRET, USER_ID);
    expectPassedThrough(await proxy(requestFor(pathname, token)));
  });

  it("Cookie 名が違えばセッションとして扱わない", async () => {
    const token = await createSessionToken(SECRET, USER_ID);
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
    const token = await createSessionToken(SECRET, USER_ID);
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

// docs/steps/pub-4.md 設計判断 1・tester 向けの方針 3・4:
// proxy の全分岐（公開パス／セッションあり／セッション無しのリダイレクト／
// 改竄 Cookie の削除を伴うリダイレクト）に CSP が付くこと、通す分岐では
// リクエストヘッダ（Next.js が nonce を読む）とレスポンスヘッダの nonce が一致することを確認する。
//
// NextResponse.next({ request: { headers } }) はリクエストヘッダの上書きを
// `x-middleware-request-<header名>` というレスポンスヘッダとして表現する
// （node_modules/next/dist/server/web/spec-extension/response.js の handleMiddlewareField）。
// これを読むことで「リクエストヘッダにも CSP と x-nonce が転送されているか」を検証できる。
describe("CSP ヘッダー", () => {
  describe("本番相当（NODE_ENV=production）", () => {
    beforeEach(() => {
      vi.stubEnv("NODE_ENV", "production");
    });

    it.each([
      ["公開パス(/login)", "/login", undefined],
      ["公開パス(サインアップ)", SIGNUP_PATH, undefined],
      ["公開パス(cron cleanup)", CRON_CLEANUP_PATH, undefined],
    ])("%s は通す分岐で、レスポンスと転送されたリクエストヘッダの両方に CSP が付く", async (_label, pathname) => {
      const response = await proxy(requestFor(pathname));
      expectPassedThrough(response);

      const responseCsp = response.headers.get(CSP_HEADER_NAME);
      expect(responseCsp, "レスポンスに CSP が無い").not.toBeNull();

      const requestCsp = response.headers.get(`x-middleware-request-${CSP_HEADER_NAME.toLowerCase()}`);
      const requestNonceHeader = response.headers.get(`x-middleware-request-${NONCE_HEADER_NAME}`);
      expect(requestCsp, "Next.js が nonce を読み取るリクエストヘッダに CSP が無い").not.toBeNull();
      expect(requestNonceHeader, "リクエストヘッダに x-nonce が無い").not.toBeNull();

      // レスポンスの CSP とリクエストヘッダの CSP は同じ nonce を使っている
      expect(requestCsp).toBe(responseCsp);
      const nonce = extractNonce(responseCsp!);
      expect(requestNonceHeader).toBe(nonce);
      expect(isValidNonce(nonce)).toBe(true);
    });

    it("セッションありは通す分岐で CSP をリクエスト・レスポンス両方に付け、nonce が一致する", async () => {
      const token = await createSessionToken(SECRET, USER_ID);
      const response = await proxy(requestFor("/", token));
      expectPassedThrough(response);

      const responseCsp = response.headers.get(CSP_HEADER_NAME);
      const requestCsp = response.headers.get(`x-middleware-request-${CSP_HEADER_NAME.toLowerCase()}`);
      const requestNonceHeader = response.headers.get(`x-middleware-request-${NONCE_HEADER_NAME}`);
      expect(responseCsp).not.toBeNull();
      expect(requestCsp).toBe(responseCsp);
      expect(requestNonceHeader).toBe(extractNonce(responseCsp!));
    });

    it("セッション無しのリダイレクトにも CSP が付く", async () => {
      const response = await proxy(requestFor("/"));
      expectRedirectedToLogin(response);
      const csp = response.headers.get(CSP_HEADER_NAME);
      expect(csp).not.toBeNull();
      expect(isValidNonce(extractNonce(csp!))).toBe(true);
    });

    it("改竄 Cookie の削除を伴うリダイレクトにも CSP が付く", async () => {
      const token = await createSessionToken(SECRET, USER_ID);
      const [header, payload, signature] = token.split(".");
      const tamperedSignature = tamperSignature(signature);
      const tampered = `${header}.${payload}.${tamperedSignature}`;

      const response = await proxy(requestFor("/", tampered));
      expectRedirectedToLogin(response);
      // Cookie 削除ヘッダと CSP ヘッダが両方付いていることを確認する（片方の実装漏れを検出する）
      expect(response.headers.get("set-cookie")).toContain(`${SESSION_COOKIE_NAME}=;`);
      const csp = response.headers.get(CSP_HEADER_NAME);
      expect(csp).not.toBeNull();
      expect(isValidNonce(extractNonce(csp!))).toBe(true);
    });

    it("公開パスのポリシーに緩みが無い（unsafe-inline・unsafe-eval・ワイルドカード・スキーム許可が script-src に無い）", async () => {
      const response = await proxy(requestFor("/login"));
      const csp = response.headers.get(CSP_HEADER_NAME)!;
      const scriptSrc = extractDirective(csp, "script-src");
      expect(scriptSrc).not.toMatch(/unsafe-inline|unsafe-eval|\*|https:|http:/);
      expect(scriptSrc).toContain("'strict-dynamic'");
      expect(extractDirective(csp, "style-src")).not.toContain("unsafe-inline");
      expect(csp).toContain("object-src 'none'");
      expect(csp).toContain("base-uri 'self'");
      expect(csp).toContain("form-action 'self'");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).not.toContain("upgrade-insecure-requests");
    });

    it("セッション無しのリダイレクトのポリシーにも緩みが無い", async () => {
      const response = await proxy(requestFor("/"));
      const csp = response.headers.get(CSP_HEADER_NAME)!;
      expect(extractDirective(csp, "script-src")).not.toMatch(/unsafe-inline|unsafe-eval/);
      expect(csp).toContain("frame-ancestors 'none'");
    });

    it("2回のリクエストで nonce が異なる（公開パス）", async () => {
      const first = await proxy(requestFor("/login"));
      const second = await proxy(requestFor("/login"));
      const nonce1 = extractNonce(first.headers.get(CSP_HEADER_NAME)!);
      const nonce2 = extractNonce(second.headers.get(CSP_HEADER_NAME)!);
      expect(nonce1).not.toBe(nonce2);
    });

    it("2回のリクエストで nonce が異なる（未認証のリダイレクト）", async () => {
      const first = await proxy(requestFor("/"));
      const second = await proxy(requestFor("/"));
      const nonce1 = extractNonce(first.headers.get(CSP_HEADER_NAME)!);
      const nonce2 = extractNonce(second.headers.get(CSP_HEADER_NAME)!);
      expect(nonce1).not.toBe(nonce2);
    });
  });

  describe("開発だけ緩める条件", () => {
    it("NODE_ENV=development のときだけ script-src に 'unsafe-eval'、style-src に 'unsafe-inline' が入る", async () => {
      vi.stubEnv("NODE_ENV", "development");
      const response = await proxy(requestFor("/login"));
      const csp = response.headers.get(CSP_HEADER_NAME)!;
      expect(extractDirective(csp, "script-src")).toContain("'unsafe-eval'");
      expect(extractDirective(csp, "style-src")).toContain("'unsafe-inline'");
    });

    it.each([
      ["production", "production"],
      ["test", "test"],
      ["未設定", undefined],
      ["空文字", ""],
      ["先頭が大文字(Development)", "Development"],
      ["全部大文字(DEVELOPMENT)", "DEVELOPMENT"],
    ])("NODE_ENV が %s では緩まない（「production でなければ緩める」にしない）", async (_label, value) => {
      vi.stubEnv("NODE_ENV", value);
      const response = await proxy(requestFor("/login"));
      const csp = response.headers.get(CSP_HEADER_NAME)!;
      expect(extractDirective(csp, "script-src")).not.toContain("unsafe-eval");
      expect(extractDirective(csp, "style-src")).not.toContain("unsafe-inline");
    });
  });

  describe("認証の判断は CSP と無関係（Step 3 までと変わらない）", () => {
    it("CSP を付けても、セッション無しは通さずリダイレクトのまま", async () => {
      vi.stubEnv("NODE_ENV", "production");
      const response = await proxy(requestFor("/expenses"));
      expectRedirectedToLogin(response);
    });

    it("CSP を付けても、有効なセッションは通す", async () => {
      vi.stubEnv("NODE_ENV", "production");
      const token = await createSessionToken(SECRET, USER_ID);
      const response = await proxy(requestFor("/expenses", token));
      expectPassedThrough(response);
    });
  });
});
