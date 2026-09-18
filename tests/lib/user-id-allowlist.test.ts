// @vitest-environment node
//
// UserId を作れる場所の許可リスト（docs/steps/pub-1.md 設計判断 7・「その他の観点」1）。
//
// src/ を走査し、
// - `as UserId` の出現は定義ファイル src/lib/user-id.ts の中だけであること
// - `brandUserIdFromTrustedSource(` の呼び出しは、許可リストの3ファイルだけであること
// を確認する。
//
// 期待値の根拠:
// - docs/steps/pub-1.md 設計判断 7「UserId はブランド型にし、作れる場所を3箇所に限る」
//   「呼び出してよい場所」の表:
//   | src/lib/auth.ts のセッション検証 | 署名を検証した JWT の sub |
//   | src/app/(auth)/login/passkey-actions.ts の認証成功後 | 署名を検証したパスキーの持ち主 |
//   | ユーザーを作る関数（設計判断 8） | サーバーが今作ったユーザー |
// - docs/steps/pub-1.md「実装完了後の引き継ぎ > 許可リストの検査について」
//   「`as UserId` は定義ファイル src/lib/user-id.ts の中にしかない。走査のテストでは、
//   定義ファイルを別扱いにして、`as UserId` の出現はこのファイルだけ、
//   `brandUserIdFromTrustedSource(` の呼び出しは許可リストの3ファイルだけ」
// - docs/steps/pub-1.md「実装完了後の引き継ぎ > モジュール構成」
//   「src/lib/users.ts — createUserWithPresets(client): Promise<UserId>」
//   （= ユーザーを作る関数はこのファイル）

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SRC_DIR = join(REPO_ROOT, "src");

/** UserId の定義ファイル。`as UserId` が唯一許されている場所 */
const DEFINITION_FILE = "src/lib/user-id.ts";

/** brandUserIdFromTrustedSource(...) を呼んでよいファイルの許可リスト（設計判断 7） */
const ALLOWED_CALLER_FILES = new Set([
  "src/lib/auth.ts",
  "src/app/(auth)/login/passkey-actions.ts",
  "src/lib/users.ts",
]);

/** src/ 以下の .ts / .tsx を再帰的に列挙する（テスト・型定義生成物は対象外） */
function listSourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "generated") continue; // Prisma Client の生成物は対象外
      found.push(...listSourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      found.push(full);
    }
  }
  return found;
}

function toRepoRelative(absPath: string): string {
  return relative(REPO_ROOT, absPath).split("\\").join("/");
}

const sourceFiles = listSourceFiles(SRC_DIR);

describe("UserId を作れる場所の許可リスト", () => {
  it("走査が空振りしていない（src/ 配下の .ts/.tsx を実際に読めている）", () => {
    expect(sourceFiles.length).toBeGreaterThan(50);
  });

  it("`as UserId` は src/lib/user-id.ts の中にしか無い", () => {
    const violations: { file: string; line: number }[] = [];

    for (const file of sourceFiles) {
      const relPath = toRepoRelative(file);
      if (relPath === DEFINITION_FILE) continue;

      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, index) => {
        if (/\bas\s+UserId\b/.test(line)) {
          violations.push({ file: relPath, line: index + 1 });
        }
      });
    }

    expect(
      violations,
      `as UserId が許可リスト外で使われています: ${violations
        .map((v) => `${v.file}:${v.line}`)
        .join(", ")}`,
    ).toEqual([]);
  });

  it("定義ファイル自身には `as UserId` が存在する（許可リストの検査が本当に効いていることの確認）", () => {
    const content = readFileSync(join(REPO_ROOT, DEFINITION_FILE), "utf8");
    expect(content).toMatch(/\bas\s+UserId\b/);
  });

  it("`brandUserIdFromTrustedSource(` の呼び出しは許可リストの3ファイルだけ", () => {
    const violations: { file: string; line: number }[] = [];
    const callerFiles = new Set<string>();

    for (const file of sourceFiles) {
      const relPath = toRepoRelative(file);
      if (relPath === DEFINITION_FILE) continue; // 定義自体（宣言）は呼び出しではない

      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, index) => {
        if (/\bbrandUserIdFromTrustedSource\s*\(/.test(line)) {
          callerFiles.add(relPath);
          if (!ALLOWED_CALLER_FILES.has(relPath)) {
            violations.push({ file: relPath, line: index + 1 });
          }
        }
      });
    }

    expect(
      violations,
      `brandUserIdFromTrustedSource の呼び出しが許可リスト外にあります: ${violations
        .map((v) => `${v.file}:${v.line}`)
        .join(", ")}`,
    ).toEqual([]);

    // 許可リストの3ファイルすべてが実際に呼んでいること（許可リストが形骸化していないか）
    expect([...callerFiles].sort()).toEqual([...ALLOWED_CALLER_FILES].sort());
  });

  it("定義ファイルの JSDoc に書かれている許可リストと、このテストの許可リストが一致する", () => {
    // docs/steps/pub-1.md「実装完了後の引き継ぎ」に「関数名は検索で見つけやすく」とあるとおり、
    // user-id.ts 側のコメントにも同じ3ファイルが列挙されているはず。ドキュメントとテストの
    // 許可リストがずれたまま放置されないよう、各ファイルパスが JSDoc 内に登場することを確認する。
    const content = readFileSync(join(REPO_ROOT, DEFINITION_FILE), "utf8");
    for (const file of ALLOWED_CALLER_FILES) {
      expect(content, `${DEFINITION_FILE} の JSDoc に ${file} の記載が見つかりません`).toContain(
        file.replace("src/", "src/"),
      );
    }
  });
});

describe("廃止したパスワードログイン・RECOVERY_MODE への参照が残っていない", () => {
  // 期待値の根拠: docs/steps/pub-1.md 設計判断 1「削除するもの: loginAction」
  // 「.env.example の APP_PASSWORD / RECOVERY_MODE」、
  // 「その他の観点」10.「loginAction / APP_PASSWORD / RECOVERY_MODE への参照が
  // src/ に残っていないこと」

  const FORBIDDEN_TOKENS = ["loginAction", "APP_PASSWORD", "RECOVERY_MODE"];

  it("src/ のどのファイルにも loginAction・APP_PASSWORD・RECOVERY_MODE が現れない", () => {
    const violations: { file: string; line: number; token: string }[] = [];

    for (const file of sourceFiles) {
      const relPath = toRepoRelative(file);
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, index) => {
        for (const token of FORBIDDEN_TOKENS) {
          if (line.includes(token)) {
            violations.push({ file: relPath, line: index + 1, token });
          }
        }
      });
    }

    expect(
      violations,
      `廃止済みのはずの識別子が残っています: ${violations
        .map((v) => `${v.file}:${v.line} (${v.token})`)
        .join(", ")}`,
    ).toEqual([]);
  });

  it("削除されたはずのモジュールがファイルとして存在しない", () => {
    for (const removed of [
      "src/app/(auth)/login/login-form.tsx",
      "src/app/(auth)/login/login-state.ts",
      "prisma/seed.ts",
    ]) {
      expect(() => readFileSync(join(REPO_ROOT, removed), "utf8")).toThrow();
    }
  });
});
