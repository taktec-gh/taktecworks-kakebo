// src/app/settings/payment-sources/[id]/payment-source-edit-form.tsx の描画・操作を検証する。
//
// 禁止条件のボタン活性/非活性は props（setDefaultBlockedReason 等）で渡されるため、
// ここでは「渡された理由どおりに表示・活性状態が切り替わること」を確認する
// （実際の判定ロジックは src/lib/payment-sources.ts 側。tests/lib/payment-sources.test.ts で検証済み）。

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PaymentSourceType } from "@/generated/prisma/enums";
import { PaymentSourceEditForm } from "@/app/settings/payment-sources/[id]/payment-source-edit-form";
import type { PaymentSourceFormAction } from "@/app/settings/payment-sources/action-state";

const okAction: PaymentSourceFormAction = () => ({ error: null });

function baseProps() {
  return {
    id: "ps_1",
    name: "Aカード",
    type: PaymentSourceType.CREDIT_CARD,
    isActive: true,
    isDefault: false,
    setDefaultBlockedReason: null,
    deactivateBlockedReason: null,
    deleteBlockedReason: null,
    updateAction: okAction,
    setDefaultAction: okAction,
    setActiveAction: okAction,
    deleteAction: okAction,
  };
}

afterEach(() => {
  cleanup();
});

describe("リネーム / タイプ変更フォーム", () => {
  it("名前・タイプの初期値が渡された値になっている", () => {
    render(<PaymentSourceEditForm {...baseProps()} />);
    expect((screen.getByLabelText("名前") as HTMLInputElement).value).toBe("Aカード");
    expect((screen.getByLabelText("タイプ") as HTMLSelectElement).value).toBe(
      PaymentSourceType.CREDIT_CARD,
    );
  });

  it("保存すると id・name・type が action に渡る", async () => {
    const action = vi.fn((_prev: { error: string | null }, formData: FormData) => ({
      error: null,
    }));
    render(<PaymentSourceEditForm {...baseProps()} updateAction={action} />);

    fireEvent.change(screen.getByLabelText("名前"), { target: { value: "Bカード" } });
    fireEvent.click(screen.getByRole("button", { name: "保存する" }));

    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    const formData = action.mock.calls[0][1];
    expect(formData.get("id")).toBe("ps_1");
    expect(formData.get("name")).toBe("Bカード");
  });

  it("失敗時はエラーが alert で表示される", async () => {
    const action = () => ({ error: "同じ名前の払い出し先がすでに登録されています。" });
    render(<PaymentSourceEditForm {...baseProps()} updateAction={action} />);

    fireEvent.click(screen.getByRole("button", { name: "保存する" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("同じ名前の払い出し先がすでに登録されています。");
  });
});

describe("既定にする", () => {
  it("すでに既定の場合はボタンを出さず、案内文を表示する", () => {
    render(<PaymentSourceEditForm {...baseProps()} isDefault={true} />);
    expect(screen.getByText(/この払い出し先が既定です/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "既定にする" })).not.toBeInTheDocument();
  });

  it("既定でなく、拒否理由が無ければボタンは押せる", () => {
    render(<PaymentSourceEditForm {...baseProps()} isDefault={false} setDefaultBlockedReason={null} />);
    expect(screen.getByRole("button", { name: "既定にする" })).toBeEnabled();
  });

  it("無効な払い出し先は拒否理由とともにボタンが非活性になる", () => {
    const reason = "無効な払い出し先は既定にできません。先に有効に戻してください。";
    render(
      <PaymentSourceEditForm
        {...baseProps()}
        isActive={false}
        isDefault={false}
        setDefaultBlockedReason={reason}
      />,
    );
    expect(screen.getByRole("button", { name: "既定にする" })).toBeDisabled();
    expect(screen.getByText(reason)).toBeInTheDocument();
  });

  it("押すと id を含めて setDefaultAction が呼ばれる", async () => {
    const action = vi.fn((_prev: { error: string | null }, formData: FormData) => ({
      error: null,
    }));
    render(<PaymentSourceEditForm {...baseProps()} isDefault={false} setDefaultAction={action} />);

    fireEvent.click(screen.getByRole("button", { name: "既定にする" }));

    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    expect(action.mock.calls[0][1].get("id")).toBe("ps_1");
  });
});

describe("有効 / 無効の切り替え", () => {
  it("有効なときはボタンのラベルが「無効にする」で、isActive=false を送る", async () => {
    const action = vi.fn((_prev: { error: string | null }, formData: FormData) => ({
      error: null,
    }));
    render(<PaymentSourceEditForm {...baseProps()} isActive={true} setActiveAction={action} />);

    const button = screen.getByRole("button", { name: "無効にする" });
    expect(button).toBeEnabled();
    fireEvent.click(button);

    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    expect(action.mock.calls[0][1].get("isActive")).toBe("false");
    expect(action.mock.calls[0][1].get("id")).toBe("ps_1");
  });

  it("無効なときはボタンのラベルが「有効に戻す」で、isActive=true を送る", async () => {
    const action = vi.fn((_prev: { error: string | null }, formData: FormData) => ({
      error: null,
    }));
    render(
      <PaymentSourceEditForm
        {...baseProps()}
        isActive={false}
        deactivateBlockedReason={null}
        setActiveAction={action}
      />,
    );

    const button = screen.getByRole("button", { name: "有効に戻す" });
    fireEvent.click(button);

    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    expect(action.mock.calls[0][1].get("isActive")).toBe("true");
  });

  it("無効化できない理由がある場合（既定・有効が1件だけ）はボタンが非活性で理由が表示される", () => {
    const reason = "有効な払い出し先が1件だけのため無効にできません。先に別の払い出し先を追加してください。";
    render(
      <PaymentSourceEditForm {...baseProps()} isActive={true} deactivateBlockedReason={reason} />,
    );
    expect(screen.getByRole("button", { name: "無効にする" })).toBeDisabled();
    expect(screen.getByText(reason)).toBeInTheDocument();
  });

  it("有効化のときは deactivateBlockedReason があってもボタンは非活性にならない（有効化の判定に流用しない）", () => {
    const reason = "有効化には関係ないはずの理由";
    render(
      <PaymentSourceEditForm
        {...baseProps()}
        isActive={false}
        deactivateBlockedReason={reason}
      />,
    );
    expect(screen.getByRole("button", { name: "有効に戻す" })).toBeEnabled();
    expect(screen.queryByText(reason)).not.toBeInTheDocument();
  });
});

describe("削除", () => {
  it("拒否理由が無ければ「削除する」ボタンが押せ、押すと確認画面が出る", () => {
    render(<PaymentSourceEditForm {...baseProps()} deleteBlockedReason={null} />);
    const button = screen.getByRole("button", { name: "削除する" });
    expect(button).toBeEnabled();

    fireEvent.click(button);
    expect(screen.getByText(/「Aカード」を削除します。元に戻せません。/)).toBeInTheDocument();
  });

  it("拒否理由がある場合（支出あり等）はボタンが非活性で理由が表示される", () => {
    const reason = "この払い出し先には支出が記録されているため削除できません。無効化してください。";
    render(<PaymentSourceEditForm {...baseProps()} deleteBlockedReason={reason} />);
    expect(screen.getByRole("button", { name: "削除する" })).toBeDisabled();
    expect(screen.getByText(reason)).toBeInTheDocument();
  });

  it("確認画面で「やめる」を押すと確認前の表示に戻る", () => {
    render(<PaymentSourceEditForm {...baseProps()} />);
    fireEvent.click(screen.getByRole("button", { name: "削除する" }));
    fireEvent.click(screen.getByRole("button", { name: "やめる" }));

    expect(screen.queryByText(/元に戻せません/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "削除する" })).toBeInTheDocument();
  });

  it("確認画面で削除を確定すると id を含めて deleteAction が呼ばれる", async () => {
    const action = vi.fn((_prev: { error: string | null }, formData: FormData) => ({
      error: null,
    }));
    render(<PaymentSourceEditForm {...baseProps()} deleteAction={action} />);

    fireEvent.click(screen.getByRole("button", { name: "削除する" }));
    fireEvent.click(screen.getByRole("button", { name: "削除する" }));

    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    expect(action.mock.calls[0][1].get("id")).toBe("ps_1");
  });

  it("削除に失敗した場合はエラーが alert で表示される", async () => {
    const action = () => ({
      error: "この払い出し先には予算が設定されているため削除できません。無効化してください。",
    });
    render(<PaymentSourceEditForm {...baseProps()} deleteAction={action} />);

    fireEvent.click(screen.getByRole("button", { name: "削除する" }));
    fireEvent.click(screen.getByRole("button", { name: "削除する" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      "この払い出し先には予算が設定されているため削除できません。無効化してください。",
    );
  });
});

// 退行テスト: docs/steps/fix-form-reset-select.md（コミット 617e6cb）。
//
// React 19 の <form action={関数}> は完了時に必ず form.reset() を実行し、<select> の
// defaultSelected はマウント時にしか書かれないため、対策なしだと「タイプを変えて保存 →
// もう一度保存」で送信内容が古い値（マウント時の値）に巻き戻る。
// 2回目の送信の FormData を見ないとこの不具合は再現しないため、すべてのケースで
// 2回目の送信内容を検証する。
describe("<select> のリセット対策（フォーム自動リセットでの巻き戻り防止）", () => {
  it("失敗パス: タイプを変更 → 保存失敗 → 名前だけ直して再送信しても、変更後のタイプが送られる", async () => {
    const seen: string[] = [];
    const action = (_prev: { error: string | null }, formData: FormData) => {
      seen.push(String(formData.get("type")));
      return { error: "同じ名前の払い出し先がすでに登録されています。" };
    };
    render(
      <PaymentSourceEditForm
        {...baseProps()}
        type={PaymentSourceType.CREDIT_CARD}
        updateAction={action}
      />,
    );

    fireEvent.change(screen.getByLabelText("タイプ"), {
      target: { value: PaymentSourceType.BANK_DEBIT },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存する" }));
    await waitFor(() => expect(seen.length).toBe(1));
    expect(seen[0]).toBe(PaymentSourceType.BANK_DEBIT);

    fireEvent.change(screen.getByLabelText("名前"), { target: { value: "別の名前" } });
    fireEvent.click(screen.getByRole("button", { name: "保存する" }));
    await waitFor(() => expect(seen.length).toBe(2));

    // 根拠: action はエラーを返しているだけで完了はしているため reset() は走る。
    // 利用者はタイプを変え直していないので、2回目も直前に選んだ BANK_DEBIT が
    // 送られるべき（マウント時の CREDIT_CARD に巻き戻ってはいけない）。
    expect(seen[1]).toBe(PaymentSourceType.BANK_DEBIT);
  });

  it("成功パス: タイプを変更して保存 → 新しい props が来る → 名前だけ直して再送信すると新しいタイプが送られる", async () => {
    const seen: string[] = [];
    const action = (_prev: { error: string | null }, formData: FormData) => {
      seen.push(String(formData.get("type")));
      return { error: null };
    };
    const { rerender } = render(
      <PaymentSourceEditForm
        {...baseProps()}
        type={PaymentSourceType.CREDIT_CARD}
        updateAction={action}
      />,
    );

    fireEvent.change(screen.getByLabelText("タイプ"), {
      target: { value: PaymentSourceType.BANK_DEBIT },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存する" }));
    await waitFor(() => expect(seen.length).toBe(1));

    // サーバーで保存され、新しい type が props として返ってきた状況を rerender で再現
    rerender(
      <PaymentSourceEditForm
        {...baseProps()}
        type={PaymentSourceType.BANK_DEBIT}
        updateAction={action}
      />,
    );

    fireEvent.change(screen.getByLabelText("名前"), { target: { value: "別の名前" } });
    fireEvent.click(screen.getByRole("button", { name: "保存する" }));
    await waitFor(() => expect(seen.length).toBe(2));

    // 根拠: 1回目の保存で BANK_DEBIT が確定し、props も BANK_DEBIT に更新された。
    // 名前だけ変えて再送信しても BANK_DEBIT が送られ続けるべき。
    expect(seen[1]).toBe(PaymentSourceType.BANK_DEBIT);
  });

  it("送信せず rerender で type だけ変えると、<select> の表示値が新しい props に追従する", () => {
    const { rerender } = render(
      <PaymentSourceEditForm {...baseProps()} type={PaymentSourceType.CREDIT_CARD} />,
    );
    expect((screen.getByLabelText("タイプ") as HTMLSelectElement).value).toBe(
      PaymentSourceType.CREDIT_CARD,
    );

    rerender(<PaymentSourceEditForm {...baseProps()} type={PaymentSourceType.BANK_DEBIT} />);

    // 根拠: サーバーから新しい props が来たら <select> はそれに追従すべき
    // （修正前は defaultValue だけだったため、マウント後の props 変化を反映しなかった）。
    expect((screen.getByLabelText("タイプ") as HTMLSelectElement).value).toBe(
      PaymentSourceType.BANK_DEBIT,
    );
  });
});
