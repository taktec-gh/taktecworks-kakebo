// src/app/(auth)/signup/signup-form.tsx の描画・操作を検証する。
//
// start/finish/register/supportsWebAuthn/onSuccess を props で差し替える
// （docs/steps/step-7.md「tester への引き継ぎ > 4-3」と同じ方針。
// tests/app/settings/passkeys/passkey-register-form.test.tsx と同型）。
//
// 期待値の根拠:
// - docs/steps/pub-2.md 設計判断 6「画面」
//   「サインアップの失敗理由は出してよい」「端末の名前の入力欄を置く」
//   「ブラウザが WebAuthn 非対応ならボタンを無効にして理由を出す」
//   「成功したら / へ通常のナビゲーションで移動する」
//   「入力欄は text-base 以上（iOS の拡大を避ける）」

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RECOVERY_CODE_CONFIRM_LABEL } from "@/components/recovery-code-display";
import { PASSKEY_ERRORS } from "@/lib/passkey-messages";
import { SIGNUP_ERRORS } from "@/lib/signup-messages";
import {
  SIGNUP_CONTINUE_LABEL,
  SIGNUP_UNSUPPORTED_MESSAGE,
  SignupForm,
} from "@/app/(auth)/signup/signup-form";

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
  return screen.getByRole("button", {
    name: /パスキーでアカウントを作る|作成中…/,
  }) as HTMLButtonElement;
}

afterEach(() => {
  cleanup();
});

describe("初期表示", () => {
  it("端末の名前欄がある（id/name/maxLength、text-base 以上で iOS の拡大を避ける）", () => {
    render(
      <SignupForm
        start={async () => ({ ok: true, options: OPTIONS })}
        finish={async () => ({ ok: true, recoveryCode: "K7Q2M-9XP4H-TR8WN-B3D6F" })}
        supportsWebAuthn={() => true}
      />,
    );
    const input = nameInput();
    expect(input).toHaveAttribute("id", "signup-device-name");
    expect(input).toHaveAttribute("name", "deviceName");
    expect(input.className).toContain("text-base");
  });

  it("未対応端末ではボタンが無効になり案内が出る", () => {
    render(
      <SignupForm
        start={async () => ({ ok: true, options: OPTIONS })}
        finish={async () => ({ ok: true, recoveryCode: "K7Q2M-9XP4H-TR8WN-B3D6F" })}
        supportsWebAuthn={() => false}
      />,
    );
    expect(submitButton()).toBeDisabled();
    expect(screen.getByText(SIGNUP_UNSUPPORTED_MESSAGE)).toBeInTheDocument();
  });

  it("対応端末ではボタンが有効で、未対応の案内・エラーが出ていない", () => {
    render(
      <SignupForm
        start={async () => ({ ok: true, options: OPTIONS })}
        finish={async () => ({ ok: true, recoveryCode: "K7Q2M-9XP4H-TR8WN-B3D6F" })}
        supportsWebAuthn={() => true}
      />,
    );
    expect(submitButton()).toBeEnabled();
    expect(screen.queryByText(SIGNUP_UNSUPPORTED_MESSAGE)).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("端末名の空チェック（生体認証を出す前にクライアント側で弾く）", () => {
  it("空のまま送信すると deviceNameRequired を出し、start を呼ばない", async () => {
    const start = vi.fn(async () => ({ ok: true as const, options: OPTIONS }));
    render(
      <SignupForm start={start} finish={async () => ({ ok: true, recoveryCode: "K7Q2M-9XP4H-TR8WN-B3D6F" })} supportsWebAuthn={() => true} />,
    );

    fireEvent.click(submitButton());

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(PASSKEY_ERRORS.deviceNameRequired),
    );
    expect(start).not.toHaveBeenCalled();
  });

  it("空白のみでも同様に弾く", async () => {
    const start = vi.fn(async () => ({ ok: true as const, options: OPTIONS }));
    render(
      <SignupForm start={start} finish={async () => ({ ok: true, recoveryCode: "K7Q2M-9XP4H-TR8WN-B3D6F" })} supportsWebAuthn={() => true} />,
    );
    fireEvent.change(nameInput(), { target: { value: "   " } });
    fireEvent.click(submitButton());

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(PASSKEY_ERRORS.deviceNameRequired),
    );
    expect(start).not.toHaveBeenCalled();
  });
});

describe("成功パス", () => {
  // docs/steps/pub-5.md 設計判断 3「成功の戻り値で平文のコードを返し、サインアップ画面が
  // コードの表示に切り替わる。『控えました』の確認（チェックボックスなど）の後に / へ移る」
  // 引き継ぎ: 「SignupForm の onSuccess は『控えました』の後」。
  // registerの直後に onSuccess を呼ばないこと・コードの表示を経ること・
  // 「控えました」にチェックするまで先へ進めないことを、この1本で確かめる。
  it("start → register → finish の後はコードの表示に切り替わり、『控えました』にチェックして進むまで onSuccess を呼ばない", async () => {
    const order: string[] = [];
    const start = vi.fn(async () => {
      order.push("start");
      return { ok: true as const, options: OPTIONS };
    });
    const register = vi.fn(async () => {
      order.push("register");
      return RESPONSE;
    });
    const finish = vi.fn(async (_response, deviceName: string) => {
      order.push(`finish:${deviceName}`);
      return { ok: true as const, recoveryCode: "K7Q2M-9XP4H-TR8WN-B3D6F" };
    });
    const onSuccess = vi.fn(() => order.push("onSuccess"));

    render(
      <SignupForm
        start={start}
        finish={finish}
        register={register}
        onSuccess={onSuccess}
        supportsWebAuthn={() => true}
      />,
    );

    fireEvent.change(nameInput(), { target: { value: "iPhone" } });
    fireEvent.click(submitButton());

    // finish の直後はコードの表示に切り替わり、まだ onSuccess は呼ばれない
    const confirmCheckbox = await screen.findByLabelText(RECOVERY_CODE_CONFIRM_LABEL);
    expect(order).toEqual(["start", "register", "finish:iPhone"]);
    expect(onSuccess).not.toHaveBeenCalled();
    expect(screen.getByTestId("recovery-code")).toHaveTextContent("K7Q2M-9XP4H-TR8WN-B3D6F");

    // 「控えました」の前は進むボタンが disabled
    const continueButton = screen.getByRole("button", { name: SIGNUP_CONTINUE_LABEL });
    expect(continueButton).toBeDisabled();

    fireEvent.click(confirmCheckbox);
    expect(continueButton).toBeEnabled();
    fireEvent.click(continueButton);

    expect(order).toEqual(["start", "register", "finish:iPhone", "onSuccess"]);
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(finish).toHaveBeenCalledWith(RESPONSE, "iPhone");
  });

  it("送信中はボタンが disabled になり「作成中…」を表示する", async () => {
    let resolveStart!: (value: { ok: true; options: PublicKeyCredentialCreationOptionsJSON }) => void;
    const start = vi.fn(
      () =>
        new Promise<{ ok: true; options: PublicKeyCredentialCreationOptionsJSON }>((resolve) => {
          resolveStart = resolve;
        }),
    );

    render(
      <SignupForm
        start={start}
        finish={async () => ({ ok: true, recoveryCode: "K7Q2M-9XP4H-TR8WN-B3D6F" })}
        supportsWebAuthn={() => true}
        onSuccess={() => {}}
      />,
    );

    fireEvent.change(nameInput(), { target: { value: "iPhone" } });
    fireEvent.click(submitButton());
    await waitFor(() => expect(screen.getByRole("button")).toHaveTextContent("作成中…"));
    expect(screen.getByRole("button")).toBeDisabled();

    resolveStart({ ok: true, options: OPTIONS });
    await waitFor(() =>
      expect(screen.getByRole("button")).toHaveTextContent("パスキーでアカウントを作る"),
    );
  });
});

describe("失敗パス（サインアップは理由を出してよい。docs/steps/pub-2.md 設計判断 6）", () => {
  it("start が失敗を返す（例: レート制限）", async () => {
    render(
      <SignupForm
        start={async () => ({ ok: false, error: SIGNUP_ERRORS.rateLimited })}
        finish={async () => ({ ok: true, recoveryCode: "K7Q2M-9XP4H-TR8WN-B3D6F" })}
        supportsWebAuthn={() => true}
      />,
    );
    fireEvent.change(nameInput(), { target: { value: "iPhone" } });
    fireEvent.click(submitButton());

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(SIGNUP_ERRORS.rateLimited),
    );
  });

  it("finish が失敗を返す（例: duplicate）", async () => {
    render(
      <SignupForm
        start={async () => ({ ok: true, options: OPTIONS })}
        finish={async () => ({ ok: false, error: SIGNUP_ERRORS.duplicate })}
        register={async () => RESPONSE}
        supportsWebAuthn={() => true}
      />,
    );
    fireEvent.change(nameInput(), { target: { value: "iPhone" } });
    fireEvent.click(submitButton());

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(SIGNUP_ERRORS.duplicate),
    );
  });

  it("register が reject（利用者の取り消し等）した場合は SIGNUP_ERRORS.verificationFailed を出す", async () => {
    render(
      <SignupForm
        start={async () => ({ ok: true, options: OPTIONS })}
        finish={async () => ({ ok: true, recoveryCode: "K7Q2M-9XP4H-TR8WN-B3D6F" })}
        register={() => Promise.reject(new Error("NotAllowedError"))}
        supportsWebAuthn={() => true}
      />,
    );
    fireEvent.change(nameInput(), { target: { value: "iPhone" } });
    fireEvent.click(submitButton());

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(SIGNUP_ERRORS.verificationFailed),
    );
  });

  it("失敗理由の文言に技術的な詳細（Error オブジェクトの中身等）を含めない", async () => {
    render(
      <SignupForm
        start={async () => ({ ok: true, options: OPTIONS })}
        finish={async () => ({ ok: true, recoveryCode: "K7Q2M-9XP4H-TR8WN-B3D6F" })}
        register={() => Promise.reject(new Error("some internal stack trace detail"))}
        supportsWebAuthn={() => true}
      />,
    );
    fireEvent.change(nameInput(), { target: { value: "iPhone" } });
    fireEvent.click(submitButton());

    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(screen.getByRole("alert").textContent).not.toContain("internal stack trace");
  });
});
