// @vitest-environment node
//
// src/app/settings/passkeys/actions.ts（パスキーの登録・削除）を検証する。
// @simplewebauthn/server はモック、チャレンジ JWT は本物を使う
// （docs/steps/step-7.md「tester への引き継ぎ > 4」と同じ方針）。
//
// 期待値の根拠:
// - docs/steps/step-7.md「実装するファイル」actions.ts の役割
// - docs/steps/step-7.md「特に壊れやすい箇所」（要ログイン・チャレンジの単回性・
//   資格情報の削除・RP不一致）
// - docs/steps/step-7.md「tester への引き継ぎ > 5. 失敗パスの再現方法」

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createChallengeToken } from "@/lib/passkey";
import { PASSKEY_ERRORS } from "@/lib/passkey-messages";
import type { UserId } from "@/lib/user-id";
import { getPasskeyDisplayName } from "@/lib/webauthn-user-id";

import type { RegistrationResponseJSON } from "@simplewebauthn/server";

const SECRET = "test-auth-secret-0123456789abcdef";
const RP_ID = "localhost";
const RP_ORIGIN = "http://localhost:3123";
const USER_ID = "user_1" as UserId;

class RedirectError extends Error {
  digest: string;
  constructor(url: string) {
    super(`NEXT_REDIRECT;${url}`);
    this.digest = `NEXT_REDIRECT;replace;${url};307;`;
  }
}
const redirect = vi.fn((url: string): never => {
  throw new RedirectError(url);
});
const revalidatePath = vi.fn();

const requireUserId = vi.fn<() => Promise<UserId>>();

// ---- @simplewebauthn/server のモック ----
const generateRegistrationOptions = vi.fn(async (_opts: unknown) => ({
  challenge: "CHALLENGE",
  rp: { name: "家計簿", id: RP_ID },
  user: { id: "dXNlcg", name: "owner", displayName: "" },
  pubKeyCredParams: [],
}));
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

// ---- Cookie ----
type StoredCookie = { name: string; value: string; options?: Record<string, unknown> };
const cookieStore = new Map<string, StoredCookie>();
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
}));

vi.mock("next/navigation", () => ({ redirect: (url: string) => redirect(url) }));
vi.mock("next/cache", () => ({ revalidatePath: (path: string) => revalidatePath(path) }));
vi.mock("@/lib/session", () => ({ requireUserId: () => requireUserId() }));

// ---- @/lib/credentials のモック ----
const listCredentials = vi.fn();
const createCredential = vi.fn();
const deleteCredential = vi.fn();
vi.mock("@/lib/credentials", () => ({
  listCredentials: (...args: unknown[]) => listCredentials(...args),
  createCredential: (...args: unknown[]) => createCredential(...args),
  deleteCredential: (...args: unknown[]) => deleteCredential(...args),
}));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));

// ---- @/lib/users のモック（webauthnUserId の取得。docs/steps/pub-2.md 設計判断 3・7）----
const findWebauthnUserId = vi.fn();
vi.mock("@/lib/users", () => ({
  findWebauthnUserId: (...args: unknown[]) => findWebauthnUserId(...args),
}));

const USER_WEBAUTHN_USER_ID = "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA";
const OTHER_USER_WEBAUTHN_USER_ID = "__79_Pv6-fj39vX08_Lx8O_u7ezr6uno5-bl5OPi4eA";

const {
  startPasskeyRegistrationAction,
  finishPasskeyRegistrationAction,
  deletePasskeyAction,
} = await import("@/app/settings/passkeys/actions");
const { initialPasskeyActionState } = await import("@/app/settings/passkeys/action-state");

function makeCredential(overrides: Partial<{ credentialId: string; transports: string[] }> = {}) {
  return {
    id: "cred_1",
    userId: USER_ID,
    credentialId: "cred-1",
    publicKey: new Uint8Array([1, 2, 3]),
    counter: BigInt(0),
    transports: ["internal"],
    deviceName: "iPhone",
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    updatedAt: new Date("2026-08-01T00:00:00.000Z"),
    lastUsedAt: null,
    ...overrides,
  };
}

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

function formDataOf(entries: Record<string, string>): FormData {
  const formData = new FormData();
  for (const [key, value] of Object.entries(entries)) formData.set(key, value);
  return formData;
}

beforeEach(() => {
  cookieStore.clear();
  redirect.mockClear();
  revalidatePath.mockClear();
  requireUserId.mockReset();
  requireUserId.mockResolvedValue(USER_ID);
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
  listCredentials.mockReset();
  listCredentials.mockResolvedValue([]);
  createCredential.mockReset();
  createCredential.mockResolvedValue({ ok: true, value: makeCredential() });
  deleteCredential.mockReset();
  deleteCredential.mockResolvedValue({ ok: true, value: null });
  findWebauthnUserId.mockReset();
  findWebauthnUserId.mockResolvedValue(USER_WEBAUTHN_USER_ID);

  vi.stubEnv("AUTH_SECRET", SECRET);
  vi.stubEnv("RP_ID", RP_ID);
  vi.stubEnv("RP_ORIGIN", RP_ORIGIN);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/** requireUserId() が未ログインのときの実際の挙動（redirect(LOGIN_PATH) を呼んで例外を投げる）を再現する */
function mockUnauthenticated(): void {
  requireUserId.mockImplementation(() => {
    redirect("/login");
    throw new Error("unreachable");
  });
}

describe("要ログイン", () => {
  it("startPasskeyRegistrationAction は未ログインなら /login へ redirect し、DB を呼ばない", async () => {
    mockUnauthenticated();
    await expect(startPasskeyRegistrationAction()).rejects.toThrow("NEXT_REDIRECT");
    expect(redirect).toHaveBeenCalledWith("/login");
    expect(listCredentials).not.toHaveBeenCalled();
  });

  it("finishPasskeyRegistrationAction は未ログインなら /login へ redirect する", async () => {
    mockUnauthenticated();
    await expect(
      finishPasskeyRegistrationAction(regResponse, "iPhone"),
    ).rejects.toThrow("NEXT_REDIRECT");
    expect(createCredential).not.toHaveBeenCalled();
  });

  it("deletePasskeyAction は未ログインなら /login へ redirect する", async () => {
    mockUnauthenticated();
    await expect(
      deletePasskeyAction(initialPasskeyActionState, formDataOf({ id: "cred_1" })),
    ).rejects.toThrow("NEXT_REDIRECT");
    expect(deleteCredential).not.toHaveBeenCalled();
  });
});

describe("startPasskeyRegistrationAction", () => {
  it("成功時はオプションを返しチャレンジ Cookie を発行する", async () => {
    const result = await startPasskeyRegistrationAction();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.options.challenge).toBe("CHALLENGE");
    expect(cookieStore.has("kakeibo_passkey_register")).toBe(true);
  });

  it("residentKey/userVerification を required にする", async () => {
    await startPasskeyRegistrationAction();
    expect(generateRegistrationOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        authenticatorSelection: { residentKey: "required", userVerification: "required" },
      }),
    );
  });

  it("登録済みの資格情報を excludeCredentials として渡す（二重登録防止）", async () => {
    listCredentials.mockResolvedValue([makeCredential({ credentialId: "existing-1" })]);
    await startPasskeyRegistrationAction();
    expect(generateRegistrationOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        excludeCredentials: [{ id: "existing-1", transports: ["internal"] }],
      }),
    );
  });

  it("listCredentials を requireUserId が返した userId で呼ぶ（自分の分だけを excludeCredentials にする）", async () => {
    await startPasskeyRegistrationAction();
    expect(listCredentials).toHaveBeenCalledWith(expect.anything(), USER_ID);
  });

  it("RP_ID/RP_ORIGIN 未設定なら configMissing を返す（ここでは理由を出してよい）", async () => {
    vi.stubEnv("RP_ID", "");
    const result = await startPasskeyRegistrationAction();
    expect(result).toEqual({ ok: false, error: PASSKEY_ERRORS.configMissing });
  });

  describe("webauthnUserId と表示名（docs/steps/pub-2.md 設計判断 3・7）", () => {
    it("findWebauthnUserId を requireUserId が返した userId で呼ぶ", async () => {
      await startPasskeyRegistrationAction();
      expect(findWebauthnUserId).toHaveBeenCalledWith(expect.anything(), USER_ID);
    });

    it("userID にはそのユーザーの webauthnUserId 由来のバイト列を使う（毎回新しく作らない）", async () => {
      await startPasskeyRegistrationAction();
      const [[options]] = generateRegistrationOptions.mock.calls as [
        [{ userID: Uint8Array; userName: string; userDisplayName: string }],
      ];
      // webauthnUserIdToBytes(USER_WEBAUTHN_USER_ID) と同じバイト列になるはず
      expect(Buffer.from(options.userID).toString("base64url")).toBe(USER_WEBAUTHN_USER_ID);
    });

    it("表示名（userName/userDisplayName）は webauthnUserId から決まる値で、他のユーザーの値ではない", async () => {
      await startPasskeyRegistrationAction();
      const expectedName = getPasskeyDisplayName(USER_WEBAUTHN_USER_ID);
      const otherName = getPasskeyDisplayName(OTHER_USER_WEBAUTHN_USER_ID);
      expect(expectedName).not.toBe(otherName);

      const [[options]] = generateRegistrationOptions.mock.calls as [
        [{ userID: Uint8Array; userName: string; userDisplayName: string }],
      ];
      expect(options.userName).toBe(expectedName);
      expect(options.userDisplayName).toBe(expectedName);
    });

    it("別のユーザーの webauthnUserId が返ってきたら、そのユーザーの表示名になる（他ユーザーの値を使わない）", async () => {
      findWebauthnUserId.mockResolvedValue(OTHER_USER_WEBAUTHN_USER_ID);
      await startPasskeyRegistrationAction();
      const [[options]] = generateRegistrationOptions.mock.calls as [
        [{ userID: Uint8Array; userName: string; userDisplayName: string }],
      ];
      expect(options.userName).toBe(getPasskeyDisplayName(OTHER_USER_WEBAUTHN_USER_ID));
      expect(options.userName).not.toBe(getPasskeyDisplayName(USER_WEBAUTHN_USER_ID));
    });

    it("webauthnUserId が見つからない（アカウントが消えた後のセッションなど）なら accountNotFound を返し、DB を呼ばない", async () => {
      findWebauthnUserId.mockResolvedValue(null);
      const result = await startPasskeyRegistrationAction();
      expect(result).toEqual({ ok: false, error: PASSKEY_ERRORS.accountNotFound });
      expect(listCredentials).not.toHaveBeenCalled();
      expect(generateRegistrationOptions).not.toHaveBeenCalled();
    });
  });
});

describe("finishPasskeyRegistrationAction", () => {
  it("成功時は保存して一覧を revalidate する", async () => {
    const token = await createChallengeToken("CHALLENGE", "register", SECRET);
    cookieStore.set("kakeibo_passkey_register", { name: "kakeibo_passkey_register", value: token });

    const result = await finishPasskeyRegistrationAction(regResponse, "iPhone");

    expect(result).toEqual({ ok: true });
    expect(createCredential).toHaveBeenCalledWith(expect.anything(), USER_ID, {
      credentialId: "cred-1",
      publicKey: new Uint8Array([1, 2, 3]),
      counter: 0,
      transports: ["internal", "hybrid"],
      deviceName: "iPhone",
    });
    expect(revalidatePath).toHaveBeenCalledWith("/settings/passkeys");
  });

  it("response.response.transports が無ければ空配列で保存する", async () => {
    const token = await createChallengeToken("CHALLENGE", "register", SECRET);
    cookieStore.set("kakeibo_passkey_register", { name: "kakeibo_passkey_register", value: token });
    const withoutTransports = {
      ...regResponse,
      response: { clientDataJSON: "e30", attestationObject: "e30" },
    };

    await finishPasskeyRegistrationAction(withoutTransports, "iPhone");

    expect(createCredential).toHaveBeenCalledWith(
      expect.anything(),
      USER_ID,
      expect.objectContaining({ transports: [] }),
    );
  });

  it("端末名が空なら検証エラーを返し、チャレンジを消費しない（DB も呼ばない）", async () => {
    const token = await createChallengeToken("CHALLENGE", "register", SECRET);
    cookieStore.set("kakeibo_passkey_register", { name: "kakeibo_passkey_register", value: token });

    const result = await finishPasskeyRegistrationAction(regResponse, "");

    expect(result).toEqual({ ok: false, error: PASSKEY_ERRORS.deviceNameRequired });
    expect(createCredential).not.toHaveBeenCalled();
    // チャレンジは消費されずまだ残っている
    expect(cookieStore.has("kakeibo_passkey_register")).toBe(true);
  });

  it("端末名が31文字なら検証エラーを返す", async () => {
    const token = await createChallengeToken("CHALLENGE", "register", SECRET);
    cookieStore.set("kakeibo_passkey_register", { name: "kakeibo_passkey_register", value: token });

    const result = await finishPasskeyRegistrationAction(regResponse, "あ".repeat(31));

    expect(result).toEqual({ ok: false, error: PASSKEY_ERRORS.deviceNameTooLong });
    expect(createCredential).not.toHaveBeenCalled();
  });

  it("チャレンジ Cookie が無ければ challengeExpired を返す", async () => {
    const result = await finishPasskeyRegistrationAction(regResponse, "iPhone");
    expect(result).toEqual({ ok: false, error: PASSKEY_ERRORS.challengeExpired });
    expect(createCredential).not.toHaveBeenCalled();
  });

  it("チャレンジは単回性: 2回目は challengeExpired", async () => {
    const token = await createChallengeToken("CHALLENGE", "register", SECRET);
    cookieStore.set("kakeibo_passkey_register", { name: "kakeibo_passkey_register", value: token });

    await finishPasskeyRegistrationAction(regResponse, "iPhone");
    const second = await finishPasskeyRegistrationAction(regResponse, "iPhone2");

    expect(second).toEqual({ ok: false, error: PASSKEY_ERRORS.challengeExpired });
  });

  it("認証用チャレンジを登録として使おうとすると challengeExpired（sub 違い）", async () => {
    const token = await createChallengeToken("CHALLENGE", "authenticate", SECRET);
    cookieStore.set("kakeibo_passkey_register", { name: "kakeibo_passkey_register", value: token });

    const result = await finishPasskeyRegistrationAction(regResponse, "iPhone");
    expect(result).toEqual({ ok: false, error: PASSKEY_ERRORS.challengeExpired });
    expect(verifyRegistrationResponse).not.toHaveBeenCalled();
  });

  it("verifyRegistrationResponse が throw したら verificationFailed", async () => {
    const token = await createChallengeToken("CHALLENGE", "register", SECRET);
    cookieStore.set("kakeibo_passkey_register", { name: "kakeibo_passkey_register", value: token });
    verifyRegistrationResponse.mockRejectedValue(new Error("origin mismatch"));

    const result = await finishPasskeyRegistrationAction(regResponse, "iPhone");
    expect(result).toEqual({ ok: false, error: PASSKEY_ERRORS.verificationFailed });
    expect(createCredential).not.toHaveBeenCalled();
  });

  it("verified:false なら verificationFailed", async () => {
    const token = await createChallengeToken("CHALLENGE", "register", SECRET);
    cookieStore.set("kakeibo_passkey_register", { name: "kakeibo_passkey_register", value: token });
    verifyRegistrationResponse.mockResolvedValue({ verified: false });

    const result = await finishPasskeyRegistrationAction(regResponse, "iPhone");
    expect(result).toEqual({ ok: false, error: PASSKEY_ERRORS.verificationFailed });
  });

  it("重複登録（データ層が duplicate を返す）はそのままエラーを返す", async () => {
    const token = await createChallengeToken("CHALLENGE", "register", SECRET);
    cookieStore.set("kakeibo_passkey_register", { name: "kakeibo_passkey_register", value: token });
    createCredential.mockResolvedValue({ ok: false, error: PASSKEY_ERRORS.duplicate });

    const result = await finishPasskeyRegistrationAction(regResponse, "iPhone");
    expect(result).toEqual({ ok: false, error: PASSKEY_ERRORS.duplicate });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("RP_ID/RP_ORIGIN 未設定なら configMissing", async () => {
    const token = await createChallengeToken("CHALLENGE", "register", SECRET);
    cookieStore.set("kakeibo_passkey_register", { name: "kakeibo_passkey_register", value: token });
    vi.stubEnv("RP_ID", "");

    const result = await finishPasskeyRegistrationAction(regResponse, "iPhone");
    expect(result).toEqual({ ok: false, error: PASSKEY_ERRORS.configMissing });
  });
});

describe("deletePasskeyAction", () => {
  it("id が無ければ idRequired を返す", async () => {
    const result = await deletePasskeyAction(initialPasskeyActionState, formDataOf({}));
    expect(result).toEqual({ error: PASSKEY_ERRORS.idRequired });
    expect(deleteCredential).not.toHaveBeenCalled();
  });

  it("成功時は error:null を返し一覧を revalidate する。deleteCredential は requireUserId の userId と id を渡す", async () => {
    const result = await deletePasskeyAction(initialPasskeyActionState, formDataOf({ id: "cred_1" }));
    expect(result).toEqual({ error: null });
    expect(deleteCredential).toHaveBeenCalledWith(expect.anything(), USER_ID, "cred_1");
    expect(revalidatePath).toHaveBeenCalledWith("/settings/passkeys");
  });

  it("最後の1本（データ層が deleteLastOne を返す）は拒否し、revalidate しない", async () => {
    deleteCredential.mockResolvedValue({ ok: false, error: PASSKEY_ERRORS.deleteLastOne });

    const result = await deletePasskeyAction(initialPasskeyActionState, formDataOf({ id: "cred_1" }));

    expect(result).toEqual({ error: PASSKEY_ERRORS.deleteLastOne });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("対象が存在しなければ notFound", async () => {
    deleteCredential.mockResolvedValue({ ok: false, error: PASSKEY_ERRORS.notFound });
    const result = await deletePasskeyAction(initialPasskeyActionState, formDataOf({ id: "no-such-id" }));
    expect(result).toEqual({ error: PASSKEY_ERRORS.notFound });
  });
});
