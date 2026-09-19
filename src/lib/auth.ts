import { SignJWT, jwtVerify } from "jose";

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

/** 認証なしでアクセスしてよいパス（完全一致） */
const PUBLIC_PATHS = new Set<string>([
  LOGIN_PATH,
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
 * ログインページと静的アセットのみ true。それ以外（"/" を含む）は保護対象。
 */
export function isPublicPath(pathname: string): boolean {
  if (PUBLIC_PATHS.has(pathname)) return true;
  if (pathname.startsWith(`${LOGIN_PATH}/`)) return true;
  return PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}
