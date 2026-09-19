import { PaymentSourceType, WasteTag } from "@/generated/prisma/enums";
import { DEMO_TTL_HOURS } from "@/lib/demo-messages";
import { formatDateString, getDaysInMonth, parseDateString } from "@/lib/expense-date";
import { formatYearMonth, JST_OFFSET_MINUTES, shiftYearMonth } from "@/lib/year-month";

/**
 * デモアカウントの定数と、サンプルデータの生成（純粋関数。DB にも Next.js にも依存しない）。
 *
 * 仕様の出典: docs/steps/pub-3.md 設計判断 1・2・8。
 *
 * - **乱数を使わない。** 同じ「今日」からは必ず同じデータになる（テストで1年分の全日付を確かめるため）
 * - 払い出し先・カテゴリは**名前で**参照する。DB への投入（名前 → ID の解決）は src/lib/demo-seed.ts の担当
 * - 日付は JST の「今日」（"YYYY-MM-DD"。getCurrentDate(now) で作る）を受け取る。この中で new Date() を呼ばない
 * - 店名・メモ・払い出し先名は**一般名詞だけ**（実在の店名・ブランド名・銀行名を使わない）
 *
 * 今日の日付によらず成り立つように作ってあること（設計判断 8 の 1〜5）:
 *
 * 1. 今月の支出は今日以前の日付だけ（テンプレートの日が今日の日以下のものだけを入れる）
 * 2. 今月の総予算に対して残額がプラス（月末まで全部入れても総支出 < 総予算になる金額にしてある）
 * 3. 少なくとも1つの払い出し先が理想消化額を上回る。「A銀行 引き落とし」は1日に家賃が落ちるので、
 *    月初から「超過」。月末に近づくと理想消化額が追いつくが、それまでに光熱費が入り、
 *    月末でも予算の9割（要注意の線）を超えている
 * 4. 今月の浪費の合計が0より大きい。1日にコンビニのお菓子（浪費）がある
 * 5. 前月より増えたカテゴリがある。「医療」は今月（と3か月のうちの1か月）だけにあり、前月は0円。
 *    今月の1日に入れてあるので、月初でも前月より増えている
 */

/* ------------------------------------------------------------------ *
 * 期限（設計判断 2）
 * ------------------------------------------------------------------ */

/** デモユーザーの有効期限（時間）。実体は src/lib/demo-messages.ts（画面の注意書きからも読むため） */
export { DEMO_TTL_HOURS };

const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60 * MS_PER_SECOND;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;

/**
 * 作成時刻から、デモユーザーの期限（User.demoExpiresAt）を求める。
 *
 * **秒に切り捨ててから** DEMO_TTL_HOURS を足す。セッション JWT の exp は秒単位なので、
 * 期限を秒の境界に揃えておくと exp と demoExpiresAt がちょうど一致する。
 */
export function getDemoExpiresAt(now: Date): Date {
  const time = now.getTime();
  if (Number.isNaN(time)) throw new RangeError("invalid date");
  const nowSeconds = Math.floor(time / MS_PER_SECOND);
  return new Date((nowSeconds + DEMO_TTL_HOURS * 60 * 60) * MS_PER_SECOND);
}

/**
 * デモのセッションの有効期間（秒）。セッションの発行時刻 now から demoExpiresAt までの秒数。
 *
 * createSessionToken は iat = floor(now / 1000)、exp = iat + maxAgeSeconds で作るので、
 * 同じ now を渡せば exp が demoExpiresAt（秒）と一致する。期限を過ぎていれば 0。
 */
export function getDemoSessionMaxAgeSeconds(expiresAt: Date, now: Date): number {
  const expiresSeconds = Math.floor(expiresAt.getTime() / MS_PER_SECOND);
  const nowSeconds = Math.floor(now.getTime() / MS_PER_SECOND);
  if (Number.isNaN(expiresSeconds) || Number.isNaN(nowSeconds)) {
    throw new RangeError("invalid date");
  }
  return Math.max(0, expiresSeconds - nowSeconds);
}

/**
 * 期限の日時を JST で表示する。例: "2026/9/20 18:05"。
 * 画面（ダッシュボードの「削除される日時」）に出すため。
 */
export function formatDemoExpiresAtLabel(expiresAt: Date): string {
  const time = expiresAt.getTime();
  if (Number.isNaN(time)) throw new RangeError("invalid date");
  // UTC のまま +9 時間して UTC ゲッターで読むと JST になる（getCurrentDate と同じ流儀）
  const jst = new Date(time + JST_OFFSET_MINUTES * MS_PER_MINUTE);
  const hours = String(jst.getUTCHours()).padStart(2, "0");
  const minutes = String(jst.getUTCMinutes()).padStart(2, "0");
  return `${jst.getUTCFullYear()}/${jst.getUTCMonth() + 1}/${jst.getUTCDate()} ${hours}:${minutes}`;
}

/* ------------------------------------------------------------------ *
 * サンプルデータの計画（設計判断 8）
 * ------------------------------------------------------------------ */

/** プリセットの払い出し先（src/lib/seed.ts の PRESET_PAYMENT_SOURCES）。既定のまま使う */
export const DEMO_CASH_NAME = "現金";
/** デモで追加するクレジットカード */
export const DEMO_CARD_NAME = "Aカード";
/** デモで追加する銀行引き落とし */
export const DEMO_BANK_NAME = "A銀行 引き落とし";

/** サンプルデータを作る月数（今月と、その前の3か月） */
export const DEMO_MONTH_COUNT = 4;

export type DemoPaymentSourcePlan = {
  name: string;
  type: PaymentSourceType;
  /** プリセットの「現金」（sortOrder 1）の後ろに並べる */
  sortOrder: number;
};

export type DemoBudgetPlan = {
  yearMonth: string;
  paymentSourceName: string;
  amountYen: number;
};

export type DemoCategoryBudgetPlan = {
  yearMonth: string;
  categoryName: string;
  amountYen: number;
};

export type DemoIncomePlan = {
  yearMonth: string;
  amountYen: number;
  label: string;
};

export type DemoExpensePlan = {
  /** "YYYY-MM-DD" */
  date: string;
  amountYen: number;
  categoryName: string;
  paymentSourceName: string;
  storeName: string | null;
  memo: string | null;
  wasteTag: WasteTag;
};

export type DemoDataPlan = {
  /** 対象月（古い順。最後が今月） */
  yearMonths: string[];
  /** プリセットに**追加で**作る払い出し先（「現金」はプリセットのものを使う） */
  paymentSources: DemoPaymentSourcePlan[];
  budgets: DemoBudgetPlan[];
  categoryBudgets: DemoCategoryBudgetPlan[];
  incomes: DemoIncomePlan[];
  /** 日付の昇順 */
  expenses: DemoExpensePlan[];
};

export const DEMO_PAYMENT_SOURCES: readonly DemoPaymentSourcePlan[] = [
  { name: DEMO_CARD_NAME, type: PaymentSourceType.CREDIT_CARD, sortOrder: 2 },
  { name: DEMO_BANK_NAME, type: PaymentSourceType.BANK_DEBIT, sortOrder: 3 },
];

/** 払い出し先ごとの月次予算（毎月同じ）。合計が総予算 */
export const DEMO_MONTHLY_BUDGETS: readonly { paymentSourceName: string; amountYen: number }[] = [
  { paymentSourceName: DEMO_CASH_NAME, amountYen: 30_000 },
  { paymentSourceName: DEMO_CARD_NAME, amountYen: 70_000 },
  { paymentSourceName: DEMO_BANK_NAME, amountYen: 90_000 },
];

/** カテゴリ予算（任意の補助上限。3カテゴリだけ） */
export const DEMO_MONTHLY_CATEGORY_BUDGETS: readonly { categoryName: string; amountYen: number }[] = [
  { categoryName: "食費", amountYen: 35_000 },
  { categoryName: "外食", amountYen: 12_000 },
  { categoryName: "趣味", amountYen: 10_000 },
];

/** 毎月の収入 */
export const DEMO_MONTHLY_INCOME = { label: "給与", amountYen: 280_000 } as const;

/**
 * 変動費の月ごとの増減（%）。添字は「今月から何か月前か」（0 = 今月）。
 *
 * 今月（0）は必ず 100（テンプレートの金額そのまま）。上の「成り立つこと」2・3 は今月の金額で確かめてある。
 * 前月（1）を低めにして、今月のほうが増えたカテゴリが出やすいようにしている。
 */
const MONTH_SCALE_PERCENT: readonly number[] = [100, 93, 104, 97];

type ExpenseTemplate = {
  /** 月内の日。すべての月に存在するよう 1〜28 に限る */
  day: number;
  amountYen: number;
  categoryName: string;
  paymentSourceName: string;
  storeName: string | null;
  memo: string | null;
  wasteTag: WasteTag;
  /** true なら月ごとの増減をかけない（家賃など、毎月同額のもの） */
  fixedAmount?: boolean;
  /** この支出がある月（今月から何か月前か）。省略時はすべての月 */
  monthOffsets?: readonly number[];
};

const N = WasteTag.NECESSARY;
const W = WasteTag.WASTE;
const I = WasteTag.INVESTMENT;

/**
 * 1か月分の支出のテンプレート（今月の金額）。
 *
 * 月末まで全部入った場合の合計（今月）:
 * - 現金 18,250 円（予算 30,000）
 * - Aカード 57,200 円（予算 70,000）
 * - A銀行 引き落とし 88,500 円（予算 90,000。1日の家賃で月初から「超過」、月末でも「要注意」）
 * - 合計 163,950 円（総予算 190,000）→ 残額はいつでもプラス
 */
const EXPENSE_TEMPLATES: readonly ExpenseTemplate[] = [
  // ---- 固定費（主に銀行引き落とし・カード） ----
  { day: 1, amountYen: 75_000, categoryName: "家賃", paymentSourceName: DEMO_BANK_NAME, storeName: null, memo: "家賃", wasteTag: N, fixedAmount: true },
  { day: 10, amountYen: 6_500, categoryName: "光熱費", paymentSourceName: DEMO_BANK_NAME, storeName: null, memo: "電気代", wasteTag: N },
  { day: 15, amountYen: 4_000, categoryName: "光熱費", paymentSourceName: DEMO_BANK_NAME, storeName: null, memo: "ガス代", wasteTag: N },
  { day: 20, amountYen: 3_000, categoryName: "光熱費", paymentSourceName: DEMO_BANK_NAME, storeName: null, memo: "水道代", wasteTag: N },
  { day: 5, amountYen: 3_000, categoryName: "通信", paymentSourceName: DEMO_CARD_NAME, storeName: null, memo: "スマートフォン", wasteTag: N, fixedAmount: true },
  { day: 8, amountYen: 4_800, categoryName: "通信", paymentSourceName: DEMO_CARD_NAME, storeName: null, memo: "インターネット", wasteTag: N, fixedAmount: true },

  // ---- 変動費（カード） ----
  { day: 2, amountYen: 3_200, categoryName: "食費", paymentSourceName: DEMO_CARD_NAME, storeName: "スーパー", memo: null, wasteTag: N },
  { day: 6, amountYen: 3_500, categoryName: "食費", paymentSourceName: DEMO_CARD_NAME, storeName: "スーパー", memo: null, wasteTag: N },
  { day: 9, amountYen: 2_900, categoryName: "食費", paymentSourceName: DEMO_CARD_NAME, storeName: "スーパー", memo: null, wasteTag: N },
  { day: 13, amountYen: 3_600, categoryName: "食費", paymentSourceName: DEMO_CARD_NAME, storeName: "スーパー", memo: null, wasteTag: N },
  { day: 16, amountYen: 3_100, categoryName: "食費", paymentSourceName: DEMO_CARD_NAME, storeName: "スーパー", memo: null, wasteTag: N },
  { day: 19, amountYen: 3_400, categoryName: "食費", paymentSourceName: DEMO_CARD_NAME, storeName: "スーパー", memo: null, wasteTag: N },
  { day: 23, amountYen: 3_300, categoryName: "食費", paymentSourceName: DEMO_CARD_NAME, storeName: "スーパー", memo: null, wasteTag: N },
  { day: 26, amountYen: 3_400, categoryName: "食費", paymentSourceName: DEMO_CARD_NAME, storeName: "スーパー", memo: "まとめ買い", wasteTag: N },
  { day: 7, amountYen: 1_800, categoryName: "日用品", paymentSourceName: DEMO_CARD_NAME, storeName: "ドラッグストア", memo: "洗剤", wasteTag: N },
  { day: 21, amountYen: 2_400, categoryName: "日用品", paymentSourceName: DEMO_CARD_NAME, storeName: "ドラッグストア", memo: "ティッシュ", wasteTag: N },
  { day: 12, amountYen: 4_800, categoryName: "外食", paymentSourceName: DEMO_CARD_NAME, storeName: "レストラン", memo: "ディナー", wasteTag: W },
  { day: 14, amountYen: 2_200, categoryName: "趣味", paymentSourceName: DEMO_CARD_NAME, storeName: "書店", memo: "技術書", wasteTag: I },
  { day: 24, amountYen: 6_800, categoryName: "趣味", paymentSourceName: DEMO_CARD_NAME, storeName: "家電量販店", memo: "ゲーム", wasteTag: W },
  { day: 3, amountYen: 5_000, categoryName: "交通", paymentSourceName: DEMO_CARD_NAME, storeName: null, memo: "ICカードチャージ", wasteTag: N, fixedAmount: true },

  // ---- 変動費（現金） ----
  { day: 1, amountYen: 480, categoryName: "食費", paymentSourceName: DEMO_CASH_NAME, storeName: "コンビニ", memo: "お菓子", wasteTag: W },
  { day: 1, amountYen: 1_600, categoryName: "医療", paymentSourceName: DEMO_CASH_NAME, storeName: "ドラッグストア", memo: "風邪薬", wasteTag: N, monthOffsets: [0, 2] },
  { day: 4, amountYen: 600, categoryName: "食費", paymentSourceName: DEMO_CASH_NAME, storeName: "パン屋", memo: null, wasteTag: N },
  { day: 11, amountYen: 580, categoryName: "食費", paymentSourceName: DEMO_CASH_NAME, storeName: "パン屋", memo: null, wasteTag: N },
  { day: 18, amountYen: 620, categoryName: "食費", paymentSourceName: DEMO_CASH_NAME, storeName: "パン屋", memo: null, wasteTag: N },
  { day: 25, amountYen: 600, categoryName: "食費", paymentSourceName: DEMO_CASH_NAME, storeName: "パン屋", memo: null, wasteTag: N },
  { day: 3, amountYen: 650, categoryName: "外食", paymentSourceName: DEMO_CASH_NAME, storeName: "カフェ", memo: null, wasteTag: W },
  { day: 10, amountYen: 650, categoryName: "外食", paymentSourceName: DEMO_CASH_NAME, storeName: "カフェ", memo: null, wasteTag: W },
  { day: 17, amountYen: 650, categoryName: "外食", paymentSourceName: DEMO_CASH_NAME, storeName: "カフェ", memo: "作業", wasteTag: N },
  { day: 24, amountYen: 650, categoryName: "外食", paymentSourceName: DEMO_CASH_NAME, storeName: "カフェ", memo: null, wasteTag: W },
  { day: 6, amountYen: 950, categoryName: "外食", paymentSourceName: DEMO_CASH_NAME, storeName: "定食屋", memo: "ランチ", wasteTag: N },
  { day: 13, amountYen: 950, categoryName: "外食", paymentSourceName: DEMO_CASH_NAME, storeName: "定食屋", memo: "ランチ", wasteTag: N },
  { day: 20, amountYen: 950, categoryName: "外食", paymentSourceName: DEMO_CASH_NAME, storeName: "定食屋", memo: "ランチ", wasteTag: N },
  { day: 27, amountYen: 950, categoryName: "外食", paymentSourceName: DEMO_CASH_NAME, storeName: "定食屋", memo: "ランチ", wasteTag: N },
  { day: 8, amountYen: 700, categoryName: "食費", paymentSourceName: DEMO_CASH_NAME, storeName: "コンビニ", memo: null, wasteTag: N },
  { day: 15, amountYen: 700, categoryName: "食費", paymentSourceName: DEMO_CASH_NAME, storeName: "コンビニ", memo: "夜食", wasteTag: W },
  { day: 22, amountYen: 700, categoryName: "食費", paymentSourceName: DEMO_CASH_NAME, storeName: "コンビニ", memo: null, wasteTag: N },
  { day: 16, amountYen: 220, categoryName: "交通", paymentSourceName: DEMO_CASH_NAME, storeName: null, memo: "バス", wasteTag: N },
  { day: 9, amountYen: 550, categoryName: "日用品", paymentSourceName: DEMO_CASH_NAME, storeName: "100円ショップ", memo: null, wasteTag: N },
  { day: 18, amountYen: 4_500, categoryName: "交際", paymentSourceName: DEMO_CASH_NAME, storeName: "居酒屋", memo: "飲み会", wasteTag: W, monthOffsets: [0, 2, 3] },
];

/** 月ごとの増減をかけた金額。10円単位に丸める（整数円のまま計算する） */
function scaleAmount(amountYen: number, percent: number): number {
  return Math.round((amountYen * percent) / 1000) * 10;
}

/**
 * 今日（JST）から、デモのサンプルデータの計画を作る（純粋関数）。
 *
 * - 対象月は今月と、その前の3か月（古い順）
 * - 過去の月はテンプレートの全日、今月は**今日の日以下**の日だけ（未来の支出を作らない）
 * - 予算・カテゴリ予算・収入は4か月とも入れる
 *
 * @param today "YYYY-MM-DD"（JST）。呼び出し側が getCurrentDate(now) で作る
 * @throws today が "YYYY-MM-DD" でない・実在しない日付なら RangeError
 */
export function buildDemoData(today: string): DemoDataPlan {
  const todayParts = parseDateString(today);
  if (!todayParts) throw new RangeError(`invalid date: ${String(today)}`);
  const currentYearMonth = formatYearMonth(todayParts.year, todayParts.month);

  const yearMonths: string[] = [];
  const budgets: DemoBudgetPlan[] = [];
  const categoryBudgets: DemoCategoryBudgetPlan[] = [];
  const incomes: DemoIncomePlan[] = [];
  const expenses: DemoExpensePlan[] = [];

  for (let offset = DEMO_MONTH_COUNT - 1; offset >= 0; offset -= 1) {
    const yearMonth = shiftYearMonth(currentYearMonth, -offset);
    yearMonths.push(yearMonth);
    const year = Number(yearMonth.slice(0, 4));
    const month = Number(yearMonth.slice(5, 7));
    // 今月は今日まで、過去の月は月末まで
    const lastDay = offset === 0 ? todayParts.day : getDaysInMonth(year, month);
    const percent = MONTH_SCALE_PERCENT[offset] ?? 100;

    for (const budget of DEMO_MONTHLY_BUDGETS) {
      budgets.push({ yearMonth, ...budget });
    }
    for (const categoryBudget of DEMO_MONTHLY_CATEGORY_BUDGETS) {
      categoryBudgets.push({ yearMonth, ...categoryBudget });
    }
    incomes.push({ yearMonth, ...DEMO_MONTHLY_INCOME });

    const monthExpenses: DemoExpensePlan[] = [];
    for (const template of EXPENSE_TEMPLATES) {
      if (template.day > lastDay) continue;
      if (template.monthOffsets && !template.monthOffsets.includes(offset)) continue;
      monthExpenses.push({
        date: formatDateString(year, month, template.day),
        amountYen: template.fixedAmount
          ? template.amountYen
          : scaleAmount(template.amountYen, percent),
        categoryName: template.categoryName,
        paymentSourceName: template.paymentSourceName,
        storeName: template.storeName,
        memo: template.memo,
        wasteTag: template.wasteTag,
      });
    }
    // 同じ日の中はテンプレートの順のまま（安定ソート）
    monthExpenses.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    expenses.push(...monthExpenses);
  }

  return {
    yearMonths,
    paymentSources: DEMO_PAYMENT_SOURCES.map((source) => ({ ...source })),
    budgets,
    categoryBudgets,
    incomes,
    expenses,
  };
}
