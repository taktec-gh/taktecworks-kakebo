// @vitest-environment node
//
// src/lib/demo-limits.ts（デモアカウント作成のレート制限）を検証する。
// 実データベースには接続せず PrismaClient をモックする。
//
// 期待値の根拠:
// - docs/steps/pub-3.md 設計判断 4「デモ作成のレート制限」
//   「IP単位: 1時間に5件」「全体: 24時間に300件」
//   「数えるのは作られたデモユーザー」「DemoEvent は userId を持たない」
//   「DemoEvent も SignupEvent と分ける」
// - docs/steps/pub-3.md「実装完了後の引き継ぎ」
//   「1時間5件・24時間300件。isDemoLimitReached（純粋、>=）、isDemoRateLimited、
//    recordDemoEvent(tx, ipHash)。demoEvent だけを数える」
// - docs/steps/pub-3.md「tester 向けの方針」7
//   「IP 単位（5件目までは作れて6件目で止まる）、全体（300件）の境界、時間窓の外は数えない、
//    SignupEvent と数を共有しない」
// - 手計算:
//   IP単位: 5件までは作れて6件目で止まる（>= 5 で reached）
//   全体: 300件までは作れて301件目で止まる（>= 300）
// - tests/lib/signup-limits.test.ts と同じ形（pub-3.md「tester 向けの方針」の手本）

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import {
  countRecentDemos,
  countRecentDemosByIp,
  DEMO_GLOBAL_MAX,
  DEMO_GLOBAL_WINDOW_HOURS,
  DEMO_IP_MAX,
  DEMO_IP_WINDOW_MINUTES,
  getDemoGlobalWindowStart,
  getDemoIpWindowStart,
  isDemoLimitReached,
  isDemoRateLimited,
  recordDemoEvent,
} from "@/lib/demo-limits";

describe("定数（docs/steps/pub-3.md 設計判断 4 の表）", () => {
  it("IP単位: 1時間に5件", () => {
    expect(DEMO_IP_WINDOW_MINUTES).toBe(60);
    expect(DEMO_IP_MAX).toBe(5);
  });

  it("全体: 24時間に300件", () => {
    expect(DEMO_GLOBAL_WINDOW_HOURS).toBe(24);
    expect(DEMO_GLOBAL_MAX).toBe(300);
  });
});

describe("getDemoIpWindowStart / getDemoGlobalWindowStart", () => {
  it("IP単位の時間窓の開始は now の60分前", () => {
    const now = new Date("2026-08-14T12:00:00.000Z");
    expect(getDemoIpWindowStart(now)).toEqual(new Date("2026-08-14T11:00:00.000Z"));
  });

  it("全体の時間窓の開始は now の24時間前", () => {
    const now = new Date("2026-08-14T12:00:00.000Z");
    expect(getDemoGlobalWindowStart(now)).toEqual(new Date("2026-08-13T12:00:00.000Z"));
  });
});

describe("countRecentDemosByIp / countRecentDemos", () => {
  function createMockClient() {
    const count = vi.fn();
    const client = { demoEvent: { count } } as unknown as PrismaClient;
    return { client, count };
  }

  it("countRecentDemosByIp は ipHash と createdAt >= 窓の開始 で数える（demoEvent、signupEvent ではない）", async () => {
    const { client, count } = createMockClient();
    count.mockResolvedValue(2);
    const now = new Date("2026-08-14T12:00:00.000Z");

    await expect(countRecentDemosByIp(client, "hash-1", now)).resolves.toBe(2);
    expect(count).toHaveBeenCalledWith({
      where: { ipHash: "hash-1", createdAt: { gte: new Date("2026-08-14T11:00:00.000Z") } },
    });
  });

  it("countRecentDemos は ipHash を含めず、全体で createdAt >= 窓の開始 で数える", async () => {
    const { client, count } = createMockClient();
    count.mockResolvedValue(120);
    const now = new Date("2026-08-14T12:00:00.000Z");

    await expect(countRecentDemos(client, now)).resolves.toBe(120);
    expect(count).toHaveBeenCalledWith({
      where: { createdAt: { gte: new Date("2026-08-13T12:00:00.000Z") } },
    });
  });
});

describe("isDemoLimitReached（純粋関数。>= で判定＝境界のずれに敏感）", () => {
  it("IP単位が5件未満・全体が300件未満なら reached=false（例: IP4件・全体200件）", () => {
    expect(isDemoLimitReached({ ipCount: 4, globalCount: 200 })).toBe(false);
  });

  it("IP単位がちょうど5件なら reached=true（5件目までは作れて6件目で止まる、の境界）", () => {
    expect(isDemoLimitReached({ ipCount: 5, globalCount: 0 })).toBe(true);
  });

  it("IP単位が4件（5件未満）なら reached=false", () => {
    expect(isDemoLimitReached({ ipCount: 4, globalCount: 0 })).toBe(false);
  });

  it("IP単位が6件（5件超）でも当然 reached=true", () => {
    expect(isDemoLimitReached({ ipCount: 6, globalCount: 0 })).toBe(true);
  });

  it("全体がちょうど300件なら reached=true（300件目までは作れて301件目で止まる、の境界）", () => {
    expect(isDemoLimitReached({ ipCount: 0, globalCount: 300 })).toBe(true);
  });

  it("全体が299件（300件未満）なら reached=false", () => {
    expect(isDemoLimitReached({ ipCount: 0, globalCount: 299 })).toBe(false);
  });

  it("IP単位・全体のどちらかが達していれば true（OR 条件）", () => {
    expect(isDemoLimitReached({ ipCount: 5, globalCount: 0 })).toBe(true);
    expect(isDemoLimitReached({ ipCount: 0, globalCount: 300 })).toBe(true);
  });

  it("両方とも0件なら reached=false", () => {
    expect(isDemoLimitReached({ ipCount: 0, globalCount: 0 })).toBe(false);
  });
});

describe("isDemoRateLimited（IP単位・全体の両方を見る。時間窓の外は数えない）", () => {
  function createMockClient(ipCount: number, globalCount: number) {
    const count = vi.fn(async (args: { where: Record<string, unknown> }) => {
      return "ipHash" in args.where ? ipCount : globalCount;
    });
    const client = { demoEvent: { count } } as unknown as PrismaClient;
    return { client, count };
  }

  it("IP単位・全体ともに上限未満なら false", async () => {
    const { client } = createMockClient(4, 200);
    await expect(isDemoRateLimited(client, "hash-1")).resolves.toBe(false);
  });

  it("IP単位がちょうど5件なら true（6件目を弾く）", async () => {
    const { client } = createMockClient(5, 0);
    await expect(isDemoRateLimited(client, "hash-1")).resolves.toBe(true);
  });

  it("全体がちょうど300件なら true（301件目を弾く）", async () => {
    const { client } = createMockClient(0, 300);
    await expect(isDemoRateLimited(client, "hash-1")).resolves.toBe(true);
  });

  it("時間窓の外（1時間より前）の記録は数えない: count クエリの createdAt.gte が正しい窓を指す", async () => {
    const { client, count } = createMockClient(0, 0);
    const now = new Date("2026-08-14T12:00:00.000Z");

    await isDemoRateLimited(client, "hash-1", now);

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

describe("recordDemoEvent（デモユーザー作成と同じトランザクションで1件書く）", () => {
  it("demoEvent.create を ipHash だけで呼ぶ（userId を渡さない。3つ目の例外）", async () => {
    const create = vi.fn();
    const tx = { demoEvent: { create } } as unknown as Prisma.TransactionClient;

    await recordDemoEvent(tx, "hash-1");

    expect(create).toHaveBeenCalledWith({ data: { ipHash: "hash-1" } });
    expect(create.mock.calls[0][0].data).not.toHaveProperty("userId");
  });
});

describe("DemoEvent は SignupEvent と数を共有しない（別テーブル）", () => {
  it("demoEvent.count だけを呼び、signupEvent.count は呼ばない", async () => {
    const demoCount = vi.fn().mockResolvedValue(0);
    const signupCount = vi.fn().mockResolvedValue(999); // 万一混ざっていたら数が混入して検出できる
    const client = {
      demoEvent: { count: demoCount },
      signupEvent: { count: signupCount },
    } as unknown as PrismaClient;

    await expect(isDemoRateLimited(client, "hash-1")).resolves.toBe(false);
    expect(demoCount).toHaveBeenCalled();
    expect(signupCount).not.toHaveBeenCalled();
  });
});

beforeEach(() => {
  vi.clearAllMocks();
});
