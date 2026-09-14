# 技術選定

機能仕様は [features.md](./features.md)、実装順序は [roadmap.md](./roadmap.md) を参照。

## 選定方針

1. **できるだけ無料で運用する**
2. スマホから場所を問わず入力できる（[features.md](./features.md) の前提）
3. 個人1人が使う規模。スケーラビリティより構築の速さを優先する

結果として、**Phase 1〜2 は完全に0円で運用できる**構成になった。有料なのは Phase 3 のレシートOCRのみ。

---

## 構成

| レイヤ | 採用 | 費用 |
|---|---|---|
| フレームワーク | Next.js 16 (App Router) + TypeScript | 無料（OSS） |
| UI | Tailwind CSS + shadcn/ui | 無料（OSS） |
| DB | Neon（Serverless Postgres） | 無料枠 |
| ORM | Prisma | 無料（OSS） |
| ホスティング | Vercel Hobby | 無料枠 |
| テスト | Vitest + React Testing Library | 無料（OSS） |
| グラフ | Recharts | 無料（OSS） |
| 認証 | 環境変数のパスワード + httpOnly JWT Cookie | 無料（自前実装） |
| OCR | **未決**（Phase 3 実装時に再検討） | — |

---

## 各技術の選定理由

### Next.js 16 (App Router) + TypeScript

画面とサーバー処理を1リポジトリで完結させるため。

**メリット**
- バックエンドを別に立てる必要がない
- Server Actions でフォーム送信からDB更新までを型安全に書ける。APIエンドポイントを手で作らなくてよい
- Vercelへのデプロイが `git push` だけで済む

**デメリット**
- Server Component / Client Component の区別など、覚えることが多い
- Vercel以外へ移そうとすると設定が一気に複雑になる

> **バージョンについて**: 当初 15 を想定していたが、Step 1 で `create-next-app@latest` を実行した結果 **16.3.0** が入った。ダウングレードはしていない。
>
> 16 での差分で実装に影響するもの:
> - **`middleware.ts` は `src/proxy.ts` にリネームされた**（`middleware` 規約は非推奨）。エクスポート名も `proxy`。機能は同一
> - Proxy は Edge Runtime 固定ではなく **Node.js ランタイムが既定**になった。ただし本プロジェクトは `jose` を使っているためどちらでも動作する

#### React 19 の `<form action={関数}>` はフォームを自動リセットする（重大）

Step 5 で実際にデータが壊れる不具合として現れた。**フォームを作るときは必ずこの節を読むこと。**

`<form action={関数}>` は、アクション完了時に**必ず**ネイティブの `form.reset()` を実行する（`startHostTransition` が無条件に `requestFormReset` を呼ぶ）。リセットは各要素を **`defaultValue` / `defaultChecked` / `defaultSelected`** に戻す。

問題は React がこれらを同期する条件が要素ごとに違うこと。

| 要素 | 挙動 | 影響 |
|---|---|---|
| text 入力 | 更新のたびに `defaultValue` が現在値へ同期される | 実害なし |
| **radio / checkbox** | `defaultChecked` は **`checked == null`（uncontrolled）のときしか書かれない**。controlled では更新時に同期されない | **マウント時の値へ巻き戻る** |
| **`<select>`** | uncontrolled のとき `defaultSelected` はマウント時のまま | **マウント時の値へ巻き戻る** |

Step 5 で実測した被害（保存後、何も触らずもう一度保存しただけ）:

| 項目 | 1回目 | 2回目（無操作） |
|---|---|---|
| 浪費フラグ | `WASTE` | **`NECESSARY`** |
| 払い出し先 | Aカード | **現金** |

radio は controlled なので**画面表示と送信内容が食い違う**（見た目は「浪費／Aカード」のまま）。`<select>` は uncontrolled なので巻き戻りが目に見えるが、2回目の保存で前回の変更が取り消される点は同じ。

**対策**: 選択値を state で追い、その値を `key` と `defaultValue` の両方に使う。

```tsx
const [selected, setSelected] = useState(propValue);
// サーバーから来る値が変わったら追従させる（レンダー中に調整する公式パターン）
const [lastProp, setLastProp] = useState(propValue);
if (lastProp !== propValue) { setLastProp(propValue); setSelected(propValue); }

<select key={selected} defaultValue={selected} onChange={(e) => setSelected(e.target.value)}>
```

3案を実測比較した結果（`.repro/` の一時テストで検証、後に削除）:

| 案 | 保存成功時 | **保存失敗時** |
|---|---|---|
| `key` にサーバーのプロパティを使う | ○ | **× 未保存の選択が失われる** |
| `key` に保存回数の世代番号を使う | ○ | **× 同上** |
| **`key` に state で追った選択値を使う** | ○ | **○** |

**失敗パスで差が出る。** 保存が名前の重複などで失敗したとき、利用者が名前を直して再保存すると、前2案では選択の変更が黙って捨てられる。これは直そうとしている不具合と同じ形なので、**3番目以外を採ってはいけない**。

`key` と `defaultValue` は**両方**要る。変異テストで片方ずつ外して確認した（`key` を外すと退行テストが落ちる = `defaultValue` が変わっただけでは React は `defaultSelected` を書き直さない。`defaultValue` を定数に戻しても落ちる）。

効かない対策も実測で確認済み。

- `defaultChecked` を `checked` と併記する → `checked != null` のとき React が `defaultChecked` を書かないので無効
- effect で `defaultChecked` を同期する → `reset()` はコミットのミューテーション段階で走り passive effect より**先**なので間に合わない

なお `<form action="文字列">`（`method="get"` の絞り込みフォームなど）は関数アクションではないのでリセットが走らず、影響を受けない。

### Neon（Serverless Postgres）

無料枠で使えるマネージドPostgresとして採用。

**無料枠の条件**（2026-08 時点）
- ストレージ 0.5GB（プロジェクト単位）
- 100 CU-hours / 月
- **5分間アクセスがないとコンピュートが自動停止**。停止中はCU-hoursを消費しない

**メリット**
- 停止中に時間を消費しないため、1日数回しか開かない家計簿では100 CU-hoursを使い切らない
- 支出レコードは1件あたり数百バイト。0.5GBは数十年分に相当する
- Postgresそのものなので、将来どこへでも移行できる

**デメリット**
- **コールドスタート**がある。5分放置後の最初のアクセスで起動待ちが発生する（1秒前後）。「レジ横で開いて即入力」の体感に影響しうる
- 上限超過時は課金ではなく**プロジェクト停止**。ただし超える見込みはほぼない

> **リージョンは AWS Asia Pacific (Singapore) / `aws-ap-southeast-1`**（Step 2 で作成）。
>
> Neon は **Tokyo (ap-northeast-1) を提供していない**（Asia Pacific は Singapore と Sydney のみ）ため、日本から最も近いのが Singapore になる。東京〜シンガポールは往復 70〜90ms。
>
> **デプロイ時に必ず Vercel の関数リージョンも `sin1`（Singapore）に設定する。** DBクエリは1画面につき複数回発生するため、関数がデフォルトの `iad1`（米国東部）のままだとクエリのたびに太平洋を往復して致命的に遅くなる。関数とDBが同居していれば往復は数msで済み、海を渡るのはスマホ↔Vercel の1回だけになる。Hobby プランでもリージョンは1つ選択できる。
>
> **Neon はプロジェクト作成後にリージョンを変更できない。** 変更するには新規プロジェクトを作ってデータを移行する。

### Prisma

**メリット**
- スキーマから型が自動生成され、カラム名の間違いがコンパイルエラーになる
- マイグレーション管理が付属する

**デメリット**
- Prisma Client が比較的重く、サーバーレス環境で初回起動が遅くなることがある
- 複雑な集計クエリは書きにくい。分析画面（Phase 2）で生SQLに落とす可能性がある

> **バージョン 7 での差分**（Step 1 で 7.9.1 が入った）。Step 2 でスキーマを書く際に影響する:
>
> - **`schema.prisma` に `url = env("DATABASE_URL")` を書けない。** Prisma 7 は schema 内の `url` を拒否する（P1012）。接続先は `prisma init` が生成した **`prisma.config.ts`** の `datasource.url` が `process.env["DATABASE_URL"]` を読む
> - **生成される Prisma Client の出力先が `src/generated/prisma`** になった（generator が `prisma-client`）。型の import 元は `@prisma/client` ではなく **`@/generated/prisma`** になる見込み
> - PrismaClient にドライバアダプタ（`@prisma/adapter-pg` など）を渡す必要がある
> - `/src/generated` は `.gitignore` 済み

### Vercel Hobby

**無料枠の条件**（2026-08 時点）
- 帯域 100GB / 月、100万リクエスト / 月、6,000ビルド分 / 月
- 上限到達時は課金されず**一時停止**する

**メリット**
- 個人利用ではどの上限にも近づかない
- HTTPSが自動で付き、スマホから安全にアクセスできる
- プレビュー環境が自動生成される

**デメリット**
- **商用利用は不可。** 「制作に関わった誰かの金銭的利益になるもの」が禁止されている。自分用の家計簿なら問題ないが、将来これを販売する・広告を入れる場合はProプラン（月$20）が必須
- Vercel固有機能に依存するとロックインが進む

### Vitest + React Testing Library

**メリット**
- Vite ベースで実行が速い。Stepごとに毎回全テストを回す運用（[roadmap.md](./roadmap.md)）と相性がよい
- Jest互換のAPIで書けるため情報が多い

**デメリット**
- Next.js の Server Component をそのままテストするのは難しく、ロジックを `src/lib/` に切り出す設計が前提になる

### 認証（環境変数パスワード + JWT Cookie）

利用者が自分1人だけなので、認証ライブラリを入れず自前で最小実装する。

**メリット**
- ユーザーテーブルもサインアップ画面も不要。実装量が最小
- 外部サービスに依存しない

**デメリット**
- 複数人で使う・アカウントを分ける段階になったら作り直しになる
- 自前実装のため、Cookie の署名検証などを正しく書く必要がある（テスト担当が必ず検証する）

---

## 費用まとめ

| フェーズ | 月額 |
|---|---|
| Phase 1（MVP） | **0円** |
| Phase 2（分析） | **0円** |
| Phase 3（OCR） | 選定次第。従量課金になる可能性あり |

---

## 未決事項

### 1. Phase 3 のOCR技術 — 実装時に再検討する

現時点では確定させない。Phase 3 は最後のStepであり、それまでに手入力での運用実感が得られるため、そこで判断する。

判断の材料になる選択肢:

| 案 | 内容 | 費用 |
|---|---|---|
| A | Phase 3 を作らない（手入力のみで運用） | 0円 |
| B | Claude API（Vision + Structured Outputs） | 1枚あたり概ね1〜4円 |
| C | 無料枠のあるOCR API | 0円だが、返るのは文字列のみ。日付・合計金額の抽出処理を自作する必要があり、レシートは店ごとにレイアウトが違うため手間が大きい |

**判断の時期**: Step 9 着手前。それまでに「月に何枚レシートを撮りたいか」が分かっているはず。

### 2. レシート画像の保存先 — Phase 3 で要設計

[features.md](./features.md) には「レシート画像を支出レコードに添付保存」と記載があるが、**画像を Neon（Postgres）に保存してはいけない。**

画像は1枚数百KB〜数MBあり、無料枠の 0.5GB をすぐ使い切る。Phase 3 着手時に次のいずれかを選ぶ:

- オブジェクトストレージに置く（別途無料枠の確認が必要）
- 画像は保存せず、抽出したデータのみ残す

---

## 検討したが採用しなかったもの

| 用途 | 候補 | 不採用の理由 |
|---|---|---|
| DB | Supabase | 認証機能が付属する利点はあるが、無操作が続くとプロジェクトが一時停止し手動再開が必要になる場合がある。認証は自前実装で足りるため利点も活きない |
| DB | Turso / Cloudflare D1 | SQLiteベースで軽量だが、Prismaとの相性と集計クエリの機能で Postgres に劣る |
| ホスティング | Cloudflare Pages | 帯域無制限は魅力だが、Next.js の一部機能に制約があり設定が複雑 |
| 全体 | 自宅PCで運用 | 完全無料だが**外出先から使えない**。「買った直後にスマホで記録」という前提と矛盾する |

---

## 注記

無料枠の条件は変更されることがある。本文中の数値は **2026-08-12 時点**で確認したもの。長期運用する場合は年に一度程度、各サービスの料金ページを確認すること。

- [Neon Free plan limits and quotas](https://neon.com/faqs/free-plan-limits-and-quotas)
- [Vercel Pricing](https://vercel.com/pricing)
