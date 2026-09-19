// src/app/(auth)/signup/page.tsx を検証する。
//
// getSession を差し替える（tests/app/page.test.tsx・tests/app/(auth)/login/page.test.tsx と
// 同じ方針。async Server Component なので `await SignupPage()` してから render する）。
//
// 期待値の根拠:
// - docs/steps/pub-2.md 設計判断 6「画面」
//   「/signup: 公開パス」「ログイン中に /signup を開いたら / へリダイレクトする」
//   「画面に出すこと（登録ボタンの前に読める位置）:
//   メールアドレスもパスワードも要らずこの端末のパスキーでアカウントを作ること、
//   この端末をなくすとログインできなくなること・登録後に設定からも登録してほしいこと、
//   これはデモであり実在の家計情報を入力しないでほしいこと、
//   すでにアカウントを持っているならログイン画面から入ること」
//   「ログイン画面に『アカウントを作る』→ /signup、サインアップ画面に『ログインする』→ /login」
// - docs/steps/pub-2.md「tester 向けの方針」9.

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SessionPayload } from "@/lib/auth";
import type { UserId } from "@/lib/user-id";

const getSessionMock = vi.fn<() => Promise<SessionPayload | null>>();

vi.mock("@/lib/session", () => ({
  getSession: () => getSessionMock(),
}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT;${url}`);
  },
}));
// isServerActionRerender（src/lib/server-action-request.ts）が next/headers の headers() を読む。
// ここでは「Server Action の再描画ではない」（next-action ヘッダが無い）状態を既定にする
// （docs/steps/pub-5.md「/signup と /recovery/passkey のページは、Server Action の後の
// 再描画のときだけ redirect しない」）
vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
}));
// signup/actions.ts はサーバー専用の依存（@simplewebauthn/server, jose 等）を持つため、
// ページの配線テストでは Server Action そのものをモックし、画面の描画だけを見る
vi.mock("@/app/(auth)/signup/actions", () => ({
  startSignupAction: vi.fn(),
  finishSignupAction: vi.fn(),
}));

const { default: SignupPage } = await import("@/app/(auth)/signup/page");

afterEach(() => {
  cleanup();
  getSessionMock.mockReset();
});

describe("未ログイン", () => {
  it("サインアップフォームが組み込まれている（画面まで結線されていることの確認）", async () => {
    getSessionMock.mockResolvedValue(null);
    render(await SignupPage());
    expect(
      screen.getByRole("button", { name: /パスキーでアカウントを作る/ }),
    ).toBeInTheDocument();
  });

  it("登録ボタンの前に、パスキーだけで作ることを読める", async () => {
    getSessionMock.mockResolvedValue(null);
    render(await SignupPage());
    expect(
      screen.getByText(/メールアドレスもパスワードも要りません/),
    ).toBeInTheDocument();
  });

  it("登録ボタンの前に、登録後にリカバリーコードを控えてほしいこと・別の端末も登録すると安心なことを読める（docs/steps/pub-5.md 設計判断 9で趣旨を改めた）", async () => {
    // 設計判断 9: 「この端末をなくすとログインできなくなる」という Step 2 の文言を、
    // 「登録の後に表示するリカバリーコードを控えてほしい。別の端末も登録しておくと安心」の趣旨に改める
    getSessionMock.mockResolvedValue(null);
    render(await SignupPage());
    expect(screen.getByText(/リカバリーコード/)).toBeInTheDocument();
    expect(screen.getByText(/一度だけ表示します/)).toBeInTheDocument();
    expect(screen.getByText(/必ず控えてください/)).toBeInTheDocument();
    expect(screen.getByText(/別の端末も登録しておくと安心です/)).toBeInTheDocument();
  });

  it("登録ボタンの前に、デモであり実在の家計情報を入力しないでほしいことを読める", async () => {
    getSessionMock.mockResolvedValue(null);
    render(await SignupPage());
    expect(screen.getByText(/これはデモです/)).toBeInTheDocument();
    expect(screen.getByText(/実在の家計の情報は入力しないでください/)).toBeInTheDocument();
  });

  it("すでにアカウントがあるならログイン画面から入ること・QRコードでスマホのパスキーを使えることを読める", async () => {
    getSessionMock.mockResolvedValue(null);
    render(await SignupPage());
    expect(screen.getByText(/すでにアカウントをお持ちなら/)).toBeInTheDocument();
    expect(screen.getByText(/QR コードで使ってログインできます/)).toBeInTheDocument();
  });

  it("ログイン画面へのリンクを持つ（/login）", async () => {
    getSessionMock.mockResolvedValue(null);
    render(await SignupPage());
    const links = screen.getAllByRole("link", { name: "ログイン画面" }).concat(
      screen.queryAllByRole("link", { name: "ログインする" }),
    );
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(link).toHaveAttribute("href", "/login");
    }
  });

  it("これらの注意書きは、登録ボタンより前（DOM順で手前）に出る", async () => {
    getSessionMock.mockResolvedValue(null);
    render(await SignupPage());
    const notice = screen.getByText(/これはデモです/);
    const button = screen.getByRole("button", { name: /パスキーでアカウントを作る/ });
    // DOM の出現順で notice が button より前にあること
    const followingFlag = Node.DOCUMENT_POSITION_FOLLOWING;
    const position = notice.compareDocumentPosition(button);
    expect(Boolean(position & followingFlag)).toBe(true);
  });
});

describe("ログイン中", () => {
  it("/ へリダイレクトする", async () => {
    getSessionMock.mockResolvedValue({
      userId: "user_1" as UserId,
      iat: 0,
      exp: 999999999999,
    });
    await expect(SignupPage()).rejects.toThrow("NEXT_REDIRECT;/");
  });
});
