import { type NextRequest, NextResponse } from "next/server";

const UPSTREAM = process.env.TRADEWINDS_API_URL ?? "https://tradewinds.fly.dev";
const TOKEN = process.env.TRADEWINDS_TOKEN;

export async function GET(_req: NextRequest) {
  if (!TOKEN) {
    return NextResponse.json({ error: "TRADEWINDS_TOKEN not set" }, { status: 503 });
  }

  const upstreamUrl = `${UPSTREAM}/api/v1/world/events`;

  const upstream = await fetch(upstreamUrl, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });

  if (!upstream.ok || !upstream.body) {
    return NextResponse.json({ error: "Failed to connect to world events" }, { status: 502 });
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
