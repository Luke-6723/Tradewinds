import { type NextRequest, NextResponse } from "next/server";
import { COOKIE_PLAYER_KEY } from "@/lib/kibb/cookies";
import { authorizedCompany, errorResponse, kibb, unauthorizedResponse } from "@/lib/kibb/server";
import type { UpdateCompanySettingsRequest } from "@/lib/kibb/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bad = (detail: string) => NextResponse.json({ status: 400, code: "bad_request", detail }, { status: 400 });

/**
 * `{ auto_remit_for_bills?, auto_remit_min_reserve_pence? }`. The PATCH needs `account_manage`,
 * which the stored company key doesn't carry: mint a two-minute company key with the player key,
 * use it once and revoke it. It is never stored.
 */
export async function PATCH(req: NextRequest) {
  let companyId: string | null;
  try {
    companyId = await authorizedCompany(req);
  } catch (e) {
    return unauthorizedResponse(req, e);
  }
  if (!companyId) return unauthorizedResponse(req);
  const playerKey = req.cookies.get(COOKIE_PLAYER_KEY)?.value;
  if (!playerKey) return unauthorizedResponse(req);

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return bad("Body must be JSON");
  const patch: UpdateCompanySettingsRequest = {};
  if (body.auto_remit_for_bills !== undefined) {
    if (typeof body.auto_remit_for_bills !== "boolean") return bad("auto_remit_for_bills must be true or false");
    patch.auto_remit_for_bills = body.auto_remit_for_bills;
  }
  if (body.auto_remit_min_reserve_pence !== undefined) {
    const v = body.auto_remit_min_reserve_pence;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0) return bad("auto_remit_min_reserve_pence must be a whole number of pence, 0 or more");
    patch.auto_remit_min_reserve_pence = v;
  }
  if (Object.keys(patch).length === 0) return bad("Nothing to change");

  const player = kibb(playerKey);
  let tempKeyId: string | undefined;
  try {
    const temp = await player.createKey({ label: "dashboard:settings", scopes: ["read", "account_manage"], company_id: companyId, ttl_seconds: 120 });
    tempKeyId = temp.key.id;
    return NextResponse.json(await kibb(temp.api_key).updateCompanySettings(patch));
  } catch (e) {
    return errorResponse(e);
  } finally {
    if (tempKeyId) await player.revokeKey(tempKeyId).catch(() => undefined);
  }
}
