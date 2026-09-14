# Step 2 — Prisma スキーマ

[roadmap.md](../roadmap.md) の Step 2。仕様の出典は [features.md](../features.md)、Prisma 7 の注意点は [tech-stack.md](../tech-stack.md)。

**完了条件**: `prisma migrate` が通る / スキーマ制約とシード投入のテストが通る

---

## 前提（すでに済んでいること）

- Step 1 完了。Next.js 16.3.0 / Prisma 7.9.1 / Vitest 導入済み、パスワード認証実装済み
- Neon プロジェクト作成済み（AWS Asia Pacific / Singapore、DB名 `neondb`）
- `.env` に `DATABASE_URL`（pooler 経由）と `DIRECT_URL`（直接接続）の両方を設定済み。**どちらも `SELECT 1` で疎通確認済み**
- `prisma/schema.prisma` は datasource と generator のみでモデルは空
- `prisma.config.ts` は `datasource.url` に `process.env["DATABASE_URL"]` を渡している

> **Prisma 7 の API は学習データと異なる。** `node_modules/prisma` および `node_modules/@prisma/client` の型定義を実際に読んで確認してから書くこと。記憶で書かない。

---

## 実装内容

### 1. 依存の追加

`pg` / `@prisma/adapter-pg` / `@types/pg` を追加する。Prisma 7 はドライバアダプタが必要。

### 2. スキーマ定義

以下は features.md から導出した確定仕様。**勝手に変更しない。** 疑問があれば実装せずレポートに書く。

#### 共通規約

- 金額はすべて **整数円（`Int`）**。小数を使わない
- 年月は **`String` の `"YYYY-MM"` 形式**（例 `"2026-08"`）。辞書順ソートが暦順と一致するため。**`@db.VarChar(7)`** を付ける

> **`Char(7)` ではなく `VarChar(7)` を使う。** Postgres の `char(n)` は短い値を空白で埋めるため、`"2026-8"` を保存すると `"2026-8 "` として読み戻る（実測で確認）。SQL 上の等値比較は末尾空白を無視するので DB では気づけず、JS 側の `===` 比較だけが静かに失敗する。`varchar(7)` なら長さ上限は同じままパディングが起きない。
>
> なお、どちらの型も **"YYYY-MM" という形式そのものは検証しない。** 形式の保証はアプリ層の整形ヘルパー（Step 3 以降）の責任とする。
- 全モデルに `createdAt DateTime @default(now())` と `updatedAt DateTime @updatedAt`
- id は `String @id @default(cuid())`

#### enum

| enum | 値 | 出典 |
|---|---|---|
| `PaymentSourceType` | `CASH` / `CREDIT_CARD` / `BANK_DEBIT` | features.md「払い出し先のタイプは3種類」 |
| `WasteTag` | `NECESSARY` / `WASTE` / `INVESTMENT` | features.md「浪費フラグ（必要・浪費・投資 の3択）」 |
| `CostType` | `FIXED` / `VARIABLE` | features.md「カテゴリごとに固定費/変動費 属性」 |

#### `PaymentSource`（払い出し先）

| フィールド | 型 | 備考 |
|---|---|---|
| `name` | `String` | 表示名。例「Aカード」「A銀行 引き落とし」。ユニーク |
| `type` | `PaymentSourceType` | |
| `sortOrder` | `Int` | 並べ替え用 |
| `isActive` | `Boolean @default(true)` | 使わなくなったカードの無効化。**削除ではない** |
| `isDefault` | `Boolean @default(false)` | features.md「払い出し先はデフォルト値を持たせ、通常は選び直さなくてよいようにする」 |

`isDefault` は全体で1件のみ `true` であるべき。DB制約で強制できる方法（部分ユニークインデックス等）があれば入れる。Prisma のスキーマ表現で困難なら制約は付けず、その旨をレポートに書く。

#### `Category`（カテゴリ）

| フィールド | 型 | 備考 |
|---|---|---|
| `name` | `String` | ユニーク |
| `costType` | `CostType` | 固定費/変動費 |
| `sortOrder` | `Int` | |
| `isHidden` | `Boolean @default(false)` | 非表示。**削除ではない** |

#### `Expense`（支出）

| フィールド | 型 | 備考 |
|---|---|---|
| `date` | `DateTime @db.Date` | **支出発生日**。日付のみを保持しタイムゾーンの影響を受けないようにする |
| `amountYen` | `Int` | |
| `categoryId` | → `Category` | **`onDelete: Restrict`** |
| `paymentSourceId` | → `PaymentSource` | **`onDelete: Restrict`** |
| `storeName` | `String?` | features.md「直近使った…店名をサジェスト」に必要 |
| `memo` | `String?` | |
| `wasteTag` | `WasteTag` | 無駄使い検出の中核。**nullable にしない** |

`date` を支出発生日とするのは features.md「設計判断 > クレジットカードの計上タイミング」に従うため。締め日・引き落とし日は扱わない。

インデックス: `date`、`(date, categoryId)`、`(date, paymentSourceId)`。ダッシュボードと一覧の絞り込みが「月範囲 + 軸」で走るため。

#### `Budget`（払い出し先の月次予算＝主軸）

| フィールド | 型 | 備考 |
|---|---|---|
| `paymentSourceId` | → `PaymentSource` | `onDelete: Cascade` |
| `yearMonth` | `String` | |
| `amountYen` | `Int` | |

**`@@unique([paymentSourceId, yearMonth])`** — 同一払い出し先・同一月に予算が2件あってはならない。

#### `CategoryBudget`（カテゴリの任意予算＝補助上限）

| フィールド | 型 | 備考 |
|---|---|---|
| `categoryId` | → `Category` | `onDelete: Cascade` |
| `yearMonth` | `String` | |
| `amountYen` | `Int` | |

**`@@unique([categoryId, yearMonth])`**

> **予算を2テーブルに分ける理由**: features.md「設計判断 > 予算の持ち方」で払い出し先が主軸・カテゴリは任意の補助と決まっている。単一テーブルに nullable な FK を2本持たせると「どちらも null」「どちらも設定」という不正な状態を型で防げないため分離する。

#### `Income`（収入＝今月使える原資）

| フィールド | 型 | 備考 |
|---|---|---|
| `yearMonth` | `String` | インデックスを張る |
| `amountYen` | `Int` | |
| `label` | `String?` | 「給与」「賞与」など |

1ヶ月に複数件登録できる。**ユニーク制約は付けない。** features.md のとおり収支管理はせず、原資としてのみ扱う。

### 3. マイグレーション

- `prisma migrate dev` でマイグレーションを作成し Neon に適用する
- **Neon の pooler 経由（`DATABASE_URL`）ではマイグレーションが失敗する場合がある。** `DIRECT_URL` を使う必要があるなら `prisma.config.ts` を修正する。ただし **Prisma 7 の config が `directUrl` 相当をどう受け取るかを、記憶ではなく `node_modules/prisma` の型定義で確認してから**書くこと。確認内容をレポートに書く
- `prisma/migrations/` がコミット対象になること（`.gitignore` で除外されていないか確認）

### 4. Prisma Client のシングルトン

`src/lib/prisma.ts` を作る。

- `@prisma/adapter-pg` でアダプタを構築し `PrismaClient` に渡す
- 開発時の HMR で接続が増え続けないよう `globalThis` にキャッシュする
- 型の import 元は **`@/generated/prisma`**（`@prisma/client` ではない）
- **`DATABASE_URL` はサーバー側の環境変数から読む。ハードコード禁止、`NEXT_PUBLIC_` 禁止**

### 5. シード

`prisma/seed.ts` を作る。シードの登録方法（`package.json` か `prisma.config.ts` か）は Prisma 7 の作法を確認してから設定する。

**プリセットカテゴリ11件**（features.md の順序どおり、`sortOrder` もこの順）

食費 / 日用品 / 外食 / 交通 / 光熱費 / 通信 / 家賃 / 趣味 / 交際 / 医療 / その他

`costType` は各カテゴリの性質に応じて設定する（家賃・光熱費・通信は `FIXED`、他は `VARIABLE` を基本とし、判断の根拠をレポートに書く）。

**払い出し先は「現金」1件のみ**（`type: CASH`, `isDefault: true`）。カードや銀行はユーザーが自分の事情に合わせて登録するものなので勝手に作らない。

**何度実行しても結果が同じ（冪等）にすること。** `upsert` を使う。

---

## 制約

- **テストは書かない。** `tests/` と `vitest.config.ts` には触らない（tester の担当範囲）
- `docs/` と `.claude/` にも書き込まない
- `.env` の値を出力・ログ出力しない
- TypeScript strict、`any` 禁止
- Prisma の生成型を再定義しない

---

## 実装完了後の引き継ぎ（tester 向け）

implementer の実装が完了した時点の事実を記録する。**期待値の根拠は上の仕様であって、この節ではない。** この節は「何がどう呼べるか」と「実測された DB の挙動」を知るためのもの。

### `src/lib/prisma.ts` のエクスポート

```ts
export type EnvSource = Record<string, string | undefined>;
export function getDatabaseUrl(env?: EnvSource): string;   // 未設定/空なら throw new Error("DATABASE_URL is not set")
export function createPrismaClient(connectionString?: string): PrismaClient;  // キャッシュしない
export function getPrismaClient(): PrismaClient;           // globalThis.__kakeiboPrisma にキャッシュ
export const prisma: PrismaClient;                         // 遅延生成 Proxy（default export も同一）
export default prisma;
```

`prisma` は Proxy による遅延生成。`import` しただけでは `DATABASE_URL` を読まず、プロパティに触れた時点で `getPrismaClient()` が走る。

### `src/lib/seed.ts` のエクスポート

```ts
export type PresetCategory = { name: string; costType: CostType; sortOrder: number };
export type PresetPaymentSource = { name: string; type: PaymentSourceType; sortOrder: number; isDefault: boolean };
export const PRESET_CATEGORIES: readonly PresetCategory[];            // 11件
export const PRESET_PAYMENT_SOURCES: readonly PresetPaymentSource[];  // 1件
export type SeedResult = { categories: Category[]; paymentSources: PaymentSource[] };
export async function seedDatabase(client: PrismaClient): Promise<SeedResult>;
```

- `sortOrder` は **1始まり**（仕様に記載がないため implementer が決めた）
- `upsert` の `update` は **`{}`**（既存レコードを更新しない）。利用者の並べ替え・非表示・既定値変更を再実行で巻き戻さないため
- 型・enum は `@/generated/prisma/client` から import できる

### 実測された DB の挙動

| 操作 | 結果 |
|---|---|
| 2件目の `isDefault: true` を INSERT | **P2002**（`isDefault: false` は複数可） |
| 参照する `Expense` がある `Category` / `PaymentSource` を削除 | **P2039**（P2003 ではない。ドライバアダプタ経由のため） |
| 同一 `(paymentSourceId, yearMonth)` の `Budget` 2件目 | P2002 |
| `PaymentSource` 削除時の `Budget` | Cascade で削除される |
| `yearMonth` に8文字 | **P2000** |
| `yearMonth` に6文字 | パディングされずそのまま6文字で読み戻る（`VarChar` のため） |
| `yearMonth` に `"abcdefg"` | **通る。** DB は形式を検証しない |

### テストの方針（重要）

**単体テストから実データベースに接続しない。** 理由は3つ。

1. `.env` の秘密情報がなくてもテストが走る状態を保つ
2. Neon の共有データを書き換えると、テストの実行順やタイミングで結果が変わる
3. 無料枠の CU-hours を消費する

したがって Step 2 のテスト対象は次になる。

- `PRESET_CATEGORIES` / `PRESET_PAYMENT_SOURCES` の内容（件数・順序・名称・`costType` の割り当て・`sortOrder` の連番・名前の重複がないこと）
- `seedDatabase()` に **モックした PrismaClient** を渡し、`upsert` が正しい `where` / `create` / `update` で呼ばれること、冪等であること
- `getDatabaseUrl()` / `getPrismaClient()` / `prisma` Proxy の挙動（未設定時の例外、同一インスタンスを返すこと、import しただけでは環境変数を読まないこと）
- `prisma/schema.prisma` をテキストとして読み、**壊れると被害の大きい制約**が存在することを検証する（`onDelete: Restrict` が `Expense` の両 FK にあること、`Budget` / `CategoryBudget` の `@@unique`、`isDefault` の部分ユニーク、`Expense.date` の `@db.Date`、`yearMonth` が `VarChar(7)` であること）。上表の DB 挙動はこれらの制約に依存しているため、制約が消えたことを検出できる必要がある

---

## 完了レポートに含めるもの

1. 作成・変更したファイル一覧
2. **公開インターフェース** — モデル名・フィールド名・型・enum の値・制約（ユニーク / インデックス / `onDelete`）を漏れなく。tester はこれを見てテストを書くため、ここが不正確だとテストが書けない。`src/lib/prisma.ts` のエクスポート名とシグネチャも含める
3. 仕様上の判断とその根拠（特に `isDefault` の一意制約、`costType` の割り当て、`directUrl` の扱い）
4. マイグレーションの実行結果（適用できたか、pooler と direct のどちらを使ったか）
5. 未解決の懸念・引き継ぎ事項
