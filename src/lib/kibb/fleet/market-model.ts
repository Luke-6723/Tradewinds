/**
 * The market model (the `marketModel` setting): what a port's NPC market for a good is expected to quote when a ship gets there,
 * and what each further ton bought or sold costs or fetches. Pure logic, no calls: World feeds it the books and gossip it reads and
 * our own fills, keeps it in its snapshot, and gates it (World.marketView); the planner leans on it in proportion to its confidence,
 * the old constants and haircut standing for the rest and wherever it has nothing.
 *
 * What it rests on (guide 3.1): prices follow scarcity, a bounded monotone function of stock: near the catalog base at normal stock,
 * steeply dearer as stock falls, cheaper in a glut. Production, consumption and NPC shipping pull stock back towards normal, strongly
 * when a source is near, weakly when far; cheap bulk goods run deeper markets and recover more slowly once drained. A quay shows the
 * live full depth with `npc_current_stock` (each NPC ask tranche a tenth of the stock, so the ask ladder walks the curve down the
 * stock); coffee-house gossip carries a remote port's stock and best bid and ask with its age. NPC ladders re-quote every 6 game hours
 * (guide 3.2): the model's time step.
 *
 * Per port and good:
 * - Scarcity curve, each side apart: ln p = a − e·ln S, a power law in stock kept within bounds (PRICE_LO/HI_OF_BASE of the catalog
 *   base, widened to what was seen). Fitted by Huber-weighted least squares with a ridge prior on the elasticity e (the good class's
 *   pooled figure, else E_PRIOR) from (stock, price) points: the best NPC bid and ask in gossip and at our quays (a player's level on
 *   top is left out: it isn't the curve), and the latest quay ladder's deeper NPC levels, each at the stock it is quoted from (asks:
 *   stock less the NPC tons before it; bids: stock plus them). Recent points weigh more; points read during a shortage or glut, or
 *   before a structural shift, much less. Forecasts are anchored to the latest NPC top seen (the curve's shape moves it, its level
 *   doesn't), so a reading just taken is forecast as seen.
 * - Stock as an Ornstein-Uhlenbeck process in re-quote steps: S(k+1) = μ + (1 − θ)(S(k) − μ) + σε. μ is the recency-weighted median
 *   of the stock readings (those just after a fill of ours, or during a shock, left out: our own dips aren't the port's normal);
 *   θ from pairs of readings (a fill of ours just after the first is folded into it; later ones void the pair), shrunk towards its
 *   good class's pooled figure (bulk slower); σ from the pairs' residuals, shrunk likewise.
 * - A Kalman-style state: the latest reading (a stale one predicted forward from its age), our own fills applied as they happen (a
 *   buy lowers the stock by the NPC tons it took, a sale raises it), the variance growing each step: P ← (1 − θ)²·P + σ². A reading
 *   older than the state is used for the fits only (out-of-sequence fusion isn't attempted); one repeating a reading held (the same
 *   report via two boards, a ship in port polling) moves the state only. Just after a fill of ours, the side it didn't walk still
 *   quotes the old stock until the re-quote: that side of the reading is left out of the curve and the anchor.
 * - Ladder refill: after a sweep of ours, the NPC depth on that side at the next re-quote or two gives the share refilled per step
 *   (Obizhaeva-Wang resilience, measured in re-quote steps rather than assumed continuous), per side, shrunk to the class's.
 * - A scorecard: each live book read where an older price was remembered scores the model's forecast of it against the old rule's
 *   (the haircut bid, the unaged ask). Once it has enough, a model worse than the old rule is trusted less, down to not at all.
 * - A book unread for long (or beyond the books kept) keeps only its fitted figures: its priors when it is read again.
 *
 * Confidence (0-1) grows with the distinct readings behind a book (none with a single one) times the scorecard's trust; the planner
 * blends the model with the old rule by it, so thin data changes nothing.
 */

export type BookSide = "bid" | "ask";

/** What a forecaster needs from the world. */
export interface MarketModelEnv {
  /** Server ms now. */
  now(): number;
  /** Real ms per game minute. */
  gameMinuteMs(): number;
  /** The catalog base price (pence; 0: unknown). */
  basePrice(good: string): number;
  /** The good's class for pooled priors: `bulk` for the cheap bulk goods (guide 3.1), else its catalog category. */
  goodClass(good: string): string;
}

/** One level of a quay ladder as the model takes it. */
export interface LadderLevel {
  price: number;
  qty: number;
  npc: boolean;
}

/** A forecast of one side of a book at one time (World.marketView gates it; the planner blends it). */
export interface MarketView {
  /** Server ms of the latest stock reading behind it. */
  seenAt: number;
  /** Re-quote steps from the state to the time asked about. */
  steps: number;
  /** Stock expected then (tons, our fills and the reversion counted) and its sd. */
  stock: number;
  stockSd: number;
  /** The best NPC price expected then (pence per ton) and its sd. */
  price: number;
  sd: number;
  /** 0-1: the data behind it times the scorecard's trust (0: not used). */
  conf: number;
  /** 0-1: the data behind it alone (distinct readings), before the scorecard's trust. */
  data: number;
  /** Average price per ton of `tons` more, after `after` tons taken by others first (asks: bought; bids: sold). */
  avg(tons: number, after?: number): number;
  /** The price of the n-th ton after `after`. */
  marginal(n: number, after?: number): number;
  /** NPC bid depth expected then (tons; bids only, null: none seen at a quay). An ask side's depth is the stock itself. */
  depth: number | null;
}

/** Fitted figures for one book, as the digest and panel show them. */
export interface MarketBookRow {
  port: string;
  good: string;
  /** Latest reading (server ms) and the stock now expected, and its long-run level. */
  seenAt: number;
  stock: number;
  mu: number;
  /** Stock half-life (game hours) and the elasticities (null: no side fitted). */
  halfLifeH: number;
  eBid: number | null;
  eAsk: number | null;
  /** Share refilled per re-quote after a sweep (asks, bids) and the sweeps measured. */
  refillAsk: number;
  refillBid: number;
  sweeps: number;
  readings: number;
  conf: number;
}

/** The model's coverage and calibration (digest, panel). */
export interface MarketModelSummary {
  /** Books kept in full (an idle one keeps only its fitted figures, not counted), those modelled (some confidence), those with ≥ 0.6. */
  books: number;
  modelled: number;
  confident: number;
  /** Median fitted stock half-life (game hours) over modelled books, and over bulk goods. */
  halfLifeH: number | null;
  bulkHalfLifeH: number | null;
  /** Median elasticity per side over books with a side fitted. */
  eBid: number | null;
  eAsk: number | null;
  /** Median refill share per re-quote over books with sweeps measured, and the sweeps (null: none measured). */
  refillAsk: number | null;
  refillBid: number | null;
  sweeps: number;
  /** The scorecard per side: books scored, mean absolute log error of the old rule and of the model, the trust it gives. */
  score: Record<BookSide, { n: number; oldErr: number; modelErr: number; trust: number }>;
  /** The most recently read books (at most `rows`). */
  rows: MarketBookRow[];
}

/** Saved state (world snapshot, optional): books as plain arrays, structural shifts, the scorecard, idle books' fitted figures. */
export interface MarketSnapshot {
  v: 1;
  /** Each book's saved parts (an empty one left out). */
  books: Array<[string, Partial<SavedBook>]>;
  shifts: Array<[string, number]>;
  score: Record<BookSide, Score>;
  /** Absent in older saves. */
  idle?: Array<[string, Mem]>;
}

// ── Constants ────────────────────────────────────────────────────────────────

/** NPC ladders re-quote every 6 game hours (guide 3.2): the model's time step (game minutes). */
export const REQUOTE_GAME_MIN = 360;
/** Readings older than this (game hours) aren't forecast from (the planner's own limit on remembered bids). */
const MAX_AGE_GAME_H = 72;
/** Kept per book: top-of-book points per side, ladder levels per side (the latest ladder only), stock readings, our fills, NPC bid depths, refill samples per side, sweeps awaiting a re-quote. */
const TOP_POINTS_KEPT = 16;
const LADDER_LEVELS_KEPT = 12;
const READINGS_KEPT = 16;
const OWN_KEPT = 24;
const DEPTH_KEPT = 8;
const REFILL_KEPT = 12;
const SWEEPS_KEPT = 4;
/**
 * Books kept in full (the most recently read: well above the catalog's trade pairs, about 540 in the October catalog) and how long
 * an unread one is (game days). Beyond either, a book keeps only its fitted figures (Mem), its priors when it is read again; those
 * go once unread for MEMORY_GAME_DAYS, a structural shift there postdates them, or beyond MEMORY_KEPT (the oldest).
 */
const BOOKS_KEPT = 2000;
const BOOK_IDLE_GAME_DAYS = 10;
const MEMORY_KEPT = 4000;
const MEMORY_GAME_DAYS = 60;
/** Books are pruned at each snapshot, and when one is opened at most this often (game minutes). */
const PRUNE_GAME_MIN = 60;
/** Structural shifts remembered (the newest). */
const SHIFTS_KEPT = 200;
/** A curve point weighs half as much this many game days on; a stock reading in μ likewise. */
const CURVE_HALF_LIFE_GAME_DAYS = 6;
const MU_HALF_LIFE_GAME_DAYS = 4;
/** Points read before a structural shift, or during a shortage or glut, count this much in the curve. */
const SHIFTED_WEIGHT = 0.3;
const SHOCKED_WEIGHT = 0.25;
/** A deeper ladder level's weight (the best level counts 1, like a gossip point). */
const LADDER_WEIGHT = 0.5;
/** Elasticity of price to stock (ln p per ln S) before any is learned, and its bounds. A guess: the old 0.13%-a-ton impact on a ~300 t stock. */
const E_PRIOR = 0.5;
const E_MIN = 0.05;
const E_MAX = 3;
/** The ridge on e, in Σw·(Δln S)²: about four gossip points a quarter of the stock apart. */
const E_RIDGE = 0.25;
/** Huber's k (in robust sds) and the IRLS passes. */
const HUBER_K = 1.5;
const IRLS_PASSES = 3;
/** Price bounds as multiples of base (guide 3.1: bounded both ways; the real bounds aren't published), widened to what was seen. */
const PRICE_LO_OF_BASE = 0.2;
const PRICE_HI_OF_BASE = 5;
/** Reversion per step before any is learned: about two re-quotes' half-life, bulk about four (guide 3.1: drained bulk recovers slowly). Guesses. */
const THETA_PRIOR = 0.3;
const THETA_PRIOR_BULK = 0.16;
const THETA_MIN = 0.02;
const THETA_MAX = 0.9;
/** Stock noise per step as a share of its long-run level, before any is learned. A guess. */
const SIGMA_REL_PRIOR = 0.08;
/** Share of a swept side's depth refilled per re-quote before any is measured. A guess. */
const REFILL_PRIOR = 0.5;
/** Pseudo-observations behind a book's prior (θ, σ; refill) and behind a class's pooled figure. */
const BOOK_PRIOR_N = 4;
const REFILL_PRIOR_N = 2;
const CLASS_PRIOR_N = 3;
/** A pair informs θ only when its first reading sat this share of μ (and 2 t) away from it. */
const THETA_MIN_DEV = 0.1;
/** A pair's readings are at least / at most this many steps apart. */
const PAIR_MIN_STEPS = 1;
const PAIR_MAX_STEPS = 8;
/** Our fills within this many steps after a pair's first reading are folded into it (read just before our trade); later ones void it. */
const PAIR_TRADE_SLACK_STEPS = 0.25;
/** Readings closer than this (steps) count as one; confidence is full at this many distinct readings beyond the first. */
const DISTINCT_STEPS = 0.5;
const CONF_FULL_READINGS = 5;
/** A reading of the same stock (±0.5 t) as one held this close to it (steps) is the same news: it moves the state, not the fits. */
const DUPLICATE_STEPS = 0.25;
/** A reading this soon after a fill of ours (steps) is post-trade: left out of μ. */
const POST_TRADE_STEPS = 0.25;
/** A ladder this fresh (steps) tells which of our tons hit NPC levels and which players', and makes a sweep measurable. */
const LADDER_FRESH_STEPS = 0.5;
/** A sweep counts when it took this share of that side's NPC depth (and 2 t); measured at the first quay read this many steps on, given up after. */
const SWEEP_MIN_SHARE = 0.1;
const SWEEP_MIN_STEPS = 1;
const SWEEP_MAX_STEPS = 2.5;
/** Scorecard: forecasts scored before it decides trust; trust falls from 1 at the old rule's error to 0 at this multiple of it; error floor; EMA rate floor. */
const SCORE_MIN_N = 12;
const SCORE_CUTOFF = 1.25;
const SCORE_FLOOR = 0.01;
const SCORE_ALPHA_MIN = 0.03;
/** A class's pooled priors are gathered again at most this often (real ms). */
const CLASS_POOL_MS = 60_000;
/** Gossip stock is noisier than a quay's (rounding, a crew's look): measurement sd as a share of it. */
const GOSSIP_STOCK_SD = 0.03;
/** A stock reading's measurement variance (t²): a quay's exact count, or gossip's. */
const measureVar = (stock: number, gossip: boolean) => (gossip ? (GOSSIP_STOCK_SD * stock) ** 2 + 1 : 0.01);

// ── State ────────────────────────────────────────────────────────────────────

/** A curve point: server ms, stock (t), price (pence), flags. */
type Pt = [at: number, stock: number, price: number, flags: number];
const P_LADDER = 1;
const P_SHOCKED = 2;
/** A stock reading: server ms, tons, flags. */
type Reading = [at: number, stock: number, flags: number];
const R_QUAY = 1;
const R_POST = 2;
const R_SHOCKED = 4;
/** A ladder level saved: price, tons, NPC (1) or a player's (0). */
type Lvl = [price: number, qty: number, npc: number];
/**
 * A book's fitted figures, kept when its readings go (unread for BOOK_IDLE_GAME_DAYS, or beyond BOOKS_KEPT): server ms of its
 * latest reading, μ, θ, σ/μ, the elasticity per side (0: none fitted), the refill per side, the distinct readings behind it. They
 * stand as its priors when it is read again (none from before a structural shift there).
 */
type Mem = [at: number, mu: number, theta: number, sigmaRel: number, eBid: number, eAsk: number, rBid: number, rAsk: number, n: number];

interface SavedBook {
  bid: Pt[];
  ask: Pt[];
  readings: Reading[];
  /** Our fills (server ms, signed NPC tons: − bought from its asks, + sold into its bids). */
  own: Array<[at: number, tons: number]>;
  /** The latest quay ladder (asks ascending, bids descending), depleted by our fills since. */
  ladder: { at: number; stock: number; asks: Lvl[]; bids: Lvl[] } | null;
  /** NPC bid depth at quays (server ms, tons). */
  depth: Array<[at: number, tons: number]>;
  /** Stock estimate, its variance (t²), server ms. */
  kf: [x: number, p: number, t: number] | null;
  /** Sweeps of ours awaiting a re-quote: server ms, side (0 bid, 1 ask), NPC tons taken, NPC depth left. */
  sweeps: Array<[at: number, side: number, tons: number, depthAfter: number]>;
  /** Refill per re-quote measured, per side (bid, ask): server ms, share. */
  refill: [bid: Array<[number, number]>, ask: Array<[number, number]>];
  /** The latest NPC best per side (bid, ask) with the stock it was quoted at: server ms, stock, price. */
  top: [bid: [number, number, number] | null, ask: [number, number, number] | null];
  /** Latest reading (server ms). */
  seen: number;
  /** What was fitted before its readings last went (prune): its priors. Absent: none (older saves too). */
  mem?: Mem;
}

interface Score {
  n: number;
  old: number;
  model: number;
}

interface SideFit {
  a: number;
  e: number;
  n: number;
  rsd: number;
  lo: number;
  hi: number;
  /** The slope the data alone gives, and its information (Σw·Δx²), for pooling a class's prior. */
  eData: number | null;
  info: number;
}

interface Fit {
  at: number;
  cls: string;
  shiftAt: number;
  bid: SideFit | null;
  ask: SideFit | null;
  mu: number;
  theta: number;
  sigma: number;
  thetaData: number | null;
  pairs: number;
  sigmaRelData: number | null;
  readings: number;
  conf: number;
  refillBid: number;
  refillAsk: number;
  refillBidData: number | null;
  refillAskData: number | null;
  sweeps: number;
  floor: number;
}

interface ClassPrior {
  theta: number;
  sigmaRel: number;
  eBid: number;
  eAsk: number;
  rBid: number;
  rAsk: number;
}

// ── Small maths ──────────────────────────────────────────────────────────────

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const finite = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);

/** The weighted median of [value, weight] pairs (null: none with weight). */
function wmedian(xs: Array<[number, number]>): number | null {
  const s = xs.filter(([v, w]) => finite(v) && w > 0).sort((a, b) => a[0] - b[0]);
  const total = s.reduce((n, [, w]) => n + w, 0);
  if (total <= 0) return null;
  let acc = 0;
  for (const [v, w] of s) {
    acc += w;
    if (acc >= total / 2) return v;
  }
  return s[s.length - 1][0];
}

const median = (xs: number[]): number | null => wmedian(xs.map((x) => [x, 1]));

/** Shrinks `n` observations' figure towards a prior worth `n0` of them. */
const shrink = (data: number | null, n: number, prior: number, n0: number) => (data === null || n <= 0 ? prior : (n * data + n0 * prior) / (n + n0));

/**
 * One side's curve ln p = a − e·ln S by weighted least squares with a ridge on e towards `e0`, re-weighted (Huber) against outliers:
 * a shock's spike or a stray player's level. A single stock level gives the level only (e stays at the prior).
 */
function fitCurve(xs: number[], ys: number[], ws: number[], e0: number): { a: number; e: number; rsd: number; eData: number | null; info: number } | null {
  const n = xs.length;
  if (n === 0) return null;
  let w = [...ws];
  let a = 0;
  let e = e0;
  let eData: number | null = null;
  let info = 0;
  for (let pass = 0; pass < IRLS_PASSES; pass++) {
    let sw = 0;
    let sx = 0;
    let sy = 0;
    for (let i = 0; i < n; i++) {
      sw += w[i];
      sx += w[i] * xs[i];
      sy += w[i] * ys[i];
    }
    if (sw <= 0) return null;
    const mx = sx / sw;
    const my = sy / sw;
    let sxx = 0;
    let sxy = 0;
    for (let i = 0; i < n; i++) {
      sxx += w[i] * (xs[i] - mx) ** 2;
      sxy += w[i] * (xs[i] - mx) * (ys[i] - my);
    }
    // ln p = a − e·x: minimise Σw(y − a + e·x)² + λ(e − e0)², a at the weighted means.
    e = clamp((E_RIDGE * e0 - sxy) / (sxx + E_RIDGE), E_MIN, E_MAX);
    a = my + e * mx;
    info = sxx;
    eData = sxx > 0.02 ? clamp(-sxy / sxx, E_MIN, E_MAX) : null;
    if (pass === IRLS_PASSES - 1) break;
    const res = xs.map((x, i) => ys[i] - (a - e * x));
    const scale = Math.max(0.02, 1.4826 * (wmedian(res.map((r, i) => [Math.abs(r), ws[i]])) ?? 0));
    w = ws.map((wi, i) => wi * Math.min(1, (HUBER_K * scale) / Math.max(Math.abs(res[i]), 1e-9)));
  }
  let sr = 0;
  let sw = 0;
  for (let i = 0; i < n; i++) {
    sr += w[i] * (ys[i] - (a - e * xs[i])) ** 2;
    sw += w[i];
  }
  const rsd = Math.max(0.02, Math.sqrt(sr / Math.max(sw, 1e-9)) * Math.sqrt(n / Math.max(1, n - 1)));
  return { a, e, rsd, eData, info };
}

// ── The model ────────────────────────────────────────────────────────────────

export class MarketModel {
  private readonly books = new Map<string, SavedBook>();
  /** Structural shifts (`port|good`, `port|*`, `*|good`) → server ms of the latest. */
  private readonly shifts = new Map<string, number>();
  private score: Record<BookSide, Score> = { bid: { n: 0, old: 0, model: 0 }, ask: { n: 0, old: 0, model: 0 } };
  /** Fits by book (not saved; refitted when a book changes or a step has passed). */
  private readonly fits = new Map<string, Fit | null>();
  private readonly dirty = new Set<string>();
  private classPriors = new Map<string, ClassPrior>();
  private classPooledAt = 0;
  /** Fitted figures of books whose readings went (prune), by `port|good`: their priors when read again. */
  private readonly idle = new Map<string, Mem>();
  /** Server ms of the last prune. */
  private prunedAt = 0;

  constructor(private readonly env: MarketModelEnv) {}

  private get stepMs(): number {
    return REQUOTE_GAME_MIN * this.env.gameMinuteMs();
  }

  private gameDaysMs(d: number): number {
    return d * 24 * 60 * this.env.gameMinuteMs();
  }

  private book(port: string, good: string): SavedBook {
    const k = `${port}|${good}`;
    let b = this.books.get(k);
    if (!b) {
      if (this.env.now() - this.prunedAt > PRUNE_GAME_MIN * this.env.gameMinuteMs()) this.prune();
      b = { bid: [], ask: [], readings: [], own: [], ladder: null, depth: [], kf: null, sweeps: [], refill: [[], []], top: [null, null], seen: 0 };
      // Read again after its readings went: what was fitted then stands as its priors.
      const mem = this.idle.get(k);
      if (mem) {
        b.mem = mem;
        this.idle.delete(k);
      }
      this.books.set(k, b);
    }
    return b;
  }

  private touch(port: string, good: string): void {
    this.dirty.add(`${port}|${good}`);
  }

  // ── Ingest ──────────────────────────────────────────────────────────────────

  /**
   * A quay's live book for one good (guide 3.1: full depth and `npc_current_stock`): a stock reading, the NPC best on each side as
   * a curve point, the deeper NPC levels as the latest ladder's points, the NPC bid depth, sweeps of ours measured against it.
   * `shocked`: a shortage or glut was on there then.
   */
  observeQuay(port: string, good: string, at: number, stock: number, asks: LadderLevel[], bids: LadderLevel[], shocked = false): void {
    if (!finite(at) || !finite(stock) || stock < 0) return;
    const b = this.book(port, good);
    const askLv = asks.filter((l) => finite(l.price) && l.price > 0 && finite(l.qty) && l.qty > 0).sort((x, y) => x.price - y.price);
    const bidLv = bids.filter((l) => finite(l.price) && l.price > 0 && finite(l.qty) && l.qty > 0).sort((x, y) => y.price - x.price);
    const npcAskDepth = askLv.filter((l) => l.npc).reduce((n, l) => n + l.qty, 0);
    const npcBidDepth = bidLv.filter((l) => l.npc).reduce((n, l) => n + l.qty, 0);
    this.measureSweeps(b, at, npcAskDepth, npcBidDepth);
    // The ladder's points: each NPC tranche at the stock it is quoted from (the best as a top point, the rest the latest ladder's).
    // Asks: the stock less the NPC tons before it, none quoted from under half a ton. Bids: the stock plus them, at least half a
    // ton, so a sold-out port's live bids (quoted at the scarce top) still set the bid's level, as gossip's do.
    const flag = shocked ? P_SHOCKED : 0;
    const walk = (levels: LadderLevel[], dir: -1 | 1): Pt[] => {
      const out: Pt[] = [];
      let q = 0;
      for (const l of levels) {
        if (!l.npc) continue;
        if (out.length >= LADDER_LEVELS_KEPT + 1) break;
        const s = dir < 0 ? stock - q : Math.max(0.5, stock + q);
        if (s < 0.5) break;
        out.push([at, s, l.price, flag | (out.length ? P_LADDER : 0)]);
        q += l.qty;
      }
      return out;
    };
    // Just after a fill of ours, the side it didn't walk still quotes the stock from before it until the ladder re-quotes (guide
    // 3.2): not a point on the curve at today's stock, nor the level to anchor to; and bids we sold into show a depth we depleted.
    const recent = b.own.filter(([t]) => t <= at && at - t <= POST_TRADE_STEPS * this.stepMs);
    const askStale = recent.some(([, t]) => t > 0);
    const bidStale = recent.some(([, t]) => t < 0);
    const ap = askStale ? [] : walk(askLv, -1);
    const bp = bidStale ? [] : walk(bidLv, 1);
    // The latest NPC best sets the level forecasts are anchored to, even on a re-read with the stock unchanged.
    if (ap.length && at >= (b.top[1]?.[0] ?? -Infinity)) b.top[1] = [at, stock, ap[0][2]];
    if (bp.length && at >= (b.top[0]?.[0] ?? -Infinity)) b.top[0] = [at, stock, bp[0][2]];
    // A re-read with the stock as it was (a ship in port polling) adds nothing to the fits.
    if (this.addReading(b, port, good, at, stock, R_QUAY | (shocked ? R_SHOCKED : 0), 0)) {
      this.addPoints(b.ask, ap);
      this.addPoints(b.bid, bp);
      if (bidLv.some((l) => l.npc) && !recent.some(([, t]) => t > 0)) {
        b.depth.push([at, npcBidDepth]);
        if (b.depth.length > DEPTH_KEPT) b.depth.splice(0, b.depth.length - DEPTH_KEPT);
      }
    }
    if (!b.ladder || at >= b.ladder.at) {
      const lv = (l: LadderLevel): Lvl => [l.price, l.qty, l.npc ? 1 : 0];
      b.ladder = { at, stock, asks: askLv.slice(0, 24).map(lv), bids: bidLv.slice(0, 24).map(lv) };
    }
    this.touch(port, good);
  }

  /**
   * A reading of stock with the best bid and ask only (coffee-house gossip, guide 3.1), as of server ms `at`. `bid` / `ask`: the NPC
   * best, null where that side was empty or a player's level was on top (World leaves those out: they aren't the curve).
   */
  observeTop(port: string, good: string, at: number, stock: number, bid: number | null, ask: number | null, shocked = false): void {
    if (!finite(at) || !finite(stock) || stock < 0) return;
    const b = this.book(port, good);
    // Stock is the NPC ask ladder's depth (a tenth a tranche): a report a re-quote or two after a sweep of ours shows its refill.
    this.measureSweeps(b, at, stock, null);
    if (!this.addReading(b, port, good, at, stock, shocked ? R_SHOCKED : 0, GOSSIP_STOCK_SD)) return;
    const flag = shocked ? P_SHOCKED : 0;
    if (finite(bid) && bid > 0) {
      this.addPoints(b.bid, [[at, stock, bid, flag]]);
      if (at >= (b.top[0]?.[0] ?? -Infinity)) b.top[0] = [at, stock, bid];
    }
    if (finite(ask) && ask > 0) {
      this.addPoints(b.ask, [[at, stock, ask, flag]]);
      if (at >= (b.top[1]?.[0] ?? -Infinity)) b.top[1] = [at, stock, ask];
    }
    this.touch(port, good);
  }

  /**
   * One of our own fills (`side`: our order's; a bid of ours takes the NPC asks' stock, an ask of ours adds to it). With a fresh
   * ladder, the tons are walked down it in price order so a player's level we took doesn't count against the NPC stock, and a sweep
   * big enough is kept to measure the refill at the next re-quote.
   */
  noteOwnTrade(port: string, good: string, side: BookSide, tons: number, at: number): void {
    if (!finite(tons) || tons <= 0 || !finite(at)) return;
    const b = this.books.get(`${port}|${good}`);
    if (!b) return;
    const lad = b.ladder && at - b.ladder.at <= LADDER_FRESH_STEPS * this.stepMs ? b.ladder : null;
    const hit = side === "bid" ? lad?.asks : lad?.bids;
    let npc = tons;
    let depthBefore = 0;
    if (hit) {
      depthBefore = hit.reduce((n, l) => n + (l[2] ? l[1] : 0), 0);
      npc = 0;
      let left = tons;
      for (const l of hit) {
        if (left <= 0) break;
        const take = Math.min(left, l[1]);
        if (l[2]) npc += take;
        l[1] -= take;
        left -= take;
      }
      // Beyond the ladder seen (it re-quoted, or depth hidden): NPC tons.
      npc += Math.max(0, left);
      if (lad) {
        if (side === "bid") lad.asks = lad.asks.filter((l) => l[1] > 0);
        else lad.bids = lad.bids.filter((l) => l[1] > 0);
      }
    }
    if (npc <= 0) return;
    const signed = side === "bid" ? -npc : npc;
    b.own.push([at, signed]);
    if (b.own.length > OWN_KEPT) b.own.splice(0, b.own.length - OWN_KEPT);
    if (b.kf) {
      const fit = this.fitOf(port, good, b);
      const [x, p] = fit && at > b.kf[2] ? this.predict(b.kf, fit, at) : [b.kf[0], b.kf[1]];
      b.kf = [Math.max(0, x + signed), p, Math.max(at, b.kf[2])];
    }
    // A sweep big enough to read the refill from (the depth before it from the fresh ladder); one just made on the same side takes
    // this fill in. Our other fills move the depth the rest are measured from: the asks' depth is the stock (a buy lowers it, a sale
    // raises it at the re-quote), the bids' falls with what we sell into them.
    const sideIdx = side === "bid" ? 1 : 0;
    const open = b.sweeps.find((s) => s[1] === sideIdx && at - s[0] <= POST_TRADE_STEPS * this.stepMs);
    for (const s of b.sweeps) {
      if (s === open || s[0] > at) continue;
      if (s[1] === 1) s[3] = Math.max(0, s[3] + signed);
      else if (side === "ask") s[3] = Math.max(0, s[3] - npc);
    }
    if (open) {
      open[2] += npc;
      open[3] = Math.max(0, open[3] - npc);
    } else if (hit && npc >= Math.max(2, SWEEP_MIN_SHARE * depthBefore)) {
      b.sweeps.push([at, sideIdx, npc, Math.max(0, depthBefore - npc)]);
      if (b.sweeps.length > SWEEPS_KEPT) b.sweeps.splice(0, b.sweeps.length - SWEEPS_KEPT);
    }
    this.touch(port, good);
  }

  /**
   * A structural shift (guide 3.1: `production_collapse`, `production_boom`, `import_slump`) from server ms `at` at a port for a
   * good (null: every port, or every good): readings before it no longer set the stock's level or its reversion, nor the state
   * (it restarts from the latest reading since, else from the next one), and curve points before it count for less. Idempotent (the
   * latest start is kept).
   */
  structural(port: string | null, good: string | null, at: number): void {
    if (!finite(at)) return;
    const k = `${port ?? "*"}|${good ?? "*"}`;
    if ((this.shifts.get(k) ?? -Infinity) >= at) return;
    this.shifts.set(k, at);
    if (this.shifts.size > SHIFTS_KEPT) {
      const oldest = [...this.shifts].sort((x, y) => x[1] - y[1])[0];
      this.shifts.delete(oldest[0]);
    }
    for (const [key, b] of this.books) {
      const [p, g] = key.split("|");
      if ((port !== null && p !== port) || (good !== null && g !== good)) continue;
      this.dirty.add(key);
      // A later shift there already restarted it; with no reading since, addReading takes the next one as the state.
      if (!b.kf || this.shiftAt(p, g) > at) continue;
      const last = b.readings.reduce<Reading | null>((m, x) => (x[0] >= at && (!m || x[0] > m[0]) ? x : m), null);
      if (last) b.kf = this.stateFrom(b, last[0], last[1], measureVar(last[1], !(last[2] & R_QUAY)));
    }
  }

  /**
   * A live book read where an older price was remembered: the model's forecast of it (made before the book was taken in) and the old
   * rule's, against what it shows (pence). Feeds the trust the planner gives the model.
   */
  scoreForecast(side: BookSide, actual: number, oldPred: number, modelPred: number): void {
    if (!(actual > 0) || !(oldPred > 0) || !(modelPred > 0)) return;
    const s = this.score[side];
    s.n++;
    const alpha = Math.max(SCORE_ALPHA_MIN, 1 / s.n);
    s.old += alpha * (Math.abs(Math.log(oldPred / actual)) - s.old);
    s.model += alpha * (Math.abs(Math.log(modelPred / actual)) - s.model);
  }

  /** 0-1: how far the scorecard lets the model be leaned on (1 until it has enough; 0 once 25% worse than the old rule). */
  trust(side: BookSide): number {
    const s = this.score[side];
    if (s.n < SCORE_MIN_N) return 1;
    const q = (s.model + SCORE_FLOOR) / (s.old + SCORE_FLOOR);
    return clamp((SCORE_CUTOFF - q) / (SCORE_CUTOFF - 1), 0, 1);
  }

  /**
   * Adds a stock reading and runs the state's update. False (nothing added, the state left as it was): the same stock as a reading
   * held within DUPLICATE_STEPS of it (one report re-read, or passed on by two boards; a ship in port reading the book again), the
   * same news, fused once.
   */
  private addReading(b: SavedBook, port: string, good: string, at: number, stock: number, flags: number, sdShare: number): boolean {
    const gm = this.env.gameMinuteMs();
    const step = this.stepMs;
    b.seen = Math.max(b.seen, at);
    if (b.readings.some((x) => Math.abs(x[0] - at) < DUPLICATE_STEPS * step && Math.abs(x[1] - stock) < 0.5)) return false;
    // Kalman: predict the state to the reading, then update with it. A reading older than the state is for the fits only, but for
    // the first since a structural shift (nothing before it says what the stock is now): the state is taken from it alone.
    const r = measureVar(stock, sdShare > 0);
    const shiftAt = this.shiftAt(port, good);
    if (!b.kf) b.kf = [stock, r, at];
    else if (at >= shiftAt && !b.readings.some((x) => x[0] >= shiftAt)) b.kf = this.stateFrom(b, at, stock, r);
    else if (at >= b.kf[2] - gm) {
      const fit = this.fitOf(port, good, b);
      const [x, p] = fit && at > b.kf[2] ? this.predict(b.kf, fit, at) : [b.kf[0], b.kf[1]];
      const k = p / (p + r);
      b.kf = [Math.max(0, x + k * (stock - x)), (1 - k) * p, Math.max(at, b.kf[2])];
    }
    this.dirty.add(`${port}|${good}`);
    const post = b.own.some(([t]) => t <= at && at - t <= POST_TRADE_STEPS * step);
    b.readings.push([at, stock, flags | (post ? R_POST : 0)]);
    if (b.readings.length > READINGS_KEPT) {
      // The oldest by time goes (gossip arrives out of order).
      b.readings.sort((x, y) => x[0] - y[0]);
      b.readings.splice(0, b.readings.length - READINGS_KEPT);
    }
    return true;
  }

  /** The state from one reading alone (its measurement variance `r`), our fills since it applied. */
  private stateFrom(b: SavedBook, at: number, stock: number, r: number): [number, number, number] {
    let x = stock;
    let t = at;
    for (const [ta, tons] of b.own) {
      if (ta <= at) continue;
      x = Math.max(0, x + tons);
      t = Math.max(t, ta);
    }
    return [x, r, t];
  }

  /** New points on one side: a ladder's deeper levels replace the last ladder's; top points beyond the cap go, oldest first. */
  private addPoints(pts: Pt[], add: Pt[]): void {
    if (add.some((p) => p[3] & P_LADDER)) {
      for (let i = pts.length - 1; i >= 0; i--) if (pts[i][3] & P_LADDER) pts.splice(i, 1);
    }
    pts.push(...add);
    let tops = pts.filter((p) => !(p[3] & P_LADDER)).length;
    if (tops <= TOP_POINTS_KEPT) return;
    pts.sort((x, y) => x[0] - y[0]);
    for (let i = 0; i < pts.length && tops > TOP_POINTS_KEPT; ) {
      if (!(pts[i][3] & P_LADDER)) {
        pts.splice(i, 1);
        tops--;
      } else i++;
    }
  }

  /**
   * Sweeps of ours measured against a reading a re-quote or two later (a quay's NPC depth on each side; a report's stock for the asks
   * only, null for the bids): the share of what we took that came back, per step.
   */
  private measureSweeps(b: SavedBook, at: number, askDepth: number | null, bidDepth: number | null): void {
    if (b.sweeps.length === 0) return;
    const step = this.stepMs;
    b.sweeps = b.sweeps.filter(([t, side, tons, after]) => {
      const k = (at - t) / step;
      const now = side === 1 ? askDepth : bidDepth;
      if (k < SWEEP_MIN_STEPS || now === null) return k <= SWEEP_MAX_STEPS;
      if (k > SWEEP_MAX_STEPS || tons <= 0) return false;
      const rk = clamp((now - after) / tons, 0, 1.5);
      // Re-quotes since: k on average (their phase isn't known), at least one.
      const steps = Math.max(1, k);
      const r1 = rk >= 1 ? 1 : 1 - Math.pow(1 - rk, 1 / steps);
      const into = b.refill[side === 1 ? 1 : 0];
      into.push([at, r1]);
      if (into.length > REFILL_KEPT) into.splice(0, into.length - REFILL_KEPT);
      return false;
    });
  }

  // ── Fitting ─────────────────────────────────────────────────────────────────

  private shiftAt(port: string, good: string): number {
    return Math.max(this.shifts.get(`${port}|${good}`) ?? 0, this.shifts.get(`${port}|*`) ?? 0, this.shifts.get(`*|${good}`) ?? 0);
  }

  /** The book's fit, refitted when it changed or a step has passed (recency weights move). */
  private fitOf(port: string, good: string, b: SavedBook): Fit | null {
    const k = `${port}|${good}`;
    const now = this.env.now();
    const had = this.fits.get(k);
    if (had !== undefined && !this.dirty.has(k) && (had === null || now - had.at < this.stepMs)) return had;
    const fit = this.computeFit(port, good, b, now);
    this.fits.set(k, fit);
    this.dirty.delete(k);
    return fit;
  }

  /** A class's priors: each figure the median of its books' own (those with data), shrunk to the fixed prior; gathered once a minute. */
  private priorsFor(cls: string): ClassPrior {
    if (Date.now() - this.classPooledAt > CLASS_POOL_MS) {
      this.classPooledAt = Date.now();
      const by = new Map<string, Fit[]>();
      for (const f of this.fits.values()) if (f) by.set(f.cls, [...(by.get(f.cls) ?? []), f]);
      this.classPriors = new Map();
      for (const [c, fs] of by) {
        const pool = (xs: Array<number | null>, prior: number) => {
          const v = xs.filter((x): x is number => x !== null);
          return shrink(median(v), v.length, prior, CLASS_PRIOR_N);
        };
        this.classPriors.set(c, {
          theta: clamp(pool(fs.map((f) => (f.pairs >= 2 ? f.thetaData : null)), c === "bulk" ? THETA_PRIOR_BULK : THETA_PRIOR), THETA_MIN, THETA_MAX),
          sigmaRel: pool(fs.map((f) => (f.pairs >= 2 ? f.sigmaRelData : null)), SIGMA_REL_PRIOR),
          eBid: clamp(pool(fs.map((f) => (f.bid && f.bid.info >= 0.1 ? f.bid.eData : null)), E_PRIOR), E_MIN, E_MAX),
          eAsk: clamp(pool(fs.map((f) => (f.ask && f.ask.info >= 0.1 ? f.ask.eData : null)), E_PRIOR), E_MIN, E_MAX),
          rBid: clamp(pool(fs.map((f) => f.refillBidData), REFILL_PRIOR), 0, 1),
          rAsk: clamp(pool(fs.map((f) => f.refillAskData), REFILL_PRIOR), 0, 1),
        });
      }
    }
    return (
      this.classPriors.get(cls) ?? {
        theta: cls === "bulk" ? THETA_PRIOR_BULK : THETA_PRIOR,
        sigmaRel: SIGMA_REL_PRIOR,
        eBid: E_PRIOR,
        eAsk: E_PRIOR,
        rBid: REFILL_PRIOR,
        rAsk: REFILL_PRIOR,
      }
    );
  }

  private computeFit(port: string, good: string, b: SavedBook, now: number): Fit | null {
    const step = this.stepMs;
    const shiftAt = this.shiftAt(port, good);
    const cls = this.env.goodClass(good);
    const rs = b.readings.filter((r) => r[0] >= shiftAt).sort((x, y) => x[0] - y[0]);
    if (rs.length === 0) return null;
    // The book's priors: its class's, or what it had fitted before its readings went (none from before a shift there).
    const cp = this.priorsFor(cls);
    const mem = b.mem && b.mem[0] >= shiftAt ? b.mem : null;
    const pri: ClassPrior = mem
      ? { theta: mem[2], sigmaRel: mem[3], eBid: mem[4] > 0 ? mem[4] : cp.eBid, eAsk: mem[5] > 0 ? mem[5] : cp.eAsk, rBid: mem[6], rAsk: mem[7] }
      : cp;
    // μ: the recency-weighted median stock, our own dips and shocks left out (all readings if that leaves none); a remembered μ
    // counts as its readings did, aged alike.
    const muHl = this.gameDaysMs(MU_HALF_LIFE_GAME_DAYS);
    const plain = rs.filter((r) => !(r[2] & (R_POST | R_SHOCKED)));
    const muPts = (plain.length ? plain : rs).map((r): [number, number] => [r[1], Math.pow(0.5, Math.max(0, now - r[0]) / muHl)]);
    if (mem) muPts.push([mem[1], Math.min(mem[8], CONF_FULL_READINGS) * Math.pow(0.5, Math.max(0, now - mem[0]) / muHl)]);
    const mu = Math.max(1, wmedian(muPts) ?? 1);
    const floor = Math.max(1, 0.02 * mu);
    // Pairs: each reading with the first one at least PAIR_MIN_STEPS later.
    const pairs: Array<{ d1: number; d2: number; k: number }> = [];
    for (let i = 0; i < rs.length; i++) {
      const [t1, s1, f1] = rs[i];
      const j = rs.findIndex((r, n) => n > i && r[0] - t1 >= PAIR_MIN_STEPS * step);
      if (j < 0) continue;
      const [t2, s2, f2] = rs[j];
      const k = (t2 - t1) / step;
      if (k > PAIR_MAX_STEPS || (f1 | f2) & R_SHOCKED) continue;
      let adj = 0;
      let late = false;
      for (const [ta, tons] of b.own) {
        if (ta <= t1 || ta > t2) continue;
        if (ta - t1 > PAIR_TRADE_SLACK_STEPS * step) late = true;
        else adj += tons;
      }
      if (!late) pairs.push({ d1: Math.max(0, s1 + adj) - mu, d2: s2 - mu, k });
    }
    const th: Array<[number, number]> = [];
    for (const p of pairs) {
      if (Math.abs(p.d1) < Math.max(THETA_MIN_DEV * mu, 2)) continue;
      const r = clamp(p.d2 / p.d1, 0.01, 1.2);
      th.push([clamp(1 - Math.pow(r, 1 / p.k), 0, 1), Math.min(2, Math.abs(p.d1) / mu) * Math.min(1, p.k)]);
    }
    const thetaData = th.length ? wmedian(th) : null;
    const theta = clamp(shrink(thetaData, th.length, pri.theta, BOOK_PRIOR_N), THETA_MIN, THETA_MAX);
    const rho = 1 - theta;
    // σ per step from the pairs' residuals (robust: median of squares over its χ²₁ median).
    const vs = pairs.map((p) => {
      const rk = Math.pow(rho, p.k);
      const e = p.d2 - rk * p.d1;
      const denom = rho < 0.999 ? (1 - rk * rk) / (1 - rho * rho) : p.k;
      return (e * e) / Math.max(denom, 1e-6);
    });
    const s2Data = vs.length ? (median(vs) ?? 0) / 0.455 : null;
    const s2 = shrink(s2Data, vs.length, (pri.sigmaRel * mu) ** 2, BOOK_PRIOR_N);
    const sigma = Math.max(Math.sqrt(s2), 0.01 * mu + 0.5);
    // Curves.
    const base = this.env.basePrice(good);
    const curveHl = this.gameDaysMs(CURVE_HALF_LIFE_GAME_DAYS);
    const side = (pts: Pt[], e0: number): SideFit | null => {
      const use = pts.filter((p) => p[2] > 0 && now - p[0] <= this.gameDaysMs(BOOK_IDLE_GAME_DAYS));
      if (!use.some((p) => p[0] >= shiftAt)) return null;
      const xs = use.map((p) => Math.log(Math.max(p[1], floor)));
      const ys = use.map((p) => Math.log(p[2]));
      const ws = use.map(
        (p) =>
          (p[3] & P_LADDER ? LADDER_WEIGHT : 1) *
          Math.pow(0.5, Math.max(0, now - p[0]) / curveHl) *
          (p[0] < shiftAt ? SHIFTED_WEIGHT : 1) *
          (p[3] & P_SHOCKED ? SHOCKED_WEIGHT : 1),
      );
      const f = fitCurve(xs, ys, ws, e0);
      if (!f) return null;
      const seenLo = Math.min(...use.map((p) => p[2]));
      const seenHi = Math.max(...use.map((p) => p[2]));
      return {
        a: f.a,
        e: f.e,
        n: use.length,
        rsd: f.rsd,
        lo: base > 0 ? Math.min(base * PRICE_LO_OF_BASE, seenLo * 0.8) : seenLo * 0.5,
        hi: base > 0 ? Math.max(base * PRICE_HI_OF_BASE, seenHi * 1.25) : seenHi * 2,
        eData: f.eData,
        info: f.info,
      };
    };
    // Distinct readings: those at least DISTINCT_STEPS apart count apart.
    let distinct = 0;
    let last = -Infinity;
    for (const r of rs) {
      if (r[0] - last < DISTINCT_STEPS * step) continue;
      distinct++;
      last = r[0];
    }
    const refill = (xs: Array<[number, number]>, prior: number) => {
      const d = median(xs.map(([, r]) => r));
      return { r: clamp(shrink(d, xs.length, prior, REFILL_PRIOR_N), 0, 1), data: d };
    };
    const rb = refill(b.refill[0], pri.rBid);
    const ra = refill(b.refill[1], pri.rAsk);
    return {
      at: now,
      cls,
      shiftAt,
      bid: side(b.bid, pri.eBid),
      ask: side(b.ask, pri.eAsk),
      mu,
      theta,
      sigma,
      thetaData,
      pairs: th.length,
      sigmaRelData: s2Data === null ? null : Math.sqrt(s2Data) / mu,
      readings: distinct,
      conf: clamp((distinct - 1) / CONF_FULL_READINGS, 0, 1),
      refillBid: rb.r,
      refillAsk: ra.r,
      refillBidData: rb.data,
      refillAskData: ra.data,
      sweeps: b.refill[0].length + b.refill[1].length,
      floor,
    };
  }

  /** The state predicted to server ms `at`: mean and variance after k steps (k fractional; none backwards). */
  private predict(kf: [number, number, number], fit: Fit, at: number): [number, number] {
    const k = Math.max(0, (at - kf[2]) / this.stepMs);
    const rho = 1 - fit.theta;
    const rk = Math.pow(rho, k);
    const m = fit.mu + rk * (kf[0] - fit.mu);
    const v = rk * rk * kf[1] + fit.sigma ** 2 * (rho < 0.999 ? (1 - rk * rk) / (1 - rho * rho) : k);
    return [Math.max(0, m), v];
  }

  // ── Forecasts ───────────────────────────────────────────────────────────────

  /**
   * One side of a book at server ms `at`, or null with nothing to go on (no reading, none in MAX_AGE_GAME_H, none since a structural
   * shift, no point on that side). `anchor`: a price seen on that side after the model's own latest (a counting house's live top,
   * a storage snapshot; World passes it), which sets the level instead. Raw: `conf` is the data's times the scorecard's trust, and
   * may be 0 (World.marketView leaves those out).
   */
  view(port: string, good: string, side: BookSide, at: number, anchor?: { price: number; at: number } | null): MarketView | null {
    const b = this.books.get(`${port}|${good}`);
    if (!b?.kf) return null;
    const now = this.env.now();
    const gm = this.env.gameMinuteMs();
    if (now - b.seen > MAX_AGE_GAME_H * 60 * gm) return null;
    const fit = this.fitOf(port, good, b);
    const sf = fit?.[side];
    if (!fit || !sf || b.seen < fit.shiftAt) return null;
    const [m, v] = this.predict(b.kf, fit, at);
    const floor = fit.floor;
    // The level: from the latest NPC top seen on this side (the curve's shape carries it to other stock), else the curve's own.
    const top = b.top[side === "bid" ? 0 : 1];
    const topOk = top && top[0] >= fit.shiftAt && now - top[0] <= MAX_AGE_GAME_H * 60 * gm ? top : null;
    let lvl: { price: number; stock: number } | null = topOk ? { price: topOk[2], stock: topOk[1] } : null;
    // Only a price from a look the model didn't get (no stock: a counting house, a storage snapshot), an hour or more newer than its
    // own latest reading: a report it did get but left out of the curve (a player's level on top) never sets the NPC level.
    if (anchor && finite(anchor.price) && anchor.price > 0 && anchor.at > Math.max(topOk?.[0] ?? -Infinity, b.seen) + 60 * gm) {
      lvl = { price: anchor.price, stock: this.predict(b.kf, fit, anchor.at)[0] };
    }
    const a = lvl ? Math.log(lvl.price) + sf.e * Math.log(Math.max(lvl.stock, floor)) : sf.a;
    const P = (s: number) => clamp(Math.exp(a - sf.e * Math.log(Math.max(s, floor))), sf.lo, sf.hi);
    const dir = side === "ask" ? -1 : 1;
    const price = P(m);
    const stockSd = Math.sqrt(Math.max(0, v));
    // Stock uncertainty through the curve's slope, plus the curve's own misfit (scaled by how far the shape carries the anchor).
    const slope = (sf.e * price) / Math.max(m, floor);
    const carry = lvl ? Math.min(1, Math.abs(Math.log(Math.max(m, floor) / Math.max(lvl.stock, floor)))) : 1;
    const sd = Math.sqrt((slope * stockSd) ** 2 + (price * sf.rsd) ** 2 * carry);
    // A tranche is priced at the stock it starts from, so the u-th ton's price is the curve half a tranche short of u (an ask tranche
    // is a tenth of the stock; a bid tranche as the last ladder showed them), never better than the best level. Worked out only
    // when a price beyond the best is asked for (the planner reads most views for their best alone).
    const ladBids = side === "bid" ? b.ladder?.bids : undefined;
    let half: number | undefined = side === "ask" ? 0.05 * m : ladBids?.length ? undefined : 0;
    const halfTranche = () => (half ??= (median(ladBids!.filter((l) => l[2]).map((l) => l[1])) ?? 0) / 2);
    const at_ = (u: number) => P(m + dir * Math.max(0, u - halfTranche()));
    const avg = (tons: number, after = 0) => {
      const u0 = Math.max(0, after);
      if (!(tons > 0)) return at_(u0);
      // Simpson's rule over the tons walked.
      const h = tons / 8;
      let sum = 0;
      for (let i = 0; i <= 8; i++) sum += (i === 0 || i === 8 ? 1 : i % 2 ? 4 : 2) * at_(u0 + h * i);
      return sum / 24;
    };
    const marginal = (n: number, after = 0) => at_(Math.max(0, after) + Math.max(0, n));
    // NPC bid depth: the last quay's less what we sold into it since, refilling towards its usual level each re-quote (worked out
    // when read).
    const depths = side === "bid" && b.depth.length ? b.depth : null;
    const own = b.own;
    const stepMs = this.stepMs;
    let depth: number | null | undefined = depths ? undefined : null;
    const depthOf = (): number | null => {
      if (depth !== undefined) return depth;
      const [lastAt, lastTons] = depths![depths!.length - 1];
      const usual = median(depths!.map(([, t]) => t)) ?? lastTons;
      const sold = own.filter(([t, tons]) => t > lastAt && tons > 0).reduce((n, [, tons]) => n + tons, 0);
      const left = Math.max(0, lastTons - sold);
      const k = Math.max(0, (at - lastAt) / stepMs);
      return (depth = Math.max(0, usual - (usual - left) * Math.pow(1 - fit.refillBid, k)));
    };
    return {
      seenAt: b.seen,
      steps: Math.max(0, (at - b.kf[2]) / this.stepMs),
      stock: m,
      stockSd,
      price,
      sd,
      conf: fit.conf * this.trust(side),
      data: fit.conf,
      avg,
      marginal,
      get depth() {
        return depthOf();
      },
    };
  }

  /** The expected price and its sd for one side at `at`, `after` tons taken by others first (null: no model there). Raw (no gates). */
  forecast(port: string, good: string, side: BookSide, at: number, after = 0): { price: number; sd: number; conf: number } | null {
    const v = this.view(port, good, side, at);
    if (!v) return null;
    return { price: after > 0 ? v.marginal(0, after) : v.price, sd: v.sd, conf: v.conf };
  }

  /** The price of the `tons`-th ton bought (asks) or sold (bids) at `at`, after `after` tons taken by others first (null: no model). Raw. */
  marginal(port: string, good: string, side: BookSide, tons: number, at: number, after = 0): number | null {
    return this.view(port, good, side, at)?.marginal(tons, after) ?? null;
  }

  /** Stock expected at `at` and its sd (null: no reading). Raw. */
  stockAt(port: string, good: string, at: number): { stock: number; sd: number; mu: number } | null {
    const b = this.books.get(`${port}|${good}`);
    if (!b?.kf) return null;
    const fit = this.fitOf(port, good, b);
    if (!fit) return null;
    const [m, v] = this.predict(b.kf, fit, at);
    return { stock: m, sd: Math.sqrt(Math.max(0, v)), mu: fit.mu };
  }

  /**
   * Share of a swept side's NPC depth refilled per re-quote (the book's, shrunk to its class's; an idle book's as fitted before its
   * readings went), and the sweeps measured there (0 for the latter two).
   */
  refill(port: string, good: string, side: BookSide): { r: number; n: number } {
    const b = this.books.get(`${port}|${good}`);
    const fit = b ? this.fitOf(port, good, b) : null;
    if (fit) return side === "bid" ? { r: fit.refillBid, n: b!.refill[0].length } : { r: fit.refillAsk, n: b!.refill[1].length };
    const mem = this.memOf(port, good);
    if (mem) return { r: side === "bid" ? mem[6] : mem[7], n: 0 };
    const pri = this.priorsFor(this.env.goodClass(good));
    return { r: side === "bid" ? pri.rBid : pri.rAsk, n: 0 };
  }

  /** Stock half-life (game hours), reversion per step and long-run stock at a book (an idle one's as fitted before; null: none). */
  reversion(port: string, good: string): { theta: number; halfLifeH: number; mu: number } | null {
    const b = this.books.get(`${port}|${good}`);
    const fit = b ? this.fitOf(port, good, b) : null;
    if (fit) return { theta: fit.theta, halfLifeH: this.halfLifeH(fit.theta), mu: fit.mu };
    const mem = this.memOf(port, good);
    return mem ? { theta: mem[2], halfLifeH: this.halfLifeH(mem[2]), mu: mem[1] } : null;
  }

  /** An idle book's fitted figures (or a re-read one's, before it has a fit), unless a structural shift there postdates them. */
  private memOf(port: string, good: string): Mem | null {
    const k = `${port}|${good}`;
    const mem = this.idle.get(k) ?? this.books.get(k)?.mem;
    return mem && mem[0] >= this.shiftAt(port, good) ? mem : null;
  }

  private halfLifeH(theta: number): number {
    return (REQUOTE_GAME_MIN / 60) * (-Math.LN2 / Math.log(1 - clamp(theta, 1e-6, 0.999999)));
  }

  // ── Summary and persistence ─────────────────────────────────────────────────

  /** Coverage and calibration over the books kept in full (read on every state read: no pruning here). */
  summary(rows = 24): MarketModelSummary {
    const now = this.env.now();
    const out: MarketBookRow[] = [];
    let modelled = 0;
    let confident = 0;
    const hl: number[] = [];
    const hlBulk: number[] = [];
    const eb: number[] = [];
    const ea: number[] = [];
    const rb: number[] = [];
    const ra: number[] = [];
    let sweeps = 0;
    for (const [k, b] of this.books) {
      const [port, good] = k.split("|");
      const fit = this.fitOf(port, good, b);
      if (!fit || !b.kf) continue;
      const fresh = now - b.seen <= MAX_AGE_GAME_H * 60 * this.env.gameMinuteMs();
      const conf = fresh ? fit.conf : 0;
      if (conf > 0) {
        modelled++;
        if (conf >= 0.6) confident++;
        (fit.cls === "bulk" ? hlBulk : hl).push(this.halfLifeH(fit.theta));
      }
      if (fit.bid) eb.push(fit.bid.e);
      if (fit.ask) ea.push(fit.ask.e);
      if (fit.refillBidData !== null) rb.push(fit.refillBidData);
      if (fit.refillAskData !== null) ra.push(fit.refillAskData);
      sweeps += fit.sweeps;
      out.push({
        port,
        good,
        seenAt: b.seen,
        stock: Math.round(this.predict(b.kf, fit, now)[0]),
        mu: Math.round(fit.mu),
        halfLifeH: Math.round(this.halfLifeH(fit.theta) * 10) / 10,
        eBid: fit.bid ? Math.round(fit.bid.e * 100) / 100 : null,
        eAsk: fit.ask ? Math.round(fit.ask.e * 100) / 100 : null,
        refillAsk: Math.round(fit.refillAsk * 100) / 100,
        refillBid: Math.round(fit.refillBid * 100) / 100,
        sweeps: fit.sweeps,
        readings: fit.readings,
        conf: Math.round(conf * 100) / 100,
      });
    }
    const all = [...hl, ...hlBulk];
    const r2 = (x: number | null, d = 100) => (x === null ? null : Math.round(x * d) / d);
    const sc = (s: BookSide) => ({ n: this.score[s].n, oldErr: r2(this.score[s].old, 10_000)!, modelErr: r2(this.score[s].model, 10_000)!, trust: r2(this.trust(s))! });
    return {
      books: this.books.size,
      modelled,
      confident,
      halfLifeH: r2(median(all), 10),
      bulkHalfLifeH: r2(median(hlBulk), 10),
      eBid: r2(median(eb)),
      eAsk: r2(median(ea)),
      refillAsk: r2(median(ra)),
      refillBid: r2(median(rb)),
      sweeps,
      score: { bid: sc("bid"), ask: sc("ask") },
      rows: out.sort((x, y) => y.seenAt - x.seenAt).slice(0, rows),
    };
  }

  /**
   * Books unread for BOOK_IDLE_GAME_DAYS, then the least recently read beyond BOOKS_KEPT, keep only their fitted figures (compact);
   * never one with a fill of ours lately or a sweep awaiting its re-quote. Fitted figures go once stale, shifted or beyond MEMORY_KEPT.
   */
  private prune(): void {
    const now = this.env.now();
    this.prunedAt = now;
    const idle = this.gameDaysMs(BOOK_IDLE_GAME_DAYS);
    const sweepMs = SWEEP_MAX_STEPS * this.stepMs;
    const busy = (b: SavedBook) => b.own.some(([t]) => now - t <= idle) || b.sweeps.some(([t]) => now - t <= sweepMs);
    for (const [k, b] of this.books) if (now - b.seen > idle && !busy(b)) this.compact(k, b);
    if (this.books.size > BOOKS_KEPT) {
      const order = [...this.books].filter(([, b]) => !busy(b)).sort((x, y) => x[1].seen - y[1].seen);
      for (const [k, b] of order.slice(0, this.books.size - BOOKS_KEPT)) this.compact(k, b);
    }
    const memMs = this.gameDaysMs(MEMORY_GAME_DAYS);
    for (const [k, m] of this.idle) {
      const [port, good] = k.split("|");
      if (now - m[0] > memMs || m[0] < this.shiftAt(port, good)) this.idle.delete(k);
    }
    if (this.idle.size > MEMORY_KEPT) {
      const order = [...this.idle].sort((x, y) => x[1][0] - y[1][0]);
      for (const [k] of order.slice(0, this.idle.size - MEMORY_KEPT)) this.idle.delete(k);
    }
  }

  /** A book's readings and points go; what was fitted from them as of its latest reading stays (its priors if it is read again). */
  private compact(k: string, b: SavedBook): void {
    const [port, good] = k.split("|");
    this.books.delete(k);
    this.fits.delete(k);
    this.dirty.delete(k);
    // Fitted as of its latest reading (its curve points still in the window then); none since a shift: nothing worth keeping.
    const fit = b.seen > 0 ? this.computeFit(port, good, b, b.seen) : null;
    if (!fit) return;
    const mem = b.mem && b.mem[0] >= fit.shiftAt ? b.mem : null;
    const r = (x: number) => Math.round(x * 1000) / 1000;
    this.idle.set(k, [
      Math.round(b.seen),
      r(fit.mu),
      r(fit.theta),
      r(fit.sigma / fit.mu),
      r(fit.bid?.e ?? mem?.[4] ?? 0),
      r(fit.ask?.e ?? mem?.[5] ?? 0),
      r(fit.refillBid),
      r(fit.refillAsk),
      fit.readings,
    ]);
  }

  /**
   * The state to save (pruned first). Lean: curve points older than any fit of the book can use (the window back from its latest
   * reading) and empty parts are left out (restore takes a missing part as empty).
   */
  snapshot(): MarketSnapshot {
    this.prune();
    const r = (x: number, d = 10) => Math.round(x * d) / d;
    const now = this.env.now();
    const window = this.gameDaysMs(BOOK_IDLE_GAME_DAYS);
    // A ladder is kept only while a fill could still be walked down it (a re-quote later it says nothing).
    const fresh = (at: number) => now - at <= this.stepMs;
    const save = (b: SavedBook): Partial<SavedBook> => {
      const pts = (xs: Pt[]): Pt[] => xs.filter((p) => b.seen - p[0] <= window).map(([at, s, p, f]) => [Math.round(at), r(s), Math.round(p), f]);
      const pairs = (xs: Array<[number, number]>, d = 10) => xs.map(([at, x]): [number, number] => [Math.round(at), r(x, d)]);
      const top = (t: [number, number, number] | null): [number, number, number] | null => (t ? [Math.round(t[0]), r(t[1]), Math.round(t[2])] : null);
      const out: Partial<SavedBook> = {
        bid: pts(b.bid),
        ask: pts(b.ask),
        readings: b.readings.map(([at, s, f]): Reading => [Math.round(at), r(s), f]),
        own: pairs(b.own),
        depth: pairs(b.depth),
        sweeps: b.sweeps.map(([at, s, t, d]): [number, number, number, number] => [Math.round(at), s, r(t), r(d)]),
        refill: [pairs(b.refill[0], 1000), pairs(b.refill[1], 1000)],
        top: [top(b.top[0]), top(b.top[1])],
        seen: b.seen,
      };
      if (b.ladder && fresh(b.ladder.at)) {
        const lv = (l: Lvl): Lvl => [l[0], r(l[1]), l[2]];
        out.ladder = { at: b.ladder.at, stock: r(b.ladder.stock), asks: b.ladder.asks.map(lv), bids: b.ladder.bids.map(lv) };
      }
      // The variance to 0.001 t²: a quay's (0.01 t²) rounded to 0 would make the state ignore the next reading at its own time.
      if (b.kf) out.kf = [r(b.kf[0]), r(b.kf[1], 1000), Math.round(b.kf[2])];
      if (b.mem) out.mem = b.mem;
      for (const f of ["bid", "ask", "own", "depth", "sweeps"] as const) if (out[f]!.length === 0) delete out[f];
      if (b.refill[0].length + b.refill[1].length === 0) delete out.refill;
      if (!b.top[0] && !b.top[1]) delete out.top;
      return out;
    };
    return {
      v: 1,
      books: [...this.books].map(([k, b]): [string, Partial<SavedBook>] => [k, save(b)]),
      shifts: [...this.shifts],
      score: { bid: { ...this.score.bid }, ask: { ...this.score.ask } },
      idle: [...this.idle],
    };
  }

  /** Picks up a snapshot (any malformed part is dropped, never trusted). */
  restore(s: MarketSnapshot | undefined | null): void {
    if (!s || s.v !== 1) return;
    const arr = <T>(x: unknown, ok: (y: unknown) => y is T): T[] => (Array.isArray(x) ? x.filter(ok) : []);
    const tuple = (n: number) => (y: unknown): y is number[] => Array.isArray(y) && y.length === n && y.every(finite);
    const pt = tuple(4) as (y: unknown) => y is Pt;
    const pair = tuple(2) as (y: unknown) => y is [number, number];
    const triple = tuple(3) as (y: unknown) => y is [number, number, number];
    const quad = tuple(4) as (y: unknown) => y is [number, number, number, number];
    const share = (x: number) => x >= 0 && x <= 1;
    const memOk = (y: unknown): y is Mem => tuple(9)(y) && y[1] >= 1 && y[2] > 0 && y[2] < 1 && y[3] >= 0 && y[4] >= 0 && y[5] >= 0 && share(y[6]) && share(y[7]) && y[8] >= 0;
    for (const e of Array.isArray(s.books) ? s.books : []) {
      if (!Array.isArray(e) || typeof e[0] !== "string" || !e[0].includes("|") || !e[1] || typeof e[1] !== "object") continue;
      const x = e[1] as Partial<SavedBook>;
      const lad = x.ladder;
      const ladder =
        lad && finite(lad.at) && finite(lad.stock) ? { at: lad.at, stock: lad.stock, asks: arr(lad.asks, triple) as Lvl[], bids: arr(lad.bids, triple) as Lvl[] } : null;
      const refill: unknown[] = Array.isArray(x.refill) ? x.refill : [];
      const top: unknown[] = Array.isArray(x.top) ? x.top : [];
      const topBid = top[0];
      const topAsk = top[1];
      const kf = x.kf;
      const readings = arr(x.readings, triple) as Reading[];
      this.books.set(e[0], {
        bid: arr(x.bid, pt).slice(-(TOP_POINTS_KEPT + LADDER_LEVELS_KEPT + 1)),
        ask: arr(x.ask, pt).slice(-(TOP_POINTS_KEPT + LADDER_LEVELS_KEPT + 1)),
        readings: readings.slice(-READINGS_KEPT),
        own: arr(x.own, pair).slice(-OWN_KEPT),
        ladder,
        depth: arr(x.depth, pair).slice(-DEPTH_KEPT),
        kf: triple(kf) && kf[0] >= 0 && kf[1] >= 0 ? [kf[0], kf[1], kf[2]] : null,
        sweeps: arr(x.sweeps, quad).slice(-SWEEPS_KEPT),
        refill: [arr(refill[0], pair).slice(-REFILL_KEPT), arr(refill[1], pair).slice(-REFILL_KEPT)],
        top: [triple(topBid) ? topBid : null, triple(topAsk) ? topAsk : null],
        seen: finite(x.seen) ? x.seen : Math.max(0, ...readings.map((r) => r[0])),
        ...(memOk(x.mem) ? { mem: x.mem } : {}),
      });
    }
    for (const e of Array.isArray(s.idle) ? s.idle : []) {
      if (Array.isArray(e) && typeof e[0] === "string" && e[0].includes("|") && memOk(e[1]) && !this.books.has(e[0])) this.idle.set(e[0], e[1]);
    }
    for (const e of Array.isArray(s.shifts) ? s.shifts : []) if (Array.isArray(e) && typeof e[0] === "string" && finite(e[1])) this.shifts.set(e[0], e[1]);
    for (const side of ["bid", "ask"] as const) {
      const sc = s.score?.[side];
      if (sc && finite(sc.n) && finite(sc.old) && finite(sc.model) && sc.n >= 0) this.score[side] = { n: sc.n, old: sc.old, model: sc.model };
    }
    this.fits.clear();
    this.dirty.clear();
  }
}
