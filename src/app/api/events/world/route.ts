import { type NextRequest, NextResponse } from "next/server";
import { COOKIE_TOKEN, UPSTREAM } from "@/lib/auth-cookies";
import { saveEvent } from "@/lib/db/collections";

export async function GET(req: NextRequest) {
  const token = req.cookies.get(COOKIE_TOKEN)?.value ?? process.env.TRADEWINDS_TOKEN;

  if (!token) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }

  const upstream = await fetch(`${UPSTREAM}/api/v1/world/events`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!upstream.ok || !upstream.body) {
    return NextResponse.json({ error: "Failed to connect to world events" }, { status: 502 });
  }

  // Tap the stream: parse each SSE event and save to MongoDB while forwarding
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      controller.enqueue(chunk);

      const text = new TextDecoder().decode(chunk);
      for (const line of text.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const raw = line.slice(5).trim();
        try {
          const data = JSON.parse(raw) as Record<string, unknown>;
          void saveEvent({ scope: "world", data });
        } catch { /* non-JSON line — skip */ }
      }
    },
  });

  upstream.body.pipeTo(writable).catch(() => {});

  return new NextResponse(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
