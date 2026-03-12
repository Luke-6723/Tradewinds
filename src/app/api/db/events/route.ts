/**
 * GET /api/db/events?type=world|company
 *
 * Returns the last 100 SSE events of the given type from MongoDB.
 * Scoped to the current company for company events.
 * Returns an empty array (not an error) if MongoDB is not configured.
 */

import { type NextRequest, NextResponse } from "next/server";
import { COOKIE_COMPANY } from "@/lib/auth-cookies";
import { getEvents } from "@/lib/db/collections";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const type = req.nextUrl.searchParams.get("type") === "company" ? "company" : "world";
  const companyId = req.cookies.get(COOKIE_COMPANY)?.value ?? process.env.TRADEWINDS_COMPANY_ID;

  const events = await getEvents(
    type,
    type === "company" ? companyId : undefined,
  );

  // Return oldest-first so the feed can append in correct order
  return NextResponse.json(events.reverse());
}
