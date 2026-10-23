import { type NextRequest, NextResponse } from "next/server";
import { COOKIE_COMPANY_ID, COOKIE_PLAYER_KEY } from "@/lib/kibb/cookies";
import { forgetAllOwners, kibb, KIBB_URL } from "@/lib/kibb/server";
import { noSession, playerKeyError } from "../session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bad = (detail: string) => NextResponse.json({ status: 400, code: "bad_request", detail }, { status: 400 });

/**
 * `{ current_passphrase, new_passphrase, revoke_all_keys }`: changes the signed-in player's
 * passphrase. Passed straight through to the game; never stored or logged. Revoking all keys
 * also kills this session and the autopilot's stored keys, so it signs out.
 *
 * Sent once, without the client's retries: a retry after a lost answer would send the old
 * passphrase again and report a change that happened as a failure.
 */
export async function POST(req: NextRequest) {
  const playerKey = req.cookies.get(COOKIE_PLAYER_KEY)?.value;
  if (!playerKey) return noSession();
  const body = (await req.json().catch(() => ({}))) as {
    current_passphrase?: unknown;
    new_passphrase?: unknown;
    revoke_all_keys?: unknown;
  };
  if (typeof body.current_passphrase !== "string" || !body.current_passphrase) return bad("Enter your current passphrase");
  if (typeof body.new_passphrase !== "string" || body.new_passphrase.length < 8 || body.new_passphrase.length > 128) {
    return bad("The new passphrase must be 8 to 128 characters");
  }
  const revokeAll = body.revoke_all_keys === true;

  let handle: string;
  try {
    handle = (await kibb(playerKey).playerProfile()).player.handle;
  } catch (e) {
    return playerKeyError(playerKey, e);
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${KIBB_URL}/v1/auth/change-passphrase`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        handle,
        current_passphrase: body.current_passphrase,
        new_passphrase: body.new_passphrase,
        revoke_all_keys: revokeAll,
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    return NextResponse.json(
      {
        status: 502,
        code: "upstream_unreachable",
        detail: "The game didn't answer, so the change may or may not have gone through. Try signing in with the new passphrase.",
      },
      { status: 502 },
    );
  }
  const text = await upstream.text();
  if (!upstream.ok) {
    // A 401 here is a wrong current passphrase, not a dead session: pass it through as it is.
    return new NextResponse(text, { status: upstream.status, headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" } });
  }
  forgetAllOwners();
  const res = NextResponse.json({ ...(JSON.parse(text) as object), signed_out: revokeAll });
  if (revokeAll) {
    res.cookies.delete(COOKIE_PLAYER_KEY);
    res.cookies.delete(COOKIE_COMPANY_ID);
  }
  return res;
}
