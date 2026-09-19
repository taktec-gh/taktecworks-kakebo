import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import {
  getAuthSecret,
  isPublicPath,
  LOGIN_PATH,
  SESSION_COOKIE_NAME,
  verifySessionToken,
} from "@/lib/auth";
import {
  buildContentSecurityPolicy,
  CSP_HEADER_NAME,
  generateNonce,
  isDevelopmentEnv,
  NONCE_HEADER_NAME,
} from "@/lib/csp";

/**
 * Next.js 16 では middleware は proxy にリネームされた（機能は同じ）。
 * node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md 参照。
 *
 * ログインページと静的アセット以外を保護する。
 *
 * あわせて、すべての分岐でリクエストごとの nonce を使った CSP を付ける
 * （docs/steps/pub-4.md 設計判断 1）。通す分岐ではリクエストヘッダにも付け、
 * Next.js が描画時に nonce を読み取れるようにする。認証の判断は CSP と無関係に行う。
 */
export async function proxy(request: NextRequest): Promise<NextResponse> {
  const { pathname } = request.nextUrl;

  const nonce = generateNonce();
  const csp = buildContentSecurityPolicy({
    nonce,
    isDev: isDevelopmentEnv(process.env.NODE_ENV),
  });

  if (isPublicPath(pathname)) {
    return passThrough(request, nonce, csp);
  }

  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  const session = await verifySessionToken(token, getAuthSecret());

  if (session) {
    return passThrough(request, nonce, csp);
  }

  const url = request.nextUrl.clone();
  url.pathname = LOGIN_PATH;
  url.search = "";

  const response = NextResponse.redirect(url);
  response.headers.set(CSP_HEADER_NAME, csp);
  if (token) {
    // 改竄・期限切れの Cookie は消してからログインへ戻す
    response.cookies.delete(SESSION_COOKIE_NAME);
  }
  return response;
}

/**
 * 認証を通ったリクエストをそのまま先へ渡す。
 * CSP をリクエストヘッダ（Next.js が nonce を読む）とレスポンスヘッダ（ブラウザが適用する）の両方に付ける。
 */
function passThrough(request: NextRequest, nonce: string, csp: string): NextResponse {
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set(NONCE_HEADER_NAME, nonce);
  requestHeaders.set(CSP_HEADER_NAME, csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set(CSP_HEADER_NAME, csp);
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
