# 公開版 Step 1 — データ分離

[design-decisions.md](../design-decisions.md)「4. データ分離」の実装。公開版の最初の Step。

> **番号について。** 単一ユーザー版の Step 1〜7（`step-N.md`）と区別するため、公開版の指示書は `pub-N.md` とする。
> [roadmap.md](../roadmap.md) の Step 8（PWA）以降は単一ユーザー版の計画であり、この番号とは関係ない。

**完了条件**: 全データ操作が `userId` で絞られ、利用者Aのセッションから利用者Bのデータを閲覧・編集・削除できない /
分離テストが全 Server Action を網羅し、`userId` の絞り込みを外すと落ちる / 実DB（ローカルDocker）での分離の検証スクリプトが通る

**複数ユーザー化の本丸。** 単一ユーザー版は `deleteExpense(prisma, id)` のように ID だけで行を操作しているため、
そのまま複数ユーザーにすると他人の支出IDを推測するだけで閲覧・編集・削除できる（IDOR）。
この Step の漏れは、後から機能を足しても塞がらない。

---

## 前提

- 単一ユーザー版のコードをコピーした直後の状態（コミット `e72aea1`）。テスト1612件が全件成功
- **ローカルの Docker（PostgreSQL）が起動しており、`.env` が開発用の値で設定済みであること（利用者が準備する）。**
  未準備なら、マイグレーションの作成・適用と「実DBでの検証」の手前で止まってレポートする
- **単一ユーザー版の `.env` と接続先を使わない。** 接続先のホストが `localhost` / `127.0.0.1` 以外なら何もせず止まる
- `prisma migrate` でエンジンのインストールスクリプトの承認が要る場合は、承認せず止まって報告する（CLAUDE.md「踏みやすい罠」）
- 作業ブランチを切る（例: `feat/data-isolation`）

---

## この Step の範囲

design-decisions.md の「残りの設計項目」のうち、**データ分離と切り離せないものだけ**をこの Step に含める。

| 含める | 含めない（後の Step） |
|---|---|
| `User` モデル（最小限）と全テーブルへの `userId` | サインアップ画面、リカバリーコード |
| `UserId` ブランド型、セッション JWT の `sub` をユーザーIDに | デモアカウント、期限切れの自動削除 |
| 全データ層・全 Server Action・全ページの `userId` 化 | セッションの個別失効、有効期間の見直し |
| ユニーク制約・採番・既定の払い出し先をユーザー単位に | 鍵の用途別分離（`AUTH_SECRET` は兼用のまま） |
| `Credential` の持ち主、「最後の1本は消せない」をユーザー単位に | アカウント単位のレート制限、登録件数の上限 |
| **パスワードログイン（`APP_PASSWORD`）と `RECOVERY_MODE` の廃止** | パスキーの WebAuthn ユーザーID（`PASSKEY_USER_NAME`）のランダム化 |
| 初期データ投入をユーザー単位に（`upsert` のキーを `(userId, name)`） | セキュリティヘッダー、CSP |
| Next.js のキャッシュでユーザー間の画面が混ざらないことの確認 | ログから家計データを除く対応 |

---

## 設計判断（先に決めておくこと）

### 1. パスワードログインと `RECOVERY_MODE` はこの Step で廃止する

**セッションの `sub` をユーザーIDにすると、パスワードログインは「誰としてログインさせるか」を決められない。**
`APP_PASSWORD` は全体で1本なので、特定のユーザーに対応づけるには固定のユーザーIDを環境変数などに持たせるしかなく、
それは設計方針 2 の「ユーザーIDを外部から受け取らない」に反する仮の穴になる。設計方針 3 で廃止が決まっているため、ここで消す。

帰結として、**この Step の完了時点ではブラウザからログインする手段がパスキーしかなく、パスキーを登録する手段（サインアップ）もまだ無い。**
したがってこの Step では**画面での実機確認は行わない**。代わりに次の2つで分離を保証する。

- 単体テスト（分離テストと変異テスト）
- 実DB（ローカルDocker）での検証スクリプト（設計判断 9）

画面での確認は、サインアップを作る Step に持ち越す。

**開発用のログイン口（ユーザーIDを指定してセッションを発行する経路）は作らない。** 「開発時だけ有効」の分岐は、
設定の取り違え1つで本番に残る裏口になる。

削除するもの:

- `loginAction`（`src/app/(auth)/login/actions.ts`。`logoutAction` は残す）、パスワードのフォームと state
- `getAppPassword` / `verifyPassword` / `safeEqual`（他で使っていなければ）
- `isRecoveryMode` / `shouldRequirePasskey`、`countCredentials`（使い道が無くなれば）
- `.env.example` の `APP_PASSWORD` / `RECOVERY_MODE`
- ログイン画面のパスワード欄。パスキーのボタンだけを残す

### 2. `User` モデルは最小限にする

```prisma
model User {
  id        String   @id @default(cuid())
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  // 各モデルへの逆参照
}
```

表示名・メールアドレス・デモかどうか・有効期限は**持たせない**。必要になる Step で足す（設計方針 3「メールアドレスを持たない」）。

### 3. `userId` を持たせるテーブル

| モデル | `userId` | 理由 |
|---|---|---|
| `PaymentSource` / `Category` / `Expense` / `Budget` / `CategoryBudget` / `Income` | **持たせる（必須）** | 家計データ |
| `Credential` | **持たせる（必須）** | パスキーの持ち主 |
| `LoginAttempt` | **持たせない** | ログイン前（誰か分からない時点）の IP 単位の記録。アカウント単位の制限は後の Step |

`Budget` / `CategoryBudget` は払い出し先・カテゴリ経由で持ち主が決まるが、**それでも `userId` を直接持たせる。**
「全クエリの `where` に `userId` がある」という単純な規則にしておくと、テストで機械的に検査でき、例外を覚えなくて済む。

`User` を消したら全データを消す（`onDelete: Cascade`）。デモユーザーの自動削除（設計方針 2）がこの前提に乗る。

### 4. 関連の持ち主はDBの複合外部キーで強制する

**この Step で最も効く防御。** `Expense.categoryId` に他人のカテゴリIDを入れられない、をアプリの確認だけに頼らずDBで保証する。

```prisma
model Category {
  // ...
  userId String
  user   User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([id, userId])      // 複合外部キーの参照先
  @@unique([userId, name])
}

model Expense {
  // ...
  userId String
  user   User @relation(fields: [userId], references: [id], onDelete: Cascade)

  categoryId String
  category   Category @relation(fields: [categoryId, userId], references: [id, userId], onDelete: Restrict)
}
```

こうすると「Aの `userId` で Bのカテゴリを参照する行」は外部キー違反でDBが拒否する。
同じ形を `Expense → PaymentSource`、`Budget → PaymentSource`、`CategoryBudget → Category` にも適用する。

**それでもアプリ側で持ち主を確認する**（設計判断 6）。DBの拒否は Prisma のエラーコードでしか返らず、
カテゴリと払い出し先のどちらが悪いか区別できないため。アプリ側の確認は画面の文言のため、複合外部キーは保証のため、と役割を分ける。

> **確認すること。** `userId` が自分自身の外部キー（`User` への参照）と複合外部キーの両方に使われる形を、
> Prisma 7 が受け付けるか・生成される SQL が意図どおりかを `prisma migrate dev --create-only` の SQL で確認する。
> 受け付けない場合は、実装せずレポートに書いて止まる。

> **`onDelete: Restrict` とカスケードの衝突に注意。** `User` を削除すると `Category` と `Expense` が同時にカスケード削除されるが、
> PostgreSQL の `ON DELETE RESTRICT` は即時に検査されるため、削除順によっては「支出が参照しているカテゴリ」の削除で失敗しうる
> （`NO ACTION` は文の終わりに検査するので通る）。**実DBの検証スクリプトで「支出のあるユーザーを削除できる」ことを確かめ、**
> 失敗するなら `Restrict` を `NoAction` に変える。アプリからのカテゴリ単体の削除が拒否される挙動（P2003 / P2039）は変わらないこと。

### 5. ユニーク制約・採番・既定をユーザー単位にする

| 対象 | 単一ユーザー版 | 公開版 |
|---|---|---|
| `PaymentSource.name` | `@unique` | `@@unique([userId, name])` |
| `Category.name` | `@unique` | `@@unique([userId, name])` |
| 既定の払い出し先 | `@@unique([isDefault], where: { isDefault: true })` | **ユーザーごとに最大1件**（`userId` を含む部分ユニーク） |
| `Budget` | `@@unique([paymentSourceId, yearMonth])` | 変えない（払い出し先が持ち主を決める）。ただし操作の `where` には `userId` を足す |
| `CategoryBudget` | `@@unique([categoryId, yearMonth])` | 同上 |
| `Credential.credentialId` | `@unique` | **変えない**。認証器が発行するIDは全体で一意で、ログイン時は持ち主が分からない状態で引くため |
| `sortOrder` の採番 | `aggregate({ _max })` が全体の最大値 | `where: { userId }` を付ける |
| インデックス | `[date]` など | 先頭に `userId` を足す（`[userId, date]` など）。全クエリが `userId` で絞るため |

**`setDefaultPaymentSource` の `updateMany({ where: { isDefault: true } })` に `userId` を付け忘れると、全ユーザーの既定が外れる。**
部分ユニークが全体のままだと、2人目のユーザーが既定を持てずプリセット投入が失敗する。どちらも1文字の漏れで起きる。

### 6. データ層の規則

**全データ操作関数のシグネチャを `(client, userId: UserId, ...)` にする**（設計方針 4）。

| 操作 | 書き方 | 禁止 |
|---|---|---|
| 1件取得 | `findFirst({ where: { id, userId } })` など、条件に `userId` を含める | `findUnique({ where: { id } })` のあとで `row.userId === userId` を比べる |
| 更新・削除 | `update` / `delete` の `where: { id, userId }`。一致しなければ P2025 → `notFound` | 取得してから持ち主を比べて更新する |
| 一覧・件数・集計 | `where` に必ず `userId` | `userId` 無しの `findMany` / `count` / `aggregate` |
| 作成 | `data.userId` は**引数の `userId` から設定する** | フォームの入力オブジェクトを `data` にスプレッドする（入力に `userId` が紛れ込む余地を作らない） |
| トランザクション内の複数更新 | 並べ替え・連番の振り直し・既定の切り替えの**各** `update` / `updateMany` に `userId` | 先頭だけ絞って残りを ID で更新する |
| 関連先を受け取る操作 | `categoryId` / `paymentSourceId` が自分のものか `where: { id, userId }` で確認し、なければ既存の `categoryNotFound` / `paymentSourceNotFound` を返す | 確認を省いてDBの外部キー違反だけに任せる |

**`userId` を更新しない。** どの `update` の `data` にも `userId` を入れない（持ち主の付け替えを作らない）。

`update({ where: { id, userId } })` は Prisma の拡張ユニーク条件で書ける想定。**生成された `*WhereUniqueInput` の型を読んで確認すること。**
書けなければ `@@unique([id, userId])` の複合キー（`id_userId`）を使う。

**例外（`userId` を取らない関数）はこれだけ。** 追加したくなったら実装せず、理由をレポートに書く。

| 関数 | 理由 |
|---|---|
| `findCredentialByCredentialId` | ログインの時点では持ち主が分からない。認証器が返した資格情報IDで引くことが認証そのもの |
| `updateCredentialCounter` | 上の検証が通った直後に、同じ資格情報IDで更新する |
| `login-attempts.ts` の関数 | ログイン前の IP 単位の記録（設計判断 3） |
| ユーザーを作る関数（設計判断 8） | `userId` を生み出す側 |

### 7. `UserId` はブランド型にし、作れる場所を3箇所に限る

```ts
// src/lib/user-id.ts
declare const userIdBrand: unique symbol;
export type UserId = string & { readonly [userIdBrand]: true };
```

フォームから来た `string` を渡すとコンパイルが通らない。ただし `as UserId` はどこでも書けてしまうので、
**`string` を `UserId` に変える箇所を1つの関数に集め、その呼び出し元を次の3箇所に限る。**

| 呼び出してよい場所 | 根拠 |
|---|---|
| `src/lib/auth.ts` のセッション検証 | 署名を検証した JWT の `sub` |
| `src/app/(auth)/login/passkey-actions.ts` の認証成功後 | 署名を検証したパスキーの持ち主（DBの `Credential.userId`） |
| ユーザーを作る関数（設計判断 8） | サーバーが今作ったユーザー |

**この制限はテストで検査する**（tester が `src/` を走査し、変換関数の呼び出しと `as UserId` の出現箇所が上の許可リストに収まることを確認する）。
関数名は検索で見つけやすく、呼ぶ側が意味を自覚できる名前にすること（例: `brandUserIdFromTrustedSource`）。

### 8. セッションとユーザーの作成

**セッション**

- `createSessionToken(secret, userId: UserId, options)`。JWT の `sub` にユーザーIDを入れる。`SESSION_SUBJECT = "owner"` は削除する
- `verifySessionToken` は `{ userId: UserId; iat; exp } | null` を返す。`sub` が文字列でない・空文字なら `null`
- `createSession(userId: UserId)`
- **`requireUserId(): Promise<UserId>`** を `src/lib/session.ts` に置く。セッションが無ければ `redirect(LOGIN_PATH)`。
  各ファイルにある `requireSession()` はこれに置き換える
- セッションのユーザーがDBに存在するかは**この Step では照合しない**（毎リクエストのクエリが増える。個別失効の Step で世代番号と一緒に扱う）。
  消えたユーザーのセッションは、一覧が空になり、作成は外部キー違反で失敗する（データは漏れない）

**チャレンジ JWT との取り違え。** 単一ユーザー版はセッションの `sub`（`"owner"`）とチャレンジの `sub`（`"passkey-register"` など）を
別の値にして取り違えを防いでいた。`sub` がユーザーIDになると、この区別が「cuid が偶然 `passkey-register` と一致しない」ことに依存する。
**セッション JWT を用途で区別できる別の手段（例: `typ` ヘッダや専用クレーム）を足し、検証で必須にする。** 方法は実装者が決めてレポートに書く。

**ユーザーの作成** — `src/lib/users.ts`

- `createUserWithPresets(client): Promise<UserId>` — `User` を作り、同じトランザクションでプリセット（カテゴリ11件・払い出し先「現金」[既定]）を投入する
- この Step で呼ぶのは検証スクリプトだけ。サインアップ・デモ作成の Step でそのまま使う（設計方針 2「サインアップ時の初期データ投入と同じ処理を流用」）

**初期データ** — `src/lib/seed.ts`

- `seedDatabase(client)` を `seedUserPresets(client, userId: UserId)` にし、`upsert` のキーを `(userId, name)` にする。冪等性は保つ
- 全体に対して投入する対象が無くなるので、**CLI の入口（`prisma/seed.ts` と `prisma.config.ts` の `migrations.seed`）は削除する**

### 9. 実DBでの検証スクリプト

**単体テストはモックなので、複合外部キー・部分ユニーク・カスケードが PostgreSQL 上で効くことは保証できない**
（`tests/prisma/schema.test.ts` の冒頭コメントのとおり）。この Step はそこが防御の要なので、実DBで確かめるスクリプトを置く。

- 置き場所: `prisma/checks/data-isolation.ts`（`npx tsx` で実行）
- **接続先のホストが `localhost` / `127.0.0.1` 以外なら、何もせず終了コード1で終わる。** 接続文字列そのものは出力しない
- 自分で作ったユーザーA・Bのデータだけを使い、**成否にかかわらず `finally` で両ユーザーを削除する**（カスケードで全データが消えることも同時に検証する）
- 出力は検査項目ごとの OK / NG だけ。金額やIDなどを出さない

検査項目（最低限）:

1. A・B とも `createUserWithPresets` でき、同名のカテゴリ・払い出し先を持てる（ユニーク制約がユーザー単位）
2. A・B それぞれが既定の払い出し先を1件ずつ持てる。A に既定を2件作ろうとすると拒否される
3. A の `userId` で B のカテゴリ / 払い出し先を参照する支出・予算を、**アプリの確認を通さず Prisma で直接**作ろうとすると外部キー違反で拒否される
4. データ層の関数を A の `userId` で、B の各ID（支出・収入・カテゴリ・払い出し先・パスキー）に対して呼ぶと、取得は `null`、更新・削除は `notFound` になり、**B の行が変わっていない**
5. A の `setDefaultPaymentSource` が B の既定を外さない
6. 支出・予算があるユーザーを削除でき、そのユーザーの全行が消え、もう一方のデータは残る（設計判断 4 の `Restrict` の注意）

### 10. Next.js のキャッシュ

ユーザーごとに内容が変わる画面が静的生成・キャッシュされると、**Aの画面がBに表示される。** 分離をどれだけ正しく書いても、ここで漏れる。

- 全ページが `requireUserId()`（＝ `cookies()`）を呼ぶので動的レンダリングになるはず。**`next build` の出力で、データを出す全ルートが Dynamic（`ƒ`）であることを確認し、一覧をレポートに貼る**
- `"use cache"` / `unstable_cache` / `fetch` のキャッシュを使っていないことを確認する（2026-09-15 時点の grep では使用箇所なし）
- `revalidatePath` はパス単位でユーザーを区別しないが、動的レンダリングならキャッシュを持たないので問題ない。この理解が Next.js 16 の文書と合っているかを `node_modules/next/dist/docs/` で確認し、根拠の文書名をレポートに書く

### 11. 他人のIDには「存在しない」と同じ応答を返す

- データ層: 他人のID → 既存の `notFound` と**同じ文言**。「権限がありません」の類の文言を新設しない
- ページ（`/expenses/[id]`、`/settings/categories/[id]`、`/settings/payment-sources/[id]`）: 存在しないIDと同じく `notFound()`
- `deleteBudget` は対象が無くても成功を返す仕様（二重送信対策）。**他人の払い出し先IDでも同じく成功を返し、何も消さない**。これで応答から存在は漏れない

---

## 実装内容

### 1. スキーマとマイグレーション

- 設計判断 2〜5 のとおり `prisma/schema.prisma` を変更する。冒頭の共通規約コメントに「全データモデルに `userId`（`LoginAttempt` を除く）」を足す
- **既存のマイグレーションは書き換えず、新しいマイグレーションを追加する**（`prisma migrate dev --create-only` → SQL を読んで確認 → 適用）
- 既存の行があると `NOT NULL` の列を足せない。**ローカルDBに行があって適用に失敗したら、`prisma migrate reset` をせずに止まってレポートする**（reset は利用者の同意が要る）

### 2. データ層（`src/lib/`）

設計判断 6 の規則で、次の関数をすべて `(client, userId, ...)` にする。

| ファイル | 関数 |
|---|---|
| `payment-sources.ts` | `listPaymentSources` `getPaymentSource` `getPaymentSourceDetail` `createPaymentSource` `updatePaymentSource` `setDefaultPaymentSource` `setPaymentSourceActive` `movePaymentSource` `deletePaymentSource` |
| `categories.ts` | `listCategories` `listVisibleCategories` `getCategory` `getCategoryDetail` `createCategory` `updateCategory` `setCategoryHidden` `moveCategory` `deleteCategory` |
| `expenses.ts` | `listExpenses` `getExpense` `createExpense` `updateExpense` `deleteExpense` `listQuickPickCategoryIds` `listRecentStoreNames` |
| `budgets.ts` | `listBudgets` `listCategoryBudgets` `getMonthlyBudgetData` `saveBudgets` `saveCategoryBudgets` `deleteBudget` |
| `incomes.ts` | `listIncomes` `createIncome` `deleteIncome` |
| `dashboard-data.ts` | `getDashboardData`（7本のクエリ**すべて**） |
| `credentials.ts` | `listCredentials` `createCredential` `deleteCredential`（設計判断 6 の例外2つは除く） |
| `seed.ts` / `users.ts` | 設計判断 8 |

見落としやすい箇所:

- `listRecentStoreNames` / `listQuickPickCategoryIds` — 漏れると**他人の店名がサジェストに出る**
- `getPaymentSourceDetail` / `getCategoryDetail` / `deletePaymentSource` / `deleteCategory` の `expense.count` / `budget.count`
- `saveBudgets` / `saveCategoryBudgets` の `upsert` — `where` に `userId` を足し、`create` に `userId` を入れる。
  `where` に `userId` が無いと、**他人の払い出し先IDを渡したときに他人の予算を上書きする**
- `deleteCredential` — 対象の取得・件数・削除の3つすべて。件数は**そのユーザーの**パスキーの数で「最後の1本」を判定する
  （`getCredentialDeleteBlockedReason(totalCount)`。`recoveryMode` 引数は削除）。Serializable のトランザクションは維持する

### 3. Server Action（`src/app/**/actions.ts`、`passkey-actions.ts`）

- 全アクションの先頭で `const userId = await requireUserId()`。データ層へは必ずこの値を渡す
- `saveBudgetsAction` / `saveCategoryBudgetsAction` は、**自分の**払い出し先・カテゴリの一覧から入力欄名を組み立てる（今の作りを維持。他人のIDの入力欄は読まれない）
- `startPasskeyRegistrationAction` の `excludeCredentials` は**自分の**パスキーだけにする。全件を並べると他人の資格情報IDがブラウザに渡る
- `finishPasskeyRegistrationAction` は `createCredential(prisma, userId, ...)`
- `verifyPasskeyLoginAction` は検証成功後に `createSession(持ち主のUserId)`

### 4. ページ（Server Component）

`@/lib/prisma` を import している全ページ（`src/app/page.tsx`、`expenses/`、`incomes/`、`budgets/`、`settings/**`）で、
**proxy のガードとは別に** `requireUserId()` を呼び、データ層へ渡す。proxy はセッションの有無しか見ず、ユーザーIDを渡せないため。

### 5. 検証スクリプト

設計判断 9。

---

## 制約

- **テストは書かない。** `tests/` と `vitest.config.ts` には触らない。`docs/` と `.claude/` にも書き込まない
- TypeScript strict、`any` 禁止。`npx tsc --noEmit` と `npm run lint` が通ること
- **既存のテストは大半が落ちる**（シグネチャが変わるため）。落ちること自体は実装の失敗ではない。
  ただし `npx vitest run` の結果（`FAIL` の行を含む。件数だけにしない）をレポートに貼り、
  **シグネチャ変更では説明できない失敗**があれば分けて書く
- 検証スクリプトで作ったユーザーは必ず削除する。**ローカルDBに残った行が無いことを件数で確認してレポートに書く**
- `next dev` / `next build` を起動したら停止してからレポートする
- 秘密の値（`AUTH_SECRET`、接続文字列）を出力しない
- 設計判断に反する必要が出たら、実装せずレポートに書いて止まる

---

## tester 向けの方針

### テストの規模

シグネチャの変更で既存テストの大半が書き換えになる。**1回の呼び出しで終わらない場合は、次の順で分けてよい。**

1. 既存テストの移行（`userId` の追加）と、廃止した機能（パスワードログイン・`RECOVERY_MODE`）のテストの削除
2. 分離テストの追加

**削除したテストは、ファイル名・ケース数・削除の根拠（この文書の設計判断 1）をレポートに列挙する。**
件数が1612件から減るので、減った理由が全部説明できること。

### 分離テスト（この Step の中心）

design-decisions.md「分離テスト」のとおり、**利用者A・Bを用意し、全 Server Action について、Aのセッションで Bの支出・収入・予算・カテゴリ・払い出し先・パスキーを閲覧／編集／削除できないことを表形式で漏れなく検証する。**

満たすべき性質（実装方法は tester が決める）:

- **表の行が全 Server Action を網羅していることを、テスト自身が検査する。** 各 `actions.ts` の export を列挙し、表に無いアクションがあれば落ちるようにする（アクションを足したときに分離テストの追加漏れを検出するため）
- 各行で、A のセッションから B のIDを指定したとき、**B のデータが返らない・変わらない**こと、応答が**存在しないIDを指定したときと同じ**であること
- **データ層の関数から `userId` の絞り込みを1箇所外したら落ちること。** 「`where` に `userId` が含まれるか」だけを見るモックでもよいが、
  可能なら A・B のデータを持ち `where` の条件を実際に解釈する小さな偽の Prisma クライアントを `tests/` に作るほうが、「B の行が返ってしまう」ことを直接検出できる
- データ層の単体テストでは、**全クエリ（トランザクション内の各更新を含む）**の `where` に正しい `userId` があり、作成の `data.userId` が引数の値であることを確認する。
  入力オブジェクトに `userId` を紛れ込ませても、引数の `userId` が使われること

### その他の観点

壊れると被害が大きい順。

1. **`UserId` を作れる場所の許可リスト**（設計判断 7）— `src/` の走査で、変換関数の呼び出しと `as UserId` が許可リストの3ファイルにしか無いこと
2. **ページ** — `[id]` の3ページで他人のIDが `notFound()` になること。全データページが `requireUserId()` の値をデータ層へ渡すこと
3. **セッション** — `sub` がユーザーIDになり、検証で `userId` として返ること。空の `sub`、改竄、期限切れで `null`。**チャレンジ JWT をセッションとして渡したら `null`**（設計判断 8）
4. **パスキー** — 登録時の `excludeCredentials` が自分の分だけ。ログイン成功時に**その資格情報の持ち主**のセッションが発行されること。削除の「最後の1本」がユーザー単位（A が1本・B が2本のとき、A は消せず B は消せる）
5. **`setDefaultPaymentSource`** — `updateMany` に `userId` があること
6. **予算の保存** — 他人の払い出し先・カテゴリの入力欄を送っても無視されること、`upsert` の `where` / `create` に `userId`
7. **支出の登録・更新** — 他人の `categoryId` / `paymentSourceId` を拒否し、それぞれの `notFound` 文言を返すこと
8. **`listRecentStoreNames` / `listQuickPickCategoryIds` / `getDashboardData`** の全クエリ
9. **スキーマ**（`tests/prisma/schema.test.ts`）— 全データモデルに `userId`、`LoginAttempt` には無い、`name` のユニークが `(userId, name)`、既定の部分ユニークに `userId`、複合外部キー、`User` への Cascade
10. **廃止の確認** — `loginAction` / `APP_PASSWORD` / `RECOVERY_MODE` への参照が `src/` に残っていないこと

### テストの方針

公開版でも**単体テストから実データベースに接続しない。** 実DBでの確認は設計判断 9 の検証スクリプトの担当。

---

## 変異テスト（必須）

CLAUDE.md のとおり、**`userId` の絞り込みを外して落ちることを必ず確認する。** 1つずつ入れ、`git diff` で変異が入ったことを確認してから流し、戻す。
結果は「変異 / 落ちたテスト名 / 件数」の表で残す。

| # | 変異 | 期待 |
|---|---|---|
| 1 | `deleteExpense` の `where` から `userId` を外す | 落ちる |
| 2 | `getExpense` の `where` から `userId` を外す | 落ちる（データ層と `/expenses/[id]` の両方） |
| 3 | `setDefaultPaymentSource` の `updateMany` から `userId` を外す | 落ちる |
| 4 | `listRecentStoreNames` から `userId` を外す | 落ちる |
| 5 | `getDashboardData` の7本のうち1本（例: `categoryBudget`）から `userId` を外す | 落ちる |
| 6 | `saveBudgets` の `upsert` の `where` から `userId` を外す | 落ちる |
| 7 | `createExpense` の関連先の持ち主確認を削る | 落ちる |
| 8 | `deleteCredential` の件数から `userId` を外す | 落ちる |
| 9 | `startPasskeyRegistrationAction` で全ユーザーのパスキーを `excludeCredentials` に並べる | 落ちる |
| 10 | どれか1つの Server Action で、データ層に固定の別ユーザーIDを渡す | 落ちる |
| 11 | 分離テストの表から Server Action を1行消す | 網羅の検査で落ちる |
| 12 | `movePaymentSource` のトランザクション内の `update` から `userId` を外す | 落ちる |

---

## 実装完了後の引き継ぎ（tester 向け）

implementer の実装が完了した時点（コミット `5f12290`、2026-09-19）の事実を記録する。
**期待値の根拠は上の仕様であって、この節ではない。** シグネチャは実ファイルを読んで確認すること。

### モジュール構成

| ファイル | 役割 |
|---|---|
| `src/lib/user-id.ts` | `UserId` 型と `brandUserIdFromTrustedSource(value)`（空文字・非文字列で throw）。`as UserId` はこのファイルの中だけ |
| `src/lib/users.ts` | `createUserWithPresets(client): Promise<UserId>`。User 作成とプリセット投入を1トランザクション |
| `src/lib/seed.ts` | `seedUserPresets(client: Prisma.TransactionClient, userId)`。`upsert` のキーは `userId_name`。`seedDatabase` は削除 |
| `src/lib/session.ts` | `createSession(userId)`、`requireUserId()`（無ければ `redirect(LOGIN_PATH)`） |
| `src/lib/auth.ts` | `createSessionToken(secret, userId, options?)`、`verifySessionToken` は `{ userId, iat, exp } \| null` |
| `prisma/checks/data-isolation.ts` | 実DBの検証スクリプト（**単体テストの対象外**。実DBに接続するため） |

データ層の関数は、設計判断 6 の例外を除き、すべて第2引数が `userId: UserId`（以降の引数は元の順序のまま）。

### 仕様から補足・判断した点

- **セッション JWT とチャレンジ JWT の区別（設計判断 8）** — セッション JWT は `typ` ヘッダに `SESSION_JWT_TYP = "kakebo-session+jwt"` を付け、検証で一致を必須にしている。チャレンジ JWT には `typ` を付けない
- **`LOGIN_ERROR_MESSAGE` の文言を変更した**（`src/lib/auth-messages.ts`）。新しい文言は「ログインできませんでした。もう一度お試しください。」。パスワード欄が無くなったため。**この文言を採用する**（利用者の指示を受けて tester に依頼した時点の扱い）。テストに旧文言を直書きしている箇所は定数の参照に直すこと
- **1件取得は `findFirst({ where: { id, userId } })`**。`findUnique` が残るのは `findCredentialByCredentialId` だけ
- **`saveBudgets` / `saveCategoryBudgets` の持ち主確認** — 金額を保存する入力の id を `findMany({ where: { id: { in }, userId } })` で確かめ、1件でも自分のものでなければ**何も保存せず** `paymentSourceNotFound` / `categoryNotFound` を返す。null（未設定）の削除は `deleteMany` を `userId` で絞るだけなので、他人のIDでも成功扱いで何も消えない。`upsert` の `where` は `{ paymentSourceId_yearMonth: {...}, userId }`
- **`createExpense` / `updateExpense`** — 入力検証のあと、カテゴリ → 払い出し先の順に持ち主を確認してから書き込む
- **`getCredentialDeleteBlockedReason(totalCount)`** — `recoveryMode` 引数を削除
- **削除した export** — `safeEqual` `verifyPassword` `getAppPassword` `isRecoveryMode` `shouldRequirePasskey` `countCredentials` `loginAction` `LoginForm` `LoginState` `SESSION_SUBJECT` `seedDatabase`。削除したファイルは `login-form.tsx` `login-state.ts` `prisma/seed.ts`
- **複合外部キーは `onDelete: Restrict` のまま**。支出のあるユーザーを削除できることは実DBで確認済み

### 実装完了時点のテスト結果

`Tests 380 failed | 1181 passed (1561)`、`Test Files 26 failed | 51 passed (77)`。1612件から減っているのは、削除したモジュールを import する3ファイルが読み込みの段階で落ちているため
（`tests/app/(auth)/login/actions.test.ts`、`actions-rate-limit.test.ts`、`login-form.test.tsx`）。

原因の内訳（implementer の申告。**tester は自分で確かめること**）:

- `userId` の引数追加による呼び出しのずれ、`findUnique` → `findFirst`
- `@/lib/session` のモックに `requireUserId` が無い（Server Action とページのテスト）
- 廃止した機能のテスト（パスワードログイン、`RECOVERY_MODE`、`seedDatabase`）
- スキーマの制約が仕様どおり変わった（`tests/prisma/schema.test.ts`）
- パスキーのログインで、フィクスチャの資格情報に `userId` が無いため `brandUserIdFromTrustedSource` が throw する
- `LOGIN_ERROR_MESSAGE` の旧文言を直書きしている（`passkey-actions.test.ts` の11件）

### 許可リストの検査について

`as UserId` は定義ファイル `src/lib/user-id.ts` の中にしかない。走査のテストでは、**定義ファイルを別扱いにして、`as UserId` の出現はこのファイルだけ、`brandUserIdFromTrustedSource(` の呼び出しは許可リストの3ファイルだけ**、とするのが素直。

---

## 完了レポートに含めるもの

1. 作成・変更・削除したファイル一覧
2. **公開インターフェース** — 変更後の全データ層関数・Server Action のシグネチャ、`UserId` の変換関数の名前と呼び出し箇所、セッション JWT の用途区別の方法
3. 設計判断 6 の例外以外に `userId` を取らない関数が残っていないことを、どう確かめたか
4. 生成されたマイグレーション SQL の要点（複合外部キー、部分ユニーク、`Restrict` / `NoAction` の結論）
5. 検証スクリプトの実行結果（OK / NG の一覧）と、**後片付け（作ったユーザーを削除し、残った行が0件であること）**
6. `next build` のルート一覧（Dynamic であること）と、キャッシュについて参照した Next.js の文書
7. `npx tsc --noEmit` / `npm run lint` / `npx vitest run`（`FAIL` の行を含む）の結果
8. 判断した点、未解決の懸念、後の Step への持ち越し

---

## この Step で決まること（完了後に design-decisions.md へ移す）

- `User` は最小限、`onDelete: Cascade`
- `LoginAttempt` だけは `userId` を持たない
- 関連の持ち主は複合外部キーで強制する
- パスワードログインと `RECOVERY_MODE` はデータ分離と同時に廃止
- `UserId` を作れる場所は3箇所
- セッションのユーザーの存在確認は個別失効の Step まで持ち越す
