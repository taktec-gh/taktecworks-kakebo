// @vitest-environment node
//
// src/lib/cleanup.ts（期限切れのデモユーザーと、保持期間を過ぎた記録の削除）を検証する。
// 実データベースには接続せず PrismaClient をモックする。
//
// **この Step で最も壊れると被害が大きい箇所**（docs/steps/pub-3.md「tester 向けの方針」1）。
// 通常ユーザー（demoExpiresAt が null）や期限内のデモユーザーが決して消えないことを重点的に確かめる。
//
// 期待値の根拠:
// - docs/steps/pub-3.md 設計判断 5「期限切れのデモユーザーの削除」
//   「削除の条件は demoExpiresAt が null でなく、かつ現在時刻より前であること。
//    条件は where: { demoExpiresAt: { not: null, lt: now } } のように両方を明示する」
//   「1回の件数に上限を設ける（例: 1000件）。残った分は次の回に消える」
//   「SignupEvent / DemoEvent は7日、LoginAttempt は30日」
// - docs/steps/pub-3.md「実装完了後の引き継ぎ」
//   「expiredDemoUserWhere(now) = { demoExpiresAt: { not: null, lt: now } }、
//    deleteExpiredDemoUsers(client, now)（findMany take:1000 → deleteMany。両方に同じ条件）、
//    deleteExpiredRecords(client, now)（7日/7日/30日）、runCleanup(client, now)」
// - docs/steps/pub-3.md「変異テスト」1・2・13
//   1. not: null を外し、通常ユーザーも対象になる形にすると落ちる
//   2. lt: now を gt: now にする（期限内のデモを消す）と落ちる
//   13. LoginAttempt の保持期間を7日にすると落ちる
// - 手計算: 保持期間の境界は「ちょうど retentionDays 日前」で lt（含まない）

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PrismaClient } from "@/generated/prisma/client";
import {
  DEMO_CLEANUP_BATCH_SIZE,
  DEMO_EVENT_RETENTION_DAYS,
  deleteExpiredDemoUsers,
  deleteExpiredRecords,
  expiredDemoUserWhere,
  getRetentionCutoff,
  LOGIN_ATTEMPT_RETENTION_DAYS,
  runCleanup,
  SIGNUP_EVENT_RETENTION_DAYS,
} from "@/lib/cleanup";

describe("定数", () => {
  it("1回に消すデモユーザーの上限は1000件", () => {
    expect(DEMO_CLEANUP_BATCH_SIZE).toBe(1000);
  });

  it("保持期間: SignupEvent/DemoEvent は7日、LoginAttempt は30日", () => {
    expect(SIGNUP_EVENT_RETENTION_DAYS).toBe(7);
    expect(DEMO_EVENT_RETENTION_DAYS).toBe(7);
    expect(LOGIN_ATTEMPT_RETENTION_DAYS).toBe(30);
  });
});

describe("expiredDemoUserWhere（削除条件。not: null と lt を両方明示する）", () => {
  it("not: null と lt: now の両方を含む", () => {
    const now = new Date("2026-08-14T12:00:00.000Z");
    expect(expiredDemoUserWhere(now)).toEqual({ demoExpiresAt: { not: null, lt: now } });
  });

  it("lte ではなく lt（ちょうど now のデモは対象に含まれない条件を返す）", () => {
    const now = new Date("2026-08-14T12:00:00.000Z");
    const where = expiredDemoUserWhere(now);
    expect(where.demoExpiresAt).not.toHaveProperty("lte");
    expect(where.demoExpiresAt.lt).toEqual(now);
  });

  it("OR で demoExpiresAt: null を含めない（通常ユーザーが対象に混ざらない形）", () => {
    const now = new Date("2026-08-14T12:00:00.000Z");
    const where = expiredDemoUserWhere(now) as Record<string, unknown>;
    expect(where).not.toHaveProperty("OR");
    expect(JSON.stringify(where)).not.toContain("demoExpiresAt\":null");
  });
});

describe("getRetentionCutoff", () => {
  it("7日前（手計算: 7*24*60*60*1000 = 604,800,000ms）", () => {
    const now = new Date("2026-08-14T12:00:00.000Z");
    expect(getRetentionCutoff(now, 7)).toEqual(new Date("2026-08-07T12:00:00.000Z"));
  });

  it("30日前", () => {
    const now = new Date("2026-08-14T12:00:00.000Z");
    expect(getRetentionCutoff(now, 30)).toEqual(new Date("2026-07-15T12:00:00.000Z"));
  });

  it("0日なら now と同じ", () => {
    const now = new Date("2026-08-14T12:00:00.000Z");
    expect(getRetentionCutoff(now, 0)).toEqual(now);
  });
});

/* ------------------------------------------------------------------ *
 * deleteExpiredDemoUsers（最重要: 通常ユーザー・期限内のデモを消さないこと）
 * ------------------------------------------------------------------ */

describe("deleteExpiredDemoUsers", () => {
  function createMockClient() {
    const findMany = vi.fn();
    const deleteMany = vi.fn();
    const client = { user: { findMany, deleteMany } } as unknown as PrismaClient;
    return { client, findMany, deleteMany };
  }

  it("findMany・deleteMany の両方に expiredDemoUserWhere(now) と同じ条件（not: null かつ lt: now）を渡す", async () => {
    const { client, findMany, deleteMany } = createMockClient();
    findMany.mockResolvedValue([{ id: "user_expired_1" }]);
    deleteMany.mockResolvedValue({ count: 1 });
    const now = new Date("2026-08-14T12:00:00.000Z");

    await deleteExpiredDemoUsers(client, now);

    expect(findMany).toHaveBeenCalledWith({
      where: { demoExpiresAt: { not: null, lt: now } },
      select: { id: true },
      orderBy: { demoExpiresAt: "asc" },
      take: DEMO_CLEANUP_BATCH_SIZE,
    });
    expect(deleteMany).toHaveBeenCalledWith({
      where: {
        id: { in: ["user_expired_1"] },
        demoExpiresAt: { not: null, lt: now },
      },
    });
  });

  it("該当が0件なら deleteMany を呼ばず 0 を返す（無条件の deleteMany を実行しない）", async () => {
    const { client, findMany, deleteMany } = createMockClient();
    findMany.mockResolvedValue([]);

    const result = await deleteExpiredDemoUsers(client, new Date("2026-08-14T12:00:00.000Z"));

    expect(result).toBe(0);
    expect(deleteMany).not.toHaveBeenCalled();
  });

  it("戻り値は deleteMany の count", async () => {
    const { client, findMany, deleteMany } = createMockClient();
    findMany.mockResolvedValue([{ id: "a" }, { id: "b" }, { id: "c" }]);
    deleteMany.mockResolvedValue({ count: 3 });

    await expect(
      deleteExpiredDemoUsers(client, new Date("2026-08-14T12:00:00.000Z")),
    ).resolves.toBe(3);
  });

  it("take は DEMO_CLEANUP_BATCH_SIZE（1000）件まで（1回の上限）", async () => {
    const { client, findMany, deleteMany } = createMockClient();
    findMany.mockResolvedValue([]);
    deleteMany.mockResolvedValue({ count: 0 });

    await deleteExpiredDemoUsers(client, new Date("2026-08-14T12:00:00.000Z"));

    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 1000 }));
  });

  it("orderBy は demoExpiresAt 昇順（期限の古い順から消す）", async () => {
    const { client, findMany } = createMockClient();
    findMany.mockResolvedValue([]);

    await deleteExpiredDemoUsers(client, new Date("2026-08-14T12:00:00.000Z"));

    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ orderBy: { demoExpiresAt: "asc" } }));
  });
});

/* ------------------------------------------------------------------ *
 * データを実際に解釈する疑似クライアントで、通常ユーザー・期限内デモが
 * 絶対に消えないことを直接確かめる（分離テスト data-isolation.test.ts と同じ発想）。
 * ------------------------------------------------------------------ */

describe("deleteExpiredDemoUsers — where を実際に解釈する疑似クライアントでの確認", () => {
  type FakeUser = { id: string; demoExpiresAt: Date | null };

  /** 削除の条件（not: null かつ lt: now）を実際に解釈する最小限の疑似 Prisma クライアント */
  function createFakeClient(users: FakeUser[]) {
    const rows = [...users];
    const matches = (row: FakeUser, now: Date) => row.demoExpiresAt !== null && row.demoExpiresAt < now;
    const client = {
      user: {
        findMany: vi.fn(async (args: { where: { demoExpiresAt: { not: null; lt: Date } } }) => {
          const now = args.where.demoExpiresAt.lt;
          return rows.filter((r) => matches(r, now)).map((r) => ({ id: r.id }));
        }),
        deleteMany: vi.fn(
          async (args: {
            where: { id: { in: string[] }; demoExpiresAt: { not: null; lt: Date } };
          }) => {
            const now = args.where.demoExpiresAt.lt;
            const ids = new Set(args.where.id.in);
            const before = rows.length;
            for (let i = rows.length - 1; i >= 0; i -= 1) {
              if (ids.has(rows[i].id) && matches(rows[i], now)) rows.splice(i, 1);
            }
            return { count: before - rows.length };
          },
        ),
      },
    } as unknown as PrismaClient;
    return { client, rows };
  }

  it("通常ユーザー（demoExpiresAt: null）は消えない", async () => {
    const now = new Date("2026-08-14T12:00:00.000Z");
    const { client, rows } = createFakeClient([
      { id: "user_normal", demoExpiresAt: null },
      { id: "user_expired_demo", demoExpiresAt: new Date("2026-08-01T00:00:00.000Z") },
    ]);

    const deleted = await deleteExpiredDemoUsers(client, now);

    expect(deleted).toBe(1);
    expect(rows.some((r) => r.id === "user_normal")).toBe(true);
    expect(rows.some((r) => r.id === "user_expired_demo")).toBe(false);
  });

  it("期限内のデモユーザー（demoExpiresAt > now）は消えない", async () => {
    const now = new Date("2026-08-14T12:00:00.000Z");
    const { client, rows } = createFakeClient([
      { id: "user_future_demo", demoExpiresAt: new Date("2026-08-20T00:00:00.000Z") },
    ]);

    const deleted = await deleteExpiredDemoUsers(client, now);

    expect(deleted).toBe(0);
    expect(rows).toHaveLength(1);
  });

  it("境界: demoExpiresAt がちょうど now のデモユーザーは消えない（lt。未満だけが対象）", async () => {
    const now = new Date("2026-08-14T12:00:00.000Z");
    const { client, rows } = createFakeClient([{ id: "user_exact_now", demoExpiresAt: new Date(now) }]);

    const deleted = await deleteExpiredDemoUsers(client, now);

    expect(deleted).toBe(0);
    expect(rows).toHaveLength(1);
  });

  it("境界: now の1ミリ秒前に期限切れのデモユーザーは消える", async () => {
    const now = new Date("2026-08-14T12:00:00.000Z");
    const { client, rows } = createFakeClient([
      { id: "user_just_expired", demoExpiresAt: new Date(now.getTime() - 1) },
    ]);

    const deleted = await deleteExpiredDemoUsers(client, now);

    expect(deleted).toBe(1);
    expect(rows).toHaveLength(0);
  });

  it("通常ユーザー・期限内デモ・期限切れデモが混在していても、期限切れデモだけが消える", async () => {
    const now = new Date("2026-08-14T12:00:00.000Z");
    const { client, rows } = createFakeClient([
      { id: "user_normal_1", demoExpiresAt: null },
      { id: "user_normal_2", demoExpiresAt: null },
      { id: "user_demo_expired_1", demoExpiresAt: new Date("2026-08-01T00:00:00.000Z") },
      { id: "user_demo_expired_2", demoExpiresAt: new Date("2026-08-10T00:00:00.000Z") },
      { id: "user_demo_future", demoExpiresAt: new Date("2026-08-15T00:00:00.000Z") },
    ]);

    const deleted = await deleteExpiredDemoUsers(client, now);

    expect(deleted).toBe(2);
    expect(rows.map((r) => r.id).sort()).toEqual(["user_demo_future", "user_normal_1", "user_normal_2"]);
  });
});

/* ------------------------------------------------------------------ *
 * deleteExpiredRecords（保持期間）
 * ------------------------------------------------------------------ */

describe("deleteExpiredRecords", () => {
  function createMockClient() {
    const signupDeleteMany = vi.fn().mockResolvedValue({ count: 1 });
    const demoDeleteMany = vi.fn().mockResolvedValue({ count: 2 });
    const loginDeleteMany = vi.fn().mockResolvedValue({ count: 3 });
    const client = {
      signupEvent: { deleteMany: signupDeleteMany },
      demoEvent: { deleteMany: demoDeleteMany },
      loginAttempt: { deleteMany: loginDeleteMany },
    } as unknown as PrismaClient;
    return { client, signupDeleteMany, demoDeleteMany, loginDeleteMany };
  }

  it("SignupEvent は7日、DemoEvent は7日、LoginAttempt は30日の cutoff で削除する", async () => {
    const { client, signupDeleteMany, demoDeleteMany, loginDeleteMany } = createMockClient();
    const now = new Date("2026-08-14T12:00:00.000Z");

    await deleteExpiredRecords(client, now);

    expect(signupDeleteMany).toHaveBeenCalledWith({
      where: { createdAt: { lt: new Date("2026-08-07T12:00:00.000Z") } },
    });
    expect(demoDeleteMany).toHaveBeenCalledWith({
      where: { createdAt: { lt: new Date("2026-08-07T12:00:00.000Z") } },
    });
    expect(loginDeleteMany).toHaveBeenCalledWith({
      where: { createdAt: { lt: new Date("2026-07-15T12:00:00.000Z") } },
    });
  });

  it("戻り値は3テーブルそれぞれの削除件数", async () => {
    const { client } = createMockClient();
    await expect(deleteExpiredRecords(client, new Date("2026-08-14T12:00:00.000Z"))).resolves.toEqual({
      deletedSignupEvents: 1,
      deletedDemoEvents: 2,
      deletedLoginAttempts: 3,
    });
  });

  it("境界: 保持期間ちょうど（7日前ぴったり）の記録は消えない条件になっている（lt。以降のみ対象）", async () => {
    // getRetentionCutoff で確認済みの cutoff がそのまま lt に渡ることを、より直接に確認する
    const { client, signupDeleteMany } = createMockClient();
    const now = new Date("2026-08-14T12:00:00.000Z");
    await deleteExpiredRecords(client, now);
    const where = signupDeleteMany.mock.calls[0][0].where as { createdAt: { lt: Date; lte?: Date } };
    expect(where.createdAt).not.toHaveProperty("lte");
    expect(where.createdAt.lt).toEqual(new Date("2026-08-07T12:00:00.000Z"));
  });
});

describe("deleteExpiredRecords — 実際に解釈する疑似クライアントで境界を確認する", () => {
  type FakeRecord = { id: string; createdAt: Date };

  function createFakeClient(signupEvents: FakeRecord[], demoEvents: FakeRecord[], loginAttempts: FakeRecord[]) {
    function makeTable(rows: FakeRecord[]) {
      return {
        deleteMany: vi.fn(async (args: { where: { createdAt: { lt: Date } } }) => {
          const cutoff = args.where.createdAt.lt;
          const before = rows.length;
          for (let i = rows.length - 1; i >= 0; i -= 1) {
            if (rows[i].createdAt < cutoff) rows.splice(i, 1);
          }
          return { count: before - rows.length };
        }),
      };
    }
    const client = {
      signupEvent: makeTable(signupEvents),
      demoEvent: makeTable(demoEvents),
      loginAttempt: makeTable(loginAttempts),
    } as unknown as PrismaClient;
    return { client, signupEvents, demoEvents, loginAttempts };
  }

  it("7日ちょうど前の SignupEvent/DemoEvent は消えない。7日と1ミリ秒前は消える", async () => {
    const now = new Date("2026-08-14T12:00:00.000Z");
    const exactlySevenDaysAgo = new Date("2026-08-07T12:00:00.000Z");
    const justOverSevenDaysAgo = new Date(exactlySevenDaysAgo.getTime() - 1);
    const { client, signupEvents, demoEvents } = createFakeClient(
      [
        { id: "signup_exact", createdAt: exactlySevenDaysAgo },
        { id: "signup_old", createdAt: justOverSevenDaysAgo },
      ],
      [
        { id: "demo_exact", createdAt: exactlySevenDaysAgo },
        { id: "demo_old", createdAt: justOverSevenDaysAgo },
      ],
      [],
    );

    await deleteExpiredRecords(client, now);

    expect(signupEvents.map((r) => r.id)).toEqual(["signup_exact"]);
    expect(demoEvents.map((r) => r.id)).toEqual(["demo_exact"]);
  });

  it("29日前の LoginAttempt は消えない。30日と1ミリ秒前は消える（30日の境界）", async () => {
    const now = new Date("2026-08-14T12:00:00.000Z");
    const twentyNineDaysAgo = new Date("2026-07-16T12:00:00.000Z");
    const justOverThirtyDaysAgo = new Date(new Date("2026-07-15T12:00:00.000Z").getTime() - 1);
    const { client, loginAttempts } = createFakeClient(
      [],
      [],
      [
        { id: "login_29d", createdAt: twentyNineDaysAgo },
        { id: "login_over_30d", createdAt: justOverThirtyDaysAgo },
      ],
    );

    await deleteExpiredRecords(client, now);

    expect(loginAttempts.map((r) => r.id)).toEqual(["login_29d"]);
  });
});

/* ------------------------------------------------------------------ *
 * runCleanup（本体）
 * ------------------------------------------------------------------ */

describe("runCleanup", () => {
  it("deleteExpiredDemoUsers と deleteExpiredRecords の結果をまとめて返す", async () => {
    const findMany = vi.fn().mockResolvedValue([{ id: "user_1" }]);
    const userDeleteMany = vi.fn().mockResolvedValue({ count: 1 });
    const signupDeleteMany = vi.fn().mockResolvedValue({ count: 2 });
    const demoDeleteMany = vi.fn().mockResolvedValue({ count: 3 });
    const loginDeleteMany = vi.fn().mockResolvedValue({ count: 4 });
    const client = {
      user: { findMany, deleteMany: userDeleteMany },
      signupEvent: { deleteMany: signupDeleteMany },
      demoEvent: { deleteMany: demoDeleteMany },
      loginAttempt: { deleteMany: loginDeleteMany },
    } as unknown as PrismaClient;

    const result = await runCleanup(client, new Date("2026-08-14T12:00:00.000Z"));

    expect(result).toEqual({
      deletedDemoUsers: 1,
      deletedSignupEvents: 2,
      deletedDemoEvents: 3,
      deletedLoginAttempts: 4,
    });
  });

  it("応答（戻り値）にユーザーIDやデータの中身を含まない。件数のキーだけ", async () => {
    const findMany = vi.fn().mockResolvedValue([{ id: "user_should_not_leak" }]);
    const userDeleteMany = vi.fn().mockResolvedValue({ count: 1 });
    const client = {
      user: { findMany, deleteMany: userDeleteMany },
      signupEvent: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      demoEvent: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      loginAttempt: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
    } as unknown as PrismaClient;

    const result = await runCleanup(client, new Date("2026-08-14T12:00:00.000Z"));

    expect(Object.keys(result).sort()).toEqual([
      "deletedDemoEvents",
      "deletedDemoUsers",
      "deletedLoginAttempts",
      "deletedSignupEvents",
    ]);
    expect(JSON.stringify(result)).not.toContain("user_should_not_leak");
  });
});

beforeEach(() => {
  vi.clearAllMocks();
});
