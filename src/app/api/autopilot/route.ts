import { type NextRequest, NextResponse } from "next/server";
import { autopilotManager } from "@/lib/server/autopilot-manager";
import { COOKIE_COMPANY, COOKIE_TOKEN } from "@/lib/auth-cookies";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function getCredentials(req: NextRequest) {
  const token     = req.cookies.get(COOKIE_TOKEN)?.value   ?? process.env.TRADEWINDS_TOKEN ?? "";
  const companyId = req.cookies.get(COOKIE_COMPANY)?.value ?? process.env.TRADEWINDS_COMPANY_ID ?? "";
  return { token, companyId };
}

export async function GET(req: NextRequest) {
  const { companyId } = getCredentials(req);
  return NextResponse.json(await autopilotManager.getState(companyId));
}

export async function POST(req: NextRequest) {
  const { token, companyId } = getCredentials(req);
  if (!token || !companyId) {
    return NextResponse.json({ error: "No credentials" }, { status: 401 });
  }
  const body = await req.json() as { enabled?: boolean; fleetMgmt?: boolean };
  if (body.fleetMgmt !== undefined) {
    const state = autopilotManager.setFleetMgmtEnabled(companyId, token, body.fleetMgmt);
    return NextResponse.json(state);
  }
  const state = autopilotManager.setEnabled(companyId, token, body.enabled ?? false);
  return NextResponse.json(state);
}
