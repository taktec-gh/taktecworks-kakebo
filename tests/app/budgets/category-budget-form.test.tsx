// src/app/budgets/category-budget-form.tsx の描画・操作を検証する。
//
// 期待値の根拠:
// - docs/features.md「設計判断 > 予算の持ち方」（カテゴリ予算は任意の補助上限で、総予算には含まれない）
// - docs/steps/step-4.md「カテゴリ予算（任意）: 別セクション。総予算には含まれないと明示する」

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CategoryBudgetForm,
  type CategoryBudgetFormRow,
} from "@/app/budgets/category-budget-form";
import { categoryBudgetAmountFieldName } from "@/app/budgets/action-state";

afterEach(() => {
  cleanup();
});

function row(overrides: Partial<CategoryBudgetFormRow>): CategoryBudgetFormRow {
  return {
    categoryId: "cat_1",
    name: "食費",
    isHidden: false,
    amountYen: null,
    ...overrides,
  };
}

const okAction = () => ({ error: null, saved: false });

describe("空の一覧", () => {
  it("案内メッセージを表示し、送信ボタンは非活性", () => {
    render(<CategoryBudgetForm yearMonth="2026-08" rows={[]} action={okAction} />);
    expect(screen.getByText("表示中のカテゴリがありません。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "カテゴリ予算を保存する" })).toBeDisabled();
  });
});

describe("初期表示", () => {
  it("非表示のカテゴリには非表示バッジが付く（表示中カテゴリには付かない）", () => {
    render(
      <CategoryBudgetForm
        yearMonth="2026-08"
        rows={[
          row({ categoryId: "c1", name: "食費", isHidden: false }),
          row({ categoryId: "c2", name: "旧カテゴリ", isHidden: true, amountYen: 1000 }),
        ]}
        action={okAction}
      />,
    );
    expect(screen.getByText("非表示")).toBeInTheDocument();
  });

  it("未設定の行は入力欄が空", () => {
    render(
      <CategoryBudgetForm
        yearMonth="2026-08"
        rows={[row({ categoryId: "c1", amountYen: null })]}
        action={okAction}
      />,
    );
    const input = screen.getByLabelText(/食費/) as HTMLInputElement;
    expect(input.value).toBe("");
  });

  it("0円の行は入力欄に '0' が表示される", () => {
    render(
      <CategoryBudgetForm
        yearMonth="2026-08"
        rows={[row({ categoryId: "c1", amountYen: 0 })]}
        action={okAction}
      />,
    );
    const input = screen.getByLabelText(/食費/) as HTMLInputElement;
    expect(input.value).toBe("0");
  });

  it("入力欄の name は categoryBudgetAmountFieldName(categoryId) に一致する", () => {
    render(
      <CategoryBudgetForm
        yearMonth="2026-08"
        rows={[row({ categoryId: "c1" })]}
        action={okAction}
      />,
    );
    const input = screen.getByLabelText(/食費/) as HTMLInputElement;
    expect(input.name).toBe(categoryBudgetAmountFieldName("c1"));
  });
});

describe("合計は『参考値』であり、総予算には含まれない旨が表示される", () => {
  it("手計算: 5000(食費) + 2000(日用品) = 7000。文言に『総予算には含まれません』が入る", () => {
    render(
      <CategoryBudgetForm
        yearMonth="2026-08"
        rows={[
          row({ categoryId: "c1", name: "食費", amountYen: 5_000 }),
          row({ categoryId: "c2", name: "日用品", amountYen: 2_000 }),
        ]}
        action={okAction}
      />,
    );
    expect(screen.getByText(/¥7,000/)).toBeInTheDocument();
    expect(screen.getByText(/総予算には含まれません/)).toBeInTheDocument();
  });
});

describe("入力の検証", () => {
  it("小数を入力するとエラーが表示され、送信ボタンが非活性になる", () => {
    render(
      <CategoryBudgetForm
        yearMonth="2026-08"
        rows={[row({ categoryId: "c1", name: "食費" })]}
        action={okAction}
      />,
    );
    fireEvent.change(screen.getByLabelText(/食費/), { target: { value: "100.5" } });

    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "カテゴリ予算を保存する" })).toBeDisabled();
  });
});

describe("送信・状態表示", () => {
  it("入力金額と yearMonth を含めて action が呼ばれる", async () => {
    const action = vi.fn((_prev: { error: string | null; saved: boolean }, formData: FormData) => ({
      error: null,
      saved: true,
    }));
    render(
      <CategoryBudgetForm
        yearMonth="2026-08"
        rows={[row({ categoryId: "c1", name: "食費" })]}
        action={action}
      />,
    );

    fireEvent.change(screen.getByLabelText(/食費/), { target: { value: "5000" } });
    fireEvent.click(screen.getByRole("button", { name: "カテゴリ予算を保存する" }));

    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    const formData = action.mock.calls[0][1];
    expect(formData.get(categoryBudgetAmountFieldName("c1"))).toBe("5000");
    expect(formData.get("yearMonth")).toBe("2026-08");
  });

  it("保存成功後は『保存しました。』が表示される", async () => {
    const action = () => Promise.resolve({ error: null, saved: true });
    render(
      <CategoryBudgetForm
        yearMonth="2026-08"
        rows={[row({ categoryId: "c1" })]}
        action={action}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "カテゴリ予算を保存する" }));

    const status = await screen.findByRole("status");
    expect(status).toHaveTextContent("保存しました。");
  });

  it("失敗時はエラーが alert で表示される", async () => {
    const action = () => Promise.resolve({ error: "対象のカテゴリが見つかりません。", saved: false });
    render(
      <CategoryBudgetForm
        yearMonth="2026-08"
        rows={[row({ categoryId: "c1" })]}
        action={action}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "カテゴリ予算を保存する" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("対象のカテゴリが見つかりません。");
  });
});
