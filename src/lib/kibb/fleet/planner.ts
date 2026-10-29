/**
 * Lane planner: what a ship should load, where, and where to take it.
 *
 * A lane is one leg of work from where the ship is: sail to a source port S (empty, unless it is
 * already there), load, sail to D, and deliver or sell. It is named for what fills the hold first:
 *
 *   charter  goods bought at S for charters at D: live ones, and ones heard of only as gossip,
 *            counted at the chance they are still open (falling with the news' age), the rest of
 *            their value at what the goods would fetch if they are gone;
 *   market   goods bought at S and sold to D's buyers at the last bid seen there (a live book, or
 *            coffee-house gossip marked down for its age), less the drop selling the load causes;
 *   freight  Merchant Adventurers lots listed at the ship's own port, carried sealed to D (return freight, paid by
 *            the Crown, among them: its sealed cargo is worth nothing, so it draws no raid; only the collateral and
 *            the reward go down with the ship).
 *
 * Whatever room and cash the first choice leaves is filled ("mixed loads") with other goods S sells
 * that D's charters or buyers want, best margin per ton first, and with freight lots from S to D.
 *
 * Costs per ton: the ask (with the impact of what we and our other ships buy there), customs at S,
 * the fee to bring the money from D's region back to S's, and the share of the load pirates are
 * expected to take on the way (more for a richer load: pirates go for the richest prizes). The
 * chance of pirates taking the ship itself is charged to the leg at the hull's value. Storms are
 * charged the same way: the share of the load they are expected to destroy on the laden passage
 * (each zone's storm odds per day at sea, worse in storm season, learned from our own voyages), and
 * the rare sinking at the hull's value. Charters count a weighted share of the phase-completion bonus, but
 * their cash pay must cover the cost by itself. Loads are capped by hold room and by the cash spare
 * when the ship reaches the source: what our other ships' loads leave by then, counting cash due
 * from our cargo at sea that lands first.
 *
 * Expansion charters are re-posted when they lapse, so their expiry doesn't end them: a load landing
 * after it is valued at the re-post's terms (richer, on fewer tons, when the posting looks stalled).
 * While the fleet lets a stalled posting lapse (manager.ts stallStakes), nothing of ours is delivered
 * into it first: a load landing before the lapse waits for the re-post, its wait counted in the lane's
 * time, so ships take other work until a run lands near the lapse.
 *
 * Lanes are ranked by profit per real hour over the leg plus the best leg visible from D, so a lane
 * that ends where a paid return cargo waits beats one ending in a dead end. With nothing paying from
 * D, an empty sail back to S stands in for what comes next. When cash is what limits the fleet, the
 * money a load ties up is charged at the fleet's own return on cash, so thin-margin loads that lock
 * up a lot of it rank lower.
 *
 * World events move prices: a shortage's bid and a glut's ask are expected from the shocks seen so
 * far, fading by the news' lapse, and a shortage's crisis charter (listed only on its quay or as
 * gossip later) is planned on before it is listed, at the share found when looked for.
 *
 * The AI's bans (ports, sea zones, goods, charters, public charters rivals are due at first) keep lanes
 * touching them out of every plan, onward legs included; its bias only reorders lanes that pass.
 */

import type { RoutePlan, ZoneClass } from "../types";
import { BID_HAIRCUT_BASE, freightLoot, PROVISIONAL_PREFIX, type CharterInfo, type World } from "./world";

export interface ShipSpec {
  shipClass: string;
  hull: ZoneClass;
  /** Unladen speed, knots. */
  knots: number;
  /** Cargo room once guns, stores and sealed freight are aboard. */
  cap: number;
  guns: number;
  /** What losing the ship to pirates would cost (pence): its rebuild value and guns. */
  hullValue?: number;
}

export type LaneKind = "charter" | "market" | "freight";

/** One good bought at the source: delivered to charters at the destination, or sold to its buyers. */
export interface Part {
  kind: "charter" | "market";
  good: string;
  tons: number;
  /** Charters this good fills, with the tons for each (charter parts only). */
  fills: Array<[charterId: string, tons: number]>;
  /** Expected cash per ton at the destination: charter pay (gossip discounted), or the expected sale price. */
  pay: number;
  /** Weighted phase-bonus share per ton. */
  bonus: number;
  /** Lowest value per ton (bonus included) among what this part fills: the buy limit is set from it. */
  minPay: number;
  /** Lowest cash value per ton among what it fills: the buyer never pays more than this covers. */
  cashPay: number;
  estAsk: number;
  askKnown: boolean;
  /** Landed cost per ton: ask + customs + remittance fee + expected piracy and storm losses. */
  costPerTon: number;
  /** Per ton delivered: pay + bonus − cost. */
  margin: number;
  /** Server time to hold the load until (a stalled expansion charter's re-post), or null to deliver on arrival. */
  holdUntil: number | null;
}

/** A freight lot to accept at the source, bound for the destination. */
export interface FreightPick {
  id: string;
  good: string;
  tons: number;
  reward: number;
  collateral: number;
  /** Return freight (guide 3.8, Crown-funded): worth nothing to pirates (world.ts freightLoot). Absent on older saves: an ordinary lot. */
  ret?: boolean;
}

export interface Lane {
  key: string;
  kind: LaneKind;
  source: string;
  dest: string;
  /** The main good (a freight lane: the first lot's). */
  good: string;
  /** Goods to buy at the source, main part first. */
  parts: Part[];
  /** Freight lots to accept at the source. */
  freight: FreightPick[];
  /** Every charter the load fills, across its parts. */
  fills: Array<[charterId: string, tons: number]>;
  /** Tons aboard for this lane: goods and freight. */
  tons: number;
  /** Per-ton averages over the whole load: cash in, phase bonus, landed cost, and their margin. */
  pay: number;
  bonus: number;
  costPerTon: number;
  margin: number;
  /** Expected share of the load lost to pirates on the laden passage (bps). */
  piracyBps: number;
  /** Expected share of the load storms destroy on the laden passage (bps), sinkings included; read as `?? 0` (restored lanes lack it). */
  stormBps: number;
  /** Whether the main good's ask is a price seen (rather than an estimate). */
  askKnown: boolean;
  /** Expected cash profit of this leg (the phase bonus is paid later and isn't in it). */
  cashProfit: number;
  /** Cash the load ties up at the source: goods and freight collateral. */
  capital: number;
  /** Real ms planned waiting at the destination for a re-post (0 when delivering on arrival). */
  holdMs: number;
  /** Server time the load is expected to be delivered (after any hold). */
  deliverAt: number;
  /** Real ms from now until this leg is delivered. */
  deliverMs: number;
  /** This leg plus the best leg seen from its destination (or an empty sail back). */
  loopMs: number;
  profitPerHour: number;
  /** What the planner expects to do after this leg, for the log. */
  next: string | null;
  /** Tons first planned, once the load was planned again at its source with the cash there was then. */
  resizedFrom?: number;
  /** Of `capital`, what the plan counted on cash due rather than cash in hand (absent: none). That part never has first call at the source. */
  dueCounted?: number;
  /** It fills a crisis charter expected from a shortage's news, not listed yet. */
  speculative?: boolean;
  /** Sea zones the laden passage's hazards roll for (absent on lanes saved before it was kept). */
  zones?: string[];
  /**
   * Planned at its source with a loan (FleetManager.leveragedLoad): at most `pence` borrowed when buying it, for the
   * cash profit it adds over the cash-only load (`gain`), paid back on delivery (`paybackDays`, game days); `loanId`
   * once taken. Absent: none.
   */
  borrow?: { pence: number; gain: number; paybackDays: number; state: "planned" | "taken" | "failed"; loanId?: string };
}

/** The AI's hard bans for its horizon (ai/directives.ts): no planned load touches them. */
export interface Bans {
  /** No loading, delivering or selling there. */
  ports: Set<string>;
  /** No passage through them, laden or empty. */
  zones: Set<string>;
  goods: Set<string>;
  /** Postings (the ids that now stand for them). */
  charters: Set<string>;
  /** No public charter where rivals are due before we land. */
  contested: boolean;
}

/** Tons other ships are bound to deliver, buy or sell, and freight lots they mean to take. */
export interface Reservations {
  /** Per charter id. */
  charterTons: Map<string, number>;
  /** Per `source|good`. */
  sourceTons: Map<string, number>;
  /** Per `dest|good`: tons other ships will sell to that port's buyers. */
  sellTons: Map<string, number>;
  freightIds: Set<string>;
  /** Per charter id: the soonest one of our other ships delivers into it (a stalled posting's stall ends then). */
  charterLandsAt?: Map<string, number>;
}

/**
 * The fleet's call on one stalled expansion posting (manager.ts): let it lapse for its richer
 * re-post ("camp": nothing of ours goes into it before then) or deliver into it, with the numbers.
 */
export interface StallStake {
  /** `port|good`, the posting and its lapse (server ms). */
  key: string;
  id: string;
  port: string;
  good: string;
  expiresAt: number;
  /** Chance it re-posts richer if none of our ships delivers first (0 on an AI "deliver" call). */
  p: number;
  /** Rival first deliveries into its stalled postings per game day (its record, pooled). */
  rivalPerDay: number;
  /** Extra pay per ton on the re-post (pence), as the premium taper leaves it (guide 3.7). */
  uplift: number;
  /** Our tons landing before the lapse, and those expected into the re-post. */
  tonsBefore: number;
  tonsAfter: number;
  /** Expected gain of letting it lapse, and what waiting costs (pence). */
  value: number;
  cost: number;
  camp: boolean;
  /** "Always hold" or an AI "wait": camped in its last HOLD_MAX_GAME_H whatever the math says. */
  forced: boolean;
  why: string;
}

export interface PlanOptions {
  /** Minimum profit per ton (pence) after every cost. */
  minMargin: number;
  /** Carry Merchant Adventurers freight (as a lane or to fill spare room). */
  freight: boolean;
  /** 0–1: how much of the expected phase-completion bonus to count. */
  bonusWeight: number;
  /** 0–2: how much of the expected storm losses to count (1 = as learned, 0 = ignore storms). */
  stormWeight?: number;
  /** Pence the fleet can spend on this load, or null for no limit. */
  cash: number | null;
  /**
   * Pence the fleet can spend on a load bought at `source` at server time `at`, counting cash due by
   * then (FleetManager.cashAt). Used for this ship's own legs in place of `cash`; onward legs keep `cash`.
   */
  cashAt?: (at: number, source: string) => number;
  /** Only legs loading at this port: a load planned again at its source (FleetManager.resizeLane). */
  onlySource?: string;
  /** Only legs delivering at this port: a ship insured for that voyage (its policy is void anywhere else). */
  onlyDest?: string;
  /** Charge per pence of cash a load ties up, per real hour (0 while cash isn't scarce). */
  capitalRate?: number;
  /**
   * A multiplier on a lane's rank (the AI advisor's lane bias). It only reorders lanes that already
   * passed every check and earn something; it never makes a lane eligible.
   */
  bias?: (lane: Lane) => number;
  /** The fleet's call on each stalled expansion posting, by `port|good` (AI stall calls and settings folded in). */
  stalls?: Map<string, StallStake>;
  /** Leave crisis charters expected from the news out of onward legs (the buyer). */
  noSpeculativeOnward?: boolean;
  /** The AI's bans in force: lanes touching them aren't planned (onward legs included). */
  bans?: Bans;
}

/** Estimated ask rise per ton bought, before the ladder re-quotes (~4% for a 30 t hoy load). */
const IMPACT_PER_TON = 0.0013;
/** Estimated bid fall per ton sold into a port's buyers. */
const SELL_IMPACT_PER_TON = 0.0015;
/** Tons one port's buyers are assumed to take of one good per visit when their depth isn't visible. */
const MARKET_MAX_TONS = 40;
/** Market pairs tried per good: the best few buyers by bid and sellers by ask. */
const MARKET_TOP = 3;
/** Legs whose onward leg from their destination is weighed (the rest assume an empty sail back). */
const ONWARD_TOP = 12;
/** Charters closing sooner than the ship can deliver plus this are skipped. */
const EXPIRY_SLACK_MS = 10 * 60_000;
/** Fixed per-leg overhead: arrival processing, polling, depart retries. */
const LEG_OVERHEAD_MS = 60_000;
/** Smallest amount of one good worth a separate purchase. */
const MIN_PART_TONS = 3;
/** Smallest load (goods and freight, tons) worth a leg for a ship with this much room; the buyer keeps to it too. */
export const minLoadTons = (cap: number) => Math.min(10, cap * 0.5);
/** Bids seen longer ago than this (game hours) aren't planned on. */
const MARKET_MAX_AGE_GAME_H = 72;
// A remembered bid is marked down by World's BID_HAIRCUT_BASE, plus its learned rate per game day of age.
/** A gossiped charter's chance of still being open: this when fresh, less per game day of age. */
const GOSSIP_TRUST_MAX = 0.85;
const GOSSIP_TRUST_PER_DAY = 0.15;
const GOSSIP_TRUST_MIN = 0.15;
/** A ton's worth at a gossiped charter's port if the charter is gone and no bid is known there. */
const SALVAGE_OF_BASE = 0.6;
/**
 * Each laden rival whose cargo is unknown, due at a public charter's port (or an expected crisis
 * charter's, from public news) before we land, takes this share of its room; known cargo takes its
 * likely tons (to at most 60% in all).
 */
const RIVAL_CROWD_SHARE = 0.15;
/** "Always hold" and AI "wait" calls camp a stalled posting this close to its lapse (game hours). */
export const HOLD_MAX_GAME_H = 4;
/** Backstop on any hold the math allows (game hours; 4 real hours at 60x): data going stale shouldn't idle a ship longer. */
export const HOLD_CAP_GAME_H = 240;
/** Allowance (game minutes) for the re-post to appear after the lapse. */
export const REPOST_GRACE_GAME_MIN = 30;

interface Ctx {
  world: World;
  ship: ShipSpec;
  res: Reservations;
  opts: PlanOptions;
  now: number;
  baseLockMs: number;
  gameDayMs: number;
  /** Tons that can still earn the phase bonus (the tier's remainder less our other ships' loads). */
  bonusTons: number;
  /** Base value (pence) our other ships are bound to deliver into the tier: the bonus split counts it as ours already. */
  bonusExtra: number;
  /** Our Crown and Admiralty charter earnings over the last 10 game days (pence), read once for the premium taper (World.charterTaper). */
  charterEarned: number;
  /** Plannable charters by `port|good`. */
  charters: Map<string, CharterInfo[]>;
  /** Goods each port wants: charters for them there, or a recent bid. */
  wanted: Map<string, Set<string>>;
  legs: Map<string, Promise<Leg[]>>;
}

interface Leg {
  lane: Lane;
  /** Expected profit: margins (bonus included) on tons expected to arrive, plus freight rewards. */
  profit: number;
  ms: number;
}

const rate = (profit: number, ms: number) => (profit * 3_600_000) / Math.max(ms, 1);

// ── Prices ────────────────────────────────────────────────────────────────────

/**
 * The bid a sale at `port` can count on when the load lands at `at`: a live book as seen, older news
 * marked down, a shock's share easing as it fades; a shortage's expected spike when no book since it
 * began shows the real one. Null with nothing to go on (or only a bid from before an import slump).
 */
function expectedBid(ctx: Ctx, port: string, good: string, at = ctx.now): number | null {
  const { world } = ctx;
  // Lawful buyers only (guide 3.18): no bid for contraband, and a cove's stores market is never a lane's buyer.
  if (world.isCove(port) || !world.trades(port, good)) return null;
  const obs = world.price(port, good);
  let bid: number | null = null;
  const age = obs ? Math.max(0, ctx.now - obs.at) : Infinity;
  if (obs?.bid && age <= MARKET_MAX_AGE_GAME_H * 60 * world.gameMinuteMs && !world.shiftedSince(port, good, "import_slump", obs.at)) {
    const fresh = obs.live && age < 60 * world.gameMinuteMs;
    const haircut = fresh ? 0 : BID_HAIRCUT_BASE + world.bidHaircutPerDay * (age / ctx.gameDayMs);
    bid = world.easeShock(port, good, "demand_shortage", obs.bid, obs.at, at) * Math.max(0, 1 - haircut);
  }
  const spike = world.shortageBid(port, good, at, obs?.at ?? null);
  return spike !== null ? Math.max(bid ?? 0, spike) : bid;
}

/** 1 for a live charter; for gossip, the chance it is still open (one expected from the news: at most the share found). */
function trust(ctx: Ctx, c: CharterInfo): number {
  if (!c.stale) return 1;
  const ageDays = c.newsAt ? Math.max(0, ctx.now - c.newsAt) / ctx.gameDayMs : 2;
  const t = Math.max(GOSSIP_TRUST_MIN, Math.min(GOSSIP_TRUST_MAX, GOSSIP_TRUST_MAX - GOSSIP_TRUST_PER_DAY * ageDays));
  // Expected from a shortage's news: also no more than the share of crisis charters found so far.
  return c.trustCap !== undefined ? Math.max(GOSSIP_TRUST_MIN, Math.min(t, c.trustCap)) : t;
}

/** What a charter pays and takes for a load landing at `arriveAt`, and how long to hold it. */
interface Terms {
  pay: number;
  remaining: number;
  holdUntil: number | null;
}

/**
 * An expansion charter re-posts when it lapses: at the same rate, or (if nothing was delivered in
 * the posting) at a higher rate on fewer tons. A load landing after the lapse gets the re-post's
 * terms, weighted by the chance it escalates; one landing before it waits for it while the fleet
 * lets the posting lapse.
 */
function terms(ctx: Ctx, c: CharterInfo, arriveAt: number): Terms {
  const plain = { pay: c.payPerTon, remaining: c.remaining, holdUntil: null };
  const w = c.expiresAt === null || !renewing(ctx, c) ? undefined : ctx.world.stallWatch(c);
  if (!w || c.expiresAt === null) return plain;
  const esc = ctx.world.escalation;
  // The fleet's call on this posting. A pre-lapse delivery of ours (planned, not held) ends the
  // stall; camped postings never have one (reservations leave them out).
  const stake = ctx.opts.stalls?.get(`${c.port}|${c.good}`);
  const mine = stake?.id === c.id ? stake : undefined;
  const ours = ctx.res.charterLandsAt?.get(c.id);
  const stalled = w.stalled && !(ours !== undefined && ours < c.expiresAt);
  // The chance it re-posts richer: learned stall fates, rival record, rivals inbound (an AI "deliver" call: none).
  const p = !stalled ? 0 : mine ? mine.p : ctx.world.escalationOdds(w, ctx.now);
  const reposted = {
    pay: Math.round(c.payPerTon * (1 + (esc.pay - 1) * p)),
    remaining: Math.floor(c.remaining * (1 - (1 - esc.tons) * p)),
  };
  if (arriveAt > c.expiresAt) return { ...reposted, holdUntil: null };
  const gm = ctx.world.gameMinuteMs;
  const early = c.expiresAt - arriveAt;
  if (mine && stalled && (mine.camp || (mine.forced && early <= HOLD_MAX_GAME_H * 60 * gm))) {
    // Nothing of ours goes in before the lapse: a load landing far too early can't use it.
    if (early > HOLD_CAP_GAME_H * 60 * gm) return { ...plain, remaining: 0 };
    return { ...reposted, holdUntil: c.expiresAt + REPOST_GRACE_GAME_MIN * gm };
  }
  return plain;
}

/**
 * Whether a charter will still be re-posted when it lapses: an expansion charter of the tier in
 * play, while the tier still needs tons beyond our fleet's loads and isn't due to complete first
 * (its charters end with it).
 */
function renewing(ctx: Ctx, c: CharterInfo): boolean {
  const { world } = ctx;
  if (!world.renews(c) || ctx.bonusTons <= 0) return false;
  const lapse = (c.expiresAt ?? ctx.now) + REPOST_GRACE_GAME_MIN * world.gameMinuteMs;
  return world.tierEtaMs === null || ctx.now + world.tierEtaMs > lapse;
}

/**
 * Expected cash per ton for a charter landing at `at`: its pay if open (`pay`, terms' re-post pay included), else what the goods
 * fetch at its port. A Crown or Admiralty charter's premium over the goods' value is tapered (guide 3.7) by our charter earnings
 * over the last 10 game days with this load's own pay (`tons` of it) counted in; a player's charter pays as posted.
 */
function charterCash(ctx: Ctx, c: CharterInfo, pay = c.payPerTon, at = ctx.now, tons = 1): number {
  const paid = ctx.world.charterPayValue(c, pay, tons, ctx.charterEarned);
  const t = trust(ctx, c);
  if (t >= 1) return paid;
  const salvage = expectedBid(ctx, c.port, c.good, at) ?? ctx.world.basePrice(c.good) * SALVAGE_OF_BASE;
  return t * paid + (1 - t) * Math.min(salvage, paid);
}

/**
 * Weighted phase bonus per ton into charter `c`, on average over `tons` delivered together into the tier on top of
 * `extra` (base value our other ships and this load's earlier parts already bring): the square-root split gives each
 * further ton less (World.charterBonus).
 */
function charterBonus(ctx: Ctx, c: CharterInfo, tons?: number, extra = ctx.bonusExtra): number {
  return Math.round(ctx.world.charterBonus(c, tons, extra) * ctx.opts.bonusWeight * trust(ctx, c));
}

// ── Parts ─────────────────────────────────────────────────────────────────────

interface PartArgs {
  source: string;
  dest: string;
  good: string;
  /** Hold room and cash this part may use. */
  room: number;
  cash: number;
  /** Share of the cargo expected lost to pirates on the passage. */
  piracy: number;
  /** Share of the cargo expected destroyed by storms on the passage (sinkings included). */
  storm: number;
  /** Server time the load can be delivered by (charters closing sooner are skipped). */
  deliverBy: number;
  /** Expected server time of delivery: landing plus the base lock (without the safety slack in deliverBy). */
  arriveAt: number;
  /** Phase-bonus tons still unclaimed in this lane (read only: taking a part claims them). */
  bonusTons: number;
  /** Base value (pence) already bound for the tier: our other ships' loads and this lane's earlier parts. */
  bonusExtra: number;
  /** Expected server time of buying at the source (its base lock cleared). */
  buyAt: number;
}

type AskEst = NonNullable<ReturnType<World["estAsk"]>>;

/** Tons the source's asks can supply beyond what our other ships will buy there: all of it, unless only players' asks count (a royal monopoly). */
function offered(est: { maxTons?: number }, reserved: number): number {
  return est.maxTons === undefined ? Infinity : Math.max(0, Math.floor(est.maxTons - reserved));
}

/**
 * Average ask per ton for `tons` more bought at the source after the `reserved` tons our other ships buy there: a
 * players' resting ask in the news below the ladder (its tons, what the others leave of them) first, then the
 * ladder's ask rising with what is bought from it.
 */
function askFor(est: AskEst, reserved: number, tons: number): number {
  const p = est.player;
  if (!p || p.ask >= est.ask || tons <= 0) return est.ask * (1 + IMPACT_PER_TON * (reserved + Math.max(0, tons) / 2));
  const fromPlayer = Math.min(tons, Math.max(0, p.tons - reserved));
  const rest = tons - fromPlayer;
  const ladder = est.ask * (1 + IMPACT_PER_TON * (Math.max(0, reserved - p.tons) + rest / 2));
  return (fromPlayer * p.ask + rest * ladder) / tons;
}

/** The cheapest an ask can be at the source (the best case, for a quick test): a cheaper players' level, else the ladder's. */
const bestAsk = (est: AskEst) => Math.min(est.ask, est.player?.ask ?? Infinity);

/**
 * A players' resting bid in the news above what the port's buyers are expected to pay (World.playerLevel: ours left
 * out, its tons marked down for the news' age at `at`), or null.
 */
function playerBid(ctx: Ctx, port: string, good: string, bid: number | null, at: number): { price: number; tons: number } | null {
  if (ctx.world.isCove(port) || !ctx.world.trades(port, good)) return null;
  const lvl = ctx.world.playerLevel(port, good, "bid", at);
  return lvl && lvl.price > (bid ?? 0) ? lvl : null;
}

/** Landed cost per ton delivered at `ask`, and the cash it takes at the source per ton bought. */
function costs(ctx: Ctx, a: PartArgs, ask: number) {
  const customs = 1 + ctx.world.customsBps(a.source) / 10_000;
  const fee = 1 + ctx.world.remitBps(ctx.world.region(a.dest), ctx.world.region(a.source)) / 10_000;
  return { landed: (ask * customs * fee) / ((1 - a.piracy) * (1 - a.storm)), cash: ask * customs };
}

function charterPart(ctx: Ctx, a: PartArgs, charters: CharterInfo[]): Part | null {
  const { world, res, opts } = ctx;
  const est = world.estAsk(a.source, a.good, a.buyAt);
  if (!est || a.room < MIN_PART_TONS) return null;
  const reserved = res.sourceTons.get(`${a.source}|${a.good}`) ?? 0;
  // Re-posted charters outlive their expiry; the rest must still be open when the load lands.
  let usable = charters.filter((c) => c.expiresAt === null || c.expiresAt >= a.deliverBy || renewing(ctx, c));
  const t = new Map(usable.map((c) => [c.id, terms(ctx, c, a.arriveAt)]));
  const cashTons = Math.floor(a.cash / Math.max(costs(ctx, a, askFor(est, reserved, a.room)).cash, 1));
  const cap = Math.min(a.room, cashTons, offered(est, reserved));
  // The premium taper counts the delivery itself: about what this part could put into the charter.
  const cashOf = (c: CharterInfo) => charterCash(ctx, c, t.get(c.id)!.pay, a.arriveAt, Math.max(1, Math.min(cap, t.get(c.id)!.remaining)));
  // The bonus per ton is ranked at about the tons this part can put into the tier (the split's returns diminish).
  const refTons = Math.max(1, Math.min(a.room, a.bonusTons > 0 ? a.bonusTons : a.room));
  const value = (c: CharterInfo) => cashOf(c) + charterBonus(ctx, c, refTons, a.bonusExtra);
  usable.sort((x, y) => value(y) - value(x));

  // Rivals due at the port before we land: what they likely deliver of this good goes to the best-paying
  // charters first, counted once across them; laden ones of unknown cargo take a share of each public
  // charter's room, and of a crisis charter expected from public news (it can be raced too).
  const rivals = world.rivalLanding(a.dest, a.good, a.arriveAt);
  // The AI's "contested" ban: no public charter (nor one expected from public news) rivals are due at first.
  if (opts.bans?.contested && (rivals.tons > 0 || rivals.unknown > 0)) usable = usable.filter((c) => !c.isPublic && !c.provisional);
  const rivalTake = new Map<string, number>();
  let rivalLeft = rivals.tons;
  for (const c of usable) {
    const take = Math.min(rivalLeft, Math.max(0, t.get(c.id)!.remaining));
    if (take <= 0) break;
    rivalTake.set(c.id, take);
    rivalLeft -= take;
  }
  // Never below 40% of the room: arrival estimates are rough.
  const roomOf = (c: CharterInfo) => {
    // An expected crisis charter isn't listed yet: one ship's load on it at a time.
    if (c.provisional && (res.charterTons.get(c.id) ?? 0) > 0) return 0;
    const room = (t.get(c.id)!.remaining - (res.charterTons.get(c.id) ?? 0)) * trust(ctx, c);
    const share = c.isPublic || c.provisional ? 1 - RIVAL_CROWD_SHARE * rivals.unknown : 1;
    return Math.max(0, Math.floor(Math.max(room * 0.4, room * share - (rivalTake.get(c.id) ?? 0))));
  };
  const avail = Math.min(cap, usable.reduce((n, c) => n + roomOf(c), 0));
  const fullCost = costs(ctx, a, askFor(est, reserved, avail)).landed;

  let tons = 0;
  let cashTotal = 0;
  let bonusLeft = a.bonusTons;
  const bonusFills: Array<[CharterInfo, number]> = [];
  let minPay = Infinity;
  let cashPay = Infinity;
  let holdUntil: number | null = null;
  const fills: Array<[string, number]> = [];
  for (const c of usable) {
    if (value(c) - fullCost < opts.minMargin) break; // sorted by value: the rest are worth even less
    // The bonus may rank a charter, but its cash must cover the cost by itself.
    if (cashOf(c) < fullCost) continue;
    const take = Math.min(roomOf(c), cap - tons);
    if (take <= 0) continue;
    tons += take;
    cashTotal += take * cashOf(c);
    const hold = t.get(c.id)!.holdUntil;
    if (hold !== null) holdUntil = Math.max(holdUntil ?? 0, hold);
    if (world.expansionCharters.has(c.id)) {
      const b = Math.min(take, bonusLeft);
      if (b > 0) bonusFills.push([c, b]);
      bonusLeft = Math.max(0, bonusLeft - take);
    }
    minPay = Math.min(minPay, value(c));
    cashPay = Math.min(cashPay, cashOf(c));
    fills.push([c.id, take]);
    if (tons >= cap) break;
  }
  if (tons < MIN_PART_TONS) return null;
  const pay = cashTotal / tons;
  // The tier's bonus for every ton this part puts into it, counted together (the square-root split).
  const intoTier = bonusFills.reduce((n, [, b]) => n + b, 0);
  const bonusTotal = intoTier > 0 ? bonusFills.reduce((n, [c, b]) => n + b * charterBonus(ctx, c, intoTier, a.bonusExtra), 0) : 0;
  const bonus = bonusTotal / tons;
  const ask = askFor(est, reserved, tons);
  const costPerTon = costs(ctx, a, ask).landed;
  const margin = pay + bonus - costPerTon;
  if (margin < opts.minMargin || pay < costPerTon) return null;
  return {
    kind: "charter",
    good: a.good,
    tons,
    fills,
    pay: Math.round(pay),
    bonus: Math.round(bonus),
    minPay: Math.round(minPay),
    cashPay: Math.round(cashPay),
    estAsk: Math.round(ask),
    askKnown: est.known,
    costPerTon: Math.round(costPerTon),
    margin: Math.round(margin),
    holdUntil,
  };
}

function marketPart(ctx: Ctx, a: PartArgs): Part | null {
  const { world, res, opts } = ctx;
  const npcBid = expectedBid(ctx, a.dest, a.good, a.arriveAt);
  // A players' resting bid in the news above the buyers' (its tons, aged): sold into first, up to its tons.
  const player = playerBid(ctx, a.dest, a.good, npcBid, a.arriveAt);
  const bid = Math.max(npcBid ?? 0, player?.price ?? 0);
  const est = world.estAsk(a.source, a.good, a.buyAt);
  if (!bid || !est || a.room < MIN_PART_TONS) return null;
  // Cheap test before any sizing: the best case must clear the margin.
  if (bid - costs(ctx, a, bestAsk(est)).landed < opts.minMargin) return null;

  const reserved = res.sourceTons.get(`${a.source}|${a.good}`) ?? 0;
  const sold = res.sellTons.get(`${a.dest}|${a.good}`) ?? 0;
  // A live book shows how much its buyers take; otherwise assume a modest depth. The players' level adds its tons
  // (what our other ships sell there takes it first).
  const ladderDepth = npcBid === null ? 0 : (world.price(a.dest, a.good)?.bidDepth ?? MARKET_MAX_TONS);
  const max = Math.min(a.room, ladderDepth + (player?.tons ?? 0) - sold, offered(est, reserved));
  /** Average sale per ton for `tons` sold after our other ships' `sold`: the players' level first, then the buyers' falling bid. */
  const saleFor = (tons: number) => {
    const fromPlayer = player ? Math.min(tons, Math.max(0, player.tons - sold)) : 0;
    const rest = tons - fromPlayer;
    const ladder = (npcBid ?? 0) * (1 - SELL_IMPACT_PER_TON * (Math.max(0, sold - (player?.tons ?? 0)) + rest / 2));
    return (fromPlayer * (player?.price ?? 0) + rest * ladder) / tons;
  };
  // Profit falls per ton on both books: find the size that earns most.
  let best: { tons: number; sale: number; ask: number; landed: number; profit: number } | null = null;
  for (let tons = max; tons >= MIN_PART_TONS; tons -= Math.max(1, Math.round(max / 12))) {
    const ask = askFor(est, reserved, tons);
    const c = costs(ctx, a, ask);
    if (c.cash * tons > a.cash) continue;
    const sale = saleFor(tons);
    if (sale - c.landed < opts.minMargin) continue;
    const profit = tons * (sale - c.landed);
    if (!best || profit > best.profit) best = { tons, sale, ask, landed: c.landed, profit };
  }
  if (!best) return null;
  return {
    kind: "market",
    good: a.good,
    tons: best.tons,
    fills: [],
    pay: Math.round(best.sale),
    bonus: 0,
    minPay: Math.round(best.sale),
    cashPay: Math.round(best.sale),
    estAsk: Math.round(best.ask),
    askKnown: est.known,
    costPerTon: Math.round(best.landed),
    margin: Math.round(best.sale - best.landed),
    holdUntil: null,
  };
}

/**
 * Freight lots at `source` for `dest`, best reward per ton first, packed into the room and cash. Return freight (guide 3.8) only
 * while our companies' cap on it hasn't refused one lately (world.returnBlocked).
 */
function freightPicks(ctx: Ctx, source: string, dest: string, room: number, cash: number): FreightPick[] {
  const { world, res } = ctx;
  if (!ctx.opts.freight) return [];
  const retOk = !world.returnBlocked();
  const lots = world.freight
    .filter(
      (f) =>
        f.origin === source &&
        f.dest === dest &&
        !res.freightIds.has(f.id) &&
        // Never lots any of our player's companies issued (refused as same-player dealing).
        !world.ownIssued(f) &&
        (f.expiresAt === null || f.expiresAt >= ctx.now) &&
        f.tons > 0 &&
        (retOk || !f.ret),
    )
    .sort((a, b) => b.reward / b.tons - a.reward / a.tons);
  const picks: FreightPick[] = [];
  for (const f of lots) {
    if (f.tons > room || f.collateral > cash) continue;
    picks.push({ id: f.id, good: f.good, tons: f.tons, reward: f.reward, collateral: f.collateral, ...(f.ret ? { ret: true } : {}) });
    room -= f.tons;
    cash -= f.collateral;
  }
  return picks;
}

// ── Legs ──────────────────────────────────────────────────────────────────────

type Primary = { kind: "charter"; good: string; charters: CharterInfo[] } | { kind: "market"; good: string } | { kind: "freight" };

async function buildLeg(ctx: Ctx, from: string, source: string, dest: string, primary: Primary, cheap: boolean): Promise<Leg | null> {
  const { world, ship, opts } = ctx;
  // Lawful lanes never load or land at a smugglers' cove, nor carry contraband (guide 3.18); a ship may sail from one.
  if (world.isCove(source) || world.isCove(dest) || (primary.kind !== "freight" && world.isContraband(primary.good))) return null;
  let out: RoutePlan, dead: RoutePlan | null;
  try {
    [out, dead] = await Promise.all([
      world.route(source, dest, ship.shipClass),
      from === source ? Promise.resolve(null) : world.route(from, source, ship.shipClass),
    ]);
  } catch {
    return null;
  }
  if (!world.routeRated(out, ship.hull) || (dead && !world.routeRated(dead, ship.hull))) return null;
  // Zones the laden passage rolls for (kept on the lane), and the AI's zone bans on it and on the empty sail there.
  const zones = [...new Set(out.legs.map((l) => world.hazardZone(l.to_node)?.id).filter((z): z is string => !!z))];
  const banZ = opts.bans?.zones;
  if (banZ?.size && (zones.some((z) => banZ.has(z)) || dead?.legs.some((l) => banZ.has(world.hazardZone(l.to_node)?.id ?? "")))) return null;

  // Pirates go for the richest prizes. To price the goods, a first guess: the hold full of the main
  // good at its base price (freight: the lots here at about three times their collateral; return
  // freight at nothing, guide 3.8). The load actually chosen is re-judged below.
  const guessValue =
    primary.kind === "freight"
      ? world.freight.filter((f) => f.origin === source && f.dest === dest && !ctx.res.freightIds.has(f.id)).reduce((n, f) => n + freightLoot(f), 0)
      : ship.cap * world.basePrice(primary.good);
  const piracy = world.piracyRisk(out, ship.guns, ship.knots * 0.8, guessValue).cargoShare;
  const deadMs = dead ? world.sailMs(dead.total_distance_nm, ship.knots) : 0;
  const landsAt = ctx.now + deadMs + ctx.baseLockMs + ship.cap * world.handlingMsPerTon(source) + world.sailMs(out.total_distance_nm, ship.knots * 0.8);
  // Delivered once the destination's base lock clears.
  const arriveAt = landsAt + ctx.baseLockMs;
  const deliverBy = arriveAt + EXPIRY_SLACK_MS;
  // Bought once the source's base lock clears.
  const buyAt = ctx.now + deadMs + ctx.baseLockMs;
  // Storms don't care what's aboard: the share of the load expected destroyed on the laden passage
  // (judged in the season it sails in), and the chance of sinking; the empty sail there can sink it too.
  const sailsAt = buyAt + ship.cap * world.handlingMsPerTon(source);
  const storm = world.stormRisk(out, ship.hull, ship.knots * 0.8, sailsAt, opts.stormWeight ?? 1);
  const deadSink = dead ? world.stormRisk(dead, ship.hull, ship.knots, ctx.now, opts.stormWeight ?? 1).sink : 0;
  let bonusTons = ctx.bonusTons;
  let bonusExtra = ctx.bonusExtra;
  let room = ship.cap;
  // Bought once at the source: cash due by then may count (onward legs: cash in hand only).
  let cash = !cheap && opts.cashAt ? opts.cashAt(buyAt, source) : (opts.cash ?? Number.MAX_SAFE_INTEGER);
  const parts: Part[] = [];
  let freight: FreightPick[] = [];
  const args = (good: string): PartArgs => ({ source, dest, good, room, cash, piracy, storm: storm.cargoShare, deliverBy, arriveAt, buyAt, bonusTons, bonusExtra });
  const charterAt = (good: string) => ctx.charters.get(`${dest}|${good}`) ?? [];
  const take = (p: Part) => {
    parts.push(p);
    room -= p.tons;
    cash -= costs(ctx, args(p.good), p.estAsk).cash * p.tons;
    for (const [id, t] of p.fills) {
      if (!world.expansionCharters.has(id)) continue;
      // Later parts' bonus counts this part's tons as ours already (the split's returns diminish).
      bonusExtra += Math.min(t, bonusTons) * world.bonusUnit({ id, good: p.good });
      bonusTons = Math.max(0, bonusTons - t);
    }
  };

  // The main cargo.
  if (primary.kind === "charter") {
    const p = charterPart(ctx, args(primary.good), primary.charters);
    if (!p) return null;
    take(p);
  } else if (primary.kind === "market") {
    const p = marketPart(ctx, args(primary.good));
    if (!p) return null;
    take(p);
  } else {
    freight = freightPicks(ctx, source, dest, room, cash);
    if (freight.length === 0) return null;
    for (const f of freight) {
      room -= f.tons;
      cash -= f.collateral;
    }
  }

  // Fill the rest: other goods S sells that D wants, best margin per ton first, then freight to D.
  // (Onward estimates skip this: the main cargo is enough to rank a next leg.)
  const wanted = ctx.wanted.get(dest);
  if (!cheap && wanted && room >= MIN_PART_TONS) {
    const done = new Set(parts.map((p) => p.good));
    const options: Part[] = [];
    for (const good of world.goodsAt(source)) {
      if (done.has(good) || !wanted.has(good) || opts.bans?.goods.has(good)) continue;
      const c = charterPart(ctx, args(good), charterAt(good));
      const m = marketPart(ctx, args(good));
      const pick = c && m ? (c.margin >= m.margin ? c : m) : (c ?? m);
      if (pick) options.push(pick);
    }
    options.sort((a, b) => b.margin - a.margin);
    for (const o of options) {
      if (room < MIN_PART_TONS) break;
      // Sized again with the room and cash the better options left.
      const p = o.kind === "charter" ? charterPart(ctx, args(o.good), charterAt(o.good)) : marketPart(ctx, args(o.good));
      if (p && p.tons <= room) take(p);
    }
  }
  if (!cheap && primary.kind !== "freight" && room > 0) {
    freight = freightPicks(ctx, source, dest, room, cash);
    for (const f of freight) room -= f.tons;
  }

  const goodsTons = parts.reduce((n, p) => n + p.tons, 0);
  const freightTons = freight.reduce((n, f) => n + f.tons, 0);
  const tons = goodsTons + freightTons;
  if (tons < minLoadTons(ship.cap)) return null;

  const fill = tons / Math.max(ship.cap, 1);
  const marketTons = parts.filter((p) => p.kind === "market").reduce((n, p) => n + p.tons, 0);
  const loadMs = ctx.baseLockMs + tons * world.handlingMsPerTon(source);
  const ladenMs = world.sailMs(out.total_distance_nm, ship.knots * (1 - 0.2 * fill));
  // Charters and freight are delivered from the roadstead once the base lock clears; selling needs the berth.
  const unloadMs = ctx.baseLockMs + marketTons * world.handlingMsPerTon(dest);
  // A load held for a re-post waits at the destination until then.
  const landAt = ctx.now + deadMs + loadMs + ladenMs;
  const holdUntil = parts.reduce<number | null>((m, p) => (p.holdUntil === null ? m : Math.max(m ?? 0, p.holdUntil)), null);
  const holdMs = holdUntil === null ? 0 : Math.max(0, holdUntil - landAt);
  const ms = deadMs + loadMs + ladenMs + holdMs + unloadMs + LEG_OVERHEAD_MS;
  // Season end (guide 3.11): a leg must be delivered before it (charters and freight pay nothing after, cargo counts at base).
  if (!world.beforeSeasonEnd(ctx.now + ms - LEG_OVERHEAD_MS)) return null;
  // Berth dues (guide 3.3): the stay loading at the source (its minimum already paid when the ship is there)
  // and the one at the destination (a ship berths on arrival; a hold for a re-post waits in the roadstead).
  const dues = world.berthDuesFor(source, loadMs, from !== source) + world.berthDuesFor(dest, unloadMs);

  // The load as chosen, as the pirates see it: its share lost (captures included) and the chance
  // of losing the ship itself, at what it would cost to replace. Return freight draws no raid.
  const lootValue = parts.reduce((n, p) => n + p.tons * world.basePrice(p.good), 0) + freight.reduce((n, f) => n + freightLoot(f), 0);
  const risk = world.piracyRisk(out, ship.guns, ship.knots * 0.8, lootValue);
  const kept = (1 - risk.cargoShare) * (1 - storm.cargoShare);
  const captureCost = risk.capture * (ship.hullValue ?? 0);
  // A storm sinking loses the hull (its cargo is already in the storm share).
  const sinkCost = (storm.sink + deadSink) * (ship.hullValue ?? 0);
  // Sealed freight goes down with the ship on the laden passage (a sinking or a capture): its reward
  // unearned and its collateral forfeit (guide 3.6).
  const shipLost = Math.min(1, risk.capture + storm.sink);
  const freightPay = freight.reduce((n, f) => n + f.reward, 0);
  const freightReward = freight.reduce((n, f) => n + f.reward * (1 - shipLost) - f.collateral * shipLost, 0);
  // Per ton bought: what arrives earns its pay (and bonus); the cash paid at the source is the
  // landed cost without the first guess's piracy and storm markups.
  const paid = (p: Part) => p.costPerTon * (1 - piracy) * (1 - storm.cargoShare);
  const profit = parts.reduce((n, p) => n + p.tons * (kept * (p.pay + p.bonus) - paid(p)), 0) + freightReward - captureCost - sinkCost - dues;
  const cashProfit = parts.reduce((n, p) => n + p.tons * (kept * p.pay - paid(p)), 0) + freightReward - captureCost - sinkCost - dues;
  // Pirates taking the ship can make a load not worth carrying at all.
  if (profit <= 0) return null;
  const main = parts[0];
  const good = main?.good ?? freight[0]?.good ?? "";
  const kind: LaneKind = primary.kind;
  const sum = (f: (p: Part) => number) => parts.reduce((n, p) => n + f(p) * p.tons, 0);
  // Pay as listed, like the goods' (the risk is in the profit).
  const pay = (sum((p) => p.pay) + freightPay) / tons;
  const bonusAvg = sum((p) => p.bonus) / tons;
  const costPerTon = sum((p) => p.costPerTon) / tons;
  const capital = parts.reduce((n, p) => n + costs(ctx, args(p.good), p.estAsk).cash * p.tons, 0) + freight.reduce((n, f) => n + f.collateral, 0);

  return {
    profit,
    ms,
    lane: {
      key: kind === "freight" ? `freight:${source}>${dest}:${freight.map((f) => f.id.slice(0, 8)).join(",")}` : `${kind === "market" ? "market:" : ""}${good}:${source}>${dest}`,
      kind,
      source,
      dest,
      good,
      parts,
      freight,
      fills: parts.flatMap((p) => p.fills),
      tons,
      pay: Math.round(pay),
      bonus: Math.round(bonusAvg),
      costPerTon: Math.round(costPerTon),
      margin: Math.round(pay + bonusAvg - costPerTon),
      piracyBps: Math.round(piracy * 10_000),
      stormBps: Math.round(storm.cargoShare * 10_000),
      askKnown: main?.askKnown ?? true,
      cashProfit: Math.round(cashProfit),
      capital: Math.round(capital),
      holdMs: Math.round(holdMs),
      deliverAt: Math.round(ctx.now + ms - LEG_OVERHEAD_MS),
      deliverMs: ms,
      loopMs: ms,
      profitPerHour: Math.round(rate(profit, ms)),
      next: null,
      speculative: parts.some((p) => p.fills.some(([id]) => id.startsWith(PROVISIONAL_PREFIX))) || undefined,
      zones,
    },
  };
}

/** Every leg a ship could start from `from` (memoised per planning pass). */
function legsFrom(ctx: Ctx, from: string, cheap: boolean): Promise<Leg[]> {
  const key = `${from}|${cheap ? "main" : "full"}`;
  let p = ctx.legs.get(key);
  if (!p) {
    p = enumerateLegs(ctx, from, cheap);
    ctx.legs.set(key, p);
  }
  return p;
}

async function enumerateLegs(ctx: Ctx, from: string, cheap: boolean): Promise<Leg[]> {
  const { world } = ctx;
  // Re-sizing at a source: only legs loading there (onward legs from elsewhere are unaffected).
  const only = cheap ? undefined : ctx.opts.onlySource;
  // Insured for one voyage: only legs ending at its port (onward legs from there are free).
  const onlyDest = cheap ? undefined : ctx.opts.onlyDest;
  // The AI's bans (charters at banned ports, of banned goods or banned themselves are already out of ctx.charters).
  const bans = ctx.opts.bans;
  const portOk = (p: string) => !bans?.ports.has(p);
  const jobs: Array<Promise<Leg | null>> = [];

  // Charters (live and gossip) at each port, by good, from every port selling the good.
  for (const [k, charters] of ctx.charters) {
    const [dest, good] = k.split("|");
    if (onlyDest && dest !== onlyDest) continue;
    for (const source of world.sellersOf(good)) {
      if (source !== dest && (!only || source === only) && portOk(source)) jobs.push(buildLeg(ctx, from, source, dest, { kind: "charter", good, charters }, cheap));
    }
  }

  // Markets: for each good, the best few buyers (by bid) against the cheapest few sellers, plus ports
  // in a shortage or glut of it (tried on top of the best few, never in place of one: the shock may
  // fade before a ship gets there).
  for (const c of world.catalog.commodities) {
    // Contraband has no lawful market anywhere; a cove buys nothing for a lane (guide 3.18).
    if (bans?.goods.has(c.id) || world.isContraband(c.id)) continue;
    const bids = world.catalog.ports
      .filter((p) => world.isOpen(p.id) && !p.is_cove && world.trades(p.id, c.id) && portOk(p.id))
      .filter((p) => !onlyDest || p.id === onlyDest)
      .map((p) => {
        // A players' resting bid in the news above the buyers' counts too (marketPart sells into it up to its tons).
        const npc = expectedBid(ctx, p.id, c.id);
        const best = Math.max(npc ?? 0, playerBid(ctx, p.id, c.id, npc, ctx.now)?.price ?? 0);
        return { port: p.id, bid: best > 0 ? best : null };
      })
      .filter((b): b is { port: string; bid: number } => b.bid !== null)
      .sort((a, b) => b.bid - a.bid);
    const buyers = [...bids.slice(0, MARKET_TOP), ...bids.slice(MARKET_TOP).filter((b) => world.shortageAt(b.port, c.id))];
    if (buyers.length === 0) continue;
    const offers = world
      .sellersOf(c.id)
      .filter((port) => (!only || port === only) && portOk(port))
      .map((port) => ({ port, ask: world.estAsk(port, c.id) }))
      .filter((x): x is { port: string; ask: AskEst } => x.ask !== null)
      .map((x) => ({ port: x.port, cost: bestAsk(x.ask) * (1 + world.customsBps(x.port) / 10_000) }))
      .sort((a, b) => a.cost - b.cost);
    const sellers = [...offers.slice(0, MARKET_TOP), ...offers.slice(MARKET_TOP).filter((s) => world.glutAt(s.port, c.id))];
    for (const s of sellers) {
      for (const b of buyers) {
        // Skip pairs that can't clear the margin even before the costs that need a route.
        if (b.port === s.port || b.bid - s.cost < ctx.opts.minMargin) continue;
        jobs.push(buildLeg(ctx, from, s.port, b.port, { kind: "market", good: c.id }, cheap));
      }
    }
  }

  // Freight listed here, by destination.
  if (ctx.opts.freight && portOk(from)) {
    for (const dest of new Set(world.freight.filter((f) => f.origin === from).map((f) => f.dest))) {
      if (dest !== from && world.isOpen(dest) && portOk(dest) && (!onlyDest || dest === onlyDest) && (!only || from === only)) jobs.push(buildLeg(ctx, from, from, dest, { kind: "freight" }, cheap));
    }
  }

  const legs = (await Promise.all(jobs)).filter((l): l is Leg => l !== null);
  // The same source → destination load can be reached from several mains: keep the best.
  const best = new Map<string, Leg>();
  for (const l of legs) {
    const prev = best.get(l.lane.key);
    if (!prev || rate(l.profit, l.ms) > rate(prev.profit, prev.ms)) best.set(l.lane.key, l);
  }
  return [...best.values()].sort((a, b) => rate(b.profit, b.ms) - rate(a.profit, a.ms));
}

function describe(l: Lane): string {
  return `${l.kind === "freight" ? "freight" : `${l.tons} t ${l.good}${l.kind === "market" ? " to sell" : ""}`} ${l.source} → ${l.dest}`;
}

/** Whether an onward leg would only redo this leg's work (same charters, same buyers). */
function overlaps(a: Lane, b: Lane): boolean {
  if (a.key === b.key) return true;
  const ids = new Set(a.fills.map(([id]) => id));
  if (b.fills.some(([id]) => ids.has(id))) return true;
  const sales = new Set(a.parts.filter((p) => p.kind === "market").map((p) => `${a.dest}|${p.good}`));
  return b.parts.some((p) => p.kind === "market" && sales.has(`${b.dest}|${p.good}`));
}

// ── Ranking ───────────────────────────────────────────────────────────────────

export async function rankLanes(world: World, ship: ShipSpec, from: string, res: Reservations, opts: PlanOptions): Promise<Lane[]> {
  if (ship.cap <= 0) return [];
  let reservedExpansion = 0;
  let bonusExtra = 0;
  for (const [id, t] of res.charterTons) {
    if (!world.renews({ id })) continue;
    reservedExpansion += t;
    // Our other ships' loads for the tier: the bonus split counts them as ours (a charter no longer listed: its good unknown, skipped).
    const c = world.charters.find((x) => x.id === id);
    if (c) bonusExtra += t * world.bonusUnit(c);
  }
  const ctx: Ctx = {
    world,
    ship,
    res,
    opts,
    now: world.now(),
    baseLockMs: 30 * world.gameMinuteMs,
    gameDayMs: 24 * 60 * world.gameMinuteMs,
    bonusTons: Math.max(0, world.expansionTonsLeft - reservedExpansion),
    bonusExtra,
    charterEarned: world.charterEarnings(),
    charters: new Map(),
    wanted: new Map(),
    legs: new Map(),
  };
  const want = (port: string, good: string) => {
    let set = ctx.wanted.get(port);
    if (!set) ctx.wanted.set(port, (set = new Set()));
    set.add(good);
  };
  const bans = opts.bans;
  for (const c of world.charters) {
    // Never our own player's charters (their deliveries are refused).
    if (!world.isOpen(c.port) || c.remaining <= 0 || (c.stale && trust(ctx, c) <= GOSSIP_TRUST_MIN) || !world.deliverable(c)) continue;
    // Charters refuse contraband, and lawful lanes never land at a cove (guide 3.18).
    if (world.isCove(c.port) || world.isContraband(c.good)) continue;
    if (bans && (bans.ports.has(c.port) || bans.goods.has(c.good) || bans.charters.has(world.currentId(c.id)))) continue;
    const k = `${c.port}|${c.good}`;
    ctx.charters.set(k, [...(ctx.charters.get(k) ?? []), c]);
    want(c.port, c.good);
  }
  for (const p of world.catalog.ports) {
    // A cove wants nothing a lawful lane brings; contraband is wanted only by the Underworld (expectedBid: null).
    if (!world.isOpen(p.id) || p.is_cove) continue;
    for (const g of [...(p.imports ?? []), ...(p.produces ?? []), ...(p.manufactures ?? []), "provisions"]) {
      if (!world.isContraband(g) && expectedBid(ctx, p.id, g) !== null) want(p.id, g);
    }
  }

  const legs = await legsFrom(ctx, from, false);
  // Fetched together: return routes for every leg, onward legs from the best legs' destinations.
  const [backs] = await Promise.all([
    Promise.all(legs.map((l) => world.route(l.lane.dest, l.lane.source, ship.shipClass).catch(() => null))),
    Promise.all([...new Set(legs.slice(0, ONWARD_TOP).map((l) => l.lane.dest))].map((d) => legsFrom(ctx, d, true))),
  ]);
  const lanes: Lane[] = [];
  for (const [i, leg] of legs.entries()) {
    // What comes after: an empty sail back to the source, or (for the best legs) the best leg seen
    // from the destination that doesn't just redo this one, whichever rates higher.
    const back = backs[i];
    let profit = leg.profit;
    let ms = leg.ms + (back ? world.sailMs(back.total_distance_nm, ship.knots) : leg.ms);
    let next: string | null = null;
    if (i < ONWARD_TOP) {
      const onward = (await legsFrom(ctx, leg.lane.dest, true)).find((l) => l.profit > 0 && !overlaps(leg.lane, l.lane) && !(opts.noSpeculativeOnward && l.lane.speculative));
      if (onward && rate(leg.profit + onward.profit, leg.ms + onward.ms) > rate(profit, ms)) {
        profit = leg.profit + onward.profit;
        ms = leg.ms + onward.ms;
        next = describe(onward.lane);
      }
    }
    lanes.push({ ...leg.lane, loopMs: ms, profitPerHour: Math.round(rate(profit, ms)), next });
  }
  // Scarce cash: what a load ties up is charged at the fleet's return on cash.
  const charge = opts.capitalRate ?? 0;
  // The AI's bias scales only lanes that score above zero, so it can't turn a loser into a pick.
  const score = (l: Lane) => {
    const base = l.profitPerHour - charge * l.capital;
    return base > 0 && opts.bias ? base * Math.min(1.5, Math.max(0.5, opts.bias(l))) : base;
  };
  return lanes.sort((a, b) => score(b) - score(a));
}

/** A lane for cargo already aboard (restart at sea, leftovers): carry it to one charter. */
export function cargoLane(good: string, source: string, dest: string, charterId: string, tons: number, pay: number): Lane {
  const part: Part = {
    kind: "charter",
    good,
    tons,
    fills: [[charterId, tons]],
    pay,
    bonus: 0,
    minPay: pay,
    cashPay: pay,
    estAsk: 0,
    askKnown: false,
    costPerTon: 0,
    margin: 0,
    holdUntil: null,
  };
  return {
    key: `${good}:${source}>${dest}`,
    kind: "charter",
    source,
    dest,
    good,
    parts: [part],
    freight: [],
    fills: part.fills,
    tons,
    pay,
    bonus: 0,
    costPerTon: 0,
    margin: 0,
    piracyBps: 0,
    stormBps: 0,
    askKnown: false,
    cashProfit: 0,
    capital: 0,
    holdMs: 0,
    deliverAt: 0,
    deliverMs: 0,
    loopMs: 0,
    profitPerHour: 0,
    next: null,
  };
}
