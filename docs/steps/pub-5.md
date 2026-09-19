# 公開版 Step 5 — リカバリーコード

[design-decisions.md](../design-decisions.md)「3. 認証」のリカバリーコード（パスキーを全部失ったときの逃げ道）の実装。
Step 2 で「独立した Step に分け、削れる形にしておく」とした部分。

**完了条件**: サインアップの直後にリカバリーコードが一度だけ表示される / パスキーを持たない状態から、コードを入力して新しいパスキーを登録し、元のアカウントに戻れる /
コードは使ったら無効になり、新しいコードが一度だけ表示される / DB にはコードのハッシュだけがある / 設定画面からコードを作り直せる /
**リカバリーの途中の状態では、パスキーの登録以外に何もできない**

---

## 前提

- 公開版 Step 4（セキュリティヘッダー）が完了した状態（`main` の `1def3e2`）。テスト2914件が全件成功
- ローカルの Docker（PostgreSQL）が起動しており、`.env` が開発用の値で設定済み
- 作業ブランチ `feat/recovery-code`
- **CSP が厳格になっている**（Step 4）。JSX にインラインの `style` を書かない。画面の確認は本番ビルドで行う

---

## この Step の範囲

| 含める | 含めない（後の Step） |
|---|---|
| コードの生成・表示（サインアップ直後・リカバリー完了後・設定からの作り直し） | コードの作り直しの前のパスキーでの再認証（設計判断 8） |
| コードの入力画面（`/recovery`）と、リカバリー中のパスキー登録画面 | リカバリー時に古いパスキーを自動で消すこと（設計判断 7） |
| リカバリー専用の短命なトークン（通常のセッションとは別物） | 1ユーザーに複数のコード（GitHub のような10個組） |
| コード入力のレート制限（IP 単位） | リカバリーの通知（メールアドレスを持たないので手段が無い） |
| 設定画面でのコードの状態表示と作り直し | デモユーザーのコード（デモは持たない） |

---

## 設計判断（先に決めておくこと）

### 1. コードの形

- **20文字、紛らわしい文字を除いた32種類の文字**（例: `23456789ABCDEFGHJKMNPQRSTUVWXYZ` に1文字足すなど、0 / O / 1 / I / L を含まない32文字）。**100ビット**の暗号学的乱数
- **実装での決定（2026-09-19、利用者が選択）: 文字は `23456789ABCDEFGHJKMNPQRSTUVWXYZ#`。** 0 / O / 1 / I / L を除くと英数字は31文字しか残らないため、32文字目に `#` を足した。
  Crockford 方式（O→0、I/L→1 に読み替え）や 31文字×21文字も候補にしたが、20文字・100ビットのままで読み替えの規則を持たない今の形を採った
- 表示は5文字ずつハイフンで区切る（`K7Q2M-9XP4H-TR8WN-B3D6F`）
- 入力は、前後と途中の空白・ハイフンを取り除き、英字を大文字にしてから照合する（**正規化**）。それ以外の文字が残れば照合せずに失敗
- **平文はどこにも保存しない。** Server Action の戻り値として画面に一度渡すだけ。ログ・DB・Cookie・URL に出さない

### 2. DB にはハッシュだけを保存する。ハッシュは鍵なしの SHA-256

- `User.recoveryCodeHash`（`String?`、`@unique`）。**正規化したコードの SHA-256（16進）**。`null` は「コードが無い」（デモユーザー、または未発行）
- **design-decisions.md の「鍵付きハッシュ（HMAC）」から変える。** 理由:
  - コードは100ビットの乱数なので、DB が漏れてもハッシュから総当たりで戻すことはできない。鍵が守るのは「推測できる値（IP アドレスなど）」のハッシュで、ここでは効果が無い
  - 鍵を使うと、**鍵を交換したときに全員のコードが使えなくなる。** 今の運用では `AUTH_SECRET` の交換が「全員のセッションを切る」手段なので、兼用すると交換のたびに全員の非常口が消える
  - パスワードのような低エントロピーの値ではないので、ソルトや遅いハッシュ（bcrypt など）も要らない（GitHub のトークンなどと同じ扱い）
- ユニーク制約でコードからユーザーを1人に特定する（ユーザー名を持たないため）

### 3. サインアップ直後に一度だけ表示する

- `finishSignupAction` のトランザクションで、ユーザーと一緒にコードのハッシュを保存する（Step 2 のトランザクションに足す）
- 成功の戻り値で平文のコードを返し、サインアップ画面が**コードの表示に切り替わる**。「控えました」の確認（チェックボックスなど）の後に `/` へ移る（Step 2 の `SIGNUP_COMPLETE_PATH` の1箇所）
- 表示では: コードは等幅で読みやすく、**コピーのボタン**を置く。「この画面を閉じると二度と表示されない」「パスキーを全部なくしたときに使う」「なくした場合は設定から作り直せる」ことを書く
- 画面を閉じたり再読み込みしたりすると、そのコードは二度と見られない（仕様どおり）。設定から作り直せる（設計判断 6）

### 4. リカバリーは2段階。**コードの消費はパスキーの登録が済んだときに行う**

コードを入力した時点で無効にすると、そのあと生体認証を取り消したり画面を閉じたりしただけで、**コードもパスキーも無い＝二度と戻れない**状態になる。
そこで、入力の時点では照合だけを行い、**新しいパスキーの登録と同じトランザクションでコードを差し替える。**

流れ:

1. **`/recovery`**（公開パス）: コードを入力する（`verifyRecoveryCodeAction`）
   - IP 単位のレート制限（設計判断 5）を確認する
   - 正規化 → ハッシュ → `recoveryCodeHash` が一致し、`demoExpiresAt` が `null` のユーザーを探す
   - 見つかったら**リカバリー用トークン**（設計判断 5）を Cookie に置き、`/recovery/passkey` へ移る。**まだコードを消費しない**
   - 見つからなければ一律の文言（例:「コードが正しくないか、すでに使われています。」）。**「使用済み」と「間違い」を区別しない**
2. **`/recovery/passkey`**（公開パス。ただしリカバリー用トークンが無ければ `/recovery` へ）: 新しいパスキーを登録する
   - 登録の開始（`startRecoveryPasskeyRegistrationAction`）: トークンを検証し、そのユーザーの `webauthnUserId` と表示名、**そのユーザーの**登録済みパスキーを `excludeCredentials` にする（Step 2 / 3 の設定画面と同じ）
   - 登録の完了（`finishRecoveryPasskeyRegistrationAction`）: 応答を検証し、**1つのトランザクションで**
     - 資格情報を作る
     - **`recoveryCodeHash` を新しいコードのハッシュに差し替える。条件は `where: { id: userId, recoveryCodeHash: トークンに入れたハッシュ }`。更新が1件でなければ失敗として全部を戻す**
       （同じコードで2つのリカバリーが並んだとき、先に終わった方だけが通る。途中で設定から作り直されていたら通らない）
   - 成功したらリカバリー用トークンを消し、**通常のセッションを発行し**、新しいコードを一度だけ表示する（設計判断 3 と同じ画面の部品を使ってよい）。「控えました」の後に `/` へ
   - 表示では「なくした端末のパスキーは、設定 > パスキー から削除してください」と伝える（設計判断 7）

### 5. リカバリー用トークンは通常のセッションとは別物にする

**コードを入力しただけの状態で、家計データに触れさせない。** できるのはパスキーの登録だけ。

- 署名付き JWT。**`typ` ヘッダを `kakebo-recovery+jwt` にする**（セッションの `kakebo-session+jwt`、チャレンジの typ 無しと区別。Step 1 設計判断 8 と同じ考え方）
- 中身は `sub` = ユーザーID と、照合したコードのハッシュ（設計判断 4 の差し替えの条件に使う）
- **有効期限10分**、Cookie は別の名前（`httpOnly` / `SameSite=Lax` / 本番で `Secure`、`path: "/"`）
- `verifySessionToken` はこのトークンを受け付けない（typ が違う）。**proxy・`requireUserId()`・全データ画面はこのトークンではログイン扱いにならない**
- 逆に、リカバリーの Server Action は通常のセッションを受け付けない（セッションがあってもリカバリー用トークンが無ければ失敗）
- 検証関数は `src/lib/auth.ts` に置く。**`UserId` を作れる3箇所（Step 1 設計判断 7）を増やさない**（`auth.ts` はすでに許可リストにある。新しいファイルで `brandUserIdFromTrustedSource` を呼ばない）
- **パスキー登録のチャレンジは用途を分ける**（sub と Cookie 名。Step 2 の3用途に「リカバリー中の登録」を足して4用途）
- `/recovery` と `/recovery/passkey` は `isPublicPath` に**完全一致で**足す

### 6. レート制限

- コードの入力は **`LoginAttempt` に記録し、ログインと同じ IP 単位の制限（15分に10回の失敗）を使う。** 照合の失敗を失敗として、成功を成功として記録する
- 100ビットのコードは総当たりで当たらないので、制限の目的は負荷と濫用の抑止
- 制限にかかったときも、文言はコードの失敗と同じにする（ログイン画面と同じ方針）

### 7. 古いパスキーは自動で消さない

リカバリーは「なくした」ときに使うが、「なくしたと思ったが実は手元にあった」こともある。
自動で消すと、コードを盗んだ人がリカバリーしたときに本人のパスキーまで消え、本人が締め出される。
消すかどうかは本人が設定画面で決める（完了画面で案内する）。

### 8. 設定画面でコードを作り直せる

- `/settings/passkeys` に「リカバリーコード」の欄を置く: 発行済みか（`recoveryCodeHash` の有無）と、「作り直す」ボタン
- 作り直し（`regenerateRecoveryCodeAction`）は `requireUserId()` の値で `where: { id: userId }` を更新し、新しいコードを一度だけ表示する。**古いコードはその時点で使えなくなる**
- **デモユーザーには出さず、Server Action でも DB の `demoExpiresAt` を見て拒否する**（Step 3 のパスキー登録と同じ）
- 作り直しの前にパスキーでの再認証は求めない。セッションを盗まれた場合はパスキーの追加もできてしまうので、再認証を入れるならセッションの個別失効と一緒に考える（範囲外の表）

### 9. 画面

- ログイン画面に「パスキーをなくした場合」→ `/recovery` のリンク
- `/recovery`: コードの入力欄（`autocomplete="off"`、`text-base` 以上）と送信ボタン、ログイン画面へのリンク
- サインアップ画面の注意書き（Step 2 設計判断 1 の「この端末をなくすとログインできなくなる」）を、「登録の後に表示するリカバリーコードを控えてほしい。別の端末も登録しておくと安心」の趣旨に改める
- スマホ幅（375px）で崩れないこと。**インラインの `style` を書かない**（Step 4）
- コピーのボタンは `navigator.clipboard.writeText` でよい（CSP に影響しない）。使えない環境ではボタンを出さないか、失敗を伝える

---

## 実装内容

1. スキーマ: `User.recoveryCodeHash`（`String?`、`@unique`）。マイグレーション（Step 3 と同じ手順）
2. `src/lib/`:
   - コードの生成・表示用の整形・正規化・ハッシュ（純粋関数）
   - リカバリー用トークンの発行・検証（検証は `auth.ts`）と Cookie の副作用
   - データ層: ハッシュでユーザーを探す（`demoExpiresAt: null` の条件つき）、差し替え（条件つき更新）、作り直し、状態の取得
   - ユーザー作成（`createUserWithPasskey`）にコードのハッシュを足す
3. Server Action:
   - `finishSignupAction` の戻り値に平文のコード
   - `verifyRecoveryCodeAction`、`startRecoveryPasskeyRegistrationAction`、`finishRecoveryPasskeyRegistrationAction`
   - `regenerateRecoveryCodeAction`
4. 画面: サインアップの完了表示、`/recovery`、`/recovery/passkey`、設定画面の欄、ログイン画面のリンク
5. 検証スクリプト（`prisma/checks/` に追加）: 実DBで、同じコードで2回差し替えようとしたら2回目が失敗すること、ユニーク制約、デモユーザーが探索の対象にならないことを確かめる

---

## 制約

- **テストは書かない。** `tests/` と `vitest.config.ts` には触らない。`docs/` と `.claude/` にも書き込まない
- TypeScript strict、`any` 禁止。`npx tsc --noEmit` と `npm run lint` が通ること
- **`UserId` を作れる3箇所を増やさない**
- **平文のコードを出力しない**（レポート・ログ・DB）。確認でコードを使う場合も、画面や標準出力に出さず、長さと文字種だけを報告する
- 既存のテストが落ちた場合は `npx vitest run` の結果（`FAIL` の行を含む）をレポートに貼り、原因を書く
- 本番ビルドでの確認はポート 3000 以外を使い、起動したものは止める。DB にデータを入れたら消し、件数が作業前と同じことを確かめる
- 秘密の値（`AUTH_SECRET`、`CRON_SECRET`、接続文字列）を出力しない
- 設計判断に反する必要が出たら、実装せずレポートに書いて止まる

---

## tester 向けの方針

壊れると被害が大きい順。

1. **リカバリー用トークンでは家計データに触れない** — リカバリー用トークンを `verifySessionToken` に渡すと `null`。セッションの Cookie 名にリカバリー用トークンを入れても proxy は通さない。
   逆に、通常のセッションしか無い状態でリカバリーの Server Action は失敗する。改竄・期限切れ（10分）・typ 違いで失敗
2. **コードの消費は登録の完了と同時** — 入力の時点では `recoveryCodeHash` を変えない。登録の完了で、資格情報の作成とハッシュの差し替えが同じトランザクションにあり、差し替えの `where` に `id` と**トークンのハッシュ**がある。
   更新が0件（先に使われた・作り直された）なら資格情報も作られない
3. **平文を保存しない** — DB に渡る値がハッシュ（64文字の16進）で、平文と一致しない。生成が暗号学的乱数で、呼ぶたびに違う、20文字、許可した文字だけ
4. **正規化** — 小文字・ハイフン・空白の有無で同じハッシュになる。許可しない文字（`0` `O` `1` `I` `L` など）を含むと照合しない
5. **照合の失敗の文言が一律** — 間違い・使用済み・レート制限・デモユーザーのコードで、同じ文言。失敗が `LoginAttempt` に記録され、制限にかかると照合しない
6. **サインアップ** — 成功の戻り値にコードがあり、そのハッシュが同じトランザクションで保存される。失敗時にはコードを返さない
7. **作り直し** — `requireUserId()` の値で絞る。デモユーザーは拒否。古いハッシュが新しいハッシュに置き換わる
8. **チャレンジの用途** — リカバリー中の登録のチャレンジと、ほかの3用途（サインアップ・設定画面の登録・ログイン）の取り違えで失敗（4×4）
9. **公開パス** — `/recovery` と `/recovery/passkey` が公開、`/recoveryx`・`/recovery/other` が公開でない
10. **画面** — 完了表示で「控えました」まで遷移しない、コピー、`/recovery/passkey` はトークンが無ければ `/recovery` へ、設定画面の欄（デモには出ない）、ログイン画面のリンク
11. **スキーマ** — `recoveryCodeHash` が任意・一意
12. **分離テストの表** — 新しい Server Action の行を足す。`UserId` の許可リストのテストが通ること

単体テストから実データベースに接続しない。

---

## 変異テスト（必須）

1つずつ入れ、`git diff` で変異が入ったことを確認してから流し、戻す。結果は「変異 / 落ちたテスト名 / 件数」の表で残す。

| # | 変異 | 期待 |
|---|---|---|
| 1 | `verifySessionToken` がリカバリー用トークンの typ も受け付ける | 落ちる |
| 2 | `verifyRecoveryCodeAction` の時点でコードを消費する（ハッシュを `null` にする） | 落ちる |
| 3 | 差し替えの `where` からトークンのハッシュの条件を外す（`where: { id: userId }` だけにする） | 落ちる |
| 4 | 資格情報の作成とハッシュの差し替えを別のトランザクションにする | 落ちる |
| 5 | 平文のコードを DB に保存する（ハッシュしない） | 落ちる |
| 6 | 正規化で大文字にしない | 落ちる |
| 7 | ユーザーの探索から `demoExpiresAt: null` の条件を外す | 落ちる |
| 8 | 照合の失敗を `LoginAttempt` に記録しない | 落ちる |
| 9 | 「使用済み」と「間違い」で文言を変える | 落ちる |
| 10 | リカバリー中の登録のチャレンジの sub を設定画面の登録用と同じにする | 落ちる |
| 11 | `regenerateRecoveryCodeAction` のデモユーザーの拒否を外す | 落ちる |
| 12 | `finishRecoveryPasskeyRegistrationAction` の成功時にリカバリー用トークンを消さない | 落ちる |
| 13 | リカバリー用トークンの有効期限を30日にする | 落ちる |

### 変異テストの結果（2026-09-19）

**13件すべて検出。** 変異は文字列置換で1件ずつ入れ、`git diff` で入ったことを確認してから全テスト（3159件）を流し、戻した（最後に `src/` / `prisma/` の未コミット変更が無いことを確認）。

| # | 落ちた件数 | 検出したテスト |
|---|---|---|
| 1 | 6 | `proxy.test.ts`「リカバリー用トークンをセッション Cookie 名に入れてもリダイレクトする」、`auth.test.ts`（typ）、`session.test.ts`（requireUserId） |
| 2 | 24 | `recovery/actions.test.ts`（照合の正常系・start など）。**注: モックの prisma に `user.updateMany` が無く、変異が例外になって失敗の分岐に落ちたことで検出している**（下記） |
| 3 | 2 | `recovery-codes.test.ts`（差し替えの where）、`data-isolation.test.ts`（A の userId で B のハッシュを指定しても差し替わらない） |
| 4 | 1 | `recovery-codes.test.ts`「updateMany → createCredential の順で同じトランザクション内に呼ばれ…」 |
| 5 | 1 | `signup/actions.test.ts`「recoveryCode は createUserWithPasskey に渡した recoveryCodeHash のハッシュ元」 |
| 6 | 5 | `recovery-code.test.ts`（正規化・ハッシュ）、`recovery/actions.test.ts`（小文字を含む入力） |
| 7 | 1 | `recovery-codes.test.ts`「where は { recoveryCodeHash, demoExpiresAt: null }」 |
| 8 | 3 | `recovery/actions.test.ts`（見つからない・不正文字・例外のそれぞれで失敗を記録） |
| 9 | 1 | `recovery/actions.test.ts`「codeNotCurrent なら invalidCode を返し、トークンを消す」 |
| 10 | 5 | `passkey.test.ts`（4用途の sub が異なる、4×4）、`recovery/actions.test.ts`（登録用チャレンジで challengeExpired） |
| 11 | 2 | `settings/passkeys/actions.test.ts`（デモの拒否） |
| 12 | 1 | `recovery/actions.test.ts`「clearRecoveryCookie の後に createSession」 |
| 13 | 6 | `auth.test.ts`（定数・600秒の境界・長い exp も600秒で失効）、`recovery-session.test.ts`（Cookie の maxAge） |

- **#2（照合の時点でコードを消費する）は、たまたま検出されている。** 「照合でコードを変えない」ことを直接見るテストは `completeRecoveryWithPasskey` を呼ばないことだけで、
  変異のようにアクションが直接 `prisma.user.updateMany` を呼ぶ形は、モックに無いメソッドで例外になって落ちている。
  **実機確認 5（生体認証を取り消しても同じコードがまだ通る）で振る舞いを確かめる。** 実DBでは検証スクリプト 2c（照合してもハッシュが変わらない）がデータ層の側を確かめている
- **#4 / #5 / #7 / #9 / #12 は1ケースだけが検出している。** #4 は検証スクリプト 5d（重複で差し替えも戻る）と 6（同時に2回完了）、#7 は 4b が実DBで確かめている

---

## 実機確認

**本番ビルドで行う**（`npm run build` → `npm run start`）。DevTools の Console を開いたまま（CSP の違反が出ないこと）。

1. サインアップすると、パスキーの登録の後にリカバリーコードが表示される。コピーのボタンで控えられる。「控えました」までダッシュボードへ移らない
2. 支出を1件登録してからログアウト
3. ログイン画面の「パスキーをなくした場合」→ `/recovery` で、**わざと間違えたコード**を入れると失敗の文言が出る
4. 控えたコードを小文字・ハイフン無しで入れると通り、パスキーの登録画面に移る
5. **登録画面で生体認証を取り消し**、もう一度 `/recovery` から同じコードを入れると、まだ通る（コードは消費されていない）
6. 新しいパスキーを登録すると、新しいコードが表示され、「控えました」の後にダッシュボードが開き、**2 で登録した支出がある**（元のアカウントに戻れている）
7. ログアウトし、**古いコード**を `/recovery` に入れると失敗する
8. 新しいパスキーでログインでき、設定のパスキー画面にパスキーが2本ある。古い方を削除できる
9. 設定画面でリカバリーコードを作り直すと新しいコードが表示され、その1つ前のコードは `/recovery` で使えない
10. デモユーザーでは、設定画面にリカバリーコードの欄が出ない

### 実機確認の結果（2026-09-19、Windows・Chrome・Windows Hello、`next build` → `next start`）

1〜10 すべて OK。**5（登録画面で生体認証を取り消しても、同じコードがまだ通る）も OK** で、変異テスト #2 の弱さを振る舞いの側で補った。
CSP の違反なし。

設定画面の「別の端末で使う」案内（QR コードがブラウザの画面から出ることを書いていない、スマホにパスキーがある前提）について検討したが、利用者の判断で文言は今のままにした。

**後片付け**: 作ったユーザーは、利用者の同意を得てから DB から消す。OS に登録されたパスキーは OS の設定から消す。

---

## 完了レポートに含めるもの

1. 作成・変更・削除したファイル一覧
2. **公開インターフェース** — 新しい関数・Server Action・コンポーネントのシグネチャと戻り値、変わったシグネチャ
3. マイグレーション SQL の要点
4. リカバリー用トークンの形（typ・中身・期限・Cookie）と、通常のセッションとして通らないことをどう確かめたか
5. 差し替えの条件つき更新の実際の `where` と、トランザクションの範囲
6. 検証スクリプトの結果と後片付け（件数が作業前と同じ）
7. `npx tsc --noEmit` / `npm run lint` / `npx vitest run`（`FAIL` の行を含む）の結果
8. 判断した点、未解決の懸念、後の Step への持ち越し

---

## この Step で決まること

> **2026-09-19 に [design-decisions.md](../design-decisions.md)「10. リカバリーコードで決めたこと」へ移した。** 以下は指示書を書いた時点の一覧。

- コードは20文字・100ビット。平文を保存せず、**鍵なしの SHA-256** のハッシュだけを保存する（HMAC から変更。鍵の交換で全員の非常口が消えるため）
- コードの消費は、新しいパスキーの登録と同じトランザクションで行う（入力の時点では消費しない）
- リカバリー中は専用の短命トークン（typ で区別、10分）で、パスキーの登録しかできない
- 古いパスキーは自動で消さない
- コードは設定から作り直せる。作り直しの前の再認証はセッションの個別失効と一緒に考える

---

## 実装完了後の引き継ぎ（tester 向け）

実装はコミット `f6372db`。以下は implementer の完了レポートの要約。**シグネチャの正は実装のコード**なので、ずれていたらコードを読むこと。

### モジュール構成

| ファイル | 担当 |
|---|---|
| `src/lib/recovery-code.ts` | 純粋関数（サーバー専用）。`RECOVERY_CODE_ALPHABET`（32文字、`#` を含む）/ `RECOVERY_CODE_LENGTH = 20`。`generateRecoveryCode()`（区切り無し20文字）、`formatRecoveryCode(code)`（5文字ずつハイフン）、`normalizeRecoveryCode(input: unknown): string \| null`（空白（全角含む `\s`）と ASCII ハイフンを除き、ASCII 英小文字だけ大文字に。20文字・許可文字のみ・100文字以下の入力でなければ null）、`hashRecoveryCode(code)`（正規化後の SHA-256 16進64文字。正規化できなければ例外）、`isRecoveryCodeHash(v)`、`issueRecoveryCode(): { code, hash }` |
| `src/lib/recovery-messages.ts` | パス（`/recovery`、`/recovery/passkey`、完了後 `/`）、`RECOVERY_ERRORS`（`invalidCode` ほか）、`RECOVERY_REGENERATE_ERRORS`、`DEMO_RECOVERY_CODE_BLOCKED_MESSAGE`、`RecoveryCodeIssuedResult = { ok: true; recoveryCode } \| { ok: false; error }` |
| `src/lib/auth.ts` | `RECOVERY_JWT_TYP = "kakebo-recovery+jwt"`、`RECOVERY_TOKEN_MAX_AGE_SECONDS = 600`、`RECOVERY_COOKIE_NAME = "kakeibo_recovery"`。`createRecoveryToken(secret, { userId, codeHash }, { now? })`、`verifyRecoveryToken(token, secret, { now? })` → `{ userId: UserId, codeHash, iat, exp } \| null`（typ 一致・`maxTokenAge` 600・`codeHash` の形を要求）、`getRecoveryCookieOptions`。`/recovery`・`/recovery/passkey` を `PUBLIC_PATHS` に完全一致で |
| `src/lib/passkey.ts` | `ChallengePurpose` に `"recovery"`（sub `passkey-recovery`、Cookie `kakeibo_passkey_recovery`） |
| `src/lib/recovery-session.ts` | `setRecoveryCookie` / `getRecoverySession`（消費しない）/ `clearRecoveryCookie` |
| `src/lib/recovery-codes.ts` | `findRecoveryUserIdByCodeHash(client, hash)`（`where: { recoveryCodeHash, demoExpiresAt: null }`。形が不正なら DB を呼ばず null）、`completeRecoveryWithPasskey(client, { userId, expectedCodeHash, newCodeHash, credential })` → `{ ok: true } \| { ok: false; reason: "duplicate" \| "codeNotCurrent" }`、`regenerateRecoveryCodeHash(client, userId, newHash): Promise<boolean>`、`hasRecoveryCode(client, userId)` |
| `src/lib/users.ts` | `CreateUserWithPasskeyInput` に `recoveryCodeHash`（必須。形が不正ならトランザクション前に例外） |
| `src/lib/server-action-request.ts` | `isServerActionRerender()`（`next-action` ヘッダの有無） |
| `src/app/(auth)/recovery/actions.ts` | `verifyRecoveryCodeAction(prev, formData)`、`startRecoveryPasskeyRegistrationAction()`、`finishRecoveryPasskeyRegistrationAction(response, deviceName)` |
| `src/app/(auth)/signup/actions.ts` | `finishSignupAction` の戻り値が `RecoveryCodeIssuedResult`（**型の変更**） |
| `src/app/settings/passkeys/actions.ts` | `regenerateRecoveryCodeAction(): Promise<RecoveryCodeIssuedResult>` |
| `src/components/recovery-code-display.tsx` | `RecoveryCodeDisplay({ code, lead?, notice?, continueLabel, onContinue, copy?, canCopy? })`。コードは `[data-testid="recovery-code"]`。「控えました」のチェックまで先へ進むボタンが disabled |
| 画面 | `SignupForm`（`onSuccess` は「控えました」の後。props に `intro?` / `footer?`）、`RecoveryCodeForm({ verify })`、`RecoveryPasskeyForm(...)`、`RecoveryCodeSection({ hasCode, regenerate })`、ログイン画面のリンク |

### 処理の要点

- `verifyRecoveryCodeAction`: IP ハッシュ → `isBlocked`（制限中は失敗を記録して弾く）→ 正規化 → ハッシュ → 探索 → 成功を記録 → `setRecoveryCookie` → `redirect("/recovery/passkey")`。**失敗はすべて `RECOVERY_ERRORS.invalidCode`**（IP・DB の例外を含む）。コードは消費しない
- `finishRecoveryPasskeyRegistrationAction`: チャレンジ消費 → トークン（無ければ `sessionExpired`）→ … → `verifyRegistrationResponse` → `issueRecoveryCode` → `completeRecoveryWithPasskey`。`duplicate` はトークンを残す、`codeNotCurrent` はトークンを消して `invalidCode`。成功で `clearRecoveryCookie()` → `createSession(トークンの userId)` → `{ ok: true, recoveryCode }`
- `completeRecoveryWithPasskey` のトランザクション: **差し替え（`updateMany({ where: { id: userId, recoveryCodeHash: expectedCodeHash } })`、count が1でなければ例外）→ `createCredential(tx, ...)` の順。**
  指示書の順（資格情報 → 差し替え）から逆にした。資格情報の INSERT が User 行に共有ロックを取り、一意索引の列の UPDATE と衝突して、同じコードの同時実行でデッドロックになったため（実DBで確認）
- `/signup` と `/recovery/passkey` のページは、**Server Action の後の再描画（`next-action` ヘッダあり）のときだけ redirect しない。** Cookie を書き換えた Server Action の後の再描画で redirect すると、一度しか出さないコードが表示されずに消えるため。ヘッダは認可には使っていない

### 実装完了時点のテスト結果

`Tests 20 failed | 2906 passed (2926)`:
`data-isolation.test.ts`（新しい4つの Server Action の行が無い）、`users.test.ts` 5件（`recoveryCodeHash` が必須に）、
`signup/actions.test.ts` 2件（戻り値に `recoveryCode`）、`signup/page.test.tsx` 2件（注意書きの文言、`next/headers` のモックが要る）、
`signup-form.test.tsx` 1件（`onSuccess` は「控えました」の後）、`settings/passkeys/page.test.tsx` 9件（モックの prisma に `user` が無い）。
`npx tsc --noEmit` のエラーは `tests/` の15件のみ。
