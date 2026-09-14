# 家計簿アプリ

> **公開版（複数ユーザー化）へ改修中。** 以下は単一ユーザー版の説明で、公開時に書き直す。設計方針は [docs/design-decisions.md](./docs/design-decisions.md)。

利用者1人の個人用家計簿。毎月2つの問いに答えるために作った。

1. 今月、予算内で生活できているか
2. 無駄使いはないか

**2026-08-14 から本番稼働中。** 主にスマホから使う。

---

## 何ができるか

- **ダッシュボード** — 残り使える金額、払い出し先ごとの消化ペース、着地見込み、今月の無駄使い
- **支出の登録** — スマホで数タップ。カテゴリ・払い出し先・浪費タグを付ける
- **月次予算** — 払い出し先（現金 / クレジットカード / 銀行引き落とし）ごとに設定。合計が総予算になる
- **収入の記録** — 前月の総収入と今月の総支出の差額を表示する

詳しい仕様は [docs/features.md](./docs/features.md)。

---

## 技術構成

| レイヤ | 採用 |
|---|---|
| フレームワーク | Next.js 16（App Router）+ TypeScript |
| UI | Tailwind CSS v4 |
| DB | Neon（Serverless Postgres） |
| ORM | Prisma 7（driver adapter: `@prisma/adapter-pg`） |
| 認証 | パスキー（WebAuthn / `@simplewebauthn`）+ パスワード（緊急脱出用） |
| テスト | Vitest + React Testing Library |
| ホスティング | Vercel |

選定理由と、学習データと食い違う点は [docs/tech-stack.md](./docs/tech-stack.md)。

---

## 開発

```bash
npm install
npm run dev          # http://localhost:3000
npx vitest run       # テスト（1612件）
npx tsc --noEmit     # 型チェック
npx eslint src tests # lint
npx next build       # 本番ビルド
```

### ⚠️ ローカル開発は本番データを直接書き換える

本番とローカルで**同じ Neon インスタンス**を使っている。`next dev` で入力したものは
そのまま本番に入る。また **`prisma migrate reset` は実行しないこと**（実データが消える）。

### 環境変数

`.env.example` をコピーして `.env` を作る。`.env` はコミットしない。

| キー | 用途 |
|---|---|
| `DATABASE_URL` | アプリ実行時の DB 接続（Neon のプール接続） |
| `DIRECT_URL` | マイグレーション用（非プール接続） |
| `APP_PASSWORD` | パスワードログイン |
| `AUTH_SECRET` | セッション JWT の署名 / パスキーのチャレンジ / IP の HMAC |
| `RP_ID` / `RP_ORIGIN` | パスキーのドメイン設定 |
| `RECOVERY_MODE` | 締め出しからの緊急脱出。通常は設定しない |

本番の値は Vercel の Environment Variables で管理する。詳細は [docs/deploy.md](./docs/deploy.md)。

---

## 進め方

Step 単位で進め、**実装（`implementer`）とテスト（`tester`）を別のエージェントが担当する。**
実装者が自分のコードのテストを書くと、実装の都合に合わせた「通るテスト」になり
仕様の抜けを検出できないため。

各 Step の指示書は [docs/steps/](./docs/steps) に残してある。
**変異テスト**（実装に意図的なバグを入れて、テストが落ちることを確認する）を毎 Step 実施している。

現在の進捗と残りの Step は [docs/roadmap.md](./docs/roadmap.md)。

---

## ドキュメント

| 文書 | 内容 |
|---|---|
| [docs/features.md](./docs/features.md) | 機能一覧と仕様 |
| [docs/roadmap.md](./docs/roadmap.md) | 現在地、Step の順序と根拠、進め方、踏んだ失敗 |
| [docs/tech-stack.md](./docs/tech-stack.md) | 技術選定の理由、学習データと違う点 |
| [docs/deploy.md](./docs/deploy.md) | 本番URL、環境変数、**締め出しからの復旧手順** |
| [docs/steps/](./docs/steps) | 各 Step の指示書 |
