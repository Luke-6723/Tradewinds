/**
 * Shared view of the game world for the fleet autopilot: catalog, server clock, open charters,
 * vaults, remittance fees, cached routes and everything learned about prices (live books where we
 * have presence, coffee-house gossip elsewhere). One instance per company, refreshed by the manager.
 *
 * World events (the public feed) move what is expected: a shortage's bid and a glut's ask, a pirate
 * outbreak's piracy until the zones are read again, a structural shift's catalog re-read, and a
 * shortage's crisis charter, which stands in as an expected (`crisis:<event id>`) charter until a
 * listing shows it or one of our ships in port finds none.
 */

import type { KibbClient } from "../client";
import { CAPTURE_PRIOR, landingOdds, ODDS_UNKNOWN, pirateAttention, RAID_TAKE_PRIOR, RECENT_LANDING_GAME_MIN, RivalTracker, sqrtShare, type RivalIntelSnapshot, type RivalLanding, type Sighting } from "../rivals";
import type {
  BankingRegion,
  Catalog,
  CatalogPort,
  CatalogShipClass,
  CharterFunding,
  ContractListing,
  ExpansionTier,
  PortDetail,
  PortOrderBook,
  RoutePlan,
  ZoneClass,
} from "../types";
import type { LloydsListNotice, MonopolyResult, UnderwritingFigures, WorldEventResult, WorldEventType } from "../schema";

export const ZONE_RANK: Record<ZoneClass, number> = { coastal: 0, regional: 1, oceanic: 2 };

/** A gossip or snapshot price older than this is treated as unknown. */
const PRICE_TTL_MS = 3 * 60 * 60 * 1000;
/** An empty ask side counts as "sold out" for one NPC re-quote (6 game hours; real ms at 60×). */
const SOLD_OUT_MS = 6 * 60 * 1000;
/** A charter last seen live is recalled for this long (2 game days; real ms at 60×). */
const RECALL_MS = 2 * 24 * 60 * 1000;
/** A cached route plan is read again after this long (a phase unlock clears them all at once). */
const ROUTE_TTL_MS = 30 * 60_000;
/** The season is ended by hand on the announced date (guide 3.11): treated as over this much before it. */
const SEASON_END_SLACK_MS = 30 * 60_000;
/** Season left (real ms, after the slack) under which no hull is built (it can't pay back), and the final hours. */
export const SEASON_ENDGAME_MS = 12 * 60 * 60_000;
export const SEASON_FINAL_MS = 3 * 60 * 60_000;
/**
 * Piracy (guide 3.5; the formulas aren't published, so the fleet refines these from its own raids):
 * pirates go for the richest prizes; an interception carries the ship off in 5-10% of cases (fewer the
 * more guns face it), else seizes 20-50% of every cargo stack and of the stores and lets the ship go.
 * A raid's take starts at the prior (rivals.ts) and is learned from our raids, within the guide's range.
 */
const RAID_TAKE_PRIOR_N = 5;
const RAID_TAKE_MIN = 0.2;
const RAID_TAKE_MAX = 0.5;
/** An unarmed hull's capture odds per interception, learned from our captures within the guide's range; guns cut it towards the low end. */
const CAPTURE_PRIOR_N = 20;
const CAPTURE_MIN = 0.05;
const CAPTURE_MAX = 0.1;
const CAPTURE_GUN_CUT = 0.25;
/** Assumed cut in interception odds per gun ("cut sharply by cannons"; the formula isn't published). */
const GUN_DETERRENCE = 0.5;
/**
 * Storms (formula not published; the guide: each leg rolls for the zone it ends in, longer legs carry
 * more risk, worse for a hull below the zone's class and in game months 11-2; a hit destroys 25% of
 * every stack and a quarter of the stores). Priced like piracy: the catalog's base_storm_bps as odds
 * per game day at sea, times these priors, times what our own voyages have shown. Changing a prior
 * changes what the saved record means: rename `stormCells` in the snapshot if you do.
 */
const STORM_MONTHS = new Set([11, 12, 1, 2]);
/** Hits per game day at sea per unit of zone storm odds (rated hull, calm months) before any are seen. A guess. */
const STORM_RATE_PRIOR = 0.5;
/** Storm season against the rest of the year before any are seen ("markedly worse"). A guess. */
const STORM_SEASON_PRIOR = 2;
/** Per class a hull is below the zone ("storm damage on most legs"); the planner never sails such water. */
const STORM_UNDERRATED = 4;
/** Zone storm odds (bps) when the catalog gives none: about its class's catalog average. */
const STORM_BPS_FALLBACK: Record<ZoneClass, number> = { coastal: 450, regional: 800, oceanic: 1400 };
/** Share of every stack a hit destroys (the guide's 25%), refined from cargo_loss_pct. */
const STORM_TAKE_PRIOR = 0.25;
const STORM_TAKE_PRIOR_N = 10;
/** Chance a hit sinks a rated hull ("rarely sinks"; a guess), refined from our sinkings and rescues. */
const STORM_SINK_PRIOR = 0.02;
const STORM_SINK_PRIOR_N = 25;
/** Weight (in expected hits) of the prior behind each learned multiplier, and the multiplier's bounds. */
const STORM_PRIOR_HITS = 4;
const STORM_MULT_MIN = 0.1;
const STORM_MULT_MAX = 5;
/** A cell's record is halved past this many expected hits, so old evidence fades if the odds are retuned. */
const STORM_CELL_CAP = 200;
/**
 * A storm leaves 3/4 of the stores; a pirate raid that lets the ship go leaves at least half (it seizes
 * 20-50% of them). Stock for as many hits as are likelier than 2%, up to three, pirate raids first.
 */
const STORM_STORES_LEFT = 0.75;
const PIRATE_STORES_LEFT = 0.5;
const STORES_TAIL = 0.02;
const STORES_MAX_HITS = 3;

/** P(N ≥ k) for N ~ Poisson(λ): the chance a passage expecting λ hits takes k or more. */
function poissonTail(lambda: number, k: number): number {
  let term = Math.exp(-lambda);
  let below = 0;
  for (let i = 0; i < k; i++) {
    below += term;
    term *= lambda / (i + 1);
  }
  return Math.max(0, 1 - below);
}

/** Where a storm is learned: the season, and how the hull sits against the zone's class. */
type StormCell = `${"calm" | "storm"}|${"under" | "rated" | "above"}`;
const stormCell = (stormy: boolean, margin: number): StormCell =>
  `${stormy ? "storm" : "calm"}|${margin < 0 ? "under" : margin === 0 ? "rated" : "above"}`;

/**
 * A tier's completion bonus is 12% of its base value (guide 3.15), split by the square root of each player's tons
 * valued at base rates (`share_bps` in the spec), so the premium doesn't count. This rate on a ton's base value is
 * the fallback (a straight share of the pool) when the contribution board can't be split.
 */
const EXPANSION_BONUS_SHARE = 0.12;
/** The bonus a ton earns is judged over a load of about this size when the caller gives none (tons). */
const BONUS_REF_TONS = 30;
/** Our own resting orders (GET /v1/market/orders) are read again after this long (real ms): the fleet trades IOC only. */
const OWN_ORDERS_TTL_MS = 10 * 60_000;
/** A players' resting order in the news is counted at its tons less this share per game day of age, gone after 1/rate days. */
const PLAYER_LEVEL_DECAY_PER_DAY = 0.5;
/**
 * A posting that stays stalled (under a tenth of its expected pace, nobody else delivering) until it
 * lapses is re-posted richer: by default +25% pay on 75% of the tons left (refined from what the feed
 * shows when an escalation happens).
 */
const ESCALATION_PAY = 1.25;
const ESCALATION_TONS = 0.75;
/** Our own watch calls a posting stalled only after following it from its start for this long (game hours). */
const STALL_MIN_WATCH_GAME_H = 6;
/** A posting is stalled while under this share of its expected pace (its tons spread over its window) is delivered (guide 3.8). */
const STALL_PACE_SHARE = 0.1;
/** Our own deliveries into a camped posting stay this far under that line (the server's pace isn't published). */
const TRICKLE_SAFETY = 0.8;
/** Re-posts that escalated after only our own deliveries under the line, before ours are allowed in a camp; one that didn't resets it. */
export const OWN_TRICKLE_CONFIRM = 2;
const OWN_TRICKLE_SAMPLES = 20;
/** A quiet port's berth dues a game day (10 Cr), until a port view shows the rate at its occupancy (tripled above 70%). */
const BERTH_DUES_QUIET = 1_000;
/** A berth stay is charged for at least this long (game hours, guide 3.3). */
const BERTH_MIN_GAME_H = 6;
/** Our own flow into a charter is measured over this much real time. */
const OWN_RATE_WINDOW_MS = 6 * 60 * 60 * 1000;
/** Our delivered tons not yet seen in a charter's total stop being matched after this. */
const OWN_PENDING_MS = 10 * 60_000;
/** Deliveries this recent (game days) say a rival feeds a charter. */
const FEED_MEMORY_GAME_DAYS = 30;
/**
 * Rival first deliveries into stalled postings per game hour stalled: a prior of one per 10 game days
 * (a guess), and the game hours of a charter's own record that outweigh the tier's pooled rate.
 */
const RIVAL_BREAK_PRIOR_N = 1;
const RIVAL_BREAK_PRIOR_H = 240;
const LINEAGE_PRIOR_H = 120;
/** A delivery notice this soon after one of ours into the same posting is taken for ours. */
const OWN_MATCH_MS = 2 * 60_000;
/** At most this much time between two listings counts as watched (a restart isn't watching). */
const EXPOSURE_GAP_MS = 3 * 60_000;
/** How long a tier's postings stay open (game days) by the phase it unlocks, until a re-post shows it (guide 3.8). */
const POSTING_GAME_DAYS: Record<number, number> = { 2: 30, 3: 60, 4: 90 };
/** Tier pace is measured over at most this much real time. */
const TIER_PACE_WINDOW_MS = 2 * 60 * 60 * 1000;
/** ...and needs at least this much before it is trusted. */
const TIER_PACE_MIN_MS = 10 * 60 * 1000;

/** One expansion charter across its postings (this tier): our own flow into it, and how rivals treat its stalls. */
export interface Lineage {
  /** Our deliveries (server ms, tons), the last few hours'. */
  own: Array<[at: number, tons: number]>;
  /** Our tons not yet seen in its delivered total (so they aren't taken for a rival's), and since when. */
  ownPending: number;
  ownPendingAt: number;
  /** Game hours watched while stalled, and stalls a rival broke (its first delivery into a stalled posting). */
  stalledH: number;
  breaks: number;
  /** Real ms a posting stays open (seen at a re-post), or null until one is seen. */
  windowMs: number | null;
}

/** An expansion posting that dropped out of the listing after its lapse, awaiting its re-post. */
interface LapsedPosting {
  id: string;
  expiresAt: number | null;
  /** It was stalled late in its window, and its escalation count then (to learn whether the stall held). */
  lateStalled?: boolean;
  escalations?: number;
  /** Under the pace line late in its window with only our tons in it (ExpansionWatch.lateTrickle), and its figures then. */
  lateTrickle?: boolean;
  ownTons?: number;
  line?: number;
  rate?: number;
  remaining?: number;
}

/** A re-post of a posting only our ships delivered to (under the pace line): did it still escalate? */
export interface TrickleSample {
  at: number;
  key: string;
  ownTons: number;
  line: number;
  escalated: boolean;
  payRatio: number | null;
  tonsRatio: number | null;
}

/** What re-posts showed about our own small deliveries into stalled postings (OWN_TRICKLE_CONFIRM in a row allow them). */
export interface TrickleRecord {
  confirmed: number;
  refuted: number;
  samples: TrickleSample[];
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
  /** Rival intel beyond sightings (policies, convoys, deliveries, net worth); absent in older saves. */
  rivalIntel?: RivalIntelSnapshot;
  /** Per expansion charter (`port|good`): our own flow into it and its rival record; absent in older saves. */
  lineages?: Array<[string, Lineage]>;
  /** Learned figures (calibrators): stalled postings seen lapse and whether they escalated; bid drift samples. */
  stallFates?: { escalated: number; not: number };
  bidSamples?: Array<[ageDays: number, ratio: number]>;
  raidTakes?: number[];
  captures?: number;
  /** Storm record per cell (season|hull vs zone): hits the prior model expected of our voyages, hits seen, sinkings (rescues count). */
  stormCells?: Array<[string, { exp: number; hits: number; sinks?: number }]>;
  stormTakes?: number[];
  /** The 7-day event log was read once for storms (manager.bootstrapStorms). */
  stormBootstrapped?: boolean;
  /** World events of the last few game days, and what was learned from them (one sample per event). */
  events?: WorldEventInfo[];
  shockCal?: { shortageBid: Array<[string, number]>; glutAsk: Array<[string, number]>; crisisPay: Array<[string, number]>; crisisFound: number; crisisMissed: number };
  /** An expected crisis charter's id → the charter found for it; shortages whose crisis charter was settled. */
  crisisLink?: Array<[string, string]>;
  crisisResolved?: string[];
  /** Whether re-posts escalated after only our own deliveries under the pace line; absent in older saves. */
  ownTrickle?: TrickleRecord;
  /** Our expansion deliveries (posting id, server ms, tons); absent in older saves. */
  ownDelivered?: Array<[string, number, number]>;
  /** Royal monopolies in force as last read (or told of by a refused buy); absent in older saves. */
  monopolies?: MonopolyInfo[];
  /** Charters the server refuses our deliveries to for good (403: our own player's or a linked company's); absent in older saves. */
  noDelivery?: string[];
}

/** Ids of closed charters kept in a snapshot (the newest). */
const SNAPSHOT_CLOSED = 1_000;
/** Our expansion deliveries remembered (the newest): enough to span a posting's window across the fleet. */
const OWN_DELIVERED_KEPT = 500;
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
/** World events are re-read this far back (game days): a shortage's crisis charter stays open at least 10. */
const EVENT_LOOKBACK_GAME_DAYS = 11;
/** One page of the feed; a full page may be cut short (links for older events are then kept). */
const EVENT_PAGE = 200;
/** A crisis charter stays open at least this long (game days: 10 in the Channel and North Sea, up to 20 elsewhere). */
const CRISIS_OPEN_GAME_DAYS = 10;
/** A non-public charter for the good posted this soon before a shortage began is still its crisis charter (game minutes). */
const CRISIS_MATCH_SLACK_GAME_MIN = 60;
/** Tons planned on when the news names none, and the most planned on when it does. */
const CRISIS_TONS_DEFAULT = 50;
const CRISIS_TONS_MAX = 350;
/**
 * Event magnitudes aren't published. Priors, each counted as SHOCK_PRIOR_N sightings until real ones
 * come in: a shortage's bid and a glut's ask against base, a crisis charter's pay against base (the
 * Admiralty pays 1.25× at least), and the share of crisis charters found when looked for.
 */
const SHORTAGE_BID_PRIOR = 1.15;
const GLUT_ASK_PRIOR = 0.85;
const CRISIS_PAY_PRIOR = 1.25;
const CRISIS_FOUND_PRIOR = 0.6;
const SHOCK_PRIOR_N = 4;
const SHOCK_SAMPLES_MAX = 50;
/** A price teaches what a shock does only while at least this share of it is left. */
const SHOCK_SAMPLE_MIN_FADE = 0.5;
/** News this fresh (game hours) goes to the fleet log. */
const EVENT_NOTE_GAME_H = 2;
/** Live customs and what ports trade drift: the catalog is re-read this often, and at once after a structural shift. */
const CATALOG_REFRESH_MS = 30 * 60_000;
/** An expected crisis charter stands under this id prefix (plus the event id) until the real one is listed. */
export const PROVISIONAL_PREFIX = "crisis:";

/** The mean of learned ratios with the prior counted as SHOCK_PRIOR_N of them, kept within bounds. */
const ratioOf = (xs: Array<[string, number]>, prior: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, (xs.reduce((n, [, r]) => n + r, 0) + prior * SHOCK_PRIOR_N) / (xs.length + SHOCK_PRIOR_N)));

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
  /**
   * It re-posts richer if it stays like this: under the guide's pace line, no rival delivery, and none of ours
   * either until re-posts showed ours don't cancel it (World.judge).
   */
  stalled: boolean;
  /** This posting's tons, and when it began (server ms): known from its posting time or a re-post seen happen, else its lapse less the usual window. */
  required?: number;
  startAt?: number;
  startKnown?: boolean;
  /** Tons in this posting (undefined: unknown, the feed's count may be cumulative), and how many of them are ours. */
  delivered?: number;
  ownTons?: number;
  /** Someone else delivered into this posting (a sibling company of ours counts: the server sees another company). */
  rivalDelivered?: boolean;
  /** Under STALL_PACE_SHARE of the pace so far, and that line in tons (as of the last judgement). */
  underPace?: boolean;
  line?: number;
  /** Under the line late in its window with only our tons in it (or since): its re-post tests whether ours cancel the escalation. */
  lateTrickle?: boolean;
  /** Seen stalled within a couple of game hours of its lapse (for learning how often stalls hold). */
  lateStalled?: boolean;
  /** One of our own ships delivered to this posting: its fate says nothing about rivals. */
  ourDelivery?: boolean;
  /** When we first saw this posting (server ms) and its delivered total then. */
  postingSeenAt: number;
  postingBase: number;
  /** We saw this posting replace the previous one, so postingBase is its start. */
  sawStart: boolean;
  /** Stalled as of the last listing (notices may clear `stalled` in between), and that listing's time. */
  seenStalled?: boolean;
  lastAt?: number;
}

/** Storms as the fleet sees them (dashboard, AI digest). */
export interface StormSummary {
  /** Storm season now (game months 11-2), and when that next changes (ISO, projected from the clock). */
  season: boolean;
  turnsAt: string | null;
  /** Storms our voyages met, against what the prior model expected of them. */
  seen: number;
  expected: number;
  /** A rated hull's storm hits per game day at sea, as a multiple of its zone's storm rate, by season. */
  perDay: { calm: number; storm: number };
  /** Share of every stack a hit destroys, and the chance a hit sinks the ship (learned). */
  take: number;
  sinkRate: number;
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
  /** Posted (server ms) and the listing's `metadata.charter_kind`, when known. */
  createdAt?: number | null;
  kind?: string | null;
  /** Expected from a shortage's news, not listed yet (`crisis:<event id>`): trusted at most `trustCap`. */
  provisional?: boolean;
  trustCap?: number;
  /** Who pays deliveries (`issuer`: a player charter, paid from its issuer's escrow) and the issuing company; absent in older saves. */
  fundedBy?: CharterFunding | null;
  issuer?: string | null;
}

/** A royal monopoly in force (guide 3.9): only its holder buys the good from the Crown's asks across the banking region. */
export interface MonopolyInfo {
  id: string;
  region: BankingRegion;
  good: string;
  /** "" when only a refused buy told of it (the holder named in words), until the list shows it. */
  holderId: string;
  holder: string;
  expiresAt: number;
}

/** Goods the Crown never sells a monopoly on (guide 3.9). */
const NEVER_MONOPOLISED = new Set(["provisions", "silver_bullion"]);
/** A monopoly known only from a refused buy stands this long (game hours) unless the list shows it first. */
const MONOPOLY_SEEN_GAME_H = 6;

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
  /**
   * The best players' (not the NPC ladder's) resting ask our bids can fill and the tons at that price: from a
   * live book's depth (ours left out) or gossip (anonymous: may be ours). Null: none seen; absent: not known.
   */
  playerAsk?: number | null;
  playerAskQty?: number;
  /**
   * The best players' resting bid and its tons, as the coffee-house news gave it (gossip only: a live book's bid already
   * counts players' bids). Anonymous: our own resting orders are left out against GET /v1/market/orders (playerLevel).
   */
  playerBid?: number | null;
  playerBidQty?: number;
}

/** Our own company's resting order (GET /v1/market/orders), as the gossip's anonymous best levels may show it. */
interface OwnOrder {
  id: string;
  side: "bid" | "ask";
  price: number;
  /** Tons still resting. */
  tons: number;
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
      createdAt: c.created_at ? Date.parse(c.created_at) : null,
      kind: typeof c.metadata?.charter_kind === "string" ? c.metadata.charter_kind : null,
      fundedBy: c.funded_by ?? (typeof c.metadata?.funded_by === "string" ? (c.metadata.funded_by as CharterFunding) : null),
      issuer: c.issuer_company_id ?? null,
    }));
}

/** A world event as the planner uses it (GET /v1/world/events). */
export interface WorldEventInfo {
  id: string;
  type: WorldEventType;
  port: string | null;
  zone: string | null;
  good: string | null;
  /** The public charter it spawned (Admiralty mobilization). */
  charterId: string | null;
  addedPiracyBps: number | null;
  structural: boolean;
  /** Server ms. For a structural shift `expiresAt` is when the news lapses, not the shift. */
  startsAt: number;
  expiresAt: number;
  /** Tons the text names ("…charter for 350t"): events carry no magnitudes, but a shortage's text sizes its crisis charter. */
  tons: number | null;
  title: string;
}

/** What the dashboard shows of one event. */
export interface WorldEventRow extends Pick<WorldEventInfo, "id" | "type" | "port" | "zone" | "good" | "title" | "startsAt" | "expiresAt"> {
  /** What the planner does with it, in a few words. */
  effect: string;
  /** A shortage's crisis charter: expected (not listed yet), found, or found missing. */
  crisis: "expected" | "found" | "missing" | null;
}

export interface WorldEventsReport {
  /** Planning on shocks' prices and expected crisis charters (the setting). */
  enabled: boolean;
  rows: WorldEventRow[];
  /** Learned (n: events seen; 0 means the prior): a shortage's bid and a glut's ask against base, crisis pay against base, the share of crisis charters found. */
  shortageBid: { ratio: number; n: number };
  glutAsk: { ratio: number; n: number };
  crisisPay: { ratio: number; n: number };
  crisisFound: { rate: number; n: number };
}

const WORLD_EVENT_TYPES: WorldEventType[] = ["supply_boom", "demand_shortage", "admiralty_mobilization", "pirate_outbreak", "production_collapse", "production_boom", "import_slump"];

function toEvent(e: WorldEventResult): WorldEventInfo | null {
  if (!e || typeof e.id !== "string") return null;
  const startsAt = Date.parse(e.starts_at);
  const expiresAt = Date.parse(e.expires_at);
  if (!WORLD_EVENT_TYPES.includes(e.event_type) || !Number.isFinite(startsAt) || !Number.isFinite(expiresAt)) return null;
  const m = /\bfor (\d[\d,]*)\s?t\b/i.exec(e.description ?? "");
  const tons = m ? Number(m[1].replace(/,/g, "")) : NaN;
  return {
    id: e.id,
    type: e.event_type,
    port: e.target_port_id ?? null,
    zone: e.target_sea_zone_id ?? null,
    good: e.commodity_id ?? null,
    charterId: e.charter_id ?? null,
    addedPiracyBps: e.added_piracy_bps ?? null,
    structural: !!e.structural,
    startsAt,
    expiresAt,
    tons: Number.isFinite(tons) && tons > 0 ? tons : null,
    title: e.title ?? e.event_type,
  };
}

export class World {
  catalog!: Catalog;
  unlockedPhase = 1;
  timeScale = 60;
  paused = false;
  /** Server time the operators announced the season ends (`season_planned_end_at`; null: not announced). */
  seasonEndsAt: number | null = null;
  /** Server clock minus local clock, ms. */
  skewMs = 0;
  charters: CharterInfo[] = [];
  /** Open freight lots we can see, at ports where we have presence. */
  freight: FreightInfo[] = [];
  /** Our company (to skip freight we posted ourselves). */
  companyId: string | null = null;
  /** Every company of our player (the manager fills it): their charters and freight are never ours to deliver or carry. */
  readonly ourCompanyIds = new Set<string>();
  /** Charters the server refused our deliveries to for good (403): a linked company's we can't see, say. */
  private readonly noDelivery = new Set<string>();
  /** Royal monopolies in force (GET /v1/world/monopolies, with the world; events and refused buys in between). */
  monopolies: MonopolyInfo[] = [];
  /** Other companies' ships and voyages: seen at ports where we have presence, and (rival intel) public records. */
  readonly rivals = new RivalTracker((g) => (this.catalog ? this.basePrice(g) : 0));
  vaults = new Map<BankingRegion, number>();
  /** Our vault accounts' ids and their regions (to read the ledger). */
  readonly vaultAccounts = new Map<string, BankingRegion>();
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
  /** Re-posts after only our own deliveries under the pace line: whether ours cancel the escalation (noteTrickleFate). */
  private ownTrickle: TrickleRecord = { confirmed: 0, refuted: 0, samples: [] };
  /** Our charter deliveries in flight (or of unknown outcome, for a while) by posting: a listing meanwhile may already count them. */
  private readonly inFlight = new Map<string, Array<{ tons: number; until: number }>>();
  /** Our expansion deliveries (posting id, server ms, tons), newest last: a re-post seen after ours went into it counts them as ours. */
  private ownDelivered: Array<[id: string, at: number, tons: number]> = [];
  /** Berth dues a game day per port, as its port view (or a dock) last gave them. */
  private readonly berthDues = new Map<string, number>();
  /** Resting orders (`port|good|side` → order ids) ours can't trade with: our own other companies' (guide 3.2). */
  private readonly unfillable = new Map<string, Set<string>>();
  /** Customs per port as a book or port view last gave it (server time): newer than the catalog's, it wins. */
  private readonly customsSeen = new Map<string, { bps: number; at: number }>();
  /** Our own pirate raids: shares of cargo taken (captures aside), and captures seen. */
  private raidTakes: number[] = [];
  captures = 0;
  /** Our own voyages' storm record per cell, and shares of cargo storms destroyed. */
  private stormCells = new Map<string, { exp: number; hits: number; sinks: number }>();
  private stormTakes: number[] = [];
  /** Learned multipliers on the prior storm odds per cell and fleet-wide (recomputed when the record changes; read per planned leg). */
  private stormMult = new Map<string, number>();
  private stormMultAll = 1;
  stormBootstrapped = false;
  /** The calendar at the last clock read: game hours since 1 March 1700, its month, the server time of the read. */
  private calendar: { hours: number; month: number; at: number; projectable: boolean } | null = null;
  private zoneIndex: Map<string, Catalog["sea_zones"][number]> | null = null;
  /** A remembered bid against the next live one at the same port: (age in game days, live/remembered). */
  private bidSamples: Array<[number, number]> = [];
  /** bidHaircutPerDay, recomputed when a sample comes in (read thousands of times per plan). */
  private bidHaircut = BID_HAIRCUT_DEFAULT;
  /**
   * Rival ships due at (or just in at) each port, from the rival analysis: they may take charter
   * room before we land, or end a stall.
   */
  rivalLandings = new Map<string, RivalLanding[]>();
  /** World events of the last few game days (the public feed), newest first. */
  events: WorldEventInfo[] = [];
  /** From the settings: plan on shocks' expected prices and on crisis charters not listed yet. */
  planOnEvents = true;
  /** A line for the fleet log (news the planner acts on, a crisis charter found or missing). */
  onNote?: (msg: string) => void;
  /** Events by `port|good`, newest first; pirate outbreaks (read per route leg). */
  private shockIndex = new Map<string, WorldEventInfo[]>();
  private outbreaks: WorldEventInfo[] = [];
  private shockCal = { shortageBid: [] as Array<[string, number]>, glutAsk: [] as Array<[string, number]>, crisisPay: [] as Array<[string, number]>, crisisFound: 0, crisisMissed: 0 };
  private readonly crisisLink = new Map<string, string>();
  private readonly crisisResolved = new Set<string>();
  /** Server time the zones and the catalog were last read; a structural shift since asks for a re-read. */
  private piracyAt = 0;
  private catalogAt = 0;
  private catalogDue = false;
  /** Use rival intel beyond quay sightings (the `rivalIntel` setting; set by the manager). */
  rivalIntel = true;
  /** Active trading companies (expansion board), or null before the first read. */
  activeCompanies: number | null = null;
  /** Expansion charters of the tier in play by `port|good`: our own flow into each, and its rival record. */
  private readonly lineages = new Map<string, Lineage>();
  private tierSamples: Array<{ at: number; delivered: number; phase: number }> = [];
  /** Share value of a ton per expansion charter (pence: its base price, as the bonus split counts it), and the pool's rate on it (the linear fallback). */
  private expansionValue = new Map<string, number>();
  private expansionRate = EXPANSION_BONUS_SHARE;
  /**
   * The tier's contribution board as last read (guide 3.15): the bonus pool, the base value delivered so far and its
   * projection at completion (pence), and each company's share of it; null with no tier in play or nobody on it.
   */
  private bonusBoard: { pool: number; delivered: number; projected: number; contributors: Array<{ company_name: string; share_bps: number }> } | null = null;
  /** Our company's resting orders by `port|good` (market/orders), and when they were read (local ms; 0: never). */
  private ownOrders = new Map<string, OwnOrder[]>();
  private ownOrdersAt = 0;
  /** The Lloyd's List as each quay last posted it (local ms): underwriters' recent results, policies open there. */
  private readonly lloydsSeen = new Map<string, { at: number; notice: LloydsListNotice }>();
  /**
   * What each quay we stand on held when its port view was last read (local ms): the coffee-house reports' ages then
   * (real ms) and the sailing notices' times (server ms), with whose ship each was (ours are never sealed). What an
   * intelligence envelope sealed there could hold (not saved).
   */
  readonly quayNews = new Map<string, { at: number; reports: number[]; sailings: Array<{ at: number; company: string; ship: string }> }>();
  private rates = new Map<string, number>();
  private prices = new Map<string, PriceObs>();
  /** Last live copy of each charter seen live, for recall when it drops out of a listing. */
  private readonly liveSeen = new Map<string, { c: CharterInfo; seenAt: number }>();
  /** When each port's charters were last listed live on arrival (local ms). */
  private readonly mergedAt = new Map<string, number>();
  /** Charters we saw filled or closed. */
  private readonly closed = new Set<string>();
  private routes = new Map<string, { p: Promise<RoutePlan>; at: number }>();
  /** Safe stores per route as departures warned of them (`from>to>class`). */
  private readonly safeSeen = new Map<string, number>();
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

  /** Real ms of the season left, the slack taken off (Infinity until the end is announced). */
  seasonLeftMs(now = this.now()): number {
    return this.seasonEndsAt === null ? Infinity : this.seasonEndsAt - SEASON_END_SLACK_MS - now;
  }

  /** Whether server time `at` falls before the season ends (with the slack): charters and freight pay nothing after. */
  beforeSeasonEnd(at: number): boolean {
    return this.seasonEndsAt === null || at <= this.seasonEndsAt - SEASON_END_SLACK_MS;
  }

  /** normal; endgame (under SEASON_ENDGAME_MS left: no new hulls); final (under SEASON_FINAL_MS). */
  seasonMode(now = this.now()): "normal" | "endgame" | "final" {
    const left = this.seasonLeftMs(now);
    return left < SEASON_FINAL_MS ? "final" : left < SEASON_ENDGAME_MS ? "endgame" : "normal";
  }

  async init(): Promise<void> {
    this.catalog = await this.client.catalog();
    // Structural news older than this read is already in it.
    this.catalogAt = Date.now() + this.skewMs;
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
      rivalIntel: this.rivals.snapshot(),
      lineages: [...this.lineages],
      stallFates: { ...this.stallFates },
      bidSamples: [...this.bidSamples],
      raidTakes: [...this.raidTakes],
      captures: this.captures,
      stormCells: [...this.stormCells].map(([k, v]) => [k, { ...v }]),
      stormTakes: [...this.stormTakes],
      stormBootstrapped: this.stormBootstrapped,
      events: this.events.slice(0, EVENT_PAGE),
      shockCal: { ...this.shockCal, shortageBid: [...this.shockCal.shortageBid], glutAsk: [...this.shockCal.glutAsk], crisisPay: [...this.shockCal.crisisPay] },
      crisisLink: [...this.crisisLink],
      crisisResolved: [...this.crisisResolved],
      ownTrickle: { ...this.ownTrickle, samples: [...this.ownTrickle.samples] },
      ownDelivered: [...this.ownDelivered],
      monopolies: this.monopolies.map((m) => ({ ...m })),
      noDelivery: [...this.noDelivery].slice(-SNAPSHOT_CLOSED),
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
    // Policies and convoys before sightings, so restored sightings can match them.
    if (s.rivalIntel) this.rivals.restore(s.rivalIntel);
    for (const x of s.sightings ?? []) this.rivals.add(x);
    for (const [k, v] of s.lineages ?? []) this.lineages.set(k, { ...this.newLineage(), ...v });
    if (s.stallFates) this.stallFates = { ...s.stallFates };
    if (s.bidSamples) this.bidSamples = s.bidSamples.slice(-BID_SAMPLES_MAX);
    if (s.raidTakes) this.raidTakes = s.raidTakes.slice(-100);
    this.captures = s.captures ?? 0;
    for (const [k, v] of s.stormCells ?? []) {
      if (Number.isFinite(v?.exp) && Number.isFinite(v?.hits)) this.stormCells.set(k, { exp: v.exp, hits: v.hits, sinks: v.sinks ?? 0 });
    }
    if (s.stormTakes) this.stormTakes = s.stormTakes.filter((x) => Number.isFinite(x)).slice(-100);
    this.stormBootstrapped = s.stormBootstrapped ?? false;
    this.updateStormMult();
    if (s.events) {
      this.events = s.events.slice(0, EVENT_PAGE);
      this.indexEvents();
    }
    const k = s.shockCal;
    if (k) {
      this.shockCal = {
        shortageBid: (k.shortageBid ?? []).slice(-SHOCK_SAMPLES_MAX),
        glutAsk: (k.glutAsk ?? []).slice(-SHOCK_SAMPLES_MAX),
        crisisPay: (k.crisisPay ?? []).slice(-SHOCK_SAMPLES_MAX),
        crisisFound: k.crisisFound ?? 0,
        crisisMissed: k.crisisMissed ?? 0,
      };
    }
    for (const [a, b] of s.crisisLink ?? []) this.crisisLink.set(a, b);
    for (const id of s.crisisResolved ?? []) this.crisisResolved.add(id);
    const t = s.ownTrickle;
    if (t && Number.isFinite(t.confirmed) && Number.isFinite(t.refuted)) {
      this.ownTrickle = { confirmed: t.confirmed, refuted: t.refuted, samples: Array.isArray(t.samples) ? t.samples.slice(-OWN_TRICKLE_SAMPLES) : [] };
    }
    if (Array.isArray(s.ownDelivered)) {
      this.ownDelivered = s.ownDelivered.filter((x) => Array.isArray(x) && typeof x[0] === "string" && Number.isFinite(x[1]) && Number.isFinite(x[2])).slice(-OWN_DELIVERED_KEPT);
    }
    // Lapsed grants drop out at the first look (monopolyBars checks the expiry, the refresh re-reads the list).
    if (Array.isArray(s.monopolies)) {
      this.monopolies = s.monopolies.filter((m) => m && typeof m.region === "string" && typeof m.good === "string" && Number.isFinite(m.expiresAt));
    }
    for (const id of s.noDelivery ?? []) if (typeof id === "string") this.noDelivery.add(id);
    this.updateBidHaircut();
  }

  /** Clock, charters, fees, vaults and world events (and the catalog now and again). */
  async refresh(): Promise<void> {
    await this.readClock();
    await this.refreshListings();
  }

  /** The clock alone: skew, phase, time scale, the pause flag, the season's end, the calendar (all a paused world reads). */
  async readClock(): Promise<void> {
    const t0 = Date.now();
    const clock = await this.client.clock();
    const t1 = Date.now();
    this.skewMs = Date.parse(clock.real_utc) - (t0 + t1) / 2;
    // New waters: the shortest unlocked routes (what depart sails) may now cross them.
    if (clock.unlocked_phase !== this.unlockedPhase) this.routes.clear();
    this.unlockedPhase = clock.unlocked_phase;
    this.timeScale = clock.calendar.time_scale || 60;
    this.paused = clock.paused;
    const end = clock.season_planned_end_at ? Date.parse(clock.season_planned_end_at) : NaN;
    const ends = Number.isFinite(end) ? end : null;
    if (ends !== null && ends !== this.seasonEndsAt) this.onNote?.(`the operators announced the season ends ${new Date(ends).toISOString()}: only work landing before then is planned`);
    this.seasonEndsAt = ends;
    // The calendar, to tell storm season at any time ahead: 30-day months from 1 March (spec). If the
    // projection doesn't give the month the clock gives, the clock's month is used as it stands.
    const cal = clock.calendar;
    const readAt = Date.parse(clock.real_utc);
    if (cal && Number.isFinite(cal.total_game_hours) && Number.isFinite(readAt) && cal.month >= 1 && cal.month <= 12) {
      this.calendar = { hours: cal.total_game_hours + (cal.minute ?? 0) / 60, month: cal.month, at: readAt, projectable: true };
      this.calendar.projectable = this.monthAt(readAt) === cal.month;
    }
  }

  private async refreshListings(): Promise<void> {
    const asked = Date.now();
    const since = new Date(this.now() - EVENT_LOOKBACK_GAME_DAYS * 24 * 60 * this.gameMinuteMs).toISOString();
    const [listing, freight, rates, zones, expansion, events, , monopolies] = await Promise.all([
      this.client.contractPages({ contract_type: "charter", status: "open" }),
      this.client.contractPages({ contract_type: "freight", status: "open" }).catch(() => null),
      this.client.rates(),
      this.client.zones().catch(() => null),
      this.client.expansion().catch(() => null),
      // Public. A stream world_event only prompts this read (its payload isn't specified, and a port-scoped one may never reach us).
      this.client.worldEvents({ include_expired: true, since, limit: EVENT_PAGE }).catch(() => null),
      this.refreshVaults(),
      // Public: who holds which royal monopoly (an unread list keeps the last one).
      this.client.monopolyPages().catch(() => null),
      // Our own resting orders now and again: the news' anonymous best levels may be ours.
      this.refreshOwnOrders(),
    ]);
    const list = listing.items;
    if (freight) this.freight = toFreight(freight.items);
    if (monopolies?.complete) this.setMonopolies(monopolies.items);
    if (zones) {
      this.piracy = new Map(zones.map((z) => [z.sea_zone_id, z.net_piracy_bps]));
      this.piracyAt = asked + this.skewMs;
    }
    if (Array.isArray(events)) this.noteEvents(events.map(toEvent).filter((e): e is WorldEventInfo => e !== null), events.length < EVENT_PAGE);
    if (expansion) {
      const tier = expansion.current_tier;
      this.activeCompanies = expansion.active_trading_companies ?? null;
      const live = tier && !tier.completed ? tier : null;
      // Who delivered how much to which charter since the last look (rival profiles, stall odds).
      const rivalTons = this.rivals.observeExpansion(live, this.now(), (k, d) => this.ownShare(k, d));
      this.expansionCharters = new Set(tier && !tier.completed ? tier.charters.filter((c) => c.status === "open").map((c) => c.contract_id) : []);
      this.expansionTonsLeft = tier && !tier.completed ? tier.tons_remaining : 0;
      // When each charter was posted: an expansion posting's pace line counts from there.
      const posted = new Map<string, number>();
      for (const c of list) {
        const t = c.created_at ? Date.parse(c.created_at) : NaN;
        if (Number.isFinite(t)) posted.set(c.id, t);
      }
      this.watchExpansion(live, rivalTons, posted);
      if (tier && !tier.completed) {
        // Project the tier's final value: what is delivered, plus the tons still needed at the mix
        // delivered so far, every ton at its base price (the share counts no premium). The pool over
        // that is the bonus per unit of value.
        const value = new Map(tier.charters.map((c) => [c.contract_id, this.basePrice(c.commodity_id)]));
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
        // The board the square-root split works from (guide 3.15); the pool as published, else 12% of the projection.
        const contributors = (tier.contributors ?? []).filter((c) => typeof c.company_name === "string" && Number.isFinite(c.share_bps) && c.share_bps > 0);
        this.bonusBoard = contributors.length
          ? { pool: tier.completion_bonus_pence > 0 ? tier.completion_bonus_pence : EXPANSION_BONUS_SHARE * projected, delivered, projected: Math.max(projected, delivered), contributors }
          : null;
      } else this.bonusBoard = null;
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
    this.charters = this.withProvisional(
      this.withRecalled([
        ...fresh.filter((c) => !newer.has(c.port)),
        ...this.charters.filter((c) => newer.has(c.port)),
      ]),
    ).filter((c) => this.deliverable(c));
    this.rates = new Map(rates.map((r) => [`${r.from_region}>${r.to_region}`, r.fee_bps]));
    // What ports make and import changes with a structural shift, and customs drift: re-read the catalog then, and now and again.
    if (this.catalogDue || this.now() - this.catalogAt > CATALOG_REFRESH_MS) await this.refreshCatalog().catch(() => undefined);
  }

  /**
   * Follows each expansion charter across its postings: whether the current one is stalled (it
   * re-posts richer if it stays under the pace line with no rival delivery before it lapses), what an
   * escalation did to the pay and tons when we saw one, whether our own small deliveries cancel it
   * (learned at re-posts), and how fast the tier as a whole is filling. `rivalTons`: rival tons
   * delivered per charter since the last listing (the contribution board's deltas); `posted`: the
   * charter listing's posting times by id.
   */
  private watchExpansion(tier: ExpansionTier | null, rivalTons = new Map<string, number>(), posted = new Map<string, number>()): void {
    const now = this.now();
    if (!tier) {
      if (this.tierTargetPhase !== null) this.tierTurnedAt = now;
      this.expansionWatch.clear();
      this.lineages.clear();
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
      // A new tier's charters are new lineages.
      this.lineages.clear();
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
      // A posting only our ships delivered to, under the line, watched to its lapse: did its re-post still escalate?
      const tested = prev && newPosting ? (prev.lateTrickle && !prev.rivalDelivered && !((rivalTons.get(key) ?? 0) > 0) ? prev : null) : lapsed?.lateTrickle ? lapsed : null;
      if (tested) this.noteTrickleFate(key, tested, c);
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
      const l = this.lineage(key);
      // A re-post seen within a listing of its start: how long its postings run.
      const seenStart = newPosting && prev?.lastAt !== undefined && now - prev.lastAt <= EXPOSURE_GAP_MS && expiresAt !== null && expiresAt > now;
      if (seenStart) l.windowMs = expiresAt - now;
      // Its listed posting time gives that exactly, unless the span is too long for one posting (a re-post kept
      // an earlier posting's id and time).
      const created = posted.get(c.contract_id);
      const createdAt = created !== undefined && expiresAt !== null && expiresAt > created && expiresAt - created <= 1.5 * this.defaultWindowMs(tier.target_phase) ? created : null;
      if (createdAt !== null) l.windowMs = expiresAt! - createdAt;
      // When this posting began: posted, seen replace the last one, carried over; else its lapse less the usual window.
      const startKnown = createdAt !== null || seenStart || (!newPosting && !!prev.startKnown);
      const startAt =
        createdAt ?? (seenStart ? now : !newPosting && prev.startKnown ? prev.startAt : expiresAt !== null ? expiresAt - this.postingWindowMs(key) : undefined);
      // Tons in this posting: the feed counts quantity_delivered per posting (across postings is
      // tons_delivered_total). Without a lineage total the count may be cumulative: what grew since we
      // watched this posting start, once watched a while; unknown before that.
      // A new posting starts with ours logged into it before this listing showed it: into the same id after the last
      // posting's lapse, or into a new id since its listed start (never taken for a rival's).
      const last = prev ?? lapsed;
      const since = last && last.id === c.contract_id ? (last.expiresAt ?? -Infinity) : (createdAt ?? -Infinity);
      const ownTons = newPosting ? this.ownTonsSince(c.contract_id, since) : (prev.ownTons ?? 0);
      const inPosting = c.quantity_delivered === 0 ? 0 : c.tons_delivered_total !== undefined ? c.quantity_delivered : watchedLongEnough ? total - postingBase : null;
      // Anyone else's tons, a sibling company's included (the server sees another company). Ours in flight
      // aren't anyone else's.
      const rivalDelivered = (!newPosting && !!prev.rivalDelivered) || (inPosting !== null && inPosting > ownTons + this.inFlightTons(c.contract_id) + 0.5);
      const w: ExpansionWatch = {
        id: c.contract_id,
        port: c.port_id,
        good: c.commodity_id,
        rate: c.reward_per_ton_pence,
        remaining: c.quantity_remaining,
        expiresAt,
        escalations: c.escalations,
        beyondCoastal: c.beyond_coastal_water,
        deliveredTotal: total,
        stalled: false,
        lastAt: now,
        postingSeenAt,
        postingBase,
        sawStart,
        lateStalled: false,
        required: c.quantity_required,
        startAt,
        startKnown,
        // A listing a moment behind our own delivery: never fewer than ours.
        delivered: inPosting === null ? undefined : Math.max(inPosting, ownTons),
        ownTons,
        rivalDelivered,
        // Kept within a posting; a new posting starts clean (but for ours logged into it already).
        ourDelivery: newPosting ? ownTons > 0 : !!prev.ourDelivery,
      };
      this.judge(w, now);
      const stalled = w.stalled;
      w.seenStalled = stalled;
      // How rivals treat it: game hours it sat stalled while watched, and stalls they broke (any other
      // company's delivery ends one, our sibling companies' included; this company's aren't in `rivalTons`).
      if (prev?.seenStalled && prev.lastAt !== undefined) {
        const end = newPosting && prev.expiresAt !== null ? Math.min(now, prev.expiresAt) : now;
        l.stalledH += Math.max(0, Math.min(end - prev.lastAt, EXPOSURE_GAP_MS)) / (60 * this.gameMinuteMs);
      }
      // Across a re-post the tons went into the old posting (still stalled when last listed) or the new one.
      if ((rivalTons.get(key) ?? 0) > 0 && prev && (newPosting ? !!prev.seenStalled || !stalled : !!prev.seenStalled && !stalled)) l.breaks++;
      const late = expiresAt !== null && expiresAt - now <= LATE_STALL_GAME_H * 60 * this.gameMinuteMs && expiresAt > now;
      // A late stall broken by someone else's delivery before the lapse: it didn't hold.
      if (prev && !newPosting && prev.lateStalled && !stalled && !w.ourDelivery) this.stallFates.not++;
      // Carried over within a posting.
      w.lateStalled = stalled && ((!newPosting && !!prev.lateStalled) || late);
      // Under the line late in its window with only our tons in it: its re-post tests whether ours cancel the escalation.
      w.lateTrickle = !!w.underPace && startKnown && !rivalDelivered && ownTons > 0 && ((!newPosting && !!prev.lateTrickle) || late);
      this.expansionWatch.set(key, w);
    }
    for (const [k, w] of [...this.expansionWatch]) {
      if (seen.has(k)) continue;
      // Gone from the listing before its lapse: filled or closed. After it: awaiting its re-post.
      if (w.expiresAt !== null && w.expiresAt <= now) {
        this.lapsedPostings.set(k, {
          id: w.id,
          expiresAt: w.expiresAt,
          lateStalled: w.lateStalled && !w.ourDelivery,
          escalations: w.escalations,
          lateTrickle: !!w.lateTrickle && !w.rivalDelivered,
          ownTons: w.ownTons,
          line: w.line,
          rate: w.rate,
          remaining: w.remaining,
        });
      }
      this.expansionWatch.delete(k);
    }
    for (const k of seen) this.lapsedPostings.delete(k);
  }

  /**
   * The guide's stall (under a tenth of the pace its tons over its window imply so far, guide 3.8) and
   * whether the re-post still escalates: never after anyone else's delivery ("any rival delivering
   * cancels the escalation"); after only ours, not until re-posts showed ours don't cancel it.
   */
  private judge(w: ExpansionWatch, now = this.now()): void {
    if (w.delivered === undefined) {
      w.underPace = w.stalled = false;
      return;
    }
    const span = w.expiresAt !== null && w.startAt !== undefined ? w.expiresAt - w.startAt : 0;
    const frac = span > 0 ? Math.min(1, Math.max(0, (now - w.startAt!) / span)) : 1;
    w.line = STALL_PACE_SHARE * (w.required ?? 0) * frac;
    w.underPace = w.delivered === 0 || w.delivered < w.line;
    w.stalled = w.underPace && !w.rivalDelivered && (!((w.ownTons ?? 0) > 0) || this.ownTrickleOk);
  }

  /**
   * A posting only our ships delivered to (under the line, late in its window) was re-posted: did it
   * still escalate? Only the escalation count says so (a re-post's pay follows the port's NPC bid, so richer
   * pay alone isn't one). OWN_TRICKLE_CONFIRM in a row allow ours into camped postings (under the line); one
   * that didn't resets that (a stall can fail to escalate for other reasons: deliberately strict).
   */
  private noteTrickleFate(key: string, t: { escalations?: number; rate?: number; remaining?: number; ownTons?: number; line?: number }, c: ExpansionTier["charters"][number]): void {
    const payRatio = t.rate ? c.reward_per_ton_pence / t.rate : null;
    const tonsRatio = t.remaining ? c.quantity_remaining / t.remaining : null;
    const escalated = c.escalations > (t.escalations ?? 0);
    const r = this.ownTrickle;
    const was = this.ownTrickleOk;
    r.samples = [...r.samples, { at: this.now(), key, ownTons: t.ownTons ?? 0, line: Math.round(t.line ?? 0), escalated, payRatio, tonsRatio }].slice(-OWN_TRICKLE_SAMPLES);
    if (escalated) r.confirmed++;
    else {
      r.refuted++;
      r.confirmed = 0;
    }
    const [port, good] = key.split("|");
    this.onNote?.(
      this.ownTrickleOk !== was
        ? this.ownTrickleOk
          ? `our own small deliveries didn't cancel ${OWN_TRICKLE_CONFIRM} re-posts: delivering under the pace line into postings let lapse from now on`
          : `the ${good} charter at ${port} didn't escalate after only our ${t.ownTons ?? 0} t: none of ours into postings let lapse again`
        : `the ${good} charter at ${port} re-posted after only our ${t.ownTons ?? 0} t (under its ${Math.round(t.line ?? 0)} t pace line): ` +
            `${escalated ? "escalated" : "did not escalate"} (${r.confirmed}/${OWN_TRICKLE_CONFIRM} to allow ours)`,
    );
  }

  /** Re-posts have shown our own deliveries under the pace line don't cancel the escalation (noteTrickleFate). */
  get ownTrickleOk(): boolean {
    return this.ownTrickle.confirmed >= OWN_TRICKLE_CONFIRM;
  }

  /** What re-posts showed about our own small deliveries (dashboard). */
  trickleRecord(): TrickleRecord {
    return { ...this.ownTrickle, samples: [...this.ownTrickle.samples] };
  }

  /**
   * Tons of ours that may go into this stalled posting now and keep it under the line (with
   * TRICKLE_SAFETY): 0 until learned safe, after anyone else's delivery, or with its start unknown.
   */
  trickleRoom(charterId: string, now = this.now()): number {
    if (!this.ownTrickleOk) return 0;
    const id = this.currentId(charterId);
    const w = [...this.expansionWatch.values()].find((x) => x.id === id);
    if (!w || !w.startKnown || w.rivalDelivered || w.delivered === undefined) return 0;
    // The line rises with time.
    this.judge(w, now);
    if (!w.stalled) return 0;
    return Math.max(0, Math.ceil(w.line! * TRICKLE_SAFETY) - 1 - Math.ceil(w.delivered + this.inFlightTons(id)));
  }

  /**
   * Marks our deliveries into these charters in flight until the returned function is called (once the
   * result is booked: noteOwnDelivery), so a listing meanwhile doesn't read them as anyone else's.
   * `unsure` (the call may have gone through): they stay marked for OWN_PENDING_MS.
   */
  delivering(entries: Array<{ id: string; tons: number }>): (unsure?: boolean) => void {
    const marks = entries
      .filter((e) => e.tons > 0)
      .map((e) => {
        const id = this.currentId(e.id);
        const mark = { tons: e.tons, until: Infinity };
        this.inFlight.set(id, [...(this.inFlight.get(id) ?? []), mark]);
        return { id, mark };
      });
    return (unsure = false) => {
      for (const { id, mark } of marks) {
        if (unsure) mark.until = this.now() + OWN_PENDING_MS;
        else {
          const left = (this.inFlight.get(id) ?? []).filter((m) => m !== mark);
          if (left.length) this.inFlight.set(id, left);
          else this.inFlight.delete(id);
        }
      }
    };
  }

  /** Our tons delivered into this posting id after server time `since` (noteOwnDelivery's log). */
  private ownTonsSince(id: string, since: number): number {
    return this.ownDelivered.reduce((n, [x, at, t]) => (x === id && at > since ? n + t : n), 0);
  }

  /** Our tons in flight into this posting (World.delivering). */
  private inFlightTons(id: string): number {
    const marks = this.inFlight.get(id);
    if (!marks) return 0;
    const now = this.now();
    const live = marks.filter((m) => m.until > now);
    if (live.length === 0) this.inFlight.delete(id);
    else if (live.length < marks.length) this.inFlight.set(id, live);
    return live.reduce((n, m) => n + m.tons, 0);
  }

  /**
   * One of our ships delivered `tons` to this charter: they count in its posting as ours (judged again:
   * ours end a stall until re-posts show they don't), its stall fate isn't learned from it, and the tons
   * are ours when its delivered total next grows (not a rival's).
   */
  noteOwnDelivery(c: { id: string; port: string; good: string }, tons: number): void {
    if (!(tons > 0)) return;
    const id = this.currentId(c.id);
    const now = this.now();
    // Expansion postings' kept by id and time: a re-post under the same id that the listing hasn't shown yet gets them (watchExpansion).
    if (this.expansionCharters.has(id) || [...this.expansionWatch.values(), ...this.lapsedPostings.values()].some((w) => w.id === id)) {
      this.ownDelivered.push([id, now, tons]);
      if (this.ownDelivered.length > OWN_DELIVERED_KEPT) this.ownDelivered.splice(0, this.ownDelivered.length - OWN_DELIVERED_KEPT);
    }
    for (const w of this.expansionWatch.values()) {
      // A lapsed posting's watch: these went into its re-post, not into it.
      if (w.id !== id || (w.expiresAt !== null && w.expiresAt <= now)) continue;
      w.ourDelivery = true;
      w.ownTons = (w.ownTons ?? 0) + tons;
      // Unknown stays unknown (judged not stalled).
      if (w.delivered !== undefined) w.delivered += tons;
      this.judge(w, now);
      const late = w.expiresAt !== null && w.expiresAt > now && w.expiresAt - now <= LATE_STALL_GAME_H * 60 * this.gameMinuteMs;
      if (late && w.underPace && w.startKnown && !w.rivalDelivered) w.lateTrickle = true;
    }
    if (!this.expansionCharters.has(id) && this.expansionWatch.get(`${c.port}|${c.good}`)?.id !== id) return;
    const l = this.lineage(`${c.port}|${c.good}`);
    l.own = [...l.own.filter(([at]) => now - at <= OWN_RATE_WINDOW_MS), [now, tons]];
    l.ownPending = (now - l.ownPendingAt > OWN_PENDING_MS ? 0 : l.ownPending) + tons;
    l.ownPendingAt = now;
  }

  /** Of `delta` tons a charter's total grew by, how many were ours (our deliveries not yet seen in it). */
  private ownShare(key: string, delta: number): number {
    const l = this.lineages.get(key);
    if (!l || this.now() - l.ownPendingAt > OWN_PENDING_MS) return 0;
    const ours = Math.min(delta, l.ownPending);
    l.ownPending -= ours;
    return ours;
  }

  private newLineage(): Lineage {
    return { own: [], ownPending: 0, ownPendingAt: 0, stalledH: 0, breaks: 0, windowMs: null };
  }

  private lineage(key: string): Lineage {
    let l = this.lineages.get(key);
    if (!l) this.lineages.set(key, (l = this.newLineage()));
    return l;
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

  /** Rival first deliveries into this charter's stalled postings per game hour stalled: its own record, pooled with the tier's. */
  rivalBreakRate(key: string): number {
    let breaks = 0;
    let hours = 0;
    for (const l of this.lineages.values()) {
      breaks += l.breaks;
      hours += l.stalledH;
    }
    const pooled = (breaks + RIVAL_BREAK_PRIOR_N) / (hours + RIVAL_BREAK_PRIOR_H);
    const l = this.lineages.get(key);
    return ((l?.breaks ?? 0) + pooled * LINEAGE_PRIOR_H) / ((l?.stalledH ?? 0) + LINEAGE_PRIOR_H);
  }

  /**
   * Chance a stalled posting re-posts richer if none of our ships delivers before it lapses: the
   * learned stall fates (they already cover a stall's last LATE_STALL_GAME_H), times the chance no
   * laden rival due at its port first delivers, times the chance no other rival breaks it in the
   * game hours before that (its rival record).
   */
  escalationOdds(w: ExpansionWatch, now = this.now()): number {
    if (!w.stalled || w.expiresAt === null || w.expiresAt <= now) return 0;
    const hours = Math.max(0, (w.expiresAt - now) / (60 * this.gameMinuteMs) - LATE_STALL_GAME_H);
    const p = this.stallSurvives * this.rivalKeep(w) * Math.exp(-this.rivalBreakRate(`${w.port}|${w.good}`) * hours);
    return Math.min(0.95, Math.max(0, p));
  }

  /** Our own tons into this expansion charter per real hour lately (across its postings). */
  ownRate(key: string): number {
    const now = this.now();
    const tons = (this.lineages.get(key)?.own ?? []).filter(([at]) => now - at <= OWN_RATE_WINDOW_MS).reduce((n, [, t]) => n + t, 0);
    return tons / (OWN_RATE_WINDOW_MS / 3_600_000);
  }

  /** Real ms this charter's postings stay open: seen at a re-post (or from a posting time), else by the tier's phase. */
  postingWindowMs(key: string): number {
    return this.lineages.get(key)?.windowMs ?? this.defaultWindowMs();
  }

  /** Real ms a tier's postings stay open by the phase it unlocks (guide 3.8: 30, 60 or 90 game days). */
  private defaultWindowMs(phase = this.tierTargetPhase ?? 2): number {
    return (POSTING_GAME_DAYS[phase] ?? 30) * 24 * 60 * this.gameMinuteMs;
  }

  /**
   * A public `charter_delivered` notice. Unless it was ours (`ours`: this company's; failing that, a
   * delivery of ours into the posting just now or in flight), someone else delivered, a sibling
   * company of ours included (the server sees another company): the posting's re-post won't escalate.
   * Returns its watch if that ended a stall. `at`: the notice's time (before this posting began: it
   * was into the last one). Tons and company are counted from the next listing's board, not here.
   */
  noteCharterDelivered(charterId: string, ours: boolean | undefined, at?: number): ExpansionWatch | undefined {
    const id = this.currentId(charterId);
    const now = this.now();
    for (const [key, w] of this.expansionWatch) {
      if (w.id !== id) continue;
      if (ours ?? ((this.lineages.get(key)?.own ?? []).some(([t]) => now - t <= OWN_MATCH_MS) || this.inFlightTons(id) > 0)) return undefined;
      if (at !== undefined && Number.isFinite(at) && w.startKnown && w.startAt !== undefined && at < w.startAt) return undefined;
      // Kept for the rest of the posting (learning needs it whether or not it was stalled).
      const was = w.stalled;
      w.rivalDelivered = true;
      w.stalled = false;
      w.lateTrickle = false;
      return was ? w : undefined;
    }
    return undefined;
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

  /**
   * Rival ships due at `port` from now to `by` (server ms), as they weigh on a charter of `good`:
   * tons they are likely to deliver into it (by their declared cargo or their deliveries there), and
   * laden ships whose cargo is unknown (each takes a share of the room). With rival intel off, every
   * laden ship seen counts as unknown, as before.
   */
  rivalLanding(port: string, good: string, by: number): { tons: number; unknown: number } {
    const now = this.now();
    const recent = this.rivalIntel ? RECENT_LANDING_GAME_MIN * this.gameMinuteMs : 0;
    const since = now - FEED_MEMORY_GAME_DAYS * 24 * 60 * this.gameMinuteMs;
    let tons = 0;
    let unknown = 0;
    for (const l of this.rivalLandings.get(port) ?? []) {
      if (l.load === "ballast" || l.at < now - recent || l.at > by) continue;
      const o = this.rivalIntel ? landingOdds(l, this.unitValue(port, good), this.rivals.fed(l.company, port, good, since) > 0) : null;
      if (o) tons += o.odds * o.tons;
      else unknown++;
    }
    return { tons, unknown };
  }

  /**
   * Chance no rival due at a charter's port before its lapse delivers its good (any delivery ends a
   * stall): each laden one lowers it by its odds of delivering. Whatever the `rivalIntel` setting
   * (with it off, only the quay sightings' landings are known).
   */
  rivalKeep(c: { port: string; good: string; expiresAt: number | null }): number {
    const landings = this.rivalLandings.get(c.port);
    if (c.expiresAt === null || !landings?.length) return 1;
    const now = this.now();
    const since = now - FEED_MEMORY_GAME_DAYS * 24 * 60 * this.gameMinuteMs;
    // Read per charter per plan: the sellers only when a landing needs them.
    let sellers: Set<string> | null = null;
    let keep = 1;
    for (const l of landings) {
      if (l.load === "ballast" || l.at < now - RECENT_LANDING_GAME_MIN * this.gameMinuteMs || l.at > c.expiresAt) continue;
      const o = landingOdds(l, this.unitValue(c.port, c.good), this.rivals.fed(l.company, c.port, c.good, since) > 0);
      // Unknown cargo: likelier from a port selling the good (estimates); part laden counts half.
      const q = o ? o.odds : (l.from ? ((sellers ??= new Set(this.sellersOf(c.good))).has(l.from) ? 0.5 : 0.1) : ODDS_UNKNOWN) * (l.load === "laden" ? 1 : 0.5);
      keep *= 1 - Math.min(0.9, q);
    }
    return keep;
  }

  /** What a ton of `good` is valued at in a policy (the higher of base and the port's bid, as Lloyd's values cargo). */
  private unitValue(port: string, good: string): number {
    return Math.max(this.basePrice(good), this.price(port, good)?.bid ?? 0);
  }

  /** Whether a charter is re-posted when it lapses (an open expansion charter of the tier in play). */
  renews(c: { id: string }): boolean {
    return this.expansionCharters.has(this.currentId(c.id));
  }

  /**
   * The id of the posting that now stands for this charter (itself unless it lapsed and was
   * re-posted, or was a crisis charter expected from the news and since found).
   */
  currentId(id: string): string {
    let cur = id;
    for (let i = 0; i < 20; i++) {
      const next = this.repostOf.get(cur) ?? this.crisisLink.get(cur);
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
    this.lookForCrisis(port, fresh);
    this.charters = this.withProvisional(this.withRecalled([...this.charters.filter((c) => c.port !== port), ...fresh])).filter((c) => this.deliverable(c));
  }

  /**
   * A charter one of our player's companies issued (a player charter, guide 3.7): its issuer, its player's other
   * companies and linked companies can't deliver to it. Freight lots too (`issuer`).
   */
  ownIssued(c: { issuer?: string | null }): boolean {
    return !!c.issuer && (c.issuer === this.companyId || this.ourCompanyIds.has(c.issuer));
  }

  /** Whether our ships may deliver to this charter: not our own player's, and not refused for good (refuseCharter). */
  deliverable(c: { id: string; issuer?: string | null }): boolean {
    return !this.ownIssued(c) && !this.noDelivery.has(c.id);
  }

  /** The server refused our delivery to this charter (403): never planned or offered again; it leaves the list now. */
  refuseCharter(id: string): void {
    this.noDelivery.add(id);
    if (this.noDelivery.size > SNAPSHOT_CLOSED) this.noDelivery.delete(this.noDelivery.values().next().value!);
    this.charters = this.charters.filter((c) => c.id !== id);
  }

  /** Our company ids are known (after the first listing at start-up): our own player's charters leave the list. */
  dropOwnCharters(): void {
    this.charters = this.charters.filter((c) => this.deliverable(c));
  }

  // ── Royal monopolies ─────────────────────────────────────────────────────────

  /** The grants in force as listed; ones known only from a refused buy stand until the list shows them or they run out. */
  private setMonopolies(list: MonopolyResult[]): void {
    const now = this.now();
    const listed: MonopolyInfo[] = list
      .filter((m) => m.in_force && Date.parse(m.expires_at) > now)
      .map((m) => ({ id: m.id, region: m.banking_region, good: m.commodity_id, holderId: m.holder_company_id, holder: m.holder_company_name, expiresAt: Date.parse(m.expires_at) }));
    const seen = this.monopolies.filter((m) => !m.holderId && m.expiresAt > now && !listed.some((x) => x.region === m.region && x.good === m.good));
    const before = new Set(this.monopolies.map((m) => `${m.region}|${m.good}|${m.holderId}`));
    this.monopolies = [...listed, ...seen];
    for (const m of listed) {
      if (!before.has(`${m.region}|${m.good}|${m.holderId}`) && this.monopolyHits(m)) {
        this.onNote?.(`royal monopoly: ${m.holder} holds ${m.good} in ${m.region} until ${new Date(m.expiresAt).toISOString()}: its Crown asks there are not ours to buy`);
      }
    }
  }

  /** A grant someone other than this company holds (the holder's sibling companies are barred too: guide 3.9). */
  private monopolyHits(m: MonopolyInfo): boolean {
    return !NEVER_MONOPOLISED.has(m.good) && m.holderId !== this.companyId;
  }

  /**
   * The monopoly that bars this company from the Crown's (NPC) asks for `good` at `port` (its banking region), or
   * undefined: none in force, ours, or a good never monopolised. Players' resting asks still fill.
   */
  monopolyBars(port: string, good: string): MonopolyInfo | undefined {
    if (NEVER_MONOPOLISED.has(good) || this.monopolies.length === 0) return undefined;
    const region = this.region(port);
    const now = this.now();
    return this.monopolies.find((m) => m.region === region && m.good === good && m.expiresAt > now && this.monopolyHits(m));
  }

  /** A buy was refused for a monopoly the list didn't show yet (`detail`: the refusal, naming the holder): barred until it does. */
  noteMonopoly(port: string, good: string, detail: string): void {
    if (NEVER_MONOPOLISED.has(good) || this.monopolyBars(port, good)) return;
    const region = this.region(port);
    this.monopolies.push({
      id: `seen:${region}|${good}`,
      region,
      good,
      holderId: "",
      holder: detail.slice(0, 120) || "another company",
      expiresAt: this.now() + MONOPOLY_SEEN_GAME_H * 60 * this.gameMinuteMs,
    });
    this.onNote?.(`royal monopoly on ${good} in ${region} (a buy was refused): its Crown asks there are not ours to buy`);
  }

  /** A public `monopoly_granted` / `monopoly_expired` notice (payload as in the list, its shape not otherwise published). */
  noteMonopolyEvent(type: "monopoly_granted" | "monopoly_expired", p: Record<string, unknown>): void {
    const src = (p.monopoly && typeof p.monopoly === "object" ? p.monopoly : p) as Record<string, unknown>;
    const s = (k: string) => (typeof src[k] === "string" ? (src[k] as string) : undefined);
    const region = s("banking_region") as BankingRegion | undefined;
    const good = s("commodity_id");
    const id = s("id") ?? s("monopoly_id");
    if (type === "monopoly_expired") {
      this.monopolies = this.monopolies.filter((m) => !(id && m.id === id) && !(region && good && m.region === region && m.good === good));
      return;
    }
    const expiresAt = Date.parse(s("expires_at") ?? "");
    if (!region || !good || !Number.isFinite(expiresAt)) return;
    const holderId = s("holder_company_id") ?? "";
    this.monopolies = [
      ...this.monopolies.filter((m) => !(m.region === region && m.good === good)),
      { id: id ?? `${region}|${good}`, region, good, holderId, holder: s("holder_company_name") ?? "another company", expiresAt },
    ];
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
    const own = vaults.filter((v) => v.account_type === "vault");
    this.vaults = new Map(own.map((v) => [v.banking_region, v.balance_pence]));
    for (const v of own) this.vaultAccounts.set(v.account_id, v.banking_region);
  }

  // ── World events ────────────────────────────────────────────────────────────

  /**
   * Takes in the feed's last few game days: fresh news to the log, a structural shift since the
   * catalog read re-reads it. `complete`: the feed returned less than a full page.
   */
  noteEvents(list: WorldEventInfo[], complete: boolean): void {
    const known = new Set(this.events.map((e) => e.id));
    this.events = [...list].sort((a, b) => b.startsAt - a.startsAt);
    this.indexEvents();
    for (const e of this.events) if (!known.has(e.id)) this.noteFresh(e);
    // Gone from the window: their links and outcomes no longer matter (a full page may be cut short: keep them then).
    if (complete) {
      const ids = new Set(list.map((e) => e.id));
      for (const id of [...this.crisisResolved]) if (!ids.has(id)) this.crisisResolved.delete(id);
      for (const k of [...this.crisisLink.keys()]) if (!ids.has(k.slice(PROVISIONAL_PREFIX.length))) this.crisisLink.delete(k);
    }
  }

  private noteFresh(e: WorldEventInfo): void {
    const shift = e.structural || e.type === "production_collapse" || e.type === "production_boom" || e.type === "import_slump";
    if (shift && e.startsAt > this.catalogAt) this.catalogDue = true;
    if (!this.catalog || this.now() - e.startsAt > EVENT_NOTE_GAME_H * 60 * this.gameMinuteMs || (e.port && !this.isOpen(e.port))) return;
    const where = e.port ? (this.port(e.port)?.name ?? e.port) : (this.catalog.sea_zones.find((z) => z.id === e.zone)?.name ?? e.zone ?? "?");
    const good = e.good ? (this.catalog.commodities.find((c) => c.id === e.good)?.name ?? e.good) : "";
    const off = this.planOnEvents ? "" : " (not planned on: setting off)";
    const msg =
      e.type === "demand_shortage"
        ? `shortage of ${good} at ${where}: bids there expected up${e.tons ? `, and a crisis charter for ~${e.tons} t (listed only there until its gossip spreads)` : ""}${off}`
        : e.type === "supply_boom"
          ? `glut of ${good} at ${where}: asks there expected down${off}`
          : e.type === "pirate_outbreak"
            ? `pirate outbreak in ${where}: +${e.addedPiracyBps ?? 0} bps piracy`
            : e.type === "admiralty_mobilization"
              ? `Admiralty mobilization at ${where}: ${good ? `${good}, ` : ""}a public charter`
              : `${e.type.replace(/_/g, " ")} at ${where}${good ? ` (${good})` : ""}${this.catalogDue ? ": re-reading the catalog" : ""}`;
    this.onNote?.(msg);
  }

  private indexEvents(): void {
    this.shockIndex = new Map();
    this.outbreaks = this.events.filter((e) => e.type === "pirate_outbreak" && e.zone);
    for (const e of this.events) {
      if (!e.port || !e.good) continue;
      const k = `${e.port}|${e.good}`;
      this.shockIndex.set(k, [...(this.shockIndex.get(k) ?? []), e]);
    }
  }

  /** The latest event of this kind at `port` for `good` that has begun (in effect or lapsed, within the window). */
  private shock(port: string, good: string, type: WorldEventType): WorldEventInfo | undefined {
    const now = this.now();
    return this.shockIndex.get(`${port}|${good}`)?.find((e) => e.type === type && e.startsAt <= now);
  }

  private inEffect(e: WorldEventInfo): boolean {
    const now = this.now();
    return e.startsAt <= now && now < e.expiresAt;
  }

  /** Share of a shock left at `at`: all of it when it begins, none from the news' lapse (how fast it really fades isn't published). */
  private fade(e: WorldEventInfo, at: number): number {
    return Math.min(1, Math.max(0, (e.expiresAt - at) / Math.max(1, e.expiresAt - e.startsAt)));
  }

  /** A shortage of `good` at `port` is in effect and planned on. */
  shortageAt(port: string, good: string): boolean {
    const e = this.planOnEvents ? this.shock(port, good, "demand_shortage") : undefined;
    return !!e && this.inEffect(e);
  }

  /** A glut of `good` at `port` is in effect and planned on. */
  glutAt(port: string, good: string): boolean {
    const e = this.planOnEvents ? this.shock(port, good, "supply_boom") : undefined;
    return !!e && this.inEffect(e);
  }

  /** A shortage's bid against base at its height, from the shortages seen (1.15× until some are). */
  get shortageSpike(): number {
    return ratioOf(this.shockCal.shortageBid, SHORTAGE_BID_PRIOR, 1, 2);
  }

  /** A glut's ask against base at its height (0.85× until some are seen). */
  get glutDip(): number {
    return ratioOf(this.shockCal.glutAsk, GLUT_ASK_PRIOR, 0.5, 1);
  }

  /** A crisis charter's pay against base, from those found (1.25× until some are). */
  get crisisPayRatio(): number {
    return ratioOf(this.shockCal.crisisPay, CRISIS_PAY_PRIOR, 1, 2.5);
  }

  /** Share of shortages whose crisis charter was there when a listing or a ship looked (60% until some are seen). */
  get crisisFoundRate(): number {
    const { crisisFound: f, crisisMissed: m } = this.shockCal;
    return Math.min(0.85, Math.max(0.15, (f + CRISIS_FOUND_PRIOR * SHOCK_PRIOR_N) / (f + m + SHOCK_PRIOR_N)));
  }

  /**
   * The bid a shortage of `good` at `port` is expected to bring for a load landing at `at`: base × the
   * spike seen at shortages, fading to nothing by the news' lapse. Null without one in effect, with
   * planning on events off, or when a book read since it began shows the real bid.
   */
  shortageBid(port: string, good: string, at: number, seenAt: number | null): number | null {
    const e = this.planOnEvents ? this.shock(port, good, "demand_shortage") : undefined;
    if (!e || !this.inEffect(e) || (seenAt !== null && seenAt >= e.startsAt)) return null;
    const f = this.fade(e, at);
    return f > 0 ? Math.round(this.basePrice(good) * (1 + (this.shortageSpike - 1) * f)) : null;
  }

  /** The ask a glut is expected to show when a ship buys at `at` (as shortageBid, the other way). */
  private glutAsk(port: string, good: string, at: number, seenAt: number | null): number | null {
    const e = this.planOnEvents ? this.shock(port, good, "supply_boom") : undefined;
    if (!e || !this.inEffect(e) || (seenAt !== null && seenAt >= e.startsAt)) return null;
    const f = this.fade(e, at);
    return f > 0 ? Math.round(this.basePrice(good) * (1 - (1 - this.glutDip) * f)) : null;
  }

  /**
   * A price seen while a shortage or glut was on: the shock's expected share of it is taken out as it
   * fades towards `at`, so a spike read at its height isn't planned on after the lapse. Always on: it
   * only makes plans more cautious.
   */
  easeShock(port: string, good: string, type: "demand_shortage" | "supply_boom", price: number, seenAt: number, at: number): number {
    const e = this.shock(port, good, type);
    if (!e || seenAt < e.startsAt || seenAt >= e.expiresAt) return price;
    const m = type === "demand_shortage" ? this.shortageSpike - 1 : this.glutDip - 1;
    return Math.round((price * (1 + m * this.fade(e, at))) / (1 + m * this.fade(e, seenAt)));
  }

  /** A structural shift of this kind hit `good` at `port` after `since`: a price seen before it no longer holds. */
  shiftedSince(port: string, good: string, type: "production_collapse" | "import_slump", since: number): boolean {
    const now = this.now();
    return !!this.shockIndex.get(`${port}|${good}`)?.some((e) => e.type === type && e.startsAt > since && e.startsAt <= now);
  }

  /** A price seen while a shortage or glut was on there: what such shocks do, one sample per event (ratio to base). */
  private sampleShock(port: string, good: string, bid: number | null, ask: number | null, at: number): void {
    if (!this.catalog) return;
    const base = this.basePrice(good);
    if (base <= 0) return;
    const take = (type: WorldEventType, price: number | null, into: Array<[string, number]>) => {
      const e = this.shock(port, good, type);
      if (!e || !price || at < e.startsAt || this.fade(e, at) < SHOCK_SAMPLE_MIN_FADE || into.some(([id]) => id === e.id)) return;
      into.push([e.id, price / base]);
      if (into.length > SHOCK_SAMPLES_MAX) into.shift();
    };
    take("demand_shortage", bid, this.shockCal.shortageBid);
    take("supply_boom", ask, this.shockCal.glutAsk);
  }

  private crisisCloses(e: WorldEventInfo): number {
    return e.startsAt + CRISIS_OPEN_GAME_DAYS * 24 * 60 * this.gameMinuteMs;
  }

  /** A non-public charter for the shortage's good at its port, posted since it began: its crisis charter (or a Governor's procurement, as good). */
  private isCrisisFor(c: CharterInfo, e: WorldEventInfo): boolean {
    // A player's charter (funded from its issuer's escrow) is never the Governor's.
    if (c.isPublic || c.provisional || c.fundedBy === "issuer" || !!c.issuer || c.port !== e.port || c.good !== e.good) return false;
    const posted = c.createdAt !== undefined && c.createdAt !== null && Number.isFinite(c.createdAt) ? c.createdAt : null;
    // Without a posting time: its kind says so, or gossip of it is newer than the shortage.
    return posted !== null ? posted >= e.startsAt - CRISIS_MATCH_SLACK_GAME_MIN * this.gameMinuteMs : !!c.kind?.includes("crisis") || (c.newsAt ?? 0) >= e.startsAt;
  }

  private resolveCrisis(e: WorldEventInfo, real: CharterInfo): void {
    this.crisisResolved.add(e.id);
    this.crisisLink.set(PROVISIONAL_PREFIX + e.id, real.id);
    this.shockCal.crisisFound++;
    const base = this.basePrice(real.good);
    if (base > 0) {
      this.shockCal.crisisPay.push([e.id, real.payPerTon / base]);
      if (this.shockCal.crisisPay.length > SHOCK_SAMPLES_MAX) this.shockCal.crisisPay.shift();
    }
    this.onNote?.(
      `crisis charter for ${real.good} at ${real.port}${real.stale ? " (gossip)" : ""}: ${real.remaining} t at ${Math.round(real.payPerTon / 100)} Cr/t` +
        `${base > 0 ? ` (${(real.payPerTon / base).toFixed(2)}× base)` : ""}`,
    );
  }

  /** A live listing taken at `port` (our ship is there): a shortage's crisis charter is in it, or there is none to plan on. */
  private lookForCrisis(port: string, fresh: CharterInfo[]): void {
    const now = this.now();
    for (const e of this.events) {
      if (e.type !== "demand_shortage" || e.port !== port || !e.good || this.crisisResolved.has(e.id)) continue;
      // Too soon after the news to say it isn't coming, or past when it would have closed anyway.
      if (now - e.startsAt < CRISIS_MATCH_SLACK_GAME_MIN * this.gameMinuteMs || now >= this.crisisCloses(e)) continue;
      const real = fresh.find((c) => this.isCrisisFor(c, e));
      if (real) this.resolveCrisis(e, real);
      else {
        this.crisisResolved.add(e.id);
        this.shockCal.crisisMissed++;
        this.onNote?.(`no crisis charter for ${e.good} at ${port} on its quay (filled, or never posted)`);
      }
    }
  }

  /**
   * A shortage at `port` whose crisis charter is still unsettled and became checkable (an hour after
   * it began) since `since`: a ship in port lists the quay again then, so a missing one is caught
   * while it sits there, not only when a ship next arrives.
   */
  crisisDue(port: string, since: number): boolean {
    const now = this.now();
    const slack = CRISIS_MATCH_SLACK_GAME_MIN * this.gameMinuteMs;
    return this.events.some((e) => e.type === "demand_shortage" && e.port === port && !!e.good && !this.crisisResolved.has(e.id) && e.startsAt + slack <= now && e.startsAt + slack > since && now < this.crisisCloses(e));
  }

  /**
   * A shortage's crisis charter is listed only on its quay, or as gossip hours later. Until a listing
   * shows it (or a ship there finds none), it stands in as an expected charter: the tons the news
   * names, the crisis pay seen so far, trusted at the share found when looked for. Finding and
   * learning go on with the setting off; only the expected charter is left out then.
   */
  private withProvisional(list: CharterInfo[]): CharterInfo[] {
    const out = list.filter((c) => !c.provisional);
    const now = this.now();
    for (const e of this.events) {
      if (e.type !== "demand_shortage" || !e.port || !e.good || e.startsAt > now || this.crisisResolved.has(e.id)) continue;
      const real = out.find((c) => this.isCrisisFor(c, e));
      if (real) {
        this.resolveCrisis(e, real);
        continue;
      }
      const id = PROVISIONAL_PREFIX + e.id;
      const closes = this.crisisCloses(e);
      if (!this.planOnEvents || closes <= now || this.closed.has(id) || !this.isOpen(e.port)) continue;
      const pay = Math.round(this.basePrice(e.good) * this.crisisPayRatio);
      if (pay <= 0) continue;
      out.push({
        id,
        port: e.port,
        good: e.good,
        payPerTon: pay,
        remaining: Math.min(e.tons ?? CRISIS_TONS_DEFAULT, CRISIS_TONS_MAX),
        expiresAt: closes,
        stale: true,
        isPublic: false,
        title: `expected crisis charter: ${e.good} to ${e.port}`,
        newsAt: e.startsAt,
        createdAt: e.startsAt,
        kind: "crisis",
        provisional: true,
        trustCap: this.crisisFoundRate,
      });
    }
    return out;
  }

  /** Re-reads the catalog: live customs, and what each port makes and imports (structural shifts change that). */
  private async refreshCatalog(): Promise<void> {
    const at = this.now();
    const catalog = await this.client.catalog();
    if (!catalog?.ports?.length || !catalog.commodities?.length) return; // keep the last good one
    this.catalog = catalog;
    // Indexes built over the catalog start again from the new one (every such index is reset here).
    this.portIndex = null;
    this.zoneIndex = null;
    this.catalogAt = at;
    this.catalogDue = false;
  }

  /** Events in force (and shortages whose crisis charter may still be open), what the planner does with each, and the learned figures. */
  eventsReport(): WorldEventsReport {
    const k = this.shockCal;
    const out: WorldEventsReport = {
      enabled: this.planOnEvents,
      rows: [],
      shortageBid: { ratio: this.shortageSpike, n: k.shortageBid.length },
      glutAsk: { ratio: this.glutDip, n: k.glutAsk.length },
      crisisPay: { ratio: this.crisisPayRatio, n: k.crisisPay.length },
      crisisFound: { rate: this.crisisFoundRate, n: k.crisisFound + k.crisisMissed },
    };
    if (!this.catalog) return out; // before the first catalog read
    const now = this.now();
    for (const e of this.events) {
      const live = this.inEffect(e) || (e.type === "demand_shortage" && e.startsAt <= now && now < this.crisisCloses(e));
      if (!live || (e.port && !this.isOpen(e.port))) continue;
      const crisis = e.type !== "demand_shortage" ? null : this.crisisLink.has(PROVISIONAL_PREFIX + e.id) ? "found" : this.crisisResolved.has(e.id) ? "missing" : "expected";
      out.rows.push({ id: e.id, type: e.type, port: e.port, zone: e.zone, good: e.good, title: e.title, startsAt: e.startsAt, expiresAt: e.expiresAt, effect: this.effectOf(e, now), crisis });
      if (out.rows.length >= 30) break;
    }
    return out;
  }

  private effectOf(e: WorldEventInfo, now: number): string {
    const x = (r: number) => `${r.toFixed(2)}× base`;
    const off = "not planned on (setting off)";
    switch (e.type) {
      case "demand_shortage": {
        const link = this.crisisLink.get(PROVISIONAL_PREFIX + e.id);
        const real = link ? this.charters.find((c) => c.id === link) : undefined;
        const crisis = real
          ? `crisis charter: ${real.remaining} t at ${Math.round(real.payPerTon / 100)} Cr/t`
          : link
            ? "crisis charter filled or closed"
            : this.crisisResolved.has(e.id)
              ? "no crisis charter there"
              : this.planOnEvents
                ? `crisis charter expected: ~${Math.min(e.tons ?? CRISIS_TONS_DEFAULT, CRISIS_TONS_MAX)} t at ~${x(this.crisisPayRatio)}, trusted ≤${Math.round(this.crisisFoundRate * 100)}%`
                : `crisis charter ${off}`;
        return this.inEffect(e) && this.planOnEvents ? `bids expected ~${x(1 + (this.shortageSpike - 1) * this.fade(e, now))}, fading by the lapse; ${crisis}` : crisis;
      }
      case "supply_boom":
        return this.planOnEvents ? `asks expected ~${x(1 - (1 - this.glutDip) * this.fade(e, now))}, fading by the lapse` : off;
      case "pirate_outbreak":
        return e.startsAt > this.piracyAt ? `+${e.addedPiracyBps ?? 0} bps added until the zones are read again` : "in the live zone piracy";
      case "admiralty_mobilization": {
        const c = e.charterId ? this.charters.find((x) => x.id === e.charterId) : undefined;
        return c ? `public charter: ${c.remaining} t at ${Math.round(c.payPerTon / 100)} Cr/t` : "public charter not open (filled, lapsed or not listed yet)";
      }
      case "production_collapse":
        return "asks there from before it aren't planned on; catalog re-read";
      case "import_slump":
        return "bids there from before it aren't planned on; catalog re-read";
      default:
        return "catalog re-read";
    }
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
   * ask has been seen lately or a glut there is planned on (an importer with a glut can undercut the
   * producers).
   */
  sellersOf(good: string): string[] {
    const out = new Set(this.sourcesOf(good));
    for (const p of this.catalog.ports) {
      if (p.phase <= this.unlockedPhase && this.trades(p.id, good) && (this.price(p.id, good)?.ask || this.glutAt(p.id, good))) out.add(p.id);
    }
    return [...out];
  }

  /** Goods on sale at a port: what it makes, plus anything with an ask seen there lately or a glut there. */
  goodsAt(portId: string): string[] {
    const p = this.port(portId);
    if (!p) return [];
    const out = new Set([...(p.produces ?? []), ...(p.manufactures ?? [])]);
    for (const c of this.catalog.commodities) if (this.trades(portId, c.id) && (this.price(portId, c.id)?.ask || this.glutAt(portId, c.id))) out.add(c.id);
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

  /** A port's berth dues a game day, as a port view (or a dock) gave them at its occupancy then. */
  noteBerthDues(portId: string, perDay: number | null | undefined): void {
    if (typeof perDay === "number" && Number.isFinite(perDay) && perDay >= 0) this.berthDues.set(portId, perDay);
  }

  /**
   * Berth dues for `ms` berthed at a port (guide 3.3: pro rata per game day, at least 6 game hours a
   * stay; `minimum` off: the stay's minimum is already paid, the ship is there). The rate seen there
   * last (its occupancy then), else a quiet port's.
   */
  berthDuesFor(portId: string, ms: number, minimum = true): number {
    const perDay = this.berthDues.get(portId) ?? BERTH_DUES_QUIET;
    const billed = Math.max(minimum ? BERTH_MIN_GAME_H * 60 * this.gameMinuteMs : 0, ms);
    return Math.round((perDay * billed) / (24 * 60 * this.gameMinuteMs));
  }

  /** Real ms to sail `nm` at `knots`. */
  sailMs(nm: number, knots: number): number {
    return (nm / Math.max(knots, 0.1)) * 60 * this.gameMinuteMs;
  }

  // ── Routes ──────────────────────────────────────────────────────────────────

  /** The route `depart` would sail (cached up to ROUTE_TTL_MS; `maxAgeMs`: no older than this, e.g. as a hull is committed to it). */
  route(from: string, to: string, shipClass: string, opts: { maxAgeMs?: number } = {}): Promise<RoutePlan> {
    const key = `${from}>${to}>${shipClass}`;
    const hit = this.routes.get(key);
    if (hit && Date.now() - hit.at <= Math.min(opts.maxAgeMs ?? ROUTE_TTL_MS, ROUTE_TTL_MS)) return hit.p;
    const entry = { p: this.fetchRoute(from, to, shipClass), at: Date.now() };
    entry.p.catch(() => {
      if (this.routes.get(key) === entry) this.routes.delete(key);
    });
    this.routes.set(key, entry);
    return entry.p;
  }

  /** Our plan of this route proved stale (the server sailed or refused on another): read it afresh next time. */
  forgetRoute(from: string, to: string, shipClass: string): void {
    this.routes.delete(`${from}>${to}>${shipClass}`);
  }

  /** A departure warned the stores were under this route's safe figure (`stores_below_safe`): the server's figure, kept in memory. */
  noteSafeStores(from: string, to: string, shipClass: string, tons: number): void {
    if (Number.isFinite(tons) && tons > 0) this.safeSeen.set(`${from}>${to}>${shipClass}`, tons);
  }

  /** The safe stores a departure on this route last said it needs (0: none said). */
  safeFloor(from: string, to: string, shipClass: string): number {
    return this.safeSeen.get(`${from}>${to}>${shipClass}`) ?? 0;
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
   * True when a hull of class `hull` is rated for every leg: the leg's own class and the class of
   * the sea zone its hazards roll for (World.hazardZone).
   */
  routeRated(plan: RoutePlan, hull: ZoneClass): boolean {
    const max = ZONE_RANK[hull];
    // Every leg rolls hazards for the zone it ends in; the last leg ends at the port, whose own sea zone
    // counts. A zone we can't place fails closed.
    return plan.legs.every((l) => {
      const zone = this.hazardZone(l.to_node);
      return ZONE_RANK[l.edge_class] <= max && !!zone && ZONE_RANK[zone.zone_class] <= max;
    });
  }

  /**
   * Phase-completion bonus a ton delivered to this charter is expected to earn (pence, unweighted), on average over
   * `tons` delivered together: the bonus splits by the square root of each player's base-valued tons (guide 3.15),
   * so what a load adds is its marginal share of the pool (bonusMarginal), small for a player already far ahead and
   * large for a first delivery. `extra`: base value (pence) our other ships are already bound to deliver into the
   * tier. Without a board to split (nobody else on it, our names unknown): the ton's base value at the pool's straight
   * rate, as before. Nothing if the tier, at its recent pace, can't complete before the season ends (guide 3.11).
   */
  charterBonus(c: { id: string; good: string }, tons = BONUS_REF_TONS, extra = 0): number {
    if (!this.expansionCharters.has(c.id)) return 0;
    if (this.seasonEndsAt !== null && (this.tierEtaMs === null || !this.beforeSeasonEnd(this.now() + this.tierEtaMs))) return 0;
    const unit = this.bonusUnit(c);
    const t = Math.max(1, tons);
    const marginal = this.bonusMarginal(unit * t, extra);
    return Math.round(marginal === null ? unit * this.expansionRate : marginal / t);
  }

  /** What a ton delivered to this expansion charter counts for in the bonus split: its good's base price (pence). */
  bonusUnit(c: { id: string; good: string }): number {
    return this.expansionValue.get(c.id) ?? this.basePrice(c.good);
  }

  /**
   * The bonus (pence) `value` more of base value delivered earns at completion: pool × [√(o+t)/(√(o+t)+Σ√others) −
   * √o/(√o+Σ√others)], o our player's base value (all our companies on the board, plus `extra` already bound there),
   * each other company as its own player (who owns which isn't public). The pool is paid on the final tons: everyone's
   * share is taken to grow with the tier to its projected total, so a load counts at its part of that total (as though
   * the board were already complete). Null when the board can't be split: no tier, nobody else on it yet (the share
   * then turns on who joins), or our own names not known yet.
   */
  private bonusMarginal(value: number, extra = 0): number | null {
    const b = this.bonusBoard;
    if (!b || b.delivered <= 0 || this.rivals.ours.size === 0) return null;
    let ours = 0;
    const others: number[] = [];
    for (const c of b.contributors) {
      const v = (c.share_bps / 10_000) * b.delivered;
      if (this.rivals.ours.has(c.company_name)) ours += v;
      else others.push(v);
    }
    if (others.length === 0) return null;
    // Everyone grows by `grow` to completion: tons added at the final scale count 1/grow at today's.
    const grow = Math.max(1, b.projected / b.delivered);
    const before = sqrtShare(ours + Math.max(0, extra) / grow, others);
    const after = sqrtShare(ours + (Math.max(0, extra) + Math.max(0, value)) / grow, others);
    return Math.max(0, b.pool * (after - before));
  }

  /** Our player's share of the completion bonus as the board stands (the square-root split), and the pool; null without a board to split. */
  bonusStanding(): { share: number; pool: number } | null {
    const b = this.bonusBoard;
    if (!b || this.rivals.ours.size === 0) return null;
    let ours = 0;
    const others: number[] = [];
    for (const c of b.contributors) {
      if (this.rivals.ours.has(c.company_name)) ours += c.share_bps;
      else others.push(c.share_bps);
    }
    return { share: sqrtShare(ours, others), pool: b.pool };
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
  piracyRisk(plan: RoutePlan, guns: number, knots: number, cargoValue: number): { cargoShare: number; capture: number; raids: number } {
    const dayMs = 24 * 60 * this.gameMinuteMs;
    let rate = 0;
    for (const l of plan.legs) {
      const bps = this.zonePiracy(l.to_node) ?? this.zonePiracy(this.port(l.to_node)?.sea_zone_id ?? "");
      if (bps) rate += Math.min(1, (bps / 10_000) * (this.sailMs(l.distance_nm, knots) / dayMs));
    }
    if (rate <= 0) return { cargoShare: 0, capture: 0, raids: 0 };
    const attention = pirateAttention(cargoValue);
    const raids = Math.min(1, (rate * attention) / (1 + guns * GUN_DETERRENCE));
    const capturePerRaid = this.capturePerRaid(guns);
    const take = this.raidTake;
    return {
      cargoShare: Math.min(0.6, raids * (capturePerRaid + (1 - capturePerRaid) * take)),
      capture: Math.min(0.5, raids * capturePerRaid),
      raids,
    };
  }

  /**
   * A zone's net piracy (bps): the live figure, plus pirate outbreaks that began after it was read
   * (the zones count corsair flotillas with the marques, so the next read takes over).
   */
  private zonePiracy(id: string): number | undefined {
    const bps = this.piracy.get(id);
    const now = this.now();
    let added = 0;
    for (const e of this.outbreaks) if (e.zone === id && e.startsAt > this.piracyAt && e.startsAt <= now && e.expiresAt > now) added += e.addedPiracyBps ?? 0;
    return bps === undefined && added === 0 ? undefined : (bps ?? 0) + added;
  }

  /** The expected share of the cargo lost to pirates on a passage (captures included); see piracyRisk. */
  piracyLoss(plan: RoutePlan, guns: number, knots: number, cargoValue: number): number {
    return this.piracyRisk(plan, guns, knots, cargoValue).cargoShare;
  }

  /** Share of the cargo a raid that lets the ship go seizes, learned from our own raids (35% until some are seen; the guide's 20-50%). */
  get raidTake(): number {
    const n = this.raidTakes.length;
    const sum = this.raidTakes.reduce((a, b) => a + b, 0);
    return Math.min(RAID_TAKE_MAX, Math.max(RAID_TAKE_MIN, (sum + RAID_TAKE_PRIOR * RAID_TAKE_PRIOR_N) / (n + RAID_TAKE_PRIOR_N)));
  }

  /**
   * Chance an interception carries the ship off with `guns` facing it (a convoy's pooled guns count): an unarmed
   * hull's odds learned from our own interceptions (7.5% until some are seen, kept within the guide's 5-10%),
   * falling with guns towards the 5% floor.
   */
  capturePerRaid(guns = 0): number {
    const seen = this.raidTakes.length + this.captures;
    const unarmed = Math.min(CAPTURE_MAX, Math.max(CAPTURE_MIN, (this.captures + CAPTURE_PRIOR * CAPTURE_PRIOR_N) / (seen + CAPTURE_PRIOR_N)));
    return CAPTURE_MIN + (unarmed - CAPTURE_MIN) / (1 + Math.max(0, guns) * CAPTURE_GUN_CUT);
  }

  /** One of our ships was intercepted: the share of its cargo seized, or captured outright (count each capture once). */
  notePirateRaid(share: number | null, captured: boolean): void {
    if (captured) {
      this.captures++;
      return;
    }
    if (share === null || !Number.isFinite(share) || share <= 0 || share > 1) return;
    this.raidTakes.push(share);
    if (this.raidTakes.length > 100) this.raidTakes.shift();
  }

  // ── Storms ──────────────────────────────────────────────────────────────────

  /** The sea zone a leg's hazards roll for: the zone it ends in, or the arrival port's own zone. */
  hazardZone(node: string): Catalog["sea_zones"][number] | undefined {
    if (!this.catalog?.sea_zones) return undefined;
    if (!this.zoneIndex || this.zoneIndex.size !== this.catalog.sea_zones.length) this.zoneIndex = new Map(this.catalog.sea_zones.map((z) => [z.id, z]));
    return this.zoneIndex.get(node) ?? this.zoneIndex.get(this.port(node)?.sea_zone_id ?? "");
  }

  /** Game month (1-12) at server time `t`, projected from the last clock read (null before one). */
  monthAt(t: number): number | null {
    const c = this.calendar;
    if (!c) return null;
    if (!c.projectable) return c.month;
    const idx = Math.floor((c.hours + (t - c.at) / (60 * this.gameMinuteMs)) / (30 * 24));
    // Month 0 of the world is March.
    return ((((idx + 2) % 12) + 12) % 12) + 1;
  }

  /** Whether server time `t` falls in storm season (game months 11-2). */
  stormSeasonAt(t: number): boolean {
    const m = this.monthAt(t);
    return m !== null && STORM_MONTHS.has(m);
  }

  /** Server time storm season next starts or ends (null without a projectable calendar). */
  stormSeasonTurnsAt(from = this.now()): number | null {
    const c = this.calendar;
    if (!c?.projectable) return null;
    const hourMs = 60 * this.gameMinuteMs;
    const hours = c.hours + (from - c.at) / hourMs;
    const stormy = this.stormSeasonAt(from);
    // Month by month from the next month's start.
    let t = from + (720 - (((hours % 720) + 720) % 720)) * hourMs;
    for (let i = 0; i < 12; i++, t += 720 * hourMs) if (this.stormSeasonAt(t + 1_000) !== stormy) return t;
    return null;
  }

  /** One leg's expected storm hits under the prior model (nothing learned), and the cell it counts in. */
  private stormLeg(node: string, nm: number, knots: number, hull: ZoneClass, at: number): { hits: number; cell: StormCell } | null {
    const zone = this.hazardZone(node);
    if (!zone) return null;
    const bps = Number.isFinite(zone.base_storm_bps) ? zone.base_storm_bps! : STORM_BPS_FALLBACK[zone.zone_class] ?? STORM_BPS_FALLBACK.regional;
    const margin = ZONE_RANK[hull] - (ZONE_RANK[zone.zone_class] ?? ZONE_RANK[hull]);
    const stormy = this.stormSeasonAt(at);
    const factor = STORM_RATE_PRIOR * (margin < 0 ? STORM_UNDERRATED ** -margin : 1) * (stormy ? STORM_SEASON_PRIOR : 1);
    const days = this.sailMs(nm, knots) / (24 * 60 * this.gameMinuteMs);
    const hits = Math.min(1, (Math.max(0, bps) / 10_000) * days * factor);
    return Number.isFinite(hits) ? { hits, cell: stormCell(stormy, margin) } : null;
  }

  /**
   * What storms are expected to cost a passage that sails at `sailsAt` (server ms). Each leg rolls for
   * the zone it ends in, at the zone's storm odds as a rate per game day at sea (so longer legs count
   * for more), raised for a hull below the zone's class and in storm season (judged as the leg ends,
   * so a voyage running into November counts it), then scaled by what our own voyages have shown.
   * Unlike pirates, storms don't care what's aboard. Returns the expected hits (each destroys a share
   * of every stack and a quarter of the stores), the expected share of the cargo lost (sinkings
   * included) and the chance of sinking. `weight`: the user's storm setting (1 = as learned).
   */
  stormRisk(plan: RoutePlan, hull: ZoneClass, knots: number, sailsAt: number, weight = 1): { hits: number; cargoShare: number; sink: number } {
    let hits = 0;
    let t = sailsAt;
    for (const l of plan.legs) {
      t += this.sailMs(l.distance_nm, knots);
      const leg = this.stormLeg(l.to_node, l.distance_nm, knots, hull, t);
      if (leg) hits += Math.min(1, leg.hits * (this.stormMult.get(leg.cell) ?? this.stormMultAll));
    }
    hits *= Math.max(0, weight);
    if (!(hits > 0)) return { hits: 0, cargoShare: 0, sink: 0 };
    const sink = Math.min(0.5, hits * this.stormSinkRate);
    // Hits compound (each takes a share of what is left); over a Poisson count that is 1 − e^(−hits × take).
    const cargoShare = Math.min(0.9, sink + (1 - sink) * (1 - Math.exp(-hits * this.stormTake)));
    return { hits, cargoShare, sink };
  }

  /**
   * Stores (tons) for a passage sailing at `sailsAt`. The route's safe figure covers one storm only (a
   * quarter of the stores); a pirate raid that lets the ship go may seize half. Cover as many hits as the
   * passage could plausibly take (likelier than 2%), up to three, as many of them raids as are plausible on
   * their own (the worst case). Always at the learned odds: the user's storm weight doesn't apply.
   */
  storesFor(plan: RoutePlan, hull: ZoneClass, guns: number, knots: number, cargoValue: number, sailsAt: number): number {
    const storms = this.stormRisk(plan, hull, knots, sailsAt).hits;
    const raids = this.piracyRisk(plan, guns, knots, cargoValue).raids;
    let k = 1;
    while (k < STORES_MAX_HITS && poissonTail(storms + raids, k + 1) > STORES_TAIL) k++;
    let kp = 0;
    while (kp < k && poissonTail(raids, kp + 1) > STORES_TAIL) kp++;
    if (kp === 0 && k === 1) return plan.safe_provisions_tons;
    return Math.max(plan.safe_provisions_tons, plan.expected_provisions_tons / (PIRATE_STORES_LEFT ** kp * STORM_STORES_LEFT ** (k - kp)));
  }

  /**
   * One of our ships set out (or was first seen at sea): its legs' storm exposure under the prior
   * model goes on the record, so passages without a storm teach as much as hits do.
   */
  noteStormExposure(legs: Array<{ to_node: string; distance_nm: number; speed_centiknots: number; estimated_arrival_at?: string }>, hull: ZoneClass, at: number): void {
    for (const l of legs) {
      // A leg without a speed would read as days at sea: left out rather than guessed.
      if (!(l.speed_centiknots > 0)) continue;
      const leg = this.stormLeg(l.to_node, l.distance_nm, l.speed_centiknots / 100, hull, Date.parse(l.estimated_arrival_at ?? "") || at);
      if (leg) this.stormCellOf(leg.cell).exp += leg.hits;
    }
    this.updateStormMult();
  }

  /**
   * One of our ships met a storm in `zone` (null: unknown) at server time `at`: the share of its cargo
   * destroyed, or sunk (a convoy rescue counts as a storm that would have sunk it).
   */
  noteStorm(zone: string | null, hull: ZoneClass, at: number, share: number | null, sunk: boolean): void {
    const z = zone ? this.hazardZone(zone) : undefined;
    const c = this.stormCellOf(stormCell(this.stormSeasonAt(at), z ? ZONE_RANK[hull] - (ZONE_RANK[z.zone_class] ?? ZONE_RANK[hull]) : 0));
    c.hits++;
    if (sunk) c.sinks++;
    else if (share !== null && Number.isFinite(share) && share > 0 && share <= 1) {
      this.stormTakes.push(share);
      if (this.stormTakes.length > 100) this.stormTakes.shift();
    }
    this.updateStormMult();
  }

  /** Share of every stack a storm destroys, learned from our hits (25% until some are seen). */
  get stormTake(): number {
    const n = this.stormTakes.length;
    const sum = this.stormTakes.reduce((a, b) => a + b, 0);
    return Math.min(0.9, Math.max(0.05, (sum + STORM_TAKE_PRIOR * STORM_TAKE_PRIOR_N) / (n + STORM_TAKE_PRIOR_N)));
  }

  /** Chance a storm hit sinks the ship, learned from our sinkings and rescues (2% until some are seen). */
  get stormSinkRate(): number {
    let hits = 0;
    let sinks = 0;
    for (const c of this.stormCells.values()) {
      hits += c.hits;
      sinks += c.sinks;
    }
    return Math.min(0.3, Math.max(0.005, (sinks + STORM_SINK_PRIOR * STORM_SINK_PRIOR_N) / (hits + STORM_SINK_PRIOR_N)));
  }

  /** Null before the first clock read (the season isn't known yet). */
  stormSummary(): StormSummary | null {
    if (!this.calendar) return null;
    const now = this.now();
    let seen = 0;
    let expected = 0;
    for (const c of this.stormCells.values()) {
      seen += c.hits;
      expected += c.exp;
    }
    const mult = (cell: StormCell) => this.stormMult.get(cell) ?? this.stormMultAll;
    const turnsAt = this.stormSeasonTurnsAt(now);
    return {
      season: this.stormSeasonAt(now),
      turnsAt: turnsAt === null ? null : new Date(turnsAt).toISOString(),
      seen: Math.round(seen),
      expected: Math.round(expected * 10) / 10,
      perDay: { calm: STORM_RATE_PRIOR * mult("calm|rated"), storm: STORM_RATE_PRIOR * STORM_SEASON_PRIOR * mult("storm|rated") },
      take: this.stormTake,
      sinkRate: this.stormSinkRate,
    };
  }

  private stormCellOf(cell: StormCell): { exp: number; hits: number; sinks: number } {
    let c = this.stormCells.get(cell);
    if (!c) this.stormCells.set(cell, (c = { exp: 0, hits: 0, sinks: 0 }));
    // Old evidence fades (the game's odds may be retuned).
    if (c.exp > STORM_CELL_CAP) {
      c.exp /= 2;
      c.hits /= 2;
      c.sinks /= 2;
    }
    return c;
  }

  /** Hits seen over hits expected per cell, each pulled towards the fleet-wide figure while its own record is thin. */
  private updateStormMult(): void {
    let hits = 0;
    let exp = 0;
    for (const c of this.stormCells.values()) {
      hits += c.hits;
      exp += c.exp;
    }
    const clamp = (x: number) => Math.min(STORM_MULT_MAX, Math.max(STORM_MULT_MIN, x));
    this.stormMultAll = clamp((hits + STORM_PRIOR_HITS) / (exp + STORM_PRIOR_HITS));
    this.stormMult = new Map([...this.stormCells].map(([k, c]) => [k, clamp((c.hits + STORM_PRIOR_HITS * this.stormMultAll) / (c.exp + STORM_PRIOR_HITS))]));
  }

  // ── Prices ──────────────────────────────────────────────────────────────────

  observeBook(book: PortOrderBook): void {
    const at = book.as_of ? Date.parse(book.as_of) : this.now();
    const live = book.visibility === "quay" || book.visibility === "counting_house";
    this.noteCustoms(book.port_id, book.customs_bps, at);
    for (const b of book.books) {
      // A live bid after an older remembered one: how far did it drift for its age? (The best bid our asks can
      // take: our own other companies' resting bids left out, noteUnfillable.)
      const prev = this.prices.get(`${book.port_id}|${b.commodity_id}`);
      const best = this.fillable(book.port_id, b, "bid");
      const bid = best?.price_pence ?? null;
      if (live && bid && prev?.bid && at > prev.at) {
        const days = (at - prev.at) / (24 * 60 * this.gameMinuteMs);
        if (days >= 0.25 && days <= 3) {
          this.bidSamples.push([days, bid / prev.bid]);
          if (this.bidSamples.length > BID_SAMPLES_MAX) this.bidSamples.shift();
          this.updateBidHaircut();
        }
      }
      // The best ask our bids can fill: our own other companies' resting asks left out (noteUnfillable).
      const ask = this.fillable(book.port_id, b, "ask");
      this.sampleShock(book.port_id, b.commodity_id, bid, ask?.price_pence ?? null, at);
      // Players' asks alone (a royal monopoly leaves only those to non-holders): known only from the depth.
      const players = b.depth?.asks.filter((l) => !l.is_npc && !this.isUnfillable(book.port_id, b.commodity_id, l.order_id)) ?? null;
      const playerAsk = players && players.length ? Math.min(...players.map((l) => l.price_pence)) : null;
      this.prices.set(`${book.port_id}|${b.commodity_id}`, {
        ask: ask?.price_pence ?? null,
        askQty: ask?.quantity ?? 0,
        bid,
        bidQty: best?.quantity ?? 0,
        bidDepth: b.depth ? b.depth.bids.filter((l) => !this.isUnfillable(book.port_id, b.commodity_id, l.order_id, "bid")).reduce((n, l) => n + l.remaining_quantity, 0) : null,
        stock: b.depth?.npc_current_stock ?? null,
        customsBps: book.customs_bps,
        at,
        live,
        ...(players ? { playerAsk, playerAskQty: players.filter((l) => l.price_pence === playerAsk).reduce((n, l) => n + l.remaining_quantity, 0) } : {}),
      });
    }
  }

  /**
   * Orders never match our own other companies (guide 3.2): these resting asks (or bids) at `port` for
   * `good` stayed untouched under an order of ours that crossed them, so they are left out of the ask
   * (or bid) from now on (until they leave the book).
   */
  noteUnfillable(port: string, good: string, orderIds: string[], side: "ask" | "bid" = "ask"): void {
    if (orderIds.length === 0) return;
    const k = `${port}|${good}|${side}`;
    this.unfillable.set(k, new Set([...(this.unfillable.get(k) ?? []), ...orderIds]));
  }

  /** A resting ask our bids can't fill, or a bid our asks can't (noteUnfillable). */
  isUnfillable(port: string, good: string, orderId: string, side: "ask" | "bid" = "ask"): boolean {
    return !!this.unfillable.get(`${port}|${good}|${side}`)?.has(orderId);
  }

  /** A book side's best level without the orders ours can't trade with (null: only those are left, as good as none). */
  private fillable(port: string, b: PortOrderBook["books"][number], side: "ask" | "bid"): { price_pence: number; quantity: number } | null {
    const k = `${port}|${b.commodity_id}|${side}`;
    const top = (side === "ask" ? b.best_ask : b.best_bid) ?? null;
    const skip = this.unfillable.get(k);
    if (!skip || !b.depth) return top;
    const levels = side === "ask" ? b.depth.asks : b.depth.bids;
    // Gone from the book: forgotten.
    for (const id of [...skip]) if (!levels.some((l) => l.order_id === id)) skip.delete(id);
    if (skip.size === 0) this.unfillable.delete(k);
    const open = levels.filter((l) => !skip.has(l.order_id));
    if (open.length === 0) return levels.length > 0 ? null : top;
    const prices = open.map((l) => l.price_pence);
    const price = side === "ask" ? Math.min(...prices) : Math.max(...prices);
    return { price_pence: price, quantity: open.filter((l) => l.price_pence === price).reduce((n, l) => n + l.remaining_quantity, 0) };
  }

  /** Customs a book or port view just gave for `port` (server time `at`). */
  private noteCustoms(port: string, bps: number | null | undefined, at: number): void {
    if (typeof bps !== "number" || !Number.isFinite(bps) || bps < 0 || !Number.isFinite(at)) return;
    const prev = this.customsSeen.get(port);
    if (!prev || at >= prev.at) this.customsSeen.set(port, { bps, at });
  }

  /** Learns other ports' prices from the coffee-house gossip at a quay we stand on, who sailed there, and its berth dues. */
  observeGossip(detail: PortDetail): void {
    this.rivals.addNotices(detail.recent_sailings);
    // Public forming convoys in its news (rival intel, low confidence) and its Lloyd's List (underwriting results).
    this.rivals.addConvoyNotices(detail.convoy_notices);
    if (detail.lloyds_list) this.lloydsSeen.set(detail.id, { at: Date.now(), notice: detail.lloyds_list });
    if (detail.visibility === "quay") {
      this.quayNews.set(detail.id, {
        at: Date.now(),
        reports: (detail.coffee_house_gossip ?? []).map((g) => g.age_seconds * 1000),
        sailings: (detail.recent_sailings ?? []).map((s) => ({ at: Date.parse(s.seen_at), company: s.company_name, ship: s.ship_name })).filter((s) => Number.isFinite(s.at)),
      });
    }
    this.noteBerthDues(detail.id, detail.berth_dues_per_day_pence);
    this.noteCustoms(detail.id, detail.customs_bps, this.now());
    for (const g of detail.coffee_house_gossip ?? []) {
      const at = this.now() - g.age_seconds * 1000;
      for (const c of g.commodities) {
        const key = `${g.subject_port_id}|${c.commodity_id}`;
        this.sampleShock(g.subject_port_id, c.commodity_id, c.best_bid_pence ?? null, c.best_ask_pence ?? null, at);
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
          // The best players' resting ask and bid in the news (anonymous: playerLevel leaves ours out); absent from older boards.
          ...(c.best_player_ask_pence !== undefined ? { playerAsk: c.best_player_ask_pence, playerAskQty: c.best_player_ask_quantity ?? 0 } : {}),
          ...(c.best_player_bid_pence !== undefined ? { playerBid: c.best_player_bid_pence, playerBidQty: c.best_player_bid_quantity ?? 0 } : {}),
        });
      }
    }
  }

  /**
   * Underwriting as the quays' Lloyd's Lists last posted it (display only): the newest list's results for Lloyd's and
   * for player underwriters as a group over its window, and the policies open at each quay that posted one.
   */
  lloydsFigures(): { at: number; windowDays: number; lloyds: UnderwritingFigures | null; players: UnderwritingFigures; openHere: Array<[port: string, policies: number]> } | null {
    let newest: { at: number; notice: LloydsListNotice } | null = null;
    for (const x of this.lloydsSeen.values()) if (!newest || x.at > newest.at) newest = x;
    if (!newest) return null;
    return {
      at: newest.at,
      windowDays: newest.notice.window_game_days,
      lloyds: newest.notice.lloyds ?? null,
      players: newest.notice.players,
      // Counts from the last hour only (a quay read long ago says nothing about what is open there now).
      openHere: [...this.lloydsSeen]
        .filter(([, x]) => Date.now() - x.at < 3_600_000)
        .map(([port, x]): [string, number] => [port, x.notice.policies_open_here])
        .filter(([, n]) => n > 0),
    };
  }

  /**
   * Our own company's resting orders (GET /v1/market/orders), read at most every OWN_ORDERS_TTL_MS: the news'
   * anonymous best levels may be ours, and a live book's depth shows ours among the players' (left out of the asks our
   * bids fill and the bids our asks fill, noteUnfillable). The fleet trades IOC only, so this is usually empty; one
   * page of 200. A failed read keeps the last.
   */
  private async refreshOwnOrders(): Promise<void> {
    if (Date.now() - this.ownOrdersAt < OWN_ORDERS_TTL_MS) return;
    this.ownOrdersAt = Date.now();
    const list = await this.client.orders({ limit: 200 }).catch(() => null);
    if (!list) return;
    const by = new Map<string, OwnOrder[]>();
    for (const o of list) {
      const tons = o.quantity - o.filled_quantity;
      if (!(tons > 0) || o.is_npc) continue;
      const k = `${o.port_id}|${o.commodity_id}`;
      by.set(k, [...(by.get(k) ?? []), { id: o.id, side: o.side, price: o.price_pence, tons }]);
      this.noteUnfillable(o.port_id, o.commodity_id, [o.id], o.side);
    }
    this.ownOrders = by;
  }

  /**
   * The best players' resting order on one side at a port as last seen (`ask`: one our bids can fill; `bid`: one our
   * asks can sell into) and the tons we may count on at server time `at`: our own resting orders at that price left
   * out (the news is anonymous), and the rest less PLAYER_LEVEL_DECAY_PER_DAY per game day of the news' age (it may be
   * filled or withdrawn by then). A bid is the news' only (a live book's bid already counts players'). The news' levels
   * count only with no sibling company of ours (theirs can't be told apart). Null: none.
   */
  playerLevel(portId: string, good: string, side: "bid" | "ask", at = this.now()): { price: number; tons: number } | null {
    const p = this.price(portId, good);
    if (!p || (side === "bid" && p.live)) return null;
    // With sibling companies the news' anonymous level may be theirs (orders never match them, and only this company's
    // own orders are read to leave out): not counted.
    if (!p.live && this.rivals.ourIds.size > 1) return null;
    const price = side === "ask" ? p.playerAsk : p.playerBid;
    const qty = side === "ask" ? p.playerAskQty : p.playerBidQty;
    if (!price || !qty || qty <= 0) return null;
    // Ours at that price or better (the news shows the best price and the tons at it) aren't ours to trade with; a live
    // book's depth already left them out by order id.
    const mine = p.live
      ? 0
      : (this.ownOrders.get(`${portId}|${good}`) ?? []).filter((o) => o.side === side && (side === "ask" ? o.price <= price : o.price >= price)).reduce((n, o) => n + o.tons, 0);
    const days = Math.max(0, at - p.at) / (24 * 60 * this.gameMinuteMs);
    const tons = Math.floor((qty - mine) * Math.max(0, 1 - PLAYER_LEVEL_DECAY_PER_DAY * days));
    return tons > 0 ? { price, tons } : null;
  }

  price(portId: string, good: string): PriceObs | undefined {
    const p = this.prices.get(`${portId}|${good}`);
    return p && this.now() - p.at < PRICE_TTL_MS ? p : undefined;
  }

  /**
   * Best guess at the ask when a ship buys at `at`: last seen (a glut's dip easing as it fades), else
   * base price (a producer sits near base when stocked), lower while a glut there is planned on. Null
   * while a recent look found nothing on offer (sold out until the ladder re-quotes), or with no ask
   * seen since a structural collapse of its output there. `player`: a players' resting ask in the news below
   * that, and the tons it may still offer (playerLevel): bought first, the rest from the ladder.
   */
  estAsk(portId: string, good: string, at = this.now()): { ask: number; known: boolean; maxTons?: number; player?: { ask: number; tons: number } } | null {
    const p = this.price(portId, good);
    // Under a royal monopoly another company holds here, the Crown's asks aren't ours: only players' resting asks
    // seen (the holder's among them, ours left out), and no more than they may still offer when we buy.
    if (this.monopolyBars(portId, good)) {
      const lvl = this.playerLevel(portId, good, "ask", at);
      return lvl ? { ask: lvl.price, known: true, maxTons: lvl.tons } : null;
    }
    // A players' ask in the news (a live book's ask already counts them).
    const lvl = p && !p.live ? this.playerLevel(portId, good, "ask", at) : null;
    const player = (ask: number) => (lvl && lvl.price < ask ? { player: { ask: lvl.price, tons: lvl.tons } } : {});
    if (p && p.ask === null && this.now() - p.at < SOLD_OUT_MS * (60 / this.timeScale)) return lvl ? { ask: lvl.price, known: true, maxTons: lvl.tons } : null;
    const seenAt = p?.ask ? p.at : null;
    if (this.shiftedSince(portId, good, "production_collapse", seenAt ?? -Infinity)) return lvl ? { ask: lvl.price, known: true, maxTons: lvl.tons } : null;
    const ask = p?.ask ? this.easeShock(portId, good, "supply_boom", p.ask, p.at, at) : Math.round(this.basePrice(good) * 1.05);
    const glut = this.glutAsk(portId, good, at, seenAt);
    if (glut !== null && glut < ask) return { ask: glut, known: false, ...player(glut) };
    return { ask, known: !!p?.ask, ...player(ask) };
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

  /** A port's customs (paid by the buyer): the live figure from any book or port view read since the catalog, else the catalog's. */
  customsBps(portId: string): number {
    const seen = this.customsSeen.get(portId);
    if (seen && seen.at >= this.catalogAt) return seen.bps;
    return this.port(portId)?.customs_bps ?? seen?.bps ?? this.prices.get(`${portId}|provisions`)?.customsBps ?? 300;
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

  /** Resident Factors' share of the fleet bill (guide 3.9): 120 Cr × factors^1.3 a game day. */
  factorUpkeepPerDay(n: number): number {
    return n > 0 ? Math.round(12_000 * n ** 1.3) : 0;
  }

  /** Extra upkeep per real hour from adding `addTons` of hull to a fleet of `fleetTons`. */
  upkeepDeltaPerHour(fleetTons: number, addTons: number, oceanic = false): number {
    const gameDaysPerHour = this.timeScale / 24;
    const perDay = oceanic ? addTons * 100 : this.sprawlPerDay(fleetTons + addTons) - this.sprawlPerDay(fleetTons);
    return perDay * gameDaysPerHour;
  }
}
