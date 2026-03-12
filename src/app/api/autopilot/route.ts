import { NextResponse } from "next/server";
import { autopilotManager } from "@/lib/server/autopilot-manager";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json(autopilotManager.getState());
}

export async function POST(req: Request) {
  const { enabled } = await req.json() as { enabled: boolean };
  autopilotManager.setEnabled(enabled);
  return NextResponse.json(autopilotManager.getState());
}
