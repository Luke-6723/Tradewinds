import { type NextRequest, NextResponse } from "next/server";
import { COOKIE_COMPANY, COOKIE_TOKEN, UPSTREAM } from "@/lib/auth-cookies";
import type { Ship } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SHIPS_TTL_MS = 18_000;

interface ShipCache {
  ships: Ship[];
  traveling: number;
  docked: number;
  fetchedAt: number;
}

// Keyed by companyId — one process-lifetime cache entry per company
const _cache = new Map<string, ShipCache>();

async function fetchAllShips(token: string, companyId: string): Promise<ShipCache> {
  const now = Date.now();
  const cached = _cache.get(companyId);
  if (cached && now - cached.fetchedAt < SHIPS_TTL_MS) return cached;

  const rawShips: Ship[] = [];
  let after: string | null = null;
  do {
    const qs = after ? `?after=${encodeURIComponent(after)}` : "";
    const res = await fetch(`${UPSTREAM}/api/v1/ships${qs}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "tradewinds-company-id": companyId,
      },
    });
    if (!res.ok) break;
    const page = await res.json() as { data: Ship[]; metadata?: { after?: string } };
    rawShips.push(...page.data);
    after = page.metadata?.after ?? null;
  } while (after);

  // Deduplicate by ID (upstream cursor pagination can return the same ship twice)
  const seen = new Set<string>();
  const ships = rawShips.filter((s) => {
    if (seen.has(s.id)) return false;
    seen.add(s.id);
    return true;
  });

  const traveling = ships.filter((s) => s.status === "traveling").length;
  const docked = ships.length - traveling;
  const entry: ShipCache = { ships, traveling, docked, fetchedAt: now };
  _cache.set(companyId, entry);
  return entry;
}

export async function GET(req: NextRequest) {
  const token     = req.cookies.get(COOKIE_TOKEN)?.value   ?? process.env.TRADEWINDS_TOKEN   ?? "";
  const companyId = req.cookies.get(COOKIE_COMPANY)?.value ?? process.env.TRADEWINDS_COMPANY_ID ?? "";
  if (!token) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const page  = Math.max(0, parseInt(req.nextUrl.searchParams.get("page")  ?? "0"));
  const limit = Math.max(1, parseInt(req.nextUrl.searchParams.get("limit") ?? "50"));

  const { ships, traveling, docked } = await fetchAllShips(token, companyId);

  return NextResponse.json({
    ships: ships.slice(page * limit, (page + 1) * limit),
    total: ships.length,
    traveling,
    docked,
    page,
    limit,
  });
}
