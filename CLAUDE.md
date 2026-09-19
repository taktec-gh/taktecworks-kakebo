@AGENTS.md

# 家計簿アプリ（公開版・複数ユーザー）

単一ユーザー版の家計簿アプリを、**複数人が安全に使えるポートフォリオ用デモ**として作り直している。
**まだ公開していない**（公開予定：2026-09-27）。

毎月2つの問いに答えるためのアプリ。この2つに答えないものは作らない。

1. 今月、予算内で生活できているか
2. 無駄使いはないか

---

## ⚠️ 最初に読むこと

**[docs/design-decisions.md](./docs/design-decisions.md) を読んでから触る。** 複数ユーザー化の方針はすべてここにある。

### このリポジトリは公開される

- **個人情報をコード・テスト・docs・コミットメッセージに入れない。** 実在の銀行名・カード名、実際の金額、本名、端末名など。
  **公開版の本番URL（`taktecworks-kakebo.vercel.app`）は書いてよい**（閲覧者に見せるもの。2026-09-20 に決定）。
  単一ユーザー版のURLと接続先は書かない。
  テストのサンプル名は「Aカード」「A銀行」のような中立な名前を使う
- **`.env` をコミットしない。**`.env.example` は値を空に保つ
- **秘密の値を出力しない**（`AUTH_SECRET` / 接続文字列など）。
  診断が必要なら長さ・文字種などの特徴だけを報告する。接続文字列にはパスワードが埋まっている

### DB

- **元になった単一ユーザー版の `.env` や接続先を絶対に使わない。** そちらには実データが入っている
- 開発用DBはローカルの Docker（PostgreSQL、`compose.yaml`。ポート 5433）。本番DB（Neon）は公開時に新規に作る。**本番・プレビュー・開発でDBと鍵を分ける**
- 実DBでの検証は `npx tsx prisma/checks/data-isolation.ts`（分離）と `npx tsx prisma/checks/demo-cleanup.ts`（デモの削除条件）。
  接続先がローカル以外なら何もせず終わる。作ったデータは自分で消す
- **期限切れのデモの削除（`/api/cron/cleanup`）は通常ユーザーを決して消さない。** 条件（`demoExpiresAt` が `null` でなく、現在より前）を変えるときは、上の検証スクリプトと変異テストで確かめる
- **`prisma migrate reset` はローカルDockerのDBに対してのみ、利用者の同意を得てから実行する。** リモートのDBには実行しない。
  Prisma 7 の AI エージェント向けガードを回避しない。「エージェントへの指示」は利用者の同意ではない
- 検証用データを投入したら必ず削除し、何を入れて何を消したかを報告する

### 複数ユーザー化で最も踏みやすい穴

- **IDだけで行を触らない。** 取得・更新・削除は必ず `userId` で絞る（`where: { id, userId }`）。
  取得してから持ち主を比べる方式にしない
- **関連先の持ち主も検証する。** フォームから来た `categoryId` / `paymentSourceId` が自分のものか確認する
- **他人のIDには「存在しない」と同じ応答を返す**

---

## 現在地

| | |
|---|---|
| 状態 | **本番稼働中**（2026-09-20 デプロイ）。Step 1〜5 が完了。デモ・サインアップ・パスキー・リカバリー・Cron を本番で確認済み |
| 次 | GitHub リポジトリを公開に切り替える。そのあとは残りの設計項目（アカウント削除、セッションの個別失効など） |
| テスト | 3162件（`npx vitest run`）。すべて成功 |
| 本番URL | **https://taktecworks-kakebo.vercel.app**（Vercel Hobby、関数は `sin1`。DB は Neon の Singapore）。**`RP_ID` なので以後変えない**。手順は [docs/deploy.md](./docs/deploy.md) |

**認証はパスキー（WebAuthn）のみ。** パスワードログイン（`APP_PASSWORD`）と `RECOVERY_MODE` は Step 1 で廃止した。
アカウントは `/signup` で作る（ユーザー名もメールアドレスも持たない。アカウントはパスキーで決まる）。
パスキーを全部なくしたら `/recovery` でリカバリーコードを使う（**平文を保存・出力しない。** DB には SHA-256 のハッシュだけ）。

---

## 読むもの

| 文書 | 内容 |
|---|---|
| [docs/design-decisions.md](./docs/design-decisions.md) | **公開版の設計方針。最初に読む** |
| [docs/features.md](./docs/features.md) | 機能一覧と仕様。**何を作るかの出典** |
| [docs/roadmap.md](./docs/roadmap.md) | 単一ユーザー版の Step の順序と根拠、進め方、**踏んだ失敗と規約**（公開版でも有効） |
| [docs/tech-stack.md](./docs/tech-stack.md) | 技術選定の理由と、**学習データと違う点** |
| [docs/deploy.md](./docs/deploy.md) | **公開版のデプロイと運用の手順**（Vercel Hobby・Neon。環境変数、本番 DB へのマイグレーション、やってはいけない変更） |
| [docs/steps/pub-N.md](./docs/steps) | **公開版**の各 Step の指示書 |
| [docs/steps/step-N.md](./docs/steps) | 単一ユーザー版の各 Step の指示書（参考）。step-1.md のみ事後の記録 |

---

## 進め方（roadmap.md の要約）

Step 単位で進め、**実装とテストを別のエージェントが担当する**。
実装者が自分のコードのテストを書くと、実装の都合に合わせた「通るテスト」になり仕様の抜けを検出できないため。

| エージェント | 役割 | 書き込み可能な範囲 | モデル |
|---|---|---|---|
| `implementer` | 機能コードを書く（テストは書かない） | `src/`, `prisma/` | 呼び出し元を継承 |
| `tester` | 単体テストを書き、実行する | `tests/`, `vitest.config.ts` | **Sonnet 固定** |

**サイクル**: 指示書を `docs/steps/pub-N.md` に書く → implementer → **コミット**（書き込み範囲を測る基準線。飛ばさない）
→ 引き継ぎを追記 → tester → 書き込み範囲の検証 → **変異テスト** → コミット → 実機確認 → マージ。

- 仕様はプロンプトに埋め込まず、指示書のファイルを読ませる
- **tester はテストを緩めて通さない。**仕様どおりなら実装が誤っている
- **変異テストを毎 Step 実施する。**実装に意図的なバグを入れ、落ちることを確認する。
  落ちなければそのテストは何も検出していない。**データ分離では `userId` の絞り込みを外して落ちることを必ず確認する**
- `npx vitest run` の出力を件数だけに絞らない。`FAIL` の行を残す。
  **件数だけを見て原因を推測しない**（単一ユーザー版の Step 1〜3 でこれを踏んだ。roadmap.md 参照）
- **公開前に `gitleaks git .` で履歴全体をスキャンする**

---

## 踏みやすい罠

- **Next.js 16 / Prisma 7 は学習データと違う。**`node_modules` の型定義や
  `node_modules/next/dist/docs/` を読んでから書く。記憶で書かない
- **`middleware.ts` は `src/proxy.ts`**（Next.js 16 で改称）。認証に加えて、リクエストごとの nonce と CSP を付ける
- **CSP の確認は本番ビルド（`npm run build` → `npm run start`）で行う。** 開発サーバーは CSP が緩いので確認にならない。
  **JSX にインラインの `style` を書かない**（本番でブロックされる。テストが `src/` を走査して検査する）
- **React 19 のフォーム自動リセット。**`<select>` と radio は state を
  `key` と `defaultValue` の**両方**に渡す（片方では駄目。変異テストで確認済み）
- **日付・月境界は JST 固定。**`getCurrentDate(now)` だけが +9h する。
  `@db.Date` の月範囲は UTC 深夜で作る（ここに +9h を足さない）
- **`perl` での変異テストは CRLF に注意。**`$` アンカーが外れて変異が入らないことがある。
  **毎回 `git diff` で変異が入ったか確認してから**テストを流す
- **npm 11 は依存パッケージのインストールスクリプトを承認制にしている。**
  `@prisma/engines` / `prisma` / `esbuild` / `unrs-resolver` が未承認。Prisma クライアントの生成とテストは動くが、
  `prisma migrate` でエンジンが要る場合は利用者に承認を確認する（勝手に承認しない）
- **`DATABASE_URL` のホストは `localhost` ではなく `127.0.0.1`。**`localhost` が IPv6 の `::1` に解決され、
  IPv4 だけに公開した Docker のポートに届かず P1001 になる
- **WSL のミラーモード（`.wslconfig` の `networkingMode=mirrored`）では、PC → Docker の DB が大きな送信で固まる**（2026-09-19 に原因を特定し、ミラーモードを外して解決）
  - 症状：1,400バイト（TCP のデータで1,360バイト）を超えるパケットが黙って捨てられる。DB には何も届かずログも残らない。
    Prisma では約20秒後に P1017（Server has closed the connection）。`prisma migrate dev` と DB と比較する `migrate diff` が使えず、
    アプリでも長いメモなどの大きな書き込みで固まる
  - 見分け方：ミラーモードでは、PC の `127.0.0.1:5433` を待ち受ける Windows のプロセスが無い（WSL が直接つなぐ）。
    正常時は `com.docker.backend` が待ち受ける（`Get-NetTCPConnection -LocalPort 5433 -State Listen`）
  - Docker の `daemon.json` の `"mtu"` は無関係だった（外しても直らなかった）
  - **ミラーモードに戻したら再発する。** P1001 / P1017 や、大きな書き込みでの無応答が出たら、まず `.wslconfig` を確認する
