// src/app/incomes/income-month-navigation.tsx の描画を検証する。
//
// 期待値の根拠:
// - docs/steps/step-6.md「設計判断 > 3. 月ナビゲーションを共通化する」
//   （公開インターフェースと描画結果は共通コンポーネントに委譲する薄いラッパー）
// - tests/app/budgets/month-navigation.test.tsx と同じ観点

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { MAX_YEAR_MONTH, MIN_YEAR_MONTH } from "@/lib/year-month";
import { IncomeMonthNavigation } from "@/app/incomes/income-month-navigation";
import { incomesPath } from "@/app/incomes/action-state";

afterEach(() => {
  cleanup();
});

describe("見出し", () => {
  it("対象月を『YYYY年M月』で表示する", () => {
    render(<IncomeMonthNavigation yearMonth="2026-08" currentYearMonth="2026-08" />);
    expect(screen.getByRole("heading", { name: "2026年8月" })).toBeInTheDocument();
  });
});

describe("前月・翌月のリンク", () => {
  it("リンク先は incomesPath で組み立てられる", () => {
    render(<IncomeMonthNavigation yearMonth="2026-08" currentYearMonth="2026-08" />);
    expect(screen.getByRole("link", { name: "前月へ" })).toHaveAttribute(
      "href",
      incomesPath("2026-07"),
    );
    expect(screen.getByRole("link", { name: "翌月へ" })).toHaveAttribute(
      "href",
      incomesPath("2026-09"),
    );
  });

  it("下限月（MIN_YEAR_MONTH）では前月リンクを出さない", () => {
    render(<IncomeMonthNavigation yearMonth={MIN_YEAR_MONTH} currentYearMonth="2026-08" />);
    expect(screen.queryByRole("link", { name: "前月へ" })).not.toBeInTheDocument();
  });

  it("上限月（MAX_YEAR_MONTH）では翌月リンクを出さない", () => {
    render(<IncomeMonthNavigation yearMonth={MAX_YEAR_MONTH} currentYearMonth="2026-08" />);
    expect(screen.queryByRole("link", { name: "翌月へ" })).not.toBeInTheDocument();
  });
});

describe("『今月へ』リンク", () => {
  it("表示中の月が今月と違えば『今月へ』リンクを出す", () => {
    render(<IncomeMonthNavigation yearMonth="2026-05" currentYearMonth="2026-08" />);
    const link = screen.getByRole("link", { name: /今月（2026年8月）へ/ });
    expect(link).toHaveAttribute("href", incomesPath("2026-08"));
  });
});
