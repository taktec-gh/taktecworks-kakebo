# 修正指示 — `<select>` がフォームの自動リセットで巻き戻る不具合

Step 番号を持たない**バグ修正**の指示書。対象は Step 3（払い出し先）と Step 4（カテゴリ）で作った画面。
Step 5 で見つかったラジオの同じ不具合（コミット `6b32c8e`）の続き。

## 前提

先に [../tech-stack.md](../tech-stack.md) の
**「React 19 の `<form action={関数}>` はフォームを自動リセットする（重大）」** を必ず読むこと。
原因・要素ごとの挙動の違い・効かない対策・3案の実測比較がすべてそこに書いてある。

要点だけ再掲する。

- `<form action={関数}>` はアクション完了時に**必ず**ネイティブの `form.reset()` を実行する
- `reset()` は各コントロールを `defaultValue` / `defaultChecked` / `defaultSelected` へ戻す
- **`<select>` の `defaultSelected` は React がマウント時にしか書かない。**
  そのため `defaultValue` を渡していても、リセット後は**マウント時の値**へ戻る

## 直す対象

`<form action={関数}>` の中にある `<select>` は4つ。すべて直す。

| ファイル | `<select>` | 現状 |
|---|---|---|
| `src/app/settings/payment-sources/[id]/payment-source-edit-form.tsx` | `name="type"` | `defaultValue={type}` |
| `src/app/settings/categories/[id]/category-edit-form.tsx` | `name="costType"` | `defaultValue={costType}` |
| `src/app/settings/payment-sources/payment-source-create-form.tsx` | `name="type"` | `defaultValue={PAYMENT_SOURCE_TYPE_OPTIONS[0]?.value}` |
| `src/app/settings/categories/category-create-form.tsx` | `name="costType"` | `defaultValue={COST_TYPE_OPTIONS[0]?.value}` |

`src/app/expenses/expense-filter-panel.tsx` の3つの `<select>` は
`<form method="get" action={文字列}>`（関数アクションではない）なので**リセットが走らない。触らないこと。**

## 実害

### 編集画面（払い出し先・カテゴリ）

1. タイプを「クレジット」→「口座引落」に変えて保存する（DB は口座引落になる）
2. サーバーから新しい props が来て `<select>` は口座引落を表示する
3. **しかし DOM の `defaultSelected` はマウント時の「クレジット」のまま**
4. 名前だけ変えてもう一度保存すると、送信される `type` が**クレジットに戻る**

利用者から見ると「さっき変えたはずのタイプが、名前を直しただけで元に戻った」。

### 追加画面（払い出し先・カテゴリ）

1. タイプを「口座引落」にして、既存と重複する名前で「追加する」を押す
2. 「その名前は既に使われています」が出る（アクションは完了しているので `reset()` は走る）
3. `<select>` が先頭の選択肢へ戻る
4. 利用者が名前だけ直して再度押すと、**意図と違うタイプで作られる**

## 直し方

**選択値を state で持ち、その値を `key` と `defaultValue` の両方に渡す。**

3案を実測比較した結果、これ以外は保存失敗時に利用者の未保存の選択を捨てる
（[../tech-stack.md](../tech-stack.md) の比較表）。**他の案を採ってはいけない。**

- `key` にサーバーから来た props を使う → 失敗時に巻き戻る（**不可**）
- `key` に保存回数の世代番号を使う → 失敗時に巻き戻る（**不可**）
- `checked` / `value` を足して controlled にする → `defaultSelected` は書かれないままなので効かない（**不可**）
- `useEffect` で `defaultSelected` を同期する → `reset()` はコミットのミューテーション段階で走り passive effect より先なので間に合わない（**不可**）

### 編集画面

サーバーから来る値が変わったら state を追従させる。レンダー中に前回の props と比べて調整する
（React 公式の「props が変わったときに state を調整する」パターン。`useEffect` で書かない）。
`expense-form.tsx` の `handledSavedCount` と同じ書き方に揃えること。

```tsx
const [selectedType, setSelectedType] = useState(type);
const [lastType, setLastType] = useState(type);
if (lastType !== type) {
  setLastType(type);
  setSelectedType(type);
}

<select
  key={selectedType}
  name="type"
  defaultValue={selectedType}
  onChange={(event) => setSelectedType(event.target.value as PaymentSourceType)}
>
```

`as` によるキャストを避けたい場合は、`PAYMENT_SOURCE_TYPE_OPTIONS` に含まれる値かを確かめる
型ガードを `src/lib/payment-source-validation.ts` / `src/lib/category-validation.ts` 側に置いてよい
（既に同等のものがあればそれを使う）。**`<select>` の選択肢は自分で描いているので不正値は来ないが、
`as` で潰すより型ガードのほうが良い。** 追加した場合は公開インターフェースとして完了レポートに書くこと。

### 追加画面

追加画面には props から来る値がないので、追従は不要。初期値は今と同じ先頭の選択肢にする。

```tsx
const defaultType = PAYMENT_SOURCE_TYPE_OPTIONS[0]?.value;
const [selectedType, setSelectedType] = useState(defaultType);
```

**挙動の変更点（意図的）**: 追加に成功したあと、`<select>` は先頭の選択肢へ戻らず、
直前に選んだ値のままになる。名前の欄は今までどおり空になる。

理由: `PaymentSourceActionState` / `CategoryActionState` は `{ error: string | null }` しか持たず、
**「成功した」ことを画面側から判別できない**（初期状態も成功後も `error: null`）。
成功時だけ選択を戻すには `savedCount` のような成功の合図を状態に足す必要があり、
それは今回の修正の範囲を超える（`actions.ts` の全アクションと既存テストに波及する）。

同じタイプの払い出し先を続けて追加する場面ではむしろ都合が良いため、この挙動で確定とする。
**`savedCount` を勝手に足さないこと。**

## 制約

- `src/` 以外に書き込まない。`tests/` と `vitest.config.ts` は tester の担当
- 既存の公開インターフェース（props の型、`name` 属性、`id` 属性、`aria-*`）を変えない。
  既存テストが `getByLabelText` / `name` で参照している
- `<option>` の `key` は今のまま（`option.value`）。変えるのは `<select>` の `key` だけ
- 動作確認のために `next dev` を起動したら**レポートを返す前に必ず止める**

## 実装完了後の確認

- `npx tsc --noEmit` が通る
- `npx next build` が通る
- `npx vitest run` が**現状どおり全件通る**（この修正で既存テストが落ちてはいけない。
  落ちた場合はテストを直すのではなく、公開インターフェースを変えてしまっていないか疑うこと）

## 完了レポートに含めるもの

- 変更した4ファイルと、それぞれの差分の要点
- 型ガードを追加した場合はその公開インターフェース
- `next dev` を起動したなら、止めたことと確認方法
- tester への引き継ぎ（下の節に追記する形でよい）

---

## tester への引き継ぎ

### 変更した4ファイル

| ファイル | 変更 |
|---|---|
| `src/app/settings/payment-sources/[id]/payment-source-edit-form.tsx` | `selectedType` / `lastType` の state を追加。`<select name="type">` に `key={selectedType}` `defaultValue={selectedType}` `onChange` を付けた |
| `src/app/settings/categories/[id]/category-edit-form.tsx` | `selectedCostType` / `lastCostType` の state を追加。`<select name="costType">` に同様の変更 |
| `src/app/settings/payment-sources/payment-source-create-form.tsx` | `selectedType` の state を追加（props 追従なし）。`<select name="type">` に同様の変更 |
| `src/app/settings/categories/category-create-form.tsx` | `selectedCostType` の state を追加（props 追従なし）。`<select name="costType">` に同様の変更 |

`onChange` は `as` キャストではなく、既存の型ガード
`isPaymentSourceType` / `isCostType`（`src/lib/payment-source-validation.ts` / `src/lib/category-validation.ts`）
で絞り込んでから `setState` する。**型ガードは新規追加していない**（既存のものを import しただけ）。

### 公開インターフェース（すべて変更なし）

props の型・`name` 属性・`id` 属性・ラベル文言・`aria-*` は**一切変えていない**。
既存の 1142 件は全件通ったまま。テストは今までどおり `getByLabelText` で引ける。

| コンポーネント | props | `<select>` の `id` | `name` | ラベル文言 |
|---|---|---|---|---|
| `PaymentSourceCreateForm` | `{ action: PaymentSourceFormAction }` | `new-payment-source-type` | `type` | `タイプ` |
| `CategoryCreateForm` | `{ action: CategoryFormAction }` | `new-category-cost-type` | `costType` | `固定費 / 変動費` |
| `PaymentSourceEditForm` | `{ id, name, type, isActive, isDefault, setDefaultBlockedReason, deactivateBlockedReason, deleteBlockedReason, updateAction, setDefaultAction, setActiveAction, deleteAction }` | `payment-source-type` | `type` | `タイプ` |
| `CategoryEditForm` | `{ id, name, costType, isHidden, deleteBlockedReason, updateAction, setHiddenAction, deleteAction }` | `category-cost-type` | `costType` | `固定費 / 変動費` |

名前欄のラベルは4つとも `名前`。編集フォームの保存ボタンは `getByRole("button", { name: "保存する" })`
（同じ画面に「既定にする」「無効にする」「削除する」があるので `getByRole("button")` 単独では引けない）。
追加フォームはボタンが1つだけなので `getByRole("button")` で引ける。

選択肢の値は `PAYMENT_SOURCE_TYPE_OPTIONS`（`CASH` / `CREDIT_CARD` / `BANK_DEBIT` の順）と
`COST_TYPE_OPTIONS`（`VARIABLE` / `FIXED` の順）。どちらも先頭が初期値。

### 成功パス / 失敗パスの再現方法

`action` は `(prevState, formData) => ({ error: string | null })` を返すただの関数なので、
テストからは Server Action を使わずにスタブを渡す。

- **成功パス**: `action` が `{ error: null }` を返す
- **失敗パス**: `action` が `{ error: "その名前は既に使われています。" }` を返す
  （エラーを返しても**アクションは完了しているので `reset()` は走る**。ここが今回の不具合の肝）

送信内容の検証は `formData.get("type")` / `formData.get("costType")` を配列に貯めて、
**2回目の送信の中身**を見る。1回目だけでは不具合が出ない。

```tsx
const seen: string[] = [];
const action = (_prev: { error: string | null }, fd: FormData) => {
  seen.push(String(fd.get("type")));
  return { error: null };
};
```

編集フォームで「サーバーから新しい props が来た」状況は `rerender()` で作る
（`render()` の戻り値の `rerender` に、`type` / `costType` だけ変えた同じ props を渡す）。

送信は `fireEvent.click(保存ボタン)` → `await waitFor(() => expect(seen.length).toBe(N))`。
`<select>` の変更は `fireEvent.change(select, { target: { value: ... } })`。

### 何が起きたら不具合とみなすか

修正前のコードで**実際に落ちること**を確認済みの観点（実装時に使い捨ての再現テストで検証し、
修正前 6/6 失敗 → 修正後 6/6 成功。再現テストは削除済み）。

1. **追加フォーム・失敗パス**: 先頭以外のタイプを選んで送信 → `action` がエラーを返す →
   `<select>` の `value` が**先頭の選択肢に戻ってしまう**。
   さらに名前だけ直して再送信すると、**2回目の `FormData` に先頭の値が入る**（利用者の選択が捨てられる）
2. **編集フォーム・成功パス**: タイプを変えて保存 → `rerender` で新しい `type` を渡す →
   名前だけ変えてもう一度保存 → **2回目の `FormData` にマウント時の古い値が入る**
3. **編集フォーム・失敗パス**: タイプを変えて保存 → `action` がエラーを返す →
   そのまま再送信 → **2回目の `FormData` に古い値が入る**。
   `key` に props や保存回数を使う実装だとここだけが落ちるので、**失敗パスは必ず入れてほしい**
4. **props 追従**: 送信を一切せず、`rerender` で `type` / `costType` だけ変える →
   `<select>` の `value` が**追従しない**（修正前は `defaultValue` だけだったので追従しなかった）

### 意図的な挙動（不具合ではない）

- **追加に成功しても `<select>` は先頭の選択肢に戻らず、直前に選んだ値のまま。**
  名前欄は今までどおり空になる。
  `PaymentSourceActionState` / `CategoryActionState` が `{ error }` しか持たず、
  初期状態と成功後を区別できないため（指示書の「直し方 > 追加画面」参照）。
  **「成功後に先頭へ戻る」テストを書かないこと。**
  この挙動を変えるには `savedCount` の追加が必要で、今回の範囲外
- **初期表示時の `<select>` の値は今までどおり先頭の選択肢**（追加）／`props` の値（編集）。
  ここは変わっていないので既存テストがそのまま通る

### 触っていない

- `src/app/expenses/expense-filter-panel.tsx`（`<form method="get" action={文字列}>` なので `reset()` が走らない）
- `src/app/expenses/expense-form.tsx`（コミット `6b32c8e` で対応済み）
- `<option>` の `key` は `option.value` のまま
