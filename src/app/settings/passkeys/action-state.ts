/**
 * パスキー設定画面の Server Action の状態。
 * "use server" ファイルは async 関数しか export できないため、
 * 型と定数は actions.ts から分離してここに置く（他の設定画面と同じ構成）。
 */

export type PasskeyActionState = {
  /** 失敗時のみメッセージが入る。成功時は null */
  error: string | null;
};

export const initialPasskeyActionState: PasskeyActionState = { error: null };

/** useActionState に渡せる Server Action の形 */
export type PasskeyFormAction = (
  prevState: PasskeyActionState,
  formData: FormData,
) => PasskeyActionState | Promise<PasskeyActionState>;

/** 一覧ページ */
export const PASSKEYS_PATH = "/settings/passkeys";

/** 画面に出す一覧の1行。publicKey や counter はクライアントへ渡さない */
export type PasskeyListItem = {
  id: string;
  deviceName: string;
  /** 登録日（JST）。"2026/8/14(金)" */
  createdAtLabel: string;
  /** 最終利用日（JST）。一度も使っていなければ null */
  lastUsedAtLabel: string | null;
};
