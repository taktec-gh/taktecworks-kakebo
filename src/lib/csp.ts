/**
 * Content-Security-Policy（CSP）の組み立てと nonce の生成。
 *
 * nonce 方式（docs/steps/pub-4.md 設計判断 1・2）。proxy がリクエストごとに nonce を作り、
 * このモジュールの純粋関数でポリシーを組み立てる。Next.js は描画時にリクエストヘッダの
 * CSP から `'nonce-…'` を読み取り、自分のスクリプトに付ける
 * （node_modules/next/dist/docs/01-app/02-guides/content-security-policy.md）。
 *
 * - 本番に `'unsafe-inline'` / `'unsafe-eval'` を入れない
 * - 開発だけ緩める判定は `NODE_ENV === "development"` の一致で行う（未設定・test で緩めない）
 * - `upgrade-insecure-requests` は入れない（ローカルの http で `next start` すると壊れうる。
 *   本番は Vercel の https 強制と HSTS で足りる）
 * - 外部のドメインは1つも許可しない
 */

/** CSP のヘッダ名 */
export const CSP_HEADER_NAME = "Content-Security-Policy";

/** nonce をサーバーコンポーネントへ渡すリクエストヘッダ名（公式の手順に合わせる） */
export const NONCE_HEADER_NAME = "x-nonce";

/** nonce の乱数のバイト数。128ビット */
export const NONCE_BYTES = 16;

/**
 * 受け付ける nonce の形。標準の base64（CSP の base64-value の文法）で、
 * 128ビット（16バイト → 24文字）以上。`'` `;` 空白・改行などポリシーを壊す文字は通らない。
 */
const NONCE_PATTERN = /^[A-Za-z0-9+/]{22,}={0,2}$/;

/** nonce として受け付けられる文字列か */
export function isValidNonce(nonce: string): boolean {
  return NONCE_PATTERN.test(nonce);
}

/**
 * リクエストごとの nonce を作る。暗号学的乱数 128ビットの base64。
 * proxy の実行環境（Node / Edge）のどちらでも動くよう Web Crypto と btoa を使う。
 */
export function generateNonce(): string {
  const bytes = new Uint8Array(NONCE_BYTES);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * 開発用に緩めたポリシーを使うか。`"development"` との一致だけで判定する。
 * 「production でなければ緩める」にしない（NODE_ENV が未設定・test のときに緩まないように）。
 */
export function isDevelopmentEnv(nodeEnv: string | undefined): boolean {
  return nodeEnv === "development";
}

export type ContentSecurityPolicyOptions = {
  /** generateNonce() で作った値。形が不正なら例外 */
  nonce: string;
  /** 開発用に緩めるか。isDevelopmentEnv(process.env.NODE_ENV) を渡す */
  isDev: boolean;
};

/**
 * CSP のヘッダ値を組み立てる（純粋関数）。
 *
 * 開発時のみ:
 * - `script-src` に `'unsafe-eval'`（React が開発時のデバッグ情報に eval を使う）
 * - `style-src` を `'self' 'unsafe-inline'` にする。nonce があると `'unsafe-inline'` は
 *   ブラウザに無視されるため、開発時は style-src から nonce を外す（公式の手順と同じ形）
 *
 * @throws nonce が isValidNonce を満たさないとき
 */
export function buildContentSecurityPolicy({ nonce, isDev }: ContentSecurityPolicyOptions): string {
  if (!isValidNonce(nonce)) {
    throw new Error("CSP の nonce の形が不正です");
  }
  const nonceSource = `'nonce-${nonce}'`;

  const directives: string[] = [
    "default-src 'self'",
    `script-src 'self' ${nonceSource} 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ""}`,
    isDev ? "style-src 'self' 'unsafe-inline'" : `style-src 'self' ${nonceSource}`,
    "img-src 'self' blob: data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ];
  return directives.join("; ");
}
