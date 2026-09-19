import type { Prisma, PrismaClient } from "@/generated/prisma/client";

/**
 * デモアカウント作成のレート制限（docs/steps/pub-3.md 設計判断 4）。
 *
 * src/lib/signup-limits.ts と同じ形。**定数と記録のテーブル（DemoEvent）はサインアップと分けたまま**にする。
 * デモの連打でサインアップの枠が埋まる（逆も同じ）のを避けるため。
 *
 * - **数えるのは作られたデモユーザー**（DemoEvent）。DemoEvent はデモユーザー作成と同じトランザクションで書く
 *   （src/lib/users.ts の createDemoUser）
 * - IP 単位（1時間に5件）と全体（24時間に300件）の2つ。どちらかに達したら止める
 * - 確認と記録の間に同時に来ると数件超えうるが、許容する（Step 2 と同じ）
 * - **DemoEvent は userId を持たない。** デモユーザーが期限切れで消えても記録は残る
 * - 生IPは保存しない。IP の HMAC（src/lib/login-attempts.ts の hashIp）だけを受け取る
 *
 * このモジュールはサーバー専用。next/headers には触れない。
 */

/** IP 単位の時間窓（分） */
export const DEMO_IP_WINDOW_MINUTES = 60;

/** IP 単位で時間窓内に許すデモ作成数。これに達した時点で止める（＝6件目から弾く） */
export const DEMO_IP_MAX = 5;

/** 全体の時間窓（時間） */
export const DEMO_GLOBAL_WINDOW_HOURS = 24;

/** 全体で時間窓内に許すデモ作成数。これに達した時点で止める（＝301件目から弾く） */
export const DEMO_GLOBAL_MAX = 300;

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;

/** IP 単位の時間窓の開始時刻 */
export function getDemoIpWindowStart(now: Date): Date {
  return new Date(now.getTime() - DEMO_IP_WINDOW_MINUTES * MS_PER_MINUTE);
}

/** 全体の時間窓の開始時刻 */
export function getDemoGlobalWindowStart(now: Date): Date {
  return new Date(now.getTime() - DEMO_GLOBAL_WINDOW_HOURS * MS_PER_HOUR);
}

/** 直近1時間にその IP から作られたデモユーザーの数 */
export async function countRecentDemosByIp(
  client: PrismaClient,
  ipHash: string,
  now: Date = new Date(),
): Promise<number> {
  return client.demoEvent.count({
    where: { ipHash, createdAt: { gte: getDemoIpWindowStart(now) } },
  });
}

/** 直近24時間に（全体で）作られたデモユーザーの数 */
export async function countRecentDemos(
  client: PrismaClient,
  now: Date = new Date(),
): Promise<number> {
  return client.demoEvent.count({
    where: { createdAt: { gte: getDemoGlobalWindowStart(now) } },
  });
}

export type DemoCounts = {
  /** 直近1時間のその IP の件数 */
  ipCount: number;
  /** 直近24時間の全体の件数 */
  globalCount: number;
};

/**
 * 件数から、これ以上作らせないかを判定する（純粋関数）。
 *
 * IP 単位が DEMO_IP_MAX 件に達している、または全体が DEMO_GLOBAL_MAX 件に達していれば true。
 */
export function isDemoLimitReached(counts: DemoCounts): boolean {
  if (counts.ipCount >= DEMO_IP_MAX) return true;
  if (counts.globalCount >= DEMO_GLOBAL_MAX) return true;
  return false;
}

/**
 * その IP からのデモ作成を止めるべきか（IP 単位と全体の両方を見る）。
 * 時間窓を過ぎた記録は数えないので、ひとりでに解除される。
 */
export async function isDemoRateLimited(
  client: PrismaClient,
  ipHash: string,
  now: Date = new Date(),
): Promise<boolean> {
  const [ipCount, globalCount] = await Promise.all([
    countRecentDemosByIp(client, ipHash, now),
    countRecentDemos(client, now),
  ]);
  return isDemoLimitReached({ ipCount, globalCount });
}

/**
 * デモユーザーの作成を1件記録する。
 *
 * **デモユーザー作成と同じトランザクションの中で呼ぶ**（src/lib/users.ts の createDemoUser）。
 * 作られたデモユーザーの数と記録の数を一致させるため。
 */
export async function recordDemoEvent(
  client: Prisma.TransactionClient,
  ipHash: string,
): Promise<void> {
  await client.demoEvent.create({ data: { ipHash } });
}
