/**
 * 実DB（ローカルの Docker PostgreSQL）でのリカバリーコードの検証（docs/steps/pub-5.md「実装内容 5. 検証スクリプト」）。
 *
 *   npx tsx prisma/checks/recovery-code.ts
 *
 * 単体テストはモックなので、ユニーク制約・トランザクションの巻き戻し・条件つき更新（並んだ2つのリカバリーのうち
 * 片方だけが通ること）が PostgreSQL 上でどう効くかは保証できない。このスクリプトはそこを実DBで確かめる。
 *
 * - **接続先のホストが localhost / 127.0.0.1 以外なら何もせず終了コード1で終わる**
 * - 自分で作ったユーザーと記録（このスクリプト専用の ipHash）は、成否にかかわらず finally で削除する
 * - 出力は検査項目ごとの OK / NG だけ。**コードの平文・ハッシュ・接続文字列・ID は出さない**
 *   （コードはこのスクリプトの中で作って捨てる）
 */
import "dotenv/config";

import type { PrismaClient } from "@/generated/prisma/client";
import { createPrismaClient } from "@/lib/prisma";
import {
  formatRecoveryCode,
  generateRecoveryCode,
  hashRecoveryCode,
  isRecoveryCodeHash,
} from "@/lib/recovery-code";
import {
  completeRecoveryWithPasskey,
  findRecoveryUserIdByCodeHash,
  hasRecoveryCode,
  regenerateRecoveryCodeHash,
} from "@/lib/recovery-codes";
import type { UserId } from "@/lib/user-id";
import { createDemoUser, createUserWithPasskey } from "@/lib/users";
import { generateWebauthnUserId } from "@/lib/webauthn-user-id";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1"]);

/** このスクリプトが記録する SignupEvent / DemoEvent の ipHash。後片付けでこの値の行だけを消す */
const CHECK_IP_HASH = "recovery-code-check";

type CheckResult = { label: string; ok: boolean };

const results: CheckResult[] = [];

function record(label: string, ok: boolean): void {
  results.push({ label, ok });
  console.log(`${ok ? "OK" : "NG"}  ${label}`);
}

function errorCode(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : "unknown";
}

/** 例外を NG として記録する。例外の中身（値を含みうる）は出さず、エラーコードだけを出す */
async function check(label: string, run: () => Promise<boolean>): Promise<void> {
  try {
    record(label, await run());
  } catch (error) {
    record(`${label}（例外: ${errorCode(error)}）`, false);
  }
}

let credentialSeq = 0;

/** 検証用の資格情報（公開鍵はダミー。認証には使わない） */
function dummyCredential(deviceName: string) {
  credentialSeq += 1;
  return {
    credentialId: `recovery-code-check-${Date.now()}-${credentialSeq}`,
    publicKey: new Uint8Array([1, 2, 3, credentialSeq % 256]),
    counter: 0,
    transports: [],
    deviceName,
  };
}

async function storedHash(prisma: PrismaClient, userId: string): Promise<string | null> {
  const user = await prisma.user.findFirstOrThrow({
    where: { id: userId },
    select: { recoveryCodeHash: true },
  });
  return user.recoveryCodeHash;
}

async function countCredentials(prisma: PrismaClient, userId: string): Promise<number> {
  return prisma.credential.count({ where: { userId } });
}

/** 全テーブルの行数 */
async function countAll(prisma: PrismaClient): Promise<number[]> {
  return Promise.all([
    prisma.user.count(),
    prisma.paymentSource.count(),
    prisma.category.count(),
    prisma.expense.count(),
    prisma.budget.count(),
    prisma.categoryBudget.count(),
    prisma.income.count(),
    prisma.credential.count(),
    prisma.loginAttempt.count(),
    prisma.signupEvent.count(),
    prisma.demoEvent.count(),
  ]);
}

async function createRegularUser(
  prisma: PrismaClient,
  createdUserIds: string[],
  codeHash: string,
): Promise<UserId> {
  const created = await createUserWithPasskey(prisma, {
    webauthnUserId: generateWebauthnUserId(),
    credential: dummyCredential("端末A"),
    ipHash: CHECK_IP_HASH,
    recoveryCodeHash: codeHash,
  });
  if (!created.ok) throw new Error("createUserWithPasskey failed");
  createdUserIds.push(created.userId);
  return created.userId;
}

async function run(prisma: PrismaClient, createdUserIds: string[]): Promise<void> {
  // ---- 1. サインアップでハッシュだけが保存される ----
  const codeA = generateRecoveryCode();
  const hashA = hashRecoveryCode(codeA);
  const userA = await createRegularUser(prisma, createdUserIds, hashA);

  await check("1a. サインアップ（createUserWithPasskey）で、コードのハッシュ（64文字の16進）が保存される", async () => {
    const stored = await storedHash(prisma, userA);
    return stored === hashA && isRecoveryCodeHash(stored);
  });

  await check("1b. DB の値は平文（区切りなし・区切りあり・小文字）のどれとも一致しない", async () => {
    const stored = await storedHash(prisma, userA);
    const formatted = formatRecoveryCode(codeA);
    return stored !== codeA && stored !== formatted && stored !== formatted.toLowerCase();
  });

  // ---- 2. 照合（探索） ----
  await check("2a. コードのハッシュで利用者が見つかる", async () =>
    (await findRecoveryUserIdByCodeHash(prisma, hashA)) === userA,
  );

  await check("2b. 小文字・ハイフン無し・空白入りに正規化しても同じ利用者が見つかる", async () => {
    const formatted = formatRecoveryCode(codeA);
    const variants = [formatted.toLowerCase(), formatted.replace(/-/g, ""), ` ${formatted.replace(/-/g, " ")} `];
    const found = await Promise.all(
      variants.map((variant) => findRecoveryUserIdByCodeHash(prisma, hashRecoveryCode(variant))),
    );
    return found.every((id) => id === userA);
  });

  await check("2c. 別のコードでは見つからない", async () =>
    (await findRecoveryUserIdByCodeHash(prisma, hashRecoveryCode(generateRecoveryCode()))) === null,
  );

  await check("2d. 照合してもハッシュは変わらない（入力の時点では消費しない）", async () =>
    (await storedHash(prisma, userA)) === hashA,
  );

  // ---- 3. ユニーク制約 ----
  await check("3. 同じハッシュを別のユーザーに保存しようとすると一意制約違反（P2002）で拒否され、ユーザーが増えない", async () => {
    const before = await prisma.user.count();
    let code = "none";
    try {
      await createRegularUser(prisma, createdUserIds, hashA);
    } catch (error) {
      code = errorCode(error);
    }
    const after = await prisma.user.count();
    return code === "P2002" && after === before;
  });

  // ---- 4. デモユーザーは探索の対象にならない ----
  const demo = await createDemoUser(prisma, { ipHash: CHECK_IP_HASH, now: new Date() });
  createdUserIds.push(demo.userId);
  const demoHash = hashRecoveryCode(generateRecoveryCode());
  // アプリにデモユーザーへコードを付ける経路は無い。条件（demoExpiresAt: null）を確かめるため直接書き込む
  await prisma.user.update({ where: { id: demo.userId }, data: { recoveryCodeHash: demoHash } });

  await check("4a. デモユーザーは作成時にコードを持たない", async () => {
    const other = await createDemoUser(prisma, { ipHash: CHECK_IP_HASH, now: new Date() });
    createdUserIds.push(other.userId);
    return (await storedHash(prisma, other.userId)) === null;
  });

  await check("4b. デモユーザーのハッシュと一致しても探索で見つからない（demoExpiresAt: null の条件）", async () =>
    (await findRecoveryUserIdByCodeHash(prisma, demoHash)) === null,
  );

  // ---- 5. リカバリーの完了（資格情報の作成と差し替えが同じトランザクション） ----
  const hashA2 = hashRecoveryCode(generateRecoveryCode());
  await check("5a. 完了で資格情報が1件増え、ハッシュが新しいハッシュに差し替わる。古いパスキーは残る", async () => {
    const before = await countCredentials(prisma, userA);
    const result = await completeRecoveryWithPasskey(prisma, {
      userId: userA,
      expectedCodeHash: hashA,
      newCodeHash: hashA2,
      credential: dummyCredential("端末B"),
    });
    const after = await countCredentials(prisma, userA);
    return result.ok && after === before + 1 && (await storedHash(prisma, userA)) === hashA2;
  });

  await check("5b. 使ったコードではもう見つからず、新しいコードで見つかる", async () =>
    (await findRecoveryUserIdByCodeHash(prisma, hashA)) === null &&
    (await findRecoveryUserIdByCodeHash(prisma, hashA2)) === userA,
  );

  await check("5c. 同じコード（古いハッシュ）で2回目の完了は codeNotCurrent になり、資格情報は作られず、ハッシュも変わらない", async () => {
    const before = await countCredentials(prisma, userA);
    const result = await completeRecoveryWithPasskey(prisma, {
      userId: userA,
      expectedCodeHash: hashA,
      newCodeHash: hashRecoveryCode(generateRecoveryCode()),
      credential: dummyCredential("端末C"),
    });
    const after = await countCredentials(prisma, userA);
    return (
      !result.ok &&
      result.reason === "codeNotCurrent" &&
      after === before &&
      (await storedHash(prisma, userA)) === hashA2
    );
  });

  await check("5d. 資格情報IDが重複すると duplicate になり、ハッシュは差し替わらない", async () => {
    const existing = await prisma.credential.findFirstOrThrow({
      where: { userId: userA },
      select: { credentialId: true },
    });
    const before = await countCredentials(prisma, userA);
    const result = await completeRecoveryWithPasskey(prisma, {
      userId: userA,
      expectedCodeHash: hashA2,
      newCodeHash: hashRecoveryCode(generateRecoveryCode()),
      credential: { ...dummyCredential("端末D"), credentialId: existing.credentialId },
    });
    const after = await countCredentials(prisma, userA);
    return (
      !result.ok &&
      result.reason === "duplicate" &&
      after === before &&
      (await storedHash(prisma, userA)) === hashA2
    );
  });

  await check("5e. 別の利用者の ID で、その利用者のものでないハッシュを条件に完了しようとしても通らない", async () => {
    const codeB = hashRecoveryCode(generateRecoveryCode());
    const userB = await createRegularUser(prisma, createdUserIds, codeB);
    const before = await countCredentials(prisma, userB);
    const result = await completeRecoveryWithPasskey(prisma, {
      userId: userB,
      expectedCodeHash: hashA2,
      newCodeHash: hashRecoveryCode(generateRecoveryCode()),
      credential: dummyCredential("端末E"),
    });
    const after = await countCredentials(prisma, userB);
    return (
      !result.ok &&
      result.reason === "codeNotCurrent" &&
      after === before &&
      (await storedHash(prisma, userB)) === codeB &&
      (await storedHash(prisma, userA)) === hashA2
    );
  });

  // ---- 6. 同じコードで並んだ2つのリカバリー ----
  await check("6. 同じコードで同時に2回完了すると、1回だけ通り、資格情報は1件だけ増える", async () => {
    const before = await countCredentials(prisma, userA);
    const [first, second] = await Promise.all([
      completeRecoveryWithPasskey(prisma, {
        userId: userA,
        expectedCodeHash: hashA2,
        newCodeHash: hashRecoveryCode(generateRecoveryCode()),
        credential: dummyCredential("端末F"),
      }),
      completeRecoveryWithPasskey(prisma, {
        userId: userA,
        expectedCodeHash: hashA2,
        newCodeHash: hashRecoveryCode(generateRecoveryCode()),
        credential: dummyCredential("端末G"),
      }),
    ]);
    const after = await countCredentials(prisma, userA);
    const oks = [first, second].filter((result) => result.ok).length;
    const notCurrent = [first, second].filter(
      (result) => !result.ok && result.reason === "codeNotCurrent",
    ).length;
    const stored = await storedHash(prisma, userA);
    return oks === 1 && notCurrent === 1 && after === before + 1 && stored !== hashA2;
  });

  // ---- 7. 作り直し ----
  await check("7. 作り直すと古いコードでは見つからず、新しいコードで見つかる。発行済みの表示は true", async () => {
    const oldHash = await storedHash(prisma, userA);
    const newHash = hashRecoveryCode(generateRecoveryCode());
    const updated = await regenerateRecoveryCodeHash(prisma, userA, newHash);
    return (
      updated &&
      oldHash !== null &&
      (await findRecoveryUserIdByCodeHash(prisma, oldHash)) === null &&
      (await findRecoveryUserIdByCodeHash(prisma, newHash)) === userA &&
      (await hasRecoveryCode(prisma, userA))
    );
  });

  await check("7b. デモユーザー（コード無し）の発行済みの表示は false", async () => {
    const other = await createDemoUser(prisma, { ipHash: CHECK_IP_HASH, now: new Date() });
    createdUserIds.push(other.userId);
    return !(await hasRecoveryCode(prisma, other.userId));
  });

  await check("7c. 作り直しでも平文を渡すと拒否され、DB は変わらない", async () => {
    const before = await storedHash(prisma, userA);
    let threw = false;
    try {
      await regenerateRecoveryCodeHash(prisma, userA, generateRecoveryCode());
    } catch {
      threw = true;
    }
    return threw && (await storedHash(prisma, userA)) === before;
  });
}

async function main(): Promise<number> {
  const url = process.env.DATABASE_URL;
  if (typeof url !== "string" || url.length === 0) {
    console.error("DATABASE_URL が未設定のため中止しました");
    return 1;
  }
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    console.error("DATABASE_URL を解釈できないため中止しました");
    return 1;
  }
  if (!LOCAL_HOSTS.has(hostname)) {
    // 接続文字列そのものは出さない
    console.error("接続先が localhost / 127.0.0.1 ではないため、何もせず中止しました");
    return 1;
  }

  const prisma = createPrismaClient(url);
  const createdUserIds: string[] = [];
  let before: number[] | null = null;
  try {
    before = await countAll(prisma);
    await run(prisma, createdUserIds);
  } catch (error) {
    record(`検証の途中で例外（${errorCode(error)}）`, false);
  } finally {
    // 成否にかかわらず、作ったユーザーと記録を消す（ユーザーはカスケードで全データが消える）
    try {
      if (createdUserIds.length > 0) {
        await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
      }
      await Promise.all([
        prisma.demoEvent.deleteMany({ where: { ipHash: CHECK_IP_HASH } }),
        prisma.signupEvent.deleteMany({ where: { ipHash: CHECK_IP_HASH } }),
      ]);
      const after = await countAll(prisma);
      record(
        "後片付け: 全テーブルの件数が実行前と同じ",
        before !== null && JSON.stringify(before) === JSON.stringify(after),
      );
    } catch {
      record("後片付け: 作成したユーザー・記録の削除", false);
    }
    await prisma.$disconnect();
  }

  const failed = results.filter((result) => !result.ok).length;
  console.log(failed === 0 ? "\nすべて OK" : `\nNG が ${failed} 件あります`);
  return failed === 0 ? 0 : 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch(() => {
    console.error("検証スクリプトが異常終了しました");
    process.exitCode = 1;
  });
