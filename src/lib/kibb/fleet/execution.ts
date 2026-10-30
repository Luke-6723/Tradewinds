/**
 * Execution (guide 3.1, 3.2; the `marginalOrders`, `restingOrders` and `restingBudgetPence` settings): how the fleet trades against a
 * port's NPC ladder order by order, and its resting (GTC) orders.
 *
 * Pure logic, no calls. The game's terms: fills are at the maker's price in price-time order; an IOC with a ship trades into or out of
 * her hold, one without a ship against our warehouse there; a GTC order rests on the book against our warehouse (a resting bid
 * escrows price plus customs and reserves warehouse space; a resting ask locks the goods); the NPC ladders re-quote every 6 game hours
 * and cross resting orders then, at the resting order's price; other players cross them at once. Customs is the buyer's. Between
 * re-quotes the NPC levels only shrink (bought or sold into); a re-quote sets them afresh from the stock.
 *
 * How the autopilot uses it (agent.ts buyPart / sellLaneCargo / handleLeftover; manager.ts runResting):
 *   - Buying (planBuy): ton by ton up the visible asks, each ton's landed profit taken at the MARGINAL sale price (saleCurve: a
 *     market part's sale falls ton by ton at its destination, as the market model's curve says, leaned on by its confidence; with none,
 *     every ton at the planned average, today's rule), stopping at the first ton that clears less than minMarginPence, or past today's break-even; the IOC's limit is the
 *     dearest ask level actually wanted, so a book that moved under us fills less rather than eating the margin (a second look buys
 *     what still pays).
 *   - Selling (planSale): ton by ton down the bids, keeping the rest wherever keeping it is worth more: an IOC sells the first k tons
 *     where the bids taken plus what the rest fetches otherwise (holding for a re-quote here, resting it in our warehouse, carrying
 *     it to another port; each net of its time, rent and passage) is greatest; never under the hard floor (landed cost, half of base).
 *     The model's case is leaned on by its confidence; none leaves today's flat floor (88% of the expected price) standing.
 *   - Splitting across a re-quote (splitBuy, extraWait): when the ship is in port across a re-quote anyway (her lock outlasts it) or
 *     the slippage saved by buying the rest after the ladder refills beats her time waiting for it, only a slice is bought now (the
 *     Obizhaeva-Wang / Alfonsi-Fruth-Schied schedule: for one re-quote, about half; scanned against the ladder seen and the refill
 *     measured), the rest once the ladder shows it re-quoted (requoted: an NPC level grown or new).
 *   - Resting orders (restPlan): priced by backward induction over the re-quotes left (research §2): at each, the order at L fills
 *     with the forecast chance the NPC side crosses it (F(L), the market model's forecast and sd for that re-quote, scaled by a
 *     calibration κ learned from our own orders' fills; times the share of our tons the NPC side's depth at L takes), and the value
 *     carried back is F·L + (1 − F)·(the next stage's); the last stage's is what the goods fetch (asks: an IOC from the warehouse) or
 *     cost (bids: the ship's own IOC on arrival) without it. A bid is never over its value less one forecast sd (picking-off guard:
 *     players cross at once, and a player who does knows something).
 *   - The re-quote's phase per port (PhaseObs) is learned from re-quotes seen (a ladder that changed between two of our looks) and
 *     our resting orders' fills; unknown, a re-quote is equally likely anywhere in the step.
 */

import { REQUOTE_GAME_MIN } from "./market-model";

// ── Constants ────────────────────────────────────────────────────────────────

/** As planner.ts SELL_IMPACT_PER_TON: the old rule's bid fall per ton sold (the sale curve's slope where the model has no data). */
export const OLD_SELL_IMPACT_PER_TON = 0.0015;
/** Today's flat floor under a market part's expected price (agent.ts SELL_FLOOR_DROP): the sale floor where the model can't say. */
export const OLD_SELL_FLOOR_SHARE = 0.88;
/** NPC ladders re-quote every 6 game hours (guide 3.2), in game minutes. */
export const STEP_GAME_MIN = REQUOTE_GAME_MIN;
/** Picking-off guard (research §2): a resting bid sits at least this many forecast sds under what the goods are worth to us. */
export const PICKOFF_Z = 1;
/** Prices tried per re-quote when pricing a resting order. */
const REST_GRID = 48;
/** Calibration of the forecast fill chance: pseudo-trials at the prediction, and its bounds. */
const KAPPA_PRIOR_N = 3;
const KAPPA_MIN = 0.25;
const KAPPA_MAX = 1.5;
/** A re-quote's time is known when the latest observation of it is this sharp (game minutes either side). */
export const PHASE_MAX_ERR_GAME_MIN = 20;
/** The narrowest a phase observation is kept (game minutes either side): our looks and the server's clock aren't exact. */
const PHASE_MIN_ERR_GAME_MIN = 1;
/** Leftover asks rest over this many re-quotes before they are withdrawn (re-posted lower, or sold). */
export const REST_LEFTOVER_REQUOTES = 2;
/** A leftover lot's ask is re-posted this many times before its floor drops from landed cost to half of base (never an avenue's: restLotFloor). */
export const REST_FLOOR_DROP_ROUNDS = 3;
/** Glut lots: held at most this many re-quotes for the reversion. */
export const REST_GLUT_MAX_REQUOTES = 8;
/** Prebuys: the ship must arrive within this many re-quotes of now, and after at least one more re-quote than the one it fills at. */
export const PREBUY_MAX_REQUOTES = 2.5;
/** A prebuy's goods wait this long (game hours) for her after her lane changed before they are sold. */
export const PREBUY_HOLD_GAME_H = 12;
/** Most kept: orders closed (their late fills still matched), fill ids taken in, events. */
export const REST_CLOSED_KEEP_GAME_MIN = 240;
export const REST_FILL_IDS_KEPT = 400;
export const REST_EVENTS_KEPT = 30;
/** The default budget for escrowed bids plus the goods held for resting orders (pence): 15,000 Cr. */
export const RESTING_DEFAULT_BUDGET_PENCE = 1_500_000;
/** Warehouse rent before any is measured (pence a leased ton a game day; not published: a guess on the high side). */
export const RENT_PRIOR_PENCE_PER_TON_DAY = 100;
/** Least a split must save (pence) to be worth a wait at all, and how many times its waiting cost. */
export const SPLIT_MIN_SAVED_PENCE = 3_000;
export const SPLIT_SAFETY = 1.5;
/** Least tons to split (smaller loads go in one). */
export const SPLIT_MIN_TONS = 8;
/** Longest a split waits for the re-quote (game minutes past a full step): then the rest is bought as it stands. */
export const SPLIT_WAIT_SLACK_GAME_MIN = 45;
/**
 * A ship berthed over this long (game minutes) may be evicted to the roadstead by a ship docking at a full port (guide 3.3): a split's
 * wait ends SPLIT_EVICT_MARGIN_GAME_MIN short of it (the rest bought at the berth before then).
 */
export const BERTH_EVICT_GAME_MIN = 360;
export const SPLIT_EVICT_MARGIN_GAME_MIN = 10;

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const finite = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);

/** Φ(x), the standard normal CDF (Abramowitz & Stegun 7.1.26: |error| < 1.5e-7). */
export function normCdf(x: number): number {
  if (!Number.isFinite(x)) return x > 0 ? 1 : 0;
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const erf = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
  return x >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
}

// ── Ladders ──────────────────────────────────────────────────────────────────

/** One price level of a book side (pence a ton, tons). */
export interface Level {
  price: number;
  qty: number;
}

/**
 * Whole tons walked down a ladder in the order given (asks cheapest first, bids dearest first), each ton at the worst level it draws
 * on; at most `max` tons (a part ton left at the end isn't counted).
 */
export function walkTons(levels: readonly Level[], max: number): number[] {
  const out: number[] = [];
  let i = 0;
  let left = levels[0]?.qty ?? 0;
  while (out.length < max && i < levels.length) {
    let need = 1;
    let price = levels[i].price;
    while (need > 1e-9 && i < levels.length) {
      price = levels[i].price;
      const take = Math.min(need, Math.max(0, left));
      need -= take;
      left -= take;
      if (left <= 1e-9) {
        i++;
        left = levels[i]?.qty ?? 0;
      }
    }
    if (need > 1e-9) break;
    out.push(price);
  }
  return out;
}

/**
 * The price of the u-th ton (u from 0: the first ton is u ∈ [0, 1)) along a walked ladder (`tons`, walkTons), and past it `beyond(u)`
 * (the market model's curve; null: the last level's price).
 */
export function ladderAt(tons: readonly number[], beyond: ((u: number) => number) | null): (u: number) => number {
  return (u: number) => {
    const i = Math.floor(Math.max(0, u));
    if (i < tons.length) return tons[i];
    if (beyond) return beyond(u);
    return tons.length ? tons[tons.length - 1] : 0;
  };
}

/**
 * Tons of a forecast ladder (the market model's `marginal(n, after)`) at `price` or better for an order of ours, after `after` tons
 * others take first: on the NPC bids (an ask of ours) those at or over it, on the NPC asks (a bid of ours) those at or under it; at
 * most `max`.
 */
export function ladderTons(v: { marginal(n: number, after?: number): number }, price: number, after: number, max: number, side: RestSide): number {
  const ok = (u: number) => (side === "bid" ? v.marginal(u, after) >= price : v.marginal(u, after) <= price);
  if (!(max > 0) || !ok(0)) return 0;
  if (ok(max)) return max;
  let lo = 0;
  let hi = max;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (ok(mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}

/**
 * Whether a book's NPC levels show a re-quote since `before` (both one side's NPC levels; `side`: which, the asks cheapest first or
 * the bids dearest first): between re-quotes they only shrink as they are bought or sold into, so a level that grew, a price that
 * wasn't there inside the range seen before (or on a side swept bare), or one better than the best seen before (an ask under the
 * cheapest, a bid over the dearest: nothing else brings one into view, as after our own sweep of the best levels and a refill at the
 * same prices) means the ladder was set afresh. A price past the worst seen before may only be a deeper level now in view: not counted.
 */
export function requoted(before: readonly Level[], now: readonly Level[], side: "ask" | "bid"): boolean {
  const had = new Map<number, number>();
  for (const l of before) had.set(l.price, (had.get(l.price) ?? 0) + l.qty);
  const has = new Map<number, number>();
  for (const l of now) has.set(l.price, (has.get(l.price) ?? 0) + l.qty);
  const prices = [...had.keys()];
  const lo = prices.length ? Math.min(...prices) : -Infinity;
  const hi = prices.length ? Math.max(...prices) : Infinity;
  for (const [p, q] of has) {
    const h = had.get(p);
    if (h !== undefined) {
      if (q > h + 0.5) return true;
      continue;
    }
    if (q <= 0.5) continue;
    if (p >= lo && p <= hi) return true;
    if (side === "ask" ? p < lo : p > hi) return true;
  }
  return false;
}

// ── Buying ───────────────────────────────────────────────────────────────────

/**
 * Per ton delivered, what the n-th ton of a part (n from 1, counted from the first of it aboard) fetches at its destination: the
 * part's expected average (`pay`, over its `planned` tons) bent by the bids' fall ton by ton after `after` tons our other ships sell
 * there first, as the market model's curve says (`mv`: its marginal against its average), leaned on by its confidence; the rest of the
 * weight on the average itself (today's rule: every ton at the average). Only the slope is the model's: the level stays the planner's.
 */
export function saleCurve(
  pay: number,
  planned: number,
  after: number,
  mv: { conf: number; avg(tons: number, after?: number): number; marginal(n: number, after?: number): number } | null,
): (n: number) => number {
  const T = Math.max(1, planned);
  const a = Math.max(0, after);
  const modelAvg = mv ? mv.avg(T, a) : 0;
  const c = mv && modelAvg > 0 ? clamp(mv.conf, 0, 1) : 0;
  return (n: number) => {
    if (c <= 0) return pay;
    const model = mv!.marginal(Math.max(0, n - 0.5), a) / modelAvg;
    return pay * (c * (Number.isFinite(model) ? model : 1) + (1 - c));
  };
}

export interface BuyIn {
  /** The asks our bids can fill, cheapest first. */
  levels: readonly Level[];
  /** Tons wanted at most (the part's tons still to buy, the hold's room). */
  want: number;
  /** Tons of this good the lane already holds (the sale curve's place). */
  aboard: number;
  /** 1 + customs, 1 + the fee to bring the cash back, the share expected to arrive (pirates, storms). */
  customs: number;
  fee: number;
  kept: number;
  /** Least landed profit per ton delivered (pence). */
  minMargin: number;
  /** Today's break-even limit (pence a ton): never paid more than this. */
  cap: number;
  /** What the n-th ton fetches at the destination, per ton delivered (saleCurve; a charter: its lowest pay). */
  sale: (n: number) => number;
  /** Cash this load may use (pence; Infinity to size without it). */
  cash: number;
}

export interface BuyOut {
  qty: number;
  /** The IOC's limit: the dearest ask level the tons draw on. */
  limit: number;
  /** Cash it takes, customs included (pence). */
  cost: number;
  /** What stopped it: the next ton's margin, the cash, the room or part, or the book ran out. */
  why: "margin" | "cash" | "room" | "book";
}

/** The tons worth buying from the asks seen, ton by ton while each clears the margin at its marginal sale price (see the header). */
export function planBuy(x: BuyIn): BuyOut {
  const want = Math.max(0, Math.floor(x.want + 1e-9));
  const tons = walkTons(x.levels, want);
  let qty = 0;
  let cost = 0;
  let limit = 0;
  let why: BuyOut["why"] = "room";
  for (let i = 0; i < want; i++) {
    if (i >= tons.length) {
      why = "book";
      break;
    }
    const A = tons[i];
    if (A > x.cap) {
      why = "margin";
      break;
    }
    if (x.sale(x.aboard + i + 1) * x.kept - A * x.customs * x.fee < x.minMargin * x.kept) {
      why = "margin";
      break;
    }
    const c = A * x.customs;
    if (cost + c > x.cash + 1e-6) {
      why = "cash";
      break;
    }
    qty++;
    cost += c;
    limit = Math.max(limit, A);
  }
  return { qty, limit, cost: Math.ceil(cost), why };
}

/** Obizhaeva-Wang (2013) / Alfonsi-Fruth-Schied (2010): the first (and last) of N+1 trades in a block-shaped book refilling `r` of what was taken per interval. */
export function owFirst(x0: number, r: number, n: number): number {
  if (n <= 0) return x0;
  return x0 / ((n - 1) * clamp(r, 0, 1) + 2);
}

/**
 * Buying `qty` now against taking part of it after the next re-quote: the tons to take now and the pence saved (before customs).
 * `price(u)`: the u-th ton's ask now (ladderAt); after the re-quote the ladder has refilled `r` of what we took and moved by `drift`
 * (the forecast's own change over the step). Null: no split saves anything. The candidates: half (the OW schedule for one re-quote)
 * and a scan of 25-75%.
 */
export function splitBuy(price: (u: number) => number, qty: number, r: number, drift: number): { now: number; saved: number } | null {
  const n = Math.floor(qty);
  if (n < 2) return null;
  const rr = clamp(r, 0, 1);
  const d = finite(drift) && drift > 0 ? drift : 1;
  const cost = (from: number, k: number) => {
    let c = 0;
    for (let i = 0; i < k; i++) c += price(from + i + 0.5);
    return c;
  };
  const all = cost(0, n);
  const cands = new Set<number>([Math.round(owFirst(n, rr, 1))]);
  for (let f = 0.25; f <= 0.75 + 1e-9; f += 0.05) cands.add(Math.round(n * f));
  let best: { now: number; saved: number } | null = null;
  for (const x of cands) {
    if (x < 1 || x >= n) continue;
    const saved = all - (cost(0, x) + d * cost(x * (1 - rr), n - x));
    if (saved > 0 && (!best || saved > best.saved)) best = { now: x, saved };
  }
  return best;
}

/**
 * Expected ms waited past `busyMs` (her lock, the trade's handling) for the next re-quote, waiting `capMs` at most: `tauMs` from now
 * when its time is known, else a re-quote equally likely anywhere in the step (E[max(0, min(U, cap) − busy)] for U uniform on the step).
 */
export function extraWait(tauMs: number | null, busyMs: number, stepMs: number, capMs = Infinity): number {
  const b = Math.max(0, busyMs);
  const cap = Math.max(0, capMs);
  if (tauMs !== null && finite(tauMs)) return Math.max(0, Math.min(tauMs, cap) - b);
  if (!(stepMs > 0)) return 0;
  const c = Math.min(cap, stepMs);
  if (b >= c) return 0;
  return (c - b) ** 2 / (2 * stepMs) + (1 - c / stepMs) * (c - b);
}

/** The chance the next re-quote comes within `capMs`: certain or not when its time (`tauMs` from now) is known, else uniform on the step. */
export function requoteChance(tauMs: number | null, capMs: number, stepMs: number): number {
  if (tauMs !== null && finite(tauMs)) return tauMs <= capMs ? 1 : 0;
  if (!(stepMs > 0)) return 0;
  return clamp(capMs / stepMs, 0, 1);
}

// ── Selling ──────────────────────────────────────────────────────────────────

/**
 * Selling `tons` into the bids seen (dearest first): k tons sold now where the bids taken plus `keep(tons − k)` (what the rest fetches
 * otherwise, in all) is greatest, a tie going to selling more; never a ton under `floor`. The IOC's limit is the k-th ton's bid.
 */
export function planSale(levels: readonly Level[], tons: number, floor: number, keep: (rest: number) => number): { qty: number; limit: number; proceeds: number } {
  const total = Math.max(0, Math.floor(tons + 1e-9));
  const walked = walkTons(levels, total);
  const prices: number[] = [];
  for (const p of walked) {
    if (p < floor) break;
    prices.push(p);
  }
  let best = 0;
  let bestV = keep(total);
  let run = 0;
  let bestRun = 0;
  for (let k = 1; k <= prices.length; k++) {
    run += prices[k - 1];
    const v = run + keep(total - k);
    if (v >= bestV - 1e-6) {
      best = k;
      bestV = v;
      bestRun = run;
    }
  }
  return { qty: best, limit: best > 0 ? prices[best - 1] : 0, proceeds: Math.round(bestRun) };
}

/**
 * A function of tons evaluated at a few sizes and interpolated between them (in log tons; constant past the ends): keep values whose
 * every point costs a forecast are sampled, not computed per ton.
 */
export function sampled(max: number, f: (tons: number) => number, points = 6): (tons: number) => number {
  const top = Math.max(1, Math.floor(max));
  const xs = new Set<number>([1, top]);
  for (let i = 1; i < points - 1; i++) xs.add(Math.max(1, Math.round(Math.exp((Math.log(top) * i) / (points - 1)))));
  const pts = [...xs].sort((a, b) => a - b).map((x) => [x, f(x)] as [number, number]);
  return (t: number) => {
    if (!(t > 0)) return 0;
    if (t <= pts[0][0]) return pts[0][1];
    for (let i = 1; i < pts.length; i++) {
      const [x1, y1] = pts[i];
      if (t <= x1) {
        const [x0, y0] = pts[i - 1];
        // An end that can't be had (−Infinity) spoils the span: the worse end stands.
        if (!Number.isFinite(y0) || !Number.isFinite(y1)) return Math.min(Number.isNaN(y0) ? -Infinity : y0, Number.isNaN(y1) ? -Infinity : y1);
        const w = x1 > x0 ? (Math.log(t) - Math.log(x0)) / (Math.log(x1) - Math.log(x0)) : 1;
        return y0 + (y1 - y0) * w;
      }
    }
    return pts[pts.length - 1][1];
  };
}

// ── Resting orders ───────────────────────────────────────────────────────────

export type RestSide = "bid" | "ask";

/** A prebuy's or glut's least expected gain to rest a bid at all (pence), and a glut's least gain a ton as a share of its cost. */
export const PREBUY_MIN_GAIN_PENCE = 2_000;
export const GLUT_MIN_GAIN_SHARE = 0.05;

/** One re-quote ahead, as the market model forecasts it. */
export interface RestStage {
  /** The NPC best our order meets after this re-quote (asks of ours: the NPC's best bid; bids: its best ask) and its sd (pence). */
  mean: number;
  sd: number;
  /** Tons the NPC side then takes from an order at `price` (null: all of it). */
  depth?: ((price: number) => number) | null;
}

export interface RestPlanOut {
  /** The price to post now (pence a ton). */
  price: number;
  /** The fill share expected at the first re-quote (for calibration). */
  pFill: number;
  /** Per ton: what the goods are expected to fetch (asks) or cost (bids) over the re-quotes, the terminal included. */
  value: number;
}

/**
 * Prices a resting order by backward induction over `stages` (the re-quotes it rests through, soonest first; see the header). Asks:
 * we sell at L when the NPC best bid after a re-quote is at or over it, never under `floor`; `terminal` is what a ton fetches if it
 * never fills. Bids: we buy at L when the NPC best ask is at or under it, never over `cap`; `terminal` is what a ton costs without it.
 * `kappa` scales the forecast chance (calibration). Null: no price beats the terminal.
 */
export function restPlan(side: RestSide, stages: readonly RestStage[], terminal: number, tons: number, o: { kappa: number; floor?: number; cap?: number }): RestPlanOut | null {
  if (!stages.length || !(tons > 0) || !finite(terminal)) return null;
  const kap = clamp(finite(o.kappa) ? o.kappa : 1, KAPPA_MIN, KAPPA_MAX);
  let W = terminal;
  let first: { price: number; pFill: number } | null = null;
  for (let i = stages.length - 1; i >= 0; i--) {
    const st = stages[i];
    if (!finite(st.mean) || st.mean <= 0) {
      if (i === 0) first = null;
      continue;
    }
    const sd = Math.max(finite(st.sd) ? st.sd : 0, 0.005 * st.mean, 1);
    const lo = side === "ask" ? Math.max(o.floor ?? 1, st.mean - 2 * sd, 1) : Math.max(1, st.mean - 3 * sd);
    const hi = side === "ask" ? st.mean + 3 * sd : Math.min(o.cap ?? Infinity, st.mean + 2 * sd);
    let best: { L: number; v: number; phi: number } | null = null;
    if (hi >= lo) {
      for (let j = 0; j <= REST_GRID; j++) {
        const L = Math.round(lo + ((hi - lo) * j) / REST_GRID);
        if (L <= 0 || (side === "ask" && o.floor !== undefined && L < o.floor) || (side === "bid" && o.cap !== undefined && L > o.cap)) continue;
        const z = (L - st.mean) / sd;
        const F = Math.min(1, kap * (side === "ask" ? 1 - normCdf(z) : normCdf(z)));
        const d = st.depth ? clamp(st.depth(L) / tons, 0, 1) : 1;
        const phi = F * d;
        const v = phi * L + (1 - phi) * W;
        if (!best || (side === "ask" ? v > best.v : v < best.v)) best = { L, v, phi };
      }
    }
    const better = !!best && (side === "ask" ? best.v > W + 1e-9 : best.v < W - 1e-9);
    if (i === 0) first = better ? { price: best!.L, pFill: best!.phi } : null;
    if (better) W = best!.v;
  }
  return first ? { price: first.price, pFill: first.pFill, value: W } : null;
}

/**
 * A resting bid for `q` of the `tons` a ship of ours buys at a source on arrival, filled at `L` at a re-quote `refills` re-quotes before
 * she comes (the ladder refilling `r` of what it took each): the pence it saves against her buying all of it on arrival (`price(u)`:
 * the u-th ton's ask expected then, no prebuy). Customs is the same either way and left out.
 */
export function prebuySaving(price: (u: number) => number, tons: number, q: number, L: number, r: number, refills: number): number {
  const n = Math.floor(tons);
  const k = Math.min(n, Math.floor(q));
  if (k < 1) return 0;
  let all = 0;
  for (let i = 0; i < n; i++) all += price(i + 0.5);
  const shift = k * Math.pow(1 - clamp(r, 0, 1), Math.max(0, refills));
  let rest = 0;
  for (let i = 0; i < n - k; i++) rest += price(shift + i + 0.5);
  return all - (k * L + rest);
}

/**
 * Buying a glut to sell after its stock reverts: per ton, the best over holding 2..maxSteps re-quotes of the bid then (less one sd: the
 * forecast's own doubt) less what a ton costs landed in our warehouse (`buy`, customs in), its rent and the capital it ties up for
 * that long. Null: nothing clears `minGain` a ton.
 */
export function glutCase(x: {
  buy: number;
  bidAt: (steps: number) => { price: number; sd: number } | null;
  rentPerTonStep: number;
  capitalPerPenceStep: number;
  minGain: number;
  maxSteps: number;
}): { steps: number; gain: number; target: number } | null {
  let best: { steps: number; gain: number; target: number } | null = null;
  for (let k = 2; k <= x.maxSteps; k++) {
    const b = x.bidAt(k);
    if (!b || !finite(b.price)) continue;
    const gain = b.price - PICKOFF_Z * Math.max(0, b.sd) - x.buy - x.rentPerTonStep * k - x.capitalPerPenceStep * x.buy * k;
    if (!best || gain > best.gain) best = { steps: k, gain, target: b.price };
  }
  return best && best.gain >= x.minGain ? best : null;
}

// ── Calibration and the re-quote's phase ─────────────────────────────────────

/** Forecast fill chances against what our orders filled (per side): trials, Σ predicted share, Σ filled share. */
export interface Calib {
  n: number;
  pred: number;
  got: number;
}

/** The calibration factor on forecast fill chances (κ): filled over predicted, shrunk to 1 with KAPPA_PRIOR_N pseudo-trials. */
export function kappaOf(c: Calib | undefined): number {
  if (!c) return 1;
  return clamp((c.got + KAPPA_PRIOR_N * 0.5) / (c.pred + KAPPA_PRIOR_N * 0.5), KAPPA_MIN, KAPPA_MAX);
}

/** One re-quote trial of a resting order: `pred` the share it was expected to fill, `got` the share it did. */
export function noteTrial(c: Calib, pred: number, got: number): void {
  if (!finite(pred) || !finite(got)) return;
  c.n++;
  c.pred += clamp(pred, 0, 1);
  c.got += clamp(got, 0, 1);
  // Old trials fade (the market and the model both change): at most ~60 count.
  if (c.n > 60) {
    const f = 60 / c.n;
    c.n = 60;
    c.pred *= f;
    c.got *= f;
  }
}

/** A re-quote at a port seen at `at` ± `err` (server ms). */
export interface PhaseObs {
  at: number;
  err: number;
}

/**
 * A re-quote seen between `from` and `to` (server ms; a ladder that changed between two looks, or a fill of ours at it): narrowed
 * against what was known when the two agree (taken a whole number of steps on), else taken afresh.
 */
export function notePhase(prev: PhaseObs | undefined, from: number, to: number, stepMs: number, gameMinuteMs: number): PhaseObs {
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  const minErr = PHASE_MIN_ERR_GAME_MIN * gameMinuteMs;
  const fresh: PhaseObs = { at: (lo + hi) / 2, err: Math.max(minErr, (hi - lo) / 2) };
  if (!prev || !(stepMs > 0)) return fresh;
  const k = Math.round((fresh.at - prev.at) / stepMs);
  const c = prev.at + k * stepMs;
  const a = Math.max(lo, c - prev.err);
  const b = Math.min(hi, c + prev.err);
  if (a > b) return fresh;
  return { at: (a + b) / 2, err: Math.max(minErr, (b - a) / 2) };
}

/** The next re-quote at or after `now` (server ms) from what was seen, or null: unknown (nothing seen, or not sharp enough). */
export function nextRequote(o: PhaseObs | undefined, now: number, stepMs: number, gameMinuteMs: number): number | null {
  if (!o || !(stepMs > 0) || o.err > PHASE_MAX_ERR_GAME_MIN * gameMinuteMs) return null;
  const k = Math.ceil((now - o.at) / stepMs);
  let t = o.at + k * stepMs;
  if (t < now) t += stepMs;
  return t;
}

// ── Saved state ──────────────────────────────────────────────────────────────

export type RestPurpose = "leftover" | "prebuy" | "glut" | "sell";

/** One resting order of ours (every call saved before it is sent; `sending`/`unknown`: reconciled from the orders and fills). */
export interface RestOrder {
  /** Ours, before the server's id is known. */
  key: string;
  id: string | null;
  port: string;
  good: string;
  side: RestSide;
  /** Bids: a prebuy for a ship, or a glut; asks: our goods in the warehouse there for sale. */
  purpose: RestPurpose;
  price: number;
  qty: number;
  /** Tons filled and still resting, as last read. */
  filled: number;
  left: number;
  status: "sending" | "open" | "unknown" | "closed";
  /** Server ms: sent, withdrawn at, closed at. */
  at: number;
  until: number;
  closedAt?: number;
  /** Bids: what a ton is worth to us at most; asks: what a ton fetches if it never fills. */
  value: number;
  /** The fill share expected at its first re-quote, re-quote trials counted, and the tons filled by the last one counted. */
  pFill: number;
  trials: number;
  trialFilled: number;
  customsBps: number;
  /** Tons filled at placement against resting orders (taker) whose fill records are still to be skipped: they were taken in then. */
  taker?: number;
  /**
   * Tons filled at placement (taker: against the book as it stood, never a re-quote's crossing) in all, kept apart from `taker` (which the
   * fill matching runs down), and tons filled while resting (maker): the calibration counts only the latter, against the tons that rested.
   * Absent in older saves.
   */
  takerAtPlace?: number;
  maker?: number;
  /** Asks: the lots (RestLot.id) it sells; their fills come out of those first. Absent in older saves (any of the book's lots). */
  lots?: string[];
  /** Prebuys: the ship and lane it is for. */
  shipId?: string;
  laneKey?: string;
  /** Glut bids: re-quotes its goods are held for the reversion once filled. */
  holdSteps?: number;
}

/**
 * Goods of ours in a warehouse held for resting orders (per port, good and why). Each lot is priced and floored by its own rounds and
 * sold apart (goods rested later are never merged into a lot already offered).
 */
export interface RestLot {
  /** Ours (an ask's `lots`); restoreResting gives older saves' lots one. */
  id?: string;
  port: string;
  good: string;
  /**
   * `landed`: goods others landed into our warehouse for us (a charter we posted, freight we issued, a forward buy settled): sold as a
   * leftover is. `held`: goods held to deliver into a forward sale of ours (never offered, never loaded). `monopoly`: bought from the
   * Crown's asks under a grant of ours to resell at a markup (offered by the monopoly pass while it stands, then as landed goods).
   */
  purpose: "leftover" | "prebuy" | "glut" | "landed" | "held" | "monopoly";
  tons: number;
  /** Per ton: what they cost landed here (pence). */
  cost: number;
  /** Least a ton is sold for (leftovers: the landed cost, then half of base after REST_FLOOR_DROP_ROUNDS re-posts; an avenue's: always). */
  floor: number;
  /** Server ms first held. */
  at: number;
  /** Asks posted for it so far. */
  rounds: number;
  /** Glut: sold from then (the reversion's best); prebuy: kept for her until then once her lane changed (server ms). */
  until?: number;
  /** When it was last offered by IOC from the warehouse (server ms): once a half re-quote at most. */
  tried?: number;
  shipId?: string;
  laneKey?: string;
  /** The avenue record it came from (`charter:<id>`, `freight:<id>`, `future:<id>`, `monopoly:<region>|<good>`); absent otherwise. */
  src?: string;
}

/**
 * The least a lot is sold for now (pence a ton). In the season's endgame: base, or its floor if higher. A leftover, prebuy or glut: its
 * floor (at least half of base) until REST_FLOOR_DROP_ROUNDS re-posts, then half of base. Goods an avenue landed for us (a `src`: a
 * charter's deliveries, freight landed, a forward buy settled, a monopoly's stock) never under their floor, what they cost, whatever the
 * rounds (issuing them as freight is their other way out).
 */
export function restLotFloor(l: Pick<RestLot, "floor" | "rounds" | "src">, base: number, endgame: boolean): number {
  const half = Math.round(base * 0.5);
  if (endgame) return Math.max(base, l.floor);
  if (l.rounds >= REST_FLOOR_DROP_ROUNDS && !l.src) return Math.max(1, half);
  return Math.max(half, l.floor);
}

export interface RestStats {
  placed: number;
  cancelled: number;
  filledBidTons: number;
  filledAskTons: number;
  boughtPence: number;
  soldPence: number;
  /** Leftovers unloaded into our warehouses under a resting ask. */
  restedTons: number;
  /** Goods of ours loaded from our warehouses into a ship's hold, and their cost. */
  loadedTons: number;
  loadedPence: number;
  /** Sold from our warehouses by IOC (a lot whose asks didn't fill). */
  iocSoldTons: number;
  iocSoldPence: number;
  /** Loads bought in two slices across a re-quote, and the slippage they were expected to save. */
  splits: number;
  splitSavedPence: number;
  /** Tons the marginal stop left unbought that today's break-even limit would have bought. */
  marginalCutTons: number;
}

export interface RestEvent {
  at: string;
  kind: string;
  port: string;
  good: string;
  tons: number;
  price: number;
  note: string;
}

export interface RestingMemory {
  orders: RestOrder[];
  lots: RestLot[];
  /** Warehouse tons we leased for resting orders (port → tons added), given back once unused. */
  leases: Array<[string, number]>;
  /**
   * A lease raised with no answer (it may have landed): the lease before and the tons asked for, at (server ms); settled from the next
   * read of our warehouses (what it grew by, up to the ask, is ours to give back). Absent in older saves.
   */
  leasePending?: Array<{ port: string; before: number; need: number; at: number }>;
  /** Re-quotes seen per port. */
  phases: Array<[string, PhaseObs]>;
  calib: Record<RestSide, Calib>;
  /** Fill ids already taken in (bounded). */
  fillIds: string[];
  stats: RestStats;
  recent: RestEvent[];
}

export const emptyRestStats = (): RestStats => ({
  placed: 0,
  cancelled: 0,
  filledBidTons: 0,
  filledAskTons: 0,
  boughtPence: 0,
  soldPence: 0,
  restedTons: 0,
  loadedTons: 0,
  loadedPence: 0,
  iocSoldTons: 0,
  iocSoldPence: 0,
  splits: 0,
  splitSavedPence: 0,
  marginalCutTons: 0,
});

export const emptyResting = (): RestingMemory => ({
  orders: [],
  lots: [],
  leases: [],
  phases: [],
  calib: { bid: { n: 0, pred: 0, got: 0 }, ask: { n: 0, pred: 0, got: 0 } },
  fillIds: [],
  stats: emptyRestStats(),
  recent: [],
});

/** A key of ours for an order before its id is known, or a lot. */
export const restKey = (): string => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

const SIDES: readonly RestSide[] = ["bid", "ask"];
const PURPOSES: readonly RestPurpose[] = ["leftover", "prebuy", "glut", "sell"];
const STATUSES: readonly RestOrder["status"][] = ["sending", "open", "unknown", "closed"];
const LOT_PURPOSES: readonly RestLot["purpose"][] = ["leftover", "prebuy", "glut", "landed", "held", "monopoly"];

/** Saved resting state as far as it reads (malformed entries dropped; an order sent with no answer is still reconciled). */
export function restoreResting(s: Partial<RestingMemory> | undefined | null): RestingMemory {
  const m = emptyResting();
  if (!s || typeof s !== "object") return m;
  const str = (x: unknown): x is string => typeof x === "string" && x.length > 0;
  for (const o of Array.isArray(s.orders) ? s.orders : []) {
    if (!o || !str(o.key) || !str(o.port) || !str(o.good) || !SIDES.includes(o.side) || !PURPOSES.includes(o.purpose) || !STATUSES.includes(o.status)) continue;
    if (!finite(o.price) || !finite(o.qty) || !finite(o.at) || !finite(o.until)) continue;
    m.orders.push({
      ...o,
      id: str(o.id) ? o.id : null,
      filled: finite(o.filled) ? o.filled : 0,
      left: finite(o.left) ? o.left : Math.max(0, o.qty - (finite(o.filled) ? o.filled : 0)),
      value: finite(o.value) ? o.value : 0,
      pFill: finite(o.pFill) ? o.pFill : 0,
      trials: finite(o.trials) ? o.trials : 0,
      trialFilled: finite(o.trialFilled) ? o.trialFilled : 0,
      customsBps: finite(o.customsBps) ? o.customsBps : 0,
      taker: finite(o.taker) ? o.taker : undefined,
      takerAtPlace: finite(o.takerAtPlace) ? o.takerAtPlace : undefined,
      maker: finite(o.maker) ? o.maker : undefined,
      lots: Array.isArray(o.lots) ? o.lots.filter(str) : undefined,
    });
  }
  for (const l of Array.isArray(s.lots) ? s.lots : []) {
    if (!l || !str(l.port) || !str(l.good) || !LOT_PURPOSES.includes(l.purpose) || !finite(l.tons) || l.tons <= 0 || !finite(l.cost) || !finite(l.at)) continue;
    m.lots.push({ ...l, id: str(l.id) ? l.id : restKey(), floor: finite(l.floor) ? l.floor : 0, rounds: finite(l.rounds) ? l.rounds : 0 });
  }
  for (const e of Array.isArray(s.leases) ? s.leases : []) if (Array.isArray(e) && str(e[0]) && finite(e[1]) && e[1] > 0) m.leases.push([e[0], e[1]]);
  const pending = (Array.isArray(s.leasePending) ? s.leasePending : []).filter((p) => p && str(p.port) && finite(p.before) && finite(p.need) && finite(p.at));
  if (pending.length) m.leasePending = pending.map((p) => ({ port: p.port, before: p.before, need: p.need, at: p.at }));
  for (const e of Array.isArray(s.phases) ? s.phases : []) if (Array.isArray(e) && str(e[0]) && e[1] && finite(e[1].at) && finite(e[1].err)) m.phases.push([e[0], { at: e[1].at, err: e[1].err }]);
  for (const side of SIDES) {
    const c = s.calib?.[side];
    if (c && finite(c.n) && finite(c.pred) && finite(c.got)) m.calib[side] = { n: c.n, pred: c.pred, got: c.got };
  }
  m.fillIds = (Array.isArray(s.fillIds) ? s.fillIds : []).filter(str).slice(-REST_FILL_IDS_KEPT);
  for (const k of Object.keys(m.stats) as (keyof RestStats)[]) {
    const v = s.stats?.[k];
    if (finite(v)) m.stats[k] = v;
  }
  m.recent = (Array.isArray(s.recent) ? s.recent : []).filter((e) => e && str(e.kind) && str(e.at)).slice(-REST_EVENTS_KEPT);
  return m;
}

/** Resting orders and execution for the dashboard (later) and the digest. Money pence, times ISO. */
export interface RestingReport {
  /** The settings in force: marginal limits and splitting (marginalOrders), resting orders (restingOrders). */
  marginal: boolean;
  enabled: boolean;
  /** Why nothing new rests now (null: it may). */
  blocked: string | null;
  budgetPence: number;
  /** Open bids' escrow, and the goods held for resting orders at cost. */
  escrowPence: number;
  heldPence: number;
  orders: Array<{ id: string | null; port: string; good: string; side: RestSide; purpose: RestPurpose; price: number; qty: number; filled: number; left: number; status: RestOrder["status"]; at: string; until: string; pFill: number }>;
  lots: Array<{ port: string; good: string; purpose: RestLot["purpose"]; tons: number; cost: number; floor: number; at: string; rounds: number }>;
  leases: Array<{ port: string; tons: number }>;
  stats: RestStats;
  /** Fill-chance calibration per side: trials and κ. */
  calib: Record<RestSide, { n: number; kappa: number }>;
  /** Ports whose re-quote time is known. */
  phasesKnown: number;
  /** Warehouse rent a leased ton a game day as measured (null: the prior is used). */
  rentPerTonDay: number | null;
  recent: RestEvent[];
}
