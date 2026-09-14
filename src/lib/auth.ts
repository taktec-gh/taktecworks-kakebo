import { SignJWT, jwtVerify } from "jose";

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

/** 利用者は1人だけなので sub は固定値 */
export const SESSION_SUBJECT = "owner";

/** JWT の署名アルゴリズム */
export const SESSION_JWT_ALG = "HS256";

/**
 * ログイン失敗時に画面へ出すメッセージ。
 * 「パスワードが未設定」「文字数が違う」等を推測させない単一の文言にする。
 *
 * 実体は src/lib/auth-messages.ts にある（Client Component から
 * jose 依存のこのファイルを読ませないため）。import 元はここのままでよい。
 */
export { LOGIN_ERROR_MESSAGE } from "@/lib/auth-messages";

export type SessionPayload = {
  /** 常に SESSION_SUBJECT */
  sub: string;
  /** 発行時刻（UNIX 秒） */
  iat: number;
  /** 失効時刻（UNIX 秒） */
  exp: number;
};

export type EnvSource = Record<string, string | undefined>;

/**
 * 定数時間に近い文字列比較。
 * 早期 return をしないことで、先頭何文字が一致したかを実行時間から推測されにくくする。
 */
export function safeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  let diff = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }
  return diff === 0;
}

/**
 * 入力パスワードが正しいかを判定する。
 *
 * - 期待値（APP_PASSWORD）が空文字なら常に false。空パスワードでの素通りを防ぐ
 * - 入力が空文字なら常に false
 */
export function verifyPassword(input: string, expected: string): boolean {
  if (expected.length === 0) return false;
  if (input.length === 0) return false;
  return safeEqual(input, expected);
}

/** APP_PASSWORD を読む。未設定・空文字なら Error を投げる */
export function getAppPassword(env: EnvSource = process.env): string {
  const value = env.APP_PASSWORD;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("APP_PASSWORD is not set");
  }
  return value;
}

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
 * セッション JWT を発行する。
 *
 * @throws secret が空文字の場合 Error("AUTH_SECRET is not set")
 */
export async function createSessionToken(
  secret: string,
  options: CreateSessionTokenOptions = {},
): Promise<string> {
  const key = toKey(secret);
  const issuedAt = Math.floor((options.now?.getTime() ?? Date.now()) / 1000);
  const maxAge = options.maxAgeSeconds ?? SESSION_MAX_AGE_SECONDS;

  return new SignJWT({})
    .setProtectedHeader({ alg: SESSION_JWT_ALG })
    .setSubject(SESSION_SUBJECT)
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
 * - sub が SESSION_SUBJECT 以外
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
      subject: SESSION_SUBJECT,
      currentDate: options.now,
    });

    if (
      typeof payload.sub !== "string" ||
      payload.sub !== SESSION_SUBJECT ||
      typeof payload.iat !== "number" ||
      typeof payload.exp !== "number"
    ) {
      return null;
    }

    return { sub: payload.sub, iat: payload.iat, exp: payload.exp };
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
