/**
 * 利用者ID のブランド型（docs/steps/pub-1.md 設計判断 7）。
 *
 * データ層の関数はすべて `userId: UserId` を受け取る。フォームや URL から来た
 * ただの `string` を渡すとコンパイルが通らないので、付け忘れ・取り違えを型で防げる。
 *
 * **`string` を `UserId` に変えるのは `brandUserIdFromTrustedSource` だけ。**
 * `as UserId` はこのファイル以外に書かない。呼び出してよいのは次の3箇所に限る
 * （tests/ が src/ を走査して検査する）:
 *
 * | 場所 | 根拠 |
 * |---|---|
 * | src/lib/auth.ts のセッション検証 | 署名を検証した JWT の sub |
 * | src/app/(auth)/login/passkey-actions.ts の認証成功後 | 署名を検証したパスキーの持ち主（DB の Credential.userId） |
 * | src/lib/users.ts のユーザー作成 | サーバーが今作ったユーザー |
 *
 * それ以外の場所で必要になったら、呼び出しを足す前に設計を見直すこと。
 */

declare const userIdBrand: unique symbol;

export type UserId = string & { readonly [userIdBrand]: true };

/**
 * 信頼できる出所（署名検証済みの JWT、検証済みパスキーの持ち主、今作ったユーザー）の
 * 文字列を `UserId` にする。**フォーム・URL・Cookie の生の値には使わない。**
 *
 * @throws 空文字・文字列以外の場合 Error（空のユーザーIDで全件に触れる事故を防ぐ）
 */
export function brandUserIdFromTrustedSource(value: string): UserId {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("user id must be a non-empty string");
  }
  return value as UserId;
}
