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
// （後者は実 DB を使う結合テストの領域。docs/steps/pub-1.md 設計判断 9 の
//  prisma/checks/data-isolation.ts の担当であり、このテストの対象外）。
//
// 期待値の根拠: docs/steps/pub-1.md「その他の観点」9.
//   「全データモデルに userId、LoginAttempt には無い、name のユニークが (userId, name)、
//    既定の部分ユニークに userId、複合外部キー、User への Cascade」
// および設計判断 2〜5。

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

/** userId を持つ全データモデル（LoginAttempt を除く。pub-1.md 設計判断 3 の表） */
const USER_SCOPED_MODELS = [
  "PaymentSource",
  "Category",
  "Expense",
  "Budget",
  "CategoryBudget",
  "Income",
  "Credential",
];

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

describe("User（設計判断 2: 最小限のモデル）", () => {
  const body = extractModel("User");

  it("id は String @id @default(cuid())", () => {
    expect(fieldLine(body, "id")).toMatch(/String\s+@id\s+@default\(cuid\(\)\)/);
  });

  it("表示名・メールアドレス・デモかどうか・有効期限を持たない（設計判断 2）", () => {
    for (const forbidden of ["email", "name", "isDemo", "expiresAt", "displayName"]) {
      expect(body).not.toMatch(new RegExp(`^\\s*${forbidden}\\s`, "m"));
    }
  });

  it("createdAt / updatedAt を持つ", () => {
    expect(fieldLine(body, "createdAt")).toMatch(/DateTime\s+@default\(now\(\)\)/);
    expect(fieldLine(body, "updatedAt")).toMatch(/DateTime\s+@updatedAt/);
  });
});

describe(`userId を持つデータモデル（${USER_SCOPED_MODELS.join(", ")}）`, () => {
  it.each(USER_SCOPED_MODELS)("%s は userId: String と User への @relation(onDelete: Cascade) を持つ", (name) => {
    const body = extractModel(name);
    expect(fieldLine(body, "userId")).toMatch(/^\s*userId\s+String\s*$/);
    const relationLine = body.split("\n").find((l) => l.includes("User") && l.includes("@relation"));
    expect(relationLine).toBeDefined();
    expect(relationLine).toMatch(/fields:\s*\[userId\]/);
    expect(relationLine).toMatch(/onDelete:\s*Cascade/);
  });
});

describe("LoginAttempt（userId を持たない唯一のモデル。設計判断 3）", () => {
  const body = extractModel("LoginAttempt");

  it("userId フィールドを持たない", () => {
    expect(body).not.toMatch(/^\s*userId\s+/m);
  });

  it("ipHash（IP の HMAC）と succeeded を持つ", () => {
    expect(fieldLine(body, "ipHash")).toMatch(/String/);
    expect(fieldLine(body, "succeeded")).toMatch(/Boolean/);
  });

  it("updatedAt を持たない（追記のみで更新しない。共通規約の唯一の例外）", () => {
    expect(body).not.toMatch(/^\s*updatedAt\s+/m);
  });
});

describe("PaymentSource", () => {
  const body = extractModel("PaymentSource");

  it("name のユニークは (userId, name)（設計判断 5。単一ユーザー版の @unique 単体ではない）", () => {
    expect(fieldLine(body, "name")).not.toMatch(/@unique/);
    expect(body).toContain("@@unique([userId, name])");
  });

  it("isActive の既定値は true（無効化は削除ではなくフラグ）", () => {
    expect(fieldLine(body, "isActive")).toMatch(/@default\(true\)/);
  });

  it("isDefault の既定値は false", () => {
    expect(fieldLine(body, "isDefault")).toMatch(/@default\(false\)/);
  });

  it("isDefault=true はユーザーごとに最大1件（userId を含む部分ユニークインデックス。設計判断 5）", () => {
    // 単一ユーザー版は @@unique([isDefault], where: { isDefault: true }) で「全体に1件」だった。
    // 公開版は userId を先頭に含めて「ユーザーごとに1件」にする必要がある
    // （付け忘れると2人目のユーザーが既定を持てずプリセット投入が失敗する。設計判断 5）。
    expect(body).toMatch(
      /@@unique\(\[userId,\s*isDefault\],\s*where:\s*\{\s*isDefault:\s*true\s*\}\)/,
    );
  });

  it("複合外部キーの参照先 @@unique([id, userId]) を持つ（設計判断 4）", () => {
    expect(body).toContain("@@unique([id, userId])");
  });
});

describe("Category", () => {
  const body = extractModel("Category");

  it("name のユニークは (userId, name)", () => {
    expect(fieldLine(body, "name")).not.toMatch(/@unique/);
    expect(body).toContain("@@unique([userId, name])");
  });

  it("isHidden の既定値は false（非表示は削除ではなくフラグ）", () => {
    expect(fieldLine(body, "isHidden")).toMatch(/@default\(false\)/);
  });

  it("複合外部キーの参照先 @@unique([id, userId]) を持つ（設計判断 4）", () => {
    expect(body).toContain("@@unique([id, userId])");
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

  it("category への参照は複合外部キー [categoryId, userId] → [id, userId] で onDelete: Restrict（設計判断 4）", () => {
    const line = body.split("\n").find((l) => l.includes("@relation") && l.includes("Category"));
    expect(line).toBeDefined();
    expect(line).toMatch(/fields:\s*\[categoryId,\s*userId\]/);
    expect(line).toMatch(/references:\s*\[id,\s*userId\]/);
    expect(line).toMatch(/onDelete:\s*Restrict/);
  });

  it("paymentSource への参照は複合外部キー [paymentSourceId, userId] → [id, userId] で onDelete: Restrict（設計判断 4）", () => {
    const line = body
      .split("\n")
      .find((l) => l.includes("@relation") && l.includes("PaymentSource"));
    expect(line).toBeDefined();
    expect(line).toMatch(/fields:\s*\[paymentSourceId,\s*userId\]/);
    expect(line).toMatch(/references:\s*\[id,\s*userId\]/);
    expect(line).toMatch(/onDelete:\s*Restrict/);
  });

  it("wasteTag は nullable にしない（無駄使い検出の中核）", () => {
    // 型に `?` が付いていないことを確認する
    expect(fieldLine(body, "wasteTag")).toMatch(/^\s*wasteTag\s+WasteTag\s*$/);
  });

  it("ダッシュボード・一覧の絞り込み用インデックスの先頭に userId がある（全クエリが userId で絞るため。設計判断 5）", () => {
    expect(body).toContain("@@index([userId, date])");
    expect(body).toContain("@@index([userId, date, categoryId])");
    expect(body).toContain("@@index([userId, date, paymentSourceId])");
  });
});

describe("Budget（払い出し先の月次予算＝主軸）", () => {
  const body = extractModel("Budget");

  it("同一払い出し先・同一月に2件許さない @@unique([paymentSourceId, yearMonth])（設計判断 5。払い出し先が持ち主を決めるので変えない）", () => {
    expect(body).toContain("@@unique([paymentSourceId, yearMonth])");
  });

  it("yearMonth は VarChar(7)（Char(7) だと末尾空白パディングで === 比較が壊れるため）", () => {
    expect(fieldLine(body, "yearMonth")).toMatch(/String\s+@db\.VarChar\(7\)/);
  });

  it("amountYen は Int（金額は整数円）", () => {
    expect(fieldLine(body, "amountYen")).toMatch(/^\s*amountYen\s+Int\s*$/);
  });

  it("paymentSource への参照は複合外部キーで onDelete: Cascade（払い出し先を消したら予算も消える）", () => {
    const line = body
      .split("\n")
      .find((l) => l.includes("@relation") && l.includes("PaymentSource"));
    expect(line).toBeDefined();
    expect(line).toMatch(/fields:\s*\[paymentSourceId,\s*userId\]/);
    expect(line).toMatch(/onDelete:\s*Cascade/);
  });

  it("userId を含む操作用インデックスがある", () => {
    expect(body).toContain("@@index([userId, yearMonth])");
  });
});

describe("CategoryBudget（カテゴリの任意予算＝補助上限）", () => {
  const body = extractModel("CategoryBudget");

  it("同一カテゴリ・同一月に2件許さない @@unique([categoryId, yearMonth])（カテゴリが持ち主を決めるので変えない）", () => {
    expect(body).toContain("@@unique([categoryId, yearMonth])");
  });

  it("yearMonth は VarChar(7)", () => {
    expect(fieldLine(body, "yearMonth")).toMatch(/String\s+@db\.VarChar\(7\)/);
  });

  it("category への参照は複合外部キーで onDelete: Cascade（カテゴリを消したら予算も消える）", () => {
    const line = body.split("\n").find((l) => l.includes("@relation") && l.includes("Category"));
    expect(line).toBeDefined();
    expect(line).toMatch(/fields:\s*\[categoryId,\s*userId\]/);
    expect(line).toMatch(/onDelete:\s*Cascade/);
  });
});

describe("Income（収入＝今月使える原資）", () => {
  const body = extractModel("Income");

  it("yearMonth は VarChar(7)", () => {
    expect(fieldLine(body, "yearMonth")).toMatch(/String\s+@db\.VarChar\(7\)/);
  });

  it("userId を含む yearMonth インデックスがある（全クエリが userId で絞るため）", () => {
    expect(body).toContain("@@index([userId, yearMonth])");
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

describe("Credential（パスキー。設計判断 3・6）", () => {
  const body = extractModel("Credential");

  it("credentialId は変えず全体で @unique（ログイン時は持ち主が分からない状態で引くため。設計判断 5）", () => {
    expect(fieldLine(body, "credentialId")).toMatch(/@unique/);
  });

  it("userId で絞るためのインデックスがある", () => {
    expect(body).toContain("@@index([userId])");
  });
});

describe("共通規約", () => {
  it.each(["PaymentSource", "Category", "Expense", "Budget", "CategoryBudget", "Income", "Credential"])(
    "%s の id は String @id @default(cuid())",
    (name) => {
      const body = extractModel(name);
      expect(fieldLine(body, "id")).toMatch(/String\s+@id\s+@default\(cuid\(\)\)/);
    },
  );

  it.each(["PaymentSource", "Category", "Expense", "Budget", "CategoryBudget", "Income", "Credential"])(
    "%s に createdAt / updatedAt がある",
    (name) => {
      const body = extractModel(name);
      expect(fieldLine(body, "createdAt")).toMatch(/DateTime\s+@default\(now\(\)\)/);
      expect(fieldLine(body, "updatedAt")).toMatch(/DateTime\s+@updatedAt/);
    },
  );
});
