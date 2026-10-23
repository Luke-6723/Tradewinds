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
 *   freight  Merchant Adventurers lots listed at the ship's own port, carried sealed to D.
 *
 * Whatever room and cash the first choice leaves is filled ("mixed loads") with other goods S sells
 * that D's charters or buyers want, best margin per ton first, and with freight lots from S to D.
 *
 * Costs per ton: the ask (with the impact of what we and our other ships buy there), customs at S,
 * the fee to bring the money from D's region back to S's, and the share of the load pirates are
 * expected to take on the way. Charters count a weighted share of the phase-completion bonus, but
 * their cash pay must cover the cost by itself. Loads are capped by hold room and spare cash.
 *
 * Expansion charters are re-posted when they lapse, so their expiry doesn't end them: a load landing
 * after it is valued at the re-post's terms (richer, on fewer tons, when the posting looks stalled).
 * With holding allowed, a load landing shortly before a stalled posting lapses may wait for it.
 *
 * Lanes are ranked by profit per real hour over the leg plus the best leg visible from D, so a lane
 * that ends where a paid return cargo waits beats one ending in a dead end. With nothing paying from
 * D, an empty sail back to S stands in for what comes next. When cash is what limits the fleet, the
 * money a load ties up is charged at the fleet's own return on cash, so thin-margin loads that lock
 * up a lot of it rank lower.
 */

import type { RoutePlan, ZoneClass } from "../types";
import { BID_HAIRCUT_BASE, type CharterInfo, type World } from "./world";

export interface ShipSpec {
  shipClass: string;
  hull: ZoneClass;
  /** Unladen speed, knots. */
  knots: number;
  /** Cargo room once guns, stores and sealed freight are aboard. */
  cap: number;
  guns: number;
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
  /** Landed cost per ton: ask + customs + remittance fee + expected piracy loss. */
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

export interface PlanOptions {
  /** Minimum profit per ton (pence) after every cost. */
  minMargin: number;
  /** Carry Merchant Adventurers freight (as a lane or to fill spare room). */
  freight: boolean;
  /** 0–1: how much of the expected phase-completion bonus to count. */
  bonusWeight: number;
  /** Pence the fleet can spend on this load, or null for no limit. */
  cash: number | null;
  /** Charge per pence of cash a load ties up, per real hour (0 while cash isn't scarce). */
  capitalRate?: number;
  /** Wait at the destination for a stalled expansion charter's richer re-post when it lapses soon after arrival. */
  holdForRepost?: boolean;
  /**
   * A multiplier on a lane's rank (the AI advisor's lane bias). It only reorders lanes that already
   * passed every check and earn something; it never makes a lane eligible.
   */
  bias?: (lane: Lane) => number;
  /** Per expansion charter (`port|good`): wait for a stalled posting's re-post, or deliver now (AI stall calls). */
  stallCalls?: Map<string, "wait" | "deliver">;
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
/** Bids seen longer ago than this (game hours) aren't planned on. */
const MARKET_MAX_AGE_GAME_H = 72;
// A remembered bid is marked down by World's BID_HAIRCUT_BASE, plus its learned rate per game day of age.
/** A gossiped charter's chance of still being open: this when fresh, less per game day of age. */
const GOSSIP_TRUST_MAX = 0.85;
const GOSSIP_TRUST_PER_DAY = 0.15;
const GOSSIP_TRUST_MIN = 0.15;
/** A ton's worth at a gossiped charter's port if the charter is gone and no bid is known there. */
const SALVAGE_OF_BASE = 0.6;
/** Each laden rival seen bound for a public charter's port before we land takes this share of its room (to at most 60%). */
const RIVAL_CROWD_SHARE = 0.15;
/** Longest wait (game hours) for a stalled posting to lapse and re-post richer. */
export const HOLD_MAX_GAME_H = 4;
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

/** The bid a sale at `port` can count on: a live book as seen, older news marked down; null if too old. */
function expectedBid(ctx: Ctx, port: string, good: string): number | null {
  const obs = ctx.world.price(port, good);
  if (!obs?.bid) return null;
  const age = Math.max(0, ctx.now - obs.at);
  if (age > MARKET_MAX_AGE_GAME_H * 60 * ctx.world.gameMinuteMs) return null;
  const fresh = obs.live && age < 60 * ctx.world.gameMinuteMs;
  const haircut = fresh ? 0 : BID_HAIRCUT_BASE + ctx.world.bidHaircutPerDay * (age / ctx.gameDayMs);
  return obs.bid * Math.max(0, 1 - haircut);
}

/** 1 for a live charter; for gossip, the chance it is still open. */
function trust(ctx: Ctx, c: CharterInfo): number {
  if (!c.stale) return 1;
  const ageDays = c.newsAt ? Math.max(0, ctx.now - c.newsAt) / ctx.gameDayMs : 2;
  return Math.max(GOSSIP_TRUST_MIN, Math.min(GOSSIP_TRUST_MAX, GOSSIP_TRUST_MAX - GOSSIP_TRUST_PER_DAY * ageDays));
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
 * terms, weighted by the chance the stall lasts; one landing shortly before it may wait for it.
 */
function terms(ctx: Ctx, c: CharterInfo, arriveAt: number): Terms {
  const plain = { pay: c.payPerTon, remaining: c.remaining, holdUntil: null };
  const w = c.expiresAt === null || !renewing(ctx, c) ? undefined : ctx.world.stallWatch(c);
  if (!w || c.expiresAt === null) return plain;
  const esc = ctx.world.escalation;
  // One of our own ships delivering before the lapse ends the stall; so does an AI call to deliver.
  const ours = ctx.res.charterLandsAt?.get(c.id);
  const call = ctx.opts.stallCalls?.get(`${c.port}|${c.good}`);
  const stalled = w.stalled && call !== "deliver" && !(ours !== undefined && ours < c.expiresAt);
  // How often stalls seen lapse did re-post richer (learned).
  const p = stalled ? ctx.world.stallSurvives : 0;
  const reposted = {
    pay: Math.round(c.payPerTon * (1 + (esc.pay - 1) * p)),
    remaining: Math.floor(c.remaining * (1 - (1 - esc.tons) * p)),
  };
  if (arriveAt > c.expiresAt) return { ...reposted, holdUntil: null };
  const holdMax = HOLD_MAX_GAME_H * 60 * ctx.world.gameMinuteMs;
  if ((ctx.opts.holdForRepost || call === "wait") && stalled && c.expiresAt - arriveAt <= holdMax) {
    return { ...reposted, holdUntil: c.expiresAt + REPOST_GRACE_GAME_MIN * ctx.world.gameMinuteMs };
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

/** Expected cash per ton for a charter: its pay if open, else what the goods fetch at its port. */
function charterCash(ctx: Ctx, c: CharterInfo, pay = c.payPerTon): number {
  const t = trust(ctx, c);
  if (t >= 1) return pay;
  const salvage = expectedBid(ctx, c.port, c.good) ?? ctx.world.basePrice(c.good) * SALVAGE_OF_BASE;
  return t * pay + (1 - t) * Math.min(salvage, pay);
}

function charterBonus(ctx: Ctx, c: CharterInfo): number {
  return Math.round(ctx.world.charterBonus(c) * ctx.opts.bonusWeight * trust(ctx, c));
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
  /** Server time the load can be delivered by (charters closing sooner are skipped). */
  deliverBy: number;
  /** Expected server time of delivery: landing plus the base lock (without the safety slack in deliverBy). */
  arriveAt: number;
  /** Phase-bonus tons still unclaimed in this lane (read only: taking a part claims them). */
  bonusTons: number;
}

/** Landed cost per ton delivered at `ask`, and the cash it takes at the source per ton bought. */
function costs(ctx: Ctx, a: PartArgs, ask: number) {
  const customs = 1 + ctx.world.customsBps(a.source) / 10_000;
  const fee = 1 + ctx.world.remitBps(ctx.world.region(a.dest), ctx.world.region(a.source)) / 10_000;
  return { landed: (ask * customs * fee) / (1 - a.piracy), cash: ask * customs };
}

function charterPart(ctx: Ctx, a: PartArgs, charters: CharterInfo[]): Part | null {
  const { world, res, opts } = ctx;
  const est = world.estAsk(a.source, a.good);
  if (!est || a.room < MIN_PART_TONS) return null;
  const reserved = res.sourceTons.get(`${a.source}|${a.good}`) ?? 0;
  // Re-posted charters outlive their expiry; the rest must still be open when the load lands.
  const usable = charters.filter((c) => c.expiresAt === null || c.expiresAt >= a.deliverBy || renewing(ctx, c));
  const t = new Map(usable.map((c) => [c.id, terms(ctx, c, a.arriveAt)]));
  const cashOf = (c: CharterInfo) => charterCash(ctx, c, t.get(c.id)!.pay);
  const value = (c: CharterInfo) => cashOf(c) + charterBonus(ctx, c);
  usable.sort((x, y) => value(y) - value(x));

  const cashTons = Math.floor(a.cash / Math.max(costs(ctx, a, est.ask * (1 + IMPACT_PER_TON * (reserved + a.room / 2))).cash, 1));
  const cap = Math.min(a.room, cashTons);
  // Public charters can be raced: laden rivals seen bound for the port before we land take some of the room.
  const crowd = (c: CharterInfo) => (c.isPublic ? Math.max(0.4, 1 - RIVAL_CROWD_SHARE * world.rivalsLanding(c.port, a.arriveAt)) : 1);
  const roomOf = (c: CharterInfo) =>
    Math.max(0, Math.floor((t.get(c.id)!.remaining - (res.charterTons.get(c.id) ?? 0)) * trust(ctx, c) * crowd(c)));
  const avail = Math.min(cap, usable.reduce((n, c) => n + roomOf(c), 0));
  const fullCost = costs(ctx, a, est.ask * (1 + IMPACT_PER_TON * (reserved + avail / 2))).landed;

  let tons = 0;
  let cashTotal = 0;
  let bonusTotal = 0;
  let bonusLeft = a.bonusTons;
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
      bonusTotal += Math.min(take, bonusLeft) * charterBonus(ctx, c);
      bonusLeft = Math.max(0, bonusLeft - take);
    }
    minPay = Math.min(minPay, value(c));
    cashPay = Math.min(cashPay, cashOf(c));
    fills.push([c.id, take]);
    if (tons >= cap) break;
  }
  if (tons < MIN_PART_TONS) return null;
  const pay = cashTotal / tons;
  const bonus = bonusTotal / tons;
  const ask = est.ask * (1 + IMPACT_PER_TON * (reserved + tons / 2));
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
  const bid = expectedBid(ctx, a.dest, a.good);
  const est = world.estAsk(a.source, a.good);
  if (!bid || !est || a.room < MIN_PART_TONS) return null;
  // Cheap test before any sizing: the best case must clear the margin.
  if (bid - costs(ctx, a, est.ask).landed < opts.minMargin) return null;

  const reserved = res.sourceTons.get(`${a.source}|${a.good}`) ?? 0;
  const sold = res.sellTons.get(`${a.dest}|${a.good}`) ?? 0;
  // A live book shows how much its buyers take; otherwise assume a modest depth.
  const depth = world.price(a.dest, a.good)?.bidDepth ?? MARKET_MAX_TONS;
  const max = Math.min(a.room, depth - sold);
  // Profit falls per ton on both books: find the size that earns most.
  let best: { tons: number; sale: number; ask: number; landed: number; profit: number } | null = null;
  for (let tons = max; tons >= MIN_PART_TONS; tons -= Math.max(1, Math.round(max / 12))) {
    const ask = est.ask * (1 + IMPACT_PER_TON * (reserved + tons / 2));
    const c = costs(ctx, a, ask);
    if (c.cash * tons > a.cash) continue;
    const sale = bid * (1 - SELL_IMPACT_PER_TON * (sold + tons / 2));
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

/** Freight lots at `source` for `dest`, best reward per ton first, packed into the room and cash. */
function freightPicks(ctx: Ctx, source: string, dest: string, room: number, cash: number): FreightPick[] {
  const { world, res } = ctx;
  if (!ctx.opts.freight) return [];
  const lots = world.freight
    .filter(
      (f) =>
        f.origin === source &&
        f.dest === dest &&
        !res.freightIds.has(f.id) &&
        f.issuer !== world.companyId &&
        (f.expiresAt === null || f.expiresAt >= ctx.now) &&
        f.tons > 0,
    )
    .sort((a, b) => b.reward / b.tons - a.reward / a.tons);
  const picks: FreightPick[] = [];
  for (const f of lots) {
    if (f.tons > room || f.collateral > cash) continue;
    picks.push({ id: f.id, good: f.good, tons: f.tons, reward: f.reward, collateral: f.collateral });
    room -= f.tons;
    cash -= f.collateral;
  }
  return picks;
}

// ── Legs ──────────────────────────────────────────────────────────────────────

type Primary = { kind: "charter"; good: string; charters: CharterInfo[] } | { kind: "market"; good: string } | { kind: "freight" };

async function buildLeg(ctx: Ctx, from: string, source: string, dest: string, primary: Primary, cheap: boolean): Promise<Leg | null> {
  const { world, ship, opts } = ctx;
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

  const piracy = world.piracyLoss(out, ship.guns, ship.knots * 0.8);
  const deadMs = dead ? world.sailMs(dead.total_distance_nm, ship.knots) : 0;
  const landsAt = ctx.now + deadMs + ctx.baseLockMs + ship.cap * world.handlingMsPerTon(source) + world.sailMs(out.total_distance_nm, ship.knots * 0.8);
  // Delivered once the destination's base lock clears.
  const arriveAt = landsAt + ctx.baseLockMs;
  const deliverBy = arriveAt + EXPIRY_SLACK_MS;
  let bonusTons = ctx.bonusTons;
  let room = ship.cap;
  let cash = opts.cash ?? Number.MAX_SAFE_INTEGER;
  const parts: Part[] = [];
  let freight: FreightPick[] = [];
  const args = (good: string): PartArgs => ({ source, dest, good, room, cash, piracy, deliverBy, arriveAt, bonusTons });
  const charterAt = (good: string) => ctx.charters.get(`${dest}|${good}`) ?? [];
  const take = (p: Part) => {
    parts.push(p);
    room -= p.tons;
    cash -= costs(ctx, args(p.good), p.estAsk).cash * p.tons;
    for (const [id, t] of p.fills) if (world.expansionCharters.has(id)) bonusTons = Math.max(0, bonusTons - t);
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
      if (done.has(good) || !wanted.has(good)) continue;
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
  if (tons < Math.min(10, ship.cap * 0.5)) return null;

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

  const kept = 1 - piracy;
  const freightReward = freight.reduce((n, f) => n + f.reward, 0);
  const profit = parts.reduce((n, p) => n + p.tons * kept * p.margin, 0) + freightReward;
  const cashProfit = parts.reduce((n, p) => n + p.tons * (kept * (p.pay - p.costPerTon)), 0) + freightReward;
  const main = parts[0];
  const good = main?.good ?? freight[0]?.good ?? "";
  const kind: LaneKind = primary.kind;
  const sum = (f: (p: Part) => number) => parts.reduce((n, p) => n + f(p) * p.tons, 0);
  const pay = (sum((p) => p.pay) + freightReward) / tons;
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
      askKnown: main?.askKnown ?? true,
      cashProfit: Math.round(cashProfit),
      capital: Math.round(capital),
      holdMs: Math.round(holdMs),
      deliverAt: Math.round(ctx.now + ms - LEG_OVERHEAD_MS),
      deliverMs: ms,
      loopMs: ms,
      profitPerHour: Math.round(rate(profit, ms)),
      next: null,
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
  const jobs: Array<Promise<Leg | null>> = [];

  // Charters (live and gossip) at each port, by good, from every port selling the good.
  for (const [k, charters] of ctx.charters) {
    const [dest, good] = k.split("|");
    for (const source of world.sellersOf(good)) {
      if (source !== dest) jobs.push(buildLeg(ctx, from, source, dest, { kind: "charter", good, charters }, cheap));
    }
  }

  // Markets: for each good, the best few buyers (by bid) against the cheapest few sellers.
  for (const c of world.catalog.commodities) {
    const buyers = world.catalog.ports
      .filter((p) => world.isOpen(p.id) && world.trades(p.id, c.id))
      .map((p) => ({ port: p.id, bid: expectedBid(ctx, p.id, c.id) }))
      .filter((b): b is { port: string; bid: number } => b.bid !== null)
      .sort((a, b) => b.bid - a.bid)
      .slice(0, MARKET_TOP);
    if (buyers.length === 0) continue;
    const sellers = world
      .sellersOf(c.id)
      .map((port) => ({ port, ask: world.estAsk(port, c.id) }))
      .filter((x): x is { port: string; ask: { ask: number; known: boolean } } => x.ask !== null)
      .map((x) => ({ port: x.port, cost: x.ask.ask * (1 + world.customsBps(x.port) / 10_000) }))
      .sort((a, b) => a.cost - b.cost)
      .slice(0, MARKET_TOP);
    for (const s of sellers) {
      for (const b of buyers) {
        // Skip pairs that can't clear the margin even before the costs that need a route.
        if (b.port === s.port || b.bid - s.cost < ctx.opts.minMargin) continue;
        jobs.push(buildLeg(ctx, from, s.port, b.port, { kind: "market", good: c.id }, cheap));
      }
    }
  }

  // Freight listed here, by destination.
  if (ctx.opts.freight) {
    for (const dest of new Set(world.freight.filter((f) => f.origin === from).map((f) => f.dest))) {
      if (dest !== from && world.isOpen(dest)) jobs.push(buildLeg(ctx, from, from, dest, { kind: "freight" }, cheap));
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
  for (const [id, t] of res.charterTons) if (world.renews({ id })) reservedExpansion += t;
  const ctx: Ctx = {
    world,
    ship,
    res,
    opts,
    now: world.now(),
    baseLockMs: 30 * world.gameMinuteMs,
    gameDayMs: 24 * 60 * world.gameMinuteMs,
    bonusTons: Math.max(0, world.expansionTonsLeft - reservedExpansion),
    charters: new Map(),
    wanted: new Map(),
    legs: new Map(),
  };
  const want = (port: string, good: string) => {
    let set = ctx.wanted.get(port);
    if (!set) ctx.wanted.set(port, (set = new Set()));
    set.add(good);
  };
  for (const c of world.charters) {
    if (!world.isOpen(c.port) || c.remaining <= 0 || (c.stale && trust(ctx, c) <= GOSSIP_TRUST_MIN)) continue;
    const k = `${c.port}|${c.good}`;
    ctx.charters.set(k, [...(ctx.charters.get(k) ?? []), c]);
    want(c.port, c.good);
  }
  for (const p of world.catalog.ports) {
    if (!world.isOpen(p.id)) continue;
    for (const g of [...(p.imports ?? []), ...(p.produces ?? []), ...(p.manufactures ?? []), "provisions"]) {
      if (expectedBid(ctx, p.id, g) !== null) want(p.id, g);
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
      const onward = (await legsFrom(ctx, leg.lane.dest, true)).find((l) => l.profit > 0 && !overlaps(leg.lane, l.lane));
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
