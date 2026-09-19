import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

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
});
