/**
 * Server-side helpers for the dashboard's kibb.io routes: upstream URL, key minting, error replies.
 * Server-only (pulls in the local store).
 */

import { NextResponse } from "next/server";
import { KibbClient, KibbApiError, KIBB_DEFAULT_URL } from "./client";
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

export function cookieOptions(maxAgeS: number) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
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
  if (stored && keyIsUsable(stored, REUSE_MIN_LIFE_MS)) return stored;

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
  return key;
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
