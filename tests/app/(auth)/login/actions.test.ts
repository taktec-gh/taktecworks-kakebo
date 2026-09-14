// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LOGIN_ERROR_MESSAGE } from "@/lib/auth";
import { initialLoginState, type LoginState } from "@/app/(auth)/login/login-state";

const PASSWORD = "ひみつの合言葉";

/** redirect は本来 NEXT_REDIRECT を throw して制御を打ち切る。その挙動を再現する */
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
const destroySession = vi.fn(async () => {});

vi.mock("next/navigation", () => ({ redirect: (url: string) => redirect(url) }));
vi.mock("@/lib/session", () => ({
  createSession: () => createSession(),
  destroySession: () => destroySession(),
  getSession: async () => null,
}));

// Step 7: loginAction はパスワードを見る前にレート制限（DB）と資格情報の件数（DB）を
// 確認するようになった（docs/steps/step-7.md「ログインの処理順」）。この既存ファイルは
// もともとパスワード単体の検証に注目していたテストなので、ここでは常に
// 「ブロックされていない・パスキー未登録（0件）」というふるまいに固定する
// （指示書「tester への引き継ぎ > 0.」の (A) 案）。レート制限・パスキー必須化そのものの
// 単体テストは tests/app/(auth)/login/actions-rate-limit.test.ts に分けて書く。
vi.mock("@/lib/client-ip", () => ({
  getClientIp: async () => "203.0.113.9",
  getClientIpHash: async () => "iphash",
}));
vi.mock("@/lib/credentials", () => ({ countCredentials: async () => 0 }));
vi.mock("@/lib/login-attempts", () => ({
  isBlocked: async () => false,
  recordLoginAttempt: async () => {},
}));

const { loginAction, logoutAction } = await import("@/app/(auth)/login/actions");

function formDataWith(password: string | Blob): FormData {
  const formData = new FormData();
  formData.set("password", password);
  return formData;
}

beforeEach(() => {
  redirect.mockClear();
  createSession.mockClear();
  destroySession.mockClear();
  vi.stubEnv("APP_PASSWORD", PASSWORD);
  vi.stubEnv("AUTH_SECRET", "test-auth-secret-0123456789abcdef");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("loginAction 成功時", () => {
  it("セッションを発行して '/' へリダイレクトする", async () => {
    await expect(loginAction(initialLoginState, formDataWith(PASSWORD))).rejects.toThrow(
      "NEXT_REDIRECT",
    );
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(redirect).toHaveBeenCalledWith("/");
  });

  it("Cookie を発行してからリダイレクトする（順序が逆だと Cookie が載らない）", async () => {
    await loginAction(initialLoginState, formDataWith(PASSWORD)).catch(() => {});
    expect(createSession.mock.invocationCallOrder[0]).toBeLessThan(
      redirect.mock.invocationCallOrder[0],
    );
  });

  it("前回の状態にエラーが残っていても成功する", async () => {
    const previous: LoginState = { error: LOGIN_ERROR_MESSAGE };
    await expect(loginAction(previous, formDataWith(PASSWORD))).rejects.toThrow("NEXT_REDIRECT");
    expect(createSession).toHaveBeenCalledTimes(1);
  });
});

describe("loginAction 失敗時", () => {
  /** 失敗の4系統。すべて同じメッセージでなければならない（分岐すると原因が漏れる） */
  const failures: Array<[string, () => Promise<LoginState>]> = [
    [
      "パスワードが誤り",
      () => loginAction(initialLoginState, formDataWith("まちがった合言葉")),
    ],
    ["パスワードが空", () => loginAction(initialLoginState, formDataWith(""))],
    ["password フィールドが無い", () => loginAction(initialLoginState, new FormData())],
    [
      "APP_PASSWORD 未設定",
      () => {
        vi.stubEnv("APP_PASSWORD", "");
        return loginAction(initialLoginState, formDataWith(PASSWORD));
      },
    ],
  ];

  it.each(failures)("%s のときエラーメッセージを返す", async (_label, run) => {
    await expect(run()).resolves.toEqual({ error: LOGIN_ERROR_MESSAGE });
  });

  it.each(failures)("%s のときセッションを発行せずリダイレクトもしない", async (_label, run) => {
    await run();
    expect(createSession).not.toHaveBeenCalled();
    expect(redirect).not.toHaveBeenCalled();
  });

  it("4系統すべてが完全に同一のメッセージを返す", async () => {
    const messages: Array<string | null> = [];
    for (const [, run] of failures) {
      messages.push((await run()).error);
      vi.stubEnv("APP_PASSWORD", PASSWORD);
    }
    expect(new Set(messages).size).toBe(1);
    expect(messages[0]).toBe(LOGIN_ERROR_MESSAGE);
  });

  it("password が文字列でない（ファイル添付）場合も同じメッセージ", async () => {
    const file = new File(["dummy"], "pw.txt", { type: "text/plain" });
    await expect(loginAction(initialLoginState, formDataWith(file))).resolves.toEqual({
      error: LOGIN_ERROR_MESSAGE,
    });
    expect(createSession).not.toHaveBeenCalled();
  });

  it("前後に空白が付いたパスワードは通さない", async () => {
    await expect(loginAction(initialLoginState, formDataWith(` ${PASSWORD}`))).resolves.toEqual({
      error: LOGIN_ERROR_MESSAGE,
    });
    await expect(loginAction(initialLoginState, formDataWith(`${PASSWORD} `))).resolves.toEqual({
      error: LOGIN_ERROR_MESSAGE,
    });
    expect(createSession).not.toHaveBeenCalled();
  });

  it("正しいパスワードの接頭辞では通さない", async () => {
    await expect(
      loginAction(initialLoginState, formDataWith(PASSWORD.slice(0, 3))),
    ).resolves.toEqual({ error: LOGIN_ERROR_MESSAGE });
    expect(createSession).not.toHaveBeenCalled();
  });

  it("APP_PASSWORD 未設定のとき、空パスワードでも通らない", async () => {
    vi.stubEnv("APP_PASSWORD", "");
    await expect(loginAction(initialLoginState, formDataWith(""))).resolves.toEqual({
      error: LOGIN_ERROR_MESSAGE,
    });
    expect(createSession).not.toHaveBeenCalled();
  });

  it("エラーメッセージに入力したパスワードを含めない", async () => {
    const state = await loginAction(initialLoginState, formDataWith("まちがった合言葉"));
    expect(state.error).not.toContain("まちがった合言葉");
  });
});

describe("logoutAction", () => {
  it("セッションを破棄して /login へリダイレクトする", async () => {
    await expect(logoutAction()).rejects.toThrow("NEXT_REDIRECT");
    expect(destroySession).toHaveBeenCalledTimes(1);
    expect(redirect).toHaveBeenCalledWith("/login");
  });

  it("破棄してからリダイレクトする", async () => {
    await logoutAction().catch(() => {});
    expect(destroySession.mock.invocationCallOrder[0]).toBeLessThan(
      redirect.mock.invocationCallOrder[0],
    );
  });
});
