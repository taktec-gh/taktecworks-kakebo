// src/app/settings/payment-sources/payment-source-create-form.tsx の描画・操作を検証する。

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PaymentSourceType } from "@/generated/prisma/enums";
import { PAYMENT_SOURCE_NAME_MAX_LENGTH } from "@/lib/payment-source-validation";
import { PaymentSourceCreateForm } from "@/app/settings/payment-sources/payment-source-create-form";

const ERROR_MESSAGE = "名前を入力してください。";

const failingAction = () => ({ error: ERROR_MESSAGE });

function nameInput(): HTMLInputElement {
  return screen.getByLabelText("名前") as HTMLInputElement;
}

function typeSelect(): HTMLSelectElement {
  return screen.getByLabelText("タイプ") as HTMLSelectElement;
}

function submitButton(): HTMLButtonElement {
  return screen.getByRole("button") as HTMLButtonElement;
}

afterEach(() => {
  cleanup();
});

describe("初期表示", () => {
  it("名前・タイプの入力欄がある", () => {
    render(<PaymentSourceCreateForm action={failingAction} />);
    expect(nameInput()).toBeInTheDocument();
    expect(typeSelect()).toBeInTheDocument();
  });

  it("名前欄の name 属性・maxLength が仕様どおり", () => {
    render(<PaymentSourceCreateForm action={failingAction} />);
    expect(nameInput().name).toBe("name");
    expect(nameInput()).toHaveAttribute("maxLength", String(PAYMENT_SOURCE_NAME_MAX_LENGTH));
  });

  it("タイプの選択肢は現金・クレジットカード・銀行引き落としの3件（features.md の記載順）", () => {
    render(<PaymentSourceCreateForm action={failingAction} />);
    const options = screen.getAllByRole("option").map((o) => o.textContent);
    expect(options).toEqual(["現金", "クレジットカード", "銀行引き落とし"]);
  });

  it("タイプの既定選択は「現金」（先頭の選択肢）", () => {
    render(<PaymentSourceCreateForm action={failingAction} />);
    expect(typeSelect().value).toBe(PaymentSourceType.CASH);
  });

  it("エラーは表示されていない", () => {
    render(<PaymentSourceCreateForm action={failingAction} />);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("送信ボタンは押せる状態", () => {
    render(<PaymentSourceCreateForm action={failingAction} />);
    expect(submitButton()).toBeEnabled();
  });
});

describe("送信", () => {
  it("入力した名前とタイプが FormData として action に渡る", async () => {
    const action = vi.fn((_prev: { error: string | null }, formData: FormData) => ({
      error: null,
    }));
    render(<PaymentSourceCreateForm action={action} />);

    fireEvent.change(nameInput(), { target: { value: "Aカード" } });
    fireEvent.change(typeSelect(), { target: { value: PaymentSourceType.CREDIT_CARD } });
    fireEvent.click(submitButton());

    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    const formData = action.mock.calls[0][1];
    expect(formData.get("name")).toBe("Aカード");
    expect(formData.get("type")).toBe(PaymentSourceType.CREDIT_CARD);
  });
});

describe("失敗時の表示", () => {
  it("エラーメッセージが role=alert で表示される", async () => {
    render(<PaymentSourceCreateForm action={failingAction} />);
    fireEvent.click(submitButton());

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(ERROR_MESSAGE);
  });

  it("入力欄に aria-invalid が付く", async () => {
    render(<PaymentSourceCreateForm action={failingAction} />);
    fireEvent.click(submitButton());

    await screen.findByRole("alert");
    expect(nameInput()).toHaveAttribute("aria-invalid", "true");
  });
});

describe("送信中", () => {
  it("ボタンが「追加中…」になり無効化され、完了すると戻る", async () => {
    let resolveAction: (state: { error: string | null }) => void = () => {};
    const action = () =>
      new Promise<{ error: string | null }>((resolve) => {
        resolveAction = resolve;
      });

    render(<PaymentSourceCreateForm action={action} />);
    fireEvent.click(submitButton());

    await waitFor(() => expect(submitButton()).toBeDisabled());
    expect(submitButton()).toHaveTextContent("追加中…");

    resolveAction({ error: null });

    await waitFor(() => expect(submitButton()).toBeEnabled());
    expect(submitButton()).toHaveTextContent("追加する");
  });
});

// 退行テスト: docs/steps/fix-form-reset-select.md（コミット 617e6cb）。
//
// React 19 の <form action={関数}> は完了時に必ず form.reset() を実行し、<select> の
// defaultSelected はマウント時にしか書かれないため、対策なしだと「先頭以外のタイプを選んで
// 追加に失敗 → 名前だけ直して再送信」で2回目のタイプが先頭の選択肢（CASH）に巻き戻る。
// 2回目の送信の FormData を見ないとこの不具合は再現しないため、2回目の送信内容を検証する。
//
// 「追加に成功したあと <select> が先頭に戻る」テストは書かない（指示書で意図的な挙動と確定済み）。
describe("<select> のリセット対策（フォーム自動リセットでの巻き戻り防止）", () => {
  it("失敗パス: 先頭以外のタイプを選んで送信失敗 → 名前だけ直して再送信しても、選んだタイプが送られる", async () => {
    const seen: string[] = [];
    const action = (_prev: { error: string | null }, formData: FormData) => {
      seen.push(String(formData.get("type")));
      return { error: ERROR_MESSAGE };
    };
    render(<PaymentSourceCreateForm action={action} />);

    fireEvent.change(nameInput(), { target: { value: "C銀行" } });
    fireEvent.change(typeSelect(), { target: { value: PaymentSourceType.BANK_DEBIT } });
    fireEvent.click(submitButton());
    await waitFor(() => expect(seen.length).toBe(1));
    expect(seen[0]).toBe(PaymentSourceType.BANK_DEBIT);

    // 根拠: action はエラーを返しているだけで完了はしているため reset() は走る。
    // <select> の表示も、選んだ BANK_DEBIT のままであるべき（先頭の CASH に戻ってはいけない）。
    expect(typeSelect().value).toBe(PaymentSourceType.BANK_DEBIT);

    fireEvent.change(nameInput(), { target: { value: "C銀行(訂正)" } });
    fireEvent.click(submitButton());
    await waitFor(() => expect(seen.length).toBe(2));

    // 根拠: 利用者はタイプを選び直していないので、2回目も BANK_DEBIT が送られるべき
    // （マウント時の先頭の選択肢 CASH に巻き戻ってはいけない）。
    expect(seen[1]).toBe(PaymentSourceType.BANK_DEBIT);
  });
});
