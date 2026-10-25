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
 * Loans (finance.ts; runFinance): with leverage on, a loan bridges a hull or a load cash can't fund only when it
 * earns minLoanReturnX its interest and pays back within half its term, within maxDebtPct of net worth; what is
 * owed is kept back (debtFence; an outflow on the cash timeline for loads), repaid early when no ship waits for
 * cash and always in full 2 game days before maturity. Idle vault cash above the wealth levy's threshold is lent on
 * the credit board, secured by ship liens, and taken back when the fleet needs it.
 *
 * Ship deals (deals.ts; shipDeals): the buyer also weighs ships for sale at our quays against building their class
 * (buyListing), and commissions at our yards are built to order when the price beats our cheapest build by a clear
 * margin (runCommissions), delivered at once. Envelopes (runEnvelopes): fresh news at our quays sealed and sold, never bought.
 *
 * Stalls: for each stalled expansion posting the fleet makes one call (stallStakes): let it lapse for
 * its richer re-post (no ship delivers into it, beyond what fits under the pace line once re-posts showed
 * that safe; loads planned into it that land first wait) when the expected uplift beats what waiting
 * costs, or deliver. A rival's (or our other company's) delivery notice ends a camp at once.
 *
 * Events: a long poll on the company's event log wakes a ship's agent the moment something happens
 * to it (arrival, berth from the queue, eviction, hazard) and refreshes the world as soon as a
 * charter is posted, filled or expires, so idle ships re-plan at once. Public notices (a policy
 * listed, a convoy formed, a laden rival sailing) bring the rival check forward. Timers remain the fallback.
 * World events (shortages, gluts, pirate outbreaks, structural shifts) are read from the public feed
 * with every world refresh; see World.noteEvents.
 *
 * AI (ai/advisor.ts, live only): its setting overrides sit on the user's under hard floors wherever
 * settings are read (ai/directives.ts enforceFloors); its bans go into every plan; its ship orders act
 * through lane assignment and the ship's own decisions; a build order runs the buyer once with every
 * check; its marques and patrols are issued within the marque budget (runAiNaval). What can't be done
 * is reported back to it as a status code, and logged.
 *
 * Progress (each ship's lane and cargo state, sell floors, trips, stats, purchases, the log, the
 * event cursor and the world model's memory) is saved as it changes (journal.ts: MongoDB when
 * MONGODB_URI is set, plus a local file) and picked up again on start, so a restart resumes work.
 *
 * Runs in-process in the Next.js server (fleet-registry.ts) or from the CLI (workers/kibb-fleet.ts).
 */

import { fatalText, KibbClient, KIBB_DEFAULT_URL, isApiError, isFatalApiError, outcomeUnknown } from "../client";
import { analyseRivals, bestMarque, classOfHull, pirateAttention, rivalProfiles, seizedShare, ZONE_MARQUE_CAP, zoneDays, type MarqueOption, type RivalAnalysis, type RivalDelivery, type ZoneTraffic } from "../rivals";
import type {
  BoardOffer,
  ConvoyResult,
  ConvoyStatus,
  CreditBoard,
  EnvelopeCategory,
  EnvelopeDetail,
  EnvelopeStatus,
  InsurancePolicyListing,
  LedgerEntry,
  LetterOfMarque,
  Loan,
  MarqueQuote,
  NavalPatrol,
  SeaZonePiracyResult,
  ShipListingResult,
  UnderwritingFigures,
} from "../schema";
import {
  commissionCase,
  COMMISSION_MIN_LEFT_GAME_H,
  deliveryPays,
  ENVELOPE_EVERY_GAME_H,
  ENVELOPE_GAME_CAP,
  ENVELOPE_LIFE_GAME_H,
  ENVELOPE_MAX_OPEN,
  ENVELOPE_STALE_GAME_H,
  envelopePrice,
  listingWorth,
} from "./deals";
import {
  fittingOffers,
  GOLDSMITHS_MAX_PRINCIPAL_PENCE,
  GOLDSMITHS_RATE_BPS,
  IDLE_BUFFER_PENCE,
  IDLE_EXPIRY_GAME_H,
  IDLE_MAX_LTV_BPS,
  IDLE_MIN_LOAN_PENCE,
  IDLE_MIN_POST_PENCE,
  IDLE_TERM_DAYS,
  idleRate,
  interestFor,
  LOAN_INTEREST_HEADROOM,
  LOAN_MAX_HULL_SHARE,
  LOAN_MAX_LOAD_PENCE,
  LOAN_MAX_TERM_DAYS,
  LOAN_MIN_PRINCIPAL_PENCE,
  loanCase,
  loanTerm,
  MAX_ACTIVE_LOANS,
  owedAt,
  PLEDGE_VALUE_MARGIN,
  REPAY_LEAD_DAYS,
  repayBy,
} from "./finance";
import { judgePolicies, type UnderwriteRow } from "./underwriter";
import type { StreamEvent } from "../schema";
import type { BankingRegion, BuildMode, BuildQuote, CatalogShipClass, ContractListing, LeaderboardResult, PlaceOrderResult, RoutePlan, ShipResult } from "../types";
import { ShipAgent, STORES_BUFFER_DAYS, type AgentSnapshot, type AgentState, type AgentStats, type ConvoyOutcome, type FleetHost, type HoldInfo, type TripRecord } from "./agent";
import { openJournal, type Journal } from "./journal";
import { Advisor, AI_MODES, type AdvisorSnapshot, type AiMode, type AiReport } from "../ai/advisor";
import { AI_EFFORTS, AI_MODELS, type AiEffort, type AiModel } from "../ai/claude";
import type { DigestInput, DigestShip, DigestYard, DigestZone } from "../ai/digest";
import {
  enforceFloors,
  laneBanned,
  NAVAL_BPS_MIN,
  NAVAL_TERM_MIN_H,
  patrolCost,
  type FinanceOrder,
  type NavalOrder,
  type OrderCode,
  type OrderStatus,
  type ShipOrder,
  type ValidateCtx,
} from "../ai/directives";
import { acquireLease, type Lease } from "./lease";
import { pickShipName } from "./names";
import { HOLD_CAP_GAME_H, HOLD_MAX_GAME_H, rankLanes, REPOST_GRACE_GAME_MIN, type Lane, type PlanOptions, type Reservations, type ShipSpec, type StallStake } from "./planner";
import { OWN_TRICKLE_CONFIRM, SEASON_ENDGAME_MS, World, type ExpansionWatch, type StormSummary, type TrickleSample, type WorldEventsReport, type WorldSnapshot } from "./world";

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
   * Sponsor letters of marque automatically where the game's quote (prize money expected from the zone's
   * player traffic, after the Admiral's tenth) beats its price and our own ships' extra losses, in zones
   * with rival traffic seen. Off by default.
   */
  marques: boolean;
  /** Most spent on letters of marque in any 24 real hours (pence). */
  marqueBudgetPence: number;
  /**
   * Underwrite other companies' voyage policies whose premium beats Lloyd's own expected-loss estimate
   * on the listing (an upper bound), in small slices, taking first pick before Lloyd's looks. Off by default.
   */
  underwrite: boolean;
  /** Most collateral locked in escrow at once (pence; all escrow counts, to stay on the safe side). */
  underwriteBudgetPence: number;
  /** Most collateral on any one policy (pence). */
  underwriteMaxPerPolicyPence: number;
  /** Least edge over Lloyd's expected-loss estimate (bps of the sum insured). */
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
   * Let a stalled expansion posting (under a tenth of its expected pace) lapse for its richer re-post when
   * the expected uplift on our tons beats what waiting costs: no ship delivers into it meanwhile (ours are
   * taken to cancel the escalation too, until re-posts show they don't; then only what keeps it under the
   * line) and runs are timed to land just after the lapse. On by default.
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
  /**
   * Borrow, conservatively, to fund a hull or a load (at its source; needs resizeLoads) that cash can't: only when what
   * the money earns over the loan's term is at least `minLoanReturnX` times its interest and it pays back within half
   * the term, from the cheapest fitting credit-board offer, else the Goldsmiths' backstop against a ship of ours (never
   * one insured, listed, in a convoy or already pledged), total owed within `maxDebtPct` of net worth. What is owed is
   * kept back from other spending, repaid early from spare cash and always in full 2 game days before it matures.
   * Never in the season's endgame or while a loan is overdue. On by default.
   */
  leverage: boolean;
  /** Most owed on loans at once (principal and interest), as a share (0–100%) of net worth. */
  maxDebtPct: number;
  /** A loan must be expected to earn at least this many times its interest over its term (1 or more). */
  minLoanReturnX: number;
  /**
   * Lend vault cash above the wealth levy's 500,000 Cr threshold (less a 25,000 Cr buffer) on the credit board: one
   * secured offer (ship liens, at most half the pledge's value, with recourse) at or just under the best rival rate,
   * never under the levy's 10 bps a game day; taken back when the fleet needs the cash. Never while we owe on a loan.
   * On by default.
   */
  idleCash: boolean;
  /**
   * Ship deals (guide 3.4): the buyer also weighs ships for sale at ports where we have quay presence, and buys one priced
   * under building its class (through every check a build passes); and at yards where we have presence the autopilot
   * builds commissions to order when the price beats our cheapest build by a clear margin after the collateral's risk,
   * with the cash for the build and the collateral after loads, delivering at once. Never our own companies' listings
   * or commissions; never lists our ships. On by default.
   */
  shipDeals: boolean;
  /**
   * Intelligence envelopes (guide 3.11): at our quays, seal fresh port reports and sailings (and non-public charters,
   * only of goods the fleet isn't working) every 2 game hours and list them at a modest price per item for their age;
   * stale ones withdrawn unsold; sales booked. Never buys any. On by default.
   */
  envelopes: boolean;
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
  leverage: true,
  maxDebtPct: 25,
  minLoanReturnX: 2,
  idleCash: true,
  shipDeals: true,
  envelopes: true,
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
  bool("leverage");
  num("maxDebtPct", 0);
  if (out.maxDebtPct !== undefined && out.maxDebtPct > 100) throw new FleetSettingsError("maxDebtPct must be 0 to 100");
  num("minLoanReturnX", 1);
  if (out.minLoanReturnX !== undefined && out.minLoanReturnX > 20) throw new FleetSettingsError("minLoanReturnX must be 1 to 20");
  bool("idleCash");
  bool("shipDeals");
  bool("envelopes");
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
  /** Bought where she lay (ship market) rather than built; absent on builds. */
  bought?: boolean;
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
  /** Loans owed and made, the debt cap, idle cash on the credit board (absent from older managers). */
  finance?: FinanceReport | null;
  /** Ships for sale and commissions seen, ours being built, our envelopes (absent from older managers). */
  deals?: DealsReport | null;
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
  /**
   * The season's announced end (guide 3.11; null: not announced), the real ms left before it (the slack
   * taken off), and the mode: endgame (no new hulls), final (the last hours).
   */
  season: { endsAt: string | null; leftMs: number | null; mode: "normal" | "endgame" | "final" };
  /** When the company key expires (whoami; null: never, or not read yet). */
  keyExpiresAt: string | null;
  /** The operators paused the world: ships wait, nothing is bought or sold. */
  paused: boolean;
  /** The operators' last critical announcement (server_announcement), for a day: a dashboard banner. */
  announcement: { at: string; message: string } | null;
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
  /**
   * Our own small deliveries into stalled postings: allowed under the pace line (after `needed` re-posts in a
   * row escalated after only ours), the record so far, and its last samples.
   */
  trickle: { allowed: boolean; confirmed: number; needed: number; refuted: number; samples: TrickleSample[] };
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
  /**
   * The daily bills (pence a game day): fleet upkeep (the formula, or what the ledger shows was charged if
   * more) and warehouse rent per region (from the ledger), the home floor they set, and when the ledger was
   * last read (server ms; null: not yet).
   */
  bills: { upkeepPerDay: number; rent: Array<[BankingRegion, number]>; homeFloor: number; measuredAt: number | null };
  /** Auto-remit for bills (company settings, guide 3.9) as last read (only read, never changed); null: not read. */
  autoRemit: { on: boolean; reservePence: number } | null;
  /**
   * The Crown's wealth levy (guide 3.12): idle vault cash above the threshold, and what it pays a game day (pence).
   * While there is an excess, loads aren't charged for the cash they tie up. Absent in reports from older servers.
   */
  levy?: { thresholdPence: number; excessPence: number; perDayPence: number };
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
  /**
   * The Lloyd's List as a quay of ours last posted it (port view, display only): Lloyd's and player underwriters' results
   * over its window (loss ratio, return on cover), and the policies open at each quay that posted one. Absent: none read.
   */
  market?: {
    at: number;
    windowDays: number;
    lloyds: { lossRatioBps: number | null; returnOnCoverBps: number | null; written: number } | null;
    players: { lossRatioBps: number | null; returnOnCoverBps: number | null; written: number; underwriters: number };
    openHere: Array<[port: string, policies: number]>;
  };
}

/** A loan as the panel shows it (pence; times ISO). */
export interface FinanceLoanRow {
  id: string;
  region: BankingRegion;
  principalPence: number;
  owedPence: number;
  rateBps: number;
  status: string;
  maturesAt: string | null;
  /** When it is repaid in full by (2 game days before maturity). */
  repayBy: string | null;
  /** What it was taken for (ours), or null (taken elsewhere, or a loan we made). */
  purpose: string | null;
  collateral: string;
  /** The ship pledged, if any. */
  shipId: string | null;
}

/** Leverage and idle cash (guide 3.12-3.14), as of the last loan check. */
export interface FinanceReport {
  checkedAt: string | null;
  leverage: boolean;
  idleCash: boolean;
  /** Net worth as the debt cap reads it, and where from (the hourly leaderboard, or our own estimate); null: not known yet. */
  netWorthPence: number | null;
  worthSource: "leaderboard" | "estimate" | null;
  /** Owed on our loans (principal and interest), the cap (maxDebtPct of net worth), and what is kept back to repay them. */
  debtPence: number;
  capPence: number | null;
  fencePence: number;
  borrowed: FinanceLoanRow[];
  /** The soonest a loan of ours must be repaid in full by (ISO). */
  nextRepayBy: string | null;
  /** Interest paid and accrued on loans we owe, and earned on loans we made, as far as the records go. */
  interestPaidPence: number;
  interestEarnedPence: number;
  lent: FinanceLoanRow[];
  /** Our idle-cash offers on the credit board. */
  offers: Array<{ id: string; region: BankingRegion; availablePence: number; rateBps: number; expiresAt: string | null }>;
  idleExcessPence: number;
  /** A repayment due that cash can't cover yet (new spending stops meanwhile); null: none. */
  short: string | null;
  /** Calls with no answer, being reconciled from our loans and the board. */
  pending: number;
  /** What the last checks did or would do, newest first. */
  action: string;
  idle: string;
}

/** Ship deals and envelopes (guide 3.4, 3.11), as of the last checks (pence; times ISO). */
export interface DealsReport {
  shipDeals: boolean;
  envelopes: boolean;
  /** Ships for sale at our quays at the buyer's last look: against building the class (null: no quote), and its verdict. */
  listings: Array<{ id: string; port: string; cls: string; name: string; pricePence: number; guns: number; buildPence: number | null; verdict: string }>;
  listingsAt: string | null;
  /** Open commissions at our yards at the last look, with our cheapest build (null: not quoted), the margin and the verdict. */
  commissions: Array<{ id: string; yard: string; cls: string; pricePence: number; collateralPence: number; costPence: number | null; marginPence: number | null; expiresAt: string | null; verdict: string }>;
  commissionsAt: string | null;
  /** Commissions we took, until delivered or lost. */
  ours: Array<{ id: string; yard: string; cls: string; pricePence: number; collateralPence: number; status: string; expiresAt: string | null; note: string | null }>;
  /** Our envelopes still open. */
  openEnvelopes: Array<{ id: string; port: string; kind: "news" | "charters"; pricePence: number; createdAt: string; expiresAt: string | null }>;
  /** What deals earned since the records began: ships bought listed, commissions delivered (price less build), envelopes sold. */
  shipsBought: number;
  commissionsDelivered: number;
  commissionNetPence: number;
  envelopesSold: number;
  envelopeIncomePence: number;
  action: string;
  envelopeAction: string;
}

export interface MarqueReport {
  checkedAt: string;
  enabled: boolean;
  budgetPence: number;
  /** Spent on our marques and patrols (the AI's) created in the last 24 real hours: one budget for both. */
  spentPence: number;
  /** Of which patrols (absent in older reports). */
  patrolSpentPence?: number;
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
  /** The daily bills as the ledger showed them (pence a game day; `at` server ms); absent: not measured yet. */
  bills?: { rent: Array<[BankingRegion, number]>; upkeep: number; at: number };
  /** Older saves only (the autopilot once set the auto-remit reserve): ignored, never written now. */
  autoRemitSet?: { at: string; pence: number };
  /** The last critical server announcement (`at` server ms); absent: none. */
  announcement?: { at: number; message: string };
  /** The key-expiry warnings already given (KEY_WARN_MS marks) for the key expiring at `expiresAt`; absent in older saves. */
  keyWarned?: { expiresAt: number; marks: number[] };
  /**
   * Loans (as last seen, with what ours were taken for), calls with no answer still to reconcile, our idle-cash board
   * offers, and interest on loans no longer kept; absent in older saves.
   */
  finance?: {
    recs?: Array<[string, LoanRec]>;
    pending?: PendingCredit[];
    offers?: Array<[string, OurOffer]>;
    interestPaidBefore?: number;
    interestEarnedBefore?: number;
  };
  /** Commissions we took, our envelopes, posts with no answer, and what deals earned; absent in older saves. */
  deals?: {
    commissions?: Array<[string, CommissionRec]>;
    envelopes?: Array<[string, EnvelopeRec]>;
    pendingEnvelopes?: PendingEnvelope[];
    stats?: Partial<DealStats>;
  };
}

/** Whether a turnkey quote's walk takes any material from players' asks (a commission's build passes over the buyer's). */
function playerAsks(q: BuildQuote): boolean {
  return q.materials.some((m) => m.player_tons > 0);
}

/**
 * A commission we build to order (server ms). `accepting`/`delivering`: the call had no answer, reconciled from contract/list
 * (never sent blind again); `accepted`: ours to deliver before `expiresAt` (`retryAt` local ms); `delivered`/`failed`: done.
 */
interface CommissionRec {
  yard: string;
  cls: string;
  price: number;
  collateral: number;
  expiresAt: number | null;
  status: "accepting" | "accepted" | "delivering" | "delivered" | "failed";
  at: number;
  sentAt?: number;
  retryAt?: number;
  /** Our cheapest build when accepted, and whether own materials were planned. */
  cost: number;
  byom: boolean;
  name?: string;
  note?: string;
  /** The game said it is ours (the accept call's answer, our list, a notice); absent: only taken as ours after a call with no answer. */
  confirmed?: boolean;
  /** Built again after a delivery with no answer that may have landed: turnkey only, no materials bought ahead (absent: no doubt). */
  unsure?: boolean;
}

/** An envelope we sealed (server ms): `news` (port reports, sailings) or `charters` (non-public charters of goods we don't work). */
interface EnvelopeRec {
  port: string;
  kind: "news" | "charters";
  price: number;
  at: number;
  expiresAt: number | null;
  status: EnvelopeStatus;
  /** Local ms last seen in envelope/mine. */
  seen: number;
  /** `charters`: the goods sealed (its contents as envelope/mine shows them; absent in older saves until read). */
  goods?: string[];
}

/** An envelope post with no answer (server ms): found in envelope/mine, or not posted once PENDING_DEAL_MS is up; never posted again meanwhile. */
interface PendingEnvelope {
  port: string;
  kind: "news" | "charters";
  price: number;
  at: number;
}

interface DealStats {
  shipsBought: number;
  commissionsDelivered: number;
  commissionNet: number;
  envelopesSold: number;
  envelopeIncome: number;
}

/** One loan of ours as last seen (server ms), and what it was taken for (ours, borrowed by the autopilot). */
interface LoanRec {
  role: "borrower" | "lender";
  region: BankingRegion;
  principal: number;
  rateBps: number;
  termDays: number;
  status: string;
  owed: number;
  interestPaid: number;
  accrued: number;
  maturesAt: number | null;
  createdAt: number;
  kind: string;
  ship: string | null;
  purpose?: string;
  /** What ours was taken for: a hull or a load (the AI digest sees only this). */
  use?: "hull" | "load";
  source?: "board" | "goldsmiths";
  /** Local ms of the last sighting. */
  seen: number;
}

/** A credit call sent with no answer (server ms): reconciled from loan/list (a loan) or the board (an offer), never sent again. */
interface PendingCredit {
  kind: "borrow" | "post";
  at: number;
  region: BankingRegion;
  principal: number;
  ship?: string;
  purpose?: string;
  use?: "hull" | "load";
  source?: "board" | "goldsmiths";
}

/** An idle-cash offer we posted on a region's credit board (as the board last showed it; `at` local ms posted). */
interface OurOffer {
  region: BankingRegion;
  available: number;
  rateBps: number;
  expiresAt: number | null;
  at: number;
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
/** The company key's expiry is warned of once as it comes within each of these (real ms). */
const KEY_WARN_MS = [7 * 24 * 3_600_000, 24 * 3_600_000, 3_600_000];
/** While the world is paused, the clock is read this often and nothing else is done. */
const PAUSE_CHECK_MS = 30_000;
/** A critical server announcement stays on the dashboard this long (server ms), at most this many characters of it. */
const ANNOUNCEMENT_SHOW_MS = 24 * 3_600_000;
const ANNOUNCEMENT_MAX_CHARS = 500;
/** Resident Factors a company may keep (guide 3.9): no hire for a build past it. */
const MAX_FACTORS = 12;
/** A new hull's stores (tons of hold) as first guessed when planning its lane; that lane's real figure then counts. */
const FIRST_STORES_GUESS_TONS = 2;
/** A build whose outcome was unknown: watched for this long (server ms) before it counts as not built; a ship
 * created this long before the attempt can't be it. */
const PENDING_BUILD_MS = 10 * 60_000;
const PENDING_BUILD_SLACK_MS = 5 * 60_000;
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
/** The home reserve covers at least this many game days of fleet upkeep (and each region of its warehouse rent). */
const UPKEEP_DAYS_RESERVED = 1.5;
/** How often the ledger is read for what the daily bills really charge; how far back, in pages of 200. */
const BILLS_CHECK_MS = 10 * 60_000;
const BILLS_LOOKBACK_GAME_DAYS = 2;
const BILLS_LEDGER_PAGES = 5;
/** Ledger entries this close together are one billing pass. */
const BILLING_CLUSTER_MS = 60_000;
/** Ledger reasons of the daily bills (not published: the ones seen are logged once), and one-offs that name them. */
const RENT_REASON = /(?:^|[_\s-])(?:rent|lease)|warehouse/i;
const UPKEEP_REASON = /upkeep|sprawl|factor|salar/i;
const ONE_OFF_REASON = /hire|setup|refund|release|bailiff|seiz|distress|sale|remit/i;
/** A refit must improve a load's expected profit by this share to be worth the berth call. */
const REFIT_MIN_GAIN = 0.02;
/** AI marques and patrols still to issue are looked at this often (one waiting for cash is tried again then). */
const AI_NAVAL_RETRY_MS = 15_000;
/** One whose call had no answer: if not among ours this long after it was sent, it wasn't issued (never sent again). */
const AI_NAVAL_SETTLE_MS = 2 * 60_000;
/** How often letters of marque are judged (on the last rival analysis). */
const MARQUE_CHECK_MS = 5 * 60_000;
/** Marques are bought one game day at a time and judged again before another. */
const MARQUE_GAME_HOURS = 24;
/** Fewest laden rival passages a game day before a zone is considered at all. */
const MARQUE_MIN_LADEN = 3;
/** The Crown's minimum charge for a marque (100 Cr). */
const MARQUE_MIN_PENCE = 10_000;
/** Zones quoted per marque check (the most promising by our own estimate): the game prices each from its traffic. */
const MARQUE_QUOTE_ZONES = 6;
/** A zone's last quoted marque price counts this long (real ms) for the AI's naval orders and digest. */
const MARQUE_PRICE_TTL_MS = 30 * 60_000;
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
/**
 * The Crown's wealth levy (guide 3.12): idle vault cash above 500,000 Cr across all regions pays 0.1% of the excess a
 * game day (about 6% a real day at 60x). Loans out, deposits, venture stakes, escrow and goods are exempt.
 */
export const WEALTH_LEVY_THRESHOLD_PENCE = 50_000_000;
export const WEALTH_LEVY_BPS_PER_DAY = 10;
/** Borrower loans (liens, arrests) are read again after this long (real ms), or at once after a loan event. */
const LOANS_TTL_MS = 10 * 60_000;
/** Loans and idle cash are looked at this often (sooner after a loan event, never closer than the second); our loans are read
 * every pass while we owe, lend or have offers out. */
const FINANCE_CHECK_MS = 60_000;
const FINANCE_EVENT_MIN_MS = 10_000;
/** Net worth for the debt cap: the leaderboard's figure while it is this fresh (server ms; it is recomputed hourly), our own
 * estimate re-read at most this often otherwise. */
const WORTH_BOARD_FRESH_MS = 75 * 60_000;
const WORTH_TTL_MS = 5 * 60_000;
/** A credit call with no answer that loan/list or the board doesn't show this long after (server ms) wasn't made. */
const PENDING_CREDIT_MS = 10 * 60_000;
/** After a lender refused us (or nothing fitted at the source), no new loan is asked for this long (real ms). */
const BORROW_RETRY_MS = 10 * 60_000;
/** A load found short of cash at its source counts as the fleet needing cash (idle cash comes back) this long (real ms). */
const CASH_SHORT_MS = 10 * 60_000;
/** A repayment with no answer: that loan is left until our loans are read again this long after. */
const REPAY_HOLD_MS = 2 * 60_000;
/** The least worth repaying early (a loan owing less is repaid whole), and how long (server ms) after it was taken a loan is first repaid early. */
const MIN_REPAY_PENCE = 10_000;
const LOAN_EARLY_GRACE_MS = 3 * 60_000;
/** An idle-cash offer undercut by a rival is re-posted at the new rate at most this often (real ms); a refused post waits this long. */
const IDLE_REPRICE_MS = 30 * 60_000;
const IDLE_RETRY_MS = 10 * 60_000;
/** Loan records kept (closed ones older than this go, their interest kept in the totals). */
const LOAN_RECS_MAX = 300;
const LOAN_REC_KEEP_MS = 7 * 24 * 3_600_000;
/** A ship-lien loan's pledge in these states still holds the ship (not released, seized or lost). */
const SHIP_HELD: ReadonlySet<string> = new Set(["pledged", "held", "seizure_pending"]);
/** Ship deals and envelopes: checked every minute, sooner after a commission or envelope notice. */
const DEALS_CHECK_MS = 60_000;
const DEALS_EVENT_MIN_MS = 10_000;
/** A listing or commission refused, sold or found unbuildable is left alone this long. */
const DEAL_SKIP_MS = 30 * 60_000;
/** A listing's own rebuild value (as of its listing) stands in for a build price only this soon after it was listed (server ms). */
const LISTING_VALUE_FRESH_MS = 30 * 60_000;
/** A deal call with no answer: given up as not made after this (contract/list, envelope/mine), never re-sent meanwhile. */
const PENDING_DEAL_MS = 10 * 60_000;
/** A delivery with no answer still listed as ours to build after this (local ms) didn't land: it may be tried again. */
const DELIVER_HOLD_MS = 2 * 60_000;
/** A failed delivery is tried again after this, while we have presence at the yard and before its deadline. */
const DELIVER_RETRY_MS = 2 * 60_000;
/** A quay's port view read within this is what an envelope sealed there would hold. */
const QUAY_NEWS_FRESH_MS = 5 * 60_000;
/** Closed commission and envelope records kept at most this many, and this long (local ms). */
const DEAL_RECS_MAX = 200;
const DEAL_REC_KEEP_MS = 2 * 24 * 3_600_000;
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
  /** This company's name (a stall is only ours to keep when this company delivered: a sibling's counts as another's). */
  private companyName: string | null = null;
  private journal: Journal<FleetSnapshot> | null = null;
  private progressSince: string | null = null;
  /** Saved agents waiting for their ship to be taken command of again. */
  private restoredAgents = new Map<string, AgentSnapshot>();
  private lastPersist = 0;
  /** Convoys we know of (ours forming, mostly), refreshed at most every 20 s each; `memberClasses`: joined members'. */
  private readonly convoyCache = new Map<
    string,
    { from: string; dest: string; departsAt: number; status: ConvoyStatus; organizer: string; members: string[]; memberClasses: string[]; checkedAt: number }
  >();
  private convoyQueue: Promise<unknown> = Promise.resolve();
  /** One-off log lines already written (logOnceFor), so a waiting ship doesn't repeat them. */
  private readonly loggedOnce = new Set<string>();
  /** Our ships whose capture the world has counted (a capture may come as voyage_hazard and ship_captured both). */
  private readonly capturesNoted = new Set<string>();
  /** Rival ships and zone traffic from the last rival analysis (for the AI digest). */
  private rivalSummary: DigestInput["rivals"] = { companies: [], zones: [] };
  private lastEscalations: number | null = null;
  /** The fleet's calls on stalled expansion postings (by `port|good`) and when worked out (local ms; 0: stale). */
  private stakes = new Map<string, StallStake>();
  private stakesAt = 0;
  private stakesBusy = false;
  /** Whether our own deliveries under the pace line are allowed into postings let lapse, as last seen (World.ownTrickleOk). */
  private trickleOk = false;
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
  /** Resident Factors the company has (the user's too: all are billed), as last listed. */
  private factorCount = 0;
  /** The daily bills as the ledger last showed them (learnBills; saved). */
  private bills: { rent: Map<BankingRegion, number>; upkeep: number; at: number | null } = { rent: new Map(), upkeep: 0, at: null };
  private lastBillsCheck = 0;
  private billReasonsLogged = false;
  /** Auto-remit for bills as last read (re-read with the bills; never changed by the autopilot); an unreadable read said once. */
  private autoRemit: CashReport["autoRemit"] = null;
  private autoRemitUnreadSaid = false;
  private factorBlockedUntil = 0;
  private canRemit = true;
  /** The key may build ships (`infra_manage`): the AI can't switch the buyer on without it. */
  private canBuild = true;
  /** AI marques and patrols: being worked on, last looked at (local ms). */
  private navalBusy = false;
  private lastNavalTry = 0;
  /** For the AI digest: the zones as last read, our ships' exposure per zone, our marques and patrols, factor ports, the buyer's best options. */
  private zoneStatus: { at: number; zones: SeaZonePiracyResult[] } | null = null;
  private ownExposureSeen = new Map<string, number>();
  private ownNaval: { at: number; marques: LetterOfMarque[]; patrols: NavalPatrol[] } | null = null;
  /** Each zone's marque price per bps per game day (pence) as last quoted (local ms): the AI's naval orders and digest. */
  private readonly marquePrices = new Map<string, { price: number; at: number }>();
  private factorPorts: string[] = [];
  private buyerOptions: DigestInput["buyerOptions"] = [];
  private logLines: FleetLogLine[] = [];
  private purchases: PurchaseRecord[] = [];
  private topLanes: Lane[] = [];
  private buyer = "not checked yet";
  private marqueReport: MarqueReport | null = null;
  private lastMarqueCheck = 0;
  private underwriteReport: UnderwriteReport | null = null;
  private lastUnderwriteCheck = 0;
  /** Policies any of our companies holds a slice of, open or active, as last read in full (local ms). */
  private underwritten: { at: number; policies: InsurancePolicyListing[] } | null = null;
  /** Our loans as last read (local ms): owed (`loans`) and made (`lent`), active and defaulted; a loan event since (read again), and the read in flight. */
  private loansCache: { at: number; loans: Loan[]; lent: Loan[] } | null = null;
  private loansDirty = false;
  private loansReading: Promise<{ at: number; loans: Loan[]; lent: Loan[] } | null> | null = null;
  /** Every loan of ours seen (saved), credit calls with no answer, and our idle-cash board offers (by id). */
  private readonly loanRecs = new Map<string, LoanRec>();
  private pendingCredit: PendingCredit[] = [];
  private readonly ourOffers = new Map<string, OurOffer>();
  /** Interest on loan records no longer kept (paid on ours, earned on those we made). */
  private interestPaidBefore = 0;
  private interestEarnedBefore = 0;
  /** Each region's credit board as last read (local ms). */
  private readonly boardSeen = new Map<BankingRegion, { at: number; board: CreditBoard }>();
  /** Net worth for the debt cap (local ms), and the leaderboard's own figure for this company (server ms of its refresh). */
  private worth: { pence: number; at: number; source: "leaderboard" | "estimate" } | null = null;
  private boardWorth: { pence: number; refreshedAt: number } | null = null;
  /** A repayment due that cash can't cover: new spending stops until it is paid (null: none). */
  private debtShort: string | null = null;
  private lastFinanceCheck = 0;
  private financeDirty = false;
  /** When a load was last found short of cash at its source (local ms): the fleet needs cash (runIdleCash). */
  private cashShortAt = 0;
  private financeBusy = false;
  private financeAt: string | null = null;
  private financeAction = "not checked yet";
  private idleAction = "not checked yet";
  /** No new loan before this (local ms): a lender refused lately. A post refused waits too. */
  private borrowRetryAt = 0;
  private idleRetryAt = 0;
  /** Loans whose repayment had no answer: left alone until then (local ms), read again first. */
  private readonly repayHold = new Map<string, number>();
  /** Commissions we took and our envelopes (saved), envelope posts with no answer, and what deals earned. */
  private readonly commissionRecs = new Map<string, CommissionRec>();
  private readonly envelopeRecs = new Map<string, EnvelopeRec>();
  private pendingEnvelopes: PendingEnvelope[] = [];
  private dealStats: DealStats = { shipsBought: 0, commissionsDelivered: 0, commissionNet: 0, envelopesSold: 0, envelopeIncome: 0 };
  /** Listings and commissions left alone until then (local ms): refused, sold, unbuildable; envelope kinds per `port|kind` the same. */
  private readonly dealSkip = new Map<string, number>();
  /** What the buyer and the commission check last saw (the panel and the digest). */
  private listingsSeen: { at: number; rows: DealsReport["listings"] } | null = null;
  private commissionsSeen: { at: number; rows: DealsReport["commissions"] } | null = null;
  private lastDealsCheck = 0;
  private lastEnvelopeCheck = 0;
  private dealsDirty = false;
  private envelopesDirty = false;
  private dealsBusy = false;
  private envelopesBusy = false;
  private dealsAction = "not checked yet";
  private envelopeAction = "not checked yet";
  private lastRivalCheck = 0;
  private lastRivalAnalysis = 0;
  /** A public notice said rival intel changed: gather it again soon; re-analyse soon; judge policies soon. */
  private rivalsDirty = false;
  private rivalAnalysisDirty = false;
  private policiesDirty = false;
  private nextLeaderboardAt = 0;
  /** The last rival analysis (local ms it was made). */
  private rivalAnalysis: (RivalAnalysis & { at: number }) | null = null;
  /** The player's companies (ids), never traded with as rivals: the world's own set (their charters and freight are never ours to deliver or carry). */
  private get ourCompanyIds(): Set<string> {
    return this.world.ourCompanyIds;
  }
  private retired: AgentStats = { trips: 0, deliveredTons: 0, rewardPence: 0, spentPence: 0, freightPence: 0 };
  /** Loads planned again at their source (saved). */
  private resized: ResizeStats = { checks: 0, grown: 0, shrunk: 0, switched: 0, tonsAdded: 0, tonsCut: 0, at: null };
  private shipSpendPence = 0;
  private readonly missingScans = new Map<string, number>();

  private stopRequested = false;
  private wake: (() => void) | null = null;
  private loop: Promise<void> | null = null;
  /** When the company key expires (server ms; null: never, or not read yet), and the KEY_WARN_MS marks already warned of. */
  private keyExpiresAt: number | null = null;
  private readonly keyWarned = new Set<number>();
  /** The operators paused the world (the clock, or a `503 world_paused`): ships wait, housekeeping only reads the clock. */
  paused = false;
  private lastPauseCheck = 0;
  /** The operators' last critical announcement (server ms; saved): the dashboard's banner for a day. */
  private announcement: { at: number; message: string } | null = null;
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
   * `leaseBefore` the warehouse lease to go back to once it is adopted. `shipId`: a listed ship being
   * bought (ship market), found by her id rather than a new ship's name.
   */
  pendingBuild: { name: string; yard: string; cls: string; price: number; cost?: number; leaseBefore?: number | null; payback: number; lane: string; at?: number; shipId?: string } | null = null;
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
      limits: () => self.limits(),
      // Held by an AI order counts as idle: the tripwire sees a fleet its orders keep from work. An arrested ship
      // (a defaulted loan) can't work whatever the advice: left out of both counts.
      idleShare: () => {
        const free = [...self.agents.values()].filter((a) => !a.arrested);
        return free.length ? free.filter((a) => a.idle || a.held).length / free.length : 0;
      },
      log: (msg) => self.log("fleet", msg),
      persist: (now) => self.persist(now),
      directivesChanged: () => {
        // New settings, bans, biases or orders: world flags follow, vetoed lanes are dropped, ships idling or
        // held look again, a build or naval order is looked at within a pass, and stall calls may flip.
        self.syncWorldFlags();
        self.applyShipDirectives();
        self.lastBuyCheck = 0;
        self.lastNavalTry = 0;
        for (const a of self.agents.values()) if (a.idle || a.held) a.nudge();
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
      underwriting: this.underwriteReport ? { ...this.underwriteReport, market: this.lloydsMarket() } : null,
      finance: this.financeReport(),
      deals: this.dealsReport(),
      ai: this.advisor.report(),
      expansion: this.expansionReport(),
      capitalRate: this.capitalRate(),
      cash: this.cashReport(),
      storms: this.world.stormSummary(),
      worldEvents: this.world.eventsReport(),
      season: {
        endsAt: this.world.seasonEndsAt !== null ? new Date(this.world.seasonEndsAt).toISOString() : null,
        leftMs: this.world.seasonEndsAt !== null ? Math.max(0, Math.round(this.world.seasonLeftMs())) : null,
        mode: this.world.seasonMode(),
      },
      keyExpiresAt: this.keyExpiresAt !== null ? new Date(this.keyExpiresAt).toISOString() : null,
      paused: this.paused,
      announcement:
        this.announcement && this.world.now() - this.announcement.at < ANNOUNCEMENT_SHOW_MS
          ? { at: new Date(this.announcement.at).toISOString(), message: this.announcement.message }
          : null,
      log: [...this.logLines],
    };
  }

  /** The quays' latest Lloyd's List for the underwriting report (display only: the underwriter judges each policy's own listing). */
  private lloydsMarket(): UnderwriteReport["market"] {
    const f = this.world.lloydsFigures();
    if (!f) return undefined;
    const fig = (x: UnderwritingFigures) => ({ lossRatioBps: x.loss_ratio_bps ?? null, returnOnCoverBps: x.return_on_cover_bps ?? null, written: x.policies_written });
    return {
      at: f.at,
      windowDays: f.windowDays,
      lloyds: f.lloyds ? fig(f.lloyds) : null,
      players: { ...fig(f.players), underwriters: f.players.underwriters },
      openHere: f.openHere,
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
      trickle: (() => {
        const t = w.trickleRecord();
        return { allowed: w.ownTrickleOk, confirmed: t.confirmed, needed: OWN_TRICKLE_CONFIRM, refuted: t.refuted, samples: t.samples.slice(-5) };
      })(),
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

  /**
   * The settings in force: the user's, with the AI's overrides while they last, under the hard floors wherever
   * read (directives.ts enforceFloors: its own settings the user's, ceilings the user's, the reserve only raised,
   * no ship buying without the key's scope).
   */
  get settings(): FleetSettings {
    const o = this.advisor?.overrides();
    return o || !this.canBuild ? enforceFloors(this.ownSettings, { ...this.ownSettings, ...o }, { canBuild: this.canBuild }) : this.ownSettings;
  }

  /** The user's settings changed (dashboard, CLI): applied live. */
  set settings(v: FleetSettings) {
    const prev = this.ownSettings;
    this.ownSettings = v;
    if (prev) this.advisor.settingsChanged(prev, v);
    this.syncWorldFlags();
    this.stakesAt = 0;
  }

  /** The world's own copies of settings in force (the user's, or the AI's overrides), after either changes. */
  private syncWorldFlags(): void {
    const s = this.settings;
    this.world.rivalIntel = s.rivalIntel;
    this.world.planOnEvents = s.actOnEvents;
    // Off: expected crisis charters go now, not at the next refresh.
    if (!this.world.planOnEvents && this.world.charters.some((c) => c.provisional)) this.world.charters = this.world.charters.filter((c) => !c.provisional);
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

  /** What an AI answer is validated against (directives.ts validateAnswer). */
  private limits(): ValidateCtx {
    const w = this.world;
    const zoneBps = new Map((this.zoneStatus?.zones ?? []).map((z) => [z.sea_zone_id, { marque: z.marque_piracy_bps, patrol: z.patrol_suppression_bps }]));
    return {
      user: this.ownSettings,
      canBuild: this.canBuild,
      catalog: w.catalog,
      unlockedPhase: w.unlockedPhase,
      isOpen: (p) => w.isOpen(p),
      currentId: (id) => w.currentId(id),
      renews: (c) => w.renews(c),
      hazardZone: (n) => w.hazardZone(n),
      fleet: [...this.agents.values()].map((a) => ({ id: a.shipId, hull: w.shipClass(a.shipClass)?.hull_category ?? "coastal", gone: a.gone })),
      // Not read yet: the whole budget counts as spent, so no naval order passes it.
      navalSpent24h: this.navalSpent() ?? this.ownSettings.marqueBudgetPence,
      zoneBps,
      marquePrice: this.marquePriceMap(),
      gameMinuteMs: w.gameMinuteMs,
    };
  }

  /** Zones' marque prices per bps per game day quoted lately (pence). */
  private marquePriceMap(): Map<string, number> {
    const now = Date.now();
    return new Map([...this.marquePrices].filter(([, x]) => now - x.at < MARQUE_PRICE_TTL_MS).map(([z, x]) => [z, x.price]));
  }

  private notePrice(q: MarqueQuote): void {
    this.marquePrices.set(q.sea_zone_id, { price: q.price_per_bps_day_pence, at: Date.now() });
  }

  /**
   * Our marques and patrols created in the last 24 real hours (pence), as last read, and the AI's sent then with
   * no answer and not found among them yet (they may have been paid for); null before a read.
   */
  private navalSpent(): number | null {
    const n = this.ownNaval;
    if (!n) return null;
    const now = this.world.now();
    const listed = [...n.marques, ...n.patrols].filter((x) => now - Date.parse(x.created_at) < 24 * 3_600_000).reduce((s, x) => s + x.cost_pence, 0);
    return listed + this.advisor.unknownNavalPence(now - 24 * 3_600_000);
  }

  /** What the AI strategist reads (digest.ts): the fleet, cash, lanes, charters, the tier, zones, yards, rivals. */
  private digestInput(): Omit<DigestInput, "events" | "decisions" | "inForce"> {
    const w = this.world;
    const now = w.now();
    let committed = 0;
    for (const a of this.agents.values()) committed += this.committedBy(a);
    const ships: DigestShip[] = [...this.agents.values()]
      .filter((a) => !a.gone && a.last)
      .map((a) => {
        const r = a.last!;
        const s = r.ship;
        const cls = w.shipClass(a.shipClass);
        const eta = Date.parse(r.voyage?.estimated_arrival_at ?? s.leg_arrives_at ?? "");
        const state =
          s.status === "sailing" ? "sailing"
          : a.arrested ? "arrested"
          : a.idle ? "idle"
          : a.held ? "held"
          : a.waitingForCash ? "waiting_cash"
          : a.activity.startsWith("holding") ? "holding"
          : "working";
        return {
          id: a.shipId,
          cls: a.shipClass,
          hull: cls?.hull_category ?? "coastal",
          status: s.status,
          port: s.current_port_id ?? null,
          dest: s.status === "sailing" ? (r.route_legs.at(-1)?.to_node ?? null) : null,
          etaMs: s.status === "sailing" && Number.isFinite(eta) ? Math.max(0, eta - now) : null,
          state,
          cargoTons: r.cargo_used_tons,
          hold: r.effective_hold_capacity_tons,
          guns: s.cannons_count,
          maxGuns: cls?.max_cannons ?? 0,
          stores: r.stores.provisions_tons,
          loadCash: this.loadCash(a),
          lane: a.lane,
          trips: a.state.trips,
        };
      });
    const x = this.expansionReport();
    const value = (c: (typeof w.charters)[number]) => c.payPerTon * c.remaining;
    // Never our own player's charters (their deliveries are refused).
    const charters = w.charters.filter((c) => c.remaining > 0 && w.isOpen(c.port) && w.deliverable(c)).sort((a, b) => value(b) - value(a));
    // "Contested": rivals due at the charter's port before it lapses (or within half a game day).
    const charterRivals = new Map(charters.slice(0, 20).map((c) => [c.id, w.rivalLanding(c.port, c.good, c.expiresAt ?? now + 12 * 60 * w.gameMinuteMs)]));
    const home = this.homeRegion;
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
            trickle: { allowed: x.trickle.allowed, confirmed: x.trickle.confirmed, needed: x.trickle.needed, refuted: x.trickle.refuted },
            bonus: w.bonusStanding(),
          }
        : null,
      ships,
      maxShips: this.ownSettings.maxShips,
      buyer: this.buyer,
      cash: {
        vaults: [...w.vaults],
        homeRegion: this.homeRegion,
        spare: this.spareCash(),
        committed,
        capitalRate: this.capitalRate(),
        due: this.cashReport().duePence,
        levyExcess: this.idleExcess(),
        levyPerDay: this.levyPerDay(),
      },
      user: this.ownSettings,
      canBuild: this.canBuild,
      topLanes: this.topLanes,
      charters,
      charterRivals,
      zones: this.digestZones(now),
      yards: this.digestYards(),
      buyerOptions: this.buyerOptions,
      paybackLimit: this.settings.maxPaybackHours,
      budgets: {
        navalSpent24h: this.navalSpent(),
        navalBudget: this.ownSettings.marqueBudgetPence,
        underwriteLocked: this.underwriteReport?.lockedPence ?? null,
        underwriteBudget: this.ownSettings.underwriteBudgetPence,
        fleet: [...this.agents.values()].filter((a) => !a.gone).length,
        homeFloor: home ? this.floorIn(home) : this.homeFloor(),
        reserve: this.settings.reservePence,
        billsFloor: Math.ceil(UPKEEP_DAYS_RESERVED * this.upkeepPerDay()),
      },
      rivals: this.rivalSummary,
      bidHaircutPerDay: w.bidHaircutPerDay,
      storms: w.stormSummary(),
      // Holders aren't named to the AI: only whether it is this company's.
      monopolies: w.monopolies
        .filter((m) => m.expiresAt > now)
        .map((m) => ({ region: m.region, good: m.good, ours: !!w.companyId && m.holderId === w.companyId, leftMs: m.expiresAt - now })),
      finance: this.digestFinance(now),
      deals: this.digestDeals(now),
    };
  }

  /** Our loans for the digest: no lender, borrower or ship named, only what a loan was for (a hull or a load). */
  private digestFinance(now: number): DigestInput["finance"] {
    const f = this.financeReport();
    const ours = (id: string) => this.isOurCompany(id);
    return {
      owed: f.debtPence,
      cap: f.capPence,
      worth: f.netWorthPence,
      loans: f.borrowed.map((b) => ({
        id: b.id,
        owed: b.owedPence,
        rateBps: b.rateBps,
        repayInMs: b.repayBy ? Math.max(0, Date.parse(b.repayBy) - now) : null,
        use: this.loanRecs.get(b.id)?.use ?? null,
        defaulted: b.status === "defaulted",
      })),
      lentOut: f.lent.reduce((n, l) => n + Math.max(0, l.owedPence), 0),
      offered: f.offers.reduce((n, o) => n + o.availablePence, 0),
      short: f.short !== null,
      board: [...this.boardSeen]
        .filter(([, x]) => Date.now() - x.at < 30 * 60_000)
        .map(([region, x]) => {
          const rival = x.board.offers.filter((o) => o.status === "open" && !ours(o.lender_company_id)).map((o) => o.daily_rate_bps);
          return { region, bestOfferBps: rival.length ? Math.min(...rival) : null, offers: rival.length, requests: x.board.requests.filter((q) => q.status === "open" && !ours(q.borrower_company_id)).length };
        }),
    };
  }

  /**
   * Sea zones for the digest (at most 8): ours in force first, then by what is at stake there (our exposure and
   * the rival cargo crossing), then by piracy. The split comes from the last zones read (marques, AI naval orders).
   */
  private digestZones(now: number): DigestZone[] {
    const w = this.world;
    const read = new Map((this.zoneStatus?.zones ?? []).map((z) => [z.sea_zone_id, z]));
    const fresh = this.rivalAnalysis && Date.now() - this.rivalAnalysis.at < RIVAL_ANALYSIS_MAX_AGE_MS ? this.rivalAnalysis : null;
    const traffic = new Map((fresh?.zones ?? []).map((t) => [t.zone, t]));
    const ours = (zone: string) => [
      ...(this.ownNaval?.marques ?? []).filter((m) => m.sea_zone_id === zone && Date.parse(m.expires_at) > now && m.cost_pence > 0).map((m) => ({ kind: "marque" as const, bps: m.added_piracy_bps, leftMs: Date.parse(m.expires_at) - now })),
      ...(this.ownNaval?.patrols ?? []).filter((p) => p.sea_zone_id === zone && Date.parse(p.expires_at) > now).map((p) => ({ kind: "patrol" as const, bps: p.suppressed_piracy_bps, leftMs: Date.parse(p.expires_at) - now })),
    ];
    const out: DigestZone[] = [];
    const prices = this.marquePriceMap();
    for (const z of w.catalog.sea_zones) {
      if (z.phase > w.unlockedPhase) continue;
      const r = read.get(z.id);
      const t = traffic.get(z.id);
      const net = r?.net_piracy_bps ?? w.piracy.get(z.id) ?? 0;
      const own = this.ownExposureSeen.get(z.id) ?? 0;
      const mine = ours(z.id);
      if (net <= 0 && !t && own <= 0 && mine.length === 0) continue;
      out.push({
        zone: z.id,
        net,
        split: r ? { base: r.base_piracy_bps, marque: r.marque_piracy_bps, patrol: r.patrol_suppression_bps } : null,
        rivals: t ? { passages: t.passages, laden: t.laden, cargo: t.cargo } : null,
        ownExposure: Math.round(own),
        ours: mine,
        marquePrice: prices.get(z.id) ?? null,
      });
    }
    const stake = (z: DigestZone) => z.ownExposure + (z.rivals?.cargo ?? 0);
    return out.sort((a, b) => b.ours.length - a.ours.length || stake(b) - stake(a) || b.net - a.net).slice(0, 8);
  }

  /** Shipyards for the digest (at most 6): where we have presence first, then those quoted; each with its last quotes. */
  private digestYards(): DigestYard[] {
    const w = this.world;
    const out: DigestYard[] = [];
    for (const p of w.catalog.ports) {
      if (!p.has_shipyard || !w.isOpen(p.id)) continue;
      const ships = [...this.agents.values()].filter((a) => !a.gone && a.last && a.last.ship.status !== "sailing" && a.last.ship.current_port_id === p.id).map((a) => a.shipId);
      const factor = this.factorPorts.includes(p.id);
      const quotes = w.catalog.ship_classes
        .filter((c) => c.phase <= w.unlockedPhase && this.hullQuotes.has(`${p.id}|${c.id}`))
        .map((c): [string, number] => [c.id, this.hullQuotes.get(`${p.id}|${c.id}`)!])
        .sort((a, b) => a[1] - b[1])
        .slice(0, 4);
      if (ships.length || factor || quotes.length) out.push({ port: p.id, ships, factor, quotes });
    }
    return out.sort((a, b) => Number(b.ships.length > 0 || b.factor) - Number(a.ships.length > 0 || a.factor) || b.quotes.length - a.quotes.length).slice(0, 6);
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
      bills: this.bills.at !== null ? { rent: [...this.bills.rent], upkeep: this.bills.upkeep, at: this.bills.at } : undefined,
      announcement: this.announcement ?? undefined,
      keyWarned: this.keyExpiresAt !== null && this.keyWarned.size ? { expiresAt: this.keyExpiresAt, marks: [...this.keyWarned] } : undefined,
      finance:
        this.loanRecs.size || this.pendingCredit.length || this.ourOffers.size || this.interestPaidBefore || this.interestEarnedBefore
          ? {
              recs: [...this.loanRecs],
              pending: [...this.pendingCredit],
              offers: [...this.ourOffers],
              interestPaidBefore: this.interestPaidBefore,
              interestEarnedBefore: this.interestEarnedBefore,
            }
          : undefined,
      deals:
        this.commissionRecs.size || this.envelopeRecs.size || this.pendingEnvelopes.length || Object.values(this.dealStats).some((n) => n !== 0)
          ? { commissions: [...this.commissionRecs], envelopes: [...this.envelopeRecs], pendingEnvelopes: [...this.pendingEnvelopes], stats: { ...this.dealStats } }
          : undefined,
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
    if (s.bills) {
      this.bills = {
        rent: new Map((s.bills.rent ?? []).filter(([, p]) => Number.isFinite(p) && p > 0)),
        upkeep: Number.isFinite(s.bills.upkeep) ? s.bills.upkeep : 0,
        at: s.bills.at ?? null,
      };
    }
    // An older save's autoRemitSet is ignored: the company settings are never changed now (checkAutoRemit).
    const an = s.announcement;
    if (an && Number.isFinite(an.at) && typeof an.message === "string") this.announcement = { at: an.at, message: an.message.slice(0, ANNOUNCEMENT_MAX_CHARS) };
    // Warnings already given for this same key (whoami read it before the restore) aren't given again after a restart.
    const kw = s.keyWarned;
    if (kw && this.keyExpiresAt !== null && kw.expiresAt === this.keyExpiresAt && Array.isArray(kw.marks)) {
      for (const m of kw.marks) if (KEY_WARN_MS.includes(m)) this.keyWarned.add(m);
    }
    // Loans as last seen, calls with no answer (still never sent again), our board offers: loan/list and the board correct them.
    const f = s.finance;
    if (f) {
      for (const [id, r] of f.recs ?? []) if (typeof id === "string" && r && (r.role === "borrower" || r.role === "lender")) this.loanRecs.set(id, r);
      this.pendingCredit = (f.pending ?? []).filter((p) => p && (p.kind === "borrow" || p.kind === "post") && Number.isFinite(p.at) && Number.isFinite(p.principal));
      for (const [id, o] of f.offers ?? []) if (typeof id === "string" && o && typeof o.region === "string") this.ourOffers.set(id, o);
      this.interestPaidBefore = Number.isFinite(f.interestPaidBefore) ? f.interestPaidBefore! : 0;
      this.interestEarnedBefore = Number.isFinite(f.interestEarnedBefore) ? f.interestEarnedBefore! : 0;
    }
    // Commissions we took (one with no answer is still reconciled, never sent again), our envelopes, what deals earned.
    const dl = s.deals;
    if (dl) {
      for (const [id, r] of dl.commissions ?? []) if (typeof id === "string" && r && typeof r.yard === "string" && Number.isFinite(r.price)) this.commissionRecs.set(id, r);
      for (const [id, r] of dl.envelopes ?? []) if (typeof id === "string" && r && typeof r.port === "string" && Number.isFinite(r.price)) this.envelopeRecs.set(id, r);
      this.pendingEnvelopes = (dl.pendingEnvelopes ?? []).filter((p) => p && typeof p.port === "string" && Number.isFinite(p.at));
      for (const k of Object.keys(this.dealStats) as (keyof DealStats)[]) {
        const v = dl.stats?.[k];
        if (typeof v === "number" && Number.isFinite(v)) this.dealStats[k] = v;
      }
    }
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

  /** The key's expiry as whoami gives it; a new key starts its warnings afresh. */
  private noteKey(expiresAt: string | null | undefined): void {
    const at = expiresAt ? Date.parse(expiresAt) : NaN;
    this.keyExpiresAt = Number.isFinite(at) ? at : null;
    this.keyWarned.clear();
  }

  /** Once at each KEY_WARN_MS mark (a key found already inside a mark says only the tightest): it would stop the loop. */
  private warnKeyExpiry(): void {
    if (this.keyExpiresAt === null) return;
    const left = this.keyExpiresAt - this.world.now();
    const mark = KEY_WARN_MS.filter((m) => left <= m).at(-1);
    if (mark === undefined || this.keyWarned.has(mark)) return;
    for (const m of KEY_WARN_MS) if (m >= mark) this.keyWarned.add(m);
    const span = left <= 0 ? "now" : left >= 2 * 86_400_000 ? `in ${Math.round(left / 86_400_000)} days` : left >= 2 * 3_600_000 ? `in ${Math.round(left / 3_600_000)} h` : `in ${Math.max(1, Math.round(left / 60_000))} min`;
    this.log(
      "fleet",
      `WARNING: the company key expires ${span} (${new Date(this.keyExpiresAt).toISOString()}); the autopilot stops then. ` +
        "Dashboard: it is renewed while you are signed in (sign in again and select the company if this repeats). " +
        "CLI: mint a new KIBB_API_KEY with ttl_seconds (or create-key with handle and passphrase, which never expires) and restart.",
    );
  }

  /**
   * A renewed key for this company (the dashboard minted it before the old one ran out): every call uses it from
   * now on, without a restart. Checked first: one that isn't bound to this company is refused (throws).
   */
  async useApiKey(key: string): Promise<void> {
    const who = await new KibbClient({ baseUrl: this.client.baseUrl, apiKey: key }).whoami();
    if (!who.company_id || (this.world.companyId && who.company_id !== this.world.companyId)) throw new Error("the new key isn't bound to this company");
    this.client.setApiKey(key);
    this.noteKey(who.expires_at);
    this.log("fleet", `now on a renewed company key${who.expires_at ? ` (expires ${who.expires_at})` : " (no expiry)"}`);
  }

  /** A call was refused with `503 world_paused`: wait on the clock from now on (housekeeping reads it every 30 s). */
  notePaused(): void {
    if (this.paused) return;
    this.world.paused = true;
    this.syncPause();
  }

  /** Follows the world's pause flag, logged once each way. On resume the world is read again at once and every ship looks again. */
  private syncPause(): void {
    const p = this.world.paused;
    if (p === this.paused) return;
    this.paused = p;
    if (p) {
      this.lastPauseCheck = Date.now();
      this.log("fleet", "the operators paused the world: game time stands still and only reads are served; ships wait and nothing is bought, sold or sailed until it resumes");
      return;
    }
    this.log("fleet", "the world resumed: reading it again and waking every ship");
    this.lastWorld = 0;
    for (const a of this.agents.values()) a.nudge();
    this.wake?.();
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
    return e instanceof InitFatal || isFatalApiError(e);
  }

  private async run(): Promise<void> {
    // Transient failures (network, 5xx, world paused) retry with backoff; key problems are fatal.
    for (let attempt = 0; !this.stopRequested; attempt++) {
      try {
        await this.init();
        break;
      } catch (e) {
        if (this.isFatal(e)) return this.fatal(fatalText(e));
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
        if (this.isFatal(e)) return this.fatal(fatalText(e));
        // Paused: said once (syncPause), not as a failure every pass.
        if (isApiError(e, "world_paused")) this.notePaused();
        else this.log("fleet", `housekeeping failed: ${(e as Error).message}`);
      }
      await this.sleep(LOOP_MS);
    }
  }

  private async init(): Promise<void> {
    const who = await this.client.whoami();
    if (!who.company_id) throw new InitFatal("the API key is player-level; a company-bound key is needed");
    this.noteKey(who.expires_at);
    const missing = ["read", "fleet_navigate", "fleet_cargo", "market_spot", "market_derivatives"].filter(
      (s) => !who.scopes.includes(s as never),
    );
    if (missing.length) throw new InitFatal(`key is missing scopes: ${missing.join(", ")}`);
    this.canBuild = who.scopes.includes("infra_manage");
    // The user's own setting (the settings getter already forces autoBuy off without the scope, and leaves theirs as it is).
    if (this.ownSettings.autoBuy && !this.canBuild) this.log("fleet", "key lacks infra_manage: automatic ship buying is off");
    this.canRemit = who.scopes.includes("treasury_remit");
    if (!this.canRemit) this.log("fleet", "key lacks treasury_remit: cash stays in the region it lands in");

    let leaseNote: string | undefined;
    if (this.leaseDir && !this.lease) {
      const got = await acquireLease(
        this.leaseDir,
        who.company_id,
        () => {
          // The new holder owns the saved progress now (the database copy is shared): ours isn't written over it.
          this.journal = null;
          this.fatal("another process took over this company's autopilot lease");
        },
        (msg) => this.log("fleet", msg),
      );
      // Held: retried with backoff by run(), so a crashed holder's lease is taken once it goes stale.
      if ("heldBy" in got) throw new Error(`this company's autopilot is already running (${got.heldBy})`);
      this.lease = got.lease;
      leaseNote = got.note;
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
    // After the restore (which brings back the saved log): the database lease couldn't be had at start.
    if (leaseNote) this.log("fleet", leaseNote);
    this.progressSince ??= new Date().toISOString();
    await this.world.init();
    const profile = await this.client.companyProfile();
    this.homeRegion = this.world.region(profile.company.home_port_id);
    this.homePort = profile.company.home_port_id;
    this.companyName = profile.company.name;
    this.world.companyId = profile.company.id;
    this.trickleOk = this.world.ownTrickleOk;
    // Every company of this player: their ships aren't rivals and their policies aren't ours to write.
    this.ourCompanyIds.add(profile.company.id);
    this.world.rivals.ours.add(profile.company.name);
    this.world.rivals.ourIds.add(profile.company.id);
    this.world.rivals.self = profile.company.name;
    // Every factor is billed daily, the user's own included (upkeepPerDay).
    const factors = await this.client.factors().catch((e) => {
      if (this.isFatal(e)) throw e;
      return null;
    });
    if (factors) this.factorCount = factors.length;
    const player = await this.client.playerProfile().catch(() => null);
    for (const c of player?.companies ?? []) {
      this.ourCompanyIds.add(c.id);
      this.world.rivals.ours.add(c.name);
      this.world.rivals.ourIds.add(c.id);
    }
    // The first listing came before our ids were known: our own player's charters leave it now.
    this.world.dropOwnCharters();
    this.log(
      "fleet",
      `started for ${profile.company.name}: phase ${this.world.unlockedPhase} open, server clock ${this.world.skewMs >= 0 ? "+" : ""}${Math.round(this.world.skewMs / 1000)}s vs this machine, ` +
        `${this.world.charters.length} open charters, auto-buy ${this.settings.autoBuy ? "on" : "off"}` +
        `${saved ? `; resumed progress saved for ${this.restoredAgents.size} ship${this.restoredAgents.size === 1 ? "" : "s"}` : ""}`,
    );
    // Read again with the bills; only a fatal error comes out of it.
    await this.checkAutoRemit();
    // A factor hired for a build before the restart is dismissed now, not left drawing salary.
    if (this.tempFactors.size > 0) await this.dismissTempFactors();
    this.lastWorld = Date.now();
    // Started while paused: ships wait from their first tick.
    this.syncPause();
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
    this.warnKeyExpiry();
    // Paused by the operators (guide 4.2: only reads are served, nothing sails or bills): the clock alone is read
    // every PAUSE_CHECK_MS, and nothing is written (buyer, marques, underwriting, remits) until it resumes.
    if (this.paused) {
      if (now - this.lastPauseCheck < PAUSE_CHECK_MS) return;
      this.lastPauseCheck = now;
      await this.world.readClock();
      this.syncPause();
      if (this.paused) return;
    }
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
      this.syncPause();
      if (this.paused) return;
      // New charters: ships idling for want of a lane look again now, not in minutes.
      if (dirty) for (const a of this.agents.values()) if (a.idle) a.nudge();
      // A re-post just showed whether our own small deliveries cancel the escalation: the calls change, and
      // holders may deliver under the line now (or must stop).
      if (this.world.ownTrickleOk !== this.trickleOk) {
        this.trickleOk = this.world.ownTrickleOk;
        this.stakesAt = 0;
        for (const a of this.agents.values()) if (a.activity.startsWith("holding")) a.nudge();
      }
      await this.refreshTopLanes();
      // Stalls start, break and lapse with the listing: the fleet's calls on them follow.
      this.reviewStalls();
      // A stalled posting re-posted richer: worth the AI's look.
      const esc = this.world.escalationsSeen;
      if (this.lastEscalations !== null && esc > this.lastEscalations) this.advisor.trigger("a stalled expansion charter re-posted richer");
      this.lastEscalations = esc;
    }
    this.advisor.tick();
    // The AI's marques and patrols don't wait for the marque check (paused: housekeeping never gets here).
    if (!this.navalBusy && now - this.lastNavalTry > AI_NAVAL_RETRY_MS && this.advisor.pendingNaval().length) {
      this.lastNavalTry = now;
      await this.runAiNaval().catch((e) => {
        if (this.isFatal(e) || isApiError(e, "world_paused")) throw e;
        this.log("fleet", `AI marques and patrols: ${(e as Error).message}`);
      });
    }
    if (now - this.lastScan > SHIP_SCAN_MS) await this.scanShips();
    if (now - this.lastPersist > PERSIST_MS) this.persist();
    // Before the buyer: the floors it leaves alone count the bills as charged.
    if (now - this.lastBillsCheck > BILLS_CHECK_MS) {
      this.lastBillsCheck = now;
      await this.learnBills().catch((e) => {
        if (this.isFatal(e)) throw e;
        this.log("fleet", `reading the daily bills from the ledger failed: ${(e as Error).message}`);
      });
      await this.keepHomeFloor();
    }
    // Before the buyer: what we owe and net worth (the debt cap) as fresh as they come, and loans due repaid first.
    if (now - this.lastFinanceCheck > FINANCE_CHECK_MS || (this.financeDirty && now - this.lastFinanceCheck > FINANCE_EVENT_MIN_MS)) {
      this.lastFinanceCheck = now;
      await this.runFinance().catch((e) => {
        if (this.isFatal(e) || isApiError(e, "world_paused")) throw e;
        this.log("fleet", `loan check failed: ${(e as Error).message}`);
      });
    }
    if (now - this.lastBuyCheck > BUY_CHECK_MS) await this.runBuyer(null);
    // Commissions after the loan check (they keep clear of what our loans will take) and envelopes; soon after their notices.
    if (now - this.lastDealsCheck > DEALS_CHECK_MS || (this.dealsDirty && now - this.lastDealsCheck > DEALS_EVENT_MIN_MS)) {
      this.lastDealsCheck = now;
      this.dealsDirty = false;
      await this.runCommissions().catch((e) => {
        if (this.isFatal(e) || isApiError(e, "world_paused")) throw e;
        this.log("fleet", `commission check failed: ${(e as Error).message}`);
      });
    }
    if (now - this.lastEnvelopeCheck > DEALS_CHECK_MS || (this.envelopesDirty && now - this.lastEnvelopeCheck > DEALS_EVENT_MIN_MS)) {
      this.lastEnvelopeCheck = now;
      this.envelopesDirty = false;
      await this.runEnvelopes().catch((e) => {
        if (this.isFatal(e) || isApiError(e, "world_paused")) throw e;
        this.log("fleet", `envelope check failed: ${(e as Error).message}`);
      });
    }
    // An AI override may have lapsed in between.
    this.syncWorldFlags();
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
      // Older saves carry no stamp: the watch starts now.
      pending.at ??= this.world.now();
      const at = pending.at;
      // Only a ship created about when the build was tried (a later ship of the same name and class isn't it).
      const madeThen = (x: ShipResult) => {
        const made = Date.parse(x.ship.created_at ?? "");
        return !Number.isFinite(made) || made >= at - PENDING_BUILD_SLACK_MS;
      };
      // A listed ship being bought is found by her own id (she was built long ago).
      const found = pending.shipId
        ? ships.find((x) => x.ship.id === pending.shipId)
        : ships.find((x) => x.ship.name === pending.name && x.ship.ship_class === pending.cls && !this.agents.has(x.ship.id) && madeThen(x));
      if (!found && this.world.now() - at > PENDING_BUILD_MS) {
        // Not in the fleet long after: it wasn't built. The lease grown for its materials goes back (what is stored stays).
        this.pendingBuild = null;
        if (pending.leaseBefore !== undefined && pending.leaseBefore !== null) void this.shrinkLease(pending.yard, pending.leaseBefore);
        this.log(
          "fleet",
          `the ${pending.cls} "${pending.name}" wasn't ${pending.shipId ? "bought" : "built"} (not in the fleet ${Math.round(PENDING_BUILD_MS / 60_000)} min after the attempt): the buyer may ${pending.shipId ? "buy or build" : "build"} again`,
        );
        this.persist(true);
      }
      if (found) {
        this.pendingBuild = null;
        if (pending.shipId) this.dealStats.shipsBought++;
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
          ...(pending.shipId ? { bought: true } : {}),
        });
        this.log("fleet", `the ${pending.cls} "${pending.name}" was ${pending.shipId ? "bought" : "built"} after all`);
        const order = this.advisor.buildOrder();
        if (order?.cls === pending.cls && order.yard === pending.yard) this.noteBuild("done", undefined, undefined, found.ship.id);
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

  /** Hull, speed and cargo room for a class not yet built: 2 t of hold a gun, and whole tons for `stores`. */
  private specForClass(shipClass: string, guns: number, stores: number): ShipSpec {
    const cls = this.world.shipClass(shipClass);
    return {
      hullValue: this.hullValue(shipClass) + guns * GUN_PRICE_PENCE,
      shipClass,
      hull: cls?.hull_category ?? "coastal",
      knots: (cls?.base_speed_centiknots ?? 800) / 100,
      cap: Math.max(0, (cls?.hold_capacity_tons ?? 40) - 2 * guns - Math.ceil(stores)),
      guns,
    };
  }

  /**
   * Stores (tons) a new hull of `cls` carries on its first lane, as a ship stocks them at the source (ShipAgent.storesTarget:
   * there and back at the safe figures, or the hits the laden passage could plausibly take if more, plus STORES_BUFFER_DAYS
   * of eating in port). They take hold room (guide 3.3). Null: the passage can't be routed.
   */
  private async firstStores(cls: CatalogShipClass, guns: number, lane: Lane): Promise<number | null> {
    const w = this.world;
    const [out, back] = await Promise.all([
      w.route(lane.source, lane.dest, cls.id).catch(() => null),
      w.route(lane.dest, lane.source, cls.id).catch(() => null),
    ]);
    if (!out) return null;
    const safe = (from: string, to: string, p: RoutePlan) => Math.max(p.safe_provisions_tons, w.safeFloor(from, to, cls.id));
    const cargo = lane.parts.reduce((n, p) => n + p.tons * w.basePrice(p.good), 0);
    const hits = w.storesFor(out, cls.hull_category, guns, (cls.base_speed_centiknots / 100) * 0.8, cargo, w.now());
    const legs = safe(lane.source, lane.dest, out) + (back ? safe(lane.dest, lane.source, back) : 0);
    const need = Math.max(legs, Number.isFinite(hits) ? hits : 0) + STORES_BUFFER_DAYS * out.port_provisions_tons_per_day;
    return Number.isFinite(need) ? need : null;
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
      // Everywhere (the buyer and the top lanes too, which drop only the bias): restrictions, never a reason to buy.
      bans: this.advisor.bans() ?? undefined,
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
    // Cash above the wealth levy's threshold costs the levy while it sits idle: spending it is free (guide 3.12).
    if (this.idleExcess() > 0) return 0;
    const others = [...this.agents.values()].filter((a) => a !== except);
    const lanes = others.map((a) => a.lane).filter((l): l is Lane => !!l && (l.capital ?? 0) > 0 && l.profitPerHour > 0);
    if (lanes.length === 0) return 0;
    const capital = lanes.reduce((n, l) => n + l.capital, 0);
    const scarce = others.some((a) => a.waitingForCash) || this.loadCash(except) < (capital / lanes.length) * 0.5;
    if (!scarce) return 0;
    return (CAPITAL_CHARGE_WEIGHT * lanes.reduce((n, l) => n + l.profitPerHour, 0)) / capital;
  }

  /**
   * Cash a ship can spend on its next load: spare cash in every region, less loads other ships are bound to buy, what
   * our loans will take to repay that cash due landing first doesn't cover (fenceUncovered) and the builds of
   * commissions we owe (commissionFence). None while a repayment due can't be covered (debtShort).
   */
  private loadCash(except?: ShipAgent): number {
    if (this.debtShort) return 0;
    let committed = 0;
    for (const a of this.agents.values()) if (a !== except) committed += this.committedBy(a);
    return Math.max(0, this.spareCash() - committed - this.fenceUncovered() - this.commissionFence());
  }

  /**
   * A ship's first call at its source (ownCall), within spare cash less what our loans' repayments need that cash due
   * doesn't cover (its own load's loan aside: taken for this very load).
   */
  private ownFloor(a: ShipAgent, spare = this.spareCash()): number {
    return Math.max(0, Math.min(this.ownCall(a), spare - this.fenceUncovered(a.lane?.borrow?.loanId)));
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
    // A loan it planned on isn't cash in hand until it is taken (then it is: the cash is there for this load).
    const loan = lane.borrow && lane.borrow.state !== "taken" ? lane.borrow.pence : 0;
    return Math.max(0, Math.min(this.committedBy(a), planned - a.spentOnLane()) - (lane.dueCounted ?? 0) - loan);
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
        // A dead key or a frozen company stops everything, not just the feed.
        if (isFatalApiError(e)) return this.fatal(fatalText(e));
        if (isApiError(e) && e.status === 403) {
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
      case "insurance_underwritten":
      case "insurance_cover_reduced":
      case "insurance_policy_closed": {
        // Public: a ship somewhere is about to sail (rival intel), and a fresh policy to judge.
        if (e.event_type === "insurance_policy_listed") {
          this.policiesDirty = true;
          this.wake?.();
        }
        const insured = str("insured_company_id");
        // Sent to the insured and its underwriters: a voided policy says why (`void.reason`, e.g. cargo_exceeds_declared).
        if (e.event_type === "insurance_policy_closed") {
          // The shape isn't published beyond `void.reason`: the payload, or its policy one level down.
          const pol = (p.policy && typeof p.policy === "object" ? p.policy : {}) as Record<string, unknown>;
          const vo = p.void ?? pol.void;
          const v = (vo && typeof vo === "object" ? vo : {}) as Record<string, unknown>;
          const reason = typeof v.reason === "string" ? v.reason : null;
          const status = str("status") ?? (typeof pol.status === "string" ? pol.status : undefined);
          const id = str("policy_id", "id") ?? (typeof pol.id === "string" ? pol.id : undefined);
          const whose = insured === undefined ? "a policy" : this.ourCompanyIds.has(insured) ? `the policy on ${agent?.name ?? "one of our ships"}` : "a policy we underwrite";
          if (reason) {
            this.log(agent?.name ?? "fleet", `${whose}${id ? ` (${id.slice(0, 8)})` : ""} was voided: ${reason.replace(/_/g, " ")}${reason === "cargo_exceeds_declared" ? " (cargo was loaded after it was written, or not all declared)" : ""}`);
          } else if (status === "cancelled") this.log(agent?.name ?? "fleet", `${whose}${id ? ` (${id.slice(0, 8)})` : ""} was cancelled (no reason given)`);
        }
        // A policy on one of our ships (the user's: the autopilot never buys one) changed: read it again at
        // the ship's next decision. A notice naming no ship may be about any of ours.
        if (insured !== undefined && !this.ourCompanyIds.has(insured)) break;
        if (agent) agent.forgetPolicy();
        else if (!str("ship_id")) for (const a of this.agents.values()) a.forgetPolicy();
        break;
      }
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
        // Pirates carry the ship off in 5-10% of interceptions (`captured`, guide 4.4).
        const captured = hazard.includes("captur") || p.captured === true;
        this.log(agent?.name ?? "fleet", `${hazard} at sea${captured ? ": CAPTURED by pirates" : p.sunk ? ": SUNK" : loss ? `: lost ${loss}% of cargo` : ""}`);
        if (agent && (hazard.includes("pira") || hazard.includes("raid") || captured)) this.notePirates(agent, loss !== undefined ? loss / 100 : null, captured);
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
          this.notePirates(agent, null, true);
          this.advisor.trigger("a ship was lost");
        }
        agent?.nudge();
        break;
      }
      case "ship_mutinied":
      case "ship_provisions_exhausted": {
        const mutiny = e.event_type === "ship_mutinied";
        this.log(agent?.name ?? "fleet", mutiny ? "the crew mutinied: ship lost" : "stores ran out at sea");
        // The stores reckoning fell short (golden rule 1: a starving crew loses cargo, then may mutiny): this ship keeps a day
        // more in hand from now on; after a mutiny, with that ship gone, every other ship does.
        if (agent && !mutiny) {
          const days = agent.raiseStoresBias(true);
          if (days !== null) this.log(agent.name, `keeping ${days} game days of stores in hand from now on`);
        }
        if (agent && mutiny) {
          for (const a of this.agents.values()) if (a !== agent && !a.gone) a.raiseStoresBias(false);
          this.log("fleet", "after the mutiny every ship keeps a game day more of stores in hand");
          this.advisor.trigger("a ship was lost");
        }
        agent?.nudge();
        break;
      }
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
          // For a stall only this company's deliveries are ours: the server sees a sibling company's as another's.
          const self =
            co !== undefined && this.companyName !== null ? co === this.companyName
            : coId !== undefined && this.world.companyId !== null ? coId === this.world.companyId
            : undefined;
          const sibling = !self && ((co !== undefined && rivals.ours.has(co)) || (coId !== undefined && (this.ourCompanyIds.has(coId) || rivals.ourIds.has(coId))));
          const ended = this.world.noteCharterDelivered(id, self, Date.parse(e.timestamp) || undefined);
          if (ended) {
            this.log(
              "fleet",
              `${sibling ? `our other company${co ? ` ${co}` : ""} delivered (the server counts it as another company's)` : "a rival delivered"} into the stalled ${ended.good} charter at ${ended.port}: no richer re-post this time`,
            );
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
      case "monopoly_granted":
      case "monopoly_expired":
        // Public: who may buy a good from the Crown's asks across a region changed. Taken in now (plans route
        // around it at once), and read again with the world.
        this.world.noteMonopolyEvent(e.event_type, p);
        this.worldDirty = true;
        this.wake?.();
        break;
      case "loan_offered":
      case "loan_offer_closed":
      case "loan_disbursed":
      case "loan_repayment":
      case "loan_defaulted":
      case "loan_collateral_seized":
      case "loan_written_off": {
        // Sent to lender and borrower, the payload the loan as loan/list gives it: liens and arrests are read afresh, and
        // the loan check (repayments, idle cash) runs soon.
        this.loansDirty = true;
        this.financeDirty = true;
        const ship = str("collateral_ship_id");
        const ours = this.isOurCompany(str("borrower_company_id") ?? "");
        const lender = !ours && this.isOurCompany(str("lender_company_id") ?? "");
        const held = ship ? this.agents.get(ship) : undefined;
        const loanId = str("id");
        const tag = loanId ? ` (${loanId.slice(0, 8)})` : "";
        if (loanId && typeof p.principal_pence === "number" && typeof p.status === "string") {
          this.noteLoan(p as unknown as Loan);
          // What we owe shows in the cap and the fence at once, even while loan/list can't be read.
          if (ours && typeof p.owed_pence === "number") this.cacheLoan(p as unknown as Loan);
        }
        if (e.event_type === "loan_defaulted" && ours && held && p.collateral_kind === "ship_lien") {
          // Her pledge's loan defaulted: arrested where she lies, or where she arrives (guide 3.13.1).
          held.noteArrest("the loan she is pledged to defaulted");
          this.advisor.trigger("a ship was arrested");
        }
        if (e.event_type === "loan_defaulted" && ours) this.log(held?.name ?? "fleet", `a loan of ours DEFAULTED${tag}: its pledge goes to the lender`);
        // Loans we made (an idle-cash board offer taken, or one the user made): repayments, defaults and the pledge that comes to us.
        if (lender) {
          const amount = num("principal_pence");
          const kind = typeof p.collateral_kind === "string" ? p.collateral_kind : "";
          if (e.event_type === "loan_disbursed") {
            this.log("fleet", `lent ${amount ? cr(amount) : "a loan"}${tag} from our credit-board offer${typeof p.daily_rate_bps === "number" ? ` at ${p.daily_rate_bps} bps a game day` : ""}${typeof p.term_game_days === "number" ? ` for ${p.term_game_days} game days` : ""}, secured by a ${kind.replace(/_/g, " ") || "pledge"}`);
          } else if (e.event_type === "loan_repayment") {
            this.log("fleet", `a borrower repaid us${tag}${typeof p.owed_pence === "number" ? `: ${cr(p.owed_pence)} still owed` : ""}`);
          } else if (e.event_type === "loan_defaulted") {
            this.log("fleet", `a borrower DEFAULTED on a loan we made${tag}: its pledge comes to us${p.recourse === true ? ", the rest is a claim on its vaults" : ""}`);
          } else if (e.event_type === "loan_collateral_seized") {
            if (kind === "ship_lien") {
              // The pledged ship is ours now: the next scan takes command of her like any of ours.
              this.lastScan = 0;
              this.log("fleet", `the ship pledged to a loan we made${tag} is ours now: taking command at the next scan`);
            } else if (kind === "warehouse_goods") {
              const tons = num("collateral_tons");
              this.log("fleet", `the goods pledged to a loan we made${tag} are ours now${tons ? `: ${tons} t ${str("collateral_commodity_id") ?? ""}` : ""} in our warehouse at ${str("collateral_port_id") ?? "its port"} (with their lease space)`);
            } else this.log("fleet", `the pledge of a loan we made${tag} was seized for us`);
          } else if (e.event_type === "loan_written_off") this.log("fleet", `a loan we made${tag} was written off${typeof p.written_off_pence === "number" ? `: ${cr(p.written_off_pence)} lost` : ""}`);
        } else if (ours && e.event_type === "loan_collateral_seized") {
          this.log(held?.name ?? "fleet", `the pledge of a loan of ours${tag} was seized by the lender`);
          this.lastScan = 0;
        }
        held?.nudge();
        break;
      }
      case "commission_listed":
        // Port-scoped to a yard where we have quay presence: weighed soon.
        this.dealsDirty = true;
        break;
      case "commission_accepted":
      case "commission_delivered":
      case "commission_defaulted":
      case "commission_expired": {
        // Buyer and builder: one of ours (a call with no answer included) follows at once; the check looks again soon.
        const id = str("contract_id", "commission_id", "id");
        const rec = id ? this.commissionRecs.get(id) : undefined;
        if (id && rec) this.noteCommissionEvent(id, rec, e.event_type, num("build_cost_pence"));
        this.dealsDirty = true;
        break;
      }
      case "ship_listed":
        // Port-scoped: a ship for sale at a quay of ours; the buyer looks within seconds.
        if (this.settings.shipDeals) this.lastBuyCheck = Math.min(this.lastBuyCheck, Date.now() - BUY_CHECK_MS + DEALS_EVENT_MIN_MS);
        break;
      case "ship_sold": {
        // Seller and buyer: a ship we bought joins at the next scan; one of ours sold (listed by hand) leaves the fleet then.
        const seller = str("seller_company_id");
        const price = num("price_pence");
        if (seller && this.isOurCompany(seller)) this.log("fleet", `a ship of ours was sold where she lay${price ? ` for ${cr(price)}` : ""} (listed by hand)`);
        this.lastScan = 0;
        break;
      }
      case "envelope_sold":
        // Ours: booked from envelope/mine at the next check (once).
        this.envelopesDirty = true;
        break;
      case "crown_bailiff_warehouse_seizure":
      case "crown_bailiff_upkeep_seizure":
        this.log("fleet", `BAILIFF: ${e.event_type.replace(/_/g, " ")} (a bill went unpaid; check the reserve)`);
        break;
      case "server_announcement": {
        const at = Date.parse(e.timestamp) || this.world.now();
        this.log("fleet", `server ${str("severity") ?? "notice"}: ${str("message") ?? ""}`);
        this.advisor.noteEvent("server_announcement", str("message") ?? "", at);
        // A critical one (maintenance, a pause, the season's end) is a banner on the dashboard for a while; the latest wins.
        if (str("severity") === "critical" && (this.announcement === null || at >= this.announcement.at)) {
          this.announcement = { at, message: (str("message") ?? "").slice(0, ANNOUNCEMENT_MAX_CHARS) };
          this.persist();
        }
        break;
      }
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
   * One of our ships was intercepted (voyage_hazard) or taken (ship_captured): the world learns the raid's take
   * and the capture odds from it. A capture may come as both notices: counted once per ship.
   */
  private notePirates(agent: ShipAgent, share: number | null, captured: boolean): void {
    if (captured) {
      if (this.capturesNoted.has(agent.shipId)) return;
      this.capturesNoted.add(agent.shipId);
    }
    this.world.notePirateRaid(share, captured);
    this.persist();
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
   * "always hold" and AI "wait" force it near the lapse. Our own delivery is taken to cancel the
   * escalation too until re-posts show it doesn't (World.judge); after that ships may deliver into
   * it what fits under the pace line (ShipAgent.campShut). The season ending first vetoes it as well.
   */
  private stallStakes(): Map<string, StallStake> {
    // Working them out reads the capital charge, whose cash due checks each load against the stakes:
    // inside that, the last ones stand (else the two recurse without end).
    if (this.stakesBusy || Date.now() - this.stakesAt < STAKES_TTL_MS) return this.stakes;
    this.stakesBusy = true;
    try {
      return this.computeStallStakes();
    } finally {
      this.stakesBusy = false;
    }
  }

  private computeStallStakes(): Map<string, StallStake> {
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
        : !w.beforeSeasonEnd(until) ? "the season ends before the re-post"
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

  /** One planning pass at a time, so each ship sees the others' fresh reservations. `pin`: an insured voyage's limits. */
  assignLane(agent: ShipAgent, from: string, r: ShipResult, pin?: { onlySource?: string; onlyDest?: string }): Promise<Lane | null> {
    const run = this.assignQueue.then(() => this.assignLaneNow(agent, from, r, pin));
    this.assignQueue = run.catch(() => undefined);
    return run;
  }

  private async assignLaneNow(agent: ShipAgent, from: string, r: ShipResult, pin: { onlySource?: string; onlyDest?: string } = {}): Promise<Lane | null> {
    const prev = agent.lane;
    const cash = this.loadCash(agent);
    const spec = this.specFor(agent, r);
    const w = this.world;
    // The AI's order for this ship, never over an insured voyage's limits (its policy decides first).
    const order = pin.onlySource || pin.onlyDest ? undefined : this.advisor.shipOrder(agent.shipId);
    if (order?.order === "port" && order.ref === from) this.noteOrder(agent, order, "done");
    // A port order plans only loads from that port (none paying: the ship sails there empty, ShipAgent.atPort).
    const portOrder = order?.order === "port" && order.ref !== from ? order.ref : undefined;
    const opts = { ...this.planOptions(cash, agent), ...pin, ...(portOrder ? { onlySource: portOrder } : {}) };
    const pick = (lanes: Lane[]) => lanes.find((l) => !agent.isAvoided(l.key) && (!portOrder || l.source === portOrder)) ?? null;
    let lanes = await rankLanes(w, spec, from, this.reservations(agent), opts);
    let best = pick(lanes);
    // Nothing pays unarmed (pirates would likely take the ship), but this is a yard: plan as if
    // fully armed; the refit here then sizes the guns to the lane and the load is planned again.
    const max = w.shipClass(agent.shipClass)?.max_cannons ?? 0;
    if (!best && this.settings.guns === "auto" && r.ship.status !== "sailing" && w.port(from)?.has_shipyard && spec.guns < max) {
      const armed: ShipSpec = { ...spec, guns: max, cap: Math.max(0, spec.cap - 2 * (max - spec.guns)), hullValue: (spec.hullValue ?? 0) + (max - spec.guns) * GUN_PRICE_PENCE };
      lanes = await rankLanes(w, armed, from, this.reservations(agent), opts);
      best = pick(lanes);
    }
    // A lane or charter order: the best lane that is it and passes every check (and still earns after the
    // charge on the cash it ties up), else the best as usual: an order never idles a ship.
    if (order && (order.order === "lane" || order.order === "charter")) {
      const charge = opts.capitalRate ?? 0;
      const pinned = lanes.find(
        (l) =>
          !agent.isAvoided(l.key) &&
          l.profitPerHour - charge * l.capital > 0 &&
          (order.order === "lane" ? l.key === order.ref : l.fills.some(([id]) => w.currentId(id) === w.currentId(order.ref))),
      );
      if (pinned) best = pinned;
      this.noteOrder(agent, order, pinned ? "active" : "unmet", pinned ? undefined : "no_passing_lane");
    } else if (order?.order === "release") this.noteOrder(agent, order, "done");
    else if (portOrder && best) this.noteOrder(agent, order!, "active");
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
  resizeLane(agent: ShipAgent, port: string, r: ShipResult, onlyDest?: string): Promise<Lane | null> {
    const run = this.assignQueue.then(() => this.resizeLaneNow(agent, port, r, onlyDest));
    this.assignQueue = run.catch(() => undefined);
    return run;
  }

  private async resizeLaneNow(agent: ShipAgent, port: string, r: ShipResult, onlyDest?: string): Promise<Lane | null> {
    const prev = agent.lane;
    if (!this.settings.resizeLoads || !prev || prev.source !== port || agent.loaded) return null;
    await this.world.refreshVaults().catch(() => undefined);
    const cash = this.loadCash(agent);
    const spare = this.cashAt(this.cashFlows(agent), this.world.now(), this.world.region(port));
    // First call on what its own plan still has to buy from cash in hand (that share respected the others
    // when it was planned; never what our loans' repayments need); cash due it counted on, and growth, must leave
    // the others' loads alone.
    const floor = this.ownFloor(agent);
    const base = this.planOptions(Math.max(cash, floor), agent);
    const opts = { ...base, onlySource: port, onlyDest, cashAt: (at: number, src: string) => Math.max(floor, base.cashAt ? base.cashAt(at, src) : cash) };
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
    let pick: Lane | undefined = here.find((l) => l.key === prev.key) ?? here[0];
    // Leverage (guide 3.13): a load the cash can't fund, planned again with what a loan could add; borrowed as it is bought.
    const levered = await this.leveragedLoad(agent, r, port, opts, pick, room).catch((e: unknown) => {
      if (this.isFatal(e) || isApiError(e, "world_paused")) throw e;
      return null;
    });
    if (agent.lane !== prev) return null;
    if (levered) pick = levered;
    if (!pick) {
      this.log(
        agent.name,
        `nothing loading at ${port} pays with ${cr(room)} spare for it now; buying what that covers of ${loadText(prev)}` +
          `${(prev.dueCounted ?? 0) > 0 ? " if it makes a load worth the leg, else waiting for the cash due it counted on" : ""}`,
      );
      return null;
    }
    const before = this.committedBy(agent);
    // The loan it plans on is neither cash in hand nor cash due.
    const loan = pick.borrow?.pence ?? 0;
    const lane = agent.adoptResized({ ...pick, resizedFrom: prev.resizedFrom ?? prev.tons, dueCounted: Math.max(0, Math.round(pick.capital - loan - Math.max(cash, floor))) });
    // Its tons before or after a stalled posting's lapse move the fleet's call on it.
    this.stakesAt = 0;
    const d = lane.tons - prev.tons;
    if (d > 0) {
      s.grown++;
      s.tonsAdded += d;
    } else if (d < 0) {
      s.shrunk++;
      s.tonsCut -= d;
      // Cut to the cash there is: the fleet needs cash (idle cash on offer comes back).
      this.noteCashShort();
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

  // ── AI orders to ships ──────────────────────────────────────────────────────

  /** The AI's order in force for this ship (live only), unless done or refused. */
  shipOrder(agent: ShipAgent): ShipOrder | undefined {
    return this.advisor.shipOrder(agent.shipId);
  }

  /** What became of this order for this ship (from the ship itself; nothing if a newer answer replaced it meanwhile). */
  orderOutcome(agent: ShipAgent, order: ShipOrder, status: OrderStatus, code?: OrderCode, note?: string): void {
    this.noteOrder(agent, order, status, code, note);
  }

  /** Records an order's outcome while it is still the one in force, logged once per change (the CLI's view of it). */
  private noteOrder(agent: ShipAgent, o: ShipOrder, status: OrderStatus, code?: OrderCode, note?: string): void {
    if (this.advisor.noteOrder(o, status, code, note)) {
      this.log(agent.name, `AI order ${o.order}${o.label ? ` ${o.label}` : ""}: ${status}${code ? ` (${code.replace(/_/g, " ")})` : ""}${note ? `: ${note}` : ""}`);
    }
  }

  /**
   * Whether the AI wants this planned lane (nothing of it bought yet) dropped: it touches a ban, or an order
   * still to be acted on wants something else (a lane, charter or port order not yet planned, a hold, a release).
   */
  laneVetoed(agent: ShipAgent, lane: Lane): boolean {
    const bans = this.advisor.bans();
    if (bans && laneBanned(lane, bans, (id) => this.world.currentId(id))) return true;
    const o = this.advisor.shipOrder(agent.shipId);
    if (!o) return false;
    if (o.order === "hold") return true;
    if (o.status !== "pending") return false;
    if (o.order === "release") return true;
    if (o.order === "port") return lane.source !== o.ref;
    if (o.order === "lane") return lane.key !== o.ref;
    return !lane.fills.some(([id]) => this.world.currentId(id) === this.world.currentId(o.ref));
  }

  /** Whether the AI's bans keep a ship from making for this port (or from this passage), or from this charter. */
  offLimits(port: string, plan?: RoutePlan, charterId?: string): boolean {
    const b = this.advisor.bans();
    if (!b) return false;
    const zone = (n: string) => this.world.hazardZone(n)?.id ?? "";
    return (
      b.ports.has(port) ||
      b.zones.has(zone(port)) ||
      (!!charterId && b.charters.has(this.world.currentId(charterId))) ||
      !!plan?.legs.some((l) => b.zones.has(zone(l.to_node)))
    );
  }

  /**
   * New directives: a sailing ship's planned lane that nothing has been bought for and that the AI vetoes is
   * dropped (it plans again on arrival; it can't be recalled); release orders are carried out or refused. Ships
   * in port see to it themselves at their next decision (never mid-load).
   */
  private applyShipDirectives(): void {
    for (const a of this.agents.values()) {
      if (a.gone || !a.last) continue;
      const lane = a.lane;
      const o = this.advisor.shipOrder(a.shipId);
      const sailing = a.last.ship.status === "sailing";
      const untouched = !!lane && !a.loaded && a.partsToBuy().length === lane.parts.length && a.freightToTake().length === lane.freight.length;
      if (o?.order === "release" && o.status === "pending") {
        if (!lane) this.noteOrder(a, o, "done");
        else if (!untouched) this.noteOrder(a, o, "refused", "cargo_aboard");
        else if (sailing) {
          this.releaseLane(a);
          this.noteOrder(a, o, "done");
        }
        a.nudge();
        continue;
      }
      if (sailing && lane && untouched && this.laneVetoed(a, lane)) {
        this.log(a.name, `dropping the planned lane ${lane.key}: the AI's directives rule it out (planning again on arrival)`);
        this.releaseLane(a);
      }
      if (o) a.nudge();
    }
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
      // The pace is the slowest joined member's (pending requests don't sail).
      memberClasses: r.members.filter((m) => m.status === "joined").map((m) => m.ship_class),
      checkedAt: Date.now(),
    });
  }

  /** A class's speed in knots (unknown: about a hoy's). */
  private knots(shipClass: string): number {
    return (this.world.shipClass(shipClass)?.base_speed_centiknots ?? 800) / 100;
  }

  /**
   * Stores one of our ships needs to sail with a convoy leaving at `departsAt` at `slowest` knots: its passage
   * as it would sail alone (ShipAgent.passageStores, never under the safe figure) stretched to the convoy's
   * pace, plus eating in port until it sails. `bare`: with no hit margin (fed to port if nothing strikes).
   * The one measure joining, forming and waiting all use, so a ship never joins only to leave again.
   */
  private convoyStores(a: ShipAgent, plan: RoutePlan, departsAt: number, slowest: number): { need: number; bare: number } {
    const slow = Math.max(1, this.knots(a.shipClass) / Math.max(slowest, 0.1));
    const wait = (Math.max(0, departsAt - this.world.now()) / (24 * 60 * this.world.gameMinuteMs)) * plan.port_provisions_tons_per_day;
    return { need: a.passageStores(plan) * slow + wait, bare: plan.expected_provisions_tons * slow + wait };
  }

  /**
   * Whether a policy on one of the convoy's members (for its port) may have been priced with the consorts
   * (guide 3.4: they must then all sail with it, or it is void). Lloyd's doesn't say, so any counts.
   */
  private async consortPriced(c: { dest: string; members: string[] }): Promise<boolean> {
    for (const id of c.members) {
      const a = this.agents.get(id);
      const p = a ? await a.insuredPolicy() : null;
      // Unknown (the read failed): it may be.
      if (p === undefined || (p && p.dest_port_id === c.dest)) return true;
    }
    return false;
  }

  /**
   * In one of our convoys at `port`: waits for it to sail, re-checking every pass that this ship's stores
   * still cover the convoy's pace and the wait (a slower ship may have joined; the crew eats in port; convoy
   * departures aren't checked, guide 2). Short: provisions carried as cargo go into the stores; else it
   * leaves the convoy to top up and join again or sail alone, unless that would void a policy priced on
   * the consorts while the bare need is still covered. Never null while the convoy can't be read, isn't
   * listed or isn't forming here (only once it is over): a ship in a convoy can't dock or sail alone.
   */
  async convoyWait(agent: ShipAgent, r: ShipResult, convoyId: string, port: string): Promise<number | null> {
    let c = this.convoyCache.get(convoyId);
    if (!c || Date.now() - c.checkedAt > 20_000) {
      const list = await this.client.convoys({ convoy_id: convoyId }).catch((e) => {
        if (this.isFatal(e) || isApiError(e, "world_paused")) throw e;
        return null;
      });
      if (!list) {
        agent.activity = "in a convoy (couldn't read it); waiting";
        return 15_000;
      }
      if (list[0]) this.noteConvoy(list[0]);
      else this.convoyCache.delete(convoyId);
      c = this.convoyCache.get(convoyId);
    }
    // Over (completed, cancelled): the ship is free. Not listed, or not forming here, while she is still in it: she
    // can't dock or sail alone, so she waits (a depart now would only be refused).
    if (c && (c.status === "completed" || c.status === "cancelled")) return null;
    if (!c || c.status !== "forming" || c.from !== port) {
      agent.activity = `in a convoy that isn't forming at ${port}; waiting`;
      return 15_000;
    }
    const w = this.world;
    const left = c.departsAt - w.now();
    const n = c.members.length;
    const dest = c.dest;
    const waiting = () => {
      agent.activity = `in convoy to ${dest} with ${n} ship${n === 1 ? "" : "s"}, sails in ${Math.max(0, Math.round(left / 1000))}s`;
      return Math.min(Math.max(left + 2_000, 2_000), 30_000);
    };
    // A policy the user bought since for another port is void if she sails with this convoy (rule 8): she leaves it,
    // and atPort makes for the policy's port. Unknown (a failed read): read again next pass.
    const policy = await agent.insuredPolicy();
    if (policy && policy.dest_port_id !== c.dest && policy.dest_port_id !== port) {
      try {
        await this.client.detachConvoy({ convoy_id: convoyId, ship_id: agent.shipId });
      } catch (e) {
        if (this.isFatal(e) || !isApiError(e) || e.status >= 500) throw e;
        this.logOnceFor(`${agent.shipId}|insured|${convoyId}`, agent.name, `couldn't leave the convoy to ${c.dest} for the policy's ${policy.dest_port_id} (${e.message}); trying again`);
        agent.activity = `in convoy to ${c.dest}, insured for ${policy.dest_port_id}: couldn't leave it`;
        return 15_000;
      }
      this.convoyCache.delete(convoyId);
      this.log(agent.name, `left the convoy to ${c.dest}: the policy on this ship is for a voyage to ${policy.dest_port_id}`);
      return 1_000;
    }
    const plan = await w.route(c.from, c.dest, agent.shipClass).catch(() => null);
    if (!plan) return waiting();
    const slowest = Math.min(this.knots(agent.shipClass), ...c.memberClasses.map((k) => this.knots(k)));
    const { need, bare } = this.convoyStores(agent, plan, c.departsAt, slowest);
    const have = r.stores.provisions_tons;
    // A hair under what it joined on (the storm odds of a later sailing) isn't worth leaving over: `need` keeps its hit margin.
    if (have >= need * 0.99) return waiting();

    // Short: our own provisions cargo first (whole tons; the stores take it from the hold).
    const own = Math.min(agent.ownTons(r, "provisions"), Math.ceil(need - have));
    if (own > 0) {
      try {
        await this.client.provision(agent.shipId, own, "cargo");
        this.log(agent.name, `moved ${own} t of provisions cargo into the stores: the convoy to ${c.dest} sails at ${slowest.toFixed(1)} kn`);
        return 1_000;
      } catch (e) {
        if (this.isFatal(e) || !isApiError(e) || e.status >= 500) throw e;
      }
    }
    if (have >= bare && (await this.consortPriced(c))) {
      agent.activity = `in convoy to ${c.dest}, stores ${have.toFixed(2)} t under the ${need.toFixed(2)} t its pace wants: staying, a policy counts on the consorts`;
      this.logOnceFor(`${agent.shipId}|consorts|${convoyId}`, agent.name, `stores ${have.toFixed(2)} t, short of the ${need.toFixed(2)} t the convoy to ${c.dest} wants (${bare.toFixed(2)} t bare): staying with it, a policy may count on the consorts`);
      return waiting();
    }
    try {
      await this.client.detachConvoy({ convoy_id: convoyId, ship_id: agent.shipId });
    } catch (e) {
      if (this.isFatal(e) || !isApiError(e) || e.status >= 500) throw e;
      this.logOnceFor(`${agent.shipId}|detach|${convoyId}`, agent.name, `couldn't leave the convoy to ${c.dest} short of stores (${e.message}); trying again`);
      agent.activity = `in convoy to ${c.dest}, short of stores: couldn't leave it`;
      return 15_000;
    }
    this.convoyCache.delete(convoyId);
    const topUp = agent.convoyTopUp(need);
    this.log(
      agent.name,
      `left the convoy to ${c.dest}: stores ${have.toFixed(2)} t, short of the ${need.toFixed(2)} t its ${slowest.toFixed(1)} kn pace needs; ${topUp ? "topping up, then joining again" : "sailing alone"}`,
    );
    return 1_000;
  }

  /** Logs once per `key` (a ship waiting on the same thing says it once). */
  private logOnceFor(key: string, source: string, msg: string): void {
    if (this.loggedOnce.has(key)) return;
    this.loggedOnce.add(key);
    if (this.loggedOnce.size > 200) this.loggedOnce.delete(this.loggedOnce.values().next().value!);
    this.log(source, msg);
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
        if (r.ship.status === "berthed") agent.noteDues(from, (await this.client.offshore(agent.shipId)).berth_dues_pence);
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
   * (or forming) is worth it when the fall in all our members' losses, less the extra storm loss
   * of the slower (and later) passage, beats what the wait costs this ship's time; only with ships
   * of similar speed (a convoy sails at its slowest), only when the stores cover the slower passage
   * and the wait, and only if the cargo still arrives before its charters and freight are due.
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
    // Each ship still rolls its own storms (guide 3.7), longer at sea at the convoy's slower pace: what a passage's
    // storms are expected to cost a ship (its cargo's share, and its hull if it sinks), at the user's storm weight.
    const stormWeight = this.settings.stormWeightPct / 100;
    const storms = (cls: string, guns: number, cargo: number, knots: number, sailsAt: number) => {
      const s = w.stormRisk(plan, w.shipClass(cls)?.hull_category ?? "coastal", knots * 0.8, sailsAt, stormWeight);
      return s.cargoShare * cargo + s.sink * (this.hullValue(cls) + guns * GUN_PRICE_PENCE);
    };
    // A convoy's extra storm loss for one ship over how it would sail otherwise; never counted as a gain.
    const slower = (cls: string, guns: number, cargo: number, convoy: { knots: number; at: number }, otherwise: { knots: number; at: number }) =>
      Math.max(0, storms(cls, guns, cargo, convoy.knots, convoy.at) - storms(cls, guns, cargo, otherwise.knots, otherwise.at));
    const waitCost = (ms: number) => (agent.rate * Math.max(0, ms)) / 3_600_000;
    const baseLock = 30 * w.gameMinuteMs;
    // Can this ship sail in a convoy leaving at `departsAt` at `slowest` knots? (The stores as convoyWait judges them.)
    const fits = (departsAt: number, slowest: number) => {
      if (r.stores.provisions_tons < this.convoyStores(agent, plan, departsAt, slowest).need) return false;
      const due = agent.deliverDeadline();
      const arrive = departsAt + w.sailMs(plan.total_distance_nm, slowest * 0.8) + baseLock;
      // Charters and freight pay nothing after the season ends (guide 3.11): the muster and the slower pace mustn't push it past.
      if (!w.beforeSeasonEnd(arrive)) return false;
      return due === null || arrive <= due;
    };

    // One of ours already forming here for the same port: join it, or sail alone (never a second). Unread, or
    // not read to the end, ours may be among the missing: sail alone rather than form another.
    const listed = await this.client.convoyPages({ port_id: from, status: "forming" }).catch((e) => {
      if (this.isFatal(e) || isApiError(e, "world_paused")) throw e;
      return null;
    });
    if (!listed?.complete) return alone;
    const forming = listed.items.filter((c) => c.convoy.organizer_company_id === w.companyId && c.convoy.dest_port_id === dest);
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
      const pace = Math.min(...pick.c.members.map((m) => speed(m.ship_class)));
      const slowest = Math.min(ourSpeed, pace);
      // All members' losses before (ours alone, theirs shared n ways) against after (n + 1 ways), less the storms
      // of the slower passage: ours (later and slower than alone now), and the members' when we slow them.
      const convoy = { knots: slowest, at: pick.departsAt };
      let stormCost = slower(agent.shipClass, r.ship.cannons_count, cargoOf(r), convoy, { knots: ourSpeed, at: now });
      if (slowest < pace) {
        for (const m of pick.c.members) {
          const a = this.agents.get(m.ship_id);
          if (a?.last) stormCost += slower(m.ship_class, m.cannons_count, cargoOf(a.last), convoy, { knots: pace, at: pick.departsAt });
        }
      }
      const gain = ours + members / n - (ours + members) / (n + 1) - stormCost;
      if (!(gain > waitCost(pick.departsAt - now) && fits(pick.departsAt, slowest))) return alone;
      // A slower ship slows everyone: each of ours already in it must still have the stores for the new pace.
      if (slowest < pace) {
        for (const m of pick.c.members) {
          const a = this.agents.get(m.ship_id);
          if (!a?.last) continue;
          const mp = await w.route(from, dest, m.ship_class).catch(() => null);
          if (!mp || a.last.stores.provisions_tons < this.convoyStores(a, mp, pick.departsAt, slowest).need) return alone;
        }
      }
      return { kind: "join", convoyId: pick.c.convoy.id, ships: n };
    }

    // Our other ships that will leave the same way soon: at this port with the same lane, or on their way here for it.
    if (ours < CONVOY_MIN_EXPOSURE_PENCE) return alone;
    const handling = w.handlingMsPerTon(from);
    const partners: Array<{ ready: number; exposure: number; speed: number; cls: string; guns: number; value: number }> = [];
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
      partners.push({ ready, exposure: e, speed: speed(a.shipClass), cls: a.shipClass, guns: pr.ship.cannons_count, value });
    }
    if (partners.length === 0) return alone;
    const k = partners.length;
    const waitMs = Math.max(CONVOY_MIN_MUSTER_GAME_MIN * w.gameMinuteMs, Math.max(...partners.map((p) => p.ready)) - now + baseLock);
    const slowest = Math.min(ourSpeed, ...partners.map((p) => p.speed));
    // Less the storms of the slower, later passage: ours against alone now, each partner's against alone when ready.
    const convoy = { knots: slowest, at: now + waitMs };
    const stormCost =
      slower(agent.shipClass, r.ship.cannons_count, cargoOf(r), convoy, { knots: ourSpeed, at: now }) +
      partners.reduce((n, p) => n + slower(p.cls, p.guns, p.value, convoy, { knots: p.speed, at: p.ready }), 0);
    const gain = ((ours + partners.reduce((n, p) => n + p.exposure, 0)) * k) / (k + 1) - stormCost;
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
      // Sunk or seized but not retired yet (the next scan): no longer billed.
      if (a.gone) continue;
      const cls = this.world.shipClass(a.shipClass);
      if (!cls || (cls.hull_category === "oceanic") !== oceanic) continue;
      t += cls.hold_capacity_tons;
    }
    return t;
  }

  /** Daily fleet upkeep (pence per game day), optionally with an extra hull. */
  private upkeepPerDay(extra?: { tons: number; oceanic: boolean }): number {
    const w = this.world;
    const bill = (coastal: number, oceanic: number) => w.sprawlPerDay(coastal) + w.factorUpkeepPerDay(this.factorCount) + 100 * oceanic;
    const now = bill(this.fleetTons(false), this.fleetTons(true));
    const withExtra = bill(this.fleetTons(false) + (extra && !extra.oceanic ? extra.tons : 0), this.fleetTons(true) + (extra?.oceanic ? extra.tons : 0));
    // The formula (guide 3.9), or what the last billing passes charged if more, plus the extra hull.
    return Math.max(withExtra, this.bills.upkeep + withExtra - now);
  }

  private homeFloor(extra?: { tons: number; oceanic: boolean }): number {
    return Math.max(this.settings.reservePence, Math.ceil(UPKEEP_DAYS_RESERVED * this.upkeepPerDay(extra)));
  }

  private floorIn(region: BankingRegion): number {
    // Each region also keeps its own warehouses' rent (billed from the port's region).
    const rent = Math.ceil(UPKEEP_DAYS_RESERVED * (this.bills.rent.get(region) ?? 0));
    return (region === this.homeRegion ? this.homeFloor() : REGION_FLOOR_PENCE) + rent;
  }

  /**
   * What the daily bills really charge (guide 3.9: warehouse rent per port from its region, sprawl and
   * factors from home), learned from the ledger since the rates aren't published. A billing pass is a
   * cluster of bill debits from our vaults; per region (upkeep: all regions, a short home is swept) the
   * larger of the last two passes counts. The reason strings aren't published either: those seen are
   * logged once, so the patterns can be checked. Nothing measured: the formula alone, as before.
   */
  private async learnBills(): Promise<void> {
    const w = this.world;
    // The user may have changed them on the company page since.
    await this.checkAutoRemit();
    if (w.vaultAccounts.size === 0) await w.refreshVaults();
    const now = w.now();
    const since = now - BILLS_LOOKBACK_GAME_DAYS * 24 * 60 * w.gameMinuteMs;
    const entries: LedgerEntry[] = [];
    let cursor: string | undefined;
    let complete = false;
    for (let page = 0; page < BILLS_LEDGER_PAGES; page++) {
      const batch = await this.client.ledger({ cursor, limit: 200 });
      entries.push(...batch);
      if (batch.length < 200) {
        complete = true;
        break;
      }
      if (Date.parse(batch[batch.length - 1].created_at) < since) break;
      cursor = batch[batch.length - 1].id;
    }
    // Read far enough back for a whole game day's billing, or to the start of the ledger.
    const oldest = Math.min(...entries.map((e) => Date.parse(e.created_at)).filter((t) => Number.isFinite(t)), now);
    const covered = complete || oldest <= now - 24 * 60 * w.gameMinuteMs;

    const bills: Array<{ at: number; region: BankingRegion; pence: number; kind: "rent" | "upkeep" }> = [];
    const reasons = new Map<string, string>();
    for (const e of entries) {
      const at = Date.parse(e.created_at);
      // Out of one of our vaults to someone else (the debit side, as the treasury page reads it).
      const region = w.vaultAccounts.get(e.debit_account_id);
      if (!region || w.vaultAccounts.has(e.credit_account_id) || !(at >= since)) continue;
      const kind = ONE_OFF_REASON.test(e.reason) ? null : RENT_REASON.test(e.reason) ? "rent" : UPKEEP_REASON.test(e.reason) ? "upkeep" : null;
      if (!reasons.has(e.reason)) reasons.set(e.reason, kind ?? "-");
      if (kind && e.amount_pence > 0) bills.push({ at, region, pence: e.amount_pence, kind });
    }
    if (!this.billReasonsLogged && reasons.size > 0) {
      this.billReasonsLogged = true;
      this.log("fleet", `ledger reasons seen (taken as a daily bill: rent/upkeep): ${[...reasons].map(([r, k]) => `${r}${k === "-" ? "" : ` (${k})`}`).join(", ")}`);
    }

    // Billing passes: entries within a minute of the one before.
    const passes: Array<typeof bills> = [];
    for (const b of bills.sort((x, y) => x.at - y.at)) {
      const last = passes.at(-1);
      if (last && b.at - last[last.length - 1].at <= BILLING_CLUSTER_MS) last.push(b);
      else passes.push([b]);
    }
    const lastTwo = (pick: (b: (typeof bills)[number]) => boolean) => {
      const sums = passes.map((p) => p.filter(pick).reduce((n, b) => n + b.pence, 0)).filter((n) => n > 0);
      return sums.length ? Math.max(...sums.slice(-2)) : 0;
    };
    const rent = new Map<BankingRegion, number>();
    for (const region of new Set(bills.filter((b) => b.kind === "rent").map((b) => b.region))) rent.set(region, lastTwo((b) => b.kind === "rent" && b.region === region));
    const upkeep = lastTwo((b) => b.kind === "upkeep");
    // Not back a whole game day (a busy ledger): what this read found, the rest as measured before.
    if (!covered) {
      for (const [r, p] of this.bills.rent) if (!rent.has(r)) rent.set(r, p);
    }
    const prev = this.bills;
    this.bills = { rent, upkeep: covered || upkeep > 0 ? upkeep : prev.upkeep, at: now };
    const total = (b: typeof prev) => b.upkeep + [...b.rent.values()].reduce((n, p) => n + p, 0);
    if (prev.at === null || Math.abs(total(this.bills) - total(prev)) >= Math.max(1_000, 0.1 * total(prev))) {
      const rents = [...rent].filter(([, p]) => p > 0).map(([r, p]) => `${r} ${cr(p)}`);
      this.log("fleet", `daily bills from the ledger: upkeep ${cr(this.bills.upkeep)}${rents.length ? `, rent ${rents.join(", ")}` : ", no rent"}; home keeps ${cr(this.homeRegion ? this.floorIn(this.homeRegion) : this.homeFloor())}`);
    }
    this.persist();
  }

  /**
   * Auto-remit (guide 3.9) tops a bill its region can't cover up from our other regions, never below its reserve and
   * all-or-nothing. Only read and reported, never changed: a reserve at the floor ensureCash drains donors to would
   * leave a covered bill unpaid (the bailiff seizes ships for unpaid upkeep). Home is kept at its floor from the
   * others instead (keepHomeFloor). Said when it changes; only a fatal error comes out.
   */
  private async checkAutoRemit(): Promise<void> {
    const s = await this.client.companySettings().catch((e) => {
      if (this.isFatal(e)) throw e;
      return null;
    });
    if (!s) {
      if (this.autoRemit === null && !this.autoRemitUnreadSaid) {
        this.autoRemitUnreadSaid = true;
        this.log("fleet", "company settings unreadable: auto-remit for bills unknown (looking again with the bills)");
      }
      return;
    }
    const prev = this.autoRemit;
    this.autoRemit = { on: s.auto_remit_for_bills, reservePence: s.auto_remit_min_reserve_pence };
    if (prev && prev.on === this.autoRemit.on && prev.reservePence === this.autoRemit.reservePence) return;
    if (!s.auto_remit_for_bills) {
      return void this.log(
        "fleet",
        "auto-remit for bills is off: a region that can't cover its own bill meets the bailiff. The autopilot keeps every region's floor (home topped up from the others); switching it on (company page) also covers a short bill from the other regions",
      );
    }
    this.log(
      "fleet",
      `auto-remit for bills is on: a short bill is topped up from the other regions${s.auto_remit_min_reserve_pence > 0 ? `, keeping ${cr(s.auto_remit_min_reserve_pence)} in each (all-or-nothing: a bill the regions can't cover above that isn't topped up at all)` : ""}`,
    );
  }

  /**
   * Upkeep is billed from home every game day (guide 3.9) and nothing else refills it: home is topped up to its
   * floor from the other regions' spare (ensureCash with nothing to spend remits just the shortfall). Never while
   * paused or stopping, never dipping into a floor (not essential), under the cash lock so no stores purchase
   * is mid-way.
   */
  private async keepHomeFloor(): Promise<void> {
    const home = this.homeRegion;
    if (!home || !this.canRemit) return;
    await this.withCash(async () => {
      if (this.paused || this.stopRequested) return;
      await this.ensureCash(home, 0);
    }).catch((e) => {
      if (this.isFatal(e) || isApiError(e, "world_paused")) throw e;
      this.log("fleet", `topping ${home} up to its floor failed: ${(e as Error).message}`);
    });
  }

  withCash<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.cashQueue.then(fn);
    this.cashQueue = run.catch(() => undefined);
    return run;
  }

  /**
   * Cash spendable in a region after its floor, remitted from other regions if short. `fresh`: the vaults
   * were just read. `essential` (stores to sail safely): when still short, it may dip into the floor.
   */
  async ensureCash(region: BankingRegion, amount: number, opts: { fresh?: boolean; essential?: boolean } = {}): Promise<number> {
    const w = this.world;
    if (!opts.fresh) await w.refreshVaults();
    let have = w.vault(region) - this.floorIn(region);
    if (have < amount && this.canRemit) {
      // Pull the shortfall from the cheapest corridor first, paying the ACH fee. Each donor's spare is worked
      // out from the vaults as read after the remit before it.
      const asked = new Set<BankingRegion>();
      for (;;) {
        const d = [...w.vaults.entries()]
          .filter(([r]) => r !== region && !asked.has(r))
          .map(([r, v]) => ({ r, spare: v - this.floorIn(r) }))
          .filter((x) => x.spare > 0)
          .sort((a, b) => w.remitBps(a.r, region) - w.remitBps(b.r, region) || b.spare - a.spare)[0];
        if (!d) break;
        asked.add(d.r);
        const fee = w.remitBps(d.r, region) / 10_000;
        const gross = Math.min(d.spare, Math.max(Math.ceil((amount - have) / (1 - fee)) + 100, 1_000));
        if (gross <= 0) continue;
        let failed: unknown = null;
        try {
          const res = await this.client.remit(d.r, region, gross);
          this.log("fleet", `moved ${cr(res.net_credited_pence)} ${d.r} → ${region} (fee ${cr(res.fee_pence)})`);
          // Booked at once, in case the read below fails.
          w.vaults.set(d.r, w.vault(d.r) - res.gross_amount_pence);
          w.vaults.set(region, w.vault(region) + res.net_credited_pence);
        } catch (e) {
          if (this.isFatal(e) || isApiError(e, "world_paused")) throw e;
          this.log("fleet", `remit ${d.r} → ${region} failed: ${(e as Error).message}`);
          failed = e;
        }
        await w.refreshVaults().catch((e) => {
          if (this.isFatal(e)) throw e;
        });
        have = w.vault(region) - this.floorIn(region);
        if (have >= amount) break;
        // It may have gone through: don't stack another remit on it; the caller asks again next tick.
        if (failed !== null && outcomeUnknown(failed)) break;
      }
    }
    if (have < amount && opts.essential) {
      // Stores to sail safely are what the floor is kept for: they may use it, down to a day's upkeep at
      // home and a day's warehouse rent anywhere.
      const keep = (region === this.homeRegion ? Math.min(this.homeFloor(), Math.ceil(this.upkeepPerDay())) : 0) + Math.ceil(this.bills.rent.get(region) ?? 0);
      return Math.max(0, w.vault(region) - keep);
    }
    return Math.max(0, have);
  }

  private spareCash(): number {
    let n = 0;
    // A region in debt (dues it couldn't cover) is swept from the others: it counts against them.
    for (const [r, v] of this.world.vaults) n += v < 0 ? v : Math.max(0, v - this.floorIn(r));
    return n;
  }

  /**
   * Idle vault cash above the Crown's wealth-levy threshold (pence; guide 3.12): every region's vault together (escrow,
   * loans out, deposits, stakes and goods are exempt), as last read. What idle-cash handling may put to work.
   */
  idleExcess(): number {
    let cash = 0;
    for (const v of this.world.vaults.values()) cash += v;
    return Math.max(0, cash - WEALTH_LEVY_THRESHOLD_PENCE);
  }

  /** The wealth levy the idle excess pays a game day (pence). */
  levyPerDay(): number {
    return Math.round((this.idleExcess() * WEALTH_LEVY_BPS_PER_DAY) / 10_000);
  }

  // ── Loans (liens and arrests) ───────────────────────────────────────────────

  /**
   * Our loans as borrower that can hold a ship (GET /v1/loan/list, `active` and `defaulted`; guide 3.13.1): a lien and
   * an arrest live there, not on the ship. Read at most every `maxAgeMs` (a loan event forces the next read); one
   * read at a time. A failed read keeps the last; null with none to keep.
   */
  async borrowerLoans(maxAgeMs = LOANS_TTL_MS): Promise<Loan[] | null> {
    return (await this.readLoans(maxAgeMs))?.loans ?? null;
  }

  /**
   * Our loans, `active` and `defaulted`, as borrower (`loans`) and as lender (`lent`), read together at most every
   * `maxAgeMs` (a loan event forces the next read); one read at a time; each one's record (loanRecs) follows. A failed
   * read keeps the last; null with none to keep.
   */
  private async readLoans(maxAgeMs: number): Promise<{ at: number; loans: Loan[]; lent: Loan[] } | null> {
    const c = this.loansCache;
    if (c && !this.loansDirty && Date.now() - c.at < maxAgeMs) return c;
    this.loansReading ??= (async () => {
      const started = Date.now();
      try {
        const lists = await Promise.all([
          this.client.loanPages({ role: "borrower", status: "active" }),
          this.client.loanPages({ role: "borrower", status: "defaulted" }),
          this.client.loanPages({ role: "lender", status: "active" }),
          this.client.loanPages({ role: "lender", status: "defaulted" }),
        ]);
        const [active, defaulted, lentActive, lentDefaulted] = lists;
        this.loansDirty = false;
        this.loansCache = { at: Date.now(), loans: [...active.items, ...defaulted.items], lent: [...lentActive.items, ...lentDefaulted.items] };
        for (const l of [...this.loansCache.loans, ...this.loansCache.lent]) this.noteLoan(l);
        // A record still open that no longer lists (read in full, not seen since the read began) has closed meanwhile.
        if (lists.every((x) => x.complete)) {
          const listed = new Set([...this.loansCache.loans, ...this.loansCache.lent].map((l) => l.id));
          for (const [id, r] of this.loanRecs) {
            if ((r.status === "active" || r.status === "defaulted") && !listed.has(id) && r.seen < started) this.loanRecs.set(id, { ...r, status: "closed", owed: 0, accrued: 0 });
          }
        }
        return this.loansCache;
      } catch (e) {
        if (this.isFatal(e)) throw e;
        return this.loansCache ?? null;
      } finally {
        this.loansReading = null;
      }
    })();
    return this.loansReading;
  }

  /**
   * Our ships held by our loans, by ship id: `liened` (pledged to a loan still owed: it can't be listed, sold, pledged
   * again or carry a venture until repaid) and `arrested` (a defaulted loan's pledge whose seizure is pending: it can't
   * depart or join a convoy). Null when our loans can't be read.
   */
  async shipPledges(maxAgeMs = LOANS_TTL_MS): Promise<{ liened: Map<string, Loan>; arrested: Map<string, Loan> } | null> {
    const loans = await this.borrowerLoans(maxAgeMs);
    if (!loans) return null;
    const liened = new Map<string, Loan>();
    const arrested = new Map<string, Loan>();
    for (const l of loans) {
      const ship = l.collateral_ship_id;
      if (l.collateral_kind !== "ship_lien" || !ship || !SHIP_HELD.has(l.collateral_status)) continue;
      liened.set(ship, l);
      if (l.status === "defaulted") arrested.set(ship, l);
    }
    return { liened, arrested };
  }

  /** Whether one of our loans holds a lien on this ship (null: unknown). A ship sale or listing (and a new pledge) must check it first. */
  async isLiened(shipId: string, maxAgeMs = LOANS_TTL_MS): Promise<boolean | null> {
    const p = await this.shipPledges(maxAgeMs);
    return p ? p.liened.has(shipId) : null;
  }

  async shipArrested(shipId: string, fresh = false): Promise<boolean | null> {
    const p = await this.shipPledges(fresh ? 0 : LOANS_TTL_MS);
    return p ? p.arrested.has(shipId) : null;
  }

  // ── Leverage and idle cash ──────────────────────────────────────────────────

  /** One of this player's companies (never our lender, borrower or rival). */
  private isOurCompany(id: string): boolean {
    return !!id && (this.ourCompanyIds.has(id) || this.world.rivals.ourIds.has(id));
  }

  /** Records a loan of ours as read (loan/list, or a loan event's payload): its state, and what ours was taken for. */
  private noteLoan(l: Loan, extra: { purpose?: string; use?: "hull" | "load"; source?: "board" | "goldsmiths" } = {}): void {
    if (typeof l.id !== "string") return;
    const role = this.isOurCompany(l.borrower_company_id) ? "borrower" : this.isOurCompany(l.lender_company_id) ? "lender" : null;
    if (!role) return;
    const prev = this.loanRecs.get(l.id);
    const t = (s: string | null | undefined) => {
      const x = Date.parse(s ?? "");
      return Number.isFinite(x) ? x : null;
    };
    this.loanRecs.set(l.id, {
      role,
      region: l.banking_region,
      principal: l.principal_pence,
      rateBps: l.daily_rate_bps,
      termDays: l.term_game_days,
      status: l.status,
      owed: l.owed_pence ?? 0,
      interestPaid: l.interest_paid_pence ?? 0,
      accrued: l.accrued_interest_pence ?? 0,
      maturesAt: t(l.matures_at),
      createdAt: t(l.created_at) ?? 0,
      kind: l.collateral_kind,
      ship: l.collateral_ship_id ?? null,
      purpose: extra.purpose ?? prev?.purpose,
      use: extra.use ?? prev?.use,
      source: extra.source ?? prev?.source,
      seen: Date.now(),
    });
    if (this.loanRecs.size > LOAN_RECS_MAX) this.pruneLoanRecs();
  }

  /** Closed loan records past keeping go, oldest first (their interest stays in the totals). */
  private pruneLoanRecs(): void {
    const open = (r: LoanRec) => r.status === "active" || r.status === "defaulted" || r.status === "offered";
    const closed = [...this.loanRecs].filter(([, r]) => !open(r)).sort((a, b) => a[1].seen - b[1].seen);
    for (const [id, r] of closed) {
      if (this.loanRecs.size <= LOAN_RECS_MAX && Date.now() - r.seen < LOAN_REC_KEEP_MS) break;
      if (r.role === "borrower") this.interestPaidBefore += r.interestPaid;
      else this.interestEarnedBefore += r.interestPaid;
      this.loanRecs.delete(id);
    }
  }

  /** A loan of ours as a call just returned it: the cached list follows at once (the cap and the fence count it before the next read). */
  private cacheLoan(l: Loan): void {
    const c = this.loansCache;
    if (!c) return;
    const owe = this.isOurCompany(l.borrower_company_id);
    const list = (owe ? c.loans : c.lent).filter((x) => x.id !== l.id);
    if ((l.status === "active" || l.status === "defaulted") && (!owe || l.owed_pence > 0)) list.push(l);
    if (owe) c.loans = list;
    else c.lent = list;
  }

  /** What a loan call with no answer may have borrowed (its principal): counted as owed until loan/list says. */
  private pendingBorrowPence(): number {
    return this.pendingCredit.filter((p) => p.kind === "borrow").reduce((n, p) => n + p.principal, 0);
  }

  /** What we owe on our loans now (principal and interest, as last read), with any loan call that had no answer. */
  private debtOwed(): number {
    return (this.loansCache?.loans ?? []).reduce((n, l) => n + Math.max(0, l.owed_pence), 0) + this.pendingBorrowPence();
  }

  /**
   * When a loan we owe is repaid in full by (server ms): REPAY_LEAD_DAYS before maturity; one the user took (no purpose
   * of ours) at most half its term before, so a short one isn't repaid the minute it is taken.
   */
  private repayDate(l: Loan, day: number): number | null {
    const term = l.term_game_days;
    const lead = this.loanRecs.get(l.id)?.purpose || !(term > 0) ? REPAY_LEAD_DAYS : Math.min(REPAY_LEAD_DAYS, term / 2);
    return repayBy(l, day, lead);
  }

  /**
   * Each loan we owe as the repayment it will take (guide 3.13.1): owed now plus interest until it is repaid in full,
   * by its repay date (repayDate; at once when defaulted or overdue). `exceptLoan`: one left out.
   */
  private debtFlows(now: number, exceptLoan?: string): Array<{ at: number; pence: number }> {
    const day = 24 * 60 * this.world.gameMinuteMs;
    const out: Array<{ at: number; pence: number }> = [];
    for (const l of this.loansCache?.loans ?? []) {
      if (!(l.owed_pence > 0) || l.id === exceptLoan) continue;
      const by = this.repayDate(l, day);
      const at = l.status === "defaulted" || by === null ? now : Math.max(now, by);
      out.push({ at, pence: owedAt(l, now, at, day) });
    }
    return out;
  }

  /**
   * What our loans will take to repay, and the builds of commissions we took and haven't delivered (their collateral
   * rides on them) (pence): never spent on hulls, marques, patrols, underwriting, lending or another commission.
   */
  private debtFence(): number {
    return this.debtFlows(this.world.now()).reduce((n, d) => n + d.pence, 0) + this.pendingBorrowPence() + this.commissionFence();
  }

  /** The build cost of commissions we took (or may have: an acceptance with no answer) and haven't delivered (pence). */
  private commissionFence(): number {
    let n = 0;
    for (const r of this.commissionRecs.values()) if (r.status === "accepting" || r.status === "accepted" || r.status === "delivering") n += Math.max(0, r.cost);
    return n;
  }

  /**
   * Of debtFence's loans, what cash due from our cargo at sea (at the share loads count on) landing before each
   * repayment doesn't cover, soonest repayment first: kept back from loads planned on cash in hand too (cashAt counts
   * the repayments as outflows itself). `exceptLoan`: one left out (a load's own loan, taken for it).
   */
  private fenceUncovered(exceptLoan?: string): number {
    const now = this.world.now();
    const debts = this.debtFlows(now, exceptLoan).sort((a, b) => a.at - b.at);
    let uncovered = this.pendingBorrowPence();
    if (debts.length === 0) return uncovered;
    const due = this.dueFlows();
    let i = 0;
    let pool = 0;
    for (const d of debts) {
      while (i < due.length && due[i].at <= d.at) pool += due[i++].pence;
      const take = Math.min(pool, d.pence);
      pool -= take;
      uncovered += d.pence - take;
    }
    return uncovered;
  }

  /**
   * Whether a loan may be asked for now, and the most principal that keeps what we owe (with the worst-case interest,
   * LOAN_INTEREST_HEADROOM) within maxDebtPct of net worth (pence), or why not: leverage on, the key's treasury_remit,
   * the world not paused nor the season ending, our loans read, none overdue or defaulted, no repayment short, no loan
   * call unanswered, under MAX_ACTIVE_LOANS, no idle cash of ours on offer, net worth read lately, no refusal lately.
   * As last read (borrow() reads again).
   */
  private leverageRoom(): { pence: number; why: string | null } {
    const s = this.settings;
    const w = this.world;
    const no = (why: string) => ({ pence: 0, why });
    if (!s.leverage) return no("leverage is off");
    if (!this.canRemit) return no("the key lacks treasury_remit");
    if (this.paused || this.stopRequested) return no("the world is paused");
    if (w.seasonMode() !== "normal") return no("the season is ending: no new loans");
    const c = this.loansCache;
    if (!c) return no("our loans haven't been read yet");
    const now = w.now();
    if (c.loans.some((l) => l.status === "defaulted" || (l.owed_pence > 0 && Date.parse(l.matures_at ?? "") <= now))) return no("a loan of ours is overdue or defaulted");
    if (this.debtShort) return no(`a repayment is short (${this.debtShort})`);
    if (this.pendingCredit.some((p) => p.kind === "borrow")) return no("a loan call had no answer: reconciling it from our loans first");
    if (c.loans.filter((l) => l.status === "active").length >= MAX_ACTIVE_LOANS) return no(`we already owe on ${MAX_ACTIVE_LOANS} loans`);
    if (Date.now() < this.borrowRetryAt) return no("no lender fitted, or one refused, lately");
    // Never borrowed while our own idle cash is on offer on a board: it is taken back first (runIdleCash, soon).
    if (this.ourOffers.size > 0 || this.pendingCredit.some((p) => p.kind === "post")) {
      this.financeDirty = true;
      return no("our idle cash is on the credit board: taking it back before borrowing");
    }
    if (!this.worth || this.worth.pence <= 0) return no("net worth isn't known yet");
    if (Date.now() - this.worth.at > 3 * WORTH_TTL_MS) return no("net worth hasn't been read lately");
    const room = (this.worth.pence * s.maxDebtPct) / 100 - this.debtOwed();
    const pence = Math.floor(room / (1 + LOAN_INTEREST_HEADROOM));
    return pence >= LOAN_MIN_PRINCIPAL_PENCE ? { pence, why: null } : no(`what we owe is at the ${s.maxDebtPct}%-of-net-worth cap`);
  }

  /**
   * The most one loan in `region` is likely to bring (pence): the Goldsmiths' per-loan cap, or more when the region's
   * board (read in the last half hour) shows a rival offer at or under the Goldsmiths' rate with more to lend.
   */
  private lendable(region: BankingRegion): number {
    const seen = this.boardSeen.get(region);
    const fresh = seen && Date.now() - seen.at < 30 * 60_000 ? seen.board.offers : [];
    const board = fresh.filter((o) => o.status === "open" && o.daily_rate_bps <= GOLDSMITHS_RATE_BPS && !this.isOurCompany(o.lender_company_id)).map((o) => o.available_pence);
    return Math.max(GOLDSMITHS_MAX_PRINCIPAL_PENCE, ...board);
  }

  /**
   * Our ships a lien may go on, least likely lost first (guide 3.13.1): not gone, arrested, sunk, in a convoy (or asking
   * to join one), already pledged, listed for sale or insured (a strict read: unknown counts as insured); ranked by the
   * piracy and storm losses of their lane (they sail only rated water), one at sea now after those in port. `value`: our
   * estimate of its rebuild value (the cheapest quote seen). Empty when our loans or the ship listings can't be read.
   */
  private async pledgeCandidates(): Promise<Array<{ agent: ShipAgent; value: number; risk: number }>> {
    // borrow() has just read our loans.
    const pledges = await this.shipPledges(30_000);
    if (!pledges) return [];
    const listed = await this.client.shipListingPages({}, 5).catch((e) => {
      if (this.isFatal(e) || isApiError(e, "world_paused")) throw e;
      return null;
    });
    if (!listed?.complete) return [];
    const forSale = new Set(listed.items.filter((x) => x.status === "open" && this.isOurCompany(x.seller_company_id)).map((x) => x.ship_id));
    const out: Array<{ agent: ShipAgent; value: number; risk: number }> = [];
    for (const a of this.agents.values()) {
      const r = a.last;
      if (a.gone || a.arrested || !r || r.ship.status === "sunk" || r.ship.convoy_id || pledges.liened.has(a.shipId) || forSale.has(a.shipId)) continue;
      if ((await a.insuredPolicy(60_000, true)) !== null) continue;
      const lane = a.lane;
      const risk = (lane ? (lane.piracyBps ?? 0) + (lane.stormBps ?? 0) : 0) + (r.ship.status === "sailing" ? 100 : 0);
      out.push({ agent: a, value: this.hullValue(a.shipClass), risk });
    }
    return out.sort((x, y) => x.risk - y.risk || y.value - x.value);
  }

  /**
   * Takes a loan of `principal` in `region` (guide 3.13): the cheapest standing credit-board offer that fits (never ours,
   * never above the Goldsmiths' rate; unsecured, or a lien on the ship of ours least likely lost), else the Goldsmiths'
   * backstop against such a ship; for the term its payback needs (loanCase), and only when it earns minLoanReturnX
   * its interest over it. Saved as sent, and written, before the call: one with no answer is reconciled from loan/list
   * and never asked again. Hold the cash lock (the money is spent under it).
   */
  private async borrow(need: {
    purpose: string;
    use: "hull" | "load";
    region: BankingRegion;
    principal: number;
    paybackDays: number;
    returnOver: (termDays: number) => number;
  }): Promise<{ loan: Loan } | { why: string }> {
    const w = this.world;
    const s = this.settings;
    const principal = Math.max(LOAN_MIN_PRINCIPAL_PENCE, Math.ceil(need.principal));
    // Our loans afresh (one taken, repaid or defaulted meanwhile), then the gates and the cap on them. A failed read
    // hands back the last list: never borrowed on that.
    const asked = Date.now();
    const read = await this.readLoans(0);
    if (!read || read.at < asked) return { why: "our loans couldn't be read" };
    const room = this.leverageRoom();
    if (room.why) return { why: room.why };
    if (principal > room.pence) return { why: `${cr(principal)} would take what we owe past ${s.maxDebtPct}% of net worth (room for ${cr(room.pence)})` };
    const term0 = loanTerm(need.paybackDays);
    if (term0 === null) return { why: `it pays back in ~${need.paybackDays.toFixed(1)} game days: too slow for a loan of at most ${LOAN_MAX_TERM_DAYS} with half its term to spare` };
    // Every loan is repaid in full once the season's endgame starts: one that would still run then pays back too late.
    const dayMs = 24 * 60 * w.gameMinuteMs;
    if ((term0 - REPAY_LEAD_DAYS) * dayMs > w.seasonLeftMs() - SEASON_ENDGAME_MS) return { why: "the season's endgame starts before it would be repaid" };
    const ours = (id: string) => this.isOurCompany(id);
    const ships = await this.pledgeCandidates();
    const board = await this.client.creditBoard(need.region).catch((e) => {
      if (this.isFatal(e) || isApiError(e, "world_paused")) throw e;
      return null;
    });
    if (board) this.boardSeen.set(need.region, { at: Date.now(), board });
    type Pick = { source: "board"; offer: BoardOffer; ship: ShipAgent | null; rate: number; maxTerm: number } | { source: "goldsmiths"; ship: ShipAgent; rate: number; maxTerm: number };
    let pick: Pick | null = null;
    const top = ships.length ? Math.max(...ships.map((x) => x.value)) : null;
    for (const o of fittingOffers(board?.offers ?? [], { principal, termDays: term0, now: w.now(), ours, pledgeValue: top })) {
      // A lien: the least risky ship worth enough at the offer's loan-to-value cap (with a margin on our estimate).
      const ship = o.collateral_kind === "ship_lien" ? (ships.find((x) => principal <= ((o.max_ltv_bps ?? 0) * x.value * PLEDGE_VALUE_MARGIN) / 10_000)?.agent ?? null) : null;
      if (o.collateral_kind === "ship_lien" && !ship) continue;
      pick = { source: "board", offer: o, ship, rate: o.daily_rate_bps, maxTerm: o.max_term_game_days };
      break;
    }
    // The Goldsmiths' Company, unless the board is cheaper: its quote gives what it lends on each ship now.
    if (!pick || pick.rate >= GOLDSMITHS_RATE_BPS) {
      for (const x of ships.slice(0, 3)) {
        const q = await this.client.backstopQuote(x.agent.shipId, need.region).catch((e) => {
          if (this.isFatal(e) || isApiError(e, "world_paused")) throw e;
          return null;
        });
        if (!q || q.daily_rate_bps > GOLDSMITHS_RATE_BPS || q.max_principal_pence < principal || q.max_term_game_days < term0) continue;
        if (!pick || q.daily_rate_bps < pick.rate) pick = { source: "goldsmiths", ship: x.agent, rate: q.daily_rate_bps, maxTerm: q.max_term_game_days };
        break;
      }
    }
    if (!pick) {
      this.borrowRetryAt = Date.now() + BORROW_RETRY_MS;
      return {
        why: `no lender fits ${cr(principal)} for ${term0} game days in ${need.region} (no board offer at ${GOLDSMITHS_RATE_BPS} bps or less, and no ship of ours free to pledge that the Goldsmiths would lend that on)`,
      };
    }
    const c = loanCase({ principal, rateBps: pick.rate, paybackDays: need.paybackDays, returnOver: need.returnOver, minReturnX: s.minLoanReturnX, maxTermDays: pick.maxTerm });
    if (!c.ok) return { why: c.why };
    const pend: PendingCredit = { kind: "borrow", at: w.now(), region: need.region, principal, ship: pick.ship?.shipId, purpose: need.purpose, use: need.use, source: pick.source };
    this.pendingCredit.push(pend);
    this.persist(true);
    await this.journal?.flush();
    const lender = pick.source === "goldsmiths" ? "the Goldsmiths' Company" : "a credit-board offer";
    try {
      const loan =
        pick.source === "board"
          ? await this.client.takeLoanOffer({ offer_id: pick.offer.id, principal_pence: principal, term_game_days: c.termDays, ship_id: pick.ship?.shipId })
          : await this.client.borrowBackstop({ ship_id: pick.ship.shipId, banking_region: need.region, principal_pence: principal, term_game_days: c.termDays });
      this.pendingCredit = this.pendingCredit.filter((x) => x !== pend);
      this.noteLoan(loan, { purpose: need.purpose, use: need.use, source: pick.source });
      this.cacheLoan(loan);
      w.vaults.set(need.region, w.vault(need.region) + loan.principal_pence);
      this.loansDirty = true;
      this.financeDirty = true;
      this.log(
        "fleet",
        `borrowed ${cr(loan.principal_pence)} from ${lender} in ${need.region} at ${loan.daily_rate_bps} bps a game day for ${loan.term_game_days} game days` +
          `${pick.ship ? ` (${pick.ship.name} pledged)` : ""} for ${need.purpose}: at most ~${cr(c.interest)} interest against ~${cr(c.ret)} expected; ` +
          `repaid early from spare cash, and in full ${REPAY_LEAD_DAYS} game days before it matures`,
      );
      this.persist(true);
      return { loan };
    } catch (e) {
      const unknown = outcomeUnknown(e);
      if (!unknown) {
        this.pendingCredit = this.pendingCredit.filter((x) => x !== pend);
        this.persist();
      }
      if (this.isFatal(e) || isApiError(e, "world_paused")) throw e;
      const msg = (e as Error).message;
      if (unknown) {
        this.loansDirty = true;
        this.financeDirty = true;
        this.log("fleet", `borrowing ${cr(principal)} from ${lender} for ${need.purpose}: no answer (${msg}); looked for among our loans, never asked again`);
        return { why: "the loan call had no answer" };
      }
      this.borrowRetryAt = Date.now() + BORROW_RETRY_MS;
      this.log("fleet", `borrowing ${cr(principal)} from ${lender} for ${need.purpose} was refused: ${msg}`);
      return { why: `refused: ${msg}` };
    }
  }

  /** A load short of cash at its source: for CASH_SHORT_MS the fleet needs cash, and idle cash on offer comes back soon (runIdleCash). */
  private noteCashShort(): void {
    this.cashShortAt = Date.now();
    if (this.ourOffers.size > 0 || this.pendingCredit.some((p) => p.kind === "post")) this.financeDirty = true;
  }

  /**
   * At a load's source (resizeLaneNow), when cash is what limits it (the hold not nearly full, the plan using the cash
   * there is): the load planned again with what a loan could add (the debt cap's room, at most LOAN_MAX_LOAD_PENCE).
   * Kept only when the bigger load's extra cash profit is at least minLoanReturnX times the loan's interest (at the
   * Goldsmiths' rate, the worst case) over the term its delivery needs, paid back within half of it. The loan itself is
   * asked for as the load is bought (borrowForLoad). Null: no loan.
   */
  private async leveragedLoad(agent: ShipAgent, r: ShipResult, port: string, opts: PlanOptions, pick: Lane | undefined, room: number): Promise<Lane | null> {
    // An AI order to borrow for this ship's load: its sum in place of the usual cap (every other check stands).
    const order = this.moneyOrder("borrow_load", agent.shipId);
    const spec = this.specFor(agent, r);
    const limited = !!pick && pick.tons < spec.cap * 0.9 && pick.capital >= room * 0.9;
    // Cash limits this load: the fleet needs cash, so idle cash of ours on the credit board comes back (runIdleCash).
    if (limited) this.noteCashShort();
    const lev = this.leverageRoom();
    if (lev.why) {
      if (order) this.noteFinance(order, "unmet", this.levCode(lev.why), lev.why);
      return null;
    }
    if (pick && !limited) {
      if (order) this.noteFinance(order, "unmet", "not_needed", `cash doesn't limit the load at ${port}`);
      return null;
    }
    const extra = Math.min(lev.pence, order ? order.pence : LOAN_MAX_LOAD_PENCE);
    const base = opts.cashAt;
    const bigger: PlanOptions = { ...opts, cash: (opts.cash ?? 0) + extra, cashAt: base ? (at, src) => base(at, src) + extra : undefined };
    const lanes = await rankLanes(this.world, spec, port, this.reservations(agent), bigger);
    const here = lanes.filter((l) => l.source === port && !agent.isAvoided(l.key));
    const lane = here.find((l) => l.key === pick?.key) ?? here[0];
    if (!lane) {
      if (order) this.noteFinance(order, "unmet", "no_paying_lane", `no bigger load at ${port} pays`);
      return null;
    }
    const borrow = Math.ceil(lane.capital - room);
    if (borrow < LOAN_MIN_PRINCIPAL_PENCE) {
      if (order) this.noteFinance(order, "unmet", "not_needed", `cash covers the load at ${port}`);
      return null;
    }
    const gain = lane.cashProfit - Math.max(0, pick?.cashProfit ?? 0);
    const paybackDays = lane.deliverMs / (24 * 60 * this.world.gameMinuteMs);
    const c = loanCase({ principal: borrow, rateBps: GOLDSMITHS_RATE_BPS, paybackDays, returnOver: () => gain, minReturnX: this.settings.minLoanReturnX });
    if (!c.ok) {
      this.logOnceFor(`${agent.shipId}|loan|${lane.key}`, agent.name, `cash limits the load at ${port}; a loan of ${cr(borrow)} for more wouldn't pay: ${c.why}`);
      if (order) this.noteFinance(order, "unmet", "margin", c.why);
      return null;
    }
    this.log(
      agent.name,
      `cash limits the load at ${port}: planning ${loadText(lane)} to ${lane.dest} with up to ${cr(borrow)} borrowed as it is bought ` +
        `(+${cr(gain)} on the trip against at most ~${cr(c.interest)} interest over ${c.termDays} game days)${order ? " (the AI's order)" : ""}`,
    );
    if (order) this.noteFinance(order, "active");
    return { ...lane, borrow: { pence: borrow, gain, paybackDays, state: "planned" } };
  }

  /**
   * A load planned with a loan (leveragedLoad), short of cash as it is bought: borrowed now in its source's region, what
   * the whole load still to buy needs beyond `budget` (the first call short may be the dock's one-ton check), at most
   * what was planned, once whatever comes of it. Pence it adds to the budget. Holds the cash lock (loadBudget).
   */
  private async borrowForLoad(agent: ShipAgent, region: BankingRegion, budget: number): Promise<number> {
    const lane = agent.lane;
    const plan = lane?.borrow;
    if (!lane || !plan || plan.state !== "planned" || this.world.region(lane.source) !== region) return 0;
    const short = Math.ceil((this.committedBy(agent) - Math.max(0, budget)) * 1.01);
    if (short <= 0) return 0;
    const principal = Math.max(LOAN_MIN_PRINCIPAL_PENCE, Math.min(plan.pence, short));
    plan.state = "failed";
    const got = await this.borrow({
      purpose: `${loadText(lane)} ${lane.source} → ${lane.dest} (${agent.name})`,
      use: "load",
      region,
      principal,
      paybackDays: plan.paybackDays,
      // The extra profit the loan makes possible, pro rata when less is borrowed than planned.
      returnOver: () => (plan.gain * Math.min(principal, plan.pence)) / Math.max(plan.pence, 1),
    });
    const order = this.moneyOrder("borrow_load", agent.shipId);
    if ("why" in got) {
      this.log(agent.name, `no loan for the load at ${lane.source} (${got.why}): buying what cash covers`);
      if (order) this.noteFinance(order, "unmet", "no_lender", got.why);
      this.persist();
      return 0;
    }
    plan.state = "taken";
    plan.loanId = got.loan.id;
    if (order) this.noteFinance(order, "done");
    this.persist(true);
    return got.loan.principal_pence;
  }

  /**
   * Loans and idle cash (guide 3.12-3.14), every minute and soon after a loan event: our loans read (every pass while
   * any are out, else every 10 min), loan calls with no answer reconciled, net worth refreshed for the cap, what we owe
   * repaid, and idle cash lent or taken back. Never while paused (housekeeping stops before this).
   */
  private async runFinance(): Promise<void> {
    if (this.financeBusy) return;
    this.financeBusy = true;
    try {
      const c = this.loansCache;
      const busy = this.financeDirty || this.pendingCredit.length > 0 || this.ourOffers.size > 0 || !!c?.loans.length || !!c?.lent.length;
      const loans = await this.readLoans(busy ? 0 : LOANS_TTL_MS);
      this.financeDirty = false;
      this.financeAt = new Date().toISOString();
      if (!loans) {
        this.financeAction = "our loans couldn't be read";
        return;
      }
      this.reconcileBorrows();
      this.reviewMoneyOrders();
      for (const [id, until] of [...this.repayHold]) if (until <= Date.now()) this.repayHold.delete(id);
      await this.refreshWorth();
      if (!this.canRemit) {
        this.debtShort = null;
        this.financeAction = loans.loans.length ? "we owe on loans, but the key lacks treasury_remit: they must be repaid by hand" : "the key lacks treasury_remit: no loans, repayments or lending";
        this.idleAction = "off: the key lacks treasury_remit";
        return;
      }
      await this.repayLoans();
      await this.runIdleCash();
    } finally {
      this.financeBusy = false;
      this.persist();
    }
  }

  /**
   * A loan call with no answer, against loan/list: the loan it made (same principal and region, the ship it pledged,
   * created since) is ours and keeps what it was for; none after PENDING_CREDIT_MS, it wasn't made. Never asked again.
   */
  private reconcileBorrows(): void {
    // Given up only on a list read (successfully) PENDING_CREDIT_MS after the call: a failed read keeps the last list.
    const readAt = this.loansCache ? this.loansCache.at + this.world.skewMs : -Infinity;
    const loans = this.loansCache?.loans ?? [];
    for (const p of [...this.pendingCredit]) {
      if (p.kind !== "borrow") continue;
      const hit = loans.find(
        (l) =>
          l.principal_pence === p.principal &&
          l.banking_region === p.region &&
          (!p.ship || l.collateral_ship_id === p.ship) &&
          Date.parse(l.created_at) >= p.at - 120_000 &&
          !this.loanRecs.get(l.id)?.purpose,
      );
      if (hit) {
        this.pendingCredit = this.pendingCredit.filter((x) => x !== p);
        this.noteLoan(hit, { purpose: p.purpose, use: p.use, source: p.source });
        this.log("fleet", `the loan of ${cr(p.principal)} whose call had no answer was taken after all${p.purpose ? ` (for ${p.purpose})` : ""}: repaid like any other`);
      } else if (readAt - p.at > PENDING_CREDIT_MS) {
        this.pendingCredit = this.pendingCredit.filter((x) => x !== p);
        this.log("fleet", `the loan of ${cr(p.principal)} whose call had no answer isn't among our loans ${Math.round(PENDING_CREDIT_MS / 60_000)} min on: it wasn't taken`);
      }
    }
  }

  /** The hourly leaderboard (guide 3.17): rivals' net worth (with rival intel), and this company's own when it is the player's ranked one. */
  private noteLeaderboard(board: LeaderboardResult): void {
    if (this.settings.rivalIntel) this.world.rivals.observeLeaderboard(board);
    const refreshed = Date.parse(board.refreshed_at ?? "");
    if (board.you?.is_calling_company && Number.isFinite(refreshed)) this.boardWorth = { pence: board.you.net_worth_pence, refreshedAt: refreshed };
    // Recomputed hourly: looked at again just after the next refresh (server time to ours), not sooner than 5 min.
    const next = Date.parse(board.next_refresh_at ?? "");
    this.nextLeaderboardAt = Math.max(Date.now() + 5 * 60_000, Number.isFinite(next) ? next - this.world.skewMs + 30_000 : Date.now() + 3_600_000);
  }

  /**
   * Net worth for the debt cap (guide 3.17: cash and escrow, goods at base, hulls at build value, less owed, plus owed
   * to us): the hourly leaderboard's figure for this company while fresh (read when due, rival intel or not), else our
   * own estimate. Kept for WORTH_TTL_MS.
   */
  private async refreshWorth(): Promise<void> {
    if (this.worth && Date.now() - this.worth.at < WORTH_TTL_MS) return;
    const fresh = () => !!this.boardWorth && this.world.now() - this.boardWorth.refreshedAt < WORTH_BOARD_FRESH_MS;
    if (!fresh() && Date.now() >= this.nextLeaderboardAt) {
      const board = await this.client.leaderboard().catch((e) => {
        if (this.isFatal(e)) throw e;
        return null;
      });
      if (board) this.noteLeaderboard(board);
      else this.nextLeaderboardAt = Date.now() + 5 * 60_000;
    }
    if (fresh()) {
      this.worth = { pence: this.boardWorth!.pence, at: Date.now(), source: "leaderboard" };
      return;
    }
    const est = await this.estimateWorth().catch((e) => {
      if (this.isFatal(e) || isApiError(e, "world_paused")) throw e;
      return null;
    });
    if (est !== null) this.worth = { pence: est, at: Date.now(), source: "estimate" };
  }

  /**
   * Our own net-worth estimate (guide 3.17), on the low side: vaults and escrow, our hulls at the cheapest quote seen,
   * our own goods aboard (not freight) and in warehouses at base, less what we owe, plus what we are owed.
   */
  private async estimateWorth(): Promise<number> {
    const w = this.world;
    const [vaults, warehouses] = await Promise.all([this.client.vaults(), this.client.warehouses().catch(() => null)]);
    let n = vaults.vaults.reduce((s, v) => s + v.balance_pence, 0);
    for (const a of this.agents.values()) {
      const r = a.last;
      if (a.gone || !r || r.ship.status === "sunk") continue;
      n += this.hullValue(a.shipClass);
      for (const g of Object.keys(r.cargo_manifest)) n += a.ownTons(r, g) * w.basePrice(g);
    }
    for (const wh of warehouses ?? []) for (const i of wh.inventory ?? []) n += i.quantity * w.basePrice(i.commodity_id);
    for (const l of this.loansCache?.loans ?? []) n -= Math.max(0, l.owed_pence);
    for (const l of this.loansCache?.lent ?? []) n += Math.max(0, l.owed_pence);
    return Math.round(n);
  }

  /**
   * Repays what we owe (guide 3.13.1: interest to date first, then principal, from the loan's region). In full once a
   * loan reaches its repay date (repayDate: REPAY_LEAD_DAYS before maturity, half the term for a short one the user
   * took), defaulted (its claim: paying it frees an arrested ship) or the season
   * is ending, remitting from every region's spare; short, debtShort stops new spending (loads, hulls, marques, lending)
   * until it is paid. Otherwise (loans the autopilot took) early, dearest first, from spare cash beyond what the fleet's
   * loads are bound to buy, while no ship waits for cash to load (when one does, the cash works and loads never spend
   * what the repayment counts on: cashFlows); remitted for it only when the interest saved by the repay date beats the
   * fee. A repayment with no answer leaves its loan alone until our loans are read again.
   */
  private async repayLoans(): Promise<void> {
    const w = this.world;
    const now = w.now();
    const day = 24 * 60 * w.gameMinuteMs;
    const owe = (this.loansCache?.loans ?? []).filter((l) => (l.status === "active" || l.status === "defaulted") && l.owed_pence > 0);
    // The AI's orders to repay a loan early: one no longer owed is gone.
    const repayOrders = this.advisor.financeOrders().filter((o) => o.kind === "repay");
    for (const o of repayOrders) if (!owe.some((l) => l.id === o.ref)) this.noteFinance(o, "done", undefined, "no longer owed");
    if (owe.length === 0) {
      if (this.debtShort) {
        this.log("fleet", "the loan that was due is repaid: spending resumes");
        this.debtShort = null;
        this.cashArrived();
      }
      this.financeAction = this.pendingBorrowPence() > 0 ? "a loan call had no answer: looking for it among our loans" : "nothing owed";
      return;
    }
    const ending = w.seasonMode(now) !== "normal";
    const rows = owe
      .map((l) => {
        const by = this.repayDate(l, day);
        return { l, by, must: l.status === "defaulted" || ending || (by !== null && now >= by) };
      })
      .sort((a, b) => Number(b.must) - Number(a.must) || b.l.daily_rate_bps - a.l.daily_rate_bps || (a.by ?? Infinity) - (b.by ?? Infinity));
    // A ship waiting for cash to load: early repayment waits (the loads earn more than the interest saved).
    const scarce = [...this.agents.values()].some((a) => a.waitingForCash);
    let short: string | null = null;
    const did: string[] = [];
    for (const { l, by, must } of rows) {
      if ((this.repayHold.get(l.id) ?? 0) > Date.now()) continue;
      // Early only on loans the autopilot took (one the user took is theirs to repay before its repay date), and
      // not in the first minutes (its hull's or load's purchases come first); or one the AI orders repaid (never while
      // a ship waits for cash).
      const ordered = repayOrders.find((o) => o.ref === l.id);
      if (!must && ordered && scarce) this.noteFinance(ordered, "waiting", "cash", "a ship waits for cash to load");
      if (!must && (scarce || (!ordered && (!this.loanRecs.get(l.id)?.purpose || now - Date.parse(l.disbursed_at ?? l.created_at) < LOAN_EARLY_GRACE_MS)))) continue;
      const res = await this.withCash(async (): Promise<string | null> => {
        if (this.stopRequested || this.paused) return null;
        await w.refreshVaults();
        const region = l.banking_region;
        // A game day's interest more covers the whole sum whenever in the day the call lands.
        const full = owedAt(l, now, now + day, day);
        let amount: number;
        if (must) {
          amount = Math.min(full, await this.ensureCash(region, full, { fresh: true }));
        } else {
          let committed = 0;
          for (const a of this.agents.values()) committed += this.committedBy(a);
          const want = Math.min(full, Math.max(0, this.spareCash() - committed));
          const inRegion = Math.max(0, w.vault(region) - this.floorIn(region));
          const fee = Math.min(Infinity, ...[...w.vaults.keys()].filter((r) => r !== region).map((r) => w.remitBps(r, region)));
          const daysLeft = by === null ? 0 : Math.max(0, (by - now) / day);
          amount = want <= inRegion || !(l.daily_rate_bps * daysLeft > fee) ? Math.min(want, inRegion) : Math.min(want, await this.ensureCash(region, want, { fresh: true }));
        }
        const all = amount >= full;
        if (!all && amount < Math.min(l.owed_pence, MIN_REPAY_PENCE)) {
          if (ordered && !must) this.noteFinance(ordered, "waiting", "cash", "no spare cash after the fleet's loads");
          return must ? `${cr(l.owed_pence)} due in ${region}${by !== null ? ` by ${new Date(by).toISOString()}` : ""}, only ${cr(Math.max(0, amount))} to hand` : null;
        }
        const pay = all ? undefined : Math.floor(Math.min(amount, l.owed_pence));
        try {
          const after = await this.client.repayLoan(l.id, pay);
          this.noteLoan(after);
          this.cacheLoan(after);
          this.loansDirty = true;
          await w.refreshVaults().catch((e) => {
            if (this.isFatal(e)) throw e;
          });
          const rec = this.loanRecs.get(l.id);
          const left = Math.max(0, after.owed_pence);
          did.push(`repaid ${pay === undefined ? "in full" : cr(pay)}`);
          this.log(
            "fleet",
            `repaid ${pay === undefined ? "in full" : cr(pay)} on a loan of ${cr(l.principal_pence)} in ${region}${rec?.purpose ? ` (for ${rec.purpose})` : ""}` +
              `${left > 0 ? `; ${cr(left)} still owed` : ""}${must ? (l.status === "defaulted" ? " (its claim, after a default)" : ending ? " (the season is ending)" : " (due: its repay date before maturity)") : ` early, from spare cash${ordered ? " (the AI's order)" : ""}`}`,
          );
          if (ordered) this.noteFinance(ordered, left > 0 ? "active" : "done");
          this.persist(true);
          return must && left > 0 ? `${cr(left)} still owed in ${region}` : null;
        } catch (e) {
          if (this.isFatal(e) || isApiError(e, "world_paused")) throw e;
          if (outcomeUnknown(e)) {
            // It may have landed: the loan is read again before anything more is paid on it.
            this.repayHold.set(l.id, Date.now() + REPAY_HOLD_MS);
            this.loansDirty = true;
            this.log("fleet", `repaying a loan (${l.id.slice(0, 8)}): no answer (${(e as Error).message}); reading our loans again before paying more`);
            return null;
          }
          // 409: nothing owed (repaid meanwhile).
          if (isApiError(e) && e.status === 409) {
            this.loansDirty = true;
            return null;
          }
          this.log("fleet", `repaying a loan (${l.id.slice(0, 8)}) was refused: ${(e as Error).message}`);
          return must ? `the repayment was refused (${(e as Error).message})` : null;
        }
      });
      if (res && must) short ??= res;
    }
    if (short && short !== this.debtShort) {
      this.log("fleet", `WARNING: a loan due can't be repaid in full yet (${short}): no new loads, hulls, marques or lending until it is; remitting to its region`);
      this.advisor.trigger("a loan repayment is short");
    }
    const resumed = !short && !!this.debtShort;
    this.debtShort = short;
    // Spending stopped for it: ships waiting for cash look again.
    if (resumed) {
      this.log("fleet", "the loan that was due is repaid: spending resumes");
      this.cashArrived();
    }
    const owed = this.debtOwed();
    this.financeAction =
      did.length ? `${did.join(", ")}; ${cr(owed)} owed`
      : short ? `short: ${short}`
      : scarce ? `${cr(owed)} owed: a ship waits for cash, so it works until the repay date (2 game days before maturity)`
      : `${cr(owed)} owed (repaid in full by 2 game days before maturity)`;
  }

  /**
   * Idle cash (guide 3.12, 3.13.2): vault cash above the wealth levy's threshold, less IDLE_BUFFER_PENCE and never what
   * the fleet's loads or our loans need, is posted as one secured credit-board offer in the region holding the most
   * (ship liens at most IDLE_MAX_LTV_BPS of the pledge's value, with recourse) at or just under the best rival rate,
   * never under the levy's own. It is taken back when the fleet needs the cash (a ship waits for it, or a load at its
   * source was short of it lately: no loan is taken while it is out), while we owe on a loan, near the season's end,
   * when the excess falls under half what is posted, or (re-priced) when a rival undercuts it. Only offers we posted
   * are touched; never unsecured; bank deposits aren't made.
   */
  private async runIdleCash(): Promise<void> {
    const w = this.world;
    const s = this.settings;
    const ours = (id: string) => this.isOurCompany(id);
    // Our offers as each board shows them: one gone was lent out in full, withdrawn or lapsed.
    const regions = new Set<BankingRegion>([...this.ourOffers.values()].map((o) => o.region));
    for (const p of this.pendingCredit) if (p.kind === "post") regions.add(p.region);
    // A board that can't be read keeps our offers there as last seen: taking them back doesn't need it, posting waits.
    const unread: BankingRegion[] = [];
    for (const region of regions) {
      const board = await this.client.creditBoard(region).catch((e) => {
        if (this.isFatal(e) || isApiError(e, "world_paused")) throw e;
        return null;
      });
      if (!board) {
        unread.push(region);
        continue;
      }
      this.boardSeen.set(region, { at: Date.now(), board });
      const mine = board.offers.filter((o) => o.status === "open" && !!w.companyId && o.lender_company_id === w.companyId);
      for (const [id, o] of [...this.ourOffers]) {
        if (o.region !== region) continue;
        const b = mine.find((x) => x.id === id);
        if (b) this.ourOffers.set(id, { ...o, available: b.available_pence, rateBps: b.daily_rate_bps, expiresAt: Date.parse(b.expires_at) || null });
        else this.ourOffers.delete(id);
      }
      // A post with no answer: ours if the board shows it, else not made once the wait is up (never posted twice).
      for (const p of this.pendingCredit.filter((x) => x.kind === "post" && x.region === region)) {
        const b = mine.find((x) => !this.ourOffers.has(x.id) && x.available_pence <= p.principal && Date.parse(x.created_at) >= p.at - 120_000);
        if (b) {
          this.pendingCredit = this.pendingCredit.filter((x) => x !== p);
          this.ourOffers.set(b.id, { region, available: b.available_pence, rateBps: b.daily_rate_bps, expiresAt: Date.parse(b.expires_at) || null, at: Date.now() });
          this.log("fleet", `idle cash: the ${region} credit-board offer whose call had no answer is on the board after all (${cr(b.available_pence)} at ${b.daily_rate_bps} bps)`);
        } else if (w.now() - p.at > PENDING_CREDIT_MS) {
          this.pendingCredit = this.pendingCredit.filter((x) => x !== p);
          this.log("fleet", `idle cash: the ${region} credit-board offer whose call had no answer isn't on the board: taken as not posted (or lent out at once)`);
        }
      }
    }
    const { posted, committed, excess, target } = this.idleTarget();
    // A ship waiting for cash, loads bound to buy more than is spare, or a load found short of cash at its source lately.
    const needs = [...this.agents.values()].some((a) => a.waitingForCash) || this.spareCash() - committed < 0 || Date.now() - this.cashShortAt < CASH_SHORT_MS;
    const stop =
      !s.idleCash ? "idle-cash lending is off"
      : needs ? "the fleet needs the cash"
      : this.debtOwed() > 0 ? "we owe on a loan: repaying it comes first"
      : this.debtShort ? "a repayment is short"
      : w.seasonMode() !== "normal" ? "the season is ending"
      : posted > 0 && target < posted / 2 ? "the idle excess fell"
      : null;
    if (stop) {
      if (this.ourOffers.size) await this.withdrawOffers([...this.ourOffers.keys()], stop);
      this.idleAction = this.ourOffers.size ? `taking our offers back: ${stop}` : `nothing lent: ${stop}`;
      return;
    }
    // Undercut by a rival a while after posting: taken back, and posted again at the new rate.
    for (const [id, o] of [...this.ourOffers]) {
      const board = this.boardSeen.get(o.region)?.board;
      const want = board ? idleRate(board.offers, "ship_lien", ours) : o.rateBps;
      if (o.rateBps > want + 1 && Date.now() - o.at > IDLE_REPRICE_MS) await this.withdrawOffers([id], `re-pricing it to ${want} bps a game day: a rival offers less`);
    }
    if (this.pendingCredit.some((p) => p.kind === "post")) {
      this.idleAction = "an offer's call had no answer: looking for it on the board";
      return;
    }
    if (unread.length) {
      this.idleAction = `the ${unread.join(", ")} credit board couldn't be read: nothing more posted`;
      return;
    }
    const now = [...this.ourOffers.values()].reduce((n, o) => n + o.available, 0);
    const add = target - now;
    if (add < IDLE_MIN_POST_PENCE || Date.now() < this.idleRetryAt) {
      this.idleAction =
        now > 0 ? `${cr(now)} on offer`
        : excess > 0 ? `${cr(excess)} above the levy's threshold: under the ${cr(IDLE_BUFFER_PENCE + IDLE_MIN_POST_PENCE)} it takes to post`
        : "no idle cash above the levy's threshold";
      return;
    }
    // Where the excess sits: the richest vault after its floor (the levy takes from the richest first).
    const richest = [...w.vaults].map(([r, v]) => [r, v - this.floorIn(r)] as const).sort((a, b) => b[1] - a[1])[0];
    if (richest) await this.postIdleOffer(richest[0], add);
  }

  /**
   * Idle cash as things stand: what is on offer (`posted`), the fleet's loads still to buy (`committed`), what would sit
   * above the levy's threshold with our offers back in the vaults (`excess`) and, of it, what the fleet's loads and our
   * loans don't need, less the buffer (`target`: what may be on offer in all).
   */
  private idleTarget(): { posted: number; committed: number; excess: number; target: number } {
    const posted = [...this.ourOffers.values()].reduce((n, o) => n + o.available, 0);
    let committed = 0;
    for (const a of this.agents.values()) committed += this.committedBy(a);
    const vaults = [...this.world.vaults.values()].reduce((n, v) => n + v, 0);
    const excess = vaults + posted - WEALTH_LEVY_THRESHOLD_PENCE;
    const free = this.spareCash() - committed - this.debtFence() + posted;
    return { posted, committed, excess, target: Math.max(0, Math.min(excess, free) - IDLE_BUFFER_PENCE) };
  }

  /** Posts one idle-cash offer of up to `want` on `region`'s credit board (runIdleCash), under the cash lock. */
  private async postIdleOffer(region: BankingRegion, want: number): Promise<void> {
    const w = this.world;
    const day = 24 * 60 * w.gameMinuteMs;
    await this.withCash(async () => {
      if (this.stopRequested || this.paused || !this.settings.idleCash) return;
      // A loan taken, a repayment gone short or a load found short of cash while waiting for the lock: nothing lent.
      if (this.debtOwed() > 0 || this.debtShort || Date.now() - this.cashShortAt < CASH_SHORT_MS) return;
      await w.refreshVaults();
      // Sized again on the vaults just read and the loads as they stand now (they may have bought or grown meanwhile).
      const t = this.idleTarget();
      const amount = Math.floor(Math.min(want, t.target - t.posted, w.vault(region) - this.floorIn(region)));
      if (amount < IDLE_MIN_POST_PENCE) return;
      // Its loans mature before the season ends (with the repay lead to spare), and it lapses before then too.
      const left = w.seasonLeftMs();
      const term = Math.min(IDLE_TERM_DAYS, Math.floor(left / day) - REPAY_LEAD_DAYS);
      const hours = Math.min(IDLE_EXPIRY_GAME_H, Math.floor(left / (60 * w.gameMinuteMs)));
      if (!(term >= 1) || !(hours >= 1)) return;
      const seen = this.boardSeen.get(region);
      const board =
        seen && Date.now() - seen.at < 60_000
          ? seen.board
          : await this.client.creditBoard(region).catch((e) => {
              if (this.isFatal(e) || isApiError(e, "world_paused")) throw e;
              return null;
            });
      if (!board) return;
      this.boardSeen.set(region, { at: Date.now(), board });
      const rate = idleRate(board.offers, "ship_lien", (id) => this.isOurCompany(id));
      const pend: PendingCredit = { kind: "post", at: w.now(), region, principal: amount };
      this.pendingCredit.push(pend);
      this.persist(true);
      await this.journal?.flush();
      try {
        const o = await this.client.postLoanOffer({
          banking_region: region,
          available_pence: amount,
          min_principal_pence: Math.min(amount, IDLE_MIN_LOAN_PENCE),
          daily_rate_bps: rate,
          max_term_game_days: term,
          collateral_kind: "ship_lien",
          max_ltv_bps: IDLE_MAX_LTV_BPS,
          recourse: true,
          expires_in_game_hours: hours,
        });
        this.pendingCredit = this.pendingCredit.filter((x) => x !== pend);
        this.ourOffers.set(o.id, { region, available: o.available_pence, rateBps: o.daily_rate_bps, expiresAt: Date.parse(o.expires_at) || null, at: Date.now() });
        w.vaults.set(region, w.vault(region) - amount);
        this.idleAction = `${cr(amount)} offered in ${region} at ${rate} bps a game day`;
        this.log(
          "fleet",
          `idle cash: offered ${cr(amount)} on the ${region} credit board at ${rate} bps a game day (loans of up to ${term} game days against a lien on a ship, ` +
            `at most ${IDLE_MAX_LTV_BPS / 100}% of its value, with recourse); lent cash isn't levied (the levy is 10 bps a game day)`,
        );
        this.persist(true);
      } catch (e) {
        const unknown = outcomeUnknown(e);
        if (!unknown) {
          this.pendingCredit = this.pendingCredit.filter((x) => x !== pend);
          this.persist();
        }
        if (this.isFatal(e) || isApiError(e, "world_paused")) throw e;
        if (unknown) {
          this.log("fleet", `idle cash: the ${region} credit-board offer had no answer (${(e as Error).message}); looking for it on the board, never posted again`);
          return;
        }
        this.idleRetryAt = Date.now() + IDLE_RETRY_MS;
        this.log("fleet", `idle cash: the ${region} credit-board offer was refused: ${(e as Error).message}`);
      }
    });
  }

  /** Takes our idle-cash offers off the board (what they had left comes back to the vault), under the cash lock. */
  private async withdrawOffers(ids: string[], why: string): Promise<void> {
    let back = 0;
    await this.withCash(async () => {
      for (const id of ids) {
        const o = this.ourOffers.get(id);
        if (!o) continue;
        try {
          await this.client.withdrawBoardEntry(id);
          this.ourOffers.delete(id);
          back += o.available;
        } catch (e) {
          if (this.isFatal(e) || isApiError(e, "world_paused")) throw e;
          // Not open any more (lent out in full, or lapsed): gone. No answer: the board says at the next pass.
          if (isApiError(e) && e.status === 409) this.ourOffers.delete(id);
          else this.log("fleet", `idle cash: taking back our offer (${id.slice(0, 8)}) failed: ${(e as Error).message}`);
        }
      }
      if (back > 0) {
        await this.world.refreshVaults().catch((e) => {
          if (this.isFatal(e)) throw e;
        });
      }
    });
    if (back > 0) {
      this.log("fleet", `idle cash: took ${cr(back)} back from the credit board (${why})`);
      this.persist(true);
      this.cashArrived();
    }
  }

  /** Leverage and idle cash for the panel. */
  private financeReport(): FinanceReport {
    const w = this.world;
    const s = this.settings;
    const day = 24 * 60 * w.gameMinuteMs;
    const row = (l: Loan): FinanceLoanRow => {
      const by = this.repayDate(l, day);
      return {
        id: l.id,
        region: l.banking_region,
        principalPence: l.principal_pence,
        owedPence: l.owed_pence,
        rateBps: l.daily_rate_bps,
        status: l.status,
        maturesAt: l.matures_at ?? null,
        repayBy: by !== null ? new Date(by).toISOString() : null,
        purpose: this.loanRecs.get(l.id)?.purpose ?? null,
        collateral: l.collateral_kind,
        shipId: l.collateral_ship_id ?? null,
      };
    };
    const borrowed = (this.loansCache?.loans ?? []).filter((l) => l.owed_pence > 0).map(row);
    const lent = (this.loansCache?.lent ?? []).map(row);
    const recs = [...this.loanRecs.values()];
    const open = (r: LoanRec) => r.status === "active" || r.status === "defaulted";
    const interest = (role: LoanRec["role"]) => recs.filter((r) => r.role === role).reduce((n, r) => n + r.interestPaid + (open(r) ? r.accrued : 0), 0);
    const by = borrowed.map((b) => Date.parse(b.repayBy ?? "")).filter((x) => Number.isFinite(x));
    return {
      checkedAt: this.financeAt,
      leverage: s.leverage,
      idleCash: s.idleCash,
      netWorthPence: this.worth?.pence ?? null,
      worthSource: this.worth?.source ?? null,
      debtPence: this.debtOwed(),
      capPence: this.worth ? Math.round((this.worth.pence * s.maxDebtPct) / 100) : null,
      // What our loans alone keep back (debtFence also holds commission builds).
      fencePence: Math.round(this.debtFence() - this.commissionFence()),
      borrowed,
      nextRepayBy: by.length ? new Date(Math.min(...by)).toISOString() : null,
      interestPaidPence: this.interestPaidBefore + interest("borrower"),
      interestEarnedPence: this.interestEarnedBefore + interest("lender"),
      lent,
      offers: [...this.ourOffers].map(([id, o]) => ({ id, region: o.region, availablePence: o.available, rateBps: o.rateBps, expiresAt: o.expiresAt ? new Date(o.expiresAt).toISOString() : null })),
      idleExcessPence: this.idleExcess(),
      short: this.debtShort,
      pending: this.pendingCredit.length,
      action: this.financeAction,
      idle: this.idleAction,
    };
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
   * spend, when it buys; what our loans take to repay, by 2 game days before each matures; and (at
   * cashDuePct) what our cargo at sea is due to be paid where it lands, less any shortfall under that
   * region's floor (refilled first). Nothing due counts as in hand.
   */
  private cashFlows(except?: ShipAgent): CashFlow[] {
    const w = this.world;
    const now = w.now();
    const flows: CashFlow[] = [];
    for (const a of this.agents.values()) {
      const out = a === except ? 0 : this.committedBy(a);
      if (out > 0) flows.push({ at: this.buyTime(a, now), pence: -out, region: null });
    }
    // A load never spends what a repayment counts on, unless cash due lands before it (guide 3.13.1: owed at maturity).
    for (const d of this.debtFlows(now)) flows.push({ at: d.at, pence: -d.pence, region: null });
    // Nor a commission's build we owe (its collateral is forfeit undelivered).
    const builds = this.commissionFence();
    if (builds > 0) flows.push({ at: now, pence: -builds, region: null });
    flows.push(...this.dueFlows(except));
    return flows.sort((x, y) => x.at - y.at);
  }

  /** Cash due from our cargo at sea (cashFlows' inflows, at cashDuePct), time-ordered. */
  private dueFlows(except?: ShipAgent): CashFlow[] {
    const w = this.world;
    const now = w.now();
    const flows: CashFlow[] = [];
    const share = this.settings.resizeLoads ? this.settings.cashDuePct / 100 : 0;
    if (share > 0) {
      // Paid where each passage ends; freight collateral back to the region it was escrowed from.
      const due = [...this.agents.values()]
        .filter((a) => a !== except && !a.gone)
        .map((a) => a.proceedsAboard())
        .filter((p): p is NonNullable<typeof p> => p !== null)
        .flatMap((p) => [{ at: p.at, region: w.region(p.dest), pence: p.pence }, ...p.back.map((b) => ({ at: p.at, region: b.region, pence: b.pence }))])
        .filter((p) => p.pence > 0)
        .sort((x, y) => x.at - y.at);
      const short = new Map<BankingRegion, number>();
      for (const p of due) {
        const region = p.region;
        // A vault in debt already counts against the spare cash (spareCash): only the floor is refilled here.
        const gap = short.get(region) ?? Math.max(0, this.floorIn(region) - Math.max(0, w.vault(region)));
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
    // A repayment due that cash can't cover: no new spending until it is paid (runFinance remits to it).
    if (this.debtShort) return 0;
    if (!this.settings.resizeLoads) {
      // As before, but never what our loans will take to repay.
      const fence = this.debtFence();
      if (fence <= 0) return this.ensureCash(region, amount);
      const cap = Math.max(0, this.spareCash() - fence);
      return Math.min(cap, await this.ensureCash(region, Math.min(amount, cap)));
    }
    await this.world.refreshVaults();
    const spare = this.spareCash();
    // First call on its own plan's cash in hand (ownFloor: never what our loans' repayments need); beyond that never
    // what our other ships' loads count on.
    let budget = Math.max(this.cashAt(this.cashFlows(agent), this.world.now(), region, spare), this.ownFloor(agent, spare));
    // A load planned at its source with a loan (leveragedLoad): borrowed now, for what cash leaves short of it (once).
    if (budget < amount) budget += await this.borrowForLoad(agent, region, budget);
    if (budget <= 0) return 0;
    return Math.min(budget, await this.ensureCash(region, Math.min(amount, budget), { fresh: true }));
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
      bills: {
        upkeepPerDay: Math.round(this.upkeepPerDay()),
        rent: [...this.bills.rent].filter(([, p]) => p > 0),
        homeFloor: this.homeRegion ? this.floorIn(this.homeRegion) : this.homeFloor(),
        measuredAt: this.bills.at,
      },
      autoRemit: this.autoRemit ? { ...this.autoRemit } : null,
      levy: { thresholdPence: WEALTH_LEVY_THRESHOLD_PENCE, excessPence: this.idleExcess(), perDayPence: this.levyPerDay() },
    };
  }

  // ── Letters of marque ───────────────────────────────────────────────────────

  /**
   * Our own ships per sea zone, a game day: `exposure` (cargo value × game days in the zone × gun deterrence)
   * and `risk`, what they lose per unit of zone piracy (the cargo pirates seize, and the hull and guns when
   * they take the ship, as the pirates' pull on that cargo draws them): a marque raises piracy on our
   * passages too.
   */
  private async ownExposure(): Promise<Map<string, { exposure: number; risk: number }>> {
    const w = this.world;
    const out = new Map<string, { exposure: number; risk: number }>();
    const add = (zone: string, exposure: number, risk: number) => {
      const x = out.get(zone) ?? { exposure: 0, risk: 0 };
      out.set(zone, { exposure: x.exposure + exposure, risk: x.risk + risk });
    };
    const dayMs = 24 * 60 * w.gameMinuteMs;
    const take = w.raidTake;
    for (const a of this.agents.values()) {
      const lane = a.lane;
      const knots = ((w.shipClass(a.shipClass)?.base_speed_centiknots ?? 800) / 100) * 0.85;
      const guns = a.last?.ship.cannons_count ?? 0;
      const det = 1 / (1 + 0.5 * guns);
      const capture = w.capturePerRaid(guns);
      const hull = this.hullValue(a.shipClass) + guns * GUN_PRICE_PENCE;
      // Per game day in the zone, at a whole unit of piracy.
      const lossPerDay = (value: number) => pirateAttention(value) * det * (value * seizedShare(take, capture) + hull * capture);
      if (!lane) {
        // No lane (yet): a ship at sea still carries its cargo through the rest of its voyage.
        const r = a.last;
        if (!r || r.ship.status !== "sailing") continue;
        const value = Object.entries(r.cargo_manifest).reduce((n, [g, t]) => n + t * w.basePrice(g), 0);
        if (value <= 0) continue;
        const rest = { legs: r.route_legs.slice(r.ship.current_leg_idx) };
        for (const [zone, days] of zoneDays(w.catalog, rest, knots)) add(zone, value * days * det, lossPerDay(value) * days);
        continue;
      }
      const plan = await w.route(lane.source, lane.dest, a.shipClass).catch(() => null);
      if (!plan) continue;
      // Goods at what they fetch or cost (whichever is more); sealed freight at ~3x its collateral.
      const value =
        lane.parts.reduce((n, p) => n + p.tons * Math.max(p.costPerTon, p.pay), 0) + lane.freight.reduce((n, f) => n + 3 * f.collateral, 0);
      const tripsPerDay = lane.loopMs > 0 ? dayMs / Math.max(lane.loopMs, 60_000) : 1;
      for (const [zone, days] of zoneDays(w.catalog, plan, knots)) add(zone, value * days * det * tripsPerDay, lossPerDay(value) * days * tripsPerDay);
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
    const factors = await client.factors().catch(() => null);
    if (factors) {
      this.factorCount = factors.length;
      this.factorPorts = factors;
    }
    for (const p of factors ?? []) ports.add(p);
    const intel = settings.rivalIntel;
    const [details, policies, forming, sailing, board] = await Promise.all([
      Promise.all([...ports].map((p) => client.port(p).catch(() => null))),
      intel ? client.policies({ limit: 200 }).catch(() => null) : null,
      intel ? client.convoyPages({ status: "forming" }).then((x) => x.items, () => null) : null,
      intel ? client.convoyPages({ status: "sailing" }).then((x) => x.items, () => null) : null,
      intel && Date.now() >= this.nextLeaderboardAt ? client.leaderboard().catch(() => null) : null,
    ]);
    for (const d of details) if (d) world.observeGossip(d);
    if (policies) world.rivals.addPolicies(policies);
    for (const list of [forming, sailing]) if (list) world.rivals.addConvoys(list);
    // Rival net worth, and our own for the debt cap.
    if (board) this.noteLeaderboard(board);
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
   * within the budget) sponsors the most profitable one for one game day. The game prices marques from
   * each zone's player traffic (guide 3.5: 60% of the prize money expected after the Admiral's tenth), so
   * the most promising zones by our own estimate are quoted (`marque-quote`), and one is issued only when
   * the quoted prize beats the quoted cost plus our own ships' extra losses there; never in a zone a voyage
   * we underwrite sails through (its claims would rise too), nor while our slices can't be read in full.
   */
  private async runMarques(): Promise<void> {
    const { world, client, settings } = this;
    if (!this.rivalAnalysis || Date.now() - this.rivalAnalysis.at > RIVAL_ANALYSIS_MAX_AGE_MS) await this.runRivals();
    const analysis = this.rivalAnalysis;
    if (!analysis) return;
    const now = world.now();
    const [zones, ours, patrols] = await Promise.all([client.zones(), this.recentMarques(now), this.recentPatrols(now)]);
    this.zoneStatus = { at: Date.now(), zones };
    this.ownNaval = { at: Date.now(), marques: ours, patrols };
    // One budget for the marques and the AI's patrols alike.
    const day = (x: { created_at: string }) => now - Date.parse(x.created_at) < 24 * 3_600_000;
    const patrolSpent = patrols.filter(day).reduce((n, p) => n + p.cost_pence, 0);
    const spent = ours.filter(day).reduce((n, m) => n + m.cost_pence, 0) + patrolSpent;
    const prize = ours.reduce((n, m) => n + m.prize_earned_pence, 0);
    const active = new Set(ours.filter((m) => Date.parse(m.expires_at) > now).map((m) => m.sea_zone_id));
    const traffic = analysis.zones;
    const own = await this.ownExposure();
    this.ownExposureSeen = new Map([...own].map(([z, x]) => [z, x.exposure]));
    // A marque raises the claims on the voyages we underwrite too: none where one of them sails (unknown: none at all).
    const book = await this.underwrittenZones();
    const left = Math.max(0, settings.marqueBudgetPence - spent);
    // Our own prize model takes the learned raid take and an unarmed hull's capture odds (rivals' guns aren't known).
    const model = { take: world.raidTake, capture: world.capturePerRaid(0) };

    const rows: MarqueZoneReport[] = [];
    for (const t of traffic) {
      const z = zones.find((x) => x.sea_zone_id === t.zone);
      if (!z || z.phase > world.unlockedPhase) continue;
      // What a marque bought now covers: the next game day. Sailings already announced there (rival intel)
      // stand in for it when they exceed the last day's.
      const exposure = settings.rivalIntel ? Math.max(t.exposure, t.next.exposure) : t.exposure;
      const laden = settings.rivalIntel ? Math.max(t.laden, t.next.laden) : t.laden;
      const best = bestMarque(z, exposure, own.get(t.zone)?.risk ?? 0, 1_500, model);
      const insured =
        book === null ? "our underwriting book couldn't be read in full (a marque would raise its claims)"
        : book.has(t.zone) ? "a voyage we underwrite sails through it (a marque would raise its claims)"
        : null;
      const verdict = active.has(t.zone)
        ? "our marque is in force"
        : insured
          ? insured
          : best.bps === 0
            ? "the zone's marques are at their cap"
            : laden < MARQUE_MIN_LADEN
              ? `too little laden traffic seen (${laden.toFixed(1)} a game day; needs ${MARQUE_MIN_LADEN})`
              : "";
      rows.push({ zone: t.zone, passages: t.passages, laden, cargo: Math.round(t.cargo), next: t.next, best, active: active.has(t.zone), verdict });
    }
    // The game's price for the most promising few (our estimate net of our own losses), sized to what the budget has left.
    const open = rows.filter((r) => r.verdict === "").sort((a, b) => b.best.profit - a.best.profit);
    for (const r of open.slice(MARQUE_QUOTE_ZONES)) r.verdict = "not quoted: other zones look better";
    for (const r of open.slice(0, MARQUE_QUOTE_ZONES)) {
      const z = zones.find((x) => x.sea_zone_id === r.zone)!;
      // Budget spent: still quoted (as big as the zone allows), so the dry run shows what would pay.
      const q = await this.quoteMarque(r.zone, ZONE_MARQUE_CAP - z.marque_piracy_bps, left >= MARQUE_MIN_PENCE ? left : Infinity, own.get(r.zone)?.risk ?? 0).catch(
        (e: unknown) => {
          if (this.isFatal(e)) throw e;
          return `quote failed: ${(e as Error).message}`;
        },
      );
      if (typeof q === "string") {
        r.verdict = q;
        continue;
      }
      r.best = { ...q, rivalPrize: r.best.prize };
      r.verdict = q.floor
        ? "the zone's traffic is worth less than the price floor"
        : q.profit <= 0
          ? `doesn't pay: quoted prize ~${cr(q.prize)} vs cost ${cr(q.cost)} + our losses ${cr(q.ownLoss)} a game day`
          : "pays";
    }
    rows.sort((a, b) => Number(!!b.best.quoted) - Number(!!a.best.quoted) || b.best.profit - a.best.profit);

    const pick = rows.find((r) => r.verdict === "pays");
    const cost = pick?.best.cost ?? 0;
    let action = rows.length === 0 ? "no rival traffic seen yet" : "no zone pays";
    // Our own exposure is only known once every ship has reported in.
    const unready = [...this.agents.values()].some((a) => !a.last);
    if (pick && !settings.marques) action = `off: would sponsor ${pick.best.bps} bps in ${pick.zone} for ${cr(cost)} (~${cr(pick.best.profit)} a game day)`;
    else if (pick && world.seasonMode() !== "normal") action = `the season ends in ~${Math.round(world.seasonLeftMs() / 3_600_000)} h: no new marques`;
    else if (pick && unready) action = "waiting for every ship to report before weighing our own losses";
    else if (pick && spent + cost > settings.marqueBudgetPence) action = `budget: ${cr(spent)} of ${cr(settings.marqueBudgetPence)} spent in the last 24 h`;
    else if (pick) {
      action = await this.withCash(async () => {
        // Anything may have changed while waiting for the lock: the setting, the budget, a stop.
        if (this.stopRequested || !this.settings.marques) return "cancelled: auto-marques were turned off";
        // issue-marque charges the quote as it stands then: priced again, and judged again on it.
        const q = await client.marqueQuote(pick.zone, pick.best.bps, MARQUE_GAME_HOURS);
        this.notePrice(q);
        const ownLoss = Math.round((own.get(pick.zone)?.risk ?? 0) * (q.added_piracy_bps / 10_000) * (MARQUE_GAME_HOURS / 24));
        if (q.expected_net_prize_pence - q.cost_pence - ownLoss <= 0) return `no longer pays at ${cr(q.cost_pence)} (quoted prize ~${cr(q.expected_net_prize_pence)})`;
        if (spent + q.cost_pence > this.settings.marqueBudgetPence) return `budget: ${cr(spent)} of ${cr(this.settings.marqueBudgetPence)} spent in the last 24 h`;
        // Only spare money: never what the fleet's loads need or our loans will take to repay, never by remitting.
        if ([...this.agents.values()].some((a) => a.waitingForCash)) return "a ship is waiting for cash: no marque";
        if (this.debtShort) return "a loan repayment is short: no marque";
        await world.refreshVaults();
        const home = this.homeRegion ?? "channel";
        let committed = 0;
        for (const a of this.agents.values()) committed += this.committedBy(a);
        if (this.spareCash() - committed - this.debtFence() < q.cost_pence || world.vault(home) - this.floorIn(home) < q.cost_pence) return `no spare cash for a ${cr(q.cost_pence)} marque`;
        try {
          const m = await client.issueMarque({ sea_zone_id: pick.zone, added_piracy_bps: q.added_piracy_bps, duration_game_hours: MARQUE_GAME_HOURS });
          const region = m.banking_region ?? home;
          world.vaults.set(region, world.vault(region) - m.cost_pence);
          const expect = m.pricing?.expected_net_prize_pence ?? q.expected_net_prize_pence;
          this.log("fleet", `letter of marque: +${m.added_piracy_bps} bps in ${pick.zone} for ${cr(m.cost_pence)} (the game expects ~${cr(expect)} prize after the Admiral's tenth, if traffic holds)`);
          this.worldDirty = true;
          pick.active = true;
          pick.verdict = "our marque is in force";
          return `sponsored ${m.added_piracy_bps} bps in ${pick.zone} for ${cr(m.cost_pence)}`;
        } catch (e) {
          if (this.isFatal(e)) throw e;
          this.log("fleet", `letter of marque in ${pick.zone} refused: ${(e as Error).message}`);
          return `marque refused: ${(e as Error).message}`;
        }
      }).catch((e: unknown) => {
        if (this.isFatal(e) || isApiError(e, "world_paused")) throw e;
        return `marque not issued: ${(e as Error).message}`;
      });
    }
    this.marqueReport = {
      checkedAt: new Date().toISOString(),
      enabled: settings.marques,
      budgetPence: settings.marqueBudgetPence,
      spentPence: spent,
      patrolSpentPence: patrolSpent,
      prizePence: prize,
      zones: rows,
      action,
    };
  }

  /**
   * A marque in `zone` for MARQUE_GAME_HOURS as the game prices it (`marque-quote`): the most bps the zone's cap
   * (`capBps` left) and `budget` allow at the quoted price (a quote's margin per bps is about flat, so the most
   * that fits earns most), with our own ships' extra losses there (`risk`: per unit of piracy a game day). A
   * string says why there is none.
   */
  private async quoteMarque(zone: string, capBps: number, budget: number, risk: number): Promise<MarqueOption | string> {
    const days = MARQUE_GAME_HOURS / 24;
    const top = Math.floor(Math.min(1_500, capBps) / 50) * 50;
    if (top < NAVAL_BPS_MIN) return "the zone's marques are at their cap";
    let q = await this.client.marqueQuote(zone, top, MARQUE_GAME_HOURS);
    this.notePrice(q);
    // Sized to what the budget has left at that price (a game day of it), not refused for being big.
    const fits = Number.isFinite(budget) ? Math.floor(budget / (Math.max(q.price_per_bps_day_pence, 0.1) * days) / 50) * 50 : top;
    const bps = Math.min(top, fits);
    if (bps < NAVAL_BPS_MIN) return `budget: 50 bps here costs more than the ${cr(budget)} left`;
    if (bps !== q.added_piracy_bps) {
      q = await this.client.marqueQuote(zone, bps, MARQUE_GAME_HOURS);
      this.notePrice(q);
    }
    if (q.cost_pence > budget) return `budget: ${q.added_piracy_bps} bps costs ${cr(q.cost_pence)}, more than the ${cr(budget)} left`;
    // The term is one game day (MARQUE_GAME_HOURS), so these are per game day as the report shows them.
    const ownLoss = Math.round(risk * (q.added_piracy_bps / 10_000) * days);
    return {
      bps: q.added_piracy_bps,
      prize: q.expected_net_prize_pence,
      cost: q.cost_pence,
      ownLoss,
      profit: q.expected_net_prize_pence - q.cost_pence - ownLoss,
      quoted: true,
      floor: q.floor_applied,
    };
  }

  /** Our patrols, paged back like our marques. */
  private async recentPatrols(now: number): Promise<NavalPatrol[]> {
    const out: NavalPatrol[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const batch = await this.client.patrols({ cursor, limit: 200 });
      out.push(...batch);
      if (batch.length < 200 || batch.some((p) => now - Date.parse(p.created_at) > 24 * 3_600_000)) break;
      cursor = batch[batch.length - 1].id;
    }
    return out;
  }

  /**
   * The AI's marques and patrols (live only). Each is checked against its zone (open, that side under its cap),
   * the season, the horizon left (the term is cut to it) and what the marque budget has left over the last 24 h
   * (our marques and patrols together), then issued under the cash lock from spare cash after the fleet's loads,
   * never by remitting. It is saved as being sent before the call; one whose call had no answer is never sent
   * again, only looked for among ours (and taken as not issued once AI_NAVAL_SETTLE_MS has passed).
   */
  private async runAiNaval(): Promise<void> {
    this.navalBusy = true;
    try {
      const { world, client } = this;
      const now = world.now();
      const [zones, marques, patrols] = await Promise.all([client.zones(), this.recentMarques(now), this.recentPatrols(now)]);
      this.zoneStatus = { at: Date.now(), zones };
      this.ownNaval = { at: Date.now(), marques, patrols };
      let spent = this.navalSpent() ?? 0;
      const claimed = new Set<string>();
      // As runMarques: no marque where a voyage we underwrite sails (unreadable book: none at all).
      const book = this.advisor.pendingNaval().some((o) => o.kind === "marque" && o.status !== "unknown") ? await this.underwrittenZones() : undefined;
      for (const o of this.advisor.pendingNaval()) {
        const label = `AI ${o.kind} (${o.bps} bps in ${o.zone})`;
        if (o.status === "unknown") {
          const sent = o.sentAt ?? 0;
          const ours =
            o.kind === "marque"
              ? marques.map((m) => ({ id: m.id, zone: m.sea_zone_id, bps: m.added_piracy_bps, at: Date.parse(m.created_at), cost: m.cost_pence }))
              : patrols.map((p) => ({ id: p.id, zone: p.sea_zone_id, bps: p.suppressed_piracy_bps, at: Date.parse(p.created_at), cost: p.cost_pence }));
          const hit = ours.find((x) => x.zone === o.zone && x.bps === o.bps && x.at >= sent - 60_000 && !claimed.has(x.id));
          if (hit) {
            claimed.add(hit.id);
            this.advisor.noteNaval(o.id, { status: "issued", issuedId: hit.id, costPence: hit.cost });
            this.log("fleet", `${label}: it was issued after all (${cr(hit.cost)})`);
          } else if (world.now() - sent > AI_NAVAL_SETTLE_MS) {
            this.advisor.noteNaval(o.id, { status: "refused", code: "unknown_outcome" });
            this.log("fleet", `${label}: not among ours ${Math.round(AI_NAVAL_SETTLE_MS / 60_000)} min after a call with no answer: taken as not issued (not sent again)`);
          }
          continue;
        }
        const refuse = (code: OrderCode, why: string) => {
          this.advisor.noteNaval(o.id, { status: "refused", code, note: why });
          this.log("fleet", `${label} refused: ${why}`);
        };
        const z = zones.find((x) => x.sea_zone_id === o.zone);
        // The term never outlives the advice that asked for it.
        const hours = Math.min(o.gameHours, Math.floor(((this.advisor.inForceUntil() ?? 0) - Date.now()) / (60 * world.gameMinuteMs)));
        const side = !z ? 0 : o.kind === "marque" ? z.marque_piracy_bps : z.patrol_suppression_bps;
        const budget = this.settings.marqueBudgetPence;
        if (world.seasonMode() !== "normal") refuse("season", "the season is about to end");
        else if (!z || z.phase > world.unlockedPhase) refuse("zone", "the zone isn't open");
        else if (side + o.bps > ZONE_MARQUE_CAP) refuse("cap", `the zone's ${o.kind}s are at ${side} of ${ZONE_MARQUE_CAP} bps`);
        else if (hours < NAVAL_TERM_MIN_H) this.advisor.noteNaval(o.id, { status: "lapsed", code: "horizon" });
        else if (o.kind === "marque" && (book === null || book?.has(o.zone)))
          refuse("underwritten", book === null ? "our underwriting slices couldn't be read in full" : "a voyage we underwrite sails through the zone");
        else if (o.kind === "patrol") {
          const cost = patrolCost(o.bps, hours);
          if (spent + cost > budget) refuse("budget", `${cr(spent)} of the ${cr(budget)} budget spent in the last 24 h`);
          else spent += await this.issueNaval(o, o.bps, hours, cost, label);
        } else {
          // The game prices a marque from the zone's traffic: quoted now and checked against the budget on that
          // price, cut in 50 bps steps to what it has left (issue-marque then charges its own quote at that moment).
          let q: MarqueQuote | null = null;
          try {
            q = await client.marqueQuote(o.zone, o.bps, hours);
            this.notePrice(q);
            const fits = Math.floor((budget - spent) / (Math.max(q.price_per_bps_day_pence, 0.1) * (hours / 24)) / 50) * 50;
            if (q.cost_pence > budget - spent && fits >= NAVAL_BPS_MIN && fits < q.added_piracy_bps) {
              q = await client.marqueQuote(o.zone, fits, hours);
              this.notePrice(q);
            }
          } catch (e) {
            if (this.isFatal(e) || isApiError(e, "world_paused")) throw e;
            // A transient failure is tried again on the next pass; a refusal ends it.
            if (outcomeUnknown(e) || (isApiError(e) && e.status === 429)) {
              this.advisor.noteNaval(o.id, { status: "pending", code: "server" });
              continue;
            }
            refuse("server", `the marque couldn't be priced: ${(e as Error).message}`);
            continue;
          }
          if (spent + q.cost_pence > budget) refuse("budget", `${q.added_piracy_bps} bps costs ${cr(q.cost_pence)} at the zone's price; ${cr(spent)} of the ${cr(budget)} budget spent in the last 24 h`);
          else {
            if (q.added_piracy_bps !== o.bps) this.log("fleet", `${label}: cut to ${q.added_piracy_bps} bps, what the budget left covers at the zone's price`);
            this.advisor.noteNaval(o.id, { bps: q.added_piracy_bps, costPence: q.cost_pence });
            spent += await this.issueNaval(o, q.added_piracy_bps, hours, q.cost_pence, label);
          }
        }
      }
    } finally {
      this.navalBusy = false;
    }
  }

  /** Sends one AI marque or patrol under the cash lock; returns what it spent (or may have: an unanswered call counts). */
  private async issueNaval(o: NavalOrder, bps: number, hours: number, cost: number, label: string): Promise<number> {
    const { world, client } = this;
    return this.withCash(async () => {
      // Anything may have changed while waiting for the lock (or the vaults below): the advice (superseded, cleared,
      // switched to shadow or off, the tripwire), a stop.
      const live = () => !this.stopRequested && this.advisor.pendingNaval().some((x) => x.id === o.id && x.status === "pending");
      if (!live()) return 0;
      const wait = (why: string) => {
        this.advisor.noteNaval(o.id, { status: "pending", code: "cash" });
        this.logOnceFor(`naval|${o.id}|cash`, "fleet", `${label}: waiting, ${why}`);
        return 0;
      };
      // Only spare money: never what the fleet's loads need or our loans will take to repay, never by remitting.
      if ([...this.agents.values()].some((a) => a.waitingForCash)) return wait("a ship is waiting for cash");
      if (this.debtShort) return wait("a loan repayment is short");
      await world.refreshVaults();
      if (!live()) return 0;
      const home = this.homeRegion ?? "channel";
      let committed = 0;
      for (const a of this.agents.values()) committed += this.committedBy(a);
      if (this.spareCash() - committed - this.debtFence() < cost || world.vault(home) - this.floorIn(home) < cost) return wait(`no spare ${cr(cost)} at home after the fleet's loads and our loans`);
      // Saved, and written, before the call: after a crash it is never sent twice.
      this.advisor.noteNaval(o.id, { status: "issuing", sentAt: world.now(), bps, gameHours: hours, costPence: cost, code: undefined });
      await this.journal?.flush();
      try {
        let id: string;
        let paid: number;
        let region: BankingRegion = home;
        if (o.kind === "marque") {
          // Charged at the zone's quote as it stands now (`pricing`), fixed for the term.
          const m = await client.issueMarque({ sea_zone_id: o.zone, added_piracy_bps: bps, duration_game_hours: hours });
          [id, paid, region] = [m.id, m.cost_pence, m.banking_region ?? home];
        } else {
          const p = await client.fundPatrol({ sea_zone_id: o.zone, suppressed_piracy_bps: bps, duration_game_hours: hours });
          [id, paid] = [p.id, p.cost_pence];
        }
        world.vaults.set(region, world.vault(region) - paid);
        this.advisor.noteNaval(o.id, { status: "issued", issuedId: id, costPence: paid });
        // Zone piracy (and so lanes and refits) changed.
        this.worldDirty = true;
        this.log("fleet", `${label}: issued for ${hours} game h, ${cr(paid)} (it runs its term; it can't be withdrawn)`);
        return paid;
      } catch (e) {
        if (this.isFatal(e)) throw e;
        if (isApiError(e, "world_paused") || (isApiError(e) && e.status === 429 && !outcomeUnknown(e))) {
          // Not done: tried again later.
          this.advisor.noteNaval(o.id, { status: "pending", code: "server" });
          if (isApiError(e, "world_paused")) throw e;
          return 0;
        }
        if (outcomeUnknown(e)) {
          this.advisor.noteNaval(o.id, { status: "unknown", code: "unknown_outcome", note: (e as Error).message });
          this.log("fleet", `${label}: no answer (${(e as Error).message}); never sent again, looked for among ours`);
          return cost;
        }
        this.advisor.noteNaval(o.id, { status: "refused", code: "server", note: (e as Error).message });
        this.log("fleet", `${label} refused by the game: ${(e as Error).message}`);
        return 0;
      }
    });
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
   * Sea zones the voyages we underwrite cross (open or active slices of any of our companies; runUnderwriting's read
   * while fresh, else read now): each policy's route for its class (from its hull value), else for every hull category
   * open now. Null when our slices can't be read in full or a policy can't be routed.
   */
  private async underwrittenZones(): Promise<Set<string> | null> {
    const w = this.world;
    let held = this.underwritten && Date.now() - this.underwritten.at < 3 * UNDERWRITE_CHECK_MS ? this.underwritten.policies : null;
    if (!held) {
      if (this.ourCompanyIds.size === 0) return null;
      const pages = await Promise.all(
        [...this.ourCompanyIds].flatMap((id) => (["open", "active"] as const).map((status) => this.client.policyPages({ underwriter_company_id: id, status }))),
      ).catch((e) => {
        if (this.isFatal(e) || isApiError(e, "world_paused")) throw e;
        return null;
      });
      if (!pages || !pages.every((x) => x.complete)) return null;
      held = pages.flatMap((x) => x.items);
      this.underwritten = { at: Date.now(), policies: held };
    }
    const out = new Set<string>();
    const quotes = this.knownQuotes();
    // One class of each hull category open now, for a policy whose class the hull value doesn't tell.
    const anyClass = [...new Map(w.catalog.ship_classes.filter((c) => c.phase <= w.unlockedPhase).map((c) => [c.hull_category, c.id])).values()];
    for (const p of held) {
      if (p.status !== "open" && p.status !== "active") continue;
      const cls = classOfHull(p.hull_value_pence, quotes, w.catalog);
      let routed = false;
      for (const c of cls ? [cls] : anyClass) {
        const plan = await w.route(p.origin_port_id, p.dest_port_id, c).catch(() => null);
        if (!plan) continue;
        routed = true;
        for (const z of zoneDays(w.catalog, plan, 1).keys()) out.add(z);
      }
      if (!routed) return null;
    }
    return out;
  }

  /**
   * Judges the open policies of other companies and (when enabled) writes slices on those whose
   * premium beats Lloyd's own expected-loss estimate on the listing (an upper bound) by the minimum
   * edge, within the budget, best margins first: checked every minute (sooner on a new listing), so a
   * fresh policy is written before Lloyd's looks at it an hour on.
   */
  private async runUnderwriting(): Promise<void> {
    const { world, client, settings } = this;
    if (!world.companyId) return;
    const [open, active, heldPages, vaults] = await Promise.all([
      client.policies({ status: "open", limit: 200 }),
      client.policies({ status: "active", limit: 200 }),
      // Slices any of our companies hold on a live policy: that cover says nothing about Lloyd's. Open before
      // active, so one setting sail meanwhile is still in one of them; every page, or nothing is written below.
      Promise.all(
        [...this.ourCompanyIds].map(async (id) => [
          await client.policyPages({ underwriter_company_id: id, status: "open" }),
          await client.policyPages({ underwriter_company_id: id, status: "active" }),
        ]),
      ).then((x) => x.flat()),
      client.vaults(),
    ]);
    const held = heldPages.flatMap((x) => x.items);
    // A slice of ours missed would be written on again (and its zone left out of the marque check): fail closed.
    const heldComplete = heldPages.every((x) => x.complete);
    if (heldComplete && this.ourCompanyIds.size > 0) this.underwritten = { at: Date.now(), policies: held };
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

    const toWrite = rows.filter((r) => r.sliceBps > 0 && r.verdict.startsWith("write"));
    let action = toWrite.length === 0 ? "nothing to write" : `off: would write ${toWrite.length} slice${toWrite.length === 1 ? "" : "s"}`;
    let lockedNow = locked;
    if (settings.underwrite && toWrite.length > 0 && !heldComplete) {
      action = `not writing this round: our own slices are too many to list in full (would write ${toWrite.length})`;
    } else if (settings.underwrite && toWrite.length > 0) {
      let written = 0;
      for (const r of toWrite) {
        const ok = await this.withCash(async () => {
          // Anything may have changed while waiting for the lock: the setting, the caps, a stop.
          if (this.stopRequested || !this.settings.underwrite) return false;
          if (r.collateral > this.settings.underwriteMaxPerPolicyPence || lockedNow + r.collateral > this.settings.underwriteBudgetPence) return false;
          if ([...this.agents.values()].some((a) => a.waitingForCash) || this.debtShort) return false;
          await world.refreshVaults();
          let committed = 0;
          for (const a of this.agents.values()) committed += this.committedBy(a);
          // Never what our loans will take to repay.
          if (this.spareCash() - committed - this.debtFence() < r.collateral) return false;
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
        else if (r.verdict.startsWith("write")) r.verdict = "no spare cash, or the budget changed";
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
   * What an own-materials build would cost here, from a turnkey quote: the labour, plus each material bought
   * on this port's market at the yard's own walk of the ask book (players' asks and the NPC ladder, cheapest
   * first: `cost_pence`) and the customs turnkey pays on every fill (`customs_pence`, never counted twice).
   * What it saves is the 15% markup turnkey charges on the NPC-sourced part (`npc_cost_pence`) only. Null when
   * a material can't be supplied.
   */
  private byomPrice(q: BuildQuote, yard: string): number | null {
    if (!q.total_cost_pence || q.materials.some((m) => !m.cost_pence)) return null;
    // A quote without per-material customs (an older server): the port's rate on the cost.
    const customs = (m: BuildQuote["materials"][number]) => m.customs_pence ?? Math.round(((m.cost_pence ?? 0) * this.world.customsBps(yard)) / 10_000);
    return Math.round(q.labour_pence + q.materials.reduce((n, m) => n + (m.cost_pence ?? 0) + customs(m), 0));
  }

  /** What own materials save over turnkey here: the yard's markup on the NPC-sourced part (players' asks carry none). */
  private byomSaving(q: BuildQuote, own: number | null): number {
    if (own === null || !q.total_cost_pence) return 0;
    const markup = q.yard_markup_pence ?? Math.round((q.materials.reduce((n, m) => n + (m.npc_cost_pence ?? 0), 0) * (q.yard_markup_bps ?? 1_500)) / 10_000);
    return Math.min(markup, q.total_cost_pence - own);
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
          let res: PlaceOrderResult;
          try {
            res = await this.client.placeOrder({ port_id: yard, commodity_id: m.commodity_id, side: "bid", time_in_force: "ioc", price_pence: perTon, quantity: left });
          } catch (e) {
            // A royal monopoly on the material (409 naming the holder): noted, and own-materials builds here rest a while
            // (turnkey then takes it only from players' asks, as its quote shows).
            if (isApiError(e) && e.status === 409 && (!!this.world.monopolyBars(yard, m.commodity_id) || /monopol/i.test(`${e.detail} ${e.message}`))) {
              this.world.noteMonopoly(yard, m.commodity_id, e.detail || e.message);
              this.byomBlockedUntil.set(yard, Date.now() + BYOM_BLOCK_MS);
              return { ok: false, spent, why: `a royal monopoly on ${m.commodity_id} in ${region} (${e.detail || e.message})`, leaseBefore };
            }
            throw e;
          }
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
      // Guide 3.9: at most 12 factors (the count from every factors read, ±1 on a hire or dismissal).
      if (this.factorCount >= MAX_FACTORS) {
        this.logOnceFor(`factor-cap|${this.factorCount}`, "fleet", `not hiring a factor at ${yard}: the company already has ${this.factorCount} (the most allowed is ${MAX_FACTORS})`);
        return false;
      }
      const cash = await this.ensureCash(region, FACTOR_FEE_PENCE);
      if (cash < FACTOR_FEE_PENCE) return false;
      try {
        await this.client.hireFactor(yard);
        world.vaults.set(region, world.vault(region) - FACTOR_FEE_PENCE);
        this.factorCount++;
        return true;
      } catch (e) {
        // Paused: refused (nothing hired), not an outcome to look into or back off from.
        if (this.isFatal(e) || isApiError(e, "world_paused")) throw e;
        this.log("fleet", `hiring a factor at ${yard} failed: ${(e as Error).message}`);
        // Outcome unknown (network, 5xx): if the hire went through after all, it is ours to dismiss.
        if (outcomeUnknown(e)) {
          const now = await this.client.factors().catch(() => null);
          if (now) this.factorCount = now.length;
          if (now?.includes(yard)) {
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
        this.factorCount = Math.max(0, this.factorCount - 1);
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

  /** One buyer pass at a time; `yards` null means every yard where we have presence. An AI build order runs it as a one-off autoBuy. */
  private async runBuyer(yards: string[] | null): Promise<void> {
    const order = this.advisor.buildOrder();
    if (order && !this.canBuild) this.noteBuild("refused", "scope", "the key lacks infra_manage");
    if (this.stopRequested || (!this.settings.autoBuy && !(order && this.canBuild)) || this.buying || Date.now() - this.lastBuy < BUY_COOLDOWN_MS) return;
    this.lastBuyCheck = Date.now();
    this.buying = true;
    try {
      await this.considerPurchase(yards);
    } catch (e) {
      // A paused world goes to the caller, which waits on the clock (not a failed check).
      if (this.isFatal(e) || isApiError(e, "world_paused")) throw e;
      this.setBuyer(`last check failed: ${(e as Error).message}`, true);
    } finally {
      this.buying = false;
    }
  }

  private setBuyer(text: string, log = false): void {
    if (log && text !== this.buyer) this.log("fleet", `buyer: ${text}`);
    this.buyer = text;
  }

  /** What became of the AI's build order, logged once per change. */
  private noteBuild(status: OrderStatus, code?: OrderCode, note?: string, shipId?: string): void {
    const b = this.advisor.buildOrder();
    if (b && this.advisor.noteBuild(status, code, note, shipId)) {
      this.log("fleet", `AI build order (${b.cls} at ${b.yard}): ${status}${code ? ` (${code.replace(/_/g, " ")})` : ""}${note && status !== "done" ? `: ${note}` : ""}`);
    }
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
    // The AI's build order: that class at that yard only, once, through every check below; its outcome goes back to it.
    const order = this.advisor.buildOrder();
    // Its outcome only while it is still the order in force (a newer one isn't marked with this pass's).
    const current = () => !!order && this.advisor.buildOrder() === order;
    const say = (text: string, status?: OrderStatus, code?: OrderCode, log = false) => {
      if (status && current()) this.noteBuild(status, code, text);
      this.setBuyer(text, log);
    };
    // A build whose outcome is unknown may yet turn up (scanShips): never a second hull on top of it.
    const pending = this.pendingBuild;
    if (pending) return say(`watching for the ${pending.cls} "${pending.name}" whose ${pending.shipId ? "purchase" : "build"} at ${pending.yard} had no answer`, "waiting", "unknown_outcome");
    if (this.agents.size >= settings.maxShips) return say(`fleet at the ${settings.maxShips}-ship limit`, "unmet", "fleet_full");
    const aiHold = this.advisor.buyHold();
    if (aiHold) return this.setBuyer(`AI: holding cash (${aiHold.slice(0, 160)})`);
    // Season end (guide 3.11): a hull must pay back before it; close to it, none is built (nor a factor hired).
    const seasonMs = world.seasonLeftMs();
    if (seasonMs < SEASON_ENDGAME_MS) return say(`the season ends in ~${Math.max(0, Math.round(seasonMs / 3_600_000))} h: no new hulls`, "unmet", "season");
    const seasonHours = seasonMs / 3_600_000;
    // Never a packet (guide 3.11: a 16 t courier that can seal its dispatches): it carries almost no cargo, so it never pays as a trader.
    const courier = (c: CatalogShipClass) => c.can_seal_dispatches || c.id === "packet";
    const ordered = order ? world.shipClass(order.cls) : undefined;
    if (ordered && courier(ordered)) return say(`a ${ordered.id} is a courier, never built by the autopilot`, "refused", "class");
    const classes = world.catalog.ship_classes.filter((c) => (order ? c.id === order.cls : settings.buyClasses.includes(c.id)) && c.phase <= world.unlockedPhase && !courier(c));
    if (classes.length === 0) return say(order ? `a ${order.cls} can't be built in this phase` : "no allowed hull class can be built in this phase", "refused", "class");
    if ([...this.agents.values()].some((a) => a.waitingForCash)) return say("a ship is waiting for cash to load: not buying", "waiting", "cash");
    // A loan due that cash can't cover yet comes first (guide 3.13.1).
    if (this.debtShort) return say(`repaying a loan first (${this.debtShort})`, "waiting", "cash");

    await world.refreshVaults();
    // Cash the existing fleet still needs for loads it is bound to buy comes first (loads sized on
    // cash due included: cash due never funds a hull), and what our loans will take to repay.
    let committed = 0;
    for (const a of this.agents.values()) committed += this.committedBy(a);
    const loose = this.spareCash() - committed - this.debtFence();
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
        return null;
      });
      if (factors) {
        this.factorCount = factors.length;
        this.factorPorts = factors;
      }
      for (const p of factors ?? []) if (world.port(p)?.has_shipyard && world.isOpen(p)) yards.add(p);
    }
    // An order builds at its own yard only.
    if (order) for (const y of [...yards]) if (y !== order.yard) yards.delete(y);
    if (spare <= 0) {
      const fence = this.debtFence();
      return say(`no spare cash: ${cr(committed)} is committed to loads the fleet is about to buy${fence > 0 ? `, ${cr(fence)} kept to repay our loans` : ""}${chestNote}`, "waiting", "cash");
    }
    // Ships for sale (guide 3.4, shipDeals): at the ports where we have quay presence (a ship there, or a factor), never on
    // an AI build order (that is a build).
    const forSale = !order && settings.shipDeals ? await this.dealListings(only ?? this.quayPorts()) : [];

    // No presence at any yard: price a build at the yard nearest the work from the last quotes seen
    // (a factor would be hired for it). With no quotes yet, a factor is hired to get some.
    let factorYard: string | null = null;
    let factorPriced = false;
    // At the factor cap (counted from the read above) no factor can be hired for a build.
    if (yards.size === 0 && !only && settings.yardFactor && presenceKnown && Date.now() >= this.factorBlockedUntil && this.factorCount < MAX_FACTORS) {
      const yard = order ? order.yard : this.factorYard();
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
    if (yards.size === 0 && !factorPriced && forSale.length === 0) {
      return say(`waiting for a ship to call at ${order ? order.yard : "a shipyard"} (spare ${cr(spare)} after ${cr(committed)} for loads${chestNote})`, "waiting", "no_presence");
    }

    /** `borrow`: what a loan must add for it (0: our own cash). `listing`: a ship for sale, bought where she lies (not built). */
    type Option = {
      yard: string;
      cls: string;
      hull: number;
      byom: boolean;
      guns: number;
      cost: number;
      payback: number;
      net: number;
      lane: Lane;
      upkeepFloor: number;
      borrow: number;
      listing?: ShipListingResult;
    };
    const options: Option[] = [];
    const notes: string[] = [];
    const now = world.now();
    // Leverage (guide 3.13): a loan may bridge a hull our own cash can't fund, only against cash due from our cargo at
    // sea that no loan counts on yet (it lands well before the repayment), at most half the hull, within the debt cap.
    // An AI order may lift the cash-due bound to its own sum (the debt cap, return and payback still stand).
    const lev = this.leverageRoom();
    const hullLoan = this.advisor.financeOrders().find((o) => o.kind === "borrow_hull");
    if (hullLoan && lev.why) this.noteFinance(hullLoan, "unmet", this.levCode(lev.why), lev.why);
    const dueRoom = Math.max(0, this.dueFlows().reduce((n, f) => n + f.pence, 0) - this.debtFence());
    const loanRoom = lev.why ? 0 : Math.min(lev.pence, Math.max(dueRoom, hullLoan?.pence ?? 0));
    const hoursPerDay = (24 * 60 * world.gameMinuteMs) / 3_600_000;
    // Game days for the new hull's net (per real hour) to earn a loan back with its worst-case interest.
    const loanDays = (principal: number, net: number) => (principal + interestFor(principal, GOLDSMITHS_RATE_BPS, LOAN_MAX_TERM_DAYS)) / net / hoursPerDay;

    /**
     * One hull judged, built or bought: its first lane planned with the cash left after it (`stores`: the tons to start
     * from), the upkeep it adds, payback before the season ends and on the work it would serve, and (builds only) a
     * loan's case when our own cash can't. The option, or why not.
     */
    const judge = async (c: { yard: string; cls: CatalogShipClass; guns: number; hull: number; cost: number; byom: boolean; stores: number; listing?: ShipListingResult }): Promise<Option | string> => {
      const { yard, cls, guns, cost } = c;
      // The home reserve must rise to cover the new hull's upkeep too.
      const oceanic = cls.hull_category === "oceanic";
      const upkeepFloor = this.homeFloor({ tons: cls.hold_capacity_tons, oceanic }) - this.homeFloor();
      const afterBuy = spare - cost - upkeepFloor;
      // Its first lane, planned with the cash left after building it, so the load it is credited with is one it can buy.
      // Without the AI's lane bias: it may only hold the buyer, never talk it into a ship. Nor is one built for a
      // crisis charter only expected from the news, in its own leg or the onward one.
      const firstLane = async (cash: number): Promise<Lane | string> => {
        if (cash <= 0) return `${cr(cost)} leaves nothing for cargo`;
        const planOpts = { ...this.planOptions(cash), bias: undefined, noSpeculativeOnward: true };
        const best = async (storesTons: number) =>
          (await rankLanes(world, this.specForClass(cls.id, guns, storesTons), yard, this.reservations(), planOpts)).find((l) => !l.speculative);
        let lane = await best(c.stores);
        // The stores its first lane really takes (a big crew on a long passage needs far more than the guess): when
        // they leave less room than that load, planned again on the room they leave.
        const real = lane ? await this.firstStores(cls, guns, lane) : null;
        const stores = real !== null ? Math.ceil(real) : c.stores;
        if (lane && stores > c.stores && lane.tons > this.specForClass(cls.id, guns, stores).cap) lane = await best(stores);
        if (!lane) return "no paying lane it could afford";
        const capacity = Math.max(1, this.specForClass(cls.id, guns, stores).cap);
        if (lane.tons < capacity * 0.3) return `${cr(cost)} leaves too little for cargo`;
        return lane;
      };
      let first = await firstLane(afterBuy);
      // Our own cash can't: planned again with what a loan could add, and that much (no more) borrowed when it is built.
      const maxLoan = c.listing ? 0 : Math.floor(Math.min(loanRoom, cost * LOAN_MAX_HULL_SHARE, this.lendable(world.region(yard))));
      let borrow = 0;
      if (typeof first === "string" && maxLoan >= LOAN_MIN_PRINCIPAL_PENCE && afterBuy + maxLoan > 0) {
        const lent = await firstLane(afterBuy + maxLoan);
        if (typeof lent !== "string") {
          first = lent;
          const short = Math.ceil(lent.capital - afterBuy);
          borrow = short > 0 ? Math.max(LOAN_MIN_PRINCIPAL_PENCE, short) : 0;
        }
      }
      if (typeof first === "string") return first;
      const lane = first;
      const upkeepPerHour = world.upkeepDeltaPerHour(this.fleetTons(oceanic), cls.hold_capacity_tons, oceanic);
      const net = lane.profitPerHour - upkeepPerHour;
      if (net <= 0) return "upkeep eats the profit";
      if (cost / net > seasonHours) return "can't pay back before the season ends";
      // The charters it would serve must last, and hold enough tons, to pay the ship back. Expansion
      // charters re-post when they lapse: they last as long as the tier (at its recent pace) and
      // together take no more than the tier still needs.
      const tierHours = world.tierEtaMs !== null ? world.tierEtaMs / 3_600_000 : Infinity;
      const expiries = lane.fills.map(([id]) => {
        const ch = world.charters.find((x) => x.id === id);
        if (!ch) return null;
        return world.renews(ch) ? now + tierHours * 3_600_000 : ch.expiresAt;
      }).filter((x): x is number => x !== null);
      const hoursLeft = expiries.length ? (Math.min(...expiries) - now) / 3_600_000 : Infinity;
      const res = this.reservations();
      // What the tier still needs beyond the fleet's own loads for it.
      let claimed = 0;
      for (const [id, t] of res.charterTons) if (world.renews({ id })) claimed += t;
      let expansionTons = 0;
      const tonsLeft = lane.fills.reduce((n, [id]) => {
        const ch = world.charters.find((x) => x.id === id);
        if (!ch) return n;
        const t = Math.max(0, ch.remaining - (res.charterTons.get(id) ?? 0));
        if (world.renews(ch)) {
          expansionTons += t;
          return n;
        }
        return n + t;
      }, 0) + Math.min(expansionTons, Math.max(0, world.expansionTonsLeft - claimed));
      // A lane mostly served by charters ends when they fill; a mostly-market lane repeats.
      // (One-off freight lots don't count as repeatable work.)
      const marketTons = lane.parts.filter((p) => p.kind === "market").reduce((n, p) => n + p.tons, 0);
      const repeats = marketTons >= lane.tons * 0.3;
      const earnable = Math.min(net * Math.min(settings.maxPaybackHours, hoursLeft, seasonHours), repeats ? Infinity : lane.margin * tonsLeft);
      if (earnable < cost) return "its charters can't pay it back in time";
      // A loan's case on the hull's net (worst case: the Goldsmiths' rate on the whole term): it must earn minLoanReturnX
      // its interest over the term and be earned back (with that interest) within half of it.
      if (borrow > 0) {
        const lc = loanCase({ principal: borrow, rateBps: GOLDSMITHS_RATE_BPS, paybackDays: loanDays(borrow, net), returnOver: (d) => net * d * hoursPerDay, minReturnX: settings.minLoanReturnX });
        if (!lc.ok) return `needs a loan of ${cr(borrow)}, which wouldn't pay (${lc.why})`;
      }
      return { yard, cls: cls.id, hull: c.hull, byom: c.byom, guns, cost, payback: cost / net, net, lane, upkeepFloor, borrow, listing: c.listing };
    };

    // What building each class costs at each yard this pass (the cheaper way): what a ship for sale there is weighed against.
    const buildHere = new Map<string, number>();
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
          // Own materials bought on this yard's market skip the markup on the NPC part: priced at the cheaper way.
          // (The cache keeps the turnkey price: always on offer, it is what a hull costs to replace.)
          const own = this.byomOk(yard) ? this.byomPrice(quote, yard) : null;
          price = own !== null && this.byomSaving(quote, own) >= BYOM_MIN_SAVING_PENCE ? own : quote.total_cost_pence;
          this.hullQuotes.set(`${yard}|${cls.id}`, quote.total_cost_pence);
          buildHere.set(`${yard}|${cls.id}`, price);
        }
        // "full" arms new hulls at once; "auto" builds them bare and refits on a pirate-heavy lane.
        const guns = settings.guns === "full" ? cls.max_cannons : 0;
        // A build at a factor's yard pays the factor's fee too.
        const cost = price + guns * GUN_PRICE_PENCE + (yard === factorYard ? FACTOR_FEE_PENCE : 0);
        // Priced from a cached quote (factor path) the way is decided at build time.
        const o = await judge({ yard, cls, guns, hull: price, cost, byom: this.byomOk(yard), stores: FIRST_STORES_GUESS_TONS });
        if (typeof o === "string") notes.push(`${cls.id}@${yard}: ${o}`);
        else options.push(o);
      }
    }

    // Ships for sale: one priced under building her class (at that yard this pass, else its last quote there, else the cheaper
    // of the cheapest build seen and, listed lately, the listing's own rebuild value; her guns at their refit price) is judged like a build,
    // from the stores she comes with. Never one of our companies' (dealListings), never with a loan.
    const seenRows: DealsReport["listings"] = [];
    for (const l of forSale) {
      const row = { id: l.id, port: l.port_id, cls: l.ship_class, name: l.ship_name, pricePence: l.price_pence, guns: l.cannons_count, buildPence: null as number | null, verdict: "" };
      seenRows.push(row);
      const cls = classes.find((c) => c.id === l.ship_class);
      if (!cls) {
        row.verdict = "not a class the buyer may take";
        continue;
      }
      // The listing's own rebuild value is as of its listing: counted only while that is recent (prices move).
      const listedLately = world.now() - Date.parse(l.created_at) < LISTING_VALUE_FRESH_MS;
      const fallback = [
        ...(listedLately ? [Math.max(0, l.rebuild_value_pence - l.cannons_count * GUN_PRICE_PENCE)] : []),
        ...[...this.hullQuotes].filter(([k]) => k.endsWith(`|${cls.id}`)).map(([, v]) => v),
      ].filter((x) => x > 0);
      const build = buildHere.get(`${l.port_id}|${cls.id}`) ?? this.hullQuotes.get(`${l.port_id}|${cls.id}`) ?? (fallback.length ? Math.min(...fallback) : null);
      row.buildPence = build;
      if (build === null) {
        row.verdict = "no build price to weigh her against";
        continue;
      }
      const worth = listingWorth(build, l.cannons_count, GUN_PRICE_PENCE);
      if (!(l.price_pence < worth)) {
        row.verdict = `no cheaper than building (${cr(worth)} with her guns)`;
        continue;
      }
      const o = await judge({
        yard: l.port_id,
        cls,
        guns: l.cannons_count,
        hull: l.price_pence,
        cost: l.price_pence,
        byom: false,
        stores: Math.max(FIRST_STORES_GUESS_TONS, Math.ceil(l.stores_provisions_tons)),
        listing: l,
      });
      if (typeof o === "string") {
        row.verdict = o;
        notes.push(`${cls.id} for sale@${l.port_id}: ${o}`);
      } else {
        row.verdict = `${cr(worth - l.price_pence)} under building; pays back in ${o.payback.toFixed(1)} h`;
        options.push(o);
      }
    }
    if (!order && settings.shipDeals) this.listingsSeen = { at: Date.now(), rows: seenRows };

    options.sort((a, b) => a.payback - b.payback);
    // For the AI digest: the buyer's own view (an order narrows it to one option).
    if (!order) this.buyerOptions = options.slice(0, 3).map((o) => ({ cls: o.cls, yard: o.yard, paybackHours: Math.round(o.payback * 10) / 10, costPence: o.cost }));
    // Our own cash first: a hull that needs a loan only when none that doesn't passes.
    const pick = options.find((o) => o.borrow === 0 && o.payback <= settings.maxPaybackHours) ?? options.find((o) => o.payback <= settings.maxPaybackHours);
    if (!pick) {
      // A factor hired to price builds led to none: don't hire again for a while.
      if (factorYard && !factorPriced) this.factorFailed();
      const best = options[0];
      return say(
        best
          ? `best option ${best.cls} at ${best.yard} pays back in ${best.payback.toFixed(1)} h (limit ${settings.maxPaybackHours} h)`
          : `nothing affordable pays (${notes.slice(0, 3).join("; ") || `spare ${cr(spare)}`})`,
        "unmet",
        best ? "payback" : "no_paying_lane",
        true,
      );
    }
    const failLater = (why: string, code: OrderCode = "server") => {
      this.lastBuy = Date.now() - BUY_COOLDOWN_MS + BUY_FAIL_COOLDOWN_MS;
      // A factor hired for this build earned nothing: don't hire one again straight away.
      if (pick.yard === factorYard) this.factorFailed();
      say(why, "unmet", code, true);
      return null;
    };
    if (pick.listing) {
      // A factor hired to price builds led to none.
      if (factorYard && !factorPriced) this.factorFailed();
      return this.buyListing(pick, pick.listing, chest, failLater, say);
    }
    // Priced without presence: hire the factor now, then the build below quotes it for real.
    if (factorPriced && !(await this.hireTempFactor(pick.yard))) {
      return say(`a ${pick.cls} at ${pick.yard} would pay back in ${pick.payback.toFixed(1)} h, but no factor could be hired there`, "waiting", "no_presence", true);
    }

    // Name first: the TopStats fetch must not sit between raising the cash and spending it.
    const name = await pickShipName(new Set([...[...this.agents.values()].map((a) => a.name), ...(this.pendingBuild ? [this.pendingBuild.name] : [])]));
    const region = world.region(pick.yard);
    // Materials bought for an own-materials build (on top of the build's own charge, the labour),
    // and the warehouse lease before buying them grew it (to go back to after, whatever happens).
    let materialsSpent = 0;
    let leaseBefore: number | null = null;
    const built = await this.withCash(async () => {
      if (this.stopRequested) return null;
      // Withdrawn during the pass (cleared, shadow or off, the tripwire, its horizon, a newer answer), auto-buy switched
      // off, or a payback limit the AI had raised gone back: nothing is built on what no longer holds.
      if ((order ? !current() : !this.settings.autoBuy) || pick.payback > this.settings.maxPaybackHours) return null;
      // The quote may be minutes old by now: price it again and re-check what the fleet needs.
      const q = await this.client.shipyardQuote(pick.yard, pick.cls, "turnkey_cash").catch(() => null);
      const own = q && pick.byom ? this.byomPrice(q, pick.yard) : null;
      const byom = own !== null && !!q && this.byomSaving(q, own) >= BYOM_MIN_SAVING_PENCE;
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
      // Our own cash for it: after the fleet's loads, the share kept back and what our loans will take to repay.
      const fence = this.debtFence();
      const avail = this.spareCash() - committedNow - pick.upkeepFloor - chest - fence;
      // Planned with a loan: what our cash now leaves short of the hull and its first load, borrowed in the yard's region
      // (never much more than planned); otherwise our own cash covers the hull or nothing is built.
      const short = Math.ceil(price + (pick.borrow > 0 ? pick.lane.capital : 0) - avail);
      if (pick.borrow > 0 && short > 0) {
        const most = Math.ceil(pick.borrow * 1.1);
        if (price - avail > most) return failLater(`a ${pick.cls} at ${pick.yard} now needs more than the ${cr(pick.borrow)} loan planned for it`, "cash");
        const principal = Math.min(short, most);
        const got = await this.borrow({
          purpose: `a ${pick.cls} at ${pick.yard}`,
          use: "hull",
          region,
          principal,
          paybackDays: loanDays(principal, pick.net),
          returnOver: (d) => pick.net * d * hoursPerDay,
        });
        if ("why" in got) return failLater(`a ${pick.cls} at ${pick.yard} needs a loan of ${cr(principal)}: none taken (${got.why})`, "cash");
      } else if (avail < price) {
        return failLater(
          `after the fleet's loads${chest > 0 ? " and the cash kept for the next phase" : ""}${fence > 0 ? " and what our loans will take to repay" : ""} there is no longer ${cr(price)} spare for a ${pick.cls}`,
          "cash",
        );
      }
      const cash = await this.ensureCash(region, price);
      if (cash < price) return failLater(`could not raise ${cr(price)} in ${region} for a ${pick.cls}`, "cash");
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
        // Paused: refused, not an outcome to watch for (housekeeping waits on the clock).
        if (this.isFatal(e) || isApiError(e, "world_paused")) throw e;
        if (outcomeUnknown(e)) {
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
            at: world.now(),
          };
          leaseBefore = null;
          this.persist(true);
          say(`building a ${pick.cls} at ${pick.yard}: outcome unknown (${(e as Error).message}); watching for "${name}"`, "waiting", "unknown_outcome", true);
          return null;
        }
        // A turnkey 409: the ask book can't supply a material now (or a royal monopoly keeps one to players' asks):
        // the quote cached for this yard and class no longer stands (a factor build is priced from it).
        if (mode === "turnkey_cash" && isApiError(e) && e.status === 409) this.hullQuotes.delete(`${pick.yard}|${pick.cls}`);
        // Usually presence lost (the ship sailed) or the price moved past our cash.
        if (mode === "byom") this.byomBlockedUntil.set(pick.yard, Date.now() + BYOM_BLOCK_MS);
        return failLater(
          `building a ${pick.cls} at ${pick.yard} failed: ${(e as Error).message}${mode === "byom" ? "; its materials stay in the warehouse there" : ""}`,
        );
      }
    }).finally(() => {
      // Whatever happened (a paused world's refusal thrown included): the lease goes back to what it was.
      if (leaseBefore !== null) void this.shrinkLease(pick.yard, leaseBefore);
    });
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
    if (current()) this.noteBuild("done", undefined, undefined, built.ship_id);
    if (pick.borrow > 0 && hullLoan) this.noteFinance(hullLoan, "done");
    await this.scanShips();
  }

  // ── Ship deals ──────────────────────────────────────────────────────────────

  /** Ports where we have quay presence now, as last seen: a ship of ours berthed or in the roadstead there, or a factor. */
  private quayPorts(): string[] {
    const out = new Set<string>(this.factorPorts);
    for (const a of this.agents.values()) {
      const s = a.last?.ship;
      if (!a.gone && s && s.status !== "sailing" && s.status !== "sunk" && s.current_port_id) out.add(s.current_port_id);
    }
    return [...out].filter((p) => this.world.isOpen(p));
  }

  /**
   * Ships for sale at these ports (guide 3.4: `ship-listings?port_id=`, quay presence needed): open, never one of our
   * companies', none left alone lately (refused, sold, out of its band). A port that can't be read (presence gone) is skipped.
   */
  private async dealListings(ports: Iterable<string>): Promise<ShipListingResult[]> {
    const out: ShipListingResult[] = [];
    for (const port of new Set(ports)) {
      const got = await this.client.shipListingPages({ port_id: port }, 2).catch((e) => {
        if (this.isFatal(e) || isApiError(e, "world_paused")) throw e;
        return null;
      });
      for (const l of got?.items ?? []) {
        if (l.status !== "open" || l.port_id !== port || this.isOurCompany(l.seller_company_id) || (this.dealSkip.get(`listing|${l.id}`) ?? 0) > Date.now()) continue;
        out.push(l);
      }
    }
    return out;
  }

  /**
   * Buys a ship for sale where she lies (guide 3.4: `buy-ship`, quay presence there, paid from our vault in the port's
   * region), under the cash lock with the fleet's loads, the upkeep floor she adds, the cash kept back and what our loans
   * will take to repay checked again. Sold, withdrawn or her price out of its band now (409: the seller must relist):
   * that listing is dropped. No answer: she is watched for in the fleet by her id (scanShips), never bought blind again.
   * She joins at the scan like any ship of ours.
   */
  private async buyListing(
    pick: { payback: number; upkeepFloor: number; lane: Lane; net: number },
    l: ShipListingResult,
    chest: number,
    failLater: (why: string, code?: OrderCode) => null,
    say: (text: string, status?: OrderStatus, code?: OrderCode, log?: boolean) => void,
  ): Promise<void> {
    const w = this.world;
    const region = w.region(l.port_id);
    const what = `the ${l.ship_class} "${l.ship_name}" for sale at ${l.port_id}`;
    const sold = await this.withCash(async () => {
      if (this.stopRequested || !this.settings.autoBuy || !this.settings.shipDeals || pick.payback > this.settings.maxPaybackHours) return null;
      await w.refreshVaults();
      let committedNow = 0;
      for (const a of this.agents.values()) committedNow += this.committedBy(a);
      const avail = this.spareCash() - committedNow - pick.upkeepFloor - chest - this.debtFence();
      if (avail < l.price_pence) return failLater(`after the fleet's loads and what our loans will take to repay there is no longer ${cr(l.price_pence)} spare for ${what}`, "cash");
      const cash = await this.ensureCash(region, l.price_pence);
      if (cash < l.price_pence) return failLater(`could not raise ${cr(l.price_pence)} in ${region} for ${what}`, "cash");
      try {
        return await this.client.buyShip(l.id);
      } catch (e) {
        if (this.isFatal(e) || isApiError(e, "world_paused")) throw e;
        if (outcomeUnknown(e)) {
          // She may be ours: watched for by her id, and no other hull meanwhile.
          this.lastBuy = Date.now();
          this.pendingBuild = { name: l.ship_name, yard: l.port_id, cls: l.ship_class, price: l.price_pence, cost: l.price_pence, payback: pick.payback, lane: pick.lane.key, at: w.now(), shipId: l.ship_id };
          this.persist(true);
          say(`buying ${what}: outcome unknown (${(e as Error).message}); watching for her in the fleet`, undefined, undefined, true);
          return null;
        }
        this.dealSkip.set(`listing|${l.id}`, Date.now() + DEAL_SKIP_MS);
        return failLater(`buying ${what} failed (dropped): ${(e as Error).message}`);
      }
    });
    if (!sold) return;
    this.lastBuy = Date.now();
    this.dealSkip.set(`listing|${l.id}`, Date.now() + DEAL_SKIP_MS);
    this.shipSpendPence += sold.price_pence;
    this.dealStats.shipsBought++;
    w.vaults.set(region, w.vault(region) - sold.price_pence);
    this.log("fleet", `bought ${what} for ${cr(sold.price_pence)}: lane ${pick.lane.key}, ~${cr(pick.net)}/h net, pays back in ~${pick.payback.toFixed(1)} h`);
    this.purchases.push({
      at: new Date().toISOString(),
      shipId: sold.ship_id,
      name: l.ship_name,
      shipClass: l.ship_class,
      port: l.port_id,
      costPence: sold.price_pence,
      paybackHours: Math.round(pick.payback * 10) / 10,
      lane: pick.lane.key,
      bought: true,
    });
    this.setBuyer(`bought ${what}`);
    this.persist(true);
    await this.scanShips();
  }

  /** The AI's money order of this kind (for this ship, loan or commission) still to act on. */
  private moneyOrder(kind: FinanceOrder["kind"], ref?: string): FinanceOrder | undefined {
    return this.advisor.financeOrders().find((o) => o.kind === kind && (ref === undefined || o.ref === ref));
  }

  /** What became of an AI money order, logged once per change. */
  private noteFinance(o: FinanceOrder, status: OrderStatus, code?: OrderCode, note?: string): void {
    if (this.advisor.noteFinance(o, status, code, note)) {
      this.log("fleet", `AI order (${o.label}): ${status}${code ? ` (${code.replace(/_/g, " ")})` : ""}${note && status !== "done" ? `: ${note}` : ""}`);
    }
  }

  /** The status code for why no loan may be asked for now (leverageRoom's reason). */
  private levCode(why: string): OrderCode {
    if (why.includes("treasury_remit")) return "scope";
    if (why.includes("is off")) return "switched_off";
    if (why.includes("season")) return "season";
    return "debt_cap";
  }

  /** AI money orders that can't be acted on as things stand (the rest are acted on where they apply). */
  private reviewMoneyOrders(): void {
    const s = this.settings;
    for (const o of this.advisor.financeOrders()) {
      if (o.kind === "borrow_load") {
        const a = this.agents.get(o.ref);
        if (!a || a.gone) this.noteFinance(o, "refused", "gone", "the ship is no longer in the fleet");
        else if (!s.leverage) this.noteFinance(o, "unmet", "switched_off", "leverage is off");
        else if (!s.resizeLoads) this.noteFinance(o, "unmet", "switched_off", "a load loan needs re-sizing at the source (resizeLoads)");
      } else if (o.kind === "borrow_hull") {
        if (!s.leverage) this.noteFinance(o, "unmet", "switched_off", "leverage is off");
        else if (!s.autoBuy && !this.advisor.buildOrder()) this.noteFinance(o, "unmet", "switched_off", "the buyer is off (autoBuy) and no build is ordered");
      }
    }
  }

  // ── Ship deals: commissions built to order ──────────────────────────────────

  /**
   * Building to order (guide 3.4 commissions; setting shipDeals, or an AI order for one): our commissions are reconciled
   * and any of ours not yet built is built (while we have presence at its yard, before its deadline); then of the open
   * commissions at our yards (never one of our companies'), the best whose price beats our cheapest build there (turnkey,
   * or own materials when that saves) by the margin after the collateral's risk (deals.ts commissionCase), for a class open
   * in this phase with time to its deadline, is taken and built at once under the cash lock, with the build and the
   * collateral covered by spare cash after the fleet's loads and our loans' repayments. One a pass.
   */
  private async runCommissions(): Promise<void> {
    if (this.dealsBusy) return;
    this.dealsBusy = true;
    try {
      const s = this.settings;
      const orders = this.advisor.financeOrders().filter((o) => o.kind === "commission");
      const live = [...this.commissionRecs.values()].some((r) => r.status === "accepting" || r.status === "accepted" || r.status === "delivering");
      if (!s.shipDeals && orders.length === 0 && !live) {
        this.dealsAction = "commissions: off";
        this.commissionsSeen = null;
        return;
      }
      const read = (status: "open" | "active") =>
        this.client.contractPages({ contract_type: "commission", status }, 3).catch((e) => {
          if (this.isFatal(e) || isApiError(e, "world_paused")) throw e;
          return null;
        });
      const [open, active] = await Promise.all([read("open"), live ? read("active") : null]);
      if (live) await this.reconcileCommissions(open, active);
      // Ours not built yet: built while we have presence at the yard, before the deadline.
      for (const [id, rec] of [...this.commissionRecs]) if (rec.status === "accepted") await this.retryDelivery(id, rec);
      if (!open) {
        this.dealsAction = "the commissions couldn't be read";
        return;
      }
      await this.takeCommission(open.items, orders);
    } finally {
      this.dealsBusy = false;
      this.pruneDealRecs();
      this.persist();
    }
  }

  /**
   * Our commissions against contract/list: an acceptance with no answer is ours when listed as ours to build, wasn't made
   * when still open to anyone a while after, and is taken as made otherwise (a delivery then settles it: a refusal checks
   * the completed list); a delivery with no answer still ours to build a while after didn't land (tried again), one gone
   * from ours is looked for among the completed; one past its deadline unbuilt is lost (its collateral forfeit).
   */
  private async reconcileCommissions(
    open: { items: ContractListing[]; complete: boolean } | null,
    active: { items: ContractListing[]; complete: boolean } | null,
  ): Promise<void> {
    const now = this.world.now();
    const ours = new Set((active?.items ?? []).filter((c) => c.contract_type === "commission" && this.isOurCompany(c.carrier_company_id ?? "")).map((c) => c.id));
    const stillOpen = open?.complete ? new Set(open.items.map((c) => c.id)) : null;
    for (const [id, rec] of [...this.commissionRecs]) {
      const what = `the ${rec.cls} commissioned at ${rec.yard}`;
      // Listed as ours to build: no doubt left that it is.
      if (rec.status === "accepted" && ours.has(id)) {
        rec.confirmed = true;
        rec.unsure = undefined;
      }
      if (rec.status === "accepting") {
        if (ours.has(id)) {
          rec.status = "accepted";
          rec.confirmed = true;
          this.log("fleet", `${what}: our acceptance that had no answer went through; building it`);
        } else if (now - rec.at > DELIVER_HOLD_MS) {
          if (stillOpen?.has(id)) {
            this.commissionRecs.delete(id);
            this.log("fleet", `${what}: our acceptance that had no answer didn't go through (it is still open)`);
            const o = this.moneyOrder("commission", id);
            if (o) this.noteFinance(o, "unmet", "server", "the acceptance didn't go through");
          } else if (stillOpen || now - rec.at > PENDING_DEAL_MS) {
            // Not open any more (or no word for long): taken as ours; a delivery settles it, and one refused drops it.
            rec.status = "accepted";
          }
        }
      } else if (rec.status === "delivering" && rec.sentAt !== undefined && now - rec.sentAt > DELIVER_HOLD_MS) {
        if (ours.has(id)) {
          rec.status = "accepted";
          rec.unsure = undefined;
          rec.note = "the delivery with no answer didn't land";
          this.log("fleet", `${what}: the delivery that had no answer didn't land; building it again`);
        } else if (active?.complete) {
          // Not ours to build any more: delivered if the completed list has it; else built again before its deadline (the
          // game refuses a second delivery, and the commission notices settle it too).
          await this.settleCommission(id, rec, false);
        }
      } else if (rec.status === "accepted" && rec.expiresAt !== null && now >= rec.expiresAt) await this.settleCommission(id, rec, true);
    }
  }

  /**
   * A commission of ours no longer ours to build (or past its deadline): delivered if the completed list has it, else lost
   * (`final`: past its deadline, or long enough without word) or back to be built (a refusal then settles it).
   */
  private async settleCommission(id: string, rec: CommissionRec, final: boolean): Promise<void> {
    const done = await this.client.contractPages({ contract_type: "commission", status: "completed" }, 2).catch((e) => {
      if (this.isFatal(e) || isApiError(e, "world_paused")) throw e;
      return null;
    });
    if (!done) return;
    if (done.items.some((c) => c.id === id)) return this.commissionDone(id, rec, null);
    if (final || (rec.expiresAt !== null && this.world.now() >= rec.expiresAt)) {
      rec.status = "failed";
      this.log(
        "fleet",
        rec.confirmed
          ? `the ${rec.cls} commissioned at ${rec.yard} wasn't delivered before its deadline: our ${cr(rec.collateral)} collateral goes to the buyer`
          : `the ${rec.cls} commission at ${rec.yard} whose acceptance had no answer never showed as ours (if it was, its ${cr(rec.collateral)} collateral is lost)`,
      );
      const o = this.moneyOrder("commission", id);
      if (o) this.noteFinance(o, "unmet", "deadline");
      this.persist(true);
      return;
    }
    rec.status = "accepted";
    // It may be delivered already (the completed list can lag): built again turnkey only (deliverNow).
    rec.unsure = true;
    rec.retryAt = Date.now() + DELIVER_RETRY_MS;
  }

  /** A commission of ours delivered: the price less the build (`d`, or as planned when only an event or a list told of it) booked to the deal stats. */
  private commissionDone(id: string, rec: CommissionRec, d: { price_paid_pence: number; build_cost_pence: number } | null, materials = 0): void {
    if (rec.status === "delivered") return;
    rec.status = "delivered";
    rec.note = undefined;
    const net = d ? d.price_paid_pence - d.build_cost_pence - materials : rec.price - rec.cost;
    this.dealStats.commissionsDelivered++;
    this.dealStats.commissionNet += net;
    this.log("fleet", `delivered the ${rec.cls} commissioned at ${rec.yard}: paid ${cr(d?.price_paid_pence ?? rec.price)} and our ${cr(rec.collateral)} collateral back, ~${cr(net)} over the build${d ? "" : " (as planned)"}`);
    const o = this.moneyOrder("commission", id);
    if (o) this.noteFinance(o, "done");
    this.persist(true);
  }

  /** A commission notice (buyer and builder) about one of ours: accepted, delivered or defaulted follows at once. */
  private noteCommissionEvent(id: string, rec: CommissionRec, type: string, buildCost: number | undefined): void {
    if (type === "commission_accepted" && rec.status === "accepting") {
      rec.status = "accepted";
      rec.confirmed = true;
      this.log("fleet", `the ${rec.cls} commissioned at ${rec.yard}: our acceptance went through; building it`);
      this.persist(true);
    } else if (type === "commission_delivered" && rec.status !== "delivered" && rec.status !== "failed") {
      this.commissionDone(id, rec, buildCost !== undefined ? { price_paid_pence: rec.price, build_cost_pence: buildCost } : null);
    } else if (type === "commission_defaulted" && rec.status !== "delivered" && rec.status !== "failed") {
      rec.status = "failed";
      this.log("fleet", `the ${rec.cls} commissioned at ${rec.yard} defaulted: our ${cr(rec.collateral)} collateral goes to the buyer`);
      const o = this.moneyOrder("commission", id);
      if (o) this.noteFinance(o, "unmet", "deadline");
      this.persist(true);
    }
  }

  /** One of ours accepted and not built yet: built again once its retry time is up, while we have presence at the yard. */
  private async retryDelivery(id: string, rec: CommissionRec): Promise<void> {
    if ((rec.retryAt ?? 0) > Date.now()) return;
    const w = this.world;
    if (rec.expiresAt !== null && w.now() >= rec.expiresAt) return this.settleCommission(id, rec, true);
    if (!this.quayPorts().includes(rec.yard)) {
      rec.note = "waiting for a ship of ours (or a factor) at the yard to build it";
      const left = rec.expiresAt !== null ? (rec.expiresAt - w.now()) / (60 * w.gameMinuteMs) : Infinity;
      if (left < COMMISSION_MIN_LEFT_GAME_H) this.logOnceFor(`commission-presence|${id}`, "fleet", `WARNING: the ${rec.cls} commissioned at ${rec.yard} is due in ${left.toFixed(1)} game h and no ship of ours or factor is there to build it (its ${cr(rec.collateral)} collateral is at stake)`);
      return;
    }
    await this.withCash(async () => {
      if (this.stopRequested || this.paused || rec.status !== "accepted") return;
      await this.deliverNow(id, rec);
    });
  }

  /**
   * The open commissions at our yards, each judged on a quote there (the cheaper of turnkey and own materials, when that
   * saves BYOM_MIN_SAVING_PENCE); the best that pays is taken and built, an AI order's first. Seen ones go to the panel.
   */
  private async takeCommission(rows: ContractListing[], orders: FinanceOrder[]): Promise<void> {
    const s = this.settings;
    const w = this.world;
    const now = w.now();
    const hourMs = 60 * w.gameMinuteMs;
    const quay = new Set(this.quayPorts());
    const seen: DealsReport["commissions"] = [];
    const quotes = new Map<string, BuildQuote | null>();
    const cands: Array<{ c: ContractListing; cost: number; byom: boolean; margin: number; order?: FinanceOrder }> = [];
    for (const c of rows) {
      if (c.contract_type !== "commission" || c.status !== "open" || !c.ship_class) continue;
      const yard = c.origin_port_id;
      const order = orders.find((o) => o.ref === c.id);
      const row: DealsReport["commissions"][number] = {
        id: c.id,
        yard,
        cls: c.ship_class,
        pricePence: c.reward_pence,
        collateralPence: c.collateral_pence,
        costPence: null,
        marginPence: null,
        expiresAt: c.expires_at ?? null,
        verdict: "",
      };
      seen.push(row);
      const no = (verdict: string, code?: OrderCode) => {
        row.verdict = verdict;
        if (order && code) this.noteFinance(order, "unmet", code, verdict);
      };
      if (this.isOurCompany(c.issuer_company_id ?? "")) {
        no("posted by one of our companies: never built for ourselves", "gone");
        continue;
      }
      if (this.commissionRecs.has(c.id)) {
        row.verdict = "ours";
        continue;
      }
      if ((this.dealSkip.get(`commission|${c.id}`) ?? 0) > Date.now()) {
        no("left alone after a refusal");
        continue;
      }
      if (!s.shipDeals && !order) {
        row.verdict = "ship deals are off";
        continue;
      }
      if (!quay.has(yard) || !w.port(yard)?.has_shipyard) {
        no("no ship of ours or factor at the yard", "no_presence");
        continue;
      }
      const cls = w.shipClass(c.ship_class);
      if (!cls || cls.phase > w.unlockedPhase) {
        no("its class can't be built in this phase", "class");
        continue;
      }
      const key = `${yard}|${cls.id}`;
      let q = quotes.get(key);
      if (q === undefined) {
        q = await this.client.shipyardQuote(yard, cls.id, "turnkey_cash").catch((e) => {
          if (this.isFatal(e) || isApiError(e, "world_paused")) throw e;
          return null;
        });
        quotes.set(key, q);
      }
      if (!q?.available || !q.total_cost_pence) {
        no("the yard can't build it now (the book can't supply its materials)", "server");
        continue;
      }
      this.hullQuotes.set(key, q.total_cost_pence);
      // A commission's turnkey build skips the buyer's own asks with no cap on what it pays instead: with players' asks
      // in the walk (the buyer's, perhaps), own materials only (our bids may buy them), or not taken.
      const asks = playerAsks(q);
      const own = this.byomOk(yard) ? this.byomPrice(q, yard) : null;
      const byom = own !== null && (asks || this.byomSaving(q, own) >= BYOM_MIN_SAVING_PENCE);
      if (asks && !byom) {
        no("its turnkey build would draw on players' asks (perhaps the buyer's, which a commission's build passes over), and own materials aren't open here", s.byomBuilds ? "server" : "switched_off");
        continue;
      }
      const cost = byom ? own! : q.total_cost_pence;
      const exp = c.expires_at ? Date.parse(c.expires_at) : NaN;
      const cc = commissionCase({ price: c.reward_pence, collateral: c.collateral_pence, cost, leftGameH: Number.isFinite(exp) ? (exp - now) / hourMs : Infinity });
      row.costPence = cost;
      row.marginPence = cc.margin;
      if (!cc.ok) {
        no(cc.why, cc.code);
        continue;
      }
      row.verdict = `pays: ~${cr(cc.margin)} over our ${byom ? "own-materials" : "turnkey"} build`;
      cands.push({ c, cost, byom, margin: cc.margin, order });
    }
    this.commissionsSeen = { at: Date.now(), rows: seen };
    for (const o of orders) if (!rows.some((c) => c.id === o.ref) && !this.commissionRecs.has(o.ref)) this.noteFinance(o, "unmet", "gone", "no longer open");
    const pick = cands.sort((a, b) => Number(!!b.order) - Number(!!a.order) || b.margin - a.margin)[0];
    const blocked = this.debtShort ? `a loan repayment is short (${this.debtShort})` : w.seasonMode(now) === "final" ? "the season's last hours" : null;
    if (!pick || blocked) {
      if (pick?.order && blocked) this.noteFinance(pick.order, "waiting", this.debtShort ? "cash" : "season", blocked);
      this.dealsAction = blocked && pick ? `not taking commissions: ${blocked}` : `commissions: ${seen.length} open at our yards, none that pays`;
      return;
    }
    await this.acceptAndBuild(pick.c, pick);
  }

  /**
   * Takes a commission and builds it at once, holding the cash lock: quoted again, judged again, the build and the
   * collateral covered by spare cash after the fleet's loads and our loans' repayments and raised in the yard's region;
   * saved as being accepted before the call (one with no answer is reconciled, never sent blind again).
   */
  private async acceptAndBuild(c: ContractListing, plan: { byom: boolean; order?: FinanceOrder }): Promise<void> {
    const w = this.world;
    const yard = c.origin_port_id;
    const cls = c.ship_class!;
    const region = w.region(yard);
    const what = `the commission for a ${cls} at ${yard} (${cr(c.reward_pence)}, collateral ${cr(c.collateral_pence)})`;
    // Name first: the TopStats fetch must not sit between raising the cash and spending it.
    const name = await pickShipName(new Set([...[...this.agents.values()].map((a) => a.name), ...[...this.commissionRecs.values()].map((r) => r.name ?? "")]));
    await this.withCash(async () => {
      if (this.stopRequested || this.paused) return;
      if (!this.settings.shipDeals && !(plan.order && this.advisor.financeOrders().includes(plan.order))) return;
      const q = await this.client.shipyardQuote(yard, cls, "turnkey_cash").catch((e) => {
        if (this.isFatal(e) || isApiError(e, "world_paused")) throw e;
        return null;
      });
      if (!q?.available || !q.total_cost_pence) {
        this.dealsAction = `${what}: the yard can't build it now`;
        return;
      }
      // Players' asks in the turnkey walk: own materials only (takeCommission), or not taken.
      const asks = playerAsks(q);
      const own = (plan.byom || asks) && this.byomOk(yard) ? this.byomPrice(q, yard) : null;
      const byom = own !== null && (asks || this.byomSaving(q, own) >= BYOM_MIN_SAVING_PENCE);
      if (asks && !byom) {
        this.dealsAction = `${what}: its turnkey build would draw on players' asks, and own materials aren't open there`;
        if (plan.order) this.noteFinance(plan.order, "unmet", this.settings.byomBuilds ? "server" : "switched_off", this.dealsAction);
        return;
      }
      const cost = byom ? own! : q.total_cost_pence;
      const exp = c.expires_at ? Date.parse(c.expires_at) : NaN;
      const cc = commissionCase({ price: c.reward_pence, collateral: c.collateral_pence, cost, leftGameH: Number.isFinite(exp) ? (exp - w.now()) / (60 * w.gameMinuteMs) : Infinity });
      if (!cc.ok) {
        this.dealsAction = `${what}: no longer pays (${cc.why})`;
        if (plan.order) this.noteFinance(plan.order, "unmet", cc.code, cc.why);
        return;
      }
      await w.refreshVaults();
      let committed = 0;
      for (const a of this.agents.values()) committed += this.committedBy(a);
      const need = cost + c.collateral_pence;
      if (this.spareCash() - committed - this.debtFence() < need || (await this.ensureCash(region, need)) < need) {
        this.dealsAction = `${what}: no ${cr(need)} spare in ${region} for the build and the collateral after the fleet's loads`;
        if (plan.order) this.noteFinance(plan.order, "waiting", "cash", this.dealsAction);
        return;
      }
      const rec: CommissionRec = {
        yard,
        cls,
        price: c.reward_pence,
        collateral: c.collateral_pence,
        expiresAt: Number.isFinite(exp) ? exp : null,
        status: "accepting",
        at: w.now(),
        cost,
        byom,
        name,
      };
      this.commissionRecs.set(c.id, rec);
      this.persist(true);
      await this.journal?.flush();
      try {
        const res = await this.client.acceptCommission(c.id);
        rec.status = "accepted";
        rec.confirmed = true;
        const by = Date.parse(res.expires_at ?? "");
        if (Number.isFinite(by)) rec.expiresAt = by;
        w.vaults.set(region, w.vault(region) - res.collateral_pence);
        this.dealsAction = `took ${what}`;
        this.log("fleet", `took ${what}: building it now for ~${cr(cost)} (${byom ? "own materials" : "turnkey"}), ~${cr(cc.margin)} over our cost`);
        if (plan.order) this.noteFinance(plan.order, "active");
        this.persist(true);
      } catch (e) {
        const unknown = outcomeUnknown(e);
        if (!unknown) this.commissionRecs.delete(c.id);
        this.persist(!unknown);
        if (this.isFatal(e) || isApiError(e, "world_paused")) throw e;
        const msg = (e as Error).message;
        if (unknown) {
          this.log("fleet", `taking ${what}: no answer (${msg}); looked for among our commissions, never asked blind again`);
          if (plan.order) this.noteFinance(plan.order, "waiting", "unknown_outcome");
          return;
        }
        this.dealSkip.set(`commission|${c.id}`, Date.now() + DEAL_SKIP_MS);
        this.dealsAction = `taking ${what} was refused`;
        this.log("fleet", `taking ${what} was refused: ${msg}`);
        if (plan.order) this.noteFinance(plan.order, "refused", "server", msg);
        return;
      }
      await this.deliverNow(c.id, rec, q);
    });
  }

  /**
   * Builds and hands over a commission of ours (guide 3.4: deliver-commission builds it as build-ship would, at our cost,
   * and pays us the price and our collateral back), holding the cash lock. Own materials when planned and still cheaper
   * (bought into our warehouse at the yard first; turnkey when they can't all be had), only while building still beats
   * forfeiting the collateral. Saved as being delivered before the call: one with no answer is reconciled, never sent
   * blind again. Refused: tried again after DELIVER_RETRY_MS (a book that can't supply turnkey tries own materials next),
   * or settled when it isn't ours to build any more.
   */
  private async deliverNow(id: string, rec: CommissionRec, quote?: BuildQuote | null): Promise<void> {
    const w = this.world;
    const region = w.region(rec.yard);
    const what = `the ${rec.cls} commissioned at ${rec.yard}`;
    const later = (note: string) => {
      rec.note = note;
      rec.retryAt = Date.now() + DELIVER_RETRY_MS;
      this.persist();
    };
    const q =
      quote ??
      (await this.client.shipyardQuote(rec.yard, rec.cls, "turnkey_cash").catch((e) => {
        if (this.isFatal(e) || isApiError(e, "world_paused")) throw e;
        return null;
      }));
    if (!q?.available || !q.total_cost_pence) return later("the yard can't build it now");
    // A commission's turnkey build passes over the buyer's own asks with no cap on what it pays instead: with players'
    // asks in the walk, own materials only. Not sure it is still ours to build (an acceptance only taken as made, or a
    // delivery with no answer that may have landed): turnkey only, nothing bought ahead; with players' asks, it waits.
    const asks = playerAsks(q);
    const unsure = !rec.confirmed || !!rec.unsure;
    if (asks && unsure) return later("waiting to be sure it is ours before buying its materials (a turnkey build would draw on players' asks)");
    const own = !unsure && (rec.byom || asks) && this.byomOk(rec.yard) ? this.byomPrice(q, rec.yard) : null;
    let mode: BuildMode = own !== null && (asks || own < q.total_cost_pence) ? "byom" : "turnkey_cash";
    if (asks && mode !== "byom") return later("its turnkey build would draw on players' asks, and own materials aren't open here: waiting");
    if (!deliveryPays({ price: rec.price, collateral: rec.collateral, cost: mode === "byom" ? own! : q.total_cost_pence })) {
      this.logOnceFor(`commission-dear|${id}`, "fleet", `${what}: building it now costs more than its price and our collateral back; waiting for the yard's prices`);
      return later("building it now costs more than the price and our collateral back");
    }
    let materials = 0;
    let leaseBefore: number | null = null;
    try {
      if (mode === "byom") {
        const got = await this.buyMaterials(rec.yard, rec.cls, q);
        // Materials for a hull we hand over aren't our fleet's spend (buyMaterials books them there).
        this.shipSpendPence -= got.spent;
        materials = got.spent;
        leaseBefore = got.leaseBefore;
        if (!got.ok) {
          // Turnkey then (what was bought stays in the warehouse there for the next build), only with no player's ask in
          // its walk and while building that way still beats forfeiting the collateral.
          if (got.spent === 0) this.byomBlockedUntil.set(rec.yard, Date.now() + BYOM_BLOCK_MS);
          if (asks) return later(`own materials couldn't all be had (${got.why}); a turnkey build would draw on players' asks`);
          if (!deliveryPays({ price: rec.price, collateral: rec.collateral, cost: q.total_cost_pence })) {
            return later(`own materials couldn't all be had (${got.why}), and building it turnkey now costs more than the price and our collateral back`);
          }
          mode = "turnkey_cash";
        }
      }
      const cost = mode === "byom" ? q.labour_pence : q.total_cost_pence;
      if ((await this.ensureCash(region, cost)) < cost) return later(`couldn't raise ${cr(cost)} in ${region} to build it`);
      rec.status = "delivering";
      rec.sentAt = w.now();
      this.persist(true);
      await this.journal?.flush();
      try {
        const d = await this.client.deliverCommission(id, rec.name ?? `${rec.cls} ${id.slice(0, 4)}`, mode);
        w.vaults.set(region, w.vault(region) + d.price_paid_pence + d.collateral_returned_pence - d.build_cost_pence);
        this.commissionDone(id, rec, d, mode === "byom" ? materials : 0);
        this.dealsAction = `delivered ${what}`;
      } catch (e) {
        const unknown = outcomeUnknown(e);
        if (!unknown) rec.status = "accepted";
        this.persist(true);
        if (this.isFatal(e) || isApiError(e, "world_paused")) throw e;
        const msg = (e as Error).message;
        if (unknown) {
          this.log("fleet", `delivering ${what}: no answer (${msg}); looked for among our commissions, never sent blind again`);
          return;
        }
        this.log("fleet", `delivering ${what} was refused: ${msg}`);
        // The book can't supply a turnkey build now: the cached quote goes, and own materials are tried next.
        const supply = /suppl|book|material|stock|monopol/i.test(msg);
        if (mode === "turnkey_cash" && isApiError(e) && e.status === 409 && supply) {
          this.hullQuotes.delete(`${rec.yard}|${rec.cls}`);
          if (this.settings.byomBuilds) rec.byom = true;
        }
        if (isApiError(e) && (e.status === 409 || e.status === 400) && !supply) {
          if (!rec.confirmed) {
            // Only taken as ours after an acceptance with no answer: it wasn't (no collateral of ours is at stake).
            this.commissionRecs.delete(id);
            this.log("fleet", `${what}: our acceptance that had no answer didn't go through after all; dropped`);
            const o = this.moneyOrder("commission", id);
            if (o) this.noteFinance(o, "unmet", "server", "the acceptance didn't go through");
            this.persist(true);
            return;
          }
          // Not ours to build any more (delivered or lapsed): the completed list says which.
          rec.note = msg;
          await this.settleCommission(id, rec, false);
          return;
        }
        later(msg);
      }
    } finally {
      if (leaseBefore !== null) void this.shrinkLease(rec.yard, leaseBefore);
    }
  }

  /** Closed commission and envelope records past keeping go (the deal stats keep what they earned). */
  private pruneDealRecs(): void {
    const keep = this.world.now() - DEAL_REC_KEEP_MS;
    const closed = [...this.commissionRecs].filter(([, r]) => r.status === "delivered" || r.status === "failed").sort((a, b) => a[1].at - b[1].at);
    for (const [id, r] of closed) if (r.at < keep || this.commissionRecs.size > DEAL_RECS_MAX) this.commissionRecs.delete(id);
    const shut = [...this.envelopeRecs].filter(([, r]) => r.status !== "open").sort((a, b) => a[1].at - b[1].at);
    for (const [id, r] of shut) if (r.at < keep || this.envelopeRecs.size > DEAL_RECS_MAX) this.envelopeRecs.delete(id);
  }

  // ── Intelligence envelopes ──────────────────────────────────────────────────

  /**
   * Intelligence envelopes (guide 3.11; setting envelopes): our envelopes read (envelope/mine as seller): sales booked once,
   * posts with no answer found or given up, lapsed ones closed. Then at each port where we have quay presence, one fresh
   * envelope per kind every ENVELOPE_EVERY_GAME_H when the port view (read within QUAY_NEWS_FRESH_MS) holds something for
   * each section asked for: `news` (port reports, sailings) and `charters` (the port's own non-public charters, narrowed
   * to goods the fleet isn't carrying, planning, reserving or letting lapse), priced per item for its age (deals.ts),
   * lapsing after ENVELOPE_LIFE_GAME_H. The one it supersedes, and any unsold after ENVELOPE_STALE_GAME_H, is withdrawn.
   * At most ENVELOPE_MAX_OPEN of ours and the game's cap in all. Never buys one. No money moves here (a sale is paid in).
   */
  private async runEnvelopes(): Promise<void> {
    if (this.envelopesBusy) return;
    this.envelopesBusy = true;
    try {
      const s = this.settings;
      const w = this.world;
      const tracked = [...this.envelopeRecs.values()].some((r) => r.status === "open") || this.pendingEnvelopes.length > 0;
      if (!s.envelopes && !tracked) {
        this.envelopeAction = "envelopes: off";
        return;
      }
      const mine = await this.client.myEnvelopePages({ role: "seller" }, 2).catch((e) => {
        if (this.isFatal(e) || isApiError(e, "world_paused")) throw e;
        return null;
      });
      if (!mine) {
        this.envelopeAction = "our envelopes couldn't be read";
        return;
      }
      this.syncEnvelopes(mine.items, mine.complete);
      const now = w.now();
      const hourMs = 60 * w.gameMinuteMs;
      const ownOpen = () => [...this.envelopeRecs].filter(([, r]) => r.status === "open");
      // News of a charter whose good the fleet now works (a lane, a hold, a reservation since it was sealed): withdrawn.
      const worked = this.workedGoods();
      for (const [id, r] of ownOpen()) if (r.kind === "charters" && r.goods?.some((g) => worked.has(g))) await this.withdrawEnvelope(id, r, "its goods are ours to work now");
      if (!s.envelopes) {
        this.envelopeAction = `off: ${ownOpen().length} of ours still listed, left to sell or lapse`;
        return;
      }
      // Unsold and stale: withdrawn (a fresher one replaces it where we still stand).
      for (const [id, r] of ownOpen()) if (now - r.at >= ENVELOPE_STALE_GAME_H * hourMs) await this.withdrawEnvelope(id, r, "unsold and stale");
      // Everything of ours open (by hand too) counts against the game's cap.
      let total = mine.items.filter((e) => e.status === "open" && this.envelopeRecs.get(e.id)?.status !== "withdrawn").length + this.pendingEnvelopes.length;
      let ours = ownOpen().length + this.pendingEnvelopes.length;
      let posted = 0;
      for (const port of this.quayPorts()) {
        for (const kind of ["news", "charters"] as const) {
          if ((this.dealSkip.get(`envelope|${port}|${kind}`) ?? 0) > Date.now() || this.pendingEnvelopes.some((p) => p.port === port && p.kind === kind)) continue;
          const prev = ownOpen()
            .filter(([, r]) => r.port === port && r.kind === kind)
            .sort((a, b) => b[1].at - a[1].at)[0];
          if (prev && now - prev[1].at < ENVELOPE_EVERY_GAME_H * hourMs) continue;
          const freed = prev ? 1 : 0;
          if (ours - freed >= ENVELOPE_MAX_OPEN || total - freed >= ENVELOPE_GAME_CAP) continue;
          const plan = kind === "news" ? this.newsPlan(port) : this.chartersPlan(port);
          if (!plan) continue;
          // The one it supersedes comes off first: still listed (its withdrawal failed), no new one goes up beside it.
          if (prev) {
            if (!(await this.withdrawEnvelope(prev[0], prev[1], "superseded by fresher news"))) continue;
            ours--;
            total--;
          }
          if (await this.postEnvelope(port, kind, plan)) {
            ours++;
            total++;
            posted++;
          }
        }
      }
      const st = this.dealStats;
      this.envelopeAction = `${ownOpen().length} of ours open${posted ? `, ${posted} posted just now` : ""}; ${st.envelopesSold} sold for ${cr(st.envelopeIncome)} in all`;
    } finally {
      this.envelopesBusy = false;
      this.persist();
    }
  }

  /**
   * Our envelopes as the market has them: a sale (open → sold) booked once, a post with no answer adopted when an envelope
   * at that port at that price turned up since (else given up after PENDING_DEAL_MS), and one a full read no longer lists closed.
   */
  private syncEnvelopes(items: EnvelopeDetail[], complete: boolean): void {
    const w = this.world;
    const listed = new Set<string>();
    for (const e of items) {
      listed.add(e.id);
      let rec = this.envelopeRecs.get(e.id);
      if (!rec) {
        const created = Date.parse(e.created_at);
        const p = this.pendingEnvelopes.find((x) => x.port === e.port_id && x.price === e.price_pence && created >= x.at - 120_000);
        if (!p) continue;
        this.pendingEnvelopes = this.pendingEnvelopes.filter((x) => x !== p);
        rec = { port: p.port, kind: p.kind, price: e.price_pence, at: Number.isFinite(created) ? created : p.at, expiresAt: Date.parse(e.expires_at) || null, status: "open", seen: Date.now() };
        this.envelopeRecs.set(e.id, rec);
        this.log("fleet", `the envelope at ${p.port} whose post had no answer was listed after all`);
      }
      if (rec.status !== "sold" && e.status === "sold") {
        this.dealStats.envelopesSold++;
        this.dealStats.envelopeIncome += e.price_pence;
        this.log("fleet", `sold sealed news at ${rec.port} for ${cr(e.price_pence)} (${e.title})`);
      }
      rec.status = e.status;
      rec.seen = Date.now();
      if (rec.kind === "charters" && e.contents?.charters) rec.goods = [...new Set(e.contents.charters.map((c) => c.commodity_id))];
    }
    // One of ours still open that a full read no longer lists has lapsed.
    if (complete) for (const [id, r] of this.envelopeRecs) if (r.status === "open" && !listed.has(id)) r.status = "expired";
    this.pendingEnvelopes = this.pendingEnvelopes.filter((p) => {
      if (w.now() - p.at <= PENDING_DEAL_MS) return true;
      this.log("fleet", `the envelope at ${p.port} whose post had no answer isn't among ours: taken as not posted`);
      return false;
    });
  }

  /** What a `news` envelope sealed at this port would hold (its port view read lately): port reports and sailings, priced for their age. */
  private newsPlan(port: string): { categories: EnvelopeCategory[]; price: number; goods?: string[] } | null {
    const w = this.world;
    const q = w.quayNews.get(port);
    if (!q || Date.now() - q.at > QUAY_NEWS_FRESH_MS) return null;
    const hourMs = 60 * w.gameMinuteMs;
    const since = Date.now() - q.at;
    const now = w.now();
    const categories: EnvelopeCategory[] = [];
    const items: Array<{ kind: EnvelopeCategory; n: number; ageGameH: number }> = [];
    // (The reports include our own crews' news of the ports they called at: prices, never our ships.)
    if (q.reports.length) {
      const ages = [...q.reports].sort((a, b) => a - b);
      categories.push("port_reports");
      items.push({ kind: "port_reports", n: ages.length, ageGameH: (ages[Math.floor(ages.length / 2)] + since) / hourMs });
    }
    // The last 24 game hours' notices (half an hour's margin for ones about to drop out of the window). The section seals
    // every notice in the window: none while one of ours (by company or ship name) is among them, nor near its edge.
    const sailings = q.sailings.filter((t) => now - t.at < 23.5 * hourMs).map((t) => t.at);
    const shipNames = new Set([...this.agents.values()].map((a) => a.name));
    const ourOwn = q.sailings.some((t) => now - t.at < 24.5 * hourMs && (w.rivals.ours.has(t.company) || shipNames.has(t.ship)));
    if (sailings.length && !ourOwn) {
      categories.push("sailings");
      items.push({ kind: "sailings", n: sailings.length, ageGameH: sailings.reduce((n, t) => n + (now - t), 0) / sailings.length / hourMs });
    }
    return categories.length ? { categories, price: envelopePrice(items) } : null;
  }

  /**
   * What a `charters` envelope sealed at this port would hold: its own non-public charters listed live to us, narrowed to
   * goods the fleet isn't working (workedGoods), so news of a posting we carry for, plan, reserve or let lapse is never sold.
   */
  private chartersPlan(port: string): { categories: EnvelopeCategory[]; price: number; goods: string[] } | null {
    const w = this.world;
    const now = w.now();
    const live = w.charters.filter((c) => c.port === port && !c.isPublic && !c.stale && !c.provisional && c.remaining > 0 && (c.expiresAt ?? Infinity) > now);
    if (!live.length) return null;
    const worked = this.workedGoods();
    const goods = [...new Set(live.map((c) => c.good))].filter((g) => !worked.has(g));
    if (!goods.length) return null;
    const n = live.filter((c) => goods.includes(c.good)).length;
    return { categories: ["charters"], goods, price: envelopePrice([{ kind: "charters", n, ageGameH: 0 }]) };
  }

  /** Goods the fleet is working: its lanes (and the charters they fill), its holds, the best lanes, charter reservations, postings let lapse. */
  private workedGoods(): Set<string> {
    const w = this.world;
    const goods = new Set<string>();
    const charterGood = (id: string) => w.charters.find((c) => c.id === id || w.currentId(c.id) === w.currentId(id))?.good;
    const lane = (l: Lane | null | undefined) => {
      if (!l) return;
      goods.add(l.good);
      for (const p of l.parts) goods.add(p.good);
      for (const [id] of l.fills) {
        const g = charterGood(id);
        if (g) goods.add(g);
      }
    };
    for (const a of this.agents.values()) {
      if (a.gone) continue;
      lane(a.lane);
      for (const g of Object.keys(a.last?.cargo_manifest ?? {})) goods.add(g);
    }
    for (const l of this.topLanes) lane(l);
    for (const id of this.reservations().charterTons.keys()) {
      const g = charterGood(id);
      if (g) goods.add(g);
    }
    for (const key of this.campState.values()) goods.add(key.slice(key.indexOf("|") + 1));
    return goods;
  }

  /**
   * Seals and lists one envelope (envelope/post): saved as sent first (one with no answer is found in envelope/mine, never
   * posted blind again). Refused (a section empty after all, our cap, presence gone): that port and kind rest a while.
   */
  private async postEnvelope(port: string, kind: "news" | "charters", plan: { categories: EnvelopeCategory[]; price: number; goods?: string[] }): Promise<boolean> {
    const w = this.world;
    const pend: PendingEnvelope = { port, kind, price: plan.price, at: w.now() };
    this.pendingEnvelopes.push(pend);
    this.persist(true);
    await this.journal?.flush();
    try {
      const e = await this.client.postEnvelope({
        port_id: port,
        price_pence: plan.price,
        categories: plan.categories,
        commodity_ids: plan.goods ?? null,
        expires_in_game_hours: ENVELOPE_LIFE_GAME_H,
      });
      this.pendingEnvelopes = this.pendingEnvelopes.filter((x) => x !== pend);
      this.envelopeRecs.set(e.id, {
        port,
        kind,
        price: e.price_pence,
        at: Date.parse(e.created_at) || w.now(),
        expiresAt: Date.parse(e.expires_at) || null,
        status: e.status,
        seen: Date.now(),
        ...(plan.goods ? { goods: plan.goods } : {}),
      });
      this.log("fleet", `listed sealed news at ${port} for ${cr(e.price_pence)}: ${e.title}`);
      this.persist(true);
      return true;
    } catch (e) {
      const unknown = outcomeUnknown(e);
      if (!unknown) this.pendingEnvelopes = this.pendingEnvelopes.filter((x) => x !== pend);
      this.persist(!unknown);
      if (this.isFatal(e) || isApiError(e, "world_paused")) throw e;
      const msg = (e as Error).message;
      if (unknown) {
        this.log("fleet", `listing sealed news at ${port}: no answer (${msg}); looked for among ours, never posted blind again`);
        return false;
      }
      this.dealSkip.set(`envelope|${port}|${kind}`, Date.now() + ENVELOPE_EVERY_GAME_H * 60 * w.gameMinuteMs);
      this.logOnceFor(`envelope-refused|${port}|${kind}|${isApiError(e) ? e.status : "?"}`, "fleet", `listing sealed ${kind === "news" ? "news" : "charter news"} at ${port} was refused: ${msg}`);
      return false;
    }
  }

  /**
   * Takes an unsold envelope of ours off the market: true once it is off (withdrawn, or already sold or withdrawn: 409, the
   * next read says which); false while it may still be listed.
   */
  private async withdrawEnvelope(id: string, rec: EnvelopeRec, why: string): Promise<boolean> {
    try {
      await this.client.withdrawEnvelope(id);
      rec.status = "withdrawn";
      this.log("fleet", `withdrew our envelope at ${rec.port} (${why})`);
      this.persist();
      return true;
    } catch (e) {
      if (this.isFatal(e) || isApiError(e, "world_paused")) throw e;
      this.envelopesDirty = true;
      if (isApiError(e) && e.status === 409) return true;
      this.logOnceFor(`envelope-withdraw|${id}`, "fleet", `withdrawing our envelope at ${rec.port} failed: ${(e as Error).message}`);
      return false;
    }
  }

  /** Ship deals and envelopes for the panel. */
  private dealsReport(): DealsReport {
    const s = this.settings;
    const iso = (t: number | null) => (t !== null && Number.isFinite(t) ? new Date(t).toISOString() : null);
    const st = this.dealStats;
    return {
      shipDeals: s.shipDeals,
      envelopes: s.envelopes,
      listings: this.listingsSeen?.rows ?? [],
      listingsAt: this.listingsSeen ? new Date(this.listingsSeen.at).toISOString() : null,
      commissions: this.commissionsSeen?.rows ?? [],
      commissionsAt: this.commissionsSeen ? new Date(this.commissionsSeen.at).toISOString() : null,
      ours: [...this.commissionRecs]
        .sort((a, b) => b[1].at - a[1].at)
        .slice(0, 10)
        .map(([id, r]) => ({ id, yard: r.yard, cls: r.cls, pricePence: r.price, collateralPence: r.collateral, status: r.status, expiresAt: iso(r.expiresAt), note: r.note ?? null })),
      openEnvelopes: [...this.envelopeRecs]
        .filter(([, r]) => r.status === "open")
        .sort((a, b) => b[1].at - a[1].at)
        .map(([id, r]) => ({ id, port: r.port, kind: r.kind, pricePence: r.price, createdAt: iso(r.at) ?? "", expiresAt: iso(r.expiresAt) })),
      shipsBought: st.shipsBought,
      commissionsDelivered: st.commissionsDelivered,
      commissionNetPence: st.commissionNet,
      envelopesSold: st.envelopesSold,
      envelopeIncomePence: st.envelopeIncome,
      action: this.dealsAction,
      envelopeAction: this.envelopeAction,
    };
  }

  /** Ship deals and envelopes for the digest (seen in the last half hour; no seller or buyer named). */
  private digestDeals(now: number): DigestInput["deals"] {
    const fresh = <T extends { at: number }>(x: T | null) => (x && Date.now() - x.at < 30 * 60_000 ? x : null);
    const rows = fresh(this.commissionsSeen)?.rows ?? [];
    const left = (iso: string | null) => {
      const t = Date.parse(iso ?? "");
      return Number.isFinite(t) ? Math.max(0, t - now) : null;
    };
    const commissions: DigestInput["deals"]["commissions"] = rows
      .filter((c) => !this.commissionRecs.has(c.id) && !c.verdict.startsWith("posted by one of our"))
      .map((c) => ({ id: c.id, yard: c.yard, cls: c.cls, price: c.pricePence, collateral: c.collateralPence, leftMs: left(c.expiresAt), margin: c.marginPence, ours: null }));
    for (const [id, r] of this.commissionRecs) {
      if (r.status === "delivered" || r.status === "failed") continue;
      commissions.unshift({ id, yard: r.yard, cls: r.cls, price: r.price, collateral: r.collateral, leftMs: r.expiresAt !== null ? Math.max(0, r.expiresAt - now) : null, margin: r.price - r.cost, ours: r.status });
    }
    const st = this.dealStats;
    return {
      listings: (fresh(this.listingsSeen)?.rows ?? []).map((l) => ({ port: l.port, cls: l.cls, price: l.pricePence, build: l.buildPence, guns: l.guns })),
      commissions,
      open: [...this.envelopeRecs.values()].filter((r) => r.status === "open").length,
      sold: st.envelopesSold,
      income: st.envelopeIncome,
      commissionNet: st.commissionNet,
    };
  }
}
