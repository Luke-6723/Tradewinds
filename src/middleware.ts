import { type NextRequest, NextResponse } from "next/server";
import { COOKIE_COMPANY_ID, COOKIE_PLAYER_KEY } from "@/lib/kibb/cookies";

const PUBLIC_PATHS = ["/login", "/register"];

/**
 * Writes must come from the dashboard's own pages. SameSite=Lax cookies still ride along on a
 * POST from another port of the same host or a sibling subdomain; browsers always send Origin
 * (or Sec-Fetch-Site) on those, so a mismatch is refused. Non-browser clients send neither.
 */
function sameOrigin(req: NextRequest): boolean {
  const origin = req.headers.get("origin");
  if (origin) {
    try {
      return new URL(origin).host === (req.headers.get("x-forwarded-host") ?? req.headers.get("host"));
    } catch {
      return false;
    }
  }
  const site = req.headers.get("sec-fetch-site");
  return !site || site === "same-origin" || site === "none";
}

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (pathname.startsWith("/api/")) {
    if (req.method !== "GET" && req.method !== "HEAD" && !sameOrigin(req)) {
      return NextResponse.json({ status: 403, code: "forbidden", detail: "Cross-site request refused" }, { status: 403 });
    }
    return NextResponse.next();
  }

  // Allow public auth pages through
  if (PUBLIC_PATHS.some((p) => pathname.startsWith(p))) {
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

  // Game pages need a signed-in player and a chosen company (the server checks ownership)
  if (!hasPlayer) return redirect("/login");
  if (!hasCompany) return redirect("/companies");

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
