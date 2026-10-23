import { type NextRequest, NextResponse } from "next/server";
import { COOKIE_PLAYER_KEY } from "@/lib/kibb/cookies";
import { kibb } from "@/lib/kibb/server";
import { getCompanyKey } from "@/lib/kibb/store";
import { noSession, playerKeyError } from "./session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The signed-in player, the key this session uses, and every key on the account, with the
 * keys the dashboard stores for its companies (the autopilot runs on those) marked.
 */
export async function GET(req: NextRequest) {
  const playerKey = req.cookies.get(COOKIE_PLAYER_KEY)?.value;
  if (!playerKey) return noSession();
  const client = kibb(playerKey);
  try {
    const [who, profile, keys] = await Promise.all([client.whoami(), client.playerProfile(), client.listKeys()]);
    const stored: Record<string, string> = {};
    for (const c of profile.companies) {
      const k = await getCompanyKey(c.id);
      if (k) stored[k.keyId] = c.name;
    }
    return NextResponse.json({
      player: profile.player,
      companies: profile.companies,
      session_key_id: who.api_key_id,
      session_expires_at: who.expires_at ?? null,
      keys,
      dashboard_keys: stored,
    });
  } catch (e) {
    return playerKeyError(playerKey, e);
  }
}
