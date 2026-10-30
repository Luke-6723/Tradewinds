/**
 * Ship shares (guide 3.13.6; the `shipShares` setting): 64ths of other players' earning ships. Pure logic, no calls.
 *
 * The game's terms: a ship is 64ths, her owner holding every one nobody else does. Any holder lists (`ship-shares/list`, 50%..=150% of a
 * 64th of her rebuild value, fitted components included, paid in the region named); anyone buys a listing whole (`ship-shares/buy`, no
 * presence, the band checked again). Every game day the owner pays each outside holder its 64ths of her realised P&L above what was
 * already paid (sales from her hold less cargo bought into it, freight rewards, her berth dues, her merchant's venture shares), from the
 * owner's home vault. Shares follow the ship to a new owner and are worthless if she sinks. The Merchant Adventurers buy a listing an
 * hour old priced well below both a 64th of her rebuild value and what she earned lately per 64th (a ship that hasn't earned gets no
 * bid), so 64ths of an earning ship can always be sold.
 *
 * What we can know of a ship's earnings: a listing (and its Exchange entry) shows her name, class, owner, 64ths and price, never what
 * she earns; rival intel sees her voyages, never her P&L. Only our own holdings (`ship-shares/holdings`) show a ship's realised P&L
 * (since her shares were first issued) and the dividends paid us. Her realised P&L swings with every cargo bought into her hold and
 * sold out of it, so two readings of it say little; the dividends paid us only rise, and are exactly what a 64th of her brings. So
 * earnings are read only from our own samples of the dividends paid us, per 64th, over at least SHARES_MIN_SPAN_GAME_DAYS (earnRate),
 * and the autopilot buys only more of ships it already holds: no first buy on a ship whose earnings can't be read (a holding bought by
 * hand is where it starts).
 *
 * How the autopilot uses it (manager.ts runShares):
 *   - a listing of a ship we hold (never one of ours, never our own companies' listing) is bought when her earnings a game day per 64th,
 *     discounted for her loss (SHARES_RISK), pay its price back within SHARES_PAYBACK_GAME_DAYS (and half the season left), our 64ths of
 *     her stay within SHARES_MAX_PER_SHIP (diversified), and what the autopilot has in shares stays within `sharesBudgetPence`;
 *   - dividends are tracked per holding (the yield on what we paid);
 *   - a holding whose ship paid us no dividend over SHARES_COLLAPSE_GAME_DAYS is listed for sale down a short ladder of a 64th of her rebuild
 *     value (SHARES_SELL_LADDER, our figure for her class), withdrawn when she earns again; a sunk ship's shares are written off;
 *   - every buy and listing is saved before it is sent, and one with no answer is reconciled from our holdings and listings.
 */

import type { BankingRegion } from "../types";

/** Defaults and limits. */
export const SHARES_DEFAULT_BUDGET_PENCE = 1_000_000;
export const SHARES_MAX_PER_SHIP = 8;
/**
 * Earnings read from our own samples of the dividends paid us spanning at least this many game days (a ship pays in lumps, a sale from
 * her hold at a time: an ocean passage can take a fortnight of game days between them).
 */
export const SHARES_MIN_SPAN_GAME_DAYS = 10;
/** After our 64ths of her change (or she is first seen), game days before her dividends are sampled again (a payment catching up on them isn't earnings). */
export const SHARES_SETTLE_GAME_DAYS = 1.5;
/** A buy must pay back within this many game days (and half the season left). */
export const SHARES_PAYBACK_GAME_DAYS = 20;
/** Share of a ship's earnings discounted for her loss (sinking, capture, a sale that ends the dividends): flat, conservative. */
export const SHARES_RISK = 0.15;
/** A ship that paid us no dividend over this many game days: her 64ths are listed for sale. */
export const SHARES_COLLAPSE_GAME_DAYS = 10;
/** The sale ladder: shares of a 64th of her rebuild value (our figure), each step held SHARES_SELL_STEP_GAME_H game hours. */
export const SHARES_SELL_LADDER: readonly number[] = [1, 0.8, 0.6];
export const SHARES_SELL_STEP_GAME_H = 12;
/** How often the holdings are read (real ms), a call with no answer reconciled for this long, samples kept per holding. */
export const SHARES_CHECK_MS = 10 * 60_000;
export const SHARES_PENDING_MS = 10 * 60_000;
export const SHARES_SAMPLES_KEPT = 60;
export const SHARES_EVENTS_KEPT = 30;

/** One holding as the autopilot keeps it (saved). Samples: [server ms, pence]. */
export interface HoldingRec {
  shipId: string;
  ship: string;
  owner: string;
  /** Our 64ths as last read. */
  sixty: number;
  /** What the autopilot paid for 64ths of her and how many it bought (a holding bought by hand: 0). */
  costPence: number;
  boughtSixty: number;
  /** The dividends paid us on her (`dividends_paid_pence`) as sampled, all while we held `divSixty` 64ths of her. */
  samples: Array<[number, number]>;
  /**
   * Our 64ths of her the samples were taken with (absent: an older save's samples of her P&L, dropped on restore), and the server ms
   * before which none is taken (after a change in our 64ths: SHARES_SETTLE_GAME_DAYS).
   */
  divSixty?: number;
  divFrom?: number;
  /** The dividends paid us on her, as last read (the most seen). */
  dividends: number;
  /** Her class, when an Exchange entry named it (for her rebuild value). */
  cls: string | null;
  sunk: boolean;
  /** Our listing of her 64ths: its id (null: a listing with no answer, looked for), price per 64th, 64ths, when (local ms), ladder step. */
  listing: { id: string | null; price: number; sixty: number; at: number; step: number } | null;
  /** Local ms last seen in our holdings. */
  seen: number;
}

/** A buy or a listing sent with no answer (local ms): reconciled from our holdings and listings, never sent again blind. */
export interface SharePending {
  kind: "buy" | "list";
  shipId: string;
  listingId: string | null;
  sixty: number;
  price: number;
  region: BankingRegion;
  at: number;
  /** Our 64ths of her before the buy. */
  before: number;
}

export interface ShareStats {
  bought: number;
  spentPence: number;
  sold: number;
  soldPence: number;
  dividendsPence: number;
  writtenOffPence: number;
}

export interface ShareEvent {
  at: string;
  ship: string;
  what: "bought" | "listed" | "sold" | "withdrawn" | "sunk";
  sixty: number;
  pence: number;
  note?: string;
}

export interface ShareMemory {
  holdings: HoldingRec[];
  pending: SharePending | null;
  stats: ShareStats;
  recent: ShareEvent[];
}

export function emptyShares(): ShareMemory {
  return { holdings: [], pending: null, stats: { bought: 0, spentPence: 0, sold: 0, soldPence: 0, dividendsPence: 0, writtenOffPence: 0 }, recent: [] };
}

export function restoreShares(s: Partial<ShareMemory> | undefined): ShareMemory {
  const m = emptyShares();
  if (!s) return m;
  const pairs = (x: unknown) => (Array.isArray(x) ? x.filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1])) : []) as Array<[number, number]>;
  m.holdings = (Array.isArray(s.holdings) ? s.holdings : [])
    .filter((h) => h && typeof h.shipId === "string" && Number.isFinite(h.sixty))
    .map((h) => ({
      shipId: h.shipId,
      ship: typeof h.ship === "string" ? h.ship : h.shipId,
      owner: typeof h.owner === "string" ? h.owner : "",
      sixty: h.sixty,
      costPence: Number.isFinite(h.costPence) ? h.costPence : 0,
      boughtSixty: Number.isFinite(h.boughtSixty) ? h.boughtSixty : 0,
      // Without divSixty the samples are an older save's of her P&L: dropped (dividends are sampled afresh).
      samples: Number.isFinite(h.divSixty) ? pairs(h.samples).slice(-SHARES_SAMPLES_KEPT) : [],
      ...(Number.isFinite(h.divSixty) ? { divSixty: h.divSixty } : {}),
      ...(Number.isFinite(h.divSixty) && Number.isFinite(h.divFrom) ? { divFrom: h.divFrom } : {}),
      dividends: Number.isFinite(h.dividends) ? h.dividends : 0,
      cls: typeof h.cls === "string" ? h.cls : null,
      sunk: !!h.sunk,
      listing: h.listing && Number.isFinite(h.listing.price) && Number.isFinite(h.listing.at) ? { ...h.listing, id: typeof h.listing.id === "string" ? h.listing.id : null } : null,
      seen: Number.isFinite(h.seen) ? h.seen : 0,
    }));
  const p = s.pending;
  if (p && (p.kind === "buy" || p.kind === "list") && typeof p.shipId === "string" && Number.isFinite(p.at)) m.pending = { ...p };
  for (const k of Object.keys(m.stats) as (keyof ShareStats)[]) {
    const v = s.stats?.[k];
    if (typeof v === "number" && Number.isFinite(v)) m.stats[k] = v;
  }
  m.recent = (Array.isArray(s.recent) ? s.recent : []).filter((e) => e && typeof e.at === "string").slice(-SHARES_EVENTS_KEPT);
  return m;
}

/**
 * A sample of the dividends paid us on her (server ms `at`, while we hold `sixty` 64ths), kept only when it moved or a game day went by
 * (so a quiet ship's samples still span time). A change in our 64ths (or her first sighting) starts the samples again once
 * SHARES_SETTLE_GAME_DAYS are past, so a payment catching up on the new 64ths is never read as earnings.
 */
export function addSample(h: HoldingRec, at: number, paid: number, sixty: number, gameDayMs: number): void {
  if (h.divSixty !== sixty) {
    h.samples = [];
    h.divSixty = sixty;
    h.divFrom = at + SHARES_SETTLE_GAME_DAYS * gameDayMs;
  }
  if (at < (h.divFrom ?? 0)) return;
  const last = h.samples.at(-1);
  if (last && last[1] === paid && at - last[0] < gameDayMs) return;
  h.samples.push([at, paid]);
  if (h.samples.length > SHARES_SAMPLES_KEPT) h.samples.splice(0, h.samples.length - SHARES_SAMPLES_KEPT);
}

/**
 * What a 64th of her earned us a game day (pence): the rise in the dividends paid us over our samples of the last `windowDays` game
 * days, per 64th held, when they span at least SHARES_MIN_SPAN_GAME_DAYS. Counted from the first payment the samples saw, over their
 * whole span (a payment landing just after the first sample would make the span look richer than she is): on the low side. Null: our
 * samples don't show it yet (no buy on it).
 */
export function earnRate(h: Pick<HoldingRec, "samples" | "divSixty">, now: number, gameDayMs: number, windowDays = 2 * SHARES_PAYBACK_GAME_DAYS): number | null {
  const sixty = h.divSixty ?? 0;
  if (!(sixty > 0)) return null;
  const xs = h.samples.filter(([t]) => now - t <= windowDays * gameDayMs);
  if (xs.length < 2) return null;
  const last = xs[xs.length - 1];
  const span = last[0] - xs[0][0];
  if (span < SHARES_MIN_SPAN_GAME_DAYS * gameDayMs) return null;
  const first = xs.findIndex(([, p], i) => i > 0 && p > xs[i - 1][1]);
  const paid = first > 0 ? Math.max(0, last[1] - xs[first][1]) : 0;
  return (paid / span) * (gameDayMs / sixty);
}

/**
 * Whether she paid us a dividend within the last SHARES_COLLAPSE_GAME_DAYS (a rise between two of our samples). Not the opposite of
 * collapsed: samples too short to tell (just started again) are neither.
 */
export function paidLately(samples: ReadonlyArray<[number, number]>, now: number, gameDayMs: number): boolean {
  const win = SHARES_COLLAPSE_GAME_DAYS * gameDayMs;
  return samples.some(([t, p], i) => i > 0 && now - t <= win && p > samples[i - 1][1]);
}

/** Whether her earnings have collapsed: no dividend paid us over the last SHARES_COLLAPSE_GAME_DAYS, our samples spanning them. */
export function collapsed(samples: ReadonlyArray<[number, number]>, now: number, gameDayMs: number): boolean {
  const win = SHARES_COLLAPSE_GAME_DAYS * gameDayMs;
  const before = [...samples].reverse().find(([t]) => now - t >= win);
  const last = samples.at(-1);
  if (!before || !last || last[0] - before[0] < win) return false;
  return last[1] - before[1] <= 0;
}

/**
 * Whether a listing of a ship we hold is worth buying: what a 64th of her earned us a game day (earnRate), less SHARES_RISK, pays the
 * price per 64th back within the payback horizon. The payback (game days), or why not.
 */
export function buyCase(c: { pricePer64: number; ratePer64: number | null; seasonLeftDays: number }): { ok: true; paybackDays: number } | { ok: false; why: string } {
  if (c.ratePer64 === null) return { ok: false, why: `her dividends can't be read yet (our samples span under ${SHARES_MIN_SPAN_GAME_DAYS} game days)` };
  const per64 = c.ratePer64 * (1 - SHARES_RISK);
  if (!(per64 > 0)) return { ok: false, why: "she paid us no dividend lately (past the first)" };
  const days = c.pricePer64 / per64;
  const horizon = Math.min(SHARES_PAYBACK_GAME_DAYS, c.seasonLeftDays / 2);
  if (days > horizon) return { ok: false, why: `pays back in ~${days.toFixed(1)} game days (limit ${horizon.toFixed(1)})` };
  return { ok: true, paybackDays: days };
}

/** A 64th's sale price at a ladder step (pence): that share of a 64th of her rebuild value (our figure), whole Crowns. */
export function sellPrice(rebuild: number, step: number): number {
  const share = SHARES_SELL_LADDER[Math.min(Math.max(0, step), SHARES_SELL_LADDER.length - 1)];
  return Math.max(100, Math.round((rebuild / 64) * share / 100) * 100);
}

/** Ship shares for the panel (`/shares`) and the digest. Pence; times ISO. */
export interface SharesReport {
  enabled: boolean;
  budgetPence: number;
  /** What the autopilot paid for the 64ths still held. */
  investedPence: number;
  blocked: string | null;
  action: string;
  checkedAt: string | null;
  holdings: Array<{
    shipId: string;
    ship: string;
    sixtyFourths: number;
    costPence: number;
    dividendsPence: number;
    /** The dividends a game day our 64ths of her earn us (earnRate; null: not read yet), and the yield on what we paid (bps a game day; null: bought by hand). */
    ourEarnPerDayPence: number | null;
    yieldBpsPerDay: number | null;
    sunk: boolean;
    listing: { pricePer64thPence: number; sixtyFourths: number; step: number; since: string } | null;
    verdict: string;
  }>;
  /** Listings of ships we hold, as last weighed. */
  candidates: Array<{ listingId: string; ship: string; sixtyFourths: number; pricePer64thPence: number; verdict: string }>;
  stats: ShareStats;
  recent: ShareEvent[];
}
