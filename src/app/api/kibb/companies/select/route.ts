import { type NextRequest, NextResponse } from "next/server";
import { COOKIE_COMPANY_ID, COOKIE_PLAYER_KEY } from "@/lib/kibb/cookies";
import { cookieOptions, ensureCompanyKey, errorResponse, forgetOwner, kibb, PLAYER_KEY_TTL_S } from "@/lib/kibb/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Makes one of the player's companies active, minting and storing its key if needed. */
export async function POST(req: NextRequest) {
  const playerKey = req.cookies.get(COOKIE_PLAYER_KEY)?.value;
  if (!playerKey) {
    return NextResponse.json({ status: 401, code: "not_signed_in", detail: "Sign in first" }, { status: 401 });
  }
  const { company_id } = (await req.json()) as { company_id?: string };
  try {
    const { companies } = await kibb(playerKey).playerProfile();
    const company = companies.find((c) => c.id === company_id);
    if (!company) {
      return NextResponse.json({ status: 404, code: "not_found", detail: "No such company on this account" }, { status: 404 });
    }
    await ensureCompanyKey(playerKey, company);
    forgetOwner(playerKey);
    const res = NextResponse.json({ ok: true, company });
    res.cookies.set(COOKIE_COMPANY_ID, company.id, cookieOptions(req, PLAYER_KEY_TTL_S));
    return res;
  } catch (e) {
    return errorResponse(e);
  }
}
