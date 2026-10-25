/**
 * Ship deals and intelligence envelopes (guide 3.4, 3.11), pure: no I/O. The manager reads the listings, commissions
 * and its envelopes and makes every call; this says on what terms.
 *
 * Ship market: a ship for sale where we have quay presence is worth buying only below what building its class costs
 * (at that yard, else the cheapest build seen; its guns at their refit price), and then only through every check a
 * build passes (payback on its first lane, upkeep, cash after loads, max ships, the season).
 *
 * Commissions (building to order): the buyer escrows the price, the builder the collateral; delivering builds the hull
 * at the builder's cost and pays the builder the price with its collateral back, a missed deadline forfeits the
 * collateral. Accepted only when the price beats our cheapest build by a clear margin after the collateral's risk.
 *
 * Envelopes: news our quays hold, sealed and listed at a modest price per item, halved for every 12 game hours of age.
 */

import type { EnvelopeCategory } from "../schema";

/** A commission is taken only when price − our build cost − the collateral's risk is at least this share of the price and this much. */
export const COMMISSION_MIN_MARGIN_SHARE = 0.1;
export const COMMISSION_MIN_MARGIN_PENCE = 100_000;
/** The chance a delivery fails before its deadline (the build is delivered at once; a retry needs presence there again). */
export const COMMISSION_FAIL_RISK = 0.05;
/** Game hours a commission must still have to run when accepted. */
export const COMMISSION_MIN_LEFT_GAME_H = 3;

/** Envelopes: a fresh one per port and kind at most this often, withdrawn unsold after this, lapsing after this (game hours). */
export const ENVELOPE_EVERY_GAME_H = 2;
export const ENVELOPE_STALE_GAME_H = 12;
export const ENVELOPE_LIFE_GAME_H = 24;
/** Our own open envelopes at most (the game allows 20 a company: room is left for ones posted by hand). */
export const ENVELOPE_MAX_OPEN = 16;
export const ENVELOPE_GAME_CAP = 20;
/** Price per item by section (pence), halved per ENVELOPE_HALF_LIFE_GAME_H of age, within a floor and a cap. */
export const ENVELOPE_ITEM_PENCE: Record<EnvelopeCategory, number> = { port_reports: 1_500, charters: 2_000, sailings: 500 };
export const ENVELOPE_HALF_LIFE_GAME_H = 12;
export const ENVELOPE_FLOOR_PENCE = 1_000;
export const ENVELOPE_CAP_PENCE = 30_000;

/**
 * Whether an open commission pays to build (pence): price − our cheapest build − the collateral at its risk, against
 * the least margin; with the game hours left before its deadline.
 */
export function commissionCase(c: { price: number; collateral: number; cost: number; leftGameH: number }):
  | { ok: true; margin: number }
  | { ok: false; margin: number; why: string; code: "margin" | "deadline" } {
  const margin = Math.round(c.price - c.cost - COMMISSION_FAIL_RISK * c.collateral);
  if (c.leftGameH < COMMISSION_MIN_LEFT_GAME_H) return { ok: false, margin, why: `${c.leftGameH.toFixed(1)} game h left before its deadline`, code: "deadline" };
  const need = Math.max(COMMISSION_MIN_MARGIN_PENCE, Math.ceil(c.price * COMMISSION_MIN_MARGIN_SHARE));
  if (margin < need) return { ok: false, margin, why: `margin ${Math.round(margin / 100)} Cr under the ${Math.round(need / 100)} Cr it needs`, code: "margin" };
  return { ok: true, margin };
}

/** Once accepted, a delivery still beats forfeiting the collateral while the build costs less than the price and the collateral back. */
export function deliveryPays(c: { price: number; collateral: number; cost: number }): boolean {
  return c.cost < c.price + c.collateral;
}

/** What a listed ship is worth to us (pence): building its class (here, else the cheapest seen) plus its guns at their refit price. */
export function listingWorth(build: number, guns: number, gunPence: number): number {
  return build + guns * gunPence;
}

/**
 * An envelope's price (pence): per item by section, each section halved for every ENVELOPE_HALF_LIFE_GAME_H of its age,
 * rounded to whole Crowns within the floor and the cap.
 */
export function envelopePrice(items: Array<{ kind: EnvelopeCategory; n: number; ageGameH: number }>): number {
  let p = 0;
  for (const x of items) p += x.n * ENVELOPE_ITEM_PENCE[x.kind] * 0.5 ** (Math.max(0, x.ageGameH) / ENVELOPE_HALF_LIFE_GAME_H);
  return Math.min(ENVELOPE_CAP_PENCE, Math.max(ENVELOPE_FLOOR_PENCE, Math.round(p / 100) * 100));
}
