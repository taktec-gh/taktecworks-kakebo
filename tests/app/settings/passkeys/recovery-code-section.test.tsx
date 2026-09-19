// src/app/settings/passkeys/recovery-code-section.tsx の描画・操作を検証する。
//
// 期待値の根拠:
// - docs/steps/pub-5.md 設計判断 8「設定画面でコードを作り直せる」
//   「/settings/passkeys に『リカバリーコード』の欄を置く: 発行済みか
//   （recoveryCodeHash の有無）と、『作り直す』ボタン」「作り直すと古いコードは使えなくなる」
// - docs/steps/pub-5.md「実装完了後の引き継ぎ」
//   「RecoveryCodeSection({ hasCode, regenerate })」

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  RECOVERY_CREATE_LABEL,
  RECOVERY_REGENERATE_CANCEL_LABEL,
  RECOVERY_REGENERATE_CONFIRM_LABEL,
  RECOVERY_REGENERATE_CONFIRM_MESSAGE,
  RECOVERY_REGENERATE_DONE_LABEL,
  RECOVERY_REGENERATE_LABEL,
  RECOVERY_SECTION_HEADING,
  RECOVERY_STATUS_ISSUED,
  RECOVERY_STATUS_NOT_ISSUED,
  RecoveryCodeSection,
} from "@/app/settings/passkeys/recovery-code-section";
import { RECOVERY_REGENERATE_ERRORS } from "@/lib/recovery-messages";

afterEach(() => {
  cleanup();
});

describe("表示（発行済みかどうか）", () => {
  it("見出しを出す", () => {
    render(<RecoveryCodeSection hasCode={true} regenerate={async () => ({ ok: true, recoveryCode: "X" })} />);
    expect(screen.getByText(RECOVERY_SECTION_HEADING)).toBeInTheDocument();
  });

  it("発行済み（hasCode: true）なら「発行済みです」と「作り直す」ボタンを出す", () => {
    render(<RecoveryCodeSection hasCode={true} regenerate={async () => ({ ok: true, recoveryCode: "X" })} />);
    expect(screen.getByText(RECOVERY_STATUS_ISSUED)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: RECOVERY_REGENERATE_LABEL })).toBeInTheDocument();
  });

  it("未発行（hasCode: false）なら「まだありません」と「作る」ボタンを出す", () => {
    render(<RecoveryCodeSection hasCode={false} regenerate={async () => ({ ok: true, recoveryCode: "X" })} />);
    expect(screen.getByText(RECOVERY_STATUS_NOT_ISSUED)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: RECOVERY_CREATE_LABEL })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: RECOVERY_REGENERATE_LABEL })).not.toBeInTheDocument();
  });
});

describe("作り直し（発行済み: ボタンの後に確認を1回挟む）", () => {
  it("「作り直す」を押すと確認メッセージと確定・やめるボタンが出る（まだ呼ばれない）", () => {
    const regenerate = vi.fn(async () => ({ ok: true as const, recoveryCode: "NEW-CODE" }));
    render(<RecoveryCodeSection hasCode={true} regenerate={regenerate} />);

    fireEvent.click(screen.getByRole("button", { name: RECOVERY_REGENERATE_LABEL }));

    expect(screen.getByText(RECOVERY_REGENERATE_CONFIRM_MESSAGE)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: RECOVERY_REGENERATE_CONFIRM_LABEL })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: RECOVERY_REGENERATE_CANCEL_LABEL })).toBeInTheDocument();
    expect(regenerate).not.toHaveBeenCalled();
  });

  it("「やめる」を押すと確認が閉じ、regenerate は呼ばれない", () => {
    const regenerate = vi.fn(async () => ({ ok: true as const, recoveryCode: "NEW-CODE" }));
    render(<RecoveryCodeSection hasCode={true} regenerate={regenerate} />);

    fireEvent.click(screen.getByRole("button", { name: RECOVERY_REGENERATE_LABEL }));
    fireEvent.click(screen.getByRole("button", { name: RECOVERY_REGENERATE_CANCEL_LABEL }));

    expect(screen.queryByText(RECOVERY_REGENERATE_CONFIRM_MESSAGE)).not.toBeInTheDocument();
    expect(regenerate).not.toHaveBeenCalled();
  });

  it("確認後に確定を押すと regenerate が呼ばれ、成功すれば新しいコードを表示する", async () => {
    const regenerate = vi.fn(async () => ({ ok: true as const, recoveryCode: "NEW-CODE-1" }));
    render(<RecoveryCodeSection hasCode={true} regenerate={regenerate} />);

    fireEvent.click(screen.getByRole("button", { name: RECOVERY_REGENERATE_LABEL }));
    fireEvent.click(screen.getByRole("button", { name: RECOVERY_REGENERATE_CONFIRM_LABEL }));

    await waitFor(() => expect(screen.getByTestId("recovery-code")).toHaveTextContent("NEW-CODE-1"));
    expect(regenerate).toHaveBeenCalledTimes(1);
  });

  it("新しいコードの表示は「控えました」の後まで進めない（RecoveryCodeDisplay と同じ挙動）", async () => {
    const regenerate = vi.fn(async () => ({ ok: true as const, recoveryCode: "NEW-CODE-1" }));
    render(<RecoveryCodeSection hasCode={true} regenerate={regenerate} />);

    fireEvent.click(screen.getByRole("button", { name: RECOVERY_REGENERATE_LABEL }));
    fireEvent.click(screen.getByRole("button", { name: RECOVERY_REGENERATE_CONFIRM_LABEL }));

    await waitFor(() => expect(screen.getByTestId("recovery-code")).toBeInTheDocument());
    const doneButton = screen.getByRole("button", { name: RECOVERY_REGENERATE_DONE_LABEL });
    expect(doneButton).toBeDisabled();
  });

  it("「控えました」の後に閉じるボタンを押すと、通常表示（発行済み）に戻る", async () => {
    const regenerate = vi.fn(async () => ({ ok: true as const, recoveryCode: "NEW-CODE-1" }));
    render(<RecoveryCodeSection hasCode={true} regenerate={regenerate} />);

    fireEvent.click(screen.getByRole("button", { name: RECOVERY_REGENERATE_LABEL }));
    fireEvent.click(screen.getByRole("button", { name: RECOVERY_REGENERATE_CONFIRM_LABEL }));
    await waitFor(() => expect(screen.getByTestId("recovery-code")).toBeInTheDocument());

    const confirmCheckbox = screen.getByRole("checkbox");
    fireEvent.click(confirmCheckbox);
    fireEvent.click(screen.getByRole("button", { name: RECOVERY_REGENERATE_DONE_LABEL }));

    expect(screen.queryByTestId("recovery-code")).not.toBeInTheDocument();
    expect(screen.getByText(RECOVERY_STATUS_ISSUED)).toBeInTheDocument();
  });

  it("失敗すれば文言を出し、コード表示には切り替わらない", async () => {
    const regenerate = vi.fn(async () => ({
      ok: false as const,
      error: RECOVERY_REGENERATE_ERRORS.unavailable,
    }));
    render(<RecoveryCodeSection hasCode={true} regenerate={regenerate} />);

    fireEvent.click(screen.getByRole("button", { name: RECOVERY_REGENERATE_LABEL }));
    fireEvent.click(screen.getByRole("button", { name: RECOVERY_REGENERATE_CONFIRM_LABEL }));

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(RECOVERY_REGENERATE_ERRORS.unavailable),
    );
    expect(screen.queryByTestId("recovery-code")).not.toBeInTheDocument();
  });

  it("regenerate が例外を投げても unavailable を表示する", async () => {
    const regenerate = vi.fn(async () => {
      throw new Error("network error");
    });
    render(<RecoveryCodeSection hasCode={true} regenerate={regenerate} />);

    fireEvent.click(screen.getByRole("button", { name: RECOVERY_REGENERATE_LABEL }));
    fireEvent.click(screen.getByRole("button", { name: RECOVERY_REGENERATE_CONFIRM_LABEL }));

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(RECOVERY_REGENERATE_ERRORS.unavailable),
    );
  });
});

describe("作り直し（未発行: 確認を挟まず即座に作る）", () => {
  it("未発行のとき「作る」を押すと確認を挟まず regenerate が呼ばれる", async () => {
    const regenerate = vi.fn(async () => ({ ok: true as const, recoveryCode: "FIRST-CODE" }));
    render(<RecoveryCodeSection hasCode={false} regenerate={regenerate} />);

    fireEvent.click(screen.getByRole("button", { name: RECOVERY_CREATE_LABEL }));

    await waitFor(() => expect(regenerate).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(RECOVERY_REGENERATE_CONFIRM_MESSAGE)).not.toBeInTheDocument();
  });
});
