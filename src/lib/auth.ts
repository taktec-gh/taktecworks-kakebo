import { SignJWT, jwtVerify } from "jose";

import { RECOVERY_PASSKEY_PATH, RECOVERY_PATH } from "@/lib/recovery-messages";
import { SIGNUP_PATH } from "@/lib/signup-messages";
import { brandUserIdFromTrustedSource, type UserId } from "@/lib/user-id";

/**
 * 認証まわりの純粋ロジック。
 *
 * ここには Next.js 固有の API（next/headers, next/server）を持ち込まない。
 * Cookie の読み書きなど副作用は src/lib/session.ts 側に置く。
 */

/** セッション JWT を格納する Cookie 名 */
export const SESSION_COOKIE_NAME = "kakeibo_session";

/** セッションの有効期間（秒）。既定 30 日 */
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

/** JWT の署名アルゴリズム */
export const SESSION_JWT_ALG = "HS256";

/**
 * セッション JWT の typ ヘッダ。**検証で必須にする。**
 *
 * sub がユーザーID（cuid）になったため、sub の値だけではチャレンジ JWT
 * （sub = "passkey-register" など。同じ鍵・同じアルゴリズムで署名される）と
 * 区別できない。用途の区別を「cuid が偶然一致しない」ことに頼らないよう、
 * セッション JWT にだけこの typ を付け、検証で一致を要求する
 * （docs/steps/pub-1.md 設計判断 8）。
 */
export const SESSION_JWT_TYP = "kakebo-session+jwt";

/**
 * ログイン失敗時に画面へ出すメッセージ。
 * 「パスワードが未設定」「文字数が違う」等を推測させない単一の文言にする。
 *
 * 実体は src/lib/auth-messages.ts にある（Client Component から
 * jose 依存のこのファイルを読ませないため）。import 元はここのままでよい。
 */
export { LOGIN_ERROR_MESSAGE } from "@/lib/auth-messages";

export type SessionPayload = {
  /** ログイン中の利用者。署名を検証した JWT の sub */
  userId: UserId;
  /** 発行時刻（UNIX 秒） */
  iat: number;
  /** 失効時刻（UNIX 秒） */
  exp: number;
};

export type EnvSource = Record<string, string | undefined>;

/** AUTH_SECRET を読む。未設定・空文字なら Error を投げる */
export function getAuthSecret(env: EnvSource = process.env): string {
  const value = env.AUTH_SECRET;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("AUTH_SECRET is not set");
  }
  return value;
}

function toKey(secret: string): Uint8Array {
  if (secret.length === 0) {
    throw new Error("AUTH_SECRET is not set");
  }
  return new TextEncoder().encode(secret);
}

export type CreateSessionTokenOptions = {
  /** 発行時刻。テストから固定できるように差し替え可能。既定は現在時刻 */
  now?: Date;
  /** 有効期間（秒）。既定は SESSION_MAX_AGE_SECONDS */
  maxAgeSeconds?: number;
};

/**
 * セッション JWT を発行する。sub にユーザーID、ヘッダの typ に SESSION_JWT_TYP を入れる。
 *
 * @throws secret が空文字の場合 Error("AUTH_SECRET is not set")
 * @throws userId が空文字の場合 Error（誰でもないセッションを発行しない）
 */
export async function createSessionToken(
  secret: string,
  userId: UserId,
  options: CreateSessionTokenOptions = {},
): Promise<string> {
  const key = toKey(secret);
  if (typeof userId !== "string" || userId.length === 0) {
    throw new Error("user id must be a non-empty string");
  }
  const issuedAt = Math.floor((options.now?.getTime() ?? Date.now()) / 1000);
  const maxAge = options.maxAgeSeconds ?? SESSION_MAX_AGE_SECONDS;

  return new SignJWT({})
    .setProtectedHeader({ alg: SESSION_JWT_ALG, typ: SESSION_JWT_TYP })
    .setSubject(userId)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + maxAge)
    .sign(key);
}

export type VerifySessionTokenOptions = {
  /** 検証時刻。テストから固定できるように差し替え可能。既定は現在時刻 */
  now?: Date;
};

/**
 * セッション JWT を検証する。
 *
 * 検証に失敗した場合は例外ではなく null を返す（呼び出し側の分岐を単純にするため）。
 * null になるのは次の場合:
 * - token が undefined / null / 空文字
 * - 署名が不正（Cookie 改竄・別の鍵で署名）
 * - 有効期限切れ
 * - alg が HS256 以外（alg: none などのダウングレード攻撃）
 * - typ ヘッダが SESSION_JWT_TYP でない（チャレンジ JWT をセッションとして渡した等）
 * - sub が文字列でない・空文字
 * - iat / exp が数値でない
 *
 * @throws secret が空文字の場合のみ Error("AUTH_SECRET is not set")
 */
export async function verifySessionToken(
  token: string | undefined | null,
  secret: string,
  options: VerifySessionTokenOptions = {},
): Promise<SessionPayload | null> {
  const key = toKey(secret);
  if (typeof token !== "string" || token.length === 0) return null;

  try {
    const { payload } = await jwtVerify(token, key, {
      algorithms: [SESSION_JWT_ALG],
      typ: SESSION_JWT_TYP,
      currentDate: options.now,
    });

    if (
      typeof payload.sub !== "string" ||
      payload.sub.length === 0 ||
      typeof payload.iat !== "number" ||
      typeof payload.exp !== "number"
    ) {
      return null;
    }

    // 署名・typ・期限を検証済みの sub なので、ここで UserId にしてよい（設計判断 7 の許可リスト）
    return {
      userId: brandUserIdFromTrustedSource(payload.sub),
      iat: payload.iat,
      exp: payload.exp,
    };
  } catch {
    return null;
  }
}

/**
 * リカバリー用トークン（docs/steps/pub-5.md 設計判断 5）。
 *
 * リカバリーコードを照合した直後から、新しいパスキーの登録が済むまでの間だけ使う。
 * **通常のセッションとは別物で、家計データには触れられない。** できるのはパスキーの登録だけ。
 *
 * - typ ヘッダを RECOVERY_JWT_TYP にする。セッション（SESSION_JWT_TYP）・チャレンジ（typ 無し）と区別し、
 *   検証でそれぞれ一致を要求する。**verifySessionToken はこのトークンを受け付けない**（typ が違う）ので、
 *   proxy・requireUserId()・全データ画面ではログイン扱いにならない
 * - sub はユーザーID、`codeHash` クレームは照合したコードのハッシュ（登録の完了時の差し替えの条件に使う）
 * - 有効期限は10分。Cookie は RECOVERY_COOKIE_NAME（セッションと別の名前）
 */
export const RECOVERY_JWT_TYP = "kakebo-recovery+jwt";

/** リカバリー用トークンの有効期間（秒）。10分 */
export const RECOVERY_TOKEN_MAX_AGE_SECONDS = 60 * 10;

/** リカバリー用トークンを格納する Cookie 名。セッションの Cookie とは別 */
export const RECOVERY_COOKIE_NAME = "kakeibo_recovery";

/** SHA-256 の16進（リカバリーコードのハッシュ）の形 */
const RECOVERY_CODE_HASH_PATTERN = /^[0-9a-f]{64}$/;

export type RecoveryTokenPayload = {
  /** リカバリー中の利用者。署名・typ・期限を検証した JWT の sub */
  userId: UserId;
  /** 照合したリカバリーコードのハッシュ。差し替えの条件（`where: { id, recoveryCodeHash }`）に使う */
  codeHash: string;
  /** 発行時刻（UNIX 秒） */
  iat: number;
  /** 失効時刻（UNIX 秒） */
  exp: number;
};

export type CreateRecoveryTokenInput = {
  /**
   * コードのハッシュで見つけた利用者の ID（DB の User.id）。
   * ここではまだ UserId にしない（UserId にするのは検証の側。Step 1 設計判断 7 の許可リスト）
   */
  userId: string;
  /** 照合したコードのハッシュ（64文字の16進） */
  codeHash: string;
};

export type CreateRecoveryTokenOptions = {
  /** 発行時刻。テストから固定できるように差し替え可能。既定は現在時刻 */
  now?: Date;
};

/**
 * リカバリー用トークンを発行する。typ は RECOVERY_JWT_TYP、有効期間は RECOVERY_TOKEN_MAX_AGE_SECONDS（10分）固定。
 *
 * @throws secret が空文字の場合 Error("AUTH_SECRET is not set")
 * @throws userId が空文字・codeHash がハッシュの形でない場合 Error
 */
export async function createRecoveryToken(
  secret: string,
  input: CreateRecoveryTokenInput,
  options: CreateRecoveryTokenOptions = {},
): Promise<string> {
  const key = toKey(secret);
  if (typeof input.userId !== "string" || input.userId.length === 0) {
    throw new Error("user id must be a non-empty string");
  }
  if (!RECOVERY_CODE_HASH_PATTERN.test(input.codeHash)) {
    throw new Error("invalid recovery code hash");
  }
  const issuedAt = Math.floor((options.now?.getTime() ?? Date.now()) / 1000);

  return new SignJWT({ codeHash: input.codeHash })
    .setProtectedHeader({ alg: SESSION_JWT_ALG, typ: RECOVERY_JWT_TYP })
    .setSubject(input.userId)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + RECOVERY_TOKEN_MAX_AGE_SECONDS)
    .sign(key);
}

/**
 * リカバリー用トークンを検証する。失敗時は null。
 *
 * null になるのは次の場合:
 * - token が undefined / null / 空文字
 * - 署名が不正・有効期限切れ（10分）・alg が HS256 以外
 * - 発行から RECOVERY_TOKEN_MAX_AGE_SECONDS より古い（exp を長く付けたトークンも通さない）
 * - typ ヘッダが RECOVERY_JWT_TYP でない（**セッション JWT・チャレンジ JWT を渡した**）
 * - sub が文字列でない・空文字、codeHash がハッシュの形でない、iat / exp が数値でない
 *
 * @throws secret が空文字の場合のみ Error("AUTH_SECRET is not set")
 */
export async function verifyRecoveryToken(
  token: string | undefined | null,
  secret: string,
  options: VerifySessionTokenOptions = {},
): Promise<RecoveryTokenPayload | null> {
  const key = toKey(secret);
  if (typeof token !== "string" || token.length === 0) return null;

  try {
    const { payload } = await jwtVerify(token, key, {
      algorithms: [SESSION_JWT_ALG],
      typ: RECOVERY_JWT_TYP,
      maxTokenAge: RECOVERY_TOKEN_MAX_AGE_SECONDS,
      currentDate: options.now,
    });

    const { sub, iat, exp, codeHash } = payload;
    if (
      typeof sub !== "string" ||
      sub.length === 0 ||
      typeof codeHash !== "string" ||
      !RECOVERY_CODE_HASH_PATTERN.test(codeHash) ||
      typeof iat !== "number" ||
      typeof exp !== "number"
    ) {
      return null;
    }

    // 署名・typ・期限を検証済みの sub（コードのハッシュで DB から見つけた利用者）なので、ここで UserId にしてよい。
    // auth.ts は Step 1 設計判断 7 の許可リストにある。新しいファイルで brandUserIdFromTrustedSource を呼ばない
    return {
      userId: brandUserIdFromTrustedSource(sub),
      codeHash,
      iat,
      exp,
    };
  } catch {
    return null;
  }
}

/** リカバリー用トークンの Cookie の属性（セッション Cookie と同じ考え方。有効期間は10分） */
export function getRecoveryCookieOptions(
  options: Pick<BuildSessionCookieOptions, "isProduction"> = {},
): SessionCookieOptions {
  return getSessionCookieOptions({
    isProduction: options.isProduction,
    maxAgeSeconds: RECOVERY_TOKEN_MAX_AGE_SECONDS,
  });
}

export type SessionCookieOptions = {
  httpOnly: true;
  sameSite: "lax";
  secure: boolean;
  path: "/";
  maxAge: number;
};

export type BuildSessionCookieOptions = {
  /** 本番かどうか。既定は process.env.NODE_ENV === "production" */
  isProduction?: boolean;
  /** Cookie の有効期間（秒）。既定は SESSION_MAX_AGE_SECONDS */
  maxAgeSeconds?: number;
};

/**
 * セッション Cookie の属性を組み立てる。
 * secure はローカル HTTP 開発で Cookie が落ちないよう本番のみ true。
 */
export function getSessionCookieOptions(
  options: BuildSessionCookieOptions = {},
): SessionCookieOptions {
  const isProduction = options.isProduction ?? process.env.NODE_ENV === "production";
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: isProduction,
    path: "/",
    maxAge: options.maxAgeSeconds ?? SESSION_MAX_AGE_SECONDS,
  };
}

/** ログインページ */
export const LOGIN_PATH = "/login";

/** サインアップ画面。実体は src/lib/signup-messages.ts（Client Component からも読むため） */
export { SIGNUP_PATH } from "@/lib/signup-messages";

/** 期限切れのデモユーザーなどを消す定期処理（Vercel Cron）の Route Handler */
export const CRON_CLEANUP_PATH = "/api/cron/cleanup";

/**
 * リカバリーの画面。実体は src/lib/recovery-messages.ts（Client Component からも読むため）。
 * RECOVERY_PASSKEY_PATH は公開だが、ページ自身がリカバリー用トークンの無いリクエストを RECOVERY_PATH へ戻す
 */
export { RECOVERY_PASSKEY_PATH, RECOVERY_PATH } from "@/lib/recovery-messages";

/**
 * 認証なしでアクセスしてよいパス（完全一致）。
 *
 * SIGNUP_PATH は**完全一致だけ**で公開する。接頭辞一致にすると /signupx や /signup-admin まで
 * 公開になる（docs/steps/pub-2.md 設計判断 6）。
 *
 * CRON_CLEANUP_PATH も**完全一致だけ**。`/api/cron/` の接頭辞にしない（docs/steps/pub-3.md 設計判断 5）。
 * このパスは Route Handler 自身が CRON_SECRET で認証する。
 *
 * RECOVERY_PATH / RECOVERY_PASSKEY_PATH も**完全一致だけ**（docs/steps/pub-5.md 設計判断 5）。
 * `/recoveryx` や `/recovery/other` は公開にしない。
 */
const PUBLIC_PATHS = new Set<string>([
  LOGIN_PATH,
  SIGNUP_PATH,
  CRON_CLEANUP_PATH,
  RECOVERY_PATH,
  RECOVERY_PASSKEY_PATH,
  "/favicon.ico",
  "/robots.txt",
  "/sitemap.xml",
  "/manifest.webmanifest",
  "/manifest.json",
]);

/** 認証なしでアクセスしてよいパスの接頭辞 */
const PUBLIC_PREFIXES = ["/_next/", "/icon", "/apple-icon", "/opengraph-image", "/twitter-image"];

/**
 * 認証不要なパスかどうか。
 * ログイン・サインアップ・リカバリーのページ、定期処理の Route Handler（自身で認証する）、静的アセットのみ true。
 * それ以外（"/" を含む）は保護対象。
 */
export function isPublicPath(pathname: string): boolean {
  if (PUBLIC_PATHS.has(pathname)) return true;
  if (pathname.startsWith(`${LOGIN_PATH}/`)) return true;
  return PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}
