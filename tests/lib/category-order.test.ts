// @vitest-environment node
//
// src/lib/category-order.ts の並べ替え計算（純粋関数）を検証する。
// DB非依存なのでモックは不要。計算そのものは src/lib/ordering.ts の共通モジュールが
// 持つので、ここでは「isHidden でグループ分けされること」「カテゴリ向けの文言が
// 使われること」を中心に検証する。
//
// 表示順の仕様（docs/steps/step-4.md「設計判断 > 並べ替えロジックは共通化する」）:
// - 「表示」グループ → 「非表示」グループの順、各グループ内は sortOrder 昇順
// - 移動は同一グループ内でのみ。グループの端では拒否
// - sortOrder は隙間を作らず連番を保つ（並べ替え結果は常に全件 1..n）

import { describe, expect, it } from "vitest";

import {
  assignSequentialCategorySortOrder,
  calculateCategoryReorder,
  canMoveCategory,
  CATEGORY_ORDER_ERRORS,
  compareCategoryOrder,
  isMoveDirection,
  sortCategories,
  type CategoryOrderItem,
} from "@/lib/category-order";

/** 表示3件（sortOrder 1..3）+ 非表示2件（sortOrder 4..5）。すでに整列済みの基本形 */
function basicList(): CategoryOrderItem[] {
  return [
    { id: "a1", sortOrder: 1, isHidden: false },
    { id: "a2", sortOrder: 2, isHidden: false },
    { id: "a3", sortOrder: 3, isHidden: false },
    { id: "b1", sortOrder: 4, isHidden: true },
    { id: "b2", sortOrder: 5, isHidden: true },
  ];
}

describe("isMoveDirection", () => {
  it.each(["up", "down"])("%s は正しい方向", (value) => {
    expect(isMoveDirection(value)).toBe(true);
  });

  it.each(["left", "", "UP", null, undefined, 1])("%s は不正な方向", (value) => {
    expect(isMoveDirection(value)).toBe(false);
  });
});

describe("compareCategoryOrder / sortCategories", () => {
  it("表示グループが非表示グループより常に先に来る", () => {
    const list: CategoryOrderItem[] = [
      { id: "hidden-low-sort", sortOrder: 1, isHidden: true },
      { id: "visible-high-sort", sortOrder: 99, isHidden: false },
    ];
    expect(sortCategories(list).map((c) => c.id)).toEqual([
      "visible-high-sort",
      "hidden-low-sort",
    ]);
  });

  it("同じグループ内は sortOrder 昇順", () => {
    expect(sortCategories(basicList()).map((c) => c.id)).toEqual([
      "a1",
      "a2",
      "a3",
      "b1",
      "b2",
    ]);
  });

  it("isHidden・sortOrder が同値なら id 昇順で確定する（入力順に依らない）", () => {
    const list: CategoryOrderItem[] = [
      { id: "z", sortOrder: 1, isHidden: false },
      { id: "a", sortOrder: 1, isHidden: false },
      { id: "m", sortOrder: 1, isHidden: false },
    ];
    expect(sortCategories(list).map((c) => c.id)).toEqual(["a", "m", "z"]);
  });

  it("sortCategories は引数の配列を破壊しない", () => {
    const list = basicList();
    const before = JSON.parse(JSON.stringify(list));
    sortCategories(list);
    expect(list).toEqual(before);
  });

  it("compareCategoryOrder 単体でも同じ規則で比較できる", () => {
    const visible: CategoryOrderItem = { id: "a", sortOrder: 5, isHidden: false };
    const hidden: CategoryOrderItem = { id: "b", sortOrder: 1, isHidden: true };
    expect(compareCategoryOrder(visible, hidden)).toBeLessThan(0);
    expect(compareCategoryOrder(hidden, visible)).toBeGreaterThan(0);
    expect(compareCategoryOrder(visible, visible)).toBe(0);
  });
});

describe("assignSequentialCategorySortOrder", () => {
  it("表示順のまま1からの連番を割り当てる", () => {
    expect(assignSequentialCategorySortOrder(basicList())).toEqual([
      { id: "a1", sortOrder: 1 },
      { id: "a2", sortOrder: 2 },
      { id: "a3", sortOrder: 3 },
      { id: "b1", sortOrder: 4 },
      { id: "b2", sortOrder: 5 },
    ]);
  });

  it("欠番・重複があっても表示順に基づいた1..nの連番になる", () => {
    const list: CategoryOrderItem[] = [
      { id: "z", sortOrder: 500, isHidden: false },
      { id: "x", sortOrder: 10, isHidden: false },
      { id: "y", sortOrder: 10, isHidden: false },
    ];
    expect(assignSequentialCategorySortOrder(list)).toEqual([
      { id: "x", sortOrder: 1 },
      { id: "y", sortOrder: 2 },
      { id: "z", sortOrder: 3 },
    ]);
  });

  it("空配列は空配列を返す", () => {
    expect(assignSequentialCategorySortOrder([])).toEqual([]);
  });

  it("引数の配列を破壊しない", () => {
    const list = basicList();
    const before = JSON.parse(JSON.stringify(list));
    assignSequentialCategorySortOrder(list);
    expect(list).toEqual(before);
  });
});

describe("canMoveCategory — グループ境界", () => {
  it("表示グループの先頭は上へ移動できない", () => {
    expect(canMoveCategory(basicList(), "a1", "up")).toBe(false);
  });

  it("表示グループの末尾は下へ移動できない（非表示グループへ飛び越さない）", () => {
    expect(canMoveCategory(basicList(), "a3", "down")).toBe(false);
  });

  it("非表示グループの先頭は上へ移動できない（表示グループへ飛び越さない）", () => {
    expect(canMoveCategory(basicList(), "b1", "up")).toBe(false);
  });

  it("非表示グループの末尾（＝一覧の末尾）は下へ移動できない", () => {
    expect(canMoveCategory(basicList(), "b2", "down")).toBe(false);
  });

  it("表示グループの中間は上下どちらにも移動できる", () => {
    expect(canMoveCategory(basicList(), "a2", "up")).toBe(true);
    expect(canMoveCategory(basicList(), "a2", "down")).toBe(true);
  });

  it("非表示グループ内の移動（先頭以外を上へ、末尾以外を下へ）はできる", () => {
    expect(canMoveCategory(basicList(), "b2", "up")).toBe(true);
    expect(canMoveCategory(basicList(), "b1", "down")).toBe(true);
  });

  it("一覧に存在しない id は false", () => {
    expect(canMoveCategory(basicList(), "no-such-id", "up")).toBe(false);
  });

  it("表示グループが1件だけなら上下どちらにも移動できない", () => {
    const list: CategoryOrderItem[] = [{ id: "only", sortOrder: 1, isHidden: false }];
    expect(canMoveCategory(list, "only", "up")).toBe(false);
    expect(canMoveCategory(list, "only", "down")).toBe(false);
  });

  it("空の一覧は false", () => {
    expect(canMoveCategory([], "a1", "up")).toBe(false);
  });
});

describe("calculateCategoryReorder", () => {
  it("同一グループ内の隣接スワップは全件の sortOrder を 1..n に振り直す", () => {
    expect(calculateCategoryReorder(basicList(), "a1", "down")).toEqual({
      ok: true,
      assignments: [
        { id: "a2", sortOrder: 1 },
        { id: "a1", sortOrder: 2 },
        { id: "a3", sortOrder: 3 },
        { id: "b1", sortOrder: 4 },
        { id: "b2", sortOrder: 5 },
      ],
    });
  });

  it("非表示グループ内の移動は非表示グループの中だけを入れ替え、表示グループは変えない", () => {
    expect(calculateCategoryReorder(basicList(), "b1", "down")).toEqual({
      ok: true,
      assignments: [
        { id: "a1", sortOrder: 1 },
        { id: "a2", sortOrder: 2 },
        { id: "a3", sortOrder: 3 },
        { id: "b2", sortOrder: 4 },
        { id: "b1", sortOrder: 5 },
      ],
    });
  });

  it("表示グループ末尾を下へ動かそうとすると拒否される（非表示グループへ飛び越さない）", () => {
    expect(calculateCategoryReorder(basicList(), "a3", "down")).toEqual({
      ok: false,
      error: CATEGORY_ORDER_ERRORS.cannotMoveDown,
    });
  });

  it("非表示グループ先頭を上へ動かそうとすると拒否される（表示グループへ飛び越さない）", () => {
    expect(calculateCategoryReorder(basicList(), "b1", "up")).toEqual({
      ok: false,
      error: CATEGORY_ORDER_ERRORS.cannotMoveUp,
    });
  });

  it("一覧の先頭を上へ動かそうとすると拒否される", () => {
    expect(calculateCategoryReorder(basicList(), "a1", "up")).toEqual({
      ok: false,
      error: CATEGORY_ORDER_ERRORS.cannotMoveUp,
    });
  });

  it("一覧の末尾を下へ動かそうとすると拒否される", () => {
    expect(calculateCategoryReorder(basicList(), "b2", "down")).toEqual({
      ok: false,
      error: CATEGORY_ORDER_ERRORS.cannotMoveDown,
    });
  });

  it("存在しない id は notFound", () => {
    expect(calculateCategoryReorder(basicList(), "no-such-id", "up")).toEqual({
      ok: false,
      error: CATEGORY_ORDER_ERRORS.notFound,
    });
  });

  it("不正な方向は invalidDirection", () => {
    expect(calculateCategoryReorder(basicList(), "a1", "sideways" as never)).toEqual({
      ok: false,
      error: CATEGORY_ORDER_ERRORS.invalidDirection,
    });
  });

  it("空の一覧では notFound", () => {
    expect(calculateCategoryReorder([], "a1", "up")).toEqual({
      ok: false,
      error: CATEGORY_ORDER_ERRORS.notFound,
    });
  });

  it("未ソート・欠番・重複のある一覧を渡しても結果は 1..n の連番になる", () => {
    const list: CategoryOrderItem[] = [
      { id: "z", sortOrder: 500, isHidden: false },
      { id: "x", sortOrder: 10, isHidden: false },
      { id: "y", sortOrder: 10, isHidden: false },
    ];
    // 表示順: x, y, z（同値は id 昇順） → z を上へ動かすと y と入れ替わる
    expect(calculateCategoryReorder(list, "z", "up")).toEqual({
      ok: true,
      assignments: [
        { id: "x", sortOrder: 1 },
        { id: "z", sortOrder: 2 },
        { id: "y", sortOrder: 3 },
      ],
    });
  });

  it("引数の配列を破壊しない", () => {
    const list = basicList();
    const before = JSON.parse(JSON.stringify(list));
    calculateCategoryReorder(list, "a1", "down");
    expect(list).toEqual(before);
  });
});

describe("canMoveCategory と calculateCategoryReorder の可否判断が常に一致する", () => {
  const list = basicList();
  const cases: Array<[string, "up" | "down"]> = [
    ["a1", "up"],
    ["a1", "down"],
    ["a2", "up"],
    ["a2", "down"],
    ["a3", "up"],
    ["a3", "down"],
    ["b1", "up"],
    ["b1", "down"],
    ["b2", "up"],
    ["b2", "down"],
  ];

  it.each(cases)("%s を %s へ", (id, direction) => {
    const can = canMoveCategory(list, id, direction);
    const result = calculateCategoryReorder(list, id, direction);
    expect(result.ok).toBe(can);
  });
});
