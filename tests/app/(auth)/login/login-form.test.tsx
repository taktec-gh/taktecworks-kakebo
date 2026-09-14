import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LoginForm } from "@/app/(auth)/login/login-form";
import { initialLoginState, type LoginState } from "@/app/(auth)/login/login-state";

const ERROR_MESSAGE = "ログインできませんでした。パスワードを確認してください。";

/** 常に失敗する Server Action のスタブ */
const failingAction = () => ({ error: ERROR_MESSAGE });
/** 常に成功する（＝エラーなし）スタブ。実物は redirect するのでここでは戻り値なしを模す */
const succeedingAction = () => ({ error: null });

function passwordInput(): HTMLInputElement {
  return screen.getByLabelText("パスワード") as HTMLInputElement;
}

function submitButton(): HTMLButtonElement {
  return screen.getByRole("button") as HTMLButtonElement;
}

afterEach(() => {
  cleanup();
});

describe("初期表示", () => {
  it("パスワード入力欄がラベルから取得できる", () => {
    render(<LoginForm action={failingAction} />);
    const input = passwordInput();
    expect(input).toBeInTheDocument();
    expect(input.name).toBe("password");
  });

  it("入力値が画面に見えないよう type=password になっている", () => {
    render(<LoginForm action={failingAction} />);
    expect(passwordInput()).toHaveAttribute("type", "password");
  });

  it("パスワード以外の入力欄（ユーザー名など）は無い。利用者は1人なのでパスワードのみ", () => {
    const { container } = render(<LoginForm action={failingAction} />);
    const inputs = container.querySelectorAll("input");
    expect(inputs).toHaveLength(1);
  });

  it("エラーは表示されていない", () => {
    render(<LoginForm action={failingAction} />);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(passwordInput()).not.toHaveAttribute("aria-invalid");
    expect(passwordInput()).not.toHaveAttribute("aria-describedby");
  });

  it("送信ボタンのラベルは「ログイン」で、押せる状態", () => {
    render(<LoginForm action={failingAction} />);
    expect(submitButton()).toHaveTextContent("ログイン");
    expect(submitButton()).toHaveAttribute("type", "submit");
    expect(submitButton()).toBeEnabled();
  });
});

describe("送信", () => {
  it("入力したパスワードが FormData の password として action に渡る", async () => {
    const action = vi.fn((_prev: LoginState, formData: FormData) => ({
      error: String(formData.get("password")),
    }));
    render(<LoginForm action={action} />);

    fireEvent.change(passwordInput(), { target: { value: "ひみつの合言葉" } });
    fireEvent.click(submitButton());

    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    expect(action.mock.calls[0][1].get("password")).toBe("ひみつの合言葉");
  });

  it("action には前回の状態が渡る", async () => {
    const action = vi.fn((_prev: LoginState) => ({ error: ERROR_MESSAGE }));
    render(<LoginForm action={action} />);

    fireEvent.click(submitButton());
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    expect(action.mock.calls[0][0]).toEqual(initialLoginState);

    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    fireEvent.click(submitButton());
    await waitFor(() => expect(action).toHaveBeenCalledTimes(2));
    expect(action.mock.calls[1][0]).toEqual({ error: ERROR_MESSAGE });
  });

  it("パスワード未入力でも action は呼ばれる（判定はサーバ側の責務）", async () => {
    const action = vi.fn(() => ({ error: ERROR_MESSAGE }));
    render(<LoginForm action={action} />);
    fireEvent.click(submitButton());
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
  });
});

describe("失敗時の表示", () => {
  it("エラーメッセージが role=alert で表示される", async () => {
    render(<LoginForm action={failingAction} />);
    fireEvent.click(submitButton());

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(ERROR_MESSAGE);
    expect(alert).toHaveAttribute("id", "login-error");
  });

  it("入力欄に aria-invalid と aria-describedby が付く", async () => {
    render(<LoginForm action={failingAction} />);
    fireEvent.click(submitButton());

    await screen.findByRole("alert");
    expect(passwordInput()).toHaveAttribute("aria-invalid", "true");
    expect(passwordInput()).toHaveAttribute("aria-describedby", "login-error");
  });

  it("エラーが解消されると alert が消える", async () => {
    const action = vi.fn<(prev: LoginState, formData: FormData) => LoginState>();
    action.mockReturnValueOnce({ error: ERROR_MESSAGE }).mockReturnValueOnce({ error: null });
    render(<LoginForm action={action} />);

    fireEvent.click(submitButton());
    await screen.findByRole("alert");

    fireEvent.click(submitButton());
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(passwordInput()).not.toHaveAttribute("aria-invalid");
  });

  it("成功（error: null）ではエラーを出さない", async () => {
    const action = vi.fn(succeedingAction);
    render(<LoginForm action={action} />);
    fireEvent.click(submitButton());
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("送信中", () => {
  it("ボタンが「確認中…」になり無効化され、完了すると戻る", async () => {
    let resolveAction: (state: LoginState) => void = () => {};
    const action = () =>
      new Promise<LoginState>((resolve) => {
        resolveAction = resolve;
      });

    render(<LoginForm action={action} />);
    fireEvent.click(submitButton());

    await waitFor(() => expect(submitButton()).toBeDisabled());
    expect(submitButton()).toHaveTextContent("確認中…");

    resolveAction({ error: ERROR_MESSAGE });

    await waitFor(() => expect(submitButton()).toBeEnabled());
    expect(submitButton()).toHaveTextContent("ログイン");
  });
});
