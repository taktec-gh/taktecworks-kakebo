// @vitest-environment node
//
// src/app/(auth)/recovery/actions.ts（verifyRecoveryCodeAction / startRecoveryPasskeyRegistrationAction /
// finishRecoveryPasskeyRegistrationAction）を検証する。
//
// tests/app/(auth)/signup/actions.test.ts と同じ方針:
// - @simplewebauthn/server は本物の署名を作らずモックする
// - next/headers はメモリ上の Cookie ストアを差し替え、チャレンジ・リカバリー用トークンの
//   Cookie の発行・検証は本物（src/lib/passkey.ts・passkey-session.ts・auth.ts・recovery-session.ts）を使う。
//   そうすることで「チャレンジの単回性・取り違え」「リカバリー用トークンの単回性・消費のタイミング」を
//   モックの呼び出し形だけでなく実際の Cookie の状態で確認できる
// - データ層（findRecoveryUserIdByCodeHash・completeRecoveryWithPasskey・findWebauthnUserId・
//   listCredentials）と、レート制限（login-attempts）・IP ハッシュ（client-ip）は高レベルにモックする
//   （それぞれの内部の正しさは tests/lib/recovery-codes.test.ts・tests/lib/login-attempts.test.ts・
//   tests/lib/client-ip.test.ts で検証済み）
//
// 期待値の根拠:
// - docs/steps/pub-5.md 設計判断 4「コードの消費はパスキーの登録が済んだときに行う」
//   「入力の時点では照合だけを行い、新しいパスキーの登録と同じトランザクションでコードを差し替える」
// - docs/steps/pub-5.md 設計判断 5「リカバリー用トークンは通常のセッションとは別物にする」
//   「逆に、リカバリーの Server Action は通常のセッションを受け付けない」
// - docs/steps/pub-5.md 設計判断 6「レート制限」「制限にかかったときも、文言はコードの失敗と同じにする」
// - docs/steps/pub-5.md「実装完了後の引き継ぎ」の「処理の要点」
//   「verifyRecoveryCodeAction: IP ハッシュ → isBlocked（制限中は失敗を記録して弾く）→ 正規化 →
//   ハッシュ → 探索 → 成功を記録 → setRecoveryCookie → redirect("/recovery/passkey")。
//   失敗はすべて RECOVERY_ERRORS.invalidCode（IP・DB の例外を含む）。コードは消費しない」
//   「finishRecoveryPasskeyRegistrationAction: チャレンジ消費 → トークン（無ければ sessionExpired）→
//   … → verifyRegistrationResponse → issueRecoveryCode → completeRecoveryWithPasskey。
//   duplicate はトークンを残す、codeNotCurrent はトークンを消して invalidCode。
//   成功で clearRecoveryCookie() → createSession(トークンの userId) → { ok: true, recoveryCode }」
// - docs/steps/pub-5.md「tester 向けの方針」1・2・5・8

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RECOVERY_CHALLENGE_COOKIE_NAME } from "@/lib/passkey";
import {
  RECOVERY_CODE_FIELD_NAME,
  RECOVERY_ERRORS,
  RECOVERY_PASSKEY_PATH,
} from "@/lib/recovery-messages";

import type { UserId } from "@/lib/user-id";
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
    user: {
      id: Buffer.from(userID).toString("base64url"),
      name: "家計簿 #TEST",
      displayName: "家計簿 #TEST",
    },
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
      credential: { id: "cred-new-1", publicKey: new Uint8Array([1, 2, 3]), counter: 0 },
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

// ---- next/headers（Cookie ストア + ヘッダ）のモック。本物のチャレンジ・リカバリー用トークンの署名・検証を使う ----
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

// ---- next/navigation の redirect（login/actions.test.ts と同じ方針。URL を含めて検証できるようにする） ----
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

// ---- レート制限のモック ----
const isBlocked = vi.fn(async (..._args: unknown[]) => false);
const recordLoginAttempt = vi.fn(async (..._args: unknown[]) => {});
vi.mock("@/lib/login-attempts", () => ({
  isBlocked: (...args: unknown[]) => isBlocked(...args),
  recordLoginAttempt: (...args: unknown[]) => recordLoginAttempt(...args),
}));

// ---- IP ハッシュのモック ----
const getClientIpHash = vi.fn(async () => "iphash-test");
vi.mock("@/lib/client-ip", () => ({ getClientIpHash: () => getClientIpHash() }));

// ---- リカバリーコードのデータ層のモック ----
const findRecoveryUserIdByCodeHash = vi.fn();
const completeRecoveryWithPasskey = vi.fn();
vi.mock("@/lib/recovery-codes", () => ({
  findRecoveryUserIdByCodeHash: (...args: unknown[]) => findRecoveryUserIdByCodeHash(...args),
  completeRecoveryWithPasskey: (...args: unknown[]) => completeRecoveryWithPasskey(...args),
}));

// ---- 利用者・資格情報一覧のモック ----
const findWebauthnUserId = vi.fn();
vi.mock("@/lib/users", () => ({
  findWebauthnUserId: (...args: unknown[]) => findWebauthnUserId(...args),
}));

const listCredentials = vi.fn();
vi.mock("@/lib/credentials", () => ({
  listCredentials: (...args: unknown[]) => listCredentials(...args),
}));

// ---- セッション発行のモック ----
const createSession = vi.fn(async (..._args: unknown[]) => {});
vi.mock("@/lib/session", () => ({ createSession: (...args: unknown[]) => createSession(...args) }));

const {
  verifyRecoveryCodeAction,
  startRecoveryPasskeyRegistrationAction,
  finishRecoveryPasskeyRegistrationAction,
} = await import("@/app/(auth)/recovery/actions");

const VALID_CODE = "K7Q2M9XP4HTR8WNB3D6F"; // 20文字・RECOVERY_CODE_ALPHABET のみ
const OWNER_USER_ID = "user_owner_1";
const OWNER_WEBAUTHN_USER_ID = "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA";

function formDataWithCode(code: string): FormData {
  const fd = new FormData();
  fd.set(RECOVERY_CODE_FIELD_NAME, code);
  return fd;
}

const regResponse: RegistrationResponseJSON = {
  id: "cred-new-1",
  rawId: "cred-new-1",
  type: "public-key",
  clientExtensionResults: {},
  response: {
    clientDataJSON: "e30",
    attestationObject: "e30",
    transports: ["internal", "hybrid"],
  },
};

/** verifyRecoveryCodeAction を成功させ、Cookie にリカバリー用トークンを載せた状態にする */
async function completeCodeVerification(): Promise<void> {
  findRecoveryUserIdByCodeHash.mockResolvedValue(OWNER_USER_ID);
  await expect(
    verifyRecoveryCodeAction({ error: null }, formDataWithCode(VALID_CODE)),
  ).rejects.toThrow("NEXT_REDIRECT");
}

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
      credential: { id: "cred-new-1", publicKey: new Uint8Array([1, 2, 3]), counter: 0 },
      credentialType: "public-key" as const,
      attestationObject: new Uint8Array(),
      userVerified: true,
      credentialDeviceType: "multiDevice" as const,
      credentialBackedUp: true,
      origin: RP_ORIGIN,
      rpID: RP_ID,
    },
  });

  isBlocked.mockReset();
  isBlocked.mockResolvedValue(false);
  recordLoginAttempt.mockReset();
  recordLoginAttempt.mockResolvedValue(undefined);

  getClientIpHash.mockReset();
  getClientIpHash.mockResolvedValue("iphash-test");

  findRecoveryUserIdByCodeHash.mockReset();
  completeRecoveryWithPasskey.mockReset();
  completeRecoveryWithPasskey.mockResolvedValue({ ok: true });

  findWebauthnUserId.mockReset();
  findWebauthnUserId.mockResolvedValue(OWNER_WEBAUTHN_USER_ID);
  listCredentials.mockReset();
  listCredentials.mockResolvedValue([]);

  createSession.mockClear();
  redirectSpy.mockClear();

  vi.stubEnv("AUTH_SECRET", SECRET);
  vi.stubEnv("RP_ID", RP_ID);
  vi.stubEnv("RP_ORIGIN", RP_ORIGIN);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("verifyRecoveryCodeAction — 正常系", () => {
  it("正規化したコードのハッシュで findRecoveryUserIdByCodeHash を呼び、見つかれば RECOVERY_PASSKEY_PATH へ redirect する", async () => {
    findRecoveryUserIdByCodeHash.mockResolvedValue(OWNER_USER_ID);
    const { hashRecoveryCode } = await import("@/lib/recovery-code");
    const expectedHash = hashRecoveryCode(VALID_CODE);

    await expect(
      verifyRecoveryCodeAction({ error: null }, formDataWithCode(VALID_CODE)),
    ).rejects.toThrow("NEXT_REDIRECT;" + RECOVERY_PASSKEY_PATH);

    expect(findRecoveryUserIdByCodeHash).toHaveBeenCalledWith(expect.anything(), expectedHash);
  });

  it("区切り・空白・小文字を含む入力でも、正規化した同じハッシュで探す（正規化。tester 向けの方針 4）", async () => {
    findRecoveryUserIdByCodeHash.mockResolvedValue(OWNER_USER_ID);
    const { hashRecoveryCode } = await import("@/lib/recovery-code");
    const canonicalHash = hashRecoveryCode(VALID_CODE);
    const messy = "  k7q2m-9xp4h tr8wn-b3d6f  ";

    await expect(
      verifyRecoveryCodeAction({ error: null }, formDataWithCode(messy)),
    ).rejects.toThrow("NEXT_REDIRECT");

    expect(findRecoveryUserIdByCodeHash).toHaveBeenCalledWith(expect.anything(), canonicalHash);
  });

  it("成功を LoginAttempt に記録する（true）", async () => {
    findRecoveryUserIdByCodeHash.mockResolvedValue(OWNER_USER_ID);
    await expect(
      verifyRecoveryCodeAction({ error: null }, formDataWithCode(VALID_CODE)),
    ).rejects.toThrow("NEXT_REDIRECT");
    expect(recordLoginAttempt).toHaveBeenCalledWith(expect.anything(), "iphash-test", true);
  });

  it("見つかった利用者IDとコードのハッシュでリカバリー用トークンの Cookie を発行する。ここではコードを消費しない（completeRecoveryWithPasskey を呼ばない）", async () => {
    await completeCodeVerification();

    const { getRecoverySession } = await import("@/lib/recovery-session");
    const recovery = await getRecoverySession();
    expect(recovery?.userId).toBe(OWNER_USER_ID);

    expect(completeRecoveryWithPasskey).not.toHaveBeenCalled();
  });
});

describe("verifyRecoveryCodeAction — 失敗（文言は一律。docs/steps/pub-5.md 設計判断 4・6、tester 向けの方針 5）", () => {
  it("見つからない（間違い・使用済みの区別をしない）: invalidCode を返し、失敗を記録する", async () => {
    findRecoveryUserIdByCodeHash.mockResolvedValue(null);
    const result = await verifyRecoveryCodeAction({ error: null }, formDataWithCode(VALID_CODE));
    expect(result).toEqual({ error: RECOVERY_ERRORS.invalidCode });
    expect(recordLoginAttempt).toHaveBeenCalledWith(expect.anything(), "iphash-test", false);
  });

  it("許可されない文字を含む（正規化できない）入力: findRecoveryUserIdByCodeHash を呼ばず invalidCode、失敗を記録する", async () => {
    const result = await verifyRecoveryCodeAction(
      { error: null },
      formDataWithCode("0O1IL-つづき-not-valid-code!!"),
    );
    expect(result).toEqual({ error: RECOVERY_ERRORS.invalidCode });
    expect(findRecoveryUserIdByCodeHash).not.toHaveBeenCalled();
    expect(recordLoginAttempt).toHaveBeenCalledWith(expect.anything(), "iphash-test", false);
  });

  it("コード欄が無い・文字列でない: invalidCode", async () => {
    const result = await verifyRecoveryCodeAction({ error: null }, new FormData());
    expect(result).toEqual({ error: RECOVERY_ERRORS.invalidCode });
  });

  it("レート制限中: 照合せず invalidCode。失敗として記録し、findRecoveryUserIdByCodeHash は呼ばない", async () => {
    isBlocked.mockResolvedValue(true);
    const result = await verifyRecoveryCodeAction({ error: null }, formDataWithCode(VALID_CODE));
    expect(result).toEqual({ error: RECOVERY_ERRORS.invalidCode });
    expect(findRecoveryUserIdByCodeHash).not.toHaveBeenCalled();
    expect(recordLoginAttempt).toHaveBeenCalledWith(expect.anything(), "iphash-test", false);
  });

  it("IP ハッシュの取得に失敗: invalidCode。ガードが効かないので記録もしない（fail closed）", async () => {
    getClientIpHash.mockRejectedValue(new Error("AUTH_SECRET is not set"));
    const result = await verifyRecoveryCodeAction({ error: null }, formDataWithCode(VALID_CODE));
    expect(result).toEqual({ error: RECOVERY_ERRORS.invalidCode });
    expect(recordLoginAttempt).not.toHaveBeenCalled();
  });

  it("findRecoveryUserIdByCodeHash が例外を投げても invalidCode。失敗として記録する", async () => {
    findRecoveryUserIdByCodeHash.mockRejectedValue(new Error("db unavailable"));
    const result = await verifyRecoveryCodeAction({ error: null }, formDataWithCode(VALID_CODE));
    expect(result).toEqual({ error: RECOVERY_ERRORS.invalidCode });
    expect(recordLoginAttempt).toHaveBeenCalledWith(expect.anything(), "iphash-test", false);
  });

  it("失敗理由（間違い・不正な文字・レート制限）の文言がすべて同じ文字列", async () => {
    findRecoveryUserIdByCodeHash.mockResolvedValue(null);
    const wrongCode = await verifyRecoveryCodeAction({ error: null }, formDataWithCode(VALID_CODE));

    const badChars = await verifyRecoveryCodeAction(
      { error: null },
      formDataWithCode("!!!!!!!!!!!!!!!!!!!!"),
    );

    isBlocked.mockResolvedValue(true);
    const limited = await verifyRecoveryCodeAction({ error: null }, formDataWithCode(VALID_CODE));

    expect(wrongCode).toEqual({ error: RECOVERY_ERRORS.invalidCode });
    expect(badChars).toEqual({ error: RECOVERY_ERRORS.invalidCode });
    expect(limited).toEqual({ error: RECOVERY_ERRORS.invalidCode });
    expect(wrongCode).toEqual(badChars);
    expect(badChars).toEqual(limited);
  });

  it("失敗時はリカバリー用トークンの Cookie を発行しない", async () => {
    findRecoveryUserIdByCodeHash.mockResolvedValue(null);
    await verifyRecoveryCodeAction({ error: null }, formDataWithCode(VALID_CODE));
    const { getRecoverySession } = await import("@/lib/recovery-session");
    await expect(getRecoverySession()).resolves.toBeNull();
  });
});

describe("startRecoveryPasskeyRegistrationAction", () => {
  it("リカバリー用トークンが無ければ sessionExpired。オプションは作らない", async () => {
    const result = await startRecoveryPasskeyRegistrationAction();
    expect(result).toEqual({ ok: false, error: RECOVERY_ERRORS.sessionExpired });
    expect(generateRegistrationOptions).not.toHaveBeenCalled();
  });

  it("トークンがあれば、そのユーザーの webauthnUserId とパスキー一覧を見る（他のユーザーの値を使わない）", async () => {
    await completeCodeVerification();
    listCredentials.mockResolvedValue([
      { credentialId: "cred-a-1", transports: ["internal"] },
      { credentialId: "cred-a-2", transports: ["usb"] },
    ]);

    const result = await startRecoveryPasskeyRegistrationAction();

    expect(result.ok).toBe(true);
    expect(findWebauthnUserId).toHaveBeenCalledWith(expect.anything(), OWNER_USER_ID);
    expect(listCredentials).toHaveBeenCalledWith(expect.anything(), OWNER_USER_ID);
    expect(generateRegistrationOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        excludeCredentials: [
          { id: "cred-a-1", transports: ["internal"] },
          { id: "cred-a-2", transports: ["usb"] },
        ],
      }),
    );
  });

  it("residentKey/userVerification は required", async () => {
    await completeCodeVerification();
    await startRecoveryPasskeyRegistrationAction();
    expect(generateRegistrationOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        authenticatorSelection: { residentKey: "required", userVerification: "required" },
      }),
    );
  });

  it("webauthnUserId が見つからなければ sessionExpired", async () => {
    await completeCodeVerification();
    findWebauthnUserId.mockResolvedValue(null);

    const result = await startRecoveryPasskeyRegistrationAction();
    expect(result).toEqual({ ok: false, error: RECOVERY_ERRORS.sessionExpired });
  });

  it("RP_ID/RP_ORIGIN 未設定なら unavailable", async () => {
    await completeCodeVerification();
    vi.stubEnv("RP_ID", "");
    const result = await startRecoveryPasskeyRegistrationAction();
    expect(result).toEqual({ ok: false, error: RECOVERY_ERRORS.unavailable });
  });

  it("通常のセッションしか無い（リカバリー用トークンが無い）場合も sessionExpired（tester 向けの方針 1: 逆方向も通らない）", async () => {
    const { createSessionToken } = await import("@/lib/auth");
    const { SESSION_COOKIE_NAME } = await import("@/lib/auth");
    const sessionToken = await createSessionToken(SECRET, OWNER_USER_ID as UserId);
    cookieStore.set(SESSION_COOKIE_NAME, { name: SESSION_COOKIE_NAME, value: sessionToken });

    const result = await startRecoveryPasskeyRegistrationAction();
    expect(result).toEqual({ ok: false, error: RECOVERY_ERRORS.sessionExpired });
  });
});

describe("finishRecoveryPasskeyRegistrationAction — 正常系", () => {
  it("成功したら completeRecoveryWithPasskey を { userId, expectedCodeHash, newCodeHash, credential } で呼び、新しいコードを返す", async () => {
    await completeCodeVerification();
    await startRecoveryPasskeyRegistrationAction();

    const { hashRecoveryCode } = await import("@/lib/recovery-code");
    const result = await finishRecoveryPasskeyRegistrationAction(regResponse, "iPhone");

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(typeof result.recoveryCode).toBe("string");
    expect(result.recoveryCode.length).toBeGreaterThan(0);

    expect(completeRecoveryWithPasskey).toHaveBeenCalledTimes(1);
    const call = completeRecoveryWithPasskey.mock.calls[0][1] as {
      userId: string;
      expectedCodeHash: string;
      newCodeHash: string;
      credential: unknown;
    };
    expect(call.userId).toBe(OWNER_USER_ID);
    // トークンに入れたのは verifyRecoveryCodeAction が照合したコードのハッシュ
    expect(call.expectedCodeHash).toBe(hashRecoveryCode("K7Q2M9XP4HTR8WNB3D6F"));
    // 新しいハッシュは、戻り値の平文コードのハッシュと一致する（同じコードを画面と DB に渡している）
    expect(call.newCodeHash).toBe(hashRecoveryCode(result.recoveryCode));
    expect(call.credential).toEqual({
      credentialId: "cred-new-1",
      publicKey: new Uint8Array([1, 2, 3]),
      counter: 0,
      transports: ["internal", "hybrid"],
      deviceName: "iPhone",
    });
  });

  it("成功したら clearRecoveryCookie の後に createSession(トークンの userId) を呼ぶ（順序）", async () => {
    await completeCodeVerification();
    await startRecoveryPasskeyRegistrationAction();

    await finishRecoveryPasskeyRegistrationAction(regResponse, "iPhone");

    expect(createSession).toHaveBeenCalledTimes(1);
    expect(createSession).toHaveBeenCalledWith(OWNER_USER_ID);

    // リカバリー用トークンの Cookie は消えている
    const { getRecoverySession } = await import("@/lib/recovery-session");
    await expect(getRecoverySession()).resolves.toBeNull();
  });
});

describe("finishRecoveryPasskeyRegistrationAction — リカバリー用トークン（tester 向けの方針 1）", () => {
  it("リカバリー用トークンが無ければ sessionExpired。completeRecoveryWithPasskey は呼ばれない", async () => {
    const result = await finishRecoveryPasskeyRegistrationAction(regResponse, "iPhone");
    expect(result).toEqual({ ok: false, error: RECOVERY_ERRORS.sessionExpired });
    expect(completeRecoveryWithPasskey).not.toHaveBeenCalled();
  });

  it("通常のセッションしか無い（リカバリー用トークンが無い）場合も sessionExpired（逆方向も通らない）", async () => {
    const { createSessionToken, SESSION_COOKIE_NAME } = await import("@/lib/auth");
    const sessionToken = await createSessionToken(SECRET, OWNER_USER_ID as UserId);
    cookieStore.set(SESSION_COOKIE_NAME, { name: SESSION_COOKIE_NAME, value: sessionToken });

    const result = await finishRecoveryPasskeyRegistrationAction(regResponse, "iPhone");
    expect(result).toEqual({ ok: false, error: RECOVERY_ERRORS.sessionExpired });
    expect(createSession).not.toHaveBeenCalled();
  });
});

describe("finishRecoveryPasskeyRegistrationAction — チャレンジの単回性・取り違え（tester 向けの方針 8）", () => {
  it("チャレンジ Cookie が無ければ challengeExpired（トークンはあっても）", async () => {
    await completeCodeVerification();
    // start を呼ばずにチャレンジを発行しないまま finish する
    const result = await finishRecoveryPasskeyRegistrationAction(regResponse, "iPhone");
    expect(result).toEqual({ ok: false, error: RECOVERY_ERRORS.challengeExpired });
    expect(completeRecoveryWithPasskey).not.toHaveBeenCalled();
  });

  it("同じチャレンジは2回使えない（成功後は Cookie が消えている）", async () => {
    await completeCodeVerification();
    await startRecoveryPasskeyRegistrationAction();

    const first = await finishRecoveryPasskeyRegistrationAction(regResponse, "iPhone");
    expect(first.ok).toBe(true);

    // 2回目: リカバリー用トークンも消費済みなので sessionExpired になる。
    // チャレンジ単体の再利用不可を見るため、ここではトークンを再発行してからチャレンジだけ使い回す
    await completeCodeVerification();
    const second = await finishRecoveryPasskeyRegistrationAction(regResponse, "iPhone");
    expect(second).toEqual({ ok: false, error: RECOVERY_ERRORS.challengeExpired });
  });

  it("設定画面の登録用チャレンジ（sub=passkey-register）をリカバリーの Cookie 名に入れても challengeExpired（変異#10）", async () => {
    await completeCodeVerification();
    const { createChallengeToken } = await import("@/lib/passkey");
    const token = await createChallengeToken("CHALLENGE", "register", SECRET);
    cookieStore.set(RECOVERY_CHALLENGE_COOKIE_NAME, {
      name: RECOVERY_CHALLENGE_COOKIE_NAME,
      value: token,
    });

    const result = await finishRecoveryPasskeyRegistrationAction(regResponse, "iPhone");
    expect(result).toEqual({ ok: false, error: RECOVERY_ERRORS.challengeExpired });
    expect(verifyRegistrationResponse).not.toHaveBeenCalled();
  });

  it("ログイン用チャレンジ（sub=passkey-auth）をリカバリーの Cookie 名に入れても challengeExpired", async () => {
    await completeCodeVerification();
    const { createChallengeToken } = await import("@/lib/passkey");
    const token = await createChallengeToken("CHALLENGE", "authenticate", SECRET);
    cookieStore.set(RECOVERY_CHALLENGE_COOKIE_NAME, {
      name: RECOVERY_CHALLENGE_COOKIE_NAME,
      value: token,
    });

    const result = await finishRecoveryPasskeyRegistrationAction(regResponse, "iPhone");
    expect(result).toEqual({ ok: false, error: RECOVERY_ERRORS.challengeExpired });
    expect(verifyRegistrationResponse).not.toHaveBeenCalled();
  });

  it("サインアップ用チャレンジをリカバリーの Cookie 名に入れても challengeExpired", async () => {
    await completeCodeVerification();
    const { createSignupChallengeToken } = await import("@/lib/passkey");
    const token = await createSignupChallengeToken(
      "CHALLENGE",
      "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA",
      SECRET,
    );
    cookieStore.set(RECOVERY_CHALLENGE_COOKIE_NAME, {
      name: RECOVERY_CHALLENGE_COOKIE_NAME,
      value: token,
    });

    const result = await finishRecoveryPasskeyRegistrationAction(regResponse, "iPhone");
    expect(result).toEqual({ ok: false, error: RECOVERY_ERRORS.challengeExpired });
  });

  it("期限切れ（2分超）のチャレンジは challengeExpired", async () => {
    const issuedAt = new Date("2026-08-14T00:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(issuedAt);
    try {
      // リカバリー用トークン（10分）もチャレンジ（2分）も同じ固定時刻のもとで発行する
      // （実時計とフェイクタイマーを混ぜると、リカバリー用トークンの exp との関係が
      // テストの実行タイミングに依存してしまうため）
      await completeCodeVerification();
      await startRecoveryPasskeyRegistrationAction();
      vi.setSystemTime(new Date(issuedAt.getTime() + 121_000));
      const result = await finishRecoveryPasskeyRegistrationAction(regResponse, "iPhone");
      expect(result).toEqual({ ok: false, error: RECOVERY_ERRORS.challengeExpired });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("finishRecoveryPasskeyRegistrationAction — コードの消費（tester 向けの方針 2）", () => {
  it("completeRecoveryWithPasskey が codeNotCurrent（先に使われた・作り直された）なら invalidCode を返し、リカバリー用トークンを消す（やり直せない）", async () => {
    await completeCodeVerification();
    await startRecoveryPasskeyRegistrationAction();
    completeRecoveryWithPasskey.mockResolvedValue({ ok: false, reason: "codeNotCurrent" });

    const result = await finishRecoveryPasskeyRegistrationAction(regResponse, "iPhone");

    expect(result).toEqual({ ok: false, error: RECOVERY_ERRORS.invalidCode });
    expect(createSession).not.toHaveBeenCalled();
    const { getRecoverySession } = await import("@/lib/recovery-session");
    await expect(getRecoverySession()).resolves.toBeNull();
  });

  it("completeRecoveryWithPasskey が duplicate（同じ資格情報IDが登録済み）なら duplicate を返し、リカバリー用トークンは残す（やり直せる）", async () => {
    await completeCodeVerification();
    await startRecoveryPasskeyRegistrationAction();
    completeRecoveryWithPasskey.mockResolvedValue({ ok: false, reason: "duplicate" });

    const result = await finishRecoveryPasskeyRegistrationAction(regResponse, "iPhone");

    expect(result).toEqual({ ok: false, error: RECOVERY_ERRORS.duplicate });
    expect(createSession).not.toHaveBeenCalled();
    const { getRecoverySession } = await import("@/lib/recovery-session");
    await expect(getRecoverySession()).resolves.not.toBeNull();
  });

  it("verifyRegistrationResponse が verified:false ならverificationFailed。completeRecoveryWithPasskey は呼ばれない（コードは消費されない）", async () => {
    await completeCodeVerification();
    await startRecoveryPasskeyRegistrationAction();
    verifyRegistrationResponse.mockResolvedValue({ verified: false });

    const result = await finishRecoveryPasskeyRegistrationAction(regResponse, "iPhone");
    expect(result).toEqual({ ok: false, error: RECOVERY_ERRORS.verificationFailed });
    expect(completeRecoveryWithPasskey).not.toHaveBeenCalled();
  });

  it("verifyRegistrationResponse が throw（生体認証の取り消し等）してもverificationFailed。リカバリー用トークンは残る（もう一度やり直せる。実機確認5）", async () => {
    await completeCodeVerification();
    await startRecoveryPasskeyRegistrationAction();
    verifyRegistrationResponse.mockRejectedValue(new Error("NotAllowedError"));

    const result = await finishRecoveryPasskeyRegistrationAction(regResponse, "iPhone");
    expect(result).toEqual({ ok: false, error: RECOVERY_ERRORS.verificationFailed });
    expect(completeRecoveryWithPasskey).not.toHaveBeenCalled();

    const { getRecoverySession } = await import("@/lib/recovery-session");
    await expect(getRecoverySession()).resolves.not.toBeNull();
  });

  it("端末名が空なら検証エラーを返す。completeRecoveryWithPasskey は呼ばれない", async () => {
    await completeCodeVerification();
    await startRecoveryPasskeyRegistrationAction();

    const { PASSKEY_ERRORS } = await import("@/lib/passkey-messages");
    const result = await finishRecoveryPasskeyRegistrationAction(regResponse, "");
    expect(result).toEqual({ ok: false, error: PASSKEY_ERRORS.deviceNameRequired });
    expect(completeRecoveryWithPasskey).not.toHaveBeenCalled();
  });

  it("completeRecoveryWithPasskey が例外を投げたら unavailable", async () => {
    await completeCodeVerification();
    await startRecoveryPasskeyRegistrationAction();
    completeRecoveryWithPasskey.mockRejectedValue(new Error("db unavailable"));

    const result = await finishRecoveryPasskeyRegistrationAction(regResponse, "iPhone");
    expect(result).toEqual({ ok: false, error: RECOVERY_ERRORS.unavailable });
  });

  it("ユーザー作成後にセッション発行が失敗しても unavailable を返す（パスキーとコードはすでに切り替わっている）", async () => {
    await completeCodeVerification();
    await startRecoveryPasskeyRegistrationAction();
    createSession.mockRejectedValueOnce(new Error("cookie store failure"));

    const result = await finishRecoveryPasskeyRegistrationAction(regResponse, "iPhone");
    expect(result).toEqual({ ok: false, error: RECOVERY_ERRORS.unavailable });
    expect(completeRecoveryWithPasskey).toHaveBeenCalledTimes(1);
  });
});

describe("家計データに触れない（tester 向けの方針 1）", () => {
  it("verifyRecoveryCodeAction・start・finish は @/lib/session の createSession しか使わない（requireUserId 等は呼ばれない。呼べば未提供の関数で例外になるはず）", async () => {
    // このファイルは @/lib/session を createSession だけにモックしている。
    // もしどれかが requireUserId 等の家計データ保護用の関数を呼んでいれば、
    // モジュール解決や呼び出し時点で失敗するはずだが、正常に完走できることが
    // 「リカバリーの Server Action がログイン中の利用者の情報に依存していない」ことの根拠になる
    await completeCodeVerification();
    await startRecoveryPasskeyRegistrationAction();
    const result = await finishRecoveryPasskeyRegistrationAction(regResponse, "iPhone");
    expect(result.ok).toBe(true);
  });
});
