// src/app/settings/payment-sources/payment-source-row.tsx の描画・操作を検証する。

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PaymentSourceType } from "@/generated/prisma/enums";
import { PaymentSourceRow } from "@/app/settings/payment-sources/payment-source-row";
import { paymentSourceDetailPath } from "@/app/settings/payment-sources/action-state";

afterEach(() => {
  cleanup();
});

function baseProps() {
  return {
    id: "ps_1",
    name: "Aカード",
    type: PaymentSourceType.CREDIT_CARD,
    isActive: true,
    isDefault: false,
    canMoveUp: true,
    canMoveDown: true,
  };
}

describe("表示", () => {
  it("名前・タイプラベルを表示し、詳細ページへのリンクになっている", () => {
    render(<PaymentSourceRow {...baseProps()} moveAction={() => ({ error: null })} />);
    const link = screen.getByRole("link", { name: /Aカード/ });
    expect(link).toHaveAttribute("href", paymentSourceDetailPath("ps_1"));
    expect(screen.getByText("クレジットカード")).toBeInTheDocument();
  });

  it("既定バッジは isDefault=true のときだけ表示される", () => {
    const { rerender } = render(
      <PaymentSourceRow {...baseProps()} isDefault={false} moveAction={() => ({ error: null })} />,
    );
    expect(screen.queryByText("既定")).not.toBeInTheDocument();

    rerender(
      <PaymentSourceRow {...baseProps()} isDefault={true} moveAction={() => ({ error: null })} />,
    );
    expect(screen.getByText("既定")).toBeInTheDocument();
  });

  it("無効バッジは isActive=false のときだけ表示される", () => {
    const { rerender } = render(
      <PaymentSourceRow {...baseProps()} isActive={true} moveAction={() => ({ error: null })} />,
    );
    expect(screen.queryByText("無効")).not.toBeInTheDocument();

    rerender(
      <PaymentSourceRow {...baseProps()} isActive={false} moveAction={() => ({ error: null })} />,
    );
    expect(screen.getByText("無効")).toBeInTheDocument();
  });

  it("canMoveUp/canMoveDown が false のとき対応するボタンが非活性になる", () => {
    render(
      <PaymentSourceRow
        {...baseProps()}
        canMoveUp={false}
        canMoveDown={false}
        moveAction={() => ({ error: null })}
      />,
    );
    expect(screen.getByRole("button", { name: "Aカード を上へ移動" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Aカード を下へ移動" })).toBeDisabled();
  });

  it("エラーが無ければ alert は表示されない", () => {
    render(<PaymentSourceRow {...baseProps()} moveAction={() => ({ error: null })} />);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("並べ替え操作", () => {
  it("「上へ」を押すと id と direction=up を含めて action が呼ばれる", async () => {
    const action = vi.fn((_prev: { error: string | null }, formData: FormData) => ({
      error: null,
    }));
    render(<PaymentSourceRow {...baseProps()} moveAction={action} />);

    fireEvent.click(screen.getByRole("button", { name: "Aカード を上へ移動" }));

    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    const formData = action.mock.calls[0][1];
    expect(formData.get("id")).toBe("ps_1");
    expect(formData.get("direction")).toBe("up");
  });

  it("「下へ」を押すと direction=down で action が呼ばれる", async () => {
    const action = vi.fn((_prev: { error: string | null }, formData: FormData) => ({
      error: null,
    }));
    render(<PaymentSourceRow {...baseProps()} moveAction={action} />);

    fireEvent.click(screen.getByRole("button", { name: "Aカード を下へ移動" }));

    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    expect(action.mock.calls[0][1].get("direction")).toBe("down");
  });

  it("action がエラーを返すと role=alert で表示される", async () => {
    const action = vi.fn(() => ({ error: "これ以上、下へ移動できません。" }));
    render(<PaymentSourceRow {...baseProps()} moveAction={action} />);

    fireEvent.click(screen.getByRole("button", { name: "Aカード を下へ移動" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("これ以上、下へ移動できません。");
  });
});
