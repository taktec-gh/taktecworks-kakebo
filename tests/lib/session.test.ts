// @vitest-environment node
// jose を使うため node 環境（理由は tests/lib/auth.test.ts 冒頭のコメント参照）

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  SESSION_COOKIE_NAME,
  createSessionToken,
  verifySessionToken,
} from "@/lib/auth";

const SECRET = "test-auth-secret-0123456789abcdef";
const OTHER_SECRET = "another-auth-secret-fedcba9876543210";

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

const { createSession, destroySession, getSession } = await import("@/lib/session");

beforeEach(() => {
  store.clear();
  setSpy.mockClear();
  deleteSpy.mockClear();
  vi.stubEnv("AUTH_SECRET", SECRET);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("createSession", () => {
  it("セッション Cookie 名で、検証可能なトークンを発行する", async () => {
    await createSession();

    expect(setSpy).toHaveBeenCalledTimes(1);
    const [name, token] = setSpy.mock.calls[0];
    expect(name).toBe("kakeibo_session");
    expect(name).toBe(SESSION_COOKIE_NAME);

    const payload = await verifySessionToken(token, SECRET);
    expect(payload?.sub).toBe("owner");
  });

  it("Cookie 属性が仕様どおり（httpOnly / sameSite lax / path / maxAge 2592000）", async () => {
    await createSession();
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
    await createSession();
    expect(setSpy.mock.calls[0][2]).toMatchObject({ secure: false });
  });

  it("本番環境では secure: true", async () => {
    vi.stubEnv("NODE_ENV", "production");
    await createSession();
    expect(setSpy.mock.calls[0][2]).toMatchObject({ secure: true });
  });

  it("発行したトークンは別の鍵では検証できない", async () => {
    await createSession();
    const token = setSpy.mock.calls[0][1];
    await expect(verifySessionToken(token, OTHER_SECRET)).resolves.toBeNull();
  });

  it("AUTH_SECRET 未設定なら throw し、Cookie を発行しない", async () => {
    vi.stubEnv("AUTH_SECRET", "");
    await expect(createSession()).rejects.toThrow("AUTH_SECRET is not set");
    expect(setSpy).not.toHaveBeenCalled();
  });
});

describe("getSession", () => {
  it("Cookie が無ければ null（未ログイン）", async () => {
    await expect(getSession()).resolves.toBeNull();
  });

  it("createSession で発行した Cookie を読める", async () => {
    await createSession();
    const payload = await getSession();
    expect(payload?.sub).toBe("owner");
    expect(Number.isInteger(payload?.iat)).toBe(true);
    expect(Number.isInteger(payload?.exp)).toBe(true);
  });

  it("Cookie の値が改竄されていれば null", async () => {
    await createSession();
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
    const forged = await createSessionToken(OTHER_SECRET);
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
    await createSession();
    await destroySession();
    expect(deleteSpy).toHaveBeenCalledWith(SESSION_COOKIE_NAME);
    await expect(getSession()).resolves.toBeNull();
  });

  it("ログインしていなくてもエラーにならない", async () => {
    await expect(destroySession()).resolves.toBeUndefined();
  });
});
