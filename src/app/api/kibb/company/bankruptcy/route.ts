import { type NextRequest, NextResponse } from "next/server";
import { getFleetView, updateFleet } from "@/lib/kibb/fleet-registry";
import { authorizedCompany, errorResponse, kibb, unauthorizedResponse } from "@/lib/kibb/server";
import { getCompanyKey } from "@/lib/kibb/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `{ confirm_name }`: declares Admiralty bankruptcy for the active company once the caller has
 * typed its exact name. Stops the autopilot first. Irreversible; the proxy blocks the raw route.
 */
export async function POST(req: NextRequest) {
  let companyId: string | null;
  try {
    companyId = await authorizedCompany(req);
  } catch (e) {
    return unauthorizedResponse(req, e);
  }
  if (!companyId) return unauthorizedResponse(req);
  const key = await getCompanyKey(companyId);
  if (!key) return unauthorizedResponse(req);

  const { confirm_name } = (await req.json().catch(() => ({}))) as { confirm_name?: unknown };
  try {
    const client = kibb(key.apiKey);
    const { company } = await client.companyProfile();
    if (typeof confirm_name !== "string" || confirm_name.trim() !== company.name) {
      return NextResponse.json(
        { status: 400, code: "bad_request", detail: "Type the company's exact name to confirm" },
        { status: 400 },
      );
    }
    // Stop the autopilot first; if the game refuses (most companies aren't eligible), restart it.
    const wasOn = (await getFleetView(companyId)).enabled;
    await updateFleet(companyId, { enabled: false });
    try {
      return NextResponse.json(await client.declareBankruptcy());
    } catch (e) {
      if (wasOn) await updateFleet(companyId, { enabled: true }).catch(() => undefined);
      throw e;
    }
  } catch (e) {
    return errorResponse(e);
  }
}
