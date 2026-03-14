import { type NextRequest, NextResponse } from "next/server";
import { COOKIE_COMPANY, COOKIE_TOKEN, UPSTREAM } from "@/lib/auth-cookies";
import { saveEvent, upsertLedgerEntries } from "@/lib/db/collections";

export async function GET(req: NextRequest) {
  const token     = req.cookies.get(COOKIE_TOKEN)?.value   ?? process.env.TRADEWINDS_TOKEN;
  const companyId = req.cookies.get(COOKIE_COMPANY)?.value ?? process.env.TRADEWINDS_COMPANY_ID;

  if (!token || !companyId) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }

  const upstream = await fetch(`${UPSTREAM}/api/v1/company/events`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "tradewinds-company-id": companyId,
    },
  });

  if (!upstream.ok || !upstream.body) {
    return NextResponse.json({ error: "Failed to connect to company events" }, { status: 502 });
  }

  // Tap the stream: parse each SSE event and save to MongoDB while forwarding
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      controller.enqueue(chunk);

      // Parse "data: {...}\n" lines from the SSE chunk
      const text = new TextDecoder().decode(chunk);
      for (const line of text.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const raw = line.slice(5).trim();
        try {
          const parsed = JSON.parse(raw) as Record<string, unknown>;
          void saveEvent({ scope: "company", companyId, data: parsed });

          // Persist ledger_entry events directly into the ledger collection
          if (parsed.type === "ledger_entry") {
            const d = parsed.data as Record<string, unknown>;
            void upsertLedgerEntries(companyId, [{
              id:          d.id as string,
              amount:      d.amount as number,
              reason:      (d.reason as string | undefined) ?? "",
              occurred_at: d.occurred_at as string,
            }]);
          }
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
