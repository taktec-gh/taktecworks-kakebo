// @vitest-environment node
//
// src/lib/users.ts の createUserWithPresets を検証する。
// 実データベースには接続せず、PrismaClient と @/lib/seed をモックする。
//
// 期待値の根拠:
// - docs/steps/pub-1.md 設計判断 8「createUserWithPresets(client): Promise<UserId> —
//   User を作り、同じトランザクションでプリセット（カテゴリ11件・払い出し先「現金」[既定]）を
//   投入する」
// - docs/steps/pub-1.md「実装完了後の引き継ぎ」
//   「src/lib/users.ts — createUserWithPresets(client): Promise<UserId>。
//   User 作成とプリセット投入を1トランザクション」
// - docs/steps/pub-1.md 設計判断 7「呼び出してよい場所」の1つ
//   （ユーザーを作る関数 = サーバーが今作ったユーザーの ID を brand してよい）
// - design-decisions.md「ユーザーIDを外部（フォーム・URL・Cookie）から受け取らない。
//   ID は DB が採番する」→ tx.user.create の data は {} であること（外部入力を渡さない）

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PrismaClient } from "@/generated/prisma/client";

const seedUserPresets = vi.fn();
vi.mock("@/lib/seed", () => ({
  seedUserPresets: (...args: unknown[]) => seedUserPresets(...args),
}));

const { createUserWithPresets } = await import("@/lib/users");

beforeEach(() => {
  seedUserPresets.mockReset();
});

function createMockClient() {
  const userCreate = vi.fn();
  const tx = {
    user: { create: userCreate },
  };
  const transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(tx));

  const client = {
    $transaction: transaction,
  } as unknown as PrismaClient;

  return { client, userCreate, transaction, tx };
}

describe("createUserWithPresets", () => {
  it("User を data: {} で作る（外部入力を渡さない。ID は DB が採番する）", async () => {
    const { client, userCreate } = createMockClient();
    userCreate.mockResolvedValue({ id: "user_1" });
    seedUserPresets.mockResolvedValue({ categories: [], paymentSources: [] });

    await createUserWithPresets(client);

    expect(userCreate).toHaveBeenCalledWith({ data: {}, select: { id: true } });
  });

  it("作成した User の id を UserId として seedUserPresets に渡す", async () => {
    const { client, userCreate, tx } = createMockClient();
    userCreate.mockResolvedValue({ id: "user_42" });
    seedUserPresets.mockResolvedValue({ categories: [], paymentSources: [] });

    await createUserWithPresets(client);

    expect(seedUserPresets).toHaveBeenCalledWith(tx, "user_42");
  });

  it("User 作成とプリセット投入が同じトランザクション（$transaction のコールバック内）で行われる", async () => {
    const { client, userCreate, transaction } = createMockClient();
    userCreate.mockResolvedValue({ id: "user_1" });
    seedUserPresets.mockResolvedValue({ categories: [], paymentSources: [] });

    await createUserWithPresets(client);

    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it("戻り値は作成したユーザーの id", async () => {
    const { client, userCreate } = createMockClient();
    userCreate.mockResolvedValue({ id: "user_99" });
    seedUserPresets.mockResolvedValue({ categories: [], paymentSources: [] });

    await expect(createUserWithPresets(client)).resolves.toBe("user_99");
  });

  it("User の id が空文字なら（ブランド化に失敗し）throw する。プリセットの投入は行われない", async () => {
    const { client, userCreate } = createMockClient();
    userCreate.mockResolvedValue({ id: "" });

    await expect(createUserWithPresets(client)).rejects.toThrow();
    expect(seedUserPresets).not.toHaveBeenCalled();
  });

  it("プリセット投入が失敗したら例外がそのまま伝播する（同一トランザクションなのでユーザーも作られない）", async () => {
    const { client, userCreate } = createMockClient();
    userCreate.mockResolvedValue({ id: "user_1" });
    seedUserPresets.mockRejectedValue(new Error("preset failed"));

    await expect(createUserWithPresets(client)).rejects.toThrow("preset failed");
  });
});
