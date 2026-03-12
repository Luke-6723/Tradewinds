import { type NextRequest, NextResponse } from "next/server";
import { COOKIE_TOKEN } from "@/lib/auth-cookies";

const PUBLIC_PATHS = ["/login", "/register"];

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Allow public auth pages and all API routes through
  if (
    PUBLIC_PATHS.some((p) => pathname.startsWith(p)) ||
    pathname.startsWith("/api/")
  ) {
    return NextResponse.next();
  }

  // Check for token in cookie or env (env covers the existing .env.local setup)
  const hasToken =
    req.cookies.has(COOKIE_TOKEN) || !!process.env.TRADEWINDS_TOKEN;

  if (!hasToken) {
    const loginUrl = req.nextUrl.clone();
    loginUrl.pathname = "/login";
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    /*
     * Match all paths except static files and Next.js internals.
     */
    "/((?!_next/static|_next/image|favicon.ico).*)",
  ],
};
