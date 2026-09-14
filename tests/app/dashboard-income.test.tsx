// src/app/dashboard-income.tsx（収支カード / 今月の収入カード）の描画を検証する。
//
// 期待値の根拠:
// - docs/steps/step-6.md「設計判断 > 2. 収支は『先月の総収入 − 今月の総支出』だけ」
//   「必ず月名を明示する（『2026年7月の収入』）」「『残り』という語を単独で使わない」
// - docs/steps/step-6.md「3-5. 画面」の7・8の見え方の見本
//   （収支欄の行: 2026年7月の収入 / 2026年8月の支出 / 差額）
// - docs/steps/step-6.md「tester への引き継ぎ」
//   「収支の3行目のラベルは『差額』」「総予算との比較・注意文は出さない」

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { IncomeBalanceCard, MonthlyIncomeCard } from "@/app/dashboard-income";
import { incomesPath } from "@/app/incomes/action-state";
import type { IncomeBalance, IncomeSummary } from "@/lib/dashboard";

afterEach(() => {
  cleanup();
});

describe("IncomeBalanceCard", () => {
  const balance: IncomeBalance = {
    incomeYearMonth: "2026-07",
    incomeTotalYen: 420_000,
    spentYen: 227_600,
    balanceYen: 192_400,
  };

  it("収入を見た月（前月）と支出を見た月（表示中の月）を両方明示する", () => {
    render(<IncomeBalanceCard yearMonth="2026-08" balance={balance} />);
    expect(screen.getByText("2026年7月の収入")).toBeInTheDocument();
    expect(screen.getByText("2026年8月の支出")).toBeInTheDocument();
  });

  it("収入の金額と、支出はマイナス表示、差額を表示する", () => {
    render(<IncomeBalanceCard yearMonth="2026-08" balance={balance} />);
    expect(screen.getByText("¥420,000")).toBeInTheDocument();
    expect(screen.getByText("-¥227,600")).toBeInTheDocument();
    expect(screen.getByText("¥192,400")).toBeInTheDocument();
  });

  it("3行目のラベルは『差額』（『残り』という語は使わない）", () => {
    render(<IncomeBalanceCard yearMonth="2026-08" balance={balance} />);
    expect(screen.getByText("差額")).toBeInTheDocument();
    expect(screen.queryByText("残り")).not.toBeInTheDocument();
  });

  it("差額がマイナスのときは赤字クラスが付く", () => {
    const negativeBalance: IncomeBalance = {
      incomeYearMonth: "2026-07",
      incomeTotalYen: 100_000,
      spentYen: 150_000,
      balanceYen: -50_000,
    };
    render(<IncomeBalanceCard yearMonth="2026-08" balance={negativeBalance} />);
    const value = screen.getByText("-¥50,000");
    expect(value.className).toContain("text-red-600");
  });

  it("差額がプラスのときは赤字クラスが付かない", () => {
    render(<IncomeBalanceCard yearMonth="2026-08" balance={balance} />);
    const value = screen.getByText("¥192,400");
    expect(value.className).not.toContain("text-red-600");
  });

  it("見出しは『収支』", () => {
    render(<IncomeBalanceCard yearMonth="2026-08" balance={balance} />);
    expect(screen.getByRole("heading", { name: "収支" })).toBeInTheDocument();
  });
});

describe("MonthlyIncomeCard", () => {
  it("月名と合計、件数を表示する", () => {
    const summary: IncomeSummary = { yearMonth: "2026-08", totalYen: 300_000, count: 2 };
    render(<MonthlyIncomeCard summary={summary} />);
    expect(screen.getByText("2026年8月")).toBeInTheDocument();
    expect(screen.getByText("¥300,000")).toBeInTheDocument();
    expect(screen.getByText("（2件）")).toBeInTheDocument();
  });

  it("0件のときは『未記入』と出す（総予算との比較や注意文は出さない）", () => {
    const summary: IncomeSummary = { yearMonth: "2026-08", totalYen: 0, count: 0 };
    render(<MonthlyIncomeCard summary={summary} />);
    expect(screen.getByText("（未記入）")).toBeInTheDocument();
    expect(screen.queryByText(/予算/)).not.toBeInTheDocument();
  });

  it("収入画面（対象月指定）へのリンクを持つ", () => {
    const summary: IncomeSummary = { yearMonth: "2026-08", totalYen: 0, count: 0 };
    render(<MonthlyIncomeCard summary={summary} />);
    const link = screen.getByRole("link", { name: /収入を記録する/ });
    expect(link).toHaveAttribute("href", incomesPath("2026-08"));
  });

  it("見出しは『今月の収入』", () => {
    const summary: IncomeSummary = { yearMonth: "2026-08", totalYen: 0, count: 0 };
    render(<MonthlyIncomeCard summary={summary} />);
    expect(screen.getByRole("heading", { name: "今月の収入" })).toBeInTheDocument();
  });
});
