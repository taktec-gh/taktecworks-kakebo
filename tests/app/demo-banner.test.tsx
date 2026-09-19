// src/app/demo-banner.tsx の描画を検証する。
//
// 期待値の根拠:
// - docs/steps/pub-3.md 設計判断 9
//   「ダッシュボード: デモユーザーには、上部に『デモアカウントであること』
//    『削除される日時（JST）』『ログアウトすると戻れないこと』を出す」
// - docs/steps/pub-3.md「tester 向けの方針」11「画面」
//   「ダッシュボードのデモ表示（通常ユーザーには出ない）」
//   表示の判定自体（demoExpiresAt が null かどうか）は呼び出し側（src/app/page.tsx）の責務であり、
//   tests/app/page.test.tsx「デモアカウントの表示」で確認済み。ここではコンポーネント単体の描画内容を見る。
// - src/lib/demo-messages.ts の DEMO_LOGOUT_WARNING
//   「ログアウトすると、このデモには戻れません（デモアカウントにはパスキーが無いため）。」

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { DemoBanner } from "@/app/demo-banner";
import { DEMO_LOGOUT_WARNING } from "@/lib/demo-messages";

afterEach(() => {
  cleanup();
});

describe("DemoBanner", () => {
  it("デモアカウントであることを出す", () => {
    render(<DemoBanner expiresAtLabel="2026/8/15 09:00" />);
    expect(screen.getByText("これはデモアカウントです")).toBeInTheDocument();
  });

  it("削除される日時（渡された expiresAtLabel）を出す", () => {
    render(<DemoBanner expiresAtLabel="2026/8/15 09:00" />);
    expect(screen.getByText("2026/8/15 09:00", { exact: false })).toBeInTheDocument();
    expect(screen.getByText(/日本時間/)).toBeInTheDocument();
  });

  it("ログアウトすると戻れないことを出す（DEMO_LOGOUT_WARNING）", () => {
    render(<DemoBanner expiresAtLabel="2026/8/15 09:00" />);
    expect(screen.getByText(DEMO_LOGOUT_WARNING)).toBeInTheDocument();
  });

  it("別の expiresAtLabel を渡せば、その値がそのまま出る（表示はデータ次第。ロジックを内部に持たない）", () => {
    render(<DemoBanner expiresAtLabel="2027/1/1 00:30" />);
    expect(screen.getByText("2027/1/1 00:30", { exact: false })).toBeInTheDocument();
    expect(screen.queryByText("2026/8/15 09:00", { exact: false })).not.toBeInTheDocument();
  });

  it('aria-label="デモアカウント" の section で囲われている（配置・スタイル変更に強い検出単位）', () => {
    render(<DemoBanner expiresAtLabel="2026/8/15 09:00" />);
    expect(screen.getByRole("region", { name: "デモアカウント" })).toBeInTheDocument();
  });
});
