// src/app/(auth)/recovery/passkey/recovery-passkey-form.tsx の描画・操作を検証する。
// tests/app/(auth)/signup/signup-form.test.tsx と同型（start/register/finish/onComplete/
// supportsWebAuthn を props で差し替える）。
//
// 期待値の根拠:
// - docs/steps/pub-5.md 設計判断 4
//   「成功したらリカバリー用トークンを消し、通常のセッションを発行し、新しいコードを
//   一度だけ表示する（設計判断 3 と同じ画面の部品を使ってよい）。『控えました』の後に / へ」
//   「表示では『なくした端末のパスキーは、設定 > パスキー から削除してください』と伝える
//   （設計判断 7）」

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RECOVERY_CODE_CONFIRM_LABEL } from "@/components/recovery-code-display";
import { PASSKEY_ERRORS } from "@/lib/passkey-messages";
import { RECOVERY_ERRORS } from "@/lib/recovery-messages";
import {
  RECOVERY_CONTINUE_LABEL,
  RECOVERY_OLD_PASSKEY_NOTICE,
  RECOVERY_PASSKEY_UNSUPPORTED_MESSAGE,
  RecoveryPasskeyForm,
} from "@/app/(auth)/recovery/passkey/recovery-passkey-form";

import type {
  PublicKeyCredentialCreationOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";

const OPTIONS: PublicKeyCredentialCreationOptionsJSON = {
  challenge: "CHALLENGE",
  rp: { name: "家計簿", id: "localhost" },
  user: { id: "dXNlcg", name: "家計簿 #TEST", displayName: "家計簿 #TEST" },
  pubKeyCredParams: [],
};

const RESPONSE: RegistrationResponseJSON = {
  id: "cred-1",
  rawId: "cred-1",
  type: "public-key",
  clientExtensionResults: {},
  response: { clientDataJSON: "e30", attestationObject: "e30", transports: ["internal"] },
};

function nameInput(): HTMLInputElement {
  return screen.getByLabelText("この端末の名前") as HTMLInputElement;
}

function submitButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: /この端末を登録|登録中…/ }) as HTMLButtonElement;
}

afterEach(() => {
  cleanup();
});

describe("初期表示", () => {
  it("端末の名前欄がある", () => {
    render(
      <RecoveryPasskeyForm
        start={async () => ({ ok: true, options: OPTIONS })}
        finish={async () => ({ ok: true, recoveryCode: "X" })}
        supportsWebAuthn={() => true}
      />,
    );
    expect(nameInput()).toHaveAttribute("id", "recovery-device-name");
  });

  it("未対応端末ではボタンが無効になり案内が出る", () => {
    render(
      <RecoveryPasskeyForm
        start={async () => ({ ok: true, options: OPTIONS })}
        finish={async () => ({ ok: true, recoveryCode: "X" })}
        supportsWebAuthn={() => false}
      />,
    );
    expect(submitButton()).toBeDisabled();
    expect(screen.getByText(RECOVERY_PASSKEY_UNSUPPORTED_MESSAGE)).toBeInTheDocument();
  });
});

describe("成功パス（新しいコードの表示を経てから onComplete。docs/steps/pub-5.md 設計判断 4）", () => {
  it("start → register → finish の後はコードの表示に切り替わり、『控えました』にチェックして進むまで onComplete を呼ばない", async () => {
    const order: string[] = [];
    const start = vi.fn(async () => {
      order.push("start");
      return { ok: true as const, options: OPTIONS };
    });
    const register = vi.fn(async () => {
      order.push("register");
      return RESPONSE;
    });
    const finish = vi.fn(async () => {
      order.push("finish");
      return { ok: true as const, recoveryCode: "NEW-CODE-1" };
    });
    const onComplete = vi.fn(() => order.push("onComplete"));

    render(
      <RecoveryPasskeyForm
        start={start}
        finish={finish}
        register={register}
        onComplete={onComplete}
        supportsWebAuthn={() => true}
      />,
    );

    fireEvent.change(nameInput(), { target: { value: "iPhone" } });
    fireEvent.click(submitButton());

    const checkbox = await screen.findByLabelText(RECOVERY_CODE_CONFIRM_LABEL);
    expect(order).toEqual(["start", "register", "finish"]);
    expect(onComplete).not.toHaveBeenCalled();
    expect(screen.getByTestId("recovery-code")).toHaveTextContent("NEW-CODE-1");
    // 古いパスキーは自動で消さない案内（設計判断 7）
    expect(screen.getByText(RECOVERY_OLD_PASSKEY_NOTICE)).toBeInTheDocument();

    const continueButton = screen.getByRole("button", { name: RECOVERY_CONTINUE_LABEL });
    expect(continueButton).toBeDisabled();

    fireEvent.click(checkbox);
    fireEvent.click(continueButton);

    expect(order).toEqual(["start", "register", "finish", "onComplete"]);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });
});

describe("失敗パス", () => {
  it("start が失敗を返す（例: sessionExpired）", async () => {
    render(
      <RecoveryPasskeyForm
        start={async () => ({ ok: false, error: RECOVERY_ERRORS.sessionExpired })}
        finish={async () => ({ ok: true, recoveryCode: "X" })}
        supportsWebAuthn={() => true}
      />,
    );
    fireEvent.change(nameInput(), { target: { value: "iPhone" } });
    fireEvent.click(submitButton());

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(RECOVERY_ERRORS.sessionExpired),
    );
  });

  it("finish が失敗を返す（例: duplicate）。コードの表示には切り替わらない", async () => {
    render(
      <RecoveryPasskeyForm
        start={async () => ({ ok: true, options: OPTIONS })}
        finish={async () => ({ ok: false, error: RECOVERY_ERRORS.duplicate })}
        register={async () => RESPONSE}
        supportsWebAuthn={() => true}
      />,
    );
    fireEvent.change(nameInput(), { target: { value: "iPhone" } });
    fireEvent.click(submitButton());

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(RECOVERY_ERRORS.duplicate),
    );
    expect(screen.queryByTestId("recovery-code")).not.toBeInTheDocument();
  });

  it("register が reject（生体認証の取り消し等）した場合は RECOVERY_ERRORS.verificationFailed を出す", async () => {
    render(
      <RecoveryPasskeyForm
        start={async () => ({ ok: true, options: OPTIONS })}
        finish={async () => ({ ok: true, recoveryCode: "X" })}
        register={() => Promise.reject(new Error("NotAllowedError"))}
        supportsWebAuthn={() => true}
      />,
    );
    fireEvent.change(nameInput(), { target: { value: "iPhone" } });
    fireEvent.click(submitButton());

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(RECOVERY_ERRORS.verificationFailed),
    );
  });

  it("端末名が空のまま送信すると deviceNameRequired を出し、start を呼ばない", async () => {
    const start = vi.fn(async () => ({ ok: true as const, options: OPTIONS }));
    render(
      <RecoveryPasskeyForm
        start={start}
        finish={async () => ({ ok: true, recoveryCode: "X" })}
        supportsWebAuthn={() => true}
      />,
    );
    fireEvent.click(submitButton());

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(PASSKEY_ERRORS.deviceNameRequired),
    );
    expect(start).not.toHaveBeenCalled();
  });
});
