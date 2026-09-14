// src/app/settings/passkeys/passkey-list.tsx の描画・操作を検証する。
//
// 期待値の根拠:
// - docs/steps/step-7.md「画面 > /settings/passkeys」「フォームの name/id/ラベル一覧」
//   （削除は2段階確認、hidden の id、ラベル文言）

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PasskeyList } from "@/app/settings/passkeys/passkey-list";

import type { PasskeyListItem } from "@/app/settings/passkeys/action-state";

function item(overrides: Partial<PasskeyListItem> = {}): PasskeyListItem {
  return {
    id: "cred_1",
    deviceName: "iPhone",
    createdAtLabel: "2026/8/14(金)",
    lastUsedAtLabel: null,
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
});

describe("空の一覧", () => {
  it("1件も無ければ案内文を出す", () => {
    render(<PasskeyList items={[]} deleteAction={async () => ({ error: null })} />);
    expect(screen.getByText("登録された端末はまだありません。下のフォームから登録してください。")).toBeInTheDocument();
  });
});

describe("一覧表示", () => {
  it("端末名・登録日・最終利用日を表示する", () => {
    render(
      <PasskeyList
        items={[item({ lastUsedAtLabel: "2026/8/14(金)" })]}
        deleteAction={async () => ({ error: null })}
      />,
    );
    expect(screen.getByText("iPhone")).toBeInTheDocument();
    expect(screen.getByText("登録 2026/8/14(金)")).toBeInTheDocument();
    expect(screen.getByText("最終利用 2026/8/14(金)")).toBeInTheDocument();
  });

  it("最終利用が null なら「まだ使っていません」", () => {
    render(<PasskeyList items={[item({ lastUsedAtLabel: null })]} deleteAction={async () => ({ error: null })} />);
    expect(screen.getByText("最終利用 まだ使っていません")).toBeInTheDocument();
  });

  it("複数件を全て表示する", () => {
    render(
      <PasskeyList
        items={[item({ id: "a", deviceName: "iPhone" }), item({ id: "b", deviceName: "MacBook" })]}
        deleteAction={async () => ({ error: null })}
      />,
    );
    expect(screen.getByText("iPhone")).toBeInTheDocument();
    expect(screen.getByText("MacBook")).toBeInTheDocument();
  });
});

describe("削除の2段階確認", () => {
  it("1段目は「削除する」ボタンのみで、フォームはまだ出ない", () => {
    render(<PasskeyList items={[item()]} deleteAction={async () => ({ error: null })} />);
    expect(screen.getByRole("button", { name: "削除する" })).toBeInTheDocument();
    expect(screen.queryByText(/を削除します/)).not.toBeInTheDocument();
  });

  it("1段目を押すと確認メッセージと hidden の id を持つフォームが出る", () => {
    render(<PasskeyList items={[item({ id: "cred_1", deviceName: "iPhone" })]} deleteAction={async () => ({ error: null })} />);
    fireEvent.click(screen.getByRole("button", { name: "削除する" }));

    expect(screen.getByText("「iPhone」を削除します。この端末からはログインできなくなります。")).toBeInTheDocument();
    const hidden = document.querySelector('input[name="id"]') as HTMLInputElement;
    expect(hidden).toHaveAttribute("type", "hidden");
    expect(hidden.value).toBe("cred_1");
  });

  it("「やめる」を押すと確認前の表示に戻る", () => {
    render(<PasskeyList items={[item()]} deleteAction={async () => ({ error: null })} />);
    fireEvent.click(screen.getByRole("button", { name: "削除する" }));
    fireEvent.click(screen.getByRole("button", { name: "やめる" }));

    expect(screen.queryByText(/を削除します/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "削除する" })).toBeInTheDocument();
  });

  it("2段目の送信で deleteAction が id を伴って呼ばれる", async () => {
    const deleteAction = vi.fn(async (_prev: { error: string | null }, formData: FormData) => {
      expect(formData.get("id")).toBe("cred_1");
      return { error: null };
    });

    render(<PasskeyList items={[item({ id: "cred_1" })]} deleteAction={deleteAction} />);
    fireEvent.click(screen.getByRole("button", { name: "削除する" }));
    fireEvent.click(screen.getByRole("button", { name: "削除する" }));

    await waitFor(() => expect(deleteAction).toHaveBeenCalledTimes(1));
  });

  it("削除に失敗した場合はエラーメッセージを alert として表示する", async () => {
    const deleteAction = async () => ({ error: "これが最後のパスキーです。削除するとログインできなくなるため、先にもう1台登録してください。" });

    render(<PasskeyList items={[item()]} deleteAction={deleteAction} />);
    fireEvent.click(screen.getByRole("button", { name: "削除する" }));
    fireEvent.click(screen.getByRole("button", { name: "削除する" }));

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "これが最後のパスキーです。削除するとログインできなくなるため、先にもう1台登録してください。",
      ),
    );
  });
});
