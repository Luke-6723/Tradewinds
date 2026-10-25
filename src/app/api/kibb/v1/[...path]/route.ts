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
// Passed back to the browser: a replayed write, and the rate limits it may want to honour.
const FORWARD_HEADERS = ["retry-after", "idempotency-replayed", "x-ratelimit-bucket", "x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-reset"];
/** Browser long polls on the event log held open at once per company (each tab is one; the autopilot shares the key's stream bucket). */
const MAX_BROWSER_POLLS = 2;
const g = globalThis as { __kibbBrowserPolls?: Map<string, number> };
const polls = (g.__kibbBrowserPolls ??= new Map<string, number>());

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
    // The browser's own key (writeFetch) is kept for retries of the same action; a fresh one otherwise.
    headers["idempotency-key"] = req.headers.get("idempotency-key") ?? randomUUID();
  }

  // An event long poll (SSE, or a stream read that waits: timeout_ms absent means 5 s) holds a slot until it ends.
  const wait = req.nextUrl.searchParams.get("timeout_ms");
  const longPoll = !!companyId && (path === "event/sse" || (path === "event/stream" && (wait === null || Number(wait) > 0)));
  if (longPoll) {
    const open = polls.get(companyId!) ?? 0;
    if (open >= MAX_BROWSER_POLLS) {
      return NextResponse.json(
        { status: 429, code: "too_many_streams", detail: `At most ${MAX_BROWSER_POLLS} live event feeds per company from the dashboard; close another tab` },
        { status: 429, headers: { "retry-after": "30" } },
      );
    }
    polls.set(companyId!, open + 1);
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
    for (const h of FORWARD_HEADERS) {
      const v = upstream.headers.get(h);
      if (v) out.headers.set(h, v);
    }
    return out;
  } catch (e) {
    const err = e as Error & { cause?: { name?: string } };
    if (err.name === "TimeoutError" || err.cause?.name === "TimeoutError") {
      // No answer in time: a write may still have gone through. Retrying sends the same key, so it replays.
      const detail = isWrite ? "The game didn't answer in time; it may have gone through, and retrying reuses the same key" : "The game didn't answer in time";
      return NextResponse.json({ status: 504, code: "upstream_timeout", detail }, { status: 504 });
    }
    return NextResponse.json({ status: 502, code: "upstream_unreachable", detail: err.message }, { status: 502 });
  } finally {
    if (longPoll) {
      const left = (polls.get(companyId!) ?? 1) - 1;
      if (left > 0) polls.set(companyId!, left);
      else polls.delete(companyId!);
    }
  }
}

export { forward as GET, forward as POST, forward as PATCH };
