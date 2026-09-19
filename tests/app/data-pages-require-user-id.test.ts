// @vitest-environment node
//
// データを出す全ページ（Server Component）が requireUserId() を呼び、その戻り値を
// データ層へ渡していることの静的な検査（docs/steps/pub-1.md「その他の観点」2）。
//
// 3つの [id] ページ（/expenses/[id]、/settings/categories/[id]、
// /settings/payment-sources/[id]）と、ダッシュボード（/）・/incomes は、
// 実際にレンダリングして requireUserId() の戻り値がデータ層の呼び出し引数と
// 一致することを個別のテストで確認済み
// （tests/app/expenses/[id]/page.test.tsx・tests/app/settings/categories/[id]/page.test.tsx・
// tests/app/settings/payment-sources/[id]/page.test.tsx・tests/app/page.test.tsx・
// tests/app/incomes/page.test.tsx）。
//
// 残りの「@/lib/prisma を import している全ページ」（budgets・expenses（一覧・新規）・
// settings/categories（一覧）・settings/passkeys・settings/payment-sources（一覧））は、
// 子コンポーネント（一覧・フォーム）ごとの表示テストは既にあるが、page.tsx 自体を
// レンダリングする配線テストは無い。ここでは全ページをレンダリングし直す代わりに、
// 「requireUserId() を呼び、その戻り値の変数がデータ層の呼び出しに再度使われているか」を
// ソースの静的な形で検査する（docs/steps/pub-1.md「実装内容 > 4. ページ」
// 「proxy のガードとは別に requireUserId() を呼び、データ層へ渡す」）。
//
// 期待値の根拠:
// - docs/steps/pub-1.md「実装内容 > 4. ページ」
//   「@/lib/prisma を import している全ページで、proxy のガードとは別に requireUserId() を
//   呼び、データ層へ渡す。proxy はセッションの有無しか見ず、ユーザーIDを渡せないため」

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SRC_APP_DIR = join(REPO_ROOT, "src", "app");

/** @/lib/prisma を import している page.tsx を再帰的に集める */
function findPrismaPages(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...findPrismaPages(full));
    } else if (entry.name === "page.tsx") {
      const content = readFileSync(full, "utf8");
      if (content.includes("@/lib/prisma")) found.push(full);
    }
  }
  return found;
}

function toRepoRelative(absPath: string): string {
  return relative(REPO_ROOT, absPath).split("\\").join("/");
}

describe("データを出す全ページが requireUserId() の値をデータ層へ渡す", () => {
  const pages = findPrismaPages(SRC_APP_DIR);

  it("走査が空振りしていない（@/lib/prisma を import しているページが実際に見つかる）", () => {
    expect(pages.length).toBeGreaterThanOrEqual(11);
  });

  it.each(pages.map((p) => [toRepoRelative(p), p] as const))(
    "%s は requireUserId() を呼び、その戻り値をデータ層の呼び出しで再利用している",
    (_relPath, absPath) => {
      const content = readFileSync(absPath, "utf8");

      expect(content).toMatch(/await\s+requireUserId\(\)/);

      const declarationMatch = content.match(
        /const\s+(\w+)\s*=\s*await\s+requireUserId\(\);/,
      );
      expect(
        declarationMatch,
        `requireUserId() の戻り値を変数に受けていません（例: const userId = await requireUserId();）`,
      ).not.toBeNull();

      const varName = declarationMatch![1];
      // 宣言以降にもう一度その変数名が登場していれば、データ層の呼び出しに
      // 再利用されている可能性が高い（proxy 同様に呼ぶだけで捨てていない）
      const occurrences = content.split(new RegExp(`\\b${varName}\\b`)).length - 1;
      expect(
        occurrences,
        `requireUserId() の戻り値（${varName}）が宣言以降どこにも使われていません`,
      ).toBeGreaterThan(1);
    },
  );
});
