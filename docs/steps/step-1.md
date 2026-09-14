# Step 1 — 初期セットアップ・パスワード認証・テスト基盤

[roadmap.md](../roadmap.md) の Step 1。技術選定の理由は [tech-stack.md](../tech-stack.md)。

**完了条件**: スマホからログインできる / 認証の単体テストが通る

---

> **この文書は事後に書いた記録である。**
>
> Step 2 以降と違い、Step 1 では指示書を先に作らずに実装へ入ったため、
> `docs/steps/step-1.md` が存在しなかった。Step 7 完了後、コミット `df1727f` と
> 当時の差分から復元した。**これから実装するための指示書ではなく、何を作り何を決めたかの記録。**
>
> ここに書いた内容の一部は後の Step で変わっている。現在の姿はコードを見ること。
> 変わった箇所は本文中に注記した。

---

## 何を作ったか

コミット `df1727f`（41ファイル、+12283/−18）。

### 1. プロジェクトの土台

`create-next-app@latest` を実行した。**結果として入ったのは Next.js 16.3.0** で、
tech-stack.md が当初想定していた 15 ではなかった。ダウングレードはしていない。

| 項目 | 採用 |
|---|---|
| フレームワーク | Next.js 16.3.0（App Router） |
| 言語 | TypeScript |
| UI | Tailwind CSS v4 |
| DB クライアント | Prisma 7.9.1（**モデル定義とマイグレーションは Step 2**） |
| JWT | jose 6 |
| テスト | Vitest 4.1.10 + React Testing Library + jsdom |

### 2. パスワード認証（利用者は1人）

| ファイル | 役割 |
|---|---|
| `src/lib/auth.ts` | **純粋ロジック。**Next.js 固有の API を持ち込まない |
| `src/lib/session.ts` | Cookie の読み書き（副作用側） |
| `src/proxy.ts` | 認証していないアクセスをログインへ飛ばす |
| `src/app/(auth)/login/` | ログイン画面と Server Action |

決めたこと:

- `APP_PASSWORD` / `AUTH_SECRET` は**サーバー側の環境変数からのみ**読む。ハードコードしない
- セッションは **HS256 の JWT** を `httpOnly` Cookie に入れる。有効期間30日
- **純粋ロジックと副作用を分ける。**`auth.ts` に Cookie 操作を持ち込むと単体テストが書けなくなる
- `proxy.ts` は**既定で全パスを保護**し、`isPublicPath()` に載ったものだけ通す（許可リスト方式）。
  拒否リスト方式にすると、画面を足すたびに保護を書き忘れる余地が残る

### 3. テスト基盤

`vitest.config.ts` で決めたこと:

- `@/...` を `src/...` に解決する（実装が `@/lib/auth` 形式で import するため）
- 既定環境は **jsdom**。React コンポーネントのテストのため
- jose の Web Crypto など Node の実装をそのまま使いたいファイルは、
  先頭に `// @vitest-environment node` を書いて個別に切り替える

159ケース / 7ファイル。署名改竄・`alg` 混同・期限切れ・オープンリダイレクト・
ログイン失敗時の情報漏れを網羅した。

---

## Next.js 16 / Prisma 7 で当初想定と違った点

**ここが Step 1 でいちばん重要な発見。** 学習データと実物が食い違うため、
以降の Step でも「記憶で書かず `node_modules` の型定義を読む」という規約につながった。

### Next.js 16

- **`middleware.ts` は `src/proxy.ts` にリネームされた。**`middleware` 規約は非推奨。
  エクスポート名も `proxy`。機能は同一
- Proxy は Edge Runtime 固定ではなく **Node.js ランタイムが既定**になった。
  本プロジェクトは `jose` を使っているのでどちらでも動く

### Prisma 7

- **`schema.prisma` に `url = env("DATABASE_URL")` を書けない**（P1012 で拒否される）。
  接続先は `prisma.config.ts` の `datasource.url` が環境変数を読む
- **生成される Prisma Client の出力先が `src/generated/prisma`**（generator が `prisma-client`）。
  型の import 元は `@prisma/client` ではなく `@/generated/prisma`
- PrismaClient にドライバアダプタ（`@prisma/adapter-pg` など）を渡す必要がある
- `/src/generated` は `.gitignore` 済み

いずれも tech-stack.md に追記済み。

---

## Step 1 で踏んだ失敗と、そこから作った規約

roadmap.md の「各Stepの進め方」に反映してある。

### 1. implementer の成果をコミットせずに tester を走らせた

tester が `src/` を触っていないことを `git status` で検証するには、
**その直前のコミットが基準線として必要**。未コミットのまま走らせたため、
両者の変更がまとめて「未追跡」として並び、どちらが作ったか区別できなくなった。
ファイル更新時刻での事後確認を強いられた。

→ **サイクルに「implementer の後にコミットする」手順を追加した。**以降の全 Step で守っている。

### 2. テストが全パスしただけでは、検出力があるか分からない

初回から全パスした場合、**実装から期待値を逆算していないか**を疑う価値がある。
確認方法を決めた:

1. 実装に意図的なバグを入れる（例: `isPublicPath` が `"/"` に true を返すようにする）
2. `npx vitest run` を実行し、**落ちることを確認**する
3. 実装を元に戻す

Step 1 ではこの手順で10件が正しく失敗することを確認した。
**以降の全 Step で「変異テスト」として実施している。**

### 3. 「実装を戻した直後に2件失敗する」を誤って説明した

当時これを Vite のトランスフォームキャッシュ（`node_modules/.vite`）のせいだと説明したが、
**これは誤りだった。** Step 3 で失敗したテスト名を記録したことで、真の原因が判明した。

JWT の署名の末尾1文字を書き換えて改竄を再現するテストに実在する欠陥があった。
base64url の最終文字は上位4ビットしか持たないため `A`〜`D` は同じバイト列になり、
改竄が成立しない（1テストあたり 4/64 の確率で失敗する）。

→ **「件数だけを見て原因を推測しない」「再現しない不具合を『フレーキー』と名付けて片付けない」**
という2つの教訓を roadmap.md に記録した。名前を付けた時点で調査が止まる。

---

## 後の Step で変わったもの

この Step で作ったものの現在の姿。

| Step 1 で作ったもの | その後 |
|---|---|
| `src/app/page.tsx`（暫定のリンク集） | **Step 6 でダッシュボードに置き換え。**`searchParams` を受け取る async Server Component になった |
| `src/lib/auth.ts` の `LOGIN_ERROR_MESSAGE` | **Step 7 で実体を `src/lib/auth-messages.ts` へ移した**（Client Component に jose を持ち込まないため）。import 元は `@/lib/auth` のまま |
| `loginAction`（パスワードのみ） | **Step 7 でレート制限とパスキー必須判定を追加。**パスワードを見る前に DB を2回引くようになった |
| `next.config.ts` | Step 3 で `allowedDevOrigins`、Step 7 で `X-Robots-Tag` を追加 |
| 認証はパスワードのみ | **Step 7 でパスキー（WebAuthn）が主動線になった。**パスキーが1本でもあればパスワード単独は拒否される |

**変わっていないもの**（Step 7 の時点でも維持されている）:

- 純粋ロジック（`auth.ts`）と副作用（`session.ts`）を分ける構造
- `proxy.ts` の許可リスト方式
- JWT の `alg` を HS256 に固定してダウングレードを防ぐこと
- **ログイン失敗のメッセージを全パターンで同一にすること**
- 定数時間に近いパスワード比較（`safeEqual`）

---

## 検証したこと

- `npx vitest run` 159/159 パス（26回連続で安定を確認）
- 実装に意図的なバグを注入し、10件が正しく失敗することを確認
- 書き込み境界の検証: implementer は `tests/` に、tester は `src/` に触れていない
- スマホ実機からログインできることを確認
