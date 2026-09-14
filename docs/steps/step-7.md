# Step 7 — 認証の強化（パスキー + ログイン試行のレート制限）

## この Step の目的

Vercel にデプロイして**公開インターネットに出す**ための前提を作る。

Step 1 で作った認証はパスワード1本のみ。土台は堅い（後述）が、公開すると
「無制限に試行できる」という穴が残る。ここを塞ぎ、
**登録した端末からしかログインできない状態**にしてから実運用を開始する。

完了したら実運用を開始する。roadmap.md の Step 番号はこの Step の挿入に伴い繰り下げる。

---

## 現状の認証（変えてはいけない部分）

`src/lib/auth.ts` / `src/lib/session.ts` / `src/proxy.ts` / `src/app/(auth)/login/` は
Step 1 で作られ、テストで固められている。**次の性質は Step 7 の後も維持すること。**

- セッションは JWT(HS256)。`jwtVerify` に `algorithms: [SESSION_JWT_ALG]` を渡して
  `alg: none` へのダウングレードを塞いでいる（`src/lib/auth.ts:148-152`）
- Cookie は `httpOnly` / `sameSite=lax` / 本番のみ `secure` / `path=/`
- 改竄・期限切れの Cookie は削除してからログインへ戻す（`src/proxy.ts:37-40`）
- パスワード比較は早期 return しない定数時間比較（`safeEqual`）
- **ログイン失敗のメッセージは全パターンで同一**。「パスワード未設定」「文字数が違う」等を
  推測させない。`APP_PASSWORD` 未設定も通常の失敗と同じ扱い
- `proxy.ts` は既定で全パスを保護し、`isPublicPath()` に載ったものだけ通す許可リスト方式
- 純粋ロジックは `src/lib/auth.ts`、Cookie などの副作用は `src/lib/session.ts` に分ける

**既存テストを1件も壊さないこと。** 壊れたら設計が間違っている。

---

## 設計判断 1. パスキーは「2要素目」ではなく「パスワードの置き換え」

登録済みのパスキーが1本以上あれば、**パスワード単独でのログインを拒否する**。
これが「認められた端末からしかアクセスできない」の実体。

### 判定はフラグではなく DB 上の件数から導く

```ts
/**
 * パスキーを必須とするか。
 *
 * 環境変数のフラグにしない。パスキーを登録したのに切り替えを忘れると
 * 穴が空いたままになるため、件数から導いて自動的に閉まるようにする。
 */
export function shouldRequirePasskey(credentialCount: number, recoveryMode: boolean): boolean {
  if (recoveryMode) return false;
  return credentialCount > 0;
}
```

| 資格情報の件数 | `RECOVERY_MODE` | パスワード単独ログイン |
|---|---|---|
| 0 | 未設定 | **通す**（最初のパスキーを登録するために必要） |
| 1以上 | 未設定 | **拒否** |
| 0 | `1` | 通す |
| 1以上 | `1` | **通す**（緊急脱出） |

拒否のときも**メッセージは `LOGIN_ERROR_MESSAGE` と同一にする**。
「パスキーが必要です」と出すと、パスキーが登録済みであること自体が攻撃者に漏れる。

---

## 設計判断 2. 締め出し対策

パスキーを必須にすると、端末を失った瞬間にデータへ二度と触れなくなる。
**次の3つを必ず実装する。**

1. **2本目の登録を促す。** 1本目の登録直後、`/settings/passkeys` に
   「バックアップ用にもう1台登録してください」を出す。件数が1のときだけ表示する
2. **最後の1本は削除できない。** パスキー必須の状態（件数1以上かつ `RECOVERY_MODE` 未設定）で
   残り1本を削除しようとしたら拒否する
3. **break-glass。** `RECOVERY_MODE=1` のときだけパスワード単独を許す。
   Vercel の環境変数を変更できるのは Vercel アカウント保持者だけなので、
   これ自体が second factor として働く。既定は未設定＝無効

---

## 設計判断 3. チャレンジは DB でなく短命の署名付き Cookie

WebAuthn のチャレンジは**単回・短命**である必要がある。DB に置くと期限切れレコードの
掃除が要る。既存の `jose` と `src/lib/auth.ts` のパターンをそのまま使う。

- 有効期限 **2分** の JWT を `httpOnly` Cookie に入れる
- 署名鍵は `AUTH_SECRET`。ただし**セッション JWT とは `sub` を変えて取り違えを防ぐ**
  （セッションは `"owner"`、チャレンジは `"passkey-register"` / `"passkey-auth"`）
- **検証後は成否にかかわらず必ず Cookie を削除する**（単回性）

セッション用の JWT がチャレンジとして通ったり、その逆が起きたりしてはいけない。
`sub` を検証すること。

---

## 設計判断 4. レート制限は Neon にテーブル1つ

Vercel はサーバーレスでインスタンスごとにメモリが別なので、**メモリ内カウンタは効かない**。
Prisma と Neon はすでにあるので新しいインフラは足さない。

- **IP ごと: 直近15分間に失敗10回でそのIPをブロック**（11回目から弾く）
- **全体の上限は設けない。** 正規の利用者を締め出す DoS になるため。
  総当たりへの本命の防御はパスワードのエントロピーとパスキー必須化であって、これは深層防御
- ブロック中も**メッセージは `LOGIN_ERROR_MESSAGE` と同一**。「試行しすぎです」と出すと
  攻撃者に状態が漏れる
- **生IPは保存しない。** `AUTH_SECRET` で HMAC-SHA256 した値を保存する
- IP は Vercel が付ける `x-forwarded-for` の**先頭**を使う。取得できなければ固定値
  `"unknown"` を使う（全員が同じバケツに入るが、無いよりよい）

成功したログインも記録する（`succeeded = true`）。ただし**成功しても過去の失敗記録は消さない**。
消すと「9回失敗 → 1回成功 → また10回」で制限を回避できる。

---

## スキーマ（`prisma/schema.prisma` に2モデル追加）

既存モデルは**一切変更しない**。

```prisma
/// パスキー（WebAuthn）の資格情報。利用者は1人なのでユーザーへの参照は持たない。
model Credential {
  id String @id @default(cuid())

  /// 認証器が発行した資格情報ID。base64url 文字列として保存する
  credentialId String @unique
  /// 公開鍵（COSE 形式のバイト列）
  publicKey    Bytes
  /// 署名カウンタ。クローン検知に使う。0 のままの認証器もある
  counter      BigInt   @default(0)
  /// "internal" / "hybrid" など。次回の認証UIのヒントに使う
  transports   String[]
  /// 「iPhone」など利用者が付ける名前。どの端末を消すのか分かるようにする
  deviceName   String   @db.VarChar(30)

  createdAt  DateTime  @default(now())
  updatedAt  DateTime  @updatedAt
  lastUsedAt DateTime?
}

/// ログイン試行の記録。レート制限と、攻撃に気づくために残す。
model LoginAttempt {
  id String @id @default(cuid())

  /// IP を AUTH_SECRET で HMAC-SHA256 したもの。生IPは保存しない
  ipHash    String
  succeeded Boolean

  createdAt DateTime @default(now())

  @@index([ipHash, createdAt])
}
```

`updatedAt` は既存モデルの規約（schema 冒頭「全モデルに createdAt / updatedAt」）に合わせる。
`LoginAttempt` は追記のみで更新しないため `updatedAt` を持たない。**この例外を schema にコメントで書くこと。**

マイグレーションは `npx prisma migrate dev --name add_credential_and_login_attempt` で作る。
**`migrate reset` は絶対に実行しない。** 実データが入っている。

---

## 環境変数（`.env.example` に追記。値は空のまま）

```
# パスキーの RP ID。ホスト名のみでスキームもポートも含めない。
# 本番は "<project>.vercel.app"、ローカル開発は "localhost"
RP_ID=

# パスキーで許可するオリジン。スキームとポートを含める。
# 本番は "https://<project>.vercel.app"、ローカル開発は "http://localhost:3123"
RP_ORIGIN=

# 締め出しからの緊急脱出。"1" のときだけパスワード単独ログインを許す。通常は未設定
RECOVERY_MODE=
```

- **どれも `NEXT_PUBLIC_` を付けない。** サーバー側からのみ読む
- `RP_ID` / `RP_ORIGIN` 未設定時は `getAuthSecret()` と同じく **Error を投げる**。
  ただしログイン画面には漏らさない（`LOGIN_ERROR_MESSAGE` に落とす）
- `RECOVERY_MODE` は文字列 `"1"` のときだけ true。`"true"` や `"0"` は false

---

## 依存の追加

```
@simplewebauthn/server  ^13.3.2
@simplewebauthn/browser ^13.x
```

Web Crypto ベースで、Node ランタイムの Server Action から使える。
`proxy.ts`（Edge）は既存の `jose` によるセッション検証しか行わないので、ここには持ち込まない。

**API は必ず `node_modules/@simplewebauthn/server/` の型定義を読んでから使うこと。**
バージョン間で引数名が変わっている（例: `verifyAuthenticationResponse` の
`authenticator` → `credential`）。記憶で書かない。

---

## 実装するファイル

| ファイル | 役割 |
|---|---|
| `prisma/schema.prisma` | `Credential` / `LoginAttempt` を追加 |
| `src/lib/passkey.ts` | **新規・純粋ロジック中心**。RP 設定の解決、チャレンジ JWT の発行/検証、`shouldRequirePasskey()`、`isRecoveryMode()` |
| `src/lib/passkey-session.ts` | 新規・Cookie の副作用側（`src/lib/session.ts` と同じ分け方） |
| `src/lib/credentials.ts` | 新規・Prisma 層。資格情報の一覧・追加・削除・`counter` 更新・件数取得 |
| `src/lib/login-attempts.ts` | 新規・Prisma 層。`hashIp()`、失敗/成功の記録、`isBlocked()` |
| `src/app/(auth)/login/actions.ts` | **変更**。レート制限 → パスキー必須判定 → パスワード検証 の順。成否を記録 |
| `src/app/(auth)/login/passkey-actions.ts` | 新規。認証用オプションの生成と検証（Server Action） |
| `src/app/(auth)/login/login-form.tsx` | **変更**。「パスキーでログイン」を主動線にし、パスワードは折りたたむ |
| `src/app/(auth)/login/passkey-login-button.tsx` | 新規・Client。`@simplewebauthn/browser` の `startAuthentication` |
| `src/app/settings/passkeys/page.tsx` | 新規。登録済みの一覧・登録・削除 |
| `src/app/settings/passkeys/actions.ts` | 新規。登録用オプションの生成と検証、削除。**すべて要ログイン** |
| `src/app/settings/passkeys/action-state.ts` | 新規。状態の型とパス（既存 Step の慣習に合わせる） |
| `src/app/settings/passkeys/passkey-register-form.tsx` | 新規・Client。`startRegistration` + 端末名の入力 |
| `src/app/settings/passkeys/passkey-list.tsx` | 新規・Client。一覧と削除 |
| `src/app/robots.ts` | 新規。全クローラを拒否 |
| `next.config.ts` | `X-Robots-Tag: noindex, nofollow` を全パスに付ける |
| `.env.example` | 上記3キーを空値で追記 |
| `docs/roadmap.md` | Step 7 に「認証の強化」を挿入し PWA 以降を繰り下げ |

`/settings/passkeys` へのリンクを `src/app/page.tsx` の設定リンク群に足す。

---

## ログインの処理順（`loginAction`）

**この順序を守ること。** 順序が変わると情報が漏れる。

```
1. IP を取り出して HMAC する
2. isBlocked(ipHash) → true なら、パスワードを見ずに LOGIN_ERROR_MESSAGE を返す
   （失敗として記録する。ブロック中の試行も攻撃の一部）
3. 資格情報の件数を取る。shouldRequirePasskey() が true なら
   パスワードを見ずに LOGIN_ERROR_MESSAGE を返す（失敗として記録する）
4. APP_PASSWORD を読む。未設定なら LOGIN_ERROR_MESSAGE（失敗として記録）
5. verifyPassword() で判定。失敗なら記録して LOGIN_ERROR_MESSAGE
6. 成功。成功として記録し、createSession() して "/" へリダイレクト
```

パスキー認証（`passkey-actions.ts`）も同様にレート制限の対象にする。
ただし**パスキー必須の判定は掛けない**（パスキーそのものだから）。

---

## 画面

### `/login`

```
家計簿

  [ パスキーでログイン ]        ← 主動線。大きく

  ──────────────────

  パスワードでログイン ▾        ← 折りたたみ。既定は閉じる
    パスワード [        ]
    [ ログイン ]
```

- パスキーが未登録でも**この見た目は変えない**。登録の有無を画面から推測させない
- パスキー認証に失敗したときのメッセージも `LOGIN_ERROR_MESSAGE` と同一にする
- **ブラウザがパスキーに未対応のときだけ**、パスキーのボタンを無効にして
  「この端末はパスキーに対応していません」を出す。これは秘密ではないので出してよい

### `/settings/passkeys`

```
← ホーム
パスキー

登録した端末からしかログインできません。

┌────────────────────────┐
│ iPhone                 │
│ 登録 2026-08-14        │
│ 最終利用 2026-08-14    │
│              [ 削除 ]  │
└────────────────────────┘

⚠ バックアップ用にもう1台登録してください   ← 件数が1のときだけ
   この1台を失うと、ログインできなくなります。

端末の名前 [        ]
[ この端末を登録 ]
```

- 削除は既存の支出・収入と同じ**2段階確認**にする
- 必須状態で最後の1本を削除しようとしたら、拒否してその理由を出す
  （**ここは秘密ではない**。ログイン画面ではないので理由を明示してよい）

---

## 特に壊れやすい箇所（tester は必ず押さえること）

| 箇所 | 内容 |
|---|---|
| 必須化の判定 | 件数0 → 通す / 1以上 → 拒否 / `RECOVERY_MODE=1` なら件数に関わらず通す |
| 情報の漏れ | ブロック中・パスキー必須・パスワード誤り・`APP_PASSWORD` 未設定が**すべて同一メッセージ**であること |
| チャレンジの単回性 | 一度検証したチャレンジが再利用できない。期限切れ（2分超）が弾かれる |
| チャレンジの取り違え | セッション JWT をチャレンジとして渡すと弾かれる。登録用チャレンジで認証できない（`sub` の検証） |
| counter | `signCount` が保存値以下なら拒否。ただし**認証器が 0 を返し続ける場合は許容する** |
| 資格情報の削除 | 必須状態で最後の1本を消せない。`RECOVERY_MODE=1` なら消せる |
| レート制限の境界 | 10回目までは通り**11回目で弾く**。15分経過で解除される |
| 記録の保持 | **成功しても過去の失敗記録が消えない**（9回失敗→成功→また10回、で回避できないこと） |
| IP の扱い | `LoginAttempt.ipHash` に生IPが入っていない。`x-forwarded-for` が複数値なら先頭を使う。無ければ `"unknown"` |
| RP の不一致 | オリジンが `RP_ORIGIN` と違う応答を拒否する |
| 既存の退行 | ログアウト、Cookie 改竄、`proxy.ts` の保護範囲が Step 1 のまま |

---

## やらないこと

- **セッションの個別失効** — 端末紛失時は `AUTH_SECRET` を交換して全セッションを切る。専用画面は作らない
- **CSP** — 外部スクリプトを読まない単一利用者のアプリなので優先度が低い
- **パスワードのハッシュ化** — 単一利用者で環境変数から読むだけなので、ハッシュ化しても
  「環境変数が漏れたら終わり」という性質は変わらない。複雑さに見合わない
- **`LoginAttempt` の自動削除** — 件数が問題になる規模ではない。必要になったら足す

---

## 完了条件

1. `npx vitest run` — 既存 1397 件が全通過し、Step 7 分が加わる
2. `npx tsc --noEmit` / `npx next build` / `npx eslint src tests` がエラー0
3. 実データが無傷（払い出し先・カテゴリ・予算・支出・収入の件数と合計が変わっていない）

---

## tester への引き継ぎ

### 0. 先に読むこと — 既存テストが3件落ちている

`tests/app/(auth)/login/actions.test.ts` の **「loginAction 成功時」の3件**が失敗する。

```
FAIL  loginAction 成功時 > セッションを発行して '/' へリダイレクトする
FAIL  loginAction 成功時 > Cookie を発行してからリダイレクトする（順序が逆だと Cookie が載らない）
FAIL  loginAction 成功時 > 前回の状態にエラーが残っていても成功する
```

原因は仕様変更そのもの。`loginAction` は**パスワードを見る前に**
「レート制限（DB）」と「資格情報の件数（DB）」を確認する必要がある
（この文書「ログインの処理順」）。既存テストは `next/headers` と `@/lib/prisma` を
モックしていないため、ガードの段階で `DATABASE_URL is not set` になり、
**fail closed** の方針どおり `{ error: LOGIN_ERROR_MESSAGE }` が返る。
失敗系の8件は同じメッセージなので通ったままで、成功系だけが落ちる。

実装を「DB が読めなければ通す」に変えれば3件は通るが、
それは **DB を落とすだけでパスキー必須化を迂回できる**という穴になるので変えていない。
テスト側に次のモックを足してほしい（どちらか一方でよい）。

```ts
// (A) ふるまいの層でモックする（おすすめ。DBの中身を意識しなくてよい）
vi.mock("@/lib/client-ip", () => ({
  getClientIp: async () => "203.0.113.9",
  getClientIpHash: async () => "iphash",
}));
vi.mock("@/lib/credentials", () => ({ countCredentials: async () => 0 }));
vi.mock("@/lib/login-attempts", () => ({
  isBlocked: async () => false,
  recordLoginAttempt: async () => {},
}));

// (B) Prisma とヘッダをモックする（クエリ条件まで見たいとき）
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-forwarded-for": "203.0.113.9, 70.41.3.18" }),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    credential: { count: async () => 0 },
    loginAttempt: { count: async () => 0, create: async () => ({}) },
  },
}));
```

`AUTH_SECRET` は `hashIp()` が使うので、(B) では `vi.stubEnv("AUTH_SECRET", ...)` が必須。

---

### 1. 追加・変更したファイル

| ファイル | 種別 | 役割 |
|---|---|---|
| `prisma/schema.prisma` | 変更 | `Credential` / `LoginAttempt` を追加（既存モデルは無変更） |
| `prisma/migrations/20260814054515_add_credential_and_login_attempt/` | 追加 | 上記2テーブルの作成のみ |
| `src/lib/passkey.ts` | 追加 | 純粋ロジック。RP 設定、チャレンジ JWT、必須化判定、counter 判定、入力検証 |
| `src/lib/passkey-messages.ts` | 追加 | パスキー画面の文言と `DEVICE_NAME_MAX_LENGTH`。`passkey.ts` から再 export |
| `src/lib/passkey-session.ts` | 追加 | チャレンジ Cookie の副作用側（`session.ts` と同じ分け方） |
| `src/lib/credentials.ts` | 追加 | Prisma 層。一覧・件数・追加・counter 更新・削除 |
| `src/lib/login-attempts.ts` | 追加 | 純粋 + Prisma 層。`extractClientIp` / `hashIp` / 記録 / `isBlocked` |
| `src/lib/client-ip.ts` | 追加 | `next/headers` から IP を取る副作用側 |
| `src/lib/auth-messages.ts` | 追加 | `LOGIN_ERROR_MESSAGE` の実体。`auth.ts` から再 export（import 元は従来どおり `@/lib/auth` でよい） |
| `src/lib/auth.ts` | 変更 | 上記の再 export に置き換えただけ。他の関数・定数は無変更 |
| `src/app/(auth)/login/actions.ts` | 変更 | `loginAction` にレート制限とパスキー必須判定を追加。`logoutAction` は無変更 |
| `src/app/(auth)/login/passkey-actions.ts` | 追加 | パスキーでのログイン（開始・検証） |
| `src/app/(auth)/login/passkey-login-button.tsx` | 追加 | Client。主動線のボタン |
| `src/app/(auth)/login/page.tsx` | 変更 | パスキーを主動線に。パスワードは `<details>` で折りたたむ |
| `src/app/(auth)/login/login-form.tsx` | **無変更** | パスワードフォームは Step 1 のまま |
| `src/app/settings/passkeys/page.tsx` | 追加 | 一覧・バックアップ促し・登録フォーム |
| `src/app/settings/passkeys/actions.ts` | 追加 | 登録（開始・検証）と削除。すべて要ログイン |
| `src/app/settings/passkeys/action-state.ts` | 追加 | 状態の型・パス・一覧行の型 |
| `src/app/settings/passkeys/passkey-register-form.tsx` | 追加 | Client。端末名 + 登録 |
| `src/app/settings/passkeys/passkey-list.tsx` | 追加 | Client。一覧 + 2段階確認の削除 |
| `src/app/dashboard-view.tsx` | 変更 | 「パスキーの設定」リンクを1本追加（カテゴリの設定の下） |
| `src/app/robots.ts` | 追加 | 全クローラ拒否 |
| `next.config.ts` | 変更 | 全パスに `X-Robots-Tag: noindex, nofollow` |
| `.env.example` | 変更 | `RP_ID` / `RP_ORIGIN` / `RECOVERY_MODE` を空値で追記 |
| `package.json` | 変更 | `@simplewebauthn/server@13.3.2` / `@simplewebauthn/browser@13.3.0` を追加 |

---

### 2. 公開インターフェース

#### `src/lib/passkey.ts`（純粋。DB も next/headers も触らない）

```ts
const RP_NAME = "家計簿";
const PASSKEY_USER_NAME = "owner";
const REGISTER_CHALLENGE_SUBJECT = "passkey-register";
const AUTH_CHALLENGE_SUBJECT = "passkey-auth";
const CHALLENGE_MAX_AGE_SECONDS = 120;
const REGISTER_CHALLENGE_COOKIE_NAME = "kakeibo_passkey_register";
const AUTH_CHALLENGE_COOKIE_NAME = "kakeibo_passkey_auth";
const DEVICE_NAME_MAX_LENGTH = 30;          // 実体は passkey-messages.ts
const PASSKEY_ERRORS: { ... } as const;      // 同上（キーは下表）

type ChallengePurpose = "register" | "authenticate";
type PasskeyResult<T> = { ok: true; value: T } | { ok: false; error: string };
type RpConfig = { rpID: string; rpOrigin: string; rpName: string };

function getChallengeSubject(purpose: ChallengePurpose): string;
function getChallengeCookieName(purpose: ChallengePurpose): string;
function getRpConfig(env?: Record<string, string | undefined>): RpConfig;  // 未設定/形式違いは throw
function isRecoveryMode(env?: Record<string, string | undefined>): boolean; // "1" のときだけ true
function shouldRequirePasskey(credentialCount: number, recoveryMode: boolean): boolean;
function getCredentialDeleteBlockedReason(totalCount: number, recoveryMode: boolean): string | null;
function isCounterRegression(storedCounter: number, newCounter: number): boolean;
function toAuthenticatorTransports(values: readonly string[]): AuthenticatorTransportFuture[];
function validateDeviceName(input: unknown): PasskeyResult<string>;
function validateCredentialId(input: unknown): PasskeyResult<string>;

function createChallengeToken(
  challenge: string, purpose: ChallengePurpose, secret: string,
  options?: { now?: Date; maxAgeSeconds?: number },
): Promise<string>;

function verifyChallengeToken(
  token: string | undefined | null, purpose: ChallengePurpose, secret: string,
  options?: { now?: Date },
): Promise<string | null>;   // 成功時はチャレンジ文字列、失敗は null

function getChallengeCookieOptions(
  options?: { isProduction?: boolean; maxAgeSeconds?: number },
): { httpOnly: true; sameSite: "lax"; secure: boolean; path: "/"; maxAge: number };

// Server Action の戻り値の型（"use server" から export できないためここに置いてある）
type PasskeyAuthenticationOptionsResult =
  | { ok: true; options: PublicKeyCredentialRequestOptionsJSON } | { ok: false; error: string };
type PasskeyRegistrationOptionsResult =
  | { ok: true; options: PublicKeyCredentialCreationOptionsJSON } | { ok: false; error: string };
type PasskeyVerificationResult = { ok: true } | { ok: false; error: string };
```

`getRpConfig()` が throw する条件: `RP_ID` 未設定/空 / `RP_ID` に `/` か `:` を含む /
`RP_ORIGIN` 未設定/空 / `RP_ORIGIN` が `http://`・`https://` で始まらない。

`PASSKEY_ERRORS` のキー: `deviceNameRequired` `deviceNameTooLong` `idRequired` `notFound`
`challengeExpired` `verificationFailed` `duplicate` `deleteLastOne` `configMissing`。

#### `src/lib/passkey-session.ts`（`next/headers` の cookies を使う）

```ts
function setChallengeCookie(purpose: ChallengePurpose, challenge: string): Promise<void>;
function consumeChallengeCookie(purpose: ChallengePurpose): Promise<string | null>; // 取り出す前に必ず delete
function clearChallengeCookie(purpose: ChallengePurpose): Promise<void>;
```

#### `src/lib/credentials.ts`（第1引数に PrismaClient を受ける）

```ts
function listCredentials(client): Promise<Credential[]>;         // createdAt asc, id asc
function countCredentials(client): Promise<number>;
function findCredentialByCredentialId(client, credentialId: string): Promise<Credential | null>;
function createCredential(client, input: {
  credentialId: string; publicKey: Uint8Array<ArrayBuffer>; counter: number;
  transports: string[]; deviceName: string;
}): Promise<PasskeyResult<Credential>>;                          // P2002 → PASSKEY_ERRORS.duplicate
function updateCredentialCounter(client, credentialId: string, counter: number, usedAt: Date): Promise<void>;
function deleteCredential(client, id: string, recoveryMode: boolean): Promise<PasskeyResult<null>>;
```

`counter` は DB では `BigInt`。書き込みは `BigInt(n)`、読み出しは `Number(...)` で比較する。
Prisma モックを書くときは `counter: 0n` ではなく `BigInt(0)` を返すこと（tsconfig の target が ES2017 で
BigInt リテラルが使えない）。

#### `src/lib/login-attempts.ts`

```ts
const RATE_LIMIT_WINDOW_MINUTES = 15;
const RATE_LIMIT_MAX_FAILURES = 10;
const UNKNOWN_IP = "unknown";

function extractClientIp(forwardedFor: string | null | undefined): string; // 先頭を trim。無ければ "unknown"
function hashIp(ip: string, secret: string): string;                       // HMAC-SHA256 の hex。secret 空なら throw
function recordLoginAttempt(client, ipHash: string, succeeded: boolean): Promise<void>;
function getWindowStart(now: Date): Date;
function countRecentFailures(client, ipHash: string, now?: Date): Promise<number>;
function isBlocked(client, ipHash: string, now?: Date): Promise<boolean>;   // failures >= 10
```

#### `src/lib/client-ip.ts`

```ts
function getClientIp(): Promise<string>;      // headers() の x-forwarded-for
function getClientIpHash(): Promise<string>;  // 上を AUTH_SECRET で HMAC。生IPは返さない
```

#### Server Action

| 名前 | 引数 | 成功 | 失敗 |
|---|---|---|---|
| `loginAction`（`(auth)/login/actions.ts`） | `(prevState: LoginState, formData: FormData)` | `createSession()` して `redirect("/")`（＝throw） | `{ error: LOGIN_ERROR_MESSAGE }` |
| `logoutAction` | なし | `destroySession()` して `redirect("/login")` | — |
| `startPasskeyLoginAction`（`passkey-actions.ts`） | なし | `{ ok: true, options }`（Cookie にチャレンジ） | `{ ok: false, error: LOGIN_ERROR_MESSAGE }` |
| `verifyPasskeyLoginAction` | `(response: AuthenticationResponseJSON)` | `{ ok: true }`（`createSession()` 済み。リダイレクトはしない） | `{ ok: false, error: LOGIN_ERROR_MESSAGE }` |
| `startPasskeyRegistrationAction`（`settings/passkeys/actions.ts`） | なし | `{ ok: true, options }` | `{ ok: false, error: PASSKEY_ERRORS.configMissing }` |
| `finishPasskeyRegistrationAction` | `(response: RegistrationResponseJSON, deviceName: string)` | `{ ok: true }` | `{ ok: false, error }`（`deviceName*` / `challengeExpired` / `verificationFailed` / `duplicate` / `configMissing`） |
| `deletePasskeyAction` | `(prevState: PasskeyActionState, formData: FormData)` | `{ error: null }` | `{ error }`（`idRequired` / `notFound` / `deleteLastOne`） |

`/settings/passkeys` の3つはすべて先頭で `getSession()` を見て、未ログインなら
`redirect("/login")`（＝throw）する。**この redirect は try/catch の外**にある。

#### React コンポーネント

```ts
// src/app/(auth)/login/passkey-login-button.tsx
const PASSKEY_UNSUPPORTED_MESSAGE = "この端末はパスキーに対応していません。";
type PasskeyLoginButtonProps = {
  start: () => Promise<PasskeyAuthenticationOptionsResult>;
  verify: (response: AuthenticationResponseJSON) => Promise<PasskeyVerificationResult>;
  authenticate?: (optionsJSON: PublicKeyCredentialRequestOptionsJSON) => Promise<AuthenticationResponseJSON>;
  onSuccess?: () => void;          // 既定は window.location.assign("/")
  supportsWebAuthn?: () => boolean; // 既定は browserSupportsWebAuthn
};

// src/app/settings/passkeys/passkey-register-form.tsx
const PASSKEY_UNSUPPORTED_MESSAGE = "この端末はパスキーに対応していません。";
const PASSKEY_REGISTERED_MESSAGE = "登録しました。";
type PasskeyRegisterFormProps = {
  start: () => Promise<PasskeyRegistrationOptionsResult>;
  finish: (response: RegistrationResponseJSON, deviceName: string) => Promise<PasskeyVerificationResult>;
  register?: (optionsJSON: PublicKeyCredentialCreationOptionsJSON) => Promise<RegistrationResponseJSON>;
  supportsWebAuthn?: () => boolean;
};

// src/app/settings/passkeys/passkey-list.tsx
type PasskeyListProps = { items: readonly PasskeyListItem[]; deleteAction: PasskeyFormAction };

// src/app/settings/passkeys/action-state.ts
type PasskeyActionState = { error: string | null };
const initialPasskeyActionState = { error: null };
const PASSKEYS_PATH = "/settings/passkeys";
type PasskeyListItem = {
  id: string; deviceName: string;
  createdAtLabel: string;            // "2026/8/14(金)"（JST）
  lastUsedAtLabel: string | null;    // null なら「まだ使っていません」と表示
};
```

---

### 3. フォームの `name` / `id` / ラベル

| 画面 | 要素 | `id` | `name` | ラベル / 文言 |
|---|---|---|---|---|
| `/login` | パスワード入力（Step 1 のまま） | `password` | `password` | `パスワード` |
| `/login` | 送信ボタン | — | — | `ログイン` / 送信中は `確認中…` |
| `/login` | 折りたたみの見出し | — | — | `パスワードでログイン`（`<summary>`。role は付かない） |
| `/login` | パスキーのボタン | — | — | `パスキーでログイン` / 送信中は `確認中…`（`type="button"`） |
| `/login` | パスキーのエラー | `passkey-login-error` | — | `role="alert"`。文言は `LOGIN_ERROR_MESSAGE` |
| `/login` | 未対応の案内 | `passkey-unsupported` | — | `この端末はパスキーに対応していません。` |
| `/settings/passkeys` | 端末名 | `deviceName` | `deviceName` | `端末の名前`（`maxLength=30`、placeholder `iPhone`。空のまま送るとブラウザの生体認証を出す前に `PASSKEY_ERRORS.deviceNameRequired` を出す） |
| `/settings/passkeys` | 登録ボタン | — | — | `この端末を登録` / 実行中は `登録中…` |
| `/settings/passkeys` | 削除（1段目） | — | — | `削除する` |
| `/settings/passkeys` | 削除（2段目） | — | `id`（hidden） | `削除する` / 実行中は `削除中…` ・ `やめる` |
| `/settings/passkeys` | 一覧の各行 | — | — | `登録 {日付}` / `最終利用 {日付 or まだ使っていません}` |
| `/settings/passkeys` | 1本だけのときの警告 | — | — | `⚠ バックアップ用にもう1台登録してください。` |

`/login` の見た目は**パスキーの登録有無で変わらない**（DB を読まずに描画している）。

---

### 4. WebAuthn の応答をどうモックするか

**方針: 本物の署名は作らない。`@simplewebauthn/*` を境界としてモックする。**
暗号処理そのものはライブラリ側のテストの領分で、この Step で守りたいのは
「順序」「単回性」「必須化」「レート制限」というアプリ側の判断だから。

#### 4-1. Server Action のテスト（`@simplewebauthn/server` をモック）

```ts
const verifyAuthentication = vi.fn(async () => ({
  verified: true,
  authenticationInfo: {
    credentialID: "cred-1",
    newCounter: 3,
    userVerified: true,
    credentialDeviceType: "multiDevice" as const,
    credentialBackedUp: true,
    origin: "http://localhost:3123",
    rpID: "localhost",
  },
}));

vi.mock("@simplewebauthn/server", () => ({
  generateAuthenticationOptions: async () => ({
    challenge: "CHALLENGE", timeout: 60_000, rpId: "localhost", userVerification: "required",
  }),
  generateRegistrationOptions: async () => ({
    challenge: "CHALLENGE", rp: { name: "家計簿", id: "localhost" },
    user: { id: "dXNlcg", name: "owner", displayName: "" }, pubKeyCredParams: [],
  }),
  verifyAuthenticationResponse: (opts: unknown) => verifyAuthentication(opts),
  verifyRegistrationResponse: async () => ({
    verified: true,
    registrationInfo: {
      fmt: "none",
      aaguid: "00000000-0000-0000-0000-000000000000",
      credential: { id: "cred-1", publicKey: new Uint8Array([1, 2, 3]), counter: 0 },
      credentialType: "public-key",
      attestationObject: new Uint8Array(),
      userVerified: true,
      credentialDeviceType: "multiDevice",
      credentialBackedUp: true,
      origin: "http://localhost:3123",
      rpID: "localhost",
    },
  }),
}));
```

`response` 引数（`AuthenticationResponseJSON` / `RegistrationResponseJSON`）は
**モックした検証関数には中身を見られないので、形だけ整った固定値でよい**。
実装が実際に読むのは次の2つだけ:

- `response.id` … `findCredentialByCredentialId()` の引数（認証時）
- `response.response.transports` … 保存する transports（登録時。無ければ `[]`）

```ts
const authResponse = {
  id: "cred-1", rawId: "cred-1", type: "public-key" as const,
  clientExtensionResults: {},
  response: { clientDataJSON: "e30", authenticatorData: "e30", signature: "e30" },
};
const regResponse = {
  id: "cred-1", rawId: "cred-1", type: "public-key" as const,
  clientExtensionResults: {},
  response: { clientDataJSON: "e30", attestationObject: "e30", transports: ["internal", "hybrid"] },
};
```

`expectedOrigin` / `expectedRPID` に何を渡したかは
`verifyAuthentication.mock.calls[0][0]` で確認できる（RP 不一致の検証はこの引数で見る。
`RP_ORIGIN` を変えると渡る値が変わること、が実装側の責任範囲）。
**「オリジンが違う応答を拒否する」ものそのものは `verifyAuthenticationResponse` の
throw で表現される**ので、`verifyAuthentication.mockRejectedValue(new Error("origin"))` で
「throw されたら `LOGIN_ERROR_MESSAGE` を返し、失敗として記録する」ことを確かめてほしい。

#### 4-2. Cookie とヘッダ

```ts
const cookieStore = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      cookieStore.has(name) ? { name, value: cookieStore.get(name) } : undefined,
    set: (name: string, value: string) => { cookieStore.set(name, value); },
    delete: (name: string) => { cookieStore.delete(name); },
  }),
  headers: async () => new Headers({ "x-forwarded-for": "203.0.113.9" }),
}));
```

チャレンジ Cookie の値は `createChallengeToken("CHALLENGE", "authenticate", secret)` で
本物を作れる（jose はモック不要）。`AUTH_SECRET` を `vi.stubEnv` で固定すること。

#### 4-3. Client Component のテスト（`@simplewebauthn/browser` はモック不要）

`PasskeyLoginButton` / `PasskeyRegisterForm` は
`authenticate` / `register` / `supportsWebAuthn` / `onSuccess` を props で差し替えられる。
`vi.mock("@simplewebauthn/browser")` を書かずに、スタブ関数を渡すのが楽。

- `supportsWebAuthn={() => false}` … ボタンが `disabled` になり未対応メッセージが出る
- `authenticate={() => Promise.reject(new Error("NotAllowedError"))}` … 利用者の取り消し。
  `role="alert"` に `LOGIN_ERROR_MESSAGE` が出る
- `onSuccess` を渡さないと既定で `window.location.assign("/")` を呼ぶ（jsdom が
  "Not implemented: navigation" を出す）ので、成功系では必ず渡すこと

---

### 5. 失敗パスの再現方法

| 状況 | 再現 | 期待 |
|---|---|---|
| レート制限に掛かっている | `loginAttempt.count` が `10` を返す（= `isBlocked` true） | パスワードを**見ずに** `LOGIN_ERROR_MESSAGE`。`loginAttempt.create({ succeeded: false })` が呼ばれる |
| 境界（10回目は通る） | `count` が `9` → 通常どおりパスワード判定へ。`10` → 弾く | `RATE_LIMIT_MAX_FAILURES = 10` |
| 15分で解除 | `countRecentFailures` に渡る `where.createdAt.gte` が `now - 15分` であること | `getWindowStart(now)` と一致 |
| 成功しても失敗記録が消えない | 成功時に `deleteMany` / `delete` が**呼ばれない**こと | 実装は `create` しかしない |
| パスキー必須で弾かれる | `credential.count` が `1` 以上 + `RECOVERY_MODE` 未設定 | パスワードが正しくても `LOGIN_ERROR_MESSAGE`、失敗として記録 |
| 緊急脱出 | 上に加えて `vi.stubEnv("RECOVERY_MODE", "1")` | パスワードが正しければ成功 |
| `RECOVERY_MODE` の値 | `"true"` / `"0"` / `""` / 未設定 | すべて false（`"1"` のみ true） |
| チャレンジ期限切れ | `createChallengeToken(c, p, secret, { now: new Date(t) })` を作り、`verifyChallengeToken(..., { now: new Date(t + 121_000) })` | `null` |
| チャレンジの単回性 | `consumeChallengeCookie()` を2回呼ぶ | 2回目は `null`（1回目で delete 済み） |
| チャレンジの取り違え | セッション JWT（`createSessionToken`）を `verifyChallengeToken(..., "authenticate", ...)` に渡す / 登録用トークンを認証用として検証 | どちらも `null`（`sub` 違い） |
| 別鍵で署名 | `AUTH_SECRET` を変えて検証 | `null` |
| counter 巻き戻り | 保存 `counter = 5`、`verifyAuthenticationResponse` のモックが `newCounter: 3` | `LOGIN_ERROR_MESSAGE`。`credential.update` は呼ばれない |
| counter が常に 0 | 保存 `0`、`newCounter: 0` | 通る（`isCounterRegression(0, 0) === false`） |
| 最後の1本を削除 | `credential.count` が `1`、`RECOVERY_MODE` 未設定 | `{ error: PASSKEY_ERRORS.deleteLastOne }`。`delete` は呼ばれない |
| 最後の1本を削除（脱出中） | 同上 + `RECOVERY_MODE=1` | 削除できる |
| RP 未設定 | `RP_ID` / `RP_ORIGIN` を空にする | ログイン側は `LOGIN_ERROR_MESSAGE`、設定画面側は `PASSKEY_ERRORS.configMissing` |
| IP が複数値 | `x-forwarded-for: "203.0.113.9, 70.41.3.18"` | `extractClientIp` は `"203.0.113.9"` |
| IP が取れない | ヘッダ無し | `"unknown"`。`hashIp` に渡るのは生IPで、DB に入るのはハッシュだけ |
| 未ログインで設定画面の Action を叩く | `getSession` が `null` | `redirect("/login")` が throw される |

---

### 6. 判断した点（この文書に書かれていなかったこと）

1. **ガードが DB / ヘッダの取得に失敗したら通さない（fail closed）。**
   通すと DB を落とすだけでパスキー必須化を迂回できるため。既存テスト3件が落ちるのはこれが理由。
2. **認証は `userVerification: "required"`、登録は `residentKey: "required"`。**
   パスキー1本でログインできる以上、端末側の生体認証/PIN を必ず挟む。
   `residentKey: "required"` により discoverable credential になるので、
   **ログイン画面で `allowCredentials` を返さない**（未認証の相手に資格情報IDを晒さない）。
3. `startPasskeyLoginAction`（オプション生成だけ）は**失敗として記録しない**。
   認証の試行は `verifyPasskeyLoginAction` の1回だけを数える（1回のログインが2件にならないように）。
4. 成功後の遷移は Client 側の `window.location.assign("/")`。
   Server Action 内の `redirect()` にしなかったのは、Cookie の反映を確実にするためと、
   ボタンの成功パスをテストしやすくするため。
5. 文言の実体を `auth-messages.ts` / `passkey-messages.ts` に切り出し、
   `auth.ts` / `passkey.ts` から再 export した（Client Component に jose を持ち込まないため）。
   **既存の import 元 `@/lib/auth` は変えていない。**
6. `src/lib/client-ip.ts` を追加（この文書のファイル一覧には無い）。
   `login-attempts.ts` を純粋 + Prisma のみに保ち、`next/headers` 依存を1ファイルに閉じるため。
7. ログイン画面のパスワード欄は `<details>` で折りたたんだ。DOM には常に存在するので、
   JavaScript 無効でも開けるし、既存の `login-form.test.tsx` / `page.test.tsx` も壊れない。
