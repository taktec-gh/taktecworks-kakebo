// @vitest-environment node
//
// prisma/schema.prisma をテキストとして読み、壊れると被害の大きい制約が
// 存在することを検証する。実データベースには接続しない
// （docs/steps/step-2.md「テストの方針」）。
//
// ここではスキーマファイルをテキスト解析するだけで、実際に
// `prisma migrate` や Postgres の型検査を行うわけではない。
// そのため「制約が書かれていること」を検証できるが、
// 「制約が Postgres 上で正しく機能すること」の保証はできない
// （後者は実 DB を使う結合テストの領域であり、Step 2 の方針により対象外）。

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SCHEMA_PATH = fileURLToPath(new URL("../../prisma/schema.prisma", import.meta.url));
const schemaText = readFileSync(SCHEMA_PATH, "utf8");

/** `model Name { ... }` のブロック本文を取り出す。閉じ括弧は行頭の `}` のみを対象にする */
function extractModel(name: string): string {
  const match = schemaText.match(new RegExp(`model ${name} \\{([\\s\\S]*?)\\n\\}`, "m"));
  if (!match) throw new Error(`model ${name} が schema.prisma に見つからない`);
  return match[1];
}

/** `enum Name { ... }` のブロック本文を取り出す */
function extractEnum(name: string): string {
  const match = schemaText.match(new RegExp(`enum ${name} \\{([\\s\\S]*?)\\n\\}`, "m"));
  if (!match) throw new Error(`enum ${name} が schema.prisma に見つからない`);
  return match[1];
}

function fieldLine(modelBody: string, fieldName: string): string {
  const line = modelBody
    .split("\n")
    .find((l) => new RegExp(`^\\s*${fieldName}\\s+`).test(l));
  if (line === undefined) {
    throw new Error(`フィールド ${fieldName} が見つからない: ${modelBody}`);
  }
  return line;
}

describe("enum", () => {
  // 出典: docs/steps/step-2.md の enum 表（features.md から導出済み）
  it("PaymentSourceType は CASH / CREDIT_CARD / BANK_DEBIT の3種類（features.md「払い出し先のタイプは3種類」）", () => {
    const body = extractEnum("PaymentSourceType");
    const values = body
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    expect(values).toEqual(["CASH", "CREDIT_CARD", "BANK_DEBIT"]);
  });

  it("WasteTag は NECESSARY / WASTE / INVESTMENT の3択（features.md「必要・浪費・投資 の3択」）", () => {
    const body = extractEnum("WasteTag");
    const values = body
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    expect(values).toEqual(["NECESSARY", "WASTE", "INVESTMENT"]);
  });

  it("CostType は FIXED / VARIABLE（features.md「固定費/変動費 属性」）", () => {
    const body = extractEnum("CostType");
    const values = body
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    expect(values).toEqual(["FIXED", "VARIABLE"]);
  });
});

describe("PaymentSource", () => {
  const body = extractModel("PaymentSource");

  it("name はユニーク", () => {
    expect(fieldLine(body, "name")).toMatch(/@unique/);
  });

  it("isActive の既定値は true（無効化は削除ではなくフラグ）", () => {
    expect(fieldLine(body, "isActive")).toMatch(/@default\(true\)/);
  });

  it("isDefault の既定値は false", () => {
    expect(fieldLine(body, "isDefault")).toMatch(/@default\(false\)/);
  });

  it("isDefault=true は全体で最大1件（部分ユニークインデックス）", () => {
    // 出典: docs/steps/step-2.md「isDefault は全体で1件のみ true であるべき。
    // DB制約で強制できる方法（部分ユニークインデックス等）があれば入れる」
    expect(body).toMatch(/@@unique\(\[isDefault\],\s*where:\s*\{\s*isDefault:\s*true\s*\}\)/);
  });
});

describe("Category", () => {
  const body = extractModel("Category");

  it("name はユニーク", () => {
    expect(fieldLine(body, "name")).toMatch(/@unique/);
  });

  it("isHidden の既定値は false（非表示は削除ではなくフラグ）", () => {
    expect(fieldLine(body, "isHidden")).toMatch(/@default\(false\)/);
  });
});

describe("Expense", () => {
  const body = extractModel("Expense");

  it("date は日付のみ保持する @db.Date（タイムゾーンの影響を受けない）", () => {
    expect(fieldLine(body, "date")).toMatch(/DateTime\s+@db\.Date/);
  });

  it("amountYen は Int（金額は整数円）", () => {
    expect(fieldLine(body, "amountYen")).toMatch(/^\s*amountYen\s+Int\s*$/);
  });

  it("category への参照は onDelete: Restrict（参照先カテゴリの削除を防ぐ）", () => {
    const line = body.split("\n").find((l) => l.includes("@relation") && l.includes("Category"));
    expect(line).toBeDefined();
    expect(line).toMatch(/onDelete:\s*Restrict/);
  });

  it("paymentSource への参照は onDelete: Restrict（参照先払い出し先の削除を防ぐ）", () => {
    const line = body
      .split("\n")
      .find((l) => l.includes("@relation") && l.includes("PaymentSource"));
    expect(line).toBeDefined();
    expect(line).toMatch(/onDelete:\s*Restrict/);
  });

  it("wasteTag は nullable にしない（無駄使い検出の中核）", () => {
    // 型に `?` が付いていないことを確認する
    expect(fieldLine(body, "wasteTag")).toMatch(/^\s*wasteTag\s+WasteTag\s*$/);
  });

  it("ダッシュボード・一覧の絞り込み用インデックスが date / (date, categoryId) / (date, paymentSourceId) にある", () => {
    expect(body).toContain("@@index([date])");
    expect(body).toContain("@@index([date, categoryId])");
    expect(body).toContain("@@index([date, paymentSourceId])");
  });
});

describe("Budget（払い出し先の月次予算＝主軸）", () => {
  const body = extractModel("Budget");

  it("同一払い出し先・同一月に2件許さない @@unique([paymentSourceId, yearMonth])", () => {
    expect(body).toContain("@@unique([paymentSourceId, yearMonth])");
  });

  it("yearMonth は VarChar(7)（Char(7) だと末尾空白パディングで === 比較が壊れるため）", () => {
    expect(fieldLine(body, "yearMonth")).toMatch(/String\s+@db\.VarChar\(7\)/);
  });

  it("amountYen は Int（金額は整数円）", () => {
    expect(fieldLine(body, "amountYen")).toMatch(/^\s*amountYen\s+Int\s*$/);
  });

  it("paymentSource への参照は onDelete: Cascade（払い出し先を消したら予算も消える）", () => {
    const line = body.split("\n").find((l) => l.includes("@relation"));
    expect(line).toBeDefined();
    expect(line).toMatch(/onDelete:\s*Cascade/);
  });
});

describe("CategoryBudget（カテゴリの任意予算＝補助上限）", () => {
  const body = extractModel("CategoryBudget");

  it("同一カテゴリ・同一月に2件許さない @@unique([categoryId, yearMonth])", () => {
    expect(body).toContain("@@unique([categoryId, yearMonth])");
  });

  it("yearMonth は VarChar(7)", () => {
    expect(fieldLine(body, "yearMonth")).toMatch(/String\s+@db\.VarChar\(7\)/);
  });

  it("category への参照は onDelete: Cascade（カテゴリを消したら予算も消える）", () => {
    const line = body.split("\n").find((l) => l.includes("@relation"));
    expect(line).toBeDefined();
    expect(line).toMatch(/onDelete:\s*Cascade/);
  });
});

describe("Income（収入＝今月使える原資）", () => {
  const body = extractModel("Income");

  it("yearMonth は VarChar(7)", () => {
    expect(fieldLine(body, "yearMonth")).toMatch(/String\s+@db\.VarChar\(7\)/);
  });

  it("yearMonth にインデックスがある", () => {
    expect(body).toContain("@@index([yearMonth])");
  });

  it("1ヶ月に複数件登録できるため @@unique を付けない（features.md「収支管理はせず、原資としてのみ扱う」）", () => {
    expect(body).not.toContain("@@unique");
  });

  it("amountYen は Int", () => {
    expect(fieldLine(body, "amountYen")).toMatch(/^\s*amountYen\s+Int\s*$/);
  });

  it("label は任意（「給与」「賞与」など未入力でもよい）", () => {
    expect(fieldLine(body, "label")).toMatch(/String\?/);
  });
});

describe("共通規約", () => {
  it.each(["PaymentSource", "Category", "Expense", "Budget", "CategoryBudget", "Income"])(
    "%s の id は String @id @default(cuid())",
    (name) => {
      const body = extractModel(name);
      expect(fieldLine(body, "id")).toMatch(/String\s+@id\s+@default\(cuid\(\)\)/);
    },
  );

  it.each(["PaymentSource", "Category", "Expense", "Budget", "CategoryBudget", "Income"])(
    "%s に createdAt / updatedAt がある",
    (name) => {
      const body = extractModel(name);
      expect(fieldLine(body, "createdAt")).toMatch(/DateTime\s+@default\(now\(\)\)/);
      expect(fieldLine(body, "updatedAt")).toMatch(/DateTime\s+@updatedAt/);
    },
  );
});
