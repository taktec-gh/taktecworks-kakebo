// src/app/incomes/income-list.tsx の描画・削除操作を検証する。
//
// 期待値の根拠:
// - docs/steps/step-6.md「3-5. 画面 > /incomes」「その月の一覧（新しい順、各行に削除）」
// - docs/steps/step-6.md「編集画面は作らない」「削除は誤操作しやすいので確認を1段挟む」
//   （Step 5 の支出削除と同じ形。tests/app/expenses/[id]/expense-delete-form.test.tsx の
//    2段階確認のテスト観点を踏襲する）
// - docs/steps/step-6.md「tester への引き継ぎ > name / id / 主なラベル文言」
//   「収入 削除フォーム: name=id（hidden）、ボタン 削除 → 確認後 削除する / やめる」
// - 実装（src/app/incomes/income-list.tsx）を読んで確定した点:
//   - 空のとき: 「この月に受け取った収入はまだ記録されていません。」
//   - ラベル無しの行は「（ラベルなし）」と表示する
//   - 削除ボタンの accessible name は aria-label（`${label ?? "収入"} ${金額} を削除`）で、
//     ボタン内の見た目のテキスト「削除」とは異なる
//   - confirmingId は1つの state で管理されるため、同時に確認状態になれるのは1行だけ

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { IncomeList, type IncomeListItem } from "@/app/incomes/income-list";
import type { IncomeActionState } from "@/app/incomes/action-state";

function makeItem(overrides: Partial<IncomeListItem> = {}): IncomeListItem {
  return {
    id: "income_1",
    amountYen: 300_000,
    label: "給与",
    ...overrides,
  };
}

function noopAction(prevState: IncomeActionState): IncomeActionState {
  return prevState;
}

afterEach(() => {
  cleanup();
});

describe("空のとき", () => {
  it("この月に受け取った収入はまだ記録されていません、と表示する", () => {
    render(<IncomeList items={[]} deleteAction={noopAction} />);
    expect(
      screen.getByText("この月に受け取った収入はまだ記録されていません。"),
    ).toBeInTheDocument();
  });
});

describe("一覧表示", () => {
  it("ラベルと金額を表示する", () => {
    render(
      <IncomeList
        items={[makeItem({ label: "給与", amountYen: 300_000 })]}
        deleteAction={noopAction}
      />,
    );
    expect(screen.getByText("給与")).toBeInTheDocument();
    expect(screen.getByText("¥300,000")).toBeInTheDocument();
  });

  it("ラベルが無い行は『（ラベルなし）』と表示する", () => {
    render(
      <IncomeList items={[makeItem({ label: null, amountYen: 1_000 })]} deleteAction={noopAction} />,
    );
    expect(screen.getByText("（ラベルなし）")).toBeInTheDocument();
  });

  it("0円の収入でも行として表示する", () => {
    // バリデーションでは0円は拒否されるが（下限1円）、既存データが0円になり得るケース
    // （手計算: formatYen(0) = "¥0"）に一覧が崩れないことを確認する
    render(
      <IncomeList items={[makeItem({ label: "テスト", amountYen: 0 })]} deleteAction={noopAction} />,
    );
    expect(screen.getByText("¥0")).toBeInTheDocument();
  });

  it("複数件は渡した順番のまま表示する（並べ替えはデータ層の責任）", () => {
    render(
      <IncomeList
        items={[
          makeItem({ id: "income_1", label: "給与", amountYen: 300_000 }),
          makeItem({ id: "income_2", label: "副業", amountYen: 50_000 }),
        ]}
        deleteAction={noopAction}
      />,
    );
    const listItems = screen.getAllByRole("listitem");
    expect(listItems).toHaveLength(2);
    expect(listItems[0]).toHaveTextContent("給与");
    expect(listItems[1]).toHaveTextContent("副業");
  });
});

describe("削除ボタンの accessible name", () => {
  it("ラベルありは『{ラベル} {金額} を削除』", () => {
    render(
      <IncomeList
        items={[makeItem({ label: "給与", amountYen: 300_000 })]}
        deleteAction={noopAction}
      />,
    );
    expect(
      screen.getByRole("button", { name: "給与 ¥300,000 を削除" }),
    ).toBeInTheDocument();
  });

  it("ラベル無しは『収入 {金額} を削除』", () => {
    render(
      <IncomeList items={[makeItem({ label: null, amountYen: 1_000 })]} deleteAction={noopAction} />,
    );
    expect(screen.getByRole("button", { name: "収入 ¥1,000 を削除" })).toBeInTheDocument();
  });
});

describe("2段階確認", () => {
  it("最初は削除ボタンのみで、確認文は出ない", () => {
    render(<IncomeList items={[makeItem()]} deleteAction={noopAction} />);
    expect(screen.queryByText(/元に戻せません/)).not.toBeInTheDocument();
  });

  it("削除ボタンを押すと確認文と『削除する』『やめる』が出る", () => {
    render(
      <IncomeList
        items={[makeItem({ label: "給与", amountYen: 300_000 })]}
        deleteAction={noopAction}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "給与 ¥300,000 を削除" }));

    expect(
      screen.getByText("「給与 ¥300,000」を削除します。元に戻せません。"),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "削除する" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "やめる" })).toBeInTheDocument();
  });

  it("『やめる』を押すと確認前の表示に戻る", () => {
    render(
      <IncomeList
        items={[makeItem({ label: "給与", amountYen: 300_000 })]}
        deleteAction={noopAction}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "給与 ¥300,000 を削除" }));
    fireEvent.click(screen.getByRole("button", { name: "やめる" }));

    expect(screen.queryByText(/元に戻せません/)).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "給与 ¥300,000 を削除" }),
    ).toBeInTheDocument();
  });

  it("確認状態になるのは押した行だけ（他の行は削除ボタンのまま）", () => {
    render(
      <IncomeList
        items={[
          makeItem({ id: "income_1", label: "給与", amountYen: 300_000 }),
          makeItem({ id: "income_2", label: "副業", amountYen: 50_000 }),
        ]}
        deleteAction={noopAction}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "給与 ¥300,000 を削除" }));

    expect(
      screen.getByText("「給与 ¥300,000」を削除します。元に戻せません。"),
    ).toBeInTheDocument();
    // 2件目はまだ確認前のまま
    expect(
      screen.getByRole("button", { name: "副業 ¥50,000 を削除" }),
    ).toBeInTheDocument();
  });

  it("確認画面で削除を確定すると id を含めて deleteAction が呼ばれる", async () => {
    const action = vi.fn(
      async (prevState: IncomeActionState, _formData: FormData): Promise<IncomeActionState> => ({
        error: null,
        savedCount: prevState.savedCount + 1,
      }),
    );
    render(
      <IncomeList
        items={[makeItem({ id: "income_9", label: "給与", amountYen: 300_000 })]}
        deleteAction={action}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "給与 ¥300,000 を削除" }));
    fireEvent.click(screen.getByRole("button", { name: "削除する" }));

    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    const formData = action.mock.calls[0]?.[1];
    if (!formData) throw new Error("deleteAction に formData が渡っていません");
    expect(formData.get("id")).toBe("income_9");
  });

  it("削除に失敗した場合はエラーが alert で表示される", async () => {
    const action = async (prevState: IncomeActionState): Promise<IncomeActionState> => ({
      error: "対象の収入が見つかりません。",
      savedCount: prevState.savedCount,
    });
    render(
      <IncomeList
        items={[makeItem({ label: "給与", amountYen: 300_000 })]}
        deleteAction={action}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "給与 ¥300,000 を削除" }));
    fireEvent.click(screen.getByRole("button", { name: "削除する" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("対象の収入が見つかりません。");
  });
});
