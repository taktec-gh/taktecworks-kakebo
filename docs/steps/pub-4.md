# 公開版 Step 4 — セキュリティヘッダー

design-decisions.md「残りの設計項目 > Webセキュリティ」のうち、**レスポンスヘッダーでブラウザ側の防御を効かせる**部分の実装。

**完了条件**: 全ページの応答に、リクエストごとの nonce を使った厳格な CSP が付く / 本番の CSP に `'unsafe-inline'` と `'unsafe-eval'` が無い /
クリックジャッキング・MIME の取り違え・http への格下げなどを防ぐヘッダーが全パスに付く /
**本番ビルドで全画面を開いて CSP 違反が0件で、パスキー・デモ・Server Action が今までどおり動く**

---

## 前提

- 公開版 Step 3（デモアカウント）が完了した状態（`main` の `9766afa`）。テスト2735件が全件成功
- ローカルの Docker（PostgreSQL）が起動しており、`.env` が開発用の値で設定済み
- 作業ブランチ `feat/security-headers`
- **Next.js 16 の CSP の公式の手順は `node_modules/next/dist/docs/01-app/02-guides/content-security-policy.md`。** 書く前に読む。記憶で書かない

---

## この Step の範囲

| 含める | 含めない（後の Step） |
|---|---|
| nonce 付きの CSP（proxy で生成） | CSP 違反の報告の受け口（`report-to`。保存先が要る） |
| その他のセキュリティヘッダー（`next.config.ts` の `headers()`） | HSTS の preload（`vercel.app` のサブドメインでは申請できない） |
| 全ページの動的レンダリングの保証 | CSRF 対策の確認（Server Actions の Origin チェック。別途確認する） |
| 予算バーのインラインの `style` をやめる（設計判断 3） | 依存パッケージの脆弱性チェックの自動化 |
| `X-Powered-By` を消す | デプロイ後の外部サービス（securityheaders.com など）での採点（デプロイの Step で行う） |

---

## 設計判断（先に決めておくこと）

### 1. CSP は nonce 方式。proxy で生成する

公式の手順の「Adding a nonce with Proxy」に従う。

- **nonce はリクエストごとに新しく作る。** 暗号学的乱数で128ビット以上（公式例の `crypto.randomUUID()` の base64 でよい）。予測できないことが nonce の防御のすべて
- `src/proxy.ts` で nonce を作り、**リクエストヘッダ**（Next.js が描画時に nonce を読み取る）と**レスポンスヘッダ**（ブラウザが適用する）の両方に CSP を設定する
- **proxy のすべての分岐で CSP を付ける。** 今の proxy は「公開パス → そのまま通す」「セッションあり → 通す」「無し → ログインへリダイレクト」の3分岐がある。
  公開パス（ログイン・サインアップ）にも付けること。付け忘れた分岐のページは CSP 無しで出る
- **認証の判断は変えない。** CSP を足すために分岐の順序や条件を変えない（Step 1〜3 のテストが守っている）
- `'unsafe-inline'`（スクリプト）を使う nonce 無しの方式を採らない理由: インラインスクリプトを全部許すと、XSS で差し込まれたスクリプトも動き、CSP の意味がほぼ無くなる。
  家計データという機微情報を扱うので、公式の「When to use nonces」の条件に当たる
- 実験的な SRI（ハッシュ）方式は採らない（Experimental であり、全ページがもともと動的レンダリングなので静的生成の利点も無い）

### 2. ポリシーの中身

本番（`NODE_ENV === "production"`。`next start` と Vercel）のポリシー:

```
default-src 'self';
script-src 'self' 'nonce-<nonce>' 'strict-dynamic';
style-src 'self' 'nonce-<nonce>';
img-src 'self' blob: data:;
font-src 'self';
connect-src 'self';
object-src 'none';
base-uri 'self';
form-action 'self';
frame-ancestors 'none';
```

- **本番に `'unsafe-inline'` と `'unsafe-eval'` を入れない**（`script-src` にも `style-src` にも）
- 開発（`NODE_ENV === "development"`）だけ、公式の手順どおり `script-src` に `'unsafe-eval'`、`style-src` に `'unsafe-inline'` を足す（React のデバッグ情報と開発時のスタイル注入のため）。
  **判定は `=== "development"` の一致で行う。**「production でなければ緩める」にしない（`NODE_ENV` が未設定・`test` のときに緩いポリシーにならないように）
- **`upgrade-insecure-requests` は入れない。** 公式の例には入っているが、`next start` をローカルの http で動かすと同一オリジンの読み込みまで https に書き換えられて壊れうる。
  本番は Vercel が https を強制し、HSTS（設計判断 4）もあり、読み込み先はすべて `'self'` の相対パスなので、失うものは無い
- 外部のドメインは1つも許可しない（外部のスクリプト・フォント・画像・解析ツールを使っていない。フォントは `next/font` がビルド時に自前で配信する）
- **WebAuthn（パスキー）は CSP の対象外**で、ブラウザの API 呼び出しなので `connect-src` などに影響しない。ただし実機確認で必ず確かめる
- ポリシーは**純粋関数**で組み立てる（例: `buildContentSecurityPolicy({ nonce, isDev })`）。proxy はそれを呼ぶだけにし、テストでポリシーの中身を直接確かめられるようにする。
  nonce に `'` `;` 空白などが入らないことも関数の側で守る（生成した nonce 以外を受け付けない）

### 3. 予算バーのインラインの `style` をやめる

`src/app/dashboard-progress-list.tsx` の予算バーが `style={{ width: ... }}` で幅を決めている。
**`style` 属性は `style-src` に `'unsafe-inline'`（または `style-src-attr`）が無いとブラウザにブロックされる**ため、本番でバーの幅が効かなくなる。

- インラインの `style` を使わない方法に変える（例: SVG の `<rect width="…%">`、`<progress>` / `<meter>` 要素、幅の段階を表す Tailwind のクラス）。方法は実装者が決める
- **見た目と、割合の表し方（`getUsageBarPercent` の値）を変えない。** 読み上げ（`aria-*` / role）も今と同等以上にする
- `style-src-attr 'unsafe-inline'` で許す方法は採らない（ポリシーに例外を作らず、`src/` にインラインの `style` が無い状態を保つ。テストで `src/` を走査して検査できる）

### 4. その他のセキュリティヘッダー

全パス（静的ファイルを含む）に付くよう `next.config.ts` の `headers()` に置く。既存の `X-Robots-Tag` は残す。

| ヘッダー | 値 | 目的 |
|---|---|---|
| `Strict-Transport-Security` | `max-age=63072000; includeSubDomains` | http への格下げを防ぐ（2年）。`preload` は付けない（範囲外の表） |
| `X-Content-Type-Options` | `nosniff` | ファイルの種類の推測による取り違え |
| `X-Frame-Options` | `DENY` | クリックジャッキング。CSP の `frame-ancestors 'none'` と同じ意味で、古いブラウザ向けに重ねる |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | 外部へ URL のパス（支出の ID など）を送らない |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=(), payment=(), usb=()` | 使わない機能を無効にする |
| `Cross-Origin-Opener-Policy` | `same-origin` | 他のサイトが開いたウィンドウからこのページを操作させない |

- **`Referrer-Policy` を `no-referrer` にしない。** 同一オリジンの POST で `Origin` ヘッダが `null` になりうり、**Server Actions の Origin チェックで全フォームが失敗する**おそれがある
- **`Permissions-Policy` で `publickey-credentials-get` / `publickey-credentials-create` を塞がない**（パスキーが動かなくなる）。既定（自オリジンで許可）のままにする
- `camera=()` は Phase 3（レシート撮影 OCR）を作るときに見直す（features.md）。この時点では使っていない
- `poweredByHeader: false` で `X-Powered-By: Next.js` を消す（使っている技術と版を外に知らせない）
- CSP は nonce がリクエストごとに違うので `headers()` には置かない（proxy の担当）

### 5. 全ページを動的レンダリングにする

nonce は描画のたびに入るので、**静的に生成されたページには nonce が入らず、本番でスクリプトが全部ブロックされる**（公式の「Dynamic Rendering Requirement」）。

- データを出すページは Step 1 で動的なことを確認済み。**ログイン・サインアップなど、データを読まないページが静的になっていないか**を `next build` の出力で確かめる
- 静的なページがあれば動的にする。方法は公式の `connection()`、またはルートレイアウトで行うなど実装者が決める。
  **ページを足したときに付け忘れない形**（例: ルートレイアウトで一度だけ）が望ましい
- `next build` のルート一覧を完了レポートに貼る（HTML を返すルートがすべて `ƒ`。`robots.txt` など HTML でないものは静的のままでよい）

### 6. CSP は強制モードで出す

`Content-Security-Policy-Report-Only`（違反を報告だけして止めない）で様子を見る段階は置かない。報告の受け口が無く（範囲外の表）、様子を見ても結果を集められないため。
代わりに、**本番ビルドで全画面を開いて違反が0件であることを実機で確かめる**（実機確認）。

---

## 実装内容

1. CSP の組み立て（純粋関数）と nonce の生成（`src/lib/` など）
2. `src/proxy.ts`: 全分岐で CSP をリクエストとレスポンスに付ける。`matcher` は今のまま（認証の対象を変えない）
3. `next.config.ts`: 設計判断 4 のヘッダーと `poweredByHeader: false`
4. 予算バーのインラインの `style` の置き換え
5. 必要なら動的レンダリングの指定

---

## 制約

- **テストは書かない。** `tests/` と `vitest.config.ts` には触らない。`docs/` と `.claude/` にも書き込まない
- TypeScript strict、`any` 禁止。`npx tsc --noEmit` と `npm run lint` が通ること
- **proxy の認証の判断を変えない**
- 既存のテストが落ちた場合は `npx vitest run` の結果（`FAIL` の行を含む）をレポートに貼り、原因を書く（`tests/next-config.test.ts` と proxy のテストは、ヘッダーが増えるので落ちてよい）
- **本番ビルド（`next build` → `next start`）でヘッダーを確かめる。** `curl -I` でログイン画面・ダッシュボード（セッション無しのリダイレクトを含む）・静的ファイル・`/api/cron/cleanup` のヘッダーを見て、レポートに貼る。
  nonce の値そのものは貼ってよい（秘密ではない。ただし2回のリクエストで違う値であることを示す）
- 起動したサーバーは停止してからレポートする。DB にデータを入れたら消し、件数が作業前と同じことを確かめる
- 秘密の値（`AUTH_SECRET`、`CRON_SECRET`、接続文字列）を出力しない
- 設計判断に反する必要が出たら、実装せずレポートに書いて止まる

---

## tester 向けの方針

壊れると被害が大きい順。

1. **本番のポリシーに緩みが無い** — `isDev: false` で `'unsafe-inline'`・`'unsafe-eval'`・`*`・`http:`・`https:`（スキーム全体の許可）・`data:` の `script-src` への混入が無い。
   `script-src` に nonce と `'strict-dynamic'`、`object-src 'none'`、`base-uri 'self'`、`frame-ancestors 'none'`、`form-action 'self'` がある。`upgrade-insecure-requests` が無い
2. **開発だけ緩める条件** — `NODE_ENV` が `development` のときだけ `'unsafe-eval'` / `'unsafe-inline'` が入る。`production`・`test`・未設定では入らない
3. **nonce** — リクエストごとに違う、十分な長さ、ポリシーを壊す文字（`'` `;` 空白・改行）を含まない。レスポンスの CSP とリクエストの CSP の nonce が同じ
4. **proxy の全分岐に CSP** — 公開パス（`/login`・`/signup`・`/api/cron/cleanup`）、セッションあり、セッション無しのリダイレクト、改竄 Cookie の削除を伴うリダイレクト。
   **認証の判断が Step 3 までと同じ**（既存の proxy のテストが通ること）
5. **その他のヘッダー** — 設計判断 4 の表どおり。`X-Robots-Tag` が残る。`Referrer-Policy` が `no-referrer` でない。`Permissions-Policy` がパスキーを塞いでいない。`poweredByHeader` が `false`
6. **インラインの `style` が無い** — `src/` を走査し、JSX の `style=` が無いこと（ポリシーに例外を作らないことの担保）。予算バーの割合の表示と読み上げが今までどおり

単体テストから実データベースに接続しない。

---

## 変異テスト（必須）

1つずつ入れ、`git diff` で変異が入ったことを確認してから流し、戻す。結果は「変異 / 落ちたテスト名 / 件数」の表で残す。

| # | 変異 | 期待 |
|---|---|---|
| 1 | 本番の `script-src` に `'unsafe-inline'` を足す | 落ちる |
| 2 | 開発の判定を `!== "production"` にする（test・未設定で緩む） | 落ちる |
| 3 | nonce を固定値にする | 落ちる |
| 4 | proxy の公開パスの分岐で CSP を付けない | 落ちる |
| 5 | proxy のリダイレクトの分岐で CSP を付けない | 落ちる |
| 6 | レスポンスにだけ CSP を付け、リクエストヘッダには付けない（Next.js が nonce を読めない） | 落ちる |
| 7 | `frame-ancestors 'none'` を消す | 落ちる |
| 8 | `Referrer-Policy` を `no-referrer` にする | 落ちる |
| 9 | 予算バーをインラインの `style` に戻す | 落ちる |
| 10 | `upgrade-insecure-requests` を足す | 落ちる |

---

## 実機確認

**本番ビルドで行う**（開発サーバーは CSP が緩いので確認にならない）。

```powershell
npm run build
npm run start
```

Chrome で `http://localhost:3000` を開き、**DevTools の Console を開いたまま**次を行う。CSP の違反は Console に赤字で出る。

1. ログイン画面・サインアップ画面が崩れず、Console に CSP の違反が出ない
2. 「デモで試す」でダッシュボードが開く。**予算バーの幅が正しく出る**（設計判断 3）
3. 支出の追加・編集・削除、予算・収入・カテゴリ・払い出し先の各画面を開き、フォームを1つずつ送信する。違反が出ない
4. ログアウトしてサインアップ、パスキーでログイン（Windows Hello が出て通る）
5. DevTools の Network で任意のページを選び、Response Headers に CSP と設計判断 4 のヘッダーがあること

**後片付け**: 確認で作ったユーザーとデモは、利用者の同意を得てから DB から消す。サーバーを止める。

---

## 完了レポートに含めるもの

1. 作成・変更・削除したファイル一覧
2. **公開インターフェース** — CSP の組み立て関数・nonce の生成関数のシグネチャ、proxy の変更点
3. 本番と開発のポリシーの全文
4. `next build` のルート一覧（動的であること）
5. `curl -I` の結果（ログイン・ダッシュボードのリダイレクト・静的ファイル・`/api/cron/cleanup`。2回のリクエストで nonce が違うこと）
6. 予算バーの置き換えの方法
7. `npx tsc --noEmit` / `npm run lint` / `npx vitest run`（`FAIL` の行を含む）の結果
8. 判断した点、未解決の懸念、後の Step への持ち越し

---

## この Step で決まること

完了後に design-decisions.md へ移す。

- CSP は nonce 方式で proxy が生成する。本番に `'unsafe-inline'` / `'unsafe-eval'` を入れない。開発だけ緩める判定は `=== "development"`
- `upgrade-insecure-requests` は入れない（HSTS と Vercel の https 強制で足りる）
- `src/` にインラインの `style` を置かない
- その他のヘッダーは `next.config.ts`。`Referrer-Policy` は `strict-origin-when-cross-origin`（`no-referrer` は Server Actions を壊しうる）
- CSP は強制モードで出し、違反の報告の受け口は持たない

---

## 実装完了後の引き継ぎ（tester 向け）

実装はコミット `6d2c9bd`。以下は implementer の完了レポートの要約。**シグネチャの正は実装のコード**なので、ずれていたらコードを読むこと。

### モジュール構成

| ファイル | 担当 |
|---|---|
| `src/lib/csp.ts` | `CSP_HEADER_NAME` / `NONCE_HEADER_NAME`（`"x-nonce"`）/ `NONCE_BYTES = 16`。`isValidNonce(nonce)`（標準 base64 で22文字以上、`/^[A-Za-z0-9+/]{22,}={0,2}$/`）、`generateNonce()`（`crypto.getRandomValues` 16バイト → `btoa`、24文字）、`isDevelopmentEnv(nodeEnv)`（`=== "development"` のときだけ true）、`buildContentSecurityPolicy({ nonce, isDev })`（純粋関数。不正な nonce は例外。項目は `"; "` 区切り、末尾に `;` 無し） |
| `src/proxy.ts` | シグネチャと `matcher` は不変。冒頭で nonce と CSP を作る。通す分岐（公開パス・セッションあり）はリクエストヘッダに `x-nonce` と CSP を入れ、レスポンスにも CSP。リダイレクトの分岐（改竄 Cookie の削除を含む）はレスポンスに CSP |
| `next.config.ts` | `poweredByHeader: false`。`headers()` は `/:path*` の1項目で、X-Robots-Tag → HSTS → X-Content-Type-Options → X-Frame-Options → Referrer-Policy → Permissions-Policy → COOP の順 |
| `src/app/dashboard-progress-list.tsx` | `DashboardProgressBar` の props は不変。DOM は `div[aria-hidden="true"] > svg > rect[width="N%"]`（N は `getUsageBarPercent`）。色は `fill-*` |
| `src/app/layout.tsx` | `await connection()` で全ページを動的に（RootLayout が async に） |
| `src/app/not-found.tsx` | 自前の 404 画面（「ページが見つかりません」と `/` へのリンク）。既定の 404 画面がインラインの style と nonce 無しの `<style>` を使うため |

### ポリシーの全文

- 本番: `default-src 'self'; script-src 'self' 'nonce-<n>' 'strict-dynamic'; style-src 'self' 'nonce-<n>'; img-src 'self' blob: data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'`
- 開発: `script-src` に `'unsafe-eval'` を足し、**`style-src` は `'self' 'unsafe-inline'`（nonce を外す）**。nonce があるとブラウザが `'unsafe-inline'` を無視するため（公式の Development Environment 節と同じ形）

### 仕様から補足・判断した点

- 開発の `style-src` の形（上記）。設計判断 2 の「足す」から変えた
- 自前の 404 画面を足した
- 既定の `global-error` は置き換えていない（持ち越し）

### 実装完了時点のテスト結果

`Tests 4 failed | 2731 passed (2735)`:
`tests/next-config.test.ts`（ヘッダー配列を丸ごと `toEqual`）、
`tests/app/dashboard-progress-list.test.tsx` の3件（`[aria-hidden="true"] > div` の `style.width` を読んでいる。`svg rect` の `width` 属性を見る形にする）。`tests/proxy.test.ts` は全件成功。
