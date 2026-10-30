/**
 * Posted prices learned by Thompson sampling (the fareBandit and orderHulls settings; research u6 §1: Besbes & Zeevi, Ferreira,
 * Simchi-Levi & Wang, Russo et al. §6.3, Trovò et al.). Pure: no I/O; the randomness is passed in (Math.random by default).
 *
 * A "key" is one market the price is posted in (a passengers' route-length band × kind × whether anyone competes; our convoys' escort
 * fee; a hull class commissioned). Its price is a multiplier on a reference the caller works out each time (the band's or the route's
 * median fare, the fee our loss model sets, our own cheapest build), so the arms keep their meaning while the reference moves with the
 * market: the step rule (the reference, and the old learner's nudge) moves the grid's centre, the bandit picks within it.
 *
 *   - Arms: a fixed grid of multipliers per key kind (FARE_GRID, ESCORT_GRID, HULL_GRID).
 *   - Beliefs: per arm a Beta posterior on "taken" (an offer's share of the heads that could board that did, a fractional trial; a
 *     convoy a paying ship joined; a commission a builder took): an informative prior (`Prior`: the acceptance the old learner implies at its centre, `p` there, falling off as
 *     a logistic in log-price with `slope`, `n` pseudo-trials per arm, never Beta(1,1)) plus the data counts, which are discounted
 *     (BANDIT_GAMMA a trial on the key, and a half-life in game time) so a market that moves is followed.
 *   - Choice: θ drawn per arm, made monotone in price by pooling adjacent violators (acceptance never rises with the price for a
 *     seller's posted price, `dir: "down"`; never falls for a buyer's, `dir: "up"`), and the caller's value of each arm on those θ
 *     (price × θ × the heads the berths take for fares: θ is the share of them expected to board) picks the arm; `best` is the same
 *     pick on the posterior means (no draw), what the planner counts on.
 *
 * Nothing here says when to post: the callers keep every check they had, and fall back to their old rule with the setting off.
 */

/** Acceptance falls as a seller's price rises ("down": fares, escort fees) and rises as a buyer's does ("up": a commission we post). */
export type Direction = "down" | "up";

/** Per arm data counts (discounted), the last update (server ms), trials seen, and the prior's centre and odds there as last used. */
export interface ArmState {
  a: number[];
  b: number[];
  at: number;
  n: number;
  /** The prior as last used (the report reads posterior means with it). */
  c?: number;
  p?: number;
}

export interface BanditSnapshot {
  v: 1;
  keys: Array<[string, ArmState]>;
}

/** The prior on a key's acceptance: `p` at multiplier `centre`, a logistic in log-price with `slope`, `n` pseudo-trials per arm. */
export interface Prior {
  centre: number;
  p: number;
  slope: number;
  n: number;
  dir: Direction;
}

/** Fare multipliers on the reference (the route's or its band's median, speed-weighed): 0.7x to 2x, about 8% apart. */
export const FARE_GRID: readonly number[] = [0.7, 0.78, 0.86, 0.94, 1.03, 1.13, 1.25, 1.4, 1.58, 1.78, 2];
/** Our convoys' escort fee per ton: multipliers on the fee our loss model sets (half the joiner's saving). */
export const ESCORT_GRID: readonly number[] = [0.3, 0.45, 0.65, 0.85, 1, 1.25, 1.55, 2];
/** A commission we post for a hull: multipliers on our own cheapest build (always under it). */
export const HULL_GRID: readonly number[] = [0.6, 0.66, 0.72, 0.78, 0.84, 0.89, 0.94];

/** The grid a key's arms stand on, by its kind (`pax|…`, `escort|…`, `hull|…`); none for another. */
export function gridOf(key: string): readonly number[] {
  return key.startsWith("pax|") ? FARE_GRID : key.startsWith("escort|") ? ESCORT_GRID : key.startsWith("hull|") ? HULL_GRID : [];
}

/** Discount on a key's data per trial on it (1/γ ≈ trials over which the market changes). */
export const BANDIT_GAMMA = 0.03;
/** The data's half-life in game hours (fares move with the season and the competition: a week). */
export const BANDIT_HALF_LIFE_GAME_H = 7 * 24;
/** Keys tried rarely (a convoy formed, a hull ordered): a gentler discount and a longer memory, so a dead market stops being probed. */
export const BANDIT_RARE_GAMMA = 0.01;
export const BANDIT_RARE_HALF_LIFE_GAME_H = 30 * 24;

/** A key's discount per trial and its data's half-life (game hours), by its kind. */
export function decayOf(key: string): { gamma: number; halfLifeGameH: number } {
  return key.startsWith("pax|") ? { gamma: BANDIT_GAMMA, halfLifeGameH: BANDIT_HALF_LIFE_GAME_H } : { gamma: BANDIT_RARE_GAMMA, halfLifeGameH: BANDIT_RARE_HALF_LIFE_GAME_H };
}
/** Keys kept (least recently updated dropped first). */
export const BANDIT_KEYS_KEPT = 300;
/** A posterior never narrower than this many trials' worth per arm on the prior side. */
const PRIOR_MIN_N = 1;

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const logit = (p: number) => Math.log(p / (1 - p));
const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

/** The prior acceptance at multiplier `m`: `p` at the centre, a logistic in log-price falling ("down") or rising ("up") with the slope. */
export function priorAt(m: number, pr: Prior): number {
  const p = clamp(pr.p, 0.02, 0.98);
  const x = Math.log(Math.max(m, 1e-6) / Math.max(pr.centre, 1e-6));
  return clamp(sigmoid(logit(p) + (pr.dir === "down" ? -1 : 1) * pr.slope * x), 0.01, 0.99);
}

/** Standard normal by Box-Muller. */
function normal(rng: () => number): number {
  const u = Math.max(rng(), 1e-12);
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Gamma(k, 1) by Marsaglia-Tsang (k < 1 boosted by u^(1/k)). */
function gamma(k: number, rng: () => number): number {
  if (!(k > 0)) return 0;
  if (k < 1) return gamma(k + 1, rng) * Math.pow(Math.max(rng(), 1e-12), 1 / k);
  const d = k - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (let i = 0; i < 64; i++) {
    let x: number;
    let v: number;
    do {
      x = normal(rng);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = Math.max(rng(), 1e-12);
    if (Math.log(u) < 0.5 * x * x + d - d * v + d * Math.log(v)) return d * v;
  }
  return d;
}

/** A Beta(a, b) draw. */
export function betaSample(a: number, b: number, rng: () => number = Math.random): number {
  const x = gamma(Math.max(a, 1e-6), rng);
  const y = gamma(Math.max(b, 1e-6), rng);
  return x + y > 0 ? x / (x + y) : a / (a + b);
}

/**
 * The weighted least-squares monotone fit of `xs` (pool adjacent violators): non-increasing along the array ("down") or
 * non-decreasing ("up"). `ws`: weights (the posteriors' strength).
 */
export function monotone(xs: readonly number[], ws: readonly number[], dir: Direction): number[] {
  const sgn = dir === "down" ? -1 : 1;
  // Fit the non-decreasing sequence of sgn·x, then map back.
  const blocks: Array<{ v: number; w: number; n: number }> = [];
  for (let i = 0; i < xs.length; i++) {
    let b = { v: sgn * xs[i], w: Math.max(ws[i] ?? 1, 1e-9), n: 1 };
    while (blocks.length && blocks[blocks.length - 1].v > b.v) {
      const p = blocks.pop()!;
      const w = p.w + b.w;
      b = { v: (p.v * p.w + b.v * b.w) / w, w, n: p.n + b.n };
    }
    blocks.push(b);
  }
  const out: number[] = [];
  for (const b of blocks) for (let i = 0; i < b.n; i++) out.push(sgn * b.v);
  return out;
}

/** The unit normal loss function L(z) = φ(z) − z(1 − Φ(z)) (the expected improvement of a choice `z` sds behind). */
export function normalLoss(z: number): number {
  const phi = Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);
  return Math.max(0, phi - z * (1 - normCdf(z)));
}

/** Φ(z), by the Abramowitz-Stegun erf (error < 1.5e-7). */
export function normCdf(z: number): number {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return z >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}

/** One draw of the key's acceptance per arm, monotone in price. */
export function drawTheta(st: ArmState | undefined, grid: readonly number[], pr: Prior, rng: () => number = Math.random): number[] {
  const n = Math.max(PRIOR_MIN_N, pr.n);
  const raw: number[] = [];
  const ws: number[] = [];
  for (let k = 0; k < grid.length; k++) {
    const p0 = priorAt(grid[k], pr);
    const a = n * p0 + (st?.a[k] ?? 0);
    const b = n * (1 - p0) + (st?.b[k] ?? 0);
    raw.push(betaSample(a, b, rng));
    ws.push(a + b);
  }
  return monotone(raw, ws, pr.dir);
}

/** The posterior mean acceptance per arm, monotone in price (for planning and the report: no draw). */
export function meanTheta(st: ArmState | undefined, grid: readonly number[], pr: Prior): number[] {
  const n = Math.max(PRIOR_MIN_N, pr.n);
  const mean: number[] = [];
  const ws: number[] = [];
  for (let k = 0; k < grid.length; k++) {
    const p0 = priorAt(grid[k], pr);
    const a = n * p0 + (st?.a[k] ?? 0);
    const b = n * (1 - p0) + (st?.b[k] ?? 0);
    mean.push(a / (a + b));
    ws.push(a + b);
  }
  return monotone(mean, ws, pr.dir);
}

/**
 * The arm a key's posted price stands on: the key, the arm's index, its multiplier, and the prior's centre and odds there (kept on the
 * key for the report). Kept on the offer it priced, so its outcome goes to the right arm.
 */
export interface ArmRef {
  key: string;
  k: number;
  m: number;
  c?: number;
  p?: number;
}

/** An arm reference read back from a save (null: malformed). */
export function armOf(x: unknown): ArmRef | null {
  const r = x as ArmRef | null;
  if (!r || typeof r !== "object" || typeof r.key !== "string" || !Number.isInteger(r.k) || r.k < 0 || !Number.isFinite(r.m)) return null;
  return { key: r.key, k: r.k, m: r.m, ...(Number.isFinite(r.c) && Number.isFinite(r.p) ? { c: r.c, p: r.p } : {}) };
}

/**
 * Every key's posteriors (World keeps one, saved with its snapshot). `choose` draws and picks, `observe` takes a trial's outcome in,
 * `mean` reads a posterior mean.
 */
export class PostedPrices {
  private readonly keys = new Map<string, ArmState>();

  /** `gameMinuteMs`: real ms a game minute (the data's half-life is in game time). */
  constructor(private readonly gameMinuteMs: () => number) {}

  /** The state of a key (undefined: never tried). */
  get(key: string): ArmState | undefined {
    return this.keys.get(key);
  }

  /**
   * Draws θ per arm and returns the arm whose `value(k, θk)` is highest among `ok` arms (null: none ok or none worth anything), with
   * the draws. The prior used is kept on the key for the report.
   */
  choose(key: string, grid: readonly number[], pr: Prior, value: (k: number, theta: number) => number, ok: (k: number) => boolean = () => true, rng: () => number = Math.random): { k: number; theta: number[]; value: number } | null {
    const st = this.keys.get(key);
    if (st) {
      st.c = pr.centre;
      st.p = pr.p;
    }
    const theta = drawTheta(st, grid, pr, rng);
    let best: { k: number; value: number } | null = null;
    for (let k = 0; k < grid.length; k++) {
      if (!ok(k)) continue;
      const v = value(k, theta[k]);
      if (Number.isFinite(v) && (!best || v > best.value)) best = { k, value: v };
    }
    return best ? { k: best.k, theta, value: best.value } : null;
  }

  /** Posterior mean acceptance at arm `k` under prior `pr` (no draw). */
  mean(key: string, grid: readonly number[], pr: Prior, k: number): number {
    return meanTheta(this.keys.get(key), grid, pr)[k] ?? 0;
  }

  /**
   * The arm whose `value(k, θk)` is highest among `ok` arms at the posterior means (no draw, nothing kept on the key): what a choice is
   * expected to post, for planning on it. Null: none ok or none worth anything.
   */
  best(key: string, grid: readonly number[], pr: Prior, value: (k: number, theta: number) => number, ok: (k: number) => boolean = () => true): { k: number; theta: number[]; value: number } | null {
    const theta = meanTheta(this.keys.get(key), grid, pr);
    let best: { k: number; value: number } | null = null;
    for (let k = 0; k < grid.length; k++) {
      if (!ok(k)) continue;
      const v = value(k, theta[k]);
      if (Number.isFinite(v) && (!best || v > best.value)) best = { k, value: v };
    }
    return best ? { k: best.k, theta, value: best.value } : null;
  }

  /**
   * A trial on `ref` came out `won` at server ms `at`: the key's data discounted (per trial and for the time since), the arm's counted.
   * `won` a number: a share of a success (0..1; a fare's heads boarded of those that could), counted as that much won and the rest lost.
   */
  observe(ref: ArmRef, won: boolean | number, at: number): void {
    const arms = ref && typeof ref.key === "string" ? gridOf(ref.key).length : 0;
    if (!ref || arms === 0 || !(ref.k >= 0) || ref.k >= arms || !Number.isFinite(at)) return;
    let st = this.keys.get(ref.key);
    if (!st || st.a.length !== arms) st = { a: new Array<number>(arms).fill(0), b: new Array<number>(arms).fill(0), at, n: 0, ...(st?.c !== undefined ? { c: st.c, p: st.p } : {}) };
    const d = decayOf(ref.key);
    const hl = d.halfLifeGameH * 60 * this.gameMinuteMs();
    const age = Math.max(0, at - st.at);
    const f = (1 - d.gamma) * (hl > 0 ? Math.pow(0.5, age / hl) : 1);
    for (let i = 0; i < arms; i++) {
      st.a[i] *= f;
      st.b[i] *= f;
    }
    const share = typeof won === "number" ? (Number.isFinite(won) ? Math.min(1, Math.max(0, won)) : 0) : won ? 1 : 0;
    st.a[ref.k] += share;
    st.b[ref.k] += 1 - share;
    st.n += 1;
    if (Number.isFinite(ref.c) && Number.isFinite(ref.p)) {
      st.c = ref.c;
      st.p = ref.p;
    }
    st.at = Math.max(st.at, at);
    this.keys.delete(ref.key);
    this.keys.set(ref.key, st);
    while (this.keys.size > BANDIT_KEYS_KEPT) this.keys.delete(this.keys.keys().next().value!);
  }

  /** Data weight left on a key (discounted trials), for the report. */
  weight(key: string): number {
    const st = this.keys.get(key);
    return st ? st.a.reduce((n, x) => n + x, 0) + st.b.reduce((n, x) => n + x, 0) : 0;
  }

  /** Every key, least recently updated first. */
  list(): Array<[string, ArmState]> {
    return [...this.keys];
  }

  snapshot(): BanditSnapshot {
    const r = (x: number) => Math.round(x * 1000) / 1000;
    return { v: 1, keys: [...this.keys].map(([k, s]) => [k, { a: s.a.map(r), b: s.b.map(r), at: s.at, n: s.n, ...(s.c !== undefined ? { c: r(s.c), p: r(s.p ?? 0.5) } : {}) }]) };
  }

  /** Puts back a snapshot; malformed keys dropped. */
  restore(s: BanditSnapshot | undefined | null): void {
    this.keys.clear();
    if (!s || s.v !== 1 || !Array.isArray(s.keys)) return;
    const okArr = (x: unknown): x is number[] => Array.isArray(x) && x.every((v) => typeof v === "number" && Number.isFinite(v) && v >= 0);
    for (const e of s.keys.slice(-BANDIT_KEYS_KEPT)) {
      if (!Array.isArray(e) || typeof e[0] !== "string") continue;
      const st = e[1];
      // A grid changed since the save: that key starts again.
      if (!st || !okArr(st.a) || !okArr(st.b) || st.a.length !== st.b.length || st.a.length !== gridOf(e[0]).length || !Number.isFinite(st.at)) continue;
      this.keys.set(e[0], {
        a: [...st.a],
        b: [...st.b],
        at: st.at,
        n: Number.isFinite(st.n) ? st.n : 0,
        ...(Number.isFinite(st.c) && Number.isFinite(st.p) ? { c: st.c, p: st.p } : {}),
      });
    }
  }
}

/** One key's line for the report: trials, data left after the discount, and the arm the posterior means favour (by `value`). */
export interface BanditRow {
  key: string;
  trials: number;
  weight: number;
  at: number;
  /** Posterior mean acceptance per arm (rounded), the multiplier the means favour, and the acceptance there. */
  arms: Array<{ m: number; p: number }>;
  bestM: number | null;
  bestP: number | null;
}

/** A key's report line from its saved prior (`dir`, `slope`, `n` as the caller's kind uses them) and a value per arm (m × θ by default). */
export function banditRow(key: string, st: ArmState, grid: readonly number[], dir: Direction, slope: number, n: number, value: (m: number, p: number) => number = (m, p) => (dir === "down" ? m * p : p * (1 - m))): BanditRow {
  const pr: Prior = { centre: st.c ?? 1, p: st.p ?? 0.5, slope, n, dir };
  const means = meanTheta(st, grid, pr);
  let best: { m: number; p: number; v: number } | null = null;
  const arms = grid.map((m, k) => {
    const p = means[k];
    const v = value(m, p);
    if (!best || v > best.v) best = { m, p, v };
    return { m, p: Math.round(p * 1000) / 1000 };
  });
  const b = best as { m: number; p: number; v: number } | null;
  return { key, trials: st.n, weight: Math.round((st.a.reduce((x, y) => x + y, 0) + st.b.reduce((x, y) => x + y, 0)) * 10) / 10, at: st.at, arms, bestM: b ? b.m : null, bestP: b ? Math.round(b.p * 1000) / 1000 : null };
}
