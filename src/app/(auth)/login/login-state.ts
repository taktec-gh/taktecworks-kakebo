/**
 * ログインフォームの状態。
 * "use server" ファイルは async 関数しか export できないため、
 * 定数と型は actions.ts から分離してここに置く。
 */
export type LoginState = {
  /** 失敗時のみメッセージが入る。成功時は "/" へリダイレクトするので返らない */
  error: string | null;
};

export const initialLoginState: LoginState = { error: null };
