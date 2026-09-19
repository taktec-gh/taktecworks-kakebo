// src/components/recovery-code-display.tsx の描画・操作を検証する。
// copy/canCopy は props で差し替える（navigator.clipboard に触れない。
// tests/app/(auth)/signup/signup-form.test.tsx と同型の方針）。
//
// 期待値の根拠:
// - docs/steps/pub-5.md 設計判断 3
//   「表示では: コードは等幅で読みやすく、コピーのボタンを置く。『この画面を閉じると二度と
//   表示されない』『パスキーを全部なくしたときに使う』『なくした場合は設定から作り直せる』
//   ことを書く」
// - docs/steps/pub-5.md「実装完了後の引き継ぎ」
//   「RecoveryCodeDisplay({ code, lead?, notice?, continueLabel, onContinue, copy?, canCopy? })。
//   コードは [data-testid="recovery-code"]。『控えました』のチェックまで先へ進むボタンが disabled」
// - docs/steps/pub-5.md「tester 向けの方針」10「完了表示で『控えました』まで遷移しない、コピー」

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  RECOVERY_CODE_CONFIRM_LABEL,
  RECOVERY_CODE_COPIED_MESSAGE,
  RECOVERY_CODE_COPY_FAILED_MESSAGE,
  RECOVERY_CODE_COPY_LABEL,
  RECOVERY_CODE_HEADING,
  RECOVERY_CODE_NOTICES,
  RecoveryCodeDisplay,
} from "@/components/recovery-code-display";

const CODE = "K7Q2M-9XP4H-TR8WN-B3D6F";
const CONTINUE_LABEL = "つぎへ";

afterEach(() => {
  cleanup();
});

describe("表示内容", () => {
  it("見出しとコードを表示する（[data-testid=\"recovery-code\"]）", () => {
    render(
      <RecoveryCodeDisplay
        code={CODE}
        continueLabel={CONTINUE_LABEL}
        onContinue={() => {}}
        canCopy={() => false}
      />,
    );
    expect(screen.getByText(RECOVERY_CODE_HEADING)).toBeInTheDocument();
    expect(screen.getByTestId("recovery-code")).toHaveTextContent(CODE);
  });

  it("lead・notice を渡せば表示する", () => {
    render(
      <RecoveryCodeDisplay
        code={CODE}
        lead="アカウントを作りました。"
        notice="なくした端末のパスキーは、設定から削除してください。"
        continueLabel={CONTINUE_LABEL}
        onContinue={() => {}}
        canCopy={() => false}
      />,
    );
    expect(screen.getByText("アカウントを作りました。")).toBeInTheDocument();
    expect(
      screen.getByText("なくした端末のパスキーは、設定から削除してください。"),
    ).toBeInTheDocument();
  });

  it("lead・notice が無ければ出さない（クラッシュしない）", () => {
    render(
      <RecoveryCodeDisplay
        code={CODE}
        continueLabel={CONTINUE_LABEL}
        onContinue={() => {}}
        canCopy={() => false}
      />,
    );
    expect(screen.queryByText("アカウントを作りました。")).not.toBeInTheDocument();
  });

  it("必須の注意書き（画面を閉じると二度と表示されない・パスキーを全部なくしたとき・作り直せる）を出す", () => {
    render(
      <RecoveryCodeDisplay
        code={CODE}
        continueLabel={CONTINUE_LABEL}
        onContinue={() => {}}
        canCopy={() => false}
      />,
    );
    for (const notice of RECOVERY_CODE_NOTICES) {
      expect(screen.getByText(notice)).toBeInTheDocument();
    }
    // 内容の要点も確認する（文言の定数を書き換えられても意図が伝わる形になっているか）
    expect(screen.getByText(/二度と表示されません/)).toBeInTheDocument();
    expect(screen.getByText(/パスキーを登録した端末をすべてなくしたとき/)).toBeInTheDocument();
    expect(screen.getByText(/設定 > パスキー」から作り直せます/)).toBeInTheDocument();
  });

  it("continueLabel をボタンの文言に使う", () => {
    render(
      <RecoveryCodeDisplay
        code={CODE}
        continueLabel="家計簿をはじめる"
        onContinue={() => {}}
        canCopy={() => false}
      />,
    );
    expect(screen.getByRole("button", { name: "家計簿をはじめる" })).toBeInTheDocument();
  });
});

describe("「控えました」までは先へ進めない（tester 向けの方針 10）", () => {
  it("初期状態では進むボタンが disabled", () => {
    render(
      <RecoveryCodeDisplay
        code={CODE}
        continueLabel={CONTINUE_LABEL}
        onContinue={() => {}}
        canCopy={() => false}
      />,
    );
    expect(screen.getByRole("button", { name: CONTINUE_LABEL })).toBeDisabled();
  });

  it("チェックすると有効になり、押すと onContinue が呼ばれる", () => {
    const onContinue = vi.fn();
    render(
      <RecoveryCodeDisplay
        code={CODE}
        continueLabel={CONTINUE_LABEL}
        onContinue={onContinue}
        canCopy={() => false}
      />,
    );
    fireEvent.click(screen.getByLabelText(RECOVERY_CODE_CONFIRM_LABEL));
    const button = screen.getByRole("button", { name: CONTINUE_LABEL });
    expect(button).toBeEnabled();

    fireEvent.click(button);
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it("チェックを外すと再び disabled になり、onContinue は呼ばれない", () => {
    const onContinue = vi.fn();
    render(
      <RecoveryCodeDisplay
        code={CODE}
        continueLabel={CONTINUE_LABEL}
        onContinue={onContinue}
        canCopy={() => false}
      />,
    );
    const checkbox = screen.getByLabelText(RECOVERY_CODE_CONFIRM_LABEL);
    fireEvent.click(checkbox); // チェック
    fireEvent.click(checkbox); // 外す

    const button = screen.getByRole("button", { name: CONTINUE_LABEL });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(onContinue).not.toHaveBeenCalled();
  });
});

describe("コピー", () => {
  it("canCopy が true ならコピーのボタンを出す", () => {
    render(
      <RecoveryCodeDisplay
        code={CODE}
        continueLabel={CONTINUE_LABEL}
        onContinue={() => {}}
        copy={async () => {}}
        canCopy={() => true}
      />,
    );
    expect(screen.getByRole("button", { name: RECOVERY_CODE_COPY_LABEL })).toBeInTheDocument();
  });

  it("canCopy が false ならコピーのボタンを出さない（使えない環境で押しても動かないボタンを出さない）", () => {
    render(
      <RecoveryCodeDisplay
        code={CODE}
        continueLabel={CONTINUE_LABEL}
        onContinue={() => {}}
        canCopy={() => false}
      />,
    );
    expect(screen.queryByRole("button", { name: RECOVERY_CODE_COPY_LABEL })).not.toBeInTheDocument();
  });

  it("コピーに成功したら、渡した copy にコードを渡し、成功メッセージを出す", async () => {
    const copy = vi.fn(async () => {});
    render(
      <RecoveryCodeDisplay
        code={CODE}
        continueLabel={CONTINUE_LABEL}
        onContinue={() => {}}
        copy={copy}
        canCopy={() => true}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: RECOVERY_CODE_COPY_LABEL }));

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(RECOVERY_CODE_COPIED_MESSAGE));
    expect(copy).toHaveBeenCalledWith(CODE);
  });

  it("コピーに失敗したら（reject）、失敗を伝える文言を出す", async () => {
    const copy = vi.fn(async () => {
      throw new Error("clipboard denied");
    });
    render(
      <RecoveryCodeDisplay
        code={CODE}
        continueLabel={CONTINUE_LABEL}
        onContinue={() => {}}
        copy={copy}
        canCopy={() => true}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: RECOVERY_CODE_COPY_LABEL }));

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(RECOVERY_CODE_COPY_FAILED_MESSAGE),
    );
  });

  it("失敗の文言に技術的な詳細（Error の中身）を含めない", async () => {
    const copy = vi.fn(async () => {
      throw new Error("some internal stack trace detail");
    });
    render(
      <RecoveryCodeDisplay
        code={CODE}
        continueLabel={CONTINUE_LABEL}
        onContinue={() => {}}
        copy={copy}
        canCopy={() => true}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: RECOVERY_CODE_COPY_LABEL }));

    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(screen.getByRole("alert").textContent).not.toContain("internal stack trace");
  });
});
