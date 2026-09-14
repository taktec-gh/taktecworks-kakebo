// @vitest-environment node
//
// src/lib/expense-suggestions.ts のクイック選択・店名候補の選定（純粋関数）を検証する。
//
// 期待値の根拠:
// - docs/steps/step-5.md「設計判断 > カテゴリは『よく使う順』を先頭に出す」
//   「直近30日間の使用回数が多い上位5件」「同数なら表示順が先を優先」
//   「支出が1件も無いうちはクイック選択を出さない」
// - docs/steps/step-5.md「実装完了後の引き継ぎ > 特に確認したい観点」8.
//   「回数降順、同数なら表示順が先を優先、一覧に無い id を落とす、上限の切り捨て」

import { describe, expect, it } from "vitest";

import {
  dedupeStoreNames,
  QUICK_PICK_CATEGORY_LIMIT,
  QUICK_PICK_WINDOW_DAYS,
  RECENT_STORE_NAME_LIMIT,
  selectQuickPickCategoryIds,
} from "@/lib/expense-suggestions";

describe("定数", () => {
  it("集計期間は30日、上限は5件", () => {
    expect(QUICK_PICK_WINDOW_DAYS).toBe(30);
    expect(QUICK_PICK_CATEGORY_LIMIT).toBe(5);
  });

  it("店名候補の上限は10件", () => {
    expect(RECENT_STORE_NAME_LIMIT).toBe(10);
  });
});

describe("selectQuickPickCategoryIds", () => {
  const ORDER = ["cat_1", "cat_2", "cat_3", "cat_4", "cat_5", "cat_6"];

  it("支出が1件も無ければ空配列（クイック選択の枠ごと出さない）", () => {
    expect(selectQuickPickCategoryIds([], ORDER)).toEqual([]);
  });

  it("使用回数の多い順に並べる", () => {
    const used = ["cat_2", "cat_1", "cat_1", "cat_1", "cat_2"]; // cat_1:3件, cat_2:2件
    expect(selectQuickPickCategoryIds(used, ORDER)).toEqual(["cat_1", "cat_2"]);
  });

  it("同数のときは表示順（orderedCategoryIds）が先のものを優先する", () => {
    // cat_3 と cat_1 が同数(1件)。表示順は cat_1 が先なので cat_1 が先に来る
    const used = ["cat_3", "cat_1"];
    expect(selectQuickPickCategoryIds(used, ORDER)).toEqual(["cat_1", "cat_3"]);
  });

  it("選択肢に無い id（非表示・削除済み）は候補から落とす", () => {
    const used = ["cat_1", "unknown_id", "unknown_id", "unknown_id"];
    expect(selectQuickPickCategoryIds(used, ORDER)).toEqual(["cat_1"]);
  });

  it("上位N件で切り捨てる（既定は5件）", () => {
    // 6カテゴリすべて1回ずつ使用 → 表示順の先頭5件だけ残る
    const used = ["cat_6", "cat_5", "cat_4", "cat_3", "cat_2", "cat_1"];
    expect(selectQuickPickCategoryIds(used, ORDER)).toEqual([
      "cat_1",
      "cat_2",
      "cat_3",
      "cat_4",
      "cat_5",
    ]);
  });

  it("limit を明示的に指定できる", () => {
    const used = ["cat_1", "cat_2", "cat_3"];
    expect(selectQuickPickCategoryIds(used, ORDER, 2)).toEqual(["cat_1", "cat_2"]);
  });

  it("limit が0以下なら空配列", () => {
    expect(selectQuickPickCategoryIds(["cat_1"], ORDER, 0)).toEqual([]);
    expect(selectQuickPickCategoryIds(["cat_1"], ORDER, -1)).toEqual([]);
  });

  it("orderedCategoryIds が空なら空配列", () => {
    expect(selectQuickPickCategoryIds(["cat_1"], [])).toEqual([]);
  });
});

describe("dedupeStoreNames", () => {
  it("重複を除いて先頭からlimit件を返す（直近の順を保つ）", () => {
    expect(dedupeStoreNames(["スーパーA", "スーパーB", "スーパーA"])).toEqual([
      "スーパーA",
      "スーパーB",
    ]);
  });

  it("null・空文字は無視する", () => {
    expect(dedupeStoreNames([null, "", "  ", "スーパーA"])).toEqual(["スーパーA"]);
  });

  it("前後の空白を trim してから比較する", () => {
    expect(dedupeStoreNames(["スーパーA", "  スーパーA  "])).toEqual(["スーパーA"]);
  });

  it("limit で切り捨てる", () => {
    expect(dedupeStoreNames(["A", "B", "C"], 2)).toEqual(["A", "B"]);
  });

  it("limit が0以下なら空配列", () => {
    expect(dedupeStoreNames(["A"], 0)).toEqual([]);
  });

  it("空配列は空配列", () => {
    expect(dedupeStoreNames([])).toEqual([]);
  });
});
