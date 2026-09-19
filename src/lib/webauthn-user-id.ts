import { createHash, randomBytes } from "node:crypto";

/**
 * WebAuthn のユーザーID（user handle）と、パスキーの選択画面に出す表示名
 * （docs/steps/pub-2.md 設計判断 3）。
 *
 * - user handle は**ユーザーごとの32バイトの暗号学的乱数**を base64url にした文字列。
 *   `User.webauthnUserId` に保存し、サインアップ時も設定画面での追加登録時も同じ値を使う
 *   （毎回変わると、認証器からは別アカウントに見える）
 * - 内部の `User.id`（cuid）は user handle に使わない。認証器（同期されるパスキーを含む）へ
 *   内部IDを渡さないため
 * - **`webauthnUserId` を作る関数は `generateWebauthnUserId` の1つだけ。**
 *   サインアップ・デモアカウント・検証スクリプトのどれもこれを呼ぶ
 *
 * サーバー専用（node:crypto を使う）。Client Component から import しない。
 */

/** user handle のバイト数。WebAuthn の上限は64バイト */
export const WEBAUTHN_USER_ID_BYTES = 32;

/** 32バイトを base64url（パディング無し）にした長さ */
export const WEBAUTHN_USER_ID_LENGTH = 43;

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

/** 表示名の接頭辞。RP 名と同じく秘密ではない */
export const PASSKEY_DISPLAY_NAME_PREFIX = "家計簿";

/**
 * 表示名の識別子に使う文字。紛らわしい文字（0/O、1/I/L）を除いた英大文字と数字。
 * 小文字は使わない（大文字と見分けにくい端末フォントがあるため）。
 */
export const PASSKEY_DISPLAY_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

/** 表示名の識別子の文字数 */
export const PASSKEY_DISPLAY_CODE_LENGTH = 4;

/**
 * 新しい webauthnUserId を作る。呼ぶたびに違う値になる。
 *
 * @returns 32バイトの暗号学的乱数の base64url（パディング無し、43文字）
 */
export function generateWebauthnUserId(): string {
  return randomBytes(WEBAUTHN_USER_ID_BYTES).toString("base64url");
}

/**
 * webauthnUserId として妥当な形か（base64url・43文字・32バイトに戻る）。
 * 署名付き Cookie から取り出した値や、ユーザーを作る直前の値の検査に使う。
 */
export function isValidWebauthnUserId(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length !== WEBAUTHN_USER_ID_LENGTH) return false;
  if (!BASE64URL_PATTERN.test(value)) return false;
  return Buffer.from(value, "base64url").length === WEBAUTHN_USER_ID_BYTES;
}

/**
 * `generateRegistrationOptions` の `userID` に渡すバイト列に戻す。
 * 登録オプションの `user.id` は、このバイト列を base64url にしたもの（＝元の文字列）になる。
 *
 * @throws 形式が不正なら Error
 */
export function webauthnUserIdToBytes(webauthnUserId: string): Uint8Array<ArrayBuffer> {
  if (!isValidWebauthnUserId(webauthnUserId)) {
    throw new Error("invalid webauthnUserId");
  }
  const decoded = Buffer.from(webauthnUserId, "base64url");
  const bytes = new Uint8Array(new ArrayBuffer(decoded.length));
  bytes.set(decoded);
  return bytes;
}

/**
 * パスキーの選択画面に出す表示名（`userName` / `userDisplayName` の両方に使う）。
 *
 * 例: `家計簿 #K7Q2`。webauthnUserId の SHA-256 から、紛らわしい文字を除いた4文字を作る。
 * **決定的**（同じ webauthnUserId なら常に同じ表示名）なので、サインアップ時と
 * 設定画面での追加登録時で同じになる。利用者の入力（名前・メールアドレス）は使わない。
 *
 * 4文字は約92万通りで、一意ではない（衝突しうる）。同じ端末に複数のアカウントがあるときに
 * 見分けるためのもので、識別子としては使わない。
 */
export function getPasskeyDisplayName(webauthnUserId: string): string {
  const digest = createHash("sha256").update(webauthnUserId).digest();
  const alphabet = PASSKEY_DISPLAY_CODE_ALPHABET;
  let code = "";
  for (let i = 0; i < PASSKEY_DISPLAY_CODE_LENGTH; i += 1) {
    const byte = digest[i] ?? 0;
    code += alphabet[byte % alphabet.length];
  }
  return `${PASSKEY_DISPLAY_NAME_PREFIX} #${code}`;
}

/**
 * ログイン応答の userHandle が、資格情報の持ち主の webauthnUserId と一致するか
 * （docs/steps/pub-2.md 設計判断 4）。
 *
 * ログイン画面は allowCredentials を渡さない（discoverable credential）ので、認証器は
 * userHandle を必ず返す。**無ければ不一致として扱う。**
 * base64url のパディング（`=`）の有無の違いだけは吸収する。
 */
export function userHandleMatches(
  userHandle: string | null | undefined,
  webauthnUserId: string,
): boolean {
  if (typeof userHandle !== "string" || userHandle.length === 0) return false;
  if (webauthnUserId.length === 0) return false;
  return stripPadding(userHandle) === stripPadding(webauthnUserId);
}

function stripPadding(value: string): string {
  return value.replace(/=+$/, "");
}
