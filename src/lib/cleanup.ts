import type { PrismaClient } from "@/generated/prisma/client";

/**
 * 定期処理（1日1回の Cron）の削除（docs/steps/pub-3.md 設計判断 5）。
 *
 * 1. 期限切れのデモユーザーを消す。User を消せば全データが Cascade で消える
 * 2. 保持期間を過ぎた記録（SignupEvent / DemoEvent / LoginAttempt）を消す
 *
 * - **通常のユーザー（demoExpiresAt が null）は決して消さない。** 条件は `not: null` と `lt: now` の
 *   **両方を明示する**（SQL では null < now は真にならないが、読み手と変異テストに見える形にする）
 * - 期限がちょうど now のデモユーザーは消さない（`lt`。セッションの exp と同じく「その時刻まで有効」）
 * - 1回に消すデモユーザーは DEMO_CLEANUP_BATCH_SIZE 件まで。残りは次の回に消える
 * - 時刻は引数で受け取る（Route Handler から切り離し、テストと検証スクリプトから呼ぶため）
 * - 戻り値は件数だけ。ユーザーIDやデータの中身を返さない・ログに出さない
 */

/** 1回の処理で消すデモユーザーの上限 */
export const DEMO_CLEANUP_BATCH_SIZE = 1000;

/** SignupEvent の保持期間（日）。レート制限の時間窓（最大24時間）より十分長ければよい */
export const SIGNUP_EVENT_RETENTION_DAYS = 7;

/** DemoEvent の保持期間（日） */
export const DEMO_EVENT_RETENTION_DAYS = 7;

/** LoginAttempt の保持期間（日）。レート制限（15分）のほか、攻撃に気づくために残す */
export const LOGIN_ATTEMPT_RETENTION_DAYS = 30;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * 期限切れのデモユーザーの条件。**not: null と lt: now の両方を必ず含める。**
 *
 * 検索と削除の両方でこの条件を使う（検索で得た ID だけでなく、削除の時点でも条件を満たす行だけを消す）。
 */
export function expiredDemoUserWhere(now: Date): {
  demoExpiresAt: { not: null; lt: Date };
} {
  return { demoExpiresAt: { not: null, lt: now } };
}

/** 保持期間の境界。これより前（lt）に作られた行を消す */
export function getRetentionCutoff(now: Date, retentionDays: number): Date {
  return new Date(now.getTime() - retentionDays * MS_PER_DAY);
}

/**
 * 期限切れのデモユーザーを消す（最大 DEMO_CLEANUP_BATCH_SIZE 件）。
 *
 * deleteMany は件数の上限を指定できないので、先に期限の古い順に ID を引き、
 * **同じ条件を付けたまま** その ID の行を消す。
 *
 * @returns 消したデモユーザーの数
 */
export async function deleteExpiredDemoUsers(client: PrismaClient, now: Date): Promise<number> {
  const expired = await client.user.findMany({
    where: expiredDemoUserWhere(now),
    select: { id: true },
    orderBy: { demoExpiresAt: "asc" },
    take: DEMO_CLEANUP_BATCH_SIZE,
  });
  if (expired.length === 0) return 0;

  const result = await client.user.deleteMany({
    where: {
      id: { in: expired.map((user) => user.id) },
      ...expiredDemoUserWhere(now),
    },
  });
  return result.count;
}

export type ExpiredRecordCounts = {
  deletedSignupEvents: number;
  deletedDemoEvents: number;
  deletedLoginAttempts: number;
};

/** 保持期間を過ぎた記録を消す */
export async function deleteExpiredRecords(
  client: PrismaClient,
  now: Date,
): Promise<ExpiredRecordCounts> {
  const [signupEvents, demoEvents, loginAttempts] = await Promise.all([
    client.signupEvent.deleteMany({
      where: { createdAt: { lt: getRetentionCutoff(now, SIGNUP_EVENT_RETENTION_DAYS) } },
    }),
    client.demoEvent.deleteMany({
      where: { createdAt: { lt: getRetentionCutoff(now, DEMO_EVENT_RETENTION_DAYS) } },
    }),
    client.loginAttempt.deleteMany({
      where: { createdAt: { lt: getRetentionCutoff(now, LOGIN_ATTEMPT_RETENTION_DAYS) } },
    }),
  ]);
  return {
    deletedSignupEvents: signupEvents.count,
    deletedDemoEvents: demoEvents.count,
    deletedLoginAttempts: loginAttempts.count,
  };
}

export type CleanupResult = ExpiredRecordCounts & {
  deletedDemoUsers: number;
};

/** 定期処理の本体。期限切れのデモユーザーと、保持期間を過ぎた記録を消す */
export async function runCleanup(client: PrismaClient, now: Date): Promise<CleanupResult> {
  const deletedDemoUsers = await deleteExpiredDemoUsers(client, now);
  const records = await deleteExpiredRecords(client, now);
  return { deletedDemoUsers, ...records };
}
