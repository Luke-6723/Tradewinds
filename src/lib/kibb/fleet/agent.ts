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
 */

import { isApiError, KibbApiError, type KibbClient } from "../client";
import type { BankingRegion, ContractListing, DeliverCharterResult, OrderBookLevel, RoutePlan, ShipResult } from "../types";
import type { FleetSettings } from "./manager";
import { cargoLane, HOLD_MAX_GAME_H, REPOST_GRACE_GAME_MIN, type FreightPick, type Lane, type Part } from "./planner";
import type { World } from "./world";

const POLL_MS              = 15_000;
const MAX_SAIL_SLEEP_MS    = 60_000;
// Idle re-checks are short: events (arrivals, new charters, deliveries paying) wake ships at once,
// and these are only the fallback when nothing does.
const IDLE_WAIT_MS         = 30_000;
const NO_CASH_WAIT_MS      = 30_000;
/** Between tenders of freight the issuer refused (it has no warehouse space yet). */
const STAND_BY_MS          = 60_000;
/** Holding leftovers for a fair bid: NPC buyers re-quote every 6 game hours (6 real min at 60×). */
const HOLD_WAIT_MS         = 3 * 60_000;
const ERROR_BACKOFF_MS     = 30_000;
/** A lane that just failed at its source is skipped for one NPC re-quote (6 game hours at 60×). */
const LANE_COOLDOWN_MS     = 6 * 60_000;
/** Fewest tons worth holding a whole ship for a stalled charter's re-post. */
const MIN_HOLD_TONS        = 3;
/** Stores kept beyond the next legs' safe figures, in game days of eating in port. */
const STORES_BUFFER_DAYS   = 2;
const STORES_GOOD          = "provisions";
const GUN_PRICE_PENCE      = 15_000;
/** Value of a ship-hour when nothing better is known, for weighing detours (pence). */
const DEFAULT_RATE_PER_HOUR = 300_000;
/** Holds at an unfair market before carrying leftovers to the best market elsewhere. */
const MAX_HOLDS            = 2;
/** Market goods are sold down to this far below the price the planner expected, no further. */
const SELL_FLOOR_DROP      = 0.12;
const FATAL_CODES          = ["account_suspended", "company_frozen"];
/** Delivery refusals that mean the contract itself is gone, not that our cargo was refused. */
const CLOSED_RE            = /complet|closed|filled|expired|cancel|not open|no longer|no remaining|defaulted|breach/i;

export interface FleetHost {
  readonly world: World;
  readonly client: KibbClient;
  readonly settings: FleetSettings;
  log(source: string, msg: string): void;
  fatal(msg: string): void;
  /** Picks, reserves and returns the best lane for this ship from `from` (null: nothing pays). */
  assignLane(agent: ShipAgent, from: string, r: ShipResult): Promise<Lane | null>;
  releaseLane(agent: ShipAgent): void;
  /** Cash spendable in a region after its floor, topping it up from other regions if short. */
  ensureCash(region: BankingRegion, amount: number): Promise<number>;
  /** Runs `fn` holding the company's cash lock, so raising cash and spending it can't interleave. */
  withCash<T>(fn: () => Promise<T>): Promise<T>;
  /** Called while this ship gives us presence at a shipyard: the buyer's chance to build there. */
  visitShipyard(port: string): Promise<void>;
  /** Guns this ship should carry after a refit here, or undefined to leave them as they are. */
  gunTarget(agent: ShipAgent, r: ShipResult): Promise<number | undefined>;
  noteArmed(shipId: string, costPence: number): void;
  /** Money landed in a region (a delivery paid): ships waiting for cash can try again. */
  cashArrived(): void;
  /** Room in a charter this ship may deliver into, after other ships' loaded cargo for it. */
  charterRoomFor(agent: ShipAgent, charterId: string, remaining: number): number;
  /** Whether another ship's lane means to take this freight lot. */
  freightClaimed(agent: ShipAgent, id: string): boolean;
  /** Another of our ships' hold at this port on this good for a re-post, if any. */
  siblingHold(agent: ShipAgent, port: string, good: string): HoldInfo | undefined;
  /** The AI's call on a stalled expansion charter here: hold for its re-post ("wait") or not ("deliver"). */
  stallCall(port: string, good: string): "wait" | "deliver" | undefined;
  /** The fleet's progress changed: save it (`now` for a trip, a load or a delivery). */
  persist(now?: boolean): void;
  /** A trip finished: add it to the saved history. */
  tripFinished(agent: ShipAgent, trip: TripRecord & { goods: string[]; spentPence: number; rewardPence: number }): void;
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
  } | null;
  lane: Lane | null;
  laneLoaded: string | null;
  laneKey: string | null;
  laneSince: number;
  minSale: Array<[string, number]>;
  avoid: Array<[string, number]>;
  ratePerHour: number;
  freight: Array<[string, CarriedFreight]>;
}

/** Cargo held for an expansion charter's re-post. */
export interface HoldInfo {
  /** The posting held for, and its lapse (server ms). */
  id: string;
  expiresAt: number;
  /** When the hold ends at the latest. */
  until: number;
  /** A stalled posting lapsing soon, or a load that landed just after a lapse. */
  why: "stall" | "lapse";
}

export interface AgentStats {
  trips: number;
  deliveredTons: number;
  rewardPence: number;
  spentPence: number;
  freightPence: number;
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
}

const IDLE_RE = /^(no lane pays|waiting for cash|standing by|holding)/;
const TRIP_HISTORY = 8;

export interface CarriedFreight {
  dest: string;
  good: string;
  tons: number;
  reward: number;
  deadline: string | null;
  /** Server time the issuer last refused the tender at `dest`. */
  refusedAt?: number;
  /** Delivery was rejected outright: keep counting the sealed tons, stop sailing for it. */
  undeliverable?: boolean;
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
}

const secs = (ms: number) => `${Math.max(0, Math.round(ms / 1000))}s`;
const cr = (pence: number) => `${(pence / 100).toLocaleString("en-GB", { maximumFractionDigits: 2 })} Cr`;

export class ShipAgent {
  lane: Lane | null = null;
  activity = "starting";
  stats: AgentStats = { trips: 0, deliveredTons: 0, rewardPence: 0, spentPence: 0, freightPence: 0 };
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
  /** Consecutive holds with leftovers at a market that won't pay fairly. */
  private holds = 0;
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
  } | null = null;
  /** The lane whose cargo was loaded at its source: arriving at its destination completes it. */
  private laneLoaded: string | null = null;
  /** Lowest price per ton each good aboard may be sold at (its landed cost, or the market floor). */
  private readonly minSale = new Map<string, number>();
  private readonly trips: TripRecord[] = [];
  /** Restored from a snapshot: the first tick checks the lane still fits the ship. */
  private checkRestored = false;
  /** A restored lane part-bought at this port: its goods aboard count as bought here. */
  private resumeAt: string | null = null;

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
  }

  /** After a restart: keep the restored lane only if its cargo (or freight) is still aboard, or nothing was loaded yet but some was bought. */
  private checkRestoredLane(r: ShipResult): void {
    this.checkRestored = false;
    const lane = this.lane;
    if (!lane) return;
    const goods = this.laneGoodsAboard(r, lane);
    const freight = lane.freight.some((f) => this.freight.has(f.id));
    if (goods > 0 || freight) {
      this.log(`resumed lane ${lane.key}${this.laneLoaded === lane.key ? " (loaded)" : " (part loaded)"}`);
      // Part bought at the source: what's aboard was bought there, so loading carries on from it.
      if (this.laneLoaded !== lane.key && r.ship.status !== "sailing" && r.ship.current_port_id === lane.source) this.resumeAt = lane.source;
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
    };
    this.trips.push(rec);
    if (this.trips.length > TRIP_HISTORY) this.trips.splice(0, this.trips.length - TRIP_HISTORY);
    this.host.tripFinished(this, { ...rec, goods: [...t.goods], spentPence: t.spent, rewardPence: t.reward });
    this.host.persist(true);
  }

  /** Tons of this good aboard that belong to us (not sealed freight). */
  ownTons(r: ShipResult, good: string): number {
    let sealed = 0;
    for (const f of this.freight.values()) if (f.good === good) sealed += f.tons;
    return Math.max(0, (r.cargo_manifest[good] ?? 0) - sealed);
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

  /** Tons of this lane's goods aboard (sealed freight excluded). */
  private laneGoodsAboard(r: ShipResult, lane: Lane | null = this.lane): number {
    return lane ? lane.parts.reduce((n, p) => n + this.ownTons(r, p.good), 0) : 0;
  }

  /** Starts the trip record for the lane at its first purchase or freight lot. */
  private ensureTrip(r: ShipResult, lane: Lane): NonNullable<ShipAgent["trip"]> {
    // A trip of the same lane whose cargo never arrived (charter filled, sold off) is stale.
    const stale = this.trip?.key === lane.key && this.laneGoodsAboard(r, lane) === 0 && ![...this.trip.freightIds].some((id) => this.freight.has(id));
    if (!this.trip || this.trip.key !== lane.key || stale) {
      this.trip = {
        key: lane.key,
        label: `${lane.good} ${lane.source} → ${lane.dest}`,
        goods: new Set(lane.parts.map((p) => p.good)),
        freightIds: new Set(),
        // Cash only (the phase bonus comes later) and up to delivery, like what a trip makes.
        est: (lane.cashProfit * 3_600_000) / Math.max(lane.deliverMs, 60_000),
        startedAt: this.laneKey === lane.key && this.laneSince ? this.laneSince : Date.now(),
        spent: 0,
        reward: 0,
        tons: 0,
      };
    }
    return this.trip;
  }

  /** True while waiting for cash to buy a load. */
  get waitingForCash(): boolean {
    return this.activity.startsWith("waiting for cash");
  }

  /** True while idle because no lane pays. */
  get idle(): boolean {
    return this.activity.startsWith("no lane pays");
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
      try {
        wait = await this.tick();
      } catch (e) {
        if (isApiError(e) && (e.status === 401 || FATAL_CODES.includes(e.code ?? ""))) {
          this.host.fatal(e.message);
          return;
        }
        this.log(`tick failed: ${(e as Error).message}`);
        wait = ERROR_BACKOFF_MS;
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
   * listed before and no longer does (settled), and drops lots a game day past their deadline.
   */
  private async syncFreight(): Promise<void> {
    try {
      const active = (await this.host.client.contractPages({ contract_type: "freight", status: "active" })).items;
      const mine = active.filter((x) => x.carrier_ship_id === this.shipId);
      const ids = new Set(mine.map((c) => c.id));
      for (const c of mine) this.trackFreight(c);
      for (const id of [...this.freight.keys()]) {
        if (this.listedFreight.has(id) && !ids.has(id)) {
          const f = this.freight.get(id)!;
          this.log(`freight to ${f.dest} is no longer active; treating the ${f.tons} t ${f.good} as settled`);
          this.freight.delete(id);
        }
      }
      this.listedFreight.clear();
      for (const id of ids) this.listedFreight.add(id);
      this.freightSynced = true;
    } catch (e) {
      this.log(`could not list carried freight yet: ${(e as Error).message}`);
    }
    const now = this.host.world.now();
    for (const [id, f] of this.freight) {
      if (f.deadline && Date.parse(f.deadline) + 24 * 60 * this.host.world.gameMinuteMs < now) {
        this.log(`freight to ${f.dest} is past its deadline; treating the ${f.tons} t ${f.good} as settled`);
        this.freight.delete(id);
      }
    }
  }

  private trackFreight(c: ContractListing): void {
    if (!c.dest_port_id || !c.commodity_id || this.freight.has(c.id)) return;
    this.freight.set(c.id, {
      dest: c.dest_port_id,
      good: c.commodity_id,
      tons: c.quantity_required,
      reward: c.reward_pence,
      deadline: c.expires_at ?? null,
    });
  }

  /** The freight destination to make for next: earliest deadline first. */
  private freightDestination(here: string): string | null {
    const lots = [...this.freight.values()].filter((f) => f.dest !== here && !f.undeliverable);
    if (lots.length === 0) return null;
    lots.sort((a, b) => (a.deadline ? Date.parse(a.deadline) : Infinity) - (b.deadline ? Date.parse(b.deadline) : Infinity));
    return lots[0].dest;
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
    if (!this.freightSynced) await this.syncFreight();
    if (this.checkRestored && this.freightSynced) this.checkRestoredLane(r);
    for (const good of [...this.minSale.keys()]) if (this.ownTons(r, good) <= 0) this.minSale.delete(good);

    if (s.status === "sailing") {
      this.stay = null;
      if (!this.lane && this.freightSynced) this.adoptCargoLane(r);
      const eta = Date.parse(r.voyage?.estimated_arrival_at ?? s.leg_arrives_at ?? "") || 0;
      const ms = eta ? eta - world.now() : POLL_MS;
      this.activity = `sailing to ${r.route_legs.at(-1)?.to_node ?? "?"}, arrives in ${secs(ms)}`;
      return Math.min(Math.max(ms + 1_500, 2_000), MAX_SAIL_SLEEP_MS);
    }

    const port = s.current_port_id;
    if (!port) return POLL_MS;
    if (!this.stay || this.stay.port !== port) {
      this.stay = { port, key: `${port}@${Date.now()}`, scouted: false, traded: new Set(), boughtHere: new Map(), refused: new Set(), holds: new Map() };
      if (this.resumeAt === port && this.lane) {
        for (const p of this.lane.parts) {
          const t = this.ownTons(r, p.good);
          if (t > 0) this.stay.boughtHere.set(p.good, t);
        }
      }
      this.resumeAt = null;
      await this.syncFreight();
      await this.refreshPortCharters(port);
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
    this.host.releaseLane(this);
    this.stopRequested = true;
    return 0;
  }

  /** After a restart mid-voyage: rebuild the lane so its charter room stays reserved. */
  private adoptCargoLane(r: ShipResult): void {
    const dest = r.route_legs.at(-1)?.to_node;
    if (!dest) return;
    for (const good of Object.keys(r.cargo_manifest)) {
      const tons = this.ownTons(r, good);
      const c = this.host.world.charters.filter((x) => x.port === dest && x.good === good).sort((a, b) => b.payPerTon - a.payPerTon)[0];
      if (tons <= 0 || !c) continue;
      this.lane = cargoLane(good, r.route_legs[0]?.from_node ?? dest, dest, c.id, Math.min(tons, c.remaining), c.payPerTon);
      this.laneLoaded = this.lane.key;
      return;
    }
  }


  private async refreshPortCharters(port: string): Promise<void> {
    try {
      const list = await this.host.client.listContracts({ contract_type: "charter", port_id: port, status: "open", limit: 200 });
      this.host.world.mergePortCharters(port, list);
    } catch {
      // Keep the manager's last listing.
    }
  }

  private async atPort(r: ShipResult, stay: Stay): Promise<number> {
    const { world, client } = this.host;
    const port = stay.port;
    const atYard = !!world.port(port)?.has_shipyard;

    if (!stay.scouted) {
      stay.scouted = true;
      await this.scout(port);
    }

    // 1. Freight that ends here (works from the roadstead).
    let refusedHere = false;
    let freightChanged = false;
    for (const [id, f] of [...this.freight].filter(([, x]) => x.dest === port && !x.undeliverable)) {
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
    // Held goods wait for their re-post (ours, or another of our ships' here: delivering would end
    // the stall); the rest is delivered now (never into a lapsed posting).
    const deliverNow = (good: string) => (stay.holds.has(good) || this.host.siblingHold(this, port, good) ? 0 : deliverable(good));
    const nowMs = world.now();
    const due = world.charters.filter(
      (c) =>
        c.port === port && (c.expiresAt === null || c.expiresAt > nowMs) && this.roomIn(c) > 0 && !stay.refused.has(c.id) && deliverNow(c.good) > 0,
    );
    // Market goods still to sell here need the berth: don't leave it to deliver from the roadstead.
    const sellingHere =
      this.loaded && this.lane!.dest === port && !stay.traded.has("sold") && this.lane!.parts.some((p) => p.kind === "market" && this.ownTons(r, p.good) > 0);
    if (due.length > 0) {
      const s = r.ship;
      const roomByGood = new Map<string, number>();
      for (const c of due) roomByGood.set(c.good, (roomByGood.get(c.good) ?? 0) + this.roomIn(c));
      const tons = [...roomByGood].reduce((n, [good, room]) => n + Math.min(deliverable(good), room), 0);
      if (s.status === "berthed" && !sellingHere) {
        const lockLeft = s.turnaround_unlocks_at ? Date.parse(s.turnaround_unlocks_at) - world.now() : 0;
        // At the berth each ton delivered extends the lock; from the roadstead it doesn't.
        if (tons * world.handlingMsPerTon(port) > Math.max(lockLeft, 0) + 5_000) {
          if (lockLeft > 0) {
            this.activity = `waiting ${secs(lockLeft)} for the berth lock, then delivering from the roadstead`;
            return lockLeft + 1_000;
          }
          try {
            await client.offshore(this.shipId);
            this.log(`moved to the roadstead at ${port} to deliver without the per-ton berth lock`);
          } catch (e) {
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
      if (r.ship.status === "berthed" && !this.locked(r)) await client.offshore(this.shipId).catch(() => undefined);
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
      if (r.ship.status === "berthed" && !this.locked(r)) await client.offshore(this.shipId).catch(() => undefined);
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

    // 3. Where next. Sealed freight decides first.
    const pinned = this.freightDestination(port);
    if (pinned) {
      // A loaded lane keeps its cargo and charter room: it is finished at its destination later.
      if (this.lane && !this.loaded && this.lane.source !== pinned) this.host.releaseLane(this);
      await yardVisit();
      return this.sailTo(r, pinned, stay);
    }
    // At the source of the lane we hold: load (keeping the lane, whose charter may only be visible
    // from its own port), topping up whatever of the good is already aboard.
    if (this.lane && this.lane.source === port && this.laneLoaded !== this.lane.key && !stay.traded.has("cargo") && !this.isAvoided(this.lane.key)) {
      // The lane was planned a while ago: a charter main must still have room for most of its load.
      const main = this.lane.kind === "charter" ? this.lane.parts[0] : null;
      if (!main || this.liveTons(main) >= Math.min(10, main.tons / 2)) {
        await yardVisit();
        return this.loadAt(await this.reread(), this.lane, stay);
      }
      this.host.releaseLane(this);
    }
    if (this.lane && this.laneLoaded === this.lane.key && this.lane.dest !== port) {
      await yardVisit();
      return this.sailTo(r, this.lane.dest, stay);
    }
    for (const good of Object.keys(r.cargo_manifest)) {
      if (this.ownTons(r, good) <= 0) continue;
      const wait = await this.handleLeftover(r, good, stay);
      if (wait !== null) return wait;
    }
    this.holds = 0;

    let lane = await this.host.assignLane(this, port, r);
    // Guns suit a lane: refit for the new one while still at the yard, then size the load to the new room.
    if (lane && atYard && (await this.refitGuns(r, stay))) {
      r = await this.reread();
      lane = await this.host.assignLane(this, port, r);
    }
    await yardVisit();
    if (!lane) {
      this.activity = "no lane pays right now; waiting";
      if (r.ship.status === "berthed" && !this.locked(r)) await client.offshore(this.shipId).catch(() => undefined);
      return IDLE_WAIT_MS;
    }
    if (lane.source === port) return this.loadAt(await this.reread(), lane, stay);
    await this.takeFreight(r, lane.source, stay);
    return this.sailTo(await this.reread(), lane.source, stay);
  }

  private async reread(): Promise<ShipResult> {
    this.last = await this.host.client.ship(this.shipId);
    return this.last;
  }

  private locked(r: ShipResult): boolean {
    const u = r.ship.turnaround_unlocks_at;
    return r.ship.status === "berthed" && !!u && Date.parse(u) > this.host.world.now();
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
    if (stay.traded.has("arm") || r.ship.status !== "berthed") return false;
    // The guns were chosen for the passage this cargo makes: don't change them under it.
    if (stay.traded.has("cargo") || (this.lane && this.laneLoaded === this.lane.key) || this.laneGoodsAboard(r) > 0) return false;
    const target = await this.host.gunTarget(this, r);
    const now = r.ship.cannons_count;
    if (target === undefined || target === now) return false;
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
        if (!isApiError(e) || e.status >= 500) throw e;
        this.log(`refit to ${target} guns refused: ${e.message}`);
        return false;
      }
    });
  }

  // ── Loading ─────────────────────────────────────────────────────────────────

  private async loadAt(r: ShipResult, lane: Lane, stay: Stay): Promise<number> {
    if (stay.traded.has("cargo")) return this.sailTo(r, lane.dest, stay);
    const { world } = this.host;
    if (r.ship.status !== "berthed") {
      // Docking costs a berth stay: only when at least a ton (or the freight's collateral) can be paid for.
      const need = Math.max(lane.parts[0]?.costPerTon ?? 0, lane.freight[0]?.collateral ?? 0, 1);
      if ((await this.host.ensureCash(world.region(lane.source), need)) < need) {
        this.host.releaseLane(this);
        this.activity = "waiting for cash to buy a load";
        return NO_CASH_WAIT_MS;
      }
      return this.dockOrWait(r);
    }

    const trimmed = await this.trimStores(r, lane, stay);
    await this.topUpStoresFor(await this.reread(), lane.source, lane.dest, stay, lane.source);
    r = await this.reread();

    // The main cargo first: without it the lane is off.
    const extras = lane.kind === "freight" ? lane.parts : lane.parts.slice(1);
    if (lane.kind === "freight") {
      const got = await this.acceptLaneFreight(r, lane, stay);
      if (got.taken === 0) {
        this.host.releaseLane(this);
        if (got.cashShort) {
          this.activity = "waiting for cash for freight collateral";
          return NO_CASH_WAIT_MS;
        }
        this.avoid.set(lane.key, world.now() + LANE_COOLDOWN_MS * (60 / world.timeScale));
        this.activity = "re-planning: the freight lots were taken or don't fit";
        return 3_000;
      }
    } else {
      const main = lane.parts[0];
      const res = await this.buyPart(r, lane, main, stay);
      // Bought on an earlier tick of this stay (a later step failed): carry on loading.
      if (res.bought === 0 && (stay.boughtHere.get(main.good) ?? 0) === 0) {
        // Put surplus stores moved into cargo back: they were only worth carrying with a load.
        if (trimmed > 0) {
          await this.host.client.provision(this.shipId, trimmed, "cargo").catch(() => undefined);
          stay.boughtHere.set(STORES_GOOD, Math.max(0, (stay.boughtHere.get(STORES_GOOD) ?? 0) - trimmed));
        }
        this.host.releaseLane(this);
        if (res.reason === "cash") {
          this.activity = "waiting for cash to buy a load";
          if (!this.locked(r)) await this.host.client.offshore(this.shipId).catch(() => undefined);
          return NO_CASH_WAIT_MS;
        }
        this.avoid.set(lane.key, world.now() + LANE_COOLDOWN_MS * (60 / world.timeScale));
        this.activity = `re-planning: ${res.reason}`;
        return 3_000;
      }
    }
    // Then the rest of the load: other goods, and freight lots for the same destination.
    for (const p of extras) await this.buyPart(await this.reread(), lane, p, stay);
    // Never sell any of it for less than it cost to land (or, for market goods, the planned floor).
    for (const p of lane.parts) {
      const floor = Math.max(p.costPerTon, p.kind === "market" ? Math.round(p.pay * (1 - SELL_FLOOR_DROP)) : 0);
      if (floor > 0) this.minSale.set(p.good, Math.max(this.minSale.get(p.good) ?? 0, floor));
    }
    if (lane.kind !== "freight" && lane.freight.length > 0) await this.acceptLaneFreight(await this.reread(), lane, stay);
    stay.traded.add("cargo");
    this.laneLoaded = lane.key;
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

  /** Buys one good of the lane's load, up to its break-even price and the room left for it. */
  private async buyPart(r: ShipResult, lane: Lane, part: Part, stay: Stay): Promise<{ bought: number; reason: string }> {
    const { client, world, settings } = this.host;
    const port = lane.source;
    const good = part.good;
    const want = Math.min(part.tons, this.liveTons(part)) - this.ownTons(r, good);
    if (want < 1) return { bought: 0, reason: `no room left in the ${good} charters` };
    // Room for the cargo after the whole tons of stores the voyage still needs.
    const storesTarget = await this.storesTarget(lane.source, lane.dest, lane.source);
    const storesRoom = this.storesHoldNeed(r.stores.provisions_tons, storesTarget);
    return this.host.withCash(async () => {
      const book = await client.book(port, good);
      world.observeBook(book);
      const b = book.books.find((x) => x.commodity_id === good);
      if (!b?.best_ask) {
        world.observeNoAsk(port, good, b?.best_bid ?? null);
        return { bought: 0, reason: `no ${good} on offer at ${port}` };
      }

      const customs = 1 + book.customs_bps / 10_000;
      const fee = 1 + world.remitBps(world.region(lane.dest), world.region(port)) / 10_000;
      // Every ton must clear the margin against the lowest-value use in this part, after the share
      // pirates are expected to take; and the phase bonus may pick a charter, but never pay more
      // than its cash covers (the bonus is paid later, and only if the tier completes).
      const kept = 1 - (lane.piracyBps ?? 0) / 10_000;
      const limit = Math.floor(Math.min((part.minPay - settings.minMarginPence) * kept, part.cashPay * kept) / (customs * fee));
      if (b.best_ask.price_pence > limit) {
        this.log(`${good} at ${port} asks ${cr(b.best_ask.price_pence)}/t, above the ${cr(limit)}/t break-even for ${lane.dest}`);
        return { bought: 0, reason: `${good} too dear at ${port}` };
      }
      const room = Math.min(r.effective_hold_capacity_tons - r.cargo_used_tons - storesRoom, want);
      if (room <= 0) return { bought: 0, reason: "no room" };

      // Price `n` tons by walking the visible ask ladder up to the limit (beyond it: at the limit).
      const asks: OrderBookLevel[] = (b.depth?.asks ?? []).filter((l) => l.price_pence <= limit).sort((x, y) => x.price_pence - y.price_pence);
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
      const cash = await this.host.ensureCash(world.region(port), costFor(room));
      let qty = room;
      while (qty > 0 && costFor(qty) > cash) qty--;
      if (qty <= 0) {
        this.log(`not enough cash in ${world.region(port)} for ${good} at ${port}`);
        return { bought: 0, reason: "cash" };
      }

      try {
        const use = part.kind === "market" ? `sells ~${cr(part.pay)}/t at ${lane.dest}` : `pays ${cr(part.pay)}/t at ${lane.dest}`;
        this.log(`bid ${qty} t ${good} at ${port} ≤ ${cr(limit)}/t (ask ${cr(b.best_ask.price_pence)}, ${use})`);
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
        this.stats.spentPence += paid;
        world.vaults.set(world.region(port), world.vault(world.region(port)) - paid);
        stay.boughtHere.set(good, (stay.boughtHere.get(good) ?? 0) + res.filled_quantity);
        if (res.filled_quantity > 0) {
          const trip = this.ensureTrip(r, lane);
          trip.spent += paid;
          trip.tons += res.filled_quantity;
        }
        this.log(`bought ${res.filled_quantity}/${qty} t for ${cr(paid)} (${cr(res.filled_quantity ? paid / res.filled_quantity : 0)}/t landed)`);
        return { bought: res.filled_quantity, reason: res.filled_quantity ? "ok" : "nothing filled" };
      } catch (e) {
        if (isApiError(e) && e.status === 400) {
          this.log(`buy refused: ${e.message}`);
          return { bought: 0, reason: "refused" };
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
  private async acceptLaneFreight(r: ShipResult, lane: Lane, stay: Stay): Promise<{ taken: number; cashShort: boolean }> {
    const port = stay.port;
    const need = await this.storesTarget(port, lane.dest, lane.source);
    let room = r.effective_hold_capacity_tons - r.cargo_used_tons - this.storesHoldNeed(r.stores.provisions_tons, need);
    let taken = 0;
    let cashShort = false;
    for (const f of lane.freight) {
      if (this.freight.has(f.id) || f.tons > room) continue;
      const res = await this.acceptFreightLot(port, f.id, f.collateral, r, lane);
      if (res === "taken") {
        taken++;
        room -= f.tons;
      } else if (res === "cash") cashShort = true;
    }
    return { taken, cashShort };
  }

  /** Accepts one freight lot onto this ship (collateral from the port's region). */
  private async acceptFreightLot(port: string, id: string, collateral: number, r: ShipResult, lane: Lane | null): Promise<"taken" | "cash" | "no"> {
    const { client, world } = this.host;
    return this.host.withCash(async () => {
      const cash = await this.host.ensureCash(world.region(port), collateral);
      if (cash < collateral) return "cash";
      try {
        const res = await client.acceptFreight(id, this.shipId);
        this.freight.set(id, { dest: res.dest_port_id, good: res.commodity_id, tons: res.quantity, reward: res.reward_pence, deadline: res.delivery_deadline });
        world.dropFreight(id);
        world.vaults.set(world.region(port), world.vault(world.region(port)) - res.collateral_pence);
        if (lane && res.dest_port_id === lane.dest) {
          const trip = this.ensureTrip(r, lane);
          trip.freightIds.add(id);
          trip.tons += res.quantity;
        }
        this.log(`took freight: ${res.quantity} t ${res.commodity_id} ${port} → ${res.dest_port_id} for ${cr(res.reward_pence)} (collateral ${cr(res.collateral_pence)})`);
        return "taken";
      } catch (e) {
        const unknown = !isApiError(e) || e.status >= 500 || e.code === "idempotency_request_in_flight" || e.status === 429;
        if (!unknown && e.status !== 401) {
          world.dropFreight(id);
          this.log(`freight ${id.slice(0, 8)} not taken: ${(e as Error).message}`);
          return "no";
        }
        // Unknown outcome: the server may have bound it to us. Re-sync before going on.
        this.freightSynced = false;
        throw e;
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
    if (r.ship.status !== "berthed") return this.dockOrWait(r);
    stay.traded.add("sold");
    const { world } = this.host;
    for (const p of parts) {
      const tons = this.ownTons(r, p.good) - (stay.boughtHere.get(p.good) ?? 0);
      const floor = Math.max(this.minSale.get(p.good) ?? 0, Math.round(p.pay * (1 - SELL_FLOOR_DROP)), Math.round(world.basePrice(p.good) * 0.5));
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
      .filter((c) => c.port === port && (c.expiresAt === null || c.expiresAt > now) && !stay.refused.has(c.id) && this.roomIn(c) > 0)
      .sort((a, b) => b.payPerTon - a.payPerTon);

    // Several charters at once: one all-or-nothing batch call; on any refusal, one at a time below.
    const plan: Array<{ c: (typeof charters)[number]; qty: number }> = [];
    const left = new Map<string, number>();
    for (const c of charters) {
      const have = left.get(c.good) ?? deliverable(c.good);
      const qty = Math.min(have, this.roomIn(c));
      if (qty <= 0) continue;
      plan.push({ c, qty });
      left.set(c.good, have - qty);
    }
    if (plan.length > 1 && plan.length <= 25) {
      try {
        const results = await client.deliverCharters(plan.map(({ c, qty }) => ({ contract_id: c.id, quantity: qty, ship_id: this.shipId })));
        results.forEach((res, i) => {
          const c = plan.find((x) => x.c.id === res.contract_id)?.c ?? plan[i]?.c;
          if (c) delivered += this.recordDelivery(r, port, c, res);
        });
        // A charter may have taken less than asked: the pass below offers the rest to the others.
      } catch (e) {
        if (!(e instanceof KibbApiError) || e.status >= 500) throw e;
        if (e.status === 401 || e.status === 403 || FATAL_CODES.includes(e.code ?? "")) throw e;
        if (e.status === 429 || e.code === "idempotency_request_in_flight") return { delivered, retry: true };
        // Nothing applied: find the refusal one charter at a time.
      }
    }

    for (const c of charters) {
      const qty = Math.min(deliverable(c.good), this.roomIn(c));
      if (qty <= 0) continue;
      try {
        const res = await client.deliverCharter({ contract_id: c.id, quantity: qty, ship_id: this.shipId });
        delivered += this.recordDelivery(r, port, c, res);
      } catch (e) {
        if (!(e instanceof KibbApiError) || e.status >= 500) throw e;
        if (e.status === 401 || e.status === 403 || FATAL_CODES.includes(e.code ?? "")) throw e;
        if (e.status === 429 || e.code === "idempotency_request_in_flight") {
          retry = true;
          break;
        }
        if (e.status === 404 || ((e.status === 400 || e.status === 409) && CLOSED_RE.test(e.detail))) {
          c.remaining = 0;
          world.markClosed(c.id);
          this.log(`${c.title} is closed: ${e.detail}`);
        } else {
          stay.refused.add(c.id);
          this.log(`${c.title} refused our ${c.good}: ${e.message}`);
        }
      }
    }
    if (delivered > 0) this.host.cashArrived();
    return { delivered, retry };
  }

  /**
   * Keeps the stay's holds for stalled charters' re-posts current: lists the port again once a held
   * posting has lapsed (so its re-post shows), drops a hold once the re-post is listed, the stall
   * breaks or the hold runs out, and starts new ones where this ship's voyage ends.
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
      // Before the lapse, a stall hold stands only while its reasons do (still listed and stalled,
      // holding still on, the tier not completing first).
      if (!drop && h.why === "stall" && now < h.expiresAt) {
        const c = world.charters.find((x) => x.id === h.id);
        drop = !c || this.holdFor(c, deliverable(good)) === null;
      }
      if (drop) {
        stay.holds.delete(good);
        if (!reposted && now >= h.until) this.log(`no re-post of the ${good} charter at ${port} turned up in time: delivering what is open`);
      }
    }
    // Only where this ship's voyage ends: not at the source of a lane it is about to load.
    const endsHere = this.loaded ? this.lane!.dest === port : !this.lane;
    if (!endsHere) return;
    for (const c of world.charters) {
      if (c.port !== port || stay.holds.has(c.good) || stay.refused.has(c.id) || this.roomIn(c) <= 0) continue;
      const tons = deliverable(c.good);
      if (tons < MIN_HOLD_TONS) continue;
      const until = this.holdFor(c, tons);
      if (until === null) continue;
      stay.holds.set(c.good, { id: c.id, expiresAt: c.expiresAt!, until, why: "stall" });
      this.log(`holding ${tons} t ${c.good} at ${port} for ${secs(until - now)}: ${c.title} is stalled and re-posts richer when it lapses`);
    }
    // Another of our ships here is holding a good we carry too: hold it alongside, not deliver it
    // (that would end the stall) nor sell it off.
    for (const good of Object.keys(this.last?.cargo_manifest ?? {})) {
      if (stay.holds.has(good) || deliverable(good) <= 0) continue;
      const sib = this.host.siblingHold(this, port, good);
      if (sib) stay.holds.set(good, { ...sib });
    }
    // A load planned on an expansion charter that landed just after it lapsed (whatever the hold
    // setting): wait out the grace for its re-post rather than selling the cargo off.
    if (!this.loaded) return;
    for (const p of this.lane!.parts) {
      if (p.kind !== "charter" || stay.holds.has(p.good) || deliverable(p.good) <= 0) continue;
      if (world.charters.some((c) => c.port === port && c.good === p.good && (c.expiresAt === null || c.expiresAt > now) && this.roomIn(c) > 0)) continue;
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
   * Server time to hold `tons` for this charter until (its re-post), or null to deliver now: holding
   * is on, the charter is a stalled expansion posting lapsing within the hold window, and the tier
   * isn't about to complete first (its charters end with it).
   */
  private holdFor(c: World["charters"][number], tons: number): number | null {
    const { world, settings } = this.host;
    // Holding is on for all stalled postings, or the AI called this one; an AI "deliver" call vetoes it.
    const call = this.host.stallCall(c.port, c.good);
    if (call === "deliver" || (!settings.holdForRepost && call !== "wait")) return null;
    if (c.expiresAt === null || !world.renews(c) || !world.stallWatch(c)?.stalled) return null;
    const now = world.now();
    const left = c.expiresAt - now;
    if (left <= 0 || left > HOLD_MAX_GAME_H * 60 * world.gameMinuteMs) return null;
    const until = c.expiresAt + REPOST_GRACE_GAME_MIN * world.gameMinuteMs;
    if (tons >= world.expansionTonsLeft || (world.tierEtaMs !== null && now + world.tierEtaMs < until)) return null;
    return until;
  }

  /**
   * Tons this ship may deliver into a charter: what other ships already carrying cargo for it leave,
   * and nothing when the good is one of this lane's market goods and the charter pays less than
   * the planned sale.
   */
  private roomIn(c: World["charters"][number]): number {
    if (c.remaining <= 0) return 0;
    const sale = this.loaded ? this.lane!.parts.find((p) => p.kind === "market" && p.good === c.good) : undefined;
    if (sale && c.payPerTon < sale.pay) return 0;
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
    if (res.delivered_quantity > 0) world.noteOwnDelivery(c.id);
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
      if (this.trip?.freightIds.has(id)) this.trip.reward += res.reward_paid_pence;
      this.host.cashArrived();
      this.log(`delivered freight: ${res.delivered_quantity} t ${f.good} at ${f.dest} for ${cr(res.reward_paid_pence)}`);
      return "delivered";
    } catch (e) {
      if (!(e instanceof KibbApiError) || e.status >= 500) throw e;
      if (e.status === 401 || FATAL_CODES.includes(e.code ?? "")) throw e;
      if (e.status === 429 || e.code === "idempotency_request_in_flight") return "retry";
      const pastDeadline = !!f.deadline && Date.parse(f.deadline) < this.host.world.now();
      if (e.status === 404 || CLOSED_RE.test(e.detail) || (e.status === 409 && pastDeadline)) {
        this.log(`freight to ${f.dest} is settled: ${e.detail}`);
        this.freight.delete(id);
        return "gone";
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
    if (!settings.useFreight || r.ship.status !== "berthed" || stay.traded.has("freight")) return;
    stay.traded.add("freight");

    let listings: ContractListing[];
    try {
      listings = (await client.contractPages({ contract_type: "freight", port_id: port, status: "open" })).items;
      world.mergePortFreight(port, listings);
    } catch {
      return;
    }
    const profitPerMs = this.ratePerHour / 3_600_000;
    const handling = world.handlingMsPerTon(port);
    const candidates = listings
      .filter((c) => c.origin_port_id === port && c.dest_port_id === next && !c.stale)
      .map((c) => ({ c, value: c.reward_pence - c.quantity_required * handling * profitPerMs }))
      .filter((x) => x.value > 0)
      .sort((a, b) => b.value / b.c.quantity_required - a.value / a.c.quantity_required);
    if (candidates.length === 0) return;

    const need = await this.storesTarget(port, next, this.lane?.dest);
    let room = r.effective_hold_capacity_tons - r.cargo_used_tons - this.storesHoldNeed(r.stores.provisions_tons, need);

    for (const { c } of candidates) {
      if (c.quantity_required > room || this.host.freightClaimed(this, c.id)) continue;
      const lane = this.lane && this.lane.dest === next ? this.lane : null;
      if ((await this.acceptFreightLot(port, c.id, c.collateral_pence, r, lane)) === "taken") room -= c.quantity_required;
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
    const tons = this.ownTons(r, good);
    const cls = world.shipClass(this.shipClass);
    const hull = cls?.hull_category ?? "coastal";
    const knots = (cls?.base_speed_centiknots ?? 800) / 100;
    const now = world.now();
    const base = world.basePrice(good);

    // What it fetches here (fresh book when this port trades it).
    let localBid = 0;
    if (world.trades(port, good)) {
      const book = await client.book(port, good).catch(() => null);
      if (book) world.observeBook(book);
      localBid = world.price(port, good)?.bid ?? 0;
    }

    // Stores this ship could carry for a leg: what it has, plus free hold, plus provisions cargo it could eat.
    const stockable = r.stores.provisions_tons + Math.max(0, r.effective_hold_capacity_tons - r.cargo_used_tons) + this.ownTons(r, STORES_GOOD);
    const reachable = (plan: RoutePlan) => world.routeRated(plan, hull) && plan.safe_provisions_tons <= stockable;

    let best: { c: (typeof world.charters)[number]; take: number; value: number } | null = null;
    for (const c of world.charters) {
      if (c.good !== good || c.port === port || c.stale || c.remaining <= 0 || !world.isOpen(c.port)) continue;
      const plan = await world.route(port, c.port, this.shipClass).catch(() => null);
      if (!plan || !reachable(plan)) continue;
      const sailMs = world.sailMs(plan.total_distance_nm, knots * 0.8);
      if (c.expiresAt !== null && c.expiresAt < now + sailMs + 30 * world.gameMinuteMs + 10 * 60_000) continue;
      const take = Math.min(tons, c.remaining);
      const value = take * (c.payPerTon - localBid - settings.minMarginPence) - (sailMs / 3_600_000) * this.ratePerHour;
      if (value > 0 && (!best || value > best.value)) best = { c, take, value };
    }
    if (best) {
      this.lane = cargoLane(good, port, best.c.port, best.c.id, best.take, best.c.payPerTon);
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
    if (localBid >= Math.max(base * 0.5, floor) && !refusedHere) {
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
          this.holds = 0;
          this.log(`sold ${res.filled_quantity}/${tons} t leftover ${good} at ${port} for ${cr(res.total_gross_pence)}`);
          return 2_000;
        }
      } catch (e) {
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
      if (p.id === port || !world.isOpen(p.id) || !world.trades(p.id, good)) continue;
      const plan = await world.route(port, p.id, this.shipClass).catch(() => null);
      if (!plan || !reachable(plan)) continue;
      const bid = world.price(p.id, good)?.bid ?? ((p.imports ?? []).includes(good) ? base * 0.9 : 0);
      if (bid < floor) continue;
      const value = tons * bid - (world.sailMs(plan.total_distance_nm, knots * 0.8) / 3_600_000) * this.ratePerHour;
      if (!market || value > market.value) market = { port: p.id, value };
    }
    if (market && (market.value > tons * localBid || this.holds > MAX_HOLDS)) {
      this.log(`taking ${tons} t ${good} to ${market.port} to sell`);
      this.holds = 0;
      return this.sailTo(r, market.port, stay);
    }
    this.activity = `holding ${tons} t ${good}: no fair bid at ${port}`;
    if (r.ship.status === "berthed" && !this.locked(r)) await client.offshore(this.shipId).catch(() => undefined);
    return HOLD_WAIT_MS;
  }

  // ── Stores ──────────────────────────────────────────────────────────────────

  private async storesTarget(from: string, to: string, then?: string): Promise<number> {
    const { world } = this.host;
    if (from === to) return 0;
    const first = await world.route(from, to, this.shipClass);
    const second = then && then !== to ? await world.route(to, then, this.shipClass) : null;
    return first.safe_provisions_tons + (second?.safe_provisions_tons ?? 0) + STORES_BUFFER_DAYS * first.port_provisions_tons_per_day;
  }

  /**
   * Surplus stores (whole tons above what the voyage needs) are dead weight in the hold. On a
   * provisions lane they go into cargo for the charter. On any other lane, when the hold is what
   * limits the load, they come out and are sold here. Returns the tons left in cargo, which the
   * caller puts back if the load falls through.
   */
  private async trimStores(r: ShipResult, lane: Lane, stay: Stay): Promise<number> {
    if (stay.port === lane.dest) return 0;
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
    if (forCharter) {
      await this.host.client.unprovision(this.shipId, surplus, "cargo");
      stay.boughtHere.set(STORES_GOOD, (stay.boughtHere.get(STORES_GOOD) ?? 0) + surplus);
      this.log(`moved ${surplus} t of surplus stores into cargo for the ${lane.dest} charter`);
      return surplus;
    }
    // Moving stores into cargo frees nothing by itself: only worth it if they sell here, so look first.
    const { client, world } = this.host;
    const book = await client.book(stay.port, STORES_GOOD).catch(() => null);
    if (book) world.observeBook(book);
    const bid = book?.books.find((b) => b.commodity_id === STORES_GOOD)?.best_bid;
    if (!bid || bid.price_pence < world.basePrice(STORES_GOOD) * 0.5) return 0;
    const n = Math.min(surplus, bid.quantity);
    await client.unprovision(this.shipId, n, "cargo");
    const sold = await this.sellHere(stay.port, STORES_GOOD, n);
    if (sold < n) await client.provision(this.shipId, n - sold, "cargo").catch(() => undefined);
    if (sold > 0) this.log(`sold ${sold} t of surplus stores at ${stay.port} to make room for the ${lane.good} load`);
    return 0;
  }

  /**
   * Sells our own goods here. Without a floor: at the best bid, if it is a fair one (half the base
   * price or more). With a floor: down the bid ladder to it. Returns tons sold.
   */
  private async sellHere(port: string, good: string, tons: number, floor?: number): Promise<number> {
    const { client, world } = this.host;
    try {
      const book = await client.book(port, good);
      world.observeBook(book);
      const bid = book.books.find((b) => b.commodity_id === good)?.best_bid?.price_pence ?? 0;
      const limit = floor ?? bid;
      if (bid < Math.max(limit, world.basePrice(good) * 0.5)) return 0;
      const res = await client.placeOrder({ port_id: port, commodity_id: good, side: "ask", time_in_force: "ioc", price_pence: limit, quantity: tons, ship_id: this.shipId });
      this.stats.rewardPence += res.total_gross_pence;
      world.vaults.set(world.region(port), world.vault(world.region(port)) + res.total_gross_pence);
      return res.filled_quantity;
    } catch (e) {
      if (!isApiError(e) || e.status >= 500 || e.status === 401) throw e;
      this.log(`selling ${good} at ${port} refused: ${e.message}`);
      return 0;
    }
  }

  /**
   * Best effort: buys stores for the next leg (and the one after) while berthed, only what fits in
   * the hold and only if the cash is there. Returns whether the stores now cover the target.
   */
  private async topUpStoresFor(r: ShipResult, from: string, to: string, stay: Stay, then?: string, extraTons = 0): Promise<boolean> {
    const { client, world } = this.host;
    const target = (await this.storesTarget(from, to, then ?? from)) + extraTons;
    const have = r.stores.provisions_tons;
    if (have >= target) return true;
    if (r.ship.status !== "berthed") return false;

    // Stores take whole tons of hold: buy no more than the free space allows.
    const free = r.effective_hold_capacity_tons - r.cargo_used_tons;
    let tons = Math.max(1, Math.ceil(target - have));
    while (tons > 0 && Math.ceil(have + tons) - Math.ceil(have) > free) tons--;
    if (tons <= 0) {
      this.log(`no hold space for stores at ${stay.port}`);
      return false;
    }

    const port = stay.port;
    const book = await client.book(port, STORES_GOOD);
    world.observeBook(book);
    const ask = book.books.find((b) => b.commodity_id === STORES_GOOD)?.best_ask;
    if (!ask) {
      this.log(`no provisions on sale at ${port} for stores`);
      return false;
    }
    const limit = Math.ceil(ask.price_pence * 1.1);
    const cost = Math.ceil(limit * tons * (1 + book.customs_bps / 10_000));
    return this.host.withCash(async () => {
      const cash = await this.host.ensureCash(world.region(port), cost);
      if (cash < cost) {
        this.log(`no cash in ${world.region(port)} for stores at ${port}`);
        return false;
      }
      try {
        const res = await client.placeOrder({
          port_id: port,
          commodity_id: STORES_GOOD,
          side: "bid",
          time_in_force: "ioc",
          price_pence: limit,
          quantity: tons,
          ship_id: this.shipId,
          into_stores: true,
        });
        const paid = res.total_gross_pence + res.customs_duty_pence;
        this.stats.spentPence += paid;
        world.vaults.set(world.region(port), world.vault(world.region(port)) - paid);
        stay.traded.add("stores");
        this.log(`stores: bought ${res.filled_quantity}/${tons} t at ${port}`);
        return have + res.filled_quantity >= target;
      } catch (e) {
        if (!isApiError(e) || e.status >= 500 || e.status === 401) throw e;
        this.log(`stores purchase refused: ${e.message}`);
        return false;
      }
    });
  }

  // ── Moving ──────────────────────────────────────────────────────────────────

  private async dockOrWait(r: ShipResult): Promise<number> {
    if (r.ship.dock_queued_at) {
      this.activity = `queued for a berth at ${r.ship.current_port_id}`;
      return POLL_MS;
    }
    const res = await this.host.client.dock(this.shipId);
    this.activity = res.queue_position ? `queued #${res.queue_position} for a berth` : `docked at ${res.port_id}`;
    return 2_000;
  }

  private async sailTo(r: ShipResult, dest: string, stay: Stay): Promise<number> {
    const { client, world } = this.host;
    const port = stay.port;
    const hull = world.shipClass(this.shipClass)?.hull_category ?? "coastal";

    let plan: RoutePlan;
    try {
      plan = await world.route(port, dest, this.shipClass);
    } catch (e) {
      this.log(`no route ${port} → ${dest}: ${(e as Error).message}`);
      this.host.releaseLane(this);
      return IDLE_WAIT_MS;
    }
    if (!world.routeRated(plan, hull)) {
      this.log(`${port} → ${dest} crosses water a ${hull} hull isn't rated for; dropping the lane`);
      this.host.releaseLane(this);
      return 5_000;
    }

    // Stores: aim for this leg plus the laden leg after a deadhead; never sail below this leg's safe figure.
    const then = this.lane && dest === this.lane.source ? this.lane.dest : undefined;
    const need = await this.storesTarget(port, dest, then);
    if (r.stores.provisions_tons < need) {
      if (r.ship.status === "berthed") {
        await this.topUpStoresFor(r, port, dest, stay, then);
        r = await this.reread();
      } else if (r.stores.provisions_tons < plan.safe_provisions_tons) {
        return this.dockOrWait(r);
      }
    }
    if (r.stores.provisions_tons < plan.safe_provisions_tons) {
      // No hold room to buy stores: eat our own provisions cargo if we carry any.
      const own = Math.min(this.ownTons(r, STORES_GOOD), Math.ceil(plan.safe_provisions_tons - r.stores.provisions_tons));
      if (own > 0) {
        try {
          await client.provision(this.shipId, own, "cargo");
          this.log(`moved ${own} t of provisions cargo into the stores for ${dest}`);
          return 1_000;
        } catch (e) {
          if (!isApiError(e) || e.status >= 500) throw e;
        }
      }
      this.activity = `stores ${r.stores.provisions_tons.toFixed(2)} t below the ${plan.safe_provisions_tons.toFixed(2)} t needed for ${dest}`;
      const free = r.effective_hold_capacity_tons - r.cargo_used_tons;
      if (r.ship.status === "berthed" && this.storesHoldNeed(r.stores.provisions_tons, plan.safe_provisions_tons) > free) {
        // No room to stock this leg: give the destination up so the cargo is sold or sent somewhere reachable.
        this.log(`can't stock stores for ${dest} with the hold this full; re-planning`);
        this.host.releaseLane(this);
        return 5_000;
      }
      return 60_000;
    }

    if (this.locked(r)) {
      const wait = Date.parse(r.ship.turnaround_unlocks_at!) - world.now();
      this.activity = `berth lock: leaving for ${dest} in ${secs(wait)}`;
      return wait + 750;
    }

    try {
      const res = await client.depart({ ship_id: this.shipId, dest_port_id: dest });
      for (const w of res.warnings) this.log(`depart warning ${w.code}: ${w.detail}`);
      const eta = Date.parse(res.estimated_arrival_at);
      const own = Object.keys(r.cargo_manifest).reduce((n, g) => n + this.ownTons(r, g), 0);
      this.log(`sailing ${port} → ${dest} with ${own} t${this.freight.size ? ` + ${this.sealedTons()} t freight` : ""}, arrives in ${secs(eta - world.now())}`);
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
        return m ? (Number(m[1]) + 1) * 1_000 : 5_000;
      }
      if (isApiError(e, "insufficient_provisions")) {
        const short = (e.body as { provisions_shortfall?: { buy_provisions_tons?: number } }).provisions_shortfall;
        this.log(`depart refused, stores short: ${e.detail}`);
        if (r.ship.status !== "berthed") return this.dockOrWait(r);
        await this.topUpStoresFor(r, port, dest, stay, then, Math.max(1, short?.buy_provisions_tons ?? 1));
        return 30_000;
      }
      throw e;
    }
  }
}
