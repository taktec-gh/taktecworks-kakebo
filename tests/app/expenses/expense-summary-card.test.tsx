// src/app/expenses/expense-summary-card.tsx の描画を検証する。
//
// 期待値の根拠:
// - docs/steps/step-5.md「設計判断 > 一覧は月単位」
//   「絞り込んだ結果の合計金額と件数を一覧の先頭に出す。
//    『今月の外食はいくらか』『浪費だけでいくらか』がその場で分かる」

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { WasteTag } from "@/generated/prisma/enums";
import { summarizeExpenses } from "@/lib/expense-summary";
import { ExpenseSummaryCard } from "@/app/expenses/expense-summary-card";

afterEach(() => {
  cleanup();
});

describe("合計表示", () => {
  it("filtering=false のときは『この月の合計』の見出し", () => {
    render(<ExpenseSummaryCard summary={summarizeExpenses([])} filtering={false} />);
    expect(screen.getByText("この月の合計")).toBeInTheDocument();
  });

  it("filtering=true のときは『絞り込んだ合計』の見出し", () => {
    render(<ExpenseSummaryCard summary={summarizeExpenses([])} filtering={true} />);
    expect(screen.getByText("絞り込んだ合計")).toBeInTheDocument();
  });

  it("合計金額・件数が正しく表示される", () => {
    // 手計算: 1000(必要) + 2000(浪費) = 3000円、2件
    const summary = summarizeExpenses([
      { amountYen: 1000, wasteTag: WasteTag.NECESSARY },
      { amountYen: 2000, wasteTag: WasteTag.WASTE },
    ]);
    render(<ExpenseSummaryCard summary={summary} filtering={false} />);
    expect(screen.getByText("¥3,000")).toBeInTheDocument();
    expect(screen.getByText("2件")).toBeInTheDocument();
  });

  it("空配列（0件）は ¥0・0件・浪費0件と表示する", () => {
    render(<ExpenseSummaryCard summary={summarizeExpenses([])} filtering={false} />);
    // 合計・必要・浪費・投資のすべてが ¥0 になるため複数ヒットする。件数で確認する
    expect(screen.getAllByText("¥0")).toHaveLength(4);
    expect(screen.getByText("0件")).toBeInTheDocument();
    expect(screen.getByText("浪費は 0件")).toBeInTheDocument();
  });

  it("浪費タグ別の内訳（必要・浪費・投資）を金額つきで表示する", () => {
    const summary = summarizeExpenses([
      { amountYen: 1000, wasteTag: WasteTag.NECESSARY },
      { amountYen: 2000, wasteTag: WasteTag.WASTE },
      { amountYen: 500, wasteTag: WasteTag.INVESTMENT },
    ]);
    render(<ExpenseSummaryCard summary={summary} filtering={false} />);
    expect(screen.getByText("必要")).toBeInTheDocument();
    expect(screen.getByText("¥1,000")).toBeInTheDocument();
    expect(screen.getByText("浪費")).toBeInTheDocument();
    expect(screen.getByText("¥2,000")).toBeInTheDocument();
    expect(screen.getByText("投資")).toBeInTheDocument();
    expect(screen.getByText("¥500")).toBeInTheDocument();
  });

  it("浪費件数を明示する（無駄使い検出がこのアプリの目的の半分のため）", () => {
    const summary = summarizeExpenses([
      { amountYen: 1000, wasteTag: WasteTag.WASTE },
      { amountYen: 2000, wasteTag: WasteTag.WASTE },
    ]);
    render(<ExpenseSummaryCard summary={summary} filtering={false} />);
    expect(screen.getByText("浪費は 2件")).toBeInTheDocument();
  });
});
