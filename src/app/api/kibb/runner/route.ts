import { type NextRequest, NextResponse } from "next/server";
import type { CharterSettings } from "@/lib/kibb/charter-runner";
import { COOKIE_COMPANY_ID } from "@/lib/kibb/cookies";
import { getRunnerView, updateRunner } from "@/lib/kibb/runner-registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function companyOf(req: NextRequest): string | null {
  return req.cookies.get(COOKIE_COMPANY_ID)?.value ?? null;
}

function noCompany() {
  return NextResponse.json({ status: 401, code: "no_company", detail: "Select a company first" }, { status: 401 });
}

export async function GET(req: NextRequest) {
  const companyId = companyOf(req);
  if (!companyId) return noCompany();
  return NextResponse.json(await getRunnerView(companyId));
}

/** `{ enabled?, settings? }`: start/stop the charter runner and/or change its settings. */
export async function POST(req: NextRequest) {
  const companyId = companyOf(req);
  if (!companyId) return noCompany();
  const body = (await req.json()) as { enabled?: boolean; settings?: Partial<CharterSettings> };
  try {
    return NextResponse.json(await updateRunner(companyId, body));
  } catch (e) {
    return NextResponse.json({ status: 409, code: "runner_error", detail: (e as Error).message }, { status: 409 });
  }
}
