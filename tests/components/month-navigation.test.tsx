// src/components/month-navigation.tsx（共通の月ナビゲーション）の描画を検証する。
//
// 期待値の根拠:
// - docs/steps/step-6.md「設計判断 > 3. 月ナビゲーションを共通化する」
//   props は { yearMonth, currentYearMonth, hrefForMonth }
// - 既存の budgets/month-navigation.test.tsx と同じ観点
//   （表示・前月翌月・範囲端・今月へリンク）を、委譲元の共通コンポーネント自体にも適用する

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MAX_YEAR_MONTH, MIN_YEAR_MONTH } from "@/lib/year-month";
import { MonthNavigation } from "@/components/month-navigation";

function hrefForMonth(yearMonth: string): string {
  return `/test?month=${yearMonth}`;
}

afterEach(() => {
  cleanup();
});

describe("見出し", () => {
  it("対象月を『YYYY年M月』で表示する", () => {
    render(
      <MonthNavigation
        yearMonth="2026-08"
        currentYearMonth="2026-08"
        hrefForMonth={hrefForMonth}
      />,
    );
    expect(screen.getByRole("heading", { name: "2026年8月" })).toBeInTheDocument();
  });
});

describe("前月・翌月のリンク", () => {
  it("hrefForMonth に前月・翌月の年月を渡してリンク先を組み立てる", () => {
    const spy = vi.fn(hrefForMonth);
    render(
      <MonthNavigation yearMonth="2026-08" currentYearMonth="2026-08" hrefForMonth={spy} />,
    );
    expect(screen.getByRole("link", { name: "前月へ" })).toHaveAttribute(
      "href",
      "/test?month=2026-07",
    );
    expect(screen.getByRole("link", { name: "翌月へ" })).toHaveAttribute(
      "href",
      "/test?month=2026-09",
    );
    expect(spy).toHaveBeenCalledWith("2026-07");
    expect(spy).toHaveBeenCalledWith("2026-09");
  });

  it("下限月（MIN_YEAR_MONTH）では前月リンクを出さない", () => {
    render(
      <MonthNavigation
        yearMonth={MIN_YEAR_MONTH}
        currentYearMonth="2026-08"
        hrefForMonth={hrefForMonth}
      />,
    );
    expect(screen.queryByRole("link", { name: "前月へ" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "翌月へ" })).toBeInTheDocument();
  });

  it("上限月（MAX_YEAR_MONTH）では翌月リンクを出さない", () => {
    render(
      <MonthNavigation
        yearMonth={MAX_YEAR_MONTH}
        currentYearMonth="2026-08"
        hrefForMonth={hrefForMonth}
      />,
    );
    expect(screen.queryByRole("link", { name: "翌月へ" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "前月へ" })).toBeInTheDocument();
  });

  it("年をまたぐ移動も正しい月を指す（2026-01 の前月は 2025-12）", () => {
    render(
      <MonthNavigation
        yearMonth="2026-01"
        currentYearMonth="2026-08"
        hrefForMonth={hrefForMonth}
      />,
    );
    expect(screen.getByRole("link", { name: "前月へ" })).toHaveAttribute(
      "href",
      "/test?month=2025-12",
    );
  });
});

describe("『今月へ』リンク", () => {
  it("表示中の月が今月と同じなら出さない", () => {
    render(
      <MonthNavigation
        yearMonth="2026-08"
        currentYearMonth="2026-08"
        hrefForMonth={hrefForMonth}
      />,
    );
    expect(screen.queryByRole("link", { name: /今月へ/ })).not.toBeInTheDocument();
  });

  it("表示中の月が今月と違えば『今月へ』リンクを出し、hrefForMonth(今月) を指す", () => {
    render(
      <MonthNavigation
        yearMonth="2026-05"
        currentYearMonth="2026-08"
        hrefForMonth={hrefForMonth}
      />,
    );
    const link = screen.getByRole("link", { name: /今月（2026年8月）へ/ });
    expect(link).toHaveAttribute("href", "/test?month=2026-08");
  });
});
