// src/app/budgets/month-navigation.tsx の描画を検証する。
//
// 期待値の根拠:
// - docs/steps/step-4.md「月次予算 > 対象月の表示と『前月 / 翌月』の移動。既定は今月（JST）」
// - docs/steps/step-4.md「year-month.ts の shiftYearMonth の年またぎと範囲端」
//   （扱える範囲の端では移動リンクを出さない設計）

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { MAX_YEAR_MONTH, MIN_YEAR_MONTH } from "@/lib/year-month";
import { MonthNavigation } from "@/app/budgets/month-navigation";
import { budgetsPath } from "@/app/budgets/action-state";

afterEach(() => {
  cleanup();
});

describe("見出し", () => {
  it("対象月を『YYYY年M月』で表示する", () => {
    render(<MonthNavigation yearMonth="2026-08" currentYearMonth="2026-08" />);
    expect(screen.getByRole("heading", { name: "2026年8月" })).toBeInTheDocument();
  });
});

describe("前月・翌月のリンク", () => {
  it("通常の月では前月・翌月ともリンクが有効", () => {
    render(<MonthNavigation yearMonth="2026-08" currentYearMonth="2026-08" />);
    const prev = screen.getByRole("link", { name: "前月へ" });
    const next = screen.getByRole("link", { name: "翌月へ" });
    expect(prev).toHaveAttribute("href", budgetsPath("2026-07"));
    expect(next).toHaveAttribute("href", budgetsPath("2026-09"));
  });

  it("下限月（MIN_YEAR_MONTH）では前月リンクを出さない", () => {
    render(<MonthNavigation yearMonth={MIN_YEAR_MONTH} currentYearMonth="2026-08" />);
    expect(screen.queryByRole("link", { name: "前月へ" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "翌月へ" })).toBeInTheDocument();
  });

  it("上限月（MAX_YEAR_MONTH）では翌月リンクを出さない", () => {
    render(<MonthNavigation yearMonth={MAX_YEAR_MONTH} currentYearMonth="2026-08" />);
    expect(screen.queryByRole("link", { name: "翌月へ" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "前月へ" })).toBeInTheDocument();
  });

  it("年をまたぐ移動も正しい月を指す（2026-01 の前月は 2025-12）", () => {
    render(<MonthNavigation yearMonth="2026-01" currentYearMonth="2026-08" />);
    expect(screen.getByRole("link", { name: "前月へ" })).toHaveAttribute(
      "href",
      budgetsPath("2025-12"),
    );
  });
});

describe("『今月へ』リンク", () => {
  it("表示中の月が今月と同じなら出さない", () => {
    render(<MonthNavigation yearMonth="2026-08" currentYearMonth="2026-08" />);
    expect(screen.queryByRole("link", { name: /今月へ/ })).not.toBeInTheDocument();
  });

  it("表示中の月が今月と違えば『今月へ』リンクを出す", () => {
    render(<MonthNavigation yearMonth="2026-05" currentYearMonth="2026-08" />);
    const link = screen.getByRole("link", { name: /今月（2026年8月）へ/ });
    expect(link).toHaveAttribute("href", budgetsPath("2026-08"));
  });
});
