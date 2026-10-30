/**
 * Buying intelligence envelopes (the buyEnvelopes setting; guide 3.11). Pure logic, no calls.
 *
 * An envelope for sale (`envelope/list`, public: never its contents) names the ports it covers, its sections and the age of its oldest
 * and newest items; buying needs presence at its port (a lease, a ship or a factor), and its contents (copied from game data with their
 * original timestamps) are read from the purchase or `envelope/mine`. Its port reports are worth to us what they could change in the
 * fleet's next choice of lane, as the market model sees it: the value of information, kept simple and conservative.
 *
 *   - Per candidate lane (the planner's best for the reference ship, best first): each market part's sale price at the destination (bids)
 *     and its buy price at the source (asks), where the envelope covers that port and its report there is newer than anything we hold
 *     (its OLDEST item's time is taken, the safe side: the listing doesn't say which item is which port's). The forecast's variance there
 *     at the time it matters falls from what the model has now to what a reading at the report's time would leave (the stock's OU
 *     reversion from it, plus gossip's noise), through the price curve's slope: `cut` = tons² × that fall (pence² over the leg). With
 *     no model of that book, a rough relative sd growing with the steps since the price we hold, half counted.
 *   - The decision is the best lane against each alternative, in profit per hour: σ the sd of the difference those cuts resolve (keys
 *     both lanes share left out: they cancel), `gap` the distance between them in the score the ranking sorted them by (laneScore:
 *     profit per hour less the capital charge; absolute, so a lane ranked lower on a higher profit per hour is no coin-flip); the
 *     expected improvement σ·L(gap/σ) over the best lane's hours (L the unit normal loss). The largest over the alternatives, never
 *     their sum: one decision, one ship.
 *   - Bought only when ENVELOPE_VOI_HAIRCUT of that beats its price, within `envelopeBudgetPence` in any 24 real hours, never our own.
 */

/** Spent on envelopes in any 24 real hours by default (pence; 2,000 Cr). */
export const ENVELOPE_BUY_DEFAULT_BUDGET_PENCE = 200_000;
/** Share of the value of information counted (the listing doesn't say which ports its reports are of; one decision, one ship). */
export const ENVELOPE_VOI_HAIRCUT = 0.5;
/** Candidate lanes weighed: the planner's best this many. */
export const ENVELOPE_VOI_LANES = 6;
/** Gossip's measurement noise on stock (as the market model takes it): (3% of the stock)² + 1 t². */
export const GOSSIP_STOCK_REL_SD = 0.03;
/** With no model of a book: the relative price sd a step since the price we hold, its cap, and the share counted. */
export const FALLBACK_REL_SD_PER_STEP = 0.05;
export const FALLBACK_REL_SD_MAX = 0.3;
export const FALLBACK_SHARE = 0.5;
/** A buy with no answer is looked for among ours this long (real ms), then taken as not made. */
export const ENVELOPE_BUY_PENDING_MS = 10 * 60_000;
/** Records kept for the report. */
export const ENVELOPE_BUYS_KEPT = 30;

/** The unit normal loss L(z) = φ(z) − z(1 − Φ(z)). */
function loss(z: number): number {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const erf = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  const cdf = z >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
  return Math.max(0, Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI) - z * (1 - cdf));
}

/**
 * The stock variance an OU forecast `steps` re-quotes after a gossip reading of `stock` leaves (t²): V∞(1 − ρ^2k) + ρ^2k·R, R the
 * reading's noise. `vInf`: the stationary variance (the forecast's far ahead), `rho` = 1 − θ.
 */
export function stockVarAfter(x: { vInf: number; rho: number; steps: number; stock: number }): number {
  const r2k = Math.pow(Math.min(0.999999, Math.max(0, x.rho)), 2 * Math.max(0, x.steps));
  const R = (GOSSIP_STOCK_REL_SD * Math.max(0, x.stock)) ** 2 + 1;
  return Math.max(0, x.vInf) * (1 - r2k) + r2k * R;
}

/** With no model of a book: the relative price variance cut a reading `stepsAfter` before the time asked about makes, against `stepsNow`. */
export function fallbackRelVarCut(stepsNow: number, stepsAfter: number): number {
  const rel = (k: number) => Math.min(FALLBACK_REL_SD_MAX, FALLBACK_REL_SD_PER_STEP * Math.sqrt(Math.max(0, k)));
  return FALLBACK_SHARE * Math.max(0, rel(stepsNow) ** 2 - (rel(stepsAfter) + 0.02) ** 2);
}

/**
 * One candidate lane as the VOI weighs it: its profit per hour, the score the ranking sorted it by (planner.ts laneScore: profit per hour
 * less the charge on its capital; absent: its profit per hour), its hours, and the variance (pence² over the leg) the report cuts per book.
 */
export interface LaneInfo {
  key: string;
  pph: number;
  score?: number;
  hours: number;
  cuts: Map<string, number>;
}

/**
 * The value of the information (pence) for choosing among `lanes` (best first): the best against each alternative, σ the sd in profit per
 * hour the cuts resolve on the difference (books both share left out), gap the distance between the two in the ranking's own score
 * (either way: an alternative ranked lower on a higher profit per hour is as far from being chosen); σ·L(gap/σ) over the best lane's
 * hours. The largest.
 */
export function laneVoi(lanes: readonly LaneInfo[]): { voi: number; against: string | null } {
  if (lanes.length < 2) return { voi: 0, against: null };
  const best = lanes[0];
  const score = (l: LaneInfo) => (l.score !== undefined && Number.isFinite(l.score) ? l.score : l.pph);
  let out = { voi: 0, against: null as string | null };
  for (const alt of lanes.slice(1)) {
    let v = 0;
    for (const [k, c] of best.cuts) if (!alt.cuts.has(k)) v += c / Math.max(best.hours, 0.05) ** 2;
    for (const [k, c] of alt.cuts) if (!best.cuts.has(k)) v += c / Math.max(alt.hours, 0.05) ** 2;
    if (!(v > 0)) continue;
    const sigma = Math.sqrt(v);
    // The cuts resolve profit per hour; the capital charge is known, so the score's difference is the lead they act on.
    const gap = Math.abs(score(best) - score(alt));
    const voi = sigma * loss(gap / sigma) * Math.max(best.hours, 0.05);
    if (voi > out.voi) out = { voi, against: alt.key };
  }
  return out;
}

/** One envelope we bought (or tried to). Times local ms (`at`) and server ms (`reportAt`). */
export interface EnvelopeBuyRec {
  id: string;
  port: string;
  price: number;
  /** The value of information it was bought on (pence, before the haircut), and the lane it might have overturned. */
  voi: number;
  against: string | null;
  covered: string[];
  at: number;
  status: "buying" | "bought" | "failed";
  /** Rows of port reports taken into the world and the market model, once read. */
  rows?: number;
  why?: string;
}

export interface EnvelopeBuyStats {
  bought: number;
  spentPence: number;
  rows: number;
  /** Passes that found one worth weighing, and the last pass's best VOI against its price. */
  weighed: number;
}

export const emptyEnvelopeBuyStats = (): EnvelopeBuyStats => ({ bought: 0, spentPence: 0, rows: 0, weighed: 0 });

/** Envelope buying for the panel and the digest (pence; times ISO). */
export interface EnvelopeBuyReport {
  enabled: boolean;
  blocked: string | null;
  budgetPence: number;
  spent24hPence: number;
  /** The last pass: what it did, and its best case (VOI after the haircut against the price). */
  action: string;
  best: { id: string; port: string; pricePence: number; worthPence: number } | null;
  recent: Array<{ at: string; port: string; pricePence: number; voiPence: number; status: EnvelopeBuyRec["status"]; rows: number | null; why: string | null }>;
  stats: EnvelopeBuyStats;
}

export function restoreEnvelopeBuys(s: { recs?: EnvelopeBuyRec[]; spends?: Array<[number, number]>; stats?: Partial<EnvelopeBuyStats> } | undefined): {
  recs: EnvelopeBuyRec[];
  spends: Array<[number, number]>;
  stats: EnvelopeBuyStats;
} {
  const stats = emptyEnvelopeBuyStats();
  for (const k of Object.keys(stats) as (keyof EnvelopeBuyStats)[]) {
    const v = s?.stats?.[k];
    if (typeof v === "number" && Number.isFinite(v)) stats[k] = v;
  }
  const recs = (Array.isArray(s?.recs) ? s!.recs : [])
    .filter((r) => r && typeof r.id === "string" && typeof r.port === "string" && Number.isFinite(r.price) && Number.isFinite(r.at) && (r.status === "buying" || r.status === "bought" || r.status === "failed"))
    .map((r) => ({ ...r, covered: Array.isArray(r.covered) ? r.covered.filter((p) => typeof p === "string") : [] }))
    .slice(-ENVELOPE_BUYS_KEPT);
  const spends = (Array.isArray(s?.spends) ? s!.spends : []).filter((x) => Array.isArray(x) && Number.isFinite(x[0]) && Number.isFinite(x[1])).map(([t, p]) => [t, p] as [number, number]);
  return { recs, spends, stats };
}
