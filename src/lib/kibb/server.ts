/**
 * Server-side helpers for the dashboard's kibb.io routes: upstream URL, key minting, error replies.
 * Server-only (pulls in the local store).
 */

import { createHash } from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";
import { KibbClient, KibbApiError, KIBB_DEFAULT_URL } from "./client";
import { COOKIE_COMPANY_ID, COOKIE_PLAYER_KEY } from "./cookies";
import { getCompanyKey, keyIsUsable, saveCompanyKey, type StoredCompanyKey } from "./store";
import type { ApiKeyScope } from "./types";

export const KIBB_URL = process.env.KIBB_API_URL ?? KIBB_DEFAULT_URL;

/** Player keys from dashboard logins last the 90-day season. */
export const PLAYER_KEY_TTL_S = 90 * 24 * 60 * 60;

/** Everything a company key can hold except account management. */
const COMPANY_KEY_SCOPES: ApiKeyScope[] = [
  "read",
  "fleet_navigate",
  "fleet_cargo",
  "market_spot",
  "market_derivatives",
  "infra_manage",
  "treasury_remit",
];

/** Reuse a stored company key with at least this much life left, instead of minting a new one. */
const REUSE_MIN_LIFE_MS = 24 * 60 * 60 * 1000;

export function kibb(apiKey?: string): KibbClient {
  return new KibbClient({ baseUrl: KIBB_URL, apiKey });
}

/**
 * Session cookie options. `Secure` only when the browser reached us over HTTPS (directly or via a
 * proxy that says so): browsers drop Secure cookies sent over plain http (localhost aside), which
 * would sign everyone out of a production build served on http://host:port.
 * COOKIE_SECURE=true|false overrides the guess.
 */
export function cookieOptions(req: NextRequest, maxAgeS: number) {
  const forced = process.env.COOKIE_SECURE;
  const proto = req.headers.get("x-forwarded-proto")?.split(",")[0].trim() ?? req.nextUrl.protocol.replace(":", "");
  return {
    httpOnly: true,
    secure: forced ? forced === "true" : proto === "https",
    sameSite: "lax" as const,
    path: "/",
    maxAge: maxAgeS,
  };
}

/** Returns the stored company key, minting one with the player key if none has a day of life left. */
export async function ensureCompanyKey(
  playerKey: string,
  company: { id: string; name: string },
): Promise<StoredCompanyKey> {
  const stored = await getCompanyKey(company.id);
  if (stored && keyIsUsable(stored, REUSE_MIN_LIFE_MS)) {
    // Reuse it only if the game still accepts it (it may have been revoked).
    try {
      await kibb(stored.apiKey).whoami();
      return stored;
    } catch (e) {
      if (!(e instanceof KibbApiError) || e.status !== 401) return stored;
    }
  }

  // A sub-key can't outlive the key that mints it.
  const player = kibb(playerKey);
  const who = await player.whoami();
  const playerLifeS = who.expires_at ? Math.floor((Date.parse(who.expires_at) - Date.now()) / 1000) - 60 : PLAYER_KEY_TTL_S;
  if (playerLifeS < 60) throw new KibbApiError(401, "expired_api_key", "Your session is about to expire; sign in again", "");

  const res = await player.createKey({
    label: `dashboard:${company.name}`.slice(0, 64),
    scopes: COMPANY_KEY_SCOPES,
    company_id: company.id,
    ttl_seconds: Math.min(PLAYER_KEY_TTL_S, playerLifeS),
  });
  const key: StoredCompanyKey = {
    companyId: company.id,
    companyName: company.name,
    apiKey: res.api_key,
    keyId: res.key.id,
    expiresAt: res.key.expires_at ?? null,
    savedAt: new Date().toISOString(),
  };
  await saveCompanyKey(key);
  // A running autopilot still holds the old key: restart it on the new one.
  void import("./fleet-registry").then((m) => m.refreshFleetKey(company.id)).catch(() => undefined);
  return key;
}

// Which companies each signed-in player owns, cached briefly (keyed by a hash of the player key).
const g = globalThis as { __kibbOwners?: Map<string, { ids: Set<string>; at: number }> };
const owners = (g.__kibbOwners ??= new Map());
const OWNER_TTL_MS = 5 * 60_000;

/** The game couldn't be asked who owns what (network, 5xx, rate limit): answer 503, don't sign out. */
export class UpstreamUnavailable extends Error {}

/** The game rejected the player key itself (expired or revoked): the user must sign in again. */
export class PlayerKeyRejected extends Error {}

/**
 * The active company id, only if the request carries a player session that owns it. Guards the
 * routes that act with the company's stored key: the company cookie alone proves nothing.
 * Null means "not signed in or not the owner"; throws UpstreamUnavailable when it can't tell.
 */
export async function authorizedCompany(req: NextRequest): Promise<string | null> {
  const playerKey = req.cookies.get(COOKIE_PLAYER_KEY)?.value;
  const companyId = req.cookies.get(COOKIE_COMPANY_ID)?.value;
  if (!playerKey || !companyId) return null;
  const id = createHash("sha256").update(playerKey).digest("hex");
  const hit = owners.get(id);
  if (hit && Date.now() - hit.at < OWNER_TTL_MS) return hit.ids.has(companyId) ? companyId : null;
  try {
    const { companies } = await kibb(playerKey).playerProfile();
    owners.set(id, { ids: new Set(companies.map((c) => c.id)), at: Date.now() });
    return companies.some((c) => c.id === companyId) ? companyId : null;
  } catch (e) {
    if (e instanceof KibbApiError && e.status === 401) {
      owners.delete(id);
      throw new PlayerKeyRejected(e.detail);
    }
    // An upstream blip: the last known answer is better than signing the owner out.
    if (hit) return hit.ids.has(companyId) ? companyId : null;
    throw new UpstreamUnavailable((e as Error).message);
  }
}

/** The 401/503 reply for a request authorizedCompany turned away. */
export function unauthorizedResponse(req: NextRequest, e?: unknown): NextResponse {
  if (e instanceof UpstreamUnavailable) {
    return NextResponse.json({ status: 503, code: "upstream_unreachable", detail: `Couldn't reach the game: ${e.message}` }, { status: 503 });
  }
  if (e instanceof PlayerKeyRejected) {
    const res = NextResponse.json({ status: 401, code: "not_signed_in", detail: "Your session has expired; sign in again" }, { status: 401 });
    res.cookies.delete(COOKIE_PLAYER_KEY);
    return res;
  }
  const signedIn = req.cookies.has(COOKIE_PLAYER_KEY);
  return NextResponse.json(
    signedIn
      ? { status: 401, code: "no_company_key", detail: "Select a company you own" }
      : { status: 401, code: "not_signed_in", detail: "Sign in first" },
    { status: 401 },
  );
}

/** Forgets the ownership cache for a player key (after founding or selecting a company). */
export function forgetOwner(playerKey: string): void {
  owners.delete(createHash("sha256").update(playerKey).digest("hex"));
}

/** Forgets every cached ownership answer, so revoked player keys stop working at once. */
export function forgetAllOwners(): void {
  owners.clear();
}

/** Turns an upstream error into a problem+json reply with the same status. */
export function errorResponse(e: unknown): NextResponse {
  if (e instanceof KibbApiError) {
    const body = typeof e.body === "string" ? { status: e.status, detail: e.detail } : e.body;
    return NextResponse.json(body, { status: e.status });
  }
  console.error("[kibb]", e);
  return NextResponse.json({ status: 502, code: "upstream_unreachable", detail: (e as Error).message }, { status: 502 });
}
