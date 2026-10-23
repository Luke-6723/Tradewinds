import { type NextRequest, NextResponse } from "next/server";
import { pickShipName } from "@/lib/kibb/fleet/names";
import { authorizedCompany, errorResponse, kibb, unauthorizedResponse } from "@/lib/kibb/server";
import { getCompanyKey } from "@/lib/kibb/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A name for a new ship (a random Discord bot name) that no ship in the fleet already has. */
export async function GET(req: NextRequest) {
  let companyId: string | null;
  try {
    companyId = await authorizedCompany(req);
  } catch (e) {
    return unauthorizedResponse(req, e);
  }
  const key = companyId ? await getCompanyKey(companyId) : null;
  if (!key) return unauthorizedResponse(req);
  try {
    const ships = await kibb(key.apiKey).ships();
    return NextResponse.json({ name: await pickShipName(new Set(ships.map((r) => r.ship.name))) });
  } catch (e) {
    return errorResponse(e);
  }
}
