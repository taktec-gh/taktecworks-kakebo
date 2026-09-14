/**
 * 入力を数タップで終わらせるためのサジェスト計算（純粋関数・DB非依存）。
 *
 * features.md「直近使ったカテゴリ・払い出し先・店名をサジェスト
 * （2回目以降の入力を数タップに）」。
 *
 * **「直近30日・上位5件」に強い根拠はない。使ってみて調整する前提の初期値。**
 * 変えたくなったらこのファイルの定数だけを触ればよい（docs/steps/step-5.md）。
 */

/** クイック選択の集計期間（日）。今日を含む直近この日数 */
export const QUICK_PICK_WINDOW_DAYS = 30;

/** クイック選択に並べるカテゴリの最大件数 */
export const QUICK_PICK_CATEGORY_LIMIT = 5;

/** 店名の候補として出す最大件数 */
export const RECENT_STORE_NAME_LIMIT = 10;

/** 店名の候補を拾うために遡って読む支出の件数 */
export const RECENT_STORE_NAME_SCAN_LIMIT = 100;

/**
 * 「よく使う順」のカテゴリ id を選ぶ。
 *
 * @param usedCategoryIds 集計期間内に使われたカテゴリ id（重複あり・順不同）
 * @param orderedCategoryIds 選択肢に出せるカテゴリ id を**表示順**で並べたもの。
 *   ここに無い id（非表示・削除済み）は候補から落とす
 * @param limit 最大件数
 *
 * 並びは使用回数の多い順。同数のときは表示順が先のものを優先する
 * （同数のときに並びが揺れると、押す位置が毎回変わって遅くなるため）。
 *
 * 支出が1件も無ければ空配列。呼び出し側は空ならクイック選択の枠ごと出さないこと。
 */
export function selectQuickPickCategoryIds(
  usedCategoryIds: readonly string[],
  orderedCategoryIds: readonly string[],
  limit: number = QUICK_PICK_CATEGORY_LIMIT,
): string[] {
  if (limit <= 0) return [];

  const displayIndex = new Map<string, number>();
  orderedCategoryIds.forEach((id, index) => {
    if (!displayIndex.has(id)) displayIndex.set(id, index);
  });

  const counts = new Map<string, number>();
  for (const id of usedCategoryIds) {
    if (!displayIndex.has(id)) continue;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }

  return [...counts.entries()]
    .sort((a, b) => {
      if (a[1] !== b[1]) return b[1] - a[1];
      return (displayIndex.get(a[0]) ?? 0) - (displayIndex.get(b[0]) ?? 0);
    })
    .slice(0, limit)
    .map(([id]) => id);
}

/**
 * 店名の候補。重複を除いて先頭から limit 件。
 *
 * @param storeNames 新しい順に並んだ店名（null・空文字が混ざっていてよい）
 *
 * 入力の順序をそのまま保つ（＝直近に使ったものが先）。
 */
export function dedupeStoreNames(
  storeNames: readonly (string | null)[],
  limit: number = RECENT_STORE_NAME_LIMIT,
): string[] {
  if (limit <= 0) return [];

  const seen = new Set<string>();
  const result: string[] = [];

  for (const raw of storeNames) {
    if (typeof raw !== "string") continue;
    const name = raw.trim();
    if (name.length === 0 || seen.has(name)) continue;

    seen.add(name);
    result.push(name);
    if (result.length >= limit) break;
  }

  return result;
}
