// @vitest-environment node
//
// PRESET_CATEGORIES / PRESET_PAYMENT_SOURCES の内容と seedDatabase() の呼び出しを検証する。
// 実データベースには接続せず、PrismaClient をモックする
// （docs/steps/step-2.md「テストの方針」）。

import { describe, expect, it, vi } from "vitest";

import {
  CostType,
  PaymentSourceType,
  type Category,
  type PaymentSource,
  type PrismaClient,
} from "@/generated/prisma/client";
import { PRESET_CATEGORIES, PRESET_PAYMENT_SOURCES, seedDatabase } from "@/lib/seed";

// features.md「初期カテゴリをプリセット」の記載順。sortOrder はこの順で 1 始まりの連番
// （docs/steps/step-2.md「sortOrder は 1 始まり」）
const EXPECTED_CATEGORY_NAMES = [
  "食費",
  "日用品",
  "外食",
  "交通",
  "光熱費",
  "通信",
  "家賃",
  "趣味",
  "交際",
  "医療",
  "その他",
];

// docs/steps/step-2.md「costType は各カテゴリの性質に応じて設定する
// （家賃・光熱費・通信は FIXED、他は VARIABLE を基本とし）」
const EXPECTED_COST_TYPES: Record<string, CostType> = {
  食費: CostType.VARIABLE,
  日用品: CostType.VARIABLE,
  外食: CostType.VARIABLE,
  交通: CostType.VARIABLE,
  光熱費: CostType.FIXED,
  通信: CostType.FIXED,
  家賃: CostType.FIXED,
  趣味: CostType.VARIABLE,
  交際: CostType.VARIABLE,
  医療: CostType.VARIABLE,
  その他: CostType.VARIABLE,
};

describe("PRESET_CATEGORIES", () => {
  it("11件ある（features.md の初期カテゴリプリセット）", () => {
    expect(PRESET_CATEGORIES).toHaveLength(11);
  });

  it("features.md の記載順と一致する", () => {
    expect(PRESET_CATEGORIES.map((c) => c.name)).toEqual(EXPECTED_CATEGORY_NAMES);
  });

  it("sortOrder は1始まりの連番（重複・欠番なし）", () => {
    expect(PRESET_CATEGORIES.map((c) => c.sortOrder)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11,
    ]);
  });

  it("name に重複がない", () => {
    const names = PRESET_CATEGORIES.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it.each(EXPECTED_CATEGORY_NAMES)("%s の costType が仕様どおり", (name) => {
    const preset = PRESET_CATEGORIES.find((c) => c.name === name);
    expect(preset).toBeDefined();
    expect(preset?.costType).toBe(EXPECTED_COST_TYPES[name]);
  });

  it("家賃・光熱費・通信の3件だけが FIXED、残り8件は VARIABLE", () => {
    const fixed = PRESET_CATEGORIES.filter((c) => c.costType === CostType.FIXED).map(
      (c) => c.name,
    );
    const variable = PRESET_CATEGORIES.filter((c) => c.costType === CostType.VARIABLE).map(
      (c) => c.name,
    );
    expect(new Set(fixed)).toEqual(new Set(["光熱費", "通信", "家賃"]));
    expect(variable).toHaveLength(8);
  });
});

describe("PRESET_PAYMENT_SOURCES", () => {
  it("「現金」1件のみ（クレジットカード・銀行はユーザーが任意に登録するため作らない）", () => {
    expect(PRESET_PAYMENT_SOURCES).toHaveLength(1);
    expect(PRESET_PAYMENT_SOURCES[0].name).toBe("現金");
  });

  it("type は CASH", () => {
    expect(PRESET_PAYMENT_SOURCES[0].type).toBe(PaymentSourceType.CASH);
  });

  it("isDefault は true（features.md「払い出し先はデフォルト値を持たせ…」）", () => {
    expect(PRESET_PAYMENT_SOURCES[0].isDefault).toBe(true);
  });

  it("sortOrder は1始まり", () => {
    expect(PRESET_PAYMENT_SOURCES[0].sortOrder).toBe(1);
  });
});

/** PrismaClient のうち seedDatabase が使う部分だけをモックする */
function createMockClient(): {
  client: PrismaClient;
  categoryUpsert: ReturnType<typeof vi.fn>;
  paymentSourceUpsert: ReturnType<typeof vi.fn>;
} {
  const categoryUpsert = vi.fn(
    async (args: {
      where: { name: string };
      update: Record<string, never>;
      create: { name: string; costType: CostType; sortOrder: number };
    }): Promise<Category> => {
      const now = new Date("2026-01-01T00:00:00.000Z");
      return {
        id: `cat_${args.create.name}`,
        name: args.create.name,
        costType: args.create.costType,
        sortOrder: args.create.sortOrder,
        isHidden: false,
        createdAt: now,
        updatedAt: now,
      };
    },
  );

  const paymentSourceUpsert = vi.fn(
    async (args: {
      where: { name: string };
      update: Record<string, never>;
      create: { name: string; type: PaymentSourceType; sortOrder: number; isDefault: boolean };
    }): Promise<PaymentSource> => {
      const now = new Date("2026-01-01T00:00:00.000Z");
      return {
        id: `ps_${args.create.name}`,
        name: args.create.name,
        type: args.create.type,
        sortOrder: args.create.sortOrder,
        isActive: true,
        isDefault: args.create.isDefault,
        createdAt: now,
        updatedAt: now,
      };
    },
  );

  const client = {
    category: { upsert: categoryUpsert },
    paymentSource: { upsert: paymentSourceUpsert },
  } as unknown as PrismaClient;

  return { client, categoryUpsert, paymentSourceUpsert };
}

describe("seedDatabase", () => {
  it("カテゴリごとに1回ずつ upsert を呼ぶ（PRESET_CATEGORIES と同数）", async () => {
    const { client, categoryUpsert } = createMockClient();
    await seedDatabase(client);
    expect(categoryUpsert).toHaveBeenCalledTimes(PRESET_CATEGORIES.length);
  });

  it("category.upsert は name で where、update は空、create は preset の内容", async () => {
    const { client, categoryUpsert } = createMockClient();
    await seedDatabase(client);

    PRESET_CATEGORIES.forEach((preset, i) => {
      expect(categoryUpsert).toHaveBeenNthCalledWith(i + 1, {
        where: { name: preset.name },
        update: {},
        create: {
          name: preset.name,
          costType: preset.costType,
          sortOrder: preset.sortOrder,
        },
      });
    });
  });

  it("払い出し先ごとに1回ずつ upsert を呼ぶ（PRESET_PAYMENT_SOURCES と同数）", async () => {
    const { client, paymentSourceUpsert } = createMockClient();
    await seedDatabase(client);
    expect(paymentSourceUpsert).toHaveBeenCalledTimes(PRESET_PAYMENT_SOURCES.length);
  });

  it("paymentSource.upsert は name で where、update は空、create は preset の内容", async () => {
    const { client, paymentSourceUpsert } = createMockClient();
    await seedDatabase(client);

    PRESET_PAYMENT_SOURCES.forEach((preset, i) => {
      expect(paymentSourceUpsert).toHaveBeenNthCalledWith(i + 1, {
        where: { name: preset.name },
        update: {},
        create: {
          name: preset.name,
          type: preset.type,
          sortOrder: preset.sortOrder,
          isDefault: preset.isDefault,
        },
      });
    });
  });

  it("upsert の update は常に {}（既存レコードを更新しない。並べ替え・非表示・既定値変更を再実行で巻き戻さないため）", async () => {
    const { client, categoryUpsert, paymentSourceUpsert } = createMockClient();
    await seedDatabase(client);

    for (const call of categoryUpsert.mock.calls) {
      expect(call[0].update).toEqual({});
    }
    for (const call of paymentSourceUpsert.mock.calls) {
      expect(call[0].update).toEqual({});
    }
  });

  it("戻り値の categories / paymentSources は upsert の戻り値をそのまま定義順に含む", async () => {
    const { client } = createMockClient();
    const result = await seedDatabase(client);

    expect(result.categories).toHaveLength(PRESET_CATEGORIES.length);
    expect(result.categories.map((c) => c.name)).toEqual(
      PRESET_CATEGORIES.map((p) => p.name),
    );

    expect(result.paymentSources).toHaveLength(PRESET_PAYMENT_SOURCES.length);
    expect(result.paymentSources.map((p) => p.name)).toEqual(
      PRESET_PAYMENT_SOURCES.map((p) => p.name),
    );
  });

  it("2回実行しても同じ引数で upsert を呼ぶ（冪等）", async () => {
    const { client, categoryUpsert, paymentSourceUpsert } = createMockClient();

    await seedDatabase(client);
    const firstCategoryArgs = categoryUpsert.mock.calls.map((c) => c[0]);
    const firstPaymentSourceArgs = paymentSourceUpsert.mock.calls.map((c) => c[0]);

    categoryUpsert.mockClear();
    paymentSourceUpsert.mockClear();

    await seedDatabase(client);
    const secondCategoryArgs = categoryUpsert.mock.calls.map((c) => c[0]);
    const secondPaymentSourceArgs = paymentSourceUpsert.mock.calls.map((c) => c[0]);

    expect(secondCategoryArgs).toEqual(firstCategoryArgs);
    expect(secondPaymentSourceArgs).toEqual(firstPaymentSourceArgs);
  });
});
