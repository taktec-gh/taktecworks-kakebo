# 家計簿アプリ（複数ユーザー版）

毎月2つの問いに答えるための家計簿。**この2つに答えない機能は作らない**ことを基準にしている。

1. 今月、予算内で生活できているか
2. 無駄使いはないか

**デモ: https://taktecworks-kakebo.vercel.app**

「デモで試す」を押すと、4か月分のサンプルデータ入りのアカウントがその場で作られ、**24時間後に自動で削除される**。
登録も入力も要らない。**実在の家計情報は入力しないでほしい**（デモであり、データは予告なく削除される）。

> 個人用に作って運用していた単一ユーザー版を、**複数人が安全に使える形に作り直したもの**。
> 作り直しの方針と判断の理由は [docs/design-decisions.md](./docs/design-decisions.md) にすべて残してある。

---

## 何ができるか

- **ダッシュボード** — 残り使える金額、払い出し先ごとの消化ペース（予算内 / 要注意 / 超過）、月末の着地見込み、今月の無駄使い
- **支出の登録** — スマホで数タップ。カテゴリ・払い出し先・浪費タグ（必要 / 浪費 / 投資）を付ける
- **月次予算** — 払い出し先（現金 / クレジットカード / 銀行引き落とし）ごとに設定し、その合計が総予算になる
- **支出一覧** — 月の切り替え、カテゴリ・払い出し先・浪費タグでの絞り込み、金額順の並べ替え
- **収入の記録** — 「今月使える原資」として登録する

仕様は [docs/features.md](./docs/features.md)。

---

## 見どころ（複数ユーザー化で難しいのは認証ではなくデータ分離）

個人用のコードは `deleteExpense(prisma, id)` のように **ID だけで行を操作**していた。そのまま複数ユーザーにすると、
他人の支出 ID を推測するだけで閲覧・編集・削除できてしまう。そこを作り直すのがこのリポジトリの主題になっている。

| やったこと | 中身 |
|---|---|
| **全データ操作に利用者を渡す** | 関数のシグネチャを `(client, userId, ...)` に統一し、取得・更新・削除は必ず `where: { id, userId }` |
| **付け忘れを型で防ぐ** | `userId` は専用の型（ブランド型）で、**作れる場所を3ファイルに限定**。テストが `src/` を走査して守らせる |
| **関連先の持ち主を DB で強制** | `Expense(categoryId, userId) → Category(id, userId)` の複合外部キー。アプリの確認だけに頼らない |
| **他人の ID には「存在しない」と同じ応答** | 「権限がない」と返すと、その ID が実在することが漏れる |
| **分離テスト** | 全 Server Action を表で網羅し、**表の行が全アクションを覆っていることをテスト自身が検査する** |
| **変異テスト** | `userId` の絞り込みを外す等の変異を毎 Step 入れ、テストが落ちることを確認（各 Step の指示書に結果の表がある） |

認証まわり:

- **パスキー（WebAuthn）のみ。** パスワードもメールアドレスも持たない（持たないものは漏れない）
- ログインでユーザー名を入力させない → **ユーザー列挙の経路が生まれない**
- パスキーを全部なくしたときは**リカバリーコード**。DB にはハッシュだけを保存し、**新しいパスキーの登録が済むまでコードを消費しない**
- **デモアカウントは24時間で失効**し、定期処理（Vercel Cron）が削除する。削除の条件は「デモであり、かつ期限切れ」で、通常の利用者を消さないことを実 DB の検証スクリプトと変異テストで確かめている
- **CSP はリクエストごとの nonce 方式**（`'unsafe-inline'` を使わない）。HSTS などのヘッダーも全パスに付ける

---

## 技術構成

| レイヤ | 採用 |
|---|---|
| フレームワーク | Next.js 16（App Router / Server Actions / Proxy）+ TypeScript |
| UI | Tailwind CSS v4 |
| DB | PostgreSQL（開発: Docker、本番: Neon） |
| ORM | Prisma 7（driver adapter: `@prisma/adapter-pg`） |
| 認証 | パスキー（WebAuthn / `@simplewebauthn`）+ リカバリーコード |
| テスト | Vitest + React Testing Library（**3162件**） |
| ホスティング | Vercel |

選定の理由と、学習データと食い違う点は [docs/tech-stack.md](./docs/tech-stack.md)。

---

## 開発

開発用の DB はローカルの Docker（PostgreSQL）。**本番の DB は使わない。**

```bash
docker compose up -d          # PostgreSQL（127.0.0.1:5433）
cp .env.example .env          # 値を埋める（.env はコミットしない）
npm install
npx prisma migrate deploy     # スキーマを適用
npm run dev                   # http://localhost:3000

npx vitest run                # テスト
npx tsc --noEmit              # 型チェック
npm run lint
npm run build && npm start    # 本番ビルド（CSP の確認はこちらで行う）
```

実 DB での検証スクリプト（接続先がローカル以外なら何もせず終わる）:

```bash
npx tsx prisma/checks/data-isolation.ts   # 分離
npx tsx prisma/checks/demo-cleanup.ts     # デモの削除条件
npx tsx prisma/checks/recovery-code.ts    # リカバリーコード
```

環境変数は `.env.example` にすべて説明がある。本番の値は Vercel の Environment Variables で管理する（[docs/deploy.md](./docs/deploy.md)）。

---

## 作り方（AI エージェントとの分業）

Step 単位で進め、**実装（`implementer`）とテスト（`tester`）を別のエージェントが担当する。**
実装者が自分のコードのテストを書くと、実装の都合に合わせた「通るテスト」になり、仕様の抜けを検出できないため。

各 Step のサイクル:

> 指示書を書く → implementer → コミット（書き込み範囲を測る基準線）→ 引き継ぎを追記 → tester →
> 書き込み範囲の検証 → **変異テスト** → コミット → 実機確認 → マージ

指示書には、設計判断とその理由、テストの方針、入れるべき変異の一覧を先に書く。
**やったことだけでなく、採らなかった選択肢とその理由も残してある。**

- [docs/steps/pub-1.md](./docs/steps/pub-1.md) — データ分離
- [docs/steps/pub-2.md](./docs/steps/pub-2.md) — サインアップ
- [docs/steps/pub-3.md](./docs/steps/pub-3.md) — デモアカウント
- [docs/steps/pub-4.md](./docs/steps/pub-4.md) — セキュリティヘッダー
- [docs/steps/pub-5.md](./docs/steps/pub-5.md) — リカバリーコード

---

## ドキュメント

| 文書 | 内容 |
|---|---|
| [docs/design-decisions.md](./docs/design-decisions.md) | **決めたことと、その理由**（最初に読む） |
| [docs/features.md](./docs/features.md) | 機能一覧と仕様 |
| [docs/tech-stack.md](./docs/tech-stack.md) | 技術選定の理由、学習データと違う点 |
| [docs/deploy.md](./docs/deploy.md) | デプロイと運用の手順 |
| [docs/steps/](./docs/steps) | 各 Step の指示書（`pub-N.md` が複数ユーザー版、`step-N.md` は単一ユーザー版の参考） |
| [docs/roadmap.md](./docs/roadmap.md) | 単一ユーザー版の進め方と、踏んだ失敗の記録 |

---

## 制限

- 利用規約・プライバシーポリシーは最小限（デモのため）
- アカウントの削除画面、セッションの個別失効、レシート撮影 OCR（Phase 3）は未実装
- デモアカウントの作成には回数の上限がある（IP 単位・全体）
