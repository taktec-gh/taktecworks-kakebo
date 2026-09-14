// src/app/expenses/expense-list.tsx の描画を検証する。
//
// 期待値の根拠:
// - docs/steps/step-5.md「実装内容 > 画面」「一覧（月切り替え・絞り込み・並べ替え・合計）」
// - docs/features.md「5. 支出一覧」（高額順で見ると無駄使いが即座に目に入る、の前提として
//   金額・日付・カテゴリが一覧に表示される必要がある）

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { WasteTag } from "@/generated/prisma/enums";
import { ExpenseList, type ExpenseListItem } from "@/app/expenses/expense-list";
import { expenseDetailPath } from "@/app/expenses/action-state";

function makeItem(overrides: Partial<ExpenseListItem> = {}): ExpenseListItem {
  return {
    id: "exp_1",
    date: "2026-08-13",
    amountYen: 1234,
    categoryName: "食費",
    paymentSourceName: "現金",
    wasteTag: WasteTag.NECESSARY,
    storeName: null,
    memo: null,
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
});

describe("空のとき", () => {
  it("emptyMessage をそのまま表示する", () => {
    render(<ExpenseList items={[]} emptyMessage="この月の支出はまだありません。" />);
    expect(screen.getByText("この月の支出はまだありません。")).toBeInTheDocument();
  });
});

describe("一覧表示", () => {
  it("日付・カテゴリ・金額・払い出し先を表示する", () => {
    render(
      <ExpenseList
        items={[makeItem({ date: "2026-08-13", amountYen: 1234 })]}
        emptyMessage=""
      />,
    );
    expect(screen.getByText("8/13(木)")).toBeInTheDocument();
    expect(screen.getByText("食費")).toBeInTheDocument();
    expect(screen.getByText("¥1,234")).toBeInTheDocument();
    expect(screen.getAllByText("現金").length).toBeGreaterThan(0);
  });

  it("1行が編集ページへのリンクになっている", () => {
    render(<ExpenseList items={[makeItem({ id: "exp_1" })]} emptyMessage="" />);
    const link = screen.getByRole("link");
    expect(link).toHaveAttribute("href", expenseDetailPath("exp_1"));
  });

  it("必要（NECESSARY）タグはバッジを出さない", () => {
    render(<ExpenseList items={[makeItem({ wasteTag: WasteTag.NECESSARY })]} emptyMessage="" />);
    expect(screen.queryByText("必要")).not.toBeInTheDocument();
  });

  it("浪費（WASTE）タグはバッジで表示する", () => {
    render(<ExpenseList items={[makeItem({ wasteTag: WasteTag.WASTE })]} emptyMessage="" />);
    expect(screen.getByText("浪費")).toBeInTheDocument();
  });

  it("投資（INVESTMENT）タグはバッジで表示する", () => {
    render(<ExpenseList items={[makeItem({ wasteTag: WasteTag.INVESTMENT })]} emptyMessage="" />);
    expect(screen.getByText("投資")).toBeInTheDocument();
  });

  it("店名があれば店名を、無くメモがあればメモを、両方無ければ払い出し先名を表示する", () => {
    cleanup();
    render(
      <ExpenseList
        items={[makeItem({ storeName: "スーパーA", memo: "牛乳", paymentSourceName: "現金" })]}
        emptyMessage=""
      />,
    );
    expect(screen.getByText("スーパーA")).toBeInTheDocument();

    cleanup();
    render(
      <ExpenseList
        items={[makeItem({ storeName: null, memo: "牛乳", paymentSourceName: "現金" })]}
        emptyMessage=""
      />,
    );
    expect(screen.getByText("牛乳")).toBeInTheDocument();

    cleanup();
    render(
      <ExpenseList
        items={[makeItem({ storeName: null, memo: null, paymentSourceName: "Aカード" })]}
        emptyMessage=""
      />,
    );
    expect(screen.getAllByText("Aカード").length).toBeGreaterThan(0);
  });

  it("複数件は渡した順番のまま表示する（並べ替えはデータ層の責任）", () => {
    render(
      <ExpenseList
        items={[
          makeItem({ id: "exp_1", amountYen: 500 }),
          makeItem({ id: "exp_2", amountYen: 3000 }),
        ]}
        emptyMessage=""
      />,
    );
    const links = screen.getAllByRole("link");
    expect(links[0]).toHaveAttribute("href", expenseDetailPath("exp_1"));
    expect(links[1]).toHaveAttribute("href", expenseDetailPath("exp_2"));
  });
});
