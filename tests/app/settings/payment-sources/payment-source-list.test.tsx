// src/app/settings/payment-sources/payment-source-list.tsx の描画を検証する。
//
// 期待値の根拠:
// - docs/steps/step-3.md「設計判断」の並べ替え規則
//   （有効→無効の順、各グループ内は sortOrder 昇順、移動は同一グループ内のみ）
// - docs/steps/step-3.md「一覧に出す情報」

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PaymentSourceType } from "@/generated/prisma/enums";
import {
  PaymentSourceList,
  type PaymentSourceListItem,
} from "@/app/settings/payment-sources/payment-source-list";

const noopAction = vi.fn(() => ({ error: null }));

function item(overrides: Partial<PaymentSourceListItem>): PaymentSourceListItem {
  return {
    id: "id",
    sortOrder: 1,
    isActive: true,
    isDefault: false,
    name: "name",
    type: PaymentSourceType.CASH,
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  noopAction.mockClear();
});

describe("空の一覧", () => {
  it("案内メッセージを表示する", () => {
    render(<PaymentSourceList sources={[]} moveAction={noopAction} />);
    expect(screen.getByText(/払い出し先がまだありません/)).toBeInTheDocument();
  });

  it("グループ見出しは出さない", () => {
    render(<PaymentSourceList sources={[]} moveAction={noopAction} />);
    expect(screen.queryByText("有効")).not.toBeInTheDocument();
    expect(screen.queryByText("無効")).not.toBeInTheDocument();
  });
});

describe("グループ分けと並び順", () => {
  it("有効グループが無効グループより先に、各グループ内は sortOrder 昇順で表示される", () => {
    const sources: PaymentSourceListItem[] = [
      item({ id: "b2", name: "使わないカード", isActive: false, sortOrder: 5 }),
      item({ id: "a2", name: "Aカード", isActive: true, sortOrder: 2 }),
      item({ id: "b1", name: "眠っている口座", isActive: false, sortOrder: 4 }),
      item({ id: "a1", name: "現金", isActive: true, sortOrder: 1 }),
    ];
    render(<PaymentSourceList sources={sources} moveAction={noopAction} />);

    // 各行の名前だけを見る（link.textContent はタイプ・バッジも含んでしまうため）
    const names = screen.getAllByRole("link").map((link) => link.firstElementChild?.textContent);
    expect(names).toEqual(["現金", "Aカード", "眠っている口座", "使わないカード"]);
  });

  it("有効グループの見出しは常に表示される", () => {
    render(
      <PaymentSourceList
        sources={[item({ id: "a1", name: "現金", isActive: true })]}
        moveAction={noopAction}
      />,
    );
    expect(screen.getByRole("heading", { name: "有効" })).toBeInTheDocument();
  });

  it("無効な行が無ければ「無効」の見出しは出さない", () => {
    render(
      <PaymentSourceList
        sources={[item({ id: "a1", name: "現金", isActive: true })]}
        moveAction={noopAction}
      />,
    );
    expect(screen.queryByRole("heading", { name: "無効" })).not.toBeInTheDocument();
  });

  it("無効な行があれば「無効」の見出しを出す", () => {
    render(
      <PaymentSourceList
        sources={[
          item({ id: "a1", name: "現金", isActive: true }),
          item({ id: "b1", name: "旧カード", isActive: false }),
        ]}
        moveAction={noopAction}
      />,
    );
    expect(screen.getByRole("heading", { name: "無効" })).toBeInTheDocument();
  });

  it("有効な行が1件も無い場合は「有効な払い出し先がありません」と表示する", () => {
    render(
      <PaymentSourceList
        sources={[item({ id: "b1", name: "旧カード", isActive: false })]}
        moveAction={noopAction}
      />,
    );
    expect(screen.getByText("有効な払い出し先がありません。")).toBeInTheDocument();
  });
});

describe("一覧に出す情報（名前・タイプ・既定バッジ・無効バッジ）", () => {
  it("既定バッジは isDefault の行にだけ表示される", () => {
    render(
      <PaymentSourceList
        sources={[
          item({ id: "a1", name: "現金", isDefault: true }),
          item({ id: "a2", name: "Aカード", isDefault: false, sortOrder: 2 }),
        ]}
        moveAction={noopAction}
      />,
    );
    const badges = screen.getAllByText("既定");
    expect(badges).toHaveLength(1);
  });

  it("タイプの日本語ラベルが表示される", () => {
    render(
      <PaymentSourceList
        sources={[item({ id: "a1", name: "A銀行", type: PaymentSourceType.BANK_DEBIT })]}
        moveAction={noopAction}
      />,
    );
    expect(screen.getByText("銀行引き落とし")).toBeInTheDocument();
  });

  it("無効バッジは無効グループの行にだけ表示される", () => {
    render(
      <PaymentSourceList
        sources={[
          item({ id: "a1", name: "現金", isActive: true }),
          item({ id: "b1", name: "旧カード", isActive: false }),
        ]}
        moveAction={noopAction}
      />,
    );
    // 「無効」は見出し(h2)としても出るため、バッジ(span)だけを数える
    const badges = screen.getAllByText("無効").filter((el) => el.tagName === "SPAN");
    expect(badges).toHaveLength(1);
  });
});

describe("上へ/下へボタンの活性状態（グループの端で非活性）", () => {
  it("有効グループ先頭は上へが非活性、末尾は下へが非活性", () => {
    render(
      <PaymentSourceList
        sources={[
          item({ id: "a1", name: "現金", isActive: true, sortOrder: 1 }),
          item({ id: "a2", name: "Aカード", isActive: true, sortOrder: 2 }),
        ]}
        moveAction={noopAction}
      />,
    );
    expect(screen.getByRole("button", { name: "現金 を上へ移動" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "現金 を下へ移動" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Aカード を上へ移動" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Aカード を下へ移動" })).toBeDisabled();
  });

  it("有効グループの末尾から無効グループへは移動できない（下へが非活性のまま）", () => {
    render(
      <PaymentSourceList
        sources={[
          item({ id: "a1", name: "現金", isActive: true, sortOrder: 1 }),
          item({ id: "b1", name: "旧カード", isActive: false, sortOrder: 2 }),
        ]}
        moveAction={noopAction}
      />,
    );
    expect(screen.getByRole("button", { name: "現金 を下へ移動" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "旧カード を上へ移動" })).toBeDisabled();
  });

  it("グループ内が1件だけなら上下とも非活性", () => {
    render(
      <PaymentSourceList
        sources={[item({ id: "a1", name: "現金", isActive: true })]}
        moveAction={noopAction}
      />,
    );
    expect(screen.getByRole("button", { name: "現金 を上へ移動" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "現金 を下へ移動" })).toBeDisabled();
  });
});
