import { NextResponse } from "next/server";
import { getAutopilotCredentials } from "@/lib/db/collections";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const creds = await getAutopilotCredentials();
  return NextResponse.json({ stored: creds !== null });
}
