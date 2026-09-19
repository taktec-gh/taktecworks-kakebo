import { headers } from "next/headers";

/**
 * 今の描画が Server Action の後の再描画かどうか。
 *
 * Server Action の中で Cookie を書き換えると、Next.js は**同じリクエストの中で**今のページを描画し直して返す
 * （node_modules/next/dist/docs/01-app/01-getting-started/07-mutating-data.md「Cookies」、
 * 03-api-reference/04-functions/cookies.md「Understanding Cookie Behavior in Server Functions」）。
 * 画面（Client Component の state）はアンマウントされないが、ページが描画中に redirect() すると、そのまま遷移してしまう。
 *
 * サインアップの完了・リカバリーの完了では、セッションやリカバリー用トークンの Cookie を書き換えた直後に、
 * **一度しか表示しないリカバリーコード**を同じ画面に出す（docs/steps/pub-5.md 設計判断 3・4）。
 * そこでページの「ログイン中なら / へ」「リカバリー用トークンが無ければ /recovery へ」の redirect を、
 * この再描画のときだけ行わないために使う。
 *
 * 判定は Next.js が Server Action の呼び出しに付ける `next-action` ヘッダ
 * （node_modules/next/dist/server/lib/server-action-request-meta.js と同じ）。
 * **認可には使わない。** ヘッダは誰でも付けられるので、これで省くのは「データを出さない公開ページの遷移」だけにする。
 * Server Action 自身はそれぞれ Cookie（セッション・リカバリー用トークン）を検証する。
 */
export const SERVER_ACTION_HEADER = "next-action";

export async function isServerActionRerender(): Promise<boolean> {
  const headerList = await headers();
  const actionId = headerList.get(SERVER_ACTION_HEADER);
  return typeof actionId === "string" && actionId.length > 0;
}
