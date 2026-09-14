// src/app/settings/categories/category-row.tsx の描画・操作を検証する。

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CostType } from "@/generated/prisma/enums";
import { CategoryRow } from "@/app/settings/categories/category-row";
import { categoryDetailPath } from "@/app/settings/categories/action-state";

afterEach(() => {
  cleanup();
});

function baseProps() {
  return {
    id: "cat_1",
    name: "食費",
    costType: CostType.VARIABLE,
    isHidden: false,
    canMoveUp: true,
    canMoveDown: true,
  };
}

describe("表示", () => {
  it("名前・固定費/変動費ラベルを表示し、詳細ページへのリンクになっている", () => {
    render(<CategoryRow {...baseProps()} moveAction={() => ({ error: null })} />);
    const link = screen.getByRole("link", { name: /食費/ });
    expect(link).toHaveAttribute("href", categoryDetailPath("cat_1"));
    expect(screen.getByText("変動費")).toBeInTheDocument();
  });

  it("非表示バッジは isHidden=true のときだけ表示される", () => {
    const { rerender } = render(
      <CategoryRow {...baseProps()} isHidden={false} moveAction={() => ({ error: null })} />,
    );
    expect(screen.queryByText("非表示")).not.toBeInTheDocument();

    rerender(
      <CategoryRow {...baseProps()} isHidden={true} moveAction={() => ({ error: null })} />,
    );
    expect(screen.getByText("非表示")).toBeInTheDocument();
  });

  it("canMoveUp/canMoveDown が false のとき対応するボタンが非活性になる", () => {
    render(
      <CategoryRow
        {...baseProps()}
        canMoveUp={false}
        canMoveDown={false}
        moveAction={() => ({ error: null })}
      />,
    );
    expect(screen.getByRole("button", { name: "食費 を上へ移動" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "食費 を下へ移動" })).toBeDisabled();
  });

  it("エラーが無ければ alert は表示されない", () => {
    render(<CategoryRow {...baseProps()} moveAction={() => ({ error: null })} />);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("並べ替え操作", () => {
  it("「上へ」を押すと id と direction=up を含めて action が呼ばれる", async () => {
    const action = vi.fn((_prev: { error: string | null }, formData: FormData) => ({
      error: null,
    }));
    render(<CategoryRow {...baseProps()} moveAction={action} />);

    fireEvent.click(screen.getByRole("button", { name: "食費 を上へ移動" }));

    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    const formData = action.mock.calls[0][1];
    expect(formData.get("id")).toBe("cat_1");
    expect(formData.get("direction")).toBe("up");
  });

  it("「下へ」を押すと direction=down で action が呼ばれる", async () => {
    const action = vi.fn((_prev: { error: string | null }, formData: FormData) => ({
      error: null,
    }));
    render(<CategoryRow {...baseProps()} moveAction={action} />);

    fireEvent.click(screen.getByRole("button", { name: "食費 を下へ移動" }));

    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    expect(action.mock.calls[0][1].get("direction")).toBe("down");
  });

  it("action がエラーを返すと role=alert で表示される", async () => {
    const action = vi.fn(() => ({ error: "これ以上、下へ移動できません。" }));
    render(<CategoryRow {...baseProps()} moveAction={action} />);

    fireEvent.click(screen.getByRole("button", { name: "食費 を下へ移動" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("これ以上、下へ移動できません。");
  });
});
