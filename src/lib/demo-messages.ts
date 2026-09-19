/**
 * デモアカウントに関する文言と、デモ開始の Server Action の状態の型。
 *
 * src/lib/signup-messages.ts と同じく、Client Component（デモ開始のボタン）からも読むため
 * jose / node:crypto / Prisma に依存しないここに置く。
 *
 * 仕様の出典: docs/steps/pub-3.md 設計判断 4・6・7・9。
 */

/**
 * デモユーザーの有効期限（時間）。セッションの有効期限も同じにする（設計判断 2）。
 * 画面の注意書きでも使うのでここに置く。src/lib/demo-data.ts から再 export している
 */
export const DEMO_TTL_HOURS = 24;

/** デモ開始に成功したときの遷移先（ダッシュボード） */
export const DEMO_START_PATH = "/";

/** デモ開始の Server Action（startDemoAction）の状態。成功時は遷移するので error が null のまま */
export type DemoActionState = {
  error: string | null;
};

export const INITIAL_DEMO_ACTION_STATE: DemoActionState = { error: null };

export const DEMO_ERRORS = {
  /** IP 単位・全体のどちらの制限でも同じ文言（区別しない） */
  rateLimited: "デモが混み合っています。時間をおいてお試しください。",
  /** DB の障害・設定の不備など、サーバー側の事情。理由は出さない */
  unavailable: "ただいまデモを開始できません。時間をおいてお試しください。",
} as const;

/** デモユーザーのパスキー登録を拒否するときの文言（設計判断 7） */
export const DEMO_PASSKEY_BLOCKED_MESSAGE =
  "デモアカウントではパスキーを登録できません。続けて使う場合は、ログアウトしてアカウントを作ってください。";

/** デモ開始のボタンの文言 */
export const DEMO_START_LABEL = "デモで試す（登録不要）";

/** ログイン画面の注意書き（ボタンの近くに出す） */
export const DEMO_LOGIN_NOTICES = [
  `サンプルデータ入りのアカウントがその場で作られ、${DEMO_TTL_HOURS}時間後に自動で削除されます。`,
  "実在の家計情報は入力しないでください。",
] as const;

/** ダッシュボードのデモ表示: ログアウトすると戻れないこと（設計判断 6） */
export const DEMO_LOGOUT_WARNING =
  "ログアウトすると、このデモには戻れません（デモアカウントにはパスキーが無いため）。";
