/**
 * Server-side helpers for the dashboard's kibb.io routes: upstream URL, key minting, error replies.
 * Server-only (pulls in the local store).
 */

import { createHash } from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";
import { KibbClient, KibbApiError, KIBB_DEFAULT_URL } from "./client";
import { COOKIE_COMPANY_ID, COOKIE_PLAYER_KEY } from "./cookies";
import { getCompanyKey, keyIsUsable, listCompanyKeys, saveCompanyKey, type StoredCompanyKey } from "./store";
import type { ApiKeyScope } from "./types";

export const KIBB_URL = process.env.KIBB_API_URL ?? KIBB_DEFAULT_URL;

/** Player keys from dashboard logins last the 90-day season. */
export const PLAYER_KEY_TTL_S = 90 * 24 * 60 * 60;

/** Everything a company key can hold except account management and the Free Trade (`underworld`, guide 3.18). */
export const COMPANY_KEY_SCOPES: ApiKeyScope[] = [
  "read",
  "fleet_navigate",
  "fleet_cargo",
  "market_spot",
  "market_derivatives",
  "infra_manage",
  "treasury_remit",
];
/**
 * Smuggling (guide 3.18: everything under `/v1/underworld/*`): never on a company key by default, so a trading key can't
 * gamble ships. Added only when the owner allows it on the Underworld page (setCompanyUnderworld); every renewal keeps it
 * from then on, until the owner withdraws it there.
 */
export const SMUGGLING_SCOPE: ApiKeyScope = "underworld";

/** The scopes a company key is minted with: the base set, and `underworld` once the owner allowed smuggling. */
function companyScopes(underworld: boolean): ApiKeyScope[] {
  return underworld ? [...COMPANY_KEY_SCOPES, SMUGGLING_SCOPE] : [...COMPANY_KEY_SCOPES];
}

const sameScopes = (a: readonly ApiKeyScope[], b: readonly ApiKeyScope[]) => a.length === b.length && a.every((s) => b.includes(s));

/** Whether a stored key holds `underworld` (an older store's record without scopes: not until whoami says so). */
export function keyAllowsSmuggling(key: StoredCompanyKey | null | undefined): boolean {
  return !!key?.scopes?.includes(SMUGGLING_SCOPE);
}

/** Reuse a stored company key with at least this much life left, instead of minting a new one. */
const REUSE_MIN_LIFE_MS = 24 * 60 * 60 * 1000;
/** A stored key with less life than this is renewed (best effort) while its owner is signed in; looked at this often per company. */
const RENEW_WITHIN_MS = 7 * 24 * 60 * 60 * 1000;
const RENEW_CHECK_MS = 10 * 60_000;
/** A renewal is only worth it when the player key outlives the stored key by this much (a sub-key can't outlive it). */
const RENEW_MIN_GAIN_MS = 24 * 60 * 60 * 1000;

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

// Key changes for one company run one at a time, across Next.js module instances: a renewal racing the Underworld page's
// allow or withdraw would otherwise mint (or record) with scopes read before the other's change, and could put back a scope
// the owner just withdrew.
const gl = globalThis as { __kibbKeyLocks?: Map<string, Promise<unknown>> };
const keyLocks = (gl.__kibbKeyLocks ??= new Map<string, Promise<unknown>>());

/** Runs `fn` holding the company's key lock (a promise chain per company). */
export function withCompanyKeyLock<T>(companyId: string, fn: () => Promise<T>): Promise<T> {
  const next = (keyLocks.get(companyId) ?? Promise.resolve()).then(fn);
  const tail = next.catch(() => undefined);
  keyLocks.set(companyId, tail);
  void tail.then(() => {
    if (keyLocks.get(companyId) === tail) keyLocks.delete(companyId);
  });
  return next;
}

/** Records what whoami said a stored key holds, unless that key was replaced meanwhile (under the company's key lock). */
export function recordCompanyKeyScopes(companyId: string, keyId: string, scopes: ApiKeyScope[]): Promise<void> {
  return withCompanyKeyLock(companyId, async () => {
    const cur = await getCompanyKey(companyId);
    if (cur && cur.keyId === keyId && !(cur.scopes && sameScopes(cur.scopes, scopes))) await saveCompanyKey({ ...cur, scopes });
  });
}

/**
 * Returns the stored company key, minting one with the player key if none has `minLifeMs` of life left (a day by default).
 * `underworld` (the Underworld page's allow / withdraw): a key with exactly that scope set, minted afresh if the stored one
 * differs, and a running autopilot switched to it before this returns. Left out (selecting a company, renewals): the
 * scopes the stored key holds (or held, once it has expired), so smuggling once allowed stays allowed until withdrawn.
 * Holds the company's key lock throughout.
 */
export function ensureCompanyKey(
  playerKey: string,
  company: { id: string; name: string },
  minLifeMs = REUSE_MIN_LIFE_MS,
  opts: { underworld?: boolean } = {},
): Promise<StoredCompanyKey> {
  return withCompanyKeyLock(company.id, () => companyKeyLocked(playerKey, company, minLifeMs, opts));
}

/** ensureCompanyKey's work; the caller holds the company's key lock. */
async function companyKeyLocked(
  playerKey: string,
  company: { id: string; name: string },
  minLifeMs: number,
  opts: { underworld?: boolean },
): Promise<StoredCompanyKey> {
  const stored = await getCompanyKey(company.id);
  // The owner's recorded choice outlives the key: an expired key's record still says whether smuggling was allowed.
  const recorded = stored ?? (await listCompanyKeys()).find((k) => k.companyId === company.id) ?? null;
  const underworld = opts.underworld ?? keyAllowsSmuggling(recorded);
  const scopes = companyScopes(underworld);
  // An older store's key has no scopes recorded: the base set until whoami says otherwise.
  const storedScopes = stored?.scopes ?? COMPANY_KEY_SCOPES;
  if (stored && keyIsUsable(stored, minLifeMs) && (opts.underworld === undefined || sameScopes(storedScopes, scopes))) {
    // Reuse it only if the game still accepts it (it may have been revoked).
    try {
      const who = await kibb(stored.apiKey).whoami();
      if (!stored.scopes || !sameScopes(stored.scopes, who.scopes)) {
        const known = { ...stored, scopes: who.scopes };
        await saveCompanyKey(known);
        // Asked for a scope set the key turned out not to hold: mint one below.
        if (opts.underworld === undefined || sameScopes(who.scopes, scopes)) return known;
      } else return stored;
    } catch (e) {
      if (!(e instanceof KibbApiError) || e.status !== 401) return stored;
    }
  }

  // A sub-key can't outlive the key that mints it, nor hold a scope it lacks.
  const player = kibb(playerKey);
  const who = await player.whoami();
  const playerLifeS = who.expires_at ? Math.floor((Date.parse(who.expires_at) - Date.now()) / 1000) - 60 : PLAYER_KEY_TTL_S;
  if (playerLifeS < 60) throw new KibbApiError(401, "expired_api_key", "Your session is about to expire; sign in again", "");
  let granted = scopes;
  if (underworld && !who.scopes.includes(SMUGGLING_SCOPE)) {
    const detail = "Your sign-in key doesn't hold the underworld scope (it predates the Free Trade): sign out and sign in again";
    if (opts.underworld) throw new KibbApiError(403, "missing_scope", detail, { status: 403, code: "missing_scope", detail });
    // A renewal: the company keeps trading; smuggling stops until the owner signs in again and allows it.
    console.error(`[kibb] renewing the key of ${company.name} without the underworld scope: ${detail}`);
    granted = companyScopes(false);
  }

  const res = await player.createKey({
    label: `dashboard:${company.name}`.slice(0, 64),
    scopes: granted,
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
    scopes: res.key.scopes?.length ? res.key.scopes : granted,
  };
  await saveCompanyKey(key);
  // A running autopilot still holds the old key: it switches to the new one (a failed one restarts on it). A scope change
  // waits for it, so the key it replaces can be revoked once nothing uses it.
  const refresh = import("./fleet-registry").then((m) => m.refreshFleetKey(company.id));
  if (opts.underworld !== undefined) await refresh.catch((e) => console.error(`[kibb] switching the autopilot of ${company.name} to its new key failed: ${(e as Error).message}`));
  else void refresh.catch(() => undefined);
  return key;
}

/**
 * The owner allows (or withdraws) smuggling for a company, from the Underworld page (guide 3.18: scope `underworld`): its
 * stored key is minted again with (or without) the scope, with the signed-in owner's player key; a running autopilot takes
 * the new key at once (FleetManager.useApiKey reads its scopes), and the key it replaced is revoked, so a key holding the
 * scope never outlives the owner's "no". Returns the key now stored.
 */
export function setCompanyUnderworld(playerKey: string, company: { id: string; name: string }, allow: boolean): Promise<StoredCompanyKey> {
  // Under the company's key lock: a renewal can't mint in between with the scopes read before this change.
  return withCompanyKeyLock(company.id, async () => {
    const before = (await listCompanyKeys()).find((k) => k.companyId === company.id) ?? null;
    const key = await companyKeyLocked(playerKey, company, REUSE_MIN_LIFE_MS, { underworld: allow });
    if (before && before.keyId !== key.keyId) {
      await kibb(playerKey)
        .revokeKey(before.keyId)
        .catch((e) => console.error(`[kibb] revoking the replaced key of ${company.name} failed: ${(e as Error).message}`));
    }
    return key;
  });
}

// Which companies each signed-in player owns, cached briefly (keyed by a hash of the player key).
const g = globalThis as { __kibbOwners?: Map<string, { ids: Set<string>; at: number }>; __kibbRenewChecked?: Map<string, number> };
const owners = (g.__kibbOwners ??= new Map());
const renewChecked = (g.__kibbRenewChecked ??= new Map<string, number>());

/**
 * Best effort, from the dashboard's fleet poll: mints a fresh company key once the stored one has under 7 days
 * left (or has run out), with the signed-in owner's player key (the cookie), at most every 10 min per company.
 * Skipped when the player key wouldn't outlive the stored key by a day: then the panel says to sign in again.
 * The running autopilot takes the new key without a restart (ensureCompanyKey → refreshFleetKey).
 */
export async function renewCompanyKeyIfDue(req: NextRequest, companyId: string): Promise<void> {
  const playerKey = req.cookies.get(COOKIE_PLAYER_KEY)?.value;
  if (!playerKey || Date.now() - (renewChecked.get(companyId) ?? 0) < RENEW_CHECK_MS) return;
  renewChecked.set(companyId, Date.now());
  const stored = (await listCompanyKeys()).find((k) => k.companyId === companyId);
  const ends = stored?.expiresAt ? Date.parse(stored.expiresAt) : NaN;
  if (!stored || !Number.isFinite(ends) || ends - Date.now() > RENEW_WITHIN_MS) return;
  const who = await kibb(playerKey).whoami();
  const playerEnds = who.expires_at ? Date.parse(who.expires_at) : Infinity;
  if (!(playerEnds - ends >= RENEW_MIN_GAIN_MS)) return;
  await ensureCompanyKey(playerKey, { id: companyId, name: stored.companyName }, RENEW_WITHIN_MS);
}
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
