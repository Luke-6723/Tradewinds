import { type NextRequest, NextResponse } from "next/server";
import { COOKIE_COMPANY_ID, COOKIE_PLAYER_KEY } from "@/lib/kibb/cookies";
import { cookieOptions, ensureCompanyKey, errorResponse, forgetOwner, kibb, PLAYER_KEY_TTL_S } from "@/lib/kibb/server";
import { getCompanyKey } from "@/lib/kibb/store";
import { KibbApiError } from "@/lib/kibb/client";
import type { CreateCompanyRequest } from "@/lib/kibb/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function noSession() {
  return NextResponse.json({ status: 401, code: "not_signed_in", detail: "Sign in first" }, { status: 401 });
}

/** The signed-in player's companies, flagged with whether a company key is stored for each. */
export async function GET(req: NextRequest) {
  const playerKey = req.cookies.get(COOKIE_PLAYER_KEY)?.value;
  if (!playerKey) return noSession();
  try {
    const { player, companies } = await kibb(playerKey).playerProfile();
    const withKeys = await Promise.all(
      companies.map(async (c) => ({ ...c, has_key: (await getCompanyKey(c.id)) !== null })),
    );
    return NextResponse.json({
      player,
      companies: withKeys,
      active_company_id: req.cookies.get(COOKIE_COMPANY_ID)?.value ?? null,
    });
  } catch (e) {
    if (e instanceof KibbApiError && e.status === 401) {
      const res = noSession();
      res.cookies.delete(COOKIE_PLAYER_KEY);
      return res;
    }
    return errorResponse(e);
  }
}

/** Founds a company, mints its key and makes it the active company. */
export async function POST(req: NextRequest) {
  const playerKey = req.cookies.get(COOKIE_PLAYER_KEY)?.value;
  if (!playerKey) return noSession();
  const body = (await req.json()) as CreateCompanyRequest;
  try {
    const created = await kibb(playerKey).createCompany({
      name: body.name,
      home_port_id: body.home_port_id,
      starter_ship_name: body.starter_ship_name || undefined,
    });
    await ensureCompanyKey(playerKey, created.company);
    forgetOwner(playerKey);
    const res = NextResponse.json(created, { status: 201 });
    res.cookies.set(COOKIE_COMPANY_ID, created.company.id, cookieOptions(req, PLAYER_KEY_TTL_S));
    return res;
  } catch (e) {
    return errorResponse(e);
  }
}
