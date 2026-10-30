/**
 * Ordering hulls from builders (the orderHulls setting; guide 3.4 commissions). Pure logic, no calls.
 *
 * The game's terms: we post `create-commission {port_id, ship_class, price_pence, collateral_pence, deadline_game_hours}`; the price
 * (50-150% of the hull's rebuild value) is escrowed from our vault in the yard's region at once, the builder escrows the collateral (at
 * most 25% of the price) when it accepts, and delivering builds the hull at the yard, hands it to us berthed there and pays the builder.
 * An untaken commission is refunded at its deadline (or cancelled while untaken); a taken one not delivered refunds us and forfeits the
 * builder's collateral to us. We need no presence at the yard.
 *
 * When the buyer has picked a hull to build (its own cash, no loan or mortgage, no listing, no AI build order: an order builds now) and
 * the fleet isn't in a hurry (no ship waits for cash; payback with the deadline added still inside the limit and the season), it may post
 * a commission instead, under our own cheapest build (HULL_GRID multipliers on it, within the game's band of the rebuild value), priced by
 * Thompson sampling (bandit.ts, one key per hull class, `up`: builders take dearer ones more often; prior HULL_PRIOR, learned from our
 * commissions taken or not). An arm's value is what it saves if taken against what the wait costs the hull's earnings:
 *
 *   value(k) = θk × (our cost − price k) − net an hour × D × (θk × ½ + (1 − θk))   (D: the deadline in real hours; taken half-way on
 *                                                                                   average, else the whole wait before we build ourselves)
 *
 * posted only when the best arm's sampled value clears HULL_ORDER_MIN_GAIN (pence and share of the cost) and its value at the posterior
 * mean is no loss (so a market where nobody builds for us stops being probed: the key's data is discounted gently). One open at a time; while it stands the
 * buyer builds nothing else and counts it as the hull to come. Cancelled while untaken when the plan changes (the switch or autoBuy off, the
 * class no longer allowed or the fleet full, an AI build order or buy hold, a ship waiting for cash, a loan repayment short, the season's
 * endgame); the hull a builder delivers is taken command of at the yard like any new ship.
 */

import { HULL_GRID, type ArmRef, type PostedPrices, type Prior } from "./bandit";

/** The commission's deadline (game hours: one and a half game days, inside the plan's 1-3). */
export const HULL_ORDER_DEADLINE_GAME_H = 36;
/** The collateral asked of the builder: a small share of the price (the game allows up to 25%). */
export const HULL_ORDER_COLLATERAL_SHARE = 0.05;
/** The game's band on the price, of the hull's rebuild value (50-150%), with a margin for the value moving before it is checked. */
export const HULL_ORDER_BAND_LO = 0.52;
export const HULL_ORDER_BAND_HI = 1.45;
/** Least expected value of an order over building now (pence; and share of our cost). */
export const HULL_ORDER_MIN_GAIN_PENCE = 20_000;
export const HULL_ORDER_MIN_GAIN_SHARE = 0.01;
/** An arm under this share of our cost saves nothing worth the wait. */
export const HULL_ORDER_MAX_SHARE = 0.97;
/** The prior on a builder taking a commission at a multiplier of our cost: 30% at 0.9x, rising steeply with the price. */
export const HULL_PRIOR: Prior = { centre: 0.9, p: 0.3, slope: 4, n: 3, dir: "up" };
/** A post with no answer is looked for among the commissions this long (real ms), then taken as not made. */
export const HULL_ORDER_PENDING_MS = 10 * 60_000;
/** Records kept for the report. */
export const HULL_ORDERS_KEPT = 20;

export const hullKey = (cls: string) => `hull|${cls}`;

/** The price an arm posts (pence): our cost × the multiplier, within the game's band of the rebuild value. */
export function hullArmPrice(k: number, ourCost: number, rebuild: number): number {
  const m = HULL_GRID[k] ?? 1;
  const lo = rebuild > 0 ? HULL_ORDER_BAND_LO * rebuild : 0;
  const hi = rebuild > 0 ? HULL_ORDER_BAND_HI * rebuild : Infinity;
  return Math.round(Math.min(hi, Math.max(lo, ourCost * m)));
}

/**
 * The commission to post for a hull the buyer picked, or null (build now): the arm with the best sampled value (saving if taken against
 * the wait's cost to the hull's net), only arms that save at least 3% under our cost, and only when that value clears the least gain.
 */
export function hullOrderCase(x: {
  bandit: PostedPrices;
  cls: string;
  /** Our cheapest way to build it now (pence; its guns left out: a builder's hull comes bare). */
  ourCost: number;
  /** The class's rebuild value (pence): the game's band on the price. */
  rebuild: number;
  /** What the hull is expected to earn (pence a real hour, net of its upkeep). */
  netPerHour: number;
  /** The deadline in real hours. */
  deadlineHours: number;
  rng?: () => number;
}): { k: number; price: number; theta: number; value: number; arm: ArmRef } | null {
  if (!(x.ourCost > 0)) return null;
  const key = hullKey(x.cls);
  const D = Math.max(0, x.deadlineHours);
  const net = Math.max(0, x.netPerHour);
  const price = (k: number) => hullArmPrice(k, x.ourCost, x.rebuild);
  const ok = (k: number) => price(k) <= HULL_ORDER_MAX_SHARE * x.ourCost;
  const value = (k: number, th: number) => th * (x.ourCost - price(k)) - net * D * (th * 0.5 + (1 - th));
  const pick = x.bandit.choose(key, HULL_GRID, HULL_PRIOR, value, ok, x.rng);
  if (!pick) return null;
  const need = Math.max(HULL_ORDER_MIN_GAIN_PENCE, HULL_ORDER_MIN_GAIN_SHARE * x.ourCost);
  if (!(pick.value >= need)) return null;
  // The draw may be lucky; the posterior's mean must not expect a loss on that arm either (a market nobody builds for stops being probed).
  if (!(value(pick.k, x.bandit.mean(key, HULL_GRID, HULL_PRIOR, pick.k)) >= 0)) return null;
  return { k: pick.k, price: price(pick.k), theta: pick.theta[pick.k], value: Math.round(pick.value), arm: { key, k: pick.k, m: HULL_GRID[pick.k], c: HULL_PRIOR.centre, p: HULL_PRIOR.p } };
}

/**
 * One commission we posted for a hull. Times server ms. `status`: `posting` (sent, no answer yet), `open` (untaken), `cancelling`
 * (withdrawal sent with no answer, or refused as taken or closed: settled only from whole reads of the open and active lists, the buyer
 * building nothing meanwhile), `taken` (a builder accepted), `delivered`, `cancelled`, `expired` (untaken at its deadline), `defaulted`
 * (taken and not delivered: refunded, the collateral ours), `failed` (the post refused).
 */
export interface HullOrderRec {
  id: string | null;
  yard: string;
  cls: string;
  price: number;
  collateral: number;
  /** Our cheapest build when posted, the class's rebuild value, the hull's net an hour as the buyer judged it, the case's value (pence). */
  ourCost: number;
  rebuild: number;
  net: number;
  value: number;
  arm: ArmRef;
  status: "posting" | "open" | "cancelling" | "taken" | "delivered" | "cancelled" | "expired" | "defaulted" | "failed";
  at: number;
  deadline: number;
  /** The bandit has counted its outcome (taken or not): once. */
  scored?: boolean;
  takenAt?: number;
  doneAt?: number;
  shipId?: string;
  lane?: string;
  payback?: number;
  why?: string;
}

/** Open: escrowed, or may be (a post or cancel with no answer), or a builder at work. */
export const orderLive = (r: HullOrderRec) => r.status === "posting" || r.status === "open" || r.status === "cancelling" || r.status === "taken";

export interface HullOrderStats {
  posted: number;
  taken: number;
  delivered: number;
  cancelled: number;
  expired: number;
  defaulted: number;
  /** Our cost less the price, on hulls delivered (pence). */
  savedPence: number;
}

export const emptyHullOrderStats = (): HullOrderStats => ({ posted: 0, taken: 0, delivered: 0, cancelled: 0, expired: 0, defaulted: 0, savedPence: 0 });

/** Hull orders for the panel and the digest (pence; times ISO). */
export interface HullOrderReport {
  enabled: boolean;
  blocked: string | null;
  open: { id: string | null; yard: string; cls: string; pricePence: number; ourCostPence: number; collateralPence: number; status: HullOrderRec["status"]; deadline: string } | null;
  recent: Array<{ at: string; yard: string; cls: string; pricePence: number; ourCostPence: number; status: HullOrderRec["status"]; why: string | null }>;
  stats: HullOrderStats;
}

const STATUSES: ReadonlyArray<HullOrderRec["status"]> = ["posting", "open", "cancelling", "taken", "delivered", "cancelled", "expired", "defaulted", "failed"];

export function restoreHullOrders(s: { recs?: HullOrderRec[]; stats?: Partial<HullOrderStats> } | undefined): { recs: HullOrderRec[]; stats: HullOrderStats } {
  const stats = emptyHullOrderStats();
  for (const k of Object.keys(stats) as (keyof HullOrderStats)[]) {
    const v = s?.stats?.[k];
    if (typeof v === "number" && Number.isFinite(v)) stats[k] = v;
  }
  const recs = (Array.isArray(s?.recs) ? s!.recs : [])
    .filter(
      (r) =>
        r &&
        typeof r.yard === "string" &&
        typeof r.cls === "string" &&
        (r.id === null || typeof r.id === "string") &&
        STATUSES.includes(r.status) &&
        Number.isFinite(r.price) &&
        Number.isFinite(r.at) &&
        Number.isFinite(r.deadline) &&
        r.arm &&
        typeof r.arm.key === "string",
    )
    .map((r) => ({ ...r, arm: { ...r.arm } }))
    .slice(-HULL_ORDERS_KEPT);
  return { recs, stats };
}
