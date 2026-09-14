// src/app/budgets/budget-form.tsx の描画・操作を検証する。
//
// 期待値の根拠:
// - docs/features.md「設計判断 > 予算の持ち方」（払い出し先の予算合計＝総予算）
// - docs/steps/step-4.md「予算の『未設定』と『0円』を区別する」
// - 手計算: 総予算 = 各行の入力金額（未設定は0として扱う） + otherTotalYen（無効な払い出し先の分）

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PaymentSourceType } from "@/generated/prisma/enums";
import { BudgetForm, type BudgetFormRow } from "@/app/budgets/budget-form";
import { budgetAmountFieldName } from "@/app/budgets/action-state";

afterEach(() => {
  cleanup();
});

function row(overrides: Partial<BudgetFormRow>): BudgetFormRow {
  return {
    paymentSourceId: "ps_1",
    name: "現金",
    type: PaymentSourceType.CASH,
    amountYen: null,
    ...overrides,
  };
}

const okAction = () => ({ error: null, saved: false });

describe("空の一覧", () => {
  it("案内メッセージを表示し、送信ボタンは非活性", () => {
    render(<BudgetForm yearMonth="2026-08" rows={[]} otherTotalYen={0} action={okAction} />);
    expect(
      screen.getByText("有効な払い出し先がありません。先に払い出し先を登録してください。"),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "予算を保存する" })).toBeDisabled();
  });
});

describe("初期表示", () => {
  it("yearMonth を hidden フィールドに持つ", () => {
    const { container } = render(
      <BudgetForm
        yearMonth="2026-08"
        rows={[row({ paymentSourceId: "ps_1" })]}
        otherTotalYen={0}
        action={okAction}
      />,
    );
    const hidden = container.querySelector('input[name="yearMonth"]') as HTMLInputElement;
    expect(hidden.value).toBe("2026-08");
  });

  it("未設定（null）の行は入力欄が空、placeholder が『未設定』", () => {
    render(
      <BudgetForm
        yearMonth="2026-08"
        rows={[row({ paymentSourceId: "ps_1", amountYen: null })]}
        otherTotalYen={0}
        action={okAction}
      />,
    );
    const input = screen.getByLabelText(/現金/) as HTMLInputElement;
    expect(input.value).toBe("");
    expect(input).toHaveAttribute("placeholder", "未設定");
  });

  it("0円の行は入力欄に '0' が表示される（未設定と区別する）", () => {
    render(
      <BudgetForm
        yearMonth="2026-08"
        rows={[row({ paymentSourceId: "ps_1", amountYen: 0 })]}
        otherTotalYen={0}
        action={okAction}
      />,
    );
    const input = screen.getByLabelText(/現金/) as HTMLInputElement;
    expect(input.value).toBe("0");
  });

  it("入力欄の name は budgetAmountFieldName(paymentSourceId) に一致する", () => {
    render(
      <BudgetForm
        yearMonth="2026-08"
        rows={[row({ paymentSourceId: "ps_1" })]}
        otherTotalYen={0}
        action={okAction}
      />,
    );
    const input = screen.getByLabelText(/現金/) as HTMLInputElement;
    expect(input.name).toBe(budgetAmountFieldName("ps_1"));
  });
});

describe("総予算の計算（画面表示）", () => {
  it("手計算: 10000(現金) + 0(日用品=未設定) + 5000(無効な払い出し先分) = 15000", () => {
    render(
      <BudgetForm
        yearMonth="2026-08"
        rows={[
          row({ paymentSourceId: "ps_1", name: "現金", amountYen: 10_000 }),
          row({ paymentSourceId: "ps_2", name: "Aカード", amountYen: null }),
        ]}
        otherTotalYen={5_000}
        action={okAction}
      />,
    );
    expect(screen.getByText("¥15,000")).toBeInTheDocument();
  });

  it("入力を変更すると総予算がその場で再計算される", () => {
    render(
      <BudgetForm
        yearMonth="2026-08"
        rows={[row({ paymentSourceId: "ps_1", name: "現金", amountYen: null })]}
        otherTotalYen={0}
        action={okAction}
      />,
    );
    const input = screen.getByLabelText(/現金/) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "12000" } });
    expect(screen.getByText("¥12,000")).toBeInTheDocument();
  });

  it("otherTotalYen が 0 のときは行の合計のみが表示される", () => {
    render(
      <BudgetForm
        yearMonth="2026-08"
        rows={[row({ paymentSourceId: "ps_1", amountYen: 1_000 })]}
        otherTotalYen={0}
        action={okAction}
      />,
    );
    expect(screen.getByText("¥1,000")).toBeInTheDocument();
  });
});

describe("入力の検証", () => {
  it("マイナスの値を入力するとエラーが表示され、送信ボタンが非活性になる", () => {
    render(
      <BudgetForm
        yearMonth="2026-08"
        rows={[row({ paymentSourceId: "ps_1", name: "現金" })]}
        otherTotalYen={0}
        action={okAction}
      />,
    );
    const input = screen.getByLabelText(/現金/) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "-100" } });

    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "予算を保存する" })).toBeDisabled();
  });

  it("上限（99,999,999）を超える値はエラーになる", () => {
    render(
      <BudgetForm
        yearMonth="2026-08"
        rows={[row({ paymentSourceId: "ps_1", name: "現金" })]}
        otherTotalYen={0}
        action={okAction}
      />,
    );
    const input = screen.getByLabelText(/現金/) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "100000000" } });

    expect(screen.getByRole("alert")).toBeInTheDocument();
  });
});

describe("送信・状態表示", () => {
  it("入力金額を含めて action が呼ばれる", async () => {
    const action = vi.fn((_prev: { error: string | null; saved: boolean }, formData: FormData) => ({
      error: null,
      saved: true,
    }));
    render(
      <BudgetForm
        yearMonth="2026-08"
        rows={[row({ paymentSourceId: "ps_1", name: "現金" })]}
        otherTotalYen={0}
        action={action}
      />,
    );

    fireEvent.change(screen.getByLabelText(/現金/), { target: { value: "40000" } });
    fireEvent.click(screen.getByRole("button", { name: "予算を保存する" }));

    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    const formData = action.mock.calls[0][1];
    expect(formData.get(budgetAmountFieldName("ps_1"))).toBe("40000");
    expect(formData.get("yearMonth")).toBe("2026-08");
  });

  it("保存成功後は『保存しました。』が表示される", async () => {
    const action = () => Promise.resolve({ error: null, saved: true });
    render(
      <BudgetForm
        yearMonth="2026-08"
        rows={[row({ paymentSourceId: "ps_1" })]}
        otherTotalYen={0}
        action={action}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "予算を保存する" }));

    const status = await screen.findByRole("status");
    expect(status).toHaveTextContent("保存しました。");
  });

  it("失敗時はエラーが alert で表示され、成功メッセージは出ない", async () => {
    const action = () => Promise.resolve({ error: "対象の払い出し先が見つかりません。", saved: false });
    render(
      <BudgetForm
        yearMonth="2026-08"
        rows={[row({ paymentSourceId: "ps_1" })]}
        otherTotalYen={0}
        action={action}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "予算を保存する" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("対象の払い出し先が見つかりません。");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
