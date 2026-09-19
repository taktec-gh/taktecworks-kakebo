import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DEMO_LOGIN_NOTICES, DEMO_START_LABEL } from "@/lib/demo-messages";

// ログインページは Server Action 経由で next/headers に触れるため、副作用側を差し替える
vi.mock("@/lib/session", () => ({
  createSession: async () => {},
  destroySession: async () => {},
  getSession: async () => null,
}));
vi.mock("next/navigation", () => ({
  redirect: () => {
    throw new Error("NEXT_REDIRECT");
  },
}));
// startDemoAction が呼ぶモジュール（クリックしない限り実行されないが、import 解決のため用意する）
vi.mock("@/lib/client-ip", () => ({ getClientIpHash: async () => "iphash-test" }));
vi.mock("@/lib/demo-limits", () => ({ isDemoRateLimited: async () => false }));
vi.mock("@/lib/users", () => ({
  createDemoUser: async () => ({ userId: "user_demo", demoExpiresAt: new Date() }),
}));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));

const { default: LoginPage } = await import("@/app/(auth)/login/page");

afterEach(() => {
  cleanup();
});

describe("ログインページ", () => {
  it("パスキーでログインボタンが組み込まれている（画面まで結線されていることの確認）", () => {
    render(<LoginPage />);
    expect(screen.getByRole("button", { name: /パスキーでログイン/ })).toBeInTheDocument();
  });

  it("初期表示ではエラーが出ていない", () => {
    render(<LoginPage />);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("パスワード欄が無い（公開版はパスキーのみ。docs/steps/pub-1.md 設計判断 1）", () => {
    render(<LoginPage />);
    expect(screen.queryByLabelText("パスワード")).not.toBeInTheDocument();
    expect(screen.queryByText("パスワードでログイン")).not.toBeInTheDocument();
  });

  it("サインアップ画面へのリンク（アカウントを作る → /signup）を持つ（docs/steps/pub-2.md 設計判断 6）", () => {
    render(<LoginPage />);
    const link = screen.getByRole("link", { name: "アカウントを作る" });
    expect(link).toHaveAttribute("href", "/signup");
  });

  it("別の端末のパスキーが QR コードで使えることを短く添える（docs/steps/pub-2.md 設計判断 8）", () => {
    render(<LoginPage />);
    expect(screen.getByText(/QR コードを使ってログインに使えます/)).toBeInTheDocument();
  });

  it("「パスキーをなくした場合」→ /recovery のリンクを持つ（docs/steps/pub-5.md 設計判断 9）", () => {
    render(<LoginPage />);
    const link = screen.getByRole("link", { name: "パスキーをなくした場合" });
    expect(link).toHaveAttribute("href", "/recovery");
  });
});

describe("デモで試す（docs/steps/pub-3.md 設計判断 9）", () => {
  it("「デモで試す（登録不要）」ボタンがある", () => {
    render(<LoginPage />);
    expect(screen.getByRole("button", { name: DEMO_START_LABEL })).toBeInTheDocument();
  });

  it("注意書き（24時間後の削除・実在情報を入れないこと）が読める", () => {
    render(<LoginPage />);
    for (const notice of DEMO_LOGIN_NOTICES) {
      expect(screen.getByText(notice)).toBeInTheDocument();
    }
  });

  it("デモのボタンは、パスキーでログインのボタンより前（DOM 順で先）にある（閲覧者の主な入口として目立たせる）", () => {
    render(<LoginPage />);
    const buttons = screen.getAllByRole("button").map((el) => el.textContent);
    const demoIndex = buttons.findIndex((text) => text === DEMO_START_LABEL);
    const passkeyIndex = buttons.findIndex((text) => text?.includes("パスキーでログイン"));
    expect(demoIndex).toBeGreaterThanOrEqual(0);
    expect(passkeyIndex).toBeGreaterThanOrEqual(0);
    expect(demoIndex).toBeLessThan(passkeyIndex);
  });
});
