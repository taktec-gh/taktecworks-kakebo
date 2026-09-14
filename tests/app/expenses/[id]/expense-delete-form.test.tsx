// src/app/expenses/[id]/expense-delete-form.tsx の描画・操作を検証する。
//
// 期待値の根拠:
// - docs/steps/step-5.md「設計判断 > 削除は確認を挟んだ物理削除」
//   「スマホでの誤タップを防ぐため2段階にする（Step 3 の払い出し先の削除と同じ形）」

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ExpenseDeleteForm } from "@/app/expenses/[id]/expense-delete-form";
import type { ExpenseActionState } from "@/app/expenses/action-state";

afterEach(() => {
  cleanup();
});

describe("2段階確認", () => {
  it("最初は『削除する』ボタンのみで、確認文は出ない", () => {
    const action = (prevState: ExpenseActionState) => prevState;
    render(<ExpenseDeleteForm id="exp_1" description="8/13(木) 食費 ¥1,200" action={action} />);
    expect(screen.getByRole("button", { name: "削除する" })).toBeInTheDocument();
    expect(screen.queryByText(/元に戻せません/)).not.toBeInTheDocument();
  });

  it("『削除する』を押すと確認文が出る", () => {
    const action = (prevState: ExpenseActionState) => prevState;
    render(<ExpenseDeleteForm id="exp_1" description="8/13(木) 食費 ¥1,200" action={action} />);
    fireEvent.click(screen.getByRole("button", { name: "削除する" }));
    expect(
      screen.getByText("「8/13(木) 食費 ¥1,200」を削除します。元に戻せません。"),
    ).toBeInTheDocument();
  });

  it("確認画面で『やめる』を押すと確認前の表示に戻る", () => {
    const action = (prevState: ExpenseActionState) => prevState;
    render(<ExpenseDeleteForm id="exp_1" description="8/13(木) 食費 ¥1,200" action={action} />);
    fireEvent.click(screen.getByRole("button", { name: "削除する" }));
    fireEvent.click(screen.getByRole("button", { name: "やめる" }));
    expect(screen.queryByText(/元に戻せません/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "削除する" })).toBeInTheDocument();
  });

  it("確認画面で削除を確定すると id を含めて action が呼ばれる", async () => {
    const action = vi.fn(
      async (prevState: ExpenseActionState, _formData: FormData) => ({
        error: null,
        savedCount: prevState.savedCount + 1,
      }),
    );
    render(<ExpenseDeleteForm id="exp_1" description="説明" action={action} />);

    fireEvent.click(screen.getByRole("button", { name: "削除する" }));
    fireEvent.click(screen.getByRole("button", { name: "削除する" }));

    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    const formData = action.mock.calls[0][1];
    expect(formData.get("id")).toBe("exp_1");
  });

  it("削除に失敗した場合はエラーが alert で表示される", async () => {
    const action = async (prevState: ExpenseActionState) => ({
      error: "対象の支出が見つかりません。",
      savedCount: prevState.savedCount,
    });
    render(<ExpenseDeleteForm id="exp_1" description="説明" action={action} />);

    fireEvent.click(screen.getByRole("button", { name: "削除する" }));
    fireEvent.click(screen.getByRole("button", { name: "削除する" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("対象の支出が見つかりません。");
  });
});
