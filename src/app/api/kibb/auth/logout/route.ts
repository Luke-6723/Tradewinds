import { type NextRequest, NextResponse } from "next/server";
import { COOKIE_COMPANY_ID, COOKIE_PLAYER_KEY } from "@/lib/kibb/cookies";
import { forgetOwner, kibb } from "@/lib/kibb/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Revokes the player key and clears the session. Stored company keys are kept, so a running
 * charter runner carries on trading.
 */
export async function POST(req: NextRequest) {
  const playerKey = req.cookies.get(COOKIE_PLAYER_KEY)?.value;
  if (playerKey) {
    await kibb(playerKey).revokeKey().catch(() => undefined);
    forgetOwner(playerKey);
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.delete(COOKIE_PLAYER_KEY);
  res.cookies.delete(COOKIE_COMPANY_ID);
  return res;
}
