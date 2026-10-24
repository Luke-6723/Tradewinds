/**
 * Shared view of the game world for the fleet autopilot: catalog, server clock, open charters,
 * vaults, remittance fees, cached routes and everything learned about prices (live books where we
 * have presence, coffee-house gossip elsewhere). One instance per company, refreshed by the manager.
 */

import type { KibbClient } from "../client";
import { RivalTracker, type Sighting } from "../rivals";
import type {
  BankingRegion,
  Catalog,
  CatalogPort,
  CatalogShipClass,
  ContractListing,
  ExpansionTier,
  PortDetail,
  PortOrderBook,
  RoutePlan,
  ZoneClass,
} from "../types";

export const ZONE_RANK: Record<ZoneClass, number> = { coastal: 0, regional: 1, oceanic: 2 };

/** A gossip or snapshot price older than this is treated as unknown. */
const PRICE_TTL_MS = 3 * 60 * 60 * 1000;
/** An empty ask side counts as "sold out" for one NPC re-quote (6 game hours; real ms at 60×). */
const SOLD_OUT_MS = 6 * 60 * 1000;
/** A charter last seen live is recalled for this long (2 game days; real ms at 60×). */
const RECALL_MS = 2 * 24 * 60 * 1000;
/**
 * Piracy since the October patch (formulas not published, so these are estimates the fleet refines
 * from its own raids): pirates go for the richest prizes, take a varying share of the cargo, and
 * sometimes the ship itself. A raid's take starts at this guess and is learned from our raids.
 */
const RAID_TAKE_PRIOR = 0.3;
const RAID_TAKE_PRIOR_N = 5;
/** Attention: a cargo worth this (pence) draws the zone's raw piracy; richer more, cheaper less, empty almost none. */
const ATTENTION_REF_PENCE = 1_000_000;
const ATTENTION_MIN = 0.1;
const ATTENTION_MAX = 3;
/** Chance a raid takes the ship (cargo and all), unarmed; each gun cuts it sharply. */
const CAPTURE_PER_RAID = 0.15;
const CAPTURE_GUN_CUT = 0.6;
/** Assumed cut in interception odds per gun ("cut sharply by cannons"; the formula isn't published). */
const GUN_DETERRENCE = 0.5;
/**
 * A tier's completion bonus is 12% of its value, split by the value each company delivered. Shares
 * value a ton at its charter's premium-inclusive rate (base price × premium), which the live share
 * movements bear out; this is the fallback rate when the pool can't be projected.
 */
const EXPANSION_BONUS_SHARE = 0.12;
/**
 * A posting nobody delivers to before it lapses is re-posted richer: by default +25% pay on 75% of
 * the tons left (refined from what the feed shows when an escalation happens).
 */
const ESCALATION_PAY = 1.25;
const ESCALATION_TONS = 0.75;
/** Our own watch calls a posting stalled only after following it from its start for this long (game hours). */
const STALL_MIN_WATCH_GAME_H = 6;
/** Tier pace is measured over at most this much real time. */
const TIER_PACE_WINDOW_MS = 2 * 60 * 60 * 1000;
/** ...and needs at least this much before it is trusted. */
const TIER_PACE_MIN_MS = 10 * 60 * 1000;

/** An expansion posting that dropped out of the listing after its lapse, awaiting its re-post. */
interface LapsedPosting {
  id: string;
  expiresAt: number | null;
  /** It was stalled late in its window, and its escalation count then (to learn whether the stall held). */
  lateStalled?: boolean;
  escalations?: number;
}

/** What the world model had learned, saved so a restart doesn't start blind. */
export interface WorldSnapshot {
  prices: Array<[string, PriceObs]>;
  expansionWatch: Array<[string, ExpansionWatch]>;
  escalation: { pay: number; tons: number };
  tierSamples: Array<{ at: number; delivered: number; phase: number }>;
  tierTargetPhase: number | null;
  tierTurnedAt: number | null;
  repostOf: Array<[string, string]>;
  lapsedPostings: Array<[string, LapsedPosting]>;
  liveSeen: Array<[string, { c: CharterInfo; seenAt: number }]>;
  closed: string[];
  sightings: Sighting[];
  /** Learned figures (calibrators): stalled postings seen lapse and whether they escalated; bid drift samples. */
  stallFates?: { escalated: number; not: number };
  bidSamples?: Array<[ageDays: number, ratio: number]>;
  raidTakes?: number[];
  captures?: number;
}

/** Ids of closed charters kept in a snapshot (the newest). */
const SNAPSHOT_CLOSED = 1_000;
/** A stalled posting this close to its lapse (game hours) counts towards the stall-survival figure. */
const LATE_STALL_GAME_H = 2;
/** Prior for the stall-survival odds: as if this many lapses had been seen at 75%. */
const STALL_PRIOR_N = 4;
const STALL_PRIOR_P = 0.75;
/** Bid drift: per-game-day markdown used until enough samples are in, bounds, and samples kept. */
const BID_HAIRCUT_DEFAULT = 0.03;
/** Every remembered bid is marked down this much before its age is counted (the planner adds the per-day rate). */
export const BID_HAIRCUT_BASE = 0.03;
const BID_SAMPLES_MIN = 10;
const BID_SAMPLES_MAX = 200;

/** One expansion charter as the autopilot watches it across its postings. */
export interface ExpansionWatch {
  /** The current posting's contract id. */
  id: string;
  port: string;
  good: string;
  /** Pay per ton now, and tons it still takes. */
  rate: number;
  remaining: number;
  expiresAt: number | null;
  escalations: number;
  /** Beyond coastal water from every home: a starter hoy can't reach it. */
  beyondCoastal: boolean;
  /** Tons delivered across its postings. */
  deliveredTotal: number;
  /** Nothing delivered in this posting so far (as far as we can tell): it re-posts richer if that lasts. */
  stalled: boolean;
  /** Seen stalled within a couple of game hours of its lapse (for learning how often stalls hold). */
  lateStalled?: boolean;
  /** One of our own ships delivered to this posting: its fate says nothing about rivals. */
  ourDelivery?: boolean;
  /** When we first saw this posting (server ms) and its delivered total then. */
  postingSeenAt: number;
  postingBase: number;
  /** We saw this posting replace the previous one, so postingBase is its start. */
  sawStart: boolean;
}

export interface CharterInfo {
  id: string;
  port: string;
  good: string;
  payPerTon: number;
  remaining: number;
  expiresAt: number | null;
  /** Second-hand news: `remaining` may be out of date, the charter may already be filled. */
  stale: boolean;
  /** Listed to everyone (expansion/Admiralty): absent from an open listing means closed. */
  isPublic: boolean;
  title: string;
  /** For gossip: server time the news describes (it may since have been filled). */
  newsAt: number | null;
}

/** An open freight lot we can see (listed only at its origin port, to companies present there). */
export interface FreightInfo {
  id: string;
  origin: string;
  dest: string;
  good: string;
  tons: number;
  reward: number;
  collateral: number;
  expiresAt: number | null;
  issuer: string | null;
}

function toFreight(list: ContractListing[]): FreightInfo[] {
  return list
    .filter((c) => c.contract_type === "freight" && c.status === "open" && !c.stale && c.dest_port_id && c.commodity_id)
    .map((c) => ({
      id: c.id,
      origin: c.origin_port_id,
      dest: c.dest_port_id!,
      good: c.commodity_id!,
      tons: c.quantity_required,
      reward: c.reward_pence,
      collateral: c.collateral_pence,
      expiresAt: c.expires_at ? Date.parse(c.expires_at) : null,
      issuer: c.issuer_company_id ?? null,
    }));
}

export interface PriceObs {
  ask: number | null;
  askQty: number;
  bid: number | null;
  bidQty: number;
  /** Tons the visible bid ladder takes in all (live books with depth only). */
  bidDepth: number | null;
  stock: number | null;
  customsBps: number | null;
  /** Server time the observation describes. */
  at: number;
  /** From a live book (true) or gossip/snapshot (false). */
  live: boolean;
}

function toCharters(list: ContractListing[]): CharterInfo[] {
  return list
    .filter((c) => c.contract_type === "charter" && c.status === "open" && c.remaining_quantity > 0 && c.commodity_id)
    .map((c) => ({
      id: c.id,
      port: c.origin_port_id,
      good: c.commodity_id!,
      payPerTon: c.reward_per_ton_pence ?? Math.floor(c.reward_pence / Math.max(1, c.quantity_required)),
      remaining: c.remaining_quantity,
      expiresAt: c.expires_at ? Date.parse(c.expires_at) : null,
      stale: c.stale,
      isPublic: c.is_public,
      title: c.title ?? `${c.commodity_id} to ${c.origin_port_id}`,
      newsAt: c.stale && c.gossip?.news_as_of ? Date.parse(c.gossip.news_as_of) : null,
    }));
}

export class World {
  catalog!: Catalog;
  unlockedPhase = 1;
  timeScale = 60;
  paused = false;
  /** Server clock minus local clock, ms. */
  skewMs = 0;
  charters: CharterInfo[] = [];
  /** Open freight lots we can see, at ports where we have presence. */
  freight: FreightInfo[] = [];
  /** Our company (to skip freight we posted ourselves). */
  companyId: string | null = null;
  /** Other companies' ships seen at ports where we have presence. */
  readonly rivals = new RivalTracker();
  vaults = new Map<BankingRegion, number>();
  /** Live net piracy per sea zone (bps): base + letters of marque − naval patrols. */
  piracy = new Map<string, number>();
  /** Charters of the expansion tier in play (their deliveries earn a share of its completion bonus). */
  expansionCharters = new Set<string>();
  /** Tons the tier still needs; tons beyond that arrive after it completes and earn no bonus. */
  expansionTonsLeft = 0;
  /** The tier's progress (bps of its target) and the real ms until it completes at the recent pace (null: no pace yet). */
  tierProgressBps = 0;
  tierEtaMs: number | null = null;
  /** The phase the tier in play unlocks. */
  tierTargetPhase: number | null = null;
  /** Server time the tier in play last completed or gave way to the next (null: not seen). */
  tierTurnedAt: number | null = null;
  /** A lapsed posting's id → the id of the posting that replaced it. */
  private readonly repostOf = new Map<string, string>();
  /** Expansion postings that dropped out of the tier listing (lapsed, awaiting a re-post), by `port|good`. */
  private readonly lapsedPostings = new Map<string, LapsedPosting>();
  /** Escalations seen happen (a stalled posting re-posted richer), counted as they are noticed. */
  escalationsSeen = 0;
  /** Expansion charters by `port|good`, followed across re-posts. */
  readonly expansionWatch = new Map<string, ExpansionWatch>();
  /** What a stalled posting's re-post multiplies: pay and tons (learned when one is seen). */
  escalation = { pay: ESCALATION_PAY, tons: ESCALATION_TONS };
  /** Stalled postings seen lapse, and whether they re-posted richer. */
  private stallFates = { escalated: 0, not: 0 };
  /** Our own pirate raids: shares of cargo taken (captures aside), and captures seen. */
  private raidTakes: number[] = [];
  captures = 0;
  /** A remembered bid against the next live one at the same port: (age in game days, live/remembered). */
  private bidSamples: Array<[number, number]> = [];
  /** bidHaircutPerDay, recomputed when a sample comes in (read thousands of times per plan). */
  private bidHaircut = BID_HAIRCUT_DEFAULT;
  /**
   * Laden rival ships expected at each port (server ms of arrival), from the rival analysis: they
   * may take charter room before we land.
   */
  rivalArrivals = new Map<string, number[]>();
  private tierSamples: Array<{ at: number; delivered: number; phase: number }> = [];
  /** Share value of a ton per expansion charter (pence: base price × premium), and the pool's rate on it. */
  private expansionValue = new Map<string, number>();
  private expansionRate = EXPANSION_BONUS_SHARE;
  private rates = new Map<string, number>();
  private prices = new Map<string, PriceObs>();
  /** Last live copy of each charter seen live, for recall when it drops out of a listing. */
  private readonly liveSeen = new Map<string, { c: CharterInfo; seenAt: number }>();
  /** When each port's charters were last listed live on arrival (local ms). */
  private readonly mergedAt = new Map<string, number>();
  /** Charters we saw filled or closed. */
  private readonly closed = new Set<string>();
  private routes = new Map<string, Promise<RoutePlan>>();
  private routeSlots = 8;
  private portIndex: Map<string, CatalogPort> | null = null;
  private readonly routeWaiters: Array<() => void> = [];

  constructor(readonly client: KibbClient) {}

  /** Current server time. */
  now(): number {
    return Date.now() + this.skewMs;
  }

  /** Real milliseconds per game minute (1 s at 60×). */
  get gameMinuteMs(): number {
    return 60_000 / this.timeScale;
  }

  async init(): Promise<void> {
    this.catalog = await this.client.catalog();
    await this.refresh();
  }

  snapshot(): WorldSnapshot {
    return {
      prices: [...this.prices],
      expansionWatch: [...this.expansionWatch],
      escalation: { ...this.escalation },
      tierSamples: [...this.tierSamples],
      tierTargetPhase: this.tierTargetPhase,
      tierTurnedAt: this.tierTurnedAt,
      repostOf: [...this.repostOf].slice(-SNAPSHOT_CLOSED),
      lapsedPostings: [...this.lapsedPostings],
      liveSeen: [...this.liveSeen],
      closed: [...this.closed].slice(-SNAPSHOT_CLOSED),
      sightings: this.rivals.all(),
      stallFates: { ...this.stallFates },
      bidSamples: [...this.bidSamples],
      raidTakes: [...this.raidTakes],
      captures: this.captures,
    };
  }

  /** Picks up a snapshot from before a restart. Call before the first refresh, so the stall watch carries on (needs no catalog). */
  restore(s: WorldSnapshot): void {
    for (const [k, v] of s.prices ?? []) this.prices.set(k, v);
    for (const [k, v] of s.expansionWatch ?? []) this.expansionWatch.set(k, v);
    if (s.escalation) this.escalation = { ...s.escalation };
    this.tierSamples = [...(s.tierSamples ?? [])];
    this.tierTargetPhase = s.tierTargetPhase ?? null;
    this.tierTurnedAt = s.tierTurnedAt ?? null;
    for (const [k, v] of s.repostOf ?? []) this.repostOf.set(k, v);
    for (const [k, v] of s.lapsedPostings ?? []) this.lapsedPostings.set(k, v);
    for (const [k, v] of s.liveSeen ?? []) this.liveSeen.set(k, v);
    for (const id of s.closed ?? []) this.closed.add(id);
    for (const x of s.sightings ?? []) this.rivals.add(x);
    if (s.stallFates) this.stallFates = { ...s.stallFates };
    if (s.bidSamples) this.bidSamples = s.bidSamples.slice(-BID_SAMPLES_MAX);
    if (s.raidTakes) this.raidTakes = s.raidTakes.slice(-100);
    this.captures = s.captures ?? 0;
    this.updateBidHaircut();
  }

  /** Clock, charters, fees and vaults. */
  async refresh(): Promise<void> {
    const t0 = Date.now();
    const clock = await this.client.clock();
    const t1 = Date.now();
    this.skewMs = Date.parse(clock.real_utc) - (t0 + t1) / 2;
    this.unlockedPhase = clock.unlocked_phase;
    this.timeScale = clock.calendar.time_scale || 60;
    this.paused = clock.paused;

    const asked = Date.now();
    const [listing, freight, rates, zones, expansion] = await Promise.all([
      this.client.contractPages({ contract_type: "charter", status: "open" }),
      this.client.contractPages({ contract_type: "freight", status: "open" }).catch(() => null),
      this.client.rates(),
      this.client.zones().catch(() => null),
      this.client.expansion().catch(() => null),
      this.refreshVaults(),
    ]);
    const list = listing.items;
    if (freight) this.freight = toFreight(freight.items);
    if (zones) this.piracy = new Map(zones.map((z) => [z.sea_zone_id, z.net_piracy_bps]));
    if (expansion) {
      const tier = expansion.current_tier;
      this.expansionCharters = new Set(tier && !tier.completed ? tier.charters.filter((c) => c.status === "open").map((c) => c.contract_id) : []);
      this.expansionTonsLeft = tier && !tier.completed ? tier.tons_remaining : 0;
      this.watchExpansion(tier && !tier.completed ? tier : null);
      if (tier && !tier.completed) {
        // Project the tier's final value: what is delivered, plus the tons still needed at the mix
        // delivered so far. The pool over that is the bonus per unit of value.
        const value = new Map(tier.charters.map((c) => [c.contract_id, this.basePrice(c.commodity_id) * (c.premium_bps / 10_000)]));
        let delivered = 0;
        let tons = 0;
        for (const c of tier.charters) {
          const t = c.tons_delivered_total ?? c.quantity_delivered;
          delivered += t * value.get(c.contract_id)!;
          tons += t;
        }
        const avg = tons > 0 ? delivered / tons : [...value.values()].reduce((n, v) => n + v, 0) / Math.max(value.size, 1);
        const projected = delivered + tier.tons_remaining * avg;
        this.expansionValue = value;
        this.expansionRate = projected > 0 ? Math.min(0.2, Math.max(0.06, tier.completion_bonus_pence / projected)) : EXPANSION_BONUS_SHARE;
      }
    }
    const fresh = toCharters(list).filter((c) => !this.closed.has(c.id));
    // Ports re-listed live on arrival while this request was in flight keep that newer view.
    const newer = new Set([...this.mergedAt].filter(([, t]) => t > asked).map(([p]) => p));
    this.remember(fresh.filter((c) => !newer.has(c.port)));
    // Public charters are listed to everyone: one missing from a complete listing is closed.
    if (listing.complete) {
      const ids = new Set(fresh.map((c) => c.id));
      for (const [id, { c }] of this.liveSeen) if (c.isPublic && !newer.has(c.port) && !ids.has(id)) this.liveSeen.delete(id);
    }
    this.charters = this.withRecalled([
      ...fresh.filter((c) => !newer.has(c.port)),
      ...this.charters.filter((c) => newer.has(c.port)),
    ]);
    this.rates = new Map(rates.map((r) => [`${r.from_region}>${r.to_region}`, r.fee_bps]));
  }

  /**
   * Follows each expansion charter across its postings: whether the current one is stalled (it
   * re-posts richer if nothing is delivered before it lapses), what an escalation did to the pay
   * and tons when we saw one, and how fast the tier as a whole is filling.
   */
  private watchExpansion(tier: ExpansionTier | null): void {
    const now = this.now();
    if (!tier) {
      if (this.tierTargetPhase !== null) this.tierTurnedAt = now;
      this.expansionWatch.clear();
      this.tierSamples = [];
      this.tierEtaMs = null;
      this.tierProgressBps = 0;
      this.tierTargetPhase = null;
      return;
    }
    // A new tier starts its pace afresh.
    if (this.tierTargetPhase !== tier.target_phase) {
      if (this.tierTargetPhase !== null) this.tierTurnedAt = now;
      this.tierSamples = [];
    }
    this.tierTargetPhase = tier.target_phase;
    this.tierProgressBps = tier.progress_bps;
    this.tierSamples.push({ at: now, delivered: tier.tons_delivered, phase: tier.target_phase });
    this.tierSamples = this.tierSamples.filter((s) => now - s.at <= TIER_PACE_WINDOW_MS);
    const first = this.tierSamples[0];
    const span = now - first.at;
    const pace = span >= TIER_PACE_MIN_MS ? (tier.tons_delivered - first.delivered) / span : 0;
    this.tierEtaMs = pace > 0 ? tier.tons_remaining / pace : null;

    const seen = new Set<string>();
    for (const c of tier.charters) {
      if (c.status !== "open") continue;
      const key = `${c.port_id}|${c.commodity_id}`;
      seen.add(key);
      const expiresAt = c.expires_at ? Date.parse(c.expires_at) : null;
      const total = c.tons_delivered_total ?? c.quantity_delivered;
      const prev = this.expansionWatch.get(key);
      const newPosting = !prev || prev.id !== c.contract_id || prev.expiresAt !== expiresAt;
      // An escalation seen happen: learn what it did (within sane bounds).
      if (prev && c.escalations > prev.escalations && prev.rate > 0) {
        this.escalation.pay = Math.min(2, Math.max(1, c.reward_per_ton_pence / prev.rate));
        if (prev.remaining > 0) this.escalation.tons = Math.min(1, Math.max(0.3, c.quantity_remaining / prev.remaining));
        this.escalationsSeen++;
      }
      // A posting we saw stalled late in its window has lapsed: did it re-post richer? (Seen
      // either in one step, or after it dropped out of the listing for a while.) Postings our own
      // ships delivered to don't count: the planner allows for those separately.
      const lapsed = !prev ? this.lapsedPostings.get(key) : undefined;
      if (prev && newPosting && prev.lateStalled && !prev.ourDelivery) {
        if (c.escalations > prev.escalations) this.stallFates.escalated++;
        else this.stallFates.not++;
      } else if (lapsed?.lateStalled) {
        if (c.escalations > (lapsed.escalations ?? 0)) {
          this.stallFates.escalated++;
          this.escalationsSeen++;
        } else this.stallFates.not++;
      }
      if (prev && prev.id !== c.contract_id) {
        this.repostOf.set(prev.id, c.contract_id);
        // Old links are long lapsed: keep the newest.
        if (this.repostOf.size > SNAPSHOT_CLOSED) this.repostOf.delete(this.repostOf.keys().next().value!);
      }
      const postingSeenAt = newPosting ? now : prev.postingSeenAt;
      const postingBase = newPosting ? total : prev.postingBase;
      // Seen from its start (it replaced one we watched), so the base really is the posting's start.
      const sawStart = newPosting ? !!prev : prev.sawStart;
      const watchedLongEnough = sawStart && now - postingSeenAt >= STALL_MIN_WATCH_GAME_H * 60 * this.gameMinuteMs;
      this.expansionWatch.set(key, {
        id: c.contract_id,
        port: c.port_id,
        good: c.commodity_id,
        rate: c.reward_per_ton_pence,
        remaining: c.quantity_remaining,
        expiresAt,
        escalations: c.escalations,
        beyondCoastal: c.beyond_coastal_water,
        deliveredTotal: total,
        // Nothing delivered in this posting (the feed counts it per posting; across postings is
        // tons_delivered_total). Only if the feed gives no lineage total (so the count may be
        // cumulative): nothing since we watched this posting start, for a while.
        stalled: c.quantity_delivered === 0 || (c.tons_delivered_total === undefined && watchedLongEnough && total === postingBase),
        postingSeenAt,
        postingBase,
        sawStart,
        lateStalled: false,
      });
      const w = this.expansionWatch.get(key)!;
      const late = expiresAt !== null && expiresAt - now <= LATE_STALL_GAME_H * 60 * this.gameMinuteMs && expiresAt > now;
      // Kept within a posting; a new posting starts clean.
      w.ourDelivery = !newPosting && !!prev?.ourDelivery;
      // A late stall broken by someone else's delivery before the lapse: it didn't hold.
      if (prev && !newPosting && prev.lateStalled && !w.stalled && !w.ourDelivery) this.stallFates.not++;
      // Carried over within a posting.
      w.lateStalled = w.stalled && ((!newPosting && !!prev?.lateStalled) || late);
    }
    for (const [k, w] of [...this.expansionWatch]) {
      if (seen.has(k)) continue;
      // Gone from the listing before its lapse: filled or closed. After it: awaiting its re-post.
      if (w.expiresAt !== null && w.expiresAt <= now) this.lapsedPostings.set(k, { id: w.id, expiresAt: w.expiresAt, lateStalled: w.lateStalled && !w.ourDelivery, escalations: w.escalations });
      this.expansionWatch.delete(k);
    }
    for (const k of seen) this.lapsedPostings.delete(k);
  }

  /** One of our ships delivered to this charter: an expansion posting's stall fate then isn't learned from it. */
  noteOwnDelivery(charterId: string): void {
    const id = this.currentId(charterId);
    for (const w of this.expansionWatch.values()) if (w.id === id) w.ourDelivery = true;
  }

  /** An expansion posting at this port for this good that lapsed and hasn't been re-posted yet (as far as we know). */
  lapsedPosting(port: string, good: string): LapsedPosting | undefined {
    return this.lapsedPostings.get(`${port}|${good}`);
  }

  /** The watch on an expansion charter of the tier in play (live or by its port and good), if it is one. */
  stallWatch(c: { id: string; port: string; good: string }): ExpansionWatch | undefined {
    const w = this.expansionWatch.get(`${c.port}|${c.good}`);
    return w && (w.id === c.id || this.expansionCharters.has(c.id)) ? w : undefined;
  }

  /**
   * Chance a posting that looks stalled now is still stalled when it lapses: from the stalled
   * postings seen lapse (re-posted richer or not), starting from 75%.
   */
  get stallSurvives(): number {
    const { escalated, not } = this.stallFates;
    return Math.min(0.95, Math.max(0.2, (escalated + STALL_PRIOR_P * STALL_PRIOR_N) / (escalated + not + STALL_PRIOR_N)));
  }

  /**
   * How much a remembered bid is marked down per game day of age: the median drop seen when a live
   * book followed an older price (3% until enough samples, kept within 0.5–15%).
   */
  get bidHaircutPerDay(): number {
    return this.bidHaircut;
  }

  private updateBidHaircut(): void {
    this.bidHaircut = this.fitBidHaircut();
  }

  private fitBidHaircut(): number {
    if (this.bidSamples.length < BID_SAMPLES_MIN) return BID_HAIRCUT_DEFAULT;
    // Fitted to how the planner uses it: a fixed base markdown plus this rate per day.
    const rates = this.bidSamples.map(([days, ratio]) => Math.max(0, 1 - ratio - BID_HAIRCUT_BASE) / Math.max(days, 0.25)).sort((a, b) => a - b);
    return Math.min(0.15, Math.max(0.005, rates[Math.floor(rates.length / 2)]));
  }

  /** Laden rival ships expected at `port` between now and `by` (server ms). */
  rivalsLanding(port: string, by: number): number {
    const now = this.now();
    return (this.rivalArrivals.get(port) ?? []).filter((t) => t >= now && t <= by).length;
  }

  /** Whether a charter is re-posted when it lapses (an open expansion charter of the tier in play). */
  renews(c: { id: string }): boolean {
    return this.expansionCharters.has(this.currentId(c.id));
  }

  /** The id of the posting that now stands for this charter (itself unless it lapsed and was re-posted). */
  currentId(id: string): string {
    let cur = id;
    for (let i = 0; i < 20; i++) {
      const next = this.repostOf.get(cur);
      if (!next || next === cur) break;
      cur = next;
    }
    return cur;
  }

  /** Replaces what we know about one port's charters with a live listing taken there. */
  mergePortCharters(port: string, list: ContractListing[]): void {
    const fresh = toCharters(list.filter((c) => c.origin_port_id === port)).filter((c) => !this.closed.has(c.id));
    // Taken with our ship in port, so the listing is complete there: missing means closed.
    const ids = new Set(fresh.map((c) => c.id));
    for (const [id, { c }] of this.liveSeen) if (c.port === port && !ids.has(id)) this.liveSeen.delete(id);
    this.remember(fresh);
    this.mergedAt.set(port, Date.now());
    this.charters = this.withRecalled([...this.charters.filter((c) => c.port !== port), ...fresh]);
  }

  /** Replaces the open freight we know of at one port with a listing taken there. */
  mergePortFreight(port: string, list: ContractListing[]): void {
    this.freight = [...this.freight.filter((f) => f.origin !== port), ...toFreight(list.filter((c) => c.origin_port_id === port))];
  }

  /** A freight lot was taken (by us or anyone): stop planning on it. */
  dropFreight(id: string): void {
    this.freight = this.freight.filter((f) => f.id !== id);
  }

  /**
   * A charter was filled or closed: drop it now and ignore it in listings already in flight. One
   * that only `lapsed` and is an expansion posting may come back under the same id when re-posted,
   * so it isn't ignored for good.
   */
  markClosed(id: string, lapsed = false): void {
    if (!lapsed || !this.renews({ id })) this.closed.add(id);
    this.liveSeen.delete(id);
    this.charters = this.charters.filter((c) => c.id !== id);
  }

  private remember(list: CharterInfo[]): void {
    const now = this.now();
    // Keep the object itself: deliveries update its `remaining` in place.
    for (const c of list) if (!c.stale) this.liveSeen.set(c.id, { c, seenAt: now });
  }

  /**
   * Non-public charters are listed live only while we have presence at their port. Keep the last
   * live copy of one we saw (for a while, until it expires or is closed) where a listing now shows
   * it only as gossip or not at all, so a ship already bound for it doesn't lose it on the way.
   */
  private withRecalled(list: CharterInfo[]): CharterInfo[] {
    const now = this.now();
    const live = new Set(list.filter((c) => !c.stale).map((c) => c.id));
    const out = list.filter((c) => !(c.stale && this.liveSeen.has(c.id)));
    for (const [id, { c, seenAt }] of this.liveSeen) {
      const expired = c.expiresAt !== null && c.expiresAt < now;
      if (expired || c.remaining <= 0 || now - seenAt > RECALL_MS * (60 / this.timeScale)) {
        this.liveSeen.delete(id);
        continue;
      }
      if (!live.has(id)) out.push(c);
    }
    return out;
  }

  async refreshVaults(): Promise<void> {
    const { vaults } = await this.client.vaults();
    this.vaults = new Map(vaults.filter((v) => v.account_type === "vault").map((v) => [v.banking_region, v.balance_pence]));
  }

  // ── Catalog lookups ─────────────────────────────────────────────────────────

  port(id: string): CatalogPort | undefined {
    if (!this.portIndex || this.portIndex.size !== this.catalog.ports.length) this.portIndex = new Map(this.catalog.ports.map((p) => [p.id, p]));
    return this.portIndex.get(id);
  }

  shipClass(id: string): CatalogShipClass | undefined {
    return this.catalog.ship_classes.find((c) => c.id === id);
  }

  region(portId: string): BankingRegion {
    return this.port(portId)?.banking_region ?? "channel";
  }

  isOpen(portId: string): boolean {
    return (this.port(portId)?.phase ?? 99) <= this.unlockedPhase;
  }

  /** Ports that produce or manufacture the good: where it is cheap. */
  sourcesOf(good: string): string[] {
    return this.catalog.ports
      .filter((p) => p.phase <= this.unlockedPhase && [...(p.produces ?? []), ...(p.manufactures ?? [])].includes(good))
      .map((p) => p.id);
  }

  /**
   * Ports to buy the good at: the open ports that make it, plus any open port trading it where an
   * ask has been seen lately (an importer with a glut can undercut the producers).
   */
  sellersOf(good: string): string[] {
    const out = new Set(this.sourcesOf(good));
    for (const p of this.catalog.ports) {
      if (p.phase <= this.unlockedPhase && this.trades(p.id, good) && this.price(p.id, good)?.ask) out.add(p.id);
    }
    return [...out];
  }

  /** Goods on sale at a port: what it makes, plus anything with an ask seen there lately. */
  goodsAt(portId: string): string[] {
    const p = this.port(portId);
    if (!p) return [];
    const out = new Set([...(p.produces ?? []), ...(p.manufactures ?? [])]);
    for (const c of this.catalog.commodities) if (this.trades(portId, c.id) && this.price(portId, c.id)?.ask) out.add(c.id);
    return [...out];
  }

  /** Whether the port has a market for the good at all. */
  trades(portId: string, good: string): boolean {
    const p = this.port(portId);
    if (!p) return false;
    return good === "provisions" || [...(p.produces ?? []), ...(p.manufactures ?? []), ...(p.imports ?? [])].includes(good);
  }

  basePrice(good: string): number {
    return this.catalog.commodities.find((c) => c.id === good)?.base_price_pence ?? 0;
  }

  /** Extra berth lock per ton handled: 1 game minute at hubs, 2 elsewhere. */
  handlingMsPerTon(portId: string): number {
    return (this.port(portId)?.is_hub ? 1 : 2) * this.gameMinuteMs;
  }

  /** Real ms to sail `nm` at `knots`. */
  sailMs(nm: number, knots: number): number {
    return (nm / Math.max(knots, 0.1)) * 60 * this.gameMinuteMs;
  }

  // ── Routes ──────────────────────────────────────────────────────────────────

  route(from: string, to: string, shipClass: string): Promise<RoutePlan> {
    const key = `${from}>${to}>${shipClass}`;
    let p = this.routes.get(key);
    if (!p) {
      p = this.fetchRoute(from, to, shipClass);
      p.catch(() => this.routes.delete(key));
      this.routes.set(key, p);
    }
    return p;
  }

  /** At most a few route lookups in flight: a first planning pass asks for hundreds. */
  private async fetchRoute(from: string, to: string, shipClass: string): Promise<RoutePlan> {
    while (this.routeSlots === 0) await new Promise<void>((r) => this.routeWaiters.push(r));
    this.routeSlots--;
    try {
      return await this.client.route(from, to, shipClass);
    } finally {
      this.routeSlots++;
      this.routeWaiters.shift()?.();
    }
  }

  /**
   * True when a hull of class `hull` is rated for every leg: the lane's own class and the class of
   * the sea zone each leg ends in (hazards roll for that zone).
   */
  routeRated(plan: RoutePlan, hull: ZoneClass): boolean {
    const max = ZONE_RANK[hull];
    return plan.legs.every((l) => {
      const zone = this.catalog.sea_zones.find((z) => z.id === l.to_node);
      return ZONE_RANK[l.edge_class] <= max && (!zone || ZONE_RANK[zone.zone_class] <= max);
    });
  }

  /** Phase-completion bonus a ton delivered to this charter is expected to earn (pence, unweighted). */
  charterBonus(c: { id: string; good: string }): number {
    if (!this.expansionCharters.has(c.id)) return 0;
    return Math.round((this.expansionValue.get(c.id) ?? this.basePrice(c.good) * 1.3) * this.expansionRate);
  }

  /**
   * What pirates are expected to cost a passage carrying `cargoValue` (pence). Each leg rolls for
   * the zone it ends in (a port's own zone for the last leg), at the zone's net piracy as a rate per
   * game day at sea, so longer legs count for more. Pirates go for the richest prizes, so the rate
   * scales with the cargo's value (an empty ship is barely looked at); guns deter. A raid takes a
   * share of the cargo (learned from our raids), and now and then the ship itself, cargo and all
   * (rarer with guns). Returns the expected share of the cargo lost (captures included) and the
   * chance of losing the ship. Estimates for ranking lanes and refits.
   */
  piracyRisk(plan: RoutePlan, guns: number, knots: number, cargoValue: number): { cargoShare: number; capture: number } {
    const dayMs = 24 * 60 * this.gameMinuteMs;
    let rate = 0;
    for (const l of plan.legs) {
      const bps = this.piracy.get(l.to_node) ?? this.piracy.get(this.port(l.to_node)?.sea_zone_id ?? "");
      if (bps) rate += Math.min(1, (bps / 10_000) * (this.sailMs(l.distance_nm, knots) / dayMs));
    }
    if (rate <= 0) return { cargoShare: 0, capture: 0 };
    const attention = cargoValue <= 0 ? ATTENTION_MIN : Math.min(ATTENTION_MAX, Math.max(ATTENTION_MIN, Math.sqrt(cargoValue / ATTENTION_REF_PENCE)));
    const raids = Math.min(1, (rate * attention) / (1 + guns * GUN_DETERRENCE));
    const capturePerRaid = CAPTURE_PER_RAID / (1 + guns * CAPTURE_GUN_CUT);
    const take = this.raidTake;
    return {
      cargoShare: Math.min(0.6, raids * (capturePerRaid + (1 - capturePerRaid) * take)),
      capture: Math.min(0.5, raids * capturePerRaid),
    };
  }

  /** The expected share of the cargo lost to pirates on a passage (captures included); see piracyRisk. */
  piracyLoss(plan: RoutePlan, guns: number, knots: number, cargoValue: number): number {
    return this.piracyRisk(plan, guns, knots, cargoValue).cargoShare;
  }

  /** Share of the cargo a raid takes, learned from our own raids (30% until some are seen). */
  get raidTake(): number {
    const n = this.raidTakes.length;
    const sum = this.raidTakes.reduce((a, b) => a + b, 0);
    return Math.min(0.9, Math.max(0.05, (sum + RAID_TAKE_PRIOR * RAID_TAKE_PRIOR_N) / (n + RAID_TAKE_PRIOR_N)));
  }

  /** One of our ships was raided: the share of its cargo taken, or captured outright. */
  notePirateRaid(share: number | null, captured: boolean): void {
    if (captured) {
      this.captures++;
      return;
    }
    if (share === null || !Number.isFinite(share) || share <= 0 || share > 1) return;
    this.raidTakes.push(share);
    if (this.raidTakes.length > 100) this.raidTakes.shift();
  }

  // ── Prices ──────────────────────────────────────────────────────────────────

  observeBook(book: PortOrderBook): void {
    const at = book.as_of ? Date.parse(book.as_of) : this.now();
    const live = book.visibility === "quay" || book.visibility === "counting_house";
    for (const b of book.books) {
      // A live bid after an older remembered one: how far did it drift for its age?
      const prev = this.prices.get(`${book.port_id}|${b.commodity_id}`);
      const bid = b.best_bid?.price_pence ?? null;
      if (live && bid && prev?.bid && at > prev.at) {
        const days = (at - prev.at) / (24 * 60 * this.gameMinuteMs);
        if (days >= 0.25 && days <= 3) {
          this.bidSamples.push([days, bid / prev.bid]);
          if (this.bidSamples.length > BID_SAMPLES_MAX) this.bidSamples.shift();
          this.updateBidHaircut();
        }
      }
      this.prices.set(`${book.port_id}|${b.commodity_id}`, {
        ask: b.best_ask?.price_pence ?? null,
        askQty: b.best_ask?.quantity ?? 0,
        bid: b.best_bid?.price_pence ?? null,
        bidQty: b.best_bid?.quantity ?? 0,
        bidDepth: b.depth ? b.depth.bids.reduce((n, l) => n + l.remaining_quantity, 0) : null,
        stock: b.depth?.npc_current_stock ?? null,
        customsBps: book.customs_bps,
        at,
        live,
      });
    }
  }

  /** Learns other ports' prices from the coffee-house gossip at a quay we stand on, and who sailed there. */
  observeGossip(detail: PortDetail): void {
    this.rivals.addNotices(detail.recent_sailings);
    for (const g of detail.coffee_house_gossip ?? []) {
      const at = this.now() - g.age_seconds * 1000;
      for (const c of g.commodities) {
        const key = `${g.subject_port_id}|${c.commodity_id}`;
        const prev = this.prices.get(key);
        if (prev && prev.at >= at) continue;
        this.prices.set(key, {
          ask: c.best_ask_pence ?? null,
          askQty: 0,
          bid: c.best_bid_pence ?? null,
          bidQty: 0,
          bidDepth: null,
          stock: c.current_stock,
          customsBps: prev?.customsBps ?? null,
          at,
          live: false,
        });
      }
    }
  }

  price(portId: string, good: string): PriceObs | undefined {
    const p = this.prices.get(`${portId}|${good}`);
    return p && this.now() - p.at < PRICE_TTL_MS ? p : undefined;
  }

  /**
   * Best guess at the ask: last seen, else base price (a producer sits near base when stocked).
   * Null while a recent look found nothing on offer (sold out until the ladder re-quotes).
   */
  estAsk(portId: string, good: string): { ask: number; known: boolean } | null {
    const p = this.price(portId, good);
    if (p && p.ask === null && this.now() - p.at < SOLD_OUT_MS * (60 / this.timeScale)) return null;
    if (p?.ask) return { ask: p.ask, known: true };
    return { ask: Math.round(this.basePrice(good) * 1.05), known: false };
  }

  /**
   * Records that a port had nothing of this good on offer just now. The bid is what the same book
   * showed (an older bid would otherwise be restamped as fresh).
   */
  observeNoAsk(portId: string, good: string, bid: { price_pence: number; quantity: number } | null = null): void {
    const key = `${portId}|${good}`;
    const prev = this.prices.get(key);
    this.prices.set(key, {
      ask: null,
      askQty: 0,
      bid: bid?.price_pence ?? null,
      bidQty: bid?.quantity ?? 0,
      bidDepth: null,
      stock: 0,
      customsBps: prev?.customsBps ?? null,
      at: this.now(),
      live: true,
    });
  }

  customsBps(portId: string): number {
    return this.prices.get(`${portId}|provisions`)?.customsBps ?? this.port(portId)?.customs_bps ?? 300;
  }

  // ── Money ───────────────────────────────────────────────────────────────────

  remitBps(from: BankingRegion, to: BankingRegion): number {
    return from === to ? 0 : (this.rates.get(`${from}>${to}`) ?? 200);
  }

  vault(region: BankingRegion): number {
    return this.vaults.get(region) ?? 0;
  }

  totalCash(): number {
    let n = 0;
    for (const v of this.vaults.values()) n += Math.max(0, v);
    return n;
  }

  /** Fleet sprawl upkeep per game day for this much coastal/regional hull tonnage. */
  sprawlPerDay(tons: number): number {
    return tons <= 40 ? 0 : Math.round(4_500 * Math.pow((tons - 40) / 100, 1.45));
  }

  /** Extra upkeep per real hour from adding `addTons` of hull to a fleet of `fleetTons`. */
  upkeepDeltaPerHour(fleetTons: number, addTons: number, oceanic = false): number {
    const gameDaysPerHour = this.timeScale / 24;
    const perDay = oceanic ? addTons * 100 : this.sprawlPerDay(fleetTons + addTons) - this.sprawlPerDay(fleetTons);
    return perDay * gameDaysPerHour;
  }
}
