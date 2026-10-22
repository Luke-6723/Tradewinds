import { randomUUID } from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";
import { COOKIE_COMPANY_ID } from "@/lib/kibb/cookies";
import { KIBB_URL } from "@/lib/kibb/server";
import { getCompanyKey } from "@/lib/kibb/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Writes the browser may not make through the proxy: key management, company founding, bankruptcy.
const BLOCKED_WRITES = [/^auth\//, /^player\//, /^company\/create$/, /^company\/declare-bankruptcy$/];

/**
 * Forwards `/api/kibb/v1/*` to the kibb.io API with the active company's stored key.
 * World routes work without a company. Writes get an Idempotency-Key if the browser sent none.
 */
async function forward(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const path = (await params).path.join("/");
  const isWrite = req.method !== "GET" && req.method !== "HEAD";
  if (isWrite && BLOCKED_WRITES.some((re) => re.test(path))) {
    return NextResponse.json({ status: 403, code: "forbidden", detail: `${path} is not available from the dashboard` }, { status: 403 });
  }

  const companyId = req.cookies.get(COOKIE_COMPANY_ID)?.value;
  const key = companyId ? await getCompanyKey(companyId) : null;
  if (!key && !path.startsWith("world/")) {
    return NextResponse.json({ status: 401, code: "no_company_key", detail: "Select a company first" }, { status: 401 });
  }

  const headers: Record<string, string> = { accept: "application/json" };
  if (key) headers.authorization = `Bearer ${key.apiKey}`;
  let body: string | undefined;
  if (isWrite) {
    body = await req.text();
    headers["content-type"] = "application/json";
    headers["idempotency-key"] = req.headers.get("idempotency-key") ?? randomUUID();
  }

  try {
    const upstream = await fetch(`${KIBB_URL}/v1/${path}${req.nextUrl.search}`, {
      method: req.method,
      headers,
      body,
      cache: "no-store",
      signal: AbortSignal.timeout(30_000),
    });
    const out = new NextResponse(await upstream.text(), { status: upstream.status });
    out.headers.set("content-type", upstream.headers.get("content-type") ?? "application/json");
    const retryAfter = upstream.headers.get("retry-after");
    if (retryAfter) out.headers.set("retry-after", retryAfter);
    return out;
  } catch (e) {
    return NextResponse.json({ status: 502, code: "upstream_unreachable", detail: (e as Error).message }, { status: 502 });
  }
}

export { forward as GET, forward as POST, forward as PATCH };
