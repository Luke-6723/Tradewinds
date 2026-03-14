import { type NextRequest, NextResponse } from "next/server";
import { COOKIE_COMPANY, COOKIE_TOKEN, UPSTREAM } from "@/lib/auth-cookies";
import { getLedgerEntries, upsertLedgerEntries } from "@/lib/db/collections";
import type { LedgerEntry } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const token = req.cookies.get(COOKIE_TOKEN)?.value ?? process.env.TRADEWINDS_TOKEN ?? null;
  const companyId =
    req.cookies.get(COOKIE_COMPANY)?.value ?? process.env.TRADEWINDS_COMPANY_ID ?? null;

  if (!token || !companyId) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }

  // Fetch fresh ledger page from upstream and accumulate into DB
  try {
    const upstream = await fetch(`${UPSTREAM}/api/v1/company/ledger`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "tradewinds-company-id": companyId,
      },
    });

    if (upstream.ok) {
      const json = await upstream.json();
      const fresh: LedgerEntry[] = json?.data ?? json ?? [];
      if (fresh.length > 0) {
        await upsertLedgerEntries(companyId, fresh);
      }
    }
  } catch {
    // Non-fatal — return whatever is stored
  }

  const stored = await getLedgerEntries(companyId);

  // Map to a minimal LedgerEntry shape for the client (only fields needed for display)
  const entries = stored.map((s) => ({
    id: s.entryId,
    company_id: companyId,
    amount: s.amount,
    reason: s.reason as LedgerEntry["reason"],
    reference_type: "system" as const,
    reference_id: s.entryId,
    idempotency_key: s.entryId,
    occurred_at: s.occurredAt.toISOString(),
    inserted_at: s.occurredAt.toISOString(),
  })) satisfies LedgerEntry[];

  return NextResponse.json(entries);
}
