// src/app/(auth)/recovery/recovery-code-form.tsx の描画・操作を検証する。
//
// 期待値の根拠:
// - docs/steps/pub-5.md 設計判断 9
//   「/recovery: コードの入力欄（autocomplete="off"、text-base 以上）と送信ボタン、
//   ログイン画面へのリンク」
// - docs/steps/pub-5.md「実装完了後の引き継ぎ」
//   「RecoveryCodeForm({ verify })」

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  RecoveryCodeForm,
  RECOVERY_CODE_INPUT_LABEL,
  RECOVERY_CODE_SUBMIT_LABEL,
} from "@/app/(auth)/recovery/recovery-code-form";
import {
  RECOVERY_CODE_FIELD_NAME,
  RECOVERY_ERRORS,
  type RecoveryCodeFormState,
} from "@/lib/recovery-messages";

function input(): HTMLInputElement {
  return screen.getByLabelText(RECOVERY_CODE_INPUT_LABEL) as HTMLInputElement;
}

function submitButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: new RegExp(`${RECOVERY_CODE_SUBMIT_LABEL}|確認中…`) }) as HTMLButtonElement;
}

afterEach(() => {
  cleanup();
});

describe("初期表示", () => {
  it("入力欄は autocomplete=off、text-base 以上、name は RECOVERY_CODE_FIELD_NAME", () => {
    render(<RecoveryCodeForm verify={async (prev) => prev} />);
    const el = input();
    expect(el).toHaveAttribute("autocomplete", "off");
    expect(el).toHaveAttribute("name", RECOVERY_CODE_FIELD_NAME);
    expect(el.className).toContain("text-base");
  });

  it("初期表示ではエラーが出ていない", () => {
    render(<RecoveryCodeForm verify={async (prev) => prev} />);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("送信ボタンがある", () => {
    render(<RecoveryCodeForm verify={async (prev) => prev} />);
    expect(screen.getByRole("button", { name: RECOVERY_CODE_SUBMIT_LABEL })).toBeInTheDocument();
  });
});

describe("入力", () => {
  it("入力した値が state に反映される（React 19 のフォーム自動リセットで打ち直しにならないように）", () => {
    render(<RecoveryCodeForm verify={async (prev) => prev} />);
    fireEvent.change(input(), { target: { value: "K7Q2M-9XP4H-TR8WN-B3D6F" } });
    expect(input().value).toBe("K7Q2M-9XP4H-TR8WN-B3D6F");
  });
});

describe("送信失敗", () => {
  it("verify が error を返せば alert として出す", async () => {
    const verify = vi.fn(async () => ({ error: RECOVERY_ERRORS.invalidCode }));
    render(<RecoveryCodeForm verify={verify} />);
    fireEvent.change(input(), { target: { value: "WRONG-CODE" } });
    fireEvent.click(submitButton());

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(RECOVERY_ERRORS.invalidCode),
    );
  });

  it("verify には入力したコードを含む FormData を渡す", async () => {
    const verify = vi.fn(async (_prev: RecoveryCodeFormState, _formData: FormData) => ({
      error: RECOVERY_ERRORS.invalidCode,
    }));
    render(<RecoveryCodeForm verify={verify} />);
    fireEvent.change(input(), { target: { value: "K7Q2M-9XP4H-TR8WN-B3D6F" } });
    fireEvent.click(submitButton());

    await waitFor(() => expect(verify).toHaveBeenCalledTimes(1));
    const formData = verify.mock.calls[0][1] as FormData;
    expect(formData.get(RECOVERY_CODE_FIELD_NAME)).toBe("K7Q2M-9XP4H-TR8WN-B3D6F");
  });

  it("失敗理由の文言に技術的な詳細を含めない（RECOVERY_ERRORS.invalidCode はそもそも一般的な文言）", async () => {
    const verify = vi.fn(async () => ({ error: RECOVERY_ERRORS.invalidCode }));
    render(<RecoveryCodeForm verify={verify} />);
    fireEvent.click(submitButton());

    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    for (const leak of ["Error", "prisma", "AUTH_SECRET"]) {
      expect(screen.getByRole("alert").textContent).not.toContain(leak);
    }
  });
});
