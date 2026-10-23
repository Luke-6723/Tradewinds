import { NextResponse } from "next/server";
import { KIBB_URL } from "@/lib/kibb/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// One quick try each: the client's retries would hold a dead server's check open for minutes.
async function probe(path: string): Promise<string> {
  try {
    const res = await fetch(`${KIBB_URL}${path}`, { cache: "no-store", signal: AbortSignal.timeout(5_000) });
    if (!res.ok) return `down: HTTP ${res.status}`;
    return ((await res.json()) as { status?: string }).status ?? "ok";
  } catch (e) {
    return `down: ${(e as Error).message}`;
  }
}

/** The game server's liveness (`/healthz`) and readiness (`/readyz`). Public. */
export async function GET() {
  const [healthz, readyz] = await Promise.all([probe("/healthz"), probe("/readyz")]);
  return NextResponse.json({ healthz, readyz, ok: !healthz.startsWith("down") && !readyz.startsWith("down") });
}
