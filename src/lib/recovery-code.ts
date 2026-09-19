import { createHash, randomBytes } from "node:crypto";

/**
 * リカバリーコード（パスキーを全部なくしたときの逃げ道）の生成・整形・正規化・ハッシュ。
 * すべて純粋関数（生成だけが暗号学的乱数を使う）。docs/steps/pub-5.md 設計判断 1・2。
 *
 * - コードは **20文字 × 32種類の文字 = 100ビット** の暗号学的乱数
 * - 表示は5文字ずつハイフンで区切る（`XXXXX-XXXXX-XXXXX-XXXXX`）
 * - 入力は空白とハイフンを取り除き、英字（ASCII）を大文字にしてから照合する（正規化）。
 *   それ以外の文字（許可していない文字）が残れば照合しない
 * - DB には**正規化したコードの SHA-256（16進）だけ**を保存する。鍵なし（HMAC にしない）。
 *   100ビットの乱数なのでハッシュから総当たりで戻せず、鍵を使うと鍵の交換で全員のコードが使えなくなるため
 * - **平文はどこにも保存しない。** Server Action の戻り値として画面に一度渡すだけ。ログ・DB・Cookie・URL に出さない
 *
 * サーバー専用（node:crypto を使う）。Client Component から import しない
 * （画面の文言とパスは src/lib/recovery-messages.ts）。
 */

/**
 * コードに使う32種類の文字。紛らわしい文字（0 / O / 1 / I / L）を含まない。
 *
 * 英大文字と数字から 0 / O / 1 / I / L を除くと31文字しか残らないため、
 * 32文字目に記号 `#` を使う（1文字あたり5ビット、20文字で100ビットにするため）。
 * `#` は英数字と見間違えにくく、区切りのハイフン・空白とも重ならない。
 */
export const RECOVERY_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ#";

/** コードの文字数（区切りを除く） */
export const RECOVERY_CODE_LENGTH = 20;

/** 表示で区切る文字数 */
export const RECOVERY_CODE_GROUP_SIZE = 5;

/** 表示の区切り文字 */
export const RECOVERY_CODE_SEPARATOR = "-";

/** コードのハッシュ（SHA-256 の16進・小文字）の形 */
const RECOVERY_CODE_HASH_PATTERN = /^[0-9a-f]{64}$/;

/**
 * 正規化の前に受け付ける入力の最大の長さ。これを超える入力は照合しない。
 * 区切りや空白を多少含んでも収まる長さ（巨大な入力で正規化の処理をさせないため）。
 */
const RECOVERY_CODE_INPUT_MAX_LENGTH = 100;

/** 5ビット（0〜31）を取り出すマスク。256 は 32 で割り切れるので、1バイトの下位5ビットは一様 */
const FIVE_BITS = 0b11111;

/**
 * 新しいリカバリーコードを作る（区切りなしの20文字）。呼ぶたびに違う値になる。
 *
 * 暗号学的乱数（randomBytes）の各バイトの下位5ビットで文字を選ぶ。32 = 2^5 なので偏りは無く、
 * 20文字で100ビットになる。
 */
export function generateRecoveryCode(): string {
  const bytes = randomBytes(RECOVERY_CODE_LENGTH);
  let code = "";
  for (const byte of bytes) {
    code += RECOVERY_CODE_ALPHABET[byte & FIVE_BITS];
  }
  return code;
}

/**
 * 表示用に5文字ずつハイフンで区切る（`K7Q2M-9XP4H-TR8WN-B3D6F`）。
 * 区切りの有無・小文字を問わず、正規化してから整形する。
 *
 * @throws 正規化できない（文字数・文字種が違う）場合 Error
 */
export function formatRecoveryCode(code: string): string {
  const normalized = normalizeRecoveryCode(code);
  if (normalized === null) throw new Error("invalid recovery code");
  const groups: string[] = [];
  for (let i = 0; i < normalized.length; i += RECOVERY_CODE_GROUP_SIZE) {
    groups.push(normalized.slice(i, i + RECOVERY_CODE_GROUP_SIZE));
  }
  return groups.join(RECOVERY_CODE_SEPARATOR);
}

/**
 * 入力を正規化する。照合してよい形でなければ null。
 *
 * 1. 前後と途中の空白（全角空白を含む）と ASCII のハイフンを取り除く
 * 2. ASCII の英小文字を大文字にする
 * 3. 残りが RECOVERY_CODE_LENGTH 文字で、すべて RECOVERY_CODE_ALPHABET の文字であること。
 *    それ以外の文字（0 / O / 1 / I / L、全角の英数字、その他の記号など）が残れば null
 */
export function normalizeRecoveryCode(input: unknown): string | null {
  if (typeof input !== "string") return null;
  if (input.length > RECOVERY_CODE_INPUT_MAX_LENGTH) return null;

  const normalized = input
    .replace(/[\s-]/g, "")
    .replace(/[a-z]/g, (letter) => letter.toUpperCase());

  if (normalized.length !== RECOVERY_CODE_LENGTH) return null;
  for (const char of normalized) {
    if (!RECOVERY_CODE_ALPHABET.includes(char)) return null;
  }
  return normalized;
}

/**
 * コードのハッシュ（DB に保存する値・照合に使う値）。正規化したコードの SHA-256 の16進（64文字）。
 * 区切り・小文字・空白の有無が違っても、同じコードなら同じハッシュになる。
 *
 * @throws 正規化できない場合 Error（照合してはいけない入力をハッシュしない）
 */
export function hashRecoveryCode(code: string): string {
  const normalized = normalizeRecoveryCode(code);
  if (normalized === null) throw new Error("invalid recovery code");
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}

/** コードのハッシュの形（64文字の16進・小文字）か。平文を DB に渡していないことの確認に使う */
export function isRecoveryCodeHash(value: unknown): value is string {
  return typeof value === "string" && RECOVERY_CODE_HASH_PATTERN.test(value);
}

/** 新しく発行したコード。`code` は画面に一度だけ渡し、`hash` だけを DB に保存する */
export type IssuedRecoveryCode = {
  /** 表示用に区切った平文。**保存しない・ログに出さない** */
  code: string;
  /** DB に保存するハッシュ */
  hash: string;
};

/** 新しいコードを作り、表示用の平文とハッシュを返す */
export function issueRecoveryCode(): IssuedRecoveryCode {
  const raw = generateRecoveryCode();
  return { code: formatRecoveryCode(raw), hash: hashRecoveryCode(raw) };
}
