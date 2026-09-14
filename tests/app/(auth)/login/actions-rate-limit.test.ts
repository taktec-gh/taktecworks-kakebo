// @vitest-environment node
//
// loginAction のレート制限・パスキー必須化・IP の扱いを検証する。
// tests/app/(auth)/login/actions.test.ts はデータ層をふるまいごとモックする方針
// （指示書「tester への引き継ぎ > 0.」の (A) 案）なのに対し、こちらは
// Prisma と next/headers をモックしてクエリの中身まで見る (B) 案を使う。
//
// 期待値の根拠:
// - docs/steps/step-7.md「ログインの処理順」1〜6
// - docs/steps/step-7.md「特に壊れやすい箇所」表（必須化の判定 / 情報の漏れ /
//   レート制限の境界 / 記録の保持 / IP の扱い）
// - docs/steps/step-7.md「tester への引き継ぎ > 5. 失敗パスの再現方法」

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LOGIN_ERROR_MESSAGE } from "@/lib/auth";
import { hashIp, RATE_LIMIT_MAX_FAILURES } from "@/lib/login-attempts";
import { initialLoginState } from "@/app/(auth)/login/login-state";

const PASSWORD = "ひみつの合言葉";
const SECRET = "test-auth-secret-0123456789abcdef";

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
const createSession = vi.fn(async () => {});

const credentialCount = vi.fn();
const loginAttemptCount = vi.fn();
const loginAttemptCreate = vi.fn();
const loginAttemptDeleteMany = vi.fn();

let forwardedFor: string | null | undefined = "203.0.113.9";

vi.mock("next/navigation", () => ({ redirect: (url: string) => redirect(url) }));
vi.mock("@/lib/session", () => ({
  createSession: () => createSession(),
  destroySession: async () => {},
  getSession: async () => null,
}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers(forwardedFor ? { "x-forwarded-for": forwardedFor } : {}),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    credential: { count: (...args: unknown[]) => credentialCount(...args) },
    loginAttempt: {
      count: (...args: unknown[]) => loginAttemptCount(...args),
      create: (...args: unknown[]) => loginAttemptCreate(...args),
      deleteMany: (...args: unknown[]) => loginAttemptDeleteMany(...args),
    },
  },
}));

const { loginAction } = await import("@/app/(auth)/login/actions");

function formDataWith(password: string): FormData {
  const formData = new FormData();
  formData.set("password", password);
  return formData;
}

beforeEach(() => {
  redirect.mockClear();
  createSession.mockClear();
  credentialCount.mockReset();
  loginAttemptCount.mockReset();
  loginAttemptCreate.mockReset();
  loginAttemptDeleteMany.mockReset();
  loginAttemptCreate.mockResolvedValue({});
  forwardedFor = "203.0.113.9";
  vi.stubEnv("APP_PASSWORD", PASSWORD);
  vi.stubEnv("AUTH_SECRET", SECRET);
  vi.stubEnv("RECOVERY_MODE", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("レート制限の境界", () => {
  it("直近の失敗が9回なら通り、正しいパスワードで成功する", async () => {
    loginAttemptCount.mockResolvedValue(RATE_LIMIT_MAX_FAILURES - 1);
    credentialCount.mockResolvedValue(0);

    await expect(loginAction(initialLoginState, formDataWith(PASSWORD))).rejects.toThrow(
      "NEXT_REDIRECT",
    );
    expect(createSession).toHaveBeenCalledTimes(1);
  });

  it("直近の失敗が10回（RATE_LIMIT_MAX_FAILURES）ならブロックされ、正しいパスワードでも失敗する", async () => {
    loginAttemptCount.mockResolvedValue(RATE_LIMIT_MAX_FAILURES);
    credentialCount.mockResolvedValue(0);

    const result = await loginAction(initialLoginState, formDataWith(PASSWORD));

    expect(result).toEqual({ error: LOGIN_ERROR_MESSAGE });
    expect(createSession).not.toHaveBeenCalled();
    // ブロック判定だけで弾くので、資格情報の件数は見に行かない
    expect(credentialCount).not.toHaveBeenCalled();
  });

  it("ブロック中の試行も失敗として記録する", async () => {
    loginAttemptCount.mockResolvedValue(RATE_LIMIT_MAX_FAILURES);

    await loginAction(initialLoginState, formDataWith(PASSWORD));

    expect(loginAttemptCreate).toHaveBeenCalledWith({
      data: { ipHash: expect.any(String), succeeded: false },
    });
  });
});

describe("必須化の判定（パスキー）", () => {
  it("資格情報0件ならパスワードで通る", async () => {
    loginAttemptCount.mockResolvedValue(0);
    credentialCount.mockResolvedValue(0);

    await expect(loginAction(initialLoginState, formDataWith(PASSWORD))).rejects.toThrow(
      "NEXT_REDIRECT",
    );
    expect(createSession).toHaveBeenCalledTimes(1);
  });

  it("資格情報1件以上なら、正しいパスワードでも拒否する", async () => {
    loginAttemptCount.mockResolvedValue(0);
    credentialCount.mockResolvedValue(1);

    const result = await loginAction(initialLoginState, formDataWith(PASSWORD));

    expect(result).toEqual({ error: LOGIN_ERROR_MESSAGE });
    expect(createSession).not.toHaveBeenCalled();
  });

  it("資格情報が多数あっても同様に拒否する", async () => {
    loginAttemptCount.mockResolvedValue(0);
    credentialCount.mockResolvedValue(5);

    const result = await loginAction(initialLoginState, formDataWith(PASSWORD));
    expect(result).toEqual({ error: LOGIN_ERROR_MESSAGE });
  });

  it("拒否したときも失敗として記録する", async () => {
    loginAttemptCount.mockResolvedValue(0);
    credentialCount.mockResolvedValue(1);

    await loginAction(initialLoginState, formDataWith(PASSWORD));

    expect(loginAttemptCreate).toHaveBeenCalledWith({
      data: { ipHash: expect.any(String), succeeded: false },
    });
  });

  it("RECOVERY_MODE=1 なら資格情報が1件以上あってもパスワードで通る（緊急脱出）", async () => {
    vi.stubEnv("RECOVERY_MODE", "1");
    loginAttemptCount.mockResolvedValue(0);
    credentialCount.mockResolvedValue(3);

    await expect(loginAction(initialLoginState, formDataWith(PASSWORD))).rejects.toThrow(
      "NEXT_REDIRECT",
    );
    expect(createSession).toHaveBeenCalledTimes(1);
  });

  it.each(["true", "0", "", "TRUE"])(
    "RECOVERY_MODE='%s' は緊急脱出にならない（資格情報1件以上なら拒否のまま）",
    async (value) => {
      vi.stubEnv("RECOVERY_MODE", value);
      loginAttemptCount.mockResolvedValue(0);
      credentialCount.mockResolvedValue(1);

      const result = await loginAction(initialLoginState, formDataWith(PASSWORD));
      expect(result).toEqual({ error: LOGIN_ERROR_MESSAGE });
    },
  );
});

describe("情報の漏れ — 失敗理由を問わず同一メッセージ", () => {
  it("ブロック中・パスキー必須・パスワード誤りが完全に同じ文字列を返す", async () => {
    // ブロック中
    loginAttemptCount.mockResolvedValue(RATE_LIMIT_MAX_FAILURES);
    credentialCount.mockResolvedValue(0);
    const blocked = await loginAction(initialLoginState, formDataWith(PASSWORD));

    // パスキー必須
    loginAttemptCount.mockResolvedValue(0);
    credentialCount.mockResolvedValue(1);
    const passkeyRequired = await loginAction(initialLoginState, formDataWith(PASSWORD));

    // パスワード誤り
    loginAttemptCount.mockResolvedValue(0);
    credentialCount.mockResolvedValue(0);
    const wrongPassword = await loginAction(initialLoginState, formDataWith("wrong"));

    const messages = [blocked.error, passkeyRequired.error, wrongPassword.error];
    expect(new Set(messages).size).toBe(1);
    expect(messages[0]).toBe(LOGIN_ERROR_MESSAGE);
  });
});

describe("記録の保持 — 成功しても過去の失敗記録は消えない", () => {
  it("成功時に deleteMany など記録を消す操作を呼ばない", async () => {
    loginAttemptCount.mockResolvedValue(9); // 直近9回失敗している状態
    credentialCount.mockResolvedValue(0);

    await loginAction(initialLoginState, formDataWith(PASSWORD)).catch(() => {});

    expect(loginAttemptDeleteMany).not.toHaveBeenCalled();
    expect(loginAttemptCreate).toHaveBeenCalledWith({
      data: { ipHash: expect.any(String), succeeded: true },
    });
  });
});

describe("IP の扱い", () => {
  it("記録される ipHash は生IPではなく HMAC 済みの値（先頭IPから計算したもの）", async () => {
    forwardedFor = "203.0.113.9, 70.41.3.18";
    loginAttemptCount.mockResolvedValue(0);
    credentialCount.mockResolvedValue(1); // 必ず失敗させて記録させる

    await loginAction(initialLoginState, formDataWith(PASSWORD));

    const expectedHash = hashIp("203.0.113.9", SECRET);
    expect(loginAttemptCreate).toHaveBeenCalledWith({
      data: { ipHash: expectedHash, succeeded: false },
    });
    // 生IPは含まれない
    const [[arg]] = loginAttemptCreate.mock.calls;
    expect(JSON.stringify(arg)).not.toContain("203.0.113.9");
    expect(JSON.stringify(arg)).not.toContain("70.41.3.18");
  });

  it("x-forwarded-for が無ければ 'unknown' を基にハッシュする", async () => {
    forwardedFor = null;
    loginAttemptCount.mockResolvedValue(0);
    credentialCount.mockResolvedValue(1);

    await loginAction(initialLoginState, formDataWith(PASSWORD));

    const expectedHash = hashIp("unknown", SECRET);
    expect(loginAttemptCreate).toHaveBeenCalledWith({
      data: { ipHash: expectedHash, succeeded: false },
    });
  });

  it("isBlocked とレート制限の記録には同じ ipHash を使う", async () => {
    forwardedFor = "198.51.100.7";
    loginAttemptCount.mockResolvedValue(0);
    credentialCount.mockResolvedValue(1);

    await loginAction(initialLoginState, formDataWith(PASSWORD));

    const expectedHash = hashIp("198.51.100.7", SECRET);
    expect(loginAttemptCount.mock.calls[0][0]).toMatchObject({
      where: expect.objectContaining({ ipHash: expectedHash }),
    });
    expect(loginAttemptCreate).toHaveBeenCalledWith({
      data: { ipHash: expectedHash, succeeded: false },
    });
  });
});

describe("fail closed — DB/ヘッダの取得に失敗したら通さない", () => {
  it("loginAttempt.count が reject したら通常の失敗として扱い、パスワードが正しくても成功しない", async () => {
    loginAttemptCount.mockRejectedValue(new Error("DB down"));
    credentialCount.mockResolvedValue(0);

    const result = await loginAction(initialLoginState, formDataWith(PASSWORD));

    expect(result).toEqual({ error: LOGIN_ERROR_MESSAGE });
    expect(createSession).not.toHaveBeenCalled();
  });

  it("credential.count が reject したら成功しない", async () => {
    loginAttemptCount.mockResolvedValue(0);
    credentialCount.mockRejectedValue(new Error("DB down"));

    const result = await loginAction(initialLoginState, formDataWith(PASSWORD));

    expect(result).toEqual({ error: LOGIN_ERROR_MESSAGE });
    expect(createSession).not.toHaveBeenCalled();
  });
});
