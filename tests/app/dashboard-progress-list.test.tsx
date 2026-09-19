// src/app/dashboard-progress-list.tsx の描画を検証する。
//
// 期待値の根拠:
// - docs/steps/step-6.md「3-5. 画面 > 5. 払い出し先別バー」
//   「各行に 名前・実績/予算・目安・残り・バー。予算未設定の行はバーを出さず『予算未設定』と出す」
// - docs/steps/step-6.md「バーの実装は CSS（幅の%）でよい。…消化率が100%を超えたら
//   バーは100%で止め、色で超過を示す」
// - docs/steps/step-6.md「tester への引き継ぎ > 公開インターフェース」
// - docs/steps/pub-4.md 設計判断 3（インラインの `style` をやめ、SVG の `<rect width="…%">` に
//   置き換える。見た目と割合の表し方は変えない）と「実装完了後の引き継ぎ」
//   （DOM は `div[aria-hidden="true"] > svg > rect[width="N%"]`）

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { CostType, PaymentSourceType } from "@/generated/prisma/enums";
import {
  CategoryProgressList,
  DashboardProgressBar,
  PaymentSourceProgressList,
} from "@/app/dashboard-progress-list";
import type { CategoryProgressRow, PaymentSourceProgressRow } from "@/lib/dashboard";

afterEach(() => {
  cleanup();
});

function paymentRow(overrides: Partial<PaymentSourceProgressRow> = {}): PaymentSourceProgressRow {
  return {
    paymentSourceId: "ps_1",
    // 名前と種別ラベルの文言が偶然一致すると getByText が複数ヒットするため、
    // 種別ラベル（現金・クレジットカード・銀行引き落とし）とは別の名前にする
    name: "メイン財布",
    type: PaymentSourceType.CASH,
    isActive: true,
    budgetYen: 1_000,
    spentYen: 500,
    count: 2,
    remainingYen: 500,
    expectedYen: 400,
    usageRatio: 0.5,
    projectedYen: 900,
    status: "under",
    ...overrides,
  };
}

function categoryRow(overrides: Partial<CategoryProgressRow> = {}): CategoryProgressRow {
  return {
    categoryId: "cat_1",
    name: "食費",
    costType: CostType.VARIABLE,
    budgetYen: 20_000,
    spentYen: 10_000,
    count: 5,
    remainingYen: 10_000,
    expectedYen: 9_000,
    usageRatio: 0.5,
    status: "under",
    ...overrides,
  };
}

describe("DashboardProgressBar", () => {
  it("usageRatio が null なら何も描かない（予算未設定）", () => {
    const { container } = render(<DashboardProgressBar usageRatio={null} status="unknown" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("50%のときバーの幅は50%", () => {
    const { container } = render(<DashboardProgressBar usageRatio={0.5} status="under" />);
    const rect = container.querySelector('[aria-hidden="true"] > svg > rect') as SVGRectElement;
    expect(rect.getAttribute("width")).toBe("50%");
  });

  it("100%を超えてもバーの幅は100%で止まる", () => {
    const { container } = render(<DashboardProgressBar usageRatio={1.5} status="over" />);
    const rect = container.querySelector('[aria-hidden="true"] > svg > rect') as SVGRectElement;
    expect(rect.getAttribute("width")).toBe("100%");
  });

  it("Infinity（予算0円で使ってしまった）でも100%で止まる", () => {
    const { container } = render(
      <DashboardProgressBar usageRatio={Number.POSITIVE_INFINITY} status="over" />,
    );
    const rect = container.querySelector('[aria-hidden="true"] > svg > rect') as SVGRectElement;
    expect(rect.getAttribute("width")).toBe("100%");
  });

  it("インラインの style 属性を使わない（CSP の style-src に 'unsafe-inline' が無くても崩れない）", () => {
    const { container } = render(<DashboardProgressBar usageRatio={0.5} status="under" />);
    expect(container.querySelector("[style]")).toBeNull();
  });
});

describe("PaymentSourceProgressList", () => {
  it("行が0件のときは案内文を出す", () => {
    render(<PaymentSourceProgressList rows={[]} />);
    expect(
      screen.getByText("有効な払い出し先がありません。先に払い出し先を登録してください。"),
    ).toBeInTheDocument();
  });

  it("名前・実績/予算・目安・残りを表示する", () => {
    render(
      <PaymentSourceProgressList
        rows={[
          paymentRow({
            name: "メイン財布",
            spentYen: 500,
            budgetYen: 1_000,
            expectedYen: 400,
            remainingYen: 500,
          }),
        ]}
      />,
    );
    expect(screen.getByText("メイン財布")).toBeInTheDocument();
    expect(screen.getByText("¥500")).toBeInTheDocument();
    expect(screen.getByText("/ ¥1,000")).toBeInTheDocument();
    expect(screen.getByText(/目安 ¥400/)).toBeInTheDocument();
    expect(screen.getByText(/残り ¥500/)).toBeInTheDocument();
  });

  it("予算未設定の行はバーを描かず『予算未設定』とだけ出す", () => {
    render(
      <PaymentSourceProgressList
        rows={[
          paymentRow({
            budgetYen: null,
            expectedYen: null,
            remainingYen: null,
            usageRatio: null,
            projectedYen: null,
            status: "unknown",
          }),
        ]}
      />,
    );
    expect(screen.getByText("予算未設定")).toBeInTheDocument();
    expect(screen.queryByText(/目安/)).not.toBeInTheDocument();
  });

  it("無効な払い出し先には『無効』バッジが付く", () => {
    render(<PaymentSourceProgressList rows={[paymentRow({ isActive: false })]} />);
    expect(screen.getByText("無効")).toBeInTheDocument();
  });

  it("有効な払い出し先には『無効』バッジが付かない", () => {
    render(<PaymentSourceProgressList rows={[paymentRow({ isActive: true })]} />);
    expect(screen.queryByText("無効")).not.toBeInTheDocument();
  });

  it("払い出し先の種別ラベルを表示する（クレジットカード）", () => {
    render(
      <PaymentSourceProgressList
        rows={[paymentRow({ type: PaymentSourceType.CREDIT_CARD })]}
      />,
    );
    expect(screen.getByText("クレジットカード")).toBeInTheDocument();
  });

  it("渡した順にそのまま描画する（並べ替えは純粋関数の責任）", () => {
    render(
      <PaymentSourceProgressList
        rows={[
          paymentRow({ paymentSourceId: "ps_a", name: "A" }),
          paymentRow({ paymentSourceId: "ps_b", name: "B" }),
        ]}
      />,
    );
    const items = screen.getAllByRole("listitem");
    expect(items[0]).toHaveTextContent("A");
    expect(items[1]).toHaveTextContent("B");
  });

  it("ペース判定の日本語ラベルを表示する（要注意）", () => {
    render(<PaymentSourceProgressList rows={[paymentRow({ status: "warning" })]} />);
    expect(screen.getByText("要注意")).toBeInTheDocument();
  });
});

describe("CategoryProgressList", () => {
  it("名前・費目種別・実績/予算・目安・残りを表示する", () => {
    render(
      <CategoryProgressList
        rows={[
          categoryRow({
            name: "食費",
            costType: CostType.VARIABLE,
            spentYen: 10_000,
            budgetYen: 20_000,
            expectedYen: 9_000,
            remainingYen: 10_000,
          }),
        ]}
      />,
    );
    expect(screen.getByText("食費")).toBeInTheDocument();
    expect(screen.getByText("変動費")).toBeInTheDocument();
    expect(screen.getByText("¥10,000")).toBeInTheDocument();
    expect(screen.getByText("/ ¥20,000")).toBeInTheDocument();
    expect(screen.getByText(/目安 ¥9,000/)).toBeInTheDocument();
    expect(screen.getByText(/残り ¥10,000/)).toBeInTheDocument();
  });

  it("固定費のラベルを表示する", () => {
    render(<CategoryProgressList rows={[categoryRow({ costType: CostType.FIXED })]} />);
    expect(screen.getByText("固定費")).toBeInTheDocument();
  });

  it("渡した順にそのまま描画する", () => {
    render(
      <CategoryProgressList
        rows={[
          categoryRow({ categoryId: "cat_a", name: "A" }),
          categoryRow({ categoryId: "cat_b", name: "B" }),
        ]}
      />,
    );
    const items = screen.getAllByRole("listitem");
    expect(items[0]).toHaveTextContent("A");
    expect(items[1]).toHaveTextContent("B");
  });
});
