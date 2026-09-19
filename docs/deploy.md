# デプロイと運用の手順（公開版）

公開版を Vercel（Hobby プラン）と Neon（無料プラン）に初めてデプロイする手順と、その後の運用。
単一ユーザー版の記録（パスワードログインと `RECOVERY_MODE` の緊急脱出）は公開版では使わないので書き直した。

- 決定日：2026-09-19
- **プロジェクト名：`taktecworks-kakebo`** → 本番URL `https://taktecworks-kakebo.vercel.app`
- **Vercel は Hobby（無料）プランで使う。** 商用利用の扱いについては [design-decisions.md](./design-decisions.md)「5. ドメイン」の記録を参照

> **秘密の値（接続文字列・`AUTH_SECRET`・`CRON_SECRET`）はこの文書・チャット・コミットに書かない。**
> ダッシュボードとパスワードマネージャーの中だけで扱う。

---

## 全体の順序

| # | 作業 | 誰が | 戻せるか |
|---|---|---|---|
| 1 | push の前の確認 | Claude | — |
| 2 | GitHub に**非公開**のリポジトリを作って push | 利用者 | 戻せる（非公開のまま） |
| 3 | Neon に本番用の DB を**新しく**作る | 利用者 | 戻せる |
| 4 | 本番 DB にマイグレーションを適用する | 利用者 | 戻しにくい（スキーマが作られる） |
| 5 | Vercel でプロジェクトを作り、環境変数を入れてデプロイ | 利用者 | 戻せる |
| 6 | **本番URLが `taktecworks-kakebo.vercel.app` になったか確かめる** | 利用者 | — |
| 7 | 動作確認（持ち越し項目を含む） | 利用者＋Claude | — |
| 8 | リポジトリを**公開**に切り替える | 利用者 | **戻せない**（一度公開した内容は複製されうる） |

**8 は最後にする。** 1〜7 で問題が出たら、公開の前に直せる。

---

## 1. push の前の確認

- [x] `gitleaks git .` で履歴全体をスキャン（2026-09-19。テスト用の固定値の誤検出14件を `.gitleaksignore` で除外し、検出0件）
- [x] `.env` が `.gitignore` に入っていて、追跡しているのは `.env.example`（値は空）だけ
- [x] `next.config.ts` に手元の LAN の IP を直書きしていない（`DEV_ALLOWED_ORIGINS` に移した）
- [x] コミットの作者のメールアドレスは公開してよい（利用者が確認済み）
- [x] push の直前に `npx vitest run`（3162件）/ `npx tsc --noEmit` / `npm run lint`（エラー0）/ `npm run build` が通る（2026-09-19）

---

## 2. GitHub に非公開で push する

1. GitHub で新しいリポジトリを作る。**Visibility は Private。** README・`.gitignore`・ライセンスは付けない（手元の履歴と衝突するため）
2. GitHub アカウントの**2要素認証**が有効か確かめる（公開後はリポジトリが攻撃の入口になりうる）
3. 手元で:

   ```powershell
   git remote add origin https://github.com/<アカウント>/<リポジトリ名>.git
   git push -u origin main
   ```

---

## 3. Neon に本番用の DB を作る

**単一ユーザー版の Neon プロジェクトを使わない。** 実データが入っている（CLAUDE.md「DB」）。

1. Neon で**新しいプロジェクト**を作る
   - リージョン: 日本に近い地域を選ぶ。**2026-09-20 時点で Tokyo は無く、AWS Asia Pacific 1 (Singapore) を選んだ**
   - Postgres のバージョン: 既定でよい（ローカルは 17）
2. 接続文字列を2つ控える（パスワードマネージャーへ。ここには書かない）
   - **プール接続**（ホスト名に `-pooler` が付く）→ `DATABASE_URL`（アプリ実行時）
   - **直接接続**（`-pooler` 無し）→ `DIRECT_URL`（マイグレーション用）
3. **Neon の Vercel 連携（Integration）は使わない。** プレビュー用のブランチや環境変数を自動で作るため、「本番・プレビュー・開発で DB を分ける」管理と噛み合わない。環境変数は手で入れる

---

## 4. 本番 DB にマイグレーションを適用する

**ビルドの中では適用しない**（下の「やってはいけない変更」）。手元から一度だけ適用する。

`.env` は書き換えない。**PowerShell のそのウィンドウの中だけ**で接続先を差し替え、終わったら消す。
`prisma.config.ts` は `dotenv` で `.env` を読むが、**すでにある環境変数は上書きしない**ので、シェルで入れた値が優先される。

```powershell
$env:DIRECT_URL = Read-Host "Neon の直接接続の文字列"   # 聞かれたら貼り付ける
$env:DATABASE_URL = $env:DIRECT_URL
npx prisma migrate status    # 接続先が Neon で、7件が未適用と出ることを確かめる
npx prisma migrate deploy    # 7件を適用
npx prisma migrate status    # "Database schema is up to date"
Remove-Item Env:DIRECT_URL, Env:DATABASE_URL
```

- **接続文字列をコマンドに直接書かない。** PowerShell は打ったコマンドを履歴ファイル（`ConsoleHost_history.txt`）に平文で残す。`Read-Host` で聞かれて貼り付けた値は履歴に残らない
- **`migrate status` の出力で接続先のホストが Neon であることを確かめてから** `deploy` する
- **`prisma migrate reset` / `migrate dev` / `db push` を本番に対して実行しない**（CLAUDE.md「DB」）
- `prisma/checks/` の検証スクリプトは、接続先がローカル以外だと何もせず終わる（本番では使えない。使わない）
- Claude には接続文字列を渡さない。この手順は利用者が実行する

---

## 5. Vercel でプロジェクトを作る

1. Vercel アカウントの**2要素認証**が有効か確かめる（環境変数を見られると全部の鍵が漏れる）
2. Add New → Project → GitHub のリポジトリを Import
3. **Project Name を `taktecworks-kakebo` にする**
4. Framework Preset は Next.js（自動で選ばれる）。Build Command などは既定のまま
5. **Environment Variables**（すべて **Production** だけ。Preview / Development には入れない）:

   | キー | 値 | 備考 |
   |---|---|---|
   | `DATABASE_URL` | Neon の**プール接続** | `-pooler` 付き。**`sslmode=require` を `sslmode=verify-full` に書き換える**（下記） |
   | `AUTH_SECRET` | **新しく作ったランダム文字列** | ローカルと別の値。作り方は `.env.example` |
   | `CRON_SECRET` | **新しく作ったランダム文字列** | `AUTH_SECRET` と別の値 |
   | `RP_ID` | `taktecworks-kakebo.vercel.app` | ホスト名だけ。`https://` もスラッシュも付けない |
   | `RP_ORIGIN` | `https://taktecworks-kakebo.vercel.app` | スキームを含め、末尾にスラッシュを付けない |

   - `DIRECT_URL` は Vercel には入れない（マイグレーションは手元から行う。`prisma generate` は DB に接続しない）
   - `DEV_ALLOWED_ORIGINS` は入れない（開発専用）
6. Deploy

### `sslmode=verify-full` にする理由（2026-09-20）

Neon の接続文字列は `sslmode=require` で終わっている。`pg`（node-postgres）は**今は** `require` を `verify-full`
（サーバー証明書を検証する）として扱っており、関数のログに「次の大きな更新で本来の弱い意味に変わる」という警告が出る。
放置すると `pg` v9 で**黙って証明書の検証が外れる**ので、最初から `verify-full` と書いておく。`channel_binding=require` はそのままでよい。

### 関数のリージョン

Settings → Functions → Function Region を、Neon と同じ地域（**Singapore, `sin1`**）に変える。
DB と関数が離れていると、1回の画面表示で DB を何度も往復するたびに待ち時間が積み上がる。**変えたら Redeploy。**

反映は応答の `x-vercel-id` で分かる（`hnd1::sin1` なら、東京の入口からシンガポールの関数へ渡っている）。

```powershell
curl.exe -sI https://taktecworks-kakebo.vercel.app/login | Select-String x-vercel-id
```

---

## 6. 本番URLを確かめる（最重要）

**パスキーは `RP_ID`（ホスト名）に結びつく。** 実際の本番URLが `RP_ID` と違うと、パスキーの登録もログインも失敗し、
画面には一般的な失敗の文言しか出ないので原因が分からない（単一ユーザー版で実際に踏んだ）。

1. Settings → Domains に **`taktecworks-kakebo.vercel.app`** があること
2. 希望した名前が他人に取られていると、Vercel は**別の名前**を割り当てる。その場合は:
   - 割り当てられた名前を本番URLとして使うか、Domains で別の `*.vercel.app` を足して決める
   - `RP_ID` / `RP_ORIGIN` をその名前に直して **Redeploy**
   - この文書・CLAUDE.md・design-decisions.md のプロジェクト名を直す
3. **最初にパスキーを登録する前に確定する。** 登録してから変えると、そのパスキーは全部使えなくなる

### 使ってはいけない URL

| URL | 何か | なぜ駄目か |
|---|---|---|
| `taktecworks-kakebo-<team>.vercel.app` | デプロイURL | `RP_ID` と一致せずパスキーが失敗する |
| `taktecworks-kakebo-<ハッシュ>-<team>.vercel.app` | デプロイ固有URL | 同上。ハッシュはデプロイのたびに変わる |

閲覧者に渡すのは本番URLだけにする。

---

## 初回デプロイの記録（2026-09-20）

| 項目 | 結果 |
|---|---|
| Neon | プロジェクト `taktecworks-kakebo`、**AWS Asia Pacific 1 (Singapore)**、Free プラン、ブランチ `production`、DB `neondb` |
| マイグレーション | 7件を手元から `prisma migrate deploy` で適用。`migrate status` で接続先が `neon.tech` であることを確認 |
| Vercel | プロジェクト名 `taktecworks-kakebo` をそのまま取得。本番URLは希望どおり。関数のリージョンは **Singapore（`sin1`）**（`x-vercel-id` が `hnd1::sin1` で確認） |
| 環境変数 | 5つ（`DATABASE_URL` / `AUTH_SECRET` / `CRON_SECRET` / `RP_ID` / `RP_ORIGIN`）を Production のみに設定。誤って入れた `DIRECT_URL` と `DEV_ALLOWED_ORIGINS` は削除した |
| ヘッダー | CSP（nonce はリクエストごとに変わる）・HSTS・`X-Frame-Options: DENY`・`nosniff`・`Referrer-Policy`・`Permissions-Policy`・COOP を確認。`X-Powered-By` は出ない |
| パス | `/` は未ログインで `/login` へ 307、`/signup` と `/recovery` は 200、`/signupx` は `/login` へ、`/api/cron/cleanup` は合言葉なしで 401 |
| 画面 | デモ・サインアップ（Windows Hello）・リカバリーコードの表示・支出の登録・再ログインを確認。CSP の違反なし |
| Cron | Cron Jobs に登録され、手動の Run が 200（ログで確認） |
| クロスデバイス | **スマホからログインできることを確認**（Step 2 からの持ち越しを解消）。Chrome の「別の方法で保存」→「Windows Hello または外部セキュリティキー」の先に、スマホを選ぶ経路がある |

---

## 7. 動作確認

本番URLで行う。**DevTools の Console を開いたまま**（CSP の違反が出ないこと）。

### 基本

1. ログイン画面が出る。「デモで試す」でダッシュボードが開き、サンプルデータが出る
2. サインアップ → リカバリーコードの表示 → パスキーでログイン
3. `/recovery` でリカバリーコードから戻れる
4. `curl.exe -I https://taktecworks-kakebo.vercel.app/login` で、CSP・HSTS・X-Frame-Options などが付き、`X-Powered-By` が無い
5. [securityheaders.com](https://securityheaders.com) で本番URLを採点する（Step 4 からの持ち越し）

### 持ち越していた項目

6. **スマホのパスキーでのクロスデバイス認証**（Step 2 から持ち越し）
   - PC の設定画面で「この端末を登録」→ ブラウザの画面でスマホを選び、QR コードをスマホで読んでスマホにパスキーを作る
   - ログアウト → PC で「パスキーでログイン」→ QR コード → スマホで認証してログインできる
   - スマホ単体で本番URLを開き、スマホのパスキーでログインできる

### 定期処理（Cron）

7. Settings → Cron Jobs に `/api/cron/cleanup`（`0 18 * * *`）がある
8. その画面の **Run** で手動実行し、ログ（View Logs）が 200 で、件数の JSON が返っている
9. 環境変数の `CRON_SECRET` が入っていないと 401 になる（入れ忘れていないことの確認を兼ねる）

### 後片付け

確認で作ったアカウントは、設定画面からパスキーを消すだけでは消えない（アカウント削除の画面はまだ無い）。
**本番 DB のデータを手で消す手段は作らない**（本番に対して SQL を実行する経路を増やさない）。確認用のアカウントはそのまま残してよい。
デモアカウントは24時間後に Cron が消す。

---

## 8. リポジトリを公開する

1〜7 がすべて済んでから行う。

- [ ] もう一度 `gitleaks git .` で検出0件
- [x] README.md を公開版の説明に書き直した（2026-09-20）
- [ ] GitHub の Settings → General → Danger Zone → Change visibility → **Public**

---

## デプロイの仕組み

- GitHub の `main` に push すると Vercel が自動でビルド・デプロイする
- `vercel.json` の `git.deploymentEnabled` で **`main` 以外のブランチはビルドしない。**
  プレビューは `RP_ID` が一致せずパスキーが使えず、環境変数も入れていないので動かない。守りの薄い入口を増やさない
- `vercel.json` の `crons` で、1日1回（UTC 18:00 = JST 3:00 ごろ。Hobby では1時間の幅でずれる）`/api/cron/cleanup` が呼ばれる
- `/src/generated`（Prisma クライアント）は `.gitignore` 済み。`package.json` の `postinstall: prisma generate` が Vercel 側で生成する

---

## 運用

### 環境変数を変えたら必ず Redeploy する

Vercel の環境変数は、変えただけでは動いているデプロイに反映されない。Deployments → 最新 → Redeploy。

### スキーマを変える Step

1. ローカルでマイグレーションを作ってテストする（各 Step の手順どおり）
2. `main` にマージする**前に**、手順 4 と同じ方法で本番 DB に `prisma migrate deploy` する
   （コードを先にデプロイすると、新しい列を読むコードが古いスキーマで動いて失敗する）
3. マージして push

### セッションを全部無効にしたいとき

`AUTH_SECRET` を新しい値に変えて Redeploy する。全員のセッションが切れる。

- **パスキーとリカバリーコードは消えない**（リカバリーコードは鍵を使わない SHA-256 で保存しているため、鍵の交換の影響を受けない。design-decisions.md 決定事項 10）
- ログイン試行の IP のハッシュも変わるので、レート制限の数え直しが起きる（害は無い）
- 個別のセッションだけを切る手段はまだ無い（design-decisions.md「残りの設計項目 > セッション」）

---

## やってはいけない変更

### `RP_ID` を変える

**登録済みのパスキーが全部使えなくなる。** 独自ドメインへ移るときは、全員のパスキーの登録し直し（リカバリーコードで戻る）が前提になる。

### Vercel のビルドコマンドに `prisma migrate deploy` を足す

デプロイのたびに本番のスキーマが勝手に変わる。手順 4 のとおり手元から適用する。

### Preview / Development に環境変数を入れる

`main` 以外をビルドしない設定の前提が崩れる。入れるなら、本番とは別の DB と鍵にする（design-decisions.md「作業開始時の注意」）。

### 単一ユーザー版の Neon・鍵を流用する

実データが入っている。公開版とは一切共有しない。
