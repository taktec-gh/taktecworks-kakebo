// @vitest-environment node
//
// src/app/(auth)/login/actions.ts の Server Action を検証する。
//
// 公開版ではパスワードログイン（loginAction）を廃止した
// （docs/steps/pub-1.md 設計判断 1「パスワードログインと RECOVERY_MODE はこの Step で
//   廃止する」「削除するもの: loginAction」）。このファイルの旧テストは loginAction の
// パスワード検証・レート制限を検証していたが、その対象が無くなったため、
// 残った logoutAction のテストに書き換えた
// （旧 tests/app/(auth)/login/actions.test.ts の19ケース、
//   tests/app/(auth)/login/actions-rate-limit.test.ts の19ケース、
//   tests/app/(auth)/login/login-form.test.tsx の13ケースは削除。詳細はレポート参照）。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LOGIN_PATH } from "@/lib/auth";

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
const destroySession = vi.fn(async () => {});

vi.mock("next/navigation", () => ({ redirect: (url: string) => redirect(url) }));
vi.mock("@/lib/session", () => ({
  destroySession: () => destroySession(),
}));

const { logoutAction } = await import("@/app/(auth)/login/actions");

beforeEach(() => {
  redirect.mockClear();
  destroySession.mockClear();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("logoutAction", () => {
  it("セッションを破棄して /login へリダイレクトする", async () => {
    await expect(logoutAction()).rejects.toThrow("NEXT_REDIRECT");
    expect(destroySession).toHaveBeenCalledTimes(1);
    expect(redirect).toHaveBeenCalledWith(LOGIN_PATH);
  });

  it("破棄してからリダイレクトする（順序が逆だと Cookie が消える前に画面遷移してしまう）", async () => {
    await logoutAction().catch(() => {});
    expect(destroySession.mock.invocationCallOrder[0]).toBeLessThan(
      redirect.mock.invocationCallOrder[0],
    );
  });
});
