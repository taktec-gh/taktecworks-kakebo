// @vitest-environment node
// node:fs / import.meta.url を素の形で使うため node 環境
// （tests/app/data-pages-require-user-id.test.ts 冒頭と同じ理由）。
//
// src/ にインラインの `style` 属性が無いことを静的に検査する。
//
// 期待値の根拠:
// - docs/steps/pub-4.md 設計判断 3「インラインの `style` 属性は `style-src` に
//   `'unsafe-inline'`（または `style-src-attr`）が無いとブラウザにブロックされるため使わない。
//   `style-src-attr 'unsafe-inline'` で許す方法は採らない（ポリシーに例外を作らず、
//   `src/` にインラインの `style` が無い状態を保つ。テストで `src/` を走査して検査できる）」
// - docs/steps/pub-4.md tester 向けの方針 6「インラインの `style` が無い — `src/` を走査し、
//   JSX の `style=` が無いこと（ポリシーに例外を作らないことの担保）」
//
// docs/steps/pub-1.md の tests/app/data-pages-require-user-id.test.ts と同じ考え方
// （src/ を再帰的に読み、正規表現で静的に検査する）。

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const SRC_DIR = join(REPO_ROOT, "src");

/** JSX / TSX のソースファイル（.ts / .tsx）を再帰的に集める。テスト自体・型定義は対象外 */
function findSourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      // 生成物（Prisma Client の出力）は対象外
      if (entry.name === "generated") continue;
      found.push(...findSourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
      found.push(full);
    }
  }
  return found;
}

function toRepoRelative(absPath: string): string {
  return relative(REPO_ROOT, absPath).split("\\").join("/");
}

/**
 * JSX のインラインの `style=` 属性らしき記述を検出する。
 * `style={{ ... }}` / `style={someVar}` / `style="..."` のいずれも対象。
 * `styles.css` のような識別子名や `className` は拾わないよう、属性境界（空白 or JSXタグの一部）を要求する。
 */
const INLINE_STYLE_ATTR_PATTERN = /[\s<]style\s*=\s*[{"']/;

describe("src/ にインラインの style 属性が無い", () => {
  const files = findSourceFiles(SRC_DIR);

  it("走査が空振りしていない（.ts/.tsx が実際に見つかる）", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it.each(files.map((f) => [toRepoRelative(f), f] as const))(
    "%s に JSX の style= 属性が無い",
    (_relPath, absPath) => {
      const content = readFileSync(absPath, "utf8");
      const match = content.match(INLINE_STYLE_ATTR_PATTERN);
      expect(
        match,
        `インラインの style 属性が見つかりました: ${match?.[0]}`,
      ).toBeNull();
    },
  );
});
