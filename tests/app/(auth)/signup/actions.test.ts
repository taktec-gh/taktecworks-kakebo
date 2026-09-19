// @vitest-environment node
//
// src/app/(auth)/signup/actions.ts（startSignupAction / finishSignupAction）を検証する。
// @simplewebauthn/server は本物の署名を作らずモックする方針
// （docs/steps/step-7.md「tester への引き継ぎ > 4. WebAuthn の応答をどうモックするか」と同じ）。
// チャレンジ Cookie（src/lib/passkey.ts・passkey-session.ts）は本物を使う
// （next/headers だけをモックし、実際の JWT 署名・検証・Cookie の単回性を確かめるため）。
//
// createUserWithPasskey（src/lib/users.ts）と isSignupRateLimited（src/lib/signup-limits.ts）は
// 高レベルにモックする。その内部の正しさ（トランザクション・レート制限の境界値）は
// それぞれ tests/lib/users.test.ts・tests/lib/signup-limits.test.ts で検証済み。
// ここでは actions.ts が「何を・どの順で・どの値で」呼ぶかだけを見る。
//
// 期待値の根拠:
// - docs/steps/pub-2.md 設計判断 2「パスキーの検証が済むまでユーザーを作らない」
//   「ユーザーIDは登録応答には含まれないので、開始時に作った値を署名付きの Cookie から
//   取り出す。リクエストの本文やフォームから受け取らない」
// - docs/steps/pub-2.md 設計判断 5「サインアップのレート制限」
//   「開始時と完了時の両方で確認する」「数えるのは『作られたアカウント』」
// - docs/steps/pub-2.md「tester 向けの方針」1〜4
// - docs/steps/pub-2.md「実装完了後の引き継ぎ」
//   「finishSignupAction の処理順: Cookie を消費（null → challengeExpired）→ 端末名の検証 →
//   IP ハッシュとレート制限（→ rateLimited）→ getRpConfig → verifyRegistrationResponse
//   （→ verificationFailed）→ createUserWithPasskey（Cookie の webauthnUserId を使う。
//   重複 → duplicate）→ createSession(戻り値の userId)。予期しない例外は unavailable」
//   「端末名の検証より前に Cookie を消費する（成否にかかわらず Cookie を消すため）」

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  SIGNUP_CHALLENGE_COOKIE_NAME,
  verifySignupChallengeToken,
  type PasskeyRegistrationOptionsResult,
} from "@/lib/passkey";
import { PASSKEY_ERRORS } from "@/lib/passkey-messages";
import { SIGNUP_ERRORS } from "@/lib/signup-messages";

import type { RegistrationResponseJSON } from "@simplewebauthn/server";

const SECRET = "test-auth-secret-0123456789abcdef";
const RP_ID = "localhost";
const RP_ORIGIN = "http://localhost:3123";

// ---- @simplewebauthn/server のモック ----
const generateRegistrationOptions = vi.fn(async (opts: unknown) => {
  const userID = (opts as { userID: Uint8Array }).userID;
  return {
    challenge: "CHALLENGE",
    rp: { name: "家計簿", id: RP_ID },
    user: { id: Buffer.from(userID).toString("base64url"), name: "家計簿 #TEST", displayName: "家計簿 #TEST" },
    pubKeyCredParams: [],
  };
});
type RegistrationVerification = Awaited<
  ReturnType<typeof import("@simplewebauthn/server").verifyRegistrationResponse>
>;
const verifyRegistrationResponse = vi.fn(
  async (_opts: unknown): Promise<RegistrationVerification> => ({
    verified: true,
    registrationInfo: {
      fmt: "none" as const,
      aaguid: "00000000-0000-0000-0000-000000000000",
      credential: { id: "cred-1", publicKey: new Uint8Array([1, 2, 3]), counter: 0 },
      credentialType: "public-key" as const,
      attestationObject: new Uint8Array(),
      userVerified: true,
      credentialDeviceType: "multiDevice" as const,
      credentialBackedUp: true,
      origin: RP_ORIGIN,
      rpID: RP_ID,
    },
  }),
);

vi.mock("@simplewebauthn/server", () => ({
  generateRegistrationOptions: (opts: unknown) => generateRegistrationOptions(opts),
  verifyRegistrationResponse: (opts: unknown) => verifyRegistrationResponse(opts),
}));

// ---- next/headers（Cookie ストア + ヘッダ）のモック。本物のチャレンジ署名・検証を使う ----
type StoredCookie = { name: string; value: string; options?: Record<string, unknown> };
const cookieStore = new Map<string, StoredCookie>();
let forwardedFor: string | null = "203.0.113.9";

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => cookieStore.get(name),
    set: (name: string, value: string, options?: Record<string, unknown>) => {
      cookieStore.set(name, { name, value, options });
    },
    delete: (name: string) => {
      cookieStore.delete(name);
    },
  }),
  headers: async () => new Headers(forwardedFor ? { "x-forwarded-for": forwardedFor } : {}),
}));

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

// ---- レート制限のモック ----
const isSignupRateLimited = vi.fn(async (..._args: unknown[]) => false);
vi.mock("@/lib/signup-limits", () => ({
  isSignupRateLimited: (...args: unknown[]) => isSignupRateLimited(...args),
}));

// ---- ユーザー作成のモック ----
const createUserWithPasskey = vi.fn();
vi.mock("@/lib/users", () => ({
  createUserWithPasskey: (...args: unknown[]) => createUserWithPasskey(...args),
}));

// ---- セッション発行のモック ----
const createSession = vi.fn(async (..._args: unknown[]) => {});
vi.mock("@/lib/session", () => ({ createSession: (...args: unknown[]) => createSession(...args) }));

const { startSignupAction, finishSignupAction } = await import("@/app/(auth)/signup/actions");

const regResponse: RegistrationResponseJSON = {
  id: "cred-1",
  rawId: "cred-1",
  type: "public-key",
  clientExtensionResults: {},
  response: {
    clientDataJSON: "e30",
    attestationObject: "e30",
    transports: ["internal", "hybrid"],
  },
};

beforeEach(() => {
  cookieStore.clear();
  forwardedFor = "203.0.113.9";
  generateRegistrationOptions.mockClear();
  verifyRegistrationResponse.mockReset();
  verifyRegistrationResponse.mockResolvedValue({
    verified: true,
    registrationInfo: {
      fmt: "none" as const,
      aaguid: "00000000-0000-0000-0000-000000000000",
      credential: { id: "cred-1", publicKey: new Uint8Array([1, 2, 3]), counter: 0 },
      credentialType: "public-key" as const,
      attestationObject: new Uint8Array(),
      userVerified: true,
      credentialDeviceType: "multiDevice" as const,
      credentialBackedUp: true,
      origin: RP_ORIGIN,
      rpID: RP_ID,
    },
  });
  isSignupRateLimited.mockReset();
  isSignupRateLimited.mockResolvedValue(false);
  createUserWithPasskey.mockReset();
  createUserWithPasskey.mockResolvedValue({ ok: true, userId: "user_new_1" });
  createSession.mockClear();

  vi.stubEnv("AUTH_SECRET", SECRET);
  vi.stubEnv("RP_ID", RP_ID);
  vi.stubEnv("RP_ORIGIN", RP_ORIGIN);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/** 開始アクションを呼び、そのとき Cookie に載った webauthnUserId を（本物の検証で）読み出す */
async function startAndReadCookie(): Promise<{
  result: PasskeyRegistrationOptionsResult;
  webauthnUserId: string;
}> {
  const result = await startSignupAction();
  const token = cookieStore.get(SIGNUP_CHALLENGE_COOKIE_NAME)?.value;
  const decoded = await verifySignupChallengeToken(token, SECRET);
  if (!decoded) throw new Error("テストの前提が崩れている: サインアップ Cookie を読めない");
  return { result, webauthnUserId: decoded.webauthnUserId };
}

describe("startSignupAction", () => {
  it("成功時はオプションを返し、チャレンジと webauthnUserId を Cookie に載せる。DB は書かない", async () => {
    const { result, webauthnUserId } = await startAndReadCookie();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.options.challenge).toBe("CHALLENGE");
    expect(webauthnUserId.length).toBeGreaterThan(0);
    expect(createUserWithPasskey).not.toHaveBeenCalled();
  });

  it("residentKey/userVerification を required にし、excludeCredentials は空（新規ユーザーなので除外する資格情報が無い）", async () => {
    await startSignupAction();
    expect(generateRegistrationOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        excludeCredentials: [],
        authenticatorSelection: { residentKey: "required", userVerification: "required" },
      }),
    );
  });

  it("呼ぶたびに違う webauthnUserId になる", async () => {
    const first = await startAndReadCookie();
    const second = await startAndReadCookie();
    expect(first.webauthnUserId).not.toBe(second.webauthnUserId);
  });

  it("開始時にレート制限を確認する。制限中は rateLimited を返し、Cookie を発行しない", async () => {
    isSignupRateLimited.mockResolvedValue(true);
    const result = await startSignupAction();
    expect(result).toEqual({ ok: false, error: SIGNUP_ERRORS.rateLimited });
    expect(cookieStore.has(SIGNUP_CHALLENGE_COOKIE_NAME)).toBe(false);
    expect(generateRegistrationOptions).not.toHaveBeenCalled();
  });

  it("RP_ID/RP_ORIGIN 未設定なら unavailable（サーバー内部の事情は出さない）", async () => {
    vi.stubEnv("RP_ID", "");
    const result = await startSignupAction();
    expect(result).toEqual({ ok: false, error: SIGNUP_ERRORS.unavailable });
  });

  it("AUTH_SECRET が読めず IP ハッシュ化に失敗しても unavailable（fail closed）", async () => {
    vi.stubEnv("AUTH_SECRET", "");
    const result = await startSignupAction();
    expect(result).toEqual({ ok: false, error: SIGNUP_ERRORS.unavailable });
    expect(cookieStore.has(SIGNUP_CHALLENGE_COOKIE_NAME)).toBe(false);
  });
});

describe("finishSignupAction — 正常系（観点1: ユーザーを作る相手の出どころ）", () => {
  it("createUserWithPasskey には Cookie から取り出した webauthnUserId を渡す（応答・フォームの値ではない）", async () => {
    const { webauthnUserId } = await startAndReadCookie();

    await finishSignupAction(regResponse, "iPhone");

    expect(createUserWithPasskey).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ webauthnUserId }),
    );
  });

  it("応答に webauthnUserId らしき余分なフィールドが付いていても無視する（Cookie の値だけを使う）", async () => {
    const { webauthnUserId } = await startAndReadCookie();
    const tampered = {
      ...regResponse,
      webauthnUserId: "attacker-supplied-value-not-from-cookie",
    } as unknown as RegistrationResponseJSON;

    await finishSignupAction(tampered, "iPhone");

    expect(createUserWithPasskey).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ webauthnUserId }),
    );
  });

  it("検証済みの credential（id/publicKey/counter/transports）と端末名を渡す", async () => {
    await startAndReadCookie();

    await finishSignupAction(regResponse, "  iPhone  ");

    expect(createUserWithPasskey).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        credential: {
          credentialId: "cred-1",
          publicKey: new Uint8Array([1, 2, 3]),
          counter: 0,
          transports: ["internal", "hybrid"],
          deviceName: "iPhone", // trim される
        },
      }),
    );
  });

  it("成功したら、今作ったユーザー（createUserWithPasskey の戻り値の userId）に対してセッションを発行する", async () => {
    createUserWithPasskey.mockResolvedValue({ ok: true, userId: "user_brand_new" });
    await startAndReadCookie();

    const result = await finishSignupAction(regResponse, "iPhone");

    // docs/steps/pub-5.md 設計判断 3「成功の戻り値で平文のコードを返す」。
    // コード自体はランダムなので値までは固定しないが、ok と型（RecoveryCodeIssuedResult の成功形）は固定する
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(typeof result.recoveryCode).toBe("string");
      expect(result.recoveryCode.length).toBeGreaterThan(0);
    }
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(createSession).toHaveBeenCalledWith("user_brand_new");
  });

  it("成功の戻り値の recoveryCode は、createUserWithPasskey に渡した recoveryCodeHash のハッシュ元（平文）である（docs/steps/pub-5.md 設計判断 3）", async () => {
    const { hashRecoveryCode } = await import("@/lib/recovery-code");
    await startAndReadCookie();

    const result = await finishSignupAction(regResponse, "iPhone");

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    const passedHash = (createUserWithPasskey.mock.calls[0][1] as { recoveryCodeHash: string })
      .recoveryCodeHash;
    expect(hashRecoveryCode(result.recoveryCode)).toBe(passedHash);
  });
});

describe("finishSignupAction — チャレンジの単回性・取り違え（観点2）", () => {
  it("Cookie が無ければ challengeExpired。ユーザーは作らない", async () => {
    const result = await finishSignupAction(regResponse, "iPhone");
    expect(result).toEqual({ ok: false, error: SIGNUP_ERRORS.challengeExpired });
    expect(createUserWithPasskey).not.toHaveBeenCalled();
  });

  it("同じチャレンジは2回使えない（成功後は Cookie が消えている）", async () => {
    await startAndReadCookie();
    const first = await finishSignupAction(regResponse, "iPhone");
    expect(first.ok).toBe(true);

    const second = await finishSignupAction(regResponse, "iPhone");
    expect(second).toEqual({ ok: false, error: SIGNUP_ERRORS.challengeExpired });
    expect(createUserWithPasskey).toHaveBeenCalledTimes(1);
  });

  it("成否にかかわらず Cookie は消える（失敗時も）", async () => {
    await startAndReadCookie();
    verifyRegistrationResponse.mockRejectedValue(new Error("origin mismatch"));

    const result = await finishSignupAction(regResponse, "iPhone");

    expect(result).toEqual({ ok: false, error: SIGNUP_ERRORS.verificationFailed });
    expect(cookieStore.has(SIGNUP_CHALLENGE_COOKIE_NAME)).toBe(false);
  });

  it("設定画面の登録用チャレンジ（sub=passkey-register）をサインアップの Cookie 名に入れても challengeExpired（sub 違い）", async () => {
    const { createChallengeToken } = await import("@/lib/passkey");
    const token = await createChallengeToken("CHALLENGE", "register", SECRET);
    cookieStore.set(SIGNUP_CHALLENGE_COOKIE_NAME, { name: SIGNUP_CHALLENGE_COOKIE_NAME, value: token });

    const result = await finishSignupAction(regResponse, "iPhone");
    expect(result).toEqual({ ok: false, error: SIGNUP_ERRORS.challengeExpired });
    expect(verifyRegistrationResponse).not.toHaveBeenCalled();
  });

  it("ログイン用チャレンジ（sub=passkey-auth）をサインアップの Cookie 名に入れても challengeExpired（sub 違い）", async () => {
    const { createChallengeToken } = await import("@/lib/passkey");
    const token = await createChallengeToken("CHALLENGE", "authenticate", SECRET);
    cookieStore.set(SIGNUP_CHALLENGE_COOKIE_NAME, { name: SIGNUP_CHALLENGE_COOKIE_NAME, value: token });

    const result = await finishSignupAction(regResponse, "iPhone");
    expect(result).toEqual({ ok: false, error: SIGNUP_ERRORS.challengeExpired });
    expect(verifyRegistrationResponse).not.toHaveBeenCalled();
  });

  it("期限切れ（2分超）のチャレンジは challengeExpired", async () => {
    const issuedAt = new Date("2026-08-14T00:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(issuedAt);
    await startAndReadCookie();
    vi.setSystemTime(new Date(issuedAt.getTime() + 121_000));
    try {
      const result = await finishSignupAction(regResponse, "iPhone");
      expect(result).toEqual({ ok: false, error: SIGNUP_ERRORS.challengeExpired });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("finishSignupAction — 途中離脱・失敗でユーザーを残さない（観点3）", () => {
  it("端末名が空なら検証エラーを返す。Cookie は消費済みで、createUserWithPasskey は呼ばれない", async () => {
    await startAndReadCookie();
    const result = await finishSignupAction(regResponse, "");
    expect(result).toEqual({ ok: false, error: PASSKEY_ERRORS.deviceNameRequired });
    expect(createUserWithPasskey).not.toHaveBeenCalled();
    // 実装完了レポート: 「端末名の検証より前に Cookie を消費する（成否にかかわらず Cookie を消すため）」
    expect(cookieStore.has(SIGNUP_CHALLENGE_COOKIE_NAME)).toBe(false);
  });

  it("verifyRegistrationResponse が throw したら verificationFailed。ユーザーは作らない", async () => {
    await startAndReadCookie();
    verifyRegistrationResponse.mockRejectedValue(new Error("bad signature"));

    const result = await finishSignupAction(regResponse, "iPhone");
    expect(result).toEqual({ ok: false, error: SIGNUP_ERRORS.verificationFailed });
    expect(createUserWithPasskey).not.toHaveBeenCalled();
  });

  it("verified:false ならverificationFailed。ユーザーは作らない", async () => {
    await startAndReadCookie();
    verifyRegistrationResponse.mockResolvedValue({ verified: false });

    const result = await finishSignupAction(regResponse, "iPhone");
    expect(result).toEqual({ ok: false, error: SIGNUP_ERRORS.verificationFailed });
    expect(createUserWithPasskey).not.toHaveBeenCalled();
  });

  it("資格情報の重複（createUserWithPasskey が ok:false, reason:duplicate）は duplicate を返し、セッションは発行しない", async () => {
    await startAndReadCookie();
    createUserWithPasskey.mockResolvedValue({ ok: false, reason: "duplicate" });

    const result = await finishSignupAction(regResponse, "iPhone");
    expect(result).toEqual({ ok: false, error: SIGNUP_ERRORS.duplicate });
    expect(createSession).not.toHaveBeenCalled();
  });

  it("createUserWithPasskey が例外を投げたら unavailable。セッションは発行しない", async () => {
    await startAndReadCookie();
    createUserWithPasskey.mockRejectedValue(new Error("db unavailable"));

    const result = await finishSignupAction(regResponse, "iPhone");
    expect(result).toEqual({ ok: false, error: SIGNUP_ERRORS.unavailable });
    expect(createSession).not.toHaveBeenCalled();
  });

  it("ユーザー作成後にセッション発行が失敗しても unavailable を返す（ユーザー自体は作られている）", async () => {
    await startAndReadCookie();
    createSession.mockRejectedValueOnce(new Error("cookie store failure"));

    const result = await finishSignupAction(regResponse, "iPhone");
    expect(result).toEqual({ ok: false, error: SIGNUP_ERRORS.unavailable });
    expect(createUserWithPasskey).toHaveBeenCalledTimes(1);
  });
});

describe("finishSignupAction — レート制限（観点4: 開始と完了の両方で確認する）", () => {
  it("完了時にもレート制限を確認する。開始時は通っても完了時に埋まっていれば rateLimited", async () => {
    await startAndReadCookie(); // 開始時は空いていた
    isSignupRateLimited.mockResolvedValue(true); // 完了までの間に埋まった

    const result = await finishSignupAction(regResponse, "iPhone");
    expect(result).toEqual({ ok: false, error: SIGNUP_ERRORS.rateLimited });
    expect(verifyRegistrationResponse).not.toHaveBeenCalled();
    expect(createUserWithPasskey).not.toHaveBeenCalled();
  });

  it("開始・完了それぞれで1回ずつ isSignupRateLimited を呼ぶ（合計2回）", async () => {
    await startAndReadCookie();
    await finishSignupAction(regResponse, "iPhone");
    expect(isSignupRateLimited).toHaveBeenCalledTimes(2);
  });

  it("レート制限中でもチャレンジ Cookie は既に消費されている（単回性が優先される）", async () => {
    await startAndReadCookie();
    isSignupRateLimited.mockResolvedValue(true);
    await finishSignupAction(regResponse, "iPhone");
    expect(cookieStore.has(SIGNUP_CHALLENGE_COOKIE_NAME)).toBe(false);
  });
});
