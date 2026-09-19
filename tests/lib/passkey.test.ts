// @vitest-environment node
//
// src/lib/passkey.ts の純粋ロジックを検証する。jose を使うため node 環境
// （理由は tests/lib/auth.test.ts 冒頭のコメントと同じ）。
//
// 期待値の根拠:
// - docs/steps/step-7.md「設計判断 1〜3」「tester への引き継ぎ > 2. 公開インターフェース」
// - docs/steps/step-7.md「特に壊れやすい箇所」表

import { describe, expect, it, vi } from "vitest";

import { createSessionToken } from "@/lib/auth";
import {
  AUTH_CHALLENGE_COOKIE_NAME,
  AUTH_CHALLENGE_SUBJECT,
  CHALLENGE_MAX_AGE_SECONDS,
  DEVICE_NAME_MAX_LENGTH,
  PASSKEY_ERRORS,
  REGISTER_CHALLENGE_COOKIE_NAME,
  REGISTER_CHALLENGE_SUBJECT,
  SIGNUP_CHALLENGE_COOKIE_NAME,
  SIGNUP_CHALLENGE_SUBJECT,
  createChallengeToken,
  createSignupChallengeToken,
  getChallengeCookieName,
  getChallengeCookieOptions,
  getChallengeSubject,
  getCredentialDeleteBlockedReason,
  getRpConfig,
  isCounterRegression,
  toAuthenticatorTransports,
  validateCredentialId,
  validateDeviceName,
  verifyChallengeToken,
  verifySignupChallengeToken,
} from "@/lib/passkey";
import type { UserId } from "@/lib/user-id";

const SECRET = "test-auth-secret-0123456789abcdef";
const OTHER_SECRET = "another-auth-secret-fedcba9876543210";
const USER_ID = "user_1" as UserId;
// 32バイトの手元生成済み固定値（node -e "Buffer.from([1..32]).toString('base64url')"）
const WEBAUTHN_USER_ID = "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA";
const OTHER_WEBAUTHN_USER_ID = "__79_Pv6-fj39vX08_Lx8O_u7ezr6uno5-bl5OPi4eA";

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

  // 「セッション JWT の sub とは異なる」という単体の等値比較は、公開版では sub が
  // 固定値の "owner" ではなくユーザーID（cuid、可変）になったため書けない。
  // 実際の防御（セッション JWT をチャレンジとして使えないこと）は typ ヘッダ ではなく
  // このファイルの createChallengeToken/verifyChallengeToken の「チャレンジの取り違え:
  // セッション JWT をチャレンジとして渡すと null」で直接検証する。
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

// isRecoveryMode / shouldRequirePasskey は公開版で廃止（docs/steps/pub-1.md 設計判断 1）。
// RECOVERY_MODE の環境変数1本で全利用者のパスキー必須化を解除する仕組みは、
// 複数ユーザー化と両立しないため削除された（src/lib/passkey.ts に export が無いことを確認済み）。

describe("getCredentialDeleteBlockedReason（ユーザー単位の件数で判定。recoveryMode 引数は無い）", () => {
  it("残り1本なら削除不可の理由を返す", () => {
    expect(getCredentialDeleteBlockedReason(1)).toBe(PASSKEY_ERRORS.deleteLastOne);
  });

  it("残り0本（矛盾状態）でも削除不可扱い", () => {
    expect(getCredentialDeleteBlockedReason(0)).toBe(PASSKEY_ERRORS.deleteLastOne);
  });

  it("残り2本以上なら削除できる（null）", () => {
    expect(getCredentialDeleteBlockedReason(2)).toBeNull();
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

  it("チャレンジの取り違え: セッション JWT をチャレンジとして渡すと null（sub がユーザーID）", async () => {
    const sessionToken = await createSessionToken(SECRET, USER_ID, { now: NOW });
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

describe("createSignupChallengeToken / verifySignupChallengeToken（docs/steps/pub-2.md 設計判断 2・3）", () => {
  const NOW = new Date("2026-08-14T00:00:00.000Z");

  it("定数: sub は passkey-signup、Cookie 名は kakeibo_passkey_signup", () => {
    expect(SIGNUP_CHALLENGE_SUBJECT).toBe("passkey-signup");
    expect(SIGNUP_CHALLENGE_COOKIE_NAME).toBe("kakeibo_passkey_signup");
  });

  it("発行したトークンをそのまま検証でき、チャレンジと webauthnUserId が往復する", async () => {
    const token = await createSignupChallengeToken("CHALLENGE", WEBAUTHN_USER_ID, SECRET, {
      now: NOW,
    });
    await expect(verifySignupChallengeToken(token, SECRET, { now: NOW })).resolves.toEqual({
      challenge: "CHALLENGE",
      webauthnUserId: WEBAUTHN_USER_ID,
    });
  });

  it("webauthnUserId の形式が不正なら createSignupChallengeToken は throw する（Cookie に不正な値を入れない）", async () => {
    await expect(
      createSignupChallengeToken("CHALLENGE", "not-a-valid-id", SECRET, { now: NOW }),
    ).rejects.toThrow("invalid webauthnUserId");
  });

  it("webauthnUserId クレームが無いトークン（手作りで欠落させる）は null", async () => {
    const { SignJWT } = await import("jose");
    const key = new TextEncoder().encode(SECRET);
    const issuedAt = Math.floor(NOW.getTime() / 1000);
    const token = await new SignJWT({ challenge: "CHALLENGE" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(SIGNUP_CHALLENGE_SUBJECT)
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + 120)
      .sign(key);
    await expect(verifySignupChallengeToken(token, SECRET, { now: NOW })).resolves.toBeNull();
  });

  it("webauthnUserId クレームの形式が不正なトークンは null", async () => {
    const { SignJWT } = await import("jose");
    const key = new TextEncoder().encode(SECRET);
    const issuedAt = Math.floor(NOW.getTime() / 1000);
    const token = await new SignJWT({ challenge: "CHALLENGE", webauthnUserId: "bogus" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(SIGNUP_CHALLENGE_SUBJECT)
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + 120)
      .sign(key);
    await expect(verifySignupChallengeToken(token, SECRET, { now: NOW })).resolves.toBeNull();
  });

  it("期限切れ（120秒超）は null", async () => {
    const token = await createSignupChallengeToken("CHALLENGE", WEBAUTHN_USER_ID, SECRET, {
      now: NOW,
    });
    const after = new Date(NOW.getTime() + (CHALLENGE_MAX_AGE_SECONDS + 1) * 1000);
    await expect(verifySignupChallengeToken(token, SECRET, { now: after })).resolves.toBeNull();
  });

  it("別の鍵で署名されたトークンは null", async () => {
    const token = await createSignupChallengeToken("CHALLENGE", WEBAUTHN_USER_ID, SECRET, {
      now: NOW,
    });
    await expect(
      verifySignupChallengeToken(token, OTHER_SECRET, { now: NOW }),
    ).resolves.toBeNull();
  });

  it("token が undefined / null / 空文字なら null", async () => {
    await expect(verifySignupChallengeToken(undefined, SECRET)).resolves.toBeNull();
    await expect(verifySignupChallengeToken(null, SECRET)).resolves.toBeNull();
    await expect(verifySignupChallengeToken("", SECRET)).resolves.toBeNull();
  });

  it("secret が空文字なら createSignupChallengeToken は throw する", async () => {
    await expect(
      createSignupChallengeToken("CHALLENGE", WEBAUTHN_USER_ID, ""),
    ).rejects.toThrow("AUTH_SECRET is not set");
  });

  it("secret が空文字なら verifySignupChallengeToken は throw する", async () => {
    const token = await createSignupChallengeToken("CHALLENGE", WEBAUTHN_USER_ID, SECRET, {
      now: NOW,
    });
    await expect(verifySignupChallengeToken(token, "")).rejects.toThrow(
      "AUTH_SECRET is not set",
    );
  });

  it("2回発行しても webauthnUserId が異なれば、それぞれ独立して往復する（取り違えない）", async () => {
    const tokenA = await createSignupChallengeToken("CHALLENGE-A", WEBAUTHN_USER_ID, SECRET, {
      now: NOW,
    });
    const tokenB = await createSignupChallengeToken(
      "CHALLENGE-B",
      OTHER_WEBAUTHN_USER_ID,
      SECRET,
      { now: NOW },
    );
    await expect(verifySignupChallengeToken(tokenA, SECRET, { now: NOW })).resolves.toEqual({
      challenge: "CHALLENGE-A",
      webauthnUserId: WEBAUTHN_USER_ID,
    });
    await expect(verifySignupChallengeToken(tokenB, SECRET, { now: NOW })).resolves.toEqual({
      challenge: "CHALLENGE-B",
      webauthnUserId: OTHER_WEBAUTHN_USER_ID,
    });
  });
});

describe("チャレンジの用途の取り違え: register・authenticate・signup の 3×3（docs/steps/pub-2.md「tester 向けの方針」2）", () => {
  const NOW = new Date("2026-08-14T00:00:00.000Z");

  it("register で発行したトークンは register でのみ通り、authenticate・signup では通らない", async () => {
    const token = await createChallengeToken("CHALLENGE", "register", SECRET, { now: NOW });

    await expect(verifyChallengeToken(token, "register", SECRET, { now: NOW })).resolves.toBe(
      "CHALLENGE",
    );
    await expect(
      verifyChallengeToken(token, "authenticate", SECRET, { now: NOW }),
    ).resolves.toBeNull();
    await expect(verifySignupChallengeToken(token, SECRET, { now: NOW })).resolves.toBeNull();
  });

  it("authenticate で発行したトークンは authenticate でのみ通り、register・signup では通らない", async () => {
    const token = await createChallengeToken("CHALLENGE", "authenticate", SECRET, { now: NOW });

    await expect(
      verifyChallengeToken(token, "authenticate", SECRET, { now: NOW }),
    ).resolves.toBe("CHALLENGE");
    await expect(
      verifyChallengeToken(token, "register", SECRET, { now: NOW }),
    ).resolves.toBeNull();
    await expect(verifySignupChallengeToken(token, SECRET, { now: NOW })).resolves.toBeNull();
  });

  it("signup で発行したトークンは signup でのみ通り、register・authenticate では通らない", async () => {
    const token = await createSignupChallengeToken("CHALLENGE", WEBAUTHN_USER_ID, SECRET, {
      now: NOW,
    });

    await expect(verifySignupChallengeToken(token, SECRET, { now: NOW })).resolves.toEqual({
      challenge: "CHALLENGE",
      webauthnUserId: WEBAUTHN_USER_ID,
    });
    await expect(
      verifyChallengeToken(token, "register", SECRET, { now: NOW }),
    ).resolves.toBeNull();
    await expect(
      verifyChallengeToken(token, "authenticate", SECRET, { now: NOW }),
    ).resolves.toBeNull();
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
