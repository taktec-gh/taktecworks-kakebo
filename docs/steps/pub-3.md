# 公開版 Step 3 — デモアカウント

[design-decisions.md](../design-decisions.md)「2. 閲覧者の体験：訪問者ごとの使い捨てデモアカウント」の実装。

**完了条件**: ログイン画面の「デモで試す」で、サンプルデータ入りのアカウントがその場で作られ、ログインした状態になる /
デモのセッションは有効期限（24時間）を過ぎると使えない / 期限切れのデモユーザーが定期処理で削除され、**通常のユーザーは決して削除されない** /
デモの作成にレート制限がかかる / デモユーザーはパスキーを登録できない

> **絶対条件（design-decisions.md 決定事項 2）: デモ用の入口は、デモ用に作ったユーザー以外のセッションを発行できないように作る。**
> ユーザーIDを外部（フォーム・URL・Cookie）から受け取る作りにすると、任意のユーザーになりすませる裏口になる。

---

## 前提

- 公開版 Step 2（サインアップ）が完了した状態（`main` の `2827adb`）。テスト1804件が全件成功
- ローカルの Docker（PostgreSQL）が起動しており、`.env` が開発用の値で設定済み
- **単一ユーザー版の `.env` と接続先を使わない。** 接続先のホストが `localhost` / `127.0.0.1` 以外なら何もせず止まる
- `prisma migrate` でエンジンのインストールスクリプトの承認が要る場合は、承認せず止まって報告する
- 作業ブランチ `feat/demo-account`

---

## この Step の範囲

| 含める | 含めない（後の Step） |
|---|---|
| 「デモで試す」ボタンと、デモユーザーの作成（Server Action） | ログアウト時にデモユーザーをすぐ消す処理（設計判断 6） |
| サンプルデータの生成（4か月分） | デモから通常アカウントへの切り替え |
| デモのセッションの有効期限（24時間） | 利用規約・プライバシーポリシーの画面 |
| 期限切れのデモユーザーの削除（Vercel Cron から呼ぶ Route Handler） | セキュリティヘッダー、CSP |
| デモ作成のレート制限（IP 単位＋全体） | セッションのユーザーの存在照合 |
| 記録（`LoginAttempt` / `SignupEvent` / `DemoEvent`）の保持期間と削除 | 鍵の用途別分離（`CRON_SECRET` は新しく足すが、`AUTH_SECRET` は兼用のまま） |
| デモであることの表示、デモユーザーのパスキー登録の禁止 | 全ページ共通のヘッダー（表示はダッシュボードと設定画面だけ） |

---

## 設計判断（先に決めておくこと）

### 1. デモユーザーは `User.demoExpiresAt` で表す

- `User` に **`demoExpiresAt DateTime?`** を足す。`null` なら通常のユーザー、値があればデモユーザーで、その時刻に期限が切れる
- 「デモかどうか」の真偽値を別に持たない。期限の無いデモも、期限のある通常ユーザーも作れない形にするため
- **一度作ったら変えない。** 期限の延長や、デモと通常の切り替えの経路を作らない（延長できると期限の意味が無くなり、切り替えられると通常ユーザーを削除対象にする経路になる）
- 削除の検索のため `@@index([demoExpiresAt])`
- `webauthnUserId` は NOT NULL なので、デモユーザーにも `generateWebauthnUserId()` で作る（パスキーは登録させないが、列の規則を例外にしない）

### 2. 期限は24時間。セッションの有効期限も同じにする

design-decisions.md の未決事項「有効期限の長さ」への答え。

- **`DEMO_TTL_HOURS = 24`**。閲覧者が1回の訪問で触るには十分で、DB に溜まる量を抑えられる
- **デモのセッション JWT の `exp` と Cookie の `maxAge` を `demoExpiresAt` に揃える。** 削除は1日1回の定期処理なので（設計判断 5）、
  期限切れから削除までに最大で1日ほど残る。その間もセッションが切れているので、**期限切れのデータには誰も触れない**
- セッションの発行（`createSession`）に有効期間を渡せるようにする。既存の `createSessionToken` の `maxAgeSeconds` を使う
- 通常ユーザーのセッション（30日）は変えない

### 3. デモの入口はユーザーを受け取らない

絶対条件をコードの形で保証する。

- `startDemoAction` は**引数を読まない**（フォームから呼ばれても `FormData` を見ない）。Cookie やクエリも読まない（IP の取得を除く）
- デモユーザーの作成は `src/lib/users.ts` の関数が行い、**今作ったユーザーの `UserId` だけを返す**。Server Action はその戻り値にだけセッションを発行する
- **`UserId` を作れる3箇所（Step 1 設計判断 7）を増やさない。** 許可リストのテストが検査している
- 既存のセッションがあっても拒否しない（サインアップと同じ。新しいデモユーザーのセッションに切り替わるだけで、他人のデータには触れない）
- 作成は1つのトランザクションで行う。ユーザー・プリセット・サンプルデータ・`DemoEvent`（設計判断 4）のどれかが失敗したら全部を戻す

### 4. デモ作成のレート制限

| 制限 | 値（定数にする） | 目的 |
|---|---|---|
| IP 単位 | **1時間に5件** | 閲覧者が何度か試すのは許し、1台からの連打を止める |
| 全体 | **24時間に300件** | DB（Neon の無料枠）を食い潰させない。期限が24時間なので、生きているデモユーザーはおおむねこの件数以下になる |

- 記録は新しいモデル **`DemoEvent`**（`ipHash`, `createdAt`）。**`SignupEvent` と分ける**。デモの連打でサインアップの枠が埋まる（逆も同じ）のを避けるため
- `DemoEvent` も `userId` を持たない（`LoginAttempt` / `SignupEvent` と同じ理由。3つ目の例外）
- 数えるのは作られたデモユーザー。記録はトランザクションの中で行う
- 確認と記録の間に同時に来ると数件超えうる。許容する（Step 2 と同じ）
- 制限にかかったことは画面に出してよい（例:「デモが混み合っています。時間をおいてお試しください。」）
- Step 2 で「使う側が2つになってから考える」とした共通化は、**実装者の判断でよい**。ただし定数と記録のテーブルは分けたままにする

### 5. 期限切れのデモユーザーの削除

- **Route Handler `GET /api/cron/cleanup`** を作り、`vercel.json` の `crons` から1日1回呼ぶ（JST の深夜。例: `"0 18 * * *"`）
  - Vercel の Hobby プランの Cron は1日1回までで、実行時刻は指定した時間帯の中でずれる。`node_modules/next/dist/docs/` で Route Handler の書き方を確認すること
- **認証は `Authorization: Bearer <CRON_SECRET>`。** Vercel は環境変数 `CRON_SECRET` があると、Cron の呼び出しにこのヘッダを付ける
  - 比較は定数時間で行う（`crypto.timingSafeEqual`。長さが違う場合も先に落とさず安全に扱う）
  - **`CRON_SECRET` が未設定・空なら何もせず失敗を返す**（fail closed。未設定のときに誰でも叩ける状態にしない）
  - 認証に失敗したら 401。本文に理由を書かない
  - `CRON_SECRET` を `.env.example` に空で足す（コメントに作り方と「`AUTH_SECRET` と別の値にする」ことを書く）
- `/api/cron/cleanup` は proxy のセッション確認を通らないので、`isPublicPath` に**完全一致で**足す（`/api/cron/` の接頭辞にしない）
- **削除の条件は `demoExpiresAt` が `null` でなく、かつ現在時刻より前であること。** 条件は `where: { demoExpiresAt: { not: null, lt: now } }` のように**両方を明示する**
  （SQL では `null < now` は真にならないが、条件を読み手と変異テストに見える形にする。通常ユーザーを消す経路をコードの読み違いで作らない）
- `User` を消せば全データが Cascade で消える（Step 1 で決定済み）。1回の件数に上限を設ける（例: 1000件）。残った分は次の回に消える
- 同じ処理で記録の保持期間を過ぎた行を消す（design-decisions.md「残りの設計項目 > レート制限と濫用対策」への答え）:

  | テーブル | 保持期間 | 理由 |
  |---|---|---|
  | `SignupEvent` / `DemoEvent` | **7日** | レート制限の時間窓（最大24時間）より十分長ければよい |
  | `LoginAttempt` | **30日** | レート制限（15分）のほか、攻撃に気づくために残す |

- 応答は件数だけを JSON で返す（例: `{ "deletedDemoUsers": 3, ... }`）。ユーザーIDやデータの中身を返さない・ログに出さない
- 削除の関数は Route Handler から切り離し、`now` を引数で受け取る（テストと検証スクリプトから呼ぶため）

### 6. ログアウト時にはデモユーザーを消さない

ログアウトでデモユーザーを即時に消せば DB は早く空くが、**ログアウトの処理に「ユーザーを消す」経路を足すことになる。**
条件の取り違え1つで通常ユーザーのログアウトが全データの削除になるので、この Step では入れない。期限切れの削除（設計判断 5）に任せる。

画面には「ログアウトするとこのデモには戻れない」ことを出す（デモユーザーはパスキーを持たないので、ログアウトしたら再ログインの手段が無い）。

### 7. デモユーザーはパスキーを登録できない

design-decisions.md の未決事項「デモユーザーにパスキー登録を許すか」への答え。**許さない。**

- デモユーザーは24時間で消えるが、**OS に登録されたパスキーは消えない。** 閲覧者の端末に、もう使えない「家計簿 #XXXX」が残る
- パスキーを登録できると「デモを通常のアカウントとして使い続ける」経路になり、期限の意味が無くなる

実装:

- `startPasskeyRegistrationAction` と `finishPasskeyRegistrationAction` は、**DB の `demoExpiresAt` を見て**デモユーザーなら拒否する（画面の表示に頼らない。Server Action は直接叩けるため）
- 判定は `userId` で絞って取得する（`where: { id: userId }`）
- 拒否の文言は例えば「デモアカウントではパスキーを登録できません。続けて使う場合は、ログアウトしてアカウントを作ってください。」
- 設定画面（`/settings/passkeys`）では、デモユーザーには登録フォームの代わりにこの説明を出す

### 8. サンプルデータ

閲覧者が**開いた瞬間にダッシュボードの価値が分かる**データにする。毎月の2つの問い（予算内か / 無駄使いはないか）に、デモのデータで答えが出ること。

**内容**

- 払い出し先: プリセットの「現金」（既定）に加え、「Aカード」（クレジットカード）と「A銀行 引き落とし」（銀行引き落とし）
- 期間: **今月（JST の今日まで）と、その前の3か月。** カテゴリの前月比・過去3か月平均比を見せるため
- 各月: 払い出し先ごとの予算、カテゴリ予算（2〜3カテゴリ）、収入（「給与」）
- 支出: 固定費（家賃・光熱費・通信。主に銀行引き落とし・カード）と変動費（食費・外食・日用品・交通・趣味など）。浪費タグ（必要・浪費・投資）を混ぜる
- 店名・メモは**一般名詞だけ**（「スーパー」「コンビニ」「ドラッグストア」「カフェ」など）。実在の店名・ブランド名・銀行名を使わない（CLAUDE.md「このリポジトリは公開される」）

**今日の日付によらず成り立つこと**（デモはいつ作られるか分からない。月初でも月末でも見栄えが崩れないこと）

1. 今月の支出が**今日以前の日付だけ**にある（未来の支出を作らない）
2. 今月の総予算に対して残額がプラス
3. **少なくとも1つの払い出し先が、今日時点の理想消化額を上回っている**（ダッシュボードのペース判定で「要注意」か「超過」の色が出る）
4. **今月の浪費タグの合計が0より大きい**（「今月の無駄使い」が出る。月の1日でも成り立つこと）
5. 前月と比べて増えたカテゴリが少なくとも1つある

**作り方**

- 生成は**純粋関数**にする（例: `buildDemoData(today)`。今日の日付（JST）を受け取り、払い出し先・カテゴリを**名前で**参照した計画を返す）。DB への投入は別の関数が名前を ID に解決して行う
- **乱数を使わない**（`Math.random` 禁止）。同じ日付なら同じデータになること。テストで「今日の日付によらず成り立つこと」を1年分の全日付について確かめられるようにするため
- 日付の規則は既存どおり（JST 固定、`@db.Date` は UTC 深夜。CLAUDE.md「踏みやすい罠」）
- 件数は1ユーザーあたり支出200件程度までに抑える（全体の上限300件/日 × 200件で、1日あたり最大6万行程度）
- 投入は `createMany` でよい。**全行の `userId` は今作ったデモユーザー**、関連先（カテゴリ・払い出し先）もそのユーザーのもの（複合外部キーが DB で強制する）

### 9. 画面

- **ログイン画面**: 「デモで試す（登録不要）」ボタンを置く。閲覧者の主な入口なので、パスキーのログインより目立ってよい。
  ボタンの近くに「24時間後に自動で削除されること」「実在の家計情報を入力しないでほしいこと」を短く出す
- 成功したら `/` へ移る（Server Action の `redirect` でよい）
- **ダッシュボード**: デモユーザーには、上部に「デモアカウントであること」「削除される日時（JST）」「ログアウトすると戻れないこと」を出す。表示の判定は DB の `demoExpiresAt` で行う
- **設定画面（パスキー）**: 設計判断 7
- 通常ユーザーの画面は変えない
- スマホ幅（375px）で崩れないこと

---

## 実装内容

### 1. スキーマとマイグレーション

- `User.demoExpiresAt`（`DateTime?`）と `@@index([demoExpiresAt])`
- `DemoEvent`（`id`, `ipHash`, `createdAt`、`@@index([createdAt])` と `@@index([ipHash, createdAt])`）。`updatedAt` は持たない
- スキーマ冒頭の共通規約のコメントに `DemoEvent` の例外を足す
- マイグレーションは Step 2 と同じく `prisma migrate dev` で作る（止まったら `migrate diff` で作り、適用後に差分が無いことを確認する）

### 2. ライブラリ（`src/lib/`）

- サンプルデータの生成（純粋関数）と定数（`DEMO_TTL_HOURS` など）
- デモユーザーの作成（`users.ts`）: 1つのトランザクションでユーザー（`demoExpiresAt` を設定）・プリセット・サンプルデータ・`DemoEvent`
- デモのレート制限（Step 2 の `signup-limits.ts` と同じ形）
- デモかどうかの取得（`userId` で絞る）
- 期限切れのデモユーザーと古い記録の削除（`now` を引数で受け取る）
- `createSession` に有効期間を渡せるようにする

### 3. Server Action と Route Handler

- `startDemoAction`（置き場所は `src/app/(auth)/login/` の下などでよい。分離テストの網羅の検査が拾える `actions.ts` に置く）
- `src/app/api/cron/cleanup/route.ts`（`GET`）
- `src/app/settings/passkeys/actions.ts`: デモユーザーの拒否（設計判断 7）
- `vercel.json` に `crons`、`.env.example` に `CRON_SECRET`

### 4. 画面

- ログイン画面のボタン、ダッシュボードの表示、設定画面（パスキー）の説明

### 5. 検証スクリプト

`prisma/checks/` に、実DBで削除の条件を確かめるスクリプトを足す（例: `demo-cleanup.ts`。`data-isolation.ts` と同じく、接続先がローカル以外なら何もせず終わる）。

- 通常ユーザー1人、期限切れのデモユーザー1人、期限内のデモユーザー1人を作り、削除の関数を呼ぶ
- **期限切れのデモユーザーだけが消え、そのデータも消え、通常ユーザーと期限内のデモユーザーとそのデータが残る**こと
- 保持期間を過ぎた記録だけが消えること
- デモユーザーの作成で、サンプルデータが全部そのユーザーのものになっていること
- 作ったものは全部消し、件数が作業前と同じであることを確かめる

---

## 制約

- **テストは書かない。** `tests/` と `vitest.config.ts` には触らない。`docs/` と `.claude/` にも書き込まない
- TypeScript strict、`any` 禁止。`npx tsc --noEmit` と `npm run lint` が通ること
- **`UserId` を作れる3箇所を増やさない**
- 既存のテストが落ちた場合は `npx vitest run` の結果（`FAIL` の行を含む）をレポートに貼り、原因を書く
- DB に入れた確認用のデータは削除し、**全テーブルの件数が作業前と同じであることを確認してレポートに書く**
- `next dev` / `next build` を起動したら停止してからレポートする
- 秘密の値（`AUTH_SECRET`、`CRON_SECRET`、接続文字列）を出力しない
- 設計判断に反する必要が出たら、実装せずレポートに書いて止まる

---

## tester 向けの方針

壊れると被害が大きい順。

1. **削除の条件** — 期限切れのデモユーザーだけが消える。**通常ユーザー（`demoExpiresAt` が `null`）と期限内のデモユーザーは消えない。**
   境界（`demoExpiresAt` がちょうど `now`）、`where` に `not: null` と `lt` の両方があること、1回の件数の上限
2. **Cron の認証** — 正しい Bearer で成功。ヘッダ無し・違う値・`Bearer` の無い値・長さの違う値・大文字小文字違いで 401。**`CRON_SECRET` が未設定・空なら、ヘッダが何であっても（空の Bearer を含む）削除しない。** 応答にユーザーIDやデータが含まれない
3. **デモの入口の絶対条件** — `startDemoAction` が引数（`FormData` にユーザーIDらしき値を入れても）を使わない。セッションは作成関数の戻り値のユーザーにだけ発行される。作られるユーザーの `demoExpiresAt` が `null` でない
4. **デモのセッションの期限** — `exp` と Cookie の `maxAge` が `demoExpiresAt` と一致する。期限を過ぎたトークンが `verifySessionToken` で `null` になる。通常ユーザーのセッションは30日のまま
5. **サンプルデータ** — 設計判断 8 の「今日の日付によらず成り立つこと」1〜5 を、**1年分の全日付（閏年の2月29日と月末・月初を含む）**で確かめる。乱数を使っていない（同じ日付で同じ結果）。
   店名・メモ・払い出し先名が一般名詞だけであること。投入時に全行の `userId` が作ったユーザーであること
6. **トランザクション** — サンプルデータや `DemoEvent` の投入が失敗したら、ユーザーも残らない
7. **レート制限** — IP 単位（5件目までは作れて6件目で止まる）、全体（300件）の境界、時間窓の外は数えない、`SignupEvent` と数を共有しない
8. **パスキー登録の拒否** — デモユーザーでは `startPasskeyRegistrationAction` / `finishPasskeyRegistrationAction` が拒否し、資格情報を作らない。通常ユーザーは今までどおり
9. **公開パス** — `/api/cron/cleanup` が公開、`/api/cron/cleanupx`・`/api/cron/other` が公開でない
10. **保持期間** — 7日 / 30日の境界で、古い記録だけが消える
11. **画面** — ログイン画面のボタンと注意書き、ダッシュボードのデモ表示（通常ユーザーには出ない）、設定画面の説明
12. **スキーマ** — `demoExpiresAt` が任意項目でインデックスがある、`DemoEvent` に `userId` が無い
13. **分離テストの表** — `startDemoAction` の行を足す

単体テストから実データベースに接続しない。

---

## 変異テスト（必須）

1つずつ入れ、`git diff` で変異が入ったことを確認してから流し、戻す。結果は「変異 / 落ちたテスト名 / 件数」の表で残す。

| # | 変異 | 期待 |
|---|---|---|
| 1 | 削除の条件から `not: null` を外し、`lt` を `lte` や別の条件と組み合わせて通常ユーザーも対象になる形にする（例: `where: { OR: [{ demoExpiresAt: null }, { demoExpiresAt: { lt: now } }] }`） | 落ちる |
| 2 | 削除の条件の `lt: now` を `gt: now` にする（期限内のデモを消す） | 落ちる |
| 3 | Cron の認証で、`CRON_SECRET` が空のときに通す | 落ちる |
| 4 | Cron の認証の比較を外す（常に通す） | 落ちる |
| 5 | `startDemoAction` で、`FormData` の値をユーザーIDとしてセッションを発行する | 落ちる |
| 6 | デモユーザーの `demoExpiresAt` を設定しない（通常ユーザーとして作る） | 落ちる |
| 7 | デモのセッションの有効期間を既定（30日）のままにする | 落ちる |
| 8 | サンプルデータで、今月の支出の日付を今日より後にも作る | 落ちる |
| 9 | サンプルデータの浪費タグを全部「必要」にする | 落ちる |
| 10 | デモ作成の IP 単位の判定を `>=` から `>` にする | 落ちる |
| 11 | `startPasskeyRegistrationAction` のデモユーザーの拒否を外す | 落ちる |
| 12 | `isPublicPath` で `/api/cron/` を接頭辞一致にする | 落ちる |
| 13 | 保持期間の削除で `LoginAttempt` の期間を7日にする | 落ちる |

---

## 実機確認

ローカル（`npm run dev`、`http://localhost:3000`、Chrome）で行う。

1. ログイン画面に「デモで試す」があり、注意書きが読めること
2. 押すとダッシュボードが開き、サンプルデータ（残額、ペースの色分け、払い出し先別の予算バー、今月の無駄使い）が出ること
3. ダッシュボードにデモである旨と削除日時が出ること
4. 支出一覧・予算・収入の各画面に、前の3か月を含むデータがあること。月を切り替えられること
5. 設定画面（パスキー）で、登録フォームの代わりに説明が出ること
6. 別のブラウザ（またはシークレットウィンドウ）で「デモで試す」を押し、**最初のデモと別のデータ**になること（片方で追加した支出がもう片方に出ない）
7. ログアウトすると、デモには戻れないこと（ログイン画面に戻る）
8. 削除の処理: `CRON_SECRET` を `.env` に設定し、ヘッダ無しの `GET /api/cron/cleanup` が 401、正しいヘッダで 200 になること
   （期限切れのデモユーザーを作って消えることは検証スクリプトで確かめるので、ここでは認証だけでよい）

**後片付け**: 確認で作ったデモユーザーは、利用者の同意を得てから DB から消す。

---

## 完了レポートに含めるもの

1. 作成・変更・削除したファイル一覧
2. **公開インターフェース** — 新しい関数・Server Action・Route Handler・コンポーネントのシグネチャと戻り値、変わったシグネチャ
3. 生成されたマイグレーション SQL の要点
4. 削除の条件の実際の `where` と、Cron の認証の比較の方法
5. サンプルデータの概要（払い出し先・カテゴリ予算・件数）と、「今日の日付によらず成り立つこと」をどう作ったか
6. 検証スクリプトの結果（OK / NG の一覧）と後片付け（全テーブルの件数が作業前と同じ）
7. `npx tsc --noEmit` / `npm run lint` / `npx vitest run`（`FAIL` の行を含む）の結果
8. 判断した点、未解決の懸念、後の Step への持ち越し

---

## この Step で決まること

完了後に design-decisions.md へ移す。

- デモユーザーは `User.demoExpiresAt` で表し、作成後に変えない
- 期限は24時間。デモのセッションの有効期限を同じにし、削除が遅れても期限切れのデータに触れないようにする
- デモの入口はユーザーを受け取らず、今作ったユーザーにだけセッションを発行する
- デモ作成は IP 単位（1時間5件）と全体（24時間300件）で制限する。`DemoEvent` は `SignupEvent` と分け、`userId` を持たない
- 期限切れのデモユーザーは1日1回の Cron で削除する。認証は `CRON_SECRET`、未設定なら何もしない
- 記録の保持期間: `SignupEvent` / `DemoEvent` は7日、`LoginAttempt` は30日
- ログアウトではデモユーザーを消さない
- デモユーザーはパスキーを登録できない
- サンプルデータは今日の日付から決まる純粋関数で作り、乱数を使わない

---

## 実装完了後の引き継ぎ（tester 向け）

実装はコミット `3c67d75`。以下は implementer の完了レポートの要約。**シグネチャの正は実装のコード**なので、ずれていたらコードを読むこと。

### モジュール構成

| ファイル | 担当 |
|---|---|
| `src/lib/demo-data.ts` | 純粋関数。`buildDemoData(today: "YYYY-MM-DD")` → `DemoDataPlan`（`yearMonths` / `paymentSources`（現金以外の追加分）/ `budgets` / `categoryBudgets` / `incomes` / `expenses`。関連先は名前で参照）。`getDemoExpiresAt(now)`（秒に切り捨て＋24時間）、`getDemoSessionMaxAgeSeconds(expiresAt, now)`、`formatDemoExpiresAtLabel(expiresAt)`（JST）。定数 `DEMO_TTL_HOURS`（実体は demo-messages.ts）など |
| `src/lib/demo-messages.ts` | `DEMO_ERRORS`、`DEMO_PASSKEY_BLOCKED_MESSAGE`、`DEMO_START_LABEL`、`DEMO_LOGIN_NOTICES`、`DEMO_LOGOUT_WARNING`、`DemoActionState` |
| `src/lib/demo-limits.ts` | 1時間5件・24時間300件。`isDemoLimitReached`（純粋、`>=`）、`isDemoRateLimited`、`recordDemoEvent(tx, ipHash)`。`demoEvent` だけを数える |
| `src/lib/demo-seed.ts` | `insertDemoData(tx, userId, plan, presets)`。名前を ID に解決して `createMany`。解決できなければ例外 |
| `src/lib/users.ts` | `createDemoUser(client, { ipHash, now })` → `{ userId, demoExpiresAt }`（1トランザクション: User → プリセット → `insertDemoData` → `recordDemoEvent`）、`findDemoExpiresAt(client, userId)` |
| `src/lib/session.ts` | `createSession(userId, options?: { maxAgeSeconds?, now? })`（**シグネチャ変更**。JWT の exp と Cookie の maxAge の両方に使う。省略時30日） |
| `src/lib/cleanup.ts` | `expiredDemoUserWhere(now)` = `{ demoExpiresAt: { not: null, lt: now } }`、`deleteExpiredDemoUsers(client, now)`（findMany `take: 1000` → deleteMany。**両方に同じ条件**）、`deleteExpiredRecords(client, now)`（7日 / 7日 / 30日）、`runCleanup(client, now)` |
| `src/lib/cron-auth.ts` | `getCronSecret(env)`（未設定・空は null）、`isAuthorizedCronRequest(authorization, secret)`（`"Bearer " + secret` とヘッダの SHA-256 同士を `timingSafeEqual`） |
| `src/app/api/cron/cleanup/route.ts` | `GET`。認証失敗は 401・空本文、成功は 200 と件数4つの JSON、例外は 500・空本文 |
| `src/lib/auth.ts` | `CRON_CLEANUP_PATH` を `PUBLIC_PATHS`（完全一致）に |
| `src/app/(auth)/login/actions.ts` | `startDemoAction(): Promise<DemoActionState>`。**引数を宣言しない。** now → IP ハッシュ → レート制限（→ `rateLimited`）→ `createDemoUser` → `createSession(userId, { now, maxAgeSeconds })` → try の外で `redirect("/")`。例外は `unavailable` |
| `src/app/(auth)/login/demo-start-button.tsx` | `DemoStartButton({ start })`（`useActionState`） |
| `src/app/demo-banner.tsx` | `DemoBanner({ expiresAtLabel })`。`/` は `findDemoExpiresAt` が null でないときだけ出す |
| `src/app/settings/passkeys/actions.ts` / `page.tsx` | start / finish は `requireUserId()` の直後に `findDemoExpiresAt` を見て、デモなら `DEMO_PASSKEY_BLOCKED_MESSAGE`。画面は登録フォーム・表示名・別端末の案内の代わりに説明を出す |

### 仕様から補足・判断した点

- デモの予算は 現金 30,000 / Aカード 70,000 / A銀行 90,000。A銀行は1日に家賃 75,000 を落とすので、月初から「超過」か「要注意」になる
- 浪費は1日にコンビニの支出を「浪費」で入れる。前月比は「医療」（今月と2か月前だけ）で増える
- implementer が手元で 2026-01-01〜2028-12-31 の全日付について「今日の日付によらず成り立つこと」1〜5 を検算済み（スクリプトはリポジトリに無い）
- 期限がちょうど `now` のデモは消さない（`lt`）
- `vercel.json` の書式と `CRON_SECRET` の Bearer ヘッダは Vercel の公式文書で確認済み（2026-09-19）

### 実装完了時点のテスト結果

`Tests 39 failed | 1765 passed (1804)`:
`tests/app/data-isolation.test.ts`（表に `startDemoAction` が無い）、
`tests/app/page.test.tsx` 12件（prisma モックに `user` が無い。ページが `findDemoExpiresAt` を呼ぶため）、
`tests/app/settings/passkeys/actions.test.ts` 21件・`page.test.tsx` 5件（`@/lib/users` のモックに `findDemoExpiresAt` が無い）。
