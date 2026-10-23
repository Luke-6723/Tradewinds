import { type NextRequest, NextResponse } from "next/server";
import { COOKIE_COMPANY_ID, COOKIE_PLAYER_KEY } from "@/lib/kibb/cookies";
import { cookieOptions, errorResponse, kibb, PLAYER_KEY_TTL_S } from "@/lib/kibb/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Registers a player, then logs straight in. The passphrase is not stored. */
export async function POST(req: NextRequest) {
  const { handle, passphrase } = (await req.json()) as { handle?: string; passphrase?: string };
  if (!handle || !passphrase) {
    return NextResponse.json({ status: 400, detail: "Handle and passphrase are required" }, { status: 400 });
  }
  try {
    const client = kibb();
    await client.register(handle, passphrase);
    const { api_key } = await client.login({ handle, passphrase, label: "dashboard", ttl_seconds: PLAYER_KEY_TTL_S });
    const res = NextResponse.json({ ok: true, handle });
    res.cookies.set(COOKIE_PLAYER_KEY, api_key, cookieOptions(req, PLAYER_KEY_TTL_S));
    res.cookies.delete(COOKIE_COMPANY_ID);
    return res;
  } catch (e) {
    return errorResponse(e);
  }
}
