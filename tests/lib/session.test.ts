// @vitest-environment node
// jose を使うため node 環境（理由は tests/lib/auth.test.ts 冒頭のコメント参照）
//
// 期待値の根拠:
// - docs/steps/pub-1.md 設計判断 8
//   「createSession(userId: UserId)」
//   「requireUserId(): Promise<UserId> を src/lib/session.ts に置く。セッションが無ければ
//    redirect(LOGIN_PATH)。各ファイルにある requireSession() はこれに置き換える」
// - src/lib/session.ts の JSDoc
//   「ログイン中の利用者IDを返す。セッションが無ければログイン画面へリダイレクトする」

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LOGIN_PATH, SESSION_COOKIE_NAME, createSessionToken, verifySessionToken } from "@/lib/auth";
import type { UserId } from "@/lib/user-id";

const SECRET = "test-auth-secret-0123456789abcdef";
const OTHER_SECRET = "another-auth-secret-fedcba9876543210";
const USER_ID = "user_1" as UserId;

/** next/headers の cookies() が返すストアの最小実装 */
type StoredCookie = { name: string; value: string; options?: Record<string, unknown> };

const store = new Map<string, StoredCookie>();
const setSpy = vi.fn((name: string, value: string, options?: Record<string, unknown>) => {
  store.set(name, { name, value, options });
});
const deleteSpy = vi.fn((name: string) => {
  store.delete(name);
});

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => store.get(name),
    set: setSpy,
    delete: deleteSpy,
  }),
}));

class RedirectError extends Error {
  digest: string;
  constructor(url: string) {
    super(`NEXT_REDIRECT;${url}`);
    this.digest = `NEXT_REDIRECT;replace;${url};307;`;
  }
}

const redirectSpy = vi.fn((url: string): never => {
  throw new RedirectError(url);
});
vi.mock("next/navigation", () => ({ redirect: (url: string) => redirectSpy(url) }));

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

const { createSession, destroySession, getSession, requireUserId } = await import("@/lib/session");

beforeEach(() => {
  store.clear();
  setSpy.mockClear();
  deleteSpy.mockClear();
  redirectSpy.mockClear();
  vi.stubEnv("AUTH_SECRET", SECRET);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("createSession", () => {
  it("セッション Cookie 名で、検証可能なトークンを発行する。sub にはそのユーザーIDが入る", async () => {
    await createSession(USER_ID);

    expect(setSpy).toHaveBeenCalledTimes(1);
    const [name, token] = setSpy.mock.calls[0];
    expect(name).toBe("kakeibo_session");
    expect(name).toBe(SESSION_COOKIE_NAME);

    const payload = await verifySessionToken(token, SECRET);
    expect(payload?.userId).toBe(USER_ID);
  });

  it("Cookie 属性が仕様どおり（httpOnly / sameSite lax / path / maxAge 2592000）", async () => {
    await createSession(USER_ID);
    const options = setSpy.mock.calls[0][2];
    expect(options).toMatchObject({
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 2592000,
    });
  });

  it("テスト（非本番）環境では secure: false", async () => {
    vi.stubEnv("NODE_ENV", "development");
    await createSession(USER_ID);
    expect(setSpy.mock.calls[0][2]).toMatchObject({ secure: false });
  });

  it("本番環境では secure: true", async () => {
    vi.stubEnv("NODE_ENV", "production");
    await createSession(USER_ID);
    expect(setSpy.mock.calls[0][2]).toMatchObject({ secure: true });
  });

  it("発行したトークンは別の鍵では検証できない", async () => {
    await createSession(USER_ID);
    const token = setSpy.mock.calls[0][1];
    await expect(verifySessionToken(token, OTHER_SECRET)).resolves.toBeNull();
  });

  it("AUTH_SECRET 未設定なら throw し、Cookie を発行しない", async () => {
    vi.stubEnv("AUTH_SECRET", "");
    await expect(createSession(USER_ID)).rejects.toThrow("AUTH_SECRET is not set");
    expect(setSpy).not.toHaveBeenCalled();
  });
});

describe("getSession", () => {
  it("Cookie が無ければ null（未ログイン）", async () => {
    await expect(getSession()).resolves.toBeNull();
  });

  it("createSession で発行した Cookie を読め、userId が入っている", async () => {
    await createSession(USER_ID);
    const payload = await getSession();
    expect(payload?.userId).toBe(USER_ID);
    expect(Number.isInteger(payload?.iat)).toBe(true);
    expect(Number.isInteger(payload?.exp)).toBe(true);
  });

  it("Cookie の値が改竄されていれば null", async () => {
    await createSession(USER_ID);
    const token = store.get(SESSION_COOKIE_NAME)!.value;
    const [header, payload, signature] = token.split(".");
    const tamperedSignature = tamperSignature(signature);
    expect(Buffer.from(tamperedSignature, "base64url")).not.toEqual(
      Buffer.from(signature, "base64url"),
    );
    store.set(SESSION_COOKIE_NAME, {
      name: SESSION_COOKIE_NAME,
      value: `${header}.${payload}.${tamperedSignature}`,
    });
    await expect(getSession()).resolves.toBeNull();
  });

  it("別の鍵で署名されたトークンは null", async () => {
    const forged = await createSessionToken(OTHER_SECRET, USER_ID);
    store.set(SESSION_COOKIE_NAME, { name: SESSION_COOKIE_NAME, value: forged });
    await expect(getSession()).resolves.toBeNull();
  });

  it("JWT ですらない値でも throw せず null", async () => {
    store.set(SESSION_COOKIE_NAME, { name: SESSION_COOKIE_NAME, value: "garbage" });
    await expect(getSession()).resolves.toBeNull();
  });

  it("空文字の Cookie は null", async () => {
    store.set(SESSION_COOKIE_NAME, { name: SESSION_COOKIE_NAME, value: "" });
    await expect(getSession()).resolves.toBeNull();
  });

  it("AUTH_SECRET 未設定なら throw する（素通りさせない）", async () => {
    vi.stubEnv("AUTH_SECRET", "");
    store.set(SESSION_COOKIE_NAME, { name: SESSION_COOKIE_NAME, value: "anything" });
    await expect(getSession()).rejects.toThrow("AUTH_SECRET is not set");
  });
});

describe("destroySession", () => {
  it("セッション Cookie を削除する", async () => {
    await createSession(USER_ID);
    await destroySession();
    expect(deleteSpy).toHaveBeenCalledWith(SESSION_COOKIE_NAME);
    await expect(getSession()).resolves.toBeNull();
  });

  it("ログインしていなくてもエラーにならない", async () => {
    await expect(destroySession()).resolves.toBeUndefined();
  });
});

describe("requireUserId", () => {
  it("有効なセッションがあれば、そのユーザーIDを返す", async () => {
    await createSession(USER_ID);
    await expect(requireUserId()).resolves.toBe(USER_ID);
    expect(redirectSpy).not.toHaveBeenCalled();
  });

  it("セッションが無ければ LOGIN_PATH へ redirect する", async () => {
    await expect(requireUserId()).rejects.toThrow("NEXT_REDIRECT");
    expect(redirectSpy).toHaveBeenCalledWith(LOGIN_PATH);
  });

  it("セッションが改竄されている場合も LOGIN_PATH へ redirect する（null と同じ扱い）", async () => {
    await createSession(USER_ID);
    const token = store.get(SESSION_COOKIE_NAME)!.value;
    const [header, payload, signature] = token.split(".");
    store.set(SESSION_COOKIE_NAME, {
      name: SESSION_COOKIE_NAME,
      value: `${header}.${payload}.${tamperSignature(signature)}`,
    });

    await expect(requireUserId()).rejects.toThrow("NEXT_REDIRECT");
    expect(redirectSpy).toHaveBeenCalledWith(LOGIN_PATH);
  });

  it("チャレンジ JWT（typ ヘッダ無し）をセッション Cookie に入れても LOGIN_PATH へ redirect する", async () => {
    // createSessionToken は typ: SESSION_JWT_TYP を必ず付けるため、typ の無いトークンを
    // 直接組み立てて「チャレンジ JWT がセッションとして通らない」ことを再現する
    // （docs/steps/pub-1.md 設計判断 8「セッション JWT を用途で区別できる別の手段を足し、
    //   検証で必須にする」）。
    const { SignJWT } = await import("jose");
    const key = new TextEncoder().encode(SECRET);
    const challengeLikeToken = await new SignJWT({})
      .setProtectedHeader({ alg: "HS256" }) // typ を付けない
      .setSubject("passkey-register")
      .setIssuedAt()
      .setExpirationTime("2m")
      .sign(key);
    store.set(SESSION_COOKIE_NAME, { name: SESSION_COOKIE_NAME, value: challengeLikeToken });

    await expect(requireUserId()).rejects.toThrow("NEXT_REDIRECT");
    expect(redirectSpy).toHaveBeenCalledWith(LOGIN_PATH);
  });
});
