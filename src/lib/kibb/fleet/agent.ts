/**
 * One ship's autopilot. Asks the fleet manager for a lane (planner.ts), then runs it:
 *
 *   at the source  → dock, trim/top up stores, buy each good of the load up to its break-even
 *                    price (main good first: if it can't be had the lane is off), accept the
 *                    lane's freight lots, take any other freight bound the same way, depart
 *   at the dest    → deliver freight and charters (from the roadstead when the per-ton berth lock
 *                    would cost more than waiting out the base lock), sell market goods to the
 *                    port's buyers (not below a floor), re-plan, sail on
 *   anywhere else  → pick up freight bound the same way if it pays for its berth time, sail on
 *
 * Sealed freight pins the ship: it sails to the freight's destination before taking a new lane,
 * and stands by there if the issuer refuses the tender (the carrier is paid if it expires).
 * A lane is kept until its cargo is delivered, so a charter only visible from its own port is not
 * forgotten on the way to the source.
 *
 * Each port call is a "stay" with its own record of what was traded, bought and refused there.
 * All times are compared on the server's clock (World.now()).
 *
 * The AI strategist's orders (live only) act at the ship's next decision in port, after an insured
 * voyage, sealed freight and cargo aboard: hold in the roadstead, sail to a port (empty when nothing
 * pays from there), or a planned lane it rules out dropped and planned again; every safety check of
 * planning, loading and sailing still runs.
 */

import { FATAL_CODES, fatalText, isApiError, isFatalApiError, KibbApiError, outcomeUnknown, type KibbClient } from "../client";
import type { InsurancePolicy, PassengerKind, WaitingGroupView } from "../schema";
import type { OrderCode, OrderStatus, ShipOrder } from "../ai/directives";
import type { BankingRegion, ContractListing, DeliverCharterResult, OrderBookLevel, PortOrderBook, RoutePlan, ShipResult } from "../types";
import type { FleetSettings } from "./manager";
import {
  aboardOf,
  bandReference,
  berthsFor,
  fareFor,
  fillHeads,
  fittingGroups,
  lateShare,
  median,
  PAX_RECENT_GAME_DAYS,
  perHeadPerNm,
  routeKey,
  routeReference,
  routesToMeasure,
  speedFactor,
  waitWorth,
  weightMs,
  winChance,
  type PaxAboard,
  type PaxOffer,
} from "./passengers";
import { cargoLane, minLoadTons, REPOST_GRACE_GAME_MIN, type FreightPick, type Lane, type Part, type StallStake } from "./planner";
import { freightLoot, isReturnFreight, returnLotStake, type World } from "./world";

const POLL_MS              = 15_000;
const MAX_SAIL_SLEEP_MS    = 60_000;
// Idle re-checks are short: events (arrivals, new charters, deliveries paying) wake ships at once,
// and these are only the fallback when nothing does.
const IDLE_WAIT_MS         = 30_000;
const NO_CASH_WAIT_MS      = 30_000;
/** Between tenders of freight the issuer refused (it has no warehouse space yet). */
const STAND_BY_MS          = 60_000;
/** Holding leftovers for a fair bid: NPC buyers re-quote every 6 game hours, so look again in half that (game minutes). */
const HOLD_WAIT_GAME_MIN   = 180;
const ERROR_BACKOFF_MS     = 30_000;
/** A lane that just failed at its source is skipped for one NPC re-quote (6 game hours at 60×). */
const LANE_COOLDOWN_MS     = 6 * 60_000;
/** A load planned at its source this recently (same stay) isn't planned again before buying. */
const RESIZE_FRESH_MS      = 2 * 60_000;
/** Fewest tons worth holding a whole ship for a stalled charter's re-post. */
const MIN_HOLD_TONS        = 3;
/** Stores kept beyond the next legs' safe figures, in game days of eating in port (the buyer sizes a new hull's room on it too). */
export const STORES_BUFFER_DAYS = 2;
/** The route plan a ship sails on (hull check, stores) is at most this old. */
const SAIL_PLAN_MAX_AGE_MS = 5 * 60_000;
const STORES_GOOD          = "provisions";
const GUN_PRICE_PENCE      = 15_000;
/** Value of a ship-hour when nothing better is known, for weighing detours (pence). */
const DEFAULT_RATE_PER_HOUR = 300_000;
/** Holds at an unfair market before carrying leftovers to the best market elsewhere. */
const MAX_HOLDS            = 2;
/** Market goods are sold down to this far below the price the planner expected, no further. */
const SELL_FLOOR_DROP      = 0.12;
/**
 * Refusal wordings that sound like the contract itself is gone, for the log only: the guide answers a
 * closed contract and refused cargo with the same 409, so closure is told from the listing (deliverCharters).
 */
const CLOSED_RE            = /\b(?:is|was|has been|already)\s+(?:completed?|closed|filled|full|expired|cancell?ed|defaulted|settled)\b|\bnot open\b/i;
/** Sealed freight bound over water the hull isn't rated for: not sailed for again before this (the route may change). */
const FREIGHT_BLOCK_MS     = 10 * 60_000;
/** How long a read of this ship's own insurance policy is trusted (insurance events invalidate it sooner). */
const POLICY_TTL_MS        = 60_000;
/** While the world is paused a ship looks again this often (the manager's nudge on resume comes sooner). */
const PAUSED_WAIT_MS       = 60_000;
/** Extra game days of stores a starving leg adds to the buffer (persisted), its cap, and what each safe arrival takes off. */
const STORES_BIAS_STEP_DAYS = 1;
const STORES_BIAS_MAX_DAYS = 6;
const STORES_BIAS_DECAY_DAYS = 0.5;
/** An arrested ship looks again this often (real ms), and our loans are read for her release at most this often. */
const ARREST_WAIT_MS       = 60_000;
const ARREST_RECHECK_MS    = 5 * 60_000;
/** A refusal that says the ship is under arrest (guide 3.13.1: a defaulted loan's pledge can't depart or join a convoy). */
export const ARREST_RE     = /\barrest/i;
/** A ship with contraband aboard in an ordinary port, kept from a berth trade: looks again this often (real ms). */
const CONTRABAND_WAIT_MS   = 60_000;
/** Passengers (guide 3.20): a failed read of those aboard is tried again after this (real ms); it never holds a voyage up. */
const PAX_SYNC_RETRY_MS    = 60_000;
/** The groups waiting at a port are read once a stay, again only once this old (game hours: new ones come every hour). */
const PAX_WAITING_FRESH_GAME_H = 2;
/** A hold for the next game-hour round ends this long after it (game minutes), so the groups' choice has been made. */
const PAX_ROUND_SLACK_GAME_MIN = 3;
/** Offers tried for one destination in one stay at most, priced or not (a depart refused again and again never loops posting). */
const PAX_MAX_POSTS_PER_STAY = 3;
/** Free hold kept back from berths for a stores top-up (a convoy's pace, a depart that finds them short): tons, and share of the leg's safe stores. */
const PAX_STORES_SLACK_TONS = 2;
const PAX_STORES_SLACK_SHARE = 0.25;
/** Routes whose length is read for the world's fare per sea mile, when the route has too few fares of its own. */
const PAX_FALLBACK_ROUTES  = 6;
/** Share of the fares aboard counted as landing when the passage's pirate and storm odds weren't worked out. */
const PAX_DEFAULT_KEPT     = 0.95;

export interface FleetHost {
  readonly world: World;
  readonly client: KibbClient;
  readonly settings: FleetSettings;
  log(source: string, msg: string): void;
  fatal(msg: string): void;
  /** The operators paused the world: ships wait without ticking (FleetManager nudges them on resume). */
  readonly paused: boolean;
  /** A call was refused with `503 world_paused`. */
  notePaused(): void;
  /**
   * Picks, reserves and returns the best lane for this ship from `from` (null: nothing pays). `pin`: only
   * lanes loading at `onlySource` and/or delivering at `onlyDest` (an insured voyage).
   */
  assignLane(agent: ShipAgent, from: string, r: ShipResult, pin?: { onlySource?: string; onlyDest?: string }): Promise<Lane | null>;
  releaseLane(agent: ShipAgent): void;
  /**
   * Cash spendable in a region after its floor, topping it up from other regions if short. `fresh`: the
   * vaults were just read. `essential` (stores to sail safely): may dip into the floor when still short.
   */
  ensureCash(region: BankingRegion, amount: number, opts?: { fresh?: boolean; essential?: boolean }): Promise<number>;
  /** Runs `fn` holding the company's cash lock, so raising cash and spending it can't interleave. */
  withCash<T>(fn: () => Promise<T>): Promise<T>;
  /** Called while this ship gives us presence at a shipyard: the buyer's chance to build there. */
  visitShipyard(port: string): Promise<void>;
  /** Guns this ship should carry after a refit here, or undefined to leave them as they are. */
  gunTarget(agent: ShipAgent, r: ShipResult): Promise<number | undefined>;
  noteArmed(shipId: string, costPence: number): void;
  /** Money landed in a region (a delivery paid): ships waiting for cash can try again. */
  cashArrived(): void;
  /**
   * At the lane's source, before buying any of it: the load planned again with the cash there is now (null: keep
   * it as planned). `onlyDest`: an insured voyage's port, the only one it may switch to.
   */
  resizeLane(agent: ShipAgent, port: string, r: ShipResult, onlyDest?: string): Promise<Lane | null>;
  /** Cash for this ship's load now in a region (raised from others if short), never what our other ships' loads count on. Hold the cash lock. */
  loadBudget(agent: ShipAgent, region: BankingRegion, amount: number): Promise<number>;
  /** Room in a charter this ship may deliver into, after other ships' loaded cargo for it. */
  charterRoomFor(agent: ShipAgent, charterId: string, remaining: number): number;
  /** Whether another ship's lane means to take this freight lot. */
  freightClaimed(agent: ShipAgent, id: string): boolean;
  /** Another of our ships' hold at this port on this good for a re-post, if any. */
  siblingHold(agent: ShipAgent, port: string, good: string): HoldInfo | undefined;
  /** A ship about to sail: join or form a convoy with our other ships on the same route, or sail alone. */
  sailInConvoy(agent: ShipAgent, r: ShipResult, from: string, dest: string, plan: RoutePlan): Promise<ConvoyOutcome>;
  /**
   * In a convoy: real ms to wait (and the activity is set; also while it can't be read or isn't forming here), or
   * null to carry on (it is over, or the ship left it). Re-checks the stores the convoy's pace needs, and a policy
   * bought since, on every pass.
   */
  convoyWait(agent: ShipAgent, r: ShipResult, convoyId: string, port: string): Promise<number | null>;
  /** The fleet's call on the stalled expansion posting this charter stands for (camp: deliver nothing into it before its lapse). */
  stallStake(charterId: string): StallStake | undefined;
  /** The fleet's progress changed: save it (`now` for a trip, a load or a delivery). */
  persist(now?: boolean): void;
  /** A trip finished: add it to the saved history. */
  tripFinished(agent: ShipAgent, trip: TripRecord & { goods: string[]; spentPence: number; rewardPence: number }): void;
  /** The AI's order in force for this ship (live only; done and refused ones aren't). */
  shipOrder(agent: ShipAgent): ShipOrder | undefined;
  /** What became of that order (the one read: a newer answer's isn't marked with it), from the ship. */
  orderOutcome(agent: ShipAgent, order: ShipOrder, status: OrderStatus, code?: OrderCode, note?: string): void;
  /** Whether the AI's directives rule out this planned lane (nothing of it bought yet): a ban, or an order wanting something else. */
  laneVetoed(agent: ShipAgent, lane: Lane): boolean;
  /** Whether the AI's bans keep a ship from making for this port (by this passage, for this charter). */
  offLimits(port: string, plan?: RoutePlan, charterId?: string): boolean;
  /**
   * Whether our loans show this ship arrested (a defaulted loan she is pledged to, her seizure pending; guide 3.13.1).
   * Null: our loans couldn't be read. `fresh`: read them again now.
   */
  shipArrested(shipId: string, fresh?: boolean): Promise<boolean | null>;
  /** Whether this ship smuggles for the fleet now (the smuggling mode took her: no lane, no convoy, no pledge; guide 3.18). */
  isSmuggler(agent: ShipAgent): boolean;
  /**
   * The Free Trade (guide 3.18): her turn in port when she smuggles for the fleet, or (`adopt`) when contraband is aboard with
   * nothing lawful and the smuggling mode may take her. A wait (real ms), or null: carry on as a lawful ship (with contraband
   * still aboard, the hold in the roadstead).
   */
  smuggleTurn(agent: ShipAgent, r: ShipResult, adopt: boolean): Promise<number | null>;
  /**
   * Housekeeping (guide 3.4): where the fleet's retiring of this ship stands (`wanted`, `sail`, `listed`, `breakup`, `verify`), or
   * null. While marked she is offered no lane, convoy or passengers.
   */
  retireStage(agent: ShipAgent): "wanted" | "sail" | "listed" | "breakup" | "verify" | null;
  /**
   * Her turn in port when the fleet is retiring her (empty, nothing else to do): the passage to the yard, a listing for sale, the
   * break-up. A wait (real ms), or null: carry on as any ship (no mark, or it was withdrawn).
   */
  retireTurn(agent: ShipAgent, r: ShipResult, port: string): Promise<number | null>;
}

/** What one ship's agent saves, so a restart resumes its lane, sell floors and record. */
export interface AgentSnapshot {
  name: string;
  stats: AgentStats;
  time: TimeUse;
  trips: TripRecord[];
  trip: {
    key: string;
    label: string;
    goods: string[];
    freightIds: string[];
    est: number;
    startedAt: number;
    spent: number;
    reward: number;
    tons: number;
    resized?: number;
  } | null;
  lane: Lane | null;
  laneLoaded: string | null;
  laneKey: string | null;
  laneSince: number;
  minSale: Array<[string, number]>;
  avoid: Array<[string, number]>;
  ratePerHour: number;
  freight: Array<[string, CarriedFreight]>;
  /** The voyage (origin>dest) whose storm exposure is on the world's record. */
  stormVoyage?: string | null;
  /** Extra game days of stores kept after a starving leg (decays on safe arrivals), and the voyage it was raised for; absent in older saves. */
  storesBiasDays?: number;
  starvedVoyage?: string | null;
  /** Arrested for a defaulted loan (since when, local ms, and why); absent in older saves. */
  arrest?: { at: number; why: string } | null;
  /**
   * Passengers (guide 3.20): the groups aboard as last known, our open offers where she lies (closed on the server when she
   * sails), and fares paid on a lane's passage before its trip began (they go into it); absent in older saves.
   */
  aboard?: PaxAboard[];
  offers?: PaxOffer[];
  laneFares?: { lane: string; pence: number } | null;
}

/** A ship about to sail: alone, now in one of our convoys (joined or formed), or a convoy that couldn't be entered. */
export type ConvoyOutcome = { kind: "alone" } | { kind: "in"; convoyId: string; departsAt: number } | { kind: "failed"; why: string };

/** Cargo held for an expansion charter's re-post. */
export interface HoldInfo {
  /** The posting held for, and its lapse (server ms). */
  id: string;
  expiresAt: number;
  /** When the hold ends at the latest. */
  until: number;
  /** A stalled posting lapsing soon, or a load that landed just after a lapse. */
  why: "stall" | "lapse";
  /** Tons kept back (a stall hold: what this ship's lane plans into the posting); absent: all of the good. */
  tons?: number;
}

export interface AgentStats {
  trips: number;
  deliveredTons: number;
  rewardPence: number;
  spentPence: number;
  freightPence: number;
  /** Passenger fares paid on arrival (guide 3.20); 0 in older saves. */
  passengerPence: number;
}

/** Real milliseconds spent in each kind of work since the autopilot took command. */
export interface TimeUse {
  /** At sea with cargo or freight aboard. */
  laden: number;
  /** At sea empty. */
  ballast: number;
  /** In port working: docking, trading, berth locks, delivering. */
  port: number;
  /** In port with nothing to do: no lane pays, waiting for cash, standing by. */
  idle: number;
}

/** One completed lane: what the planner expected per hour against what it made. */
export interface TripRecord {
  at: string;
  lane: string;
  tons: number;
  hours: number;
  profitPence: number;
  estPerHour: number;
  actualPerHour: number;
  /** Tons the load gained (or lost) when planned again at its source. */
  resizedTons?: number;
}

// "boarding passengers" (a hold at the berth for the next game-hour round) is port work, like a berth lock: never matched here.
// "retiring" (housekeeping: listed for sale, or waiting on the breakers) is idle; her passage to the yard is ballast like any.
const IDLE_RE = /^(no lane pays|waiting for cash|waiting for provisions on sale|standing by|holding|waiting: the world is paused|AI order: holding|arrested|retiring)/;
const TRIP_HISTORY = 8;

export interface CarriedFreight {
  dest: string;
  good: string;
  tons: number;
  reward: number;
  deadline: string | null;
  /** Collateral escrowed for it, returned on delivery (unknown on lots taken before this was kept: 0). */
  collateral?: number;
  /** Where it was taken on: the collateral was escrowed from (and returns to) that port's region. Absent on older saves. */
  origin?: string;
  /** Server time the issuer last refused the tender at `dest`. */
  refusedAt?: number;
  /** Server time the route to `dest` was last found over water the hull isn't rated for (not sailed for a while). */
  blockedAt?: number;
  /** Delivery was rejected outright: keep counting the sealed tons, stop sailing for it. */
  undeliverable?: boolean;
  /**
   * Return freight (guide 3.8, Crown-funded): sealed tons labelled as a cheap local export that are no real goods (they leave the
   * hold on delivery and never touch a market or warehouse), worth nothing to pirates, storms or insurance; only the collateral and
   * the reward go down with the ship. Absent: an ordinary lot (older saves too).
   */
  ret?: boolean;
}

export interface AgentState {
  shipId: string;
  name: string;
  shipClass: string;
  status: string;
  port: string | null;
  dest: string | null;
  eta: string | null;
  activity: string;
  lane: Lane | null;
  cargoTons: number;
  hold: number;
  stores: number;
  freight: CarriedFreight[];
  stats: AgentStats;
  time: TimeUse;
  trips: TripRecord[];
  guns: number;
  nextTickAt: string | null;
  /** Arrested for a defaulted loan (guide 3.13.1): why; absent: not arrested. */
  arrested?: string;
  /** A packet holding its dispatches sealed (guide 3.11: it posts nothing to the boards it calls at). */
  dispatchesSealed?: boolean;
  /** Smuggling for the fleet (guide 3.18; the smuggling mode's report says what she is about); absent: not. */
  smuggler?: boolean;
  /** Passengers (guide 3.20): the groups aboard and our open offers where she lies; absent: none of either. */
  passengers?: { heads: number; farePence: number; groups: PaxAboard[]; offers: PaxOffer[] };
  /** Being retired by housekeeping (guide 3.4): the stage (wanted, sail, listed, breakup, verify); absent: not. */
  retiring?: string;
}

/** One port call: what was done there, so nothing is repeated or mis-delivered. */
interface Stay {
  port: string;
  key: string;
  scouted: boolean;
  /** Kinds of berth trades done: "cargo", "stores", "freight", "arm", "yard". */
  traded: Set<string>;
  /** Tons of each good bought or unloaded from stores here: never deliverable to a charter here. */
  boughtHere: Map<string, number>;
  /** Charters that refused our cargo during this stay. */
  refused: Set<string>;
  /** Goods held for an expansion charter's re-post, by good. */
  holds: Map<string, HoldInfo>;
  /** When (server time) the port's charters were last listed in this stay. */
  lookedAt: number;
  /** Rule 7: stores were bought (or moved in from cargo) this stay; after that only a top-up to the safe figure. */
  storesBought: boolean;
  /** That one top-up to the safe figure was tried (again allowed once the lock it set has passed). */
  storesTopped: boolean;
  /** Departures refused this stay for want of stores, and refused on a conflict without a lock time. */
  provisionRefusals: number;
  departRefusals: number;
  /** Left a convoy short of the stores its pace needs: one top-up to this (tons) before joining again; once a stay. */
  convoyNeed?: number;
  convoyTopped?: boolean;
  /** The last stores purchase found no cash, or no ask we can fill: waits in the roadstead until a ton could be had. */
  storesNoCash?: boolean;
  storesNoAsk?: boolean;
  /** Passengers (guide 3.20): the groups waiting here as read this stay (server ms), and offers posted per destination. */
  paxWaiting?: { at: number; groups: WaitingGroupView[] };
  paxPosts?: Map<string, number>;
  /** The one hold for a round this stay: until when (server ms), and the heads its offer had taken then (a boarding ends it early). */
  paxHold?: { until: number; taken: number };
}

const secs = (ms: number) => `${Math.max(0, Math.round(ms / 1000))}s`;
/** First line of a catch that carries on after a refusal: a dead key, a frozen company or a paused world is never swallowed. */
function soft(e: unknown): void {
  if (isFatalApiError(e) || isApiError(e, "world_paused")) throw e;
}
/** Whole tons of stores to buy to take `have` to `want` (0: there already). */
const storesTons = (have: number, want: number) => (have >= want ? 0 : Math.max(1, Math.ceil(want - have)));
/**
 * The best ask our bids can fill in a book just read, as buyPart prices it: our own other companies' resting asks
 * left out (World.noteUnfillable; null: none left, or none at all). `open`: the ask levels left; `any`: there were some.
 */
function fillableAsk(world: World, port: string, good: string, book: PortOrderBook): { ask: number | null; open: OrderBookLevel[]; any: boolean } {
  const b = book.books.find((x) => x.commodity_id === good);
  const levels = b?.depth?.asks ?? [];
  const open = levels.filter((l) => !world.isUnfillable(port, good, l.order_id));
  const ask = open.length ? Math.min(...open.map((l) => l.price_pence)) : levels.length ? null : (b?.best_ask?.price_pence ?? null);
  return { ask, open, any: levels.length > 0 };
}
const cr = (pence: number) => `${(pence / 100).toLocaleString("en-GB", { maximumFractionDigits: 2 })} Cr`;

export class ShipAgent {
  lane: Lane | null = null;
  activity = "starting";
  stats: AgentStats = { trips: 0, deliveredTons: 0, rewardPence: 0, spentPence: 0, freightPence: 0, passengerPence: 0 };
  last: ShipResult | null = null;
  /** Set when the ship is no longer ours (sunk, seized, gone). */
  gone = false;

  private readonly freight = new Map<string, CarriedFreight>();
  /** Freight ids the server has listed as ours: only those can be dropped for going unlisted. */
  private readonly listedFreight = new Set<string>();
  private freightSynced = false;
  private stay: Stay | null = null;
  /** Lane keys to skip until the given server time (sold out / too dear at the source). */
  private readonly avoid = new Map<string, number>();
  /** Last lane's profit rate, to value this ship's time (pence/hour). */
  private ratePerHour = DEFAULT_RATE_PER_HOUR;
  /** A stay where joining or forming a convoy failed: sail alone from it. */
  private noConvoyAt: string | null = null;
  /** Consecutive holds with leftovers at a market that won't pay fairly. */
  private holds = 0;
  /** The voyage (origin>dest) whose storm exposure the world has counted: once per voyage, kept across restarts. */
  private stormVoyage: string | null = null;
  /** Extra game days of stores (storesTarget): raised by a starving leg, worn down by safe arrivals; saved. */
  private storesBiasDays = 0;
  /** The voyage a starving leg was last noted for (once per voyage). */
  private starvedVoyage: string | null = null;
  /** Ticks in a row that found the ship still at sea past its ETA (the re-read backs off). */
  private overdue = 0;
  private stopRequested = false;
  private wake: (() => void) | null = null;
  /** An event arrived mid-tick: skip the next sleep. */
  private nudged = false;
  private loop: Promise<void> | null = null;
  private nextTickAt: number | null = null;
  private readonly time: TimeUse = { laden: 0, ballast: 0, port: 0, idle: 0 };
  private mode: keyof TimeUse | null = null;
  private modeSince = 0;
  /** When the lane in hand was assigned (local ms), for timing the trip. */
  private laneSince = 0;
  private laneKey: string | null = null;
  /** When (and in which stay) the lane in hand was last sized with the cash there was. */
  private sizedAt: { stay: string; at: number } | null = null;
  /** Cash put into a lane's load (goods, its freight's collateral) in one stay at its source. */
  private laneSpend: { stay: string; lane: string; pence: number } | null = null;
  private trip: {
    key: string;
    label: string;
    goods: Set<string>;
    freightIds: Set<string>;
    est: number;
    startedAt: number;
    spent: number;
    reward: number;
    tons: number;
    resized?: number;
  } | null = null;
  /** The lane whose cargo was loaded at its source: arriving at its destination completes it. */
  private laneLoaded: string | null = null;
  /** Lowest price per ton each good aboard may be sold at (its landed cost, or the market floor). */
  private readonly minSale = new Map<string, number>();
  private readonly trips: TripRecord[] = [];
  /** Restored from a snapshot: the first tick checks the lane still fits the ship. */
  private checkRestored = false;
  /** A restored lane still at its source port: its goods aboard count as bought here. */
  private resumeAt: string | null = null;
  /** The policy on this ship the user bought (open or active), as last read (local ms); null: not read, or an insurance event since. */
  private policy: { p: InsurancePolicy | null; at: number } | null = null;
  /** One-off log lines already written (by key: a policy, a lane), so a waiting ship doesn't repeat them. */
  private readonly noted = new Set<string>();
  /**
   * Arrested for a defaulted loan (guide 3.13.1: no departing or joining a convoy until the lender has her or the debt
   * is paid; cargo of ours aboard is sold toward it): since when and why (local ms), and when our loans were last
   * checked for her release. Null: free.
   */
  private arrest: { at: number; why: string; checkedAt: number } | null = null;
  /** Passenger groups aboard (guide 3.20), by id: from `passengers/aboard` each port call, and the boarding, paid and lost notices between. */
  private readonly aboard = new Map<string, PaxAboard>();
  /** Groups a read of those aboard no longer listed (paid or lost, the notice maybe still to come), by id, the newest few. */
  private readonly paxLeft = new Map<string, PaxAboard>();
  /** Our open sailing offers where she lies, by destination (one per ship and destination; the server closes them as she sails). */
  private readonly offers = new Map<string, PaxOffer>();
  /** `passengers/aboard` read since the start (else the saved list stands), and when last tried (local ms). */
  private paxSynced = false;
  private paxSyncAt = 0;
  /** Cancels of our offers under way: a new offer waits for them (one open per ship and destination). */
  private paxCancels: Promise<unknown> = Promise.resolve();
  /**
   * Passengers' ports found unsailable from where she lay (unrated water, no route, no hold left for the stores), by port: server
   * time. Not pinned to for FREIGHT_BLOCK_MS (as sealed freight's blockedAt), so she works on and they stay aboard until she can go
   * there or the server puts them ashore (guide 3.20). Not saved: a restart tries once more.
   */
  private readonly paxBlocked = new Map<string, number>();
  /** Fares paid on the passage to a lane's source before its trip began: they go into that trip. */
  private laneFares: { lane: string; pence: number } | null = null;
  /** The pirate and storm odds of the passage our offers were posted for: the share of its fares expected to land. */
  private paxKept: { dest: string; kept: number } | null = null;

  constructor(
    private readonly host: FleetHost,
    readonly shipId: string,
    public name: string,
    readonly shipClass: string,
  ) {}

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  get running(): boolean {
    return this.loop !== null;
  }

  get state(): AgentState {
    const r = this.last;
    const s = r?.ship;
    return {
      shipId: this.shipId,
      name: this.name,
      shipClass: this.shipClass,
      status: this.gone ? "gone" : (s?.status ?? "unknown"),
      port: s?.current_port_id ?? null,
      dest: s?.status === "sailing" ? (r?.route_legs.at(-1)?.to_node ?? null) : null,
      eta: s?.status === "sailing" ? (r?.voyage?.estimated_arrival_at ?? s.leg_arrives_at ?? null) : null,
      activity: this.activity,
      lane: this.lane,
      cargoTons: r?.cargo_used_tons ?? 0,
      hold: r?.effective_hold_capacity_tons ?? 0,
      stores: r?.stores.provisions_tons ?? 0,
      freight: [...this.freight.values()],
      stats: { ...this.stats },
      time: this.timeUse(),
      trips: [...this.trips],
      guns: s?.cannons_count ?? 0,
      nextTickAt: this.nextTickAt ? new Date(this.nextTickAt).toISOString() : null,
      ...(this.arrest ? { arrested: this.arrest.why } : {}),
      ...(s?.dispatches_sealed ? { dispatchesSealed: true } : {}),
      ...(!this.gone && this.host.isSmuggler(this) ? { smuggler: true } : {}),
      ...(() => {
        const stage = this.gone ? null : this.host.retireStage(this);
        return stage ? { retiring: stage } : {};
      })(),
      ...(this.aboard.size || this.offers.size
        ? { passengers: { heads: this.paxHeads(), farePence: this.faresAboard(), groups: this.paxGroups(), offers: this.paxOffers() } }
        : {}),
    };
  }

  /** What to save for this ship. */
  snapshot(): AgentSnapshot {
    const t = this.trip;
    return {
      name: this.name,
      stats: { ...this.stats },
      time: this.timeUse(),
      trips: [...this.trips],
      trip: t ? { ...t, goods: [...t.goods], freightIds: [...t.freightIds] } : null,
      lane: this.lane,
      laneLoaded: this.laneLoaded,
      laneKey: this.laneKey,
      laneSince: this.laneSince,
      minSale: [...this.minSale],
      avoid: [...this.avoid],
      ratePerHour: this.ratePerHour,
      freight: [...this.freight],
      stormVoyage: this.stormVoyage,
      storesBiasDays: this.storesBiasDays || undefined,
      starvedVoyage: this.starvedVoyage,
      arrest: this.arrest ? { at: this.arrest.at, why: this.arrest.why } : undefined,
      aboard: this.aboard.size ? this.paxGroups() : undefined,
      offers: this.offers.size ? this.paxOffers() : undefined,
      laneFares: this.laneFares ?? undefined,
    };
  }

  /**
   * Picks up from a snapshot taken before a restart (call before start()). A lane is kept only if
   * its cargo was loaded or partly bought; the first tick checks the cargo is still aboard.
   * Restored freight counts as listed, so the first sync drops lots settled while we were down.
   */
  restore(s: AgentSnapshot): void {
    this.stats = { ...this.stats, ...s.stats };
    Object.assign(this.time, s.time);
    this.trips.splice(0, this.trips.length, ...(s.trips ?? []).slice(-TRIP_HISTORY));
    this.trip = s.trip ? { ...s.trip, goods: new Set(s.trip.goods), freightIds: new Set(s.trip.freightIds) } : null;
    this.laneKey = s.laneKey;
    this.laneSince = s.laneSince;
    if (s.lane) {
      this.lane = s.lane;
      this.laneLoaded = s.laneLoaded;
      this.checkRestored = true;
    }
    for (const [g, p] of s.minSale ?? []) this.minSale.set(g, p);
    for (const [k, until] of s.avoid ?? []) this.avoid.set(k, until);
    if (s.ratePerHour > 0) this.ratePerHour = s.ratePerHour;
    for (const [id, f] of s.freight ?? []) {
      this.freight.set(id, f);
      this.listedFreight.add(id);
    }
    this.stormVoyage = s.stormVoyage ?? null;
    const bias = s.storesBiasDays ?? 0;
    this.storesBiasDays = Number.isFinite(bias) ? Math.min(STORES_BIAS_MAX_DAYS, Math.max(0, bias)) : 0;
    this.starvedVoyage = s.starvedVoyage ?? null;
    // Still arrested after the restart until our loans say otherwise (checked at the first port tick).
    if (s.arrest && typeof s.arrest.why === "string" && Number.isFinite(s.arrest.at)) this.arrest = { at: s.arrest.at, why: s.arrest.why, checkedAt: 0 };
    // Passengers as saved until the first read of those aboard (the pin and cash due work from them meanwhile); our offers stand
    // while she still lies where they were posted (the first port tick drops them elsewhere).
    for (const g of Array.isArray(s.aboard) ? s.aboard : []) if (g && typeof g.id === "string" && typeof g.dest === "string") this.aboard.set(g.id, { ...g });
    for (const o of Array.isArray(s.offers) ? s.offers : []) if (o && typeof o.id === "string" && typeof o.dest === "string") this.offers.set(o.dest, { ...o });
    if (s.laneFares && typeof s.laneFares.lane === "string" && s.laneFares.pence > 0) this.laneFares = { ...s.laneFares };
  }

  /**
   * This ship is arrested (a 409 on departing or joining a convoy that says so, or a default on the loan she is pledged
   * to): she waits in the roadstead, buying and sailing nothing, until our loans show her free (arrestWait). Her lane is
   * given up: cargo of ours left aboard is sold toward the debt (guide 3.13.1).
   */
  noteArrest(why: string): void {
    const text = why.replace(/\s+/g, " ").trim().slice(0, 160);
    if (!this.arrest) {
      this.log(`ARRESTED (${text}): she can't depart or join a convoy until the debt is paid or the lender takes her; waiting in the roadstead, buying nothing`);
      if (this.lane) this.host.releaseLane(this);
    }
    // No passengers board a ship that can't sail.
    this.dropOffers("she is under arrest");
    this.arrest = { at: Date.now(), why: text, checkedAt: Date.now() };
    this.host.persist(true);
    this.nudge();
  }

  /** Whether this ship is held under arrest (as far as we know). */
  get arrested(): boolean {
    return this.arrest !== null;
  }

  /**
   * After a restart: keep the restored lane only if its cargo (or freight) is still aboard, or nothing was loaded yet but some was
   * bought, or passengers aboard are bound for its source or its port (their voyage is the lane's: its plan and room stand).
   */
  private checkRestoredLane(r: ShipResult): void {
    this.checkRestored = false;
    const lane = this.lane;
    if (!lane) return;
    const goods = this.laneGoodsAboard(r, lane);
    const freight = lane.freight.some((f) => this.freight.has(f.id));
    const pax = [...this.aboard.values()].some((g) => g.dest === lane.source || g.dest === lane.dest);
    if (goods > 0 || freight || pax) {
      this.log(`resumed lane ${lane.key}${this.laneLoaded === lane.key ? " (loaded)" : goods > 0 || freight ? " (part loaded)" : " (passengers aboard for it)"}`);
      // Still at the source (loaded or part bought): what's aboard was bought there, so it is never offered to
      // a charter here, and loading carries on from it.
      if (r.ship.status !== "sailing" && r.ship.current_port_id === lane.source) this.resumeAt = lane.source;
      return;
    }
    if (this.laneLoaded === lane.key) this.log(`the cargo for lane ${lane.key} is no longer aboard: planning afresh`);
    // Delivered just before the restart: record the trip it finished.
    if (this.trip?.key === lane.key) this.finishTrip();
    this.host.releaseLane(this);
  }

  /** Time use so far, including the stretch in progress. */
  private timeUse(): TimeUse {
    const t = { ...this.time };
    if (this.mode) t[this.mode] += Date.now() - this.modeSince;
    return t;
  }

  /** Closes the stretch in progress and starts one for what the ship is doing now. */
  private markTime(): void {
    const now = Date.now();
    if (this.mode) this.time[this.mode] += now - this.modeSince;
    const r = this.last;
    if (this.gone || !r) {
      this.mode = null;
      return;
    }
    this.mode =
      r.ship.status === "sailing"
        ? r.cargo_used_tons > 0
          ? "laden"
          : "ballast"
        : IDLE_RE.test(this.activity)
          ? "idle"
          : "port";
    this.modeSince = now;
  }

  /** Records the lane's trip once its cargo has been delivered. */
  private finishTrip(): void {
    const t = this.trip;
    // A delivery of some other good (pinned freight port, leftovers) doesn't end this trip.
    if (!t || t.reward <= 0) return;
    this.trip = null;
    this.laneKey = null;
    const hours = Math.max((Date.now() - t.startedAt) / 3_600_000, 1 / 3_600);
    const profit = t.reward - t.spent;
    const rec: TripRecord = {
      at: new Date().toISOString(),
      lane: t.label,
      tons: t.tons,
      hours: Math.round(hours * 100) / 100,
      profitPence: profit,
      estPerHour: Math.round(t.est),
      actualPerHour: Math.round(profit / hours),
      ...(t.resized ? { resizedTons: t.resized } : {}),
    };
    this.trips.push(rec);
    if (this.trips.length > TRIP_HISTORY) this.trips.splice(0, this.trips.length - TRIP_HISTORY);
    this.host.tripFinished(this, { ...rec, goods: [...t.goods], spentPence: t.spent, rewardPence: t.reward });
    this.host.persist(true);
  }

  /**
   * Tons of this good aboard that belong to us (not sealed freight) for lawful work: contraband counts none, as no
   * market, charter or warehouse takes it (guide 3.18; contrabandAboard has it).
   */
  ownTons(r: ShipResult, good: string): number {
    if (this.host.world.isContraband(good)) return 0;
    let sealed = 0;
    for (const f of this.freight.values()) if (f.good === good) sealed += f.tons;
    return Math.max(0, (r.cargo_manifest[good] ?? 0) - sealed);
  }

  /** Contraband aboard (good, tons): ours alone (freight never carries it), worth its base in net worth but never sold lawfully. */
  contrabandAboard(r: ShipResult): Array<[string, number]> {
    return Object.entries(r.cargo_manifest).filter(([g, t]) => t > 0 && this.host.world.isContraband(g));
  }

  /** Tons of sealed freight aboard. */
  sealedTons(): number {
    let t = 0;
    for (const f of this.freight.values()) t += f.tons;
    return t;
  }

  /** Takes a lane (or none). A different lane, or none, means nothing of it is loaded yet. */
  setLane(lane: Lane | null): void {
    if (!lane || lane.key !== this.lane?.key) this.laneLoaded = null;
    this.lane = lane;
  }

  /** True once the lane's cargo is aboard (its charter room is then firmly ours). */
  get loaded(): boolean {
    return !!this.lane && this.laneLoaded === this.lane.key;
  }

  /** Parts of the lane not yet bought (they count against the source's depth and the fleet's cash). */
  partsToBuy(): Part[] {
    const r = this.last;
    if (!this.lane || !r || this.laneLoaded === this.lane.key) return [];
    return this.lane.parts.filter((p) => this.ownTons(r, p.good) === 0);
  }

  /** The lane's freight lots not yet accepted. */
  freightToTake(): FreightPick[] {
    if (!this.lane || this.laneLoaded === this.lane.key) return [];
    return this.lane.freight.filter((f) => !this.freight.has(f.id));
  }

  /** Cash this stay has put into the lane in hand so far (its first call counts down by it; 0 after a restart). */
  spentOnLane(): number {
    const s = this.laneSpend;
    return s && s.stay === this.stay?.key && s.lane === this.lane?.key ? s.pence : 0;
  }

  private noteLaneSpend(lane: Lane, pence: number): void {
    const stay = this.stay?.key;
    if (!stay || !(pence > 0)) return;
    if (this.laneSpend?.stay !== stay || this.laneSpend.lane !== lane.key) this.laneSpend = { stay, lane: lane.key, pence: 0 };
    this.laneSpend.pence += pence;
  }

  /** Tons of this lane's goods aboard (sealed freight excluded). */
  private laneGoodsAboard(r: ShipResult, lane: Lane | null = this.lane): number {
    return lane ? lane.parts.reduce((n, p) => n + this.ownTons(r, p.good), 0) : 0;
  }

  /**
   * A goods load that counted on cash due, none of it bought yet: short of that cash it waits rather than
   * sail under the planner's minimum (the cash lands, or the next plan no longer counts on it). Planned on
   * cash in hand, waiting wouldn't help: it buys what the cash covers, as ever.
   */
  private waitsForDue(r: ShipResult, lane: Lane): boolean {
    return lane.kind !== "freight" && (lane.dueCounted ?? 0) > 0 && this.laneGoodsAboard(r, lane) === 0;
  }

  /** Tons of the main cargo that, with the lane's freight, make the planner's minimum load. */
  private leastMainTons(r: ShipResult, lane: Lane): number {
    return minLoadTons(r.effective_hold_capacity_tons - this.sealedTons()) - lane.freight.reduce((n, f) => n + f.tons, 0);
  }

  /** Starts the trip record for the lane at its first purchase or freight lot. */
  private ensureTrip(r: ShipResult, lane: Lane): NonNullable<ShipAgent["trip"]> {
    // A trip of the same lane whose cargo never arrived (charter filled, sold off) is stale.
    const stale = this.trip?.key === lane.key && this.laneGoodsAboard(r, lane) === 0 && ![...this.trip.freightIds].some((id) => this.freight.has(id));
    if (!this.trip || this.trip.key !== lane.key || stale) {
      // Fares paid on the passage here for this lane (its trip's time counts that passage) go into its takings.
      const fares = this.laneFares?.lane === lane.key ? this.laneFares.pence : 0;
      this.laneFares = null;
      this.trip = {
        key: lane.key,
        label: `${lane.good} ${lane.source} → ${lane.dest}`,
        goods: new Set(lane.parts.map((p) => p.good)),
        freightIds: new Set(),
        // Cash only (the phase bonus comes later) and up to delivery, like what a trip makes.
        est: (lane.cashProfit * 3_600_000) / Math.max(lane.deliverMs, 60_000),
        startedAt: this.laneKey === lane.key && this.laneSince ? this.laneSince : Date.now(),
        spent: 0,
        reward: fares,
        tons: 0,
        resized: lane.resizedFrom !== undefined ? lane.tons - lane.resizedFrom : undefined,
      };
    }
    return this.trip;
  }

  /** What this ship's time is worth (pence an hour): its last lane's profit rate. */
  get rate(): number {
    return this.ratePerHour;
  }

  /**
   * Server time the cargo aboard must arrive by: the soonest charter the lane fills that won't be
   * re-posted, the soonest deadline of the sealed freight aboard, or (with `passengers`) the soonest
   * arrival promised to passengers aboard (guide 3.20: later cuts the fare). Null if nothing is due.
   * Without them it is the hard deadline: a charter pays nothing late and sealed freight forfeits its
   * collateral, while a late group is only cut per game day down to a floor (3.20.6), weighed as a cost.
   */
  deliverDeadline(passengers = true): number | null {
    const dues: number[] = [this.charterDue()];
    for (const f of this.freight.values()) if (f.deadline) dues.push(Date.parse(f.deadline));
    if (passengers) {
      // Groups bound for where she lies are paid there now: only those still to carry count.
      const here = this.last?.ship.status !== "sailing" ? this.last?.ship.current_port_id : null;
      for (const g of this.aboard.values()) if (g.promisedAt && g.dest !== here) dues.push(Date.parse(g.promisedAt));
    }
    const ok = dues.filter((t) => Number.isFinite(t));
    return ok.length ? Math.min(...ok) : null;
  }

  /** The soonest expiry (server ms) of the charters the lane fills that won't be re-posted; Infinity: none. */
  private charterDue(): number {
    const { world } = this.host;
    let due = Infinity;
    for (const [id] of this.lane?.fills ?? []) {
      const c = world.charters.find((x) => x.id === world.currentId(id));
      if (c?.expiresAt && !world.renews(c)) due = Math.min(due, c.expiresAt);
    }
    return due;
  }

  /**
   * What landing at `dest` at server time `at` rather than `otherwise` is expected to cut from the fares of the groups aboard bound
   * there (pence; guide 3.20.6: per game day late, down to a floor): a convoy's muster and slower pace weighed as a cost, not refused.
   */
  paxLateCost(dest: string, at: number, otherwise: number): number {
    const dayMs = 24 * 60 * this.host.world.gameMinuteMs;
    let pence = 0;
    for (const g of this.aboard.values()) {
      if (g.dest === dest) pence += g.farePence * Math.max(0, lateShare(g.promisedAt, otherwise, dayMs) - lateShare(g.promisedAt, at, dayMs));
    }
    return pence;
  }

  /**
   * What this passage is expected to pay where it ends (pence, cash only, before any haircut): the
   * loaded lane's goods at their planned pay, less the share pirates and storms may still take, and
   * freight bound there (reward and collateral), and the fares of passengers bound there (guide 3.20: paid
   * into that region on arrival, less the late cut and the share pirates and storms may take; never insured).
   * Parts held for a re-post don't count (when they pay is unsure), nor does anything while not sailing.
   * `pence` lands in the destination's region; `back` is freight collateral returning to the region it was
   * escrowed from, when that is another.
   */
  proceedsAboard(): { dest: string; at: number; pence: number; back: Array<{ region: BankingRegion; pence: number }> } | null {
    const r = this.last;
    const { world } = this.host;
    if (!r || r.ship.status !== "sailing") return null;
    const dest = r.route_legs.at(-1)?.to_node;
    const eta = Date.parse(r.voyage?.estimated_arrival_at ?? r.ship.leg_arrives_at ?? "");
    if (!dest || !Number.isFinite(eta)) return null;
    let pence = 0;
    let marketTons = 0;
    const lane = this.loaded && this.lane!.dest === dest ? this.lane! : null;
    if (lane) {
      const kept = (1 - (lane.piracyBps ?? 0) / 10_000) * (1 - (lane.stormBps ?? 0) / 10_000);
      for (const p of lane.parts) {
        // Held for a re-post (planned, or the fleet now lets that posting lapse): when it pays is unsure.
        if (p.holdUntil !== null || p.fills.some(([id]) => this.host.stallStake(id)?.camp)) continue;
        const t = Math.min(p.tons, this.ownTons(r, p.good));
        pence += t * p.pay * kept;
        if (p.kind === "market") marketTons += t;
      }
    }
    const back = new Map<BankingRegion, number>();
    for (const f of this.freight.values()) {
      if (f.dest !== dest || f.undeliverable) continue;
      pence += f.reward;
      // The collateral goes back where it was escrowed (deliverFreight books it there too).
      const home = world.region(f.origin ?? f.dest);
      if (home === world.region(dest)) pence += f.collateral ?? 0;
      else back.set(home, (back.get(home) ?? 0) + (f.collateral ?? 0));
    }
    // Fares at the ETA (late arrivals pay less), less the passage's losses: the loaded lane's odds, else those worked out when offered.
    const paxKept = lane
      ? (1 - (lane.piracyBps ?? 0) / 10_000) * (1 - (lane.stormBps ?? 0) / 10_000)
      : this.paxKept?.dest === dest
        ? this.paxKept.kept
        : PAX_DEFAULT_KEPT;
    const dayMs = 24 * 60 * world.gameMinuteMs;
    for (const g of this.aboard.values()) if (g.dest === dest) pence += g.farePence * lateShare(g.promisedAt, eta, dayMs) * paxKept;
    const flows = [...back].filter(([, p]) => p > 0).map(([region, p]) => ({ region, pence: Math.round(p) }));
    if (!(pence > 0) && flows.length === 0) return null;
    // Charters and freight pay once the base lock clears; selling needs the berth and its handling (as the planner times it).
    return { dest, at: eta + 30 * world.gameMinuteMs + marketTons * world.handlingMsPerTon(dest), pence: Math.round(Math.max(0, pence)), back: flows };
  }

  /** True while waiting for cash to buy a load. */
  get waitingForCash(): boolean {
    return this.activity.startsWith("waiting for cash");
  }

  /** True while idle because no lane pays. */
  get idle(): boolean {
    return this.activity.startsWith("no lane pays");
  }

  /** True while an AI order holds it in the roadstead (counted idle by the tripwire). */
  get held(): boolean {
    return this.activity.startsWith("AI order: holding");
  }

  /** Something happened to this ship (an event, or cash for it): tick now instead of on the timer. */
  nudge(): void {
    if (this.wake) this.wake();
    else if (this.loop) this.nudged = true;
  }

  isAvoided(laneKey: string): boolean {
    const until = this.avoid.get(laneKey);
    return until !== undefined && until > this.host.world.now();
  }

  noteLane(lane: Lane): void {
    if (lane.profitPerHour > 0) this.ratePerHour = lane.profitPerHour;
    if (lane.key !== this.laneKey) {
      this.laneKey = lane.key;
      this.laneSince = Date.now();
    }
  }

  /**
   * A load planned again at its source (FleetManager.resizeLane). The passage here was sailed for it:
   * the trip keeps its start, and its timings and rate count that time, so estimates still compare with
   * what trips make and the fleet's return on cash isn't flattered.
   */
  adoptResized(lane: Lane): Lane {
    const since = this.laneSince;
    const elapsed = since ? Math.max(0, Date.now() - since) : 0;
    const loopMs = lane.loopMs + elapsed;
    const adopted: Lane = {
      ...lane,
      deliverMs: lane.deliverMs + elapsed,
      loopMs,
      profitPerHour: Math.round((lane.profitPerHour * lane.loopMs) / Math.max(loopMs, 1)),
    };
    this.setLane(adopted);
    this.noteLane(adopted);
    if (since) this.laneSince = since;
    return adopted;
  }

  start(): void {
    if (this.loop) return;
    this.stopRequested = false;
    this.loop = this.run().finally(() => {
      this.loop = null;
      this.nextTickAt = null;
    });
  }

  async stop(): Promise<void> {
    this.stopRequested = true;
    this.wake?.();
    await this.loop;
  }

  private log(msg: string): void {
    this.host.log(this.name, msg);
  }

  private async run(): Promise<void> {
    while (!this.stopRequested) {
      let wait: number;
      if (this.host.paused) {
        // Paused by the operators: nothing sails, trades or bills, so no tick until it resumes (the manager nudges).
        this.activity = "waiting: the world is paused";
        wait = PAUSED_WAIT_MS;
      } else {
        try {
          wait = await this.tick();
        } catch (e) {
          if (isFatalApiError(e)) {
            this.host.fatal(fatalText(e));
            return;
          }
          if (isApiError(e, "world_paused")) {
            // Said once by the manager, not as a failure per ship.
            this.host.notePaused();
            this.activity = "waiting: the world is paused";
            wait = PAUSED_WAIT_MS;
          } else {
            this.log(`tick failed: ${(e as Error).message}`);
            wait = ERROR_BACKOFF_MS;
          }
        }
      }
      this.markTime();
      await this.sleep(wait);
    }
    if (this.mode) this.time[this.mode] += Date.now() - this.modeSince;
    this.mode = null;
  }

  private sleep(ms: number): Promise<void> {
    if (this.stopRequested) return Promise.resolve();
    if (this.nudged) {
      this.nudged = false;
      return Promise.resolve();
    }
    this.nextTickAt = Date.now() + ms;
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      const self = this;
      function done() {
        clearTimeout(timer);
        self.wake = null;
        resolve();
      }
      this.wake = done;
    });
  }

  // ── Freight bookkeeping ─────────────────────────────────────────────────────

  /**
   * Reconciles carried freight with the server: adds lots listed as ours, drops lots the server
   * listed before and no longer does (settled), and drops lots a game day past their deadline. Returns
   * whether the server's whole list was read (so a lot missing from it is no longer active).
   */
  private async syncFreight(): Promise<boolean> {
    let complete = false;
    try {
      const page = await this.host.client.contractPages({ contract_type: "freight", status: "active" });
      complete = page.complete;
      const mine = page.items.filter((x) => x.carrier_ship_id === this.shipId);
      const ids = new Set(mine.map((c) => c.id));
      for (const c of mine) this.trackFreight(c);
      // A list cut short says nothing of what is missing from it: lots are dropped only on the whole list.
      if (complete) {
        for (const id of [...this.freight.keys()]) {
          if (this.listedFreight.has(id) && !ids.has(id)) {
            const f = this.freight.get(id)!;
            this.log(`freight to ${f.dest} is no longer active; treating the ${f.tons} t ${f.good} as settled`);
            this.freight.delete(id);
            // A return lot of ours settled: room under our companies' cap again (guide 3.8).
            if (f.ret) this.host.world.noteReturnDelivered();
          }
        }
        this.listedFreight.clear();
      }
      for (const id of ids) this.listedFreight.add(id);
      this.freightSynced = true;
    } catch (e) {
      soft(e);
      this.log(`could not list carried freight yet: ${(e as Error).message}`);
    }
    const now = this.host.world.now();
    for (const [id, f] of this.freight) {
      if (f.deadline && Date.parse(f.deadline) + 24 * 60 * this.host.world.gameMinuteMs < now) {
        this.log(`freight to ${f.dest} is past its deadline; treating the ${f.tons} t ${f.good} as settled`);
        this.freight.delete(id);
      }
    }
    return complete;
  }

  private trackFreight(c: ContractListing): void {
    if (!c.dest_port_id || !c.commodity_id) return;
    const had = this.freight.get(c.id);
    // Return freight taken before it was flagged (an older save, an answer lost): the server's record says so.
    if (had) {
      if (!had.ret && isReturnFreight(c)) had.ret = true;
      return;
    }
    this.freight.set(c.id, {
      dest: c.dest_port_id,
      good: c.commodity_id,
      tons: c.quantity_required,
      reward: c.reward_pence,
      collateral: c.collateral_pence,
      deadline: c.expires_at ?? null,
      origin: c.origin_port_id || undefined,
      ...(isReturnFreight(c) ? { ret: true } : {}),
    });
  }

  /** Tons of return freight aboard (of `good`, if given): sealed, worth nothing (guide 3.8), never ours to sell or count as cargo value. */
  returnTons(good?: string): number {
    let t = 0;
    for (const f of this.freight.values()) if (f.ret && (good === undefined || f.good === good)) t += f.tons;
    return t;
  }

  /**
   * What a hold as read is worth to pirates and storms (pence, at base prices): every stack aboard but return freight, which no raid
   * or storm touches (guide 3.8). Ordinary sealed freight counts at its goods' value, as it did.
   */
  lootValue(r: ShipResult, basePrice: (good: string) => number): number {
    return Object.entries(r.cargo_manifest).reduce((n, [g, t]) => n + Math.max(0, t - this.returnTons(g)) * basePrice(g), 0);
  }

  /**
   * What the return freight aboard stakes on the hull (pence): each lot's reward and collateral, lost with her if she sinks or is
   * taken (guide 3.8), though it draws no raid and no storm touches it otherwise (lootValue leaves it out).
   */
  returnStake(): number {
    let n = 0;
    for (const f of this.freight.values()) n += returnLotStake(f);
    return n;
  }

  /** The freight destination to make for next: earliest deadline first (not one found over unrated water lately). */
  private freightDestination(here: string): string | null {
    const now = this.host.world.now();
    const lots = [...this.freight.values()].filter((f) => f.dest !== here && !f.undeliverable && !(f.blockedAt && now - f.blockedAt < FREIGHT_BLOCK_MS));
    if (lots.length === 0) return null;
    lots.sort((a, b) => (a.deadline ? Date.parse(a.deadline) : Infinity) - (b.deadline ? Date.parse(b.deadline) : Infinity));
    return lots[0].dest;
  }

  // ── Passengers (guide 3.20) ─────────────────────────────────────────────────

  /** Heads aboard (bound for `dest`, if given). */
  paxHeads(dest?: string): number {
    let n = 0;
    for (const g of this.aboard.values()) if (dest === undefined || g.dest === dest) n += g.size;
    return n;
  }

  /** The whole fares of the groups aboard (pence): what losing her would cost in fares (never insured), and a richer prize for pirates. */
  faresAboard(): number {
    let n = 0;
    for (const g of this.aboard.values()) n += g.farePence;
    return n;
  }

  /** The groups aboard and our open offers, for the dashboard and the snapshot. */
  paxGroups(): PaxAboard[] {
    return [...this.aboard.values()].map((g) => ({ ...g }));
  }

  paxOffers(): PaxOffer[] {
    return [...this.offers.values()].map((o) => ({ ...o }));
  }

  /** Whether an offer of ours stands where she lies (groups may board her any game hour). */
  get offering(): boolean {
    return this.offers.size > 0;
  }

  /** Whether a passenger notice naming this offer or group is about her (a group aboard, or just gone from her list). */
  knowsPax(offerId: string | undefined, groupId: string | undefined): boolean {
    if (offerId !== undefined && [...this.offers.values()].some((o) => o.id === offerId)) return true;
    return groupId !== undefined && (this.aboard.has(groupId) || this.paxLeft.has(groupId));
  }

  /**
   * The passengers' port to make for next: the soonest promise among the groups aboard bound elsewhere than `here` (null: none).
   * A port found unsailable lately (paxBlock) is skipped, so a group she can't carry there doesn't hold her from all other work.
   */
  private passengerPort(here: string): string | null {
    const now = this.host.world.now();
    let best: { dest: string; due: number } | null = null;
    for (const g of this.aboard.values()) {
      if (g.dest === here) continue;
      const blocked = this.paxBlocked.get(g.dest);
      if (blocked !== undefined && now - blocked < FREIGHT_BLOCK_MS) continue;
      const due = g.promisedAt ? Date.parse(g.promisedAt) : Infinity;
      if (!best || (Number.isFinite(due) ? due : Infinity) < best.due) best = { dest: g.dest, due: Number.isFinite(due) ? due : Infinity };
    }
    return best?.dest ?? null;
  }

  /**
   * `dest` found unsailable from here (unrated water, no route, no hold left for the stores): groups aboard bound there no longer
   * pin her for FREIGHT_BLOCK_MS (passengerPort), said once a stay. Nothing aboard for it: nothing kept.
   */
  private paxBlock(dest: string, why: string): void {
    const heads = this.paxHeads(dest);
    if (heads === 0) return;
    this.paxBlocked.set(dest, this.host.world.now());
    this.logOnce(
      `pax-blocked:${this.stay?.key ?? ""}:${dest}`,
      `can't sail for ${dest} with the ${heads} passengers aboard for it (${why}): working on meanwhile; they stay aboard until she can go there or the server puts them ashore`,
    );
  }

  /** The soonest arrival promised (server ms) to groups aboard bound for `dest` (undefined: anywhere but where she lies); Infinity: none. */
  private paxDue(dest?: string): number {
    const here = this.last?.ship.status !== "sailing" ? this.last?.ship.current_port_id : null;
    let due = Infinity;
    for (const g of this.aboard.values()) {
      if (dest !== undefined ? g.dest !== dest : g.dest === here) continue;
      const t = g.promisedAt ? Date.parse(g.promisedAt) : NaN;
      if (Number.isFinite(t)) due = Math.min(due, t);
    }
    return due;
  }

  /** Reads who is aboard (`passengers/aboard`); a failed read keeps the last list (the pin and cash due work from it meanwhile). */
  private async syncPassengers(): Promise<void> {
    this.paxSyncAt = Date.now();
    try {
      const list = await this.host.client.passengersAboard(this.shipId);
      const before = new Map(this.aboard);
      this.aboard.clear();
      for (const g of list) {
        this.aboard.set(g.id, aboardOf(g));
        // Boarded while we weren't listening (a restart), or by hand from the dashboard without a notice reaching us.
        if (!before.has(g.id)) this.log(`passengers aboard: ${g.size} ${g.kind} for ${g.dest_port_id}, ${cr(g.full_fare_pence)} on arrival${g.promised_arrival_at ? ` by ${g.promised_arrival_at}` : ""}`);
      }
      // Gone from the list (paid or lost): kept a while, so their notice, if it comes after this read, still knows them.
      for (const [id, g] of before) if (!this.aboard.has(id)) this.paxLeft.set(id, g);
      while (this.paxLeft.size > 50) this.paxLeft.delete(this.paxLeft.keys().next().value!);
      if (before.size || list.length) this.host.persist();
      this.paxSynced = true;
    } catch (e) {
      soft(e);
      this.logOnce(`pax-sync:${this.stay?.key ?? "sea"}`, `could not read the passengers aboard yet: ${(e as Error).message}`);
    }
  }

  /** The groups waiting here (public), read once a stay (again once PAX_WAITING_FRESH_GAME_H old); a failed read is none. */
  private async waitingHere(stay: Stay): Promise<WaitingGroupView[]> {
    const { client, world } = this.host;
    const seen = stay.paxWaiting;
    if (seen && world.now() - seen.at < PAX_WAITING_FRESH_GAME_H * 60 * world.gameMinuteMs) return seen.groups;
    let groups: WaitingGroupView[] = [];
    try {
      groups = await client.passengersWaiting(stay.port);
    } catch (e) {
      soft(e);
      this.logOnce(`pax-waiting:${stay.key}`, `could not list the passengers waiting at ${stay.port}: ${(e as Error).message}`);
    }
    stay.paxWaiting = { at: world.now(), groups };
    return groups;
  }

  /**
   * Offers the spare hold to passengers bound for `dest`, the port this voyage makes for anyway (guide 3.20: never a detour or a
   * passage of their own): only when groups for it wait here that would board whole before they give up, and the fares would land
   * before the season ends; never on a smuggler, with contraband aboard, under arrest, or insured (passengers make a richer prize
   * than the cargo declared: `cargo_exceeds_declared`), nor when it is unknown. Berths are the whole heads the free hold takes after
   * `reserve` tons kept for a stores top-up. Priced by paxFare; posted once a stay, again at the same terms after a move closed it.
   * A passenger failure never stops the voyage (only a dead key, a frozen company or a paused world is thrown).
   */
  private async offerBerths(r: ShipResult, dest: string, stay: Stay, plan: RoutePlan, reserve: number): Promise<void> {
    const { client, world, settings } = this.host;
    const port = stay.port;
    if (!settings.usePassengers || world.paxBlockedNow() !== null || dest === port || r.ship.status === "sailing") return;
    // Nor on a ship being retired (guide 3.4: none aboard or offered when she changes hands at the yard).
    if (this.arrest || this.host.isSmuggler(this) || this.host.retireStage(this) !== null || this.contrabandAboard(r).length > 0) return;
    const had = this.offers.get(dest);
    if (had && had.port === port && had.spot === r.ship.status) return;
    // Moved since it was posted (to or from the berth, into a convoy): taken as closed by the move, and posted again below.
    if (had) this.offers.delete(dest);
    await this.paxCancels;
    const posts = stay.paxPosts ?? (stay.paxPosts = new Map());
    if ((posts.get(dest) ?? 0) >= PAX_MAX_POSTS_PER_STAY) return;
    const cls = world.shipClass(this.shipClass);
    const perTon = cls?.passengers_per_ton || 1;
    const berths = berthsFor(r.effective_hold_capacity_tons - r.cargo_used_tons, perTon, reserve);
    if (berths < 1) return;
    const now = world.now();
    const groups = fittingGroups(await this.waitingHere(stay), dest, berths, now);
    if (groups.length === 0) return;
    const knots = ((cls?.base_speed_centiknots ?? 800) / 100) * 0.8;
    const cap = Math.max(r.hold_capacity_tons, 1);
    const fill = (r.cargo_used_tons + (r.ship.passenger_hold_tons || 0)) / cap;
    // Paid on arrival, and nothing after the season ends (guide 3.11).
    const lands = now + world.sailMs(plan.total_distance_nm, knots * (1 - 0.2 * Math.min(1, fill + berths / perTon / cap))) + 30 * world.gameMinuteMs;
    if (!world.beforeSeasonEnd(lands)) return;
    // Each try counts (priced or not), so a stay never reads the policy and the fares tick after tick.
    posts.set(dest, (posts.get(dest) ?? 0) + 1);
    if ((await this.policyNow()) !== null) return;

    let perHead: number;
    let why: string;
    let open = false;
    if (had && had.port === port) {
      perHead = had.perHead;
      open = !!had.open;
      why = "posted again from where she now lies";
    } else {
      const q = await this.paxFare(port, dest, groups, berths, plan, r);
      if (!q) return;
      perHead = q.perHead;
      open = q.open;
      why =
        `${q.heads} of ${groups.reduce((n, g) => n + g.size, 0)} heads waiting would fit; ${q.basis} ${cr(q.ref)}/head` +
        `${q.open ? `; groups give up unboarded on this route and nobody competes for them, so ${q.high ? "opened high over that" : "asked at that"} on the route's uncontested level, a step lower each unfilled round` : ""}`;
    }
    // What a loss at sea costs the fares (a sinking, a capture; Lloyd's never insures them): the share expected to land.
    const value = Object.keys(r.cargo_manifest).reduce((n, g) => n + this.ownTons(r, g) * world.basePrice(g), 0) + fillHeads(groups, berths) * perHead;
    const lost =
      world.piracyRisk(plan, r.ship.cannons_count, knots, value).capture +
      world.stormRisk(plan, cls?.hull_category ?? "coastal", knots, now, settings.stormWeightPct / 100).sink;
    const kept = Math.max(0, 1 - Math.min(1, lost));
    const until = Math.max(...groups.map((g) => Date.parse(g.board_by)));
    try {
      const o = await client.postPassengerOffer({ ship_id: this.shipId, dest_port_id: dest, fare_per_head_pence: perHead, max_berths: berths });
      this.offers.set(dest, {
        id: o.id,
        port,
        dest,
        perHead: o.fare_per_head_pence || perHead,
        berths: o.max_berths || berths,
        taken: o.berths_taken || 0,
        spot: r.ship.status,
        at: now,
        until,
        kept,
        ...(open ? { open: true } : {}),
      });
      this.paxKept = { dest, kept };
      this.host.persist();
      this.log(`offered ${berths} berths ${port} → ${dest} at ${cr(perHead)}/head (${why})`);
    } catch (e) {
      soft(e);
      // The key may not post offers (`market_derivatives`): none tried for a while, said once.
      if (isApiError(e) && e.status === 403) {
        world.notePaxBlocked(`${e.code ?? "forbidden"}: ${e.detail || e.message}`);
        this.log(`passenger offers refused (${e.code ?? "forbidden"}: ${e.detail || e.message}): not offering berths for a while`);
        return;
      }
      // One open offer per ship and destination (409), or no answer (it may have landed): ours may stand already.
      if ((outcomeUnknown(e) || (isApiError(e) && e.status === 409)) && (await this.adoptOffer(r, dest, until, kept, open ? perHead : undefined))) return;
      this.logOnce(`pax-post:${stay.key}:${dest}`, `passenger offer for ${dest} not posted: ${(e as Error).message}`);
    }
  }

  /**
   * An open offer of ours here for `dest` found on the server (after a 409 or no answer): kept as ours. Whether one was. `openAt`:
   * the uncontested ask just sent; the offer found at that fare is that one (its rounds teach the route's uncontested level).
   */
  private async adoptOffer(r: ShipResult, dest: string, until: number, kept: number, openAt?: number): Promise<boolean> {
    const port = r.ship.current_port_id;
    const list = await this.host.client.passengerOffers(true, { ship_id: this.shipId }).catch((e: unknown) => {
      soft(e);
      return null;
    });
    const o = list?.find((x) => x.ship_id === this.shipId && x.status === "open" && x.port_id === port && x.dest_port_id === dest);
    if (!o || !port) return false;
    const at = Date.parse(o.created_at);
    this.offers.set(dest, {
      id: o.id,
      port,
      dest,
      perHead: o.fare_per_head_pence,
      berths: o.max_berths,
      taken: o.berths_taken,
      spot: r.ship.status,
      at: Number.isFinite(at) ? at : this.host.world.now(),
      until,
      kept,
      ...(openAt !== undefined && o.fare_per_head_pence === openAt ? { open: true } : {}),
    });
    this.host.persist();
    return true;
  }

  /**
   * The fare per head to ask on `port` → `dest` for these groups (passengers.ts fareFor): the route's recent median by kind, else
   * the median of its length band on the fares summary (guide 3.20 item 9: like with like), else the world's per sea mile times
   * this passage; where the route is uncontested for a kind (groups of it gave up unboarded lately: `route_unmet_groups`, or the
   * summary's `unmet` list) on the route's uncontested level, opened high over a band's or the world's median (`high`) but never
   * over the route's own (the fares groups took there, our learned asks already), a little under the reference elsewhere; never
   * under what the weight of the berths costs in sailing time at this ship's rate. Null (said once a stay): no fare seen anywhere
   * yet, or none the groups would take over that floor.
   */
  private async paxFare(
    port: string,
    dest: string,
    groups: WaitingGroupView[],
    berths: number,
    plan: RoutePlan,
    r: ShipResult,
  ): Promise<{ perHead: number; heads: number; ref: number; basis: string; open: boolean; high: boolean } | null> {
    const { world } = this.host;
    const now = world.now();
    const since = now - PAX_RECENT_GAME_DAYS * 24 * 60 * world.gameMinuteMs;
    const records = await world.routeFares(port, dest);
    const refs = new Map<PassengerKind, number>();
    const basis = new Map<PassengerKind, string>();
    // Kinds whose reference is the route's own median.
    const ownRef = new Set<PassengerKind>();
    // The route's band as a fare on it counted (the server's own length), else our sea distance for the passage.
    const routeBand = records.find((f) => f.origin_port_id === port && f.dest_port_id === dest && f.band)?.band ?? null;
    for (const kind of new Set(groups.map((g) => g.kind))) {
      const own = routeReference(records, port, dest, kind, since) ?? routeReference(records, port, dest, undefined, since);
      if (own) {
        refs.set(kind, own.perHead);
        ownRef.add(kind);
        basis.set(kind, `${kind} have paid a median of`);
        continue;
      }
      const band = bandReference(world.fareSummary.bands, routeBand, plan.total_distance_nm);
      if (band) {
        refs.set(kind, band.perHead);
        basis.set(kind, `fares on ${band.band} passages have a median of`);
        continue;
      }
      const rate = await this.farePerNm(kind);
      if (rate !== null) {
        refs.set(kind, rate * plan.total_distance_nm);
        basis.set(kind, `the world's fares per sea mile give ${kind}`);
      }
    }
    const key = `pax-fare:${this.stay?.key ?? ""}:${dest}`;
    if (refs.size === 0) {
      this.logOnce(key, `not offering berths for ${dest}: no accepted fares seen yet, on the route or anywhere`);
      return null;
    }
    const cls = world.shipClass(this.shipClass);
    const knots = (cls?.base_speed_centiknots ?? 800) / 100;
    const perTon = cls?.passengers_per_ton || 1;
    const cap = Math.max(r.hold_capacity_tons, 1);
    const fill = (r.cargo_used_tons + (r.ship.passenger_hold_tons || 0)) / cap;
    // The weight slows her (passengers weigh like cargo): that extra time, at what her time is worth, is the least per head.
    const extra = weightMs(plan.total_distance_nm, knots * 0.8, fill, berths / perTon / cap, (nm, k) => world.sailMs(nm, k));
    const floor = ((extra / 3_600_000) * this.ratePerHour) / Math.max(berths, 1);
    const refKnots = median(world.catalog.ship_classes.map((c) => c.base_speed_centiknots / 100)) ?? knots;
    // Nobody competing for a kind here (guide 3.20 item 9): groups of it on this route gave up waiting unboarded lately.
    const open = new Set<PassengerKind>();
    for (const kind of refs.keys()) {
      if (groups.some((g) => g.kind === kind && (g.route_unmet_groups ?? 0) > 0) || world.paxUnmet(port, dest, kind)) open.add(kind);
    }
    const route = world.paxRoute(routeKey(port, dest));
    const q = fareFor({ refs, groups, berths, floor, adj: route?.adj ?? 1, adjOpen: route?.adjOpen, speed: speedFactor(knots, refKnots), open, own: ownRef, win: winChance(route) });
    if (!q) {
      this.logOnce(key, `not offering berths for ${dest}: the weight's sailing time costs ${cr(floor)}/head, more than groups there have paid`);
      return null;
    }
    return { ...q, basis: basis.get(q.kind) ?? "the reference", high: q.open && !ownRef.has(q.kind) };
  }

  /**
   * The world's accepted fare per head per sea mile (pence) for `kind` (any kind, if too few of it): over the newest fare records'
   * routes, their length read as this hull sails them (cached routes mostly). Null: too few records of known length.
   */
  private async farePerNm(kind: PassengerKind): Promise<number | null> {
    const { world } = this.host;
    const records = world.fares.records;
    if (records.length === 0) return null;
    const routes = new Map<string, [string, string]>();
    for (const x of [...routesToMeasure(records, kind, PAX_FALLBACK_ROUTES), ...routesToMeasure(records, undefined, PAX_FALLBACK_ROUTES)]) routes.set(routeKey(...x), x);
    const nm = new Map<string, number>();
    await Promise.all(
      [...routes].map(async ([k, [a, b]]) => {
        try {
          nm.set(k, (await world.route(a, b, this.shipClass)).total_distance_nm);
        } catch (e) {
          soft(e);
        }
      }),
    );
    const nmOf = (a: string, b: string) => nm.get(routeKey(a, b));
    return perHeadPerNm(records, nmOf, kind) ?? perHeadPerNm(records, nmOf);
  }

  /**
   * The lock clear: whether to hold her where she lies until just after the first game-hour round since our offer for `dest` went
   * up (guide 3.20: the groups choose then; she'd sail before it), once a stay: only while the fares the groups still waiting
   * would bring, at the odds our offers on the route have won and the share expected to land, beat what the wait costs her time
   * and dues. Real ms, or 0 to sail.
   */
  private paxHoldMs(r: ShipResult, dest: string, stay: Stay, plan: RoutePlan, reserve: number): number {
    const { world, settings } = this.host;
    // Switched off (by the user, or the AI's ceiling) or the key refused offers: no hold for a round (sailTo withdrew the offers).
    if (!settings.usePassengers || world.paxBlockedNow() !== null) return 0;
    const o = this.offers.get(dest);
    if (!o || o.port !== stay.port || o.spot !== r.ship.status) return 0;
    const now = world.now();
    // Held already: on until the round is past (a tick woken early by some other notice keeps holding), or a group boarded.
    if (stay.paxHold) return now < stay.paxHold.until && o.taken === stay.paxHold.taken ? stay.paxHold.until - now : 0;
    const round = world.nextGameHour(o.at);
    // A round passed already while the lock held her: the groups have chosen.
    if (round === null || round <= now) return 0;
    const waitMs = round + PAX_ROUND_SLACK_GAME_MIN * world.gameMinuteMs - now;
    // Decided once a stay, whichever way.
    stay.paxHold = { until: now, taken: o.taken };
    // Never past the charters' and sealed freight's hard deadline (as convoyDecision's fit): the wait, the passage at her laden pace,
    // a base lock and a few minutes' slack must still land by it (a lane's planning slack may be eaten by queues and locks already).
    const hard = this.deliverDeadline(false);
    const knots = ((world.shipClass(this.shipClass)?.base_speed_centiknots ?? 800) / 100) * 0.8;
    if (hard !== null && now + waitMs + world.sailMs(plan.total_distance_nm, knots) + 30 * world.gameMinuteMs + 5 * 60_000 > hard) return 0;
    const free = berthsFor(r.effective_hold_capacity_tons - r.cargo_used_tons, world.shipClass(this.shipClass)?.passengers_per_ton || 1, reserve);
    const berths = Math.min(o.berths - o.taken, free);
    const groups = fittingGroups((stay.paxWaiting?.groups ?? []).filter((g) => !this.aboard.has(g.id)), dest, berths, round);
    const heads = fillHeads(groups, berths);
    if (heads <= 0) return 0;
    const value = heads * o.perHead * winChance(world.paxRoute(routeKey(o.port, dest))) * o.kept;
    const dues = r.ship.status === "berthed" ? world.berthDuesFor(stay.port, waitMs, false) : 0;
    const { worth, cost } = waitWorth(value, waitMs, this.ratePerHour, dues);
    if (!worth) return 0;
    stay.paxHold.until = now + waitMs;
    this.log(`holding ${secs(waitMs)} at ${stay.port} for the next game-hour round: ${heads} heads for ${dest} waiting, ~${cr(value)} in fares expected against ${cr(cost)} for the wait`);
    return waitMs;
  }

  /**
   * A round our offer stood through with groups it could take still waiting, and none boarded: its route's fare is nudged down (for
   * an uncontested ask its own level, a step lower and faster).
   */
  private settleOffer(o: PaxOffer): void {
    const { world } = this.host;
    const round = world.nextGameHour(o.at);
    if (o.taken === 0 && round !== null && round + PAX_ROUND_SLACK_GAME_MIN * world.gameMinuteMs <= world.now() && o.until > round) {
      world.notePaxRound(routeKey(o.port, o.dest), false, world.now(), !!o.open);
    }
  }

  /** She sailed: the server closed our offers where she lay (each settled for the pricer). */
  private closeOffers(): void {
    for (const o of this.offers.values()) this.settleOffer(o);
    this.offers.clear();
    this.host.persist();
  }

  /**
   * Withdraws our open offers where she lies (all but the one for `except`): the lane given up, an arrest, smuggling, waiting rather
   * than sailing, a voyage now for another port. No passengers then board for a voyage she isn't making (they would pin her there).
   * In the background: a new offer waits for these (one open per ship and destination); one that closed already is nothing to undo.
   */
  dropOffers(why: string, except?: string): void {
    const drop = [...this.offers.values()].filter((o) => o.dest !== except);
    if (drop.length === 0) return;
    for (const o of drop) {
      this.settleOffer(o);
      this.offers.delete(o.dest);
    }
    this.host.persist();
    const { client } = this.host;
    const cancels = drop.map(async (o) => {
      try {
        await client.cancelPassengerOffer(o.id);
        this.log(`withdrew the passenger offer for ${o.dest} at ${o.port} (${why})`);
      } catch (e) {
        if (isApiError(e) && (e.status === 404 || e.status === 409)) return;
        this.log(`withdrawing the passenger offer for ${o.dest} failed (${(e as Error).message}): it closes when she sails`);
      }
    });
    this.paxCancels = Promise.all([this.paxCancels, ...cancels]).catch(() => undefined);
  }

  /** After a move (to the roadstead for a convoy): our offers here posted again from where she now lies, while groups still wait. */
  private async repostMoved(r: ShipResult, stay: Stay | null): Promise<void> {
    if (!stay) return;
    for (const o of [...this.offers.values()]) {
      if (o.port !== stay.port || o.spot === r.ship.status) continue;
      const plan = await this.host.world.route(stay.port, o.dest, this.shipClass).catch((e: unknown) => {
        soft(e);
        return null;
      });
      if (!plan) {
        this.offers.delete(o.dest);
        continue;
      }
      await this.offerBerths(r, o.dest, stay, plan, Math.max(PAX_STORES_SLACK_TONS, Math.ceil(this.safeStores(stay.port, o.dest, plan) * PAX_STORES_SLACK_SHARE)));
    }
  }

  /**
   * A group took our offer, or boarded by hand from the dashboard (`passengers_boarded`): aboard from now on, and the route's
   * fare nudged up. A notice that doesn't name the group, its port and heads: the list aboard is read again at the next tick.
   */
  paxBoarded(g: { id?: string; kind?: string; size?: number; origin?: string; dest?: string; perHead?: number; farePence?: number; promisedAt?: string; boardedAt?: string; offerId?: string }): void {
    const { world } = this.host;
    const o = (g.offerId ? [...this.offers.values()].find((x) => x.id === g.offerId) : undefined) ?? (g.dest ? this.offers.get(g.dest) : undefined);
    if (o) {
      o.taken += g.size ?? 0;
      // Up the level the offer was priced on (uncontested or contested), never the other.
      world.notePaxRound(routeKey(o.port, o.dest), true, world.now(), !!o.open);
    }
    if (!g.id || !g.dest || !(g.size && g.size > 0)) {
      this.paxSynced = false;
      this.paxSyncAt = 0;
      this.log(`passengers boarded${g.dest ? ` for ${g.dest}` : ""}${g.size ? ` (${g.size} heads)` : ""}: reading who is aboard`);
      this.nudge();
      return;
    }
    const perHead = g.perHead ?? (g.farePence ? Math.round(g.farePence / g.size) : (o?.perHead ?? 0));
    const fare = g.farePence ?? perHead * g.size;
    this.aboard.set(g.id, {
      id: g.id,
      kind: g.kind ?? "travellers",
      size: g.size,
      origin: g.origin ?? o?.port ?? null,
      dest: g.dest,
      perHead,
      farePence: fare,
      promisedAt: g.promisedAt ?? null,
      boardedAt: g.boardedAt ?? null,
    });
    this.log(
      `${g.size} ${g.kind ?? "passengers"} boarded for ${g.dest} at ${cr(perHead)}/head: ${cr(fare)} on arrival${g.promisedAt ? ` by ${g.promisedAt}` : ""}${o ? "" : " (not on an offer of the autopilot's)"}`,
    );
    this.host.persist(true);
    this.nudge();
  }

  /**
   * A group's fare paid on arrival (`passengers_paid`, guide 3.20): into the vault of that port's region, the ship's takings, the
   * lane's trip (or, before its trip began, kept for it; with no lane at all, a trip of fares alone), and ships waiting for cash
   * look again. A notice that doesn't name the group: those bound for that port count as ashore, and the list is read again.
   */
  paxPaid(p: { fare?: number; late?: number; id?: string; port?: string }): void {
    const { world } = this.host;
    const g = p.id ? (this.aboard.get(p.id) ?? this.paxLeft.get(p.id)) : undefined;
    const r = this.last;
    const port = p.port ?? g?.dest ?? (r?.ship.status !== "sailing" ? r?.ship.current_port_id : r?.route_legs.at(-1)?.to_node) ?? null;
    if (g) {
      this.aboard.delete(g.id);
      this.paxLeft.delete(g.id);
    } else {
      if (port) for (const [id, x] of [...this.aboard]) if (x.dest === port) this.aboard.delete(id);
      this.paxSynced = false;
      this.paxSyncAt = 0;
    }
    const fare = p.fare !== undefined && p.fare > 0 ? p.fare : 0;
    if (fare > 0) {
      if (port) world.vaults.set(world.region(port), world.vault(world.region(port)) + fare);
      // Where it landed isn't known: the vaults are read again.
      else void world.refreshVaults().catch(() => undefined);
      this.stats.passengerPence += fare;
      this.bookFare(fare, port, g);
      this.host.cashArrived();
    }
    const late = p.late !== undefined && p.late > 0 ? ` (${p.late} game day${p.late === 1 ? "" : "s"} late: the fare was cut)` : "";
    this.log(`passengers paid ${cr(fare)}${port ? ` at ${port}` : ""}${g ? ` for ${g.size} ${g.kind}${g.origin ? ` from ${g.origin}` : ""}` : ""}${late}`);
    this.host.persist(true);
  }

  /** A fare into the trip it belongs to (see paxPaid). */
  private bookFare(fare: number, port: string | null, g: PaxAboard | undefined): void {
    if (this.trip && this.lane && this.trip.key === this.lane.key) {
      this.trip.reward += fare;
      return;
    }
    if (this.lane) {
      this.laneFares = { lane: this.lane.key, pence: (this.laneFares?.lane === this.lane.key ? this.laneFares.pence : 0) + fare };
      return;
    }
    // A trip of fares alone, timed from the boarding; when that isn't known, no trip (a rate made up would mislead the AI's record).
    const boarded = g?.boardedAt ? Date.parse(g.boardedAt) : NaN;
    if (!Number.isFinite(boarded)) return;
    const hours = Math.max((this.host.world.now() - boarded) / 3_600_000, 1 / 60);
    const rec: TripRecord = {
      at: new Date().toISOString(),
      lane: `passengers ${g?.origin ?? "?"} → ${port ?? "?"}`,
      tons: 0,
      hours: Math.round(hours * 100) / 100,
      profitPence: fare,
      estPerHour: 0,
      actualPerHour: Math.round(fare / hours),
    };
    this.trips.push(rec);
    if (this.trips.length > TRIP_HISTORY) this.trips.splice(0, this.trips.length - TRIP_HISTORY);
    this.host.tripFinished(this, { ...rec, goods: [], spentPence: 0, rewardPence: fare });
  }

  /** A group lost unpaid (`passengers_lost`: the ship sunk, taken or seized, changed hands, or the group long overdue and put ashore). */
  paxLost(p: { cause?: string; id?: string; size?: number }): void {
    const g = p.id ? (this.aboard.get(p.id) ?? this.paxLeft.get(p.id)) : undefined;
    if (g) {
      this.aboard.delete(g.id);
      this.paxLeft.delete(g.id);
    } else {
      this.paxSynced = false;
      this.paxSyncAt = 0;
    }
    const causes: Record<string, string> = {
      sunk: "the ship sank",
      captured: "pirates took the ship",
      seized: "the Crown seized the ship",
      ship_changed_hands: "the ship changed hands",
      overdue: "long overdue, put ashore unpaid",
    };
    const what = g ? `${g.size} ${g.kind} for ${g.dest} (${cr(g.farePence)})` : p.size ? `${p.size} passengers` : "passengers";
    this.log(`${p.cause === "overdue" ? "WARNING: " : ""}${what} lost, unpaid: ${(p.cause && causes[p.cause]) ?? p.cause ?? "no cause given"}`);
    this.host.persist(true);
  }

  /**
   * Puts this voyage's storm exposure on the world's record once: as it sets out, or as we first see
   * it at sea after a restart. That way the storm odds learn from passages without a storm too. A
   * sailing ship ticks at least once a minute (MAX_SAIL_SLEEP_MS), and the shortest passage takes about two.
   */
  private noteVoyage(r: ShipResult): void {
    const dest = r.route_legs.at(-1)?.to_node;
    if (!dest) return;
    const key = `${r.route_legs[0]?.from_node ?? "?"}>${dest}`;
    if (this.stormVoyage === key) return;
    this.stormVoyage = key;
    const { world } = this.host;
    const cls = world.shipClass(this.shipClass);
    // The server's own leg estimates (laden speed, convoy pace) when given; else about the class speed.
    const speed = Math.round((cls?.base_speed_centiknots ?? 800) * 0.9);
    // Each leg's crossing class from route_legs (the voyage's estimates don't carry it): storms roll for the rougher water.
    const edgeOf = (from: string, to: string, idx?: number) =>
      (idx !== undefined && r.route_legs[idx]?.to_node === to ? r.route_legs[idx] : r.route_legs.find((l) => l.from_node === from && l.to_node === to))?.edge_class ?? null;
    const legs = r.voyage?.legs?.length
      ? r.voyage.legs.map((l) => ({ ...l, edge_class: edgeOf(l.from_node, l.to_node, l.leg_idx) }))
      : r.route_legs.slice(r.ship.current_leg_idx).map((l) => ({ ...l, speed_centiknots: speed }));
    world.noteStormExposure(legs, cls?.hull_category ?? "coastal", world.now());
  }

  /**
   * At sea with a leg the server expects to start with empty stores (guide 2: half speed, spoiled cargo, then
   * mutiny odds): said once a voyage, and the stores buffer grows by a day (up to STORES_BIAS_MAX_DAYS) for
   * the voyages after; safe arrivals wear it down.
   */
  private noteStarving(r: ShipResult): void {
    const legs = r.voyage?.legs ?? [];
    const leg = legs.find((l) => l.starving);
    if (!leg) return;
    const key = `${r.route_legs[0]?.from_node ?? "?"}>${r.route_legs.at(-1)?.to_node ?? "?"}`;
    if (this.starvedVoyage === key) return;
    this.starvedVoyage = key;
    this.storesBiasDays = Math.min(STORES_BIAS_MAX_DAYS, this.storesBiasDays + STORES_BIAS_STEP_DAYS);
    this.host.persist();
    this.log(
      `WARNING: the stores won't last this voyage: leg ${leg.leg_idx + 1} (${leg.from_node} → ${leg.to_node}) sets out with none (${r.stores.provisions_tons.toFixed(2)} t aboard now); ` +
        `keeping ${STORES_BUFFER_DAYS + this.storesBiasDays} game days of stores in hand from now on`,
    );
  }

  /**
   * The stores ran out on this ship's voyage (`ship_provisions_exhausted`: once a voyage, shared with noteStarving),
   * or another ship of ours was lost to mutiny (`own` false): STORES_BIAS_STEP_DAYS more in hand for the voyages after.
   * Returns the game days now kept, or null when this voyage had raised it already.
   */
  raiseStoresBias(own: boolean): number | null {
    const r = this.last;
    if (own && r?.ship.status === "sailing") {
      const key = `${r.route_legs[0]?.from_node ?? "?"}>${r.route_legs.at(-1)?.to_node ?? "?"}`;
      if (this.starvedVoyage === key) return null;
      this.starvedVoyage = key;
    }
    this.storesBiasDays = Math.min(STORES_BIAS_MAX_DAYS, this.storesBiasDays + STORES_BIAS_STEP_DAYS);
    this.host.persist();
    return STORES_BUFFER_DAYS + this.storesBiasDays;
  }

  // ── Tick ────────────────────────────────────────────────────────────────────

  private async tick(): Promise<number> {
    const { client, world } = this.host;
    let r: ShipResult;
    try {
      r = await client.ship(this.shipId);
    } catch (e) {
      if (isApiError(e) && (e.status === 404 || e.code === "ship_not_found")) return this.leaveFleet("is no longer in the fleet");
      throw e;
    }
    this.last = r;
    const s = r.ship;

    if (s.status === "sunk") return this.leaveFleet("has sunk");
    // Taken by pirates (a status the October patch may have added).
    if ((s.status as string) === "captured") return this.leaveFleet("was captured by pirates");
    // Forfeit to the Crown for smuggling (guide 3.18: as if she sank), should the game list her so before she goes.
    if ((s.status as string) === "seized") return this.leaveFleet("was seized by the Crown for smuggling");
    if (!this.freightSynced) await this.syncFreight();
    // Passengers aboard: once after a start (or a notice that couldn't be read), and on each arrival while passengers are on or some
    // are aboard (those bound there are paid, overdue ones put ashore). A failed read never holds the voyage up.
    const arriving = s.status !== "sailing" && !!s.current_port_id && this.stay?.port !== s.current_port_id;
    const pax = this.host.settings.usePassengers || this.aboard.size > 0;
    if ((!this.paxSynced && Date.now() - this.paxSyncAt >= PAX_SYNC_RETRY_MS) || (arriving && pax)) await this.syncPassengers();
    if (this.checkRestored && this.freightSynced) this.checkRestoredLane(r);
    for (const good of [...this.minSale.keys()]) if (this.ownTons(r, good) <= 0) this.minSale.delete(good);

    if (s.status === "sailing") {
      this.stay = null;
      // Sailed (alone, or with a convoy): the server closed our offers where she lay.
      if (this.offers.size) this.closeOffers();
      this.noteVoyage(r);
      this.noteStarving(r);
      // An arrested ship's cargo goes toward the debt where she arrives: no lane is rebuilt for it.
      if (!this.lane && this.freightSynced && !this.arrest) this.adoptCargoLane(r);
      const eta = Date.parse(r.voyage?.estimated_arrival_at ?? s.leg_arrives_at ?? "") || 0;
      const ms = eta ? eta - world.now() : POLL_MS;
      const to = r.route_legs.at(-1)?.to_node ?? "?";
      // Still at sea past its ETA (the server settles arrivals on its own beat; the world may be slow or paused):
      // 2 s, doubling to a minute. The arrival event wakes it sooner.
      if (eta && ms <= -1_000) {
        this.overdue++;
        this.activity = `sailing to ${to}, due ${secs(-ms)} ago`;
        return Math.min(2_000 * 2 ** Math.min(this.overdue - 1, 5), MAX_SAIL_SLEEP_MS);
      }
      this.overdue = 0;
      this.activity = `sailing to ${to}, arrives in ${secs(ms)}`;
      return Math.min(Math.max(ms + 1_500, 2_000), MAX_SAIL_SLEEP_MS);
    }

    const port = s.current_port_id;
    if (!port) return POLL_MS;
    this.overdue = 0;
    // In from a voyage on which no leg starved: the extra stores a starving one added wear off a little.
    if (this.stormVoyage !== null && this.starvedVoyage === null && this.storesBiasDays > 0) {
      this.storesBiasDays = Math.max(0, this.storesBiasDays - STORES_BIAS_DECAY_DAYS);
      this.host.persist();
    }
    this.stormVoyage = null;
    this.starvedVoyage = null;
    if (!this.stay || this.stay.port !== port) {
      this.stay = {
        port,
        key: `${port}@${Date.now()}`,
        scouted: false,
        traded: new Set(),
        boughtHere: new Map(),
        refused: new Set(),
        holds: new Map(),
        lookedAt: world.now(),
        storesBought: false,
        storesTopped: false,
        provisionRefusals: 0,
        departRefusals: 0,
      };
      if (this.resumeAt === port && this.lane) {
        for (const p of this.lane.parts) {
          const t = this.ownTons(r, p.good);
          if (t > 0) this.stay.boughtHere.set(p.good, t);
        }
      }
      this.resumeAt = null;
      // Offers posted somewhere else (saved before a restart, the ship since moved on) closed when she sailed.
      for (const [dest, o] of [...this.offers]) if (o.port !== port) this.offers.delete(dest);
      await this.syncFreight();
      await this.refreshPortCharters(port);
    } else if (world.crisisDue(port, this.stay.lookedAt)) {
      // A shortage here whose crisis charter can now be judged: list the quay again (once) to settle it.
      await this.refreshPortCharters(port);
    }
    // In a convoy still forming here: it sails with the others at its set time. A ship in a convoy
    // can't dock or sail alone, so there is nothing else to do meanwhile (after the stay is set up, so
    // leaving it short of stores can top up in this stay).
    if (s.convoy_id) {
      // Moved to the roadstead to join (assumed to close an offer: `ship_moved`): posted again from where she now lies.
      await this.repostMoved(r, this.stay);
      const wait = await this.host.convoyWait(this, r, s.convoy_id, port);
      if (wait !== null) return wait;
    }
    if (!this.freightSynced) {
      this.activity = "waiting to confirm which cargo is sealed freight";
      return POLL_MS;
    }
    return this.atPort(r, this.stay);
  }

  private leaveFleet(why: string): number {
    this.log(`${why}; stopping its autopilot`);
    this.activity = why;
    this.gone = true;
    // The server closes a lost or sold ship's offers (and her passengers are lost: passengers_lost says).
    this.offers.clear();
    this.host.releaseLane(this);
    this.stopRequested = true;
    return 0;
  }

  // ── Housekeeping: what retiring her asks (FleetManager.retireTurn) ─────────

  /** Her last trips (newest last; TRIP_HISTORY of them): what she earned lately. */
  get tripLog(): readonly TripRecord[] {
    return this.trips;
  }

  /** Sails her from this stay to `dest` as any passage (the policy guard, stores, a convoy only if one pays): empty, to the breakers. */
  async sailFor(r: ShipResult, dest: string): Promise<number> {
    const stay = this.stay;
    if (!stay || stay.port !== r.ship.current_port_id) return POLL_MS;
    return this.sailTo(r, dest, stay);
  }

  /** Waits in the roadstead (no lock or dues running up), saying what for. */
  async standBy(r: ShipResult, activity: string): Promise<void> {
    await this.park(r);
    this.activity = activity;
  }

  /** She left the fleet by our own hand (broken up at a yard): her autopilot stops; the scan retires her record. */
  retired(why: string): number {
    return this.leaveFleet(why);
  }

  /** After a restart mid-voyage: rebuild the lane so its charter room stays reserved. */
  private adoptCargoLane(r: ShipResult): void {
    const dest = r.route_legs.at(-1)?.to_node;
    if (!dest) return;
    for (const good of Object.keys(r.cargo_manifest)) {
      const tons = this.ownTons(r, good);
      // Never an expected crisis charter (it isn't listed, so nothing could be delivered into it), nor one of our own player's.
      // Contraband never (ownTons: none of it), nor a charter at a cove.
      // Best by what the pay is worth to us (a Crown or Admiralty premium tapered, guide 3.7).
      const w = this.host.world;
      const worth = (x: (typeof w.charters)[number]) => w.charterPayValue(x, x.payPerTon, Math.min(tons, x.remaining));
      const c = w.charters
        .filter((x) => x.port === dest && x.good === good && !x.provisional && w.deliverable(x) && !w.isCove(x.port))
        .sort((a, b) => worth(b) - worth(a))[0];
      if (tons <= 0 || !c) continue;
      this.lane = cargoLane(good, r.route_legs[0]?.from_node ?? dest, dest, c.id, Math.min(tons, c.remaining), Math.round(worth(c)));
      this.laneLoaded = this.lane.key;
      return;
    }
  }


  /** Lists the port's open charters (complete with our ship here). Returns whether the listing was read. */
  private async refreshPortCharters(port: string): Promise<boolean> {
    // Set before the call: a failed listing isn't retried every tick.
    if (this.stay?.port === port) this.stay.lookedAt = this.host.world.now();
    try {
      const list = await this.host.client.listContracts({ contract_type: "charter", port_id: port, status: "open", limit: 200 });
      this.host.world.mergePortCharters(port, list);
      return true;
    } catch (e) {
      soft(e);
      // Keep the manager's last listing.
      return false;
    }
  }

  /**
   * Under arrest: wait in the roadstead, buying nothing (cargo of ours aboard goes toward the debt). Our loans are read
   * every ARREST_RECHECK_MS: once they show no default holding her (paid, or the refusal wasn't hers to know of), and
   * that long after the refusal, she goes back to work (another refusal arrests her again: never a tight loop).
   * Returns the wait, or null when free.
   */
  private async arrestWait(r: ShipResult): Promise<number | null> {
    const a = this.arrest;
    if (!a) return null;
    if (Date.now() - a.checkedAt >= ARREST_RECHECK_MS) {
      a.checkedAt = Date.now();
      const held = await this.host.shipArrested(this.shipId, true);
      if (held === false && Date.now() - a.at >= ARREST_RECHECK_MS) {
        this.log(`no longer under arrest (our loans show no default holding her): back to work`);
        this.arrest = null;
        this.host.persist(true);
        return null;
      }
    }
    // Nothing reserved for her meanwhile (a lane restored or planned before the arrest was known).
    if (this.lane) this.host.releaseLane(this);
    await this.park(r);
    this.activity = `arrested (${a.why}): waiting in the roadstead until the debt is settled or the lender takes her`;
    return ARREST_WAIT_MS;
  }

  private async atPort(r: ShipResult, stay: Stay): Promise<number> {
    const { world } = this.host;
    const port = stay.port;
    const atYard = !!world.port(port)?.has_shipyard;

    // Arrested (guide 3.13.1): nothing is bought, delivered or sailed until our loans show her free.
    if (this.arrest) {
      const wait = await this.arrestWait(r);
      if (wait !== null) return wait;
    }

    // Contraband aboard in an ordinary port (guide 3.18: a ship lying there with it may be searched, berthed more than in the
    // roadstead): off the berth as soon as the lock lets her (a free berth takes an arriving ship); nothing berths her again.
    if (r.ship.status === "berthed" && !world.isCove(port) && this.contrabandAboard(r).length > 0 && !this.locked(r)) {
      await this.park(r);
      r = await this.reread();
    }

    if (!stay.scouted) {
      stay.scouted = true;
      await this.scout(port);
    }

    // Smuggling for the fleet (the smuggling mode took her, guide 3.18): her turn comes from it, never lawful work meanwhile.
    if (this.host.isSmuggler(this)) {
      const wait = await this.host.smuggleTurn(this, r, false);
      if (wait !== null) return wait;
      // Let go: back to lawful work (anything still aboard is handled below as for any ship).
      r = await this.reread();
    }

    // 1. Freight that ends here (works from the roadstead).
    let refusedHere = false;
    let freightChanged = false;
    for (const [id, f] of [...this.freight].filter(([, x]) => x.dest === port && !x.undeliverable)) {
      // Settled meanwhile (a sync during an earlier lot's delivery).
      if (!this.freight.has(id)) continue;
      if (f.refusedAt && f.refusedAt + STAND_BY_MS > world.now()) {
        refusedHere = true;
        continue;
      }
      const out = await this.deliverFreight(id, f);
      if (out === "retry") {
        this.activity = "freight delivery hit a temporary error; retrying";
        return 15_000;
      }
      if (out === "refused") refusedHere = true;
      else if (out !== "error") freightChanged = true;
    }
    if (freightChanged) r = await this.reread();

    // 2. Our own cargo that a charter here takes. Goods loaded at this port never count.
    const deliverable = (good: string) => this.ownTons(r, good) - (stay.boughtHere.get(good) ?? 0);
    await this.updateHolds(stay, deliverable);
    // Held tons wait for their re-post; the rest is delivered now (never into a lapsed posting, nor one
    // being let lapse: `due` and deliverCharters skip those, so another ship's hold needs no check here).
    const deliverNow = (good: string) => {
      const h = stay.holds.get(good);
      return h ? Math.max(0, deliverable(good) - (h.tons ?? Infinity)) : deliverable(good);
    };
    const nowMs = world.now();
    // Never into a posting the fleet is letting lapse (a token delivery may cancel its re-post's escalation),
    // unless all this ship has for it fits under the line re-posts showed safe (campShut). Nor into a crisis
    // charter only expected from the news: its id isn't the server's.
    const due = world.charters.filter(
      (c) =>
        !c.provisional &&
        c.port === port &&
        (c.expiresAt === null || c.expiresAt > nowMs) &&
        world.deliverable(c) &&
        this.roomIn(c) > 0 &&
        !stay.refused.has(c.id) &&
        deliverNow(c.good) > 0 &&
        !this.campShut(c, Math.min(deliverNow(c.good), this.roomIn(c))),
    );
    // Market goods still to sell here need the berth: don't leave it to deliver from the roadstead.
    const sellingHere =
      this.loaded && this.lane!.dest === port && !stay.traded.has("sold") && this.lane!.parts.some((p) => p.kind === "market" && this.ownTons(r, p.good) > 0);
    if (due.length > 0) {
      const s = r.ship;
      const roomByGood = new Map<string, number>();
      for (const c of due) roomByGood.set(c.good, (roomByGood.get(c.good) ?? 0) + this.roomIn(c));
      const tons = [...roomByGood].reduce((n, [good, room]) => n + Math.min(deliverNow(good), room), 0);
      if (s.status === "berthed" && !sellingHere) {
        const lockLeft = s.turnaround_unlocks_at ? Date.parse(s.turnaround_unlocks_at) - world.now() : 0;
        // At the berth each ton delivered extends the lock; from the roadstead it doesn't.
        if (tons * world.handlingMsPerTon(port) > Math.max(lockLeft, 0) + 5_000) {
          if (lockLeft > 0) {
            this.activity = `waiting ${secs(lockLeft)} for the berth lock, then delivering from the roadstead`;
            return lockLeft + 1_000;
          }
          try {
            await this.offshore(port);
            this.log(`moved to the roadstead at ${port} to deliver without the per-ton berth lock`);
          } catch (e) {
            soft(e);
            if (!isApiError(e) || e.status >= 500) throw e;
            // Lock not quite clear on the server's clock: deliver at the berth instead.
          }
        }
      }
      const res = await this.deliverCharters(r, port, stay, deliverNow);
      if (res.delivered > 0) this.stats.trips++;
      r = await this.reread();
      if (res.retry) {
        this.activity = "delivery hit a temporary error; retrying";
        return 15_000;
      }
    }
    // Still holding: wait here (before the lane is finished or the cargo counted as leftover).
    for (const good of [...stay.holds.keys()]) if (deliverable(good) <= 0) stay.holds.delete(good);
    if (stay.holds.size > 0) {
      // The lane's market goods are sold first: that needs the berth, the wait doesn't.
      if (this.loaded && this.lane!.dest === port && !stay.traded.has("sold")) {
        const wait = await this.sellLaneCargo(r, stay);
        if (wait !== null) return wait;
        r = await this.reread();
      }
      const until = Math.max(...[...stay.holds.values()].map((h) => h.until));
      // Wait in the roadstead: the berth isn't needed, and its lock shouldn't run up meanwhile.
      await this.park(r);
      this.activity = `holding cargo for an expansion charter's re-post at ${port}, ${secs(until - world.now())} left`;
      return Math.min(Math.max(until - world.now(), 2_000), 15_000);
    }

    // 2b. At the loaded lane's destination: sell its market goods, then the lane is done.
    if (this.loaded && this.lane!.dest === port) {
      const wait = await this.sellLaneCargo(r, stay);
      if (wait !== null) return wait;
      r = await this.reread();
      this.finishTrip();
      this.laneLoaded = null;
      this.host.releaseLane(this);
    }

    if (refusedHere) {
      // Standing by: hold nothing else back, and keep checking whether the contract has settled.
      this.host.releaseLane(this);
      await this.syncFreight();
      await this.park(r);
      this.activity = `standing by at ${port}: the freight issuer has no warehouse space (we are paid if it expires)`;
      return STAND_BY_MS;
    }

    if (atYard && (await this.refitGuns(r, stay))) {
      r = await this.reread();
      // Still to load here: plan again so the load uses the room the refit freed (or gave up).
      if (this.lane && this.lane.source === port && this.laneLoaded !== this.lane.key) this.host.releaseLane(this);
    }
    // Building needs presence, which we have only while here: give the buyer a look before leaving,
    // after this ship's own next lane is reserved so its load money is counted.
    const yardVisit = async () => {
      if (atYard && !stay.traded.has("yard")) {
        stay.traded.add("yard");
        await this.host.visitShipyard(port);
      }
    };

    // 3. Where next. A policy the user bought for this ship decides first (rule 8: it is void if she sails
    // anywhere but its port), unless sealed freight would miss its deadline by way of there; then sealed freight;
    // the AI's order only after both (and after cargo aboard).
    let order = this.host.shipOrder(this);
    // A port order is met by being here.
    if (order?.order === "port" && order.ref === port) {
      this.host.orderOutcome(this, order, "done");
      order = undefined;
    }
    const pinned = this.freightDestination(port);
    const policy = await this.insuredPolicy();
    // Whether the user insured her is unknown (the read failed with nothing to go on): nothing that could void it.
    if (policy === undefined) {
      this.activity = "reading this ship's insurance policy failed; waiting";
      return 15_000;
    }
    const insuredTo = policy && policy.dest_port_id !== port ? policy.dest_port_id : null;
    const inTime = insuredTo && pinned && pinned !== insuredTo ? await this.reachesInTime(port, insuredTo, pinned) : true;
    if (inTime === null) {
      this.activity = `insured for ${insuredTo}, sealed freight for ${pinned}: a route couldn't be read; waiting`;
      return 15_000;
    }
    const freightFirst = !inTime;
    if (insuredTo && !freightFirst) {
      // Nothing is loaded once a policy is written, by any path (cargo_exceeds_declared voids it): she sails to
      // the policy's port with what is aboard. A load for that port part-bought here is the load as it stands; any
      // other lane not loaded is dropped (a loaded lane bound elsewhere carries on from there). No sale here either:
      // it would cut the cover.
      this.settleLoad(r, stay, insuredTo);
      await yardVisit();
      this.logOnce(`insured:${policy!.id}`, `insured for a voyage to ${insuredTo}: sailing there with what is aboard, loading nothing more (the policy is void anywhere else, or if cargo is added)`);
      return this.sailTo(r, insuredTo, stay);
    }
    if (pinned) {
      const voids = freightFirst;
      if (voids) this.logOnce(`void:${policy!.id}`, `sailing to ${pinned} voids the policy on this voyage (for ${insuredTo}): the sealed freight there would miss its deadline by way of ${insuredTo}`);
      // A loaded lane keeps its cargo and charter room: it is finished at its destination later.
      if (this.lane && !this.loaded && this.lane.source !== pinned) this.host.releaseLane(this);
      await yardVisit();
      return this.sailTo(r, pinned, stay, { voidsPolicy: voids });
    }
    // Passengers aboard (from our offer for the voyage's port, or boarded by hand from the dashboard) pin the next port to theirs
    // (guide 3.20: late arrivals pay less), after sealed freight; a lane loading here for that port loads first, and a loaded lane's
    // port comes first only when they still land by their promise by way of it (a route that can't be read: theirs first).
    const paxTo = this.passengerPort(port);
    let laneFirst = false;
    if (paxTo && this.loaded && this.lane!.dest !== port && this.lane!.dest !== paxTo) {
      laneFirst = (await this.reachesBy(port, this.lane!.dest, paxTo, this.paxDue(paxTo))) === true;
      // Theirs first only while the lane's charters still make their expiry by way of their port: a charter late pays nothing,
      // a late fare is only cut per game day down to a floor (guide 3.20.6). A route that can't be read: theirs first, as above.
      if (!laneFirst) laneFirst = (await this.reachesBy(port, paxTo, this.lane!.dest, this.charterDue())) === false;
    }
    const paxPinned = !!paxTo && !laneFirst && !(this.lane && this.lane.dest === paxTo && (this.loaded || this.lane.source === port));
    const sailForPassengers = async () => {
      this.logOnce(`pax:${stay.key}:${paxTo}`, `passengers aboard for ${paxTo} (${this.paxHeads(paxTo!)} heads): sailing there next`);
      // A lane bound from their port carries on from there; a loaded one is finished at its own port later.
      if (this.lane && !this.loaded && this.lane.source !== paxTo) this.host.releaseLane(this);
      await yardVisit();
      return this.sailTo(r, paxTo!, stay);
    };
    if (paxPinned) return sailForPassengers();
    // At the source of the lane we hold: load (keeping the lane, whose charter may only be visible
    // from its own port), topping up whatever of the good is already aboard.
    if (this.lane && this.lane.source === port && this.laneLoaded !== this.lane.key && !stay.traded.has("cargo") && !this.isAvoided(this.lane.key)) {
      // The lane was planned a while ago: a charter main must still have room for most of its load.
      const main = this.lane.kind === "charter" ? this.lane.parts[0] : null;
      // The AI's directives rule out a lane nothing has been bought for (a ban, an order wanting something else): planned again below.
      const vetoed = this.laneGoodsAboard(r) === 0 && !this.lane.freight.some((f) => this.freight.has(f.id)) && this.host.laneVetoed(this, this.lane);
      if (!vetoed && (!main || this.liveTons(main) >= Math.min(10, main.tons / 2))) {
        await yardVisit();
        return this.loadAt(await this.reread(), this.lane, stay);
      }
      this.host.releaseLane(this);
    }
    if (this.lane && this.laneLoaded === this.lane.key && this.lane.dest !== port) {
      await yardVisit();
      return this.sailTo(r, this.lane.dest, stay);
    }
    // The lane bound for the passengers' port didn't load here after all: to their port all the same.
    if (paxTo) return sailForPassengers();
    for (const good of Object.keys(r.cargo_manifest)) {
      if (this.ownTons(r, good) <= 0) continue;
      const wait = await this.handleLeftover(r, good, stay);
      if (wait !== null) return wait;
    }
    // Contraband aboard (bought by hand, or the smuggling mode's) is never offered on a market, which would refuse it
    // (guide 3.18), and new lawful work would berth her with it aboard (a berthed ship is searched more). With the smuggling
    // mode on, it takes her (nothing lawful is aboard by now): to a want, or back to a cove. Otherwise she holds it in the
    // roadstead until it is run ashore or sold at a cove by hand.
    const contraband = this.contrabandAboard(r);
    if (contraband.length) {
      const wait = await this.host.smuggleTurn(this, r, true);
      if (wait !== null) return wait;
      const what = contraband.map(([g, t]) => `${t} t ${g}`).join(", ");
      this.logOnce(
        `contraband:${port}:${what}`,
        `holding ${what} (contraband) in the roadstead at ${port}: no lawful market takes it, and the smuggling mode isn't taking her; ` +
          `${world.isCove(port) ? "a cove is never searched" : "a ship lying in port with contraband aboard may be searched (forfeit with everything aboard)"}: run it ashore where it is wanted, or sell it at a cove, from the Underworld page`,
      );
      if (this.lane && !this.loaded) this.host.releaseLane(this);
      await this.park(r);
      this.activity = `holding ${what} (contraband) at ${port}: no lawful market takes it`;
      return HOLD_WAIT_GAME_MIN * world.gameMinuteMs;
    }
    this.holds = 0;

    // Housekeeping is retiring her (guide 3.4: dead weight, broken up at a yard, listed first with ship deals on): her turn comes from
    // it before any new work (an AI order withdraws it there, and wins).
    const retiring = await this.host.retireTurn(this, r, port);
    if (retiring !== null) return retiring;

    // An AI hold: no new work; it waits in the roadstead (counted idle by the tripwire).
    if (order?.order === "hold") {
      if (this.lane && !this.loaded) this.host.releaseLane(this);
      await yardVisit();
      await this.park(r);
      this.activity = `AI order: holding in the roadstead at ${port}`;
      this.host.orderOutcome(this, order, "active");
      return IDLE_WAIT_MS;
    }

    let lane = await this.host.assignLane(this, port, r);
    // Guns suit a lane: refit for the new one while still at the yard, then size the load to the new room.
    if (lane && atYard && (await this.refitGuns(r, stay))) {
      r = await this.reread();
      lane = await this.host.assignLane(this, port, r);
    }
    await yardVisit();
    if (!lane) {
      // An AI port order with nothing paying from there: sail there empty (presence at a yard, say) over a rated
      // route no ban rules out; sailTo still sees to the policy guard, stores and convoys.
      if (order?.order === "port") {
        const plan = await world.route(port, order.ref, this.shipClass).catch((e) => {
          soft(e);
          return null;
        });
        if (!plan || !world.routeRated(plan, world.shipClass(this.shipClass)?.hull_category ?? "coastal") || this.host.offLimits(order.ref, plan)) {
          this.host.orderOutcome(this, order, "refused", "route");
        } else {
          this.host.orderOutcome(this, order, "active", "repositioning");
          await this.takeFreight(r, order.ref, stay);
          return this.sailTo(await this.reread(), order.ref, stay);
        }
      }
      this.activity = "no lane pays right now; waiting";
      await this.park(r);
      return IDLE_WAIT_MS;
    }
    if (lane.source === port) {
      // Planned here with the cash there is now: no need to size it again before buying.
      this.sizedAt = { stay: stay.key, at: Date.now() };
      return this.loadAt(await this.reread(), lane, stay);
    }
    await this.takeFreight(r, lane.source, stay);
    return this.sailTo(await this.reread(), lane.source, stay);
  }

  private async reread(): Promise<ShipResult> {
    this.last = await this.host.client.ship(this.shipId);
    return this.last;
  }

  // ── The Free Trade (guide 3.18): what the smuggling mode asks of her ───────

  /**
   * Contraband aboard in an ordinary port: no berth, stores, trade, refit or freight there (a ship lying in port with it may be
   * searched, berthed more than in the roadstead; guide 3.18). Logged once per port and what was refused. A cove never bars.
   */
  private contrabandBarred(r: ShipResult, what: string): boolean {
    const port = r.ship.current_port_id;
    if (!port || this.host.world.isCove(port)) return false;
    const aboard = this.contrabandAboard(r);
    if (aboard.length === 0) return false;
    this.logOnce(
      `barred:${port}:${what}`,
      `not ${what} at ${port}: ${aboard.map(([g, t]) => `${t} t ${g}`).join(", ")} (contraband) aboard, and a ship lying in an ordinary port with it may be searched (berthed more than in the roadstead): roadstead only`,
    );
    return true;
  }

  /** What she is doing, for the dashboard (the smuggling mode's turn says). */
  setActivity(text: string): void {
    this.activity = text;
  }

  /** Reads her afresh. */
  refresh(): Promise<ShipResult> {
    return this.reread();
  }

  /**
   * Off the berth as soon as the lock lets her (contraband aboard in an ordinary port): a wait while the lock holds her, else
   * null (she lies in the roadstead, moved there now if she was berthed).
   */
  async smugglerLeaveBerth(r: ShipResult): Promise<number | null> {
    if (r.ship.status !== "berthed") return null;
    if (this.locked(r)) {
      const wait = Date.parse(r.ship.turnaround_unlocks_at!) - this.host.world.now();
      this.logOnce(`berthed:${this.stay?.key ?? ""}`, `berthed on arrival at ${r.ship.current_port_id} (a free berth takes an arriving ship) with contraband aboard: to the roadstead as soon as the lock lets her`);
      this.activity = `berthed with contraband aboard: to the roadstead in ${secs(wait)}`;
      return Math.max(1_000, wait + 750);
    }
    await this.park(r);
    return (await this.reread()).ship.status === "berthed" ? 5_000 : null;
  }

  /** In the roadstead (free of dues; from a berth only once the lock has passed). */
  async smugglerPark(r: ShipResult): Promise<void> {
    await this.park(r);
  }

  /** At a cove (never searched): to a berth, to stock stores there. A wait. */
  async smugglerDock(r: ShipResult): Promise<number> {
    return this.dockOrWait(r);
  }

  /** The stores a passage needs to be safe: the route's figure, or more if a departure last warned so. */
  safeStoresFor(from: string, to: string, plan: RoutePlan): number {
    return this.safeStores(from, to, plan);
  }

  /**
   * Berthed at a cove: buys whole tons of stores up to `want` (a run may not stock up anywhere else with contraband aboard;
   * the smuggling mode's own look-again interval paces a retry when the cove had too little). Returns the tons bought.
   */
  async smugglerStores(r: ShipResult, want: number): Promise<number> {
    const stay = this.stay;
    if (!stay) return 0;
    const n = storesTons(r.stores.provisions_tons, want);
    if (n <= 0) return 0;
    return this.buyStores(r, stay, n);
  }

  /**
   * Empty (nothing contraband aboard): to a cove for the smuggling mode as any ship sails (stores bought as usual, never in a
   * convoy: the convoy check leaves smugglers out). A wait.
   */
  async sailForCove(r: ShipResult, cove: string): Promise<number> {
    const stay = this.stay;
    if (!stay) return POLL_MS;
    return this.sailTo(r, cove, stay);
  }

  /**
   * Sails for `dest` alone with contraband aboard, on the plan the smuggling mode checked (hull, patrols): never in a convoy
   * (its consorts would share the search), stores as they are (bought at the cove; never in an ordinary port). A wait.
   */
  async smugglerDepart(r: ShipResult, dest: string, plan: RoutePlan): Promise<number> {
    const { client, world } = this.host;
    const port = r.ship.current_port_id ?? "?";
    if (this.locked(r)) {
      const wait = Date.parse(r.ship.turnaround_unlocks_at!) - world.now();
      this.activity = `berth lock: leaving for ${dest} in ${secs(wait)}`;
      return wait + 750;
    }
    try {
      const res = await client.depart({ ship_id: this.shipId, dest_port_id: dest });
      this.noteDues(port, res.berth_dues_pence);
      for (const w of res.warnings) {
        if (w.code === "stores_below_safe") {
          world.noteSafeStores(port, dest, this.shipClass, w.safe_tons);
          world.forgetRoute(port, dest, this.shipClass);
        }
        this.log(`depart warning ${w.code}: ${w.detail}`);
      }
      const eta = Date.parse(res.estimated_arrival_at);
      const what = this.contrabandAboard(r).map(([g, t]) => `${t} t ${g}`).join(", ");
      this.log(`sailing ${port} → ${dest}${what ? ` with ${what} (contraband)` : ""}, arrives in ${secs(eta - world.now())}`);
      const sailed = res.route_legs ?? [];
      if (sailed.length && (sailed.length !== plan.legs.length || sailed.some((l, i) => l.to_node !== plan.legs[i].to_node))) {
        world.forgetRoute(port, dest, this.shipClass);
        this.log(`WARNING: the server sailed ${port} → ${dest} by another route than the one checked for patrols: ${sailed.map((l) => l.to_node).join(" → ")}`);
      }
      this.activity = `sailing to ${dest}`;
      this.stay = null;
      this.last = {
        ...r,
        ship: { ...r.ship, status: "sailing", current_port_id: null, leg_arrives_at: res.estimated_arrival_at },
        route_legs: res.route_legs ?? r.route_legs,
        voyage: null,
      };
      return Math.min(Math.max(eta - world.now() + 1_500, 2_000), MAX_SAIL_SLEEP_MS);
    } catch (e) {
      soft(e);
      if (isApiError(e, "conflict")) {
        const m = /for (\d+)s more/.exec(e.detail);
        this.activity = `depart refused: ${e.detail}`;
        if (m) return (Number(m[1]) + 1) * 1_000;
        if (ARREST_RE.test(e.detail)) {
          this.noteArrest(e.detail);
          return 1_000;
        }
        this.logOnce(`smuggle-depart:${port}>${dest}`, `depart to ${dest} refused: ${e.detail}`);
        return 30_000;
      }
      if (isApiError(e, "insufficient_provisions")) {
        world.forgetRoute(port, dest, this.shipClass);
        const short = (e.body as { provisions_shortfall?: { buy_provisions_tons?: number } }).provisions_shortfall;
        world.noteSafeStores(port, dest, this.shipClass, r.stores.provisions_tons + (short?.buy_provisions_tons ?? 1));
        this.log(`depart to ${dest} refused, stores short: ${e.detail}`);
        return 30_000;
      }
      throw e;
    }
  }

  /**
   * Seized by the Crown for smuggling (guide 3.18: the ship and everything aboard forfeit, as if she sank; the conviction
   * on our public credit record): she leaves the fleet now.
   */
  noteSeized(why: string): void {
    if (this.gone) return;
    this.leaveFleet(why);
    this.wake?.();
  }

  private locked(r: ShipResult): boolean {
    const u = r.ship.turnaround_unlocks_at;
    return r.ship.status === "berthed" && !!u && Date.parse(u) > this.host.world.now();
  }

  /** Berth dues settle as the ship leaves the berth (guide 3.3), from the port's vault; what it can't cover goes there as debt. */
  noteDues(port: string, pence: number | null | undefined): void {
    if (!(pence && pence > 0)) return;
    const { world } = this.host;
    const region = world.region(port);
    world.vaults.set(region, world.vault(region) - pence);
    this.stats.spentPence += pence;
    if (this.trip) this.trip.spent += pence;
  }

  /** To the roadstead (every move off the berth goes through here, so its dues are booked). */
  private async offshore(port: string): Promise<void> {
    this.noteDues(port, (await this.host.client.offshore(this.shipId)).berth_dues_pence);
  }

  /**
   * Waits in the roadstead rather than at the berth (no lock or dues running up), when berthed and the lock
   * has passed. Best effort, but a fatal error or a paused world is never swallowed.
   */
  private async park(r: ShipResult): Promise<void> {
    const port = r.ship.current_port_id;
    // Waiting, not sailing: no passengers board for a voyage she isn't making now (posted again, from where she lies, when she is).
    this.dropOffers("waiting here, not sailing yet");
    if (r.ship.status !== "berthed" || !port || this.locked(r)) return;
    try {
      await this.offshore(port);
    } catch (e) {
      soft(e);
      // Lock not quite clear on the server's clock (or the ship moved on): it waits at the berth this time.
    }
  }

  /** Logs once per `key`, so a ship waiting on the same thing doesn't fill the log. */
  private logOnce(key: string, msg: string): void {
    if (this.noted.has(key)) return;
    this.noted.add(key);
    if (this.noted.size > 200) this.noted.delete(this.noted.values().next().value!);
    this.log(msg);
  }

  /**
   * The policy on this ship the user bought (the autopilot never buys one), open or active and not lapsed,
   * read at most every `maxAgeMs`. A failed read keeps the last; with none to keep (never read, or an insurance
   * event since: forgetPolicy) it is unknown (undefined), and callers take the safe side (wait, don't sell).
   */
  async insuredPolicy(maxAgeMs = POLICY_TTL_MS, strict = false): Promise<InsurancePolicy | null | undefined> {
    if (this.policy && Date.now() - this.policy.at < maxAgeMs) return this.policy.p;
    try {
      const list = await this.host.client.policies({ ship_id: this.shipId, limit: 10 });
      const now = this.host.world.now();
      // Newest first.
      const p = list.find((x) => x.ship_id === this.shipId && (x.status === "open" || x.status === "active") && !(Date.parse(x.expires_at) <= now)) ?? null;
      this.policy = { p, at: Date.now() };
    } catch (e) {
      soft(e);
      // `strict`: a failed read is unknown, never the last one kept.
      if (strict) return undefined;
    }
    return this.policy ? this.policy.p : undefined;
  }

  /** An insurance event: read the policy again at the next decision (unknown until that read succeeds). */
  forgetPolicy(): void {
    this.policy = null;
  }

  /**
   * Cargo loaded after a policy is written voids it (`cargo_exceeds_declared`, guide 3.6): read afresh before
   * each purchase or freight lot, true when a policy is on her now (or that can't be told), so nothing more
   * is loaded. The user may insure her at any moment from the dashboard.
   */
  private async policyNow(): Promise<InsurancePolicy | null | undefined> {
    const p = await this.insuredPolicy(0, true);
    // One for the voyage that ends here settles on arrival: it doesn't bind the next load.
    if (p && p.dest_port_id === this.stay?.port) return null;
    if (p) this.logOnce(`declared:${p.id}`, `insured for ${p.dest_port_id}: loading nothing more (cargo added after the policy is written voids it)`);
    return p;
  }

  /**
   * No more cargo this stay (a policy is on her): a lane for `dest` part-loaded at this source is the load as it
   * stands (its trip kept, its sell floors set, finished where it lands); any other lane not loaded yet is dropped
   * (one loaded elsewhere carries on), what it bought here aboard keeping a floor at its cost.
   */
  private settleLoad(r: ShipResult, stay: Stay, dest: string | null): void {
    stay.traded.add("cargo");
    const lane = this.lane;
    if (!lane || this.loaded) return;
    const aboard = this.laneGoodsAboard(r, lane) > 0 || lane.freight.some((f) => this.freight.has(f.id));
    const bought = aboard && lane.source === stay.port;
    const kept = bought && (dest === null || lane.dest === dest);
    // Sell floors first, for what was bought here: bound elsewhere than the lane's port (it is dropped), the part aboard
    // still never sells under what it cost.
    if (bought) {
      for (const p of lane.parts) {
        const floor = Math.max(p.costPerTon, kept && p.kind === "market" ? Math.round(p.pay * (1 - SELL_FLOOR_DROP)) : 0);
        if (floor > 0 && this.ownTons(r, p.good) > 0) this.minSale.set(p.good, Math.max(this.minSale.get(p.good) ?? 0, floor));
      }
    }
    if (!kept) {
      this.host.releaseLane(this);
      if (bought) this.host.persist(true);
      return;
    }
    this.laneLoaded = lane.key;
    this.host.persist(true);
  }

  /** A policy came up while loading (or its read failed): nothing more goes aboard; the next decision sails for its port. */
  private async stopLoading(stay: Stay, p: InsurancePolicy | undefined): Promise<number> {
    if (!p) {
      this.activity = "reading this ship's insurance policy failed; not loading yet";
      return 15_000;
    }
    this.settleLoad(await this.reread(), stay, p.dest_port_id);
    this.activity = `insured for ${p.dest_port_id}: loading nothing more`;
    return 1_000;
  }

  /**
   * Selling at the port a policy on this ship was written at cuts its cover to what is left aboard
   * (guide 3.4): there the cargo rides to the policy's port instead. True when a sale here must wait
   * (the policy unknown too).
   */
  private async coverCut(port: string): Promise<boolean> {
    const p = await this.insuredPolicy();
    if (p === undefined) return true;
    if (!p || p.origin_port_id !== port) return false;
    this.logOnce(`sell:${p.id}`, `WARNING: not selling at ${port}: a sale cuts the cover of the policy on this ship; the cargo rides to ${p.dest_port_id}`);
    return true;
  }

  /**
   * Whether the sealed freight bound for `to` still makes its deadline sailing by way of `via` first (over rated
   * water). Null: a route couldn't be read (unknown: decided next tick, nothing voided on a transient error).
   */
  private async reachesInTime(from: string, via: string, to: string): Promise<boolean | null> {
    const dues = [...this.freight.values()].filter((f) => f.dest === to && !f.undeliverable && f.deadline).map((f) => Date.parse(f.deadline!));
    return this.reachesBy(from, via, to, Math.min(...dues.filter((t) => Number.isFinite(t))));
  }

  /**
   * Whether sailing `from` → `via` → `to` (over rated water from `via`) lands at `to` by server time `due` (not finite: nothing
   * is due, true). Null: a route couldn't be read.
   */
  private async reachesBy(from: string, via: string, to: string, due: number): Promise<boolean | null> {
    const { world } = this.host;
    if (!Number.isFinite(due)) return true;
    const cls = world.shipClass(this.shipClass);
    const knots = ((cls?.base_speed_centiknots ?? 800) / 100) * 0.8;
    let a: RoutePlan, b: RoutePlan;
    try {
      [a, b] = await Promise.all([world.route(from, via, this.shipClass), world.route(via, to, this.shipClass)]);
    } catch (e) {
      soft(e);
      return null;
    }
    if (!world.routeRated(b, cls?.hull_category ?? "coastal")) return false;
    // A base lock at each port on the way, and a few minutes' slack.
    return world.now() + world.sailMs(a.total_distance_nm + b.total_distance_nm, knots) + 60 * world.gameMinuteMs + 5 * 60_000 <= due;
  }

  /** Stores for one passage as this ship sails it alone (FleetManager.convoyStores stretches it to a convoy's pace). */
  passageStores(plan: RoutePlan): number {
    return Math.max(this.storesFor(plan), this.safeStores(plan.from_port, plan.to_port, plan));
  }

  /**
   * Left a convoy short of the stores its pace needs (FleetManager.convoyWait): one top-up to `tons` at the
   * berth before joining again, once a stay. False when that was had already (it sails alone then).
   */
  convoyTopUp(tons: number): boolean {
    const s = this.stay;
    if (!s || s.convoyTopped) return false;
    s.convoyTopped = true;
    s.convoyNeed = tons;
    return true;
  }

  /** Hold tons that topping stores up to `target` will take (stores come in whole tons). */
  private storesHoldNeed(have: number, target: number): number {
    if (have >= target) return 0;
    const tons = Math.max(1, Math.ceil(target - have));
    return Math.ceil(have + tons) - Math.ceil(have);
  }

  /** Reads the book and the coffee-house gossip once per stay, feeding the planner's prices. */
  private async scout(port: string): Promise<void> {
    const { client, world } = this.host;
    const [book, detail] = await Promise.allSettled([client.book(port), client.port(port)]);
    if (book.status === "fulfilled") world.observeBook(book.value);
    if (detail.status === "fulfilled") world.observeGossip(detail.value);
  }

  /**
   * Refits the guns to the manager's target while berthed at a yard, once per stay. Mounting needs
   * hold room (2 t a gun, plus a ton for stores) and 150 Cr a gun; landing guns frees the hold.
   * Returns whether the guns changed.
   */
  private async refitGuns(r: ShipResult, stay: Stay): Promise<boolean> {
    if (stay.traded.has("arm") || r.ship.status !== "berthed" || this.contrabandBarred(r, "refitting")) return false;
    // The guns were chosen for the passage this cargo makes: don't change them under it.
    if (stay.traded.has("cargo") || (this.lane && this.laneLoaded === this.lane.key) || this.laneGoodsAboard(r) > 0) return false;
    const target = await this.host.gunTarget(this, r);
    const now = r.ship.cannons_count;
    if (target === undefined || target === now) return false;
    // Cannons can't be removed while insured (guide 3.4), nor while that is unknown.
    const policy = target < now ? await this.insuredPolicy() : null;
    if (policy !== null) {
      if (policy) this.logOnce(`guns:${policy.id}`, `keeping ${now} guns: cannons can't be landed while the ship is insured`);
      return false;
    }
    const adding = Math.max(0, target - now);
    if (adding > 0 && r.effective_hold_capacity_tons - r.cargo_used_tons < 2 * adding + 1) return false;
    stay.traded.add("arm");
    const cost = adding * GUN_PRICE_PENCE;
    const region = this.host.world.region(stay.port);
    return this.host.withCash(async () => {
      if (cost > 0 && (await this.host.ensureCash(region, cost)) < cost) {
        this.log(`can't afford ${adding} guns yet`);
        return false;
      }
      try {
        await this.host.client.modifyShip(this.shipId, target);
        if (cost > 0) {
          this.host.world.vaults.set(region, this.host.world.vault(region) - cost);
          this.host.noteArmed(this.shipId, cost);
          this.log(`mounted ${adding} gun${adding === 1 ? "" : "s"} for this lane's pirates: now ${target}`);
        } else {
          this.log(`landed ${now - target} gun${now - target === 1 ? "" : "s"} for ${2 * (now - target)} t more cargo room: now ${target}`);
        }
        return true;
      } catch (e) {
        soft(e);
        if (!isApiError(e) || e.status >= 500) throw e;
        this.log(`refit to ${target} guns refused: ${e.message}`);
        return false;
      }
    });
  }

  // ── Loading ─────────────────────────────────────────────────────────────────

  private async loadAt(r: ShipResult, lane: Lane, stay: Stay): Promise<number> {
    if (stay.traded.has("cargo")) return this.sailTo(r, lane.dest, stay);
    // The voyage is now this lane's from here (a re-plan may have swapped it while she lay waiting to sail elsewhere): our offers for
    // any other port go before the loading tick or the berth queue gives a round to groups that would take the hold sized for it.
    this.dropOffers(`loading here for ${lane.dest}`, lane.dest);
    const { world } = this.host;
    // Nothing is loaded with contraband aboard in an ordinary port (guide 3.18: berth trades, searched there): the lane goes.
    if (this.contrabandBarred(r, "loading")) {
      if (!this.loaded) this.host.releaseLane(this);
      await this.park(r);
      this.activity = `contraband aboard: not loading at ${stay.port}`;
      return CONTRABAND_WAIT_MS;
    }
    // Insured since the plan (the user, from the dashboard): nothing goes aboard after a policy is written.
    const insured = await this.policyNow();
    if (insured !== null) return this.stopLoading(stay, insured);
    if (r.ship.status !== "berthed") {
      // Docking costs a berth stay: only when at least a ton (or the freight's collateral) can be paid for;
      // for a load counting on cash due, the main cargo buyPart would sail with (the rest waits in the roadstead).
      const main = lane.parts[0];
      const tons = main && this.waitsForDue(r, lane) ? Math.min(main.tons, Math.max(1, Math.ceil(this.leastMainTons(r, lane)))) : 1;
      const need = Math.max((main?.costPerTon ?? 0) * tons, lane.freight[0]?.collateral ?? 0, 1);
      if ((await this.host.withCash(() => this.host.loadBudget(this, world.region(lane.source), need))) < need) {
        this.host.releaseLane(this);
        this.activity = "waiting for cash to buy a load";
        return NO_CASH_WAIT_MS;
      }
      return this.dockOrWait(r);
    }

    // Planned elsewhere (or a while ago) on the cash there was then: plan it again from here before buying
    // any of it, bigger if deliveries paid meanwhile, smaller if the cash went to other loads.
    const fresh = this.sizedAt?.stay === stay.key && Date.now() - this.sizedAt.at < RESIZE_FRESH_MS;
    const untouched = this.laneGoodsAboard(r, lane) === 0 && !lane.freight.some((f) => this.freight.has(f.id));
    if (!fresh && untouched) {
      this.sizedAt = { stay: stay.key, at: Date.now() };
      // Never insured here (checked just above): an insured ship loads nothing.
      lane = (await this.host.resizeLane(this, stay.port, r)) ?? lane;
    }
    // Season end (guide 3.11): a load that can't land before it isn't bought (the planner's lanes all can; one
    // kept as planned when re-sizing found nothing may not).
    if (untouched && lane.deliverAt > 0 && !world.beforeSeasonEnd(lane.deliverAt)) {
      this.log(`not loading ${lane.key}: it would land after the season ends`);
      this.host.releaseLane(this);
      this.avoid.set(lane.key, world.now() + LANE_COOLDOWN_MS * (60 / world.timeScale));
      this.activity = "re-planning: the load would land after the season ends";
      return 3_000;
    }
    const trimmed = await this.trimStores(r, lane, stay);
    // Stores for the passage and the way back, bought once this stay (rule 7: never again on a depart retry).
    if (!stay.storesBought) {
      const cur = await this.reread();
      await this.buyStores(cur, stay, storesTons(cur.stores.provisions_tons, await this.storesTarget(lane.source, lane.dest, lane.source)));
    }
    r = await this.reread();

    // The main cargo first: without it the lane is off. Each purchase and lot reads the policy afresh first: one
    // written meanwhile stops the loading where it stands (stopLoading).
    const extras = lane.kind === "freight" ? lane.parts : lane.parts.slice(1);
    if (lane.kind === "freight") {
      const got = await this.acceptLaneFreight(r, lane, stay);
      if (got.stop) return this.stopLoading(stay, got.stop.p);
      if (got.taken === 0) {
        this.host.releaseLane(this);
        if (got.cashShort) {
          this.activity = "waiting for cash for freight collateral";
          // In the roadstead: the berth's lock and dues don't run on meanwhile.
          await this.park(await this.reread());
          return NO_CASH_WAIT_MS;
        }
        this.avoid.set(lane.key, world.now() + LANE_COOLDOWN_MS * (60 / world.timeScale));
        this.activity = "re-planning: the freight lots were taken or don't fit";
        return 3_000;
      }
    } else {
      const main = lane.parts[0];
      const res = await this.buyPart(r, lane, main, stay);
      if (res.stop) return this.stopLoading(stay, res.stop.p);
      // Bought on an earlier tick of this stay (a later step failed): carry on loading. Surplus stores trimStores just
      // moved into cargo for a provisions charter count there too, but weren't bought.
      if (res.bought === 0 && (stay.boughtHere.get(main.good) ?? 0) - (main.good === STORES_GOOD ? trimmed : 0) === 0) {
        // Put surplus stores moved into cargo back: they were only worth carrying with a load.
        if (trimmed > 0) {
          await this.host.client.provision(this.shipId, trimmed, "cargo").catch(soft);
          stay.boughtHere.set(STORES_GOOD, Math.max(0, (stay.boughtHere.get(STORES_GOOD) ?? 0) - trimmed));
        }
        this.host.releaseLane(this);
        if (res.reason === "cash") {
          this.activity = "waiting for cash to buy a load";
          await this.park(r);
          return NO_CASH_WAIT_MS;
        }
        // Our own companies' asks are left out of the book now: the re-plan sees the ask we can fill, no cooldown needed.
        if (!res.self) this.avoid.set(lane.key, world.now() + LANE_COOLDOWN_MS * (60 / world.timeScale));
        this.activity = `re-planning: ${res.reason}`;
        return 3_000;
      }
    }
    // Then the rest of the load: other goods, and freight lots for the same destination.
    for (const p of extras) {
      const res = await this.buyPart(await this.reread(), lane, p, stay);
      if (res.stop) return this.stopLoading(stay, res.stop.p);
    }
    // Never sell any of it for less than it cost to land (or, for market goods, the planned floor).
    for (const p of lane.parts) {
      const floor = Math.max(p.costPerTon, p.kind === "market" ? Math.round(p.pay * (1 - SELL_FLOOR_DROP)) : 0);
      if (floor > 0) this.minSale.set(p.good, Math.max(this.minSale.get(p.good) ?? 0, floor));
    }
    if (lane.kind !== "freight" && lane.freight.length > 0) {
      const got = await this.acceptLaneFreight(await this.reread(), lane, stay);
      if (got.stop) return this.stopLoading(stay, got.stop.p);
    }
    stay.traded.add("cargo");
    this.laneLoaded = lane.key;
    // An AI lane or charter order is met once its load is aboard.
    const order = this.host.shipOrder(this);
    if (order && (order.order === "lane" ? order.ref === lane.key : order.order === "charter" && lane.fills.some(([id]) => world.currentId(id) === world.currentId(order.ref)))) {
      this.host.orderOutcome(this, order, "done");
    }
    this.host.persist(true);
    // Any room still free: freight bound the same way, if it pays for its berth time.
    await this.takeFreight(await this.reread(), lane.dest, stay);
    return this.sailTo(await this.reread(), lane.dest, stay);
  }

  /** Tons of a charter part its charters still have room for (all of a market part). */
  private liveTons(part: Part): number {
    if (part.kind !== "charter") return part.tons;
    const now = this.host.world.now();
    const { world } = this.host;
    return part.fills.reduce((n, [id, t]) => {
      // The posting that now stands for it; an expansion posting that lapsed is re-posted.
      const cur = world.currentId(id);
      const c = world.charters.find((x) => x.id === cur && x.remaining > 0 && (x.expiresAt === null || x.expiresAt > now || world.renews(x)));
      return n + (c ? Math.min(t, c.remaining) : 0);
    }, 0);
  }

  /**
   * Buys one good of the lane's load, up to its break-even price and the room left for it. `self`: nothing
   * filled because the asks under the limit were our own other companies' (they never match ours, guide 3.2).
   */
  private async buyPart(
    r: ShipResult,
    lane: Lane,
    part: Part,
    stay: Stay,
  ): Promise<{ bought: number; reason: string; self?: boolean; stop?: { p: InsurancePolicy | undefined } }> {
    const { client, world, settings } = this.host;
    const port = lane.source;
    const good = part.good;
    const want = Math.min(part.tons, this.liveTons(part)) - this.ownTons(r, good);
    if (want < 1) return { bought: 0, reason: `no room left in the ${good} charters` };
    // Cargo bought after a policy is written voids it: read afresh before every purchase.
    const policy = await this.policyNow();
    if (policy !== null) return { bought: 0, reason: "insured", stop: { p: policy } };
    // Room for the cargo after the whole tons of stores the voyage still needs.
    const storesTarget = await this.storesTarget(lane.source, lane.dest, lane.source);
    const storesRoom = this.storesHoldNeed(r.stores.provisions_tons, storesTarget);
    return this.host.withCash(async () => {
      const book = await client.book(port, good);
      world.observeBook(book);
      const b = book.books.find((x) => x.commodity_id === good);
      // A royal monopoly another company holds in this region (guide 3.9): the Crown's asks aren't ours to take,
      // only players' resting asks (the holder's among them).
      const barred = world.monopolyBars(port, good);
      if (barred && !b?.depth) return { bought: 0, reason: `${good} at ${port} is under a royal monopoly (${barred.holder})` };
      // Our own other companies' resting asks can't fill our bids: left out once found (World.noteUnfillable).
      const depthAsks = (b?.depth?.asks ?? []).filter((l) => !barred || !l.is_npc);
      const fillable = depthAsks.filter((l) => !world.isUnfillable(port, good, l.order_id));
      const bestAsk = fillable.length ? Math.min(...fillable.map((l) => l.price_pence)) : depthAsks.length || barred ? null : (b?.best_ask?.price_pence ?? null);
      if (bestAsk === null) {
        if (depthAsks.length > 0) return { bought: 0, reason: `only our own companies' ${good} is on offer at ${port}`, self: true };
        if (barred) return { bought: 0, reason: `${good} at ${port} is under a royal monopoly (${barred.holder}) and no player offers it` };
        world.observeNoAsk(port, good, b?.best_bid ?? null);
        return { bought: 0, reason: `no ${good} on offer at ${port}` };
      }

      const customs = 1 + book.customs_bps / 10_000;
      const fee = 1 + world.remitBps(world.region(lane.dest), world.region(port)) / 10_000;
      // Every ton must clear the margin against the lowest-value use in this part, after the share
      // pirates and storms are expected to take; and the phase bonus may pick a charter, but never pay
      // more than its cash covers (the bonus is paid later, and only if the tier completes).
      const kept = (1 - (lane.piracyBps ?? 0) / 10_000) * (1 - (lane.stormBps ?? 0) / 10_000);
      const limit = Math.floor(Math.min((part.minPay - settings.minMarginPence) * kept, part.cashPay * kept) / (customs * fee));
      if (bestAsk > limit) {
        this.log(`${good} at ${port} asks ${cr(bestAsk)}/t, above the ${cr(limit)}/t break-even for ${lane.dest}`);
        return { bought: 0, reason: `${good} too dear at ${port}` };
      }
      let room = Math.min(r.effective_hold_capacity_tons - r.cargo_used_tons - storesRoom, want);
      if (room <= 0) return { bought: 0, reason: "no room" };

      // Price `n` tons by walking the visible ask ladder up to the limit (beyond it: at the limit).
      const asks: OrderBookLevel[] = fillable.filter((l) => l.price_pence <= limit).sort((x, y) => x.price_pence - y.price_pence);
      // Under a monopoly only the players' asks under the limit can fill (a bid past them would be refused).
      if (barred) room = Math.min(room, Math.floor(asks.reduce((n, l) => n + l.remaining_quantity, 0)));
      if (room <= 0) return { bought: 0, reason: `${good} at ${port} is under a royal monopoly (${barred!.holder}): players offer none under the limit` };
      const costFor = (n: number) => {
        let left = n;
        let cost = 0;
        for (const l of asks) {
          const take = Math.min(left, l.remaining_quantity);
          cost += take * l.price_pence;
          left -= take;
          if (left <= 0) break;
        }
        return Math.ceil((cost + Math.max(0, left) * limit) * customs);
      };
      // Never the cash our other ships' loads count on (FleetManager.loadBudget).
      const cash = await this.host.loadBudget(this, world.region(port), costFor(room));
      let qty = room;
      while (qty > 0 && costFor(qty) > cash) qty--;
      // Cash due it counted on not here yet, and too little without it for a load worth the leg: wait for it rather than sail a sliver.
      if (qty > 0 && qty < room && part === lane.parts[0] && this.waitsForDue(r, lane) && qty < this.leastMainTons(r, lane)) {
        this.log(`cash covers only ${qty} of ${room} t ${good} (${cr(cash)} spare for this load): too little to sail; waiting for cash`);
        return { bought: 0, reason: "cash" };
      }
      if (qty > 0 && qty < room) this.log(`cash covers ${qty} of ${room} t ${good} (${cr(cash)} spare for this load)`);
      if (qty <= 0) {
        this.log(`not enough cash in ${world.region(port)} for ${good} at ${port}`);
        return { bought: 0, reason: "cash" };
      }

      try {
        const use = part.kind === "market" ? `sells ~${cr(part.pay)}/t at ${lane.dest}` : `pays ${cr(part.pay)}/t at ${lane.dest}`;
        this.log(`bid ${qty} t ${good} at ${port} ≤ ${cr(limit)}/t (ask ${cr(bestAsk)}, ${use})`);
        const res = await client.placeOrder({
          port_id: port,
          commodity_id: good,
          side: "bid",
          time_in_force: "ioc",
          price_pence: limit,
          quantity: qty,
          ship_id: this.shipId,
        });
        const paid = res.total_gross_pence + res.customs_duty_pence;
        this.noteLaneSpend(lane, paid);
        this.stats.spentPence += paid;
        world.vaults.set(world.region(port), world.vault(world.region(port)) - paid);
        stay.boughtHere.set(good, (stay.boughtHere.get(good) ?? 0) + res.filled_quantity);
        if (res.filled_quantity > 0) {
          const trip = this.ensureTrip(r, lane);
          trip.spent += paid;
          trip.tons += res.filled_quantity;
        }
        this.log(`bought ${res.filled_quantity}/${qty} t for ${cr(paid)} (${cr(res.filled_quantity ? paid / res.filled_quantity : 0)}/t landed)`);
        let self = false;
        if (res.filled_quantity < qty && asks.some((l) => !l.is_npc)) {
          // Orders never match our own other companies (guide 3.2): a player's ask under our limit still there
          // untouched after our bid crossed it is one of theirs.
          const after = await client.book(port, good).catch((e: unknown) => {
            soft(e);
            return null;
          });
          const left = after?.books.find((x) => x.commodity_id === good)?.depth?.asks ?? [];
          const ours = asks.filter((l) => !l.is_npc && left.some((x) => x.order_id === l.order_id && x.remaining_quantity === l.remaining_quantity)).map((l) => l.order_id);
          if (ours.length) {
            world.noteUnfillable(port, good, ours);
            this.log(`${ours.length} ask${ours.length === 1 ? "" : "s"} for ${good} at ${port} can't fill our bids (our own companies'): left out from now on`);
          }
          if (after) world.observeBook(after);
          self = res.filled_quantity === 0 && ours.length > 0;
        }
        return { bought: res.filled_quantity, reason: res.filled_quantity ? "ok" : self ? `only our own companies' ${good} was under the limit at ${port}` : "nothing filled", self };
      } catch (e) {
        if (isApiError(e) && e.status === 400) {
          this.log(`buy refused: ${e.message}`);
          return { bought: 0, reason: "refused" };
        }
        // A royal monopoly kept the bid from filling (409 naming the holder): noted, so plans leave the Crown's asks
        // here alone; the lane is re-planned around it (never a failed tick every 30 s until the grant expires).
        if (isApiError(e) && e.status === 409 && (!!barred || /monopol/i.test(`${e.detail} ${e.message}`))) {
          world.noteMonopoly(port, good, e.detail || e.message);
          this.log(`buying ${good} at ${port} refused: a royal monopoly (${e.detail || e.message}); planning around it`);
          return { bought: 0, reason: `${good} at ${port} is under a royal monopoly` };
        }
        throw e;
      }
    });
  }

  /**
   * Accepts the lane's freight lots that are still open and fit, keeping room for the stores the
   * voyage needs (sealed freight can't be eaten or sold to make room). Returns how many were taken,
   * and whether collateral money was what ran short.
   */
  private async acceptLaneFreight(r: ShipResult, lane: Lane, stay: Stay): Promise<{ taken: number; cashShort: boolean; stop?: { p: InsurancePolicy | undefined } }> {
    const port = stay.port;
    const need = await this.storesTarget(port, lane.dest, lane.source);
    let room = r.effective_hold_capacity_tons - r.cargo_used_tons - this.storesHoldNeed(r.stores.provisions_tons, need);
    let taken = 0;
    let cashShort = false;
    for (const f of lane.freight) {
      if (this.freight.has(f.id) || f.tons > room) continue;
      // Return freight refused for our companies' cap since the lane was planned: left (the lane carries on without it).
      if (f.ret && this.host.world.returnBlocked()) continue;
      const res = await this.acceptFreightLot(port, f.id, f.collateral, r, lane, !!f.ret);
      if (typeof res === "object") return { taken, cashShort, stop: { p: res.insured } };
      if (res === "taken") {
        taken++;
        room -= f.tons;
      } else if (res === "cash") cashShort = true;
    }
    return { taken, cashShort };
  }

  /**
   * Accepts one freight lot onto this ship (collateral from the port's region). Never once a policy is on her
   * (read afresh: freight loaded after it is written voids it); `insured` then says which (undefined: unknown).
   * `ret`: return freight (guide 3.8), kept flagged aboard; a 409 on it is our companies' cap on return lots (unless it
   * says the lot is gone), so none is planned or taken fleet-wide for a while instead of dropping lots one by one.
   */
  private async acceptFreightLot(
    port: string,
    id: string,
    collateral: number,
    r: ShipResult,
    lane: Lane | null,
    ret = false,
  ): Promise<"taken" | "cash" | "no" | { insured: InsurancePolicy | undefined }> {
    const { client, world } = this.host;
    const policy = await this.policyNow();
    if (policy !== null) return { insured: policy };
    return this.host.withCash(async () => {
      const cash = await this.host.loadBudget(this, world.region(port), collateral);
      if (cash < collateral) return "cash";
      try {
        const res = await client.acceptFreight(id, this.shipId);
        this.freight.set(id, {
          dest: res.dest_port_id,
          good: res.commodity_id,
          tons: res.quantity,
          reward: res.reward_pence,
          deadline: res.delivery_deadline,
          collateral: res.collateral_pence,
          origin: res.origin_port_id || port,
          ...(ret ? { ret: true } : {}),
        });
        world.dropFreight(id);
        world.vaults.set(world.region(port), world.vault(world.region(port)) - res.collateral_pence);
        if (lane && res.dest_port_id === lane.dest) {
          this.noteLaneSpend(lane, res.collateral_pence);
          const trip = this.ensureTrip(r, lane);
          trip.freightIds.add(id);
          trip.tons += res.quantity;
        }
        this.log(
          `took ${ret ? "return freight (the Crown's)" : "freight"}: ${res.quantity} t ${res.commodity_id} ${port} → ${res.dest_port_id} for ${cr(res.reward_pence)} (collateral ${cr(res.collateral_pence)})` +
            `${ret ? "; sealed and worth nothing aboard, only the collateral and the reward ride on the hull" : ""}`,
        );
        return "taken";
      } catch (e) {
        soft(e);
        if (outcomeUnknown(e)) {
          // The server may have bound it to us. Re-sync before going on.
          this.freightSynced = false;
          throw e;
        }
        // Rate limited (nothing ran): the lot is still there for a later tick.
        if (isApiError(e) && e.status === 429) throw e;
        world.dropFreight(id);
        // Our companies carry as many return lots as one owner may (guide 3.8: 409 beyond): no ship tries another for a while. Only a
        // 409 that says the lot itself is gone (taken, closed) is left as that.
        const said = isApiError(e) ? `${e.code ?? ""} ${e.detail} ${e.message}` : "";
        const capped = /\bcap\b|limit|at a time|too many|maximum/i.test(said) || !(CLOSED_RE.test(said) || /\b(?:taken|accepted)\b/i.test(said));
        if (ret && isApiError(e) && e.status === 409 && capped) {
          world.noteReturnCap();
          this.log(`return freight ${id.slice(0, 8)} not taken (${e.detail || e.message}): our companies carry as many return lots as they may; none tried fleet-wide until one is delivered or a game day passes`);
          return "no";
        }
        this.log(`freight ${id.slice(0, 8)} not taken: ${(e as Error).message}`);
        return "no";
      }
    });
  }

  /**
   * At the lane's destination: sells its market goods to the port's buyers, walking the bids down
   * to a floor some way under the price the planner expected (what doesn't sell is left to the
   * leftover handling). Selling needs the berth. Returns a wait while docking, else null.
   */
  private async sellLaneCargo(r: ShipResult, stay: Stay): Promise<number | null> {
    const lane = this.lane;
    if (!lane || stay.traded.has("sold")) return null;
    const parts = lane.parts.filter((p) => p.kind === "market" && this.ownTons(r, p.good) - (stay.boughtHere.get(p.good) ?? 0) > 0);
    if (parts.length === 0) return null;
    // Whether she is insured is unknown (a failed read): wait, rather than finish the lane unsold.
    if ((await this.insuredPolicy()) === undefined) {
      this.activity = `reading this ship's insurance policy failed; not selling at ${stay.port} yet`;
      return 15_000;
    }
    // Insured here since: a sale would cut the cover (it is sold where the policy's voyage ends).
    if (await this.coverCut(stay.port)) return null;
    if (r.ship.status !== "berthed") return this.dockOrWait(r);
    stay.traded.add("sold");
    const { world } = this.host;
    for (const p of parts) {
      const tons = this.ownTons(r, p.good) - (stay.boughtHere.get(p.good) ?? 0);
      // In the season's final hours goods held count at base in net worth (guide 3.11): never sold for less.
      const floor = Math.max(
        this.minSale.get(p.good) ?? 0,
        Math.round(p.pay * (1 - SELL_FLOOR_DROP)),
        Math.round(world.basePrice(p.good) * (world.seasonMode() === "final" ? 1 : 0.5)),
      );
      const before = this.stats.rewardPence;
      const sold = await this.sellHere(stay.port, p.good, tons, floor);
      const got = this.stats.rewardPence - before;
      if (this.trip?.goods.has(p.good)) this.trip.reward += got;
      if (sold > 0) this.log(`sold ${sold}/${tons} t ${p.good} at ${stay.port} for ${cr(got)} (expected ~${cr(p.pay)}/t, floor ${cr(floor)}/t)`);
      else this.log(`${p.good} at ${stay.port} bids under the ${cr(floor)}/t floor; keeping the ${tons} t for now`);
    }
    if (parts.length) this.host.cashArrived();
    return null;
  }

  // ── Delivering ──────────────────────────────────────────────────────────────

  private async deliverCharters(
    r: ShipResult,
    port: string,
    stay: Stay,
    deliverable: (good: string) => number,
  ): Promise<{ delivered: number; retry: boolean }> {
    const { client, world } = this.host;
    let delivered = 0;
    let retry = false;
    const now = world.now();
    const charters = world.charters
      .filter(
        (c) =>
          !c.provisional &&
          c.port === port &&
          (c.expiresAt === null || c.expiresAt > now) &&
          world.deliverable(c) &&
          !stay.refused.has(c.id) &&
          this.roomIn(c) > 0 &&
          !this.campShut(c, Math.min(deliverable(c.good), this.roomIn(c))),
      )
      // The best-paying first, by what the pay is worth to us (a Crown or Admiralty premium tapered, guide 3.7).
      .sort((a, b) => world.charterPayValue(b, b.payPerTon, deliverable(b.good)) - world.charterPayValue(a, a.payPerTon, deliverable(a.good)));

    // Several charters at once: one all-or-nothing batch call; on any refusal, one at a time below.
    // A posting being let lapse goes one at a time (its room under the line is checked just before).
    const plan: Array<{ c: (typeof charters)[number]; qty: number }> = [];
    const left = new Map<string, number>();
    for (const c of charters) {
      if (this.host.stallStake(c.id)?.camp) continue;
      const have = left.get(c.good) ?? deliverable(c.good);
      const qty = Math.min(have, this.roomIn(c));
      if (qty <= 0) continue;
      plan.push({ c, qty });
      left.set(c.good, have - qty);
    }
    if (plan.length > 1 && plan.length <= 25) {
      try {
        // Booked before the tons stop counting as in flight (World.delivering).
        delivered += await this.inFlight(
          plan.map(({ c, qty }) => ({ id: c.id, tons: qty })),
          async () => {
            const results = await client.deliverCharters(plan.map(({ c, qty }) => ({ contract_id: c.id, quantity: qty, ship_id: this.shipId })));
            let n = 0;
            results.forEach((res, i) => {
              const c = plan.find((x) => x.c.id === res.contract_id)?.c ?? plan[i]?.c;
              if (c) n += this.recordDelivery(r, port, c, res);
            });
            return n;
          },
        );
        // A charter may have taken less than asked: the pass below offers the rest to the others.
      } catch (e) {
        if (!(e instanceof KibbApiError) || e.status >= 500) throw e;
        if (e.status === 401 || FATAL_CODES.includes(e.code ?? "")) throw e;
        if (e.status === 429 || e.code === "idempotency_request_in_flight") return { delivered, retry: true };
        // Nothing applied (a 403 too: one of them may be our own player's charter): find the refusal one charter at a time.
      }
    }

    // A 400/409 is a closed contract or refused cargo alike (guide): the quay's listing tells which.
    const unclear: Array<{ c: (typeof charters)[number]; e: KibbApiError }> = [];
    for (const c of charters) {
      const qty = Math.min(deliverable(c.good), this.roomIn(c));
      if (qty <= 0) continue;
      // Being let lapse: only all of it, and only while that still fits under the line.
      if (this.campShut(c, qty)) continue;
      try {
        delivered += await this.inFlight([{ id: c.id, tons: qty }], async () =>
          this.recordDelivery(r, port, c, await client.deliverCharter({ contract_id: c.id, quantity: qty, ship_id: this.shipId })),
        );
      } catch (e) {
        if (!(e instanceof KibbApiError) || e.status >= 500) throw e;
        if (e.status === 401 || FATAL_CODES.includes(e.code ?? "")) throw e;
        if (e.status === 429 || e.code === "idempotency_request_in_flight") {
          retry = true;
          break;
        }
        if (e.status === 403) {
          // A player charter our player (or a company linked to ours) issued: the server refuses its deliveries for
          // good (guide 4.2). Never offered again, by any ship; never a failed tick. A key or presence refusal
          // isn't the charter's: refused for this stay only.
          const notTheCharter = e.code === "missing_scope" || e.code === "company_key_required" || e.code === "no_port_presence";
          if (!notTheCharter) this.host.world.refuseCharter(c.id);
          stay.refused.add(c.id);
          this.log(
            notTheCharter
              ? `${c.title} refused our delivery (${e.code}): ${e.detail || e.message}`
              : `${c.title} refuses our deliveries for good (${e.code ?? "forbidden"}: one of our own or a linked company's charter): ${e.detail || e.message}`,
          );
          continue;
        }
        if (e.status === 404) {
          c.remaining = 0;
          // An expansion posting may only have lapsed: its re-post can come back under the same id.
          world.markClosed(c.id, world.renews(c));
          this.log(`${c.title} is closed: ${e.detail}`);
        } else if (e.status === 400 || e.status === 409) {
          unclear.push({ c, e });
        } else {
          stay.refused.add(c.id);
          this.log(`${c.title} refused our ${c.good}: ${e.message}`);
        }
      }
    }
    if (unclear.length > 0) {
      // At quay the listing is complete: gone from it means closed. Unread, or still listed: refused for this stay only.
      const listed = await this.refreshPortCharters(port);
      for (const { c, e } of unclear) {
        if (listed && !world.charters.some((x) => x.id === c.id && !x.provisional)) {
          c.remaining = 0;
          world.markClosed(c.id, world.renews(c));
          this.log(`${c.title} is closed (gone from the quay's listing${CLOSED_RE.test(e.detail) ? "" : " after a refusal"}): ${e.detail}`);
        } else {
          stay.refused.add(c.id);
          this.log(`${c.title} refused our ${c.good}${CLOSED_RE.test(e.detail) ? " (it says closed but is still listed)" : ""}: ${e.message}`);
        }
      }
    }
    if (delivered > 0) this.host.cashArrived();
    return { delivered, retry };
  }

  /**
   * A charter delivery call with its tons marked in flight (World.delivering) until `call` has booked it:
   * a listing meanwhile doesn't read them as anyone else's. An outcome unknown keeps them marked a while.
   */
  private async inFlight<T>(entries: Array<{ id: string; tons: number }>, call: () => Promise<T>): Promise<T> {
    const release = this.host.world.delivering(entries);
    try {
      const out = await call();
      release();
      return out;
    } catch (e) {
      release(outcomeUnknown(e));
      throw e;
    }
  }

  /**
   * A posting the fleet is letting lapse takes nothing of ours, unless all this ship has for it (`tons`) fits
   * under the pace line re-posts showed our deliveries don't cancel the escalation under (World.trickleRoom).
   * Part of it wouldn't do: those tons would give up the re-post's uplift while the ship waits anyway.
   */
  private campShut(c: World["charters"][number], tons: number): boolean {
    return !!this.host.stallStake(c.id)?.camp && !(tons > 0 && tons <= this.host.world.trickleRoom(c.id));
  }

  /**
   * Keeps the stay's holds for stalled charters' re-posts current: lists the port again once a held
   * posting has lapsed (so its re-post shows), drops a hold once the re-post is listed, the stall
   * breaks or the hold runs out, and starts new ones where this ship's voyage ends (on the tons its
   * loaded lane plans into a posting the fleet is letting lapse).
   */
  private async updateHolds(stay: Stay, deliverable: (good: string) => number): Promise<void> {
    const { world } = this.host;
    const port = stay.port;
    const grace = REPOST_GRACE_GAME_MIN * world.gameMinuteMs;
    if ([...stay.holds.values()].some((h) => world.now() >= h.expiresAt)) await this.refreshPortCharters(port);
    const now = world.now();
    // The re-post of a held posting: the same id with a later lapse, its recorded successor, or the
    // expansion charter now standing for this port and good (never an unrelated charter).
    const repostOf = (c: World["charters"][number], h: { id: string; expiresAt: number }) =>
      c.expiresAt !== null && c.expiresAt > h.expiresAt && (c.id === h.id || world.currentId(h.id) === c.id || (world.renews(c) && !!world.stallWatch(c)));
    for (const [good, h] of [...stay.holds]) {
      const reposted = world.charters.some((c) => c.port === port && c.good === good && repostOf(c, h));
      let drop = reposted || now >= h.until || deliverable(good) <= 0;
      // Before the lapse, a stall hold stands only while the fleet still lets that posting lapse
      // (still listed and stalled, no rival delivery, the tier not completing first).
      if (!drop && h.why === "stall" && now < h.expiresAt) {
        const c = world.charters.find((x) => x.id === h.id);
        drop = !c || this.holdFor(c, Math.min(deliverable(good), this.roomIn(c))) === null;
      }
      if (drop) {
        stay.holds.delete(good);
        if (!reposted && now >= h.until) this.log(`no re-post of the ${good} charter at ${port} turned up in time: delivering what is open`);
      }
    }
    // Only where this ship's loaded lane ends: not at the source of a lane it is about to load, nor
    // for leftovers (no plan into any posting: delivered, sold or carried on as usual).
    if (!this.loaded || this.lane!.dest !== port) return;
    for (const c of world.charters) {
      if (c.provisional || c.port !== port || stay.holds.has(c.good) || stay.refused.has(c.id) || this.roomIn(c) <= 0) continue;
      // Only what the loaded lane plans into that posting waits (the stake counts that wait); leftovers
      // and tons planned for other charters or a market go as planned.
      const tons = Math.min(deliverable(c.good), this.plannedInto(c.id, c.good));
      if (tons < MIN_HOLD_TONS) continue;
      // Not when what it would deliver into the posting all fits under the line (campShut).
      const until = this.holdFor(c, Math.min(deliverable(c.good), this.roomIn(c)));
      if (until === null) continue;
      stay.holds.set(c.good, { id: c.id, expiresAt: c.expiresAt!, until, why: "stall", tons });
      const st = this.host.stallStake(c.id);
      this.log(`holding ${tons} t ${c.good} at ${port} for ${secs(until - now)}: the fleet is letting ${c.title} lapse for its richer re-post (~${Math.round((st?.p ?? 0) * 100)}% it escalates)`);
    }
    // Another of our ships here is holding a good we carry too: what our lane also plans into that
    // posting waits alongside rather than be sold off (the rest goes as planned).
    for (const good of Object.keys(this.last?.cargo_manifest ?? {})) {
      if (stay.holds.has(good) || deliverable(good) <= 0) continue;
      const sib = this.host.siblingHold(this, port, good);
      const tons = sib ? Math.min(deliverable(good), this.plannedInto(sib.id, good)) : 0;
      if (sib && tons > 0) stay.holds.set(good, { ...sib, tons });
    }
    // A load planned on an expansion charter that landed just after it lapsed (whatever the hold
    // setting): wait out the grace for its re-post rather than selling the cargo off.
    if (!this.loaded) return;
    for (const p of this.lane!.parts) {
      if (p.kind !== "charter" || stay.holds.has(p.good) || deliverable(p.good) <= 0) continue;
      if (world.charters.some((c) => !c.provisional && c.port === port && c.good === p.good && (c.expiresAt === null || c.expiresAt > now) && this.roomIn(c) > 0)) continue;
      const lapsed = world.lapsedPosting(port, p.good);
      for (const [id] of p.fills) {
        const cur = world.currentId(id);
        const c = world.charters.find((x) => x.id === cur);
        const renewing = world.renews({ id }) || lapsed?.id === cur;
        const expiresAt = c?.expiresAt ?? (lapsed?.id === cur ? lapsed.expiresAt : null);
        if (!renewing || expiresAt === null || now < expiresAt || now >= expiresAt + grace) continue;
        stay.holds.set(p.good, { id: cur, expiresAt, until: expiresAt + grace, why: "lapse" });
        this.log(`waiting up to ${secs(expiresAt + grace - now)} at ${port} for the re-post of the lapsed ${p.good} charter`);
        break;
      }
    }
  }

  /** This ship's hold at `port` on `good` for a re-post, if any. */
  holdAt(port: string, good: string): HoldInfo | undefined {
    return this.stay?.port === port ? this.stay.holds.get(good) : undefined;
  }

  /**
   * Server time to hold cargo for this charter until (its re-post), or null to deliver now: the
   * fleet is letting the posting lapse (the stake already weighed the odds, the waiting cost with
   * this hold counted from now, any hold past HOLD_CAP, laden rivals due first, the tier completing
   * first and our loads completing it), and the `tons` this ship would deliver into it don't all fit
   * under the line (campShut).
   */
  private holdFor(c: World["charters"][number], tons: number): number | null {
    const { world } = this.host;
    if (c.expiresAt === null || c.expiresAt <= world.now() || !world.renews(c) || !this.campShut(c, tons)) return null;
    return c.expiresAt + REPOST_GRACE_GAME_MIN * world.gameMinuteMs;
  }

  /** Tons of `good` the loaded lane plans into the posting that now stands for `id` (0: none, or nothing loaded). */
  private plannedInto(id: string, good: string): number {
    if (!this.loaded) return 0;
    const { world } = this.host;
    const cur = world.currentId(id);
    let tons = 0;
    for (const p of this.lane!.parts) if (p.kind === "charter" && p.good === good) for (const [f, t] of p.fills) if (world.currentId(f) === cur) tons += t;
    return tons;
  }

  /**
   * Tons this ship may deliver into a charter: what other ships already carrying cargo for it leave,
   * and nothing when the good is one of this lane's market goods and the charter pays less than
   * the planned sale.
   */
  private roomIn(c: World["charters"][number]): number {
    if (c.remaining <= 0) return 0;
    const sale = this.loaded ? this.lane!.parts.find((p) => p.kind === "market" && p.good === c.good) : undefined;
    // What the charter's pay is worth to us (a Crown or Admiralty premium tapered, guide 3.7) against the planned sale.
    if (sale && this.host.world.charterPayValue(c, c.payPerTon, Math.min(sale.tons, c.remaining)) < sale.pay) return 0;
    return this.host.charterRoomFor(this, c.id, c.remaining);
  }

  /** Books one charter delivery into the charter, the ship's manifest, stats and vaults. */
  private recordDelivery(r: ShipResult, port: string, c: World["charters"][number], res: DeliverCharterResult): number {
    const { world } = this.host;
    c.remaining = Math.max(0, c.remaining - res.delivered_quantity);
    if (res.contract_status !== "open") {
      c.remaining = 0;
      world.markClosed(c.id);
    }
    r.cargo_manifest[c.good] = (r.cargo_manifest[c.good] ?? 0) - res.delivered_quantity;
    world.noteOwnDelivery(c, res.delivered_quantity);
    // Crown and Admiralty pay (never a player's charter) counts towards the premium taper (guide 3.7).
    world.noteCharterPay(c, res.reward_paid_pence);
    this.host.persist(true);
    this.stats.deliveredTons += res.delivered_quantity;
    this.stats.rewardPence += res.reward_paid_pence;
    if (this.trip?.goods.has(c.good)) this.trip.reward += res.reward_paid_pence;
    world.vaults.set(world.region(port), world.vault(world.region(port)) + res.reward_paid_pence);
    this.log(`delivered ${res.delivered_quantity} t ${c.good} at ${port}: ${cr(res.reward_paid_pence)} (${c.title}; ${res.contract_status}, phase ${res.unlocked_phase})`);
    return res.delivered_quantity;
  }

  private async deliverFreight(id: string, f: CarriedFreight): Promise<"delivered" | "refused" | "gone" | "retry" | "error"> {
    try {
      const res = await this.host.client.deliverFreight(id, this.shipId);
      this.freight.delete(id);
      this.host.persist(true);
      this.stats.freightPence += res.reward_paid_pence;
      // The reward into the destination's vault like charter pay; the collateral back to the region it was
      // escrowed from (where each lands isn't published: the vaults are read again to settle it).
      const { world } = this.host;
      const back = world.region(f.origin ?? f.dest);
      world.vaults.set(world.region(f.dest), world.vault(world.region(f.dest)) + (res.reward_paid_pence ?? 0));
      world.vaults.set(back, world.vault(back) + (res.collateral_returned_pence ?? 0));
      void world.refreshVaults().catch(() => undefined);
      if (this.trip?.freightIds.has(id)) this.trip.reward += res.reward_paid_pence;
      // A return lot delivered (guide 3.8): its sealed tons simply leave the hold, and our companies have room under the cap again.
      if (f.ret) world.noteReturnDelivered();
      this.host.cashArrived();
      this.log(`delivered ${f.ret ? "return freight" : "freight"}: ${res.delivered_quantity} t ${f.good} at ${f.dest} for ${cr(res.reward_paid_pence)}`);
      return "delivered";
    } catch (e) {
      if (!(e instanceof KibbApiError) || e.status >= 500) throw e;
      if (e.status === 401 || FATAL_CODES.includes(e.code ?? "")) throw e;
      if (e.status === 429 || e.code === "idempotency_request_in_flight") return "retry";
      if (e.status === 404) {
        this.log(`freight to ${f.dest} is settled: ${e.detail}`);
        this.freight.delete(id);
        return "gone";
      }
      // Never dropped on the wording, nor on a refusal past its deadline (guide 3.6: expired while we stand by here,
      // the issuer is in breach and we are paid): the server's list of active freight decides (sealed tons stay
      // counted; syncFreight's day past the deadline is the backstop).
      if (await this.syncFreight()) {
        if (!this.freight.has(id)) return "gone";
        if (!this.listedFreight.has(id)) {
          this.log(`freight to ${f.dest} is no longer active (${e.detail}); treating the ${f.tons} t ${f.good} as settled`);
          this.freight.delete(id);
          return "gone";
        }
      }
      if (e.status === 409) {
        // Refused tender: the issuer has no space. The cargo stays sealed; stand by until it settles.
        if (!f.refusedAt) this.log(`freight tender at ${f.dest} refused (${e.detail}); standing by`);
        f.refusedAt = this.host.world.now();
        return "refused";
      }
      // Rejected outright: stop sailing for it; the sealed tons stay counted until the server drops it.
      f.undeliverable = true;
      this.log(`freight delivery at ${f.dest} rejected (${e.message}); no longer sailing for it`);
      return "error";
    }
  }

  /**
   * Takes open freight from here to `next` (the leg we are about to sail anyway) when its reward
   * beats the value of the berth time its loading costs. Leaves room for the stores the voyage needs.
   */
  private async takeFreight(r: ShipResult, next: string, stay: Stay): Promise<void> {
    const { client, world, settings } = this.host;
    const port = stay.port;
    if (!settings.useFreight || r.ship.status !== "berthed" || stay.traded.has("freight") || this.contrabandBarred(r, "taking freight")) return;
    // Insured (or unknown): sealed freight loaded after the policy voids it.
    if ((await this.policyNow()) !== null) return;
    stay.traded.add("freight");

    let listings: ContractListing[];
    try {
      listings = (await client.contractPages({ contract_type: "freight", port_id: port, status: "open" })).items;
      world.mergePortFreight(port, listings);
    } catch (e) {
      soft(e);
      return;
    }
    const profitPerMs = this.ratePerHour / 3_600_000;
    const handling = world.handlingMsPerTon(port);
    // The passage it rides on (the route is cached: the ship sails it next).
    const plan = await world.route(port, next, this.shipClass).catch((e: unknown) => {
      soft(e);
      return null;
    });
    if (!plan) return;
    const cls = world.shipClass(this.shipClass);
    const hull = cls?.hull_category ?? "coastal";
    const knots = ((cls?.base_speed_centiknots ?? 800) / 100) * 0.8;
    const lockEnds = Date.parse(r.ship.turnaround_unlocks_at ?? "");
    const sailsAt = Math.max(world.now(), Number.isFinite(lockEnds) ? lockEnds : 0);
    const sailMs = world.sailMs(plan.total_distance_nm, knots);
    const storm = world.stormRisk(plan, hull, knots, sailsAt, settings.stormWeightPct / 100);
    // Pirates take contraband like anything else: it counts toward the hold they are drawn to.
    const aboard =
      Object.keys(r.cargo_manifest).reduce((n, g) => n + this.ownTons(r, g) * world.basePrice(g), 0) +
      this.contrabandAboard(r).reduce((n, [g, t]) => n + t * world.basePrice(g), 0);
    const retBlocked = world.returnBlocked();
    const candidates = listings
      // Never lots any of our player's companies issued (same-player dealing is refused, guide 4.2).
      .filter((c) => c.origin_port_id === port && c.dest_port_id === next && !c.stale && !world.ownIssued({ issuer: c.issuer_company_id }))
      // Return freight not while our companies' cap on it refused one lately (guide 3.8).
      .filter((c) => !retBlocked || !isReturnFreight(c))
      // Paid only if it lands before the season ends (guide 3.11): loaded, sailed, and the base lock there cleared.
      .filter((c) => world.beforeSeasonEnd(sailsAt + c.quantity_required * handling + sailMs + 30 * world.gameMinuteMs))
      .map((c) => {
        // Sealed freight goes down with the ship (a sinking or a capture): reward unearned, collateral forfeit (as the planner prices it).
        // Return freight draws no raid of its own (worth nothing aboard), but is lost with the hull all the same.
        const loot = freightLoot({ collateral: c.collateral_pence, ret: isReturnFreight(c) });
        const lost = Math.min(1, world.piracyRisk(plan, r.ship.cannons_count, knots, aboard + loot).capture + storm.sink);
        return { c, value: c.reward_pence * (1 - lost) - c.collateral_pence * lost - c.quantity_required * handling * profitPerMs };
      })
      .filter((x) => x.value > 0)
      .sort((a, b) => b.value / b.c.quantity_required - a.value / a.c.quantity_required);
    if (candidates.length === 0) return;

    const need = await this.storesTarget(port, next, this.lane?.dest);
    let room = r.effective_hold_capacity_tons - r.cargo_used_tons - this.storesHoldNeed(r.stores.provisions_tons, need);

    for (const { c } of candidates) {
      if (c.quantity_required > room || this.host.freightClaimed(this, c.id)) continue;
      const ret = isReturnFreight(c);
      // One refused for the cap a moment ago, by this ship or another: the rest are left alone.
      if (ret && world.returnBlocked()) continue;
      const lane = this.lane && this.lane.dest === next ? this.lane : null;
      const res = await this.acceptFreightLot(port, c.id, c.collateral_pence, r, lane, ret);
      if (typeof res === "object") return;
      if (res === "taken") room -= c.quantity_required;
    }
  }

  /**
   * Own cargo with no lane (charter filled, restart). In order: carry it to an open charter when
   * that beats selling here by more than the voyage is worth; sell here at a fair bid; let a small
   * residue ride along (returns null: carry on planning); else take it to the best market elsewhere.
   */
  private async handleLeftover(r: ShipResult, good: string, stay: Stay): Promise<number | null> {
    const { world, client, settings } = this.host;
    const port = stay.port;
    // Contraband is never offered on a market or to a charter (both refuse it, guide 3.18): atPort holds it.
    if (world.isContraband(good)) return null;
    const tons = this.ownTons(r, good);
    const cls = world.shipClass(this.shipClass);
    const hull = cls?.hull_category ?? "coastal";
    const knots = (cls?.base_speed_centiknots ?? 800) / 100;
    const now = world.now();
    const base = world.basePrice(good);

    // What it fetches here (fresh book when this port trades it; bids our asks can't take left out).
    let localBid = 0;
    let bids: OrderBookLevel[] = [];
    if (world.trades(port, good)) {
      const book = await client.book(port, good).catch(() => null);
      if (book) world.observeBook(book);
      localBid = world.price(port, good)?.bid ?? 0;
      bids = (book?.books.find((b) => b.commodity_id === good)?.depth?.bids ?? []).filter((l) => !world.isUnfillable(port, good, l.order_id, "bid"));
    }

    // Stores this ship could carry for a leg: what it has, plus free hold, plus provisions cargo it could eat.
    const stockable = r.stores.provisions_tons + Math.max(0, r.effective_hold_capacity_tons - r.cargo_used_tons) + this.ownTons(r, STORES_GOOD);
    // A detour never lands passengers aboard after their promise (guide 3.20: late cuts the fare; the pin sends her to theirs first).
    const promised = this.paxDue();
    const reachable = (plan: RoutePlan) =>
      world.routeRated(plan, hull) && plan.safe_provisions_tons <= stockable && now + world.sailMs(plan.total_distance_nm, knots * 0.8) + 30 * world.gameMinuteMs <= promised;

    let best: { c: (typeof world.charters)[number]; take: number; value: number } | null = null;
    for (const c of world.charters) {
      if (c.good !== good || c.port === port || c.stale || c.remaining <= 0 || !world.isOpen(c.port) || !world.deliverable(c) || world.isCove(c.port)) continue;
      const plan = await world.route(port, c.port, this.shipClass).catch(() => null);
      // Not where the AI's bans rule out (cargo aboard is never stranded: selling here, or holding, remains).
      if (!plan || !reachable(plan) || this.host.offLimits(c.port, plan, c.id)) continue;
      const sailMs = world.sailMs(plan.total_distance_nm, knots * 0.8);
      if (c.expiresAt !== null && c.expiresAt < now + sailMs + 30 * world.gameMinuteMs + 10 * 60_000) continue;
      // Charters pay nothing after the season ends (guide 3.11).
      if (!world.beforeSeasonEnd(now + sailMs + 30 * world.gameMinuteMs)) continue;
      const take = Math.min(tons, c.remaining);
      // A Crown or Admiralty charter's premium is tapered by our recent charter earnings (guide 3.7).
      const value = take * (world.charterPayValue(c, c.payPerTon, take) - localBid - settings.minMarginPence) - (sailMs / 3_600_000) * this.ratePerHour;
      if (value > 0 && (!best || value > best.value)) best = { c, take, value };
    }
    if (best) {
      this.lane = cargoLane(good, port, best.c.port, best.c.id, best.take, Math.round(world.charterPayValue(best.c, best.c.payPerTon, best.take)));
      this.laneLoaded = this.lane.key;
      this.log(`carrying ${tons} t ${good} already aboard to ${best.c.title}`);
      return this.sailTo(r, best.c.port, stay);
    }

    // Sell here at a fair bid, unless a charter here refused it this stay (don't dump it at a loss),
    // and not under what it cost to land until it has been held for a few NPC re-quotes.
    const refusedHere = world.charters.some((c) => c.good === good && stay.refused.has(c.id));
    let floor = this.minSale.get(good) ?? 0;
    if (floor > 0 && this.holds > MAX_HOLDS * 2) {
      this.log(`no buyer for ${good} at its ${cr(floor)}/t cost after ${this.holds} holds; selling at what it fetches`);
      this.minSale.delete(good);
      floor = 0;
    }
    // In the season's final hours goods held count at base in net worth (guide 3.11): never sold for less.
    if (world.seasonMode() === "final") floor = Math.max(floor, base);
    if (localBid >= Math.max(base * 0.5, floor) && !refusedHere && !this.contrabandBarred(r, `selling ${good}`) && !(await this.coverCut(port))) {
      if (r.ship.status !== "berthed") return this.dockOrWait(r);
      try {
        const res = await client.placeOrder({
          port_id: port,
          commodity_id: good,
          side: "ask",
          time_in_force: "ioc",
          price_pence: localBid,
          quantity: tons,
          ship_id: this.shipId,
        });
        if (res.filled_quantity > 0) {
          this.stats.rewardPence += res.total_gross_pence;
          // Paid into this port's vault (like sellHere): ships waiting for cash may have it now.
          world.vaults.set(world.region(port), world.vault(world.region(port)) + res.total_gross_pence);
          this.host.cashArrived();
          this.holds = 0;
          this.log(`sold ${res.filled_quantity}/${tons} t leftover ${good} at ${port} for ${cr(res.total_gross_pence)}`);
        }
        // Bids that crossed ours and stayed are our own companies': left out, so the next look prices without them.
        const own = res.filled_quantity < tons ? await this.noteOwnBids(port, good, bids.filter((l) => l.price_pence >= localBid)) : 0;
        if (res.filled_quantity > 0 || own > 0) return 2_000;
      } catch (e) {
        soft(e);
        if (!isApiError(e) || e.status >= 500) throw e;
        this.log(`selling ${good} at ${port} refused: ${e.message}`);
      }
    }

    // A small residue (part of a load a charter couldn't take) rides along rather than idling the ship.
    if (tons <= Math.max(2, 0.05 * Math.max(r.hold_capacity_tons, 1))) return null;

    // The best market elsewhere: known bids net of the voyage, after holding here a while.
    this.holds++;
    let market: { port: string; value: number } | null = null;
    for (const p of world.catalog.ports) {
      // Lawful buyers only: never a cove's stores market (guide 3.18).
      if (p.id === port || !world.isOpen(p.id) || p.is_cove || !world.trades(p.id, good)) continue;
      const plan = await world.route(port, p.id, this.shipClass).catch(() => null);
      if (!plan || !reachable(plan) || this.host.offLimits(p.id, plan)) continue;
      const sail = world.sailMs(plan.total_distance_nm, knots * 0.8);
      // Sold there only before the season ends (its berth and handling: the planner's timing).
      if (!world.beforeSeasonEnd(now + sail + 30 * world.gameMinuteMs + tons * world.handlingMsPerTon(p.id))) continue;
      const seen = world.price(p.id, good);
      // A shortage there lifts the bid expected when we land (not once a book since shows the real one).
      const bid = Math.max(seen?.bid ?? ((p.imports ?? []).includes(good) ? base * 0.9 : 0), world.shortageBid(p.id, good, now + sail, seen?.at ?? null) ?? 0);
      if (bid < floor) continue;
      const value = tons * bid - (sail / 3_600_000) * this.ratePerHour;
      if (!market || value > market.value) market = { port: p.id, value };
    }
    if (market && (market.value > tons * localBid || this.holds > MAX_HOLDS)) {
      this.log(`taking ${tons} t ${good} to ${market.port} to sell`);
      this.holds = 0;
      return this.sailTo(r, market.port, stay);
    }
    this.activity = `holding ${tons} t ${good}: no fair bid at ${port}`;
    await this.park(r);
    return HOLD_WAIT_GAME_MIN * world.gameMinuteMs;
  }

  // ── Stores ──────────────────────────────────────────────────────────────────

  private async storesTarget(from: string, to: string, then?: string): Promise<number> {
    const { world } = this.host;
    if (from === to) return 0;
    const first = await world.route(from, to, this.shipClass);
    // No way on from there for this hull: this leg's stores alone.
    const second = then && then !== to ? await world.route(to, then, this.shipClass).catch(() => null) : null;
    // The next leg's stores ride along; on a passage that may take more than one hit (long, or in
    // storm season), carry at least enough to stay fed through those hits on this one.
    const legs = Math.max(this.safeStores(from, to, first) + (second ? this.safeStores(to, then!, second) : 0), this.storesFor(first));
    // A leg that starved lately keeps a few more days in hand (storesBiasDays).
    return legs + (STORES_BUFFER_DAYS + this.storesBiasDays) * first.port_provisions_tons_per_day;
  }

  /** A route's safe stores: its plan's figure, or what a departure last warned it needs if more (World.safeFloor). */
  private safeStores(from: string, to: string, plan: RoutePlan): number {
    return Math.max(plan.safe_provisions_tons, this.host.world.safeFloor(from, to, this.shipClass));
  }

  /** Stores for one passage: enough for the storm and pirate hits it could plausibly take (World.storesFor). */
  private storesFor(plan: RoutePlan): number {
    const { world } = this.host;
    const cls = world.shipClass(this.shipClass);
    // Pirates look at the cargo: our lane's load on its laden passage, nothing on any other.
    const lane = this.lane;
    const laden = !!lane && plan.from_port === lane.source && plan.to_port === lane.dest;
    const cargo = laden ? lane.parts.reduce((n, p) => n + p.tons * world.basePrice(p.good), 0) : 0;
    const stores = world.storesFor(plan, cls?.hull_category ?? "coastal", this.last?.ship.cannons_count ?? 0, ((cls?.base_speed_centiknots ?? 800) / 100) * 0.8, cargo, world.now());
    return Number.isFinite(stores) ? stores : plan.safe_provisions_tons;
  }

  /**
   * Surplus stores (whole tons above what the voyage needs) are dead weight in the hold. On a
   * provisions lane they go into cargo for the charter. On any other lane, when the hold is what
   * limits the load, they come out and are sold here. Returns the tons left in cargo, which the
   * caller puts back if the load falls through.
   */
  private async trimStores(r: ShipResult, lane: Lane, stay: Stay): Promise<number> {
    if (stay.port === lane.dest || this.contrabandBarred(r, "trading stores")) return 0;
    const target = await this.storesTarget(lane.source, lane.dest, lane.source);
    let surplus = Math.floor(r.stores.provisions_tons - target);
    if (surplus < 1) return 0;
    const forCharter = lane.kind === "charter" && lane.parts[0]?.good === STORES_GOOD;
    if (!forCharter) {
      const room = r.effective_hold_capacity_tons - r.cargo_used_tons;
      const want = lane.tons - this.laneGoodsAboard(r, lane);
      surplus = Math.min(surplus, Math.max(0, want - room));
      if (surplus < 1) return 0;
    }
    // Stores moved into cargo are cargo added: never once a policy is on her (or that can't be told).
    if ((await this.policyNow()) !== null) return 0;
    if (forCharter) {
      await this.host.client.unprovision(this.shipId, surplus, "cargo");
      stay.boughtHere.set(STORES_GOOD, (stay.boughtHere.get(STORES_GOOD) ?? 0) + surplus);
      this.log(`moved ${surplus} t of surplus stores into cargo for the ${lane.dest} charter`);
      return surplus;
    }
    // Moving stores into cargo frees nothing by itself: only worth it if they sell here, so look first.
    const { client, world } = this.host;
    if (await this.coverCut(stay.port)) return 0;
    const book = await client.book(stay.port, STORES_GOOD).catch(() => null);
    if (!book) return 0;
    world.observeBook(book);
    // The best bid our asks can take (our own companies' left out, World.noteUnfillable).
    const bid = world.price(stay.port, STORES_GOOD);
    if (!bid?.bid || bid.bid < world.basePrice(STORES_GOOD) * 0.5 || bid.bidQty < 1) return 0;
    const n = Math.min(surplus, Math.floor(bid.bidQty));
    await client.unprovision(this.shipId, n, "cargo");
    // Loaded here: never deliverable to a charter here while it sits in cargo.
    stay.boughtHere.set(STORES_GOOD, (stay.boughtHere.get(STORES_GOOD) ?? 0) + n);
    const sold = await this.sellHere(stay.port, STORES_GOOD, n);
    const back =
      sold < n
        ? await client.provision(this.shipId, n - sold, "cargo").then(
            () => n - sold,
            (e) => {
              soft(e);
              return 0;
            },
          )
        : 0;
    stay.boughtHere.set(STORES_GOOD, Math.max(0, (stay.boughtHere.get(STORES_GOOD) ?? 0) - sold - back));
    if (sold > 0) this.log(`sold ${sold} t of surplus stores at ${stay.port} to make room for the ${lane.good} load`);
    return 0;
  }

  /**
   * After an ask of ours under-filled: players' bids at or over its limit (`crossed`, read before it) still there
   * untouched can't take our asks (our own other companies', guide 3.2), so they are left out from now on, as
   * buyPart does for asks. Returns how many. Never throws but on a fatal error: the sale is already booked.
   */
  private async noteOwnBids(port: string, good: string, crossed: OrderBookLevel[]): Promise<number> {
    const { client, world } = this.host;
    const players = crossed.filter((l) => !l.is_npc);
    if (players.length === 0) return 0;
    const after = await client.book(port, good).catch((e: unknown) => {
      if (isFatalApiError(e)) throw e;
      return null;
    });
    if (!after) return 0;
    const left = after.books.find((x) => x.commodity_id === good)?.depth?.bids ?? [];
    const ours = players.filter((l) => left.some((x) => x.order_id === l.order_id && x.remaining_quantity === l.remaining_quantity)).map((l) => l.order_id);
    if (ours.length) {
      world.noteUnfillable(port, good, ours, "bid");
      this.log(`${ours.length} bid${ours.length === 1 ? "" : "s"} for ${good} at ${port} can't take our asks (our own companies'): left out from now on`);
    }
    world.observeBook(after);
    return ours.length;
  }

  /**
   * Sells our own goods here. Without a floor: at the best bid our asks can take, if it is a fair one (half
   * the base price or more). With a floor: down the bid ladder to it. Returns tons sold.
   */
  private async sellHere(port: string, good: string, tons: number, floor?: number): Promise<number> {
    const { client, world } = this.host;
    if (this.last && this.contrabandBarred(this.last, `selling ${good}`)) return 0;
    // Tons of it aboard before the order, and its limit: what an order with no answer sold is told from the hold.
    let before: number | null = null;
    let limit = 0;
    try {
      const book = await client.book(port, good);
      world.observeBook(book);
      // Our own other companies' resting bids can't take our asks: left out once found (World.noteUnfillable).
      const b = book.books.find((x) => x.commodity_id === good);
      const depthBids = b?.depth?.bids ?? [];
      const fillable = depthBids.filter((l) => !world.isUnfillable(port, good, l.order_id, "bid"));
      const bid = fillable.length ? Math.max(...fillable.map((l) => l.price_pence)) : depthBids.length ? 0 : (b?.best_bid?.price_pence ?? 0);
      limit = floor ?? bid;
      if (bid < Math.max(limit, world.basePrice(good) * 0.5)) return 0;
      before = this.ownTons(await this.reread(), good);
      const res = await client.placeOrder({ port_id: port, commodity_id: good, side: "ask", time_in_force: "ioc", price_pence: limit, quantity: tons, ship_id: this.shipId });
      this.stats.rewardPence += res.total_gross_pence;
      world.vaults.set(world.region(port), world.vault(world.region(port)) + res.total_gross_pence);
      if (res.filled_quantity < tons) await this.noteOwnBids(port, good, fillable.filter((l) => l.price_pence >= limit));
      return res.filled_quantity;
    } catch (e) {
      soft(e);
      if (before !== null && outcomeUnknown(e)) {
        // It may have gone through: what left the hold sold, at the limit or better (booked at the limit until the
        // vaults are read again). Unreadable too: the error stands, and the next tick reads the ship afresh.
        const left = await this.reread().then((x) => this.ownTons(x, good), () => null);
        if (left === null) throw e;
        const sold = Math.max(0, Math.min(tons, before - left));
        if (sold > 0) {
          this.stats.rewardPence += sold * limit;
          world.vaults.set(world.region(port), world.vault(world.region(port)) + sold * limit);
          void world.refreshVaults().catch(() => undefined);
        }
        this.log(`selling ${good} at ${port}: no answer (${(e as Error).message}); ${sold} of ${tons} t left the hold, booked at ${cr(limit)}/t`);
        return sold;
      }
      if (!isApiError(e) || e.status >= 500) throw e;
      this.log(`selling ${good} at ${port} refused: ${e.message}`);
      return 0;
    }
  }

  /**
   * Best effort: buys `tons` of stores here while berthed, only what fits in the hold and what the cash
   * covers. Stores to sail safely may dip into the region's floor (FleetHost.ensureCash essential). Any
   * fill counts as the stay's stores purchase (rule 7). Returns the tons bought.
   */
  private async buyStores(r: ShipResult, stay: Stay, tons: number): Promise<number> {
    const { client, world } = this.host;
    if (!(tons > 0) || r.ship.status !== "berthed" || this.contrabandBarred(r, "buying stores")) return 0;
    const port = stay.port;

    // Stores take whole tons of hold: buy no more than the free space allows.
    const have = r.stores.provisions_tons;
    const free = r.effective_hold_capacity_tons - r.cargo_used_tons;
    let n = Math.ceil(tons);
    while (n > 0 && Math.ceil(have + n) - Math.ceil(have) > free) n--;
    if (n <= 0) {
      this.log(`no hold space for stores at ${port}`);
      return 0;
    }

    const book = await client.book(port, STORES_GOOD);
    world.observeBook(book);
    // The best ask our bids can fill (our own other companies' resting asks never match ours).
    const { ask, open, any } = fillableAsk(world, port, STORES_GOOD, book);
    if (ask === null) {
      this.log(`no provisions on sale at ${port} for stores${any ? " (only our own companies')" : ""}`);
      stay.storesNoAsk = true;
      stay.storesNoCash = false;
      return 0;
    }
    const limit = Math.ceil(ask * 1.1);
    const perTon = limit * (1 + book.customs_bps / 10_000);
    const region = world.region(port);
    return this.host.withCash(async () => {
      const cash = await this.host.ensureCash(region, Math.ceil(perTon * n), { essential: true });
      // Short of cash for all of it: what it covers (stores are what keeps the crew fed).
      const qty = Math.min(n, Math.floor(cash / perTon));
      if (qty <= 0) {
        this.log(`no cash in ${region} for stores at ${port}`);
        stay.storesNoCash = true;
        stay.storesNoAsk = false;
        return 0;
      }
      try {
        const res = await client.placeOrder({
          port_id: port,
          commodity_id: STORES_GOOD,
          side: "bid",
          time_in_force: "ioc",
          price_pence: limit,
          quantity: qty,
          ship_id: this.shipId,
          into_stores: true,
        });
        const paid = res.total_gross_pence + res.customs_duty_pence;
        this.stats.spentPence += paid;
        world.vaults.set(region, world.vault(region) - paid);
        stay.traded.add("stores");
        if (res.filled_quantity > 0) {
          stay.storesBought = true;
          stay.storesNoCash = false;
          stay.storesNoAsk = false;
        }
        this.log(`stores: bought ${res.filled_quantity}/${qty} t at ${port}${qty < n ? ` (cash for ${qty} of ${n})` : ""}`);
        // Players' asks under the limit still there untouched can't fill us (our own companies'): left out from now on,
        // and with nothing filled the ship waits in the roadstead until an ask it can fill shows (storesBuyable).
        if (res.filled_quantity < qty && (await this.noteOwnAsks(port, STORES_GOOD, open.filter((l) => l.price_pence <= limit))) > 0 && res.filled_quantity === 0) {
          stay.storesNoAsk = true;
        }
        return res.filled_quantity;
      } catch (e) {
        soft(e);
        if (!isApiError(e) || e.status >= 500) throw e;
        this.log(`stores purchase refused: ${e.message}`);
        return 0;
      }
    });
  }

  /**
   * After stores found no cash (or no ask we can fill) here: whether a ton could be had now ("ok"), else what is
   * missing, cash raised for it as a stores purchase would (essential). Until then the ship waits in the
   * roadstead rather than dock for nothing.
   */
  private async storesBuyable(port: string): Promise<"ok" | "ask" | "cash"> {
    const { client, world } = this.host;
    const book = await client.book(port, STORES_GOOD);
    world.observeBook(book);
    const { ask } = fillableAsk(world, port, STORES_GOOD, book);
    if (ask === null) return "ask";
    const perTon = Math.ceil(ask * 1.1) * (1 + book.customs_bps / 10_000);
    const region = world.region(port);
    return (await this.host.withCash(async () => (await this.host.ensureCash(region, Math.ceil(perTon), { essential: true })) >= perTon)) ? "ok" : "cash";
  }

  /**
   * After a bid of ours under-filled: players' asks at or under its limit (`crossed`, read before it) still there
   * untouched can't fill our bids (our own other companies', guide 3.2), so they are left out from now on, as
   * buyPart does. Returns how many. Never throws but on a fatal error: the purchase is already booked.
   */
  private async noteOwnAsks(port: string, good: string, crossed: OrderBookLevel[]): Promise<number> {
    const { client, world } = this.host;
    const players = crossed.filter((l) => !l.is_npc);
    if (players.length === 0) return 0;
    const after = await client.book(port, good).catch((e: unknown) => {
      if (isFatalApiError(e)) throw e;
      return null;
    });
    if (!after) return 0;
    const left = after.books.find((x) => x.commodity_id === good)?.depth?.asks ?? [];
    const ours = players.filter((l) => left.some((x) => x.order_id === l.order_id && x.remaining_quantity === l.remaining_quantity)).map((l) => l.order_id);
    if (ours.length) {
      world.noteUnfillable(port, good, ours);
      this.log(`${ours.length} ask${ours.length === 1 ? "" : "s"} for ${good} at ${port} can't fill our bids (our own companies'): left out from now on`);
    }
    world.observeBook(after);
    return ours.length;
  }

  // ── Moving ──────────────────────────────────────────────────────────────────

  private async dockOrWait(r: ShipResult): Promise<number> {
    // Never berths with contraband aboard in an ordinary port (guide 3.18): she waits in the roadstead instead.
    if (this.contrabandBarred(r, "berthing")) {
      await this.park(r);
      this.activity = `contraband aboard: in the roadstead at ${r.ship.current_port_id}, never berthing in an ordinary port with it`;
      return CONTRABAND_WAIT_MS;
    }
    if (r.ship.dock_queued_at) {
      this.activity = `queued for a berth at ${r.ship.current_port_id}`;
      return POLL_MS;
    }
    const res = await this.host.client.dock(this.shipId);
    this.host.world.noteBerthDues(res.port_id, res.berth_dues_per_day_pence);
    this.activity = res.queue_position ? `queued #${res.queue_position} for a berth` : `docked at ${res.port_id}`;
    return 2_000;
  }

  /** `voidsPolicy`: sailing elsewhere than an insured voyage's port was chosen on purpose (sealed freight's deadline). */
  private async sailTo(r: ShipResult, dest: string, stay: Stay, opts: { voidsPolicy?: boolean } = {}): Promise<number> {
    const { client, world } = this.host;
    const port = stay.port;
    const hull = world.shipClass(this.shipClass)?.hull_category ?? "coastal";

    // Rule 8: a policy the user bought on this ship is void if she sails anywhere but its port (unknown: not sailing yet).
    const policy = opts.voidsPolicy ? null : await this.insuredPolicy();
    if (policy === undefined) {
      this.activity = `reading this ship's insurance policy failed; not sailing to ${dest} yet`;
      return 15_000;
    }
    if (policy && policy.dest_port_id !== dest && policy.dest_port_id !== port) {
      this.logOnce(`guard:${policy.id}>${dest}`, `not sailing to ${dest}: the policy on this ship is for a voyage to ${policy.dest_port_id}`);
      // A loaded lane keeps its cargo: it carries on from the policy's port.
      if (this.lane && !this.loaded) this.host.releaseLane(this);
      await this.park(r);
      this.activity = `insured for ${policy.dest_port_id}: not sailing to ${dest}`;
      return 15_000;
    }
    // Our offers here for another port (the voyage changed: a new lane, sealed freight): withdrawn before anyone boards for it.
    this.dropOffers(`she sails for ${dest} now`, dest);

    let plan: RoutePlan;
    try {
      // A plan read lately: the hull is committed to it, and depart sails the shortest unlocked route as it is now.
      plan = await world.route(port, dest, this.shipClass, { maxAgeMs: SAIL_PLAN_MAX_AGE_MS });
    } catch (e) {
      soft(e);
      this.log(`no route ${port} → ${dest}: ${(e as Error).message}`);
      this.paxBlock(dest, "no route");
      this.host.releaseLane(this);
      return IDLE_WAIT_MS;
    }
    const sealed = [...this.freight.values()].filter((f) => f.dest === dest && !f.undeliverable);
    if (!world.routeRated(plan, hull)) {
      // The user's policy for there waits on them (below); otherwise passengers for there stop pinning her for a while.
      if (!(policy && policy.dest_port_id === dest)) this.paxBlock(dest, `the route crosses water a ${hull} hull isn't rated for`);
      if (policy && policy.dest_port_id === dest) {
        // The user insured this voyage: theirs to decide (cancel the policy, or wait for the route to change).
        this.logOnce(`unrated:${policy.id}`, `WARNING: the policy on this ship is for ${dest}, but ${port} → ${dest} crosses water a ${hull} hull isn't rated for: waiting here`);
        await this.park(r);
        this.activity = `insured for ${dest}, over water a ${hull} hull isn't rated for: waiting`;
        return 60_000;
      }
      if (sealed.length > 0) {
        // Sealed freight bound there: not sailed for a while (the route may change); said once per lot.
        for (const f of sealed) {
          if (!f.blockedAt) {
            const due = f.deadline ? ` by ${f.deadline}` : "";
            this.log(`won't sail ${port} → ${dest} over water a ${hull} hull isn't rated for: the ${f.tons} t ${f.good} sealed freight (collateral ${cr(f.collateral ?? 0)}) defaults at its deadline${due} unless the route changes`);
          }
          f.blockedAt = world.now();
        }
        this.host.persist(true);
        // A lane going there is off; one loaded elsewhere carries on.
        if (this.lane && (this.lane.dest === dest || (!this.loaded && this.lane.source === dest))) this.host.releaseLane(this);
        return 5_000;
      }
      this.logOnce(`${stay.key}|unrated|${dest}`, `${port} → ${dest} crosses water a ${hull} hull isn't rated for; dropping the lane`);
      this.host.releaseLane(this);
      return 5_000;
    }
    for (const f of sealed) delete f.blockedAt;

    // Contraband aboard (bought by hand; the smuggling mode's own passages are checked there, guide 3.18): at sea only patrols
    // search, in their zones, so no passage through a zone a patrol works (as last read; a zone not read counts as patrolled);
    // and in an ordinary port no stores may be bought with it aboard, so none short of the passage's safe figure either. She
    // waits in the roadstead instead (an unloaded lane goes), logged once, until it is run ashore or sold at a cove.
    const contraband = this.contrabandAboard(r);
    if (contraband.length) {
      const zones = new Set<string>();
      for (const n of [port, ...plan.legs.flatMap((l) => [l.from_node, l.to_node]), dest]) {
        const z = world.hazardZone(n)?.id;
        if (z) zones.add(z);
      }
      const patrols = [...zones].filter((z) => world.patrolBps.get(z) !== 0);
      const safeHere = this.safeStores(port, dest, plan);
      const short = !world.isCove(port) && r.stores.provisions_tons < safeHere;
      if (patrols.length || short) {
        const what = contraband.map(([g, t]) => `${t} t ${g}`).join(", ");
        const why = patrols.length
          ? `a patrol works ${patrols.join(", ")} on the route (or it isn't read yet), and a patrol searches contraband: forfeit with everything aboard`
          : `${r.stores.provisions_tons.toFixed(2)} t of stores aboard, under the ${safeHere.toFixed(2)} t it needs, and none may be bought here with contraband aboard`;
        this.logOnce(
          `contraband-sail:${port}>${dest}:${patrols.join(",")}:${short}`,
          `not sailing ${port} → ${dest} with ${what} (contraband) aboard: ${why}; waiting in the roadstead (run it ashore where it is wanted, or sell it at a cove, from the Underworld page)`,
        );
        if (this.lane && !this.loaded) this.host.releaseLane(this);
        await this.park(r);
        this.activity = `contraband aboard: not sailing for ${dest} (${patrols.length ? "a patrol on the route" : "stores short, none to be bought here"})`;
        return HOLD_WAIT_GAME_MIN * world.gameMinuteMs;
      }
    }

    // Stores: aim for this leg plus the laden leg after a deadhead; never sail below this leg's safe figure.
    // Rule 7: they are bought once a stay, so a retry after the berth lock only departs; still under the safe
    // figure then (a part fill, the crew eating in port), one top-up to just that.
    const then = this.lane && dest === this.lane.source ? this.lane.dest : undefined;
    const need = await this.storesTarget(port, dest, then);
    const safe = this.safeStores(port, dest, plan);
    const want = !stay.storesBought ? need : stay.storesTopped ? 0 : safe;
    if (r.stores.provisions_tons < want) {
      if (r.ship.status === "berthed") {
        if (stay.storesBought) stay.storesTopped = true;
        await this.buyStores(r, stay, storesTons(r.stores.provisions_tons, want));
        r = await this.reread();
      } else if (r.stores.provisions_tons < safe) {
        // Short of cash (or of an ask we can fill) for stores last time: dock only once a ton could be had.
        const can = stay.storesNoCash || stay.storesNoAsk ? await this.storesBuyable(port) : "ok";
        if (can !== "ok") {
          // No ask isn't no cash: the fleet's cash checks (buyer, marques, underwriting) don't wait on it.
          this.activity = `${can === "cash" ? "waiting for cash for stores" : "waiting for provisions on sale"}, in the roadstead at ${port}: ${r.stores.provisions_tons.toFixed(2)} of the ${safe.toFixed(2)} t needed for ${dest}`;
          return NO_CASH_WAIT_MS;
        }
        return this.dockOrWait(r);
      }
    }
    if (r.stores.provisions_tons < safe) {
      // No hold room (or no stores to be had): eat our own provisions cargo if we carry any. It counts as the
      // stay's stores trade.
      const own = Math.min(this.ownTons(r, STORES_GOOD), Math.ceil(safe - r.stores.provisions_tons));
      if (own > 0) {
        try {
          await client.provision(this.shipId, own, "cargo");
          stay.storesBought = true;
          this.log(`moved ${own} t of provisions cargo into the stores for ${dest}`);
          return 1_000;
        } catch (e) {
          soft(e);
          if (!isApiError(e) || e.status >= 500) throw e;
        }
      }
      this.activity = `stores ${r.stores.provisions_tons.toFixed(2)} t below the ${safe.toFixed(2)} t needed for ${dest}`;
      const free = r.effective_hold_capacity_tons - r.cargo_used_tons;
      if (r.ship.status === "berthed" && this.storesHoldNeed(r.stores.provisions_tons, safe) > free) {
        // No room to stock this leg: give the destination up so the cargo is sold or sent somewhere reachable.
        this.logOnce(`${stay.key}|hold|${dest}`, `can't stock stores for ${dest} with the hold this full; re-planning`);
        this.paxBlock(dest, "no hold left to stock the stores for the passage");
        this.host.releaseLane(this);
        // Sealed freight or a policy still binds the ship there: not every few seconds.
        return sealed.length > 0 || policy?.dest_port_id === dest ? 60_000 : 5_000;
      }
      // Topped up once already and still short: once the lock that trade set has passed, one more may go
      // (each one either filled some, or traded nothing and set no lock).
      if (stay.storesTopped && !this.locked(r)) stay.storesTopped = false;
      // No cash (or no ask we can fill) for them: wait in the roadstead, not at the berth running up its dues.
      if (stay.storesNoCash || stay.storesNoAsk) {
        await this.park(r);
        this.activity = `${stay.storesNoCash ? "waiting for cash for stores" : "waiting for provisions on sale"} at ${port}: ${r.stores.provisions_tons.toFixed(2)} of the ${safe.toFixed(2)} t needed for ${dest}`;
        return NO_CASH_WAIT_MS;
      }
      return 60_000;
    }
    // Left a convoy short of the stores its slower pace needs (FleetManager.convoyWait): one top-up to that at
    // the berth, then it joins again if it fits (sailInConvoy) or sails alone.
    if (stay.convoyNeed) {
      const top = storesTons(r.stores.provisions_tons, stay.convoyNeed);
      if (top > 0 && r.ship.status !== "berthed") return this.dockOrWait(r);
      stay.convoyNeed = 0;
      if (top > 0) {
        await this.buyStores(r, stay, top);
        r = await this.reread();
      }
    }

    // Passengers in the spare hold, for the port this voyage makes for anyway (guide 3.20): the cargo and stores are aboard by
    // now, so a boarding starves no purchase; the berth lock gives the groups a game-hour round to choose. Never stops the voyage.
    const paxReserve = Math.max(PAX_STORES_SLACK_TONS, Math.ceil(safe * PAX_STORES_SLACK_SHARE));
    // Switched off since one went up (the user, or the AI's ceiling): withdrawn, so no group boards to pin her.
    if (!this.host.settings.usePassengers) this.dropOffers("passengers switched off");
    await this.offerBerths(r, dest, stay, plan, paxReserve);

    if (this.locked(r)) {
      const wait = Date.parse(r.ship.turnaround_unlocks_at!) - world.now();
      this.activity = `berth lock: leaving for ${dest} in ${secs(wait)}`;
      return wait + 750;
    }
    // The lock clear before the first round since the offer went up: one hold where she lies (a move would close it) until just
    // after that round, when the fares it may bring beat what the wait costs.
    const paxHold = this.paxHoldMs(r, dest, stay, plan, paxReserve);
    if (paxHold > 0) {
      this.activity = `boarding passengers for ${dest}: waiting ${secs(paxHold)} for the next game-hour round`;
      return paxHold;
    }

    // Our other ships bound the same way soon: sail together (pirates board just one ship of a
    // convoy, and guns are pooled).
    if (this.noConvoyAt !== stay.key) {
      const c = await this.host.sailInConvoy(this, r, port, dest, plan);
      if (c.kind === "failed" && ARREST_RE.test(c.why)) {
        // Arrested ships can't join a convoy, nor depart (guide 3.13.1): parked, not tried again every tick.
        this.noteArrest(c.why);
        return 1_000;
      }
      if (c.kind === "failed") {
        this.log(`convoy to ${dest} not possible (${c.why}): sailing alone`);
        this.noConvoyAt = stay.key;
        return 1_000;
      }
      if (c.kind === "in") {
        this.activity = `in convoy to ${dest}, sails in ${secs(c.departsAt - world.now())}`;
        return 1_500;
      }
    }

    try {
      const res = await client.depart({ ship_id: this.shipId, dest_port_id: dest });
      this.noteDues(port, res.berth_dues_pence);
      // Departing closed our offers here on the server.
      if (this.offers.size) this.closeOffers();
      for (const w of res.warnings) {
        if (w.code !== "stores_below_safe") {
          this.log(`depart warning ${w.code}: ${w.detail}`);
          continue;
        }
        // Our plan of the route under-counted (guide 1): the server's safe figure stands from now on, and the plan is read afresh.
        world.noteSafeStores(port, dest, this.shipClass, w.safe_tons);
        world.forgetRoute(port, dest, this.shipClass);
        this.log(`WARNING: sailed for ${dest} with ${w.have_tons.toFixed(2)} t of stores, under the ${w.safe_tons.toFixed(2)} t safe figure: ${w.buy_tons} t short (${w.detail})`);
      }
      const eta = Date.parse(res.estimated_arrival_at);
      const own = Object.keys(r.cargo_manifest).reduce((n, g) => n + this.ownTons(r, g), 0);
      const heads = this.paxHeads();
      this.log(`sailing ${port} → ${dest} with ${own} t${this.freight.size ? ` + ${this.sealedTons()} t freight` : ""}${heads ? ` + ${heads} passengers` : ""}, arrives in ${secs(eta - world.now())}`);
      // depart plots its own route: one other than the plan checked for this hull is logged, over unrated water loudly.
      const sailed = res.route_legs ?? [];
      if (sailed.length && (sailed.length !== plan.legs.length || sailed.some((l, i) => l.to_node !== plan.legs[i].to_node))) {
        world.forgetRoute(port, dest, this.shipClass);
        const via = sailed.map((l) => l.to_node).join(" → ");
        if (!world.routeRated({ ...plan, legs: sailed }, hull)) {
          this.log(`WARNING: the server sailed ${port} → ${dest} by another route than the one checked, over water a ${hull} hull isn't rated for: ${via}`);
        } else {
          this.log(`the route ${port} → ${dest} changed since it was checked (now ${via}); still rated for a ${hull} hull`);
        }
      }
      this.activity = `sailing to ${dest}`;
      this.stay = null;
      // Reflect the departure for the dashboard until the next read.
      this.last = {
        ...r,
        ship: { ...r.ship, status: "sailing", current_port_id: null, leg_arrives_at: res.estimated_arrival_at },
        route_legs: res.route_legs ?? r.route_legs,
        voyage: null,
      };
      return Math.min(Math.max(eta - world.now() + 1_500, 2_000), MAX_SAIL_SLEEP_MS);
    } catch (e) {
      if (isApiError(e, "conflict")) {
        // "...in physical turnaround lock for 12s more..." — wait exactly that long.
        const m = /for (\d+)s more/.exec(e.detail);
        this.activity = `depart refused: ${e.detail}`;
        if (m) return (Number(m[1]) + 1) * 1_000;
        // Arrested for a defaulted loan (guide 3.13.1): parked until our loans show her free, never retried in a loop.
        if (ARREST_RE.test(e.detail)) {
          this.noteArrest(e.detail);
          return 1_000;
        }
        // Some other conflict (convoy state, wrong port, sealed cargo): said once a stay, the ship read again,
        // then backing off; from the third, the lane is dropped and the ship waits in the roadstead.
        const n = ++stay.departRefusals;
        if (n === 1) this.log(`depart to ${dest} refused: ${e.detail}`);
        const cur = await this.reread();
        // In a convoy after all: convoyWait takes it from the next tick, after the usual backoff (never a 1 s loop).
        if (cur.ship.convoy_id) return Math.min(60_000, 15_000 * n);
        if (this.locked(cur)) return Math.max(0, Date.parse(cur.ship.turnaround_unlocks_at!) - world.now()) + 1_000;
        if (n >= 3) {
          if (n === 3) this.log(`depart to ${dest} refused ${n}× (${e.detail}): ${this.loaded ? "keeping the loaded lane" : "dropping the lane"} and waiting in the roadstead`);
          // A loaded lane keeps its cargo and charter room.
          if (this.lane && !this.loaded) this.host.releaseLane(this);
          await this.park(cur);
        }
        return Math.min(60_000, 15_000 * n);
      }
      if (isApiError(e, "insufficient_provisions")) {
        const short = (e.body as { provisions_shortfall?: { buy_provisions_tons?: number } }).provisions_shortfall;
        if (stay.provisionRefusals === 0) this.log(`depart refused, stores short: ${e.detail}`);
        // Our plan of this route was stale: read it afresh.
        world.forgetRoute(port, dest, this.shipClass);
        // depart may sail another route than the plan: what it found short stands as this route's safe floor from now
        // on, so the stores path above (with its roadstead wait while there's no cash or ask) keeps to it.
        const floor = r.stores.provisions_tons + (short?.buy_provisions_tons ?? 1);
        world.noteSafeStores(port, dest, this.shipClass, Math.max(world.safeFloor(port, dest, this.shipClass), floor));
        if (r.ship.status !== "berthed") return this.dockOrWait(r);
        const fresh = await world.route(port, dest, this.shipClass).catch((err: unknown) => {
          soft(err);
          return null;
        });
        // The shortfall, or up to the fresh safe figure if that is more: never the whole target on top of it.
        const tons = Math.max(short?.buy_provisions_tons ?? 1, fresh ? storesTons(r.stores.provisions_tons, this.safeStores(port, dest, fresh)) : 0, 1);
        stay.storesTopped = true;
        stay.provisionRefusals++;
        const got = await this.buyStores(r, stay, tons);
        if (got <= 0) {
          // A loaded lane keeps its cargo and charter room (re-taking it as a leftover would only loop back here).
          this.logOnce(`${stay.key}|provisions|${dest}`, `can't stock the stores ${dest} needs yet (refused ${stay.provisionRefusals}×)${this.loaded ? "" : ": dropping the lane"}`);
          if (this.lane && !this.loaded) this.host.releaseLane(this);
          await this.park(r);
          // Backing off: sealed freight or a policy may still bind the ship there.
          return Math.min(60_000, 5_000 * stay.provisionRefusals);
        }
        return 2_000;
      }
      throw e;
    }
  }
}
