// src/app/(auth)/recovery/page.tsx の「配線」を検証する。
//
// 期待値の根拠:
// - docs/steps/pub-5.md 設計判断 9
//   「/recovery: コードの入力欄（autocomplete="off"、text-base 以上）と送信ボタン、
//   ログイン画面へのリンク」
// - docs/steps/pub-5.md「この Step の範囲」「コードの入力画面（/recovery）」
//   「この画面は状態を読まず、誰に対しても同じものを出す（ログイン画面と同じ）」

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// actions.ts はサーバー専用の依存（jose 等）を持つため、ページの配線テストでは
// Server Action そのものをモックし、画面の描画だけを見る
vi.mock("@/app/(auth)/recovery/actions", () => ({
  verifyRecoveryCodeAction: vi.fn(),
}));

const { default: RecoveryPage } = await import("@/app/(auth)/recovery/page");

afterEach(() => {
  cleanup();
});

describe("RecoveryPage", () => {
  it("コードの入力フォームが組み込まれている（画面まで結線されていることの確認）", () => {
    render(<RecoveryPage />);
    expect(screen.getByLabelText("リカバリーコード")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "次へ" })).toBeInTheDocument();
  });

  it("見出しがある", () => {
    render(<RecoveryPage />);
    expect(screen.getByRole("heading", { name: "パスキーをなくした場合" })).toBeInTheDocument();
  });

  it("アカウント作成時にコードが表示されたこと・コードを入れると新しいパスキーを登録して戻れることを読める", () => {
    render(<RecoveryPage />);
    expect(screen.getByText(/アカウントを作ったときに表示された/)).toBeInTheDocument();
    expect(screen.getAllByText("リカバリーコード").length).toBeGreaterThan(0);
    expect(screen.getByText(/新しいパスキーを登録して、元のアカウントに戻れます/)).toBeInTheDocument();
  });

  it("ログイン画面へのリンクを持つ（/login）", () => {
    render(<RecoveryPage />);
    const link = screen.getByRole("link", { name: "ログイン画面に戻る" });
    expect(link).toHaveAttribute("href", "/login");
  });

  it("初期表示ではエラーが出ていない", () => {
    render(<RecoveryPage />);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
