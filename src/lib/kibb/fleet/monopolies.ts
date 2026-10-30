/**
 * Royal monopolies (the monopolies setting, OFF by default; guide 3.9). Pure logic, no calls.
 *
 * The game's terms: the Crown sells, for 5, 10 or 20 game days, the sole right to buy one good from its (NPC) asks at every port of one
 * banking region; everyone else (our own other companies included) must buy from the holder's resting asks or bring the goods in.
 * `world/monopoly-quote` prices it at a tenth of the Crown's expected sales of the good in the region over the term (its last 7 game days of
 * sales a day, never under 5 t a day at base per port), `market/buy-monopoly` charges it from our vault in that region, never refunded.
 * At most 2 in force per player; no back-to-back renewal of the same scope until 10 game days after a grant ends. It pays only by
 * reselling the region's Crown volume to other buyers at a markup (imports from neighbouring regions cap it, about 15%); a quiet good,
 * or one where we are the main buyer, is money thrown away.
 *
 * So the model is strict: other players' volume (the Crown's recent sales a day less our own fleet's buys of it in the region), over the
 * term, times the share of it we expect to capture through resting asks, times the markup net of the customs we pay buying it from the
 * Crown, must beat MONO_VALUE_X times the price; never when our own buys are MONO_MAIN_BUYER_SHARE or more of the Crown's sales. With the
 * guide's figures (a tenth of sales for the price, a ~15% markup) it passes only where other players' buying runs well ahead of what the
 * quote expects: rarely, by design. While a grant of ours is in force, a small stock is bought from the Crown's asks at region ports where
 * we have presence and offered under resting asks at the markup; what is left when it ends is sold as any landed goods.
 */

/** The term bought (game days; the game sells 5, 10 or 20). */
export const MONO_TERM_GAME_DAYS = 10;
/** The value over the price a grant must show. */
export const MONO_VALUE_X = 1.5;
/** The markup our resting asks take over the Crown's ask (imports cap it, guide 3.9), and the share of others' buying we expect to capture. */
export const MONO_MARKUP = 0.15;
export const MONO_CAPTURE = 0.6;
/** Our own buys at or above this share of the Crown's sales: we are the main buyer. */
export const MONO_MAIN_BUYER_SHARE = 0.3;
/** Quotes read a pass at most, each kept this long (real ms). */
export const MONO_QUOTES_PER_PASS = 3;
export const MONO_QUOTE_TTL_MS = 30 * 60_000;
/** No grant of the same scope again until this long after ours ends (game days; guide 3.9). */
export const MONO_GAP_GAME_DAYS = 10;
/** The resale stock bought a port at a time (tons), and the most of the budget it may hold at cost. */
export const MONO_RESALE_TONS = 20;
export const MONO_STOCK_SHARE = 0.5;
/** A buy with no answer is looked for among the grants this long (real ms), then taken as not made. */
export const MONO_PENDING_MS = 10 * 60_000;
/** The pass's clock (real ms). */
export const MONO_CHECK_MS = 10 * 60_000;
/** Records kept for the report. */
export const MONOPOLIES_KEPT = 20;

export interface MonopolyCase {
  /** Other players' Crown buying a day, ours a day, our share of the Crown's sales (pence a day; 0-1). */
  othersDaily: number;
  oursDaily: number;
  oursShare: number;
  /** The markup net of customs, the value over the term, and whether it clears the gate (and why not). */
  netMarkup: number;
  value: number;
  ok: boolean;
  why: string;
}

/**
 * The case for a grant at `price` (pence) over `term` game days: `recentDaily` the Crown's recent sales a day (the quote's recent sales over
 * its lookback), `expectedDaily` what the quote expects a day, `oursDaily` our fleet's buys of the good in the region a day (pence), the
 * region's customs (bps).
 */
export function monopolyCase(x: { price: number; term: number; recentDaily: number; expectedDaily: number; oursDaily: number; customsBps: number }): MonopolyCase {
  const sales = Math.max(x.recentDaily, x.expectedDaily, 1);
  const oursDaily = Math.max(0, x.oursDaily);
  const oursShare = oursDaily / sales;
  const othersDaily = Math.max(0, x.recentDaily - oursDaily);
  const netMarkup = Math.max(0, MONO_MARKUP - Math.max(0, x.customsBps) / 10_000);
  const value = othersDaily * Math.max(0, x.term) * MONO_CAPTURE * netMarkup;
  const base = { othersDaily: Math.round(othersDaily), oursDaily: Math.round(oursDaily), oursShare, netMarkup, value: Math.round(value) };
  if (oursShare >= MONO_MAIN_BUYER_SHARE) return { ...base, ok: false, why: `our fleet buys ${Math.round(oursShare * 100)}% of the Crown's sales there: the main buyer` };
  if (!(x.price > 0)) return { ...base, ok: false, why: "no price quoted" };
  if (value <= MONO_VALUE_X * x.price) return { ...base, ok: false, why: `others' buying resold at the markup is worth ~${Math.round(value / Math.max(1, x.price) * 100) / 100}x the price (needs ${MONO_VALUE_X}x)` };
  return { ...base, ok: true, why: "others' buying resold at the markup beats the price by the margin" };
}

/**
 * One grant we bought. Times server ms. `status`: `buying` (sent, no answer), `active` (in force), `ended`, `failed` (refused, or not found
 * after a buy with no answer).
 */
export interface MonopolyRec {
  id: string | null;
  region: string;
  good: string;
  term: number;
  price: number;
  value: number;
  status: "buying" | "active" | "ended" | "failed";
  at: number;
  expiresAt: number;
  /** Resale: tons bought from the Crown and their cost; tons sold through our asks and what they fetched (pence). */
  boughtTons: number;
  boughtPence: number;
  soldTons: number;
  soldPence: number;
  doneAt?: number;
  why?: string;
}

export const monopolyLive = (r: MonopolyRec) => r.status === "buying" || r.status === "active";

export interface MonopolyStats {
  quoted: number;
  bought: number;
  spentPence: number;
  resoldTons: number;
  resoldPence: number;
}

export const emptyMonopolyStats = (): MonopolyStats => ({ quoted: 0, bought: 0, spentPence: 0, resoldTons: 0, resoldPence: 0 });

/** Monopolies for the panel and the digest (pence; times ISO). */
export interface MonopolyReport {
  enabled: boolean;
  blocked: string | null;
  budgetPence: number;
  action: string;
  /** The best case weighed lately (none bought: why). */
  best: { region: string; good: string; pricePence: number; valuePence: number; oursShare: number; why: string } | null;
  held: Array<{ region: string; good: string; pricePence: number; expiresAt: string; status: MonopolyRec["status"]; boughtTons: number; soldTons: number; soldPence: number }>;
  recent: Array<{ at: string; region: string; good: string; pricePence: number; status: MonopolyRec["status"]; soldPence: number; why: string | null }>;
  stats: MonopolyStats;
}

const STATUSES: ReadonlyArray<MonopolyRec["status"]> = ["buying", "active", "ended", "failed"];

export function restoreMonopolies(s: { recs?: MonopolyRec[]; stats?: Partial<MonopolyStats> } | undefined): { recs: MonopolyRec[]; stats: MonopolyStats } {
  const stats = emptyMonopolyStats();
  for (const k of Object.keys(stats) as (keyof MonopolyStats)[]) {
    const v = s?.stats?.[k];
    if (typeof v === "number" && Number.isFinite(v)) stats[k] = v;
  }
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const recs = (Array.isArray(s?.recs) ? s!.recs : [])
    .filter(
      (r) =>
        r &&
        typeof r.region === "string" &&
        typeof r.good === "string" &&
        (r.id === null || typeof r.id === "string") &&
        STATUSES.includes(r.status) &&
        Number.isFinite(r.price) &&
        Number.isFinite(r.at) &&
        Number.isFinite(r.expiresAt),
    )
    .map((r) => ({ ...r, boughtTons: n(r.boughtTons), boughtPence: n(r.boughtPence), soldTons: n(r.soldTons), soldPence: n(r.soldPence) }))
    .slice(-MONOPOLIES_KEPT);
  return { recs, stats };
}
