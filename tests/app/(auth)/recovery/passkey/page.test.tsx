// src/app/(auth)/recovery/passkey/page.tsx の「配線」を検証する。
// getRecoverySession を差し替える（tests/app/(auth)/signup/page.test.tsx と同じ方針。
// async Server Component なので `await RecoveryPasskeyPage()` してから render する）。
//
// 期待値の根拠:
// - docs/steps/pub-5.md 設計判断 5
//   「/recovery/passkey（公開パス。ただしリカバリー用トークンが無ければ /recovery へ）」
// - docs/steps/pub-5.md「実装完了後の引き継ぎ」
//   「/signup と /recovery/passkey のページは、Server Action の後の再描画（next-action
//   ヘッダあり）のときだけ redirect しない」
// - docs/steps/pub-5.md「tester 向けの方針」10
//   「/recovery/passkey はトークンが無ければ /recovery へ」

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const getRecoverySessionMock = vi.fn();
vi.mock("@/lib/recovery-session", () => ({
  getRecoverySession: () => getRecoverySessionMock(),
}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT;${url}`);
  },
}));
// actions.ts はサーバー専用の依存を持つため、ページの配線テストでは Server Action をモックする
vi.mock("@/app/(auth)/recovery/actions", () => ({
  startRecoveryPasskeyRegistrationAction: vi.fn(),
  finishRecoveryPasskeyRegistrationAction: vi.fn(),
}));

// isServerActionRerender（src/lib/server-action-request.ts）が読む next-action ヘッダ。
// 既定では「再描画ではない」（ヘッダ無し）
let nextActionHeader: string | null = null;
vi.mock("next/headers", () => ({
  headers: async () => new Headers(nextActionHeader ? { "next-action": nextActionHeader } : {}),
}));

const { default: RecoveryPasskeyPage } = await import("@/app/(auth)/recovery/passkey/page");

afterEach(() => {
  cleanup();
  getRecoverySessionMock.mockReset();
  nextActionHeader = null;
});

describe("リカバリー用トークンが無い場合", () => {
  it("/recovery へ redirect する", async () => {
    getRecoverySessionMock.mockResolvedValue(null);
    await expect(RecoveryPasskeyPage()).rejects.toThrow("NEXT_REDIRECT;/recovery");
  });

  it("ただし Server Action の後の再描画（next-action ヘッダあり）では redirect しない（一度しか表示しないコードの表示を消さないため）", async () => {
    getRecoverySessionMock.mockResolvedValue(null);
    nextActionHeader = "some-action-id";
    const element = await RecoveryPasskeyPage();
    render(element);
    expect(screen.getByRole("heading", { name: "新しいパスキーの登録" })).toBeInTheDocument();
  });
});

describe("リカバリー用トークンがある場合", () => {
  it("redirect せず、登録フォームが組み込まれている（画面まで結線されていることの確認）", async () => {
    getRecoverySessionMock.mockResolvedValue({
      userId: "user_1",
      codeHash: "a".repeat(64),
      iat: 0,
      exp: 600,
    });
    const element = await RecoveryPasskeyPage();
    render(element);
    expect(screen.getByLabelText("この端末の名前")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /この端末を登録/ })).toBeInTheDocument();
  });

  it("リカバリーコードを確認したこと・登録が終わるまでコードは使われないことを読める", async () => {
    getRecoverySessionMock.mockResolvedValue({
      userId: "user_1",
      codeHash: "a".repeat(64),
      iat: 0,
      exp: 600,
    });
    const element = await RecoveryPasskeyPage();
    render(element);
    expect(screen.getByText(/リカバリーコードを確認しました/)).toBeInTheDocument();
    expect(screen.getByText(/登録が終わるまで、リカバリーコードは使われません/)).toBeInTheDocument();
  });

  it("/recovery へのリンク（コードを入力し直す）を持つ", async () => {
    getRecoverySessionMock.mockResolvedValue({
      userId: "user_1",
      codeHash: "a".repeat(64),
      iat: 0,
      exp: 600,
    });
    const element = await RecoveryPasskeyPage();
    render(element);
    const link = screen.getByRole("link", { name: "リカバリーコードを入力し直す" });
    expect(link).toHaveAttribute("href", "/recovery");
  });
});
