/**
 * Fleet autopilot for one company: one ShipAgent per ship, a shared World, lane assignment with
 * reservations (so ships spread across charters and sources instead of piling onto one), cash moved
 * between banking regions on demand, and automatic ship purchases.
 *
 * Buying: wherever we have presence at a shipyard (a ship there, or a Resident Factor), quote every
 * allowed hull class, score each by payback hours on its best lane net of the extra fleet upkeep,
 * and build the quickest payback within the limits. With no presence at any yard, it prices a build
 * at the yard nearest the fleet's work from the last quotes seen; if one would pay back (counting the
 * fee), it hires a Resident Factor there for the build and dismisses it straight after, so building
 * never waits for a ship to happen by and no factor salary runs on. As the expansion tier nears
 * completion (and for a while after it turns over) part of the spare cash is kept back for the new
 * tier's charters, which nobody can reach at first, so they stall and re-post richer.
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
import { analyseRivals, bestMarque, MARQUE_PENCE_PER_BPS_DAY, zoneDays, type MarqueOption } from "../rivals";
import type { LetterOfMarque } from "../schema";
import { judgePolicies, type UnderwriteRow } from "./underwriter";
import type { StreamEvent } from "../schema";
import type { BankingRegion, ShipResult } from "../types";
import { ShipAgent, type AgentState, type AgentStats, type FleetHost, type HoldInfo } from "./agent";
import { acquireLease, type Lease } from "./lease";
import { pickShipName } from "./names";
import { rankLanes, type Lane, type Reservations, type ShipSpec } from "./planner";
import { World, type ExpansionWatch } from "./world";

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
  /**
   * Sponsor letters of marque automatically where the rival traffic seen makes the prize money beat
   * the cost and our own ships' extra losses by a safety margin. Off by default.
   */
  marques: boolean;
  /** Most spent on letters of marque in any 24 real hours (pence). */
  marqueBudgetPence: number;
  /**
   * Underwrite other companies' voyage policies that Lloyd's has already priced on the same lane
   * (its acceptance bounds the expected loss), in small slices. Off by default.
   */
  underwrite: boolean;
  /** Most collateral locked in escrow at once (pence; all escrow counts, to stay on the safe side). */
  underwriteBudgetPence: number;
  /** Most collateral on any one policy (pence). */
  underwriteMaxPerPolicyPence: number;
  /** Least edge over the Lloyd's-implied expected loss (bps of the sum insured). */
  underwriteMinEdgeBps: number;
  /** Carry Merchant Adventurers freight on legs we sail anyway, when it pays for its berth time. */
  useFreight: boolean;
  /**
   * With no presence at any shipyard, hire a Resident Factor (750 Cr) at the yard nearest the fleet's
   * work when a build there would pay back, build, and dismiss the factor straight after.
   */
  yardFactor: boolean;
  /**
   * Hold cargo for a stalled expansion charter (nothing delivered in its posting) that lapses within
   * a few game hours of arrival, and deliver into its richer re-post. Off by default.
   */
  holdForRepost: boolean;
  /** Share (0–90%) of spare cash the buyer leaves alone while the expansion tier is close to completing. */
  phaseChestPct: number;
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
  marques: false,
  marqueBudgetPence: 100_000,
  underwrite: false,
  underwriteBudgetPence: 500_000,
  underwriteMaxPerPolicyPence: 300_000,
  underwriteMinEdgeBps: 150,
  useFreight: true,
  yardFactor: true,
  holdForRepost: false,
  phaseChestPct: 40,
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
  bool("marques");
  num("marqueBudgetPence", 0, true);
  bool("underwrite");
  num("underwriteBudgetPence", 0, true);
  num("underwriteMaxPerPolicyPence", 0, true);
  num("underwriteMinEdgeBps", 0, true);
  bool("yardFactor");
  bool("holdForRepost");
  num("phaseChestPct", 0);
  if (out.phaseChestPct !== undefined && out.phaseChestPct > 90) throw new FleetSettingsError("phaseChestPct must be 0 to 90");
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
  /** The last letter-of-marque check (also run, as a dry run, while auto-marques are off). */
  marques: MarqueReport | null;
  /** The last underwriting check (a dry run while it is off). */
  underwriting: UnderwriteReport | null;
  /** The expansion tier as the autopilot sees it: pace, whether the buyer is keeping cash back, stalled charters. */
  expansion: ExpansionReport | null;
  /** Charge on cash a load ties up (per pence per real hour; 0 while cash isn't scarce). */
  capitalRate: number;
  log: FleetLogLine[];
}

export interface ExpansionReport {
  targetPhase: number | null;
  progressBps: number;
  /** Real ms until the tier completes at the recent pace, or null with no pace yet. */
  etaMs: number | null;
  /** The buyer is keeping `phaseChestPct` of spare cash back for the next tier. */
  phaseSoon: boolean;
  /** What a stalled posting's re-post is expected to do to pay and tons. */
  escalation: { pay: number; tons: number };
  charters: ExpansionWatch[];
}

export interface MarqueZoneReport {
  zone: string;
  /** Rival passages and laden passages a game day, and their cargo (pence) at base prices. */
  passages: number;
  laden: number;
  cargo: number;
  /** Best marque there (per game day, pence): prize, cost, our own extra losses, profit. */
  best: MarqueOption;
  active: boolean;
  verdict: string;
}

export interface UnderwriteReport {
  checkedAt: string;
  enabled: boolean;
  budgetPence: number;
  /** All escrow across regions (underwriting collateral included). */
  lockedPence: number;
  /** Policies judged, best first (at most 25). */
  rows: UnderwriteRow[];
  action: string;
}

export interface MarqueReport {
  checkedAt: string;
  enabled: boolean;
  budgetPence: number;
  /** Spent on our marques created in the last 24 real hours. */
  spentPence: number;
  /** Prize money our marques have earned (all listed). */
  prizePence: number;
  zones: MarqueZoneReport[];
  action: string;
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
const INIT_BACKOFF_MS  = [5_000, 10_000, 20_000, 40_000, 60_000];
const LOG_LIMIT        = 400;
const GUN_PRICE_PENCE  = 15_000;
/** Spare cash kept in every non-home region for berth dues and stores. */
const REGION_FLOOR_PENCE = 20_000;
/** The home reserve covers at least this many game days of fleet upkeep. */
const UPKEEP_DAYS_RESERVED = 1.5;
/** A refit must improve a load's expected profit by this share to be worth the berth call. */
const REFIT_MIN_GAIN = 0.02;
/** How often letters of marque are judged (and presence ports re-read for sightings). */
const MARQUE_CHECK_MS = 5 * 60_000;
/** Marques are bought one game day at a time and judged again before another. */
const MARQUE_GAME_HOURS = 24;
/** Expected prize money must cover the cost plus our own extra losses this many times over. */
const MARQUE_SAFETY = 1.5;
/** Fewest laden rival passages a game day before a zone is considered at all. */
const MARQUE_MIN_LADEN = 3;
/** The Crown's minimum charge for a marque (100 Cr). */
const MARQUE_MIN_PENCE = 10_000;
/** How often the open insurance policies are judged. */
const UNDERWRITE_CHECK_MS = 60_000;
/** Resident Factor setup fee (its daily salary comes on top). */
const FACTOR_FEE_PENCE = 75_000;
/** Spare cash wanted for a hull when no quote has been seen yet, before hiring a factor to price one. */
const FACTOR_HULL_GUESS_PENCE = 2_000_000;
/** After a factor hire that led to no build (or failed), wait this long before hiring again. */
const FACTOR_RETRY_MS = 30 * 60_000;
/** The cash kept back near a phase stays back this long after the tier turns over. */
const PHASE_CHEST_GRACE_MS = 60 * 60_000;
/** The tier counts as close to completing at this progress, or this soon at its recent pace. */
const PHASE_SOON_BPS = 9_000;
const PHASE_SOON_MS = 2 * 60 * 60 * 1000;
/** Share of the fleet's own return on cash charged on what a load ties up, while cash is scarce. */
const CAPITAL_CHARGE_WEIGHT = 0.5;
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
  private homePort: string | null = null;
  /** The last hull quote per `yard|class` (pence): prices a build at a yard where we have no presence yet. */
  private readonly hullQuotes = new Map<string, number>();
  /** Factor passes in a row that built nothing: each one backs off longer. */
  private factorFails = 0;
  /** Factors the buyer hired for a build and hasn't dismissed yet (never the user's own). */
  private readonly tempFactors = new Set<string>();
  private factorBlockedUntil = 0;
  private canRemit = true;
  private logLines: FleetLogLine[] = [];
  private purchases: PurchaseRecord[] = [];
  private topLanes: Lane[] = [];
  private buyer = "not checked yet";
  private marqueReport: MarqueReport | null = null;
  private lastMarqueCheck = 0;
  private underwriteReport: UnderwriteReport | null = null;
  private lastUnderwriteCheck = 0;
  /** The player's companies (ids), never traded with as rivals. */
  private readonly ourCompanyIds = new Set<string>();
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
      marques: this.marqueReport,
      underwriting: this.underwriteReport,
      expansion: this.expansionReport(),
      capitalRate: this.capitalRate(),
      log: [...this.logLines],
    };
  }

  private expansionReport(): ExpansionReport | null {
    const w = this.world;
    if (w.tierTargetPhase === null) return null;
    return {
      targetPhase: w.tierTargetPhase,
      progressBps: w.tierProgressBps,
      etaMs: w.tierEtaMs,
      phaseSoon: this.phaseSoon() && this.settings.autoBuy && this.settings.phaseChestPct > 0 && this.agents.size < this.settings.maxShips,
      escalation: { ...w.escalation },
      charters: [...w.expansionWatch.values()].sort((a, b) => Number(b.stalled) - Number(a.stalled) || b.rate - a.rate),
    };
  }

  /** The expansion tier is close to completing: the next one's charters are worth cash in hand. */
  private phaseSoon(): boolean {
    const w = this.world;
    // Still keep it for a while after the tier turns over: the new tier's charters need it then.
    if (w.tierTurnedAt !== null && w.now() - w.tierTurnedAt < PHASE_CHEST_GRACE_MS) return true;
    if (w.tierTargetPhase === null) return false;
    return w.tierProgressBps >= PHASE_SOON_BPS || (w.tierEtaMs !== null && w.tierEtaMs < PHASE_SOON_MS);
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
    // A factor the buyer hired must not keep drawing salary: try a few times before giving up.
    for (let i = 0; i < 3 && this.tempFactors.size > 0; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, 1_000));
      await this.dismissTempFactors();
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
    this.homePort = profile.company.home_port_id;
    this.world.companyId = profile.company.id;
    // Every company of this player: their ships aren't rivals and their policies aren't ours to write.
    this.ourCompanyIds.add(profile.company.id);
    this.world.rivals.ours.add(profile.company.name);
    const player = await this.client.playerProfile().catch(() => null);
    for (const c of player?.companies ?? []) {
      this.ourCompanyIds.add(c.id);
      this.world.rivals.ours.add(c.name);
    }
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
    if (now - this.lastMarqueCheck > MARQUE_CHECK_MS) {
      this.lastMarqueCheck = now;
      await this.runMarques().catch((e) => {
        if (this.isFatal(e)) throw e;
        this.log("fleet", `marque check failed: ${(e as Error).message}`);
      });
    }
    if (now - this.lastUnderwriteCheck > UNDERWRITE_CHECK_MS) {
      this.lastUnderwriteCheck = now;
      await this.runUnderwriting().catch((e) => {
        if (this.isFatal(e)) throw e;
        this.log("fleet", `underwriting check failed: ${(e as Error).message}`);
      });
    }
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
      this.topLanes = await rankLanes(this.world, this.specFor(ref, r), from, this.reservations(ref), this.planOptions(this.loadCash(ref), ref));
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

  /** `except`: the ship being planned for, whose own pending load isn't someone else's claim on cash. */
  private planOptions(cash: number | null, except?: ShipAgent) {
    return {
      minMargin: this.settings.minMarginPence,
      freight: this.settings.useFreight,
      bonusWeight: this.settings.bonusWeightPct / 100,
      cash,
      capitalRate: this.capitalRate(except),
      holdForRepost: this.settings.holdForRepost,
    };
  }

  /**
   * While cash is what limits the fleet (a ship waits for it, or what is spare wouldn't fill half a
   * typical load), money a load ties up is charged at part of the fleet's own return on cash: profit
   * per hour over the cash its current loads hold. 0 otherwise.
   */
  private capitalRate(except?: ShipAgent): number {
    const others = [...this.agents.values()].filter((a) => a !== except);
    const lanes = others.map((a) => a.lane).filter((l): l is Lane => !!l && (l.capital ?? 0) > 0 && l.profitPerHour > 0);
    if (lanes.length === 0) return 0;
    const capital = lanes.reduce((n, l) => n + l.capital, 0);
    const scarce = others.some((a) => a.waitingForCash) || this.loadCash(except) < (capital / lanes.length) * 0.5;
    if (!scarce) return 0;
    return (CAPITAL_CHARGE_WEIGHT * lanes.reduce((n, l) => n + l.profitPerHour, 0)) / capital;
  }

  /** Cash a ship can spend on its next load: spare cash in every region, less loads other ships are bound to buy. */
  private loadCash(except?: ShipAgent): number {
    let committed = 0;
    for (const a of this.agents.values()) if (a !== except) committed += this.committedBy(a);
    return Math.max(0, this.spareCash() - committed);
  }

  /** Cash a ship's lane still has to spend: goods not yet bought, collateral for lots not yet taken. */
  private committedBy(a: ShipAgent): number {
    return a.partsToBuy().reduce((n, p) => n + p.tons * p.costPerTon, 0) + a.freightToTake().reduce((n, f) => n + f.collateral, 0);
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
      case "ship_sailed":
      case "ship_entered_port":
        this.world.rivals.addEvent(e.event_type, e.port_id, e.payload, e.timestamp);
        break;
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
        if (id && remaining === 0) this.world.markClosed(id, e.event_type === "charter_expired");
        // A lapsed expansion posting is re-posted: fetch it soon.
        if (id && e.event_type === "charter_expired" && this.world.renews({ id })) {
          this.worldDirty = true;
          this.wake?.();
        }
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
      case "marque_prize_paid": {
        const amount = num("amount_pence") ?? num("bonus_pence") ?? num("payout_pence") ?? num("prize_pence");
        this.log("fleet", `${e.event_type.replace(/_/g, " ")}${amount ? `: ${cr(amount)}` : ""}`);
        break;
      }
      case "insurance_claim_paid": {
        // Sent to the insured and to every underwriter: for us it is income or a payout.
        const amount = num("amount_pence") ?? num("payout_pence") ?? num("claim_pence");
        const insured = str("insured_company_id");
        const ours = insured !== undefined && this.ourCompanyIds.has(insured);
        const what = insured === undefined ? "insurance claim paid" : ours ? "insurance claim received" : "insurance claim paid out of our collateral";
        this.log("fleet", `${what}${amount ? `: ${ours ? "" : insured === undefined ? "" : "−"}${cr(amount)}` : ""}${str("policy_id") ? ` (policy ${str("policy_id")!.slice(0, 8)})` : ""}`);
        break;
      }
    }
  }

  /**
   * What other ships are bound for: charter room they will fill, source depth they will buy, buyers
   * at a port they will sell to, and freight lots they mean to take.
   */
  private reservations(except?: ShipAgent): Reservations {
    const charterTons = new Map<string, number>();
    const sourceTons = new Map<string, number>();
    const sellTons = new Map<string, number>();
    const freightIds = new Set<string>();
    const charterLandsAt = new Map<string, number>();
    const add = (m: Map<string, number>, k: string, t: number) => m.set(k, (m.get(k) ?? 0) + t);
    for (const a of this.agents.values()) {
      if (a === except || !a.lane) continue;
      const lane = a.lane;
      // Keyed by the posting that now stands for each charter (a lapsed one's re-post).
      for (const [id, t] of lane.fills) {
        const cur = this.world.currentId(id);
        add(charterTons, cur, t);
        if (!lane.holdMs && lane.deliverAt) charterLandsAt.set(cur, Math.min(charterLandsAt.get(cur) ?? Infinity, lane.deliverAt));
      }
      for (const p of a.partsToBuy()) add(sourceTons, `${lane.source}|${p.good}`, p.tons);
      for (const p of lane.parts) if (p.kind === "market") add(sellTons, `${lane.dest}|${p.good}`, p.tons);
      for (const f of a.freightToTake()) freightIds.add(f.id);
    }
    return { charterTons, sourceTons, sellTons, freightIds, charterLandsAt };
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
    const lanes = await rankLanes(this.world, this.specFor(agent, r), from, this.reservations(agent), this.planOptions(cash, agent));
    const best = lanes.find((l) => !agent.isAvoided(l.key)) ?? null;
    agent.setLane(best);
    if (best) agent.noteLane(best);
    if (best && best.key !== prev?.key) {
      const load = [
        ...best.parts.map((p) => `${p.tons} t ${p.good}${p.kind === "market" ? " to sell" : ""}`),
        ...(best.freight.length ? [`${best.freight.reduce((n, f) => n + f.tons, 0)} t freight`] : []),
      ].join(" + ");
      this.log(
        agent.name,
        `lane: ${load} ${best.source} → ${best.dest}, margin ~${cr(best.margin)}/t` +
          `${best.bonus > 0 ? ` incl. ~${cr(best.bonus)}/t phase bonus` : ""}${best.askKnown ? "" : " (ask estimated)"}, ~${cr(best.profitPerHour)}/h` +
          `${best.holdMs > 0 ? `, holding ~${Math.round(best.holdMs / 1000)}s at ${best.dest} for a stalled charter's re-post` : ""}` +
          `${best.next ? `; then ${best.next}` : ""}`,
      );
    } else if (!best && prev) {
      this.log(agent.name, `no lane clears the minimum margin with the ${cr(cash)} the fleet can spend right now`);
    }
    return best;
  }

  releaseLane(agent: ShipAgent): void {
    agent.setLane(null);
  }

  /** Room in a charter this ship may deliver into: what other ships already carrying cargo for it leave. */
  charterRoomFor(agent: ShipAgent, charterId: string, remaining: number): number {
    let held = 0;
    for (const a of this.agents.values()) {
      if (a === agent || !a.lane || !a.loaded) continue;
      for (const [id, t] of a.lane.fills) if (this.world.currentId(id) === charterId) held += t;
    }
    return Math.max(0, remaining - held);
  }

  /** Another of our ships' hold at this port on this good for a re-post, if any. */
  siblingHold(agent: ShipAgent, port: string, good: string): HoldInfo | undefined {
    for (const a of this.agents.values()) {
      const h = a !== agent ? a.holdAt(port, good) : undefined;
      if (h) return h;
    }
    return undefined;
  }

  /** Whether another ship's lane means to take this freight lot. */
  freightClaimed(agent: ShipAgent, id: string): boolean {
    for (const a of this.agents.values()) if (a !== agent && a.lane?.freight.some((f) => f.id === id)) return true;
    return false;
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

  // ── Letters of marque ───────────────────────────────────────────────────────

  /**
   * Our own ships' exposure per sea zone (cargo value × game days in the zone × gun deterrence, a
   * game day): a marque raises piracy on our passages too.
   */
  private async ownExposure(): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    const dayMs = 24 * 60 * this.world.gameMinuteMs;
    for (const a of this.agents.values()) {
      const lane = a.lane;
      const knots = ((this.world.shipClass(a.shipClass)?.base_speed_centiknots ?? 800) / 100) * 0.85;
      const det = 1 / (1 + 0.5 * (a.last?.ship.cannons_count ?? 0));
      if (!lane) {
        // No lane (yet): a ship at sea still carries its cargo through the rest of its voyage.
        const r = a.last;
        if (!r || r.ship.status !== "sailing") continue;
        const value = Object.entries(r.cargo_manifest).reduce((n, [g, t]) => n + t * this.world.basePrice(g), 0);
        if (value <= 0) continue;
        const rest = { legs: r.route_legs.slice(r.ship.current_leg_idx) };
        for (const [zone, days] of zoneDays(this.world.catalog, rest, knots)) out.set(zone, (out.get(zone) ?? 0) + value * days * det);
        continue;
      }
      const plan = await this.world.route(lane.source, lane.dest, a.shipClass).catch(() => null);
      if (!plan) continue;
      // Goods at what they fetch or cost (whichever is more); sealed freight at ~3x its collateral.
      const value =
        lane.parts.reduce((n, p) => n + p.tons * Math.max(p.costPerTon, p.pay), 0) + lane.freight.reduce((n, f) => n + 3 * f.collateral, 0);
      const tripsPerDay = lane.loopMs > 0 ? dayMs / Math.max(lane.loopMs, 60_000) : 1;
      for (const [zone, days] of zoneDays(this.world.catalog, plan, knots)) out.set(zone, (out.get(zone) ?? 0) + value * days * det * tripsPerDay);
    }
    return out;
  }

  /**
   * Re-reads the ports where we have presence for rival sailings, judges a marque in every zone
   * rival traffic crosses, and (when enabled, within the budget) sponsors the most profitable one
   * that clears the safety margin, for one game day.
   */
  private async runMarques(): Promise<void> {
    const { world, client, settings } = this;
    const ports = new Set<string>();
    for (const a of this.agents.values()) {
      const s = a.last?.ship;
      if (s && s.status !== "sailing" && s.current_port_id) ports.add(s.current_port_id);
    }
    for (const p of await client.factors().catch(() => [] as string[])) ports.add(p);
    await Promise.all(
      [...ports].map(async (p) => {
        const detail = await client.port(p).catch(() => null);
        if (detail) world.observeGossip(detail);
      }),
    );
    const now = world.now();
    world.rivals.prune(now, world.gameMinuteMs);

    const [zones, ours] = await Promise.all([client.zones(), this.recentMarques(now)]);
    const spent = ours.filter((m) => now - Date.parse(m.created_at) < 24 * 3_600_000).reduce((n, m) => n + m.cost_pence, 0);
    const prize = ours.reduce((n, m) => n + m.prize_earned_pence, 0);
    const active = new Set(ours.filter((m) => Date.parse(m.expires_at) > now).map((m) => m.sea_zone_id));
    const { zones: traffic } = await analyseRivals(world.rivals.all(), {
      catalog: world.catalog,
      route: (f, t, c) => world.route(f, t, c).catch(() => null),
      now,
      gameMinuteMs: world.gameMinuteMs,
      piracy: new Map(zones.map((z) => [z.sea_zone_id, z.net_piracy_bps])),
    });
    const own = await this.ownExposure();

    // Marques are sized to what the budget has left (a game day of it), not refused for being big.
    const days = MARQUE_GAME_HOURS / 24;
    const left = Math.max(0, settings.marqueBudgetPence - spent);
    const maxBps = left >= MARQUE_MIN_PENCE ? Math.floor(left / (MARQUE_PENCE_PER_BPS_DAY * days) / 50) * 50 : 0;

    const rows: MarqueZoneReport[] = [];
    for (const t of traffic) {
      const z = zones.find((x) => x.sea_zone_id === t.zone);
      if (!z || z.phase > world.unlockedPhase) continue;
      const best = bestMarque(z, t.exposure, own.get(t.zone) ?? 0, Math.max(50, maxBps));
      const verdict = active.has(t.zone)
        ? "our marque is in force"
        : best.bps === 0
          ? "the zone's marques are at their cap"
          : t.laden < MARQUE_MIN_LADEN
            ? `too little laden traffic seen (${t.laden.toFixed(1)} a game day; needs ${MARQUE_MIN_LADEN})`
            : best.profit <= 0 || best.prize < MARQUE_SAFETY * (best.cost + best.ownLoss)
              ? `doesn't pay: prize ~${cr(best.prize)} vs cost ${cr(best.cost)} + our losses ${cr(best.ownLoss)} a game day`
              : "pays";
      rows.push({ zone: t.zone, passages: t.passages, laden: t.laden, cargo: Math.round(t.cargo), best, active: active.has(t.zone), verdict });
    }
    rows.sort((a, b) => b.best.profit - a.best.profit);

    const pick = rows.find((r) => r.verdict === "pays");
    const cost = pick ? Math.max(MARQUE_MIN_PENCE, Math.round(MARQUE_PENCE_PER_BPS_DAY * pick.best.bps * days)) : 0;
    let action = rows.length === 0 ? "no rival traffic seen yet" : "no zone pays";
    // Our own exposure is only known once every ship has reported in.
    const unready = [...this.agents.values()].some((a) => !a.last);
    if (pick && !settings.marques) action = `off: would sponsor ${pick.best.bps} bps in ${pick.zone} for ${cr(cost)} (~${cr(pick.best.profit)} a game day)`;
    else if (pick && unready) action = "waiting for every ship to report before weighing our own losses";
    else if (pick && (maxBps < 50 || spent + cost > settings.marqueBudgetPence)) action = `budget: ${cr(spent)} of ${cr(settings.marqueBudgetPence)} spent in the last 24 h`;
    else if (pick) {
      action = await this.withCash(async () => {
        // Anything may have changed while waiting for the lock: the setting, the budget, a stop.
        if (this.stopRequested || !this.settings.marques) return "cancelled: auto-marques were turned off";
        if (spent + cost > this.settings.marqueBudgetPence) return `budget: ${cr(spent)} of ${cr(this.settings.marqueBudgetPence)} spent in the last 24 h`;
        // Only spare money: never what the fleet's loads need, never by remitting.
        if ([...this.agents.values()].some((a) => a.waitingForCash)) return "a ship is waiting for cash: no marque";
        await world.refreshVaults();
        const home = this.homeRegion ?? "channel";
        let committed = 0;
        for (const a of this.agents.values()) committed += this.committedBy(a);
        if (this.spareCash() - committed < cost || world.vault(home) - this.floorIn(home) < cost) return `no spare cash for a ${cr(cost)} marque`;
        try {
          const m = await client.issueMarque({ sea_zone_id: pick.zone, added_piracy_bps: pick.best.bps, duration_game_hours: MARQUE_GAME_HOURS });
          world.vaults.set(home, world.vault(home) - m.cost_pence);
          this.log("fleet", `letter of marque: +${m.added_piracy_bps} bps in ${pick.zone} for ${cr(m.cost_pence)} (expect ~${cr(pick.best.prize)} prize a game day)`);
          this.worldDirty = true;
          pick.active = true;
          pick.verdict = "our marque is in force";
          return `sponsored ${m.added_piracy_bps} bps in ${pick.zone} for ${cr(m.cost_pence)}`;
        } catch (e) {
          if (this.isFatal(e)) throw e;
          this.log("fleet", `letter of marque in ${pick.zone} refused: ${(e as Error).message}`);
          return `marque refused: ${(e as Error).message}`;
        }
      });
    }
    this.marqueReport = {
      checkedAt: new Date().toISOString(),
      enabled: settings.marques,
      budgetPence: settings.marqueBudgetPence,
      spentPence: spent,
      prizePence: prize,
      zones: rows,
      action,
    };
  }

  /** Our marques, paged back until one is older than a real day (enough for the spending window). */
  private async recentMarques(now: number): Promise<LetterOfMarque[]> {
    const out: LetterOfMarque[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const batch = await this.client.marques({ cursor, limit: 200 });
      out.push(...batch);
      if (batch.length < 200 || batch.some((m) => now - Date.parse(m.created_at) > 24 * 3_600_000)) break;
      cursor = batch[batch.length - 1].id;
    }
    return out;
  }

  // ── Underwriting ────────────────────────────────────────────────────────────

  /**
   * Judges the open policies of other companies and (when enabled) writes slices on those whose
   * premium beats the loss bound Lloyd's acceptance implies by the minimum edge, within the budget.
   */
  private async runUnderwriting(): Promise<void> {
    const { world, client, settings } = this;
    if (!world.companyId) return;
    const [open, active, held, vaults] = await Promise.all([
      client.policies({ status: "open", limit: 200 }),
      client.policies({ status: "active", limit: 200 }),
      // Slices any of our companies wrote, whatever their status: that cover says nothing about Lloyd's.
      Promise.all([...this.ourCompanyIds].map((id) => client.policies({ underwriter_company_id: id, limit: 200 }))).then((x) => x.flat()),
      client.vaults(),
    ]);
    const locked = vaults.vaults.filter((v) => v.account_type === "escrow").reduce((n, v) => n + Math.max(0, v.balance_pence), 0);
    const rows = judgePolicies([...open, ...active], {
      ours: this.ourCompanyIds,
      now: world.now(),
      gameMinuteMs: world.gameMinuteMs,
      budgetPence: settings.underwriteBudgetPence,
      lockedPence: locked,
      maxPerPolicyPence: settings.underwriteMaxPerPolicyPence,
      minEdgeBps: settings.underwriteMinEdgeBps,
      held: new Set(held.map((p) => p.id)),
    });

    const toWrite = rows.filter((r) => r.verdict === "write");
    let action = toWrite.length === 0 ? "nothing to write" : `off: would write ${toWrite.length} slice${toWrite.length === 1 ? "" : "s"}`;
    let lockedNow = locked;
    if (settings.underwrite && toWrite.length > 0) {
      let written = 0;
      for (const r of toWrite) {
        const ok = await this.withCash(async () => {
          // Anything may have changed while waiting for the lock: the setting, the caps, a stop.
          if (this.stopRequested || !this.settings.underwrite) return false;
          if (r.collateral > this.settings.underwriteMaxPerPolicyPence || lockedNow + r.collateral > this.settings.underwriteBudgetPence) return false;
          if ([...this.agents.values()].some((a) => a.waitingForCash)) return false;
          await world.refreshVaults();
          let committed = 0;
          for (const a of this.agents.values()) committed += this.committedBy(a);
          if (this.spareCash() - committed < r.collateral) return false;
          // The docs don't say which region's vault the collateral leaves: each candidate keeps its floor.
          const home = this.homeRegion ?? "channel";
          for (const reg of new Set([home, world.region(r.origin)])) if (world.vault(reg) - this.floorIn(reg) < r.collateral) return false;
          try {
            await client.underwrite({ policy_id: r.policy, slice_bps: r.sliceBps });
            this.log("fleet", `underwrote ${r.sliceBps / 100}% of ${r.lane} (${r.cover}, ${r.premiumBps} bps): ${cr(r.collateral)} collateral for ${cr(r.premiumShare)} premium`);
            r.verdict = "written";
            lockedNow += r.collateral;
            await world.refreshVaults().catch(() => undefined);
            return true;
          } catch (e) {
            if (this.isFatal(e)) throw e;
            r.verdict = `refused: ${(e as Error).message}`;
            return false;
          }
        });
        if (ok) written++;
        else if (r.verdict === "write") r.verdict = "no spare cash, or the budget changed";
      }
      action = written ? `wrote ${written} slice${written === 1 ? "" : "s"}` : "no slice written (cash or refusals)";
    } else if (!settings.underwrite && toWrite.length === 0) action = "off: nothing would be written";
    this.underwriteReport = {
      checkedAt: new Date().toISOString(),
      enabled: settings.underwrite,
      budgetPence: settings.underwriteBudgetPence,
      lockedPence: lockedNow,
      rows: rows.slice(0, 25),
      action,
    };
  }

  /** Sightings and the last marque report, for the dashboard. */
  get rivalSightings() {
    return this.world.rivals.all();
  }

  // ── Buying ships ────────────────────────────────────────────────────────────

  /** Money spent mounting guns counts with the fleet's ship spending. */
  noteArmed(shipId: string, costPence: number): void {
    this.shipSpendPence += costPence;
    const p = this.purchases.find((x) => x.shipId === shipId);
    if (p) p.costPence += costPence;
  }

  /** The open shipyard nearest the fleet's work, for a factor to build at; null if none. */
  private factorYard(): string | null {
    const { world } = this;
    const yards = world.catalog.ports.filter((p) => p.has_shipyard && world.isOpen(p.id));
    if (yards.length === 0) return null;
    // Where the fleet's lanes start (or end) earns a yard its weight; the home port and hubs break ties.
    const score = new Map<string, number>(yards.map((p) => [p.id, (p.id === this.homePort ? 2 : 0) + (p.is_hub ? 1 : 0)]));
    for (const a of this.agents.values()) {
      const l = a.lane;
      if (!l) continue;
      const w = Math.max(1, l.profitPerHour / 100);
      if (score.has(l.source)) score.set(l.source, score.get(l.source)! + 2 * w);
      if (score.has(l.dest)) score.set(l.dest, score.get(l.dest)! + w);
    }
    for (const l of this.topLanes.slice(0, 3)) if (score.has(l.source)) score.set(l.source, score.get(l.source)! + 1);
    return [...score].sort((a, b) => b[1] - a[1])[0][0];
  }

  /** Hires a factor at `yard` for a build (fee from that yard's region). False if it couldn't. */
  private async hireTempFactor(yard: string): Promise<boolean> {
    const { world } = this;
    const region = world.region(yard);
    const hired = await this.withCash(async () => {
      if (this.stopRequested || !this.settings.yardFactor) return false;
      const cash = await this.ensureCash(region, FACTOR_FEE_PENCE);
      if (cash < FACTOR_FEE_PENCE) return false;
      try {
        await this.client.hireFactor(yard);
        world.vaults.set(region, world.vault(region) - FACTOR_FEE_PENCE);
        return true;
      } catch (e) {
        if (this.isFatal(e)) throw e;
        this.log("fleet", `hiring a factor at ${yard} failed: ${(e as Error).message}`);
        // Outcome unknown (network, 5xx): if the hire went through after all, it is ours to dismiss.
        if (!isApiError(e) || e.status >= 500) {
          const now = await this.client.factors().catch(() => [] as string[]);
          if (now.includes(yard)) this.tempFactors.add(yard);
        }
        return false;
      }
    });
    if (!hired) {
      this.factorFailed();
      return false;
    }
    this.tempFactors.add(yard);
    this.log("fleet", `hired a Resident Factor at ${yard} (${cr(FACTOR_FEE_PENCE)}) to build there; dismissing it after`);
    return true;
  }

  /** A factor pass built nothing: hold off hiring again, longer each time in a row. */
  private factorFailed(): void {
    this.factorBlockedUntil = Date.now() + FACTOR_RETRY_MS * 2 ** Math.min(this.factorFails, 4);
    this.factorFails++;
  }

  /** Dismisses the factors the buyer hired for builds (kept to retry if a dismissal fails). */
  private async dismissTempFactors(): Promise<void> {
    for (const yard of [...this.tempFactors]) {
      try {
        await this.client.dismissFactor(yard);
        this.tempFactors.delete(yard);
        this.log("fleet", `dismissed the factor at ${yard}`);
      } catch (e) {
        if (isApiError(e) && (e.status === 404 || e.status === 409)) this.tempFactors.delete(yard);
        else this.log("fleet", `dismissing the factor at ${yard} failed (${(e as Error).message}); retrying later`);
      }
    }
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
    // A factor hired for a build never outlives the buyer pass that hired it (a failed dismissal is retried here).
    await this.dismissTempFactors();
    try {
      await this.considerPurchaseNow(only);
    } finally {
      await this.dismissTempFactors();
    }
  }

  private async considerPurchaseNow(only: string[] | null): Promise<void> {
    const { world, settings } = this;
    if (this.agents.size >= settings.maxShips) return this.setBuyer(`fleet at the ${settings.maxShips}-ship limit`);
    const classes = world.catalog.ship_classes.filter((c) => settings.buyClasses.includes(c.id) && c.phase <= world.unlockedPhase);
    if (classes.length === 0) return this.setBuyer("no allowed hull class can be built in this phase");
    if ([...this.agents.values()].some((a) => a.waitingForCash)) return this.setBuyer("a ship is waiting for cash to load: not buying");

    await world.refreshVaults();
    // Cash the existing fleet still needs for loads it is bound to buy comes first.
    let committed = 0;
    for (const a of this.agents.values()) committed += this.committedBy(a);
    const loose = this.spareCash() - committed;
    // Close to a new phase: part of it stays in hand for the new tier's charters.
    const chest = this.phaseSoon() ? Math.max(0, Math.round((loose * settings.phaseChestPct) / 100)) : 0;
    const spare = loose - chest;
    const justTurned = world.tierTurnedAt !== null && world.now() - world.tierTurnedAt < PHASE_CHEST_GRACE_MS;
    const chestNote = chest > 0 ? `, ${cr(chest)} kept back: ${justTurned ? "a new tier just opened" : `phase ${world.tierTargetPhase} is close`}` : "";

    // Building needs presence: a ship of ours in a yard port (re-read when not called by that ship), or a factor.
    // Presence that couldn't be read counts as unknown: no factor is hired on a failed read.
    const yards = new Set<string>(only ?? []);
    let presenceKnown = true;
    if (!only) {
      for (const a of this.agents.values()) {
        const s = a.last?.ship;
        if (!s || s.status === "sailing" || !s.current_port_id || !world.port(s.current_port_id)?.has_shipyard) continue;
        const fresh = await this.client.ship(a.shipId).catch(() => null);
        if (!fresh) presenceKnown = false;
        else if (fresh.ship.status !== "sailing" && fresh.ship.current_port_id === s.current_port_id) yards.add(s.current_port_id);
      }
      const factors = await this.client.factors().catch((e) => {
        if (this.isFatal(e)) throw e;
        presenceKnown = false;
        return [] as string[];
      });
      for (const p of factors) if (world.port(p)?.has_shipyard && world.isOpen(p)) yards.add(p);
    }
    if (spare <= 0) return this.setBuyer(`no spare cash: ${cr(committed)} is committed to loads the fleet is about to buy${chestNote}`);

    // No presence at any yard: price a build at the yard nearest the work from the last quotes seen
    // (a factor would be hired for it). With no quotes yet, a factor is hired to get some.
    let factorYard: string | null = null;
    let factorPriced = false;
    if (yards.size === 0 && !only && settings.yardFactor && presenceKnown && Date.now() >= this.factorBlockedUntil) {
      const yard = this.factorYard();
      const known = !!yard && classes.some((c) => this.hullQuotes.has(`${yard}|${c.id}`));
      // Before hiring just to get a quote: the cheapest hull seen at any yard, or a guess.
      const seen = classes.flatMap((c) => [...this.hullQuotes].filter(([k]) => k.endsWith(`|${c.id}`)).map(([, v]) => v));
      const hullGuess = seen.length ? Math.min(...seen) : FACTOR_HULL_GUESS_PENCE;
      if (yard && known) {
        factorYard = yard;
        factorPriced = true;
      } else if (yard && spare >= FACTOR_FEE_PENCE + hullGuess && (await this.hireTempFactor(yard))) {
        yards.add(yard);
        factorYard = yard;
      }
    }
    if (yards.size === 0 && !factorPriced) return this.setBuyer(`waiting for a ship to call at a shipyard (spare ${cr(spare)} after ${cr(committed)} for loads${chestNote})`);

    type Option = { yard: string; cls: string; hull: number; guns: number; cost: number; payback: number; net: number; lane: Lane; upkeepFloor: number };
    const options: Option[] = [];
    const notes: string[] = [];
    const now = world.now();

    for (const yard of factorPriced ? [factorYard!] : yards) {
      for (const cls of classes) {
        let price: number;
        if (factorPriced) {
          // Priced from the last quote seen (re-quoted for real once the factor is there).
          const q = this.hullQuotes.get(`${yard}|${cls.id}`);
          if (q === undefined) continue;
          price = q;
        } else {
          let quote;
          try {
            quote = await this.client.shipyardQuote(yard, cls.id, "turnkey_cash");
          } catch (e) {
            if (this.isFatal(e)) throw e;
            notes.push(`${cls.id}@${yard}: ${(e as Error).message}`);
            continue;
          }
          if (!quote.available || !quote.total_cost_pence) {
            this.hullQuotes.delete(`${yard}|${cls.id}`);
            notes.push(`${cls.id}@${yard}: materials not in stock`);
            continue;
          }
          this.hullQuotes.set(`${yard}|${cls.id}`, quote.total_cost_pence);
          price = quote.total_cost_pence;
        }
        // "full" arms new hulls at once; "auto" builds them bare and refits on a pirate-heavy lane.
        const guns = settings.guns === "full" ? cls.max_cannons : 0;
        const hull = price;
        // A build at a factor's yard pays the factor's fee too.
        const cost = hull + guns * GUN_PRICE_PENCE + (yard === factorYard ? FACTOR_FEE_PENCE : 0);
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
        // The charters it would serve must last, and hold enough tons, to pay the ship back. Expansion
        // charters re-post when they lapse: they last as long as the tier (at its recent pace) and
        // together take no more than the tier still needs.
        const tierHours = world.tierEtaMs !== null ? world.tierEtaMs / 3_600_000 : Infinity;
        const expiries = lane.fills.map(([id]) => {
          const c = world.charters.find((x) => x.id === id);
          if (!c) return null;
          return world.renews(c) ? now + tierHours * 3_600_000 : c.expiresAt;
        }).filter((x): x is number => x !== null);
        const hoursLeft = expiries.length ? (Math.min(...expiries) - now) / 3_600_000 : Infinity;
        const res = this.reservations();
        // What the tier still needs beyond the fleet's own loads for it.
        let claimed = 0;
        for (const [id, t] of res.charterTons) if (world.renews({ id })) claimed += t;
        let expansionTons = 0;
        const tonsLeft = lane.fills.reduce((n, [id]) => {
          const c = world.charters.find((x) => x.id === id);
          if (!c) return n;
          const t = Math.max(0, c.remaining - (res.charterTons.get(id) ?? 0));
          if (world.renews(c)) {
            expansionTons += t;
            return n;
          }
          return n + t;
        }, 0) + Math.min(expansionTons, Math.max(0, world.expansionTonsLeft - claimed));
        // A lane mostly served by charters ends when they fill; a mostly-market lane repeats.
        // (One-off freight lots don't count as repeatable work.)
        const marketTons = lane.parts.filter((p) => p.kind === "market").reduce((n, p) => n + p.tons, 0);
        const repeats = marketTons >= lane.tons * 0.3;
        const earnable = Math.min(net * Math.min(settings.maxPaybackHours, hoursLeft), repeats ? Infinity : lane.margin * tonsLeft);
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
      // A factor hired to price builds led to none: don't hire again for a while.
      if (factorYard && !factorPriced) this.factorFailed();
      const best = options[0];
      return this.setBuyer(
        best
          ? `best option ${best.cls} at ${best.yard} pays back in ${best.payback.toFixed(1)} h (limit ${settings.maxPaybackHours} h)`
          : `nothing affordable pays (${notes.slice(0, 3).join("; ") || `spare ${cr(spare)}`})`,
        true,
      );
    }
    // Priced without presence: hire the factor now, then the build below quotes it for real.
    if (factorPriced && !(await this.hireTempFactor(pick.yard))) {
      return this.setBuyer(`a ${pick.cls} at ${pick.yard} would pay back in ${pick.payback.toFixed(1)} h, but no factor could be hired there`, true);
    }

    // Name first: the TopStats fetch must not sit between raising the cash and spending it.
    const name = await pickShipName(new Set([...this.agents.values()].map((a) => a.name)));
    const region = world.region(pick.yard);
    const failLater = (why: string) => {
      this.lastBuy = Date.now() - BUY_COOLDOWN_MS + BUY_FAIL_COOLDOWN_MS;
      // A factor hired for this build earned nothing: don't hire one again straight away.
      if (pick.yard === factorYard) this.factorFailed();
      this.setBuyer(why, true);
      return null;
    };
    const built = await this.withCash(async () => {
      if (this.stopRequested) return null;
      // The quote may be minutes old by now: price it again and re-check what the fleet needs.
      const q = await this.client.shipyardQuote(pick.yard, pick.cls, "turnkey_cash").catch(() => null);
      if (!q?.available || !q.total_cost_pence || q.total_cost_pence > pick.hull * 1.05) {
        if (q?.total_cost_pence) this.hullQuotes.set(`${pick.yard}|${pick.cls}`, q.total_cost_pence);
        else this.hullQuotes.delete(`${pick.yard}|${pick.cls}`);
        return failLater(`the price of a ${pick.cls} at ${pick.yard} moved or it can't be built now`);
      }
      const price = q.total_cost_pence;
      await world.refreshVaults();
      let committedNow = 0;
      for (const a of this.agents.values()) committedNow += this.committedBy(a);
      if (this.spareCash() - committedNow - pick.upkeepFloor - chest < price) {
        return failLater(`after the fleet's loads${chest > 0 ? " and the cash kept for the next phase" : ""} there is no longer ${cr(price)} spare for a ${pick.cls}`);
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
    this.factorFails = 0;
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
