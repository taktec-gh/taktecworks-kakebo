/**
 * パスキー設定画面（/settings/passkeys）に出す文言と、それに関わる定数。
 *
 * src/lib/passkey.ts ではなくここに置いてあるのは、登録フォーム
 * （Client Component）からも同じ文字列を読むため。passkey.ts は jose に依存するので
 * クライアント側から import させたくない。passkey.ts はここから再 export する。
 *
 * **ログイン画面にはこれらを出さない。** ログインの失敗は理由を問わず
 * LOGIN_ERROR_MESSAGE に統一する（理由を出すと登録の有無が漏れる）。
 */

/** 端末名の最大文字数。Credential.deviceName は @db.VarChar(30) */
export const DEVICE_NAME_MAX_LENGTH = 30;

export const PASSKEY_ERRORS = {
  deviceNameRequired: "端末の名前を入力してください。",
  deviceNameTooLong: `端末の名前は${DEVICE_NAME_MAX_LENGTH}文字以内で入力してください。`,
  idRequired: "対象のパスキーが指定されていません。",
  notFound: "対象のパスキーが見つかりません。",
  challengeExpired:
    "登録の有効期限が切れました。もう一度「この端末を登録」からやり直してください。",
  verificationFailed: "この端末を登録できませんでした。もう一度お試しください。",
  duplicate: "この端末はすでに登録されています。",
  deleteLastOne:
    "これが最後のパスキーです。削除するとログインできなくなるため、先にもう1台登録してください。",
  /**
   * 直列化に失敗したとき（同時に削除が走ったなど）。
   * 握りつぶすと「消えたように見えて消えていない」状態になるため、必ず画面に出す。
   */
  conflict: "操作が競合しました。もう一度お試しください。",
  configMissing: "パスキーの設定（RP_ID / RP_ORIGIN）がサーバー側で未設定です。",
  /** セッションはあるが利用者の行が無い（アカウントが削除された後のセッションなど） */
  accountNotFound: "アカウントが見つかりません。ログインし直してください。",
} as const;
