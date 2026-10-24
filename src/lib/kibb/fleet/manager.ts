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
 * A load is planned on the cash spare when its ship reaches the source (cashFlows/cashAt: our other
 * ships' loads bought first, a share of what our cargo at sea is due to be paid before then), planned
 * again there just before buying (resizeLane), and never spends what another ship's load counts on.
 *
 * Stalls: for each stalled expansion posting the fleet makes one call (stallStakes): let it lapse for
 * its richer re-post (no ship delivers into it; loads planned into it that land first wait) when the
 * expected uplift beats what waiting costs, or deliver. A rival's delivery notice ends a camp at once.
 *
 * Events: a long poll on the company's event log wakes a ship's agent the moment something happens
 * to it (arrival, berth from the queue, eviction, hazard) and refreshes the world as soon as a
 * charter is posted, filled or expires, so idle ships re-plan at once. Public notices (a policy
 * listed, a convoy formed, a laden rival sailing) bring the rival check forward. Timers remain the fallback.
 * World events (shortages, gluts, pirate outbreaks, structural shifts) are read from the public feed
 * with every world refresh; see World.noteEvents.
 *
 * Progress (each ship's lane and cargo state, sell floors, trips, stats, purchases, the log, the
 * event cursor and the world model's memory) is saved as it changes (journal.ts: MongoDB when
 * MONGODB_URI is set, plus a local file) and picked up again on start, so a restart resumes work.
 *
 * Runs in-process in the Next.js server (fleet-registry.ts) or from the CLI (workers/kibb-fleet.ts).
 */

import { KibbClient, KIBB_DEFAULT_URL, isApiError } from "../client";
import { analyseRivals, bestMarque, MARQUE_PENCE_PER_BPS_DAY, rivalProfiles, zoneDays, type MarqueOption, type RivalAnalysis, type RivalDelivery, type ZoneTraffic } from "../rivals";
import type { ConvoyResult, ConvoyStatus, LetterOfMarque } from "../schema";
import { judgePolicies, type UnderwriteRow } from "./underwriter";
import type { StreamEvent } from "../schema";
import type { BankingRegion, BuildQuote, RoutePlan, ShipResult } from "../types";
import { ShipAgent, type AgentSnapshot, type AgentState, type AgentStats, type ConvoyOutcome, type FleetHost, type HoldInfo, type TripRecord } from "./agent";
import { openJournal, type Journal } from "./journal";
import { Advisor, AI_MODES, type AdvisorSnapshot, type AiMode, type AiReport } from "../ai/advisor";
import { AI_EFFORTS, AI_MODELS, type AiEffort, type AiModel } from "../ai/claude";
import type { DigestInput, DigestShip } from "../ai/digest";
import { acquireLease, type Lease } from "./lease";
import { pickShipName } from "./names";
import { HOLD_CAP_GAME_H, HOLD_MAX_GAME_H, rankLanes, REPOST_GRACE_GAME_MIN, type Lane, type Reservations, type ShipSpec, type StallStake } from "./planner";
import { World, type ExpansionWatch, type StormSummary, type WorldEventsReport, type WorldSnapshot } from "./world";

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
   * Share (0–200%) of the storm losses the planner expects that counts against a lane: cargo a storm
   * destroys on the laden passage and the rare sinking. 100 = as learned from our own voyages; 0
   * ignores storms (stores are still stocked for them).
   */
  stormWeightPct: number;
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
   * Sail in convoys with our other ships bound the same way soon (pirates board just one ship of a
   * convoy; guns are pooled), when the risk avoided outweighs the wait.
   */
  convoys: boolean;
  /**
   * Use rival intel beyond quay sightings (public insurance policies, public convoys, expansion
   * deliveries, the leaderboard) in charter crowding, stall holds and marques. On by default; off
   * behaves as before (quay sightings only) and stops the extra polling.
   */
  rivalIntel: boolean;
  /**
   * Build ships from materials bought on the yard port's own market into a warehouse there
   * ("bring your own materials"), skipping the yard's 15% turnkey markup, when that is cheaper.
   */
  byomBuilds: boolean;
  /**
   * With no presence at any shipyard, hire a Resident Factor (750 Cr) at the yard nearest the fleet's
   * work when a build there would pay back, build, and dismiss the factor straight after.
   */
  yardFactor: boolean;
  /**
   * Always let a stalled expansion posting lapse in its last few game hours (4), whatever the math
   * says: loads landing then wait for the richer re-post. Off by default.
   */
  holdForRepost: boolean;
  /**
   * Let a stalled expansion posting (nothing delivered in it) lapse for its richer re-post when the
   * expected uplift on our tons beats what waiting costs: no ship delivers into it meanwhile (ours
   * would cancel the escalation too) and runs are timed to land just after the lapse. On by default.
   */
  captureEscalations: boolean;
  /** Share (0–90%) of spare cash the buyer leaves alone while the expansion tier is close to completing. */
  phaseChestPct: number;
  /**
   * Plan each load again at its source, just before buying, with the cash there is then; never spend
   * there what our other ships' loads count on (a ship keeps first call on the share of its own load planned on cash in hand). On by default.
   */
  resizeLoads: boolean;
  /** Share (0–90%) of the cash our ships at sea are due to be paid that a load bought after it lands may count on (0: cash in hand only). Needs resizeLoads. */
  cashDuePct: number;
  /**
   * AI support (Claude as strategist): "off", "shadow" (advises and logs, changes nothing) or "live"
   * (its directives apply within limits). Off by default; needs ANTHROPIC_API_KEY.
   */
  ai: AiMode;
  /** Most the AI may spend on the Claude API in a UTC day, and in total (US dollars). */
  aiDailyCapUsd: number;
  aiTotalCapUsd: number;
  /** The strategist's model: Claude Opus 5.5 (best) or Claude Sonnet 5.5 (half the price). */
  aiModel: AiModel;
  /** How hard it thinks per answer (most of a call's cost): low, medium or high. */
  aiEffort: AiEffort;
  /** Minutes between routine calls (halved near a phase turnover); events call sooner. */
  aiIntervalMin: number;
  /**
   * Plan on world events: a shortage's dearer bids and a glut's cheaper asks (learned from the shocks
   * seen, fading by the news' lapse), and a shortage's crisis charter before it is listed (it shows
   * only on its quay, or as gossip hours later). Pirate outbreaks and structural shifts are always
   * taken in. On by default.
   */
  actOnEvents: boolean;
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
  stormWeightPct: 100,
  marques: false,
  marqueBudgetPence: 100_000,
  underwrite: false,
  underwriteBudgetPence: 500_000,
  underwriteMaxPerPolicyPence: 300_000,
  underwriteMinEdgeBps: 150,
  useFreight: true,
  convoys: true,
  rivalIntel: true,
  byomBuilds: true,
  yardFactor: true,
  holdForRepost: false,
  captureEscalations: true,
  actOnEvents: true,
  phaseChestPct: 40,
  resizeLoads: true,
  cashDuePct: 60,
  ai: "off",
  aiDailyCapUsd: 2,
  aiTotalCapUsd: 180,
  aiModel: "claude-opus-5-5",
  aiEffort: "low",
  aiIntervalMin: 60,
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
  num("stormWeightPct", 0);
  if (out.stormWeightPct !== undefined && out.stormWeightPct > 200) throw new FleetSettingsError("stormWeightPct must be 0 to 200");
  bool("autoBuy");
  bool("useFreight");
  bool("convoys");
  bool("rivalIntel");
  bool("byomBuilds");
  bool("marques");
  num("marqueBudgetPence", 0, true);
  bool("underwrite");
  num("underwriteBudgetPence", 0, true);
  num("underwriteMaxPerPolicyPence", 0, true);
  num("underwriteMinEdgeBps", 0, true);
  bool("yardFactor");
  bool("holdForRepost");
  bool("captureEscalations");
  bool("actOnEvents");
  num("phaseChestPct", 0);
  if (out.phaseChestPct !== undefined && out.phaseChestPct > 90) throw new FleetSettingsError("phaseChestPct must be 0 to 90");
  bool("resizeLoads");
  num("cashDuePct", 0);
  if (out.cashDuePct !== undefined && out.cashDuePct > 90) throw new FleetSettingsError("cashDuePct must be 0 to 90");
  if (patch.ai !== undefined) {
    if (!AI_MODES.includes(patch.ai)) throw new FleetSettingsError(`ai must be one of ${AI_MODES.join(", ")}`);
    out.ai = patch.ai;
  }
  num("aiDailyCapUsd", 0);
  num("aiTotalCapUsd", 0);
  if (patch.aiModel !== undefined) {
    if (!AI_MODELS.includes(patch.aiModel)) throw new FleetSettingsError(`aiModel must be one of ${AI_MODELS.join(", ")}`);
    out.aiModel = patch.aiModel;
  }
  if (patch.aiEffort !== undefined) {
    if (!AI_EFFORTS.includes(patch.aiEffort)) throw new FleetSettingsError(`aiEffort must be one of ${AI_EFFORTS.join(", ")}`);
    out.aiEffort = patch.aiEffort;
  }
  num("aiIntervalMin", 15, true);
  if (out.aiIntervalMin !== undefined && out.aiIntervalMin > 240) throw new FleetSettingsError("aiIntervalMin must be 15 to 240");
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
  /** Since when the totals, trips and time use run (the first start; kept across restarts). */
  progressSince: string | null;
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
  /** Cash as the planner sees it: spare, committed, due from cargo at sea, and loads re-sized at their source. */
  cash: CashReport;
  /** Storm season and what the fleet has learned about storms. */
  storms: StormSummary | null;
  /** World events in force, what the planner does with each, and what it has learned from them. */
  worldEvents: WorldEventsReport;
  /** AI support: mode, spend, the directives in force, recent decisions. */
  ai: AiReport;
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
  /** The fleet's call on each stalled posting (let it lapse or deliver), with its numbers. */
  stakes: StallStake[];
  /** Rival deliveries into this tier's charters seen lately, newest first. */
  rivalDeliveries: RivalDelivery[];
  /** Odds each stalled posting (`port|good`) re-posts richer if we don't deliver first (its stake's). */
  stallOdds: Record<string, number>;
}

/** A cash movement expected at server time `at`: a load still to buy (out), or cargo at sea paid where it lands (in). */
interface CashFlow {
  at: number;
  pence: number;
  /** Where an inflow lands (outflows: null). */
  region: BankingRegion | null;
}

/** Loads planned again at their source: how often, which way, and the tons moved. */
export interface ResizeStats {
  checks: number;
  grown: number;
  shrunk: number;
  /** Another lane loading at the same port won. */
  switched: number;
  tonsAdded: number;
  tonsCut: number;
  at: string | null;
}

export interface CashReport {
  sparePence: number;
  committedPence: number;
  /** Cash pay due from our cargo at sea at the share counted (cashDuePct), and when the first lands (server ms). */
  duePence: number;
  dueNextAt: number | null;
  resized: ResizeStats;
}

export interface MarqueZoneReport {
  zone: string;
  /** Rival passages and laden passages a game day, and their cargo (pence) at base prices. */
  passages: number;
  laden: number;
  cargo: number;
  /** Rival passages already announced for the next game day (rival intel). */
  next?: ZoneTraffic["next"];
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

/** Everything the manager saves (journal.ts) so a restart resumes where it left off. */
interface FleetSnapshot {
  progressSince: string;
  log: FleetLogLine[];
  purchases: PurchaseRecord[];
  retired: AgentStats;
  shipSpendPence: number;
  eventCursor: string | null;
  tempFactors: string[];
  hullQuotes: Array<[string, number]>;
  factorBlockedUntil: number;
  factorFails: number;
  pendingBuild: FleetManager["pendingBuild"];
  agents: Record<string, AgentSnapshot>;
  world: WorldSnapshot;
  ai?: AdvisorSnapshot;
  /** Postings being let lapse (id, `port|good`); absent in older saves. */
  camping?: Array<[string, string]>;
  /** Tons each camp shuts out, as seen before it began; absent in older saves. */
  campShut?: Array<[string, number]>;
  /** Loads planned again at their source; absent in older saves. */
  resized?: ResizeStats;
}

/** How often the progress is saved even when nothing much happened (time use, prices). */
const PERSIST_MS = 30_000;

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
/** Convoys: the longest a ship waits for our others (game hours), the shortest muster the game allows,
 * the least a passage must risk (pence) to be worth one, and how alike in speed members must be. */
const CONVOY_MAX_WAIT_GAME_H = 6;
const CONVOY_MIN_MUSTER_GAME_MIN = 60;
const CONVOY_MIN_EXPOSURE_PENCE = 5_000;
const CONVOY_MIN_SPEED_RATIO = 0.85;
/** Own-materials builds: the first bid's cap over the turnkey walk's average per ton, the most a
 * material may cost in all over the walk, the least a build must save to bother, and how long a
 * yard builds turnkey after an own-materials attempt there failed. */
const BYOM_FIRST_BID_MARKUP = 1.1;
const BYOM_BUDGET_MARKUP = 1.25;
const BYOM_MIN_SAVING_PENCE = 30_000;
const BYOM_BLOCK_MS = 30 * 60_000;
/** A hull's replacement value per ton of hold, until a yard has quoted the class. */
const HULL_PENCE_PER_TON = 25_000;
/** Spare cash kept in every non-home region for berth dues and stores. */
const REGION_FLOOR_PENCE = 20_000;
/** The home reserve covers at least this many game days of fleet upkeep. */
const UPKEEP_DAYS_RESERVED = 1.5;
/** A refit must improve a load's expected profit by this share to be worth the berth call. */
const REFIT_MIN_GAIN = 0.02;
/** How often letters of marque are judged (on the last rival analysis). */
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
/** How often rival intel is gathered (presence ports' sailings, the public policy list, public convoys) and analysed. */
const RIVAL_CHECK_MS = 2 * 60_000;
/** A public notice (a policy listed, a convoy formed) brings that forward, never closer together than this. */
const RIVAL_EVENT_MIN_MS = 20_000;
/** A laden rival's notice re-runs the analysis alone (no fetch) at most this often. */
const RIVAL_ANALYSIS_MIN_MS = 10_000;
/** A rival analysis older than this isn't used by the marque judge or the dashboard. */
const RIVAL_ANALYSIS_MAX_AGE_MS = 6 * 60_000;
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
/** Calls on stalled expansion postings are worked out at most this often (and afresh after events that move them). */
const STAKES_TTL_MS = 5_000;
/** Letting a posting lapse starts once that is worth this many times what waiting costs, and lasts while it is worth that cost. */
const CAMP_MARGIN = 1.25;
/** Never let one lapse on longer odds than this (the learned figures are rough). */
const MIN_ESCALATION_ODDS = 0.2;
/** ...nor while laden rivals due at its port first leave a stall this little chance (each may deliver its good). */
const HOLD_MIN_SURVIVAL = 0.4;
/** Our own flow into a posting let lapse loses this share of its margin to the next-best work meanwhile (a guess). */
const DEFER_LOSS_SHARE = 0.3;
/** With no lane of ours into it, a ton's cash margin there is taken as this share of its pay. */
const DEFER_MARGIN_OF_PAY = 0.15;
/** The tier must be due to last this many times the wait, or it may complete first (its charters end with it). */
const TIER_SAFETY = 1.25;
const FATAL_CODES      = ["account_suspended", "company_frozen"];

const cr = (pence: number) => `${Math.round(pence / 100).toLocaleString("en-GB")} Cr`;

/** "40 t cannons + 20 t timber to sell + 15 t freight": a lane's load, main good first. */
function loadText(l: Lane): string {
  return [
    ...l.parts.map((p) => `${p.tons} t ${p.good}${p.kind === "market" ? " to sell" : ""}`),
    ...(l.freight.length ? [`${l.freight.reduce((n, f) => n + f.tons, 0)} t freight`] : []),
  ].join(" + ");
}

/** A voyage_hazard event read as a storm (a convoy rescue is one that would have sunk the ship), or null. Shape not published. */
function stormFrom(e: StreamEvent): { hazard: string; zone: string | null; at: number | null; share: number | null; sunk: boolean } | null {
  const p = (e.payload && typeof e.payload === "object" ? e.payload : {}) as Record<string, unknown>;
  const name = [p.hazard, p.kind, p.type].find((v): v is string => typeof v === "string");
  const hazard = (name ?? "hazard").toLowerCase();
  const rescued = hazard.includes("rescue");
  if (!hazard.includes("storm") && !rescued) return null;
  const loss = typeof p.cargo_loss_pct === "number" ? p.cargo_loss_pct / 100 : null;
  return { hazard, zone: e.sea_zone_id ?? null, at: Date.parse(e.timestamp) || null, share: rescued ? null : loss, sunk: p.sunk === true || rescued };
}

/** Errors no retry will fix: wrong key, missing scopes, another process running this company. */
class InitFatal extends Error {}

// ── Manager ───────────────────────────────────────────────────────────────────

export class FleetManager implements FleetHost {
  readonly client: KibbClient;
  readonly world: World;
  /** The AI strategist (off unless the settings say otherwise). */
  readonly advisor: Advisor;
  /** The user's own settings; `settings` adds the AI's overrides on top while they are in force. */
  private ownSettings: FleetSettings;

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
  private journal: Journal<FleetSnapshot> | null = null;
  private progressSince: string | null = null;
  /** Saved agents waiting for their ship to be taken command of again. */
  private restoredAgents = new Map<string, AgentSnapshot>();
  private lastPersist = 0;
  /** Convoys we know of (ours forming, mostly), refreshed at most every 20 s each. */
  private readonly convoyCache = new Map<
    string,
    { from: string; dest: string; departsAt: number; status: ConvoyStatus; organizer: string; members: string[]; classes: string[]; checkedAt: number }
  >();
  private convoyQueue: Promise<unknown> = Promise.resolve();
  /** Rival ships and zone traffic from the last rival analysis (for the AI digest). */
  private rivalSummary: DigestInput["rivals"] = { companies: [], zones: [] };
  private lastEscalations: number | null = null;
  /** The fleet's calls on stalled expansion postings (by `port|good`) and when worked out (local ms; 0: stale). */
  private stakes = new Map<string, StallStake>();
  private stakesAt = 0;
  /** Postings being let lapse (id → `port|good`): the call's hysteresis, saved. */
  private readonly campState = new Map<string, string>();
  /** Per stalled posting: tons a camp shuts out, as last seen before it began (stallStakes). */
  private campShut = new Map<string, number>();
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
  private lastRivalCheck = 0;
  private lastRivalAnalysis = 0;
  /** A public notice said rival intel changed: gather it again soon; re-analyse soon; judge policies soon. */
  private rivalsDirty = false;
  private rivalAnalysisDirty = false;
  private policiesDirty = false;
  private nextLeaderboardAt = 0;
  /** The last rival analysis (local ms it was made). */
  private rivalAnalysis: (RivalAnalysis & { at: number }) | null = null;
  /** The player's companies (ids), never traded with as rivals. */
  private readonly ourCompanyIds = new Set<string>();
  private retired: AgentStats = { trips: 0, deliveredTons: 0, rewardPence: 0, spentPence: 0, freightPence: 0 };
  /** Loads planned again at their source (saved). */
  private resized: ResizeStats = { checks: 0, grown: 0, shrunk: 0, switched: 0, tonsAdded: 0, tonsCut: 0, at: null };
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
  /**
   * A build whose outcome is unknown, adopted if the ship turns up. `price` is what is still to
   * book (an own-materials build booked its materials when it bought them), `cost` the whole cost,
   * `leaseBefore` the warehouse lease to go back to once it is adopted.
   */
  pendingBuild: { name: string; yard: string; cls: string; price: number; cost?: number; leaseBefore?: number | null; payback: number; lane: string } | null = null;
  /** Yards where an own-materials attempt failed lately: build turnkey there until then. */
  private readonly byomBlockedUntil = new Map<string, number>();
  private cashQueue: Promise<unknown> = Promise.resolve();
  private assignQueue: Promise<unknown> = Promise.resolve();
  private events: Promise<void> | null = null;
  private eventsAbort: AbortController | null = null;
  private eventCursor: string | undefined;
  /** The one-off read of the 7-day log for storms is under way (bootstrapStorms). */
  private stormBootstrapping = false;
  /** An event said charters or the phase changed: refresh the world soon, then wake idle ships. */
  private worldDirty = false;

  constructor(
    cfg: FleetConfig,
    opts: { onLog?: (line: FleetLogLine) => void; carryOver?: Pick<FleetState, "log" | "purchases"> } = {},
  ) {
    this.client = new KibbClient({ baseUrl: cfg.baseUrl ?? KIBB_DEFAULT_URL, apiKey: cfg.apiKey });
    this.world = new World(this.client);
    this.ownSettings = cfg.settings;
    this.world.rivalIntel = cfg.settings.rivalIntel;
    this.world.planOnEvents = cfg.settings.actOnEvents;
    this.world.onNote = (msg) => this.log("world", msg);
    const self = this;
    this.advisor = new Advisor({
      get world() {
        return self.world;
      },
      userSettings: () => self.ownSettings,
      digestInput: () => self.digestInput(),
      idleShare: () => (self.agents.size ? [...self.agents.values()].filter((a) => a.idle).length / self.agents.size : 0),
      log: (msg) => self.log("fleet", msg),
      persist: (now) => self.persist(now),
      directivesChanged: () => {
        // New limits or biases: ships idling for want of a lane look again; stall calls may flip.
        for (const a of self.agents.values()) if (a.idle) a.nudge();
        self.reviewStalls();
      },
      companyId: () => self.world.companyId,
    });
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
      progressSince: this.progressSince ?? this.startedAt,
      stoppedAt: this.stoppedAt,
      homeRegion: this.homeRegion,
      totals,
      agents,
      topLanes: this.topLanes.slice(0, 8),
      purchases: [...this.purchases],
      buyer: this.buyer,
      marques: this.marqueReport,
      underwriting: this.underwriteReport,
      ai: this.advisor.report(),
      expansion: this.expansionReport(),
      capitalRate: this.capitalRate(),
      cash: this.cashReport(),
      storms: this.world.stormSummary(),
      worldEvents: this.world.eventsReport(),
      log: [...this.logLines],
    };
  }

  private expansionReport(): ExpansionReport | null {
    const w = this.world;
    if (w.tierTargetPhase === null) return null;
    const stakes = [...this.stallStakes().values()];
    return {
      targetPhase: w.tierTargetPhase,
      progressBps: w.tierProgressBps,
      etaMs: w.tierEtaMs,
      phaseSoon: this.phaseSoon() && this.settings.autoBuy && this.settings.phaseChestPct > 0 && this.agents.size < this.settings.maxShips,
      escalation: { ...w.escalation },
      charters: [...w.expansionWatch.values()].sort((a, b) => Number(b.stalled) - Number(a.stalled) || b.rate - a.rate),
      stakes,
      rivalDeliveries: w.rivals.deliveriesSeen(w.tierTargetPhase),
      stallOdds: Object.fromEntries(stakes.map((s) => [s.key, s.p])),
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

  /** The settings in force: the user's, with the AI's overrides while they last. */
  get settings(): FleetSettings {
    const o = this.advisor?.overrides();
    return o ? { ...this.ownSettings, ...o } : this.ownSettings;
  }

  /** The user's settings changed (dashboard, CLI): applied live. */
  set settings(v: FleetSettings) {
    const prev = this.ownSettings;
    this.ownSettings = v;
    if (prev) this.advisor.settingsChanged(prev, v);
    this.world.rivalIntel = this.settings.rivalIntel;
    this.world.planOnEvents = this.settings.actOnEvents;
    // Off: expected crisis charters go now, not at the next refresh.
    if (!this.world.planOnEvents) this.world.charters = this.world.charters.filter((c) => !c.provisional);
    this.stakesAt = 0;
  }

  /** The fleet's call on the stalled expansion posting this charter now stands for, if any. */
  stallStake(charterId: string): StallStake | undefined {
    const id = this.world.currentId(charterId);
    for (const st of this.stallStakes().values()) if (st.id === id) return st;
    return undefined;
  }

  /** From the dashboard: ask the AI now, or clear its directives. */
  aiCommand(cmd: "run" | "clear" | "retry"): void {
    this.advisor.command(cmd);
    this.persist(true);
  }

  /** What the AI strategist reads (digest.ts): the fleet, cash, lanes, charters, the tier, rivals. */
  private digestInput(): Omit<DigestInput, "events" | "decisions"> {
    const w = this.world;
    const now = w.now();
    let committed = 0;
    for (const a of this.agents.values()) committed += this.committedBy(a);
    const ships: DigestShip[] = [...this.agents.values()]
      .filter((a) => !a.gone && a.last)
      .map((a) => {
        const r = a.last!;
        const s = r.ship;
        const eta = Date.parse(r.voyage?.estimated_arrival_at ?? s.leg_arrives_at ?? "");
        const state =
          s.status === "sailing" ? "sailing" : a.idle ? "idle" : a.waitingForCash ? "waiting_cash" : a.activity.startsWith("holding") ? "holding" : "working";
        return {
          id: a.shipId,
          cls: a.shipClass,
          status: s.status,
          port: s.current_port_id ?? null,
          dest: s.status === "sailing" ? (r.route_legs.at(-1)?.to_node ?? null) : null,
          etaMs: s.status === "sailing" && Number.isFinite(eta) ? Math.max(0, eta - now) : null,
          state,
          cargoTons: r.cargo_used_tons,
          hold: r.effective_hold_capacity_tons,
          lane: a.lane,
          trips: a.state.trips,
        };
      });
    const x = this.expansionReport();
    const value = (c: (typeof w.charters)[number]) => c.payPerTon * c.remaining;
    return {
      now,
      gameMinuteMs: w.gameMinuteMs,
      phase: w.unlockedPhase,
      tier: x
        ? {
            targetPhase: x.targetPhase,
            progressBps: x.progressBps,
            etaMs: x.etaMs,
            phaseSoon: x.phaseSoon,
            stallSurvives: w.stallSurvives,
            escalation: x.escalation,
            charters: x.charters,
            stakes: x.stakes,
            // Company names never go to the AI.
            rivalDeliveries: x.rivalDeliveries.map((d) => ({ at: d.at, port: d.port, good: d.good, tons: d.tons })),
          }
        : null,
      ships,
      maxShips: this.ownSettings.maxShips,
      buyer: this.buyer,
      cash: { vaults: [...w.vaults], homeRegion: this.homeRegion, spare: this.spareCash(), committed, capitalRate: this.capitalRate(), due: this.cashReport().duePence },
      user: this.ownSettings,
      active: this.advisor.overrides(),
      topLanes: this.topLanes,
      charters: w.charters.filter((c) => c.remaining > 0 && w.isOpen(c.port)).sort((a, b) => value(b) - value(a)),
      piracy: [...w.piracy].filter(([, b]) => b > 0).sort((a, b) => b[1] - a[1]),
      rivals: this.rivalSummary,
      bidHaircutPerDay: w.bidHaircutPerDay,
      storms: w.stormSummary(),
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
    // A factor the buyer hired must not keep drawing salary: try a few times before giving up.
    for (let i = 0; i < 3 && this.tempFactors.size > 0; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, 1_000));
      await this.dismissTempFactors();
    }
    // An AI call in flight is cancelled (its reserved cost stays counted) before the last save.
    await this.advisor.stop();
    await this.journal?.flush();
    await this.lease?.release();
    this.lease = null;
    if (this.status !== "failed") this.status = "stopped";
    this.stoppedAt ??= new Date().toISOString();
  }

  /** Saves the progress now and waits for it (shutdown). */
  async flush(): Promise<void> {
    this.journal?.save(true);
    await this.journal?.flush();
  }

  get done(): Promise<void> {
    return this.loop ?? Promise.resolve();
  }

  log(source: string, msg: string): void {
    this.pushLog(source, msg);
    this.persist();
  }

  /** Logs without asking for a save (the journal's own errors). */
  private pushLog(source: string, msg: string): void {
    const line = { at: new Date().toISOString(), source, msg };
    this.logLines.push(line);
    if (this.logLines.length > LOG_LIMIT) this.logLines.splice(0, this.logLines.length - LOG_LIMIT);
    this.onLog?.(line);
  }

  persist(now = false): void {
    this.lastPersist = Date.now();
    this.journal?.save(now);
  }

  tripFinished(agent: ShipAgent, trip: TripRecord & { goods: string[]; spentPence: number; rewardPence: number }): void {
    const decision = this.advisor.report().active?.decisionId ?? null;
    this.advisor.tripFinished(trip);
    this.journal?.recordTrip({ shipId: agent.shipId, ship: agent.name, shipClass: agent.shipClass, aiDecision: decision, ...trip });
  }

  private snapshot(): FleetSnapshot {
    const agents: Record<string, AgentSnapshot> = {};
    // A ship gone but not yet retired (that happens at the next scan) still counts in the totals.
    const retired = { ...this.retired };
    for (const [id, a] of this.agents) {
      if (!a.gone) agents[id] = a.snapshot();
      else for (const k of Object.keys(retired) as (keyof AgentStats)[]) retired[k] += a.stats[k];
    }
    // Ships not taken command of yet this run keep what was saved for them.
    for (const [id, s] of this.restoredAgents) agents[id] ??= s;
    return {
      progressSince: this.progressSince ?? new Date().toISOString(),
      log: this.logLines,
      purchases: this.purchases,
      retired,
      shipSpendPence: this.shipSpendPence,
      eventCursor: this.eventCursor ?? null,
      tempFactors: [...this.tempFactors],
      hullQuotes: [...this.hullQuotes],
      factorBlockedUntil: this.factorBlockedUntil,
      factorFails: this.factorFails,
      pendingBuild: this.pendingBuild,
      agents,
      world: this.world.snapshot(),
      ai: this.advisor.snapshot(),
      camping: [...this.campState],
      campShut: [...this.campShut],
      resized: { ...this.resized },
    };
  }

  private restoreFrom(s: FleetSnapshot): void {
    this.progressSince = s.progressSince;
    if (s.log?.length) this.logLines = s.log.slice(-LOG_LIMIT);
    if (s.purchases?.length) this.purchases = s.purchases.slice(-50);
    if (s.retired) this.retired = { ...this.retired, ...s.retired };
    this.shipSpendPence = s.shipSpendPence ?? 0;
    this.eventCursor = s.eventCursor ?? undefined;
    for (const y of s.tempFactors ?? []) this.tempFactors.add(y);
    for (const [k, v] of s.hullQuotes ?? []) this.hullQuotes.set(k, v);
    this.factorBlockedUntil = s.factorBlockedUntil ?? 0;
    this.factorFails = s.factorFails ?? 0;
    this.pendingBuild = s.pendingBuild ?? null;
    this.restoredAgents = new Map(Object.entries(s.agents ?? {}));
    this.advisor.restore(s.ai);
    if (s.resized) this.resized = { ...this.resized, ...s.resized };
    // A camp under way before the restart carries on without the entry margin.
    for (const [id, key] of s.camping ?? []) this.campState.set(id, key);
    for (const [id, tons] of s.campShut ?? []) if (Number.isFinite(tons)) this.campShut.set(id, tons);
  }

  fatal(msg: string): void {
    if (this.status === "failed") return;
    this.status = "failed";
    this.error = msg;
    this.stoppedAt = new Date().toISOString();
    this.log("fleet", `FATAL: ${msg}`);
    this.persist(true);
    this.stopRequested = true;
    this.wake?.();
    this.eventsAbort?.abort();
    const lease = this.lease;
    this.lease = null;
    void Promise.all([...[...this.agents.values()].map((a) => a.stop()), this.advisor.stop()])
      .then(() => this.journal?.flush())
      .finally(() => {
        // Whoever runs this company next owns its saved progress: nothing more is written from here.
        this.journal = null;
        void lease?.release();
      });
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
      this.settings = { ...this.ownSettings, autoBuy: false };
    }
    this.canRemit = who.scopes.includes("treasury_remit");
    if (!this.canRemit) this.log("fleet", "key lacks treasury_remit: cash stays in the region it lands in");

    if (this.leaseDir && !this.lease) {
      const got = await acquireLease(this.leaseDir, who.company_id, () => this.fatal("another process took over this company's autopilot lease"));
      // Held: retried with backoff by run(), so a crashed holder's lease is taken once it goes stale.
      if ("heldBy" in got) throw new Error(`this company's autopilot is already running (${got.heldBy})`);
      this.lease = got.lease;
    }

    // Pick up the progress saved before a restart (first start of this manager only).
    let saved: FleetSnapshot | null = null;
    if (this.leaseDir && !this.journal) {
      this.journal = openJournal<FleetSnapshot>(this.leaseDir, who.company_id, () => this.snapshot(), (e) =>
        this.pushLog("fleet", `saving progress failed (${e.message}); retrying with the next change`),
      );
      saved = await this.journal.load();
      if (saved) {
        this.restoreFrom(saved);
        // Applied now, so a failed start-up attempt below can't save an empty world over it.
        if (saved.world) this.world.restore(saved.world);
      }
    }
    this.progressSince ??= new Date().toISOString();
    await this.world.init();
    const profile = await this.client.companyProfile();
    this.homeRegion = this.world.region(profile.company.home_port_id);
    this.homePort = profile.company.home_port_id;
    this.world.companyId = profile.company.id;
    // Every company of this player: their ships aren't rivals and their policies aren't ours to write.
    this.ourCompanyIds.add(profile.company.id);
    this.world.rivals.ours.add(profile.company.name);
    this.world.rivals.ourIds.add(profile.company.id);
    const player = await this.client.playerProfile().catch(() => null);
    for (const c of player?.companies ?? []) {
      this.ourCompanyIds.add(c.id);
      this.world.rivals.ours.add(c.name);
      this.world.rivals.ourIds.add(c.id);
    }
    this.log(
      "fleet",
      `started for ${profile.company.name}: phase ${this.world.unlockedPhase} open, server clock ${this.world.skewMs >= 0 ? "+" : ""}${Math.round(this.world.skewMs / 1000)}s vs this machine, ` +
        `${this.world.charters.length} open charters, auto-buy ${this.settings.autoBuy ? "on" : "off"}` +
        `${saved ? `; resumed progress saved for ${this.restoredAgents.size} ship${this.restoredAgents.size === 1 ? "" : "s"}` : ""}`,
    );
    // A factor hired for a build before the restart is dismissed now, not left drawing salary.
    if (this.tempFactors.size > 0) await this.dismissTempFactors();
    this.lastWorld = Date.now();
    await this.scanShips();
    // After the scan: the replay needs our ships' classes. The live feed takes over from the cursor.
    if (!this.world.stormBootstrapped && !this.stormBootstrapping) {
      const cursor = this.eventCursor;
      this.stormBootstrapping = true;
      void this.bootstrapStorms(cursor)
        .catch((e) => {
          if (!this.isFatal(e)) this.log("fleet", `storm history not read (${(e as Error).message}); learning from new voyages only`);
        })
        .finally(() => {
          this.stormBootstrapping = false;
        });
    }
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
      // Stalls start, break and lapse with the listing: the fleet's calls on them follow.
      this.reviewStalls();
      // A stalled posting re-posted richer: worth the AI's look.
      const esc = this.world.escalationsSeen;
      if (this.lastEscalations !== null && esc > this.lastEscalations) this.advisor.trigger("a stalled expansion charter re-posted richer");
      this.lastEscalations = esc;
    }
    this.advisor.tick();
    if (now - this.lastScan > SHIP_SCAN_MS) await this.scanShips();
    if (now - this.lastPersist > PERSIST_MS) this.persist();
    if (now - this.lastBuyCheck > BUY_CHECK_MS) await this.runBuyer(null);
    this.world.rivalIntel = this.settings.rivalIntel;
    if (now - this.lastRivalCheck > RIVAL_CHECK_MS || (this.rivalsDirty && now - this.lastRivalCheck > RIVAL_EVENT_MIN_MS)) {
      this.lastRivalCheck = now;
      this.rivalsDirty = false;
      this.rivalAnalysisDirty = false;
      await this.runRivals().catch((e) => {
        if (this.isFatal(e)) throw e;
        this.log("fleet", `rival check failed: ${(e as Error).message}`);
      });
    } else if (this.rivalAnalysisDirty && Date.now() - this.lastRivalAnalysis > RIVAL_ANALYSIS_MIN_MS) {
      // A laden rival's notice: no fetch (routes are cached), so charter crowding and stall odds see it within seconds.
      this.rivalAnalysisDirty = false;
      await this.analyseRivalsNow().catch(() => undefined);
    }
    if (now - this.lastMarqueCheck > MARQUE_CHECK_MS) {
      this.lastMarqueCheck = now;
      await this.runMarques().catch((e) => {
        if (this.isFatal(e)) throw e;
        this.log("fleet", `marque check failed: ${(e as Error).message}`);
      });
    }
    if (now - this.lastUnderwriteCheck > UNDERWRITE_CHECK_MS || (this.policiesDirty && now - this.lastUnderwriteCheck > RIVAL_EVENT_MIN_MS)) {
      this.lastUnderwriteCheck = now;
      this.policiesDirty = false;
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
        if (pending.leaseBefore !== undefined && pending.leaseBefore !== null) void this.shrinkLease(pending.yard, pending.leaseBefore);
        this.purchases.push({
          at: new Date().toISOString(),
          shipId: found.ship.id,
          name: pending.name,
          shipClass: pending.cls,
          port: pending.yard,
          costPence: pending.cost ?? pending.price,
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
      const saved = this.restoredAgents.get(r.ship.id);
      if (saved) {
        agent.restore(saved);
        this.restoredAgents.delete(r.ship.id);
      }
      this.agents.set(r.ship.id, agent);
      this.log("fleet", `taking command of ${r.ship.name} (${r.ship.ship_class})`);
      agent.start();
    }
    // Saved ships that sank or left while we were down: their record moves to the retired totals.
    for (const [id, s] of [...this.restoredAgents]) {
      const r = ships.find((x) => x.ship.id === id);
      if (r && r.ship.status !== "sunk") continue;
      if (!r) {
        const misses = (this.missingScans.get(id) ?? 0) + 1;
        this.missingScans.set(id, misses);
        if (misses < 2) continue;
      }
      for (const k of Object.keys(this.retired) as (keyof AgentStats)[]) this.retired[k] += s.stats?.[k] ?? 0;
      this.restoredAgents.delete(id);
      this.missingScans.delete(id);
      this.log("fleet", `${s.name ?? id} is no longer in the fleet: its record moves to the totals`);
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
      // Ranked without the AI's bias: this is what the AI itself reads as the planner's own view.
      this.topLanes = await rankLanes(this.world, this.specFor(ref, r), from, this.reservations(ref), { ...this.planOptions(this.loadCash(ref), ref), bias: undefined });
    } catch (e) {
      this.log("fleet", `lane overview failed: ${(e as Error).message}`);
    }
  }

  // ── Lanes ───────────────────────────────────────────────────────────────────

  /**
   * What a hull of this class costs to replace (pence): the cheapest quote seen for it at any yard,
   * else a rough figure from its hold. Used to price the chance of pirates taking the ship.
   */
  private hullValue(shipClass: string): number {
    const seen = [...this.hullQuotes].filter(([k]) => k.endsWith(`|${shipClass}`)).map(([, v]) => v);
    if (seen.length) return Math.min(...seen);
    return (this.world.shipClass(shipClass)?.hold_capacity_tons ?? 40) * HULL_PENCE_PER_TON;
  }

  /** Hull, speed and cargo room for one of our ships. */
  private specFor(agent: ShipAgent, r: ShipResult): ShipSpec {
    const cls = this.world.shipClass(agent.shipClass);
    return {
      hullValue: this.hullValue(agent.shipClass) + r.ship.cannons_count * GUN_PRICE_PENCE,
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
      hullValue: this.hullValue(shipClass) + guns * GUN_PRICE_PENCE,
      shipClass,
      hull: cls?.hull_category ?? "coastal",
      knots: (cls?.base_speed_centiknots ?? 800) / 100,
      cap: Math.max(0, (cls?.hold_capacity_tons ?? 40) - 2 * guns - 2),
      guns,
    };
  }

  /** `except`: the ship being planned for, whose own pending load isn't someone else's claim on cash. */
  private planOptions(cash: number | null, except?: ShipAgent) {
    // A ship's own load may count on cash due before it buys; never a hull the buyer prices (no `except`).
    const flows = except && this.settings.resizeLoads && this.settings.cashDuePct > 0 ? this.cashFlows(except) : null;
    const spare = flows ? this.spareCash() : 0;
    return {
      minMargin: this.settings.minMarginPence,
      freight: this.settings.useFreight,
      bonusWeight: this.settings.bonusWeightPct / 100,
      stormWeight: this.settings.stormWeightPct / 100,
      cash,
      capitalRate: this.capitalRate(except),
      bias: this.advisor.hasBias() ? (l: Lane) => this.advisor.bias(l) : undefined,
      stalls: this.stallStakes(),
      cashAt: flows ? (at: number, source: string) => this.cashAt(flows, at, this.world.region(source), spare) : undefined,
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

  /**
   * Cash a ship's lane still has to spend: goods not yet bought (at landed cost, less the storm share:
   * that is lost cargo, not cash), collateral for lots not yet taken. The piracy and fee markup left
   * in landed cost (about 1-5% over the cash) is kept on purpose: a buffer for walking up the ask ladder.
   */
  private committedBy(a: ShipAgent): number {
    const kept = 1 - (a.lane?.stormBps ?? 0) / 10_000;
    return a.partsToBuy().reduce((n, p) => n + p.tons * p.costPerTon * kept, 0) + a.freightToTake().reduce((n, f) => n + f.collateral, 0);
  }

  /**
   * A ship's first call at its source, ahead of our other ships' loads: what its plan still has to buy,
   * but never beyond the plan's cash less what this stay has already put into it (a part dearer than
   * planned isn't refilled from the others' cash), and never the share it counted on cash due.
   */
  private ownCall(a: ShipAgent): number {
    const lane = a.lane;
    if (!lane) return 0;
    const kept = 1 - (lane.stormBps ?? 0) / 10_000;
    const planned = lane.parts.reduce((n, p) => n + p.tons * p.costPerTon * kept, 0) + lane.freight.reduce((n, f) => n + f.collateral, 0);
    return Math.max(0, Math.min(this.committedBy(a), planned - a.spentOnLane()) - (lane.dueCounted ?? 0));
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
    // Landed cost without the piracy markup the planner priced in for the current guns. Storms take
    // their share whatever the guns: off what arrives, not off the guns' case.
    const stormKept = 1 - (lane.stormBps ?? 0) / 10_000;
    const landed = lane.costPerTon * (1 - lane.piracyBps / 10_000) * stormKept;
    const payPerTon = lane.pay + (lane.bonus ?? 0);
    // Cargo pirates take (richer loads draw more raids), and the chance they take the ship itself,
    // at its value with the guns it would carry: guns cut both.
    const hull = this.hullValue(agent.shipClass);
    // Valued as the planner values it: the goods at base price, freight at ~3x its collateral.
    const goodsTons = lane.parts.reduce((n, p) => n + p.tons, 0);
    const lootPerTon =
      lane.tons > 0
        ? (lane.parts.reduce((n, p) => n + p.tons * this.world.basePrice(p.good), 0) + lane.freight.reduce((n, f) => n + 3 * f.collateral, 0)) / Math.max(goodsTons + lane.freight.reduce((n, f) => n + f.tons, 0), 1)
        : 0;
    const profit = (g: number) => {
      const risk = this.world.piracyRisk(plan, g, knots, tonsAt(g) * lootPerTon);
      return tonsAt(g) * (payPerTon * (1 - risk.cargoShare) * stormKept - landed) - risk.capture * (hull + g * GUN_PRICE_PENCE);
    };

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
        // A laden rival under way or just in: charter crowding and stall odds take it in within seconds.
        if (p.load_state !== "ballast") this.rivalAnalysisDirty = true;
        break;
      case "insurance_policy_listed":
        // Public: a ship somewhere is about to sail (rival intel), and a fresh policy to judge.
        this.policiesDirty = true;
        this.wake?.();
        break;
      case "convoy_formed":
        // Public unless private: a convoy's schedule, hulls and guns.
        this.rivalsDirty = true;
        break;
      case "convoy_departed":
      case "convoy_arrived":
      case "convoy_cancelled":
      case "convoy_disbanded":
      case "convoy_member_joined":
      case "convoy_member_detached":
      case "convoy_member_left_behind": {
        const id = str("convoy_id");
        if (id) this.convoyCache.delete(id);
        for (const a of this.agents.values()) if (!id || a.last?.ship.convoy_id === id) a.nudge();
        break;
      }
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
        const hazard = (str("hazard", "kind", "type") ?? "hazard").toLowerCase();
        // Since the October patch pirates may take the ship itself (the event's shape isn't published).
        const captured = hazard.includes("captur") || p.captured === true;
        this.log(agent?.name ?? "fleet", `${hazard} at sea${captured ? ": CAPTURED by pirates" : p.sunk ? ": SUNK" : loss ? `: lost ${loss}% of cargo` : ""}`);
        if (agent && (hazard.includes("pira") || hazard.includes("raid") || captured)) this.world.notePirateRaid(loss !== undefined ? loss / 100 : null, captured);
        // Storms, learned per season and hull against the exposure our voyages logged (agent.noteVoyage).
        const storm = agent && !captured ? stormFrom(e) : null;
        if (agent && storm) {
          const r = agent.last;
          const zone = storm.zone ?? r?.route_legs[r.ship.current_leg_idx]?.to_node ?? null;
          this.world.noteStorm(zone, this.world.shipClass(agent.shipClass)?.hull_category ?? "coastal", storm.at ?? this.world.now(), storm.share, storm.sunk);
        }
        if ((p.sunk || captured) && agent) this.advisor.trigger("a ship was lost");
        agent?.nudge();
        break;
      }
      case "convoy_rescue": {
        // A storm that would have sunk the ship (consorts saved it): counts as a sinking storm. Sent to
        // every party, so only the rescued ship counts (the payload's shape isn't published).
        const id = str("rescued_ship_id", "ship_id");
        const saved = id ? this.agents.get(id) : undefined;
        if (saved) {
          this.log(saved.name, "rescued by convoy consorts from a storm that would have sunk her");
          this.world.noteStorm(e.sea_zone_id ?? null, this.world.shipClass(saved.shipClass)?.hull_category ?? "coastal", Date.parse(e.timestamp) || this.world.now(), null, true);
        }
        saved?.nudge();
        break;
      }
      case "ship_captured": {
        this.log(agent?.name ?? "fleet", "CAPTURED by pirates: ship and cargo lost");
        if (agent) {
          this.world.notePirateRaid(null, true);
          this.advisor.trigger("a ship was lost");
        }
        agent?.nudge();
        break;
      }
      case "ship_mutinied":
      case "ship_provisions_exhausted":
        this.log(agent?.name ?? "fleet", e.event_type === "ship_mutinied" ? "the crew mutinied: ship lost" : "stores ran out at sea");
        if (e.event_type === "ship_mutinied" && agent) this.advisor.trigger("a ship was lost");
        agent?.nudge();
        break;
      case "charter_delivered":
      case "charter_expired": {
        // A public charter's notice may name who delivered (its shape isn't documented): a rival's goes in its profile.
        if (e.event_type === "charter_delivered" && e.port_id) {
          const who = str("deliverer_company_name", "delivered_by", "company_name");
          const tons = num("delivered_quantity") ?? num("quantity_delivered") ?? num("quantity") ?? num("tons");
          const good = str("commodity_id");
          const cid = str("contract_id", "charter_id");
          const phase = cid && this.world.renews({ id: cid }) ? (this.world.tierTargetPhase ?? 0) : 0;
          if (who && tons && good) this.world.rivals.addDelivery({ company: who, port: e.port_id, good, tons, at: Date.parse(e.timestamp) || this.world.now(), phase });
        }
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
        // Someone else delivered into a posting we watch for a stall: it's over (any delivery cancels
        // the escalation). Look again now; ships holding for it deliver at once.
        if (id && e.event_type === "charter_delivered") {
          const co = str("deliverer_company_name", "delivered_by", "company_name", "company");
          const coId = str("deliverer_company_id", "company_id");
          const { rivals } = this.world;
          const ours =
            co !== undefined && rivals.ours.size ? rivals.ours.has(co)
            : coId !== undefined && this.ourCompanyIds.size ? this.ourCompanyIds.has(coId) || rivals.ourIds.has(coId)
            : undefined;
          const ended = this.world.noteCharterDelivered(id, ours);
          if (ended) {
            this.log("fleet", `a rival delivered into the stalled ${ended.good} charter at ${ended.port}: no richer re-post this time`);
            this.reviewStalls();
          }
        }
        break;
      }
      case "charter_posted":
      case "world_phase_unlocked":
      case "expansion_target_rescaled":
      case "world_event":
        if (e.event_type === "world_phase_unlocked") this.log("fleet", "a new phase opened: re-planning across the new ports");
        if (e.event_type === "world_phase_unlocked" || e.event_type === "expansion_target_rescaled") this.advisor.trigger(e.event_type.replace(/_/g, " "));
        // A world event's text goes to the AI only through its screen.
        if (e.event_type === "world_event") this.advisor.noteEvent("world_event", str("description", "message", "summary", "title", "text") ?? JSON.stringify(e.payload ?? {}).slice(0, 800), Date.parse(e.timestamp) || this.world.now());
        this.worldDirty = true;
        this.wake?.();
        break;
      case "crown_bailiff_warehouse_seizure":
      case "crown_bailiff_upkeep_seizure":
        this.log("fleet", `BAILIFF: ${e.event_type.replace(/_/g, " ")} (a bill went unpaid; check the reserve)`);
        break;
      case "server_announcement":
        this.log("fleet", `server ${str("severity") ?? "notice"}: ${str("message") ?? ""}`);
        this.advisor.noteEvent("server_announcement", str("message") ?? "", Date.parse(e.timestamp) || this.world.now());
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
   * First start with storm pricing: learn from our own 7-day event log rather than the prior alone,
   * with departures as exposure (routed for the ship's class) and storms met on those voyages as hits
   * (a guessed payload that matches nothing leaves the prior alone), up to the saved event
   * cursor or now (the live feed handles what follows; event ids are time-ordered). Applied only once
   * both replays are read, so a stop part-way leaves nothing to count twice. Once; best effort.
   */
  private async bootstrapStorms(cursor: string | undefined): Promise<void> {
    const w = this.world;
    const until = w.now();
    const replay = async (type: string, each: (e: StreamEvent) => Promise<void> | void): Promise<boolean> => {
      let after = "0";
      for (let page = 0; page < 40; page++) {
        if (this.stopRequested) return false;
        const batch = await this.client.events({ after_id: after, event_type: type, limit: 500, timeout_ms: 0 });
        for (const e of batch) {
          if ((cursor && e.id > cursor) || Date.parse(e.timestamp) > until) return true;
          await each(e);
          if (e.id === cursor) return true;
        }
        if (batch.length < 500) return true;
        after = batch.at(-1)!.id;
      }
      return true;
    };
    const field = (e: StreamEvent, k: string) => {
      const v = (e.payload && typeof e.payload === "object" ? (e.payload as Record<string, unknown>) : {})[k];
      return typeof v === "string" ? v : undefined;
    };
    const exposures: Array<() => void> = [];
    // Each matched departure's time at sea, per ship: a storm counts only inside one, so hits and
    // exposure come from the same voyages (a convoy leg or payload we can't read drops out of both).
    const voyages = new Map<string, Array<[number, number]>>();
    const storms: Array<() => void> = [];
    let unmatched = 0;
    const names = new Map<string, number>();
    const departed = await replay("ship_departed", async (e) => {
      const id = field(e, "ship_id") ?? "";
      const cls = this.agents.get(id)?.shipClass;
      const from = e.port_id ?? field(e, "origin_port_id");
      const to = field(e, "dest_port_id");
      if (!cls || !from || !to || from === to) return;
      const plan = await w.route(from, to, cls).catch(() => null);
      if (!plan) return;
      const c = w.shipClass(cls);
      const speed = Math.round((c?.base_speed_centiknots ?? 800) * 0.9);
      const at = Date.parse(e.timestamp) || w.now();
      exposures.push(() => w.noteStormExposure(plan.legs.map((l) => ({ ...l, speed_centiknots: speed })), c?.hull_category ?? "coastal", at));
      const list = voyages.get(id) ?? [];
      // Slack for laden or convoy pace and roadstead waits.
      list.push([at, at + w.sailMs(plan.total_distance_nm, speed / 100) * 1.5 + 60 * w.gameMinuteMs]);
      voyages.set(id, list);
    });
    const hazards =
      departed &&
      (await replay("voyage_hazard", (e) => {
        const name = field(e, "hazard") ?? field(e, "kind") ?? "?";
        names.set(name, (names.get(name) ?? 0) + 1);
        const id = field(e, "ship_id") ?? field(e, "carrier_ship_id") ?? "";
        const cls = this.agents.get(id)?.shipClass;
        const s = stormFrom(e);
        const t = s?.at;
        if (cls && s && t != null && voyages.get(id)?.some(([a, b]) => t >= a && t <= b)) storms.push(() => w.noteStorm(s.zone, w.shipClass(cls)?.hull_category ?? "coastal", t, s.share, s.sunk));
        else if (s) unmatched++;
      }));
    if (!hazards || this.stopRequested || w.stormBootstrapped) return;
    for (const f of [...exposures, ...storms]) f();
    w.stormBootstrapped = true;
    const sum = w.stormSummary();
    this.log(
      "fleet",
      `storms: read ${exposures.length} voyages from the 7-day log, ${sum?.seen ?? storms.length} storms against ${sum?.expected ?? "?"} expected` +
        `${unmatched ? ` (${unmatched} storms not matched to a departure, left out)` : ""}; ` +
        `hazards seen: ${[...names].map(([k, n]) => `${k} ×${n}`).join(", ") || "none"}`,
    );
    this.persist();
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
        // A camped posting's loads wait for the lapse whatever was planned: they don't end its stall.
        if (!lane.holdMs && lane.deliverAt && !this.stallStake(cur)?.camp) charterLandsAt.set(cur, Math.min(charterLandsAt.get(cur) ?? Infinity, lane.deliverAt));
      }
      for (const p of a.partsToBuy()) add(sourceTons, `${lane.source}|${p.good}`, p.tons);
      for (const p of lane.parts) if (p.kind === "market") add(sellTons, `${lane.dest}|${p.good}`, p.tons);
      for (const f of a.freightToTake()) freightIds.add(f.id);
    }
    return { charterTons, sourceTons, sellTons, freightIds, charterLandsAt };
  }

  /**
   * The fleet's call on each stalled expansion posting: let it lapse (no ship delivers into it;
   * loads landing first wait for the re-post) or deliver into it. A lapse is worth the re-post's
   * extra pay on the tons we expect to deliver into it (our recent flow there over a posting, and
   * loads already bound for it that can wait for it) times the chance it really escalates; waiting
   * costs the hold time of loaded ships landing first or already holding (their earning rate and the
   * cash they tie up), their tons the smaller re-post can't take, and part of the margin on our own
   * flow there until the lapse and on loads it shuts out (landing more than HOLD_CAP early). AI
   * "deliver", the tier possibly completing first, our loads (into any of its postings) completing
   * it, or a laden rival likely to deliver first veto it; otherwise
   * "always hold" and AI "wait" force it near the lapse. Our own delivery would cancel the
   * escalation too (as the feed shows: a posting is stalled while nothing is delivered in it).
   */
  private stallStakes(): Map<string, StallStake> {
    if (Date.now() - this.stakesAt < STAKES_TTL_MS) return this.stakes;
    const w = this.world;
    const s = this.settings;
    const now = w.now();
    const gm = w.gameMinuteMs;
    const capRate = this.capitalRate();
    const out = new Map<string, StallStake>();
    const shutOut = new Map<string, number>();
    for (const [key, x] of w.expansionWatch) {
      if (!x.stalled || x.expiresAt === null || x.expiresAt <= now || !w.renews({ id: x.id })) continue;
      const until = x.expiresAt + REPOST_GRACE_GAME_MIN * gm;
      const hoursLeft = (x.expiresAt - now) / 3_600_000;
      const into = (fills: Lane["fills"]) => fills.reduce((n, [id, tons]) => n + (w.currentId(id) === x.id ? tons : 0), 0);
      // A camp gives a load landing more than this before the lapse no room (planner terms()).
      const capMs = HOLD_CAP_GAME_H * 60 * gm;
      let before = 0;
      let holdable = 0;
      let loadedBefore = 0;
      let blocked = 0;
      let others = 0;
      let after = 0;
      let holdCost = 0;
      let longest = 0;
      let margin = 0;
      let marginTons = 0;
      for (const a of this.agents.values()) {
        const lane = a.lane;
        if (!lane || a.gone) continue;
        // A ship already holding for it waits from now, whenever its plan had it landing.
        const held = a.holdAt(x.port, x.good);
        const lands = held && w.currentId(held.id) === x.id ? now : lane.deliverAt - lane.holdMs;
        // Our loads into the tier's other postings landing first (not ones being let lapse) count towards completing it.
        if (lands < x.expiresAt) {
          for (const [id, tons] of lane.fills) {
            const cur = w.currentId(id);
            if (cur !== x.id && w.renews({ id: cur }) && !this.campState.has(cur)) others += tons;
          }
        }
        const t = into(lane.fills);
        if (t <= 0) continue;
        const part = lane.parts.find((p) => p.fills.some(([id]) => w.currentId(id) === x.id));
        if (part) {
          margin += (part.pay - part.costPerTon) * t;
          marginTons += t;
        }
        if (lands >= x.expiresAt) {
          after += t;
          continue;
        }
        before += t;
        // One not yet loaded can plan otherwise: within HOLD_CAP of the lapse it may wait for the re-post;
        // earlier, a camp re-plans it away (its margin here lost), so it never reaches the re-post.
        if (!a.loaded) {
          if (x.expiresAt - lands > capMs) blocked += t;
          else holdable += t;
          continue;
        }
        // Loaded cargo has nowhere better to go: it waits.
        holdable += t;
        loadedBefore += t;
        const holdMs = until - Math.max(now, lands);
        longest = Math.max(longest, holdMs);
        holdCost += (holdMs / 3_600_000) * (a.rate + capRate * (lane.capital ?? 0) * (t / Math.max(lane.tons, 1)));
      }
      const tierLeft = w.tierEtaMs === null ? Infinity : w.tierEtaMs - (until - now);
      const flow = w.ownRate(key);
      const top = this.topLanes.find((l) => into(l.fills) > 0);
      const topTons = top ? into(top.fills) : 0;
      // The best lane into it landing more than HOLD_CAP early is shut out by a camp: a cost, not re-post tons.
      const topBlocked = top && top.deliverAt - top.holdMs < x.expiresAt - capMs ? topTons : 0;
      const repostTons = Math.floor(x.remaining * w.escalation.tons);
      const tonsAfter = Math.min(repostTons, Math.max((flow * Math.min(w.postingWindowMs(key), tierLeft)) / 3_600_000, after, topTons - topBlocked));
      const call = this.advisor.stallCall(x.port, x.good);
      const p = call === "deliver" ? 0 : w.escalationOdds(x, now);
      const uplift = Math.round((w.escalation.pay - 1) * x.rate);
      // The re-post takes no more than its own tons, held loads included (never loads a camp plans away).
      const value = Math.round(p * uplift * Math.min(repostTons, tonsAfter + holdable));
      const perTon = marginTons > 0 ? margin / marginTons : top ? top.margin - top.bonus : DEFER_MARGIN_OF_PAY * x.rate;
      // Tons a camp shuts out. Once camped those lanes are re-planned and no longer show, so the figure
      // from before it began stands while loads could still land that early.
      const shutNow = blocked + topBlocked;
      // Camping already, or the last pass's call (the lane re-planning in between drops the top lane
      // before the camp is recorded).
      const prev = this.stakes.get(key);
      const wasCamp = this.campState.has(x.id) || (prev?.id === x.id && prev.camp);
      const shut = wasCamp && x.expiresAt - now > capMs ? Math.max(shutNow, this.campShut.get(x.id) ?? 0) : shutNow;
      shutOut.set(x.id, shut);
      // Loaded tons the smaller re-post can't take are sold off instead of paid this posting's rate.
      const salvage = Math.min(x.rate, w.price(x.port, x.good)?.bid ?? w.basePrice(x.good));
      const spill = Math.max(0, Math.min(loadedBefore, x.remaining) - repostTons);
      const cost = Math.round(holdCost + p * spill * (x.rate - salvage) + (flow * hoursLeft + shut) * DEFER_LOSS_SHARE * Math.max(0, perTon));
      // Vetoes first: "always hold" and AI "wait" never camp past them.
      const veto =
        call === "deliver" ? "AI call: deliver"
        : w.tierEtaMs !== null && w.tierEtaMs < (until - now) * TIER_SAFETY ? "the tier may complete before the lapse"
        : before + others > 0 && before + others >= w.expansionTonsLeft ? "our loads would complete the tier"
        : w.rivalKeep(x) < HOLD_MIN_SURVIVAL ? "a laden rival due before the lapse will likely deliver"
        : null;
      const forced = !veto && (call === "wait" || s.holdForRepost);
      let camp = false;
      let why: string;
      if (veto) why = veto;
      else if (forced && x.expiresAt - now <= HOLD_MAX_GAME_H * 60 * gm) {
        camp = true;
        why = call === "wait" ? "AI call: wait" : "always hold (setting)";
      } else if (!s.captureEscalations) why = "escalation capture is off";
      else if (longest > capMs) why = "a loaded ship would wait too long";
      else if (p < MIN_ESCALATION_ODDS) why = `escalates only ~${Math.round(p * 100)}%`;
      else if (value > 0 && value >= (wasCamp ? 1 : CAMP_MARGIN) * cost) {
        camp = true;
        why = "the re-post adds more than waiting costs";
      } else why = value > 0 ? "waiting costs more than the re-post adds" : "no tons of ours for it";
      out.set(key, {
        key,
        id: x.id,
        port: x.port,
        good: x.good,
        expiresAt: x.expiresAt,
        p,
        rivalPerDay: w.rivalBreakRate(key) * 24,
        uplift,
        tonsBefore: before,
        tonsAfter: Math.round(tonsAfter),
        value,
        cost,
        camp,
        forced,
        why,
      });
    }
    this.stakes = out;
    this.campShut = shutOut;
    this.stakesAt = Date.now();
    return out;
  }

  /**
   * After a refresh, a rival analysis or an event that moves a stall: logs each posting the fleet
   * starts or stops letting lapse. Starting, lanes into it that would land first and have bought
   * nothing yet (ships still sailing to their source) are planned again with the wait counted (at
   * once, or at the source when loads are re-sized there); stopping, ships holding for it deliver now.
   */
  private reviewStalls(): void {
    this.stakesAt = 0;
    const stakes = this.stallStakes();
    const w = this.world;
    const live = new Set<string>();
    const nudgeHolders = (key: string) => {
      const [port, good] = key.split("|");
      for (const a of this.agents.values()) if (a.holdAt(port, good)) a.nudge();
    };
    for (const st of stakes.values()) {
      live.add(st.id);
      if (st.camp === this.campState.has(st.id)) continue;
      if (st.camp) {
        this.campState.set(st.id, st.key);
        this.log(
          "fleet",
          `letting the ${st.good} charter at ${st.port} lapse for its richer re-post in ${Math.round((st.expiresAt - w.now()) / 60_000)} min (${st.why}): ` +
            `~${Math.round(st.p * 100)}% it escalates, worth ~${cr(st.value)} against ~${cr(st.cost)} waiting`,
        );
        // Loads re-sized at their source re-plan with this camp counted.
        if (!this.settings.resizeLoads) {
          for (const a of this.agents.values()) {
            const lane = a.lane;
            if (!lane || a.loaded || a.last?.ship.status !== "sailing" || a.partsToBuy().length < lane.parts.length || a.freightToTake().length < lane.freight.length) continue;
            if (lane.deliverAt - lane.holdMs < st.expiresAt && lane.fills.some(([id]) => w.currentId(id) === st.id)) {
              this.releaseLane(a);
              a.nudge();
            }
          }
        }
      } else {
        this.campState.delete(st.id);
        this.log("fleet", `delivering into the ${st.good} charter at ${st.port} again (${st.why})`);
        nudgeHolders(st.key);
      }
    }
    // Camps on postings no longer stalled (a delivery, the lapse) end: holders deliver or wait out the re-post.
    for (const [id, key] of [...this.campState]) {
      if (live.has(id)) continue;
      this.campState.delete(id);
      nudgeHolders(key);
    }
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
    const spec = this.specFor(agent, r);
    let lanes = await rankLanes(this.world, spec, from, this.reservations(agent), this.planOptions(cash, agent));
    let best = lanes.find((l) => !agent.isAvoided(l.key)) ?? null;
    // Nothing pays unarmed (pirates would likely take the ship), but this is a yard: plan as if
    // fully armed; the refit here then sizes the guns to the lane and the load is planned again.
    const max = this.world.shipClass(agent.shipClass)?.max_cannons ?? 0;
    if (!best && this.settings.guns === "auto" && r.ship.status !== "sailing" && this.world.port(from)?.has_shipyard && spec.guns < max) {
      const armed: ShipSpec = { ...spec, guns: max, cap: Math.max(0, spec.cap - 2 * (max - spec.guns)), hullValue: (spec.hullValue ?? 0) + (max - spec.guns) * GUN_PRICE_PENCE };
      lanes = await rankLanes(this.world, armed, from, this.reservations(agent), this.planOptions(cash, agent));
      best = lanes.find((l) => !agent.isAvoided(l.key)) ?? null;
    }
    // What it counted on beyond the cash in hand: cash due, which must land before it is spent.
    if (best) best = { ...best, dueCounted: Math.max(0, Math.round(best.capital - cash)) };
    agent.setLane(best);
    // Its tons before or after a stalled posting's lapse move the fleet's call on it.
    this.stakesAt = 0;
    if (best) agent.noteLane(best);
    if (best && best.key !== prev?.key) {
      this.log(
        agent.name,
        `lane: ${loadText(best)} ${best.source} → ${best.dest}, margin ~${cr(best.margin)}/t` +
          `${best.bonus > 0 ? ` incl. ~${cr(best.bonus)}/t phase bonus` : ""}${best.askKnown ? "" : " (ask estimated)"}, ~${cr(best.profitPerHour)}/h` +
          `${best.holdMs > 0 ? `, holding ~${Math.round(best.holdMs / 1000)}s at ${best.dest} for a stalled charter's re-post` : ""}` +
          `${best.speculative ? ", for a crisis charter expected from a shortage (not listed yet)" : ""}` +
          `${best.capital > cash ? `, counting on ~${cr(best.capital - cash)} of cash due before it loads` : ""}` +
          `${best.next ? `; then ${best.next}` : ""}`,
      );
    } else if (!best && prev) {
      this.log(agent.name, `no lane clears the minimum margin with the ${cr(cash)} the fleet can spend right now`);
    }
    return best;
  }

  /**
   * At a lane's source, before any of it is bought: the load planned again from here with the vaults
   * read afresh, the book just scouted, today's reservations and the cash this load may use now
   * (cashAt, and at least its own plan's first call, ownCall). The same lane re-sized if it still
   * ranks among lanes loading here, else the best of those (the passage here is sailed). Null keeps
   * the lane as planned; buying then stops at loadBudget, and a load that counted on cash due waits for
   * it rather than sail under the planner's minimum (ShipAgent.buyPart).
   */
  resizeLane(agent: ShipAgent, port: string, r: ShipResult): Promise<Lane | null> {
    const run = this.assignQueue.then(() => this.resizeLaneNow(agent, port, r));
    this.assignQueue = run.catch(() => undefined);
    return run;
  }

  private async resizeLaneNow(agent: ShipAgent, port: string, r: ShipResult): Promise<Lane | null> {
    const prev = agent.lane;
    if (!this.settings.resizeLoads || !prev || prev.source !== port || agent.loaded) return null;
    await this.world.refreshVaults().catch(() => undefined);
    const cash = this.loadCash(agent);
    const spare = this.cashAt(this.cashFlows(agent), this.world.now(), this.world.region(port));
    // First call on what its own plan still has to buy from cash in hand (that share respected the others
    // when it was planned); cash due it counted on, and growth, must leave the others' loads alone.
    const floor = Math.min(this.ownCall(agent), this.spareCash());
    const base = this.planOptions(Math.max(cash, floor), agent);
    const opts = { ...base, onlySource: port, cashAt: (at: number, src: string) => Math.max(floor, base.cashAt ? base.cashAt(at, src) : cash) };
    let lanes: Lane[];
    try {
      lanes = await rankLanes(this.world, this.specFor(agent, r), port, this.reservations(agent), opts);
    } catch (e) {
      this.log(agent.name, `planning the load again at ${port} failed (${(e as Error).message}); buying it as planned`);
      return null;
    }
    // Released or replaced meanwhile: nothing to re-size.
    if (agent.lane !== prev) return null;
    const s = this.resized;
    s.checks++;
    const room = Math.max(floor, spare);
    const here = lanes.filter((l) => l.source === port && !agent.isAvoided(l.key));
    const pick = here.find((l) => l.key === prev.key) ?? here[0];
    if (!pick) {
      this.log(
        agent.name,
        `nothing loading at ${port} pays with ${cr(room)} spare for it now; buying what that covers of ${loadText(prev)}` +
          `${(prev.dueCounted ?? 0) > 0 ? " if it makes a load worth the leg, else waiting for the cash due it counted on" : ""}`,
      );
      return null;
    }
    const before = this.committedBy(agent);
    const lane = agent.adoptResized({ ...pick, resizedFrom: prev.resizedFrom ?? prev.tons, dueCounted: Math.max(0, Math.round(pick.capital - Math.max(cash, floor))) });
    // Its tons before or after a stalled posting's lapse move the fleet's call on it.
    this.stakesAt = 0;
    const d = lane.tons - prev.tons;
    if (d > 0) {
      s.grown++;
      s.tonsAdded += d;
    } else if (d < 0) {
      s.shrunk++;
      s.tonsCut -= d;
    }
    const switched = lane.key !== prev.key;
    if (switched) s.switched++;
    if (switched || d !== 0) {
      s.at = new Date().toISOString();
      this.log(
        agent.name,
        `${switched ? "re-planned" : "re-sized"} at ${port} with ${cr(room)} spare for it now: ${loadText(prev)} → ${loadText(lane)}` +
          `${switched ? ` to ${lane.dest}` : ""} (${d >= 0 ? "+" : ""}${d} t), ~${cr(lane.profitPerHour)}/h`,
      );
      this.persist();
    }
    // Less cash tied up than planned: ships waiting for some may have it now.
    if (this.committedBy(agent) < before) this.cashArrived();
    return lane;
  }

  releaseLane(agent: ShipAgent): void {
    agent.setLane(null);
    this.stakesAt = 0;
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

  // ── Convoys ─────────────────────────────────────────────────────────────────

  private noteConvoy(r: ConvoyResult): void {
    const c = r.convoy;
    this.convoyCache.set(c.id, {
      from: c.origin_port_id,
      dest: c.dest_port_id,
      departsAt: Date.parse(c.departs_at),
      status: c.status,
      organizer: c.organizer_company_id,
      members: r.member_ship_ids,
      classes: r.members.map((m) => m.ship_class),
      checkedAt: Date.now(),
    });
  }

  async convoyWait(agent: ShipAgent, convoyId: string, port: string): Promise<number | null> {
    let c = this.convoyCache.get(convoyId);
    if (!c || Date.now() - c.checkedAt > 20_000) {
      const list = await this.client.convoys({ convoy_id: convoyId }).catch(() => null);
      if (list?.[0]) this.noteConvoy(list[0]);
      c = this.convoyCache.get(convoyId);
    }
    if (!c || c.status !== "forming" || c.from !== port) return null;
    const left = c.departsAt - this.world.now();
    agent.activity = `in convoy to ${c.dest} with ${c.members.length} ship${c.members.length === 1 ? "" : "s"}, sails in ${Math.max(0, Math.round(left / 1000))}s`;
    return Math.min(Math.max(left + 2_000, 2_000), 30_000);
  }

  /**
   * A ship about to sail `from` -> `dest`: joins one of our convoys forming here for the same port,
   * or forms one for our other ships bound the same way soon, or sails alone. Decided and done
   * (offshore, create or join) under one lock, so two ships never both form one for a route.
   */
  sailInConvoy(agent: ShipAgent, r: ShipResult, from: string, dest: string, plan: RoutePlan): Promise<ConvoyOutcome> {
    const run = this.convoyQueue.then(async (): Promise<ConvoyOutcome> => {
      const decision = await this.convoyDecision(agent, r, from, dest, plan);
      if (decision.kind === "alone") return decision;
      try {
        if (r.ship.status === "berthed") await this.client.offshore(agent.shipId);
        let convoyId: string;
        let departsAt: number;
        if (decision.kind === "join") {
          const res = await this.client.joinConvoy({ convoy_id: decision.convoyId, ship_id: agent.shipId });
          if (res.status !== "joined") {
            await this.client.detachConvoy({ convoy_id: decision.convoyId, ship_id: agent.shipId }).catch(() => undefined);
            return { kind: "failed", why: `the request is ${res.status}` };
          }
          convoyId = decision.convoyId;
          departsAt = Date.parse(res.departs_at);
          this.convoyCache.delete(convoyId);
          this.log(agent.name, `joined our convoy to ${dest} (${decision.ships + 1} ships), sailing in ${Math.round((departsAt - this.world.now()) / 1000)}s`);
        } else {
          const res = await this.client.createConvoy({
            name: `Fleet to ${dest}`,
            flagship_id: agent.shipId,
            dest_port_id: dest,
            depart_in_game_minutes: decision.departInGameMin,
            admission: "invite_only",
            visibility: "private",
          });
          this.noteConvoy(res);
          convoyId = res.convoy.id;
          departsAt = Date.parse(res.convoy.departs_at);
          this.log(agent.name, `formed a convoy to ${dest} for ${decision.partners} more of our ships, sailing in ${Math.round((departsAt - this.world.now()) / 1000)}s`);
        }
        // Seen at once by the next decision (this ship is now in a convoy, not a partner to count).
        if (agent.last) agent.last = { ...agent.last, ship: { ...agent.last.ship, convoy_id: convoyId, status: "anchored_roadstead" } };
        return { kind: "in", convoyId, departsAt };
      } catch (e) {
        if (this.isFatal(e) || !isApiError(e) || e.status >= 500) throw e;
        return { kind: "failed", why: e.message };
      }
    });
    this.convoyQueue = run.catch(() => undefined);
    return run;
  }

  /**
   * Whether to sail in convoy. In a convoy of s ships pirates board just one, so each ship's
   * expected piracy loss (its cargo, and the ship itself) is about 1/s of sailing alone. Joining
   * (or forming) is worth it when the fall in all our members' losses beats what the wait costs
   * this ship's time; only with ships of similar speed (a convoy sails at its slowest), only when
   * the stores cover the slower passage and the wait, and only if the cargo still arrives before
   * its charters and freight are due.
   */
  private async convoyDecision(
    agent: ShipAgent,
    r: ShipResult,
    from: string,
    dest: string,
    plan: RoutePlan,
  ): Promise<{ kind: "alone" } | { kind: "join"; convoyId: string; ships: number } | { kind: "form"; departInGameMin: number; partners: number }> {
    const alone = { kind: "alone" as const };
    const w = this.world;
    if (!this.settings.convoys || this.stopRequested) return alone;
    const now = w.now();
    const speed = (cls: string) => (w.shipClass(cls)?.base_speed_centiknots ?? 800) / 100;
    const ourSpeed = speed(agent.shipClass);
    const alike = (cls: string) => Math.min(speed(cls), ourSpeed) / Math.max(speed(cls), ourSpeed) >= CONVOY_MIN_SPEED_RATIO;
    const exposure = (cls: string, guns: number, cargo: number) => {
      const risk = w.piracyRisk(plan, guns, speed(cls) * 0.8, cargo);
      return risk.cargoShare * cargo + risk.capture * (this.hullValue(cls) + guns * GUN_PRICE_PENCE);
    };
    const cargoOf = (x: ShipResult) => Object.entries(x.cargo_manifest).reduce((n, [g, t]) => n + t * w.basePrice(g), 0);
    const ours = exposure(agent.shipClass, r.ship.cannons_count, cargoOf(r));
    const waitCost = (ms: number) => (agent.rate * Math.max(0, ms)) / 3_600_000;
    const baseLock = 30 * w.gameMinuteMs;
    const gameDayMs = 24 * 60 * w.gameMinuteMs;
    // Can this ship sail in a convoy leaving at `departsAt` at `slowest` knots?
    const fits = (departsAt: number, slowest: number) => {
      const slow = ourSpeed / Math.max(slowest, 0.1);
      const stores = plan.safe_provisions_tons * slow + ((departsAt - now) / gameDayMs) * plan.port_provisions_tons_per_day;
      if (r.stores.provisions_tons < stores) return false;
      const due = agent.deliverDeadline();
      const arrive = departsAt + w.sailMs(plan.total_distance_nm, slowest * 0.8) + baseLock;
      return due === null || arrive <= due;
    };

    // One of ours already forming here for the same port: join it, or sail alone (never a second).
    const forming = (await this.client.convoys({ port_id: from, status: "forming", limit: 50 }).catch(() => [] as ConvoyResult[])).filter(
      (c) => c.convoy.organizer_company_id === w.companyId && c.convoy.dest_port_id === dest,
    );
    for (const c of forming) this.noteConvoy(c);
    const live = forming.map((c) => ({ c, departsAt: Date.parse(c.convoy.departs_at) })).filter(({ departsAt }) => departsAt - now > 10_000);
    if (live.length) {
      const pick = live.filter(({ c }) => c.members.every((m) => alike(m.ship_class))).sort((a, b) => a.departsAt - b.departsAt)[0];
      if (!pick) return alone;
      const n = Math.max(1, pick.c.members.length);
      // The members are ours: their cargo is known.
      const members = pick.c.members.reduce((sum, m) => {
        const a = this.agents.get(m.ship_id);
        return sum + (a?.last ? exposure(m.ship_class, m.cannons_count, cargoOf(a.last)) : 0);
      }, 0);
      const slowest = Math.min(ourSpeed, ...pick.c.members.map((m) => speed(m.ship_class)));
      // All members' losses before (ours alone, theirs shared n ways) against after (n + 1 ways).
      const gain = ours + members / n - (ours + members) / (n + 1);
      if (gain > waitCost(pick.departsAt - now) && fits(pick.departsAt, slowest)) return { kind: "join", convoyId: pick.c.convoy.id, ships: n };
      return alone;
    }

    // Our other ships that will leave the same way soon: at this port with the same lane, or on their way here for it.
    if (ours < CONVOY_MIN_EXPOSURE_PENCE) return alone;
    const handling = w.handlingMsPerTon(from);
    const partners: Array<{ ready: number; exposure: number; speed: number }> = [];
    for (const a of this.agents.values()) {
      const pr = a.last;
      const lane = a.lane;
      if (a === agent || a.gone || !pr || !lane || lane.source !== from || lane.dest !== dest || pr.ship.convoy_id || !alike(a.shipClass)) continue;
      const load = a.loaded ? 0 : baseLock + lane.tons * handling;
      let ready: number;
      if (pr.ship.status !== "sailing" && pr.ship.current_port_id === from) ready = now + load;
      else if (pr.ship.status === "sailing" && pr.route_legs.at(-1)?.to_node === from) {
        const eta = Date.parse(pr.voyage?.estimated_arrival_at ?? pr.ship.leg_arrives_at ?? "");
        if (!Number.isFinite(eta)) continue;
        ready = eta + baseLock + load;
      } else continue;
      if (ready - now > CONVOY_MAX_WAIT_GAME_H * 60 * w.gameMinuteMs) continue;
      const value = lane.parts.reduce((n, p) => n + p.tons * w.basePrice(p.good), 0);
      const e = exposure(a.shipClass, pr.ship.cannons_count, value);
      // A partner with little at risk may not join on its own account: don't wait for it.
      if (e < CONVOY_MIN_EXPOSURE_PENCE / 2) continue;
      partners.push({ ready, exposure: e, speed: speed(a.shipClass) });
    }
    if (partners.length === 0) return alone;
    const k = partners.length;
    const waitMs = Math.max(CONVOY_MIN_MUSTER_GAME_MIN * w.gameMinuteMs, Math.max(...partners.map((p) => p.ready)) - now + baseLock);
    const gain = ((ours + partners.reduce((n, p) => n + p.exposure, 0)) * k) / (k + 1);
    const slowest = Math.min(ourSpeed, ...partners.map((p) => p.speed));
    if (gain <= waitCost(waitMs) || !fits(now + waitMs, slowest)) return alone;
    return { kind: "form", departInGameMin: Math.min(3 * 24 * 60, Math.ceil(waitMs / w.gameMinuteMs)), partners: k };
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

  /** Cash spendable in a region after its floor, remitted from other regions if short. `fresh`: the vaults were just read. */
  async ensureCash(region: BankingRegion, amount: number, fresh = false): Promise<number> {
    const w = this.world;
    if (!fresh) await w.refreshVaults();
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

  /** When a ship whose lane is still to buy will buy it: on reaching its source if sailing there, else now (the most careful). */
  private buyTime(a: ShipAgent, now: number): number {
    const r = a.last;
    if (!r || !a.lane || r.ship.status !== "sailing" || r.route_legs.at(-1)?.to_node !== a.lane.source) return now;
    const eta = Date.parse(r.voyage?.estimated_arrival_at ?? r.ship.leg_arrives_at ?? "");
    return Number.isFinite(eta) ? Math.max(now, eta) : now;
  }

  /**
   * The fleet's cash movements from now on, in time order: what each other ship's load still has to
   * spend, when it buys; and (at cashDuePct) what our cargo at sea is due to be paid where it lands,
   * less any shortfall under that region's floor (refilled first). Nothing due counts as in hand.
   */
  private cashFlows(except?: ShipAgent): CashFlow[] {
    const w = this.world;
    const now = w.now();
    const flows: CashFlow[] = [];
    for (const a of this.agents.values()) {
      const out = a === except ? 0 : this.committedBy(a);
      if (out > 0) flows.push({ at: this.buyTime(a, now), pence: -out, region: null });
    }
    const share = this.settings.resizeLoads ? this.settings.cashDuePct / 100 : 0;
    if (share > 0) {
      const due = [...this.agents.values()]
        .filter((a) => a !== except && !a.gone)
        .map((a) => a.proceedsAboard())
        .filter((p): p is NonNullable<typeof p> => p !== null)
        .sort((x, y) => x.at - y.at);
      const short = new Map<BankingRegion, number>();
      for (const p of due) {
        const region = w.region(p.dest);
        const gap = short.get(region) ?? Math.max(0, this.floorIn(region) - w.vault(region));
        const pence = Math.round(p.pence * share);
        short.set(region, Math.max(0, gap - pence));
        // Never "now": at the buy only cash in hand counts.
        if (pence > gap) flows.push({ at: Math.max(p.at, now + 1), pence: pence - gap, region });
      }
    }
    return flows.sort((x, y) => x.at - y.at);
  }

  /**
   * Cash a load bought at `at` in `region` may use: the least the fleet's spare cash falls to from then
   * on, after our other ships' loads and with cash due (less the fee to bring it to `region`). A ship
   * never counts on cash another's load needs first. With nothing due this equals loadCash().
   */
  private cashAt(flows: CashFlow[], at: number, region: BankingRegion | null, spare = this.spareCash()): number {
    let bal = spare;
    let low: number | null = null;
    for (const f of flows) {
      if (low === null && f.at > at) low = bal;
      const fee = f.pence > 0 && f.region && region && f.region !== region ? this.world.remitBps(f.region, region) / 10_000 : 0;
      bal += f.pence * (1 - fee);
      if (low !== null) low = Math.min(low, bal);
    }
    return Math.max(0, Math.floor(low ?? bal));
  }

  /**
   * Cash this ship may put into its load now in `region` (topped up from other regions): at most
   * `amount`, and never what our other ships' loads count on unless cash due lands before they buy;
   * but always its own plan's share planned on cash in hand, while that cash is there (ownCall: that
   * share respected the others when it was planned). Call holding the cash lock. Re-sizing off: as before.
   */
  async loadBudget(agent: ShipAgent, region: BankingRegion, amount: number): Promise<number> {
    if (!this.settings.resizeLoads) return this.ensureCash(region, amount);
    await this.world.refreshVaults();
    const spare = this.spareCash();
    // First call on its own plan's cash in hand (ownCall); beyond that never what our other ships' loads count on.
    const budget = Math.max(this.cashAt(this.cashFlows(agent), this.world.now(), region, spare), Math.min(this.ownCall(agent), spare));
    if (budget <= 0) return 0;
    return Math.min(budget, await this.ensureCash(region, Math.min(amount, budget), true));
  }

  private cashReport(): CashReport {
    let committed = 0;
    for (const a of this.agents.values()) committed += this.committedBy(a);
    const due = this.cashFlows().filter((f) => f.pence > 0);
    return {
      sparePence: this.spareCash(),
      committedPence: Math.round(committed),
      duePence: Math.round(due.reduce((n, f) => n + f.pence, 0)),
      dueNextAt: due[0]?.at ?? null,
      resized: { ...this.resized },
    };
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
   * Rival intel, every couple of minutes (sooner after a public notice): what is gathered, then the
   * analysis.
   */
  private async runRivals(): Promise<void> {
    await this.gatherRivals();
    await this.analyseRivalsNow();
  }

  /**
   * Sailings at the ports where we have presence and, with `rivalIntel`, the public policy list
   * (closed policies say when a ship arrived or sank), public convoys and the hourly leaderboard.
   */
  private async gatherRivals(): Promise<void> {
    const { world, client, settings } = this;
    const ports = new Set<string>();
    for (const a of this.agents.values()) {
      const s = a.last?.ship;
      if (s && s.status !== "sailing" && s.current_port_id) ports.add(s.current_port_id);
    }
    for (const p of await client.factors().catch(() => [] as string[])) ports.add(p);
    const intel = settings.rivalIntel;
    const [details, policies, forming, sailing, board] = await Promise.all([
      Promise.all([...ports].map((p) => client.port(p).catch(() => null))),
      intel ? client.policies({ limit: 200 }).catch(() => null) : null,
      intel ? client.convoys({ status: "forming", limit: 50 }).catch(() => null) : null,
      intel ? client.convoys({ status: "sailing", limit: 50 }).catch(() => null) : null,
      intel && Date.now() >= this.nextLeaderboardAt ? client.leaderboard().catch(() => null) : null,
    ]);
    for (const d of details) if (d) world.observeGossip(d);
    if (policies) world.rivals.addPolicies(policies);
    for (const list of [forming, sailing]) if (list) world.rivals.addConvoys(list);
    if (board) {
      world.rivals.observeLeaderboard(board);
      // Recomputed hourly: look again just after the next refresh (server time to ours), not sooner than 5 min.
      const next = Date.parse(board.next_refresh_at ?? "");
      this.nextLeaderboardAt = Math.max(Date.now() + 5 * 60_000, Number.isFinite(next) ? next - world.skewMs + 30_000 : Date.now() + 3_600_000);
    }
  }

  /**
   * Where every rival ship probably is, who lands where before our ships (charter crowding, stall
   * odds), and rival traffic per sea zone (marques), from what was gathered. No fetch but routes
   * (cached), so it can run again within seconds of a laden rival's notice.
   */
  private async analyseRivalsNow(): Promise<void> {
    const { world } = this;
    const now = world.now();
    world.rivals.prune(now, world.gameMinuteMs);
    const analysis = await analyseRivals(world.rivals, {
      catalog: world.catalog,
      route: (f, t, c) => world.route(f, t, c).catch(() => null),
      now,
      gameMinuteMs: world.gameMinuteMs,
      piracy: world.piracy,
      intel: this.settings.rivalIntel,
      quotes: this.knownQuotes(),
    });
    world.rivalLandings = new Map(analysis.landings);
    this.rivalAnalysis = { ...analysis, at: Date.now() };
    this.lastRivalAnalysis = Date.now();
    // For the AI digest: companies aliased there, never named; rivals seen first.
    const profiles = rivalProfiles(world.rivals, analysis, now)
      .filter((p) => p.ships > 0 || p.earnPerHour !== null)
      .sort((a, b) => b.ships - a.ships || (b.netWorth ?? 0) - (a.netWorth ?? 0));
    this.rivalSummary = {
      companies: profiles.map((p) => {
        const ships = analysis.ships.filter((s) => s.company === p.company);
        return {
          ships: p.ships,
          laden: ships.filter((s) => s.loadState !== null && s.loadState !== "ballast").length,
          sailing: ships.filter((s) => s.voyage && s.voyage.departAt <= now && s.voyage.arriveAt > now).length,
          earnPerHour: p.earnPerHour,
          lanes: p.lanes.slice(0, 3).map((l) => `${l.from}>${l.to} x${l.voyages} (${l.laden} laden)`),
          feeds: p.feeds.slice(0, 4).map((f) => `${f.port}/${f.good} ${Math.round(f.tons)}t`),
        };
      }),
      zones: analysis.zones.map((t) => ({ zone: t.zone, passages: t.passages, laden: t.laden })),
    };
    // Rivals landing where a posting is stalled move its odds: the fleet's calls follow within seconds.
    this.reviewStalls();
  }

  /** Cheapest quote seen per hull class (what the game values a hull at). */
  private knownQuotes(): Map<string, number> {
    const out = new Map<string, number>();
    for (const [k, v] of this.hullQuotes) {
      const cls = k.slice(k.indexOf("|") + 1);
      out.set(cls, Math.min(out.get(cls) ?? Infinity, v));
    }
    return out;
  }

  /**
   * Judges a marque in every zone rival traffic crosses (the last rival analysis), and (when enabled,
   * within the budget) sponsors the most profitable one that clears the safety margin, for one game day.
   */
  private async runMarques(): Promise<void> {
    const { world, client, settings } = this;
    if (!this.rivalAnalysis || Date.now() - this.rivalAnalysis.at > RIVAL_ANALYSIS_MAX_AGE_MS) await this.runRivals();
    const analysis = this.rivalAnalysis;
    if (!analysis) return;
    const now = world.now();
    const [zones, ours] = await Promise.all([client.zones(), this.recentMarques(now)]);
    const spent = ours.filter((m) => now - Date.parse(m.created_at) < 24 * 3_600_000).reduce((n, m) => n + m.cost_pence, 0);
    const prize = ours.reduce((n, m) => n + m.prize_earned_pence, 0);
    const active = new Set(ours.filter((m) => Date.parse(m.expires_at) > now).map((m) => m.sea_zone_id));
    const traffic = analysis.zones;
    const own = await this.ownExposure();

    // Marques are sized to what the budget has left (a game day of it), not refused for being big.
    const days = MARQUE_GAME_HOURS / 24;
    const left = Math.max(0, settings.marqueBudgetPence - spent);
    const maxBps = left >= MARQUE_MIN_PENCE ? Math.floor(left / (MARQUE_PENCE_PER_BPS_DAY * days) / 50) * 50 : 0;

    const rows: MarqueZoneReport[] = [];
    for (const t of traffic) {
      const z = zones.find((x) => x.sea_zone_id === t.zone);
      if (!z || z.phase > world.unlockedPhase) continue;
      // What a marque bought now covers: the next game day. Sailings already announced there (rival intel)
      // stand in for it when they exceed the last day's.
      const exposure = settings.rivalIntel ? Math.max(t.exposure, t.next.exposure) : t.exposure;
      const laden = settings.rivalIntel ? Math.max(t.laden, t.next.laden) : t.laden;
      const best = bestMarque(z, exposure, own.get(t.zone) ?? 0, Math.max(50, maxBps));
      const verdict = active.has(t.zone)
        ? "our marque is in force"
        : best.bps === 0
          ? "the zone's marques are at their cap"
          : laden < MARQUE_MIN_LADEN
            ? `too little laden traffic seen (${laden.toFixed(1)} a game day; needs ${MARQUE_MIN_LADEN})`
            : best.profit <= 0 || best.prize < MARQUE_SAFETY * (best.cost + best.ownLoss)
              ? `doesn't pay: prize ~${cr(best.prize)} vs cost ${cr(best.cost)} + our losses ${cr(best.ownLoss)} a game day`
              : "pays";
      rows.push({ zone: t.zone, passages: t.passages, laden, cargo: Math.round(t.cargo), next: t.next, best, active: active.has(t.zone), verdict });
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
    // The same lists are the public record of other companies' voyages: rival intel at no extra call.
    if (settings.rivalIntel) {
      world.rivals.addPolicies([...open, ...active]);
      this.rivalAnalysisDirty = true;
    }
    const rows = judgePolicies([...open, ...active], {
      ours: this.ourCompanyIds,
      now: world.now(),
      gameMinuteMs: world.gameMinuteMs,
      budgetPence: settings.underwriteBudgetPence,
      lockedPence: locked,
      maxPerPolicyPence: settings.underwriteMaxPerPolicyPence,
      minEdgeBps: settings.underwriteMinEdgeBps,
      held: new Set(held.map((p) => p.id)),
      record: settings.rivalIntel
        ? (p) => world.rivals.policyRecord(p.insured_company_id, p.origin_port_id, p.dest_port_id, p.insured_value_pence > p.hull_value_pence)
        : undefined,
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

  /** Rival intel and the last analysis (null once it is old), for the dashboard. */
  get rivalIntel() {
    const fresh = this.rivalAnalysis && Date.now() - this.rivalAnalysis.at < RIVAL_ANALYSIS_MAX_AGE_MS ? this.rivalAnalysis : null;
    return {
      sightings: this.world.rivals.all(),
      snapshot: this.world.rivals.snapshot(),
      analysis: fresh,
      quotes: [...this.knownQuotes()],
      activeCompanies: this.world.activeCompanies,
    };
  }

  // ── Buying ships ────────────────────────────────────────────────────────────

  /** Money spent mounting guns counts with the fleet's ship spending. */
  noteArmed(shipId: string, costPence: number): void {
    this.shipSpendPence += costPence;
    const p = this.purchases.find((x) => x.shipId === shipId);
    if (p) p.costPence += costPence;
  }

  /**
   * What an own-materials build would cost here, from a turnkey quote: the labour, plus each
   * material bought on this port's market at the yard's own walk of its ask ladder (the turnkey
   * price before the 15% markup) with customs on top. Null when a material can't be supplied.
   */
  private byomPrice(q: BuildQuote, yard: string): number | null {
    if (!q.total_cost_pence || q.materials.some((m) => !m.cost_pence)) return null;
    const customs = 1 + this.world.customsBps(yard) / 10_000;
    return Math.round(q.labour_pence + q.materials.reduce((n, m) => n + (m.cost_pence ?? 0), 0) * customs);
  }

  /** Whether builds at this yard may use own materials now. */
  private byomOk(yard: string): boolean {
    return this.settings.byomBuilds && (this.byomBlockedUntil.get(yard) ?? 0) <= Date.now();
  }

  /**
   * Buys the materials a build here lacks into our warehouse at the yard (leasing the room first;
   * we have presence, being able to build here): per material an IOC bid capped a little above
   * the turnkey walk's average per ton, then one for any shortfall at what is left of a budget a
   * little over the walk (a steep ladder's top levels cost more than its average). Each fill is
   * booked to the ship spend and the vault as it is paid. `leaseBefore` is the lease to go back to
   * after, set only when this grew it.
   */
  private async buyMaterials(yard: string, cls: string, q: BuildQuote): Promise<{ ok: boolean; spent: number; why: string; leaseBefore: number | null }> {
    let spent = 0;
    let leaseBefore: number | null = null;
    const region = this.world.region(yard);
    try {
      // Unreadable is not empty: a guess here could buy twice or set the lease below what it is.
      const wh = await this.client.warehouse(yard);
      const held = (good: string) => {
        const i = wh.inventory.find((x) => x.commodity_id === good);
        return i ? Math.max(0, i.quantity - i.locked_quantity) : 0;
      };
      const want = q.materials.map((m) => ({ m, qty: Math.max(0, m.quantity - held(m.commodity_id)) })).filter((x) => x.qty > 0);
      if (want.length === 0) return { ok: true, spent, why: "", leaseBefore };
      const need = wh.used_tonnage + wh.reserved_tonnage + want.reduce((n, x) => n + x.qty, 0);
      if (wh.leased_tonnage < need) {
        await this.client.setLease(yard, need);
        leaseBefore = wh.leased_tonnage;
      }
      for (const { m, qty } of want) {
        const budget = Math.floor(((m.cost_pence ?? 0) * qty * BYOM_BUDGET_MARKUP) / Math.max(m.quantity, 1));
        let left = qty;
        let paid = 0;
        for (let attempt = 0; attempt < 2 && left > 0; attempt++) {
          const perTon =
            attempt === 0 ? Math.ceil(((m.cost_pence ?? 0) / Math.max(m.quantity, 1)) * BYOM_FIRST_BID_MARKUP) : Math.floor((budget - paid) / left);
          if (perTon <= 0) break;
          const res = await this.client.placeOrder({ port_id: yard, commodity_id: m.commodity_id, side: "bid", time_in_force: "ioc", price_pence: perTon, quantity: left });
          const cost = res.total_gross_pence + res.customs_duty_pence;
          paid += res.total_gross_pence;
          spent += cost;
          this.shipSpendPence += cost;
          this.world.vaults.set(region, this.world.vault(region) - cost);
          left -= res.filled_quantity;
        }
        if (left > 0) return { ok: false, spent, why: `${left} t of ${m.commodity_id} short`, leaseBefore };
      }
    } catch (e) {
      if (this.isFatal(e)) throw e;
      return { ok: false, spent, why: (e as Error).message, leaseBefore };
    } finally {
      if (spent > 0) this.persist(true);
    }
    this.log("fleet", `bought the materials for a ${cls} at ${yard} into our warehouse there (${cr(spent)})`);
    return { ok: true, spent, why: "", leaseBefore };
  }

  /**
   * After an own-materials attempt grew the lease here: back down to the lease before it, or to
   * what the warehouse still holds if that is more.
   */
  private async shrinkLease(yard: string, before: number): Promise<void> {
    try {
      const wh = await this.client.warehouse(yard);
      const target = Math.max(before, wh.used_tonnage + wh.reserved_tonnage);
      if (wh.leased_tonnage > target) await this.client.setLease(yard, target);
    } catch (e) {
      if (!this.isFatal(e)) this.log("fleet", `couldn't shrink the warehouse lease at ${yard}: ${(e as Error).message}`);
    }
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
          if (now.includes(yard)) {
            this.tempFactors.add(yard);
            this.persist(true);
          }
        }
        return false;
      }
    });
    if (!hired) {
      this.factorFailed();
      return false;
    }
    this.tempFactors.add(yard);
    // Saved at once: a restart before its dismissal must still know it is ours to dismiss.
    this.persist(true);
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
        this.persist(true);
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
    const aiHold = this.advisor.buyHold();
    if (aiHold) return this.setBuyer(`AI: holding cash (${aiHold.slice(0, 160)})`);
    const classes = world.catalog.ship_classes.filter((c) => settings.buyClasses.includes(c.id) && c.phase <= world.unlockedPhase);
    if (classes.length === 0) return this.setBuyer("no allowed hull class can be built in this phase");
    if ([...this.agents.values()].some((a) => a.waitingForCash)) return this.setBuyer("a ship is waiting for cash to load: not buying");

    await world.refreshVaults();
    // Cash the existing fleet still needs for loads it is bound to buy comes first (loads sized on
    // cash due included: cash due never funds a hull).
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

    type Option = { yard: string; cls: string; hull: number; byom: boolean; guns: number; cost: number; payback: number; net: number; lane: Lane; upkeepFloor: number };
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
          // Own materials bought on this yard's market skip the markup: priced at the cheaper way.
          // (The cache keeps the turnkey price: always on offer, it is what a hull costs to replace.)
          const own = this.byomOk(yard) ? this.byomPrice(quote, yard) : null;
          price = own !== null && quote.total_cost_pence - own >= BYOM_MIN_SAVING_PENCE ? own : quote.total_cost_pence;
          this.hullQuotes.set(`${yard}|${cls.id}`, quote.total_cost_pence);
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
        // Without the AI's lane bias: it may only hold the buyer, never talk it into a ship. Nor is one
        // built for a crisis charter only expected from the news, in its own leg or the onward one.
        const lane = (await rankLanes(world, this.specForClass(cls.id, guns), yard, this.reservations(), { ...this.planOptions(afterBuy), bias: undefined, noSpeculativeOnward: true })).find((l) => !l.speculative);
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
        // Priced from a cached quote (factor path) the way is decided at build time.
        options.push({ yard, cls: cls.id, hull, byom: this.byomOk(yard), guns, cost, payback: cost / net, net, lane, upkeepFloor });
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
    // Materials bought for an own-materials build (on top of the build's own charge, the labour),
    // and the warehouse lease before buying them grew it (to go back to after, whatever happens).
    let materialsSpent = 0;
    let leaseBefore: number | null = null;
    const built = await this.withCash(async () => {
      if (this.stopRequested) return null;
      // The quote may be minutes old by now: price it again and re-check what the fleet needs.
      const q = await this.client.shipyardQuote(pick.yard, pick.cls, "turnkey_cash").catch(() => null);
      const own = q && pick.byom ? this.byomPrice(q, pick.yard) : null;
      const byom = own !== null && !!q?.total_cost_pence && q.total_cost_pence - own >= BYOM_MIN_SAVING_PENCE;
      const quoted = byom ? own : (q?.total_cost_pence ?? null);
      if (!q?.available || !quoted || quoted > pick.hull * 1.05) {
        if (q?.total_cost_pence) this.hullQuotes.set(`${pick.yard}|${pick.cls}`, q.total_cost_pence);
        else this.hullQuotes.delete(`${pick.yard}|${pick.cls}`);
        return failLater(`the price of a ${pick.cls} at ${pick.yard} moved or it can't be built now`);
      }
      const price = quoted;
      await world.refreshVaults();
      let committedNow = 0;
      for (const a of this.agents.values()) committedNow += this.committedBy(a);
      if (this.spareCash() - committedNow - pick.upkeepFloor - chest < price) {
        return failLater(`after the fleet's loads${chest > 0 ? " and the cash kept for the next phase" : ""} there is no longer ${cr(price)} spare for a ${pick.cls}`);
      }
      const cash = await this.ensureCash(region, price);
      if (cash < price) return failLater(`could not raise ${cr(price)} in ${region} for a ${pick.cls}`);
      // Own materials: buy what the warehouse here lacks, then build from it.
      let mode: "byom" | "turnkey_cash" = "turnkey_cash";
      if (byom) {
        const got = await this.buyMaterials(pick.yard, pick.cls, q);
        materialsSpent = got.spent;
        leaseBefore = got.leaseBefore;
        if (!got.ok) {
          // Nothing bought: build turnkey here for a while. Some bought: the next try here buys only the rest.
          if (got.spent === 0) this.byomBlockedUntil.set(pick.yard, Date.now() + BYOM_BLOCK_MS);
          return failLater(
            `couldn't buy every material for a ${pick.cls} at ${pick.yard} (${got.why})${got.spent > 0 ? `; the ${cr(got.spent)} bought stays in the warehouse there for the next try` : ""}`,
          );
        }
        mode = "byom";
      }
      try {
        return await this.client.buildShip(pick.yard, name, pick.cls, mode);
      } catch (e) {
        if (this.isFatal(e)) throw e;
        if (!isApiError(e) || e.status >= 500 || e.code === "idempotency_request_in_flight") {
          // Unknown outcome: look for the ship a few times before deciding it wasn't built.
          for (let i = 0; i < 3; i++) {
            const ships = await this.client.ships().catch(() => [] as ShipResult[]);
            const found = ships.find((x) => x.ship.name === name && x.ship.current_port_id === pick.yard);
            if (found) return { ship_id: found.ship.id, name, port_id: pick.yard, ship_class: pick.cls, build_mode: mode, status: found.ship.status, total_cost_pence: mode === "byom" ? q.labour_pence : price };
            await new Promise((r) => setTimeout(r, 5_000));
          }
          // Still unknown: don't build again for a full cooldown; adopt the ship if it turns up.
          this.lastBuy = Date.now();
          // The lease goes back once the ship turns up (not before: the build may still need the materials).
          this.pendingBuild = {
            name,
            yard: pick.yard,
            cls: pick.cls,
            price: mode === "byom" ? q.labour_pence : price,
            cost: price,
            leaseBefore,
            payback: pick.payback,
            lane: pick.lane.key,
          };
          leaseBefore = null;
          this.persist(true);
          this.setBuyer(`building a ${pick.cls} at ${pick.yard}: outcome unknown (${(e as Error).message}); watching for "${name}"`, true);
          return null;
        }
        // Usually presence lost (the ship sailed) or the price moved past our cash.
        if (mode === "byom") this.byomBlockedUntil.set(pick.yard, Date.now() + BYOM_BLOCK_MS);
        return failLater(
          `building a ${pick.cls} at ${pick.yard} failed: ${(e as Error).message}${mode === "byom" ? "; its materials stay in the warehouse there" : ""}`,
        );
      }
    });
    if (leaseBefore !== null) void this.shrinkLease(pick.yard, leaseBefore);
    if (!built) return;

    this.lastBuy = Date.now();
    this.factorFails = 0;
    // An own-materials build charges only the labour; its materials were booked as they were bought.
    const spentOnHull = built.total_cost_pence + (built.build_mode === "byom" ? materialsSpent : 0);
    this.shipSpendPence += built.total_cost_pence;
    world.vaults.set(region, world.vault(region) - built.total_cost_pence);
    this.log(
      "fleet",
      `built ${pick.cls} "${name}" at ${pick.yard} for ${cr(spentOnHull)}${built.build_mode === "byom" ? " from our own materials" : ""}: lane ${pick.lane.key}, ~${cr(pick.net)}/h net, pays back in ~${pick.payback.toFixed(1)} h`,
    );
    this.purchases.push({
      at: new Date().toISOString(),
      shipId: built.ship_id,
      name,
      shipClass: pick.cls,
      port: pick.yard,
      costPence: spentOnHull,
      paybackHours: Math.round(pick.payback * 10) / 10,
      lane: pick.lane.key,
    });
    this.setBuyer(`bought ${pick.cls} "${name}" at ${pick.yard}`);
    await this.scanShips();
  }
}
