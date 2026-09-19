/**
 * リカバリー（/recovery・/recovery/passkey）とリカバリーコードの表示に出す文言・パス・戻り値の型。
 *
 * src/lib/signup-messages.ts と同じく、Client Component からも読むため
 * jose / node:crypto に依存しないここに置く。
 *
 * **コードの照合の失敗は文言を1つにする**（docs/steps/pub-5.md 設計判断 4・6）。
 * 間違い・使用済み・レート制限・デモユーザー・サーバーの事情を区別しない。
 */

/** コードの入力画面（公開パス） */
export const RECOVERY_PATH = "/recovery";

/** リカバリー中のパスキー登録画面（公開パス。リカバリー用トークンが無ければ RECOVERY_PATH へ） */
export const RECOVERY_PASSKEY_PATH = "/recovery/passkey";

/** リカバリー完了後（新しいコードを控えた後）の遷移先 */
export const RECOVERY_COMPLETE_PATH = "/";

/** 入力欄の name */
export const RECOVERY_CODE_FIELD_NAME = "code";

export const RECOVERY_ERRORS = {
  /**
   * コードの照合の失敗。間違い・使用済み・作り直し済み・レート制限・デモユーザー・サーバーの事情のどれでも同じ。
   * 登録の完了時に、先に使われていた（差し替えの条件に合わない）場合もこの文言
   */
  invalidCode: "コードが正しくないか、すでに使われています。",
  /** リカバリー用トークンが無い・期限切れ（10分）・改竄 */
  sessionExpired:
    "リカバリーの有効期限が切れました。もう一度リカバリーコードを入力してください。",
  /** 登録のチャレンジの期限切れ・改竄・用途違い */
  challengeExpired:
    "登録の有効期限が切れました。もう一度「この端末を登録」からやり直してください。",
  /** 登録応答の検証失敗、ブラウザ側での取り消し・失敗 */
  verificationFailed: "この端末を登録できませんでした。もう一度お試しください。",
  /** 同じ資格情報IDが登録済み */
  duplicate: "この端末のパスキーはすでに登録されています。別の端末で登録するか、ログイン画面からログインしてください。",
  /** 設定の不備・DB の障害など、サーバー側の事情。理由は出さない */
  unavailable: "ただいまリカバリーできません。時間をおいてお試しください。",
} as const;

/** 設定画面での作り直しの失敗 */
export const RECOVERY_REGENERATE_ERRORS = {
  /** セッションはあるが利用者の行が無い */
  accountNotFound: "アカウントが見つかりません。ログインし直してください。",
  /** DB の障害など */
  unavailable: "リカバリーコードを作り直せませんでした。時間をおいてお試しください。",
} as const;

/** デモユーザーはリカバリーコードを持たない（作り直しも拒否する） */
export const DEMO_RECOVERY_CODE_BLOCKED_MESSAGE =
  "デモアカウントにはリカバリーコードがありません。";

/** コードの入力画面（useActionState）の状態 */
export type RecoveryCodeFormState = {
  /** 失敗時のみ文言が入る。成功時はパスキーの登録画面へ redirect する */
  error: string | null;
};

export const initialRecoveryCodeFormState: RecoveryCodeFormState = { error: null };

/**
 * 新しいコードを返す Server Action の戻り値（サインアップの完了・リカバリーの完了・設定からの作り直し）。
 *
 * `recoveryCode` は表示用に区切った平文。**画面に一度だけ出す。保存しない。**
 */
export type RecoveryCodeIssuedResult =
  | { ok: true; recoveryCode: string }
  | { ok: false; error: string };
