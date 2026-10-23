import { type NextRequest, NextResponse } from "next/server";
import { COOKIE_COMPANY_ID, COOKIE_PLAYER_KEY } from "@/lib/kibb/cookies";
import { forgetAllOwners, kibb } from "@/lib/kibb/server";
import { noSession, playerKeyError } from "../session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** `{ key_id }`: revokes one of the player's keys. Revoking this session's own key signs out. */
export async function POST(req: NextRequest) {
  const playerKey = req.cookies.get(COOKIE_PLAYER_KEY)?.value;
  if (!playerKey) return noSession();
  const { key_id } = (await req.json().catch(() => ({}))) as { key_id?: unknown };
  if (typeof key_id !== "string" || !key_id) {
    return NextResponse.json({ status: 400, code: "bad_request", detail: "key_id is required" }, { status: 400 });
  }
  try {
    const client = kibb(playerKey);
    const own = (await client.whoami()).api_key_id === key_id;
    const result = await client.revokeKey(key_id);
    // Another browser signed in with the revoked key must lose access now, not when the cache ages.
    forgetAllOwners();
    const res = NextResponse.json({ ...result, signed_out: own });
    if (own) {
      res.cookies.delete(COOKIE_PLAYER_KEY);
      res.cookies.delete(COOKIE_COMPANY_ID);
    }
    return res;
  } catch (e) {
    return playerKeyError(playerKey, e);
  }
}
