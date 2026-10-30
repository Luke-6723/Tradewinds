/**
 * Commenda ventures (guide 3.13.5; the `ventures` setting): outside capital for a load cash limits.
 *
 * Pure logic, no calls. The game's terms: a merchant opens a venture on its ship lying at the origin (not in a convoy, not liened),
 * naming the destination and the investors' share of the profit (25%..90%, after the Crown's 2% stamp duty); capital is raised in
 * the origin's region for `raise_game_hours`, on the Exchange; the merchant spends it only on cargo into that ship at the origin
 * (`venture/buy`: an IOC from our vault, reimbursed from the venture at once; refused 409 while an ask of ours rests at or under
 * the limit); the ship may then sail only to the declared destination, alone, before the raise deadline (one that never sails is
 * cancelled, its unspent cash returned); there the cargo is sold through the venture (`venture/sell`) and the venture settled
 * (`venture/settle`; on its own a game day after arrival, leftovers sold into the bids at no less than half the Crown's bid).
 * Investors get their capital plus their share pro rata; the merchant the rest; a loss is shared pro rata; ship lost, only unspent
 * cash comes back. The venture's tons can't be sold, unloaded, delivered or put into stores but through it, and its ship can't sail
 * again before settling. The Merchant Adventurers co-invest a modest stake late in the window when the investors' share is large
 * and our credit record clean, never in two open ventures of one merchant at once.
 *
 * How the autopilot uses it (manager.ts ventureStart / ventureTurn, one venture at a time):
 *   - only at a lane's source, when the load is cash-limited and no load loan is planned for it (the loan, cheaper when it pays, is
 *     weighed first: leveragedLoad), the lane all market goods (sold through the venture: never a charter, never freight, never
 *     provisions), nothing of ours aboard (no cargo, sealed freight or passengers: the venture's tons must be all its own), the
 *     ship berthed there, out of any convoy, not liened, not insured, the season normal;
 *   - the value test (ventureCase): the bigger load's cargo profit (after the duty, read conservatively on the proceeds) × our part
 *     (the merchant's share and our stake's pro rata share of the investors'), less the ship's own costs in full (the hull's risk and
 *     the berth dues are the merchant's alone: the venture's P&L is its cargo's), what the cash-limited load would make anyway and
 *     the ship's time over the window, must clear a margin; the outside capital expected is learned from our ventures (a prior first);
 *   - our own cash for the load goes in as our stake (`venture/invest`), so every ton aboard is the venture's;
 *   - the window is short (VENTURE_RAISE_MIN_H.., long enough for the Merchant Adventurers' look plus the buy's turnaround lock);
 *     the buy is timed as late as the deadline and its lock allow (for the tons the capital raised so far would buy, so money put in
 *     late is spent, not left to dilute our stake); at the buy the case is judged again on the capital actually raised, the load
 *     bounded by the tons whose lock still clears before the deadline (tonsInTime), and a venture that raised too little is
 *     cancelled (settled before sailing: our stake back) and the load bought as ever; each good is bought in as many IOCs as its plan,
 *     the venture's cash and the time take; capital raised after the buy is spent before she sails while the lock still allows;
 *   - the investors' share is learned per outcome, at the window's close (what was raised, from a read of it no longer raising):
 *     lower after one that raised what we hoped, higher after one that raised nothing;
 *   - every call is saved before it is sent; a call with no answer is reconciled from `venture/list` (which shows our own calls at
 *     once: a read VENTURE_PENDING_GAME_MIN on that doesn't show it means it didn't land), never sent blind again.
 */

import type { Venture } from "../schema";

/** The Crown's stamp duty, read on the proceeds (the guide says "on the profit"; the larger base is the safe side). */
export const VENTURE_STAMP_DUTY = 0.02;
/** Investors' share (bps): where we start, the game's floor, our ceiling, and the steps learned per outcome. */
export const VENTURE_SHARE_START_BPS = 4_000;
export const VENTURE_SHARE_MIN_BPS = 2_500;
export const VENTURE_SHARE_MAX_BPS = 7_000;
export const VENTURE_SHARE_UP_BPS = 1_000;
export const VENTURE_SHARE_DOWN_BPS = 250;
/** Raising window (game hours): at least this, at most this. */
export const VENTURE_RAISE_MIN_H = 3;
export const VENTURE_RAISE_MAX_H = 6;
/** Game minutes of raising before the buy, for the Merchant Adventurers to look (they act every 2 game hours on listings an hour old). */
export const VENTURE_LOOK_GAME_MIN = 150;
/** Slack between the buy's lock clearing and the deadline (game minutes): she never departs late. */
export const VENTURE_DEADLINE_SLACK_GAME_MIN = 60;
/** Game minutes counted with every buy's lock for its calls (book reads, IOCs, the reads between them). */
export const VENTURE_LOCK_PAD_GAME_MIN = 15;
/** Berthing sets this turnaround lock (game minutes; guide 3.3) before anything bought adds to it. */
export const VENTURE_DOCK_LOCK_GAME_MIN = 30;
/** Most IOCs per good in one buying round (each is fronted from our vault and reimbursed at once). */
export const VENTURE_BUYS_PER_GOOD = 30;
/** Capital raised after a buying round that is worth another (pence; 100 Cr, and at least a ton at the cheapest limit). */
export const VENTURE_TOPUP_MIN_PENCE = 10_000;
/** Outside capital expected, as a share of what filling the hold costs at catalog prices: the prior, and how fast outcomes move it. */
export const VENTURE_OUTSIDE_PRIOR = 0.1;
export const VENTURE_OUTSIDE_LEARN = 0.3;
/** Least gain over the cash-limited load for a venture to be opened (pence; 300 Cr), and at the buy (half of it: the window is spent). */
export const VENTURE_MIN_GAIN_PENCE = 30_000;
/**
 * A call with no answer is looked for in our ventures (`venture/list` shows our own calls at once) this long (game minutes), then a
 * read that doesn't show it means it didn't land (an open: it wasn't made): well inside the raising window, so the ship isn't left
 * idle past it. A list that can't be read is waited on, however long.
 */
export const VENTURE_PENDING_GAME_MIN = 5;
/** Our ventures are read at most this often while one is active (real ms). */
export const VENTURE_READ_MS = 20_000;
/** At the destination: sell down to this share of the planned sale price first; after this patience (game hours), into the bids at half the Crown's. */
export const VENTURE_SELL_FLOOR = 0.85;
export const VENTURE_SELL_PATIENCE_GAME_H = 8;
/** Between selling tries at the destination (game minutes): the buyers re-quote every 6 game hours. */
export const VENTURE_SELL_RETRY_GAME_MIN = 90;
/** After a refused open or a cancelled venture, no venture on that ship for this long (real ms). */
export const VENTURE_SKIP_MS = 60 * 60_000;
/** Least stake of ours put in (pence): the game takes 10 Cr at least. */
export const VENTURE_MIN_STAKE_PENCE = 1_000;
/** Ventures kept for the report, newest last. */
export const VENTURES_KEPT = 20;

export type VentureStage = "opening" | "raising" | "buying" | "loaded" | "selling" | "settling" | "closed";

/** A good the venture plans to carry (market goods only), with its buy limit and expected sale per ton (pence). */
export interface VenturePart {
  good: string;
  tons: number;
  /** Highest price per ton paid (the break-even the planner set, as buyPart does). */
  limit: number;
  /** Expected sale per ton at the destination. */
  pay: number;
}

/** A call sent with no answer yet (local ms): reconciled from venture/list, never sent again. */
export interface VenturePending {
  call: "open" | "invest" | "buy" | "sell" | "settle";
  at: number;
  good?: string;
  tons?: number;
  pence?: number;
  /** The goods' tons the venture held before a buy or sell (to tell whether it landed). */
  before?: number;
}

/** One venture of ours (server ms unless said). */
export interface VentureRec {
  id: string | null;
  shipId: string;
  ship: string;
  origin: string;
  dest: string;
  shareBps: number;
  raiseHours: number;
  /** The game's deadline to sail (server ms; null until the open's answer). */
  raiseBy: number | null;
  /**
   * When the open was sent (server ms) and when the buy is timed for: as late as the deadline and the lock allow, for the tons the
   * capital raised so far would buy (timed again at each read while raising).
   */
  openedAt: number;
  buyAt: number | null;
  /** The buy's turnaround lock (game minutes, VENTURE_LOCK_PAD_GAME_MIN in it) for the load it is timed or planned for. Absent: an hour. */
  lockMin?: number;
  /** Cash a ton of the load ties up, as last planned (pence): the buy is timed for the tons the capital raised would buy. Absent: the parts' limits. */
  perTon?: number;
  /** The venture's cash left when its last buying round ended (pence): more raised after it is spent before she sails, while the lock allows. */
  cashAfterBuy?: number;
  stage: VentureStage;
  pending: VenturePending | null;
  /** Our stake: planned, and invested (as confirmed); `stakeTried`: the invest was sent (or found no cash), never twice. */
  stakePlanned: number;
  stake: number;
  stakeTried?: boolean;
  /** Capital raised (all), from other companies, and from the Merchant Adventurers as far as the notices said. */
  capital: number;
  outside: number;
  ma: number;
  /** What was expected from outside when it was opened (pence). */
  expectedOutside: number;
  /** The cash-limited load's cash profit, and the bigger load's, as planned at the open (pence). */
  smallProfit: number;
  planProfit: number;
  /** What filling the hold costs at catalog prices (the outside capital is learned against it). */
  fillCost: number;
  parts: VenturePart[];
  /** Tons bought per good, spent and the proceeds of sales (as the venture last showed them). */
  bought: Record<string, number>;
  spent: number;
  proceeds: number;
  arrivedAt: number | null;
  lastSellAt: number;
  /** Paid at the settlement: the merchant's share and our stake's payout (null until settled). */
  merchantShare: number | null;
  stakePayout: number | null;
  outcome: "settled" | "cancelled" | "lost" | "not_opened" | "failed" | null;
  /** What it raised from outside was learned (the investors' share, the outside capital expected), once. */
  learned?: boolean;
  why: string;
  closedAt: number | null;
  /** The game's status as last read. */
  status: string | null;
}

/** What the ventures learned and did, kept across restarts. */
export interface VentureMemory {
  shareBps: number;
  outsideRatio: number;
  recs: VentureRec[];
  stats: VentureStats;
}

export interface VentureStats {
  opened: number;
  settled: number;
  cancelled: number;
  lost: number;
  /** Capital raised from other companies (players and the Merchant Adventurers), and from the Merchant Adventurers alone. */
  outsidePence: number;
  maPence: number;
  /** Paid to us at settlements: the merchant's shares and our stakes' payouts; our stakes put in (for the profit). */
  merchantPence: number;
  payoutPence: number;
  stakedPence: number;
}

export function emptyVentures(): VentureMemory {
  return {
    shareBps: VENTURE_SHARE_START_BPS,
    outsideRatio: VENTURE_OUTSIDE_PRIOR,
    recs: [],
    stats: { opened: 0, settled: 0, cancelled: 0, lost: 0, outsidePence: 0, maPence: 0, merchantPence: 0, payoutPence: 0, stakedPence: 0 },
  };
}

const STAGES: readonly VentureStage[] = ["opening", "raising", "buying", "loaded", "selling", "settling", "closed"];

export function restoreVentures(s: Partial<VentureMemory> | undefined): VentureMemory {
  const m = emptyVentures();
  if (!s) return m;
  if (Number.isFinite(s.shareBps)) m.shareBps = Math.min(VENTURE_SHARE_MAX_BPS, Math.max(VENTURE_SHARE_MIN_BPS, Math.round(s.shareBps!)));
  if (Number.isFinite(s.outsideRatio)) m.outsideRatio = Math.min(1, Math.max(0, s.outsideRatio!));
  for (const k of Object.keys(m.stats) as (keyof VentureStats)[]) {
    const v = s.stats?.[k];
    if (typeof v === "number" && Number.isFinite(v)) m.stats[k] = v;
  }
  m.recs = (Array.isArray(s.recs) ? s.recs : [])
    .filter((r) => r && typeof r.shipId === "string" && typeof r.origin === "string" && typeof r.dest === "string" && STAGES.includes(r.stage) && Number.isFinite(r.openedAt))
    .map((r) => ({
      ...r,
      bought: r.bought && typeof r.bought === "object" ? { ...r.bought } : {},
      parts: Array.isArray(r.parts) ? r.parts.map((p) => ({ ...p })) : [],
      pending: r.pending ? { ...r.pending } : null,
      perTon: typeof r.perTon === "number" && Number.isFinite(r.perTon) && r.perTon > 0 ? r.perTon : undefined,
      cashAfterBuy: typeof r.cashAfterBuy === "number" && Number.isFinite(r.cashAfterBuy) ? r.cashAfterBuy : undefined,
    }))
    .slice(-VENTURES_KEPT);
  return m;
}

/** Whether a venture is under way (anything but closed). */
export const ventureActive = (r: VentureRec) => r.stage !== "closed";

/**
 * The raising window (game hours): the Merchant Adventurers' look, then the buy's turnaround lock (`lockGameMin`) and slack before
 * the deadline, within VENTURE_RAISE_MIN_H..VENTURE_RAISE_MAX_H. Null: the lock alone would leave too little raising time.
 */
export function raiseHours(lockGameMin: number): number | null {
  const need = (VENTURE_LOOK_GAME_MIN + Math.max(0, lockGameMin) + VENTURE_LOCK_PAD_GAME_MIN + VENTURE_DEADLINE_SLACK_GAME_MIN) / 60;
  if (need > VENTURE_RAISE_MAX_H) return null;
  return Math.max(VENTURE_RAISE_MIN_H, Math.ceil(need));
}

/**
 * Server time to buy at, as late as the deadline allows: the lock of `lockGameMin` (lockGameMin: its pad in it), the pad again for
 * the planning and the calls before the last IOC (tonsInTime keeps one as its margin), and the slack must clear before it.
 */
export function buyTime(raiseBy: number, lockGameMin: number, gameMinuteMs: number): number {
  return raiseBy - (Math.max(0, lockGameMin) + VENTURE_LOCK_PAD_GAME_MIN + VENTURE_DEADLINE_SLACK_GAME_MIN) * gameMinuteMs;
}

/** The turnaround lock a buy of `tons` sets (game minutes: the port's handling a ton), with VENTURE_LOCK_PAD_GAME_MIN for its calls. */
export function lockGameMin(tons: number, handlingMsPerTon: number, gameMinuteMs: number): number {
  return Math.ceil((Math.max(0, tons) * Math.max(0, handlingMsPerTon)) / Math.max(gameMinuteMs, 1)) + VENTURE_LOCK_PAD_GAME_MIN;
}

/**
 * Most tons a buy started at `from` (server ms: now, or her berth lock's clearing if later) may take so that its lock (each ton
 * `handlingMsPerTon` more, and the pad) still clears VENTURE_DEADLINE_SLACK_GAME_MIN before the deadline `raiseBy`: she never
 * departs late. 0: no buy fits.
 */
export function tonsInTime(raiseBy: number, from: number, handlingMsPerTon: number, gameMinuteMs: number): number {
  const ms = raiseBy - from - (VENTURE_LOCK_PAD_GAME_MIN + VENTURE_DEADLINE_SLACK_GAME_MIN) * gameMinuteMs;
  return ms > 0 && handlingMsPerTon > 0 ? Math.floor(ms / handlingMsPerTon) : 0;
}

/**
 * Our part of a venture's result (pence): `capital` raised in all (our `stake` in it), the load's cargo `profit` (proceeds less
 * cost: what the venture shares); the duty taken off; a profit split (investors `shareBps` pro rata, the merchant the rest: we are
 * both), a loss shared pro rata to the stakes; less `shipCost` in full (the hull's expected loss and the berth dues: the merchant's
 * alone, never the venture's).
 */
export function ourTake(profit: number, capital: number, stake: number, shareBps: number, shipCost = 0): number {
  const k = Math.max(0, stake);
  const K = Math.max(capital, k, 1);
  const net = profit - VENTURE_STAMP_DUTY * (K + Math.max(0, profit));
  const s = Math.min(1, Math.max(0, shareBps / 10_000));
  return (net > 0 ? net * (1 - s + s * (k / K)) : net * (k / K)) - Math.max(0, shipCost);
}

/**
 * The value test: with `stake` of our own in (the cash the load would spend anyway) and `outside` expected, the bigger load
 * (`bigCapital` tied up, `bigProfit` its cargo profit, `shipCost` the ship's own costs on the passage) gives us `ourTake`; less
 * what the cash-limited load makes alone (`smallProfit`, every cost in it) and the ship's time over the window (`idleCost`), it
 * must clear `minGain`.
 */
export function ventureCase(x: {
  stake: number;
  /** Capital raised in all (ours and outside): our stake's pro rata share is of it, unspent capital included. */
  raised: number;
  smallProfit: number;
  bigCapital: number;
  /** The bigger load's cargo profit (proceeds less cost: the venture's P&L), the ship's own costs left out. */
  bigProfit: number;
  /** The hull's expected loss (pirates, storms) and the berth dues on that passage: the merchant's alone. */
  shipCost: number;
  shareBps: number;
  idleCost: number;
  minGain: number;
}): {
  ok: boolean;
  gain: number;
  ours: number;
  why: string;
} {
  const ours = ourTake(x.bigProfit, Math.max(x.raised, x.bigCapital), x.stake, x.shareBps, x.shipCost);
  const gain = Math.round(ours - Math.max(0, x.smallProfit) - Math.max(0, x.idleCost));
  if (!(x.bigCapital > x.stake)) return { ok: false, gain, ours: Math.round(ours), why: "no more capital to use: the hold or the market limits the load, not cash" };
  if (!(x.bigProfit - Math.max(0, x.shipCost) > 0)) return { ok: false, gain, ours: Math.round(ours), why: "the bigger load doesn't pay" };
  if (gain < x.minGain) {
    return { ok: false, gain, ours: Math.round(ours), why: `our part ~${crs(ours)} against ${crs(x.smallProfit)} loading alone and ${crs(x.idleCost)} of the ship's time: ${crs(gain)}, under the ${crs(x.minGain)} bar` };
  }
  return { ok: true, gain, ours: Math.round(ours), why: `our part ~${crs(ours)} against ${crs(x.smallProfit)} loading alone and ${crs(x.idleCost)} of the ship's time` };
}

const crs = (pence: number) => `${Math.round(pence / 100).toLocaleString("en-GB")} Cr`;

/** The investors' share after an outcome: lower when outsiders put in at least half what we hoped, higher when nobody did. */
export function learnShare(shareBps: number, outside: number, expected: number): number {
  let s = shareBps;
  if (outside <= 0) s += VENTURE_SHARE_UP_BPS;
  else if (outside >= 0.5 * Math.max(expected, 1)) s -= VENTURE_SHARE_DOWN_BPS;
  return Math.min(VENTURE_SHARE_MAX_BPS, Math.max(VENTURE_SHARE_MIN_BPS, Math.round(s / 50) * 50));
}

/** The outside capital expected next time, as a share of the hold's fill at catalog prices (moved toward what this one raised). */
export function learnOutside(ratio: number, outside: number, fillCost: number): number {
  if (!(fillCost > 0)) return ratio;
  const seen = Math.min(1, Math.max(0, outside / fillCost));
  return Math.min(1, Math.max(0, ratio * (1 - VENTURE_OUTSIDE_LEARN) + seen * VENTURE_OUTSIDE_LEARN));
}

/** Tons of `good` the venture holds aboard (its cargo as the game lists it). */
export function cargoTons(v: Venture, good: string): number {
  return (v.cargo ?? []).filter((c) => c.commodity_id === good).reduce((n, c) => n + (Number.isFinite(c.tons) ? c.tons : 0), 0);
}

/** Our stake in a venture as the game lists it (our companies' stakes summed). */
export function stakeOf(v: Venture, ours: (companyId: string) => boolean): number {
  return (v.stakes ?? []).filter((s) => ours(s.investor_company_id)).reduce((n, s) => n + (s.capital_pence || 0), 0);
}

/** What our stakes were paid at the settlement (as the game lists it). */
export function payoutOf(v: Venture, ours: (companyId: string) => boolean): number {
  return (v.stakes ?? []).filter((s) => ours(s.investor_company_id)).reduce((n, s) => n + (s.payout_pence || 0), 0);
}

/**
 * The sale limit per ton at the destination: down to VENTURE_SELL_FLOOR of the planned price, never above the best bid; after the
 * patience, into the bids at no less than half the best bid (what the game's own settlement would take).
 */
export function sellLimit(planned: number, bestBid: number, patient: boolean): number | null {
  if (!(bestBid > 0)) return null;
  if (!patient) return Math.ceil(Math.max(0.5 * bestBid, VENTURE_SELL_FLOOR * planned));
  return Math.max(1, Math.ceil(0.5 * bestBid));
}

/** Ventures for the panel and the digest (pence; times ISO). */
export interface VenturesReport {
  /** The setting in force (resizeLoads must be on: the cash-limited check is made there). */
  enabled: boolean;
  /** Why no venture is opened now (the switches, the season, one already under way); null: one may be. */
  blocked: string | null;
  /** The investors' share we offer next, and the outside capital expected (share of the hold's fill at catalog prices). */
  shareBps: number;
  outsideRatio: number;
  /** The venture under way, if any. */
  active: VentureView | null;
  /** The last ones, newest last. */
  recent: VentureView[];
  stats: VentureStats;
  /** Our profit from ventures settled: what came back less our stakes. */
  profitPence: number;
}

export interface VentureView {
  id: string | null;
  shipId: string;
  ship: string;
  origin: string;
  dest: string;
  shareBps: number;
  stage: VentureStage;
  status: string | null;
  raiseBy: string | null;
  buyAt: string | null;
  stakePence: number;
  capitalPence: number;
  outsidePence: number;
  maPence: number;
  goods: Array<{ good: string; plannedTons: number; boughtTons: number }>;
  spentPence: number;
  proceedsPence: number;
  merchantSharePence: number | null;
  stakePayoutPence: number | null;
  outcome: string | null;
  why: string;
  openedAt: string;
  closedAt: string | null;
}

export function viewOf(r: VentureRec): VentureView {
  const iso = (t: number | null) => (t !== null && Number.isFinite(t) ? new Date(t).toISOString() : null);
  return {
    id: r.id,
    shipId: r.shipId,
    ship: r.ship,
    origin: r.origin,
    dest: r.dest,
    shareBps: r.shareBps,
    stage: r.stage,
    status: r.status,
    raiseBy: iso(r.raiseBy),
    buyAt: iso(r.buyAt),
    stakePence: r.stake,
    capitalPence: r.capital,
    outsidePence: r.outside,
    maPence: r.ma,
    goods: r.parts.map((p) => ({ good: p.good, plannedTons: p.tons, boughtTons: r.bought[p.good] ?? 0 })),
    spentPence: r.spent,
    proceedsPence: r.proceeds,
    merchantSharePence: r.merchantShare,
    stakePayoutPence: r.stakePayout,
    outcome: r.outcome,
    why: r.why,
    openedAt: iso(r.openedAt) ?? new Date(0).toISOString(),
    closedAt: iso(r.closedAt),
  };
}
