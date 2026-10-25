import { type NextRequest, NextResponse } from "next/server";
import type { FleetSettings } from "@/lib/kibb/fleet/manager";
import { aiCommand, FleetSettingsError, getFleetView, updateFleet } from "@/lib/kibb/fleet-registry";
import { authorizedCompany, renewCompanyKeyIfDue, unauthorizedResponse } from "@/lib/kibb/server";

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
  // Best effort, not waited for: a company key close to expiry is renewed while its owner is signed in (every 10 min at most).
  void renewCompanyKeyIfDue(req, companyId).catch((e) => console.error(`[fleet] renewing the key of company ${companyId} failed: ${(e as Error).message}`));
  return NextResponse.json(await getFleetView(companyId));
}

/**
 * `{ enabled?, settings? }`: start/stop the fleet autopilot and/or change its settings (applied live).
 * `{ ai: "run" | "clear" | "retry" }`: ask the AI strategist now, clear its directives, or retry live after a demotion.
 */
export async function POST(req: NextRequest) {
  const companyId = await company(req);
  if (companyId instanceof NextResponse) return companyId;
  let body: { enabled?: boolean; settings?: Partial<FleetSettings>; ai?: "run" | "clear" | "retry" };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ status: 400, code: "bad_request", detail: "Body must be JSON" }, { status: 400 });
  }
  try {
    if (body.ai !== undefined) {
      if (body.ai !== "run" && body.ai !== "clear" && body.ai !== "retry") throw new FleetSettingsError('ai must be "run", "clear" or "retry"');
      return NextResponse.json(await aiCommand(companyId, body.ai));
    }
    return NextResponse.json(await updateFleet(companyId, { enabled: body.enabled, settings: body.settings }));
  } catch (e) {
    const status = e instanceof FleetSettingsError ? 400 : 409;
    return NextResponse.json({ status, code: status === 400 ? "bad_request" : "fleet_error", detail: (e as Error).message }, { status });
  }
}
