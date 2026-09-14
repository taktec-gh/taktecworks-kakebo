import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import {
  getAuthSecret,
  isPublicPath,
  LOGIN_PATH,
  SESSION_COOKIE_NAME,
  verifySessionToken,
} from "@/lib/auth";

/**
 * Next.js 16 では middleware は proxy にリネームされた（機能は同じ）。
 * node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md 参照。
 *
 * ログインページと静的アセット以外を保護する。
 */
export async function proxy(request: NextRequest): Promise<NextResponse> {
  const { pathname } = request.nextUrl;

  if (isPublicPath(pathname)) {
    return NextResponse.next();
  }

  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  const session = await verifySessionToken(token, getAuthSecret());

  if (session) {
    return NextResponse.next();
  }

  const url = request.nextUrl.clone();
  url.pathname = LOGIN_PATH;
  url.search = "";

  const response = NextResponse.redirect(url);
  if (token) {
    // 改竄・期限切れの Cookie は消してからログインへ戻す
    response.cookies.delete(SESSION_COOKIE_NAME);
  }
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
