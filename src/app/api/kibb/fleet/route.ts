import { type NextRequest, NextResponse } from "next/server";
import type { FleetSettings } from "@/lib/kibb/fleet/manager";
import { FleetSettingsError, getFleetView, updateFleet } from "@/lib/kibb/fleet-registry";
import { authorizedCompany, unauthorizedResponse } from "@/lib/kibb/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The caller's company, or the reply to send instead. */
async function company(req: NextRequest): Promise<string | NextResponse> {
  try {
    return (await authorizedCompany(req)) ?? unauthorizedResponse(req);
  } catch (e) {
    return unauthorizedResponse(req, e);
  }
}

export async function GET(req: NextRequest) {
  const companyId = await company(req);
  if (companyId instanceof NextResponse) return companyId;
  return NextResponse.json(await getFleetView(companyId));
}

/** `{ enabled?, settings? }`: start/stop the fleet autopilot and/or change its settings (applied live). */
export async function POST(req: NextRequest) {
  const companyId = await company(req);
  if (companyId instanceof NextResponse) return companyId;
  let body: { enabled?: boolean; settings?: Partial<FleetSettings> };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ status: 400, code: "bad_request", detail: "Body must be JSON" }, { status: 400 });
  }
  try {
    return NextResponse.json(await updateFleet(companyId, body));
  } catch (e) {
    const status = e instanceof FleetSettingsError ? 400 : 409;
    return NextResponse.json({ status, code: status === 400 ? "bad_request" : "fleet_error", detail: (e as Error).message }, { status });
  }
}
