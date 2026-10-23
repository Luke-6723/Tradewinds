/**
 * Fleet autopilot for one company: one ShipAgent per ship, a shared World, lane assignment with
 * reservations (so ships spread across charters and sources instead of piling onto one), cash moved
 * between banking regions on demand, and automatic ship purchases.
 *
 * Buying: whenever one of our ships is at a shipyard (building needs presence there), quote every
 * allowed hull class, score each by payback hours on its best lane net of the extra fleet upkeep,
 * and build the quickest payback within the limits.
 *
 * Guns: every gun takes 2 t of hold. With the "auto" policy a ship calling at a yard is refitted to
 * the count that earns most on its lane: hold space against the cargo pirates are expected to take
 * there (live zone piracy). In phase-1 waters that is usually none.
 *
 * Cash: one lock for the whole company, so "raise cash, then spend it" never interleaves between
 * ships. The home region keeps a reserve sized to the fleet's daily upkeep (bills come from it).
 *
 * Events: a long poll on the company's event log wakes a ship's agent the moment something happens
 * to it (arrival, berth from the queue, eviction, hazard) and refreshes the world as soon as a
 * charter is posted, filled or expires, so idle ships re-plan at once. Timers remain the fallback.
 *
 * Runs in-process in the Next.js server (fleet-registry.ts) or from the CLI (workers/kibb-fleet.ts).
 */

import { KibbClient, KIBB_DEFAULT_URL, isApiError } from "../client";
import type { StreamEvent } from "../schema";
import type { BankingRegion, ShipResult } from "../types";
import { ShipAgent, type AgentState, type AgentStats, type FleetHost } from "./agent";
import { acquireLease, type Lease } from "./lease";
import { pickShipName } from "./names";
import { rankLanes, type Lane, type Reservations, type ShipSpec } from "./planner";
import { World } from "./world";

// ── Settings & state ──────────────────────────────────────────────────────────

export interface FleetSettings {
  /** Build ships automatically when one pays back fast enough. */
  autoBuy: boolean;
  /** Never grow the fleet past this many ships. */
  maxShips: number;
  /** Cash always left in the home region (bills are paid from it); raised to cover daily upkeep. */
  reservePence: number;
  /** Minimum profit per ton after customs and fees for a lane to be worth sailing. */
  minMarginPence: number;
  /** Only build a ship that earns its price back within this many real hours. */
  maxPaybackHours: number;
  /** Hull classes the buyer may build. */
  buyClasses: string[];
  /**
   * Guns (150 Cr each to mount, 2 t of hold each): "auto" refits each ship at yard calls to what its
   * lane's piracy justifies, "full" arms every ship to its class maximum, "off" never refits.
   */
  guns: GunPolicy;
  /**
   * Share (0–100%) of the expected phase-completion bonus counted in an expansion charter's pay. The
   * bonus (12% of the tier's base value, split by base value delivered) is paid only when the tier
   * completes, so this discounts it for the wait and for rivals.
   */
  bonusWeightPct: number;
  /** Carry Merchant Adventurers freight on legs we sail anyway, when it pays for its berth time. */
  useFreight: boolean;
}

export type GunPolicy = "auto" | "full" | "off";
const GUN_POLICIES: GunPolicy[] = ["auto", "full", "off"];

export const DEFAULT_FLEET_SETTINGS: FleetSettings = {
  autoBuy: true,
  maxShips: 8,
  reservePence: 150_000,
  minMarginPence: 1_500,
  maxPaybackHours: 8,
  buyClasses: ["collier", "brigantine", "fluyt", "cutter"],
  guns: "auto",
  bonusWeightPct: 75,
  useFreight: true,
};

export class FleetSettingsError extends Error {}

/** Validates a settings patch (from the dashboard or env) before it is saved or applied. */
export function sanitizeSettings(patch: Partial<FleetSettings>): Partial<FleetSettings> {
  const out: Partial<FleetSettings> = {};
  const num = (k: keyof FleetSettings, min: number, int = false) => {
    const v = patch[k];
    if (v === undefined) return;
    if (typeof v !== "number" || !Number.isFinite(v) || v < min) throw new FleetSettingsError(`${k} must be a number ≥ ${min}`);
    (out as Record<string, unknown>)[k] = int ? Math.floor(v) : v;
  };
  const bool = (k: keyof FleetSettings) => {
    const v = patch[k];
    if (v === undefined) return;
    if (typeof v !== "boolean") throw new FleetSettingsError(`${k} must be true or false`);
    (out as Record<string, unknown>)[k] = v;
  };
  num("maxShips", 1, true);
  num("reservePence", 0, true);
  num("minMarginPence", 0, true);
  num("maxPaybackHours", 0.1);
  num("bonusWeightPct", 0);
  if (out.bonusWeightPct !== undefined && out.bonusWeightPct > 100) throw new FleetSettingsError("bonusWeightPct must be 0 to 100");
  bool("autoBuy");
  bool("useFreight");
  if (patch.guns !== undefined) {
    if (!GUN_POLICIES.includes(patch.guns)) throw new FleetSettingsError(`guns must be one of ${GUN_POLICIES.join(", ")}`);
    out.guns = patch.guns;
  }
  if (patch.buyClasses !== undefined) {
    if (!Array.isArray(patch.buyClasses) || !patch.buyClasses.every((c) => typeof c === "string" && /^[a-z_]{2,32}$/.test(c))) {
      throw new FleetSettingsError("buyClasses must be a list of ship class ids");
    }
    out.buyClasses = [...new Set(patch.buyClasses)];
  }
  return out;
}

export interface FleetLogLine {
  at: string;
  source: string;
  msg: string;
}

export interface PurchaseRecord {
  at: string;
  shipId: string;
  name: string;
  shipClass: string;
  port: string;
  costPence: number;
  paybackHours: number;
  lane: string;
}

export type FleetStatus = "stopped" | "starting" | "running" | "failed";

export interface FleetState {
  status: FleetStatus;
  error: string | null;
  startedAt: string | null;
  /** When it stopped or failed; null while running. */
  stoppedAt: string | null;
  homeRegion: BankingRegion | null;
  totals: AgentStats & { shipsBought: number; shipSpendPence: number };
  agents: AgentState[];
  /** Best lanes for a reference ship, refreshed with the world. */
  topLanes: Lane[];
  purchases: PurchaseRecord[];
  buyer: string;
  log: FleetLogLine[];
}

export interface FleetConfig {
  apiKey: string;
  baseUrl?: string;
  settings: FleetSettings;
  /** Directory for the per-company lease file; omit to skip the cross-process guard. */
  leaseDir?: string;
}

// ── Tuning ────────────────────────────────────────────────────────────────────

const LOOP_MS          = 10_000;
const WORLD_REFRESH_MS = 60_000;
/** Soonest world refresh after an event says charters changed. */
const EVENT_REFRESH_MS = 5_000;
/** Long-poll wait per event request (the server allows up to 30 s). */
const EVENT_POLL_MS    = 25_000;
const SHIP_SCAN_MS     = 30_000;
const BUY_CHECK_MS     = 60_000;
const BUY_COOLDOWN_MS  = 3 * 60_000;
const BUY_FAIL_COOLDOWN_MS = 60_000;
/** A ship calling at a yard re-runs the buyer there at most this often. */
const YARD_RECHECK_MS  = 45_000;
const INIT_BACKOFF_MS  = [15_000, 30_000, 60_000, 120_000, 300_000];
const LOG_LIMIT        = 400;
const GUN_PRICE_PENCE  = 15_000;
/** Spare cash kept in every non-home region for berth dues and stores. */
const REGION_FLOOR_PENCE = 20_000;
/** The home reserve covers at least this many game days of fleet upkeep. */
const UPKEEP_DAYS_RESERVED = 1.5;
/** A refit must improve a load's expected profit by this share to be worth the berth call. */
const REFIT_MIN_GAIN = 0.02;
/** Trips a refit should pay for itself within. */
const GUN_PAYBACK_TRIPS = 5;
/** Whole tons of stores never counted as trimmable room (the voyage always needs some). */
const STORES_KEPT_TONS = 1;
const FATAL_CODES      = ["account_suspended", "company_frozen"];

const cr = (pence: number) => `${Math.round(pence / 100).toLocaleString("en-GB")} Cr`;

/** Errors no retry will fix: wrong key, missing scopes, another process running this company. */
class InitFatal extends Error {}

// ── Manager ───────────────────────────────────────────────────────────────────

export class FleetManager implements FleetHost {
  readonly client: KibbClient;
  readonly world: World;
  settings: FleetSettings;

  private readonly agents = new Map<string, ShipAgent>();
  private readonly onLog?: (line: FleetLogLine) => void;
  private readonly leaseDir?: string;
  private lease: Lease | null = null;
  private status: FleetStatus = "stopped";
  private error: string | null = null;
  private startedAt: string | null = null;
  private stoppedAt: string | null = null;
  private homeRegion: BankingRegion | null = null;
  private canRemit = true;
  private logLines: FleetLogLine[] = [];
  private purchases: PurchaseRecord[] = [];
  private topLanes: Lane[] = [];
  private buyer = "not checked yet";
  private retired: AgentStats = { trips: 0, deliveredTons: 0, rewardPence: 0, spentPence: 0, freightPence: 0 };
  private shipSpendPence = 0;
  private readonly missingScans = new Map<string, number>();

  private stopRequested = false;
  private wake: (() => void) | null = null;
  private loop: Promise<void> | null = null;
  private lastWorld = 0;
  private lastScan = 0;
  private lastBuyCheck = 0;
  private lastBuy = 0;
  private buying = false;
  private readonly lastYardCheck = new Map<string, number>();
  /** A build whose response never arrived: adopted (its purchase record) if the ship shows up. */
  private pendingBuild: { name: string; yard: string; cls: string; price: number; payback: number; lane: string } | null = null;
  private cashQueue: Promise<unknown> = Promise.resolve();
  private assignQueue: Promise<unknown> = Promise.resolve();
  private events: Promise<void> | null = null;
  private eventsAbort: AbortController | null = null;
  private eventCursor: string | undefined;
  /** An event said charters or the phase changed: refresh the world soon, then wake idle ships. */
  private worldDirty = false;

  constructor(
    cfg: FleetConfig,
    opts: { onLog?: (line: FleetLogLine) => void; carryOver?: Pick<FleetState, "log" | "purchases"> } = {},
  ) {
    this.client = new KibbClient({ baseUrl: cfg.baseUrl ?? KIBB_DEFAULT_URL, apiKey: cfg.apiKey });
    this.world = new World(this.client);
    this.settings = cfg.settings;
    this.leaseDir = cfg.leaseDir;
    this.onLog = opts.onLog;
    if (opts.carryOver) {
      this.logLines = opts.carryOver.log.slice(-LOG_LIMIT);
      this.purchases = opts.carryOver.purchases.slice(-50);
    }
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  get state(): FleetState {
    const agents = [...this.agents.values()].map((a) => a.state);
    const totals = { ...this.retired, shipsBought: this.purchases.length, shipSpendPence: this.shipSpendPence };
    for (const a of agents) {
      totals.trips += a.stats.trips;
      totals.deliveredTons += a.stats.deliveredTons;
      totals.rewardPence += a.stats.rewardPence;
      totals.spentPence += a.stats.spentPence;
      totals.freightPence += a.stats.freightPence;
    }
    return {
      status: this.status,
      error: this.error,
      startedAt: this.startedAt,
      stoppedAt: this.stoppedAt,
      homeRegion: this.homeRegion,
      totals,
      agents,
      topLanes: this.topLanes.slice(0, 8),
      purchases: [...this.purchases],
      buyer: this.buyer,
      log: [...this.logLines],
    };
  }

  start(): void {
    if (this.loop) return;
    this.stopRequested = false;
    this.error = null;
    this.status = "starting";
    this.startedAt = new Date().toISOString();
    this.stoppedAt = null;
    this.loop = this.run().finally(() => {
      this.loop = null;
    });
  }

  async stop(): Promise<void> {
    this.stopRequested = true;
    this.wake?.();
    this.eventsAbort?.abort();
    await this.loop;
    await this.events;
    while (this.buying || [...this.agents.values()].some((a) => a.running)) {
      await Promise.all([...this.agents.values()].map((a) => a.stop()));
      if (this.buying) await new Promise((r) => setTimeout(r, 200));
    }
    await this.lease?.release();
    this.lease = null;
    if (this.status !== "failed") this.status = "stopped";
    this.stoppedAt ??= new Date().toISOString();
  }

  get done(): Promise<void> {
    return this.loop ?? Promise.resolve();
  }

  log(source: string, msg: string): void {
    const line = { at: new Date().toISOString(), source, msg };
    this.logLines.push(line);
    if (this.logLines.length > LOG_LIMIT) this.logLines.splice(0, this.logLines.length - LOG_LIMIT);
    this.onLog?.(line);
  }

  fatal(msg: string): void {
    if (this.status === "failed") return;
    this.status = "failed";
    this.error = msg;
    this.stoppedAt = new Date().toISOString();
    this.log("fleet", `FATAL: ${msg}`);
    this.stopRequested = true;
    this.wake?.();
    this.eventsAbort?.abort();
    const lease = this.lease;
    this.lease = null;
    void Promise.all([...this.agents.values()].map((a) => a.stop())).finally(() => lease?.release());
  }

  private sleep(ms: number): Promise<void> {
    if (this.stopRequested) return Promise.resolve();
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

  private isFatal(e: unknown): boolean {
    return e instanceof InitFatal || (isApiError(e) && (e.status === 401 || FATAL_CODES.includes(e.code ?? "")));
  }

  private async run(): Promise<void> {
    // Transient failures (network, 5xx, world paused) retry with backoff; key problems are fatal.
    for (let attempt = 0; !this.stopRequested; attempt++) {
      try {
        await this.init();
        break;
      } catch (e) {
        if (this.isFatal(e)) return this.fatal((e as Error).message);
        const wait = INIT_BACKOFF_MS[Math.min(attempt, INIT_BACKOFF_MS.length - 1)];
        this.log("fleet", `start-up failed (${(e as Error).message}); retrying in ${Math.round(wait / 1000)}s`);
        await this.sleep(wait);
      }
    }
    if (this.stopRequested) return;
    this.status = "running";
    this.eventsAbort = new AbortController();
    this.events = this.runEvents(this.eventsAbort.signal).finally(() => {
      this.events = null;
    });
    while (!this.stopRequested) {
      try {
        await this.housekeeping();
      } catch (e) {
        if (this.isFatal(e)) return this.fatal((e as Error).message);
        this.log("fleet", `housekeeping failed: ${(e as Error).message}`);
      }
      await this.sleep(LOOP_MS);
    }
  }

  private async init(): Promise<void> {
    const who = await this.client.whoami();
    if (!who.company_id) throw new InitFatal("the API key is player-level; a company-bound key is needed");
    const missing = ["read", "fleet_navigate", "fleet_cargo", "market_spot", "market_derivatives"].filter(
      (s) => !who.scopes.includes(s as never),
    );
    if (missing.length) throw new InitFatal(`key is missing scopes: ${missing.join(", ")}`);
    if (this.settings.autoBuy && !who.scopes.includes("infra_manage")) {
      this.log("fleet", "key lacks infra_manage: automatic ship buying is off");
      this.settings = { ...this.settings, autoBuy: false };
    }
    this.canRemit = who.scopes.includes("treasury_remit");
    if (!this.canRemit) this.log("fleet", "key lacks treasury_remit: cash stays in the region it lands in");

    if (this.leaseDir && !this.lease) {
      const got = await acquireLease(this.leaseDir, who.company_id, () => this.fatal("another process took over this company's autopilot lease"));
      // Held: retried with backoff by run(), so a crashed holder's lease is taken once it goes stale.
      if ("heldBy" in got) throw new Error(`this company's autopilot is already running (${got.heldBy})`);
      this.lease = got.lease;
    }

    await this.world.init();
    const profile = await this.client.companyProfile();
    this.homeRegion = this.world.region(profile.company.home_port_id);
    this.log(
      "fleet",
      `started for ${profile.company.name}: phase ${this.world.unlockedPhase} open, server clock ${this.world.skewMs >= 0 ? "+" : ""}${Math.round(this.world.skewMs / 1000)}s vs this machine, ` +
        `${this.world.charters.length} open charters, auto-buy ${this.settings.autoBuy ? "on" : "off"}`,
    );
    this.lastWorld = Date.now();
    await this.scanShips();
  }

  /** World refresh, new/lost ships, lane overview, purchases. */
  private async housekeeping(): Promise<void> {
    const now = Date.now();
    if (now - this.lastWorld > WORLD_REFRESH_MS || (this.worldDirty && now - this.lastWorld > EVENT_REFRESH_MS)) {
      const dirty = this.worldDirty;
      this.worldDirty = false;
      try {
        await this.world.refresh();
      } catch (e) {
        this.worldDirty ||= dirty;
        throw e;
      }
      this.lastWorld = now;
      // New charters: ships idling for want of a lane look again now, not in minutes.
      if (dirty) for (const a of this.agents.values()) if (a.idle) a.nudge();
      await this.refreshTopLanes();
    }
    if (now - this.lastScan > SHIP_SCAN_MS) await this.scanShips();
    if (now - this.lastBuyCheck > BUY_CHECK_MS) await this.runBuyer(null);
  }

  private async scanShips(): Promise<void> {
    this.lastScan = Date.now();
    const ships = await this.client.ships();
    const listed = new Set(ships.map((r) => r.ship.id));
    const pending = this.pendingBuild;
    if (pending) {
      const found = ships.find((x) => x.ship.name === pending.name && x.ship.ship_class === pending.cls && !this.agents.has(x.ship.id));
      if (found) {
        this.pendingBuild = null;
        this.shipSpendPence += pending.price;
        this.purchases.push({
          at: new Date().toISOString(),
          shipId: found.ship.id,
          name: pending.name,
          shipClass: pending.cls,
          port: pending.yard,
          costPence: pending.price,
          paybackHours: Math.round(pending.payback * 10) / 10,
          lane: pending.lane,
        });
        this.log("fleet", `the ${pending.cls} "${pending.name}" was built after all`);
      }
    }
    for (const r of ships) {
      if (this.stopRequested || this.agents.has(r.ship.id) || r.ship.status === "sunk") continue;
      const agent = new ShipAgent(this, r.ship.id, r.ship.name, r.ship.ship_class);
      agent.last = r;
      this.agents.set(r.ship.id, agent);
      this.log("fleet", `taking command of ${r.ship.name} (${r.ship.ship_class})`);
      agent.start();
    }
    for (const [id, a] of this.agents) {
      // Missing from the fleet list twice running (seized, lost) counts as gone.
      const misses = listed.has(id) ? 0 : (this.missingScans.get(id) ?? 0) + 1;
      this.missingScans.set(id, misses);
      if (misses >= 2 && !a.gone) {
        this.log(a.name, "no longer listed in the fleet; stopping its autopilot");
        a.gone = true;
        await a.stop();
      }
      if (a.gone && !a.running) {
        this.retire(a);
        this.agents.delete(id);
        this.missingScans.delete(id);
      }
    }
  }

  private retire(a: ShipAgent): void {
    for (const k of Object.keys(this.retired) as (keyof AgentStats)[]) this.retired[k] += a.stats[k];
  }

  private async refreshTopLanes(): Promise<void> {
    const ref = [...this.agents.values()].find((a) => a.last);
    const r = ref?.last;
    const from = r?.ship.current_port_id ?? r?.route_legs.at(-1)?.to_node;
    if (!from || !r || !ref) return;
    try {
      this.topLanes = await rankLanes(this.world, this.specFor(ref, r), from, this.reservations(ref), this.planOptions(this.loadCash(ref)));
    } catch (e) {
      this.log("fleet", `lane overview failed: ${(e as Error).message}`);
    }
  }

  // ── Lanes ───────────────────────────────────────────────────────────────────

  /** Hull, speed and cargo room for one of our ships. */
  private specFor(agent: ShipAgent, r: ShipResult): ShipSpec {
    const cls = this.world.shipClass(agent.shipClass);
    return {
      shipClass: agent.shipClass,
      hull: cls?.hull_category ?? "coastal",
      knots: (cls?.base_speed_centiknots ?? 800) / 100,
      // Surplus stores can be trimmed and sold at the source to make room (see ShipAgent.trimStores).
      cap: Math.max(0, r.effective_hold_capacity_tons - agent.sealedTons() + Math.max(0, Math.floor(r.stores.provisions_tons) - STORES_KEPT_TONS)),
      guns: r.ship.cannons_count,
    };
  }

  /** Hull, speed and cargo room for a class not yet built. */
  private specForClass(shipClass: string, guns: number): ShipSpec {
    const cls = this.world.shipClass(shipClass);
    return {
      shipClass,
      hull: cls?.hull_category ?? "coastal",
      knots: (cls?.base_speed_centiknots ?? 800) / 100,
      cap: Math.max(0, (cls?.hold_capacity_tons ?? 40) - 2 * guns - 2),
      guns,
    };
  }

  private planOptions(cash: number | null) {
    return { minMargin: this.settings.minMarginPence, bonusWeight: this.settings.bonusWeightPct / 100, cash };
  }

  /** Cash a ship can spend on its next load: spare cash in every region, less loads other ships are bound to buy. */
  private loadCash(except?: ShipAgent): number {
    let committed = 0;
    for (const a of this.agents.values()) if (a !== except && a.lane && a.boundToBuy) committed += a.lane.tons * a.lane.costPerTon;
    return Math.max(0, this.spareCash() - committed);
  }

  cashArrived(): void {
    // Idle ships too: with loads sized to cash, a ship short of it finds no lane rather than waiting.
    for (const a of this.agents.values()) if (a.waitingForCash || a.idle) a.nudge();
  }

  // ── Guns ────────────────────────────────────────────────────────────────────

  /**
   * Guns this ship should carry after a refit at the yard it is berthed at, or undefined to leave
   * them. "auto" weighs each count by the expected profit of the ship's lane: cargo room (2 t a gun)
   * against the share of the load pirates are expected to take on the laden passage.
   */
  async gunTarget(agent: ShipAgent, r: ShipResult): Promise<number | undefined> {
    const policy = this.settings.guns;
    const max = this.world.shipClass(agent.shipClass)?.max_cannons ?? 0;
    if (policy === "off") return undefined;
    if (policy === "full") return max;
    const lane = agent.lane;
    if (!lane) return undefined;
    const cls = this.world.shipClass(agent.shipClass);
    const knots = ((cls?.base_speed_centiknots ?? 800) / 100) * 0.8;
    const plan = await this.world.route(lane.source, lane.dest, agent.shipClass).catch(() => null);
    if (!plan) return undefined;

    const now = r.ship.cannons_count;
    // Room each count leaves, and whether the load is limited by room at all (charter or cash may bind first).
    const room = (g: number) => r.effective_hold_capacity_tons + 2 * (now - g) - agent.sealedTons();
    const roomBound = lane.tons >= room(now) - 0.5;
    const tonsAt = (g: number) => Math.max(0, roomBound ? room(g) : Math.min(lane.tons, room(g)));
    // Landed cost without the piracy markup the planner priced in for the current guns.
    const landed = lane.costPerTon * (1 - lane.piracyBps / 10_000);
    const payPerTon = lane.pay + (lane.bonus ?? 0);
    const profit = (g: number) => tonsAt(g) * (payPerTon * (1 - this.world.piracyLoss(plan, g, knots)) - landed);

    // Hysteresis, so a ship moving between quiet and pirate water doesn't buy and land guns on
    // alternate calls: mounting must repay twice its price (it may be landed again), landing must
    // repay what re-mounting would cost.
    const perGun = GUN_PRICE_PENCE / GUN_PAYBACK_TRIPS;
    let best = now;
    let bestProfit = profit(now);
    for (let g = 0; g <= max; g++) {
      const p = profit(g) - (g > now ? (g - now) * 2 * perGun : (now - g) * perGun);
      if (p > bestProfit) {
        best = g;
        bestProfit = p;
      }
    }
    if (best === now) return undefined;
    const base = Math.abs(profit(now)) || 1;
    return (bestProfit - profit(now)) / base >= REFIT_MIN_GAIN ? best : undefined;
  }

  // ── Events ──────────────────────────────────────────────────────────────────

  /**
   * Long-polls the company's event log for as long as the fleet runs. Without a cursor the server
   * sends only events after the request, so the first quiet polls can miss a moment between calls;
   * the timers cover that. A cursor older than the 7-day log (410) restarts from now.
   */
  private async runEvents(signal: AbortSignal): Promise<void> {
    let failures = 0;
    const pause = (ms: number) =>
      new Promise<void>((r) => {
        const done = () => {
          clearTimeout(t);
          signal.removeEventListener("abort", done);
          r();
        };
        const t = setTimeout(done, ms);
        signal.addEventListener("abort", done, { once: true });
      });
    while (!this.stopRequested && !signal.aborted) {
      try {
        const asked = Date.now();
        const batch = await this.client.events({ after_id: this.eventCursor, timeout_ms: EVENT_POLL_MS, limit: 200 }, signal);
        failures = 0;
        for (const e of batch) {
          this.eventCursor = e.id;
          this.onEvent(e);
        }
        // A server answering an empty poll at once (paused, shedding load) shouldn't be hammered.
        if (batch.length === 0 && Date.now() - asked < 1_000) await pause(2_000);
      } catch (e) {
        if (signal.aborted || this.stopRequested) return;
        if (isApiError(e, "events_expired")) {
          this.eventCursor = undefined;
          this.worldDirty = true;
          continue;
        }
        if (isApiError(e) && (e.status === 401 || e.status === 403)) {
          this.log("fleet", `event feed stopped (${e.message}); running on timers`);
          return;
        }
        failures++;
        if (failures === 3) this.log("fleet", `event feed failing (${(e as Error).message}); running on timers until it recovers`);
        await pause(Math.min(60_000, 2_000 * 2 ** Math.min(failures, 5)));
      }
    }
  }

  private onEvent(e: StreamEvent): void {
    const p = (e.payload && typeof e.payload === "object" ? e.payload : {}) as Record<string, unknown>;
    const str = (...keys: string[]) => {
      for (const k of keys) if (typeof p[k] === "string") return p[k] as string;
      return undefined;
    };
    const num = (k: string) => (typeof p[k] === "number" ? (p[k] as number) : undefined);
    const agent = (() => {
      const id = str("ship_id", "carrier_ship_id");
      return id ? this.agents.get(id) : undefined;
    })();
    switch (e.event_type) {
      case "ship_arrived":
      case "ship_berthed":
      case "ship_evicted":
      case "ship_leg_completed":
      case "freight_delivered":
      case "freight_issuer_breach":
      case "freight_defaulted":
        agent?.nudge();
        break;
      case "voyage_hazard": {
        const loss = num("cargo_loss_pct");
        this.log(agent?.name ?? "fleet", `${str("hazard") ?? "hazard"} at sea${p.sunk ? ": SUNK" : loss ? `: lost ${loss}% of cargo` : ""}`);
        agent?.nudge();
        break;
      }
      case "ship_mutinied":
      case "ship_provisions_exhausted":
        this.log(agent?.name ?? "fleet", e.event_type === "ship_mutinied" ? "the crew mutinied: ship lost" : "stores ran out at sea");
        agent?.nudge();
        break;
      case "charter_delivered":
      case "charter_expired": {
        // Filled or lapsed: drop it now. A partial delivery (ours or a rival's) shows in the next
        // listing; adjusting `remaining` here could count our own delivery twice.
        const id = str("contract_id", "charter_id");
        const remaining = e.event_type === "charter_expired" ? 0 : num("remaining_quantity");
        if (id && remaining === 0) this.world.markClosed(id);
        else if (!id || remaining === undefined) {
          this.worldDirty = true;
          this.wake?.();
        }
        break;
      }
      case "charter_posted":
      case "world_phase_unlocked":
      case "expansion_target_rescaled":
      case "world_event":
        if (e.event_type === "world_phase_unlocked") this.log("fleet", "a new phase opened: re-planning across the new ports");
        this.worldDirty = true;
        this.wake?.();
        break;
      case "crown_bailiff_warehouse_seizure":
      case "crown_bailiff_upkeep_seizure":
        this.log("fleet", `BAILIFF: ${e.event_type.replace(/_/g, " ")} (a bill went unpaid; check the reserve)`);
        break;
      case "server_announcement":
        this.log("fleet", `server ${str("severity") ?? "notice"}: ${str("message") ?? ""}`);
        break;
      case "expansion_bonus_paid":
      case "marque_prize_paid":
      case "insurance_claim_paid": {
        const amount = num("amount_pence") ?? num("bonus_pence") ?? num("payout_pence");
        this.log("fleet", `${e.event_type.replace(/_/g, " ")}${amount ? `: ${cr(amount)}` : ""}`);
        break;
      }
    }
  }

  /** Tons other ships are bound for: charter room they will fill, source depth they will buy. */
  private reservations(except?: ShipAgent): Reservations {
    const charterTons = new Map<string, number>();
    const sourceTons = new Map<string, number>();
    for (const a of this.agents.values()) {
      if (a === except || !a.lane) continue;
      for (const [id, t] of a.lane.fills) charterTons.set(id, (charterTons.get(id) ?? 0) + t);
      if (a.boundToBuy) {
        const k = `${a.lane.source}|${a.lane.good}`;
        sourceTons.set(k, (sourceTons.get(k) ?? 0) + a.lane.tons);
      }
    }
    return { charterTons, sourceTons };
  }

  /** One planning pass at a time, so each ship sees the others' fresh reservations. */
  assignLane(agent: ShipAgent, from: string, r: ShipResult): Promise<Lane | null> {
    const run = this.assignQueue.then(() => this.assignLaneNow(agent, from, r));
    this.assignQueue = run.catch(() => undefined);
    return run;
  }

  private async assignLaneNow(agent: ShipAgent, from: string, r: ShipResult): Promise<Lane | null> {
    const prev = agent.lane;
    const cash = this.loadCash(agent);
    const lanes = await rankLanes(this.world, this.specFor(agent, r), from, this.reservations(agent), this.planOptions(cash));
    const best = lanes.find((l) => !agent.isAvoided(l.key)) ?? null;
    agent.lane = best;
    if (best) agent.noteLane(best);
    if (best && best.key !== prev?.key) {
      this.log(
        agent.name,
        `lane: ${best.tons} t ${best.good} ${best.source} → ${best.dest}, margin ~${cr(best.margin)}/t` +
          `${best.bonus > 0 ? ` incl. ~${cr(best.bonus)}/t phase bonus` : ""}${best.askKnown ? "" : " (ask estimated)"}, ~${cr(best.profitPerHour)}/h`,
      );
    } else if (!best && prev) {
      this.log(agent.name, `no lane clears the minimum margin with the ${cr(cash)} the fleet can spend right now`);
    }
    return best;
  }

  releaseLane(agent: ShipAgent): void {
    agent.lane = null;
  }

  // ── Cash ────────────────────────────────────────────────────────────────────

  private fleetTons(oceanic: boolean): number {
    let t = 0;
    for (const a of this.agents.values()) {
      const cls = this.world.shipClass(a.shipClass);
      if (!cls || (cls.hull_category === "oceanic") !== oceanic) continue;
      t += cls.hold_capacity_tons;
    }
    return t;
  }

  /** Daily fleet upkeep (pence per game day), optionally with an extra hull. */
  private upkeepPerDay(extra?: { tons: number; oceanic: boolean }): number {
    const coastal = this.fleetTons(false) + (extra && !extra.oceanic ? extra.tons : 0);
    const oceanic = this.fleetTons(true) + (extra?.oceanic ? extra.tons : 0);
    return this.world.sprawlPerDay(coastal) + 100 * oceanic;
  }

  private homeFloor(extra?: { tons: number; oceanic: boolean }): number {
    return Math.max(this.settings.reservePence, Math.ceil(UPKEEP_DAYS_RESERVED * this.upkeepPerDay(extra)));
  }

  private floorIn(region: BankingRegion): number {
    return region === this.homeRegion ? this.homeFloor() : REGION_FLOOR_PENCE;
  }

  withCash<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.cashQueue.then(fn);
    this.cashQueue = run.catch(() => undefined);
    return run;
  }

  async ensureCash(region: BankingRegion, amount: number): Promise<number> {
    const w = this.world;
    await w.refreshVaults();
    let have = w.vault(region) - this.floorIn(region);
    if (have >= amount || !this.canRemit) return Math.max(0, have);

    // Pull the shortfall from the cheapest corridor first, paying the ACH fee.
    const donors = [...w.vaults.entries()]
      .filter(([r]) => r !== region)
      .map(([r, v]) => ({ r, spare: v - this.floorIn(r) }))
      .filter((d) => d.spare > 0)
      .sort((a, b) => w.remitBps(a.r, region) - w.remitBps(b.r, region) || b.spare - a.spare);
    for (const d of donors) {
      const fee = w.remitBps(d.r, region) / 10_000;
      const gross = Math.min(d.spare, Math.max(Math.ceil((amount - have) / (1 - fee)) + 100, 1_000));
      if (gross <= 0) continue;
      try {
        const res = await this.client.remit(d.r, region, gross);
        this.log("fleet", `moved ${cr(res.net_credited_pence)} ${d.r} → ${region} (fee ${cr(res.fee_pence)})`);
        await w.refreshVaults();
        have = w.vault(region) - this.floorIn(region);
        if (have >= amount) break;
      } catch (e) {
        if (this.isFatal(e)) throw e;
        this.log("fleet", `remit ${d.r} → ${region} failed: ${(e as Error).message}`);
      }
    }
    return Math.max(0, have);
  }

  private spareCash(): number {
    let n = 0;
    for (const [r, v] of this.world.vaults) n += Math.max(0, v - this.floorIn(r));
    return n;
  }

  // ── Buying ships ────────────────────────────────────────────────────────────

  /** Money spent mounting guns counts with the fleet's ship spending. */
  noteArmed(shipId: string, costPence: number): void {
    this.shipSpendPence += costPence;
    const p = this.purchases.find((x) => x.shipId === shipId);
    if (p) p.costPence += costPence;
  }

  async visitShipyard(port: string): Promise<void> {
    const last = this.lastYardCheck.get(port) ?? 0;
    if (Date.now() - last < YARD_RECHECK_MS) return;
    this.lastYardCheck.set(port, Date.now());
    await this.runBuyer([port]);
  }

  /** One buyer pass at a time; `yards` null means every yard where we have presence. */
  private async runBuyer(yards: string[] | null): Promise<void> {
    if (this.stopRequested || !this.settings.autoBuy || this.buying || Date.now() - this.lastBuy < BUY_COOLDOWN_MS) return;
    this.lastBuyCheck = Date.now();
    this.buying = true;
    try {
      await this.considerPurchase(yards);
    } catch (e) {
      if (this.isFatal(e)) throw e;
      this.setBuyer(`last check failed: ${(e as Error).message}`, true);
    } finally {
      this.buying = false;
    }
  }

  private setBuyer(text: string, log = false): void {
    if (log && text !== this.buyer) this.log("fleet", `buyer: ${text}`);
    this.buyer = text;
  }

  private async considerPurchase(only: string[] | null): Promise<void> {
    const { world, settings } = this;
    if (this.agents.size >= settings.maxShips) return this.setBuyer(`fleet at the ${settings.maxShips}-ship limit`);
    if ([...this.agents.values()].some((a) => a.waitingForCash)) return this.setBuyer("a ship is waiting for cash to load: not buying");

    await world.refreshVaults();
    // Cash the existing fleet still needs for loads it is bound to buy comes first.
    let committed = 0;
    for (const a of this.agents.values()) if (a.lane && a.boundToBuy) committed += a.lane.tons * a.lane.costPerTon;
    const spare = this.spareCash() - committed;

    // Building needs presence: a ship of ours in a yard port (re-read when not called by that ship).
    const yards = new Set<string>(only ?? []);
    if (!only) {
      for (const a of this.agents.values()) {
        const s = a.last?.ship;
        if (!s || s.status === "sailing" || !s.current_port_id || !world.port(s.current_port_id)?.has_shipyard) continue;
        const fresh = await this.client.ship(a.shipId).catch(() => null);
        if (fresh && fresh.ship.status !== "sailing" && fresh.ship.current_port_id === s.current_port_id) yards.add(s.current_port_id);
      }
    }
    if (yards.size === 0) return this.setBuyer(`waiting for a ship to call at a shipyard (spare ${cr(spare)} after ${cr(committed)} for loads)`);
    if (spare <= 0) return this.setBuyer(`no spare cash: ${cr(committed)} is committed to loads the fleet is about to buy`);

    const classes = world.catalog.ship_classes.filter((c) => settings.buyClasses.includes(c.id) && c.phase <= world.unlockedPhase);
    type Option = { yard: string; cls: string; hull: number; guns: number; cost: number; payback: number; net: number; lane: Lane; upkeepFloor: number };
    const options: Option[] = [];
    const notes: string[] = [];
    const now = world.now();

    for (const yard of yards) {
      for (const cls of classes) {
        let quote;
        try {
          quote = await this.client.shipyardQuote(yard, cls.id, "turnkey_cash");
        } catch (e) {
          if (this.isFatal(e)) throw e;
          notes.push(`${cls.id}@${yard}: ${(e as Error).message}`);
          continue;
        }
        if (!quote.available || !quote.total_cost_pence) {
          notes.push(`${cls.id}@${yard}: materials not in stock`);
          continue;
        }
        // "full" arms new hulls at once; "auto" builds them bare and refits on a pirate-heavy lane.
        const guns = settings.guns === "full" ? cls.max_cannons : 0;
        const hull = quote.total_cost_pence;
        const cost = hull + guns * GUN_PRICE_PENCE;
        // The home reserve must rise to cover the new hull's upkeep too.
        const oceanic = cls.hull_category === "oceanic";
        const upkeepFloor = this.homeFloor({ tons: cls.hold_capacity_tons, oceanic }) - this.homeFloor();
        const afterBuy = spare - cost - upkeepFloor;
        if (afterBuy <= 0) {
          notes.push(`${cls.id}@${yard}: ${cr(cost)} leaves nothing for cargo`);
          continue;
        }
        // Planned with the cash left after building it, so the load it is credited with is one it can buy.
        const lane = (await rankLanes(world, this.specForClass(cls.id, guns), yard, this.reservations(), this.planOptions(afterBuy)))[0];
        if (!lane) {
          notes.push(`${cls.id}@${yard}: no paying lane it could afford`);
          continue;
        }
        const capacity = Math.max(1, (cls.hold_capacity_tons ?? 40) - 2 * guns - 2);
        if (lane.tons < capacity * 0.3) {
          notes.push(`${cls.id}@${yard}: ${cr(cost)} leaves too little for cargo`);
          continue;
        }
        const upkeepPerHour = world.upkeepDeltaPerHour(this.fleetTons(oceanic), cls.hold_capacity_tons, oceanic);
        const net = lane.profitPerHour - upkeepPerHour;
        if (net <= 0) {
          notes.push(`${cls.id}@${yard}: upkeep eats the profit`);
          continue;
        }
        // The charters it would serve must last, and hold enough tons, to pay the ship back.
        const expiries = lane.fills.map(([id]) => world.charters.find((c) => c.id === id)?.expiresAt ?? null).filter((x): x is number => x !== null);
        const hoursLeft = expiries.length ? (Math.min(...expiries) - now) / 3_600_000 : Infinity;
        const res = this.reservations();
        const tonsLeft = lane.fills.reduce((n, [id]) => {
          const c = world.charters.find((x) => x.id === id);
          return n + (c ? Math.max(0, c.remaining - (res.charterTons.get(id) ?? 0)) : 0);
        }, 0);
        const earnable = Math.min(net * Math.min(settings.maxPaybackHours, hoursLeft), lane.margin * tonsLeft);
        if (earnable < cost) {
          notes.push(`${cls.id}@${yard}: its charters can't pay it back in time`);
          continue;
        }
        options.push({ yard, cls: cls.id, hull, guns, cost, payback: cost / net, net, lane, upkeepFloor });
      }
    }

    options.sort((a, b) => a.payback - b.payback);
    const pick = options.find((o) => o.payback <= settings.maxPaybackHours);
    if (!pick) {
      const best = options[0];
      return this.setBuyer(
        best
          ? `best option ${best.cls} at ${best.yard} pays back in ${best.payback.toFixed(1)} h (limit ${settings.maxPaybackHours} h)`
          : `nothing affordable pays (${notes.slice(0, 3).join("; ") || `spare ${cr(spare)}`})`,
        true,
      );
    }

    // Name first: the TopStats fetch must not sit between raising the cash and spending it.
    const name = await pickShipName(new Set([...this.agents.values()].map((a) => a.name)));
    const region = world.region(pick.yard);
    const failLater = (why: string) => {
      this.lastBuy = Date.now() - BUY_COOLDOWN_MS + BUY_FAIL_COOLDOWN_MS;
      this.setBuyer(why, true);
      return null;
    };
    const built = await this.withCash(async () => {
      if (this.stopRequested) return null;
      // The quote may be minutes old by now: price it again and re-check what the fleet needs.
      const q = await this.client.shipyardQuote(pick.yard, pick.cls, "turnkey_cash").catch(() => null);
      if (!q?.available || !q.total_cost_pence || q.total_cost_pence > pick.hull * 1.05) {
        return failLater(`the price of a ${pick.cls} at ${pick.yard} moved or it can't be built now`);
      }
      const price = q.total_cost_pence;
      await world.refreshVaults();
      let committedNow = 0;
      for (const a of this.agents.values()) if (a.lane && a.boundToBuy) committedNow += a.lane.tons * a.lane.costPerTon;
      if (this.spareCash() - committedNow - pick.upkeepFloor < price) {
        return failLater(`after the fleet's loads there is no longer ${cr(price)} spare for a ${pick.cls}`);
      }
      const cash = await this.ensureCash(region, price);
      if (cash < price) return failLater(`could not raise ${cr(price)} in ${region} for a ${pick.cls}`);
      try {
        return await this.client.buildShip(pick.yard, name, pick.cls, "turnkey_cash");
      } catch (e) {
        if (this.isFatal(e)) throw e;
        if (!isApiError(e) || e.status >= 500 || e.code === "idempotency_request_in_flight") {
          // Unknown outcome: look for the ship a few times before deciding it wasn't built.
          for (let i = 0; i < 3; i++) {
            const ships = await this.client.ships().catch(() => [] as ShipResult[]);
            const found = ships.find((x) => x.ship.name === name && x.ship.current_port_id === pick.yard);
            if (found) return { ship_id: found.ship.id, name, port_id: pick.yard, ship_class: pick.cls, build_mode: "turnkey_cash" as const, status: found.ship.status, total_cost_pence: price };
            await new Promise((r) => setTimeout(r, 5_000));
          }
          // Still unknown: don't build again for a full cooldown; adopt the ship if it turns up.
          this.lastBuy = Date.now();
          this.pendingBuild = { name, yard: pick.yard, cls: pick.cls, price, payback: pick.payback, lane: pick.lane.key };
          this.setBuyer(`building a ${pick.cls} at ${pick.yard}: outcome unknown (${(e as Error).message}); watching for "${name}"`, true);
          return null;
        }
        // Usually presence lost (the ship sailed) or the price moved past our cash.
        return failLater(`building a ${pick.cls} at ${pick.yard} failed: ${(e as Error).message}`);
      }
    });
    if (!built) return;

    this.lastBuy = Date.now();
    this.shipSpendPence += built.total_cost_pence;
    world.vaults.set(region, world.vault(region) - built.total_cost_pence);
    this.log(
      "fleet",
      `built ${pick.cls} "${name}" at ${pick.yard} for ${cr(built.total_cost_pence)}: lane ${pick.lane.key}, ~${cr(pick.net)}/h net, pays back in ~${pick.payback.toFixed(1)} h`,
    );
    this.purchases.push({
      at: new Date().toISOString(),
      shipId: built.ship_id,
      name,
      shipClass: pick.cls,
      port: pick.yard,
      costPence: built.total_cost_pence,
      paybackHours: Math.round(pick.payback * 10) / 10,
      lane: pick.lane.key,
    });
    this.setBuyer(`bought ${pick.cls} "${name}" at ${pick.yard}`);
    await this.scanShips();
  }
}
