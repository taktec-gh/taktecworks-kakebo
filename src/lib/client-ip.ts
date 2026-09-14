import { headers } from "next/headers";

import { getAuthSecret } from "@/lib/auth";
import { extractClientIp, hashIp } from "@/lib/login-attempts";

/**
 * リクエストヘッダから接続元 IP を取り出す副作用側。
 *
 * 純粋な取り出し（extractClientIp）とハッシュ化（hashIp）は
 * src/lib/login-attempts.ts にあり、ここは next/headers との接続だけを持つ
 * （src/lib/auth.ts と src/lib/session.ts の分け方に合わせている）。
 *
 * Server Action / Route Handler からのみ呼べる。
 */

/** 接続元 IP。取得できなければ "unknown" */
export async function getClientIp(): Promise<string> {
  const headerList = await headers();
  return extractClientIp(headerList.get("x-forwarded-for"));
}

/**
 * 接続元 IP の HMAC。**生IPは返さない**（呼び出し側で保存されないようにするため）。
 *
 * @throws AUTH_SECRET 未設定なら Error
 */
export async function getClientIpHash(): Promise<string> {
  return hashIp(await getClientIp(), getAuthSecret());
}
