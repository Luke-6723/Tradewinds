import { type NextRequest, NextResponse } from "next/server";
import { COOKIE_COMPANY_ID, COOKIE_PLAYER_KEY } from "@/lib/kibb/cookies";

const PUBLIC_PATHS = ["/login", "/register"];

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Allow public auth pages and all API routes through
  if (PUBLIC_PATHS.some((p) => pathname.startsWith(p)) || pathname.startsWith("/api/")) {
    return NextResponse.next();
  }

  const hasPlayer  = req.cookies.has(COOKIE_PLAYER_KEY);
  const hasCompany = req.cookies.has(COOKIE_COMPANY_ID);

  const redirect = (to: string) => {
    const url = req.nextUrl.clone();
    url.pathname = to;
    url.search = "";
    return NextResponse.redirect(url);
  };

  // Picking or founding a company needs the player key
  if (pathname.startsWith("/companies")) return hasPlayer ? NextResponse.next() : redirect("/login");

  // Game pages run on the company key stored server-side; the cookie says which company
  if (!hasCompany) return redirect(hasPlayer ? "/companies" : "/login");

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
