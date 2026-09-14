import { SignJWT, jwtVerify } from "jose";

import { SESSION_JWT_ALG } from "@/lib/auth";
import { DEVICE_NAME_MAX_LENGTH, PASSKEY_ERRORS } from "@/lib/passkey-messages";

import type {
  AuthenticatorTransportFuture,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/server";

/**
 * パスキー（WebAuthn）まわりの純粋ロジック。
 *
 * src/lib/auth.ts と同じ方針で、Next.js 固有の API（next/headers）も Prisma も
 * ここには持ち込まない。Cookie の副作用は src/lib/passkey-session.ts、
 * DB は src/lib/credentials.ts の担当。
 *
 * 設計の出典は docs/steps/step-7.md。要点:
 * - パスキーは「2要素目」ではなく「パスワードの置き換え」。資格情報が1件でもあれば
 *   パスワード単独ログインを拒否する（フラグではなく件数から導く）
 * - チャレンジは DB に置かず、有効期限2分の署名付き Cookie（JWT）にする。
 *   セッション JWT との取り違えを防ぐため sub を別にする
 */

/** RP の表示名。ブラウザの登録ダイアログに出る。秘密ではないので定数でよい */
export const RP_NAME = "家計簿";

/** WebAuthn の利用者名。利用者は1人なので固定値 */
export const PASSKEY_USER_NAME = "owner";

/** チャレンジ JWT の sub。セッション JWT（"owner"）と必ず別の値にする */
export const REGISTER_CHALLENGE_SUBJECT = "passkey-register";
export const AUTH_CHALLENGE_SUBJECT = "passkey-auth";

/** チャレンジの有効期間（秒）。単回・短命であること自体が防御になる */
export const CHALLENGE_MAX_AGE_SECONDS = 120;

/** チャレンジを格納する Cookie 名。登録用と認証用を混ぜない */
export const REGISTER_CHALLENGE_COOKIE_NAME = "kakeibo_passkey_register";
export const AUTH_CHALLENGE_COOKIE_NAME = "kakeibo_passkey_auth";

/**
 * 端末名の最大文字数と画面文言の実体は src/lib/passkey-messages.ts にある
 * （Client Component から jose 依存のこのファイルを読ませないため）。
 * import 元はここのままでよい。
 */
export { DEVICE_NAME_MAX_LENGTH, PASSKEY_ERRORS } from "@/lib/passkey-messages";

/** チャレンジの用途 */
export type ChallengePurpose = "register" | "authenticate";

export type EnvSource = Record<string, string | undefined>;

export type PasskeyResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** チャレンジ用途に対応する JWT の sub */
export function getChallengeSubject(purpose: ChallengePurpose): string {
  return purpose === "register" ? REGISTER_CHALLENGE_SUBJECT : AUTH_CHALLENGE_SUBJECT;
}

/** チャレンジ用途に対応する Cookie 名 */
export function getChallengeCookieName(purpose: ChallengePurpose): string {
  return purpose === "register"
    ? REGISTER_CHALLENGE_COOKIE_NAME
    : AUTH_CHALLENGE_COOKIE_NAME;
}

export type RpConfig = {
  /** ホスト名のみ。スキームもポートも含めない */
  rpID: string;
  /** スキームとポートを含むオリジン */
  rpOrigin: string;
  /** ブラウザのダイアログに出す表示名 */
  rpName: string;
};

/**
 * RP_ID / RP_ORIGIN を読む。未設定・形式違いなら Error を投げる。
 *
 * getAuthSecret() と同じく「設定漏れは起動時ではなく使用時に落とす」方針。
 * ログイン画面へは漏らさず LOGIN_ERROR_MESSAGE に落とすこと。
 */
export function getRpConfig(env: EnvSource = process.env): RpConfig {
  const rpID = env.RP_ID;
  if (typeof rpID !== "string" || rpID.length === 0) {
    throw new Error("RP_ID is not set");
  }
  if (rpID.includes("/") || rpID.includes(":")) {
    // "https://example.com" や "localhost:3123" を入れる取り違えが多いので弾く
    throw new Error("RP_ID must be a bare hostname");
  }

  const rpOrigin = env.RP_ORIGIN;
  if (typeof rpOrigin !== "string" || rpOrigin.length === 0) {
    throw new Error("RP_ORIGIN is not set");
  }
  if (!rpOrigin.startsWith("http://") && !rpOrigin.startsWith("https://")) {
    throw new Error("RP_ORIGIN must include the scheme");
  }

  return { rpID, rpOrigin, rpName: RP_NAME };
}

/**
 * 締め出しからの緊急脱出モードか。
 *
 * 文字列 "1" のときだけ true。"true" や "0" は false
 * （曖昧な値で意図せず穴が開かないようにする）。
 */
export function isRecoveryMode(env: EnvSource = process.env): boolean {
  return env.RECOVERY_MODE === "1";
}

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

/**
 * 資格情報を削除してよいか。削除できないときは理由の文言を返す。
 *
 * パスキー必須の状態で最後の1本を消すと、二度とログインできなくなる。
 * RECOVERY_MODE=1 のときはパスワードで入れるので消せる。
 *
 * @param totalCount 削除する前の総件数
 */
export function getCredentialDeleteBlockedReason(
  totalCount: number,
  recoveryMode: boolean,
): string | null {
  if (recoveryMode) return null;
  if (totalCount <= 1) return PASSKEY_ERRORS.deleteLastOne;
  return null;
}

/**
 * 署名カウンタが巻き戻っていないか。true なら拒否すべき（クローンの疑い）。
 *
 * 認証器によってはカウンタを実装せず常に 0 を返す。
 * その場合（保存値も新しい値も 0）は正常として扱う。
 */
export function isCounterRegression(storedCounter: number, newCounter: number): boolean {
  if (storedCounter === 0 && newCounter === 0) return false;
  return newCounter <= storedCounter;
}

/** WebAuthn の transports として妥当な値 */
const AUTHENTICATOR_TRANSPORTS: readonly AuthenticatorTransportFuture[] = [
  "ble",
  "cable",
  "hybrid",
  "internal",
  "nfc",
  "smart-card",
  "usb",
];

/**
 * DB に String[] で保存した transports を WebAuthn の型に戻す。
 * 未知の値は落とす（将来ブラウザが増やしても壊れないようにするため）。
 */
export function toAuthenticatorTransports(
  values: readonly string[],
): AuthenticatorTransportFuture[] {
  return values.filter((value): value is AuthenticatorTransportFuture =>
    (AUTHENTICATOR_TRANSPORTS as readonly string[]).includes(value),
  );
}

/**
 * 端末の名前を検証する。前後の空白は trim する。
 * 文字数はコードポイント単位で数える（絵文字を2文字と数えない）。
 */
export function validateDeviceName(input: unknown): PasskeyResult<string> {
  if (typeof input !== "string") {
    return { ok: false, error: PASSKEY_ERRORS.deviceNameRequired };
  }

  const name = input.trim();
  const length = Array.from(name).length;

  if (length === 0) return { ok: false, error: PASSKEY_ERRORS.deviceNameRequired };
  if (length > DEVICE_NAME_MAX_LENGTH) {
    return { ok: false, error: PASSKEY_ERRORS.deviceNameTooLong };
  }

  return { ok: true, value: name };
}

/** 対象レコードの id。空文字・文字列以外は拒否する */
export function validateCredentialId(input: unknown): PasskeyResult<string> {
  if (typeof input !== "string" || input.trim().length === 0) {
    return { ok: false, error: PASSKEY_ERRORS.idRequired };
  }
  return { ok: true, value: input };
}

function toKey(secret: string): Uint8Array {
  if (secret.length === 0) {
    throw new Error("AUTH_SECRET is not set");
  }
  return new TextEncoder().encode(secret);
}

export type CreateChallengeTokenOptions = {
  /** 発行時刻。テストから固定できるように差し替え可能 */
  now?: Date;
  /** 有効期間（秒）。既定は CHALLENGE_MAX_AGE_SECONDS */
  maxAgeSeconds?: number;
};

/**
 * チャレンジを署名付きトークンに包む。
 *
 * セッション JWT と同じ鍵・同じアルゴリズムだが sub が異なるため、
 * 片方をもう片方として使うことはできない。
 *
 * @throws secret が空文字の場合 Error("AUTH_SECRET is not set")
 */
export async function createChallengeToken(
  challenge: string,
  purpose: ChallengePurpose,
  secret: string,
  options: CreateChallengeTokenOptions = {},
): Promise<string> {
  const key = toKey(secret);
  const issuedAt = Math.floor((options.now?.getTime() ?? Date.now()) / 1000);
  const maxAge = options.maxAgeSeconds ?? CHALLENGE_MAX_AGE_SECONDS;

  return new SignJWT({ challenge })
    .setProtectedHeader({ alg: SESSION_JWT_ALG })
    .setSubject(getChallengeSubject(purpose))
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + maxAge)
    .sign(key);
}

export type VerifyChallengeTokenOptions = {
  /** 検証時刻。テストから固定できるように差し替え可能 */
  now?: Date;
};

/**
 * チャレンジトークンを検証し、中のチャレンジ文字列を返す。失敗時は null。
 *
 * null になるのは次の場合:
 * - token が undefined / null / 空文字
 * - 署名が不正
 * - 有効期限切れ（2分）
 * - alg が HS256 以外
 * - sub が用途と一致しない（セッション JWT や別用途のチャレンジを渡した）
 * - challenge クレームが文字列でない
 *
 * @throws secret が空文字の場合のみ Error("AUTH_SECRET is not set")
 */
export async function verifyChallengeToken(
  token: string | undefined | null,
  purpose: ChallengePurpose,
  secret: string,
  options: VerifyChallengeTokenOptions = {},
): Promise<string | null> {
  const key = toKey(secret);
  if (typeof token !== "string" || token.length === 0) return null;

  try {
    const { payload } = await jwtVerify(token, key, {
      algorithms: [SESSION_JWT_ALG],
      subject: getChallengeSubject(purpose),
      currentDate: options.now,
    });

    const challenge = payload.challenge;
    if (typeof challenge !== "string" || challenge.length === 0) return null;
    return challenge;
  } catch {
    return null;
  }
}

export type ChallengeCookieOptions = {
  httpOnly: true;
  sameSite: "lax";
  secure: boolean;
  path: "/";
  maxAge: number;
};

export type BuildChallengeCookieOptions = {
  /** 本番かどうか。既定は process.env.NODE_ENV === "production" */
  isProduction?: boolean;
  /** Cookie の有効期間（秒）。既定は CHALLENGE_MAX_AGE_SECONDS */
  maxAgeSeconds?: number;
};

/** チャレンジ Cookie の属性。セッション Cookie と同じ考え方で secure は本番のみ */
export function getChallengeCookieOptions(
  options: BuildChallengeCookieOptions = {},
): ChallengeCookieOptions {
  const isProduction = options.isProduction ?? process.env.NODE_ENV === "production";
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: isProduction,
    path: "/",
    maxAge: options.maxAgeSeconds ?? CHALLENGE_MAX_AGE_SECONDS,
  };
}

/**
 * Server Action の戻り値の型。
 *
 * "use server" のファイルは async 関数しか export できないため型はここに置く。
 * Client Component からは `import type` で読む（実行時の依存は増えない）。
 */
export type PasskeyAuthenticationOptionsResult =
  | { ok: true; options: PublicKeyCredentialRequestOptionsJSON }
  | { ok: false; error: string };

export type PasskeyRegistrationOptionsResult =
  | { ok: true; options: PublicKeyCredentialCreationOptionsJSON }
  | { ok: false; error: string };

/** 検証結果。成功時に画面へ返す情報は無い */
export type PasskeyVerificationResult = { ok: true } | { ok: false; error: string };
