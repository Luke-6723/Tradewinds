import { type NextRequest, NextResponse } from "next/server";

const UPSTREAM = process.env.TRADEWINDS_API_URL ?? "https://tradewinds.fly.dev";
const TOKEN = process.env.TRADEWINDS_TOKEN;
const COMPANY_ID = process.env.TRADEWINDS_COMPANY_ID;

function upstreamUrl(slug: string[], req: NextRequest): string {
  const path = slug.join("/");
  const qs = req.nextUrl.search;
  return `${UPSTREAM}/api/v1/${path}${qs}`;
}

function forwardHeaders(req: NextRequest): HeadersInit {
  const headers: Record<string, string> = {
    "Content-Type": req.headers.get("content-type") ?? "application/json",
  };
  if (TOKEN) headers["Authorization"] = `Bearer ${TOKEN}`;
  if (COMPANY_ID) headers["tradewinds-company-id"] = COMPANY_ID;
  return headers;
}

async function handler(
  req: NextRequest,
  { params }: { params: Promise<{ proxy: string[] }> },
) {
  if (!TOKEN) {
    return NextResponse.json(
      { error: "TRADEWINDS_TOKEN is not configured. Run scripts/setup.mjs first." },
      { status: 503 },
    );
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

  // Stream the body directly rather than buffering. fetch() auto-decompresses
  // gzip, so upstream.body carries the raw bytes at the decompressed size —
  // inconsistent with the original content-length. Streaming (and dropping
  // content-length) lets the client read until the stream ends naturally.
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
