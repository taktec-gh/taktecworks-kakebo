// src/app/expenses/expense-month-navigation.tsx の描画を検証する。
//
// 期待値の根拠:
// - docs/steps/step-5.md「設計判断 > 一覧は月単位」対象月の表示と前月/翌月の移動
// - docs/steps/step-5.md「絞り込みと並べ替えは URL に持つ」ため、月移動時も
//   絞り込み条件を引き継ぐ必要がある

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { WasteTag } from "@/generated/prisma/enums";
import { withExpenseFilter, type ExpenseListFilter } from "@/lib/expense-filter";
import { MAX_YEAR_MONTH, MIN_YEAR_MONTH } from "@/lib/year-month";
import { ExpenseMonthNavigation } from "@/app/expenses/expense-month-navigation";
import { expensesPath } from "@/app/expenses/action-state";

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

describe("見出し", () => {
  it("対象月を『YYYY年M月』で表示する", () => {
    render(<ExpenseMonthNavigation filter={baseFilter()} currentYearMonth="2026-08" />);
    expect(screen.getByRole("heading", { name: "2026年8月" })).toBeInTheDocument();
  });
});

describe("前月・翌月のリンク", () => {
  it("通常の月は前月・翌月ともリンクが有効で、正しい月を指す", () => {
    render(<ExpenseMonthNavigation filter={baseFilter()} currentYearMonth="2026-08" />);
    expect(screen.getByRole("link", { name: "前月へ" })).toHaveAttribute(
      "href",
      expensesPath(withExpenseFilter(baseFilter(), { yearMonth: "2026-07" })),
    );
    expect(screen.getByRole("link", { name: "翌月へ" })).toHaveAttribute(
      "href",
      expensesPath(withExpenseFilter(baseFilter(), { yearMonth: "2026-09" })),
    );
  });

  it("下限月では前月リンクを出さない", () => {
    render(
      <ExpenseMonthNavigation
        filter={baseFilter({ yearMonth: MIN_YEAR_MONTH })}
        currentYearMonth="2026-08"
      />,
    );
    expect(screen.queryByRole("link", { name: "前月へ" })).not.toBeInTheDocument();
  });

  it("上限月では翌月リンクを出さない", () => {
    render(
      <ExpenseMonthNavigation
        filter={baseFilter({ yearMonth: MAX_YEAR_MONTH })}
        currentYearMonth="2026-08"
      />,
    );
    expect(screen.queryByRole("link", { name: "翌月へ" })).not.toBeInTheDocument();
  });

  it("月移動時も絞り込み条件（カテゴリ・浪費タグ等）を引き継ぐ", () => {
    const filter = baseFilter({ categoryId: "cat_1", wasteTag: WasteTag.WASTE, sort: "amount" });
    render(<ExpenseMonthNavigation filter={filter} currentYearMonth="2026-08" />);
    expect(screen.getByRole("link", { name: "翌月へ" })).toHaveAttribute(
      "href",
      expensesPath(withExpenseFilter(filter, { yearMonth: "2026-09" })),
    );
  });
});

describe("『今月へ』リンク", () => {
  it("表示中の月が今月と同じなら出さない", () => {
    render(<ExpenseMonthNavigation filter={baseFilter()} currentYearMonth="2026-08" />);
    expect(screen.queryByRole("link", { name: /今月へ/ })).not.toBeInTheDocument();
  });

  it("表示中の月が今月と違えば『今月へ』リンクを出す", () => {
    render(
      <ExpenseMonthNavigation filter={baseFilter({ yearMonth: "2026-05" })} currentYearMonth="2026-08" />,
    );
    const link = screen.getByRole("link", { name: /今月（2026年8月）へ/ });
    expect(link).toHaveAttribute(
      "href",
      expensesPath(withExpenseFilter(baseFilter({ yearMonth: "2026-05" }), { yearMonth: "2026-08" })),
    );
  });
});
