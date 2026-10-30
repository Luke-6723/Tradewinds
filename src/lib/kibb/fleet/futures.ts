/**
 * Hub futures (the futures setting, OFF by default; guide 3.16). Pure logic, no calls.
 *
 * The game's terms: hub-only physical futures. `future/create {port_id, commodity_id, side, lot_tons, strike_price_pence,
 * matures_in_game_hours}` (strike within ±25% of the hub's NPC mid, maturity 1-1440 game hours) escrows a 25% margin from each side;
 * `future/accept {futures_id}` takes the other side; at maturity it settles from the parties' hub warehouses (the seller's goods to the
 * buyer, the strike to the seller). A defaulter forfeits its margin plus the adverse move, and what it can't pay is a claim on its record.
 * The Goldsmiths' futures desk takes the other side of a player's listing at its region's hubs once it is an hour old, but only when the
 * strike is well in the desk's favour against the mid (it buys forward well under the mid, sells forward well over it). There is no cancel.
 *
 * Three cases, each only where the market model's forecast distribution at maturity gives an expected value that beats the margin's
 * cost by a wide edge, sized at a quarter of Kelly (log utility, the payoff a ton taken as normal: n* = B·μ/σ², so n ≤ ¼·B·μ/σ²):
 *
 *   - Accept a listing that sells forward (we buy at K): μ = the hub's bid expected at maturity (the curve's average over the lot, less
 *     the rent until it sells) − K; σ = its forecast sd. The goods land in our hub warehouse at maturity (space leased for them) and are
 *     sold there through the resting machinery as landed goods.
 *   - Accept a listing that buys forward (we sell at K), cash and carry: the lot is bought now from the hub's asks into our warehouse
 *     (customs in) and held for delivery, so the price risk is gone and only the edge K − cost − rent − capital is weighed (no Kelly
 *     needed: the counterparty's margin covers its default; ours can't happen while the goods are held).
 *   - Post a forward buy (we bid) at a strike that gives the desk its edge (FUT_DESK_EDGE over the mid), when the forecast at maturity still
 *     clears it by the wide edge (a market the model expects to revert upward). Never a naked forward sale.
 *
 * Never in the season's endgame (nothing matures past its start), never on contraband or provisions, only at hubs where we have presence
 * (the warehouse settles it), within `futuresBudgetPence` (strikes of our forward buys, goods held for our forward sales, margins).
 * Hedging a hub-bound cargo is not done: delivery needs the cargo in the hub warehouse at maturity, which a ship's arrival can't promise
 * (storms, convoys, berth queues), and the desk's strike is well under the mid, so the variance it takes off a cargo the Kelly cap already
 * allows is worth less than its cost.
 */

/** Maturities weighed (game hours from now): soon enough for the forecast, never past the season's normal days. */
export const FUT_MIN_MATURITY_GAME_H = 6;
export const FUT_MAX_MATURITY_GAME_H = 72;
/** Our own listings mature this far out (game hours): the desk takes within a couple of hours, the forecast is still sharp. */
export const FUT_POST_MATURITY_GAME_H = 30;
/** Each side's margin (guide 3.16): a share of the lot's value at the strike. */
export const FUT_MARGIN_SHARE = 0.25;
/** The strike must stay within this share of the hub's NPC mid (the game's ±25%, a margin for the mid moving). */
export const FUT_STRIKE_BAND = 0.23;
/** A posted forward buy's strike over the mid: the desk's edge (it sells forward only well over the mid). */
export const FUT_DESK_EDGE = 0.1;
/** The forecast case: expected value a ton at least this share of the strike and this many forecast sds; quarter Kelly. */
export const FUT_MIN_EDGE = 0.08;
export const FUT_MIN_Z = 0.5;
export const FUT_KELLY_SHARE = 0.25;
/** Cash and carry: the least edge a ton (a share of the strike). */
export const FUT_CARRY_MIN_EDGE = 0.03;
/** The least expected gain of a contract (pence), and how many times the margin's capital cost it must beat. */
export const FUT_MIN_GAIN_PENCE = 30_000;
export const FUT_EDGE_X = 3;
/** Lots (tons) we post at most; ours live at once. */
export const FUT_MAX_LOT = 30;
export const FUT_MAX_OPEN = 3;
/** A forward sale's goods are bought up to the strike (customs in); in the last game hours before maturity up to this multiple of it. */
export const FUT_COVER_LATE_X = 1.2;
export const FUT_COVER_LATE_GAME_H = 3;
/**
 * A forward buy's whole strike is raised in the hub's region from this many game hours before maturity (every pass, so cash a load took
 * meanwhile is brought back; the pass runs every 3 game hours, so several passes land inside it), and from acceptance until it settles
 * it is kept out of every other spend (futureStrikeOwed).
 */
export const FUT_RAISE_GAME_H = 12;
/** A call with no answer is looked for among ours this long (real ms), then taken as not made. */
export const FUT_PENDING_MS = 10 * 60_000;
/** The pass's clock (real ms). */
export const FUTURES_CHECK_MS = 3 * 60_000;
/** Records kept for the report. */
export const FUTURES_KEPT = 20;

/** The strike band around the mid (pence). */
export function strikeOk(strike: number, mid: number): boolean {
  return mid > 0 && strike >= mid * (1 - FUT_STRIKE_BAND) && strike <= mid * (1 + FUT_STRIKE_BAND);
}

export interface FutureCase {
  /** Expected value a ton and in all (pence), its z on the forecast sd, the quarter-Kelly tons (Infinity: no spread). */
  perTon: number;
  ev: number;
  z: number;
  kellyTons: number;
}

/**
 * Buying forward `lot` tons at `strike`: `sale` the bid a ton expected at maturity (the curve's average over the lot), `sd` its forecast
 * sd, `rentPerTon` the rent a ton until sold, `marginCost` the capital charge on our margin until maturity (pence), `bankroll` the Kelly
 * view's (pence). Null: it doesn't clear the gate.
 */
export function longCase(x: { strike: number; lot: number; sale: number; sd: number; rentPerTon: number; marginCost: number; bankroll: number; minMargin: number }): FutureCase | null {
  const q = x.lot;
  if (!(q > 0) || !(x.strike > 0) || !(x.sale > 0)) return null;
  const perTon = x.sale - x.strike - Math.max(0, x.rentPerTon);
  const ev = perTon * q - Math.max(0, x.marginCost);
  const sd = Math.max(1, x.sd);
  const z = perTon / sd;
  if (perTon < Math.max(x.minMargin, FUT_MIN_EDGE * x.strike) || z < FUT_MIN_Z) return null;
  if (ev < Math.max(FUT_MIN_GAIN_PENCE, FUT_EDGE_X * Math.max(0, x.marginCost))) return null;
  const kellyTons = x.bankroll > 0 ? (FUT_KELLY_SHARE * x.bankroll * perTon) / (sd * sd) : 0;
  if (kellyTons < q) return null;
  return { perTon: Math.round(perTon), ev: Math.round(ev), z, kellyTons };
}

/**
 * Selling forward `lot` tons at `strike`, covered now: `cost` a ton bought from the hub's asks now (customs in), `rentPerTon` until
 * maturity, `capitalCost` the charge on the goods' cost and our margin until maturity (pence). Null: it doesn't clear the gate.
 */
export function carryCase(x: { strike: number; lot: number; cost: number; rentPerTon: number; capitalCost: number; minMargin: number }): FutureCase | null {
  const q = x.lot;
  if (!(q > 0) || !(x.strike > 0) || !(x.cost > 0)) return null;
  const perTon = x.strike - x.cost - Math.max(0, x.rentPerTon);
  const ev = perTon * q - Math.max(0, x.capitalCost);
  if (perTon < Math.max(x.minMargin, FUT_CARRY_MIN_EDGE * x.strike)) return null;
  if (ev < Math.max(FUT_MIN_GAIN_PENCE, FUT_EDGE_X * Math.max(0, x.capitalCost))) return null;
  return { perTon: Math.round(perTon), ev: Math.round(ev), z: Infinity, kellyTons: Infinity };
}

/** The strike a forward buy of ours is posted at: the desk's edge over the mid, inside the band. */
export function postStrike(mid: number): number {
  return Math.round(Math.min(mid * (1 + FUT_STRIKE_BAND), mid * (1 + FUT_DESK_EDGE)));
}

/**
 * One futures contract of ours. Times server ms. `role`: long (we buy at maturity) or short (we deliver, the goods held). `how`: accepted
 * (another's listing) or posted (ours). `status`: `sending` (a create or accept with no answer), `open` (our listing, untaken), `active`
 * (both sides in), `settled`, `defaulted` (the other side defaulted: its margin and the adverse move ours), `lapsed` (our listing untaken
 * at maturity: margin back), `failed` (refused, or not found after a call with no answer).
 */
export interface FutureRec {
  id: string | null;
  port: string;
  good: string;
  role: "long" | "short";
  how: "accepted" | "posted";
  lot: number;
  strike: number;
  margin: number;
  maturesAt: number;
  /** Short: tons bought and held for delivery, and their cost a ton (customs in). */
  held?: number;
  cost?: number;
  /** The case when taken: expected value (pence), z on the forecast. */
  ev: number;
  z: number;
  status: "sending" | "open" | "active" | "settled" | "defaulted" | "lapsed" | "failed";
  at: number;
  /** Settled: whether the goods (long) or the strike (short) were booked. */
  booked?: boolean;
  /** Set once our side may have defaulted (no goods or cash at maturity): logged once. */
  warned?: boolean;
  doneAt?: number;
  why?: string;
}

export const futureLive = (r: FutureRec) => r.status === "sending" || r.status === "open" || r.status === "active";

/** What a live contract of ours ties up against the budget (pence): a forward buy's strike, a forward sale's goods held and its margin. */
export function futureExposure(r: FutureRec): number {
  if (!futureLive(r)) return 0;
  if (r.role === "long") return Math.round(r.lot * r.strike);
  return Math.round(r.margin + (r.held ?? 0) * (r.cost ?? r.strike));
}

/**
 * Warehouse room a live contract of ours still needs at its hub (tons; the game reserves none): a forward buy's whole lot (it lands at
 * maturity), a forward sale's cover not yet bought (lot less what is held; the goods held fill their own room).
 */
export function futureSpace(r: FutureRec): number {
  if (!futureLive(r)) return 0;
  return r.role === "long" ? r.lot : Math.max(0, r.lot - (r.held ?? 0));
}

/** Cash a live forward buy of ours will take at settlement (pence): its whole strike, until it settles (a forward sale owes none). */
export function futureStrikeOwed(r: FutureRec): number {
  return futureLive(r) && r.role === "long" ? Math.ceil(r.lot * r.strike) : 0;
}

export interface FutureStats {
  accepted: number;
  posted: number;
  taken: number;
  settled: number;
  defaulted: number;
  lapsed: number;
  /** Our side found short at maturity (it should never happen). */
  ourShort: number;
  /** Expected value of the contracts entered (pence). */
  evPence: number;
}

export const emptyFutureStats = (): FutureStats => ({ accepted: 0, posted: 0, taken: 0, settled: 0, defaulted: 0, lapsed: 0, ourShort: 0, evPence: 0 });

/** Futures for the panel and the digest (pence; times ISO). */
export interface FuturesReport {
  enabled: boolean;
  blocked: string | null;
  budgetPence: number;
  exposurePence: number;
  action: string;
  open: Array<{ id: string | null; port: string; good: string; role: FutureRec["role"]; how: FutureRec["how"]; lot: number; strikePence: number; held: number | null; status: FutureRec["status"]; maturesAt: string }>;
  recent: Array<{ at: string; port: string; good: string; role: FutureRec["role"]; lot: number; strikePence: number; evPence: number; status: FutureRec["status"]; why: string | null }>;
  stats: FutureStats;
}

const STATUSES: ReadonlyArray<FutureRec["status"]> = ["sending", "open", "active", "settled", "defaulted", "lapsed", "failed"];

export function restoreFutures(s: { recs?: FutureRec[]; stats?: Partial<FutureStats> } | undefined): { recs: FutureRec[]; stats: FutureStats } {
  const stats = emptyFutureStats();
  for (const k of Object.keys(stats) as (keyof FutureStats)[]) {
    const v = s?.stats?.[k];
    if (typeof v === "number" && Number.isFinite(v)) stats[k] = v;
  }
  const recs = (Array.isArray(s?.recs) ? s!.recs : [])
    .filter(
      (r) =>
        r &&
        typeof r.port === "string" &&
        typeof r.good === "string" &&
        (r.role === "long" || r.role === "short") &&
        (r.how === "accepted" || r.how === "posted") &&
        (r.id === null || typeof r.id === "string") &&
        STATUSES.includes(r.status) &&
        Number.isFinite(r.lot) &&
        Number.isFinite(r.strike) &&
        Number.isFinite(r.maturesAt) &&
        Number.isFinite(r.at),
    )
    .map((r) => ({ ...r, margin: Number.isFinite(r.margin) ? r.margin : Math.round(FUT_MARGIN_SHARE * r.lot * r.strike) }))
    .slice(-FUTURES_KEPT);
  return { recs, stats };
}
