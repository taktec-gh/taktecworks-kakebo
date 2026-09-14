// src/app/dashboard-view.tsx の描画を検証する。
//
// 期待値の根拠:
// - docs/steps/step-6.md「3-5. 画面 > /（ダッシュボード）」の並び順と文言
//   （1.残り使える金額 2.ペース判定 3.月末着地見込み 4.今月の無駄使い
//    5.払い出し先別バー 6.カテゴリ別バー 7.収支 8.今月の収入 9.主要な画面へのリンク）
// - 「総予算が0のとき、ペースと着地見込みを出さず、予算の設定を促す」
// - 「有効な払い出し先で予算未設定がある→『予算が未設定の払い出し先が N 件あります』」
// - docs/steps/step-6.md「tester への引き継ぎ」
//   「h2 = 2026年8月の残り使える金額 / ペース / 今月の無駄使い / 払い出し先別 / カテゴリ別 /
//    収支 / 今月の収入」「ペース欄の項目名: 今日までの目安 / 実績 / 経過 / 月末の着地見込み /
//    総予算との差」

import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { CostType } from "@/generated/prisma/enums";
import { BUDGETS_PATH, budgetsPath } from "@/app/budgets/action-state";
import { DashboardView } from "@/app/dashboard-view";
import { EXPENSES_PATH, NEW_EXPENSE_PATH } from "@/app/expenses/action-state";
import { INCOMES_PATH } from "@/app/incomes/action-state";
import { CATEGORIES_PATH } from "@/app/settings/categories/action-state";
import { PASSKEYS_PATH } from "@/app/settings/passkeys/action-state";
import { PAYMENT_SOURCES_PATH } from "@/app/settings/payment-sources/action-state";
import type {
  CategoryProgressRow,
  DashboardSummary,
  IncomeBalance,
  IncomeSummary,
  MonthProgress,
} from "@/lib/dashboard";

afterEach(() => {
  cleanup();
});

const PROGRESS: MonthProgress = {
  yearMonth: "2026-08",
  daysInMonth: 31,
  elapsedDays: 14,
  elapsedRatio: 14 / 31,
  kind: "current",
};

function buildSummary(overrides: Partial<DashboardSummary> = {}): DashboardSummary {
  return {
    progress: PROGRESS,
    totalBudgetYen: 100_000,
    totalSpentYen: 50_000,
    remainingYen: 50_000,
    totalExpectedYen: 45_000,
    totalProjectedYen: 90_000,
    totalStatus: "under",
    rows: [],
    unsetBudgetCount: 0,
    ...overrides,
  };
}

const EMPTY_INCOME_SUMMARY: IncomeSummary = { yearMonth: "2026-08", totalYen: 0, count: 0 };

function baseProps(overrides: Record<string, unknown> = {}) {
  return {
    yearMonth: "2026-08",
    currentYearMonth: "2026-08",
    summary: buildSummary(),
    categoryRows: [] as readonly CategoryProgressRow[],
    wasteTotalYen: 0,
    wasteCount: 0,
    incomeSummary: EMPTY_INCOME_SUMMARY,
    incomeBalance: null as IncomeBalance | null,
    ...overrides,
  };
}

describe("残り使える金額", () => {
  it("見出しに月名を明示する", () => {
    render(<DashboardView {...baseProps()} />);
    expect(screen.getByRole("heading", { name: "2026年8月の残り使える金額" })).toBeInTheDocument();
  });

  it("マイナスなら赤字クラスが付く", () => {
    render(
      <DashboardView
        {...baseProps({ summary: buildSummary({ remainingYen: -1_000 }) })}
      />,
    );
    const value = screen.getByText("-¥1,000");
    expect(value.className).toContain("text-red-600");
  });

  it("プラスなら赤字クラスが付かない", () => {
    render(<DashboardView {...baseProps({ summary: buildSummary({ remainingYen: 1_000 }) })} />);
    const value = screen.getByText("¥1,000");
    expect(value.className).not.toContain("text-red-600");
  });

  it("総予算と支出を小さく添える", () => {
    render(
      <DashboardView
        {...baseProps({
          summary: buildSummary({ totalBudgetYen: 100_000, totalSpentYen: 50_000 }),
        })}
      />,
    );
    expect(screen.getByText(/総予算 ¥100,000/)).toBeInTheDocument();
    expect(screen.getByText(/支出 ¥50,000/)).toBeInTheDocument();
  });
});

describe("予算未設定の注意", () => {
  it("総予算0円なら『予算がまだ設定されていません』を出し、ペース節は出さない", () => {
    render(<DashboardView {...baseProps({ summary: buildSummary({ totalBudgetYen: 0 }) })} />);
    // 「この月の予算がまだ設定されていません。」の直後にリンク要素が挟まるため、
    // <p> の直接のテキストノードだけを見る getByText の完全一致では拾えない（testing-library の
    // getNodeText は子要素のテキストを含めない）。正規表現の部分一致で拾う。
    expect(
      screen.getByText(/この月の予算がまだ設定されていません。/),
    ).toBeInTheDocument();
    const link = screen.getByRole("link", { name: "まず予算を設定してください" });
    expect(link).toHaveAttribute("href", budgetsPath("2026-08"));
    expect(screen.queryByRole("heading", { name: "ペース" })).not.toBeInTheDocument();
  });

  it("総予算があれば『予算がまだ設定されていません』は出ない", () => {
    render(<DashboardView {...baseProps()} />);
    expect(
      screen.queryByText("この月の予算がまだ設定されていません。"),
    ).not.toBeInTheDocument();
  });

  it("unsetBudgetCount が1以上なら件数付きの注意を出す", () => {
    render(
      <DashboardView {...baseProps({ summary: buildSummary({ unsetBudgetCount: 3 }) })} />,
    );
    expect(screen.getByText(/予算が未設定の払い出し先が 3 件あります。/)).toBeInTheDocument();
    const link = screen.getByRole("link", { name: "月次予算を開く" });
    expect(link).toHaveAttribute("href", budgetsPath("2026-08"));
  });

  it("unsetBudgetCount が0なら注意を出さない", () => {
    render(
      <DashboardView {...baseProps({ summary: buildSummary({ unsetBudgetCount: 0 }) })} />,
    );
    expect(screen.queryByText(/予算が未設定の払い出し先が/)).not.toBeInTheDocument();
  });
});

describe("ペース", () => {
  it("目安・実績・経過日数を表示する", () => {
    render(
      <DashboardView
        {...baseProps({
          summary: buildSummary({
            totalExpectedYen: 45_000,
            totalSpentYen: 50_000,
            totalStatus: "warning",
          }),
        })}
      />,
    );
    const heading = screen.getByRole("heading", { name: "ペース" });
    expect(heading).toBeInTheDocument();
    // 「残り使える金額」節（¥50,000 = remainingYen の既定値）と実績の額が同じ表記になり得るため、
    // ペース節（<section>）の中だけを見る。
    const section = heading.closest("section");
    if (!section) throw new Error("ペース節の <section> が見つかりません");
    const withinSection = within(section);
    expect(withinSection.getByText("要注意")).toBeInTheDocument();
    expect(withinSection.getByText("¥45,000")).toBeInTheDocument();
    expect(withinSection.getByText("¥50,000")).toBeInTheDocument();
    expect(withinSection.getByText("14 / 31 日")).toBeInTheDocument();
  });

  it("totalProjectedYen が null なら着地見込みの代わりに案内文を出す", () => {
    render(
      <DashboardView
        {...baseProps({ summary: buildSummary({ totalProjectedYen: null }) })}
      />,
    );
    expect(
      screen.getByText("まだ経過日数が 0 日のため、月末の着地見込みは出せません。"),
    ).toBeInTheDocument();
  });

  it("totalProjectedYen があれば見込み額と総予算との差を出す", () => {
    render(
      <DashboardView
        {...baseProps({
          summary: buildSummary({ totalBudgetYen: 100_000, totalProjectedYen: 90_000 }),
        })}
      />,
    );
    expect(screen.getByText("月末の着地見込み")).toBeInTheDocument();
    expect(screen.getByText("¥90,000")).toBeInTheDocument();
    // 総予算との差 = 100,000 - 90,000 = 10,000
    expect(screen.getByText(/総予算との差 ¥10,000/)).toBeInTheDocument();
  });

  it("見込みが総予算を超える場合はマイナス表示になる", () => {
    render(
      <DashboardView
        {...baseProps({
          summary: buildSummary({ totalBudgetYen: 100_000, totalProjectedYen: 120_000 }),
        })}
      />,
    );
    // 総予算との差 = 100,000 - 120,000 = -20,000
    expect(screen.getByText(/総予算との差 -¥20,000/)).toBeInTheDocument();
  });
});

describe("今月の無駄使い", () => {
  it("0円でも必ず出す", () => {
    render(<DashboardView {...baseProps({ wasteTotalYen: 0, wasteCount: 0 })} />);
    const heading = screen.getByRole("heading", { name: "今月の無駄使い" });
    expect(heading).toBeInTheDocument();
    // 「今月の収入」節も未記入で ¥0 を出すため、無駄使い節（<section>）の中だけを見る。
    const section = heading.closest("section");
    if (!section) throw new Error("今月の無駄使い節の <section> が見つかりません");
    const withinSection = within(section);
    expect(withinSection.getByText("¥0")).toBeInTheDocument();
    expect(withinSection.getByText(/0件/)).toBeInTheDocument();
  });

  it("件数と金額を表示する", () => {
    render(<DashboardView {...baseProps({ wasteTotalYen: 12_000, wasteCount: 3 })} />);
    expect(screen.getByText("¥12,000")).toBeInTheDocument();
    expect(screen.getByText(/3件/)).toBeInTheDocument();
  });
});

describe("カテゴリ別", () => {
  const categoryRow: CategoryProgressRow = {
    categoryId: "cat_1",
    name: "食費",
    costType: CostType.VARIABLE,
    budgetYen: 20_000,
    spentYen: 5_000,
    count: 3,
    remainingYen: 15_000,
    expectedYen: 9_000,
    usageRatio: 0.25,
    status: "under",
  };

  it("1件も無ければ節ごと出さない", () => {
    render(<DashboardView {...baseProps({ categoryRows: [] })} />);
    expect(screen.queryByRole("heading", { name: "カテゴリ別" })).not.toBeInTheDocument();
  });

  it("あれば節を出し、行を描画する", () => {
    render(<DashboardView {...baseProps({ categoryRows: [categoryRow] })} />);
    expect(screen.getByRole("heading", { name: "カテゴリ別" })).toBeInTheDocument();
    expect(screen.getByText("食費")).toBeInTheDocument();
  });
});

describe("収支", () => {
  it("前月の収入が0件（incomeBalance が null）なら枠ごと出さない", () => {
    render(<DashboardView {...baseProps({ incomeBalance: null })} />);
    expect(screen.queryByRole("heading", { name: "収支" })).not.toBeInTheDocument();
  });

  it("incomeBalance があれば収支の節を出す", () => {
    const balance: IncomeBalance = {
      incomeYearMonth: "2026-07",
      incomeTotalYen: 420_000,
      spentYen: 227_600,
      balanceYen: 192_400,
    };
    render(<DashboardView {...baseProps({ incomeBalance: balance })} />);
    expect(screen.getByRole("heading", { name: "収支" })).toBeInTheDocument();
  });
});

describe("今月の収入", () => {
  it("0件でも枠は残す", () => {
    render(<DashboardView {...baseProps({ incomeSummary: EMPTY_INCOME_SUMMARY })} />);
    expect(screen.getByRole("heading", { name: "今月の収入" })).toBeInTheDocument();
    expect(screen.getByText("（未記入）")).toBeInTheDocument();
  });
});

describe("主要な画面へのリンク", () => {
  it("支出一覧・月次予算・収入・払い出し先・カテゴリのリンクを持つ", () => {
    render(<DashboardView {...baseProps()} />);
    expect(screen.getByRole("link", { name: /支出一覧/ })).toHaveAttribute("href", EXPENSES_PATH);
    expect(screen.getByRole("link", { name: /月次予算/ })).toHaveAttribute("href", BUDGETS_PATH);
    expect(screen.getByRole("link", { name: "収入" })).toHaveAttribute("href", INCOMES_PATH);
    expect(screen.getByRole("link", { name: /払い出し先の設定/ })).toHaveAttribute(
      "href",
      PAYMENT_SOURCES_PATH,
    );
    expect(screen.getByRole("link", { name: /カテゴリの設定/ })).toHaveAttribute(
      "href",
      CATEGORIES_PATH,
    );
  });

  it("パスキーの設定へのリンクを持つ（Step 7 で追加）", () => {
    render(<DashboardView {...baseProps()} />);
    expect(screen.getByRole("link", { name: /パスキーの設定/ })).toHaveAttribute(
      "href",
      PASSKEYS_PATH,
    );
  });

  it("『支出を記録する』はドキュメント内の最後のリンクとして最も目立つ位置にある", () => {
    render(<DashboardView {...baseProps()} />);
    const links = screen.getAllByRole("link");
    const last = links[links.length - 1];
    expect(last).toHaveAttribute("href", NEW_EXPENSE_PATH);
    expect(last).toHaveTextContent("支出を記録する");
  });
});
