// src/app/expenses/expense-filter-panel.tsx の描画を検証する。
//
// 期待値の根拠:
// - docs/steps/step-5.md「設計判断 > 一覧は月単位。絞り込みと並べ替えは URL に持つ」
//   「並べ替えは日付の新しい順（既定）と金額の高い順」
//   「絞り込んだ結果の合計金額と件数」の前提として絞り込み UI 自体の検証

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { PaymentSourceType, WasteTag } from "@/generated/prisma/enums";
import {
  parseExpenseListFilter,
  withExpenseFilter,
  type ExpenseListFilter,
} from "@/lib/expense-filter";
import {
  ExpenseFilterPanel,
  type ExpenseFilterPaymentSourceOption,
} from "@/app/expenses/expense-filter-panel";
import { expensesPath } from "@/app/expenses/action-state";

const CATEGORIES = [
  { id: "cat_1", name: "食費" },
  { id: "cat_2", name: "日用品" },
];

const PAYMENT_SOURCES: ExpenseFilterPaymentSourceOption[] = [
  { id: "ps_1", name: "現金", type: PaymentSourceType.CASH },
];

function baseFilter(overrides: Partial<ExpenseListFilter> = {}): ExpenseListFilter {
  return {
    yearMonth: "2026-08",
    categoryId: null,
    paymentSourceId: null,
    wasteTag: null,
    sort: "date",
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
});

describe("並べ替え", () => {
  it("日付順・金額順のリンクを出し、既定は日付順が選択状態", () => {
    render(<ExpenseFilterPanel filter={baseFilter()} categories={CATEGORIES} paymentSources={PAYMENT_SOURCES} />);
    const dateLink = screen.getByRole("link", { name: "日付順" });
    const amountLink = screen.getByRole("link", { name: "金額順" });
    expect(dateLink).toHaveAttribute("aria-current", "true");
    expect(amountLink).not.toHaveAttribute("aria-current");
    expect(amountLink).toHaveAttribute(
      "href",
      expensesPath(withExpenseFilter(baseFilter(), { sort: "amount" })),
    );
  });

  it("sort=amount のときは金額順が選択状態になる", () => {
    render(
      <ExpenseFilterPanel
        filter={baseFilter({ sort: "amount" })}
        categories={CATEGORIES}
        paymentSources={PAYMENT_SOURCES}
      />,
    );
    expect(screen.getByRole("link", { name: "金額順" })).toHaveAttribute("aria-current", "true");
  });
});

describe("絞り込みパネルの開閉", () => {
  it("絞り込みが無いときは既定で閉じている", () => {
    const { container } = render(
      <ExpenseFilterPanel filter={baseFilter()} categories={CATEGORIES} paymentSources={PAYMENT_SOURCES} />,
    );
    expect(container.querySelector("details")?.open).toBe(false);
    expect(screen.queryByText("適用中")).not.toBeInTheDocument();
  });

  it("絞り込みが掛かっているときは既定で開き、『適用中』を出す", () => {
    const { container } = render(
      <ExpenseFilterPanel
        filter={baseFilter({ categoryId: "cat_1" })}
        categories={CATEGORIES}
        paymentSources={PAYMENT_SOURCES}
      />,
    );
    expect(container.querySelector("details")?.open).toBe(true);
    expect(screen.getByText("適用中")).toBeInTheDocument();
  });

  it("絞り込み解除リンクは絞り込み中だけ出る", () => {
    cleanup();
    render(
      <ExpenseFilterPanel
        filter={baseFilter({ wasteTag: WasteTag.WASTE })}
        categories={CATEGORIES}
        paymentSources={PAYMENT_SOURCES}
      />,
    );
    expect(screen.getByRole("link", { name: "絞り込みを解除" })).toBeInTheDocument();

    cleanup();
    render(<ExpenseFilterPanel filter={baseFilter()} categories={CATEGORIES} paymentSources={PAYMENT_SOURCES} />);
    expect(screen.queryByRole("link", { name: "絞り込みを解除" })).not.toBeInTheDocument();
  });
});

describe("フォームの hidden フィールドと選択肢", () => {
  it("month と sort は hidden で保持し、絞り込みの select には現在値が反映される", () => {
    render(
      <ExpenseFilterPanel
        filter={baseFilter({ categoryId: "cat_1", paymentSourceId: "ps_1", wasteTag: WasteTag.WASTE, sort: "amount" })}
        categories={CATEGORIES}
        paymentSources={PAYMENT_SOURCES}
      />,
    );
    expect((screen.getByLabelText("カテゴリ") as HTMLSelectElement).value).toBe("cat_1");
    expect((screen.getByLabelText("払い出し先") as HTMLSelectElement).value).toBe("ps_1");
    expect((screen.getByLabelText("必要 / 浪費 / 投資") as HTMLSelectElement).value).toBe(
      WasteTag.WASTE,
    );
  });

  it("絞り込みの選択肢は『すべて』を含む", () => {
    render(<ExpenseFilterPanel filter={baseFilter()} categories={CATEGORIES} paymentSources={PAYMENT_SOURCES} />);
    const categorySelect = screen.getByLabelText("カテゴリ") as HTMLSelectElement;
    expect(Array.from(categorySelect.options).map((option) => option.text)).toContain("すべて");
  });
});

describe("parseExpenseListFilter と組み合わせた実際の絞り込み", () => {
  it("URLSearchParams から作った filter をそのまま渡しても描画できる", () => {
    const filter = parseExpenseListFilter(
      { month: "2026-08", waste: WasteTag.WASTE },
      new Date("2026-08-13T00:00:00.000Z"),
    );
    render(<ExpenseFilterPanel filter={filter} categories={CATEGORIES} paymentSources={PAYMENT_SOURCES} />);
    expect((screen.getByLabelText("必要 / 浪費 / 投資") as HTMLSelectElement).value).toBe(
      WasteTag.WASTE,
    );
  });
});
