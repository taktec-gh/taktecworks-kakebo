// src/app/(auth)/login/passkey-login-button.tsx の描画・操作を検証する。
//
// @simplewebauthn/browser はモックせず、authenticate / supportsWebAuthn / onSuccess
// を props で差し替える（docs/steps/step-7.md「tester への引き継ぎ > 4-3」）。
//
// 期待値の根拠:
// - docs/steps/step-7.md「画面 > /login」「フォームの name/id/ラベル一覧」

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LOGIN_ERROR_MESSAGE } from "@/lib/auth-messages";
import {
  PASSKEY_UNSUPPORTED_MESSAGE,
  PasskeyLoginButton,
} from "@/app/(auth)/login/passkey-login-button";

import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/server";

const OPTIONS: PublicKeyCredentialRequestOptionsJSON = {
  challenge: "CHALLENGE",
  rpId: "localhost",
  userVerification: "required",
  timeout: 60_000,
};

const RESPONSE: AuthenticationResponseJSON = {
  id: "cred-1",
  rawId: "cred-1",
  type: "public-key",
  clientExtensionResults: {},
  response: { clientDataJSON: "e30", authenticatorData: "e30", signature: "e30" },
};

function button(): HTMLButtonElement {
  return screen.getByRole("button", { name: /パスキーでログイン|確認中…/ }) as HTMLButtonElement;
}

afterEach(() => {
  cleanup();
});

describe("初期表示", () => {
  it("対応端末ではボタンが有効で、未対応の案内は出ない", () => {
    render(
      <PasskeyLoginButton
        start={async () => ({ ok: true, options: OPTIONS })}
        verify={async () => ({ ok: true })}
        supportsWebAuthn={() => true}
        onSuccess={() => {}}
      />,
    );
    expect(button()).toBeEnabled();
    expect(screen.queryByText(PASSKEY_UNSUPPORTED_MESSAGE)).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("未対応端末ではボタンが無効になり、案内文が出る（秘密ではないので出してよい）", () => {
    render(
      <PasskeyLoginButton
        start={async () => ({ ok: true, options: OPTIONS })}
        verify={async () => ({ ok: true })}
        supportsWebAuthn={() => false}
        onSuccess={() => {}}
      />,
    );
    expect(button()).toBeDisabled();
    expect(screen.getByText(PASSKEY_UNSUPPORTED_MESSAGE)).toBeInTheDocument();
  });
});

describe("成功パス", () => {
  it("start → authenticate → verify → onSuccess の順で呼ばれる", async () => {
    const order: string[] = [];
    const start = vi.fn(async () => {
      order.push("start");
      return { ok: true as const, options: OPTIONS };
    });
    const authenticate = vi.fn(async () => {
      order.push("authenticate");
      return RESPONSE;
    });
    const verify = vi.fn(async () => {
      order.push("verify");
      return { ok: true as const };
    });
    const onSuccess = vi.fn(() => order.push("onSuccess"));

    render(
      <PasskeyLoginButton
        start={start}
        verify={verify}
        authenticate={authenticate}
        onSuccess={onSuccess}
        supportsWebAuthn={() => true}
      />,
    );

    fireEvent.click(button());

    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
    expect(order).toEqual(["start", "authenticate", "verify", "onSuccess"]);
    expect(verify).toHaveBeenCalledWith(RESPONSE);
  });

  it("押している間はボタンが disabled になり '確認中…' を表示する", async () => {
    let resolveStart!: (value: { ok: true; options: PublicKeyCredentialRequestOptionsJSON }) => void;
    const start = vi.fn(
      () =>
        new Promise<{ ok: true; options: PublicKeyCredentialRequestOptionsJSON }>((resolve) => {
          resolveStart = resolve;
        }),
    );

    render(
      <PasskeyLoginButton
        start={start}
        verify={async () => ({ ok: true })}
        supportsWebAuthn={() => true}
        onSuccess={() => {}}
      />,
    );

    fireEvent.click(button());
    await waitFor(() => expect(screen.getByRole("button")).toHaveTextContent("確認中…"));
    expect(screen.getByRole("button")).toBeDisabled();

    resolveStart({ ok: true, options: OPTIONS });
    await waitFor(() => expect(screen.getByRole("button")).toHaveTextContent("パスキーでログイン"));
  });
});

describe("失敗パス（すべて LOGIN_ERROR_MESSAGE に統一）", () => {
  it("start が失敗を返す", async () => {
    render(
      <PasskeyLoginButton
        start={async () => ({ ok: false, error: LOGIN_ERROR_MESSAGE })}
        verify={async () => ({ ok: true })}
        supportsWebAuthn={() => true}
        onSuccess={() => {}}
      />,
    );
    fireEvent.click(button());
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(LOGIN_ERROR_MESSAGE));
    expect(screen.getByRole("alert")).toHaveAttribute("id", "passkey-login-error");
  });

  it("verify が失敗を返す", async () => {
    render(
      <PasskeyLoginButton
        start={async () => ({ ok: true, options: OPTIONS })}
        verify={async () => ({ ok: false, error: LOGIN_ERROR_MESSAGE })}
        authenticate={async () => RESPONSE}
        supportsWebAuthn={() => true}
        onSuccess={() => {}}
      />,
    );
    fireEvent.click(button());
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(LOGIN_ERROR_MESSAGE));
  });

  it("利用者がブラウザのダイアログを取り消した場合（authenticate が reject）も同じ文言", async () => {
    const onSuccess = vi.fn();
    render(
      <PasskeyLoginButton
        start={async () => ({ ok: true, options: OPTIONS })}
        verify={async () => ({ ok: true })}
        authenticate={() => Promise.reject(new Error("NotAllowedError"))}
        supportsWebAuthn={() => true}
        onSuccess={onSuccess}
      />,
    );
    fireEvent.click(button());
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(LOGIN_ERROR_MESSAGE));
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("失敗理由の文言に技術的な詳細（Error オブジェクトの中身等）を含めない", async () => {
    render(
      <PasskeyLoginButton
        start={async () => ({ ok: true, options: OPTIONS })}
        verify={async () => ({ ok: true })}
        authenticate={() => Promise.reject(new Error("some internal detail"))}
        supportsWebAuthn={() => true}
        onSuccess={() => {}}
      />,
    );
    fireEvent.click(button());
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(screen.getByRole("alert").textContent).not.toContain("internal detail");
  });
});
