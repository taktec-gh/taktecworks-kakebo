// src/app/settings/passkeys/passkey-register-form.tsx の描画・操作を検証する。
//
// register/start/finish/supportsWebAuthn を props で差し替える
// （docs/steps/step-7.md「tester への引き継ぎ > 4-3」）。
//
// 期待値の根拠:
// - docs/steps/step-7.md「フォームの name/id/ラベル一覧」
// - docs/steps/step-7.md「画面 > /settings/passkeys」

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PASSKEY_ERRORS } from "@/lib/passkey-messages";
import {
  PASSKEY_REGISTERED_MESSAGE,
  PASSKEY_UNSUPPORTED_MESSAGE,
  PasskeyRegisterForm,
} from "@/app/settings/passkeys/passkey-register-form";

import type {
  PublicKeyCredentialCreationOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";

const OPTIONS: PublicKeyCredentialCreationOptionsJSON = {
  challenge: "CHALLENGE",
  rp: { name: "家計簿", id: "localhost" },
  user: { id: "dXNlcg", name: "owner", displayName: "" },
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
  return screen.getByLabelText("端末の名前") as HTMLInputElement;
}

function submitButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: /この端末を登録|登録中…/ }) as HTMLButtonElement;
}

afterEach(() => {
  cleanup();
});

describe("初期表示", () => {
  it("端末の名前欄がある（id/name/maxLength）", () => {
    render(
      <PasskeyRegisterForm
        start={async () => ({ ok: true, options: OPTIONS })}
        finish={async () => ({ ok: true })}
        supportsWebAuthn={() => true}
      />,
    );
    const input = nameInput();
    expect(input).toHaveAttribute("id", "deviceName");
    expect(input).toHaveAttribute("name", "deviceName");
    expect(input).toHaveAttribute("maxLength", "30");
    expect(input).toHaveAttribute("placeholder", "iPhone");
  });

  it("未対応端末ではボタンが無効になり案内が出る", () => {
    render(
      <PasskeyRegisterForm
        start={async () => ({ ok: true, options: OPTIONS })}
        finish={async () => ({ ok: true })}
        supportsWebAuthn={() => false}
      />,
    );
    expect(submitButton()).toBeDisabled();
    expect(screen.getByText(PASSKEY_UNSUPPORTED_MESSAGE)).toBeInTheDocument();
  });
});

describe("端末名の空チェック（生体認証を出す前にクライアント側で弾く）", () => {
  it("空のまま送信すると deviceNameRequired を出し、start を呼ばない", async () => {
    const start = vi.fn(async () => ({ ok: true as const, options: OPTIONS }));
    render(
      <PasskeyRegisterForm start={start} finish={async () => ({ ok: true })} supportsWebAuthn={() => true} />,
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
      <PasskeyRegisterForm start={start} finish={async () => ({ ok: true })} supportsWebAuthn={() => true} />,
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
  it("start → register → finish の順で呼ばれ、完了メッセージを出して名前欄をクリアする", async () => {
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
      return { ok: true as const };
    });

    render(
      <PasskeyRegisterForm
        start={start}
        finish={finish}
        register={register}
        supportsWebAuthn={() => true}
      />,
    );

    fireEvent.change(nameInput(), { target: { value: "iPhone" } });
    fireEvent.click(submitButton());

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(PASSKEY_REGISTERED_MESSAGE));
    expect(order).toEqual(["start", "register", "finish:iPhone"]);
    expect(finish).toHaveBeenCalledWith(RESPONSE, "iPhone");
    expect(nameInput().value).toBe("");
  });
});

describe("失敗パス", () => {
  it("start が失敗を返す（例: configMissing）", async () => {
    render(
      <PasskeyRegisterForm
        start={async () => ({ ok: false, error: PASSKEY_ERRORS.configMissing })}
        finish={async () => ({ ok: true })}
        supportsWebAuthn={() => true}
      />,
    );
    fireEvent.change(nameInput(), { target: { value: "iPhone" } });
    fireEvent.click(submitButton());

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(PASSKEY_ERRORS.configMissing),
    );
  });

  it("finish が失敗を返す（例: duplicate）", async () => {
    render(
      <PasskeyRegisterForm
        start={async () => ({ ok: true, options: OPTIONS })}
        finish={async () => ({ ok: false, error: PASSKEY_ERRORS.duplicate })}
        register={async () => RESPONSE}
        supportsWebAuthn={() => true}
      />,
    );
    fireEvent.change(nameInput(), { target: { value: "iPhone" } });
    fireEvent.click(submitButton());

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(PASSKEY_ERRORS.duplicate),
    );
  });

  it("register が reject（利用者の取り消し等）した場合は verificationFailed を出す", async () => {
    render(
      <PasskeyRegisterForm
        start={async () => ({ ok: true, options: OPTIONS })}
        finish={async () => ({ ok: true })}
        register={() => Promise.reject(new Error("NotAllowedError"))}
        supportsWebAuthn={() => true}
      />,
    );
    fireEvent.change(nameInput(), { target: { value: "iPhone" } });
    fireEvent.click(submitButton());

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(PASSKEY_ERRORS.verificationFailed),
    );
  });
});
