// @vitest-environment node
// jose を使うため node 環境（tests/lib/auth.test.ts 冒頭のコメント参照）
//
// src/lib/passkey-session.ts（チャレンジ Cookie の副作用側）を検証する。
// next/headers はモックし、Cookie ストアを自前の Map で再現する
// （tests/lib/session.test.ts と同じ方針）。
//
// 期待値の根拠:
// - docs/steps/step-7.md「設計判断 3」「特に壊れやすい箇所 > チャレンジの単回性・取り違え」

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createChallengeToken } from "@/lib/passkey";

const SECRET = "test-auth-secret-0123456789abcdef";

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

const { setChallengeCookie, consumeChallengeCookie, clearChallengeCookie } = await import(
  "@/lib/passkey-session"
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

describe("setChallengeCookie", () => {
  it("用途ごとの Cookie 名で、検証可能なトークンを発行する", async () => {
    await setChallengeCookie("authenticate", "CHALLENGE");

    expect(setSpy).toHaveBeenCalledTimes(1);
    const [name, , options] = setSpy.mock.calls[0];
    expect(name).toBe("kakeibo_passkey_auth");
    expect(options).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/", maxAge: 120 });

    const consumed = await consumeChallengeCookie("authenticate");
    expect(consumed).toBe("CHALLENGE");
  });

  it("register 用は kakeibo_passkey_register に載る", async () => {
    await setChallengeCookie("register", "CHALLENGE");
    expect(setSpy.mock.calls[0][0]).toBe("kakeibo_passkey_register");
  });
});

describe("consumeChallengeCookie（単回性）", () => {
  it("1回目は取り出せる", async () => {
    await setChallengeCookie("authenticate", "CHALLENGE");
    await expect(consumeChallengeCookie("authenticate")).resolves.toBe("CHALLENGE");
  });

  it("2回目は null（1回目で Cookie が消えている）", async () => {
    await setChallengeCookie("authenticate", "CHALLENGE");
    await consumeChallengeCookie("authenticate");
    await expect(consumeChallengeCookie("authenticate")).resolves.toBeNull();
  });

  it("検証前に Cookie を削除する（成否にかかわらず消える）", async () => {
    // 検証に失敗するケース（用途の取り違え）でも Cookie が残らないことを確認する
    const token = await createChallengeToken("CHALLENGE", "register", SECRET);
    store.set("kakeibo_passkey_auth", { name: "kakeibo_passkey_auth", value: token });

    await expect(consumeChallengeCookie("authenticate")).resolves.toBeNull();
    expect(deleteSpy).toHaveBeenCalledWith("kakeibo_passkey_auth");
    expect(store.has("kakeibo_passkey_auth")).toBe(false);
  });

  it("Cookie が無ければ null", async () => {
    await expect(consumeChallengeCookie("authenticate")).resolves.toBeNull();
  });

  it("register と authenticate の Cookie は独立している", async () => {
    await setChallengeCookie("register", "REG-CHALLENGE");
    await setChallengeCookie("authenticate", "AUTH-CHALLENGE");

    await expect(consumeChallengeCookie("register")).resolves.toBe("REG-CHALLENGE");
    // register を消費しても authenticate 側は残っている
    await expect(consumeChallengeCookie("authenticate")).resolves.toBe("AUTH-CHALLENGE");
  });
});

describe("clearChallengeCookie", () => {
  it("Cookie を削除する", async () => {
    await setChallengeCookie("authenticate", "CHALLENGE");
    await clearChallengeCookie("authenticate");
    expect(deleteSpy).toHaveBeenCalledWith("kakeibo_passkey_auth");
    await expect(consumeChallengeCookie("authenticate")).resolves.toBeNull();
  });

  it("Cookie が無くてもエラーにならない", async () => {
    await expect(clearChallengeCookie("register")).resolves.toBeUndefined();
  });
});
