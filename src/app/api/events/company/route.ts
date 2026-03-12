import { type NextRequest, NextResponse } from "next/server";

const UPSTREAM = process.env.TRADEWINDS_API_URL ?? "https://tradewinds.fly.dev";
const TOKEN = process.env.TRADEWINDS_TOKEN;
const COMPANY_ID = process.env.TRADEWINDS_COMPANY_ID;

export async function GET(_req: NextRequest) {
  if (!TOKEN || !COMPANY_ID) {
    return NextResponse.json({ error: "Auth env vars not set" }, { status: 503 });
  }

  const upstreamUrl = `${UPSTREAM}/api/v1/company/events`;

  const upstream = await fetch(upstreamUrl, {
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "tradewinds-company-id": COMPANY_ID,
    },
  });

  if (!upstream.ok || !upstream.body) {
    return NextResponse.json({ error: "Failed to connect to company events" }, { status: 502 });
  }

  const { readable, writable } = new TransformStream();
  upstream.body.pipeTo(writable).catch(() => {});

  return new NextResponse(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
