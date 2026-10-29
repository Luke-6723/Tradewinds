import { type NextRequest, NextResponse } from "next/server";
import { COOKIE_PLAYER_KEY } from "@/lib/kibb/cookies";
import { authorizedCompany, errorResponse, keyAllowsSmuggling, kibb, recordCompanyKeyScopes, setCompanyUnderworld, SMUGGLING_SCOPE, unauthorizedResponse } from "@/lib/kibb/server";
import { getCompanyKey } from "@/lib/kibb/store";
import type { UnderworldAccess } from "@/lib/kibb/fleet/smuggle";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The stored company key's scopes, as the game says (recorded in the store when they differ). */
export async function GET(req: NextRequest) {
  let companyId: string | null;
  try {
    companyId = await authorizedCompany(req);
  } catch (e) {
    return unauthorizedResponse(req, e);
  }
  if (!companyId) return unauthorizedResponse(req);
  const key = await getCompanyKey(companyId);
  if (!key) return unauthorizedResponse(req);
  try {
    const who = await kibb(key.apiKey).whoami();
    if (!key.scopes || key.scopes.length !== who.scopes.length || !key.scopes.every((s) => who.scopes.includes(s))) {
      // Under the company's key lock, and only while this is still the stored key (an allow/withdraw may have replaced it).
      await recordCompanyKeyScopes(companyId, key.keyId, who.scopes);
    }
    const out: UnderworldAccess = { underworld: who.scopes.includes(SMUGGLING_SCOPE), scopes: who.scopes, keyExpiresAt: who.expires_at ?? key.expiresAt, verified: true };
    return NextResponse.json(out);
  } catch {
    const out: UnderworldAccess = { underworld: keyAllowsSmuggling(key), scopes: key.scopes ?? [], keyExpiresAt: key.expiresAt, verified: false };
    return NextResponse.json(out);
  }
}

/**
 * `{ allow: boolean }`: the owner allows smuggling (the company key is minted again with the `underworld` scope, and keeps
 * it on every renewal) or withdraws it (minted again without). Needs the signed-in owner's player key (the cookie); a
 * running autopilot switches to the new key at once and the key it replaces is revoked.
 */
export async function POST(req: NextRequest) {
  let companyId: string | null;
  try {
    companyId = await authorizedCompany(req);
  } catch (e) {
    return unauthorizedResponse(req, e);
  }
  if (!companyId) return unauthorizedResponse(req);
  const playerKey = req.cookies.get(COOKIE_PLAYER_KEY)?.value;
  if (!playerKey) return unauthorizedResponse(req);
  const body = (await req.json().catch(() => null)) as { allow?: unknown } | null;
  if (!body || typeof body.allow !== "boolean") {
    return NextResponse.json({ status: 400, code: "bad_request", detail: "allow must be true or false" }, { status: 400 });
  }
  try {
    const stored = await getCompanyKey(companyId);
    const name = stored?.companyName ?? (await kibb(playerKey).playerProfile()).companies.find((c) => c.id === companyId)?.name ?? companyId;
    const key = await setCompanyUnderworld(playerKey, { id: companyId, name }, body.allow);
    const out: UnderworldAccess = { underworld: keyAllowsSmuggling(key), scopes: key.scopes ?? [], keyExpiresAt: key.expiresAt, verified: true };
    return NextResponse.json(out);
  } catch (e) {
    return errorResponse(e);
  }
}
