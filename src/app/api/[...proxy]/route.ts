import { type NextRequest, NextResponse } from "next/server";
import { COOKIE_COMPANY, COOKIE_TOKEN, UPSTREAM } from "@/lib/auth-cookies";
import { refreshToken } from "@/lib/server/token-refresh";

function resolveAuth(req: NextRequest): { token: string | null; companyId: string | null } {
  const token     = req.cookies.get(COOKIE_TOKEN)?.value   ?? process.env.TRADEWINDS_TOKEN   ?? null;
  const companyId = req.cookies.get(COOKIE_COMPANY)?.value ?? process.env.TRADEWINDS_COMPANY_ID ?? null;
  return { token, companyId };
}

function upstreamUrl(slug: string[], req: NextRequest): string {
  const path = slug.join("/");
  const qs = req.nextUrl.search;
  return `${UPSTREAM}/api/v1/${path}${qs}`;
}

function buildUpstreamHeaders(token: string | null, companyId: string | null, contentType: string): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": contentType };
  if (token)     headers["Authorization"]           = `Bearer ${token}`;
  if (companyId) headers["tradewinds-company-id"]   = companyId;
  return headers;
}

async function handler(
  req: NextRequest,
  { params }: { params: Promise<{ proxy: string[] }> },
) {
  const { token, companyId } = resolveAuth(req);
  if (!token) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }

  const { proxy } = await params;
  const url = upstreamUrl(proxy, req);
  const contentType = req.headers.get("content-type") ?? "application/json";

  const body =
    req.method !== "GET" && req.method !== "HEAD"
      ? await req.text()
      : undefined;

  const forwardHeaders = buildUpstreamHeaders(token, companyId, contentType);
  let upstream = await fetch(url, { method: req.method, headers: forwardHeaders, body });

  // ── 401 recovery: refresh token and retry once ────────────────────────────
  let freshToken: string | null = null;
  if (upstream.status === 401) {
    try {
      freshToken = await refreshToken();
      process.env.TRADEWINDS_TOKEN = freshToken;
      const retryHeaders = buildUpstreamHeaders(freshToken, companyId, contentType);
      upstream = await fetch(url, { method: req.method, headers: retryHeaders, body });
    } catch {
      // Refresh failed — return the original 401
    }
  }

  const responseHeaders = new Headers();
  for (const [key, value] of upstream.headers.entries()) {
    if (!["content-encoding", "transfer-encoding", "content-length"].includes(key.toLowerCase())) {
      responseHeaders.set(key, value);
    }
  }

  // Propagate the new token to the browser cookie so the UI stays authenticated
  if (freshToken) {
    responseHeaders.append(
      "Set-Cookie",
      `${COOKIE_TOKEN}=${freshToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}`,
    );
  }

  const responseBody = upstream.status === 204 ? null : upstream.body;

  return new NextResponse(responseBody, {
    status: upstream.status,
    headers: responseHeaders,
  });
}

export const GET = handler;
export const POST = handler;
export const PATCH = handler;
export const PUT = handler;
export const DELETE = handler;
