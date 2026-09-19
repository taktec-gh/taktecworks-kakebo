// @vitest-environment node
//
// src/lib/signup-limits.ts（サインアップのレート制限）を検証する。
// 実データベースには接続せず PrismaClient をモックする。
//
// 期待値の根拠:
// - docs/steps/pub-2.md 設計判断 5「サインアップのレート制限」
//   「IP単位: 1時間に3件」「全体: 24時間に100件」
//   「数えるのは『作られたアカウント』。開始（チャレンジ発行）や検証失敗は数えない」
//   「記録は新しいモデル SignupEvent（ipHash, createdAt）」
//   「SignupEvent は userId を持たない」
//   「開始時と完了時の両方で確認する」
// - docs/steps/pub-2.md「実装完了後の引き継ぎ」
//   「定数（1時間3件・24時間100件）、countRecentSignupsByIp / countRecentSignups /
//   isSignupLimitReached（純粋、>=）/ isSignupRateLimited / recordSignupEvent(tx, ipHash)」
// - 手計算:
//   IP単位: 3件までは作れて4件目で止まる（>= 3 で reached ＝ 3件目の時点で次を止める）
//   全体: 100件までは作れて101件目で止まる（>= 100）

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import {
  countRecentSignups,
  countRecentSignupsByIp,
  getSignupGlobalWindowStart,
  getSignupIpWindowStart,
  isSignupLimitReached,
  isSignupRateLimited,
  recordSignupEvent,
  SIGNUP_GLOBAL_MAX,
  SIGNUP_GLOBAL_WINDOW_HOURS,
  SIGNUP_IP_MAX,
  SIGNUP_IP_WINDOW_MINUTES,
} from "@/lib/signup-limits";

describe("定数（docs/steps/pub-2.md 設計判断 5 の表）", () => {
  it("IP単位: 1時間に3件", () => {
    expect(SIGNUP_IP_WINDOW_MINUTES).toBe(60);
    expect(SIGNUP_IP_MAX).toBe(3);
  });

  it("全体: 24時間に100件", () => {
    expect(SIGNUP_GLOBAL_WINDOW_HOURS).toBe(24);
    expect(SIGNUP_GLOBAL_MAX).toBe(100);
  });
});

describe("getSignupIpWindowStart / getSignupGlobalWindowStart", () => {
  it("IP単位の時間窓の開始は now の60分前（手計算: 60*60*1000=3,600,000ms）", () => {
    const now = new Date("2026-08-14T12:00:00.000Z");
    expect(getSignupIpWindowStart(now)).toEqual(new Date("2026-08-14T11:00:00.000Z"));
  });

  it("全体の時間窓の開始は now の24時間前", () => {
    const now = new Date("2026-08-14T12:00:00.000Z");
    expect(getSignupGlobalWindowStart(now)).toEqual(new Date("2026-08-13T12:00:00.000Z"));
  });
});

describe("countRecentSignupsByIp / countRecentSignups", () => {
  function createMockClient() {
    const count = vi.fn();
    const client = { signupEvent: { count } } as unknown as PrismaClient;
    return { client, count };
  }

  it("countRecentSignupsByIp は ipHash と createdAt >= 窓の開始 で数える", async () => {
    const { client, count } = createMockClient();
    count.mockResolvedValue(2);
    const now = new Date("2026-08-14T12:00:00.000Z");

    await expect(countRecentSignupsByIp(client, "hash-1", now)).resolves.toBe(2);
    expect(count).toHaveBeenCalledWith({
      where: { ipHash: "hash-1", createdAt: { gte: new Date("2026-08-14T11:00:00.000Z") } },
    });
  });

  it("countRecentSignups は ipHash を含めず、全体で createdAt >= 窓の開始 で数える", async () => {
    const { client, count } = createMockClient();
    count.mockResolvedValue(50);
    const now = new Date("2026-08-14T12:00:00.000Z");

    await expect(countRecentSignups(client, now)).resolves.toBe(50);
    expect(count).toHaveBeenCalledWith({
      where: { createdAt: { gte: new Date("2026-08-13T12:00:00.000Z") } },
    });
  });
});

describe("isSignupLimitReached（純粋関数。>= で判定＝境界のずれに敏感）", () => {
  it("IP単位が3件未満・全体が100件未満なら reached=false（例: IP2件・全体50件）", () => {
    expect(isSignupLimitReached({ ipCount: 2, globalCount: 50 })).toBe(false);
  });

  it("IP単位がちょうど3件なら reached=true（3件目までは作れて4件目で止まる、の境界）", () => {
    expect(isSignupLimitReached({ ipCount: 3, globalCount: 0 })).toBe(true);
  });

  it("IP単位が2件（3件未満）なら reached=false", () => {
    expect(isSignupLimitReached({ ipCount: 2, globalCount: 0 })).toBe(false);
  });

  it("IP単位が4件（3件超）でも当然 reached=true", () => {
    expect(isSignupLimitReached({ ipCount: 4, globalCount: 0 })).toBe(true);
  });

  it("全体がちょうど100件なら reached=true（100件目までは作れて101件目で止まる、の境界）", () => {
    expect(isSignupLimitReached({ ipCount: 0, globalCount: 100 })).toBe(true);
  });

  it("全体が99件（100件未満）なら reached=false", () => {
    expect(isSignupLimitReached({ ipCount: 0, globalCount: 99 })).toBe(false);
  });

  it("IP単位・全体のどちらかが達していれば true（OR 条件）", () => {
    expect(isSignupLimitReached({ ipCount: 3, globalCount: 0 })).toBe(true);
    expect(isSignupLimitReached({ ipCount: 0, globalCount: 100 })).toBe(true);
  });

  it("両方とも0件なら reached=false", () => {
    expect(isSignupLimitReached({ ipCount: 0, globalCount: 0 })).toBe(false);
  });
});

describe("isSignupRateLimited（IP単位・全体の両方を見る。時間窓の外は数えない）", () => {
  function createMockClient(ipCount: number, globalCount: number) {
    const count = vi.fn(async (args: { where: Record<string, unknown> }) => {
      // ipHash を含む呼び出しは IP 単位、含まなければ全体
      return "ipHash" in args.where ? ipCount : globalCount;
    });
    const client = { signupEvent: { count } } as unknown as PrismaClient;
    return { client, count };
  }

  it("IP単位・全体ともに上限未満なら false", async () => {
    const { client } = createMockClient(2, 50);
    await expect(isSignupRateLimited(client, "hash-1")).resolves.toBe(false);
  });

  it("IP単位がちょうど3件なら true（4件目を弾く）", async () => {
    const { client } = createMockClient(3, 0);
    await expect(isSignupRateLimited(client, "hash-1")).resolves.toBe(true);
  });

  it("全体がちょうど100件なら true（101件目を弾く）", async () => {
    const { client } = createMockClient(0, 100);
    await expect(isSignupRateLimited(client, "hash-1")).resolves.toBe(true);
  });

  it("時間窓の外（1時間より前）の記録は数えない: count クエリの createdAt.gte が正しい窓を指す", async () => {
    const { client, count } = createMockClient(0, 0);
    const now = new Date("2026-08-14T12:00:00.000Z");

    await isSignupRateLimited(client, "hash-1", now);

    const ipCall = count.mock.calls.find((args) => "ipHash" in args[0].where);
    const globalCall = count.mock.calls.find((args) => !("ipHash" in args[0].where));
    expect(ipCall?.[0].where).toMatchObject({
      createdAt: { gte: new Date("2026-08-14T11:00:00.000Z") },
    });
    expect(globalCall?.[0].where).toMatchObject({
      createdAt: { gte: new Date("2026-08-13T12:00:00.000Z") },
    });
  });
});

describe("recordSignupEvent（ユーザー作成と同じトランザクションで1件書く）", () => {
  it("signupEvent.create を ipHash だけで呼ぶ（userId を渡さない。設計判断 5 の例外）", async () => {
    const create = vi.fn();
    const tx = { signupEvent: { create } } as unknown as Prisma.TransactionClient;

    await recordSignupEvent(tx, "hash-1");

    expect(create).toHaveBeenCalledWith({ data: { ipHash: "hash-1" } });
    expect(create.mock.calls[0][0].data).not.toHaveProperty("userId");
  });
});

// isSignupRateLimited を並行実行しても壊れないことのメモ（設計判断 5 の許容事項）:
// 「確認と記録の間に同時に登録が来ると数件超えうる。許容する（直列化は費用に見合わない）」
// ため、ここでは並行時の厳密な直列化を検証しない（仕様上、意図的に検証しない）。
beforeEach(() => {
  vi.clearAllMocks();
});
