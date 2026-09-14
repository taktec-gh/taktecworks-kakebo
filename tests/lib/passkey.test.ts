// @vitest-environment node
//
// src/lib/passkey.ts の純粋ロジックを検証する。jose を使うため node 環境
// （理由は tests/lib/auth.test.ts 冒頭のコメントと同じ）。
//
// 期待値の根拠:
// - docs/steps/step-7.md「設計判断 1〜3」「tester への引き継ぎ > 2. 公開インターフェース」
// - docs/steps/step-7.md「特に壊れやすい箇所」表

import { describe, expect, it, vi } from "vitest";

import { SESSION_SUBJECT, createSessionToken } from "@/lib/auth";
import {
  AUTH_CHALLENGE_COOKIE_NAME,
  AUTH_CHALLENGE_SUBJECT,
  CHALLENGE_MAX_AGE_SECONDS,
  DEVICE_NAME_MAX_LENGTH,
  PASSKEY_ERRORS,
  REGISTER_CHALLENGE_COOKIE_NAME,
  REGISTER_CHALLENGE_SUBJECT,
  createChallengeToken,
  getChallengeCookieName,
  getChallengeCookieOptions,
  getChallengeSubject,
  getCredentialDeleteBlockedReason,
  getRpConfig,
  isCounterRegression,
  isRecoveryMode,
  shouldRequirePasskey,
  toAuthenticatorTransports,
  validateCredentialId,
  validateDeviceName,
  verifyChallengeToken,
} from "@/lib/passkey";

const SECRET = "test-auth-secret-0123456789abcdef";
const OTHER_SECRET = "another-auth-secret-fedcba9876543210";

describe("getChallengeSubject / getChallengeCookieName", () => {
  it("register の sub は passkey-register、Cookie 名は kakeibo_passkey_register", () => {
    expect(getChallengeSubject("register")).toBe(REGISTER_CHALLENGE_SUBJECT);
    expect(getChallengeSubject("register")).toBe("passkey-register");
    expect(getChallengeCookieName("register")).toBe(REGISTER_CHALLENGE_COOKIE_NAME);
    expect(getChallengeCookieName("register")).toBe("kakeibo_passkey_register");
  });

  it("authenticate の sub は passkey-auth、Cookie 名は kakeibo_passkey_auth", () => {
    expect(getChallengeSubject("authenticate")).toBe(AUTH_CHALLENGE_SUBJECT);
    expect(getChallengeSubject("authenticate")).toBe("passkey-auth");
    expect(getChallengeCookieName("authenticate")).toBe(AUTH_CHALLENGE_COOKIE_NAME);
    expect(getChallengeCookieName("authenticate")).toBe("kakeibo_passkey_auth");
  });

  it("セッション JWT の sub（'owner'）とは異なる", () => {
    expect(getChallengeSubject("register")).not.toBe(SESSION_SUBJECT);
    expect(getChallengeSubject("authenticate")).not.toBe(SESSION_SUBJECT);
  });
});

describe("getRpConfig", () => {
  it("RP_ID / RP_ORIGIN が両方妥当ならその値を返す", () => {
    const config = getRpConfig({ RP_ID: "localhost", RP_ORIGIN: "http://localhost:3123" });
    expect(config).toEqual({ rpID: "localhost", rpOrigin: "http://localhost:3123", rpName: "家計簿" });
  });

  it("RP_ID 未設定なら throw", () => {
    expect(() => getRpConfig({ RP_ORIGIN: "http://localhost:3123" })).toThrow(
      "RP_ID is not set",
    );
  });

  it("RP_ID が空文字なら throw", () => {
    expect(() => getRpConfig({ RP_ID: "", RP_ORIGIN: "http://localhost:3123" })).toThrow(
      "RP_ID is not set",
    );
  });

  it("RP_ID に '/' を含むと throw（スキーム付きの取り違え）", () => {
    expect(() =>
      getRpConfig({ RP_ID: "https://example.com", RP_ORIGIN: "http://localhost:3123" }),
    ).toThrow("RP_ID must be a bare hostname");
  });

  it("RP_ID に ':' を含むと throw（ポート付きの取り違え）", () => {
    expect(() =>
      getRpConfig({ RP_ID: "localhost:3123", RP_ORIGIN: "http://localhost:3123" }),
    ).toThrow("RP_ID must be a bare hostname");
  });

  it("RP_ORIGIN 未設定なら throw", () => {
    expect(() => getRpConfig({ RP_ID: "localhost" })).toThrow("RP_ORIGIN is not set");
  });

  it("RP_ORIGIN が空文字なら throw", () => {
    expect(() => getRpConfig({ RP_ID: "localhost", RP_ORIGIN: "" })).toThrow(
      "RP_ORIGIN is not set",
    );
  });

  it("RP_ORIGIN がスキームで始まらないと throw", () => {
    expect(() => getRpConfig({ RP_ID: "localhost", RP_ORIGIN: "localhost:3123" })).toThrow(
      "RP_ORIGIN must include the scheme",
    );
  });

  it("既定は process.env を読む", () => {
    vi.stubEnv("RP_ID", "kakeibo.vercel.app");
    vi.stubEnv("RP_ORIGIN", "https://kakeibo.vercel.app");
    expect(getRpConfig()).toEqual({
      rpID: "kakeibo.vercel.app",
      rpOrigin: "https://kakeibo.vercel.app",
      rpName: "家計簿",
    });
    vi.unstubAllEnvs();
  });
});

describe("isRecoveryMode", () => {
  it("'1' のときだけ true", () => {
    expect(isRecoveryMode({ RECOVERY_MODE: "1" })).toBe(true);
  });

  it.each([["true"], ["0"], [""], [undefined]])("'%s' は false", (value) => {
    expect(isRecoveryMode({ RECOVERY_MODE: value })).toBe(false);
  });

  it("キー自体が無い場合も false", () => {
    expect(isRecoveryMode({})).toBe(false);
  });
});

describe("shouldRequirePasskey（設計判断1の判定表）", () => {
  it("件数0・RECOVERY_MODE未設定 → 通す（false）", () => {
    expect(shouldRequirePasskey(0, false)).toBe(false);
  });

  it("件数1以上・RECOVERY_MODE未設定 → 拒否（true）", () => {
    expect(shouldRequirePasskey(1, false)).toBe(true);
    expect(shouldRequirePasskey(5, false)).toBe(true);
  });

  it("件数0・RECOVERY_MODE=1 → 通す（false）", () => {
    expect(shouldRequirePasskey(0, true)).toBe(false);
  });

  it("件数1以上・RECOVERY_MODE=1 → 通す（false、緊急脱出）", () => {
    expect(shouldRequirePasskey(1, true)).toBe(false);
    expect(shouldRequirePasskey(100, true)).toBe(false);
  });
});

describe("getCredentialDeleteBlockedReason", () => {
  it("RECOVERY_MODE 未設定・残り1本なら削除不可の理由を返す", () => {
    expect(getCredentialDeleteBlockedReason(1, false)).toBe(PASSKEY_ERRORS.deleteLastOne);
  });

  it("RECOVERY_MODE 未設定・残り0本（矛盾状態）でも削除不可扱い", () => {
    expect(getCredentialDeleteBlockedReason(0, false)).toBe(PASSKEY_ERRORS.deleteLastOne);
  });

  it("RECOVERY_MODE 未設定・残り2本以上なら削除できる（null）", () => {
    expect(getCredentialDeleteBlockedReason(2, false)).toBeNull();
  });

  it("RECOVERY_MODE=1 なら残り1本でも削除できる（null）", () => {
    expect(getCredentialDeleteBlockedReason(1, true)).toBeNull();
  });
});

describe("isCounterRegression（クローン検知）", () => {
  it("新しい値が保存値より大きければ正常（false）", () => {
    expect(isCounterRegression(5, 6)).toBe(false);
  });

  it("新しい値が保存値と同じなら巻き戻り（true）", () => {
    expect(isCounterRegression(5, 5)).toBe(true);
  });

  it("新しい値が保存値より小さければ巻き戻り（true）", () => {
    expect(isCounterRegression(5, 3)).toBe(true);
  });

  it("保存値・新値ともに0なら常に0を返す認証器として許容する（false）", () => {
    expect(isCounterRegression(0, 0)).toBe(false);
  });

  it("保存値が0で新値が0より大きければ正常（false）", () => {
    expect(isCounterRegression(0, 1)).toBe(false);
  });

  it("保存値が0でない状態から0に戻るのは巻き戻り（true）", () => {
    expect(isCounterRegression(3, 0)).toBe(true);
  });
});

describe("toAuthenticatorTransports", () => {
  it("既知の値はそのまま通す", () => {
    expect(toAuthenticatorTransports(["internal", "hybrid"])).toEqual(["internal", "hybrid"]);
  });

  it("未知の値は落とす", () => {
    expect(toAuthenticatorTransports(["internal", "quantum-link"])).toEqual(["internal"]);
  });

  it("空配列はそのまま空配列", () => {
    expect(toAuthenticatorTransports([])).toEqual([]);
  });
});

describe("validateDeviceName", () => {
  it("前後の空白を trim して通す", () => {
    expect(validateDeviceName("  iPhone  ")).toEqual({ ok: true, value: "iPhone" });
  });

  it("空文字は拒否", () => {
    expect(validateDeviceName("")).toEqual({ ok: false, error: PASSKEY_ERRORS.deviceNameRequired });
  });

  it("空白のみは拒否", () => {
    expect(validateDeviceName("   ")).toEqual({
      ok: false,
      error: PASSKEY_ERRORS.deviceNameRequired,
    });
  });

  it("文字列でない入力は拒否", () => {
    expect(validateDeviceName(undefined)).toEqual({
      ok: false,
      error: PASSKEY_ERRORS.deviceNameRequired,
    });
    expect(validateDeviceName(123)).toEqual({
      ok: false,
      error: PASSKEY_ERRORS.deviceNameRequired,
    });
  });

  it(`ちょうど${DEVICE_NAME_MAX_LENGTH}文字は許容する`, () => {
    const name = "あ".repeat(DEVICE_NAME_MAX_LENGTH);
    expect(validateDeviceName(name)).toEqual({ ok: true, value: name });
  });

  it(`${DEVICE_NAME_MAX_LENGTH + 1}文字は拒否する`, () => {
    const name = "あ".repeat(DEVICE_NAME_MAX_LENGTH + 1);
    expect(validateDeviceName(name)).toEqual({
      ok: false,
      error: PASSKEY_ERRORS.deviceNameTooLong,
    });
  });

  it("絵文字はコードポイント単位で数える（サロゲートペアを2文字と数えない）", () => {
    // "📱" は UTF-16 では2コードユニットだが、コードポイントとしては1文字
    const name = "📱".repeat(DEVICE_NAME_MAX_LENGTH);
    expect(validateDeviceName(name)).toEqual({ ok: true, value: name });

    const tooLong = "📱".repeat(DEVICE_NAME_MAX_LENGTH + 1);
    expect(validateDeviceName(tooLong)).toEqual({
      ok: false,
      error: PASSKEY_ERRORS.deviceNameTooLong,
    });
  });
});

describe("validateCredentialId", () => {
  it("空でない文字列を通す", () => {
    expect(validateCredentialId("cred-1")).toEqual({ ok: true, value: "cred-1" });
  });

  it("空文字は拒否", () => {
    expect(validateCredentialId("")).toEqual({ ok: false, error: PASSKEY_ERRORS.idRequired });
  });

  it("空白のみは拒否", () => {
    expect(validateCredentialId("   ")).toEqual({ ok: false, error: PASSKEY_ERRORS.idRequired });
  });

  it("文字列以外・未指定は拒否", () => {
    expect(validateCredentialId(undefined)).toEqual({
      ok: false,
      error: PASSKEY_ERRORS.idRequired,
    });
    expect(validateCredentialId(null)).toEqual({ ok: false, error: PASSKEY_ERRORS.idRequired });
  });
});

describe("createChallengeToken / verifyChallengeToken", () => {
  const NOW = new Date("2026-08-14T00:00:00.000Z");

  it("発行したトークンは同じ用途・同じ鍵で検証できる", async () => {
    const token = await createChallengeToken("CHALLENGE", "authenticate", SECRET, { now: NOW });
    await expect(verifyChallengeToken(token, "authenticate", SECRET, { now: NOW })).resolves.toBe(
      "CHALLENGE",
    );
  });

  it("チャレンジの取り違え: 登録用チャレンジを認証用として検証すると null（sub 違い）", async () => {
    const token = await createChallengeToken("CHALLENGE", "register", SECRET, { now: NOW });
    await expect(
      verifyChallengeToken(token, "authenticate", SECRET, { now: NOW }),
    ).resolves.toBeNull();
  });

  it("チャレンジの取り違え: 認証用チャレンジを登録用として検証すると null（sub 違い）", async () => {
    const token = await createChallengeToken("CHALLENGE", "authenticate", SECRET, { now: NOW });
    await expect(
      verifyChallengeToken(token, "register", SECRET, { now: NOW }),
    ).resolves.toBeNull();
  });

  it("チャレンジの取り違え: セッション JWT をチャレンジとして渡すと null（sub が 'owner'）", async () => {
    const sessionToken = await createSessionToken(SECRET, { now: NOW });
    await expect(
      verifyChallengeToken(sessionToken, "authenticate", SECRET, { now: NOW }),
    ).resolves.toBeNull();
    await expect(
      verifyChallengeToken(sessionToken, "register", SECRET, { now: NOW }),
    ).resolves.toBeNull();
  });

  it("期限切れ（120秒超）は null", async () => {
    const token = await createChallengeToken("CHALLENGE", "authenticate", SECRET, { now: NOW });
    const after = new Date(NOW.getTime() + (CHALLENGE_MAX_AGE_SECONDS + 1) * 1000);
    await expect(
      verifyChallengeToken(token, "authenticate", SECRET, { now: after }),
    ).resolves.toBeNull();
  });

  it("ちょうど120秒後は失効している（exp は発行+120秒ちょうどで、jose は exp 以上を失効扱い）", async () => {
    const token = await createChallengeToken("CHALLENGE", "authenticate", SECRET, { now: NOW });
    const atExpiry = new Date(NOW.getTime() + CHALLENGE_MAX_AGE_SECONDS * 1000);
    await expect(
      verifyChallengeToken(token, "authenticate", SECRET, { now: atExpiry }),
    ).resolves.toBeNull();
  });

  it("119秒後はまだ有効", async () => {
    const token = await createChallengeToken("CHALLENGE", "authenticate", SECRET, { now: NOW });
    const before = new Date(NOW.getTime() + (CHALLENGE_MAX_AGE_SECONDS - 1) * 1000);
    await expect(
      verifyChallengeToken(token, "authenticate", SECRET, { now: before }),
    ).resolves.toBe("CHALLENGE");
  });

  it("別の鍵で署名されたトークンは null", async () => {
    const token = await createChallengeToken("CHALLENGE", "authenticate", SECRET, { now: NOW });
    await expect(
      verifyChallengeToken(token, "authenticate", OTHER_SECRET, { now: NOW }),
    ).resolves.toBeNull();
  });

  it("token が undefined / null / 空文字なら null", async () => {
    await expect(verifyChallengeToken(undefined, "authenticate", SECRET)).resolves.toBeNull();
    await expect(verifyChallengeToken(null, "authenticate", SECRET)).resolves.toBeNull();
    await expect(verifyChallengeToken("", "authenticate", SECRET)).resolves.toBeNull();
  });

  it("JWT ですらない値は null", async () => {
    await expect(verifyChallengeToken("garbage", "authenticate", SECRET)).resolves.toBeNull();
  });

  it("secret が空文字なら createChallengeToken は throw する", async () => {
    await expect(createChallengeToken("CHALLENGE", "authenticate", "")).rejects.toThrow(
      "AUTH_SECRET is not set",
    );
  });

  it("secret が空文字なら verifyChallengeToken は throw する", async () => {
    const token = await createChallengeToken("CHALLENGE", "authenticate", SECRET, { now: NOW });
    await expect(verifyChallengeToken(token, "authenticate", "")).rejects.toThrow(
      "AUTH_SECRET is not set",
    );
  });
});

describe("getChallengeCookieOptions", () => {
  it("既定値: httpOnly / sameSite=lax / path=/ / maxAge=120", () => {
    expect(getChallengeCookieOptions({ isProduction: false })).toEqual({
      httpOnly: true,
      sameSite: "lax",
      secure: false,
      path: "/",
      maxAge: CHALLENGE_MAX_AGE_SECONDS,
    });
  });

  it("本番では secure: true", () => {
    expect(getChallengeCookieOptions({ isProduction: true })).toMatchObject({ secure: true });
  });

  it("maxAgeSeconds を上書きできる", () => {
    expect(getChallengeCookieOptions({ isProduction: false, maxAgeSeconds: 30 })).toMatchObject({
      maxAge: 30,
    });
  });
});
