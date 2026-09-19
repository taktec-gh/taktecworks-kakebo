import type { Prisma, PrismaClient } from "@/generated/prisma/client";

/**
 * サインアップのレート制限（docs/steps/pub-2.md 設計判断 5）。
 *
 * - **数えるのは「作られたアカウント」**（SignupEvent）。開始（チャレンジ発行）や検証失敗は数えない。
 *   SignupEvent はユーザー作成と同じトランザクションで書く（src/lib/users.ts）
 * - IP 単位（1時間に3件）と全体（24時間に100件）の2つ。どちらかに達したら止める
 * - 開始時と完了時の**両方で**確認する（src/app/(auth)/signup/actions.ts）
 * - 確認と記録の間に同時に登録が来ると数件超えうるが、許容する（直列化の費用に見合わない）
 * - **SignupEvent は userId を持たない**（LoginAttempt に続く例外）。アカウントを消しても記録は残る
 * - 生IPは保存しない。IP の HMAC（src/lib/login-attempts.ts の hashIp）だけを受け取る
 *
 * このモジュールはサーバー専用。next/headers には触れない。
 */

/** IP 単位の時間窓（分） */
export const SIGNUP_IP_WINDOW_MINUTES = 60;

/** IP 単位で時間窓内に許すアカウント作成数。これに達した時点で止める（＝4件目から弾く） */
export const SIGNUP_IP_MAX = 3;

/** 全体の時間窓（時間） */
export const SIGNUP_GLOBAL_WINDOW_HOURS = 24;

/** 全体で時間窓内に許すアカウント作成数。これに達した時点で止める（＝101件目から弾く） */
export const SIGNUP_GLOBAL_MAX = 100;

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;

/** IP 単位の時間窓の開始時刻 */
export function getSignupIpWindowStart(now: Date): Date {
  return new Date(now.getTime() - SIGNUP_IP_WINDOW_MINUTES * MS_PER_MINUTE);
}

/** 全体の時間窓の開始時刻 */
export function getSignupGlobalWindowStart(now: Date): Date {
  return new Date(now.getTime() - SIGNUP_GLOBAL_WINDOW_HOURS * MS_PER_HOUR);
}

/** 直近1時間にその IP から作られたアカウントの数 */
export async function countRecentSignupsByIp(
  client: PrismaClient,
  ipHash: string,
  now: Date = new Date(),
): Promise<number> {
  return client.signupEvent.count({
    where: { ipHash, createdAt: { gte: getSignupIpWindowStart(now) } },
  });
}

/** 直近24時間に（全体で）作られたアカウントの数 */
export async function countRecentSignups(
  client: PrismaClient,
  now: Date = new Date(),
): Promise<number> {
  return client.signupEvent.count({
    where: { createdAt: { gte: getSignupGlobalWindowStart(now) } },
  });
}

export type SignupCounts = {
  /** 直近1時間のその IP の件数 */
  ipCount: number;
  /** 直近24時間の全体の件数 */
  globalCount: number;
};

/**
 * 件数から、これ以上作らせないかを判定する（純粋関数）。
 *
 * IP 単位が SIGNUP_IP_MAX 件に達している、または全体が SIGNUP_GLOBAL_MAX 件に達していれば true。
 */
export function isSignupLimitReached(counts: SignupCounts): boolean {
  if (counts.ipCount >= SIGNUP_IP_MAX) return true;
  if (counts.globalCount >= SIGNUP_GLOBAL_MAX) return true;
  return false;
}

/**
 * その IP からのサインアップを止めるべきか（IP 単位と全体の両方を見る）。
 * 時間窓を過ぎた記録は数えないので、ひとりでに解除される。
 */
export async function isSignupRateLimited(
  client: PrismaClient,
  ipHash: string,
  now: Date = new Date(),
): Promise<boolean> {
  const [ipCount, globalCount] = await Promise.all([
    countRecentSignupsByIp(client, ipHash, now),
    countRecentSignups(client, now),
  ]);
  return isSignupLimitReached({ ipCount, globalCount });
}

/**
 * サインアップの成功を1件記録する。
 *
 * **ユーザー作成と同じトランザクションの中で呼ぶ**（src/lib/users.ts の createUserWithPasskey）。
 * 作られたユーザーの数と記録の数を一致させるため。
 */
export async function recordSignupEvent(
  client: Prisma.TransactionClient,
  ipHash: string,
): Promise<void> {
  await client.signupEvent.create({ data: { ipHash } });
}
