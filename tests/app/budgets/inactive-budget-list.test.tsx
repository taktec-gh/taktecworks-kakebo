// src/app/budgets/inactive-budget-list.tsx の描画・操作を検証する。
//
// 期待値の根拠:
// - docs/steps/step-4.md「無効な払い出し先に予算が残っている場合」
//   「合計には含める」「入力欄には出さない」「警告付きで別途表示し、その場で削除できる」

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  InactiveBudgetList,
  type InactiveBudgetRow,
} from "@/app/budgets/inactive-budget-list";

afterEach(() => {
  cleanup();
});

const okAction = () => ({ error: null, saved: false });

describe("行が無い場合", () => {
  it("何も描画しない", () => {
    const { container } = render(
      <InactiveBudgetList yearMonth="2026-08" rows={[]} deleteAction={okAction} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});

describe("行がある場合", () => {
  function makeRows(): InactiveBudgetRow[] {
    return [{ paymentSourceId: "ps_1", name: "旧カード", amountYen: 5_000 }];
  }

  it("警告見出しと案内文を表示する", () => {
    render(
      <InactiveBudgetList yearMonth="2026-08" rows={makeRows()} deleteAction={okAction} />,
    );
    expect(
      screen.getByRole("heading", { name: "無効な払い出し先に予算が残っています" }),
    ).toBeInTheDocument();
  });

  it("名前と金額（¥表記）を表示する", () => {
    render(
      <InactiveBudgetList yearMonth="2026-08" rows={makeRows()} deleteAction={okAction} />,
    );
    expect(screen.getByText("旧カード")).toBeInTheDocument();
    expect(screen.getByText("¥5,000")).toBeInTheDocument();
  });

  it("削除ボタンを押すと yearMonth と paymentSourceId を含めて deleteAction が呼ばれる", async () => {
    const action = vi.fn((_prev: { error: string | null; saved: boolean }, formData: FormData) => ({
      error: null,
      saved: true,
    }));
    render(<InactiveBudgetList yearMonth="2026-08" rows={makeRows()} deleteAction={action} />);

    fireEvent.click(screen.getByRole("button", { name: "旧カード の予算を削除" }));

    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    const formData = action.mock.calls[0][1];
    expect(formData.get("yearMonth")).toBe("2026-08");
    expect(formData.get("paymentSourceId")).toBe("ps_1");
  });

  it("削除に失敗した場合はその行にエラーが alert で表示される", async () => {
    const action = () => Promise.resolve({ error: "削除に失敗しました。", saved: false });
    render(<InactiveBudgetList yearMonth="2026-08" rows={makeRows()} deleteAction={action} />);

    fireEvent.click(screen.getByRole("button", { name: "旧カード の予算を削除" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("削除に失敗しました。");
  });

  it("複数行のうち1行だけの操作が他行に影響しない（各行が独立した状態を持つ）", () => {
    const rows: InactiveBudgetRow[] = [
      { paymentSourceId: "ps_1", name: "旧カード1", amountYen: 1_000 },
      { paymentSourceId: "ps_2", name: "旧カード2", amountYen: 2_000 },
    ];
    render(<InactiveBudgetList yearMonth="2026-08" rows={rows} deleteAction={okAction} />);

    expect(screen.getByRole("button", { name: "旧カード1 の予算を削除" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "旧カード2 の予算を削除" })).toBeInTheDocument();
  });
});
