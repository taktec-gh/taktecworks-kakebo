// @vitest-environment node
// jose を使うため node 環境（理由は tests/lib/auth.test.ts 冒頭のコメント参照）
//
// src/lib/recovery-session.ts（リカバリー用トークンの Cookie の副作用側）を検証する。
// tests/lib/session.test.ts と同じ方針で next/headers の cookies() をモックし、
// 本物の JWT の発行・検証（src/lib/auth.ts）はモックしない。
//
// 期待値の根拠:
// - docs/steps/pub-5.md 設計判断 5
//   「検証関数は src/lib/auth.ts に置く」「Cookie は別の名前（httpOnly / SameSite=Lax /
//   本番で Secure、path: "/"）」
// - docs/steps/pub-5.md「実装完了後の引き継ぎ」
//   「setRecoveryCookie / getRecoverySession（消費しない）/ clearRecoveryCookie」
// - docs/steps/pub-5.md「tester 向けの方針」1
//   「リカバリー用トークンでは家計データに触れない」

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  RECOVERY_COOKIE_NAME,
  SESSION_COOKIE_NAME,
  verifyRecoveryToken,
} from "@/lib/auth";
import type { UserId } from "@/lib/user-id";

const SECRET = "test-auth-secret-0123456789abcdef";
const OTHER_SECRET = "another-auth-secret-fedcba9876543210";
const USER_ID = "user_1" as UserId;
const CODE_HASH = "a".repeat(64);

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

const { setRecoveryCookie, getRecoverySession, clearRecoveryCookie } = await import(
  "@/lib/recovery-session"
);

beforeEach(() => {
  store.clear();
  setSpy.mockClear();
  deleteSpy.mockClear();
  vi.stubEnv("AUTH_SECRET", SECRET);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("setRecoveryCookie", () => {
  it("RECOVERY_COOKIE_NAME で、検証可能なトークンを発行する。sub・codeHash に渡した値が入る", async () => {
    await setRecoveryCookie({ userId: USER_ID, codeHash: CODE_HASH });

    expect(setSpy).toHaveBeenCalledTimes(1);
    const [name, token] = setSpy.mock.calls[0];
    expect(name).toBe("kakeibo_recovery");
    expect(name).toBe(RECOVERY_COOKIE_NAME);

    const payload = await verifyRecoveryToken(token, SECRET);
    expect(payload?.userId).toBe(USER_ID);
    expect(payload?.codeHash).toBe(CODE_HASH);
  });

  it("Cookie 属性が仕様どおり（httpOnly / sameSite lax / path / maxAge 600）", async () => {
    await setRecoveryCookie({ userId: USER_ID, codeHash: CODE_HASH });
    const options = setSpy.mock.calls[0][2];
    expect(options).toMatchObject({
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 600,
    });
  });

  it("非本番では secure: false、本番では secure: true", async () => {
    vi.stubEnv("NODE_ENV", "development");
    await setRecoveryCookie({ userId: USER_ID, codeHash: CODE_HASH });
    expect(setSpy.mock.calls[0][2]).toMatchObject({ secure: false });

    setSpy.mockClear();
    vi.stubEnv("NODE_ENV", "production");
    await setRecoveryCookie({ userId: USER_ID, codeHash: CODE_HASH });
    expect(setSpy.mock.calls[0][2]).toMatchObject({ secure: true });
  });

  it("セッションの Cookie 名（kakeibo_session）には書き込まない（別物であることの確認）", async () => {
    await setRecoveryCookie({ userId: USER_ID, codeHash: CODE_HASH });
    expect(store.has(SESSION_COOKIE_NAME)).toBe(false);
    expect(store.has(RECOVERY_COOKIE_NAME)).toBe(true);
  });

  it("AUTH_SECRET 未設定なら throw し、Cookie を発行しない", async () => {
    vi.stubEnv("AUTH_SECRET", "");
    await expect(setRecoveryCookie({ userId: USER_ID, codeHash: CODE_HASH })).rejects.toThrow(
      "AUTH_SECRET is not set",
    );
    expect(setSpy).not.toHaveBeenCalled();
  });
});

describe("getRecoverySession（消費しない。取り消しても何度でも読める）", () => {
  it("Cookie が無ければ null", async () => {
    await expect(getRecoverySession()).resolves.toBeNull();
  });

  it("setRecoveryCookie で発行した Cookie を読め、userId・codeHash が入っている", async () => {
    await setRecoveryCookie({ userId: USER_ID, codeHash: CODE_HASH });
    const payload = await getRecoverySession();
    expect(payload?.userId).toBe(USER_ID);
    expect(payload?.codeHash).toBe(CODE_HASH);
  });

  it("2回続けて読んでも同じ値が返る（消費しない）", async () => {
    await setRecoveryCookie({ userId: USER_ID, codeHash: CODE_HASH });
    const first = await getRecoverySession();
    const second = await getRecoverySession();
    expect(first).toEqual(second);
    expect(store.has(RECOVERY_COOKIE_NAME)).toBe(true); // Cookie 自体も消えていない
  });

  it("改竄された Cookie は null", async () => {
    await setRecoveryCookie({ userId: USER_ID, codeHash: CODE_HASH });
    const token = store.get(RECOVERY_COOKIE_NAME)!.value;
    const [header, payload, signature] = token.split(".");
    const tampered = signature[0] === "A" ? "B" : "A";
    store.set(RECOVERY_COOKIE_NAME, {
      name: RECOVERY_COOKIE_NAME,
      value: `${header}.${payload}.${tampered}${signature.slice(1)}`,
    });
    await expect(getRecoverySession()).resolves.toBeNull();
  });

  it("別の鍵で署名されたトークンは null", async () => {
    const { createRecoveryToken } = await import("@/lib/auth");
    const forged = await createRecoveryToken(OTHER_SECRET, { userId: USER_ID, codeHash: CODE_HASH });
    store.set(RECOVERY_COOKIE_NAME, { name: RECOVERY_COOKIE_NAME, value: forged });
    await expect(getRecoverySession()).resolves.toBeNull();
  });

  it("セッション Cookie 名（kakeibo_session）に置かれたトークンは読まない（Cookie 名が違うので参照すらしない）", async () => {
    await setRecoveryCookie({ userId: USER_ID, codeHash: CODE_HASH });
    const token = store.get(RECOVERY_COOKIE_NAME)!.value;
    store.delete(RECOVERY_COOKIE_NAME);
    store.set(SESSION_COOKIE_NAME, { name: SESSION_COOKIE_NAME, value: token });
    await expect(getRecoverySession()).resolves.toBeNull();
  });

  it("JWT ですらない値でも throw せず null", async () => {
    store.set(RECOVERY_COOKIE_NAME, { name: RECOVERY_COOKIE_NAME, value: "garbage" });
    await expect(getRecoverySession()).resolves.toBeNull();
  });

  it("AUTH_SECRET 未設定なら throw する（素通りさせない）", async () => {
    vi.stubEnv("AUTH_SECRET", "");
    store.set(RECOVERY_COOKIE_NAME, { name: RECOVERY_COOKIE_NAME, value: "anything" });
    await expect(getRecoverySession()).rejects.toThrow("AUTH_SECRET is not set");
  });
});

describe("clearRecoveryCookie", () => {
  it("リカバリー用トークンの Cookie を削除する", async () => {
    await setRecoveryCookie({ userId: USER_ID, codeHash: CODE_HASH });
    await clearRecoveryCookie();
    expect(deleteSpy).toHaveBeenCalledWith(RECOVERY_COOKIE_NAME);
    await expect(getRecoverySession()).resolves.toBeNull();
  });

  it("Cookie が無くてもエラーにならない", async () => {
    await expect(clearRecoveryCookie()).resolves.toBeUndefined();
  });

  it("セッションの Cookie は消さない", async () => {
    store.set(SESSION_COOKIE_NAME, { name: SESSION_COOKIE_NAME, value: "session-token" });
    await clearRecoveryCookie();
    expect(store.has(SESSION_COOKIE_NAME)).toBe(true);
  });
});
