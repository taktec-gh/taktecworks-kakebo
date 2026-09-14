// src/app/settings/categories/category-list.tsx の描画を検証する。
//
// 期待値の根拠:
// - docs/steps/step-4.md「設計判断 > 並べ替えロジックは共通化する」
//   （表示→非表示の順、各グループ内は sortOrder 昇順、移動は同一グループ内のみ）
// - docs/steps/step-4.md「実装内容 > 2. カテゴリ管理」

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CostType } from "@/generated/prisma/enums";
import { CategoryList, type CategoryListItem } from "@/app/settings/categories/category-list";

const noopAction = vi.fn(() => ({ error: null }));

function item(overrides: Partial<CategoryListItem>): CategoryListItem {
  return {
    id: "id",
    sortOrder: 1,
    isHidden: false,
    name: "name",
    costType: CostType.VARIABLE,
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  noopAction.mockClear();
});

describe("空の一覧", () => {
  it("案内メッセージを表示する", () => {
    render(<CategoryList categories={[]} moveAction={noopAction} />);
    expect(screen.getByText(/カテゴリがまだありません/)).toBeInTheDocument();
  });

  it("グループ見出しは出さない", () => {
    render(<CategoryList categories={[]} moveAction={noopAction} />);
    expect(screen.queryByText("表示中")).not.toBeInTheDocument();
    expect(screen.queryByText("非表示")).not.toBeInTheDocument();
  });
});

describe("グループ分けと並び順", () => {
  it("表示グループが非表示グループより先に、各グループ内は sortOrder 昇順で表示される", () => {
    const categories: CategoryListItem[] = [
      item({ id: "b2", name: "旧カテゴリ2", isHidden: true, sortOrder: 5 }),
      item({ id: "a2", name: "日用品", isHidden: false, sortOrder: 2 }),
      item({ id: "b1", name: "旧カテゴリ1", isHidden: true, sortOrder: 4 }),
      item({ id: "a1", name: "食費", isHidden: false, sortOrder: 1 }),
    ];
    render(<CategoryList categories={categories} moveAction={noopAction} />);

    const names = screen.getAllByRole("link").map((link) => link.firstElementChild?.textContent);
    expect(names).toEqual(["食費", "日用品", "旧カテゴリ1", "旧カテゴリ2"]);
  });

  it("「表示中」見出しは常に表示される", () => {
    render(
      <CategoryList
        categories={[item({ id: "a1", name: "食費", isHidden: false })]}
        moveAction={noopAction}
      />,
    );
    expect(screen.getByRole("heading", { name: "表示中" })).toBeInTheDocument();
  });

  it("非表示の行が無ければ「非表示」の見出しは出さない", () => {
    render(
      <CategoryList
        categories={[item({ id: "a1", name: "食費", isHidden: false })]}
        moveAction={noopAction}
      />,
    );
    expect(screen.queryByRole("heading", { name: "非表示" })).not.toBeInTheDocument();
  });

  it("非表示の行があれば「非表示」の見出しを出す", () => {
    render(
      <CategoryList
        categories={[
          item({ id: "a1", name: "食費", isHidden: false }),
          item({ id: "b1", name: "旧カテゴリ", isHidden: true }),
        ]}
        moveAction={noopAction}
      />,
    );
    expect(screen.getByRole("heading", { name: "非表示" })).toBeInTheDocument();
  });

  it("表示中のカテゴリが1件も無い場合は案内文を表示する", () => {
    render(
      <CategoryList
        categories={[item({ id: "b1", name: "旧カテゴリ", isHidden: true })]}
        moveAction={noopAction}
      />,
    );
    expect(
      screen.getByText("表示中のカテゴリがありません。支出の記録には最低1件必要です。"),
    ).toBeInTheDocument();
  });
});

describe("一覧に出す情報（名前・固定費/変動費・非表示バッジ）", () => {
  it("固定費/変動費の日本語ラベルが表示される", () => {
    render(
      <CategoryList
        categories={[item({ id: "a1", name: "家賃", costType: CostType.FIXED })]}
        moveAction={noopAction}
      />,
    );
    expect(screen.getByText("固定費")).toBeInTheDocument();
  });

  it("非表示バッジは非表示グループの行にだけ表示される", () => {
    render(
      <CategoryList
        categories={[
          item({ id: "a1", name: "食費", isHidden: false }),
          item({ id: "b1", name: "旧カテゴリ", isHidden: true }),
        ]}
        moveAction={noopAction}
      />,
    );
    const badges = screen.getAllByText("非表示").filter((el) => el.tagName === "SPAN");
    expect(badges).toHaveLength(1);
  });
});

describe("上へ/下へボタンの活性状態（グループの端で非活性）", () => {
  it("表示グループ先頭は上へが非活性、末尾は下へが非活性", () => {
    render(
      <CategoryList
        categories={[
          item({ id: "a1", name: "食費", isHidden: false, sortOrder: 1 }),
          item({ id: "a2", name: "日用品", isHidden: false, sortOrder: 2 }),
        ]}
        moveAction={noopAction}
      />,
    );
    expect(screen.getByRole("button", { name: "食費 を上へ移動" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "食費 を下へ移動" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "日用品 を上へ移動" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "日用品 を下へ移動" })).toBeDisabled();
  });

  it("表示グループの末尾から非表示グループへは移動できない（下へが非活性のまま）", () => {
    render(
      <CategoryList
        categories={[
          item({ id: "a1", name: "食費", isHidden: false, sortOrder: 1 }),
          item({ id: "b1", name: "旧カテゴリ", isHidden: true, sortOrder: 2 }),
        ]}
        moveAction={noopAction}
      />,
    );
    expect(screen.getByRole("button", { name: "食費 を下へ移動" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "旧カテゴリ を上へ移動" })).toBeDisabled();
  });

  it("グループ内が1件だけなら上下とも非活性", () => {
    render(
      <CategoryList
        categories={[item({ id: "a1", name: "食費", isHidden: false })]}
        moveAction={noopAction}
      />,
    );
    expect(screen.getByRole("button", { name: "食費 を上へ移動" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "食費 を下へ移動" })).toBeDisabled();
  });
});
