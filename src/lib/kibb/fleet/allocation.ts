/**
 * Scoring and allocation (the `kellySizing` and `assignByRegret` settings), pure: no I/O. The planner (planner.ts rankLanes) and the
 * manager (FleetManager.assignLane) call it; it decides nothing by itself.
 *
 * Terminal value (TerminalValues): V(port), a rolling estimate of the best lane profit per real hour a ship can start from each port,
 * per ton of hold (an average over the planner's own passes there, weighted by how much each says until it settles into an EMA: the
 * mean of the best few legs' rates among those cash didn't cut short, a cheap onward estimate counting half), and the hours such a leg
 * takes. A pass with no such leg teaches nothing (an empty or cash-starved plan is no evidence that nothing pays there). A lane is
 * scored as (leg profit + V(dest) × hold × those hours) / (leg hours + those hours), or as the empty sail back where that rates higher:
 * where it ends counts for what can be done from there. Every leg's own time already holds its empty sail to its source, so the
 * repositioning is inside V. Unknown, stale (6 game days), older than structural news at that port, or no evidence of a paying lane
 * there (a next leg earning less than the least one the planner would plan): the planner's old onward estimate or the empty sail back
 * stands in.
 *
 * Scenarios (outcomes): a lane's cash outcome over its laden passage, as weighted points. The loss model's rare states are enumerated,
 * never sampled (64 draws can't show a 1% sinking): the ship lost (captured or sunk: the goods and the freight collateral gone), else a
 * raid that lets her go (a learned share seized) and storm damage, each happening or not. Each surviving state takes 64 stratified draws
 * (Latin hypercube, fixed seeds: the same draws for every lane, so lanes are compared on common numbers) of each part's sale price
 * (lognormal, the market model's forecast sd at arrival, mean kept) and of a gossiped charter still being open. The planner's expected
 * kept share and so its expected profit are preserved: only the spread is added.
 *
 * Sizing (stakeFraction, stakeCap): the stake is the cash the load ties up; the bankroll is spare cash with our deposits plus the cost of
 * cargo still at sea (the unsold part of the stakes in flight), less what our loans will take. Full Kelly (the stake fraction maximising
 * E log(1 + f·r)) is a ceiling, never a target: half of it, and no more than risk-constrained Kelly allows (RCK: the largest f with
 * E[(1 + f·r)^-λ] ≤ 1, λ = ln β / ln α, so the bankroll falls below α = 70% with probability under β = 10%; found by bisection, the
 * constraint being convex in f). Each sale's forecast sd is already in the scenarios' price spread, so it is counted there once: the
 * shrinkage k = 1/(1 + Var(edge)/edge²) is only for an estimation variance the scenarios don't carry (none is passed yet). A sale with no
 * confident forecast adds no spread: the load is sized on the loss states alone. Ships in the same pirate or storm zone, and loads sold
 * into the same market, share one cap (a zone's three times the fraction, its raids being independent bar the rate; a market's once: its
 * bids fall for all of them). Never above what the old sizing gives, never below the smallest load worth a leg (a bankroll at or under
 * 0: that floor alone).
 *
 * The scenario score: the expected log-growth of the bankroll at the stake chosen, as its certainty equivalent B·(e^g − 1) in pence in
 * place of the expected profit. Small loads score as before; a load that is a large share of the bankroll, over dangerous water, less.
 * Log utility runs on below CE_EPS of the bankroll left as its tangent line there (strictly increasing and concave past ruin), so a
 * bigger stake past the bankroll never scores higher.
 *
 * Fleet assignment (regretOf, nextByRegret): ships asking for lanes together are served by greatest regret, the value of the lane each
 * would take over its best one sharing nothing with it, instead of first come; a lane whose reservations, cash or shared caps another
 * commit changed is planned again before it is committed. Charter insertion (insertionWins): a deadline charter a ship is about to take
 * is offered to our ships at sea after their current leg, and goes to one only when it gains clearly more there than here.
 */

// ── Terminal values ───────────────────────────────────────────────────────────

/**
 * EMA step of one full observation (a cheap onward estimate is half of one) once the estimate has settled; before that each
 * observation weighs by its share of the weight so far (a running weighted mean), so a first cheap estimate doesn't dominate.
 */
export const TERMINAL_ALPHA = 0.25;
/** Weight of observations before V(port) is used. */
export const TERMINAL_KNOWN_N = 1;
/** An observation is the mean of this many best legs' rates (the very best is often taken by someone else first). */
export const TERMINAL_TOP = 3;
/** V(port) older than this (game hours) is unknown again. */
export const TERMINAL_STALE_GAME_H = 144;
/** At most this many ports kept (oldest first out). */
const TERMINAL_KEPT = 400;

export interface TerminalEntry {
  /** Pence per real hour per ton of hold. */
  v: number;
  /** Real hours such a leg takes. */
  h: number;
  /** Observations' weight (capped). */
  n: number;
  /** Server ms of the last observation. */
  at: number;
}

/** One saved row: port, V, hours, weight, server ms. */
export type TerminalRow = [port: string, v: number, h: number, n: number, at: number];

export class TerminalValues {
  private readonly m = new Map<string, TerminalEntry>();

  /**
   * One pass's best legs from `port`: `v` pence an hour per ton of hold (above 0: a pass with no paying leg says nothing and is
   * ignored), `h` their hours, `weight` 1 for a ship's own plan there, ½ for a cheap onward estimate. Weighed by its share of the weight
   * so far (w / (n + w)) until that falls under the EMA's step (TERMINAL_ALPHA × w). A stale entry, or one older than structural news
   * there (`shiftAt`), restarts.
   */
  observe(port: string, v: number, h: number, weight: number, now: number, staleMs: number, shiftAt = 0): void {
    if (!port || !(v > 0) || !Number.isFinite(v) || !Number.isFinite(h) || !(weight > 0) || !Number.isFinite(now)) return;
    const hh = Math.min(48, Math.max(0.05, h));
    const e = this.m.get(port);
    if (!e || now - e.at > staleMs || e.at < shiftAt) {
      this.m.set(port, { v, h: hh, n: weight, at: now });
    } else {
      const a = Math.min(1, Math.max(TERMINAL_ALPHA * weight, weight / (e.n + weight)));
      e.v += a * (v - e.v);
      e.h += a * (hh - e.h);
      e.n = Math.min(20, e.n + weight);
      e.at = now;
    }
    if (this.m.size > TERMINAL_KEPT) {
      const oldest = [...this.m].sort((x, y) => x[1].at - y[1].at)[0];
      this.m.delete(oldest[0]);
    }
  }

  /** V(port) when known: enough observed, fresh, and none of it from before structural news there. Null: unknown. */
  value(port: string, now: number, staleMs: number, shiftAt = 0): TerminalEntry | null {
    const e = this.m.get(port);
    if (!e || e.n < TERMINAL_KNOWN_N || now - e.at > staleMs || e.at < shiftAt) return null;
    return e;
  }

  snapshot(): TerminalRow[] {
    return [...this.m].map(([p, e]) => [p, Math.round(e.v * 1000) / 1000, Math.round(e.h * 1000) / 1000, Math.round(e.n * 100) / 100, Math.round(e.at)]);
  }

  restore(rows: unknown): void {
    this.m.clear();
    if (!Array.isArray(rows)) return;
    for (const r of rows) {
      if (!Array.isArray(r) || typeof r[0] !== "string") continue;
      const [port, v, h, n, at] = r as unknown[];
      if (typeof v !== "number" || typeof h !== "number" || typeof n !== "number" || typeof at !== "number") continue;
      // A row of 0 was a pass that found nothing (no longer learned from): dropped, the port unknown again.
      if (![v, h, n, at].every(Number.isFinite) || v <= 0 || h <= 0 || n <= 0) continue;
      this.m.set(port as string, { v, h, n, at });
    }
  }

  /** Ports known (fresh), and the medians among them. */
  summary(now: number, staleMs: number): { ports: number; known: number; medianV: number | null; medianH: number | null; top: Array<{ port: string; v: number; h: number; n: number; at: number }> } {
    const known = [...this.m].filter(([, e]) => e.n >= TERMINAL_KNOWN_N && now - e.at <= staleMs);
    const med = (xs: number[]) => {
      if (!xs.length) return null;
      const s = [...xs].sort((a, b) => a - b);
      return s[Math.floor(s.length / 2)];
    };
    return {
      ports: this.m.size,
      known: known.length,
      medianV: med(known.map(([, e]) => e.v)),
      medianH: med(known.map(([, e]) => e.h)),
      top: known
        .sort((a, b) => b[1].v - a[1].v)
        .slice(0, 12)
        .map(([port, e]) => ({ port, v: Math.round(e.v), h: Math.round(e.h * 100) / 100, n: Math.round(e.n * 10) / 10, at: e.at })),
    };
  }
}

// ── Scenarios ─────────────────────────────────────────────────────────────────

/** Price draws per surviving loss state. */
export const SAA_SAMPLES = 64;
/** Lanes per ship judged on scenarios (and sized by Kelly) each pass: the best few by the plain score, again until they all are. */
export const SAA_TOP = 8;
/** RCK: the bankroll falls below ALPHA with probability under BETA. */
export const RCK_ALPHA = 0.7;
export const RCK_BETA = 0.1;
export const RCK_LAMBDA = Math.log(RCK_BETA) / Math.log(RCK_ALPHA);
/** Fractional Kelly: full Kelly is a ceiling, never a target. */
export const KELLY_SHARE = 0.5;
/** The market model's confidence a sale's forecast needs before its sd spreads the scenarios (less: no spread, the loss states alone). */
export const KELLY_MIN_CONF = 0.3;
/** A zone's ships share this many times one stake fraction (raids are independent bar the rate); a market's share one. */
export const ZONE_GROUP_X = 3;
/** Stake fractions are searched up to this many bankrolls (more is never reachable: no cap). */
const F_SEARCH_MAX = 4;

/** One good of a load, as the scenarios see it. */
export interface RiskPart {
  tons: number;
  /** Expected cash per ton on delivery (the planner's), and the weighted phase bonus per ton. */
  pay: number;
  bonus: number;
  /** Relative sd of the sale price at arrival (the market model's forecast sd over its price; 0: none modelled). */
  rel: number;
  /** A gossiped charter's chance of still being open (1: certain), and the cash per ton if it isn't. */
  open: number;
  low: number;
}

/** A lane's laden passage as the scenarios see it (pence). */
export interface RiskProfile {
  /** Cash the load ties up at the source (the Kelly stake): goods and freight collateral. */
  stake: number;
  /** What the goods cost (ask, customs and the remittance fee). */
  cost: number;
  parts: RiskPart[];
  freightReward: number;
  freightCollateral: number;
  /** Passenger fares counted (an expectation over the ship being lost). */
  pax: number;
  /** Never scaled with the stake: the hull's expected loss and the berth dues. */
  fixed: number;
  /** Chance the ship is lost on the laden passage (captured or sunk). */
  lost: number;
  /** Given she isn't lost: the chance of a raid that lets her go and the share it seizes; of storm damage and its share. */
  raid: number;
  raidTake: number;
  storm: number;
  stormTake: number;
  /** The planner's expected share of the cargo kept (preserved). */
  kept: number;
}

/** Weighted outcome points: `cargo` scales with the stake (goods and freight net of their cost), `other` doesn't (fares, hull, dues). */
export interface Outcomes {
  w: number[];
  cargo: number[];
  other: number[];
}

/** Inverse standard normal CDF (Acklam's rational approximation, |error| < 1.2e-9). */
function normInv(p: number): number {
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const lo = 0.02425;
  if (p < lo) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - lo) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  const q = p - 0.5;
  const r = q * q;
  return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/** A small seeded generator (mulberry32): the same draws on every pass and every restart. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Stratified draws per part slot (Latin hypercube over the slots): normals `z` and uniforms `u`, built once per sample count and slot. */
const tables = new Map<number, { z: Float64Array[]; u: Float64Array[] }>();

function drawsFor(n: number, slots: number): { z: Float64Array[]; u: Float64Array[] } {
  let t = tables.get(n);
  if (!t) tables.set(n, (t = { z: [], u: [] }));
  while (t.z.length < slots) {
    const j = t.z.length;
    const perm = (seed: number) => {
      const next = rng(seed);
      const p = Array.from({ length: n }, (_, i) => i);
      for (let i = n - 1; i > 0; i--) {
        const k = Math.floor(next() * (i + 1));
        [p[i], p[k]] = [p[k], p[i]];
      }
      return p;
    };
    const pz = perm(0x5eed0 + 2 * j);
    const pu = perm(0x5eed1 + 2 * j);
    const z = new Float64Array(n);
    const u = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      z[i] = normInv((pz[i] + 0.5) / n);
      u[i] = (pu[i] + 0.5) / n;
    }
    t.z.push(z);
    t.u.push(u);
  }
  return t;
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, Number.isFinite(x) ? x : 0));

/** The lane's outcome points (see the header): the loss model's states enumerated, `n` price draws in each surviving one. */
export function outcomes(p: RiskProfile, n = SAA_SAMPLES): Outcomes {
  const w: number[] = [];
  const cargo: number[] = [];
  const other: number[] = [];
  const lost = Math.min(0.95, clamp01(p.lost));
  if (lost > 0) {
    w.push(lost);
    cargo.push(-p.cost - p.freightCollateral);
    other.push(-p.fixed);
  }
  if (lost >= 1) return { w, cargo, other };
  const pr = clamp01(p.raid);
  const ps = clamp01(p.storm);
  const states: Array<[number, number]> = [];
  for (const r of [0, 1]) {
    for (const s of [0, 1]) {
      const q = (r ? pr : 1 - pr) * (s ? ps : 1 - ps);
      if (q > 0) states.push([q, (1 - r * clamp01(p.raidTake)) * (1 - s * clamp01(p.stormTake))]);
    }
  }
  // The planner's expected kept share preserved: the states shape the spread, not the mean.
  const eKept = (1 - lost) * states.reduce((x, [q, k]) => x + q * k, 0);
  const scale = eKept > 0 && p.kept > 0 ? p.kept / eKept : 1;
  const d = drawsFor(n, Math.max(1, p.parts.length));
  const values = new Float64Array(n);
  for (const [j, part] of p.parts.entries()) {
    const open = clamp01(part.open);
    const low = Math.max(0, Math.min(part.low, part.pay));
    const z = d.z[j];
    const u = d.u[j];
    // Exact means over the draws: the open share as drawn sets the open pay, and the price factor is divided by its own mean.
    let opened = 0;
    if (open < 1) for (let i = 0; i < n; i++) if (u[i] < open) opened++;
    const share = opened / n;
    const high = open < 1 && share > 0 ? Math.max(low, (part.pay - (1 - share) * low) / share) : part.pay;
    const rel = Math.max(0, Math.min(1, part.rel || 0));
    let norm = 1;
    if (rel > 0) {
      norm = 0;
      for (let i = 0; i < n; i++) norm += Math.exp(rel * z[i]);
      norm /= n;
    }
    for (let i = 0; i < n; i++) {
      let pay = open < 1 ? (share > 0 && u[i] < open ? high : share > 0 ? low : part.pay) : part.pay;
      if (rel > 0) pay *= Math.exp(rel * z[i]) / norm;
      values[i] += part.tons * (pay + part.bonus);
    }
  }
  const pax = p.pax / (1 - lost);
  for (const [q, k] of states) {
    const kept = Math.min(1, k * scale);
    const wq = ((1 - lost) * q) / n;
    for (let i = 0; i < n; i++) {
      w.push(wq);
      cargo.push(kept * values[i] - p.cost + p.freightReward);
      other.push(pax - p.fixed);
    }
  }
  return { w, cargo, other };
}

/** Stake fractions of the bankroll (Infinity: no downside within reach, so no cap). */
export interface StakeFraction {
  /** Mean return per pence staked. */
  edge: number;
  kelly: number;
  rck: number;
  /** k = 1/(1 + Var(edge)/edge²) (1: no estimation variance beyond the scenarios'). */
  shrink: number;
  /** min(RCK, half-Kelly) × k. */
  frac: number;
}

/**
 * How much of the bankroll this lane's stake may be (see the header): full Kelly, risk-constrained Kelly (bisection), the shrinkage,
 * and min(RCK, KELLY_SHARE × Kelly) × k. `edgeVar`: the variance (pence², of the cargo outcome at this stake) of an edge estimate the
 * scenarios don't already spread; never a sale's forecast sd, which the outcomes carry (counted twice, it cut thin lanes 2-20× more).
 */
export function stakeFraction(o: Outcomes, stake: number, edgeVar = 0): StakeFraction {
  if (!(stake > 0) || o.w.length === 0) return { edge: 0, kelly: Infinity, rck: Infinity, shrink: 1, frac: Infinity };
  const n = o.w.length;
  const r = new Float64Array(n);
  let edge = 0;
  let rMin = Infinity;
  for (let i = 0; i < n; i++) {
    r[i] = o.cargo[i] / stake;
    edge += o.w[i] * r[i];
    if (o.w[i] > 0) rMin = Math.min(rMin, r[i]);
  }
  if (!(edge > 0)) return { edge, kelly: 0, rck: 0, shrink: 0, frac: 0 };
  // Up to where the worst outcome would take the whole bankroll (or the search's end).
  const top = rMin < 0 ? Math.min(F_SEARCH_MAX, (1 / -rMin) * (1 - 1e-9)) : F_SEARCH_MAX;
  const slope = (f: number) => {
    let x = 0;
    for (let i = 0; i < n; i++) x += (o.w[i] * r[i]) / (1 + f * r[i]);
    return x;
  };
  let kelly: number;
  if (slope(top) >= 0) kelly = rMin < 0 && top < F_SEARCH_MAX ? top : Infinity;
  else {
    let lo = 0;
    let hi = top;
    for (let k = 0; k < 50; k++) {
      const mid = (lo + hi) / 2;
      if (slope(mid) > 0) lo = mid;
      else hi = mid;
    }
    kelly = lo;
  }
  // RCK: E[(1 + f r)^-λ] ≤ 1, convex in f and equal at f = 0 with a falling start (edge > 0): the stakes allowed are [0, f_rck].
  const risk = (f: number) => {
    let x = 0;
    for (let i = 0; i < n; i++) x += o.w[i] * Math.pow(1 + f * r[i], -RCK_LAMBDA);
    return x - 1;
  };
  let rck: number;
  if (risk(top) <= 0) rck = top < F_SEARCH_MAX ? top : Infinity;
  else {
    let lo = 0;
    let hi = top;
    for (let k = 0; k < 50; k++) {
      const mid = (lo + hi) / 2;
      if (risk(mid) <= 0) lo = mid;
      else hi = mid;
    }
    rck = lo;
  }
  const varEdge = Math.max(0, edgeVar) / (stake * stake);
  const shrink = 1 / (1 + varEdge / (edge * edge));
  const frac = Math.min(rck, KELLY_SHARE * kelly) * shrink;
  return { edge, kelly, rck, shrink, frac };
}

/** Share of the bankroll left below which log utility runs on as its tangent line there (ruin and past it: see certainty). */
export const CE_EPS = 0.01;
const LN_CE_EPS = Math.log(CE_EPS);

/**
 * The certainty equivalent (pence) of the lane's outcomes on `bankroll`: B·(e^g − 1), g the expected log-growth, `scale` times the
 * stake. A point leaving less than CE_EPS of the bankroll (or a debt past it) is valued on the tangent of the log there, so the utility
 * stays strictly increasing and concave past ruin: each further pence lost costs more, and a bigger stake past the bankroll never
 * scores higher than a smaller one. No (or an unbounded) bankroll: the plain expectation.
 */
export function certainty(o: Outcomes, bankroll: number, scale = 1): number {
  if (!(bankroll > 0) || !Number.isFinite(bankroll)) return o.w.reduce((x, w, i) => x + w * (scale * o.cargo[i] + o.other[i]), 0);
  let g = 0;
  for (let i = 0; i < o.w.length; i++) {
    const x = (scale * o.cargo[i] + o.other[i]) / bankroll;
    g += o.w[i] * (1 + x >= CE_EPS ? Math.log1p(x) : LN_CE_EPS + (1 + x - CE_EPS) / CE_EPS);
  }
  return bankroll * Math.expm1(g);
}

/** A lane's correlation groups and the share of its stake in each: the zones its laden passage rolls for, the markets it sells into. */
export function riskGroups(l: { dest: string; zones?: string[]; parts: Array<{ kind: string; good: string; tons: number; costPerTon: number }> }): Array<[string, number]> {
  const out: Array<[string, number]> = (l.zones ?? []).map((z) => [`zone:${z}`, 1]);
  const total = l.parts.reduce((n, p) => n + Math.max(0, p.tons * p.costPerTon), 0);
  if (total > 0) for (const p of l.parts) if (p.kind === "market" && p.tons > 0) out.push([`sell:${l.dest}|${p.good}`, (p.tons * p.costPerTon) / total]);
  return out;
}

/** How many stake fractions a group's ships share. */
export const groupShare = (g: string) => (g.startsWith("zone:") ? ZONE_GROUP_X : 1);

/**
 * The most this lane may stake (pence): `frac` of the bankroll, and in each group it shares, what that group's cap (groupShare × frac
 * of the bankroll) leaves after our other ships' stakes there. Infinity: no cap. Non-decreasing in the bankroll; 0 at or under 0 (the
 * planner's floor alone then).
 */
export function stakeCap(frac: number, bankroll: number, groups: Array<[string, number]>, exposure: ReadonlyMap<string, number>): number {
  if (!Number.isFinite(frac)) return Infinity;
  let cap = frac * bankroll;
  for (const [g, share] of groups) {
    if (!(share > 0)) continue;
    const room = groupShare(g) * frac * bankroll - (exposure.get(g) ?? 0);
    cap = Math.min(cap, room / share);
  }
  return Math.max(0, cap);
}

// ── Fleet assignment ──────────────────────────────────────────────────────────

/** Lanes per ship weighed for its regret. */
export const REGRET_TOP = 8;
/** A lane another commit made stale counts this share of its score until it is planned again. */
export const STALE_DISCOUNT = 0.7;

/** One lane a ship could take, for its regret: its score (pence an hour), what it reserves, and whether a commit made it stale. */
export interface Choice {
  score: number;
  keys: string[];
  stale: boolean;
}

/** What a lane reserves: charter room, source stock, buyers and freight lots (`currentId`: the posting that now stands for a charter). */
export function laneKeys(
  l: { source: string; dest: string; fills: Array<[string, number]>; parts: Array<{ kind: string; good: string }>; freight: Array<{ id: string }> },
  currentId: (id: string) => string,
): string[] {
  const keys: string[] = [];
  for (const [id] of l.fills) keys.push(`c:${currentId(id)}`);
  for (const p of l.parts) {
    keys.push(`src:${l.source}|${p.good}`);
    if (p.kind === "market") keys.push(`sell:${l.dest}|${p.good}`);
  }
  for (const f of l.freight) keys.push(`f:${f.id}`);
  return keys;
}

/**
 * A ship's regret (pence an hour): the lane it would take first over its best one sharing nothing with it (nothing: 0). No lane at
 * all: Infinity (settled at once, it waits as ever).
 */
export function regretOf(options: Choice[]): number {
  if (options.length === 0) return Infinity;
  const val = (o: Choice) => Math.max(0, o.score) * (o.stale ? STALE_DISCOUNT : 1);
  const first = options[0];
  const taken = new Set(first.keys);
  let alt = 0;
  for (const o of options.slice(1)) if (!o.keys.some((k) => taken.has(k))) alt = Math.max(alt, val(o));
  return val(first) - alt;
}

/** The ship served next: forced ones (an order) first, then the greatest regret; ties go to the first asked. */
export function nextByRegret(entries: Array<{ forced: boolean; options: Choice[] }>): number {
  let best = 0;
  let bestR = -Infinity;
  for (const [i, e] of entries.entries()) {
    const r = e.forced ? Infinity : regretOf(e.options);
    if (r > bestR) {
      best = i;
      bestR = r;
    }
  }
  return best;
}

// ── Deadline charters: insertion ──────────────────────────────────────────────

/** A ship at sea must gain this many times what the ship in port loses, and INSERT_MIN_PENCE more, to be given a deadline charter. */
export const INSERT_EDGE = 1.5;
export const INSERT_MIN_PENCE = 50_000;
/** At most this many ships at sea are weighed for one charter. */
export const INSERT_MAX_SHIPS = 3;
/** The claimant takes the claimed charter's lane when it scores at least this share of her best. */
export const CLAIM_KEEP = 0.8;

/** Whether a ship at sea (gaining `there` pence, after her current leg) should have the charter over the one in port (losing `here`). */
export function insertionWins(here: number, there: number): boolean {
  return Number.isFinite(there) && there > INSERT_EDGE * Math.max(0, here) + INSERT_MIN_PENCE;
}

/** A deadline charter held for one of our ships at sea, after her current leg (in memory only: a restart drops it, safely). */
export interface CharterClaim {
  /** The posting's current id. */
  charter: string;
  port: string;
  good: string;
  shipId: string;
  ship: string;
  tons: number;
  /** Server ms: dropped then unless she has planned. */
  until: number;
  /** Her lane when it was claimed (another lane before she plans drops it). */
  afterKey: string | null;
  /** What she was expected to gain over the ship in port's loss (pence). */
  gain: number;
  here: number;
  at: number;
}

// ── Records ───────────────────────────────────────────────────────────────────

export interface AllocStats {
  /** Assignment passes run by regret, and the ships in them. */
  batches: number;
  batchedShips: number;
  /** Ships served before one that asked first; lanes planned again before their commit (stale); passes cut short by the time box. */
  reordered: number;
  reranked: number;
  timeouts: number;
  /** Loads cut by the Kelly/RCK cap (committed), and the stake cut (pence). */
  kellyCapped: number;
  kellyCutPence: number;
  /** Deadline charters weighed for insertion, given to a ship at sea, then taken by her, or dropped. */
  insertChecks: number;
  claims: number;
  claimsKept: number;
  claimsLapsed: number;
}

export const emptyAllocStats = (): AllocStats => ({
  batches: 0,
  batchedShips: 0,
  reordered: 0,
  reranked: 0,
  timeouts: 0,
  kellyCapped: 0,
  kellyCutPence: 0,
  insertChecks: 0,
  claims: 0,
  claimsKept: 0,
  claimsLapsed: 0,
});

export function restoreAllocStats(x: unknown): AllocStats {
  const s = emptyAllocStats();
  if (!x || typeof x !== "object") return s;
  for (const k of Object.keys(s) as (keyof AllocStats)[]) {
    const v = (x as Record<string, unknown>)[k];
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) s[k] = v;
  }
  return s;
}

/** One allocation decision, for the panel (times ISO, money pence). */
export interface AllocEvent {
  at: string;
  kind: "kelly" | "regret" | "claim" | "claim_kept" | "claim_lapsed";
  ship: string;
  text: string;
}

/** Scoring and allocation for the panel (`FleetState.allocation`). Money pence; V pence an hour per ton of hold. */
export interface AllocationReport {
  kelly: { on: boolean; user: boolean; bankroll: number | null };
  regret: { on: boolean; user: boolean };
  stats: AllocStats;
  terminal: { ports: number; known: number; medianV: number | null; medianH: number | null; top: Array<{ port: string; v: number; h: number; n: number; at: number }> };
  claims: Array<{ charter: string; port: string; good: string; ship: string; tons: number; until: string; gain: number; here: number }>;
  recent: AllocEvent[];
}
