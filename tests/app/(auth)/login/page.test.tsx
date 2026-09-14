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
  it("ログインフォームが組み込まれている（画面まで結線されていることの確認）", () => {
    render(<LoginPage />);
    expect(screen.getByLabelText("パスワード")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "ログイン" })).toBeInTheDocument();
  });

  it("初期表示ではエラーが出ていない", () => {
    render(<LoginPage />);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("パスキーでログインボタンが主動線として組み込まれている（Step 7）", () => {
    render(<LoginPage />);
    expect(screen.getByRole("button", { name: /パスキーでログイン/ })).toBeInTheDocument();
  });

  it("パスワードでログインは既定で折りたたまれている（<details> は開いていない）", () => {
    render(<LoginPage />);
    const details = screen.getByText("パスワードでログイン").closest("details");
    expect(details).not.toBeNull();
    expect(details).not.toHaveAttribute("open");
    // 折りたたまれていても DOM には存在する（JavaScript 無しでも開けるようにするため）
    expect(screen.getByLabelText("パスワード")).toBeInTheDocument();
  });
});
