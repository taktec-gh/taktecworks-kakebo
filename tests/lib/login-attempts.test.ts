// @vitest-environment node
//
// src/lib/login-attempts.ts を検証する。純粋関数（extractClientIp / hashIp /
// getWindowStart）と、PrismaClient をモックしたデータ層（recordLoginAttempt /
// countRecentFailures / isBlocked）の両方をここでまとめて見る。
//
// 期待値の根拠:
// - docs/steps/step-7.md「設計判断 4. レート制限は Neon にテーブル1つ」
// - docs/steps/step-7.md「特に壊れやすい箇所 > レート制限の境界・記録の保持・IP の扱い」
// - docs/steps/step-7.md「tester への引き継ぎ > 5. 失敗パスの再現方法」

import { describe, expect, it, vi } from "vitest";

import type { PrismaClient } from "@/generated/prisma/client";
import {
  RATE_LIMIT_MAX_FAILURES,
  RATE_LIMIT_WINDOW_MINUTES,
  UNKNOWN_IP,
  countRecentFailures,
  extractClientIp,
  getWindowStart,
  hashIp,
  isBlocked,
  recordLoginAttempt,
} from "@/lib/login-attempts";

describe("extractClientIp", () => {
  it("単一の IP をそのまま返す", () => {
    expect(extractClientIp("203.0.113.9")).toBe("203.0.113.9");
  });

  it("複数値のときは先頭を使う（Vercel が末尾に自身のプロキシを足すため）", () => {
    expect(extractClientIp("203.0.113.9, 70.41.3.18")).toBe("203.0.113.9");
  });

  it("先頭要素の前後の空白は trim する", () => {
    expect(extractClientIp("  203.0.113.9  , 70.41.3.18")).toBe("203.0.113.9");
  });

  it("ヘッダが無い（null）場合は 'unknown'", () => {
    expect(extractClientIp(null)).toBe(UNKNOWN_IP);
  });

  it("ヘッダが undefined の場合は 'unknown'", () => {
    expect(extractClientIp(undefined)).toBe(UNKNOWN_IP);
  });

  it("空文字の場合は 'unknown'", () => {
    expect(extractClientIp("")).toBe(UNKNOWN_IP);
  });

  it("カンマのみ・空白のみの場合は 'unknown'", () => {
    expect(extractClientIp(",")).toBe(UNKNOWN_IP);
    expect(extractClientIp("   ")).toBe(UNKNOWN_IP);
  });
});

describe("hashIp", () => {
  it("同じ IP・同じ鍵なら常に同じハッシュ", () => {
    const a = hashIp("203.0.113.9", "secret-a");
    const b = hashIp("203.0.113.9", "secret-a");
    expect(a).toBe(b);
  });

  it("生IPをそのまま含まない（16進文字列になる）", () => {
    const hashed = hashIp("203.0.113.9", "secret-a");
    expect(hashed).not.toContain("203.0.113.9");
    expect(hashed).toMatch(/^[0-9a-f]{64}$/);
  });

  it("鍵が違えば別のハッシュになる", () => {
    const a = hashIp("203.0.113.9", "secret-a");
    const b = hashIp("203.0.113.9", "secret-b");
    expect(a).not.toBe(b);
  });

  it("IP が違えば別のハッシュになる", () => {
    const a = hashIp("203.0.113.9", "secret-a");
    const b = hashIp("198.51.100.1", "secret-a");
    expect(a).not.toBe(b);
  });

  it("secret が空文字なら throw", () => {
    expect(() => hashIp("203.0.113.9", "")).toThrow("AUTH_SECRET is not set");
  });
});

describe("getWindowStart", () => {
  it(`現在時刻から${RATE_LIMIT_WINDOW_MINUTES}分引いた時刻`, () => {
    const now = new Date("2026-08-14T12:00:00.000Z");
    const start = getWindowStart(now);
    // 15分 = 900,000ms
    expect(start.getTime()).toBe(now.getTime() - 15 * 60_000);
    expect(start.toISOString()).toBe("2026-08-14T11:45:00.000Z");
  });
});

function createMockClient() {
  const count = vi.fn();
  const create = vi.fn();
  const client = { loginAttempt: { count, create } } as unknown as PrismaClient;
  return { client, count, create };
}

describe("recordLoginAttempt", () => {
  it("ipHash と succeeded を渡して create する", async () => {
    const { client, create } = createMockClient();
    create.mockResolvedValue({});

    await recordLoginAttempt(client, "hash-1", true);

    expect(create).toHaveBeenCalledWith({ data: { ipHash: "hash-1", succeeded: true } });
  });

  it("失敗も記録できる", async () => {
    const { client, create } = createMockClient();
    create.mockResolvedValue({});

    await recordLoginAttempt(client, "hash-1", false);

    expect(create).toHaveBeenCalledWith({ data: { ipHash: "hash-1", succeeded: false } });
  });
});

describe("countRecentFailures", () => {
  it("ipHash・succeeded:false・時間窓で絞り込む", async () => {
    const { client, count } = createMockClient();
    count.mockResolvedValue(0);
    const now = new Date("2026-08-14T12:00:00.000Z");

    await countRecentFailures(client, "hash-1", now);

    expect(count).toHaveBeenCalledWith({
      where: {
        ipHash: "hash-1",
        succeeded: false,
        createdAt: { gte: getWindowStart(now) },
      },
    });
  });

  it("count の結果をそのまま返す", async () => {
    const { client, count } = createMockClient();
    count.mockResolvedValue(7);
    await expect(countRecentFailures(client, "hash-1")).resolves.toBe(7);
  });
});

describe("isBlocked — レート制限の境界（10回目までは通り、11回目で弾く）", () => {
  it(`失敗が${RATE_LIMIT_MAX_FAILURES - 1}回（9回）なら false`, async () => {
    const { client, count } = createMockClient();
    count.mockResolvedValue(RATE_LIMIT_MAX_FAILURES - 1);
    await expect(isBlocked(client, "hash-1")).resolves.toBe(false);
  });

  it(`失敗が${RATE_LIMIT_MAX_FAILURES}回（10回）ちょうどで true（11回目の試行を弾く）`, async () => {
    const { client, count } = createMockClient();
    count.mockResolvedValue(RATE_LIMIT_MAX_FAILURES);
    await expect(isBlocked(client, "hash-1")).resolves.toBe(true);
  });

  it(`失敗が${RATE_LIMIT_MAX_FAILURES + 1}回を超えても true`, async () => {
    const { client, count } = createMockClient();
    count.mockResolvedValue(RATE_LIMIT_MAX_FAILURES + 1);
    await expect(isBlocked(client, "hash-1")).resolves.toBe(true);
  });

  it("失敗が0回なら false", async () => {
    const { client, count } = createMockClient();
    count.mockResolvedValue(0);
    await expect(isBlocked(client, "hash-1")).resolves.toBe(false);
  });

  it("15分経過すれば解除される（countRecentFailures が時間窓の外を数えないため）", async () => {
    // isBlocked は countRecentFailures（時間窓で絞り込み済み）の結果だけを見る。
    // 窓の外の失敗はそもそも count に含まれないので、DB 側で 0 になっていれば
    // 15分経過後は自動的に false になる、という契約をここで確認する。
    const { client, count } = createMockClient();
    count.mockResolvedValue(0); // 15分より前の失敗しか無い状態を模す
    const now = new Date("2026-08-14T12:20:00.000Z");

    await expect(isBlocked(client, "hash-1", now)).resolves.toBe(false);
    expect(count).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ createdAt: { gte: getWindowStart(now) } }),
      }),
    );
  });
});

describe("記録の保持 — 成功しても過去の失敗記録は消えない", () => {
  it("recordLoginAttempt(成功) は create しか呼ばない（deleteMany 等は無い）", async () => {
    const deleteMany = vi.fn();
    const client = {
      loginAttempt: { create: vi.fn().mockResolvedValue({}), deleteMany },
    } as unknown as PrismaClient;

    await recordLoginAttempt(client, "hash-1", true);

    expect(deleteMany).not.toHaveBeenCalled();
  });

  it("9回失敗→1回成功のあとも isBlocked は失敗記録の件数だけを見る（回避できない）", async () => {
    // 成功記録があっても、countRecentFailures は succeeded:false だけを数えるため
    // 失敗9件は消えたことにならない。ここでは「9件の失敗が残っている」状態を
    // count のモックで表現し、10件目の失敗で isBlocked が true に切り替わることを見る。
    const { client, count } = createMockClient();
    count.mockResolvedValueOnce(9); // 成功をはさんでも直近の失敗はまだ9件
    await expect(isBlocked(client, "hash-1")).resolves.toBe(false);

    count.mockResolvedValueOnce(10); // 10件目の失敗（回避できていない）
    await expect(isBlocked(client, "hash-1")).resolves.toBe(true);
  });
});
