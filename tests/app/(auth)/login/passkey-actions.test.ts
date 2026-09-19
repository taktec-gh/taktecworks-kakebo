// @vitest-environment node
//
// src/app/(auth)/login/passkey-actions.ts（パスキーでのログイン）を検証する。
// @simplewebauthn/server は本物の署名を作らずモックする方針
// （docs/steps/step-7.md「tester への引き継ぎ > 4. WebAuthn の応答をどうモックするか」）。
// チャレンジ JWT（src/lib/passkey.ts の createChallengeToken/verifyChallengeToken）は本物を使う。
//
// 期待値の根拠:
// - docs/steps/step-7.md「ログインの処理順」（パスキーもレート制限の対象。ただし必須化は掛けない）
// - docs/steps/step-7.md「特に壊れやすい箇所」（チャレンジの単回性・取り違え・counter・RP不一致・
//   認証時に allowCredentials を返さない）
// - docs/steps/step-7.md「tester への引き継ぎ > 3. 判断した点」3.（start は失敗として記録しない）
// - docs/steps/step-7.md「tester への引き継ぎ > 5. 失敗パスの再現方法」

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createSessionToken, LOGIN_ERROR_MESSAGE } from "@/lib/auth";
import { createChallengeToken } from "@/lib/passkey";
import type { UserId } from "@/lib/user-id";

const SECRET = "test-auth-secret-0123456789abcdef";
const RP_ID = "localhost";
const RP_ORIGIN = "http://localhost:3123";
const CREDENTIAL_OWNER_ID = "user_owner" as UserId;
// 旧文言を直書きしない。定数 LOGIN_ERROR_MESSAGE を参照する
// （docs/steps/pub-1.md「実装完了後の引き継ぎ」で採用が決まった新しい文言）
const LOGIN_ERROR_MESSAGE_EXPECTED = LOGIN_ERROR_MESSAGE;

// ---- @simplewebauthn/server のモック ----
const generateAuthenticationOptions = vi.fn(async (opts: unknown) => {
  void opts;
  return {
    challenge: "CHALLENGE",
    timeout: 60_000,
    rpId: RP_ID,
    userVerification: "required",
  };
});
type AuthenticationVerification = Awaited<
  ReturnType<typeof import("@simplewebauthn/server").verifyAuthenticationResponse>
>;
const verifyAuthenticationResponse = vi.fn(
  async (_opts: unknown): Promise<AuthenticationVerification> => ({
    verified: true,
    authenticationInfo: {
      credentialID: "cred-1",
      newCounter: 3,
      userVerified: true,
      credentialDeviceType: "multiDevice" as const,
      credentialBackedUp: true,
      origin: RP_ORIGIN,
      rpID: RP_ID,
    },
  }),
);

vi.mock("@simplewebauthn/server", () => ({
  generateAuthenticationOptions: (opts: unknown) => generateAuthenticationOptions(opts),
  verifyAuthenticationResponse: (opts: unknown) => verifyAuthenticationResponse(opts),
}));

// ---- next/headers（Cookie ストア + ヘッダ）のモック ----
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

// ---- Prisma のモック ----
const credentialFindUnique = vi.fn();
const credentialUpdate = vi.fn();
const loginAttemptCount = vi.fn();
const loginAttemptCreate = vi.fn();

vi.mock("@/lib/prisma", () => ({
  prisma: {
    credential: {
      findUnique: (...args: unknown[]) => credentialFindUnique(...args),
      update: (...args: unknown[]) => credentialUpdate(...args),
    },
    loginAttempt: {
      count: (...args: unknown[]) => loginAttemptCount(...args),
      create: (...args: unknown[]) => loginAttemptCreate(...args),
    },
  },
}));

// ---- セッション発行のモック ----
const createSession = vi.fn(async (..._args: unknown[]) => {});
vi.mock("@/lib/session", () => ({ createSession: (...args: unknown[]) => createSession(...args) }));

const { startPasskeyLoginAction, verifyPasskeyLoginAction } = await import(
  "@/app/(auth)/login/passkey-actions"
);

// 資格情報の持ち主の webauthnUserId（設計判断 4）。応答の userHandle と照合される
const OWNER_WEBAUTHN_USER_ID = "owner-webauthn-user-id-1";

function makeCredential(
  overrides: Partial<{
    credentialId: string;
    publicKey: Uint8Array;
    counter: bigint;
    transports: string[];
    userId: string;
    webauthnUserId: string;
  }> = {},
) {
  const { webauthnUserId, ...rest } = overrides;
  return {
    id: "cred_1",
    userId: CREDENTIAL_OWNER_ID,
    credentialId: "cred-1",
    publicKey: new Uint8Array([1, 2, 3]),
    counter: BigInt(0),
    transports: ["internal"],
    deviceName: "iPhone",
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    updatedAt: new Date("2026-08-01T00:00:00.000Z"),
    lastUsedAt: null,
    user: { webauthnUserId: webauthnUserId ?? OWNER_WEBAUTHN_USER_ID },
    ...rest,
  };
}

// userHandle は資格情報の持ち主（OWNER_WEBAUTHN_USER_ID）と一致させておく。
// 既定では一致し、user handle の不一致だけを検証するテストで個別に上書きする
const authResponse = {
  id: "cred-1",
  rawId: "cred-1",
  type: "public-key" as const,
  clientExtensionResults: {},
  response: {
    clientDataJSON: "e30",
    authenticatorData: "e30",
    signature: "e30",
    userHandle: OWNER_WEBAUTHN_USER_ID,
  },
};

beforeEach(() => {
  cookieStore.clear();
  forwardedFor = "203.0.113.9";
  generateAuthenticationOptions.mockClear();
  verifyAuthenticationResponse.mockReset();
  verifyAuthenticationResponse.mockResolvedValue({
    verified: true,
    authenticationInfo: {
      credentialID: "cred-1",
      newCounter: 3,
      userVerified: true,
      credentialDeviceType: "multiDevice" as const,
      credentialBackedUp: true,
      origin: RP_ORIGIN,
      rpID: RP_ID,
    },
  });
  credentialFindUnique.mockReset();
  credentialFindUnique.mockResolvedValue(makeCredential());
  credentialUpdate.mockReset();
  credentialUpdate.mockResolvedValue({});
  loginAttemptCount.mockReset();
  loginAttemptCount.mockResolvedValue(0); // ブロックされていない
  loginAttemptCreate.mockReset();
  loginAttemptCreate.mockResolvedValue({});
  createSession.mockClear();

  vi.stubEnv("AUTH_SECRET", SECRET);
  vi.stubEnv("RP_ID", RP_ID);
  vi.stubEnv("RP_ORIGIN", RP_ORIGIN);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("startPasskeyLoginAction", () => {
  it("成功時はオプションを返し、チャレンジ Cookie を発行する", async () => {
    const result = await startPasskeyLoginAction();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.options.challenge).toBe("CHALLENGE");
    }
    expect(cookieStore.has("kakeibo_passkey_auth")).toBe(true);
  });

  it("認証時に allowCredentials/excludeCredentials を渡さない（情報を晒さない）", async () => {
    await startPasskeyLoginAction();
    expect(generateAuthenticationOptions).toHaveBeenCalledWith({
      rpID: RP_ID,
      userVerification: "required",
    });
    const [calledWith] = generateAuthenticationOptions.mock.calls[0];
    expect(calledWith).not.toHaveProperty("allowCredentials");
  });

  it("ブロック中は LOGIN_ERROR_MESSAGE を返し、チャレンジを発行しない", async () => {
    loginAttemptCount.mockResolvedValue(10);
    const result = await startPasskeyLoginAction();
    expect(result).toEqual({ ok: false, error: LOGIN_ERROR_MESSAGE_EXPECTED });
    expect(cookieStore.has("kakeibo_passkey_auth")).toBe(false);
  });

  it("ブロック中でも startPasskeyLoginAction は失敗として記録しない（オプション生成だけのため）", async () => {
    loginAttemptCount.mockResolvedValue(10);
    await startPasskeyLoginAction();
    expect(loginAttemptCreate).not.toHaveBeenCalled();
  });

  it("成功時も失敗として記録しない", async () => {
    await startPasskeyLoginAction();
    expect(loginAttemptCreate).not.toHaveBeenCalled();
  });

  it("RP_ID/RP_ORIGIN 未設定なら LOGIN_ERROR_MESSAGE（理由を晒さない）", async () => {
    vi.stubEnv("RP_ID", "");
    const result = await startPasskeyLoginAction();
    expect(result).toEqual({ ok: false, error: LOGIN_ERROR_MESSAGE_EXPECTED });
  });
});

describe("verifyPasskeyLoginAction — 正常系", () => {
  it("正しい応答で成功し、セッションを発行して counter を更新する", async () => {
    const token = await createChallengeToken("CHALLENGE", "authenticate", SECRET);
    cookieStore.set("kakeibo_passkey_auth", { name: "kakeibo_passkey_auth", value: token });

    const result = await verifyPasskeyLoginAction(authResponse);

    expect(result).toEqual({ ok: true });
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(credentialUpdate).toHaveBeenCalledWith({
      where: { credentialId: "cred-1" },
      data: { counter: BigInt(3), lastUsedAt: expect.any(Date) },
    });
    expect(loginAttemptCreate).toHaveBeenCalledWith({
      data: { ipHash: expect.any(String), succeeded: true },
    });
  });

  it("セッションは、検証した資格情報の持ち主（Credential.userId）に対して発行する。利用者IDはリクエストから受け取らない", async () => {
    // 「Aの資格情報IDで認証したのに、Bのセッションが発行される」ような取り違えが無いことを、
    // 資格情報の持ち主を変えて確認する（docs/steps/pub-1.md「パスキー」の観点）。
    const specificOwner = "user_specific_owner" as UserId;
    credentialFindUnique.mockResolvedValue(makeCredential({ userId: specificOwner }));
    const token = await createChallengeToken("CHALLENGE", "authenticate", SECRET);
    cookieStore.set("kakeibo_passkey_auth", { name: "kakeibo_passkey_auth", value: token });

    await verifyPasskeyLoginAction(authResponse);

    expect(createSession).toHaveBeenCalledWith(specificOwner);
  });

  it("verifyAuthenticationResponse には検証に必要な資格情報（保存済みcounter含む）を渡す", async () => {
    credentialFindUnique.mockResolvedValue(makeCredential({ counter: BigInt(2) }));
    const token = await createChallengeToken("CHALLENGE", "authenticate", SECRET);
    cookieStore.set("kakeibo_passkey_auth", { name: "kakeibo_passkey_auth", value: token });

    await verifyPasskeyLoginAction(authResponse);

    expect(verifyAuthenticationResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        response: authResponse,
        expectedChallenge: "CHALLENGE",
        expectedOrigin: RP_ORIGIN,
        expectedRPID: RP_ID,
        credential: expect.objectContaining({ id: "cred-1", counter: 2 }),
      }),
    );
  });

  it("counter が保存値も新値も0なら許容する（0を返し続ける認証器）", async () => {
    credentialFindUnique.mockResolvedValue(makeCredential({ counter: BigInt(0) }));
    verifyAuthenticationResponse.mockResolvedValue({
      verified: true,
      authenticationInfo: {
        credentialID: "cred-1",
        newCounter: 0,
        userVerified: true,
        credentialDeviceType: "multiDevice" as const,
        credentialBackedUp: true,
        origin: RP_ORIGIN,
        rpID: RP_ID,
      },
    });
    const token = await createChallengeToken("CHALLENGE", "authenticate", SECRET);
    cookieStore.set("kakeibo_passkey_auth", { name: "kakeibo_passkey_auth", value: token });

    const result = await verifyPasskeyLoginAction(authResponse);

    expect(result).toEqual({ ok: true });
    expect(credentialUpdate).toHaveBeenCalledWith({
      where: { credentialId: "cred-1" },
      data: { counter: BigInt(0), lastUsedAt: expect.any(Date) },
    });
  });
});

describe("verifyPasskeyLoginAction — チャレンジの単回性・取り違え", () => {
  it("チャレンジ Cookie が無ければ失敗し、記録する", async () => {
    const result = await verifyPasskeyLoginAction(authResponse);
    expect(result).toEqual({ ok: false, error: LOGIN_ERROR_MESSAGE_EXPECTED });
    expect(loginAttemptCreate).toHaveBeenCalledWith({
      data: { ipHash: expect.any(String), succeeded: false },
    });
    expect(createSession).not.toHaveBeenCalled();
  });

  it("同じチャレンジは2回使えない（単回性）", async () => {
    const token = await createChallengeToken("CHALLENGE", "authenticate", SECRET);
    cookieStore.set("kakeibo_passkey_auth", { name: "kakeibo_passkey_auth", value: token });

    const first = await verifyPasskeyLoginAction(authResponse);
    expect(first).toEqual({ ok: true });

    // Cookie は1回目の検証で消えているので、2回目は使えない
    const second = await verifyPasskeyLoginAction(authResponse);
    expect(second).toEqual({ ok: false, error: LOGIN_ERROR_MESSAGE_EXPECTED });
  });

  it("期限切れ（2分超）のチャレンジは拒否する", async () => {
    const issuedAt = new Date("2026-08-14T00:00:00.000Z");
    const token = await createChallengeToken("CHALLENGE", "authenticate", SECRET, {
      now: issuedAt,
    });
    cookieStore.set("kakeibo_passkey_auth", { name: "kakeibo_passkey_auth", value: token });

    vi.useFakeTimers();
    vi.setSystemTime(new Date(issuedAt.getTime() + 121_000));
    try {
      const result = await verifyPasskeyLoginAction(authResponse);
      expect(result).toEqual({ ok: false, error: LOGIN_ERROR_MESSAGE_EXPECTED });
    } finally {
      vi.useRealTimers();
    }
  });

  it("登録用チャレンジを認証で使おうとすると拒否する（sub 違い）", async () => {
    const token = await createChallengeToken("CHALLENGE", "register", SECRET);
    cookieStore.set("kakeibo_passkey_auth", { name: "kakeibo_passkey_auth", value: token });

    const result = await verifyPasskeyLoginAction(authResponse);
    expect(result).toEqual({ ok: false, error: LOGIN_ERROR_MESSAGE_EXPECTED });
    expect(verifyAuthenticationResponse).not.toHaveBeenCalled();
  });

  it("セッション JWT をチャレンジとして渡すと拒否する（typ ヘッダが無く、sub もユーザーID）", async () => {
    const sessionToken = await createSessionToken(SECRET, CREDENTIAL_OWNER_ID);
    cookieStore.set("kakeibo_passkey_auth", { name: "kakeibo_passkey_auth", value: sessionToken });

    const result = await verifyPasskeyLoginAction(authResponse);
    expect(result).toEqual({ ok: false, error: LOGIN_ERROR_MESSAGE_EXPECTED });
    expect(createSession).not.toHaveBeenCalled();
  });
});

describe("verifyPasskeyLoginAction — レート制限", () => {
  it("ブロック中はチャレンジを見ずに失敗し、記録する", async () => {
    loginAttemptCount.mockResolvedValue(10);
    const token = await createChallengeToken("CHALLENGE", "authenticate", SECRET);
    cookieStore.set("kakeibo_passkey_auth", { name: "kakeibo_passkey_auth", value: token });

    const result = await verifyPasskeyLoginAction(authResponse);

    expect(result).toEqual({ ok: false, error: LOGIN_ERROR_MESSAGE_EXPECTED });
    expect(verifyAuthenticationResponse).not.toHaveBeenCalled();
    expect(loginAttemptCreate).toHaveBeenCalledWith({
      data: { ipHash: expect.any(String), succeeded: false },
    });
    // ブロック中でもチャレンジ Cookie は残っている（消費していない）
    expect(cookieStore.has("kakeibo_passkey_auth")).toBe(true);
  });
});

describe("verifyPasskeyLoginAction — 未登録・検証失敗・counter", () => {
  it("資格情報が見つからなければ失敗し、検証関数は呼ばない", async () => {
    credentialFindUnique.mockResolvedValue(null);
    const token = await createChallengeToken("CHALLENGE", "authenticate", SECRET);
    cookieStore.set("kakeibo_passkey_auth", { name: "kakeibo_passkey_auth", value: token });

    const result = await verifyPasskeyLoginAction(authResponse);

    expect(result).toEqual({ ok: false, error: LOGIN_ERROR_MESSAGE_EXPECTED });
    expect(verifyAuthenticationResponse).not.toHaveBeenCalled();
  });

  it("RP オリジン不一致など verifyAuthenticationResponse が throw したら失敗として記録する", async () => {
    verifyAuthenticationResponse.mockRejectedValue(new Error("origin mismatch"));
    const token = await createChallengeToken("CHALLENGE", "authenticate", SECRET);
    cookieStore.set("kakeibo_passkey_auth", { name: "kakeibo_passkey_auth", value: token });

    const result = await verifyPasskeyLoginAction(authResponse);

    expect(result).toEqual({ ok: false, error: LOGIN_ERROR_MESSAGE_EXPECTED });
    expect(credentialUpdate).not.toHaveBeenCalled();
    expect(loginAttemptCreate).toHaveBeenCalledWith({
      data: { ipHash: expect.any(String), succeeded: false },
    });
  });

  it("verified:false のときは失敗として扱う", async () => {
    verifyAuthenticationResponse.mockResolvedValue({
      verified: false,
      authenticationInfo: {
        credentialID: "cred-1",
        newCounter: 1,
        userVerified: false,
        credentialDeviceType: "multiDevice" as const,
        credentialBackedUp: true,
        origin: RP_ORIGIN,
        rpID: RP_ID,
      },
    });
    const token = await createChallengeToken("CHALLENGE", "authenticate", SECRET);
    cookieStore.set("kakeibo_passkey_auth", { name: "kakeibo_passkey_auth", value: token });

    const result = await verifyPasskeyLoginAction(authResponse);
    expect(result).toEqual({ ok: false, error: LOGIN_ERROR_MESSAGE_EXPECTED });
    expect(credentialUpdate).not.toHaveBeenCalled();
  });

  it("counter が巻き戻っていれば拒否し、counter を更新しない", async () => {
    credentialFindUnique.mockResolvedValue(makeCredential({ counter: BigInt(5) }));
    verifyAuthenticationResponse.mockResolvedValue({
      verified: true,
      authenticationInfo: {
        credentialID: "cred-1",
        newCounter: 3,
        userVerified: true,
        credentialDeviceType: "multiDevice" as const,
        credentialBackedUp: true,
        origin: RP_ORIGIN,
        rpID: RP_ID,
      },
    });
    const token = await createChallengeToken("CHALLENGE", "authenticate", SECRET);
    cookieStore.set("kakeibo_passkey_auth", { name: "kakeibo_passkey_auth", value: token });

    const result = await verifyPasskeyLoginAction(authResponse);

    expect(result).toEqual({ ok: false, error: LOGIN_ERROR_MESSAGE_EXPECTED });
    expect(credentialUpdate).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
    expect(loginAttemptCreate).toHaveBeenCalledWith({
      data: { ipHash: expect.any(String), succeeded: false },
    });
  });
});

describe("verifyPasskeyLoginAction — user handle の照合（docs/steps/pub-2.md 設計判断 4）", () => {
  it("応答の userHandle が資格情報の持ち主の webauthnUserId と一致すれば成功する", async () => {
    const token = await createChallengeToken("CHALLENGE", "authenticate", SECRET);
    cookieStore.set("kakeibo_passkey_auth", { name: "kakeibo_passkey_auth", value: token });

    const result = await verifyPasskeyLoginAction(authResponse);

    expect(result).toEqual({ ok: true });
  });

  it("userHandle が別人の webauthnUserId（他人の資格情報に自分の user handle を付けた応答）なら失敗し、署名検証は行わない", async () => {
    credentialFindUnique.mockResolvedValue(
      makeCredential({ webauthnUserId: OWNER_WEBAUTHN_USER_ID }),
    );
    const token = await createChallengeToken("CHALLENGE", "authenticate", SECRET);
    cookieStore.set("kakeibo_passkey_auth", { name: "kakeibo_passkey_auth", value: token });

    const tamperedResponse = {
      ...authResponse,
      response: { ...authResponse.response, userHandle: "someone-elses-webauthn-user-id" },
    };
    const result = await verifyPasskeyLoginAction(tamperedResponse);

    expect(result).toEqual({ ok: false, error: LOGIN_ERROR_MESSAGE_EXPECTED });
    expect(verifyAuthenticationResponse).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
    expect(loginAttemptCreate).toHaveBeenCalledWith({
      data: { ipHash: expect.any(String), succeeded: false },
    });
  });

  it("userHandle が無い応答（discoverable credential のはずが欠落）なら失敗する", async () => {
    const token = await createChallengeToken("CHALLENGE", "authenticate", SECRET);
    cookieStore.set("kakeibo_passkey_auth", { name: "kakeibo_passkey_auth", value: token });

    const withoutUserHandle = {
      ...authResponse,
      response: { clientDataJSON: "e30", authenticatorData: "e30", signature: "e30" },
    };
    const result = await verifyPasskeyLoginAction(withoutUserHandle);

    expect(result).toEqual({ ok: false, error: LOGIN_ERROR_MESSAGE_EXPECTED });
    expect(verifyAuthenticationResponse).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
  });

  it("userHandle が空文字なら失敗する", async () => {
    const token = await createChallengeToken("CHALLENGE", "authenticate", SECRET);
    cookieStore.set("kakeibo_passkey_auth", { name: "kakeibo_passkey_auth", value: token });

    const emptyUserHandle = {
      ...authResponse,
      response: { ...authResponse.response, userHandle: "" },
    };
    const result = await verifyPasskeyLoginAction(emptyUserHandle);

    expect(result).toEqual({ ok: false, error: LOGIN_ERROR_MESSAGE_EXPECTED });
    expect(verifyAuthenticationResponse).not.toHaveBeenCalled();
  });
});

describe("verifyPasskeyLoginAction — fail closed", () => {
  it("AUTH_SECRET が読めず IP ハッシュ化に失敗した場合は失敗を返し、記録もセッション発行もしない", async () => {
    vi.stubEnv("AUTH_SECRET", "");
    const result = await verifyPasskeyLoginAction(authResponse);
    expect(result).toEqual({ ok: false, error: LOGIN_ERROR_MESSAGE_EXPECTED });
    expect(createSession).not.toHaveBeenCalled();
    expect(loginAttemptCreate).not.toHaveBeenCalled();
  });
});
