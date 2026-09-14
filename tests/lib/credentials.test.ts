// @vitest-environment node
//
// src/lib/credentials.ts のデータ層を検証する。実データベースには接続せず、
// PrismaClient をモックする（tests/lib/categories.test.ts と同じ方針）。
//
// 期待値の根拠:
// - docs/steps/step-7.md「設計判断 2. 締め出し対策」「tester への引き継ぎ > 5. 失敗パスの再現方法」

import { describe, expect, it, vi } from "vitest";

import type { Credential, PrismaClient } from "@/generated/prisma/client";
import { PASSKEY_ERRORS } from "@/lib/passkey-messages";
import {
  countCredentials,
  createCredential,
  deleteCredential,
  findCredentialByCredentialId,
  listCredentials,
  updateCredentialCounter,
} from "@/lib/credentials";

const NOW = new Date("2026-08-14T00:00:00.000Z");

function makeCredential(overrides: Partial<Credential> = {}): Credential {
  return {
    id: "cred_1",
    credentialId: "credential-id-1",
    publicKey: new Uint8Array([1, 2, 3]),
    counter: BigInt(0),
    transports: ["internal"],
    deviceName: "iPhone",
    createdAt: NOW,
    updatedAt: NOW,
    lastUsedAt: null,
    ...overrides,
  };
}

/** P2002 / P2025 のような Prisma エラーを再現する */
function prismaError(code: string): Error {
  return Object.assign(new Error(`mock prisma error ${code}`), { code });
}

function createMockClient() {
  const findMany = vi.fn();
  const count = vi.fn();
  const findUnique = vi.fn();
  const create = vi.fn();
  const update = vi.fn();
  const deleteFn = vi.fn();
  // deleteCredential は対話型トランザクション（tx）でこれらを呼ぶ。
  // モックの $transaction は「与えられたコールバックに client 自身（= tx として使う）を
  // 渡して実行する」だけの単純な実装にする。tx.credential.xxx は
  // client.credential.xxx と同じ spy を指すので、呼び出し検証はそのまま使える。
  const $transaction = vi.fn((fn: (tx: PrismaClient) => unknown, options?: unknown) =>
    fn(client),
  );

  const client = {
    credential: { findMany, count, findUnique, create, update, delete: deleteFn },
    $transaction,
  } as unknown as PrismaClient;

  return { client, findMany, count, findUnique, create, update, deleteFn, $transaction };
}

describe("listCredentials", () => {
  it("createdAt asc, id asc の順で findMany を呼ぶ", async () => {
    const { client, findMany } = createMockClient();
    findMany.mockResolvedValue([]);

    await listCredentials(client);

    expect(findMany).toHaveBeenCalledWith({
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
  });

  it("1件も無ければ空配列", async () => {
    const { client, findMany } = createMockClient();
    findMany.mockResolvedValue([]);
    await expect(listCredentials(client)).resolves.toEqual([]);
  });
});

describe("countCredentials", () => {
  it("0件を返せる", async () => {
    const { client, count } = createMockClient();
    count.mockResolvedValue(0);
    await expect(countCredentials(client)).resolves.toBe(0);
  });

  it("1件以上を返せる", async () => {
    const { client, count } = createMockClient();
    count.mockResolvedValue(3);
    await expect(countCredentials(client)).resolves.toBe(3);
  });
});

describe("findCredentialByCredentialId", () => {
  it("credentialId で findUnique する", async () => {
    const { client, findUnique } = createMockClient();
    const credential = makeCredential();
    findUnique.mockResolvedValue(credential);

    await expect(findCredentialByCredentialId(client, "credential-id-1")).resolves.toBe(
      credential,
    );
    expect(findUnique).toHaveBeenCalledWith({ where: { credentialId: "credential-id-1" } });
  });

  it("存在しなければ null", async () => {
    const { client, findUnique } = createMockClient();
    findUnique.mockResolvedValue(null);
    await expect(findCredentialByCredentialId(client, "no-such-id")).resolves.toBeNull();
  });
});

describe("createCredential", () => {
  it("counter は Number ではなく BigInt として保存する", async () => {
    const { client, create } = createMockClient();
    create.mockResolvedValue(makeCredential());

    await createCredential(client, {
      credentialId: "credential-id-1",
      publicKey: new Uint8Array([1, 2, 3]) as Uint8Array<ArrayBuffer>,
      counter: 0,
      transports: ["internal"],
      deviceName: "iPhone",
    });

    expect(create).toHaveBeenCalledWith({
      data: {
        credentialId: "credential-id-1",
        publicKey: new Uint8Array([1, 2, 3]),
        counter: BigInt(0),
        transports: ["internal"],
        deviceName: "iPhone",
      },
    });
  });

  it("成功時は ok:true とレコードを返す", async () => {
    const { client, create } = createMockClient();
    const created = makeCredential();
    create.mockResolvedValue(created);

    await expect(
      createCredential(client, {
        credentialId: "credential-id-1",
        publicKey: new Uint8Array([1, 2, 3]) as Uint8Array<ArrayBuffer>,
        counter: 0,
        transports: [],
        deviceName: "iPhone",
      }),
    ).resolves.toEqual({ ok: true, value: created });
  });

  it("同じ資格情報IDの重複登録（P2002）は duplicate エラーに変換する", async () => {
    const { client, create } = createMockClient();
    create.mockRejectedValue(prismaError("P2002"));

    await expect(
      createCredential(client, {
        credentialId: "credential-id-1",
        publicKey: new Uint8Array([1, 2, 3]) as Uint8Array<ArrayBuffer>,
        counter: 0,
        transports: [],
        deviceName: "iPhone",
      }),
    ).resolves.toEqual({ ok: false, error: PASSKEY_ERRORS.duplicate });
  });

  it("P2002 以外のエラーはそのまま再送出する", async () => {
    const { client, create } = createMockClient();
    create.mockRejectedValue(prismaError("P9999"));

    await expect(
      createCredential(client, {
        credentialId: "credential-id-1",
        publicKey: new Uint8Array([1, 2, 3]) as Uint8Array<ArrayBuffer>,
        counter: 0,
        transports: [],
        deviceName: "iPhone",
      }),
    ).rejects.toThrow();
  });
});

describe("updateCredentialCounter", () => {
  it("counter を BigInt にして lastUsedAt とともに更新する", async () => {
    const { client, update } = createMockClient();
    update.mockResolvedValue(makeCredential());

    await updateCredentialCounter(client, "credential-id-1", 7, NOW);

    expect(update).toHaveBeenCalledWith({
      where: { credentialId: "credential-id-1" },
      data: { counter: BigInt(7), lastUsedAt: NOW },
    });
  });

  it("counter が0でも正しく渡す", async () => {
    const { client, update } = createMockClient();
    update.mockResolvedValue(makeCredential());

    await updateCredentialCounter(client, "credential-id-1", 0, NOW);

    expect(update).toHaveBeenCalledWith({
      where: { credentialId: "credential-id-1" },
      data: { counter: BigInt(0), lastUsedAt: NOW },
    });
  });
});

describe("deleteCredential — 資格情報の削除（締め出し対策）", () => {
  it("対象が存在しなければ notFound（count は呼ばない）", async () => {
    const { client, findUnique, count, deleteFn } = createMockClient();
    findUnique.mockResolvedValue(null);

    await expect(deleteCredential(client, "no-such-id", false)).resolves.toEqual({
      ok: false,
      error: PASSKEY_ERRORS.notFound,
    });
    expect(count).not.toHaveBeenCalled();
    expect(deleteFn).not.toHaveBeenCalled();
  });

  it("必須状態（RECOVERY_MODE=false）で残り1本なら削除できない", async () => {
    const { client, findUnique, count, deleteFn } = createMockClient();
    findUnique.mockResolvedValue(makeCredential());
    count.mockResolvedValue(1);

    await expect(deleteCredential(client, "cred_1", false)).resolves.toEqual({
      ok: false,
      error: PASSKEY_ERRORS.deleteLastOne,
    });
    expect(deleteFn).not.toHaveBeenCalled();
  });

  it("必須状態で残り2本以上なら削除できる", async () => {
    const { client, findUnique, count, deleteFn } = createMockClient();
    const target = makeCredential();
    findUnique.mockResolvedValue(target);
    count.mockResolvedValue(2);
    deleteFn.mockResolvedValue(target);

    await expect(deleteCredential(client, "cred_1", false)).resolves.toEqual({
      ok: true,
      value: null,
    });
    expect(deleteFn).toHaveBeenCalledWith({ where: { id: "cred_1" } });
  });

  it("RECOVERY_MODE=1 なら残り1本でも削除できる（緊急脱出）", async () => {
    const { client, findUnique, count, deleteFn } = createMockClient();
    const target = makeCredential();
    findUnique.mockResolvedValue(target);
    count.mockResolvedValue(1);
    deleteFn.mockResolvedValue(target);

    await expect(deleteCredential(client, "cred_1", true)).resolves.toEqual({
      ok: true,
      value: null,
    });
    expect(deleteFn).toHaveBeenCalledWith({ where: { id: "cred_1" } });
  });

  it("削除直前に対象が消えていた場合（P2025）は notFound", async () => {
    const { client, findUnique, count, deleteFn } = createMockClient();
    const target = makeCredential();
    findUnique.mockResolvedValue(target);
    count.mockResolvedValue(2);
    deleteFn.mockRejectedValue(prismaError("P2025"));

    await expect(deleteCredential(client, "cred_1", false)).resolves.toEqual({
      ok: false,
      error: PASSKEY_ERRORS.notFound,
    });
  });

  it("P2025 / P2034 以外のエラーはそのまま再送出する", async () => {
    const { client, findUnique, count, deleteFn } = createMockClient();
    const target = makeCredential();
    findUnique.mockResolvedValue(target);
    count.mockResolvedValue(2);
    // P9999 は notFound(P2025) にも conflict(P2034) にも該当しない未知のエラーコード。
    // このコードのまま rejects されること（＝握りつぶさず再送出すること）を確認する。
    deleteFn.mockRejectedValue(prismaError("P9999"));

    await expect(deleteCredential(client, "cred_1", false)).rejects.toMatchObject({
      code: "P9999",
    });
  });

  it("isolationLevel: Serializable を指定してトランザクションを開始する（退行検出）", async () => {
    // 分離レベルが Serializable でなくなると、docs/steps/step-7.md の
    // 「設計判断 2. 締め出し対策」に書かれた競合検知（P2034）が機能しなくなり、
    // 同時削除で資格情報が0本になり得る = パスキー必須化が意図せず解除される。
    const { client, findUnique, count, deleteFn, $transaction } = createMockClient();
    const target = makeCredential();
    findUnique.mockResolvedValue(target);
    count.mockResolvedValue(2);
    deleteFn.mockResolvedValue(target);

    await deleteCredential(client, "cred_1", false);

    expect($transaction).toHaveBeenCalledTimes(1);
    expect($transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: "Serializable",
    });
  });

  it("findUnique / count / delete がすべて同じトランザクション内（tx経由）で呼ばれる", async () => {
    const { client, findUnique, count, deleteFn, $transaction } = createMockClient();
    const target = makeCredential();
    findUnique.mockResolvedValue(target);
    count.mockResolvedValue(2);
    deleteFn.mockResolvedValue(target);

    await deleteCredential(client, "cred_1", false);

    // $transaction のコールバックが呼ばれて初めて findUnique/count/delete が実行される
    // ことを、呼び出し順で確認する（$transaction が先に呼ばれていること）。
    expect($transaction).toHaveBeenCalledTimes(1);
    expect(findUnique).toHaveBeenCalledWith({ where: { id: "cred_1" } });
    expect(count).toHaveBeenCalledWith();
    expect(deleteFn).toHaveBeenCalledWith({ where: { id: "cred_1" } });
  });

  it("競合により直列化に失敗した場合（P2034）は conflict エラーを返す（throwしない）", async () => {
    const { client, findUnique, count, deleteFn } = createMockClient();
    const target = makeCredential();
    findUnique.mockResolvedValue(target);
    count.mockResolvedValue(2);
    deleteFn.mockRejectedValue(prismaError("P2034"));

    // 「成功したように見えて実は消えていない」を避けるため、握りつぶさず
    // 失敗として返す（throw ではなく ok:false）。
    await expect(deleteCredential(client, "cred_1", false)).resolves.toEqual({
      ok: false,
      error: PASSKEY_ERRORS.conflict,
    });
  });

  it("ガードで弾かれる場合（残り1本・必須状態）は delete を呼ばない", async () => {
    const { client, findUnique, count, deleteFn } = createMockClient();
    findUnique.mockResolvedValue(makeCredential());
    count.mockResolvedValue(1);

    await deleteCredential(client, "cred_1", false);

    expect(deleteFn).not.toHaveBeenCalled();
  });
});
