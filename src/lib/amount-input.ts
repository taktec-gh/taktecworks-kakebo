/**
 * 金額入力の正規化（純粋関数・共通）。
 *
 * 予算（Step 4）と支出（Step 5）で「受け入れる書き方」は同じにする。
 * 違うのは**下限と、空欄の意味**だけ。
 *
 * - 予算: 空欄 = 未設定（null）。下限 0（「0円の予算」を認める）
 * - 支出: 空欄 = 入力エラー。下限 1（0円の支出は無い）
 *
 * 同じ正規化を2箇所に書くと片方だけ壊れる余地が生まれるため、ここに一本化し、
 * 範囲チェックと利用者向け文言は呼び出し側が持つ
 * （docs/steps/step-5.md「金額は1円以上」）。
 *
 * DB にも Next.js にも依存しない。
 */

/** 拒否の理由。呼び出し側がこれを自分の文言に対応づける */
export type AmountRejectReason =
  /** 数字として読めない */
  | "invalid"
  /** 小数が含まれる */
  | "notInteger"
  /** マイナス */
  | "negative"
  /** 安全に扱える整数を超えている */
  | "tooLarge";

export type AmountNormalizeResult =
  /** value が null なら「空欄」。空欄をどう扱うかは呼び出し側が決める */
  | { ok: true; value: number | null }
  | { ok: false; reason: AmountRejectReason };

/** 全角数字（０〜９）を半角に直す。スマホの日本語入力で混ざりやすいため受け入れる */
function toHalfWidthDigits(value: string): string {
  return value.replace(/[０-９]/g, (char) =>
    String.fromCharCode(char.charCodeAt(0) - 0xff10 + 0x30),
  );
}

/**
 * 金額入力を整数に正規化する。
 *
 * - 空欄（空白のみを含む）は value: null
 * - 全角数字・桁区切りのカンマ（半角/全角）・前後の空白は正規化して受け入れる
 * - 小数、マイナス、指数表記、その他の文字は**拒否する**
 *   （丸めて黙って別の金額を保存しない）
 * - 範囲（下限・上限）はここでは見ない。呼び出し側の責任
 */
export function normalizeAmountInput(input: unknown): AmountNormalizeResult {
  if (typeof input !== "string") return { ok: false, reason: "invalid" };

  // 全角空白も落とす（trim は U+3000 も対象）
  const trimmed = input.trim();
  if (trimmed.length === 0) return { ok: true, value: null };

  const normalized = toHalfWidthDigits(trimmed).replace(/[,，]/g, "");

  if (/^[-−ー－]/.test(normalized)) return { ok: false, reason: "negative" };
  if (normalized.includes(".") || normalized.includes("．")) {
    return { ok: false, reason: "notInteger" };
  }
  if (!/^\d+$/.test(normalized)) return { ok: false, reason: "invalid" };

  const amount = Number(normalized);
  if (!Number.isSafeInteger(amount)) return { ok: false, reason: "tooLarge" };

  return { ok: true, value: amount };
}

/** 3桁区切り。Intl に頼らず結果を環境非依存にする */
export function formatGroupedNumber(value: number): string {
  const sign = value < 0 ? "-" : "";
  const digits = Math.abs(value).toString();
  return sign + digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
