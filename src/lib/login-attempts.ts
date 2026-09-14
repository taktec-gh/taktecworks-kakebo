import { createHmac } from "node:crypto";

import type { PrismaClient } from "@/generated/prisma/client";

/**
 * ログイン試行の記録とレート制限（docs/steps/step-7.md「設計判断 4」）。
 *
 * - Vercel はサーバーレスでインスタンスごとにメモリが別なので、メモリ内カウンタは効かない。
 *   すでにある Neon にテーブル1つを足して数える
 * - **生IPは保存しない。** AUTH_SECRET で HMAC-SHA256 した値だけを保存する
 * - 全体の上限は設けない（正規の利用者を締め出す DoS になるため）。
 *   本命の防御はパスワードのエントロピーとパスキー必須化で、これは深層防御
 * - 成功しても過去の失敗記録は消さない。消すと
 *   「9回失敗 → 1回成功 → また10回」で制限を回避できる
 *
 * このモジュールはサーバー専用。next/headers には触れない（IP の取得は
 * src/lib/client-ip.ts の担当）。
 */

/** 失敗を数える時間窓（分） */
export const RATE_LIMIT_WINDOW_MINUTES = 15;

/** 時間窓内に許す失敗回数。これに達した時点でブロックする（＝11回目から弾く） */
export const RATE_LIMIT_MAX_FAILURES = 10;

/** IP が取れなかったときの代替値。全員が同じバケツに入るが、無いよりよい */
export const UNKNOWN_IP = "unknown";

const MS_PER_MINUTE = 60_000;

/**
 * `x-forwarded-for` から接続元 IP を取り出す（純粋関数）。
 *
 * Vercel は末尾に自身のプロキシを足していくため**先頭**が接続元。
 * 取得できなければ UNKNOWN_IP。
 */
export function extractClientIp(forwardedFor: string | null | undefined): string {
  if (typeof forwardedFor !== "string") return UNKNOWN_IP;

  const first = forwardedFor.split(",")[0]?.trim() ?? "";
  return first.length > 0 ? first : UNKNOWN_IP;
}

/**
 * IP を AUTH_SECRET で HMAC-SHA256 して16進文字列にする。
 *
 * 平文の IP を DB に残さないため。鍵付きなので、DB が漏れても
 * 候補 IP の総当たりで元の IP を突き止めることができない。
 */
export function hashIp(ip: string, secret: string): string {
  if (secret.length === 0) {
    throw new Error("AUTH_SECRET is not set");
  }
  return createHmac("sha256", secret).update(ip).digest("hex");
}

/** 試行を1件記録する。成功も失敗も残す */
export async function recordLoginAttempt(
  client: PrismaClient,
  ipHash: string,
  succeeded: boolean,
): Promise<void> {
  await client.loginAttempt.create({ data: { ipHash, succeeded } });
}

/** 時間窓の開始時刻 */
export function getWindowStart(now: Date): Date {
  return new Date(now.getTime() - RATE_LIMIT_WINDOW_MINUTES * MS_PER_MINUTE);
}

/** 直近の時間窓に入った失敗の件数 */
export async function countRecentFailures(
  client: PrismaClient,
  ipHash: string,
  now: Date = new Date(),
): Promise<number> {
  return client.loginAttempt.count({
    where: {
      ipHash,
      succeeded: false,
      createdAt: { gte: getWindowStart(now) },
    },
  });
}

/**
 * その IP をブロックすべきか。
 *
 * 失敗が RATE_LIMIT_MAX_FAILURES 件に達していれば true
 * （10回目までは通り、11回目で弾く）。時間窓を過ぎた失敗は数えないので、
 * 最後の失敗から15分でひとりでに解除される。
 */
export async function isBlocked(
  client: PrismaClient,
  ipHash: string,
  now: Date = new Date(),
): Promise<boolean> {
  const failures = await countRecentFailures(client, ipHash, now);
  return failures >= RATE_LIMIT_MAX_FAILURES;
}
