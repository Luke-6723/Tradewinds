import { type NextRequest, NextResponse } from "next/server";
import { COOKIE_COMPANY_ID, COOKIE_PLAYER_KEY } from "@/lib/kibb/cookies";
import { forgetAllOwners, kibb } from "@/lib/kibb/server";
import { noSession, playerKeyError } from "../session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `{ company_id?, keep_current_key }`: revokes every key on the account, or only those bound
 * to one company. Without a company and without keeping this session's key, it signs out.
 */
export async function POST(req: NextRequest) {
  const playerKey = req.cookies.get(COOKIE_PLAYER_KEY)?.value;
  if (!playerKey) return noSession();
  const body = (await req.json().catch(() => ({}))) as { company_id?: unknown; keep_current_key?: unknown };
  const companyId = typeof body.company_id === "string" && body.company_id ? body.company_id : undefined;
  const keepCurrent = body.keep_current_key !== false;
  try {
    const result = await kibb(playerKey).revokeAllKeys({ company_id: companyId, keep_current_key: keepCurrent });
    const signedOut = !companyId && !keepCurrent;
    forgetAllOwners();
    const res = NextResponse.json({ ...result, signed_out: signedOut });
    if (signedOut) {
      res.cookies.delete(COOKIE_PLAYER_KEY);
      res.cookies.delete(COOKIE_COMPANY_ID);
    }
    return res;
  } catch (e) {
    return playerKeyError(playerKey, e);
  }
}
