import { randomUUID } from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";
import { authorizedCompany, KIBB_URL, unauthorizedResponse } from "@/lib/kibb/server";
import { getCompanyKey } from "@/lib/kibb/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Writes the browser may not make through the proxy: key management, company founding, bankruptcy.
const BLOCKED_WRITES = [/^auth\//, /^player\//, /^company\/create$/, /^company\/declare-bankruptcy$/];
// Upstream says our stored company key is no good: send the user to re-select the company.
const DEAD_KEY_CODES = ["revoked_api_key", "invalid_api_key", "expired_api_key"];

/**
 * Forwards `/api/kibb/v1/*` to the kibb.io API with the active company's stored key, for a
 * signed-in player who owns that company. World routes work without one. Writes get an
 * Idempotency-Key if the browser sent none.
 */
async function forward(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const segments = (await params).path;
  // Segments arrive decoded: an encoded "/" or ".." would otherwise slip past the checks below
  // and be normalised away by the URL parser on the way upstream.
  if (segments.some((s) => s === "." || s === ".." || /[/\\%]/.test(s))) {
    return NextResponse.json({ status: 400, code: "bad_request", detail: "Invalid path" }, { status: 400 });
  }
  const upstreamUrl = new URL(`${KIBB_URL}/v1/${segments.map(encodeURIComponent).join("/")}${req.nextUrl.search}`);
  if (!upstreamUrl.pathname.startsWith("/v1/")) {
    return NextResponse.json({ status: 400, code: "bad_request", detail: "Invalid path" }, { status: 400 });
  }
  const path = upstreamUrl.pathname.slice("/v1/".length);
  const isWrite = req.method !== "GET" && req.method !== "HEAD";
  if (isWrite && BLOCKED_WRITES.some((re) => re.test(path))) {
    return NextResponse.json({ status: 403, code: "forbidden", detail: `${path} is not available from the dashboard` }, { status: 403 });
  }

  let companyId: string | null;
  try {
    companyId = await authorizedCompany(req);
  } catch (e) {
    if (path.startsWith("world/")) companyId = null;
    else return unauthorizedResponse(req, e);
  }
  const key = companyId ? await getCompanyKey(companyId) : null;
  if (!key && !path.startsWith("world/")) return unauthorizedResponse(req);

  const headers: Record<string, string> = { accept: "application/json" };
  if (key) headers.authorization = `Bearer ${key.apiKey}`;
  let body: string | undefined;
  if (isWrite) {
    body = await req.text();
    headers["content-type"] = "application/json";
    headers["idempotency-key"] = req.headers.get("idempotency-key") ?? randomUUID();
  }

  try {
    const upstream = await fetch(upstreamUrl, {
      method: req.method,
      headers,
      body,
      cache: "no-store",
      // A browser that gives up (a long poll left or paused) ends the upstream call too.
      signal: AbortSignal.any([req.signal, AbortSignal.timeout(30_000)]),
    });
    const text = await upstream.text();
    if (upstream.status === 401 && key) {
      const code = (() => {
        try {
          return (JSON.parse(text) as { code?: string }).code;
        } catch {
          return undefined;
        }
      })();
      if (code && DEAD_KEY_CODES.includes(code)) {
        return NextResponse.json(
          { status: 401, code: "no_company_key", detail: "This company's stored key no longer works; select the company again" },
          { status: 401 },
        );
      }
    }
    const out = new NextResponse(text, { status: upstream.status });
    out.headers.set("content-type", upstream.headers.get("content-type") ?? "application/json");
    const retryAfter = upstream.headers.get("retry-after");
    if (retryAfter) out.headers.set("retry-after", retryAfter);
    return out;
  } catch (e) {
    return NextResponse.json({ status: 502, code: "upstream_unreachable", detail: (e as Error).message }, { status: 502 });
  }
}

export { forward as GET, forward as POST, forward as PATCH };
