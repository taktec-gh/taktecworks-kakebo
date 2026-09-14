# Step 6 — ダッシュボード + 収入の入力

[roadmap.md](../roadmap.md) の Step 6。**ここで実運用を開始する。**
完了条件は「残高・ペース・着地見込みのテストが通る」。

## 前提

- Step 3（払い出し先）・Step 4（カテゴリ / 月次予算）・Step 5（支出）は完了・マージ済み
- 総予算 = その月の `Budget`（払い出し先ごとの予算）の合計。**総予算を直接入力する欄は無い**
- `CategoryBudget` は任意の補助上限で、**総予算には一切足さない**（二重計上になる）
- 既存の純粋関数を使い回すこと。**同じ計算を書き直さない**
  - `src/lib/year-month.ts` … `"YYYY-MM"` の検証・移動・表示。JST 固定
  - `src/lib/expense-date.ts` … `getCurrentDate` / `getDaysInMonth` / `getYearMonthOfDate` / `getMonthDateRange`
  - `src/lib/expense-summary.ts` … `summarizeExpenses`（浪費タグ別内訳）/ `groupExpenseTotals`（任意キーで合計）
  - `src/lib/budget-calculation.ts` … `formatYen` / `sumAmounts` / `parseBudgetAmountInput`
  - `src/lib/amount-input.ts` … 金額入力の正規化（全角・カンマ・空白）
  - `src/lib/payment-source-order.ts` / `category-order.ts` … 表示順
- **時刻を関数の中で `new Date()` から取らない。** 現在時刻は引数で受け取る（`getCurrentDate(now)` と同じ流儀）。テストできなくなる

---

## 設計判断

### 1. ペースは「払い出し先ごとに単純日割り」（利用者が決定）

**今日までの目安額 = その払い出し先の予算 × 経過日数 ÷ その月の日数**

固定費と変動費を分けて計算することは**しない**。カテゴリ単位でも計算しない。

理由（利用者の言葉）: 現金は主に変動費のみ、銀行引き落としは固定費のみ、クレジットカードは固定費と変動費が混ざる。
**払い出し先ごとに分かれていれば、その混ざり方を含めて個別に確認できる。**

この方式の既知の挙動として、銀行引き落としの払い出し先は引き落とし日の直後に必ず「超過」表示になる。
これは想定内で、**その払い出し先の中に閉じるので現金やクレジットカードの判断を濁さない**。
総額のペースも同時に出るため、全体としては月内で均される。
**「固定費だから日割りしない」といった例外処理を勝手に入れないこと。**

### 2. 収支は「先月の総収入 − 今月の総支出」だけ（利用者が決定）

給与は前月に振り込まれ、それで今月を暮らす。だから**今月の生活の原資は先月の収入**という見方をする。

- **収支の差額 = 前月の `Income` 合計 − 表示中の月の支出合計**
- **予算とは一切関連付けない。** 総予算や消化率と混ぜないこと
- **前月の収入が未記入（レコード0件）なら、計算も表示もしない。** 枠ごと出さない
- 貯蓄額・資産・口座残高は扱わない（[features.md](../features.md) の非対象）

「今月の収入」は別枠で合計と件数だけ出す（来月の原資になるので、入れ忘れに気づけるように）。
**総予算との比較や注意文は出さない。**

#### `Income.yearMonth` は「受け取った月」

7/25 に振り込まれた給与は **`2026-07`** として記録する。ここを取り違えると数字が黙って1ヶ月ずれる。

**`/incomes` の画面で「受け取った月」と明示すること。** 検証では防げないので、ラベルで防ぐ。

#### 表示中の月に追従する

ダッシュボードには月の切り替えがある。2026-07 を表示しているときは
**「2026年6月の収入 − 2026年7月の支出」**になる。常に実際の今月で固定しない。

画面上部の「残り使える金額」（総予算 − 支出）と数字が2つ並ぶため、
**必ず月名を明示する**（「2026年7月の収入」）。ラベルが曖昧だと取り違える。

#### 編集画面は作らない

**追加・一覧・削除のみ。** 金額とラベルだけの小さなレコードなので、
直したいときは消して入れ直すほうが手数が少なく、画面も1つで済む。

### 3. 月ナビゲーションを共通化する

`src/app/budgets/month-navigation.tsx` と `src/app/expenses/expense-month-navigation.tsx` は、
**リンク先の組み立て方以外が完全に同一**。ダッシュボードでこれが3つ目になるため、ここで一本化する。

Step 4 で並べ替えを `src/lib/ordering.ts` に共通化したのと同じ判断（同じ表示を3箇所に複製すると、
片方だけ壊れる余地が生まれる）。

- `src/components/month-navigation.tsx` を新設する（`src/app/` の外。ルーティング対象にしないため）
- props は `{ yearMonth, currentYearMonth, hrefForMonth: (yearMonth: string) => string }`
- 既存の2つは、この共通コンポーネントに委譲する薄いラッパーとして残す。
  **公開インターフェース（props の型・export 名・描画結果）を変えないこと。** 既存テストが通ったままであること

---

## 実装内容

### 3-1. `src/lib/dashboard.ts`（新規・純粋関数）

DB にも Next.js にも依存させない。**この Step の中心。テストの主対象。**

#### 月の進み具合

```ts
export type MonthKind = "past" | "current" | "future";

export type MonthProgress = {
  yearMonth: string;
  /** その月の日数 */
  daysInMonth: number;
  /** 経過日数。当月は「今日の日」、過去月は daysInMonth、未来月は 0 */
  elapsedDays: number;
  /** elapsedDays / daysInMonth（0〜1） */
  elapsedRatio: number;
  kind: MonthKind;
};

/** @param today "YYYY-MM-DD"。呼び出し側が getCurrentDate(now) で作る */
export function getMonthProgress(yearMonth: string, today: string): MonthProgress;
```

- 当月の判定は `getYearMonthOfDate(today) === yearMonth`
- **当月の経過日数は「今日の日」そのもの**（8/14 なら 14）。今日はもう使える日なので含める
- 未来月は `elapsedDays = 0`、`elapsedRatio = 0`
- 過去月は `elapsedDays = daysInMonth`、`elapsedRatio = 1`

#### ペース判定

```ts
/** 予算未設定は "unknown"。判定も目安も出さない */
export type PaceStatus = "under" | "warning" | "over" | "unknown";

/** 目安のこの割合を超えたら要注意 */
export const PACE_WARNING_RATIO = 0.9;
```

判定は上から順に評価する。

| 条件 | 判定 |
|---|---|
| 予算が未設定（null） | `unknown` |
| 実績 > 予算 | `over`（月内のどこであっても予算超過は超過） |
| 実績 > 目安 | `over` |
| 実績 > 目安 × `PACE_WARNING_RATIO` | `warning` |
| それ以外 | `under` |

#### 払い出し先ごとの行

```ts
export type PaymentSourceProgressRow = {
  paymentSourceId: string;
  name: string;
  type: PaymentSourceType;
  isActive: boolean;
  /** 未設定は null。0 は「0円の予算」であり null とは区別する */
  budgetYen: number | null;
  spentYen: number;
  count: number;
  /** 予算 − 実績。マイナスもあり得る。予算未設定なら null */
  remainingYen: number | null;
  /** 今日までの目安。予算未設定なら null */
  expectedYen: number | null;
  /** 消化率。並べ替えのキー。下の規則を厳密に守ること */
  usageRatio: number | null;
  /** 月末着地見込み。経過日数 0 なら null */
  projectedYen: number | null;
  status: PaceStatus;
};
```

**端数の扱い**（テストで固定する。勝手に変えない）

- 目安 `expectedYen` = `Math.floor(予算 × 経過日数 ÷ 月の日数)` … **切り捨て**。「使ってよい額」なので少なめに見る
- 着地見込み `projectedYen` = `Math.ceil(実績 ÷ 経過日数 × 月の日数)` … **切り上げ**。「このままだといくらになるか」なので多めに見る

**消化率 `usageRatio` の規則**（ゼロ除算と並べ替えの要）

| 状況 | 値 |
|---|---|
| 予算が未設定 | `null` |
| 予算 > 0 | `実績 ÷ 予算` |
| 予算 = 0 かつ 実績 = 0 | `0` |
| 予算 = 0 かつ 実績 > 0 | `Number.POSITIVE_INFINITY` |

最後の行を `null` や `0` にしてはいけない。**0円の予算に対して使ってしまった払い出し先が最も危険**であり、
消化率の降順で並べたときに先頭へ来る必要がある。

**行に含める払い出し先**

- 有効な払い出し先は**全件**（予算も支出も無くても行を出す。「予算を入れ忘れている」ことが見えるように）
- 無効な払い出し先は、**予算か支出のどちらかがある場合だけ**出す
  （Step 4 の `buildBudgetSummary` と同じ考え方。ただし支出も条件に入れる）

**並び順**: 消化率の降順（`features.md`「消化率順に並べる＝一番危ない払い出し先が一番上」）。
同率なら払い出し先の表示順（`sortPaymentSources`）。予算未設定（`usageRatio === null`）は**末尾**にまとめ、その中は表示順。

#### 全体の集計

```ts
export type DashboardSummary = {
  progress: MonthProgress;
  /** その月の Budget レコードの合計 = 総予算。無効な払い出し先の分も含む */
  totalBudgetYen: number;
  /** その月の支出合計 */
  totalSpentYen: number;
  /** 総予算 − 実績。**画面最上部に大きく出す「残り使える金額」**。マイナスもあり得る */
  remainingYen: number;
  totalExpectedYen: number;
  totalProjectedYen: number | null;
  totalStatus: PaceStatus;
  rows: PaymentSourceProgressRow[];
  /** 有効な払い出し先のうち予算が未設定の件数。0 なら注意を出さない */
  unsetBudgetCount: number;
};
```

**総予算が 0 のとき**（予算を1つも入れていない）は `totalStatus = "unknown"` とし、ペースも着地見込みも出さない。
0 で割った結果や「0円の予算に対して超過」を初回起動でいきなり見せない。
`unsetBudgetCount` を使って「まず予算を設定してください」と促す。

#### カテゴリごとの行

```ts
export type CategoryProgressRow = {
  categoryId: string;
  name: string;
  costType: CostType;
  budgetYen: number;
  spentYen: number;
  count: number;
  remainingYen: number;
  expectedYen: number;
  usageRatio: number;
  status: PaceStatus;
};
```

**カテゴリ予算が設定されているカテゴリだけ**を対象にする（`features.md`「カテゴリ予算を設定している場合のみ」）。
未設定のカテゴリは行に出さない＝`budgetYen` は必ず数値。並びは消化率の降順、同率は表示順。
非表示カテゴリでも予算と支出があれば出す。

**カテゴリの合計を総予算やダッシュボードの残高に足さないこと。**

#### 収入と収支

```ts
export type IncomeSummary = {
  yearMonth: string;
  totalYen: number;
  count: number;
};

export type IncomeBalance = {
  /** 収入を見た月 = 表示中の月の前月 */
  incomeYearMonth: string;
  incomeTotalYen: number;
  /** 表示中の月の支出合計 */
  spentYen: number;
  /** incomeTotalYen − spentYen。マイナスもあり得る */
  balanceYen: number;
};

/** 前月の収入が0件なら null（画面は枠ごと出さない） */
export function buildIncomeBalance(
  yearMonth: string,
  previousMonthIncomes: readonly { amountYen: number }[],
  totalSpentYen: number,
): IncomeBalance | null;
```

**空判定を先に行うこと。** `previousMonthIncomes.length === 0` を確認してから
`previousYearMonth(yearMonth)` を呼ぶ。順序が逆だと、扱える範囲の先頭（`"0000-01"`）で
`RangeError` になる（`shiftYearMonth` は範囲外で投げる。`src/lib/year-month.ts` 参照）。

合計は既存の `sumAmounts`（`src/lib/budget-calculation.ts`）を使う。**新しい合計関数を作らない。**

### 3-2. `src/lib/income-validation.ts`（新規・純粋関数）

- 金額: `src/lib/amount-input.ts` の正規化を使う。**空欄は不可**（予算と違い「未設定の収入」は無い）
  - 下限 1 円（0円の収入を登録する意味が無い）、上限は `BUDGET_AMOUNT_MAX_YEN` と同じ `99_999_999`
- ラベル: 任意。前後の空白を落とし、空文字なら `null`。最大 20 文字
- 年月: `validateYearMonth` を使う
- 文言は利用者向けの日本語。既存の `*_VALIDATION_ERRORS` と同じ形で定数に出す

### 3-3. `src/lib/incomes.ts`（新規・Prisma を使う層）

`src/lib/budgets.ts` と同じ流儀（`Result` 型を返し、例外を投げない）。

- `listIncomes(prisma, yearMonth)` … その月の収入。新しい順（`createdAt` 降順）
- `createIncome(prisma, input)`
- `deleteIncome(prisma, id)` … 見つからない場合は `P2025` を判定してエラーを返す
- `sumIncomeAmounts(incomes)` … 合計（純粋関数。`sumAmounts` で足りるならそれを使う）

**更新（`updateIncome`）は作らない。**（設計判断 2）

### 3-4. `src/lib/dashboard-data.ts`（新規・Prisma を使う層）

ダッシュボード1画面に必要なデータを1関数で集める。`getMonthlyBudgetData` と同じ流儀。

```ts
export type DashboardData = {
  paymentSources: PaymentSource[];
  categories: Category[];
  budgets: Budget[];
  categoryBudgets: CategoryBudget[];
  expenses: Expense[];              // その月の全支出
  incomes: Income[];                // 表示中の月
  previousMonthIncomes: Income[];   // 前月。前月が存在しなければ空配列
};
export async function getDashboardData(prisma, yearMonth): Promise<DashboardData>;
```

月の範囲は `getMonthDateRange(yearMonth)` を使う（**UTC 深夜で組み立てる。ここに +9h を足さない**。
`@db.Date` は UTC 深夜の `Date` として読み書きされる。Step 5 の `expense-date.ts` のコメント参照）。

**前月を求める前に `canShiftYearMonth(yearMonth, -1)` で確認すること。**
`previousYearMonth` は範囲外で `RangeError` を投げるため、確認せずに呼ぶと
`"0000-01"` を表示したときにダッシュボードが落ちる。前月が無ければ空配列を入れる。

### 3-5. 画面

#### `/`（ダッシュボード）— `src/app/page.tsx` を置き換える

現在の暫定的なリンク集を、ダッシュボードにする。月は `?month=YYYY-MM`（未指定なら今月）。

上から順に:

1. **残り使える金額**を最も大きく（`remainingYen`）。マイナスなら赤。総予算と実績を小さく添える
2. **ペース判定** … 今日までの目安と実績、`under` / `warning` / `over` で色分け。経過日数も出す（「14 / 31 日」）
3. **月末着地見込み**（`totalProjectedYen`）。総予算との差も添える
4. **今月の無駄使い** … `summarizeExpenses` の `WASTE` 合計。0 円でも必ず出す（0 であることに意味がある）
5. **払い出し先別バー** … 消化率順。各行に 名前・実績/予算・目安・残り・バー。予算未設定の行はバーを出さず「予算未設定」と出す
6. **カテゴリ別バー** … カテゴリ予算があるときだけ節ごと出す。1件も無ければ節を出さない
7. **収支** …「先月の収入 − 今月の支出」。**前月の収入が0件なら枠ごと出さない**
8. **今月の収入** … 合計と件数、`/incomes` へのリンク。**総予算との比較・注意文は出さない**
9. 主要な画面へのリンク（**支出を記録するボタンを最も押しやすい位置に**）

7 と 8 の見え方:

```
【収支】────────────────
  2026年7月の収入   ¥420,000
  2026年8月の支出  −¥227,600
                   ────────
  残り               ¥192,400

【今月の収入】────────────
  2026年8月        ¥0（未記入）
  ※ 来月の原資になる

  収入を記録する →
```

- **月名を必ず明示する。** 1番の「残り使える金額」（総予算 − 支出）と数字が2つ並ぶため、
  ラベルが曖昧だと取り違える。「残り」という語を単独で使わない
- 収支の差額がマイナスなら赤
- 前月の収入が0件でも **「今月の収入」の枠は残す**（記録を促すため）

注意の出し分け:

- 有効な払い出し先で予算未設定がある → 「予算が未設定の払い出し先が N 件あります」＋ `/budgets` へのリンク
- 総予算が 0 → ペースと着地見込みを出さず、予算の設定を促す

**バーの実装は CSS（幅の%）でよい。グラフライブラリは Step 8 まで入れない。**
消化率が 100% を超えたらバーは 100% で止め、色で超過を示す。

#### `/incomes`（収入の入力）

- 月ナビゲーション（共通コンポーネント）
- 追加フォーム（金額・ラベル任意）
- その月の一覧（新しい順、各行に削除）
- 合計を上部に表示

**月の見出しに「受け取った月」と明示すること。** 例:「2026年8月に受け取った収入」。
`Income.yearMonth` は受け取った月であり、ダッシュボードの収支はこれを前提に前月分を読む
（設計判断 2）。取り違えると数字が黙って1ヶ月ずれ、検証では気づけない。

**Step 5 で踏んだフォームの落とし穴を必ず避けること。**
[../tech-stack.md](../tech-stack.md) の「React 19 の `<form action={関数}>` はフォームを自動リセットする（重大）」を読むこと。
`<select>` や radio を使う場合は、選択値を state で持ち `key` と `defaultValue` の両方に渡す。
削除は誤操作しやすいので、Step 5 の支出削除と同じく**確認を1段挟む**。

#### Server Action

`src/app/incomes/actions.ts` + `action-state.ts`。既存の設定画面と同じ形:

- `(prevState, formData) => state` のシグネチャ
- 失敗時は例外を投げず、利用者向けの日本語メッセージを返す
- **各アクションで `getSession()` を確認する**（Server Action は POST として直接叩けるため、proxy のガードとは別に必要）
- 成功時は `revalidatePath` で `/` と `/incomes` の両方を更新する（**ダッシュボードの収入表示が古いままにならないように**）

---

## 制約

- **`src/` と `prisma/` 以外に書き込まない。** `tests/` と `vitest.config.ts` は tester の担当
- **スキーマは変更しない。** `Income` は Step 2 で作成済み。マイグレーションは不要
- 実DBに検証データを入れたら、**レポートを返す前に必ず消してシードの状態に戻す**。
  利用者の実データ（カテゴリ・払い出し先・2026-08 の予算）が入っている。**これを消さないこと**
- 動作確認で `next dev` を起動したら**必ず止める**
- 金額はすべて整数円。小数を持ち回らない（割合の計算だけ小数でよい）
- 既存テスト（1150 件）が全件通ったままであること

## 実装完了後の確認

- `npx tsc --noEmit` / `npx next build` / `npx eslint src` が通る
- `npx vitest run` が全件通る
- `/` と `/incomes` が実際に描画される（利用者の実データで確認してよいが、**投入したものは戻す**）

## 完了レポートに含めるもの

- 追加・変更したファイルと、それぞれの役割
- **公開インターフェース**（型・関数シグネチャ・コンポーネントの props・`name` / `id` / ラベル文言）。tester がこれを見てテストを書く
- 端数処理・ゼロ除算・並べ替えで判断した点
- 起動したもの / 投入したもの / どう戻したか
- tester への引き継ぎ（下の節に追記する）

---

## tester への引き継ぎ

### 追加・変更したファイル

| ファイル | 役割 |
|---|---|
| `src/lib/dashboard.ts` | **新規・純粋関数。この Step の中心** |
| `src/lib/income-validation.ts` | 新規・純粋関数。収入フォームの検証 |
| `src/lib/incomes.ts` | 新規・Prisma を使う層（収入） |
| `src/lib/dashboard-data.ts` | 新規・Prisma を使う層（ダッシュボード1画面ぶん） |
| `src/components/month-navigation.tsx` | **新規・共通の月ナビゲーション**（`src/app/` の外） |
| `src/app/budgets/month-navigation.tsx` | 変更。共通コンポーネントへ委譲する薄いラッパーに（**公開インターフェースと描画結果は Step 4 のまま**） |
| `src/app/expenses/expense-month-navigation.tsx` | 変更。同上（**Step 5 のまま**） |
| `src/app/page.tsx` | **置き換え。暫定リンク集 → ダッシュボード** |
| `src/app/dashboard-path.ts` | 新規。`DASHBOARD_PATH` / `dashboardPath()` |
| `src/app/dashboard-view.tsx` | 新規。ダッシュボード本体（表示のみ） |
| `src/app/dashboard-progress-list.tsx` | 新規。消化率バーの一覧 |
| `src/app/dashboard-income.tsx` | 新規。収支カード / 今月の収入カード |
| `src/app/incomes/action-state.ts` | 新規。状態の型とパス |
| `src/app/incomes/actions.ts` | 新規。Server Action（追加・削除） |
| `src/app/incomes/income-form.tsx` | 新規。追加フォーム（Client） |
| `src/app/incomes/income-list.tsx` | 新規。一覧 + 削除（Client） |
| `src/app/incomes/income-month-navigation.tsx` | 新規。共通コンポーネントの薄いラッパー |
| `src/app/incomes/page.tsx` | 新規。`/incomes` |

**スキーマとマイグレーションは変更していない。**

### 公開インターフェース

#### `src/lib/dashboard.ts`

```ts
type MonthKind = "past" | "current" | "future";
type MonthProgress = { yearMonth: string; daysInMonth: number; elapsedDays: number;
                       elapsedRatio: number; kind: MonthKind };
function getMonthProgress(yearMonth: string, today: string): MonthProgress; // 不正値は RangeError

type PaceStatus = "under" | "warning" | "over" | "unknown";
const PACE_WARNING_RATIO = 0.9;
const PACE_STATUS_LABELS: Record<PaceStatus, string>;
  // under:"予算内" / warning:"要注意" / over:"超過" / unknown:"予算未設定"

function judgePaceStatus(budgetYen: number | null, spentYen: number,
                         expectedYen: number | null): PaceStatus;
function calculateExpectedYen(budgetYen: number | null, progress: MonthProgress): number | null;
function calculateProjectedYen(spentYen: number, progress: MonthProgress): number | null;
function calculateUsageRatio(budgetYen: number | null, spentYen: number): number | null;
function getUsageBarPercent(usageRatio: number | null): number;  // 0〜100
function formatSignedYen(amountYen: number): string;             // -1000 → "-¥1,000"

type DashboardPaymentSourceInput = { id; sortOrder; isActive; name; type: PaymentSourceType };
type DashboardCategoryInput      = { id; sortOrder; isHidden; name; costType: CostType };
type PaymentSourceSpendInput = { paymentSourceId: string; amountYen: number };
type CategorySpendInput      = { categoryId: string; amountYen: number };

type PaymentSourceProgressRow = { paymentSourceId; name; type; isActive;
  budgetYen: number | null; spentYen: number; count: number;
  remainingYen: number | null; expectedYen: number | null;
  usageRatio: number | null; projectedYen: number | null; status: PaceStatus };
function buildPaymentSourceProgressRows(input: {
  paymentSources; budgets; expenses; progress }): PaymentSourceProgressRow[];

type CategoryProgressRow = { categoryId; name; costType; budgetYen: number; spentYen: number;
  count: number; remainingYen: number; expectedYen: number; usageRatio: number; status };
function buildCategoryProgressRows(input: {
  categories; categoryBudgets; expenses; progress }): CategoryProgressRow[];

type DashboardSummary = { progress; totalBudgetYen; totalSpentYen; remainingYen;
  totalExpectedYen; totalProjectedYen: number | null; totalStatus: PaceStatus;
  rows: PaymentSourceProgressRow[]; unsetBudgetCount: number };
function buildDashboardSummary(input: {
  paymentSources; budgets; expenses; progress }): DashboardSummary;

type IncomeSummary = { yearMonth: string; totalYen: number; count: number };
function summarizeIncomes(yearMonth: string, incomes: readonly { amountYen: number }[]): IncomeSummary;

type IncomeBalance = { incomeYearMonth; incomeTotalYen; spentYen; balanceYen };
function buildIncomeBalance(yearMonth: string,
  previousMonthIncomes: readonly { amountYen: number }[],
  totalSpentYen: number): IncomeBalance | null;
```

**引数はすべてオブジェクト1つ**（`build*` 系）。位置引数ではない。

#### `src/lib/income-validation.ts`

```ts
const INCOME_AMOUNT_MIN_YEN = 1;
const INCOME_AMOUNT_MAX_YEN = 99_999_999;   // = BUDGET_AMOUNT_MAX_YEN
const INCOME_LABEL_MAX_LENGTH = 20;
const INCOME_VALIDATION_ERRORS = {
  amountRequired: "金額を入力してください。",
  amountInvalid: "金額は数字で入力してください。",
  amountNotInteger: "金額は1円単位の整数で入力してください。",
  amountTooSmall: "金額は1円以上で入力してください。",
  amountTooLarge: "金額は99,999,999円以下で入力してください。",
  labelTooLong: "ラベルは20文字以内で入力してください。",
  idRequired: "対象の収入が指定されていません。",
};
function validateIncomeAmount(input: unknown): ValidationResult<number>;
function validateIncomeLabel(input: unknown): ValidationResult<string | null>;
function validateIncomeId(input: unknown): ValidationResult<string>;
function validateIncomeInput(input: { yearMonth: unknown; amount: unknown; label: unknown })
  : ValidationResult<{ yearMonth: string; amountYen: number; label: string | null }>;
```

対象月が不正なときの文言は `YEAR_MONTH_ERRORS.invalid`（"対象月の指定が不正です。"）。

#### `src/lib/incomes.ts`

```ts
const INCOME_ERRORS = { notFound: "対象の収入が見つかりません。",
  invalidYearMonth: "対象月の指定が不正です。", invalidAmount: "金額が不正です。" };
function listIncomes(client, yearMonth): Promise<Income[]>;
  // where: { yearMonth }, orderBy: [{ createdAt: "desc" }, { id: "asc" }]
function createIncome(client, { yearMonth, amountYen, label }): Promise<IncomeResult<Income>>;
function deleteIncome(client, id): Promise<IncomeResult<null>>;   // P2025 → notFound
function sumIncomeAmounts(incomes): number;                        // 中身は sumAmounts
```

`updateIncome` は**存在しない**（設計判断 2）。

#### `src/lib/dashboard-data.ts`

```ts
type DashboardData = { yearMonth; paymentSources; categories; budgets; categoryBudgets;
                       expenses; incomes; previousMonthIncomes };
function getDashboardData(client, yearMonth): Promise<DashboardData>;
```

発行するクエリ（`Promise.all` で7本）:

| モデル | where | orderBy |
|---|---|---|
| `paymentSource` | なし | `[{isActive:"desc"},{sortOrder:"asc"},{id:"asc"}]` |
| `category` | なし | `[{isHidden:"asc"},{sortOrder:"asc"},{id:"asc"}]` |
| `budget` | `{ yearMonth }` | なし |
| `categoryBudget` | `{ yearMonth }` | なし |
| `expense` | `{ date: { gte, lt } }`（`getMonthDateRange`） | なし |
| `income` | `{ yearMonth }` | `[{createdAt:"desc"},{id:"asc"}]` |
| `income`（前月） | `{ yearMonth: previousYearMonth }` | 同上 |

**前月が扱える範囲の外（`"0000-01"`）なら7本目を発行せず空配列を返す。**

#### コンポーネント

```ts
// src/components/month-navigation.tsx
MonthNavigation: { yearMonth: string; currentYearMonth: string;
                   hrefForMonth: (yearMonth: string) => string }
// src/app/budgets/month-navigation.tsx      MonthNavigation: { yearMonth, currentYearMonth }（変更なし）
// src/app/expenses/expense-month-navigation.tsx ExpenseMonthNavigation: { filter, currentYearMonth }（変更なし）
// src/app/incomes/income-month-navigation.tsx   IncomeMonthNavigation: { yearMonth, currentYearMonth }

// src/app/dashboard-view.tsx
DashboardView: { yearMonth: string; currentYearMonth: string; summary: DashboardSummary;
                 categoryRows: readonly CategoryProgressRow[];
                 wasteTotalYen: number; wasteCount: number;
                 incomeSummary: IncomeSummary; incomeBalance: IncomeBalance | null }
// <main> は page.tsx 側。DashboardView はフラグメントを返す

// src/app/dashboard-progress-list.tsx
DashboardProgressBar:       { usageRatio: number | null; status: PaceStatus }
PaymentSourceProgressList:  { rows: readonly PaymentSourceProgressRow[] }
CategoryProgressList:       { rows: readonly CategoryProgressRow[] }
PACE_TEXT_CLASS:            Record<PaceStatus, string>

// src/app/dashboard-income.tsx
IncomeBalanceCard: { yearMonth: string; balance: IncomeBalance }
MonthlyIncomeCard: { summary: IncomeSummary }

// src/app/incomes/income-form.tsx
IncomeForm: { yearMonth: string; action: IncomeFormAction }
// src/app/incomes/income-list.tsx
IncomeListItem = { id: string; amountYen: number; label: string | null }
IncomeList: { items: readonly IncomeListItem[]; deleteAction: IncomeFormAction }
```

#### `name` / `id` / 主なラベル文言

| 場所 | `name` | `id` | ラベル |
|---|---|---|---|
| 収入フォーム 金額 | `amount` | `income-amount` | `金額` |
| 収入フォーム ラベル | `label` | `income-label` | `ラベル（任意）` |
| 収入フォーム 対象月 | `yearMonth`（hidden） | — | — |
| 収入 削除フォーム | `id`（hidden） | — | ボタン `削除` → 確認後 `削除する` / `やめる` |
| 収入フォーム 送信 | — | — | `収入を追加する`（送信中は `保存中…`） |

画面の主な見出し・文言:

- `/incomes`: `h1` = `収入`、`h2` = `2026年8月に受け取った収入` / `収入を追加`。
  一覧が空のとき `この月に受け取った収入はまだ記録されていません。`
- `/`: `h1` = `家計簿`。`h2` = `2026年8月の残り使える金額` / `ペース` / `今月の無駄使い` /
  `払い出し先別` / `カテゴリ別` / `収支` / `今月の収入`
- ペース欄の項目名: `今日までの目安` / `実績` / `経過`（値は `14 / 31 日`）/ `月末の着地見込み` / `総予算との差`
- 収支欄の行: `2026年7月の収入` / `2026年8月の支出` / `差額`
- 注意文: `この月の予算がまだ設定されていません。` + リンク `まず予算を設定してください`、
  `予算が未設定の払い出し先が N 件あります。` + リンク `月次予算を開く`
- 払い出し先の行で予算未設定のとき `予算未設定`（バーは描かない）

#### Server Action（`src/app/incomes/actions.ts`）

```ts
type IncomeActionState = { error: string | null; savedCount: number };
const initialIncomeActionState = { error: null, savedCount: 0 };

createIncomeAction(prevState, formData): Promise<IncomeActionState>
  // formData: yearMonth / amount / label
  // 成功 → { error: null, savedCount: prev+1 } ＋ revalidatePath("/incomes") と revalidatePath("/")
  // 失敗 → { error: 日本語メッセージ, savedCount: prev }（例外は投げない）
deleteIncomeAction(prevState, formData): Promise<IncomeActionState>
  // formData: id。成功時も画面遷移しない（redirect しない）。戻り値は create と同じ形
```

どちらも先頭で `getSession()` を確認し、未ログインなら `redirect(LOGIN_PATH)`。

### 端数処理・ゼロ除算・並べ替えで判断した点

1. **目安 `expectedYen` は切り捨て、着地見込み `projectedYen` は切り上げ**（指示書どおり）。
   `Math.floor(予算 × 経過日数 ÷ 月の日数)` / `Math.ceil(実績 ÷ 経過日数 × 月の日数)`。
2. **消化率**: 予算 0 かつ実績 > 0 は `Number.POSITIVE_INFINITY`。`null` にも `0` にもしない。
3. **並べ替え**は「表示順に並べてから消化率の降順で安定ソート」。
   同率（`Infinity` 同士を含む）は表示順が残る。`null` は必ず末尾。
   `b.usageRatio - a.usageRatio` は `Infinity - Infinity = NaN` になるため使っていない。
4. **総予算 0 のとき `totalStatus = "unknown"`。** ただし `totalProjectedYen` は
   計算式どおりの値を返す（経過日数 0 のときだけ `null`）。**画面側で総予算 0 なら
   ペース節ごと出さない**という分担にした。純粋関数の戻り値を表示都合で歪めないため。
5. `judgePaceStatus` は `expectedYen === null` でも `"unknown"` を返す（防御的）。
   通常 `budgetYen !== null` なら `expectedYen` も非 null になる。
6. `unsetBudgetCount` は「**有効な**払い出し先のうち予算が `null`」の件数。
   無効な払い出し先は数えない。
7. **符号付き表示**は `formatSignedYen`。マイナスは `-¥52,400`（ASCII のハイフンマイナスを
   通貨記号の**前**に置く）。`formatYen(-52400)` は `"¥-52,400"` になるためこちらを使う。
8. `getUsageBarPercent` は 0〜100 の整数。`Infinity` は 100、`null` は 0、
   0 < 比率 < 1 は `Math.round(比率 × 100)`。

### そのほかの判断（仕様に書かれていなかった点）

- **「支出を記録する」ボタンはダッシュボードの最下部**（リンク一覧の後ろ）に大きく置いた。
  スマホでは画面下端が最も指の届く位置のため。`/expenses` 一覧と同じ配置。
- 見出しは「今月の無駄使い」「今月の収入」のまま残しつつ、**その中に必ず月名を併記**した
  （月を切り替えられるため）。「残り使える金額」の見出しにも月名を付けている。
- 収支の3行目のラベルは **`差額`**（指示書の「『残り』という語を単独で使わない」に従い、
  モックアップの「残り」は採らなかった）。
- `validateIncomeInput` の検証順は **金額 → ラベル → 対象月**（利用者が直せる欄を先に見せる）。
- `listIncomes` / 前月の収入の `orderBy` に `{ id: "asc" }` を第2キーとして足した
  （`createdAt` が同一のとき順序が揺れないため）。
- ダッシュボードのパスは `/`、月のクエリ名は `month`（予算・支出と同じ）。

### テストで押さえてほしい観点

- `getMonthProgress`: 当月は「今日の日」そのもの（8/14 → 14）/ 月末（8/31 → 31、`elapsedRatio === 1`）/
  過去月 / 未来月 / うるう年の 2月（2024-02 は 29 日、2026-02 は 28 日）/ 年またぎ
- `calculateExpectedYen`: 切り捨てであること（`380000 × 14 ÷ 31 = 171612.9…` → `171612`）
- `calculateProjectedYen`: 切り上げであること（`250 ÷ 14 × 31 = 553.57…` → `554`）/ 経過 0 日 → `null`
- `judgePaceStatus`: **評価順**（実績 > 予算 なら目安より少なくても `over`）/
  `PACE_WARNING_RATIO` のちょうど境界（`実績 === 目安 × 0.9` は `under`、超えたら `warning`）/
  `実績 === 目安` は `under`
- `calculateUsageRatio`: 予算 0 + 実績 0 → `0`、予算 0 + 実績 > 0 → `Infinity`、予算 null → `null`
- `buildPaymentSourceProgressRows`: 有効は予算も支出も無くても行が出る /
  無効は予算か支出があるときだけ出る / **予算0円で使ってしまった行が先頭に来る** /
  同率のときは表示順（`sortPaymentSources`）/ 予算未設定は末尾
- `buildDashboardSummary`: 総予算に**無効な払い出し先の予算も含む** /
  総予算 0 → `totalStatus === "unknown"` / `unsetBudgetCount` は有効な行だけ数える
- `buildCategoryProgressRows`: **カテゴリ予算があるカテゴリだけ**が出る /
  非表示カテゴリでも予算があれば出る / カテゴリの合計が総予算に混ざっていないこと
- `buildIncomeBalance`: 0件 → `null` /
  **`"0000-01"` でも 0 件なら例外を投げない**（空判定が `previousYearMonth` より先） /
  0件でない `"0000-01"` は `RangeError`（呼ぶ側が来ない前提だが挙動として固定してよい） /
  差額がマイナスになる場合
- `getDashboardData`: 月範囲が **UTC 深夜**（`2026-08-01T00:00:00.000Z` 以上
  `2026-09-01T00:00:00.000Z` 未満、+9h を足していない）/ `"0000-01"` で前月クエリを発行しない
- `income-validation`: 空欄はエラー / `0` はエラー（下限 1）/ 全角数字・カンマを受け入れる /
  小数・マイナスを拒否 / 上限 `99,999,999` の境界 / ラベル 20 文字の境界（`Array.from` で数える）/
  ラベルは trim して空なら `null`
- `MonthNavigation`（共通）: `hrefForMonth` が呼ばれること / 範囲端でリンクを出さないこと。
  **既存の `budgets/month-navigation.test.tsx` と `expense-month-navigation.test.tsx` が
  そのまま通ること**（委譲後も描画結果は同一）
- `IncomeForm`: 保存成功（`savedCount` の増加）で金額とラベルが**クリアされる** /
  保存失敗（`error`）では入力が**残る** / `yearMonth` が hidden で送られる
- `IncomeList`: 削除は確認を1段挟む（`削除` → `削除する` / `やめる`）/ ラベル無しの行の表示
- Server Action: 未ログインで `redirect(LOGIN_PATH)` / 失敗時に例外を投げず日本語を返す /
  成功時に `revalidatePath` が **`/incomes` と `/` の両方**に呼ばれること

### 既知の未対応

- **`tests/app/page.test.tsx`（6件）が失敗する。** この Step で `src/app/page.tsx` を
  暫定リンク集からダッシュボード（`searchParams` を受け取る async Server Component）へ
  置き換えたため、`render(<HomePage />)` が成立しなくなった。
  `npx tsc --noEmit` / `npx next build` もこのテストファイルの型エラーで止まる。
  **tester が書き直す必要がある**（実装側でシグネチャを曲げて旧テストに合わせることはしなかった）。
- `/?month=0000-01` は Postgres が年 0000 の日付を拒否するため 500 になる。
  これは `getMonthDateRange` を使う既存の `/expenses?month=0000-01` でも同じで、
  Step 6 で持ち込んだものではない。
