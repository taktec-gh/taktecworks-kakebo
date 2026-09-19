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

import { createChallengeToken, createSignupChallengeToken } from "@/lib/passkey";

const SECRET = "test-auth-secret-0123456789abcdef";
// 32バイトの手元生成済み固定値（node -e "Buffer.from([1..32]).toString('base64url')"）
const WEBAUTHN_USER_ID = "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA";

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

const {
  setChallengeCookie,
  consumeChallengeCookie,
  clearChallengeCookie,
  setSignupChallengeCookie,
  consumeSignupChallengeCookie,
} = await import("@/lib/passkey-session");

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

describe("setSignupChallengeCookie / consumeSignupChallengeCookie（docs/steps/pub-2.md 設計判断 2）", () => {
  it("kakeibo_passkey_signup にチャレンジと webauthnUserId をまとめて載せ、往復できる", async () => {
    await setSignupChallengeCookie("CHALLENGE", WEBAUTHN_USER_ID);

    expect(setSpy).toHaveBeenCalledTimes(1);
    const [name, , options] = setSpy.mock.calls[0];
    expect(name).toBe("kakeibo_passkey_signup");
    expect(options).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/", maxAge: 120 });

    await expect(consumeSignupChallengeCookie()).resolves.toEqual({
      challenge: "CHALLENGE",
      webauthnUserId: WEBAUTHN_USER_ID,
    });
  });

  it("1回消費すると2回目は null（単回性）", async () => {
    await setSignupChallengeCookie("CHALLENGE", WEBAUTHN_USER_ID);
    await consumeSignupChallengeCookie();
    await expect(consumeSignupChallengeCookie()).resolves.toBeNull();
  });

  it("検証前に Cookie を削除する（失敗するケースでも Cookie が残らない）", async () => {
    // 設定画面の登録用チャレンジを signup の Cookie 名に紛れ込ませた状況（sub 違いで検証は失敗する）
    const token = await createChallengeToken("CHALLENGE", "register", SECRET);
    store.set("kakeibo_passkey_signup", { name: "kakeibo_passkey_signup", value: token });

    await expect(consumeSignupChallengeCookie()).resolves.toBeNull();
    expect(deleteSpy).toHaveBeenCalledWith("kakeibo_passkey_signup");
    expect(store.has("kakeibo_passkey_signup")).toBe(false);
  });

  it("Cookie が無ければ null", async () => {
    await expect(consumeSignupChallengeCookie()).resolves.toBeNull();
  });

  it("register/authenticate の Cookie とは独立している（同時に発行しても互いに影響しない）", async () => {
    await setChallengeCookie("register", "REG-CHALLENGE");
    await setChallengeCookie("authenticate", "AUTH-CHALLENGE");
    await setSignupChallengeCookie("SIGNUP-CHALLENGE", WEBAUTHN_USER_ID);

    await expect(consumeSignupChallengeCookie()).resolves.toEqual({
      challenge: "SIGNUP-CHALLENGE",
      webauthnUserId: WEBAUTHN_USER_ID,
    });
    // signup を消費しても register/authenticate 側は残っている
    await expect(consumeChallengeCookie("register")).resolves.toBe("REG-CHALLENGE");
    await expect(consumeChallengeCookie("authenticate")).resolves.toBe("AUTH-CHALLENGE");
  });

  it("サインアップ用チャレンジトークンを register/authenticate として消費しようとしても失敗する（Cookie名が別なので混入しない前提だが、念のため sub の分離も確認）", async () => {
    const token = await createSignupChallengeToken("CHALLENGE", WEBAUTHN_USER_ID, SECRET);
    store.set("kakeibo_passkey_register", { name: "kakeibo_passkey_register", value: token });

    await expect(consumeChallengeCookie("register")).resolves.toBeNull();
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
