import { type NextRequest, NextResponse } from "next/server";
import { COOKIE_COMPANY, COOKIE_TOKEN, UPSTREAM } from "@/lib/auth-cookies";

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

function forwardHeaders(req: NextRequest): HeadersInit {
  const { token, companyId } = resolveAuth(req);
  const headers: Record<string, string> = {
    "Content-Type": req.headers.get("content-type") ?? "application/json",
  };
  if (token)     headers["Authorization"]           = `Bearer ${token}`;
  if (companyId) headers["tradewinds-company-id"]   = companyId;
  return headers;
}

async function handler(
  req: NextRequest,
  { params }: { params: Promise<{ proxy: string[] }> },
) {
  const { token } = resolveAuth(req);
  if (!token) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }

  const { proxy } = await params;
  const url = upstreamUrl(proxy, req);
  const headers = forwardHeaders(req);

  const body =
    req.method !== "GET" && req.method !== "HEAD"
      ? await req.text()
      : undefined;

  const upstream = await fetch(url, {
    method: req.method,
    headers,
    body,
  });

  const responseHeaders = new Headers();
  for (const [key, value] of upstream.headers.entries()) {
    if (!["content-encoding", "transfer-encoding", "content-length"].includes(key.toLowerCase())) {
      responseHeaders.set(key, value);
    }
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
