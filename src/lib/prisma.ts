import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "@/generated/prisma/client";

/**
 * Prisma Client のシングルトン。
 *
 * - Prisma 7 はドライバアダプタ必須のため @prisma/adapter-pg（pg）を渡す
 * - 接続文字列はサーバー側の環境変数 DATABASE_URL のみから読む。
 *   ハードコードしない。NEXT_PUBLIC_ に置かない
 * - 開発時の HMR / Next.js の再コンパイルでコネクションプールが増え続けないよう
 *   globalThis にキャッシュする
 * - 生成は遅延させる。`import` しただけでは接続文字列を読まないため、
 *   DB を使わないテストからこのモジュールを import しても失敗しない
 *
 * このモジュールはサーバー専用。Client Component から import しないこと。
 */

export type EnvSource = Record<string, string | undefined>;

/** DATABASE_URL を読む。未設定・空文字なら Error を投げる */
export function getDatabaseUrl(env: EnvSource = process.env): string {
  const value = env.DATABASE_URL;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("DATABASE_URL is not set");
  }
  return value;
}

/**
 * アダプタ付きの PrismaClient を新規に生成する。キャッシュしないため、
 * 呼び出し側が使い終わったら `$disconnect()` すること。
 */
export function createPrismaClient(connectionString: string = getDatabaseUrl()): PrismaClient {
  const adapter = new PrismaPg({ connectionString });
  return new PrismaClient({ adapter });
}

const globalForPrisma = globalThis as unknown as {
  __kakeiboPrisma?: PrismaClient;
};

/**
 * 共有の PrismaClient を返す。初回呼び出し時に生成し、以降は同じインスタンスを返す。
 */
export function getPrismaClient(): PrismaClient {
  const cached = globalForPrisma.__kakeiboPrisma;
  if (cached) return cached;

  const client = createPrismaClient();
  globalForPrisma.__kakeiboPrisma = client;
  return client;
}

/**
 * アプリ全体で共有する PrismaClient。
 *
 * 実体は遅延生成のための Proxy で、プロパティに初めて触れた時点で
 * `getPrismaClient()` が呼ばれる。`prisma.expense.findMany()` のように
 * 通常の PrismaClient と同じく使える。
 */
export const prisma: PrismaClient = new Proxy({} as PrismaClient, {
  get(_target, property) {
    const client = getPrismaClient();
    const value: unknown = Reflect.get(client, property, client);
    return typeof value === "function" ? value.bind(client) : value;
  },
});

export default prisma;
