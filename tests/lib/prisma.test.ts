// @vitest-environment node
//
// src/lib/prisma.ts の挙動を検証する。実データベースには接続しない
// （docs/steps/step-2.md「テストの方針」）。
//
// createPrismaClient / getPrismaClient はドライバアダプタ（pg）を使って
// PrismaClient を「構築」するだけで、プロセスがクエリを発行するまで
// ネットワーク接続を張らない（実測済み）。そのため接続先が存在しない
// 文字列を渡しても構築自体は同期的に成功する。この前提のもとで
// 「正しい入力から正しい構築ができること」「未設定/空文字を弾くこと」
// 「キャッシュの有無で挙動が変わること」を検証する。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PrismaClient } from "@/generated/prisma/client";
import defaultPrisma, {
  createPrismaClient,
  getDatabaseUrl,
  getPrismaClient,
  prisma,
} from "@/lib/prisma";

/** 実在しなくても構築だけなら成功する接続文字列 */
const DUMMY_URL = "postgresql://user:pass@127.0.0.1:1/dummy";

type GlobalWithPrismaCache = typeof globalThis & { __kakeiboPrisma?: PrismaClient };
const globalWithCache = globalThis as GlobalWithPrismaCache;

beforeEach(() => {
  delete globalWithCache.__kakeiboPrisma;
});

afterEach(() => {
  delete globalWithCache.__kakeiboPrisma;
  vi.unstubAllEnvs();
});

describe("getDatabaseUrl", () => {
  it("注入した env から値を返す", () => {
    expect(getDatabaseUrl({ DATABASE_URL: DUMMY_URL })).toBe(DUMMY_URL);
  });

  it("未設定なら throw", () => {
    expect(() => getDatabaseUrl({})).toThrow("DATABASE_URL is not set");
  });

  it("空文字なら throw", () => {
    expect(() => getDatabaseUrl({ DATABASE_URL: "" })).toThrow("DATABASE_URL is not set");
  });

  it("引数の env が優先され、process.env にフォールバックしない", () => {
    vi.stubEnv("DATABASE_URL", "from-process-env");
    expect(() => getDatabaseUrl({})).toThrow("DATABASE_URL is not set");
  });

  it("引数省略時は process.env を読む", () => {
    vi.stubEnv("DATABASE_URL", DUMMY_URL);
    expect(getDatabaseUrl()).toBe(DUMMY_URL);
  });

  it("テスト環境では既定で DATABASE_URL が読み込まれていない（.env を読まずにテストが走る）", () => {
    expect(process.env.DATABASE_URL).toBeUndefined();
  });
});

describe("createPrismaClient", () => {
  it("接続文字列を渡すと同期的に構築できる（ネットワークに接続しない）", () => {
    expect(() => createPrismaClient(DUMMY_URL)).not.toThrow();
  });

  it("呼び出すたびに新しいインスタンスを返す（キャッシュしない）", () => {
    const a = createPrismaClient(DUMMY_URL);
    const b = createPrismaClient(DUMMY_URL);
    expect(a).not.toBe(b);
  });

  it("引数省略時は process.env の DATABASE_URL を使う", () => {
    vi.stubEnv("DATABASE_URL", DUMMY_URL);
    expect(() => createPrismaClient()).not.toThrow();
  });

  it("引数省略時に DATABASE_URL が無ければ throw する", () => {
    expect(() => createPrismaClient()).toThrow("DATABASE_URL is not set");
  });
});

describe("getPrismaClient", () => {
  it("初回呼び出しでキャッシュに保存される", () => {
    vi.stubEnv("DATABASE_URL", DUMMY_URL);
    expect(globalWithCache.__kakeiboPrisma).toBeUndefined();
    getPrismaClient();
    expect(globalWithCache.__kakeiboPrisma).toBeDefined();
  });

  it("2回呼んでも同一インスタンスを返す", () => {
    vi.stubEnv("DATABASE_URL", DUMMY_URL);
    const a = getPrismaClient();
    const b = getPrismaClient();
    expect(a).toBe(b);
  });

  it("既にキャッシュがあれば、DATABASE_URL が未設定でも新規生成せずキャッシュを返す", () => {
    const marker = { __marker: true } as unknown as PrismaClient;
    globalWithCache.__kakeiboPrisma = marker;
    // DATABASE_URL は stub していない = 未設定。新規生成しようとすれば throw するはず
    expect(getPrismaClient()).toBe(marker);
  });
});

describe("prisma（遅延生成 Proxy）", () => {
  it("import しただけでは DATABASE_URL を読まない（未設定でも import 自体は成功している）", async () => {
    // このテストファイルの import 文自体が、DATABASE_URL 未設定の状態
    // （前段のテストで確認済み）で既に成功している。ここでは動的 import でも
    // 再現することを明示的に確認する
    vi.resetModules();
    await expect(import("@/lib/prisma")).resolves.toBeDefined();
  });

  it("プロパティに触れた時点で DATABASE_URL 未設定なら throw する", () => {
    expect(() => prisma.$connect).toThrow("DATABASE_URL is not set");
  });

  it("プロパティに触れた時点でキャッシュがあればそれを使う（新規生成しない）", () => {
    const marker = { flag: "cached-value" } as unknown as PrismaClient;
    globalWithCache.__kakeiboPrisma = marker;
    expect((prisma as unknown as { flag: string }).flag).toBe("cached-value");
  });

  it("関数プロパティはキャッシュされたクライアントに bind されて返る（分割代入しても動く）", () => {
    const marker = {
      greet(this: { name: string } | undefined) {
        return this?.name;
      },
      name: "kakeibo",
    } as unknown as PrismaClient;
    globalWithCache.__kakeiboPrisma = marker;

    const { greet } = prisma as unknown as { greet: () => string | undefined };
    expect(greet()).toBe("kakeibo");
  });

  it("default export と named export は同一の Proxy インスタンス", () => {
    expect(defaultPrisma).toBe(prisma);
  });
});
