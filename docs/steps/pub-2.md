# 公開版 Step 2 — サインアップ

[design-decisions.md](../design-decisions.md)「3. 認証」のうち、**パスキーだけでアカウントを作る**部分の実装。

**完了条件**: ログイン画面から誰でもアカウントを作れ、作った直後にそのアカウントでログインしている /
パスキーの登録が済むまでユーザーが作られない / サインアップに IP 単位と全体のレート制限がかかる /
パスキーのユーザーIDがユーザーごとのランダム値になる / **Step 1 で持ち越した画面での実機確認（2アカウントでの分離）が通る**

---

## 前提

- 公開版 Step 1（データ分離）が完了した状態（`main` の `0c6e56f`）。テスト1650件が全件成功
- ローカルの Docker（PostgreSQL）が起動しており、`.env` が開発用の値で設定済み（`RP_ID=localhost`、`RP_ORIGIN=http://localhost:3000`）
- **単一ユーザー版の `.env` と接続先を使わない。** 接続先のホストが `localhost` / `127.0.0.1` 以外なら何もせず止まる
- `prisma migrate` でエンジンのインストールスクリプトの承認が要る場合は、承認せず止まって報告する
- 作業ブランチ `feat/signup`

---

## この Step の範囲

| 含める | 含めない（後の Step） |
|---|---|
| サインアップ画面（`/signup`）と Server Action | **リカバリーコード**（別の Step。設計判断 1） |
| パスキー検証が済んでからユーザーを作る（途中離脱でユーザーを残さない） | デモアカウント、期限切れの自動削除 |
| WebAuthn のユーザーID（user handle）をユーザーごとのランダム値に | アカウント削除の画面 |
| パスキーの表示名を固定値 `"owner"` からユーザーごとの値に | 利用規約・プライバシーポリシーの画面 |
| ログイン時に user handle と資格情報の持ち主の一致を確認 | セッションの個別失効、ユーザーの存在照合 |
| サインアップのレート制限（IP 単位＋全体） | ログイン・パスキー登録のアカウント単位の制限 |
| ログイン画面とサインアップ画面の相互リンク、`/signup` を公開パスに | チャレンジの無制限発行の再評価、`SignupEvent` の保持期間 |
| **Step 1 から持ち越した画面での実機確認** | 鍵の用途別分離（`AUTH_SECRET` は兼用のまま） |

---

## 設計判断（先に決めておくこと）

### 1. リカバリーコードはこの Step に含めない

design-decisions.md の決定事項 3 で、リカバリーコードは「スケジュールが押したら MVP から最初に削る」ことになっている。
公開予定日（2026-09-27）までにデモアカウント・セキュリティヘッダー・デプロイが残っているため、**独立した Step に分け、削れる形にしておく。**

この Step ではリカバリーコードが無い前提で画面を作る。代わりに、サインアップ画面で
**「この端末をなくすとログインできなくなる。登録後に設定から別の端末も登録してほしい」**ことを登録の前に伝える
（決定事項 3「その場合は『複数のパスキーの登録を促す』だけで出す」）。

リカバリーコードを後で足すときは、サインアップ完了の直後にコードを表示する画面を挟む。
**この Step の作りがそれを妨げないこと**（例: 完了後の遷移先を1箇所で決めている）。

### 2. パスキーの検証が済むまでユーザーを作らない

サインアップの途中離脱（design-decisions.md「残りの設計項目 > 認証」）への答え。
「ユーザーを作る → パスキーを登録する」の順にすると、生体認証を取り消しただけでパスキーの無いユーザーが残り、
**誰もログインできないのにデータ（プリセット）だけがある行**が溜まる。ボットに叩かれればそれだけで DB が埋まる。

流れ:

1. **開始**（`startSignupAction`）: レート制限を確認し、WebAuthn のユーザーID（設計判断 3）を新しく作る。
   登録用オプションを作り、**チャレンジとユーザーIDを一緒に署名付きの短命 Cookie に入れる。** DB には何も書かない
2. ブラウザでパスキーを作る
3. **完了**（`finishSignupAction`）: チャレンジ Cookie を消費し、登録応答を検証する。
   通ったら**1つのトランザクションで**ユーザー作成・プリセット投入・資格情報の保存・サインアップの記録（設計判断 5）を行い、
   そのユーザーのセッションを発行する。どれかが失敗したら全部を戻す

- ユーザーIDは登録応答には含まれないので、開始時に作った値を**署名付きの Cookie から**取り出す。
  リクエストの本文やフォームから受け取らない（改竄されれば他人の user handle で資格情報を作れてしまう）
- **サインアップ用のチャレンジは、設定画面での登録用（`register`）・ログイン用（`authenticate`）と用途を分ける。**
  JWT の `sub` と Cookie 名を別にし、取り違えたら検証に失敗すること。
  設定画面の登録用チャレンジでサインアップを完了できると、ログイン中の利用者に紐づかないパスキーの取り扱いが曖昧になる。逆も同じ
- **ユーザーIDを作れる場所（設計判断 7 / Step 1）は増やさない。** ユーザーを作る関数は `src/lib/users.ts` に置き、
  Server Action では `brandUserIdFromTrustedSource` を呼ばない
- Step 1 の `createUserWithPresets` はトランザクションを自分で張る。ユーザー作成と資格情報の保存を同じトランザクションに入れられる形にする
  （関数を分ける・トランザクションクライアントを受け取るなど、方法は実装者が決める）
- 完了時の重複（同じ資格情報IDが登録済み）は Step 1 の `createCredential` と同じ扱いでよい。トランザクションごと戻り、ユーザーは残らない

### 3. WebAuthn のユーザーID（user handle）をユーザーごとのランダム値にする

単一ユーザー版は `userName` が固定値 `"owner"` で、user handle は `@simplewebauthn/server` が登録のたびに乱数で作っていた。
複数ユーザーでは次の2つが問題になる。

- 同じ利用者が2本目のパスキーを登録するたびに user handle が変わると、認証器からは別アカウントに見える
- **ログイン時に「その資格情報は本当にこのユーザーのものか」を user handle で照合できない**（設計判断 4）

決めたこと:

- `User` に **`webauthnUserId`**（一意）を足す。**32バイトの暗号学的乱数を base64url にした文字列**（WebAuthn の上限は64バイト）
- 内部の `User.id`（cuid）を user handle に使わない。認証器（同期されるパスキーを含む）へ内部IDを渡さないため
- 設定画面での追加登録は、そのユーザーの `webauthnUserId` を使う（毎回新しく作らない）
- サインアップ時は設計判断 2 のとおり開始時に作り、完了時にその値で `User` を作る
- 既存の行は無い前提でよい（本番 DB は未作成、ローカルの DB は検証スクリプトが行を残さない）。
  ただし**マイグレーションは既存の行があっても失敗しないこと**（乱数で埋めてから NOT NULL にするなど）
- **デモアカウントの Step もこの列を使う。** `webauthnUserId` を作る関数は1つにし、呼び出し側で作り方を変えない

**表示名（`userName` / `userDisplayName`）** はパスキーの選択画面に出る。`"owner"` のままだと、同じ端末に2アカウントあるとき区別できない。

- **`webauthnUserId` から決まる短い識別子**にする。例: `家計簿 #K7Q2`（`webauthnUserId` の SHA-256 から、紛らわしい文字を除いた4文字）
- 利用者の入力（名前・メールアドレス）を使わない。持たないものは漏れない（決定事項 3）
- 同じユーザーなら、サインアップ時も設定画面での追加登録時も**同じ表示名**になること
- 設定画面（`/settings/passkeys`）に、このアカウントの表示名を出す。パスキーの選択画面で自分のアカウントを見分けるため
- 定数 `PASSKEY_USER_NAME` は消す

### 4. ログイン時に user handle と資格情報の持ち主の一致を確認する

WebAuthn の仕様（ユーザー名なしのログインで RP が行う検証）に合わせる。

- ログイン画面は `allowCredentials` を渡さない（discoverable credential）ので、認証器は応答に user handle を**必ず**含める
- 応答の `userHandle` が無い、または**資格情報の持ち主の `webauthnUserId` と一致しない**ならログイン失敗
- 失敗時の応答は他の失敗と同じ `LOGIN_ERROR_MESSAGE`。失敗として記録する（レート制限に数える）
- 資格情報の検索（`findCredentialByCredentialId`）で、持ち主の `webauthnUserId` を一緒に取れるようにする。
  **検索の条件は資格情報IDのまま**（Step 1 設計判断 6 の例外）

### 5. サインアップのレート制限

ボットによる大量登録（design-decisions.md「残りの設計項目」）への対策。
**ソフトウェアの認証器を使えば WebAuthn の登録は自動化できる**ので、パスキー必須だけでは防げない。

| 制限 | 値（定数にする） | 目的 |
|---|---|---|
| IP 単位 | **1時間に3件** | 1台からの連続登録を止める |
| 全体 | **24時間に100件** | IP を変えながらの登録でも、DB（Neon の無料枠）を食い潰させない |

- **数えるのは「作られたアカウント」。** 開始（チャレンジ発行）や検証失敗は数えない。
  サインアップの成功をトランザクション内で記録するので、ユーザーが作られた件数と記録の件数は必ず一致する
- 記録は新しいモデル **`SignupEvent`**（`ipHash`, `createdAt`）。IP は `LoginAttempt` と同じく HMAC した値だけを保存する
- **`SignupEvent` は `userId` を持たない**（`LoginAttempt` に続く2つ目の例外）。
  ユーザーに紐づけて Cascade にすると、アカウントを消すたびに記録も消え、「作って消す」を繰り返せば制限を回避できるため
- 開始時と完了時の**両方で**確認する。開始時に止めればボットはチャレンジも受け取れない。
  完了時にも確認するのは、開始から完了までの2分間に他の登録が入りうるため
- 確認と記録の間に同時に登録が来ると数件超えうる。**許容する**（厳密にするには直列化が要り、費用に見合わない）
- 全体の上限は正規の利用者も止める（DoS になりうる）。デモであり可用性への要求は低い（決定事項 1）ので、DB を守るほうを取る
- **制限にかかったことは画面に出してよい。** ユーザー名が無いので、登録の有無が漏れる経路にならない。
  文言は IP 単位と全体を区別しない（例:「新規登録が混み合っています。時間をおいてお試しください。」）
- デモアカウントの Step で同じ仕組みを使う想定。ただし**この Step では汎用化しない**（使う側が2つになってから考える）

### 6. 画面

- **`/signup`**: 公開パス（ログイン無しで開ける）。`isPublicPath` に足す。**接頭辞一致で広げすぎない**（`/signupx` などを公開にしない）
- ログイン中に `/signup` を開いたら `/` へリダイレクトする（ログイン画面と揃える必要は無い。ログイン画面はそのままでよい）
- 画面に出すこと（登録ボタンの**前に**読める位置）:
  - メールアドレスもパスワードも要らず、この端末のパスキー（指紋・顔・PIN）でアカウントを作ること
  - **この端末をなくすとログインできなくなること。登録後に「設定 > パスキー」から別の端末も登録してほしいこと**（設計判断 1）
  - **これはデモであり、実在の家計情報を入力しないでほしいこと。データは予告なく削除されうること**（決定事項 1）
  - **すでにアカウントを持っているなら、ここではなくログイン画面から入ること。** 別の端末では、スマホのパスキーを QR コードで使ってログインできること
    （設計判断 8。ここで登録すると別アカウントになる）
- 端末の名前の入力欄を置く（設定画面の登録と同じ検証 `validateDeviceName`）。資格情報の `deviceName` になる
- ブラウザが WebAuthn 非対応ならボタンを無効にして理由を出す（ログイン画面・設定画面と同じ）
- **サインアップの失敗理由は出してよい**（期限切れ・検証失敗・レート制限・重複）。ログイン画面と違い、登録の有無を推測させる情報が無いため。
  ただし設定の不備（`RP_ID` 未設定）など**サーバーの内部事情は出さない**。一般的な失敗の文言にする
- 成功したら `/` へ通常のナビゲーションで移動する（`PasskeyLoginButton` の `defaultOnSuccess` と同じ理由。セッション Cookie を確実に載せる）
- ログイン画面に「アカウントを作る」→ `/signup`、サインアップ画面に「ログインする」→ `/login` のリンク
- スマホ幅（375px）で崩れないこと。入力欄は `text-base` 以上（iOS の拡大を避ける。既存の登録フォームと同じ）

### 7. 既存の設定画面での登録

- `startPasskeyRegistrationAction` の `userID` をそのユーザーの `webauthnUserId` にし、表示名を設計判断 3 の値にする
- それ以外（`excludeCredentials` が自分の分だけ、`residentKey: "required"`、`userVerification: "required"`）は変えない
- `webauthnUserId` の取得は `userId` で絞る（`where: { id: userId }`。`User` は自分自身の行）

### 8. 別の端末で使うときの案内

**アカウントは「どのパスキーを持っているか」で決まる。** ユーザー名もメールアドレスも無いので、サーバーは同じ人かを見分けられない。
利用者が新しい端末でサインアップすると、**別のアカウントができてしまう**（元のデータは見えない）。これを画面の文言で防ぐ。

パスキーには同期されるもの（iCloud キーチェーン、Google パスワードマネージャー、パスワード管理アプリ）と、
端末から出ないもの（Windows Hello に保存したものなど）がある。同期されない端末で使う手順は次のとおりで、アプリ側の新しい仕組みは要らない:

1. 新しい端末のログイン画面で「パスキーでログイン」→ ブラウザが出す QR コードを、パスキーの入ったスマホで読み取ってログインする（ブラウザ標準のクロスデバイス認証）
2. ログインした状態で「設定 > パスキー」から「この端末を登録」を押す。同じアカウントに2本目のパスキーが付く

画面に出す文言:

- **サインアップ画面**: 設計判断 6 のとおり、既存のアカウントがあるならログイン画面から入ること、QR コードでスマホのパスキーを使えること
- **ログイン画面**: 別の端末のパスキーは QR コードで使えることを短く添える。**パスキーの登録の有無で文言を変えない**（ログイン画面は状態で出し分けない。Step 1 と同じ）
- **設定画面（`/settings/passkeys`）**: 別の端末でも使うには、その端末でログイン（QR コード可）してからこの画面で登録すること

文言はどの OS・ブラウザでも嘘にならない書き方にする（「QR コード」の表示はブラウザ側の UI で、端末によっては別の選択肢として出る。「〜で使えます」程度に留める）。

---

## 実装内容

### 1. スキーマとマイグレーション

- `User.webauthnUserId`（`String`、`@unique`）
- `SignupEvent`（`id`, `ipHash`, `createdAt`、`@@index([createdAt])` と `@@index([ipHash, createdAt])`）。`updatedAt` は持たない（`LoginAttempt` と同じく追記のみ）
- マイグレーションは `prisma migrate dev` で作る（Step 1 のあと WSL のミラーモードを外したため、DB と比較する操作が使える）
- スキーマ冒頭の共通規約のコメントに `SignupEvent` の例外を足す

### 2. ライブラリ（`src/lib/`）

- `webauthnUserId` の生成と、そこから表示名を作る関数（純粋関数。表示名は決定的であること）
- サインアップ用チャレンジの発行・検証（`webauthnUserId` を含む。用途の区別は設計判断 2）
- ユーザー作成（`users.ts`）: `webauthnUserId` と資格情報を受け取り、1つのトランザクションでユーザー・プリセット・資格情報・`SignupEvent` を作る。
  `createUserWithPresets` のシグネチャも `webauthnUserId` を受け取る形に変わる（検証スクリプト `prisma/checks/data-isolation.ts` も合わせて直す）
- レート制限: 直近1時間の IP 単位の件数、直近24時間の全体の件数、判定
- 資格情報の検索で持ち主の `webauthnUserId` を返す（設計判断 4）
- 設定画面用: `userId` からそのユーザーの `webauthnUserId` を取る

### 3. Server Action

- `src/app/(auth)/signup/actions.ts`: `startSignupAction` / `finishSignupAction`。戻り値の型は既存の `PasskeyRegistrationOptionsResult` / `PasskeyVerificationResult` に揃える
- `src/app/(auth)/login/passkey-actions.ts`: user handle の照合（設計判断 4）
- `src/app/settings/passkeys/actions.ts`: `webauthnUserId` と表示名（設計判断 7）

### 4. 画面

- `src/app/(auth)/signup/page.tsx` と登録フォーム（Client Component。Server Action は props で受け取る。既存の登録フォームと同じ形）
- ログイン画面のリンク、設定画面のアカウント表示名
- `src/lib/auth.ts` の `isPublicPath`

---

## 制約

- **テストは書かない。** `tests/` と `vitest.config.ts` には触らない。`docs/` と `.claude/` にも書き込まない
- TypeScript strict、`any` 禁止。`npx tsc --noEmit` と `npm run lint` が通ること
- **`UserId` を作れる3箇所（Step 1 設計判断 7）を増やさない。** 許可リストのテストが検査している
- 既存のテストのうち、シグネチャが変わる箇所（`createUserWithPresets`、`findCredentialByCredentialId`、`PASSKEY_USER_NAME`、分離テストの網羅の検査に新しい Server Action が無いこと）は落ちてよい。
  `npx vitest run` の結果（`FAIL` の行を含む。件数だけにしない）をレポートに貼り、**それで説明できない失敗**を分けて書く
- 手動確認のために DB に入れたユーザーは削除し、**`User` と `SignupEvent` の件数が作業前と同じであることを確認してレポートに書く**
- `next dev` / `next build` を起動したら停止してからレポートする
- 秘密の値（`AUTH_SECRET`、接続文字列）を出力しない
- 設計判断に反する必要が出たら、実装せずレポートに書いて止まる

---

## tester 向けの方針

壊れると被害が大きい順。

1. **ユーザーを作る相手の出どころ** — `finishSignupAction` が作るユーザーの `webauthnUserId` は**署名付き Cookie の値**であり、応答やフォームの値ではないこと。
   セッションは**今作ったユーザー**に発行されること
2. **チャレンジの用途** — サインアップ用・設定画面の登録用・ログイン用を互いに取り違えたら失敗すること（3×3 の組み合わせ）。
   改竄・期限切れ・`webauthnUserId` の無いトークンで失敗すること。成否にかかわらず Cookie が消えること
3. **途中離脱と失敗でユーザーが残らない** — 開始だけでは何も書かれない。検証失敗・重複・トランザクション内の途中の失敗で、ユーザー・プリセット・資格情報・`SignupEvent` が1件も残らない（トランザクションに入っていること）
4. **レート制限** — IP 単位の境界（1時間に3件なら、3件目までは作れて4件目で止まる）、時間窓の外は数えない、全体の上限、開始と完了の両方で確認、失敗は数えない
5. **user handle の照合** — 一致で成功、不一致・欠落で `LOGIN_ERROR_MESSAGE` と失敗の記録。**他人の資格情報に自分の user handle を付けた応答**で失敗すること
6. **`webauthnUserId`** — 32バイト相当の長さ、base64url、呼ぶたびに違う値。表示名が決定的で、同じ値から同じ表示名になり、紛らわしい文字を含まない
7. **設定画面の登録** — そのユーザーの `webauthnUserId` と表示名が使われ、**他のユーザーの値が使われない**
8. **公開パス** — `/signup` が公開、`/signupx`・`/signup-admin` などが公開でない。ログイン中の `/signup` がリダイレクト
9. **画面** — 登録前の注意書き（別の端末の登録を促す文言・デモである旨・既存アカウントならログイン画面へ）が出る、ログイン画面と設定画面の別端末の案内（設計判断 8）、非対応ブラウザ、失敗文言、成功時の遷移。内部事情（`RP_ID` 未設定）を出さない
10. **スキーマ** — `webauthnUserId` の一意、`SignupEvent` に `userId` が無い（`LoginAttempt` と並ぶ例外として schema テストの期待を更新する）
11. **分離テストの表** — 新しい Server Action の行を足す。サインアップはログイン前の操作なので「他人のデータに触れない」ことの確認の形がログインの行と同じになる

単体テストから実データベースに接続しない（Step 1 と同じ）。

---

## 変異テスト（必須）

1つずつ入れ、`git diff` で変異が入ったことを確認してから流し、戻す。結果は「変異 / 落ちたテスト名 / 件数」の表で残す。

| # | 変異 | 期待 |
|---|---|---|
| 1 | `finishSignupAction` で、登録応答の検証より前にユーザーを作る | 落ちる |
| 2 | ユーザー作成と資格情報の保存を別のトランザクションに分ける（資格情報の保存が失敗してもユーザーが残る） | 落ちる |
| 3 | サインアップ用チャレンジの `sub` を設定画面の登録用と同じにする | 落ちる |
| 4 | `finishSignupAction` で、Cookie ではなく新しく作った `webauthnUserId` でユーザーを作る | 落ちる |
| 5 | IP 単位の制限の判定を `>=` から `>` にする（境界のずれ） | 落ちる |
| 6 | 全体の上限の確認を外す | 落ちる |
| 7 | 完了時のレート制限の確認を外す | 落ちる |
| 8 | ログインの user handle の照合を外す | 落ちる |
| 9 | 設定画面の登録で、ユーザーの `webauthnUserId` ではなく毎回新しい値を使う | 落ちる |
| 10 | `isPublicPath` で `/signup` を接頭辞一致にする（`startsWith("/signup")`） | 落ちる |
| 11 | `finishSignupAction` の成功時にセッションを発行しない | 落ちる |
| 12 | `SignupEvent` の記録をトランザクションの外（ユーザー作成の後）に出す | 落ちる |

### 変異テストの結果（2026-09-19）

**12件すべて検出。** 変異は文字列置換で1件ずつ入れ、`git diff` で入ったことを確認してから全テストを流し、戻した（最後に `src/` / `prisma/` の未コミット変更が無いことを確認）。テスト総数は1804件。

| # | 落ちた件数 | 検出したテスト |
|---|---|---|
| 1 | 5 | `signup/actions.test.ts`（検証失敗・例外でユーザーを作らない、単回性 など） |
| 2 | 1 | `users.test.ts`「成功時: User作成 → createCredential → recordSignupEvent の順で同じトランザクション内に呼ばれ…」 |
| 3 | 3 | `passkey.test.ts`（定数、3×3 の取り違え）、`passkey-session.test.ts`（signup のトークンを register / authenticate として消費できない） |
| 4 | 2 | `signup/actions.test.ts`「Cookie から取り出した webauthnUserId を渡す」「応答の余分なフィールドを無視する」 |
| 5 | 3 | `signup-limits.test.ts`（IP 単位がちょうど3件で止まる境界） |
| 6 | 3 | `signup-limits.test.ts`（全体がちょうど100件で止まる境界） |
| 7 | 2 | `signup/actions.test.ts`「完了時にもレート制限を確認する」「開始・完了で1回ずつ呼ぶ」 |
| 8 | 3 | `passkey-actions.test.ts`（別人の user handle・欠落・空文字） |
| 9 | 1 | `settings/passkeys/actions.test.ts`「userID にはそのユーザーの webauthnUserId 由来のバイト列を使う」 |
| 10 | 1 | `auth.test.ts`「接頭辞一致で広げない: /signupx・/signup-admin・/signup/foo は公開でない」 |
| 11 | 2 | `signup/actions.test.ts`「今作ったユーザーに対してセッションを発行する」ほか |
| 12 | 1 | #2 と同じ `users.test.ts` の1ケース |

- **#2 と #12 は同じ1ケースだけが検出している。** トランザクションの境界はモックでは「`tx` で呼ばれたか」でしか見られない。
  実際の PostgreSQL で戻ることは、検証スクリプト（`prisma/checks/data-isolation.ts` の 7b）が確認している

---

## 実機確認（Step 1 からの持ち越しを含む）

ローカル（`npm run dev`、`http://localhost:3000`、Chrome）で行う。パスキーは OS の認証器（Windows Hello など）を使う。

1. `/login` から「アカウントを作る」→ `/signup`。注意書きが登録ボタンの前に読めること
2. **アカウントA** を作る。ダッシュボードが開き、プリセット（カテゴリ11件・払い出し先「現金」）があること
3. A で支出を1件登録し、その編集画面の URL（`/expenses/<id>`）を控える
4. ログアウトし、**アカウントB** を作る。B の支出一覧が空で、カテゴリ・払い出し先が B 自身のプリセットであること
5. B のまま、控えた A の URL を開いて **404** になること（カテゴリ・払い出し先の `[id]` も同様）
6. ログアウトしてログイン。パスキーの選択画面に**2つのアカウントが別の表示名で**出ること。A を選ぶと A のデータ、B を選ぶと B のデータが出ること
7. `/settings/passkeys` に表示名が出て、パスキーの選択画面の表示と一致すること
8. ログイン中に `/signup` を開くと `/` へ移ること
9. 生体認証を途中で取り消したとき、エラーが出て、**ユーザーが増えていない**こと（DB の `User` の件数で確認）
10. **（スマホがあれば）別の端末での利用**: A のパスキーをスマホに作っておく（`/settings/passkeys` で登録し、QR コードでスマホを選ぶ）。
    PC のパスキーを使わずに、ログイン画面から QR コード経由でスマホのパスキーで A にログインできること。
    ローカルの `http://localhost:3000` では、スマホ側がオリジンを検証するためクロスデバイス認証が通らない場合がある。
    通らなければこの項目はデプロイ後のプレビュー環境へ持ち越し、その旨を記録する

### 実機確認の結果（2026-09-19、Windows・Chrome・Windows Hello）

| # | 結果 |
|---|---|
| 1〜3 | OK。サインアップ画面から A を作成し、ダッシュボードとプリセットを確認 |
| 4・5 | **OK。A の支出の編集画面（`/expenses/<id>`）を B で開くと 404。** Step 1 から持ち越した画面での分離の確認はこれで完了 |
| 6 | OK。パスキーの選択画面に2つのアカウントが別の表示名で出て、選んだアカウントのデータが出る |
| 7 | 未確認（設定画面の表示名とパスキーの選択画面の一致） |
| 8 | 利用者は未確認。implementer が `next dev` と仮のセッション Cookie で `/` へのリダイレクトを確認済み |
| 9 | OK。生体認証を取り消すとエラーが出て、ユーザーは増えない |
| 10 | **デプロイ後のプレビュー環境へ持ち越し。** サインアップで「iPhone、iPad、または Android デバイス」を選び、表示された QR コードを Android の標準カメラで読むと `FIDO:/…` の文字列が出るだけで、パスキーの作成に進めなかった。原因の候補は、読み取るアプリが `FIDO:` を扱えない、PC とスマホの Bluetooth、`localhost` の RP ID。アプリのコードの不具合ではないため、本物の https のドメインで確認する |

**後片付け**: 作った A・B は DB から削除する（`User` を消せば Cascade で全データが消える。利用者の同意を得てから行う）。
OS に登録されたパスキーは DB から消えても残るので、OS の設定（Windows なら「設定 > アカウント > パスキー」）から消す。

---

## 完了レポートに含めるもの

1. 作成・変更・削除したファイル一覧
2. **公開インターフェース** — 新しい関数・Server Action・コンポーネントのシグネチャと戻り値、変わったシグネチャ
3. 生成されたマイグレーション SQL の要点（`webauthnUserId` の既存行の埋め方、`SignupEvent` のインデックス）
4. サインアップ用チャレンジの用途の区別の方法、`webauthnUserId` をどこから取り出しているか
5. レート制限の定数と、開始・完了のどこで確認しているか
6. 手動確認をしたなら、その内容と後片付け（`User` / `SignupEvent` の件数が作業前と同じ）
7. `npx tsc --noEmit` / `npm run lint` / `npx vitest run`（`FAIL` の行を含む）の結果
8. 判断した点、未解決の懸念、後の Step への持ち越し

---

## この Step で決まること

> **2026-09-19 に [design-decisions.md](../design-decisions.md)「7. サインアップで決めたこと」へ移した。** 以下は指示書を書いた時点の一覧。

- リカバリーコードは独立した Step にし、削れる形にする
- ユーザーはパスキーの検証が済んでから作る（途中離脱でユーザーを残さない）
- WebAuthn のユーザーIDはユーザーごとの32バイトの乱数。内部IDを認証器に渡さない
- ログイン時に user handle と資格情報の持ち主を照合する
- サインアップは IP 単位（1時間3件）と全体（24時間100件）で制限する。`SignupEvent` は `userId` を持たない
- アカウントはパスキーで決まる。別の端末で使うときは QR コードでログインしてからパスキーを追加する（新しい端末でのサインアップは別アカウントになる）

---

## 実装完了後の引き継ぎ（tester 向け）

実装はコミット `f2e36f5`。以下は implementer の完了レポートの要約。**シグネチャの正は実装のコード**なので、ずれていたらコードを読むこと。

### モジュール構成

| ファイル | 担当 |
|---|---|
| `src/lib/webauthn-user-id.ts` | `generateWebauthnUserId()`（32バイト乱数の base64url、43文字。作る関数はこれ1つ）、`isValidWebauthnUserId`、`webauthnUserIdToBytes`、`getPasskeyDisplayName`（`"家計簿 #XXXX"`。SHA-256 由来で決定的。アルファベットは `PASSKEY_DISPLAY_CODE_ALPHABET`）、`userHandleMatches(userHandle, webauthnUserId)` |
| `src/lib/passkey.ts` | `createSignupChallengeToken` / `verifySignupChallengeToken`（`sub = "passkey-signup"`、`webauthnUserId` クレーム必須）。**`ChallengePurpose` には入れず専用関数**。`PASSKEY_USER_NAME` は削除 |
| `src/lib/passkey-session.ts` | `setSignupChallengeCookie` / `consumeSignupChallengeCookie`（Cookie `kakeibo_passkey_signup`。検証の前に消す） |
| `src/lib/signup-limits.ts` | 定数（1時間3件・24時間100件）、`countRecentSignupsByIp` / `countRecentSignups` / `isSignupLimitReached`（純粋、`>=`）/ `isSignupRateLimited` / `recordSignupEvent(tx, ipHash)` |
| `src/lib/signup-messages.ts` | `SIGNUP_PATH`、`SIGNUP_COMPLETE_PATH = "/"`、`SIGNUP_ERRORS` |
| `src/lib/users.ts` | `createUserWithPresets(client, webauthnUserId)`（**シグネチャ変更**）、`createUserWithPasskey(client, { webauthnUserId, credential, ipHash })` → `{ ok: true, userId } \| { ok: false, reason: "duplicate" }`（1トランザクションで User → プリセット → 資格情報 → SignupEvent）、`findWebauthnUserId(client, userId)` |
| `src/lib/credentials.ts` | `findCredentialByCredentialId` が `include: { user: { select: { webauthnUserId: true } } }` を返す（**戻り値の型変更**）。`createCredential` の第1引数は `Prisma.TransactionClient` |
| `src/lib/auth.ts` | `PUBLIC_PATHS`（完全一致）に `/signup` |
| `src/app/(auth)/signup/actions.ts` | `startSignupAction()`、`finishSignupAction(response, deviceName)`。処理順は下記 |
| `src/app/(auth)/signup/page.tsx` / `signup-form.tsx` | ログイン中は `redirect("/")`。`SignupForm` の props は `start` / `finish` / `register?` / `onSuccess?` / `supportsWebAuthn?` |
| `src/app/(auth)/login/passkey-actions.ts` | 資格情報を引いた直後、署名検証の前に `userHandleMatches` で照合。不一致は失敗を記録して `LOGIN_ERROR_MESSAGE` |
| `src/app/settings/passkeys/actions.ts` | `startPasskeyRegistrationAction` が `findWebauthnUserId` の値と表示名を使う。null なら `PASSKEY_ERRORS.accountNotFound` |

`finishSignupAction` の処理順: Cookie を消費（null → `challengeExpired`）→ 端末名の検証 → IP ハッシュとレート制限（→ `rateLimited`）→ `getRpConfig` → `verifyRegistrationResponse`（→ `verificationFailed`）→ `createUserWithPasskey`（Cookie の `webauthnUserId` を使う。重複 → `duplicate`）→ `createSession(戻り値の userId)`。予期しない例外は `unavailable`。

### 仕様から補足・判断した点

- **ログイン中でもサインアップの Server Action は拒否しない**（画面だけリダイレクト）。直接叩くと新しいアカウントが作られてセッションが切り替わる。他人のデータには触れない
- 端末名の検証より前に Cookie を消費する（成否にかかわらず Cookie を消すため）
- マイグレーションは `migrate dev --create-only` が一意制約の警告で止まったため、`migrate diff` で SQL を作り、既存行の埋め込みを手で足した。適用後の差分は無い
- 表示名の4文字は一意ではない（見分けるための名前）

### 実装完了時点のテスト結果

`Tests 16 failed | 1634 passed (1650)`。すべて指示書で「落ちてよい」とした変更による:
`tests/lib/users.test.ts`（`createUserWithPresets` の引数）、`tests/lib/credentials.test.ts`（`include` が増えた）、
`tests/app/(auth)/login/passkey-actions.test.ts`（資格情報に `user.webauthnUserId`・応答に `userHandle` が無い）、
`tests/app/settings/passkeys/actions.test.ts`（モックの prisma に `user` が無い）、`tests/app/data-isolation.test.ts`（表にサインアップの2アクションが無い）。
`npx tsc --noEmit` のエラーは `tests/lib/users.test.ts` の6件のみ。
