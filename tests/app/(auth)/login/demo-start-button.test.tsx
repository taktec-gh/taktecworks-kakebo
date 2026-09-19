// src/app/(auth)/login/demo-start-button.tsx の描画・操作を検証する。
//
// 期待値の根拠:
// - docs/steps/pub-3.md 設計判断 9
//   「ログイン画面: 「デモで試す（登録不要）」ボタンを置く」
//   「ボタンの近くに『24時間後に自動で削除されること』『実在の家計情報を入力しないでほしいこと』を短く出す」
// - docs/steps/pub-3.md「tester 向けの方針」11「画面」
//   「ログイン画面のボタンと注意書き」
// - src/lib/demo-messages.ts
//   DEMO_START_LABEL = "デモで試す（登録不要）"
//   DEMO_LOGIN_NOTICES（24時間後の削除・実在情報を入れないことの2件）

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DemoStartButton } from "@/app/(auth)/login/demo-start-button";
import {
  DEMO_ERRORS,
  DEMO_LOGIN_NOTICES,
  DEMO_START_LABEL,
} from "@/lib/demo-messages";

function button(): HTMLButtonElement {
  return screen.getByRole("button", { name: new RegExp(`${DEMO_START_LABEL}|デモを準備中…`) }) as HTMLButtonElement;
}

afterEach(() => {
  cleanup();
});

describe("初期表示", () => {
  it("ボタンの文言は DEMO_START_LABEL", () => {
    render(<DemoStartButton start={async () => ({ error: null })} />);
    expect(screen.getByRole("button", { name: DEMO_START_LABEL })).toBeInTheDocument();
  });

  it("注意書き（24時間後の削除・実在情報を入れないこと）がすべて出る", () => {
    render(<DemoStartButton start={async () => ({ error: null })} />);
    for (const notice of DEMO_LOGIN_NOTICES) {
      expect(screen.getByText(notice)).toBeInTheDocument();
    }
    expect(DEMO_LOGIN_NOTICES.length).toBeGreaterThanOrEqual(2);
  });

  it("初期表示ではエラーが出ていない", () => {
    render(<DemoStartButton start={async () => ({ error: null })} />);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("入力欄を持たない（デモの入口は何も受け取らない。設計判断3）", () => {
    render(<DemoStartButton start={async () => ({ error: null })} />);
    expect(screen.queryAllByRole("textbox")).toHaveLength(0);
  });
});

describe("押下時の挙動", () => {
  it("押すと start（Server Action）が呼ばれる", async () => {
    const start = vi.fn(async () => ({ error: null }));
    render(<DemoStartButton start={start} />);
    fireEvent.click(button());
    await waitFor(() => expect(start).toHaveBeenCalledTimes(1));
  });

  it("押している間はボタンが disabled になり「デモを準備中…」を表示する", async () => {
    let resolveStart!: (value: { error: string | null }) => void;
    const start = vi.fn(
      () =>
        new Promise<{ error: string | null }>((resolve) => {
          resolveStart = resolve;
        }),
    );
    render(<DemoStartButton start={start} />);

    fireEvent.click(button());
    await waitFor(() => expect(screen.getByRole("button")).toHaveTextContent("デモを準備中…"));
    expect(screen.getByRole("button")).toBeDisabled();

    resolveStart({ error: null });
    await waitFor(() => expect(screen.getByRole("button")).toHaveTextContent(DEMO_START_LABEL));
  });

  it("失敗（レート制限）なら文言を alert で出す", async () => {
    render(<DemoStartButton start={async () => ({ error: DEMO_ERRORS.rateLimited })} />);
    fireEvent.click(button());
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(DEMO_ERRORS.rateLimited),
    );
  });

  it("失敗（サーバー内部事情）なら unavailable の文言を出す", async () => {
    render(<DemoStartButton start={async () => ({ error: DEMO_ERRORS.unavailable })} />);
    fireEvent.click(button());
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(DEMO_ERRORS.unavailable),
    );
  });
});
