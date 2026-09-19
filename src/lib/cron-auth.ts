import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Cron の呼び出しの認証（docs/steps/pub-3.md 設計判断 5）。純粋関数（環境変数は引数で受け取る）。
 *
 * Vercel は環境変数 CRON_SECRET があると、Cron の呼び出しに
 * `Authorization: Bearer <CRON_SECRET>` を付ける。これと一致したときだけ通す。
 *
 * - **CRON_SECRET が未設定・空なら、ヘッダが何であっても通さない**（fail closed。
 *   未設定のときに誰でも叩ける状態にしない。`Bearer ` だけのヘッダも通らない）
 * - 比較は定数時間（crypto.timingSafeEqual）。timingSafeEqual は長さが違うと例外を投げ、
 *   長さで先に落とすと長さが漏れるので、**両方を SHA-256 にして同じ長さにしてから**比べる
 * - 大文字小文字・前後の空白を正規化しない（`bearer x` や `Bearer  x` は別の値として拒否する）
 *
 * Route Handler（src/app/api/cron/cleanup/route.ts）から呼ぶ。
 */

/** Authorization ヘッダの接頭辞（Vercel の Cron が付ける形） */
export const CRON_AUTH_SCHEME = "Bearer ";

export type EnvSource = Record<string, string | undefined>;

/** CRON_SECRET を読む。未設定・空文字なら null（呼び出し側で必ず拒否する） */
export function getCronSecret(env: EnvSource = process.env): string | null {
  const value = env.CRON_SECRET;
  if (typeof value !== "string" || value.length === 0) return null;
  return value;
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/**
 * Authorization ヘッダが `Bearer <secret>` と一致するか。
 *
 * @param authorization リクエストの Authorization ヘッダ（無ければ null）
 * @param secret CRON_SECRET。null・空文字なら常に false
 */
export function isAuthorizedCronRequest(
  authorization: string | null | undefined,
  secret: string | null | undefined,
): boolean {
  if (typeof secret !== "string" || secret.length === 0) return false;
  if (typeof authorization !== "string" || authorization.length === 0) return false;

  const expected = digest(`${CRON_AUTH_SCHEME}${secret}`);
  const actual = digest(authorization);
  return timingSafeEqual(actual, expected);
}
