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
 * Loans by quote (finance.ts; runFinance): with leverage on, a loan bridges a hull or a load cash can't fund only when
 * it earns minLoanReturnX its interest and pays back within half its term, within maxDebtPct of net worth, on the
 * Goldsmiths' instant quote against a ship of ours; a request posted alongside lets a player lender, or a bank's lending line
 * (guide 3.13.8: standing terms that quote at once; the request is shaped to fit the cheapest that covers it), refinance it for
 * less. What is owed is kept back (debtFence; outflows on the cash timeline for loads, installments included), repaid
 * early when no ship waits for cash and always in full 2 game days before maturity. A turnkey hull cash can't fund may
 * instead be built on a ship mortgage (mortgages; guide 3.4: amortised over 180 game days, one at a time), never repaid
 * early: only its next installments are kept back. Spare cash the fleet hasn't needed
 * for a while is quoted on players' secured requests from borrowers with a clean record, and withdrawn when it is needed.
 *
 * Ship deals (deals.ts; shipDeals): the buyer also weighs ships for sale at our quays against building their class
 * (buyListing), and commissions at our yards are built to order when the price beats our cheapest build by a clear
 * margin (runCommissions), delivered at once; the Admiralty's (guide 3.4: the Crown pays, the hull joins the Royal Navy) the
 * same way, one taken at a time. Envelopes (runEnvelopes): fresh news at our quays sealed and sold, never bought.
 *
 * Remittances (ensureCash) go by bank draft when a bank undercuts the Crown's fee and has the cash there (guide 3.12: the game
 * chooses; never auto-remit): the fee as charged is booked, and what drafts saved is counted.
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
 * check; its marques and patrols are issued within the marque budget (runAiNaval); a break-up order marks
 * the ship through the dead-weight path's checks and a move order moves home through its hard gates
 * (runAiHousekeeping). What can't be done is reported back to it as a status code, and logged.
 *
 * Progress (each ship's lane and cargo state, sell floors, trips, stats, purchases, the log, the
 * event cursor and the world model's memory) is saved as it changes (journal.ts: MongoDB when
 * MONGODB_URI is set, plus a local file) and picked up again on start, so a restart resumes work.
 *
 * Runs in-process in the Next.js server (fleet-registry.ts) or from the CLI (workers/kibb-fleet.ts).
 */

import { fatalText, KibbClient, KIBB_DEFAULT_URL, isApiError, isFatalApiError, outcomeUnknown, type KibbApiError } from "../client";
import {
  ADMIRALS_TENTH,
  analyseRivals,
  bestMarque,
  bestPatrol,
  classOfHull,
  PATROL_FLOOR_PENCE_PER_BPS_DAY,
  patrolValue,
  pirateAttention,
  rivalProfiles,
  seizedShare,
  ZONE_MARQUE_CAP,
  zoneDays,
  type MarqueOption,
  type PatrolOption,
  type PatrolZoneVerdict,
  type RivalAnalysis,
  type RivalDelivery,
  type ZoneTraffic,
} from "../rivals";
import type {
  BreakUpShipResult,
  ConvoyResult,
  ConvoyStatus,
  CoveBookResult,
  CreditReport,
  EnvelopeCategory,
  EnvelopeDetail,
  EnvelopeStatus,
  GoldsmithsQuote,
  InsurancePolicyListing,
  LedgerEntry,
  LendingLine,
  LetterOfMarque,
  Loan,
  LoanRepayment,
  LoanRequestView,
  MarqueQuote,
  NavalPatrol,
  PatrolQuote,
  RelocateHomePortResult,
  SeaZonePiracyResult,
  ShipListingResult,
  UnderwritingFigures,
  WantsResult,
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
  annualBpsOf,
  creditBlemishes,
  dailyBasis,
  GOLDSMITHS_LTV_BPS,
  GOLDSMITHS_MAX_PRINCIPAL_PENCE,
  goldsmithsAnnualBps,
  IDLE_BUFFER_PENCE,
  IDLE_MAX_LOAN_SHARE,
  IDLE_MAX_QUOTES,
  IDLE_MAX_TERM_DAYS,
  IDLE_MIN_LOAN_PENCE,
  IDLE_SETTLE_GAME_H,
  idleQuoteBps,
  installmentsBefore,
  interestFor,
  LOAN_INTEREST_HEADROOM,
  LOAN_MAX_HULL_SHARE,
  LOAN_MAX_LOAD_PENCE,
  LOAN_MAX_TERM_DAYS,
  LOAN_MIN_PRINCIPAL_PENCE,
  loanCase,
  loanTerm,
  MAX_ACTIVE_LOANS,
  MORTGAGE_FENCE_DAYS,
  MORTGAGE_FENCED_INSTALLMENTS,
  MORTGAGE_INSTALLMENT_DAYS,
  mortgageCase,
  mortgageEstimate,
  mortgagePlan,
  owedAt,
  pctYear,
  perDayBps,
  REFI_MIN_SAVING_PENCE,
  REPAY_LEAD_DAYS,
  repayBy,
  REQUEST_MIN_PENCE,
  REQUEST_OPEN_GAME_H,
  type MortgagePlan,
} from "./finance";
import { judgePolicies, type UnderwriteRow } from "./underwriter";
import {
  asRegion,
  breakUpCase,
  BROKER_LADDER,
  BROKER_STEP_GAME_H,
  busyNow,
  CROWN_REFUSED_GAME_DAYS,
  DEAD_STREAK_CHECKS,
  DEAD_STREAK_GAME_DAYS,
  DEAD_TRAIL_GAME_DAYS,
  deadWeight,
  freshLadder,
  HOME_FEES_KEPT,
  homeRank,
  HORIZON_MAX_MS,
  ladderPrice,
  ladderText,
  LIST_CHECK_MS,
  RETIRE_SAIL_GAME_DAYS,
  matured,
  namedTime,
  neverRetire,
  nextStreak,
  OBSOLETE_PHASES_BEHIND,
  regionIn,
  relocationCase,
  RELOCATE_FEE_PENCE,
  RELOCATE_GAP_MS,
  RELOCATE_RETRY_MS,
  RELOCATE_WINDOW_GAME_DAYS,
  RETIRE_SKIP_MS,
  recentPerHour,
  RETIRED_KEPT,
  TOP_UPS_KEPT,
  trailingPerHour,
  VERIFY_MS,
  type BreakUpCase,
  type CrownTopUp,
  type HomeFee,
  type RelocationCase,
  type RetireMark,
  type RetireRec,
  type Streak,
} from "./housekeeping";
import {
  ARRIVAL_BERTH_GAME_H,
  ATTENTION_WINDOW_GAME_H,
  attentionGapGameH,
  BERTHED_FACTOR,
  COVE_RESALE_SHARE,
  EV_LOSS_X,
  LIVE_WANT_MAX_AGE_GAME_H,
  portHazard,
  restoreModel,
  RUN_MIN_MULTIPLE_BPS,
  runGameHours,
  runHazard,
  seizureOdds,
  SMUGGLE_DEFAULT_PENCE,
  SMUGGLE_DEFAULT_TONS,
  SMUGGLE_MAX_SHIPS,
  SMUGGLE_MIN_FLEET,
  SMUGGLE_STORES_DAYS,
  smuggleCase,
  WANT_LIFE_GAME_H,
  WANT_MAX_AGE_GAME_H,
  WANT_MIN_MULTIPLE_BPS,
  wantValue,
  type SeizureModel,
} from "./smuggle";
import type { StreamEvent } from "../schema";
import type { BankingRegion, BuildMode, BuildQuote, CatalogPort, CatalogShipClass, ContractListing, LeaderboardResult, PlaceOrderResult, RoutePlan, ShipResult } from "../types";
import { ShipAgent, STORES_BUFFER_DAYS, type AgentSnapshot, type AgentState, type AgentStats, type ConvoyOutcome, type FleetHost, type HoldInfo, type TripRecord } from "./agent";
import { openJournal, type Journal } from "./journal";
import { Advisor, AI_MODES, type AdvisorSnapshot, type AiMode, type AiReport } from "../ai/advisor";
import { AI_EFFORTS, AI_MODELS, type AiEffort, type AiModel } from "../ai/claude";
import type { DigestInput, DigestShip, DigestYard, DigestZone } from "../ai/digest";
import {
  enforceFloors,
  isHousekeeping,
  laneBanned,
  NAVAL_BPS_MIN,
  NAVAL_TERM_MIN_H,
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
import {
  freightLoot,
  OWN_TRICKLE_CONFIRM,
  returnLotStake,
  SEASON_ENDGAME_MS,
  TAPER_FREE_PENCE,
  TAPER_WINDOW_GAME_DAYS,
  World,
  type ExpansionWatch,
  type StormSummary,
  type TrickleSample,
  type WorldEventsReport,
  type WorldSnapshot,
} from "./world";

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
   * with rival traffic seen; and naval patrols where the smuggler prize money expected from the seizures
   * seen there, plus the piracy taken off our own ships, beats the patrol's quote (runPatrols). Off by default.
   */
  marques: boolean;
  /** Most spent on letters of marque and naval patrols (the autopilot's and the AI's) in any 24 real hours (pence). */
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
   * Passengers (guide 3.20) in the spare hold of voyages the fleet sails anyway, never a detour or a passage of their own: with
   * the cargo and stores aboard, offer the free hold to groups waiting for the port she makes for, a little under the fares
   * groups accepted on the route (the world's per sea mile where it has too few), never under what the weight's extra sailing
   * time costs; hold one game-hour round for them only when the fares expected beat the wait. Never on a smuggler, with
   * contraband aboard, under arrest or insured. Passengers aboard pin her next port to theirs. On by default.
   */
  usePassengers: boolean;
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
   * the term, on the Goldsmiths' instant quote (balloon, an annual rate by term) against a ship of ours (never one
   * insured, listed, in a convoy or already pledged), total owed within `maxDebtPct` of net worth; a request for quotes
   * posted alongside is approved when a player lender refinances it for less. What is owed is kept back from other
   * spending, repaid early from spare cash and always in full 2 game days before it matures. Never in the season's
   * endgame or while a loan is overdue. On by default.
   */
  leverage: boolean;
  /**
   * Ship mortgages (guide 3.4), only while leverage is on: a turnkey hull our own cash can't fund may be built with the yard
   * region's Goldsmiths paying 60% of its price (80% for an oceanic hull), amortised over 180 game days with an installment
   * every 10, a lien on the new hull with recourse, one at a time. Only within the debt cap (principal and interest), when
   * the hull's net covers its installments 1.5x over and earns minLoanReturnX its interest over the term, and the cheaper
   * in interest when an instant loan would also do. Never repaid early; its next two installments are kept back from
   * other spending. On by default; the user's "off" is a ceiling the AI can't lift.
   */
  mortgages: boolean;
  /** Most owed on loans at once (principal and interest), as a share (0–100%) of net worth. */
  maxDebtPct: number;
  /** A loan must be expected to earn at least this many times its interest over its term (1 or more). */
  minLoanReturnX: number;
  /**
   * Lend spare cash the fleet hasn't needed for ~20 game hours (beyond its loads, our loans and a 25,000 Cr buffer) by
   * quoting players' loan requests: secured (ship liens or warehouse goods) with recourse, at most 60 game days, from
   * borrowers whose credit record is clean (no default, walk-away, write-off, bankruptcy or smuggling conviction), never
   * our own companies, at 0.9x the Goldsmiths' rate for the term (never under 15% a year); quotes are withdrawn when the
   * fleet needs the cash. Never while we owe on a loan. On by default.
   */
  idleCash: boolean;
  /**
   * Ship deals (guide 3.4): the buyer also weighs ships for sale at ports where we have quay presence, and buys one priced
   * under building its class (through every check a build passes); and at yards where we have presence the autopilot
   * builds commissions to order when the price beats our cheapest build by a clear margin after the collateral's risk,
   * with the cash for the build and the collateral after loads, delivering at once. Never our own companies' listings
   * or commissions; never lists our ships but to retire them (autoBreakUp). On by default.
   */
  shipDeals: boolean;
  /**
   * Intelligence envelopes (guide 3.11): at our quays, seal fresh port reports and sailings (and non-public charters,
   * only of goods the fleet isn't working) every 2 game hours and list them at a modest price per item for their age;
   * stale ones withdrawn unsold; sales booked. Never buys any. On by default.
   */
  envelopes: boolean;
  /**
   * Break up dead weight (guide 3.4: the yard pays 35% of her rebuild value, from its region's Crown). A ship that, for 2 game days
   * and 3 checks running, lay idle earning less than her share of the upkeep with no lane from where she lies beating it (or an
   * out-of-date class whose slot a paying new hull would take, the fleet full), and only when the upkeep saved to the season's end
   * (at most a week ahead), less what she would earn, makes up the 65% of her hull net worth loses. Never the last ship, a
   * smuggler, one arrested, under an AI order, with components fitted, cargo, freight, passengers, a lane, a policy, a lien,
   * outside shares or a venture. At the yard she is listed for sale on the Exchange first (a player, or the ship broker, pays more than
   * the yard), at 60%, 55% then 51% of her rebuild value, 3 game hours a step; broken up only when unsold. One at a time. On by default; the user's
   * "off" is a ceiling the AI can't lift.
   */
  autoBreakUp: boolean;
  /**
   * Move the home port (guide 3.12: 2,500 Cr from the new home's vault) when the trade and cash have moved: one region paid most
   * of the remit fees that kept home funded over 3 game days, those fees to the season's end beat the move 1.5x over, that
   * region's vault holds the fee above the floor it would keep as home, and a ship of ours (or a factor) is there; at most once in
   * 3 real days. To the region's hub with a shipyard where we have presence, if any. On by default; the user's "off" is a
   * ceiling the AI can't lift.
   */
  autoRelocate: boolean;
  /**
   * The Free Trade (guide 3.18). OFF by default; the user's "off" is a ceiling the AI can't lift; it needs the company key's
   * `underworld` scope (allowed on the Underworld page). One dedicated ship at a time (the fastest fit one: never pledged,
   * insured, listed, sharing her ownership, in a convoy, or with lawful cargo or sealed freight aboard; never the fleet's only
   * ship) buys a small load of contraband at a cove on a fresh want (≤ a game day old, ≥ 3x base), sails it only through
   * zones no patrol works (read again before departing), lies in the wanting port's roadstead (never berthed if she can help
   * it) and runs it ashore at once; if the want is gone, on to the next live want, or back to a cove to sell on its book. Only
   * when the expected gain is at least twice the expected loss (a conservative seizure model, learned from our own runs);
   * runs are spaced for the Crown's attention. A seizure forfeits the ship and everything aboard (insurance pays nothing) and
   * puts a conviction on our public credit record: the mode then switches itself off until it is turned on again.
   */
  smuggling: boolean;
  /** Most tons of contraband one run buys. */
  smuggleMaxTons: number;
  /** Most one run spends on contraband (pence). */
  smuggleMaxPence: number;
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
  usePassengers: true,
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
  mortgages: true,
  maxDebtPct: 25,
  minLoanReturnX: 2,
  idleCash: true,
  shipDeals: true,
  envelopes: true,
  autoBreakUp: true,
  autoRelocate: true,
  smuggling: false,
  smuggleMaxTons: SMUGGLE_DEFAULT_TONS,
  smuggleMaxPence: SMUGGLE_DEFAULT_PENCE,
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
  bool("usePassengers");
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
  bool("mortgages");
  num("maxDebtPct", 0);
  if (out.maxDebtPct !== undefined && out.maxDebtPct > 100) throw new FleetSettingsError("maxDebtPct must be 0 to 100");
  num("minLoanReturnX", 1);
  if (out.minLoanReturnX !== undefined && out.minLoanReturnX > 20) throw new FleetSettingsError("minLoanReturnX must be 1 to 20");
  bool("idleCash");
  bool("shipDeals");
  bool("envelopes");
  bool("autoBreakUp");
  bool("autoRelocate");
  bool("smuggling");
  num("smuggleMaxTons", 1, true);
  if (out.smuggleMaxTons !== undefined && out.smuggleMaxTons > 500) throw new FleetSettingsError("smuggleMaxTons must be 1 to 500");
  num("smuggleMaxPence", 0, true);
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
  /** Built on a ship mortgage (guide 3.4): what the Goldsmiths paid of `costPence` (our vault paid the rest); absent otherwise. */
  mortgagePence?: number;
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
  /** `drafts` / `draftSavedPence`: our remittances banks carried as drafts, and what they saved against the Crown's fees (guide 3.12; absent from older managers). */
  totals: AgentStats & { shipsBought: number; shipSpendPence: number; drafts?: number; draftSavedPence?: number };
  agents: AgentState[];
  /** Best lanes for a reference ship, refreshed with the world. */
  topLanes: Lane[];
  purchases: PurchaseRecord[];
  buyer: string;
  /** The last letter-of-marque check (also run, as a dry run, while auto-marques are off). */
  marques: MarqueReport | null;
  /** The last underwriting check (a dry run while it is off). */
  underwriting: UnderwriteReport | null;
  /** Loans owed and made, the debt cap, idle cash quoted on requests, our requests (absent from older managers). */
  finance?: FinanceReport | null;
  /** Ships for sale and commissions seen, ours being built, our envelopes (absent from older managers). */
  deals?: DealsReport | null;
  /** The Free Trade: the smuggling mode, our smugglers, wants seen, runs, seizures (absent from older managers). */
  smuggling?: SmuggleReport | null;
  /** Passengers in the spare hold: fares earned, the groups aboard, our open offers, what the pricer learned (absent from older managers). */
  passengers?: PassengerReport | null;
  /** Fleet housekeeping: dead weight judged, listed or broken up, the home port's case, the Crowns topped up (absent from older managers). */
  housekeeping?: HousekeepingReport | null;
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

/** Passengers in the spare hold (guide 3.20) for the dashboard and the digest. Times ISO. */
export interface PassengerReport {
  /** The setting in force (the user's, or the AI's within it). */
  enabled: boolean;
  /** Why offers aren't tried for now (a 403 for the key: `market_derivatives`); null: they are. */
  blocked: string | null;
  /** Fares paid since the records began (ships retired included). */
  earnedPence: number;
  /** Groups aboard our ships, and the whole fares they pay on arrival. */
  aboard: Array<{ shipId: string; ship: string; id: string; kind: string; size: number; origin: string | null; dest: string; perHead: number; farePence: number; promisedAt: string | null }>;
  aboardFarePence: number;
  /** Our open offers (posted where the ship lies; closed when she sails). `open`: priced as uncontested, on the route's own level (absent: undercut). */
  offers: Array<{ shipId: string; ship: string; id: string; port: string; dest: string; perHead: number; berths: number; taken: number; postedAt: string; open?: boolean }>;
  /**
   * What the pricer learned per route (`from>to`): its nudge on the reference fare (contested), its level where nobody competes
   * (`adjOpen`, absent until such a round), and game-hour rounds won and left unfilled.
   */
  routes: Array<{ route: string; adj: number; adjOpen?: number; won: number; lost: number }>;
  /** Fares accepted world-wide in the pricer's cache, and when they were read. */
  fares: { records: number; readAt: string | null };
  /**
   * The fares summary as the pricer last read it (guide 3.20 item 9; absent from older managers): per route-length band the recent
   * fares, heads and median per head (the reference where a route has too few fares of its own), the routes where groups gave up
   * waiting unboarded (uncontested: offers there open high), and when it was read.
   */
  summary?: { bands: Array<{ band: string; minNm: number; maxNm: number | null; fares: number; heads: number; medianPerHead: number | null }>; uncontested: number; readAt: string | null };
}

/** Fleet housekeeping (guide 3.4, 3.12) for the panel and the digest. Money pence, times ISO. */
export interface HousekeepingReport {
  breakUp: {
    /** The setting in force (the user's, or the AI's within it). */
    enabled: boolean;
    /** Why nothing is judged now (the switch, the key, the season); null: judged every bills pass. */
    blocked: string | null;
    /**
     * Ships judged dead weight at the last pass: why (`idle`: no lane beat her upkeep; `obsolete`: a class the buyer wouldn't build,
     * a paying hull waiting for her slot), the run of checks behind it, the break-up's case over the horizon, and the verdict.
     */
    candidates: Array<{
      shipId: string;
      ship: string;
      cls: string;
      port: string | null;
      reason: "idle" | "obsolete";
      why: string;
      since: string;
      checks: number;
      /** Long enough a run to act on. */
      matured: boolean;
      rebuildPence: number;
      payoutPence: number;
      upkeepPerDayPence: number;
      earnPerDayPence: number;
      horizonHours: number;
      /** Cash by the horizon, broken up against kept; net worth given away at once; net worth by the horizon (null: not weighed yet). */
      gainPence: number | null;
      worthLossPence: number;
      worthGainPence: number | null;
      verdict: string;
    }>;
    /** Ships being retired: the stage (wanted, sail, listed, breakup, verify), the yard, a listing for sale, when decided. */
    pending: Array<{
      shipId: string;
      ship: string;
      stage: string;
      reason: "idle" | "obsolete";
      why: string;
      yard: string;
      rebuildPence: number;
      payoutPence: number;
      /** Her listing for sale on the Exchange: the broker's ladder step it is at (1-based) of how many (absent from older managers). */
      listing: { id: string | null; pricePence: number; until: string; step?: number; steps?: number } | null;
      decidedAt: string;
    }>;
    /** Ships retired, newest last: broken up (the yard's payout) or sold while listed (the price). */
    done: Array<{ at: string; shipId: string; ship: string; cls: string; port: string; how: "broken_up" | "sold"; pence: number; rebuildPence: number; worthLossPence: number; why: string }>;
    /** Regions whose Crown couldn't pay a break-up lately (409): no yard there until then. */
    refusedRegions: Array<{ region: BankingRegion; until: string }>;
    brokenUp: number;
    payoutPence: number;
    sold: number;
    soldPence: number;
    action: string;
  };
  relocate: {
    enabled: boolean;
    homePort: string | null;
    homeRegion: BankingRegion | null;
    /** Remit fees paid from other regions to keep home funded (keepHomeFloor, auto-remit) over the window, per game day and per region. */
    windowGameDays: number;
    feesPence: number;
    perDayPence: number;
    byRegion: Array<{ region: BankingRegion; feesPence: number; share: number }>;
    trackedSince: string | null;
    /** Game days the saving is counted over (to the season's end, at most a week ahead), the fees over them, and the bar (the move 1.5x). */
    gameDaysLeft: number;
    savingPence: number;
    thresholdPence: number;
    feePence: number;
    /** The region that paid most, and the port a move would go to (null: none chosen). */
    donor: BankingRegion | null;
    target: string | null;
    lastMovedAt: string | null;
    /** The soonest the next move may be made (our 3-day gap, the server's day, or a back-off). */
    nextAllowedAt: string | null;
    verdict: string;
  };
  /** The Exchequer's top-ups of Crowns run low (public world events, never how much), newest last. */
  crownsToppedUp: Array<{ at: string; region: BankingRegion | null; title: string }>;
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
   * The Crown's wealth levy (guide 3.12): net worth above the threshold, and what it pays a game day (pence), taken from
   * cash. `worthPence` / `worthSource`: the net worth it is reckoned on (the leaderboard while fresh, else our estimate;
   * absent from older managers). Absent in reports from older servers.
   */
  levy?: { thresholdPence: number; excessPence: number; perDayPence: number; worthPence?: number | null; worthSource?: "leaderboard" | "estimate" | null };
  /**
   * The charter premium taper (guide 3.7): our Crown and Admiralty charter earnings over the last `windowGameDays` (all our
   * companies the autopilot runs here), the threshold above which the premium tapers, and the factor on the premium now (1: none;
   * a delivery's own pay lowers it further). Absent in reports from older servers.
   */
  charterTaper?: { earnedPence: number; thresholdPence: number; windowGameDays: number; factor: number };
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
  /** Annual bps (`rateBasis` "annual", every loan by quote), or bps a game day for a loan made before them ("daily"). */
  rateBps: number;
  rateBasis: "daily" | "annual";
  repayment: LoanRepayment;
  /** What the quote said it repays in all, paying on schedule (null: an older loan). */
  totalRepayablePence: number | null;
  /** The next payment due (arrears within their grace, else the next installment, else all at maturity), and arrears. */
  nextPaymentAt: string | null;
  nextPaymentPence: number | null;
  arrearsPence: number;
  status: string;
  maturesAt: string | null;
  /** When it is repaid in full by (2 game days before maturity). */
  repayBy: string | null;
  /** What it was taken for (ours), or null (taken elsewhere, or a loan we made). */
  purpose: string | null;
  collateral: string;
  /** The ship pledged, if any. */
  shipId: string | null;
  /** A ship mortgage (guide 3.4: amortised, never repaid early by the autopilot; `repayBy` is its maturity). */
  isMortgage: boolean;
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
  /** Our idle-cash quotes on players' requests (principal escrowed; rate annual bps), until approved, released or withdrawn. */
  quotes: Array<{ id: string; region: BankingRegion; principalPence: number; rateBps: number; termDays: number; expiresAt: string | null }>;
  /** Our requests for quotes (posted to refinance a Goldsmiths' loan): the quotes on them and the best rate (annual bps). */
  requests: Array<{ id: string; region: BankingRegion; principalPence: number; termDays: number; status: string; quotes: number; bestBps: number | null; expiresAt: string | null; refinances: string | null }>;
  /** What idle-cash lending may have out now (spare beyond loads, our loans and the buffer, quotes included). */
  idleFreePence: number;
  /** A repayment due that cash can't cover yet (new spending stops meanwhile); null: none. */
  short: string | null;
  /** Calls with no answer, being reconciled from our loans and the requests. */
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
  /**
   * Open commissions at our yards at the last look, with our cheapest build (null: not quoted), the margin and the verdict.
   * `admiralty`: ordered by the Admiralty (guide 3.4: no buyer company, the price paid by the yard region's Crown, the deposit
   * forfeit to it undelivered, one taken at a time; the hull joins the Royal Navy); absent: a player's.
   */
  commissions: Array<{ id: string; yard: string; cls: string; pricePence: number; collateralPence: number; costPence: number | null; marginPence: number | null; expiresAt: string | null; verdict: string; admiralty?: boolean }>;
  commissionsAt: string | null;
  /** Commissions we took, until delivered or lost (`admiralty` as above). */
  ours: Array<{ id: string; yard: string; cls: string; pricePence: number; collateralPence: number; status: string; expiresAt: string | null; note: string | null; admiralty?: boolean }>;
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
  /**
   * The auto-patrol beside the marques (same switch, budget and gates; guide 3.5): smuggler prize money our patrols have earned
   * (all listed), what it did or would do, and its verdict per zone. Absent in older reports.
   */
  patrolPrizePence?: number;
  patrolAction?: string;
  patrols?: PatrolZoneVerdict[];
}

/** One of our smuggling runs (guide 3.18) for the record. `at` is server ms (ISO in the report). */
export interface SmuggleRunRec {
  at: number;
  ship: string;
  /** Where the goods were bought (null: aboard already). */
  cove: string | null;
  port: string;
  good: string;
  tons: number;
  costPence: number;
  /** What landing or selling them paid (null: nothing yet, or no notice of it). */
  proceedsPence: number | null;
  /** under way | landed | landed (no notice; pay in the vault) | nothing landed | cancelled | sold at a cove | SEIZED */
  outcome: string;
  /** Odds of a seizure and expected gain when decided (null: goods the mode didn't buy). */
  p: number | null;
  gain: number | null;
}

/** The smuggling mode for the dashboard (guide 3.18). Times ISO. */
export interface SmuggleReport {
  /** The user's setting. */
  enabled: boolean;
  /** The company key holds the underworld scope. */
  available: boolean;
  /** Acting now (the setting in force, the scope, no halt). */
  active: boolean;
  /** "on", or why not. */
  state: string;
  /** The last pass's decision. */
  action: string;
  /** Switched off by a seizure until turned on again. */
  halt: { at: string; why: string } | null;
  maxTons: number;
  maxPence: number;
  ships: Array<{
    shipId: string;
    name: string;
    purpose: "buy" | "run" | "sell";
    dest: string | null;
    want: { port: string; good: string; multipleBps: number } | null;
    load: { good: string; tons: number; pence: number; cove: string } | null;
    run: { port: string; good: string; tons: number; completesAt: string } | null;
    odds: { p: number; gain: number; loss: number } | null;
    since: string;
    zones: string[];
  }>;
  wants: Array<{ port: string; good: string; multipleBps: number; ageGameH: number; remaining: number | null; source: "live" | "board"; via: string | null }>;
  runs: Array<Omit<SmuggleRunRec, "at"> & { at: string }>;
  stats: SmuggleStats & { convictions: number };
  /** The seizure model: odds per run and per game hour in port (learned from the priors), how long a run takes, what it has seen. */
  model: {
    perRun: number;
    perPortHour: number;
    runGameH: number;
    runs: number;
    portHours: number;
    seizedInPort: number;
    seizedAtSea: number;
    /** Odds a run ends in a seizure now. */
    odds: number;
    recentRuns: number;
    nextRunAt: string | null;
  };
  /** inPort null: where she was taken isn't known (she vanished from the fleet and the last read couldn't tell). */
  convictions: Array<{ at: string; ship: string; where: string; inPort: boolean | null }>;
  log: Array<{ at: string; source: string; msg: string }>;
}

export interface SmuggleStats {
  /** Runs ashore started. */
  runs: number;
  landedTons: number;
  proceedsPence: number;
  spentPence: number;
  seizures: number;
}

/** Everything the manager saves (journal.ts) so a restart resumes where it left off. */
interface FleetSnapshot {
  progressSince: string;
  log: FleetLogLine[];
  purchases: PurchaseRecord[];
  retired: AgentStats;
  shipSpendPence: number;
  /** Our remittances carried by banks as drafts and what they saved against the Crown's fees (pence); absent in older saves. */
  drafts?: { n: number; saved: number };
  eventCursor: string | null;
  tempFactors: string[];
  hullQuotes: Array<[string, number]>;
  /** What a discount yard's quote left off the full labour and markup (`yard|class`); absent in older saves. */
  hullUplift?: Array<[string, number]>;
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
  /** `levy`: the wealth levy the ledger showed charged a game day (absent from older saves). */
  bills?: { rent: Array<[BankingRegion, number]>; upkeep: number; levy?: number; at: number };
  /** Older saves only (the autopilot once set the auto-remit reserve): ignored, never written now. */
  autoRemitSet?: { at: string; pence: number };
  /** The last critical server announcement (`at` server ms); absent: none. */
  announcement?: { at: number; message: string };
  /** The key-expiry warnings already given (KEY_WARN_MS marks) for the key expiring at `expiresAt`; absent in older saves. */
  keyWarned?: { expiresAt: number; marks: number[] };
  /**
   * Loans (as last seen, with what ours were taken for), calls with no answer still to reconcile, our idle-cash quotes and
   * our requests for quotes, and interest on loans no longer kept; absent in older saves. `offers` (credit-board offers,
   * gone with the board) and `post` calls are only in older saves: dropped on restore.
   */
  finance?: {
    recs?: Array<[string, LoanRec]>;
    pending?: PendingCredit[];
    quotes?: Array<[string, OurQuote]>;
    requests?: Array<[string, OurRequest]>;
    offers?: unknown[];
    interestPaidBefore?: number;
    interestEarnedBefore?: number;
    /** The Goldsmiths lend nothing until then (server ms; 403 goldsmiths_walk_away_ban); absent in older saves. */
    goldsmithsBanUntil?: number;
  };
  /** Commissions we took, our envelopes, posts with no answer, and what deals earned; absent in older saves. */
  deals?: {
    commissions?: Array<[string, CommissionRec]>;
    envelopes?: Array<[string, EnvelopeRec]>;
    pendingEnvelopes?: PendingEnvelope[];
    stats?: Partial<DealStats>;
  };
  /**
   * The smuggling mode: the learned seizure model, our smugglers (what each is about), the runs, the Crown's attention, what
   * it earned, the halt after a seizure and the convictions, the wants seen, its decisions; absent in older saves.
   */
  smuggle?: {
    model?: Partial<SeizureModel>;
    roles?: Array<[string, SmuggleRole]>;
    runs?: SmuggleRunRec[];
    runTimes?: number[];
    stats?: Partial<SmuggleStats>;
    halt?: { at: number; why: string } | null;
    convictions?: Array<SeizureRec>;
    /** Ids of our ships counted as seized (a notice and a guess never count one twice); absent in older saves. */
    seized?: string[];
    wants?: Array<[string, WantSeen]>;
    log?: Array<{ at: string; source: string; msg: string }>;
    scoutAt?: number;
  };
  /**
   * Fleet housekeeping: ships being retired (a listing, a break-up with no answer), ships retired, Crowns that couldn't pay a
   * break-up (server ms), the remit fees that kept home funded and since when they were tracked (server ms), our last move (local
   * ms), the server's next allowed move and a back-off (server ms, local ms), the Exchequer's top-ups, and the totals; absent in
   * older saves.
   */
  housekeeping?: {
    retiring?: Array<[string, RetireMark]>;
    done?: RetireRec[];
    refused?: Array<[BankingRegion, number]>;
    fees?: HomeFee[];
    feesSince?: number | null;
    movedAt?: number;
    nextMoveAt?: number;
    moveBlockedUntil?: number;
    topUps?: CrownTopUp[];
    stats?: Partial<RetireStats>;
    /** Ships we disposed of as dead weight (listed or sold by the retiring): never bought back. */
    disposed?: string[];
  };
}

/** What retiring ships brought in (pence) since the records began. */
interface RetireStats {
  brokenUp: number;
  payout: number;
  sold: number;
  soldPence: number;
}

/** A new hull that would take a slot the fleet is full without (slotOption): its first lane's net a real hour, payback, cost. */
interface SlotOption {
  cls: string;
  yard: string;
  perHour: number;
  payback: number;
  cost: number;
}

/** A break-up's 409 is the Crown that can't pay (guide 3.4) unless it names something else that keeps her from changing hands. */
const BREAK_UP_OTHER_409 = /list|convoy|insur|polic|lien|mortgage|loan|passeng|offer|share|venture|cargo|freight|salvage|yard|berth/i;

/** One of our ships seized for smuggling: when, which, where (inPort null: not known), and whether it was inferred (no notice). */
interface SeizureRec {
  at: number;
  ship: string;
  where: string;
  inPort: boolean | null;
  id?: string;
  guessed?: boolean;
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
  /** Ordered by the Admiralty (guide 3.4): paid by the yard region's Crown, the hull to the Royal Navy, the deposit forfeit to the Crown. */
  admiralty?: boolean;
}

/**
 * Whether a commission is the Admiralty's (guide 3.4): `admiralty: true` on the listing or its raw record, or one with no buyer company
 * (an Admiralty commission has none; a player's always names its buyer).
 */
function isAdmiralty(c: ContractListing): boolean {
  return c.admiralty === true || c.metadata?.admiralty === true || (c.contract_type === "commission" && !c.issuer_company_id);
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
  /** Annual bps, or (`rateBasis` "daily", and every record from before loans by quote) bps a game day. */
  rateBps: number;
  rateBasis?: "daily" | "annual";
  repayment?: LoanRepayment;
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
  /** Who lent it: the Goldsmiths' quote, a player's quote on our request (`board`: older saves). */
  source?: "board" | "goldsmiths" | "request";
  /** A Goldsmiths' loan of ours a request was posted to refinance (never asked twice), and one a cheaper loan replaced (repaid at once). */
  refiAsked?: boolean;
  refinanced?: boolean;
  /**
   * A request shaped to fit a bank's lending line (guide 3.13.8) was posted for it: a loan asked once before any line covered it may be
   * asked once more when one does, never again after. Absent: not asked against a line.
   */
  refiLineAsked?: boolean;
  /** A ship mortgage (`is_mortgage`, guide 3.4): runs on its installments, never refinanced or repaid early. */
  isMortgage?: boolean;
  /** Local ms of the last sighting. */
  seen: number;
}

/**
 * A credit call sent with no answer (server ms), never sent again: `borrow` (accept a Goldsmiths' quote) and `approve` (a
 * quote on our request) reconciled from loan/list by the quote's id; `request` (ours posted) from our requests; `quote`
 * (idle cash on a player's request) from that request's quotes. Older saves' `post` (a board offer) is dropped. A `borrow`
 * with `mortgage` is a mortgaged build with no answer: its loan is any mortgage of ours made since (one at a time).
 */
interface PendingCredit {
  kind: "borrow" | "approve" | "request" | "quote";
  at: number;
  region: BankingRegion;
  principal: number;
  ship?: string;
  purpose?: string;
  use?: "hull" | "load";
  source?: "board" | "goldsmiths" | "request";
  quoteId?: string;
  requestId?: string;
  /** approve / request: the Goldsmiths' loan it refinances. */
  replaces?: string;
  termDays?: number;
  rateBps?: number;
  /** borrow: a ship mortgage taken with a build (guide 3.4), and its installment (what the fence keeps back meanwhile). */
  mortgage?: boolean;
  installment?: number;
}

/** An idle-cash quote we made on a player's request (annual bps; `at` local ms made), until approved, released or withdrawn. */
interface OurQuote {
  region: BankingRegion;
  requestId: string;
  borrower: string;
  principal: number;
  rateBps: number;
  termDays: number;
  expiresAt: number | null;
  at: number;
}

/** A request for quotes we posted to refinance a Goldsmiths' loan (`replaces`), as last read (server ms). */
interface OurRequest {
  region: BankingRegion;
  principal: number;
  termDays: number;
  ship: string | null;
  replaces: string;
  status: string;
  expiresAt: number | null;
  at: number;
  /** Open quotes on it, and the cheapest (annual bps), as last read. */
  quotes: number;
  bestBps: number | null;
}

/** A want for contraband seen (guide 3.18): live at a port where a ship of ours lay (with the tons it still takes), or on a cove's board. */
interface WantSeen {
  port: string;
  good: string;
  multipleBps: number;
  /** Server ms it was seen at that multiple. */
  at: number;
  /** Tons it still takes (a live read only). */
  remaining: number | null;
  source: "live" | "board";
  /** The cove whose board told it. */
  via: string | null;
}

/** A ship smuggling for the fleet (guide 3.18; server ms). */
interface SmuggleRole {
  since: number;
  /** "buy": bound for a cove to buy (or there); "run": goods aboard bound for a want; "sell": goods aboard, back to a cove. */
  purpose: "buy" | "run" | "sell";
  dest: string | null;
  want: { port: string; good: string; multipleBps: number; seenAt: number } | null;
  /** Sea zones of the passage planned or under way (no patrol of ours goes there); null: not known yet. */
  zones: string[] | null;
  /** The goods the mode bought for this run. */
  load: { good: string; tons: number; pence: number; cove: string; at: number } | null;
  /** A run ashore under way (`before`: tons of the good aboard when it started). */
  run: { id: string; port: string; good: string; tons: number; startedAt: number; completesAt: number; before: number } | null;
  /** Lying in an ordinary port with contraband aboard: the last look, berthed then, and the ms berthed and in the roadstead so far. */
  lying: { port: string; lastAt: number; berthed: boolean; berthedMs: number; roadMs: number } | null;
  /** Sailing with contraband aboard (a voyage for the model, counted when she arrives). */
  voyage: boolean;
  /** Waiting at a cove (for a want worth a run, or a bid) since. */
  waitingSince: number | null;
  /** The odds and the value test when the passage was decided. */
  odds: { p: number; gain: number; loss: number } | null;
}

/** A run the mode might make (smuggle.ts): the want, the load, the route and its zones, stores, and the value test. */
interface RunOption {
  want: WantSeen;
  tons: number;
  plan: RoutePlan;
  zones: string[];
  /** Stores (t) the passage there and back needs, with the buffer. */
  stores: number;
  proceeds: number;
  goods: number;
  p: number;
  shipValue: number;
  /** Real hours from now until the goods are ashore. */
  hours: number;
  /** Odds the want still stands when she lands. */
  survive: number;
  gain: number;
  loss: number;
  ok: boolean;
}

/** How often the progress is saved even when nothing much happened (time use, prices). */
const PERSIST_MS = 30_000;

export interface FleetConfig {
  apiKey: string;
  baseUrl?: string;
  settings: FleetSettings;
  /** Directory for the per-company lease file; omit to skip the cross-process guard. */
  leaseDir?: string;
  /** Clear the halt a seizure put on the smuggling mode (the CLI's KIBB_SMUGGLING=resume): the user re-enables it. */
  resumeSmuggling?: boolean;
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
/** The yards' turnkey markup on the NPC-bought part of the materials (guide 3.4: 15%), waived at a discount yard. */
const YARD_MARKUP_BPS = 1_500;
/** Discount yards (guide 3.4) are a little preferred for a factor's build with no presence anywhere: their hull costs less. */
const DISCOUNT_YARD_SCORE = 1.1;
/** Spare cash kept in every non-home region for berth dues and stores. */
const REGION_FLOOR_PENCE = 20_000;
/** The home reserve covers at least this many game days of fleet upkeep and the wealth levy (and each region of its warehouse rent). */
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
/** The Crown's wealth levy (`crown_wealth_levy`, guide 3.12): its own bill, never taken for rent, upkeep or a one-off. */
const LEVY_REASON = /levy/i;
/** A refit must improve a load's expected profit by this share to be worth the berth call. */
const REFIT_MIN_GAIN = 0.02;
/** AI marques and patrols still to issue are looked at this often (one waiting for cash is tried again then). */
const AI_NAVAL_RETRY_MS = 15_000;
/** One whose call had no answer: if not among ours this long after it was sent, it wasn't issued (never sent again). */
const AI_NAVAL_SETTLE_MS = 2 * 60_000;
/** The AI's housekeeping orders (break up a ship, move home) are looked at this often: one waiting for cash or presence is tried again then. */
const AI_HOUSEKEEPING_RETRY_MS = 60_000;
/** How a mark the AI ordered reads (the log, the panel, the digest): her retiring was the AI's call, not the dead-weight path's. */
const AI_RETIRE_WHY = "ordered by the AI";
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
/**
 * Auto-patrols (guide 3.5), beside the marques on their switch, budget and gates: one game day at a time like them, the most
 * promising few zones quoted per check (by our own estimate at the 2 Cr floor: a zone that doesn't pay even there isn't quoted).
 */
const PATROL_GAME_HOURS = 24;
const PATROL_QUOTE_ZONES = 4;
/**
 * A seized smuggler's prize pool (half the base value of her and everything aboard) when neither the notices nor our own prize
 * money have shown one: half the cheapest hull open now (the cargo, unknown, counted as nothing).
 */
const SMUGGLER_POOL_SHARE = 0.5;
/** The smuggling mode's pass (guide 3.18), and live wants read where we lie: a few ports a pass, each at most this often. */
const SMUGGLE_CHECK_MS = 60_000;
const WANTS_READ_MS = 5 * 60_000;
const WANTS_PORTS_PER_PASS = 4;
/** Zones' patrols as read this recently stand for a route check (a departure always reads them afresh). */
const SMUGGLE_ZONES_FRESH_MS = 3 * 60_000;
/** Wants weighed per decision, and free ships weighed for a new run (fastest first). */
const SMUGGLE_OPTIONS = 5;
const SMUGGLE_CANDIDATES = 3;
/** Buying at a cove: at most this far over the best ask (so only what is on the book at about that price). */
const BUY_SLIP = 0.05;
/** A new run is estimated with the goods at this multiple of base (the Underworld's price drifts around base). */
const HOUSE_PRICE_GUESS = 1.1;
/** At a cove: look again this often (game minutes); wait this long for a want worth a run (game hours), then let her go. */
const COVE_RECHECK_GAME_MIN = 30;
const COVE_WAIT_GAME_H = 6;
/** A run ashore past its completes_at with no notice: waited this much longer (real ms) before the hold says what landed. */
const RUN_GRACE_MS = 30_000;
/** A smuggler holding where she is looks again this often (real ms). */
const SMUGGLE_HOLD_MS = 60_000;
/** An idle ship goes to read a cove's board at most once in this many game hours, and only to a cove this near (nm). */
const SCOUT_GAP_GAME_H = 24;
const SCOUT_MAX_NM = 600;
/** Runs, decisions kept. */
const SMUGGLE_RUNS_KEPT = 40;
const SMUGGLE_LOG_KEEP = 40;
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
 * The Crown's wealth levy (guide 3.12): a company's net worth (as the leaderboard counts it: cash, escrow, goods, hulls,
 * loans, deposits, venture stakes) above 1,000,000 Cr pays 0.1% of the excess a game day, taken from cash (richest vault
 * first, never below the threshold). Nothing escapes it by being put to work.
 */
export const WEALTH_LEVY_THRESHOLD_PENCE = 100_000_000;
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
/** A credit call with no answer that loan/list or the requests don't show this long after (server ms) wasn't made. */
const PENDING_CREDIT_MS = 10 * 60_000;
/** Each region's open requests (idle lending) as read are used this long (real ms); a borrower's credit record this long. */
const REQUESTS_TTL_MS = 60_000;
const CREDIT_TTL_MS = 10 * 60_000;
/** Banks' lending lines in a region (guide 3.13.8) are read again after this many game hours (sooner after a line is posted). */
const LINES_TTL_GAME_H = 1;
/** Idle lending reads the open requests of at most this many regions a pass (the richest spare first). */
const IDLE_REGIONS_PER_PASS = 2;
/** A request with less than this left open (game hours) isn't quoted: the borrower may not see it in time. */
const IDLE_MIN_OPEN_GAME_H = 1;
/** After a lender refused us (or nothing fitted at the source), no new loan is asked for this long (real ms). */
const BORROW_RETRY_MS = 10 * 60_000;
/** A mortgaged build refused 409 (guide 3.4: one at a time, we still owe on one): no mortgage asked for again this long (real ms). */
const MORTGAGE_BUSY_MS = 30 * 60_000;
/** A load found short of cash at its source counts as the fleet needing cash (idle cash comes back) this long (real ms). */
const CASH_SHORT_MS = 10 * 60_000;
/** A repayment with no answer: that loan is left until our loans are read again this long after. */
const REPAY_HOLD_MS = 2 * 60_000;
/** The least worth repaying early (a loan owing less is repaid whole), and how long (server ms) after it was taken a loan is first repaid early. */
const MIN_REPAY_PENCE = 10_000;
const LOAN_EARLY_GRACE_MS = 3 * 60_000;
/** A refused idle-cash quote, request or approval waits this long (real ms) before the next. */
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
function stormFrom(e: StreamEvent): { hazard: string; zone: string | null; at: number | null; share: number | null; stores: number | null; sunk: boolean } | null {
  const p = (e.payload && typeof e.payload === "object" ? e.payload : {}) as Record<string, unknown>;
  const name = [p.hazard, p.kind, p.type].find((v): v is string => typeof v === "string");
  const hazard = (name ?? "hazard").toLowerCase();
  const rescued = hazard.includes("rescue");
  if (!hazard.includes("storm") && !rescued) return null;
  const loss = typeof p.cargo_loss_pct === "number" ? p.cargo_loss_pct / 100 : null;
  // The share of the stores taken varies too (guide 3.5): learned for the stores planned against further storms.
  const stores = typeof p.stores_loss_pct === "number" ? p.stores_loss_pct / 100 : null;
  return { hazard, zone: e.sea_zone_id ?? null, at: Date.parse(e.timestamp) || null, share: rescued ? null : loss, stores: rescued ? null : stores, sunk: p.sunk === true || rescued };
}

/** Errors no retry will fix: wrong key, missing scopes, another process running this company. */
class InitFatal extends Error {}

/** The Goldsmiths' refusal for a real day after any walk-away by us or a linked company (guide 3.13.1). */
const WALK_AWAY_BAN = "goldsmiths_walk_away_ban";

/**
 * When a goldsmiths_walk_away_ban ends (server ms): a time the refusal names (a field of its body, or the first timestamp in its
 * detail), else a real day from `now`. One that can't be read, has passed, or lies past the rule's day is taken as a day from now.
 */
function walkAwayBanEnd(e: KibbApiError, now: number): number {
  const day = 24 * 3_600_000;
  const body = (typeof e.body === "object" && e.body ? e.body : {}) as unknown as Record<string, unknown>;
  const named = ["until", "banned_until", "ban_until", "ban_ends_at", "lends_again_at", "retry_at", "available_at"].map((k) => body[k]).find((v): v is string => typeof v === "string");
  const text = named ?? e.detail.match(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/)?.[0];
  const t = text ? Date.parse(text) : Number.NaN;
  return Number.isFinite(t) && t > now && t <= now + day + 3_600_000 ? t : now + day;
}

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
  /**
   * The last turnkey quote per `yard|class` (pence): what a build there costs us (a discount yard's too), pricing a build at a
   * yard where we have no presence yet. Rebuild value (hullValue, knownQuotes) reads it without the discount (hullUplift).
   */
  private readonly hullQuotes = new Map<string, number>();
  /** Per discount yard's `yard|class` quoted (guide 3.4): what its labour cut and waived markup took off the full price. */
  private readonly hullUplift = new Map<string, number>();
  /** Factor passes in a row that built nothing: each one backs off longer. */
  private factorFails = 0;
  /** Factors the buyer hired for a build and hasn't dismissed yet (never the user's own). */
  private readonly tempFactors = new Set<string>();
  /** Resident Factors the company has (the user's too: all are billed), as last listed. */
  private factorCount = 0;
  /** The daily bills as the ledger last showed them (learnBills; saved). */
  private bills: { rent: Map<BankingRegion, number>; upkeep: number; levy: number; at: number | null } = { rent: new Map(), upkeep: 0, levy: 0, at: null };
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
  /** Zones' patrol prices per bps per game day as last quoted (`patrol-quote`, local ms). */
  private readonly patrolPrices = new Map<string, { price: number; at: number }>();
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
  /** Every loan of ours seen (saved), credit calls with no answer, our idle-cash quotes and our requests (by id; saved). */
  private readonly loanRecs = new Map<string, LoanRec>();
  private pendingCredit: PendingCredit[] = [];
  private readonly ourQuotes = new Map<string, OurQuote>();
  private readonly ourRequests = new Map<string, OurRequest>();
  /** Interest on loan records no longer kept (paid on ours, earned on those we made). */
  private interestPaidBefore = 0;
  private interestEarnedBefore = 0;
  /** Each region's open loan requests as last read (local ms), and borrowers' credit records (by company id). */
  private readonly requestsSeen = new Map<BankingRegion, { at: number; requests: LoanRequestView[] }>();
  private readonly creditSeen = new Map<string, { at: number; report: CreditReport }>();
  /** Banks' open lending lines by region as last read (local ms; a failed read keeps the last): a refinance request is shaped to fit one. */
  private readonly linesSeen = new Map<BankingRegion, { at: number; lines: LendingLine[] }>();
  /** Since when (local ms) spare cash has been idle with nothing to fund (0: needed lately): quotes wait IDLE_SETTLE_GAME_H. */
  private idleSince = 0;
  /** Requests a lender quoted on lately (loan_quote_received): read again soon. Our own requests as last listed (local ms). */
  private requestsDirty = false;
  private requestsMine: { at: number; list: LoanRequestView[] } | null = null;
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
  /** No new loan before this (local ms): a lender refused lately. A refused quote, request or approval waits too. */
  private borrowRetryAt = 0;
  /** Server ms until which the Goldsmiths quote and lend nothing (guide 3.13.1: 403 goldsmiths_walk_away_ban after any walk-away). */
  private goldsmithsBanUntil = 0;
  /** No ship mortgage asked for before this (local ms): a mortgaged build was refused 409 (one still owed, guide 3.4). */
  private mortgageBusyUntil = 0;
  /** The last reason a mortgage was refused per `yard|class` the buyer weighed one for ("ok": it passed): logged when it changes. */
  private readonly mortgageSeen = new Map<string, string>();
  private idleRetryAt = 0;
  private refiRetryAt = 0;
  /** Loans a request for quotes found no other ship of ours free to pledge for: not looked at again until then (local ms). */
  private readonly refiNoShip = new Map<string, number>();
  /** Loans whose repayment had no answer: left alone until then (local ms), read again first. */
  private readonly repayHold = new Map<string, number>();
  /** Commissions we took and our envelopes (saved), envelope posts with no answer, and what deals earned. */
  private readonly commissionRecs = new Map<string, CommissionRec>();
  private readonly envelopeRecs = new Map<string, EnvelopeRec>();
  private pendingEnvelopes: PendingEnvelope[] = [];
  private dealStats: DealStats = { shipsBought: 0, commissionsDelivered: 0, commissionNet: 0, envelopesSold: 0, envelopeIncome: 0 };
  /** Listings and commissions left alone until then (local ms): refused, sold, unbuildable; envelope kinds per `port|kind` the same. */
  private readonly dealSkip = new Map<string, number>();
  /**
   * Admiralty commissions left alone until then (local ms): taking one was refused (409, guide 3.4: our player's companies hold one
   * taken already, perhaps by hand or by another company of ours), so none is tried for a game day.
   */
  private admiraltyBlockedUntil = 0;
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
  private retired: AgentStats = { trips: 0, deliveredTons: 0, rewardPence: 0, spentPence: 0, freightPence: 0, passengerPence: 0 };
  /** Loads planned again at their source (saved). */
  private resized: ResizeStats = { checks: 0, grown: 0, shrunk: 0, switched: 0, tonsAdded: 0, tonsCut: 0, at: null };
  private shipSpendPence = 0;
  /** Our remittances banks carried as drafts (guide 3.12) and what they saved against the Crown's fees (pence), since the records began. */
  private drafts = { n: 0, saved: 0 };
  /** Drafts our own remit calls logged lately (their ledger groups): the `bank_draft` notice of one isn't logged again. */
  private readonly draftsLogged = new Set<string>();
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
   * bought (ship market), found by her id rather than a new ship's name. `mortgage`: built on a ship mortgage (guide 3.4) of
   * that principal (`price` is then our vault's part); its loan is reconciled from our loans (a `borrow` PendingCredit).
   */
  pendingBuild: {
    name: string;
    yard: string;
    cls: string;
    price: number;
    cost?: number;
    leaseBefore?: number | null;
    payback: number;
    lane: string;
    at?: number;
    shipId?: string;
    mortgage?: { principal: number; installment: number };
  } | null = null;
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

  // The Free Trade (guide 3.18): the smuggling mode.
  /** The key holds `underworld` (whoami): without it the mode is unavailable. */
  private canSmuggle = false;
  /** Ships smuggling for the fleet (ship id → what she is about). Saved. */
  private readonly smugglers = new Map<string, SmuggleRole>();
  /** The learned seizure model (smuggle.ts). Saved. */
  private smuggleModel: SeizureModel = restoreModel(null);
  /** Our runs, newest last. Saved. */
  private smuggleRuns: SmuggleRunRec[] = [];
  /** Server ms our runs ashore started (the Crown's attention). Saved. */
  private smuggleRunTimes: number[] = [];
  private smuggleStats: SmuggleStats = { runs: 0, landedTons: 0, proceedsPence: 0, spentPence: 0, seizures: 0 };
  /** After a seizure the mode stays off until the user turns it on again (CLI: KIBB_SMUGGLING=resume). Saved. */
  private smuggleHalt: { at: number; why: string } | null = null;
  /** Our ships seized for smuggling: each a conviction on our public credit record. Saved. */
  private convictions: SeizureRec[] = [];
  /** Our ships sold or broken up lately (ship_sold, ship_broken_up): gone for that reason, never counted as seized. */
  private readonly leftFleet = new Set<string>();
  /** Ships whose seizure is counted (a notice, or a smuggler gone with contraband aboard): once each. */
  private readonly seizedNoted = new Set<string>();
  /** Wants seen (`port|good`). Saved. */
  private readonly wantsSeen = new Map<string, WantSeen>();
  /** When each port's wants were last read (local ms). */
  private readonly wantsReadAt = new Map<string, number>();
  /** The mode's decisions, for the panel and the digest. Saved. */
  private smuggleLog: Array<{ at: string; source: string; msg: string }> = [];
  private smuggleAction = "not checked yet";
  private lastSmuggleCheck = 0;
  /** When an idle ship last went to read a cove's board (server ms). Saved. */
  private lastScoutAt = 0;
  private readonly resumeSmuggling: boolean;
  /** Called when a seizure switches the mode off (the dashboard saves the setting off). */
  private readonly onSmugglingHalted?: () => void;

  // Fleet housekeeping (housekeeping.ts; reviewDeadWeight, retireTurn, reviewHome).
  /** Ships being retired (ship id → where she stands): no lane, convoy, smuggling run, passengers or refit while marked. Saved. */
  private readonly retiring = new Map<string, RetireMark>();
  /** Dead-weight runs of checks per ship, the last pass's judgements (the panel), and ships left alone until then (local ms). */
  private readonly deadStreaks = new Map<string, Streak>();
  private deadSeen: HousekeepingReport["breakUp"]["candidates"] = [];
  private readonly retireSkip = new Map<string, number>();
  /** A class's rebuild value asked of a yard of ours (a turnkey quote) at most hourly (local ms). */
  private readonly quoteTried = new Map<string, number>();
  /** The last verdict said per ship (or `fleet`), so a refusal is logged once per change, not every pass. */
  private readonly retireSaid = new Map<string, string>();
  /** Ships retired (saved; newest last), the ids among them (a notice after our own call isn't counted again), and the totals. */
  private retiredRecs: RetireRec[] = [];
  private readonly retiredIds = new Set<string>();
  /**
   * Ships we disposed of as dead weight (listed by the retiring, or sold so): never bought back by our own buyer when the broker (or
   * a player) puts the same hull up again (guide 3.4: the broker's resales are often the cheapest hulls about). Saved.
   */
  private readonly disposedIds = new Set<string>();
  private retireStats: RetireStats = { brokenUp: 0, payout: 0, sold: 0, soldPence: 0 };
  /** Regions whose Crown couldn't pay a break-up (409): server ms until a yard there is tried again. Saved. */
  private readonly crownRefused = new Map<BankingRegion, number>();
  private retireAction = "not checked yet";
  /** Why each ship's last retiring was withdrawn (unmark), newest last: what an AI break-up order comes back with. */
  private readonly retireWithdrawn = new Map<string, string>();
  /** The AI's housekeeping orders (break up, move home) last looked at (local ms). */
  private lastAiHousekeepingTry = 0;
  /** Remit fees that kept home funded (server ms; saved), since when they are tracked (server ms), and the last case worked out. */
  private homeFees: HomeFee[] = [];
  private feesSince: number | null = null;
  private homeCase: (RelocationCase & { target: string | null; verdict: string; daysLeft: number }) | null = null;
  /** Our last move (local ms), the server's next allowed one (server ms), and a back-off after a refusal (local ms). Saved. */
  private movedAt = 0;
  private nextMoveAt = 0;
  private moveBlockedUntil = 0;
  private relocateSaid = "";
  /** The Exchequer's top-ups seen on the feed (newest last). Saved. */
  private crownTopUps: CrownTopUp[] = [];

  constructor(
    cfg: FleetConfig,
    opts: { onLog?: (line: FleetLogLine) => void; carryOver?: Pick<FleetState, "log" | "purchases">; onSmugglingHalted?: () => void } = {},
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
        self.lastAiHousekeepingTry = 0;
        for (const a of self.agents.values()) if (a.idle || a.held) a.nudge();
        self.reviewStalls();
      },
      companyId: () => self.world.companyId,
    });
    this.leaseDir = cfg.leaseDir;
    this.onLog = opts.onLog;
    this.onSmugglingHalted = opts.onSmugglingHalted;
    this.resumeSmuggling = !!cfg.resumeSmuggling;
    if (opts.carryOver) {
      this.logLines = opts.carryOver.log.slice(-LOG_LIMIT);
      this.purchases = opts.carryOver.purchases.slice(-50);
    }
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  get state(): FleetState {
    const agents = [...this.agents.values()].map((a) => a.state);
    const totals = { ...this.retired, shipsBought: this.purchases.length, shipSpendPence: this.shipSpendPence, drafts: this.drafts.n, draftSavedPence: this.drafts.saved };
    for (const a of agents) {
      totals.trips += a.stats.trips;
      totals.deliveredTons += a.stats.deliveredTons;
      totals.rewardPence += a.stats.rewardPence;
      totals.spentPence += a.stats.spentPence;
      totals.freightPence += a.stats.freightPence;
      totals.passengerPence += a.stats.passengerPence ?? 0;
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
      smuggling: this.smuggleReport(),
      passengers: this.passengerReport(totals.passengerPence),
      housekeeping: this.housekeepingReport(),
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

  /** Passengers in the spare hold for the dashboard (`earned`: the fares in the totals). */
  private passengerReport(earned: number): PassengerReport {
    const ships = [...this.agents.values()].filter((a) => !a.gone);
    const aboard = ships.flatMap((a) =>
      a.paxGroups().map((g) => ({ shipId: a.shipId, ship: a.name, id: g.id, kind: g.kind, size: g.size, origin: g.origin, dest: g.dest, perHead: g.perHead, farePence: g.farePence, promisedAt: g.promisedAt })),
    );
    const fares = this.world.fares;
    const summary = this.world.fareSummary;
    return {
      enabled: this.settings.usePassengers,
      blocked: this.world.paxBlockedNow(),
      earnedPence: Math.round(earned),
      aboard,
      aboardFarePence: aboard.reduce((n, g) => n + g.farePence, 0),
      offers: ships.flatMap((a) =>
        a.paxOffers().map((o) => ({
          shipId: a.shipId,
          ship: a.name,
          id: o.id,
          port: o.port,
          dest: o.dest,
          perHead: o.perHead,
          berths: o.berths,
          taken: o.taken,
          postedAt: new Date(o.at).toISOString(),
          ...(o.open ? { open: true } : {}),
        })),
      ),
      routes: this.world
        .paxRouteList()
        .sort((x, y) => y[1].at - x[1].at)
        .slice(0, 30)
        .map(([route, x]) => ({ route, adj: Math.round(x.adj * 1000) / 1000, ...(x.adjOpen !== undefined ? { adjOpen: Math.round(x.adjOpen * 1000) / 1000 } : {}), won: x.won, lost: x.lost })),
      fares: { records: fares.records.length, readAt: fares.at ? new Date(fares.at).toISOString() : null },
      summary: {
        bands: summary.bands.map((b) => ({ band: b.band, minNm: b.min_nm, maxNm: b.max_nm ?? null, fares: b.fares, heads: b.heads, medianPerHead: b.median_fare_per_head_pence ?? null })),
        uncontested: summary.unmet,
        readAt: summary.at ? new Date(summary.at).toISOString() : null,
      },
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
    // Turned on again after a seizure switched it off: the user's call.
    if (prev && !prev.smuggling && v.smuggling && this.smuggleHalt) {
      this.smuggleNote("smuggling", `smuggling re-enabled by the user after the seizure (${this.smuggleHalt.why})`);
      this.smuggleHalt = null;
      this.persist(true);
    }
    this.syncWorldFlags();
    this.stakesAt = 0;
  }

  /** The world's own copies of settings in force (the user's, or the AI's overrides), after either changes. */
  private syncWorldFlags(): void {
    const s = this.settings;
    this.world.rivalIntel = s.rivalIntel;
    this.world.planOnEvents = s.actOnEvents;
    const hadPax = this.world.usePassengers;
    this.world.usePassengers = s.usePassengers;
    // Off (the user, or the AI's ceiling): our open offers go now, so no group boards to pin a ship (each sailTo checks it too).
    if (hadPax && !s.usePassengers) for (const a of this.agents.values()) a.dropOffers("passengers switched off");
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
      patrolPrice: this.patrolPriceMap(),
      noPatrolZones: this.smugglingZones(),
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

  /** Zones' patrol prices per bps per game day quoted lately (pence). */
  private patrolPriceMap(): Map<string, number> {
    const now = Date.now();
    return new Map([...this.patrolPrices].filter(([, x]) => now - x.at < MARQUE_PRICE_TTL_MS).map(([z, x]) => [z, x.price]));
  }

  private notePatrolPrice(q: PatrolQuote): void {
    this.patrolPrices.set(q.sea_zone_id, { price: q.price_per_bps_day_pence, at: Date.now() });
  }

  /**
   * Sea zones no patrol of ours may go (guide 3.18: "sponsoring a patrol where your own ships smuggle always loses money": its
   * search may take our own ship, which is forfeit with everything aboard, and the prize never covers her). Every zone a ship of
   * ours with contraband aboard may pass: the rest of her route at sea, her lane's passage and her port's zone in port; and
   * every zone our smuggling runs use (smugglingRouteZones). Null when that can't be told (a ship that hasn't reported yet, one
   * with contraband aboard whose route isn't known: at sea with no legs left, holding a lane with no zones she isn't sailing, or
   * lying in an ordinary port with no passage planned; or the runs' zones unknown): then no patrol at all.
   */
  private smugglingZones(): Set<string> | null {
    const w = this.world;
    const runs = this.smugglingRouteZones();
    if (runs === null) return null;
    const out = new Set(runs);
    for (const a of this.agents.values()) {
      if (a.gone) continue;
      const r = a.last;
      // A ship that hasn't reported yet may carry contraband.
      if (!r) return null;
      if (a.contrabandAboard(r).length === 0) continue;
      // A node is a zone or a port (its own zone).
      const add = (node: string | null | undefined) => {
        const z = node ? w.hazardZone(node)?.id : undefined;
        if (z) out.add(z);
      };
      if (r.ship.status === "sailing") {
        const rest = r.route_legs.slice(r.ship.current_leg_idx);
        if (rest.length === 0) return null;
        for (const l of rest) {
          add(l.from_node);
          add(l.to_node);
        }
      } else {
        if (!r.ship.current_port_id) return null;
        add(r.ship.current_port_id);
        // Lying in an ordinary port with no passage planned (a lane with zones, or a smuggler bound elsewhere): she may sail
        // anywhere next (on to a want, back to a cove), and a patrol of ours on that way would strand her where she may be
        // searched: no patrol anywhere until it is known. At a cove she is never searched, and the mode re-reads every zone
        // before she sails.
        const role = this.smugglers.get(a.shipId);
        const planned = !!a.lane?.zones || (!!role?.dest && role.dest !== r.ship.current_port_id && role.zones !== null);
        if (!w.isCove(r.ship.current_port_id) && !planned) return null;
      }
      // Her next passage, as planned. A lane with no zones (one for cargo already aboard, or saved before zones were kept) is
      // known only while she sails it (the route above); otherwise her passage can't be told: no patrol anywhere.
      const lane = a.lane;
      if (lane) {
        if (lane.zones) for (const z of lane.zones) out.add(z);
        else if (!(r.ship.status === "sailing" && r.route_legs.at(-1)?.to_node === lane.dest)) return null;
      }
    }
    return out;
  }

  /**
   * The sea zones our smuggling runs cross or are about to (guide 3.18: a patrol of ours there would search our own ship), for
   * smugglingZones: each smuggler's passage as planned or sailed (cove to the wanting port, on to a cove). Null when a smuggler
   * is bound somewhere whose passage isn't known yet: then no patrol of ours goes anywhere.
   */
  private smugglingRouteZones(): Set<string> | null {
    const out = new Set<string>();
    for (const [id, role] of this.smugglers) {
      const a = this.agents.get(id);
      if (!a || a.gone) continue;
      if (role.dest && role.zones === null) return null;
      for (const z of role.zones ?? []) out.add(z);
    }
    return out;
  }

  // ── The Free Trade (guide 3.18) ─────────────────────────────────────────────

  /** Whether the smuggling mode may act now: the setting in force (the user's "off" is a ceiling for the AI), the key's scope, no halt. */
  private smugglingOn(): boolean {
    return this.settings.smuggling && this.canSmuggle && !this.smuggleHalt;
  }

  /** Why the smuggling mode isn't acting (null: it is). */
  private smugglingOff(): string | null {
    if (!this.ownSettings.smuggling) return "off";
    if (!this.canSmuggle) return "unavailable: the company key lacks the underworld scope (allow smuggling on the Underworld page)";
    if (this.smuggleHalt) return `off since a seizure (${this.smuggleHalt.why}): turn it on again to resume`;
    if (!this.settings.smuggling) return "switched off by the AI for its horizon";
    return null;
  }

  /** Whether this ship smuggles for the fleet now (the mode took her). */
  isSmuggler(agent: ShipAgent): boolean {
    return this.smugglers.has(agent.shipId);
  }

  /** Whether the ship has contraband aboard as last read. */
  private carriesContraband(a: ShipAgent | undefined): boolean {
    const r = a?.last;
    return !!a && !!r && a.contrabandAboard(r).length > 0;
  }

  /** Real ms in a game hour. */
  private get gameHourMs(): number {
    return 60 * this.world.gameMinuteMs;
  }

  /** A decision of the smuggling mode: logged (on the ship's line when it is hers) and kept for the panel and the digest. */
  private smuggleNote(source: string, msg: string): void {
    this.log(source, msg);
    this.smuggleLog.push({ at: new Date().toISOString(), source, msg });
    if (this.smuggleLog.length > SMUGGLE_LOG_KEEP) this.smuggleLog.splice(0, this.smuggleLog.length - SMUGGLE_LOG_KEEP);
  }

  /** smuggleNote once per key (a ship waiting on the same thing doesn't fill the log). */
  private smuggleOnce(key: string, source: string, msg: string): void {
    if (this.loggedOnce.has(key)) return;
    this.loggedOnce.add(key);
    if (this.loggedOnce.size > 200) this.loggedOnce.delete(this.loggedOnce.values().next().value!);
    this.smuggleNote(source, msg);
  }

  /** The key no longer holds `underworld` (a 403 missing_scope): the mode is unavailable until it is allowed again. */
  private loseSmugglingScope(): void {
    if (!this.canSmuggle) return;
    this.canSmuggle = false;
    this.smuggleNote("smuggling", "the company key no longer holds the underworld scope: the smuggling mode is unavailable until smuggling is allowed again on the Underworld page");
  }

  /** Our runs ashore started within the Crown's attention window. */
  private recentRuns(now = this.world.now()): number {
    const since = now - ATTENTION_WINDOW_GAME_H * this.gameHourMs;
    return this.smuggleRunTimes.filter((t) => t >= since).length;
  }

  /** Server ms from which the Crown's attention allows the next run (0: any time). */
  private nextRunAt(now = this.world.now()): number {
    const last = this.smuggleRunTimes.at(-1);
    return last === undefined ? 0 : last + attentionGapGameH(this.recentRuns(now)) * this.gameHourMs;
  }

  /** Odds a run ends in a seizure now (smuggle.ts: per run, and the hours lying berthed and in the wanting port's roadstead). */
  private seizureOddsNow(): number {
    return seizureOdds(this.smuggleModel, { berthH: ARRIVAL_BERTH_GAME_H, roadH: runGameHours(this.smuggleModel) + 0.25, recent: this.recentRuns() });
  }

  /**
   * Wants as the game told them (guide 3.18). At a port: every want live there now (with the tons it still takes; one missing
   * from it is gone). At a cove: its board of wants carried in by ships, the freshest per port and good, by when seen.
   */
  private noteWants(res: WantsResult): void {
    const w = this.world;
    const now = w.now();
    if (res.is_cove) {
      for (const b of res.board ?? []) {
        if (!w.isContraband(b.commodity_id) || w.isCove(b.port_id)) continue;
        const at = Date.parse(b.observed_at);
        const seenAt = Number.isFinite(at) ? at : now - b.age_game_hours * this.gameHourMs;
        const key = `${b.port_id}|${b.commodity_id}`;
        const had = this.wantsSeen.get(key);
        if (had && had.at >= seenAt) continue;
        this.wantsSeen.set(key, { port: b.port_id, good: b.commodity_id, multipleBps: b.multiple_bps, at: seenAt, remaining: null, source: "board", via: res.port_id });
      }
      return;
    }
    for (const [k, x] of this.wantsSeen) if (x.port === res.port_id) this.wantsSeen.delete(k);
    for (const x of res.wants ?? []) {
      if (!w.isContraband(x.commodity_id) || !(x.remaining_tons > 0)) continue;
      this.wantsSeen.set(`${res.port_id}|${x.commodity_id}`, {
        port: res.port_id,
        good: x.commodity_id,
        multipleBps: x.multiple_bps,
        at: now,
        remaining: x.remaining_tons,
        source: "live",
        via: null,
      });
    }
  }

  /** Reads a port's live wants or a cove's board (needs a ship there, or a factor at a port). Null: not seen. */
  private async readWants(port: string): Promise<WantsResult | null> {
    this.wantsReadAt.set(port, Date.now());
    try {
      const res = await this.client.underworldWants(port);
      this.noteWants(res);
      return res;
    } catch (e) {
      if (this.isFatal(e) || isApiError(e, "world_paused")) throw e;
      if (isApiError(e, "missing_scope")) this.loseSmugglingScope();
      return null;
    }
  }

  /** Wants older than any could still stand are forgotten. */
  private pruneWants(): void {
    const now = this.world.now();
    for (const [k, x] of this.wantsSeen) if (now - x.at > WANT_LIFE_GAME_H * this.gameHourMs) this.wantsSeen.delete(k);
  }

  /** Wants seen fresh enough and rich enough, at open ordinary ports, best (multiple × base) first. */
  private freshWants(o: { maxAgeGameH: number; minBps: number; goods?: ReadonlySet<string>; except?: string }): WantSeen[] {
    const w = this.world;
    const now = w.now();
    return [...this.wantsSeen.values()]
      .filter(
        (x) =>
          (now - x.at) / this.gameHourMs <= o.maxAgeGameH &&
          x.multipleBps >= o.minBps &&
          (!o.goods || o.goods.has(x.good)) &&
          x.port !== o.except &&
          w.isOpen(x.port) &&
          !w.isCove(x.port) &&
          (x.remaining === null || x.remaining > 0),
      )
      .sort((a, b) => b.multipleBps * w.basePrice(b.good) - a.multipleBps * w.basePrice(a.good));
  }

  /** Live wants where we lie (ships in ordinary ports, factors): a few ports a pass, each at most every WANTS_READ_MS. */
  private async pollWants(): Promise<void> {
    const w = this.world;
    const ports = new Set<string>();
    for (const a of this.agents.values()) {
      const r = a.last;
      const at = r && r.ship.status !== "sailing" ? r.ship.current_port_id : null;
      if (!a.gone && at && !w.isCove(at)) ports.add(at);
    }
    for (const p of this.factorPorts) if (!w.isCove(p)) ports.add(p);
    const due = [...ports].filter((p) => Date.now() - (this.wantsReadAt.get(p) ?? 0) > WANTS_READ_MS).slice(0, WANTS_PORTS_PER_PASS);
    for (const p of due) {
      await this.readWants(p);
      if (!this.canSmuggle) return;
    }
  }

  /** The sea zones a passage rolls in (each leg's end, and its ends' own zones). */
  private routeZones(plan: { from_port?: string; to_port?: string; legs: Array<{ from_node: string; to_node: string }> }): string[] {
    const w = this.world;
    const out = new Set<string>();
    const add = (n: string | undefined) => {
      const z = n ? w.hazardZone(n)?.id : undefined;
      if (z) out.add(z);
    };
    add(plan.from_port);
    for (const l of plan.legs) {
      add(l.from_node);
      add(l.to_node);
    }
    add(plan.to_port);
    return [...out];
  }

  /** Zones among these a patrol works now, as last read (one missing from the read counts: it can't be told). */
  private patrolled(zones: string[]): string[] {
    const st = this.zoneStatus;
    const read = st && Date.now() - st.at < SMUGGLE_ZONES_FRESH_MS ? new Map(st.zones.map((z) => [z.sea_zone_id, z.patrol_suppression_bps])) : this.world.patrolBps;
    return zones.filter((z) => {
      const bps = read.get(z);
      return bps === undefined || bps > 0;
    });
  }

  /** Reads every zone's patrols now (before a departure with contraband aboard). False: couldn't. */
  private async readZonesNow(): Promise<boolean> {
    try {
      const zones = await this.client.zones();
      this.zoneStatus = { at: Date.now(), zones };
      this.world.patrolBps = new Map(zones.map((z) => [z.sea_zone_id, z.patrol_suppression_bps]));
      return true;
    } catch (e) {
      if (this.isFatal(e) || isApiError(e, "world_paused")) throw e;
      return false;
    }
  }

  /**
   * A run from `from` to a want for `tons` costing `goods` (0: aboard already), setting out `extraMs` from now (the passage to
   * the cove first): its route (rated for her hull, no patrol on it as last read), the stores it needs (there and back to
   * `from`, plus a buffer: none may be bought in an ordinary port with contraband aboard), what it is expected to fetch, the
   * odds of a seizure and the value test (smuggle.ts). A string says why there is none.
   */
  private async runOption(a: ShipAgent, r: ShipResult, from: string, want: WantSeen, tons: number, goods: number, extraMs = 0): Promise<RunOption | string> {
    const w = this.world;
    const cls = w.shipClass(a.shipClass);
    const hull = cls?.hull_category ?? "coastal";
    const route = (x: string, y: string) =>
      w.route(x, y, a.shipClass).catch((e: unknown) => {
        if (this.isFatal(e) || isApiError(e, "world_paused")) throw e;
        return null;
      });
    const plan = await route(from, want.port);
    if (!plan) return `no route ${from} → ${want.port}`;
    if (!w.routeRated(plan, hull)) return `${from} → ${want.port} crosses water a ${hull} hull isn't rated for`;
    const zones = this.routeZones(plan);
    const patrols = this.patrolled(zones);
    if (patrols.length) return `a patrol works ${patrols.join(", ")} on ${from} → ${want.port}`;
    const back = await route(want.port, from);
    const knots = ((cls?.base_speed_centiknots ?? 800) / 100) * 0.9;
    const sailMs = w.sailMs(plan.total_distance_nm, knots);
    const inPortMs = (ARRIVAL_BERTH_GAME_H + runGameHours(this.smuggleModel)) * this.gameHourMs;
    const landAt = w.now() + extraMs + sailMs + inPortMs;
    const v = wantValue({ basePence: w.basePrice(want.good), multipleBps: want.multipleBps, ageGameH: (landAt - want.at) / this.gameHourMs, tons, remaining: want.remaining });
    const p = this.seizureOddsNow();
    const shipValue = this.hullValue(a.shipClass) + r.ship.cannons_count * GUN_PRICE_PENCE;
    const hours = (extraMs + sailMs + inPortMs) / 3_600_000;
    const proceeds = v.perTon * tons;
    const c = smuggleCase({ proceeds, goods, shipValue, p, timeCost: a.rate * hours });
    const stores =
      a.safeStoresFor(from, want.port, plan) + (back ? a.safeStoresFor(want.port, from, back) : a.safeStoresFor(from, want.port, plan)) + SMUGGLE_STORES_DAYS * plan.port_provisions_tons_per_day;
    return { want, tons, plan, zones, stores, proceeds, goods, p, shipValue, hours, survive: v.survive, ...c };
  }

  /** A run option for the log: what, where, the want, the odds and the value test. */
  private optionText(o: RunOption): string {
    const age = (this.world.now() - o.want.at) / this.gameHourMs;
    return (
      `${o.tons} t ${o.want.good} for ${o.want.port} (want ${(o.want.multipleBps / 10_000).toFixed(1)}x base, seen ${age.toFixed(1)} game h ago` +
      `${o.want.source === "board" ? ` on the ${o.want.via ?? "cove"} board` : " there by our ship"}${o.want.remaining !== null ? `, ${o.want.remaining} t wanted` : ""}): ` +
      `~${cr(o.proceeds)} expected (${Math.round(o.survive * 100)}% it still stands)${o.goods ? ` for ${cr(o.goods)} of goods` : ""}, ` +
      `odds of a seizure ${(o.p * 100).toFixed(1)}% on a ${cr(o.shipValue)} ship: expected gain ${cr(o.gain)} vs expected loss ${cr(o.loss)}` +
      `${o.ok ? ` (passes: at least ${EV_LOSS_X}x)` : ` (fails: needs at least ${EV_LOSS_X}x)`}`
    );
  }

  /**
   * Why this ship may not smuggle (null: she may). Only a ship whose loss we accept (guide 3.18: forfeit with everything aboard,
   * no insurance, a lien and shares lost): in port, nothing lawful aboard or loaded, no sealed freight, never pledged, insured,
   * listed for sale, in a convoy, sharing her ownership, under arrest or under an AI order. Reads it can't make fail closed.
   */
  private async smugglerUnfit(a: ShipAgent, r: ShipResult): Promise<string | null> {
    const w = this.world;
    if (a.gone || a.arrested) return "she is arrested or gone";
    if (r.ship.status === "sailing" || !r.ship.current_port_id) return "she is at sea";
    if (r.ship.convoy_id) return "she is in a convoy";
    if (a.sealedTons() > 0) return "sealed freight is aboard";
    if (Object.entries(r.cargo_manifest).some(([g, t]) => t > 0 && !w.isContraband(g))) return "lawful cargo is aboard";
    // A seizure loses her passengers unpaid (guide 3.20), and an offer may board some any game hour.
    if (a.paxHeads() > 0) return "passengers are aboard";
    if (a.offering) return "a passenger offer of hers is open";
    if (a.loaded) return "a loaded lane";
    if (this.advisor.shipOrder(a.shipId)) return "an AI order is in force for her";
    if (this.retiring.has(a.shipId)) return "she is being sold or broken up";
    const pledges = await this.shipPledges(60_000);
    if (!pledges) return "our loans couldn't be read";
    if (pledges.liened.has(a.shipId)) return "she is pledged to a loan";
    const listed = await this.client.shipListingPages({}, 5).catch((e) => {
      if (this.isFatal(e) || isApiError(e, "world_paused")) throw e;
      return null;
    });
    if (!listed?.complete) return "our ship listings couldn't be read";
    if (listed.items.some((x) => x.ship_id === a.shipId && x.status === "open")) return "she is listed for sale";
    const shares = await this.client.shareListings(a.shipId).catch((e) => {
      if (this.isFatal(e) || isApiError(e, "world_paused")) throw e;
      return null;
    });
    if (!shares) return "her ship shares couldn't be read";
    if (shares.some((x) => x.ship_id === a.shipId && (x.status === "open" || x.status === "sold"))) return "shares in her are listed or held by others";
    const policy = await a.insuredPolicy(60_000, true);
    if (policy === undefined) return "her insurance couldn't be read";
    if (policy) return "she is insured";
    return null;
  }

  /** Takes a ship for smuggling: her lane goes, she takes her turns from the mode. */
  private takeSmuggler(a: ShipAgent, purpose: SmuggleRole["purpose"], dest: string | null, want: WantSeen | null, zones: string[] | null, why: string): SmuggleRole {
    const role: SmuggleRole = {
      since: this.world.now(),
      purpose,
      dest,
      want: want ? { port: want.port, good: want.good, multipleBps: want.multipleBps, seenAt: want.at } : null,
      zones,
      load: null,
      run: null,
      lying: null,
      voyage: false,
      waitingSince: null,
      odds: null,
    };
    this.smugglers.set(a.shipId, role);
    if (a.lane) this.releaseLane(a);
    // No passengers board a smuggler (her seizure must cost nothing but her).
    a.dropOffers("taken for smuggling");
    this.smuggleNote(a.name, `SMUGGLING: ${why}`);
    this.persist(true);
    a.nudge();
    return role;
  }

  /** Lets a smuggler go back to lawful work. */
  private releaseSmuggler(a: ShipAgent, why: string): void {
    const role = this.smugglers.get(a.shipId);
    if (!role) return;
    this.endLying(role);
    this.smugglers.delete(a.shipId);
    this.smuggleNote(a.name, `no longer smuggling (${why}): back to lawful work`);
    this.persist(true);
    a.nudge();
  }

  /** Lying in an ordinary port with contraband aboard: the hours count for the model (a cove is never searched). */
  private noteLying(role: SmuggleRole, r: ShipResult, port: string, carrying: boolean): void {
    const now = this.world.now();
    if (!carrying || this.world.isCove(port) || r.ship.status === "sailing") {
      this.endLying(role);
      return;
    }
    const berthed = r.ship.status === "berthed";
    const l = role.lying;
    if (!l || l.port !== port) {
      this.endLying(role);
      role.lying = { port, lastAt: now, berthed, berthedMs: 0, roadMs: 0 };
      return;
    }
    const dt = Math.max(0, now - l.lastAt);
    if (l.berthed) l.berthedMs += dt;
    else l.roadMs += dt;
    l.lastAt = now;
    l.berthed = berthed;
  }

  /** She left the port (or the goods did): her hours there go into the model, berthed hours counted BERTHED_FACTOR times. */
  private endLying(role: SmuggleRole): void {
    const l = role.lying;
    if (!l) return;
    const dt = Math.max(0, this.world.now() - l.lastAt);
    if (l.berthed) l.berthedMs += dt;
    else l.roadMs += dt;
    this.smuggleModel.portHours += (l.berthedMs * BERTHED_FACTOR + l.roadMs) / this.gameHourMs;
    role.lying = null;
    this.persist();
  }

  /** The newest record of this ship's run still under way (one is started for goods aboard the mode didn't buy). */
  private runRec(a: ShipAgent, make?: { port: string; good: string; tons: number }): SmuggleRunRec | undefined {
    const open = [...this.smuggleRuns].reverse().find((x) => x.ship === a.name && x.outcome === "under way");
    if (open || !make) return open;
    const rec: SmuggleRunRec = { at: this.world.now(), ship: a.name, cove: null, port: make.port, good: make.good, tons: make.tons, costPence: 0, proceedsPence: null, outcome: "under way", p: null, gain: null };
    this.smuggleRuns.push(rec);
    if (this.smuggleRuns.length > SMUGGLE_RUNS_KEPT) this.smuggleRuns.splice(0, this.smuggleRuns.length - SMUGGLE_RUNS_KEPT);
    return rec;
  }

  /**
   * Her turn in port (FleetHost.smuggleTurn). A ship not taken yet is taken only with `adopt`: contraband aboard, nothing lawful,
   * the mode on and room for another smuggler, and she fit to risk. Null: carry on as a lawful ship.
   */
  async smuggleTurn(agent: ShipAgent, r: ShipResult, adopt: boolean): Promise<number | null> {
    const port = r.ship.current_port_id;
    if (!port || r.ship.status === "sailing" || agent.gone) return null;
    const aboard = agent.contrabandAboard(r);
    let role = this.smugglers.get(agent.shipId);
    if (!role) {
      if (!adopt || aboard.length === 0 || !this.smugglingOn() || this.smugglers.size >= SMUGGLE_MAX_SHIPS) return null;
      const why = await this.smugglerUnfit(agent, r);
      if (why) {
        this.smuggleOnce(`unfit:${agent.shipId}:${why}`, agent.name, `the smuggling mode won't take her with contraband aboard: ${why}`);
        return null;
      }
      role = this.takeSmuggler(agent, "sell", null, null, [], `contraband aboard (${aboard.map(([g, t]) => `${t} t ${g}`).join(", ")}): taking it to a want, or back to a cove`);
    }
    this.noteLying(role, r, port, aboard.length > 0);
    if (role.voyage) {
      // A passage with contraband aboard ended safely.
      role.voyage = false;
      this.smuggleModel.runs++;
      this.persist();
    }
    if (!this.smugglingOn()) return this.smuggleOffTurn(agent, r, role, port);
    // Something lawful came aboard, or she joined a convoy (by hand): she is let go at once.
    if (agent.sealedTons() > 0 || r.ship.convoy_id || Object.entries(r.cargo_manifest).some(([g, t]) => t > 0 && !this.world.isContraband(g))) {
      this.releaseSmuggler(agent, "lawful cargo, sealed freight or a convoy");
      return null;
    }
    return this.world.isCove(port) ? this.coveTurn(agent, r, role, port) : this.portTurn(agent, r, role, port);
  }

  /**
   * The mode is off (the user's setting, the AI's, a halt after a seizure, or the scope gone): nothing is bought and no new run
   * starts. A run ashore under way here finishes (departing would cancel it). Goods still aboard, with the scope kept and nothing
   * lawful aboard, the load is finished before she is let go (left in an ordinary port's roadstead, she may be searched): run
   * ashore at a live want here, else taken to a cove clear of patrols and sold into a fair bid there (a cove is never searched;
   * no want elsewhere is sailed for). Without the scope she is let go at once (contraband still aboard is held, logged).
   */
  private async smuggleOffTurn(a: ShipAgent, r: ShipResult, role: SmuggleRole, port: string): Promise<number | null> {
    const now = this.world.now();
    const run = role.run;
    if (run && run.port === port && run.completesAt + RUN_GRACE_MS > now && a.contrabandAboard(r).length > 0) {
      a.setActivity(`smuggling off: letting the run ashore at ${port} finish (departing would cancel it)`);
      return Math.min(60_000, Math.max(2_000, run.completesAt - now + 2_000));
    }
    if (run) this.settleRun(a, role, r);
    const off = this.smugglingOff() ?? "off";
    const aboard = a.contrabandAboard(r);
    const lawful = a.sealedTons() > 0 || !!r.ship.convoy_id || Object.entries(r.cargo_manifest).some(([g, t]) => t > 0 && !this.world.isContraband(g));
    if (aboard.length && this.canSmuggle && !lawful) {
      const what = aboard.map(([g, t]) => `${t} t ${g}`).join(", ");
      this.smuggleOnce(
        `off-finish:${a.shipId}:${off}`,
        a.name,
        `the smuggling mode is ${off}: nothing new is bought; finishing the ${what} aboard first (run ashore at a live want here, or taken to a cove clear of patrols and sold there), then back to lawful work`,
      );
      if (!this.world.isCove(port)) return this.portTurn(a, r, role, port, true);
      const sold = await this.sellAtCove(a, r, role, port, aboard);
      if (sold > 0) return 2_000;
      role.waitingSince ??= now;
      this.smuggleOnce(`off-cove:${a.shipId}:${port}:${what}`, a.name, `smuggling off: holding ${what} at ${port} (a cove is never searched) for a fair bid on its book; back to lawful work once it is sold`);
      return this.holdTurn(a, r, `smuggling off: holding ${what} at ${port} for a fair bid`, COVE_RECHECK_GAME_MIN * this.world.gameMinuteMs);
    }
    this.releaseSmuggler(a, `the smuggling mode is ${off}`);
    return null;
  }

  /** Waits where she is (in the roadstead). */
  private async holdTurn(a: ShipAgent, r: ShipResult, text: string, ms = SMUGGLE_HOLD_MS): Promise<number> {
    await a.smugglerPark(r);
    a.setActivity(text);
    return ms;
  }

  /**
   * At a cove (never searched; guide 3.18): goods aboard go to the best fresh want (stores first), else to a fair bid on the
   * book, else she waits here; empty, she buys for the best want that passes the value test (stores first, then the goods,
   * within smuggleMaxTons and smuggleMaxPence), else waits a while for the board to change, then goes back to lawful work.
   */
  private async coveTurn(a: ShipAgent, r: ShipResult, role: SmuggleRole, cove: string): Promise<number | null> {
    const w = this.world;
    const now = w.now();
    await this.readWants(cove);
    if (!this.canSmuggle) return this.holdTurn(a, r, `smuggling: the key lost the underworld scope; holding at ${cove}`);
    const aboard = a.contrabandAboard(r);
    if (aboard.length) {
      const pick = await this.bestCarry(a, r, cove, aboard);
      if (pick) {
        const st = await this.coveStores(a, r, cove, pick);
        if ("wait" in st) return st.wait;
        if (st.short) {
          this.smuggleOnce(
            `cove-stores:${a.shipId}:${cove}:${pick.want.port}`,
            a.name,
            `at ${cove}: ${st.r.stores.provisions_tons.toFixed(1)} t of stores, short of the ${this.runStores(pick).toFixed(1)} t the run to ${pick.want.port} and back needs (the cove had too few, or no cash for them): trying again shortly`,
          );
          return this.holdTurn(a, st.r, `smuggling: at ${cove}, short of stores for the run to ${pick.want.port}`, COVE_RECHECK_GAME_MIN * w.gameMinuteMs);
        }
        return this.sailRun(a, st.r, role, { dest: pick.want.port, want: pick.want, text: this.optionText(pick), odds: pick }, "run", cove);
      }
      const sold = await this.sellAtCove(a, r, role, cove, aboard);
      if (sold > 0) return 2_000;
      role.waitingSince ??= now;
      const what = aboard.map(([g, t]) => `${t} t ${g}`).join(", ");
      this.smuggleOnce(`cove-hold:${a.shipId}:${cove}:${what}`, a.name, `holding ${what} at ${cove} (a cove is never searched): no want worth the run and no fair bid on the book yet`);
      return this.holdTurn(a, r, `smuggling: holding ${what} at ${cove} for a want worth the run, or a fair bid`, COVE_RECHECK_GAME_MIN * w.gameMinuteMs);
    }
    if (role.purpose !== "buy") {
      this.releaseSmuggler(a, "the run is over");
      return null;
    }
    const startAt = this.nextRunAt(now);
    if (startAt > now) {
      if (startAt - now > 2 * this.gameHourMs) {
        this.releaseSmuggler(a, `the Crown's attention: no new run for ${((startAt - now) / this.gameHourMs).toFixed(0)} game hours`);
        return null;
      }
      return this.holdTurn(a, r, `smuggling: at ${cove}, the next run waits for the Crown's attention to cool`, Math.max(2_000, startAt - now));
    }
    if (w.seasonMode() !== "normal") {
      this.releaseSmuggler(a, "no new runs near the season's end");
      return null;
    }
    const best = await this.bestBuy(a, r, cove);
    if (typeof best === "string") {
      role.waitingSince ??= now;
      if (now - role.waitingSince > COVE_WAIT_GAME_H * this.gameHourMs) {
        this.releaseSmuggler(a, `no run worth it from ${cove} after ${COVE_WAIT_GAME_H} game hours (${best})`);
        return null;
      }
      this.smuggleOnce(`cove-wait:${a.shipId}:${cove}:${role.waitingSince}`, a.name, `at ${cove}: no run passes yet (${best}); waiting for the board to change (a cove is never searched)`);
      return this.holdTurn(a, r, `smuggling: at ${cove}, waiting for a want worth a run`, COVE_RECHECK_GAME_MIN * w.gameMinuteMs);
    }
    // Stores for the whole run first (none may be bought in an ordinary port with contraband aboard), then the goods.
    const st = await this.coveStores(a, r, cove, best.opt);
    if ("wait" in st) return st.wait;
    r = st.r;
    if (st.short) {
      this.releaseSmuggler(a, `short of the ${this.runStores(best.opt).toFixed(1)} t of stores the run needs at ${cove} (${r.stores.provisions_tons.toFixed(1)} t aboard): nothing bought`);
      return null;
    }
    const room = Math.floor(r.effective_hold_capacity_tons - r.cargo_used_tons);
    const tons = Math.min(best.opt.tons, room);
    if (tons < 1) {
      this.releaseSmuggler(a, `no hold room at ${cove} after her stores`);
      return null;
    }
    // Fit still (a lien, a listing, shares or a policy may have come since she was taken): the goods go aboard only a ship whose
    // loss we accept.
    const unfit = await this.smugglerUnfit(a, r);
    if (unfit) {
      this.releaseSmuggler(a, `not fit to carry contraband now: ${unfit}; nothing bought`);
      return null;
    }
    const got = await this.buyContraband(a, r, role, cove, best, tons);
    if (got === null || got.filled <= 0) return this.holdTurn(a, r, `smuggling: at ${cove}, nothing bought yet`, COVE_RECHECK_GAME_MIN * w.gameMinuteMs);
    r = await a.refresh();
    // The run as bought (fewer tons may have filled), judged again on its own figures.
    const opt = await this.runOption(a, r, cove, best.opt.want, got.filled, got.paid);
    if (typeof opt === "string") return 1_000;
    return this.sailRun(a, r, role, { dest: opt.want.port, want: opt.want, text: this.optionText(opt), odds: opt }, "run", cove);
  }

  /** The stores a run can't sail without: the passage there and the way back, without the buffer. */
  private runStores(o: RunOption): number {
    return o.stores - SMUGGLE_STORES_DAYS * o.plan.port_provisions_tons_per_day;
  }

  /**
   * At a cove before a run: stores up to what it needs with the buffer (berthing at a cove is safe: never searched; a run may
   * not stock up anywhere else with contraband aboard). A wait while she docks, else the ship as she stands and whether she is
   * still short of the passages' own figures (then she can't make the run yet).
   */
  private async coveStores(a: ShipAgent, r: ShipResult, cove: string, o: RunOption): Promise<{ wait: number } | { r: ShipResult; short: boolean }> {
    const short = (x: ShipResult) => x.stores.provisions_tons < this.runStores(o);
    if (r.stores.provisions_tons >= o.stores) return { r, short: false };
    if (r.ship.status !== "berthed") {
      // Waiting in the queue for a berth only for the buffer isn't worth it once the passages are covered.
      if (!short(r) && r.ship.dock_queued_at) return { r, short: false };
      a.setActivity(`smuggling: docking at ${cove} for the run's stores`);
      return { wait: await a.smugglerDock(r) };
    }
    const got = await a.smugglerStores(r, o.stores);
    if (got > 0) this.log(a.name, `stores for the run: ${got} t at ${cove}`);
    const now = await a.refresh();
    return { r: now, short: short(now) };
  }

  /**
   * The best run to buy for at this cove: fresh wants on the board (or seen live by our ships) at ≥ 3x base, for goods its book
   * sells, small loads (smuggleMaxTons, smuggleMaxPence, the hold, what the want still takes), priced at the book's ask, through
   * the value test. A string says why none.
   */
  private async bestBuy(a: ShipAgent, r: ShipResult, cove: string): Promise<{ opt: RunOption; good: string; limit: number } | string> {
    const wants = this.freshWants({ maxAgeGameH: WANT_MAX_AGE_GAME_H, minBps: WANT_MIN_MULTIPLE_BPS }).slice(0, SMUGGLE_OPTIONS);
    if (!wants.length) return `no fresh want of ${WANT_MIN_MULTIPLE_BPS / 10_000}x base or more on the board`;
    let book: CoveBookResult;
    try {
      book = await this.client.underworldBook(cove);
    } catch (e) {
      if (this.isFatal(e) || isApiError(e, "world_paused")) throw e;
      if (isApiError(e, "missing_scope")) this.loseSmugglingScope();
      return `the book at ${cove} couldn't be read (${(e as Error).message})`;
    }
    const s = this.settings;
    // Stores still to buy here take hold room first.
    const freeHold = Math.max(0, Math.floor(r.effective_hold_capacity_tons - r.cargo_used_tons));
    let best: { opt: RunOption; good: string; limit: number } | null = null;
    let why = "";
    for (const want of wants) {
      const b = book.books.find((x) => x.commodity_id === want.good);
      const levels = [...(b?.house_ask ? [b.house_ask] : []), ...(b?.asks ?? [])].filter((l) => l.quantity > 0);
      if (!levels.length) {
        why = `${cove} sells no ${want.good} now`;
        continue;
      }
      const ask = Math.min(...levels.map((l) => l.price_pence));
      const limit = Math.floor(ask * (1 + BUY_SLIP));
      const available = levels.filter((l) => l.price_pence <= limit).reduce((n, l) => n + l.quantity, 0);
      const tons = Math.min(s.smuggleMaxTons, Math.floor(s.smuggleMaxPence / Math.max(1, limit)), available, freeHold, want.remaining ?? Infinity);
      if (tons < 1) {
        why = `${want.good} at ${cr(limit)}/t: smuggleMaxPence or the hold buys less than a ton`;
        continue;
      }
      const opt = await this.runOption(a, r, cove, want, tons, tons * limit);
      if (typeof opt === "string") {
        why = opt;
        continue;
      }
      if (!opt.ok) {
        why = this.optionText(opt);
        continue;
      }
      if (!best || opt.gain > best.opt.gain) best = { opt, good: want.good, limit };
    }
    return best ?? why;
  }

  /**
   * The best want to carry goods already aboard to from here (they are a sunk cost: goods count 0): fresh (a board's ≤ a game
   * day, our own sighting ≤ half a day), rich enough to run ashore, through the value test against the ship's risk and time.
   * Away from a cove the stores aboard must already reach it (none may be bought with contraband aboard).
   */
  private async bestCarry(a: ShipAgent, r: ShipResult, from: string, aboard: Array<[string, number]>): Promise<RunOption | null> {
    const w = this.world;
    const tonsOf = new Map(aboard.map(([g, t]) => [g, Math.floor(t)]));
    const wants = this.freshWants({ maxAgeGameH: WANT_MAX_AGE_GAME_H, minBps: RUN_MIN_MULTIPLE_BPS, goods: new Set(tonsOf.keys()), except: from })
      .filter((x) => x.source === "board" || (w.now() - x.at) / this.gameHourMs <= LIVE_WANT_MAX_AGE_GAME_H)
      .slice(0, SMUGGLE_OPTIONS);
    let best: RunOption | null = null;
    for (const want of wants) {
      const tons = Math.min(tonsOf.get(want.good) ?? 0, want.remaining ?? Infinity);
      if (tons < 1) continue;
      const opt = await this.runOption(a, r, from, want, tons, 0);
      if (typeof opt === "string" || !opt.ok) continue;
      if (!w.isCove(from)) {
        // No stores may be bought with contraband aboard: those aboard must reach the want and, should goods be left there (the
        // want gone, or taken first), on to a cove clear of patrols, never stranding her in a port where she may be searched.
        const back = await this.coveBackStores(a, want.port);
        if (back === null || r.stores.provisions_tons < a.safeStoresFor(from, want.port, opt.plan) + back) continue;
      }
      if (!best || opt.gain > best.gain) best = opt;
    }
    return best;
  }

  /** The stores (t) the cheapest way from `from` to an open cove clear of patrols needs (a run's way back with goods left); null: none. */
  private async coveBackStores(a: ShipAgent, from: string): Promise<number | null> {
    const w = this.world;
    const hull = w.shipClass(a.shipClass)?.hull_category ?? "coastal";
    let best: number | null = null;
    for (const p of w.catalog.ports) {
      if (!p.is_cove || !w.isOpen(p.id) || p.id === from) continue;
      const plan = await w.route(from, p.id, a.shipClass).catch((e: unknown) => {
        if (this.isFatal(e) || isApiError(e, "world_paused")) throw e;
        return null;
      });
      if (!plan || !w.routeRated(plan, hull) || this.patrolled(this.routeZones(plan)).length) continue;
      const need = a.safeStoresFor(from, p.id, plan);
      if (best === null || need < best) best = need;
    }
    return best;
  }

  /** The nearest open cove she can reach clear of patrols on the stores aboard (to sell on the book, or wait). A string: none, why. */
  private async nearestCove(a: ShipAgent, r: ShipResult, from: string): Promise<{ dest: string; text: string } | string> {
    const w = this.world;
    const hull = w.shipClass(a.shipClass)?.hull_category ?? "coastal";
    let best: { dest: string; nm: number } | null = null;
    let why = "no cove open";
    for (const p of w.catalog.ports) {
      if (!p.is_cove || !w.isOpen(p.id) || p.id === from) continue;
      const plan = await w.route(from, p.id, a.shipClass).catch((e: unknown) => {
        if (this.isFatal(e) || isApiError(e, "world_paused")) throw e;
        return null;
      });
      if (!plan || !w.routeRated(plan, hull)) {
        why = `${p.id}: no rated route`;
        continue;
      }
      const patrols = this.patrolled(this.routeZones(plan));
      if (patrols.length) {
        why = `${p.id}: a patrol works ${patrols.join(", ")}`;
        continue;
      }
      if (r.stores.provisions_tons < a.safeStoresFor(from, p.id, plan)) {
        why = `${p.id}: the stores aboard don't reach it`;
        continue;
      }
      if (!best || plan.total_distance_nm < best.nm) best = { dest: p.id, nm: plan.total_distance_nm };
    }
    return best ? { dest: best.dest, text: `back to the cove at ${best.dest} (${Math.round(best.nm)} nm) to sell on the book or wait for a want` } : why;
  }

  /**
   * Sails a smuggler on a passage: the plan as depart will sail it and every zone's patrols read afresh (guide 3.5/3.18: a patrol
   * searches contraband in its zones): refused if any patrol now works the route, or the stores aboard don't make its safe
   * figure. The decision is logged; the passage's zones go to the patrol hook at once.
   */
  private async sailRun(
    a: ShipAgent,
    r: ShipResult,
    role: SmuggleRole,
    x: { dest: string; want: WantSeen | null; text: string; odds: { p: number; gain: number; loss: number } | null },
    purpose: SmuggleRole["purpose"],
    from: string,
  ): Promise<number> {
    const w = this.world;
    const hull = w.shipClass(a.shipClass)?.hull_category ?? "coastal";
    const plan = await w.route(from, x.dest, a.shipClass, { maxAgeMs: 60_000 }).catch((e: unknown) => {
      if (this.isFatal(e) || isApiError(e, "world_paused")) throw e;
      return null;
    });
    if (!plan || !w.routeRated(plan, hull)) {
      this.smuggleOnce(`sail-route:${a.shipId}:${from}>${x.dest}`, a.name, `smuggling: not sailing ${from} → ${x.dest}: no rated route now`);
      return this.holdTurn(a, r, `smuggling: no rated route to ${x.dest}`);
    }
    if (!(await this.readZonesNow())) {
      this.smuggleOnce(`sail-zones:${a.shipId}:${from}>${x.dest}`, a.name, `smuggling: not sailing ${from} → ${x.dest} yet: the zones' patrols couldn't be read`);
      return this.holdTurn(a, r, `smuggling: waiting to read the zones' patrols before sailing for ${x.dest}`);
    }
    const zones = this.routeZones(plan);
    const patrols = this.patrolled(zones);
    if (patrols.length) {
      this.smuggleNote(a.name, `smuggling: NOT sailing ${from} → ${x.dest}: a patrol now works ${patrols.join(", ")} on the route`);
      return this.holdTurn(a, r, `smuggling: a patrol works the route to ${x.dest}`);
    }
    const carrying = a.contrabandAboard(r).length > 0;
    const safe = a.safeStoresFor(from, x.dest, plan);
    if (r.stores.provisions_tons < safe) {
      this.smuggleOnce(
        `sail-stores:${a.shipId}:${from}>${x.dest}`,
        a.name,
        `smuggling: not sailing ${from} → ${x.dest}: ${r.stores.provisions_tons.toFixed(2)} t of stores aboard, under the ${safe.toFixed(2)} t it needs${carrying && !w.isCove(from) ? ", and none may be bought here with contraband aboard" : ""}`,
      );
      return this.holdTurn(a, r, `smuggling: short of stores for ${x.dest}`);
    }
    // Still locked at the berth (a cove's: her stores or goods just bought): sails once it clears, decided again then.
    const unlocks = r.ship.status === "berthed" && r.ship.turnaround_unlocks_at ? Date.parse(r.ship.turnaround_unlocks_at) - w.now() : 0;
    if (unlocks > 0) {
      a.setActivity(`smuggling: berth lock, then sailing for ${x.dest}`);
      return unlocks + 750;
    }
    role.purpose = purpose;
    role.dest = x.dest;
    role.zones = zones;
    role.want = x.want ? { port: x.want.port, good: x.want.good, multipleBps: x.want.multipleBps, seenAt: x.want.at } : null;
    role.odds = x.odds ? { p: x.odds.p, gain: x.odds.gain, loss: x.odds.loss } : role.odds;
    role.waitingSince = null;
    this.endLying(role);
    role.voyage = carrying;
    this.smuggleNote(a.name, `smuggling: sailing ${from} → ${x.dest}: ${x.text}; the route is clear of patrols (${zones.join(", ") || "no zone"})`);
    this.persist(true);
    const wait = await a.smugglerDepart(r, x.dest, plan);
    const sailed = a.last;
    if (sailed?.ship.status === "sailing") role.zones = [...new Set([...zones, ...this.routeZones({ legs: sailed.route_legs })])];
    else role.voyage = false;
    return wait;
  }

  /** Cash for contraband (guide 3.18: paid vault to vault in the cove's region): never what loads, loans or a ship waiting for cash count on. */
  private async smuggleCashBlock(cost: number): Promise<string | null> {
    if ([...this.agents.values()].some((a) => a.waitingForCash)) return "a ship is waiting for cash";
    if (this.debtShort) return "a loan repayment is short";
    await this.world.refreshVaults();
    let committed = 0;
    for (const a of this.agents.values()) committed += this.committedBy(a);
    if (this.spareCash() - committed - this.debtFence() < cost) return `no spare cash for ${cr(cost)} of goods`;
    return null;
  }

  /**
   * Buys the run's goods at the cove (IOC at most BUY_SLIP over the best ask, so only what is on the book at about that price),
   * under the cash lock. Null: no cash or the mode went off; else what filled and what it cost. An order with no answer is told
   * from the hold.
   */
  private async buyContraband(
    a: ShipAgent,
    r: ShipResult,
    role: SmuggleRole,
    cove: string,
    best: { opt: RunOption; good: string; limit: number },
    tons: number,
  ): Promise<{ filled: number; paid: number } | null> {
    const w = this.world;
    const region = w.region(cove);
    const cost = tons * best.limit;
    return this.withCash(async () => {
      if (this.stopRequested || this.paused || !this.smugglingOn()) return null;
      const block = await this.smuggleCashBlock(cost);
      if (block) {
        this.smuggleOnce(`buy-cash:${a.shipId}:${block}`, a.name, `smuggling: not buying at ${cove}: ${block}`);
        return null;
      }
      if ((await this.ensureCash(region, cost, { fresh: true })) < cost) {
        this.smuggleOnce(`buy-region:${a.shipId}:${region}`, a.name, `smuggling: not buying at ${cove}: under ${cr(cost)} spare in ${region}`);
        return null;
      }
      const before = r.cargo_manifest[best.good] ?? 0;
      let filled = 0;
      let paid = 0;
      try {
        const res = await this.client.underworldOrder({ ship_id: a.shipId, commodity_id: best.good, side: "bid", time_in_force: "ioc", price_pence: best.limit, quantity: tons });
        filled = res.filled_quantity;
        paid = res.total_gross_pence;
      } catch (e) {
        if (this.isFatal(e) || isApiError(e, "world_paused")) throw e;
        if (isApiError(e, "missing_scope")) {
          this.loseSmugglingScope();
          return null;
        }
        if (!outcomeUnknown(e)) {
          this.smuggleNote(a.name, `smuggling: buying ${tons} t ${best.good} at ${cove} refused: ${(e as Error).message}`);
          return { filled: 0, paid: 0 };
        }
        const after = await a.refresh().then(
          (x) => x.cargo_manifest[best.good] ?? 0,
          () => null,
        );
        if (after === null) throw e;
        filled = Math.max(0, after - before);
        paid = filled * best.limit;
        void w.refreshVaults().catch(() => undefined);
        this.smuggleNote(a.name, `smuggling: the buy at ${cove} had no answer (${(e as Error).message}); ${filled} t came aboard, booked at ${cr(best.limit)}/t`);
      }
      if (filled <= 0) {
        this.smuggleNote(a.name, `smuggling: nothing filled buying ${best.good} at ${cove} at up to ${cr(best.limit)}/t`);
        return { filled: 0, paid: 0 };
      }
      w.vaults.set(region, w.vault(region) - paid);
      this.smuggleStats.spentPence += paid;
      role.load = { good: best.good, tons: filled, pence: paid, cove, at: w.now() };
      const rec: SmuggleRunRec = {
        at: w.now(),
        ship: a.name,
        cove,
        port: best.opt.want.port,
        good: best.good,
        tons: filled,
        costPence: paid,
        proceedsPence: null,
        outcome: "under way",
        p: best.opt.p,
        gain: best.opt.gain,
      };
      this.smuggleRuns.push(rec);
      if (this.smuggleRuns.length > SMUGGLE_RUNS_KEPT) this.smuggleRuns.splice(0, this.smuggleRuns.length - SMUGGLE_RUNS_KEPT);
      this.smuggleNote(a.name, `smuggling: bought ${filled}/${tons} t ${best.good} at ${cove} for ${cr(paid)} (house and players' asks, at most ${cr(best.limit)}/t)`);
      this.persist(true);
      return { filled, paid };
    });
  }

  /**
   * Back at a cove with goods no want takes: sold into players' bids on the book at a fair price (what they cost, at least half
   * their base; after waiting COVE_WAIT_GAME_H, a quarter of base). Returns tons sold.
   */
  private async sellAtCove(a: ShipAgent, r: ShipResult, role: SmuggleRole, cove: string, aboard: Array<[string, number]>): Promise<number> {
    const w = this.world;
    let book: CoveBookResult;
    try {
      book = await this.client.underworldBook(cove);
    } catch (e) {
      if (this.isFatal(e) || isApiError(e, "world_paused")) throw e;
      if (isApiError(e, "missing_scope")) this.loseSmugglingScope();
      return 0;
    }
    const waited = role.waitingSince !== null && w.now() - role.waitingSince > COVE_WAIT_GAME_H * this.gameHourMs;
    let sold = 0;
    for (const [good, held] of aboard) {
      const base = w.basePrice(good);
      const cost = role.load?.good === good && role.load.tons > 0 ? role.load.pence / role.load.tons : 0;
      const floor = Math.ceil(waited ? base * 0.25 : Math.max(cost, base * COVE_RESALE_SHARE));
      const bids = (book.books.find((x) => x.commodity_id === good)?.bids ?? []).filter((l) => l.price_pence >= floor && l.quantity > 0);
      const qty = Math.min(Math.floor(held), bids.reduce((n, l) => n + l.quantity, 0));
      if (qty < 1) continue;
      try {
        const res = await this.client.underworldOrder({ ship_id: a.shipId, commodity_id: good, side: "ask", time_in_force: "ioc", price_pence: floor, quantity: qty });
        if (res.filled_quantity <= 0) continue;
        const region = w.region(cove);
        w.vaults.set(region, w.vault(region) + res.total_gross_pence);
        this.smuggleStats.proceedsPence += res.total_gross_pence;
        sold += res.filled_quantity;
        const rec = this.runRec(a, { port: cove, good, tons: res.filled_quantity });
        if (rec) {
          rec.proceedsPence = (rec.proceedsPence ?? 0) + res.total_gross_pence;
          rec.outcome = "sold at a cove";
        }
        this.smuggleNote(a.name, `smuggling: sold ${res.filled_quantity} t ${good} at ${cove} into players' bids for ${cr(res.total_gross_pence)} (floor ${cr(floor)}/t)`);
        this.cashArrived();
      } catch (e) {
        if (this.isFatal(e) || isApiError(e, "world_paused")) throw e;
        if (isApiError(e, "missing_scope")) this.loseSmugglingScope();
        this.smuggleNote(a.name, `smuggling: selling ${good} at ${cove} refused: ${(e as Error).message}`);
      }
    }
    if (sold > 0) this.persist(true);
    return sold;
  }

  /**
   * In an ordinary port (guide 3.18: a ship lying there with contraband aboard may be searched, berthed more than in the
   * roadstead). Empty: on to the cove she was taken for, else let go. With goods aboard: off the berth as soon as the lock
   * allows, a run ashore under way waited out, a live want here run ashore at once, else on to the next fresh want, else back to
   * a cove; never lying here longer than that takes. `finishing` (the mode off): no want elsewhere is sailed for.
   */
  private async portTurn(a: ShipAgent, r: ShipResult, role: SmuggleRole, port: string, finishing = false): Promise<number | null> {
    const w = this.world;
    const now = w.now();
    const aboard = a.contrabandAboard(r);
    if (!aboard.length) {
      if (role.run) this.settleRun(a, role, r);
      if (role.purpose === "buy" && role.dest && w.isCove(role.dest) && w.seasonMode() === "normal") {
        a.setActivity(`smuggling: bound for ${role.dest} to buy`);
        return a.sailForCove(r, role.dest);
      }
      this.releaseSmuggler(a, "nothing aboard to run");
      return null;
    }
    const leave = await a.smugglerLeaveBerth(r);
    if (leave !== null) return leave;
    r = a.last ?? r;
    const run = role.run;
    if (run && run.port === port) {
      const left = run.completesAt - now;
      if (left > -RUN_GRACE_MS) {
        a.setActivity(`smuggling: running ${run.tons} t ${run.good} ashore at ${port}, done in ~${Math.max(0, Math.round(left / 1_000))}s`);
        return Math.min(60_000, Math.max(2_000, left + 2_000));
      }
      // Past it and no notice came: what left the hold was landed.
      this.settleRun(a, role, r);
    }
    const wants = await this.readWants(port);
    if (!this.canSmuggle) return this.holdTurn(a, r, `smuggling: the key lost the underworld scope; holding at ${port}`);
    if (wants && !wants.is_cove) {
      const ranked = aboard
        .map(([good, tons]) => ({ good, tons, want: wants.wants.find((x) => x.commodity_id === good && x.remaining_tons > 0) }))
        .filter((x) => x.want && x.want.multiple_bps >= RUN_MIN_MULTIPLE_BPS)
        .sort((x, y) => y.want!.multiple_bps * w.basePrice(y.good) - x.want!.multiple_bps * w.basePrice(x.good));
      for (const x of ranked) {
        const qty = Math.min(Math.floor(x.tons), x.want!.remaining_tons);
        if (qty < 1) continue;
        const started = await this.startRun(a, r, role, port, x.good, qty, x.want!.multiple_bps);
        if (started !== null) return started;
      }
    }
    const next = finishing ? null : await this.bestCarry(a, r, port, aboard);
    if (next) return this.sailRun(a, r, role, { dest: next.want.port, want: next.want, text: this.optionText(next), odds: next }, "run", port);
    const cove = await this.nearestCove(a, r, port);
    if (typeof cove !== "string") return this.sailRun(a, r, role, { dest: cove.dest, want: null, text: cove.text, odds: null }, "sell", port);
    this.smuggleOnce(
      `stuck:${a.shipId}:${port}`,
      a.name,
      `WARNING: contraband aboard at ${port}, no want here for it, none worth sailing for, and no cove reachable clear of patrols (${cove}): holding in the roadstead, where she may be searched`,
    );
    return this.holdTurn(a, r, `smuggling: contraband aboard at ${port}, no way on clear of patrols: holding in the roadstead`);
  }

  /**
   * Runs goods ashore here at once (guide 3.18: from the roadstead of a port with a live want; the first ashore takes the best of
   * it; departing cancels it). A wait for it, or null when it didn't start (try the next good, or move on).
   */
  private async startRun(a: ShipAgent, r: ShipResult, role: SmuggleRole, port: string, good: string, qty: number, multipleBps: number): Promise<number | null> {
    const w = this.world;
    const now = w.now();
    const before = r.cargo_manifest[good] ?? 0;
    const guess = now + runGameHours(this.smuggleModel) * this.gameHourMs;
    const begin = (id: string, startedAt: number, completesAt: number, tons: number) => {
      role.run = { id, port, good, tons, startedAt, completesAt, before };
      this.smuggleRunTimes.push(now);
      if (this.smuggleRunTimes.length > 50) this.smuggleRunTimes.splice(0, this.smuggleRunTimes.length - 50);
      this.smuggleStats.runs++;
      const rec = this.runRec(a, { port, good, tons });
      if (rec) rec.port = port;
      this.persist(true);
    };
    try {
      const res = await this.client.runAshore({ ship_id: a.shipId, commodity_id: good, quantity: qty });
      const startedAt = Date.parse(res.started_at) || now;
      const completesAt = Date.parse(res.completes_at) || guess;
      begin(res.run_id, startedAt, completesAt, res.quantity || qty);
      this.smuggleNote(
        a.name,
        `smuggling: running ${qty} t ${good} ashore at ${port} (want ${(multipleBps / 10_000).toFixed(1)}x base now): done in ~${((completesAt - now) / this.gameHourMs).toFixed(1)} game h; she lies in the roadstead meanwhile (departing would cancel it)`,
      );
      a.setActivity(`smuggling: running ${qty} t ${good} ashore at ${port}`);
      return Math.min(60_000, Math.max(2_000, completesAt - now + 2_000));
    } catch (e) {
      if (this.isFatal(e) || isApiError(e, "world_paused")) throw e;
      if (isApiError(e, "missing_scope")) {
        this.loseSmugglingScope();
        return 60_000;
      }
      if (isApiError(e, "not_in_roadstead")) {
        await a.smugglerPark(r);
        return 2_000;
      }
      if (isApiError(e, "run_in_progress")) {
        if (!role.run) begin("", now, guess, qty);
        return 30_000;
      }
      if (isApiError(e, "no_want")) {
        this.wantsSeen.delete(`${port}|${good}`);
        return null;
      }
      if (outcomeUnknown(e)) {
        begin("", now, guess, qty);
        this.smuggleNote(a.name, `smuggling: running ${good} ashore at ${port} had no answer (${(e as Error).message}): taken as started, waited out`);
        return 30_000;
      }
      this.smuggleNote(a.name, `smuggling: running ${good} ashore at ${port} refused: ${(e as Error).message}`);
      return null;
    }
  }

  /** A run's end with no notice (the feed missed it): what left the hold was landed (its pay shows in the vault, read again). */
  private settleRun(a: ShipAgent, role: SmuggleRole, r: ShipResult): void {
    const run = role.run;
    if (!run) return;
    role.run = null;
    const left = r.cargo_manifest[run.good] ?? 0;
    const landed = Math.max(0, run.before - left);
    const hours = (Math.min(this.world.now(), run.completesAt) - run.startedAt) / this.gameHourMs;
    if (hours > 0) this.smuggleModel.runHours = [...this.smuggleModel.runHours, hours].slice(-20);
    this.smuggleStats.landedTons += landed;
    const rec = this.runRec(a);
    if (rec) rec.outcome = landed > 0 ? "landed (no notice; pay in the vault)" : "nothing landed";
    this.smuggleNote(a.name, `smuggling: the run at ${run.port} is over with no notice: ${landed} t ${run.good} left the hold`);
    void this.world.refreshVaults().then(() => this.cashArrived(), () => undefined);
    this.persist(true);
  }

  /**
   * The housekeeping pass: wants read where we lie, and (the mode on, the Crown's attention cool, the season normal, a fleet of
   * two or more, no smuggler out) a new run when one passes the value test: the fastest fit ship goes to the cove that serves it.
   */
  private async runSmuggling(): Promise<void> {
    const w = this.world;
    const now = w.now();
    this.pruneWants();
    for (const [id, role] of [...this.smugglers]) {
      const a = this.agents.get(id);
      if (!a || a.gone) {
        if (a) this.checkLostSmuggler(a);
        this.smugglers.delete(id);
        continue;
      }
      if (a.last?.ship.status === "sailing") this.endLying(role);
    }
    if (!this.ownSettings.smuggling || !this.canSmuggle) {
      this.smuggleAction = this.smugglingOff() ?? "off";
      return;
    }
    await this.pollWants();
    const off = this.smugglingOff();
    if (off) {
      this.smuggleAction = off;
      return;
    }
    if (w.seasonMode() !== "normal") {
      this.smuggleAction = "no new runs near the season's end";
      return;
    }
    if (this.smugglers.size >= SMUGGLE_MAX_SHIPS) {
      this.smuggleAction = `${[...this.smugglers.keys()].map((id) => this.agents.get(id)?.name ?? id.slice(0, 8)).join(", ")} smuggling`;
      return;
    }
    const fleet = [...this.agents.values()].filter((a) => !a.gone);
    if (fleet.length < SMUGGLE_MIN_FLEET) {
      this.smuggleAction = "the fleet's only ship is never spared for smuggling";
      return;
    }
    const startAt = this.nextRunAt(now);
    if (startAt > now) {
      this.smuggleAction = `the Crown's attention (${this.recentRuns(now)} runs ashore in ${ATTENTION_WINDOW_GAME_H} game hours): the next run in ${((startAt - now) / this.gameHourMs).toFixed(1)} game hours`;
      return;
    }
    await this.designateSmuggler(fleet);
  }

  /**
   * A new run: for each free ship in port (nothing lawful aboard or loaded, no sealed freight, convoy, arrest or AI order), fastest
   * first, each open cove and each fresh rich want, the run as estimated (goods at the book's usual price: base × HOUSE_PRICE_GUESS,
   * the passage to the cove counted); the best that passes the value test is taken, if she is fit to risk. With no want known, an
   * idle ship near a cove may go and read its board (at most once a game day).
   */
  private async designateSmuggler(fleet: ShipAgent[]): Promise<void> {
    const w = this.world;
    const s = this.settings;
    const speed = (a: ShipAgent) => w.shipClass(a.shipClass)?.base_speed_centiknots ?? 0;
    const free = fleet
      .filter((a) => {
        const r = a.last;
        return (
          !!r &&
          r.ship.status !== "sailing" &&
          !!r.ship.current_port_id &&
          !a.arrested &&
          !r.ship.convoy_id &&
          !a.loaded &&
          a.sealedTons() === 0 &&
          a.paxHeads() === 0 &&
          !a.offering &&
          !Object.entries(r.cargo_manifest).some(([g, t]) => t > 0 && !w.isContraband(g)) &&
          !this.advisor.shipOrder(a.shipId) &&
          !this.retiring.has(a.shipId)
        );
      })
      .sort((x, y) => speed(y) - speed(x))
      .slice(0, SMUGGLE_CANDIDATES);
    if (!free.length) {
      this.smuggleAction = "no ship free for a run (in port, empty, no lane loaded)";
      return;
    }
    const coves = w.catalog.ports.filter((p) => p.is_cove && w.isOpen(p.id)).map((p) => p.id);
    if (!coves.length) {
      this.smuggleAction = "no cove open";
      return;
    }
    const wants = this.freshWants({ maxAgeGameH: WANT_MAX_AGE_GAME_H, minBps: WANT_MIN_MULTIPLE_BPS }).slice(0, SMUGGLE_OPTIONS);
    if (!wants.length) {
      await this.scoutCove(free, coves);
      return;
    }
    let why = "";
    // Fastest first: the first fit ship with a run that passes takes it (her best run).
    for (const a of free) {
      let best: { cove: string; opt: RunOption } | null = null;
      const r = a.last!;
      const from = r.ship.current_port_id!;
      const cls = w.shipClass(a.shipClass);
      const hull = cls?.hull_category ?? "coastal";
      const knots = ((cls?.base_speed_centiknots ?? 800) / 100) * 0.9;
      for (const cove of coves) {
        let toCoveMs = 0;
        if (from !== cove) {
          const p = await w.route(from, cove, a.shipClass).catch((e: unknown) => {
            if (this.isFatal(e) || isApiError(e, "world_paused")) throw e;
            return null;
          });
          if (!p || !w.routeRated(p, hull)) continue;
          toCoveMs = w.sailMs(p.total_distance_nm, knots) + 30 * w.gameMinuteMs;
        }
        for (const want of wants) {
          const price = Math.ceil(w.basePrice(want.good) * HOUSE_PRICE_GUESS);
          const tons = Math.min(s.smuggleMaxTons, Math.floor(s.smuggleMaxPence / Math.max(1, price)), Math.floor(r.effective_hold_capacity_tons - r.cargo_used_tons), want.remaining ?? Infinity);
          if (tons < 1) {
            why = `smuggleMaxPence buys less than a ton of ${want.good}`;
            continue;
          }
          const opt = await this.runOption(a, r, cove, want, tons, tons * price, toCoveMs);
          if (typeof opt === "string") {
            why = opt;
            continue;
          }
          if (!opt.ok) {
            why = `${a.name} via ${cove}: ${this.optionText(opt)}`;
            continue;
          }
          if (!best || opt.gain > best.opt.gain) best = { cove, opt };
        }
      }
      if (!best) continue;
      const unfit = await this.smugglerUnfit(a, r);
      if (unfit) {
        why = `${a.name} can't be risked: ${unfit}`;
        this.smuggleOnce(`unfit:${a.shipId}:${unfit}`, "smuggling", `${a.name} would run ${this.optionText(best.opt)}, but ${unfit}: not taken`);
        continue;
      }
      this.takeSmuggler(a, "buy", best.cove, best.opt.want, best.opt.zones, `taken for a run (the fastest fit ship): via the cove at ${best.cove}, ${this.optionText(best.opt)}`);
      this.smuggleAction = `${a.name} bound for ${best.cove} to buy for ${best.opt.want.port}`;
      return;
    }
    this.smuggleAction = `no run passes the value test: ${why || "no cove or want reachable"}`;
    // Once per set of wants known (the figures move every pass).
    this.smuggleOnce(`nobest:${wants.map((x) => `${x.port}|${x.good}|${x.at}`).join(",")}`, "smuggling", `no run taken: ${why || "no cove or want reachable"}`);
  }

  /** No want known (they are told only at coves, or seen where we lie): an idle ship (no lane pays) goes to the nearest cove to read its board. */
  private async scoutCove(free: ShipAgent[], coves: string[]): Promise<void> {
    const w = this.world;
    const now = w.now();
    this.smuggleAction = "no fresh want known (wants are told only at the coves, or seen where our ships lie)";
    if (now - this.lastScoutAt < SCOUT_GAP_GAME_H * this.gameHourMs) return;
    for (const a of free.filter((x) => x.idle)) {
      const r = a.last!;
      const from = r.ship.current_port_id!;
      const hull = w.shipClass(a.shipClass)?.hull_category ?? "coastal";
      let near: { cove: string; nm: number } | null = null;
      for (const cove of coves) {
        const p =
          from === cove
            ? { total_distance_nm: 0 }
            : await w.route(from, cove, a.shipClass).then(
                (x) => (w.routeRated(x, hull) ? x : null),
                (e: unknown) => {
                  if (this.isFatal(e) || isApiError(e, "world_paused")) throw e;
                  return null;
                },
              );
        if (p && (!near || p.total_distance_nm < near.nm)) near = { cove, nm: p.total_distance_nm };
      }
      if (!near || near.nm > SCOUT_MAX_NM) continue;
      const unfit = await this.smugglerUnfit(a, r);
      if (unfit) continue;
      this.lastScoutAt = now;
      this.takeSmuggler(a, "buy", near.cove, null, [], `idle (no lane pays): to the cove at ${near.cove} (${Math.round(near.nm)} nm) to read its board of wants`);
      this.smuggleAction = `${a.name} bound for ${near.cove} to read its board`;
      return;
    }
  }

  /**
   * A smuggler gone from the fleet with no notice of why: with contraband aboard, neither sunk, taken by pirates, sold nor broken
   * up, she was most likely seized (the ship_seized notice missed): counted so (once: by her id), which stops the mode until
   * re-enabled (the safe way to be wrong). Placed at sea or in port only where her last read tells it (lastWhere).
   */
  private checkLostSmuggler(a: ShipAgent): void {
    const r = a.last;
    if (!r || this.seizedNoted.has(a.shipId) || this.capturesNoted.has(a.shipId) || this.leftFleet.has(a.shipId)) return;
    const status = r.ship.status as string;
    if (status === "sunk" || status === "captured" || a.contrabandAboard(r).length === 0) return;
    const where = r.ship.current_port_id ?? r.route_legs[r.ship.current_leg_idx]?.to_node ?? null;
    this.noteSeized(a, a.shipId, a.name, where, this.lastWhere(a), this.world.now(), true);
  }

  /**
   * Where a ship of ours was, by her last read, for a seizure no notice placed: at sea while her passage was still under way, in an
   * ordinary port when lying there; null when it can't be told (her arrival was due, or she lay at a cove, which is never
   * searched: she sailed since).
   */
  private lastWhere(a: ShipAgent | undefined): boolean | null {
    const r = a?.last;
    if (!r) return null;
    if (r.ship.status === "sailing") {
      const eta = Date.parse(r.voyage?.estimated_arrival_at ?? "");
      return Number.isFinite(eta) && eta < this.world.now() ? null : false;
    }
    const port = r.ship.current_port_id;
    return port && !this.world.isCove(port) ? true : null;
  }

  /** A seizure's place in the model: in port, or at sea (a run that ended so); unknown counts in neither. `sign` -1 takes it back. */
  private seizureSplit(inPort: boolean | null, sign: 1 | -1): void {
    const m = this.smuggleModel;
    if (inPort === true) m.seizedInPort = Math.max(0, m.seizedInPort + sign);
    else if (inPort === false) {
      m.seizedAtSea = Math.max(0, m.seizedAtSea + sign);
      m.runs = Math.max(0, m.runs + sign);
    }
  }

  /**
   * One of our ships seized by the Crown for smuggling (guide 3.18): she and everything aboard are forfeit as if she sank (a lien,
   * shares and a venture lost, insurance pays nothing), and the conviction goes on our public credit record. The model learns it,
   * and the mode switches itself off until the user turns it on again.
   */
  private noteSeized(a: ShipAgent | undefined, id: string | null, ship: string, where: string | null, inPort: boolean | null, at: number, guessed = false): void {
    const key = id ?? a?.shipId ?? null;
    if (key && this.seizedNoted.has(key)) {
      // Counted already (inferred when she vanished): the notice says where, and the model's split is set right.
      const c = guessed ? undefined : this.convictions.find((x) => x.id === key && x.guessed);
      if (c) {
        if (inPort !== null && c.inPort !== inPort) {
          this.seizureSplit(c.inPort, -1);
          this.seizureSplit(inPort, 1);
          c.inPort = inPort;
        }
        if (where) c.where = where;
        c.guessed = false;
        this.smuggleNote("smuggling", `the Crown's notice confirms the seizure of ${ship} ${inPort === null ? "" : inPort ? "in port" : "at sea"}${where ? ` at ${where}` : ""} (already counted)`);
        this.persist(true);
      }
      return;
    }
    if (key) {
      this.seizedNoted.add(key);
      if (this.seizedNoted.size > 200) this.seizedNoted.delete(this.seizedNoted.values().next().value!);
    }
    const role = a ? this.smugglers.get(a.shipId) : undefined;
    if (role) this.endLying(role);
    if (a) this.smugglers.delete(a.shipId);
    this.seizureSplit(inPort, 1);
    this.smuggleStats.seizures++;
    this.convictions.push({ at, ship, where: where ?? "?", inPort, ...(key ? { id: key } : {}), ...(guessed ? { guessed: true } : {}) });
    if (this.convictions.length > 50) this.convictions.splice(0, this.convictions.length - 50);
    const rec = a ? this.runRec(a) : undefined;
    if (rec) rec.outcome = "SEIZED";
    a?.noteSeized("was SEIZED by the Crown for smuggling: the ship and everything aboard are forfeit");
    this.loansDirty = true;
    this.financeDirty = true;
    this.lastScan = 0;
    const wasOn = this.ownSettings.smuggling && !this.smuggleHalt;
    const place = inPort === null ? "(where not known)" : inPort ? "in port" : "at sea";
    this.smuggleHalt ??= { at, why: `${ship} seized ${place}${where ? ` at ${where}` : ""}` };
    this.smuggleNote(
      "smuggling",
      `SEIZED${guessed ? " (no notice came: she is gone from the fleet with contraband aboard)" : ""}: ${ship} ${place}${where ? ` at ${where}` : ""}: ` +
        `the ship and everything aboard are forfeit, insurance pays nothing, and a smuggling conviction goes on our public credit record. ` +
        `${wasOn ? "The smuggling mode switches itself off until you turn it on again." : "The smuggling mode stays off until you turn it on again."}`,
    );
    this.advisor.trigger("a ship was seized for smuggling");
    this.persist(true);
    if (wasOn) this.onSmugglingHalted?.();
  }

  /** A ship of ours left the fleet by sale or break-up (not seized). */
  private noteLeftFleet(id: string): void {
    this.leftFleet.add(id);
    if (this.leftFleet.size > 100) this.leftFleet.delete(this.leftFleet.values().next().value!);
  }

  /** A ship of ours listed (or sold) by the retiring: never bought back by our buyer (disposedIds). */
  private noteDisposed(id: string): void {
    if (this.disposedIds.has(id)) return;
    this.disposedIds.add(id);
    if (this.disposedIds.size > 100) this.disposedIds.delete(this.disposedIds.values().next().value!);
    this.persist();
  }

  /** The smuggling mode's report for the dashboard. */
  private smuggleReport(): SmuggleReport {
    const w = this.world;
    const now = w.now();
    const m = this.smuggleModel;
    const iso = (t: number) => new Date(t).toISOString();
    const next = this.nextRunAt(now);
    return {
      enabled: this.ownSettings.smuggling,
      available: this.canSmuggle,
      active: this.smugglingOn(),
      state: this.smugglingOff() ?? "on",
      action: this.smuggleAction,
      halt: this.smuggleHalt ? { at: iso(this.smuggleHalt.at), why: this.smuggleHalt.why } : null,
      maxTons: this.settings.smuggleMaxTons,
      maxPence: this.settings.smuggleMaxPence,
      ships: [...this.smugglers].map(([id, s]) => ({
        shipId: id,
        name: this.agents.get(id)?.name ?? id.slice(0, 8),
        purpose: s.purpose,
        dest: s.dest,
        want: s.want ? { port: s.want.port, good: s.want.good, multipleBps: s.want.multipleBps } : null,
        load: s.load ? { good: s.load.good, tons: s.load.tons, pence: s.load.pence, cove: s.load.cove } : null,
        run: s.run ? { port: s.run.port, good: s.run.good, tons: s.run.tons, completesAt: iso(s.run.completesAt) } : null,
        odds: s.odds,
        since: iso(s.since),
        zones: s.zones ?? [],
      })),
      wants: this.freshWants({ maxAgeGameH: WANT_LIFE_GAME_H, minBps: 0 })
        .slice(0, 20)
        .map((x) => ({ port: x.port, good: x.good, multipleBps: x.multipleBps, ageGameH: Math.round(((now - x.at) / this.gameHourMs) * 10) / 10, remaining: x.remaining, source: x.source, via: x.via })),
      runs: [...this.smuggleRuns].reverse().slice(0, 12).map((x) => ({ ...x, at: iso(x.at) })),
      stats: { ...this.smuggleStats, convictions: this.convictions.length },
      model: {
        perRun: runHazard(m),
        perPortHour: portHazard(m),
        runGameH: runGameHours(m),
        runs: m.runs,
        portHours: Math.round(m.portHours * 10) / 10,
        seizedInPort: m.seizedInPort,
        seizedAtSea: m.seizedAtSea,
        odds: this.seizureOddsNow(),
        recentRuns: this.recentRuns(now),
        nextRunAt: next > now ? iso(next) : null,
      },
      convictions: this.convictions.map((c) => ({ ...c, at: iso(c.at) })),
      log: [...this.smuggleLog].reverse().slice(0, 25),
    };
  }

  /** The mode for the AI (digest): its state, wants seen, our smugglers, runs and seizures. Nothing names a company. */
  private digestSmuggling(now: number): DigestInput["smuggling"] {
    const r = this.smuggleReport();
    return {
      state: r.state,
      user: this.ownSettings.smuggling,
      available: this.canSmuggle,
      halted: !!this.smuggleHalt,
      maxTons: this.ownSettings.smuggleMaxTons,
      maxPence: this.ownSettings.smuggleMaxPence,
      ships: r.ships.map((s) => ({ purpose: s.purpose, dest: s.dest, want: s.want ? `${s.want.good}@${s.want.port}` : null, running: !!s.run })),
      wants: this.freshWants({ maxAgeGameH: WANT_MAX_AGE_GAME_H, minBps: 0 })
        .slice(0, 8)
        .map((x) => ({ port: x.port, good: x.good, x: x.multipleBps / 10_000, ageH: Math.round((now - x.at) / this.gameHourMs), remaining: x.remaining, source: x.source })),
      runs: r.stats.runs,
      landedTons: r.stats.landedTons,
      proceeds: r.stats.proceedsPence,
      spent: r.stats.spentPence,
      seizures: r.stats.seizures,
      convictions: r.stats.convictions,
      odds: r.model.odds,
      recentRuns: r.model.recentRuns,
    };
  }

  /** Passengers for the digest: fares paid, groups aboard by ship and destination, our open offers, the pricer's routes. No group named. */
  private digestPassengers(now: number): DigestInput["passengers"] {
    const w = this.world;
    const ships = [...this.agents.values()].filter((a) => !a.gone);
    const aboard = new Map<string, { ship: string; dest: string; heads: number; fares: number; due: number | null }>();
    for (const a of ships) {
      for (const g of a.paxGroups()) {
        const k = `${a.shipId}|${g.dest}`;
        const x = aboard.get(k) ?? { ship: a.shipId, dest: g.dest, heads: 0, fares: 0, due: null };
        x.heads += g.size;
        x.fares += g.farePence;
        const t = Date.parse(g.promisedAt ?? "");
        if (Number.isFinite(t)) x.due = x.due === null ? t : Math.min(x.due, t);
        aboard.set(k, x);
      }
    }
    return {
      enabled: this.settings.usePassengers,
      blocked: w.paxBlockedNow() !== null,
      earned: Math.round(this.retired.passengerPence + [...this.agents.values()].reduce((n, a) => n + (a.stats.passengerPence ?? 0), 0)),
      aboard: [...aboard.values()].map((x) => ({ ship: x.ship, dest: x.dest, heads: x.heads, fares: x.fares, dueInMs: x.due !== null ? Math.max(0, x.due - now) : null })),
      offers: ships.flatMap((a) => a.paxOffers().map((o) => ({ ship: a.shipId, port: o.port, dest: o.dest, perHead: o.perHead, berths: o.berths, taken: o.taken }))),
      routes: w
        .paxRouteList()
        .sort((x, y) => y[1].at - x[1].at)
        .slice(0, 6)
        .map(([route, x]) => ({ route, adj: x.adj, ...(x.adjOpen !== undefined ? { adjOpen: x.adjOpen } : {}), won: x.won, lost: x.lost })),
      records: w.fares.records.length,
      ...(w.fareSummary.at ? { uncontested: w.fareSummary.unmet } : {}),
    };
  }

  /** Ship mortgages in the buyer for the digest: whether it may take one now, its latest checks of one, the last hull built on one. */
  private digestMortgage(): NonNullable<DigestInput["finance"]["mortgage"]> {
    const s = this.settings;
    const busy = this.mortgageBusy();
    const last = [...this.purchases].reverse().find((p) => (p.mortgagePence ?? 0) > 0);
    return {
      state: !s.mortgages ? "off" : !s.leverage ? "off (leverage is off)" : busy ? `none now: ${busy}` : "on (leverage's gates and the debt cap apply)",
      checks: [...this.mortgageSeen].slice(-3).map(([k, code]) => ({ yard: k.slice(0, k.lastIndexOf("|")), cls: k.slice(k.lastIndexOf("|") + 1), code })),
      lastBuilt: last ? { cls: last.shipClass, yard: last.port, agoMs: Math.max(0, Date.now() - Date.parse(last.at)), principal: last.mortgagePence ?? 0 } : null,
    };
  }

  /**
   * Housekeeping for the digest: the dead-weight candidates and the ships being retired by ship id, the last retired, the home's case
   * in figures and the autopilot's own words (never the game's), where we have presence to move to, the Crowns topped up.
   */
  private digestHousekeeping(now: number): DigestInput["housekeeping"] {
    const w = this.world;
    const hc = this.homeCase;
    const present = new Set<string>(this.factorPorts);
    for (const a of this.agents.values()) {
      const sh = a.last?.ship;
      if (!a.gone && sh && sh.status !== "sailing" && sh.current_port_id) present.add(sh.current_port_id);
    }
    const nextAt = Math.max(this.movedAt ? this.movedAt + RELOCATE_GAP_MS : 0, this.nextMoveAt ? this.nextMoveAt - w.skewMs : 0, this.moveBlockedUntil);
    return {
      breakUp: {
        enabled: this.settings.autoBreakUp,
        blocked: this.retireBlocked(),
        candidates: this.deadSeen.map((c) => ({
          ship: c.shipId,
          reason: c.reason,
          checks: c.checks,
          ready: c.matured,
          payout: c.payoutPence,
          earnPerDay: c.earnPerDayPence,
          upkeepPerDay: c.upkeepPerDayPence,
          horizonH: c.horizonHours,
          gain: c.gainPence,
          worthGain: c.worthGainPence,
        })),
        pending: [...this.retiring].map(([id, m]) => ({ ship: id, stage: m.stage, yard: m.yard, payout: m.payout, ordered: m.why.startsWith(AI_RETIRE_WHY) })),
        done: this.retiredRecs.map((r) => ({ cls: r.cls, port: r.port, how: r.how, pence: r.pence, agoMs: Math.max(0, Date.now() - r.at) })),
        refused: [...this.crownRefused].filter(([, until]) => until > now).map(([region]) => region),
        brokenUp: this.retireStats.brokenUp,
        payout: this.retireStats.payout,
        sold: this.retireStats.sold,
        soldPence: this.retireStats.soldPence,
      },
      relocate: {
        enabled: this.settings.autoRelocate,
        home: this.homePort,
        region: this.homeRegion,
        perDay: hc?.perDay ?? 0,
        byRegion: (hc?.byRegion ?? []).map((x) => ({ region: x.region, share: x.share })),
        saving: hc?.saving ?? 0,
        threshold: hc?.threshold ?? 0,
        fee: RELOCATE_FEE_PENCE,
        verdict: this.homeVerdict(),
        target: hc?.target ?? null,
        presence: [...present].filter((p) => p !== this.homePort && !!w.port(p) && w.isOpen(p) && !w.isCove(p)).sort(),
        nextInMs: nextAt > Date.now() ? nextAt - Date.now() : null,
      },
      toppedUp: this.crownTopUps.map((t) => ({ region: t.region, agoMs: Math.max(0, now - t.at) })),
    };
  }

  /** The home port's verdict (reviewHome's code) in the autopilot's own words, never the game's: for the digest. */
  private homeVerdict(): string {
    const code = this.relocateSaid;
    const holds = "the case holds, but";
    const words: Record<string, string> = {
      "": "not checked yet",
      off: "moving it is off",
      scope: "the key lacks infra_manage",
      season: "the season's endgame: it stays",
      "case:unknown": "the home port isn't known yet",
      "case:untracked": "fees not tracked over a full window yet",
      "case:none": "no remit fees paid to fund it",
      "case:split": "no one region paid most of the fees",
      "case:small": "the fees don't beat the move 1.5x",
      ai: "your order to move stands",
      gap: `${holds} it moved lately (our 3-real-day gap)`,
      server: `${holds} the server's day since the last move hasn't passed`,
      backoff: `${holds} a refused try is backing off`,
      vault: `${holds} the donor region's vault can't pay the fee above its floor`,
      presence: `${holds} we have no presence in the donor region`,
      lost: "the last move had no answer and didn't go through",
      moved: "moved",
    };
    return words[code] ?? (code.startsWith("refused:") ? "the last move was refused" : "not checked yet");
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
          : this.smugglers.has(a.shipId) ? "smuggling"
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
          pax: a.paxHeads(),
          retiring: this.retiring.get(a.shipId)?.stage ?? null,
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
        levyExcess: this.levyExcess(),
        levyPerDay: this.levyPerDay(),
        charterEarned: Math.round(w.charterEarnings(now)),
        charterTaper: w.charterTaper(0, w.charterEarnings(now)),
        drafts: this.drafts.n,
        draftSaved: this.drafts.saved,
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
        billsFloor: Math.ceil(UPKEEP_DAYS_RESERVED * (this.upkeepPerDay() + this.levyPerDay())),
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
      smuggling: this.digestSmuggling(now),
      passengers: this.digestPassengers(now),
      housekeeping: this.digestHousekeeping(now),
    };
  }

  /** Our loans for the digest: no lender, borrower or ship named, only what a loan was for (a hull or a load). Rates annual bps. */
  private digestFinance(now: number): DigestInput["finance"] {
    const f = this.financeReport();
    const inMs = (iso: string | null) => (iso ? Math.max(0, Date.parse(iso) - now) : null);
    const annual = (r: FinanceLoanRow) => (r.rateBasis === "daily" ? r.rateBps * 360 : r.rateBps);
    return {
      owed: f.debtPence,
      cap: f.capPence,
      worth: f.netWorthPence,
      loans: f.borrowed.map((b) => ({
        id: b.id,
        owed: b.owedPence,
        rateBps: annual(b),
        repayInMs: inMs(b.repayBy),
        use: this.loanRecs.get(b.id)?.use ?? null,
        defaulted: b.status === "defaulted",
        repayment: b.repayment,
        nextPaymentInMs: b.status === "active" ? inMs(b.nextPaymentAt) : null,
        nextPaymentPence: b.status === "active" ? b.nextPaymentPence : null,
        arrears: b.arrearsPence,
        mortgage: b.isMortgage,
      })),
      mortgage: this.digestMortgage(),
      lentOut: f.lent.reduce((n, l) => n + Math.max(0, l.owedPence), 0),
      quoted: f.quotes.reduce((n, q) => n + q.principalPence, 0),
      quotes: f.quotes.map((q) => ({ principal: q.principalPence, rateBps: q.rateBps, termDays: q.termDays })),
      requests: f.requests
        .filter((r) => r.status === "open")
        .map((r) => {
          const old = r.refinances ? this.loanRecs.get(r.refinances) : undefined;
          return { principal: r.principalPence, termDays: r.termDays, quotes: r.quotes, bestBps: r.bestBps, refinancesBps: old ? (old.rateBasis === "daily" ? old.rateBps * 360 : old.rateBps) : null };
        }),
      short: f.short !== null,
      goldsmiths: [30, 90, 180, 360].map((days) => ({ days, bps: goldsmithsAnnualBps(days) })),
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
    const patrolPrices = this.patrolPriceMap();
    const seized = new Map(w.seizuresByZone(now).map(([z, atSea, inPort]) => [z, { atSea, inPort }]));
    const smuggle = this.smugglingZones();
    for (const z of w.catalog.sea_zones) {
      if (z.phase > w.unlockedPhase) continue;
      const r = read.get(z.id);
      const t = traffic.get(z.id);
      const net = r?.net_piracy_bps ?? w.piracy.get(z.id) ?? 0;
      const own = this.ownExposureSeen.get(z.id) ?? 0;
      const mine = ours(z.id);
      const s = seized.get(z.id) ?? null;
      if (net <= 0 && !t && own <= 0 && mine.length === 0 && !s) continue;
      out.push({
        zone: z.id,
        net,
        split: r ? { base: r.base_piracy_bps, marque: r.marque_piracy_bps, patrol: r.patrol_suppression_bps } : null,
        rivals: t ? { passages: t.passages, laden: t.laden, cargo: t.cargo } : null,
        ownExposure: Math.round(own),
        ours: mine,
        marquePrice: prices.get(z.id) ?? null,
        patrolPrice: patrolPrices.get(z.id) ?? null,
        seized: s,
        noPatrol: smuggle === null || smuggle.has(z.id),
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
      drafts: this.drafts.n ? { ...this.drafts } : undefined,
      eventCursor: this.eventCursor ?? null,
      tempFactors: [...this.tempFactors],
      hullQuotes: [...this.hullQuotes],
      hullUplift: this.hullUplift.size ? [...this.hullUplift] : undefined,
      factorBlockedUntil: this.factorBlockedUntil,
      factorFails: this.factorFails,
      pendingBuild: this.pendingBuild,
      agents,
      world: this.world.snapshot(),
      ai: this.advisor.snapshot(),
      camping: [...this.campState],
      campShut: [...this.campShut],
      resized: { ...this.resized },
      bills: this.bills.at !== null ? { rent: [...this.bills.rent], upkeep: this.bills.upkeep, levy: this.bills.levy || undefined, at: this.bills.at } : undefined,
      announcement: this.announcement ?? undefined,
      keyWarned: this.keyExpiresAt !== null && this.keyWarned.size ? { expiresAt: this.keyExpiresAt, marks: [...this.keyWarned] } : undefined,
      finance:
        this.loanRecs.size ||
        this.pendingCredit.length ||
        this.ourQuotes.size ||
        this.ourRequests.size ||
        this.interestPaidBefore ||
        this.interestEarnedBefore ||
        this.goldsmithsBanUntil > this.world.now()
          ? {
              recs: [...this.loanRecs],
              pending: [...this.pendingCredit],
              quotes: [...this.ourQuotes],
              requests: [...this.ourRequests],
              interestPaidBefore: this.interestPaidBefore,
              interestEarnedBefore: this.interestEarnedBefore,
              goldsmithsBanUntil: this.goldsmithsBanUntil > this.world.now() ? this.goldsmithsBanUntil : undefined,
            }
          : undefined,
      deals:
        this.commissionRecs.size || this.envelopeRecs.size || this.pendingEnvelopes.length || Object.values(this.dealStats).some((n) => n !== 0)
          ? { commissions: [...this.commissionRecs], envelopes: [...this.envelopeRecs], pendingEnvelopes: [...this.pendingEnvelopes], stats: { ...this.dealStats } }
          : undefined,
      smuggle:
        this.smugglers.size || this.smuggleRuns.length || this.smuggleHalt || this.convictions.length || this.wantsSeen.size || this.smuggleModel.runs || this.smuggleModel.portHours
          ? {
              model: { ...this.smuggleModel, runHours: [...this.smuggleModel.runHours] },
              roles: [...this.smugglers],
              runs: this.smuggleRuns,
              runTimes: this.smuggleRunTimes,
              stats: { ...this.smuggleStats },
              halt: this.smuggleHalt,
              convictions: this.convictions,
              seized: [...this.seizedNoted].slice(-100),
              wants: [...this.wantsSeen],
              log: this.smuggleLog,
              scoutAt: this.lastScoutAt || undefined,
            }
          : undefined,
      housekeeping:
        this.retiring.size || this.retiredRecs.length || this.crownRefused.size || this.homeFees.length || this.feesSince !== null || this.movedAt || this.crownTopUps.length || this.disposedIds.size
          ? {
              retiring: [...this.retiring].map(([id, m]) => [id, { ...m, ...(m.listed ? { listed: { ...m.listed } } : {}) }]),
              done: this.retiredRecs,
              refused: [...this.crownRefused],
              fees: this.homeFees,
              feesSince: this.feesSince,
              movedAt: this.movedAt || undefined,
              nextMoveAt: this.nextMoveAt || undefined,
              moveBlockedUntil: this.moveBlockedUntil || undefined,
              topUps: this.crownTopUps,
              stats: { ...this.retireStats },
              disposed: this.disposedIds.size ? [...this.disposedIds] : undefined,
            }
          : undefined,
    };
  }

  private restoreFrom(s: FleetSnapshot): void {
    this.progressSince = s.progressSince;
    if (s.log?.length) this.logLines = s.log.slice(-LOG_LIMIT);
    if (s.purchases?.length) this.purchases = s.purchases.slice(-50);
    if (s.retired) this.retired = { ...this.retired, ...s.retired };
    this.shipSpendPence = s.shipSpendPence ?? 0;
    if (s.drafts && Number.isFinite(s.drafts.n) && Number.isFinite(s.drafts.saved)) this.drafts = { n: s.drafts.n, saved: s.drafts.saved };
    this.eventCursor = s.eventCursor ?? undefined;
    for (const y of s.tempFactors ?? []) this.tempFactors.add(y);
    for (const [k, v] of s.hullQuotes ?? []) this.hullQuotes.set(k, v);
    for (const [k, v] of s.hullUplift ?? []) if (typeof k === "string" && Number.isFinite(v) && v >= 0) this.hullUplift.set(k, v);
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
        // Older saves didn't measure the levy: the formula alone until the ledger is read.
        levy: Number.isFinite(s.bills.levy) ? s.bills.levy! : 0,
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
    // Loans as last seen (a record from before loans by quote is a daily-rate one: such loans run on to maturity), calls with
    // no answer (still never sent again), our quotes and requests: loan/list and the requests correct them. The board is
    // gone: older saves' offers (their escrow came back with it) and offer posts are dropped.
    const f = s.finance;
    if (f) {
      for (const [id, r] of f.recs ?? []) {
        if (typeof id === "string" && r && (r.role === "borrower" || r.role === "lender")) this.loanRecs.set(id, { ...r, rateBasis: r.rateBasis ?? "daily" });
      }
      const kinds: ReadonlyArray<PendingCredit["kind"]> = ["borrow", "approve", "request", "quote"];
      this.pendingCredit = (f.pending ?? []).filter((p) => p && kinds.includes(p.kind) && Number.isFinite(p.at) && Number.isFinite(p.principal));
      for (const [id, q] of f.quotes ?? []) if (typeof id === "string" && q && typeof q.region === "string" && Number.isFinite(q.principal)) this.ourQuotes.set(id, q);
      for (const [id, r] of f.requests ?? []) if (typeof id === "string" && r && typeof r.region === "string" && typeof r.replaces === "string") this.ourRequests.set(id, r);
      this.interestPaidBefore = Number.isFinite(f.interestPaidBefore) ? f.interestPaidBefore! : 0;
      this.interestEarnedBefore = Number.isFinite(f.interestEarnedBefore) ? f.interestEarnedBefore! : 0;
      this.goldsmithsBanUntil = Number.isFinite(f.goldsmithsBanUntil) ? f.goldsmithsBanUntil! : 0;
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
    // The smuggling mode: its model, our smugglers mid-run (a ship no longer ours is dropped at the next pass), the record, the
    // halt after a seizure, the wants seen.
    const sm = s.smuggle;
    if (sm) {
      this.smuggleModel = restoreModel(sm.model);
      for (const [id, r] of sm.roles ?? []) {
        if (typeof id === "string" && r && (r.purpose === "buy" || r.purpose === "run" || r.purpose === "sell") && Number.isFinite(r.since)) {
          this.smugglers.set(id, { ...r, voyage: !!r.voyage, lying: r.lying ?? null, run: r.run ?? null, load: r.load ?? null, odds: r.odds ?? null, waitingSince: r.waitingSince ?? null, zones: Array.isArray(r.zones) ? r.zones : null });
        }
      }
      this.smuggleRuns = (sm.runs ?? []).filter((x) => x && typeof x.ship === "string" && Number.isFinite(x.at)).slice(-SMUGGLE_RUNS_KEPT);
      this.smuggleRunTimes = (sm.runTimes ?? []).filter((t) => Number.isFinite(t)).slice(-50);
      for (const k of Object.keys(this.smuggleStats) as (keyof SmuggleStats)[]) {
        const v = sm.stats?.[k];
        if (typeof v === "number" && Number.isFinite(v)) this.smuggleStats[k] = v;
      }
      const h = sm.halt;
      if (h && Number.isFinite(h.at) && typeof h.why === "string") this.smuggleHalt = { at: h.at, why: h.why };
      this.convictions = (sm.convictions ?? []).filter((c) => c && Number.isFinite(c.at) && typeof c.ship === "string").slice(-50);
      for (const id of sm.seized ?? []) if (typeof id === "string") this.seizedNoted.add(id);
      for (const c of this.convictions) if (typeof c.id === "string") this.seizedNoted.add(c.id);
      for (const [k, x] of sm.wants ?? []) if (typeof k === "string" && x && typeof x.port === "string" && Number.isFinite(x.at) && Number.isFinite(x.multipleBps)) this.wantsSeen.set(k, x);
      this.smuggleLog = (sm.log ?? []).filter((l) => l && typeof l.msg === "string").slice(-SMUGGLE_LOG_KEEP);
      this.lastScoutAt = Number.isFinite(sm.scoutAt) ? sm.scoutAt! : 0;
    }
    // Housekeeping: a ship listed or broken up with no answer carries on from where she stood (a mark whose ship is no longer
    // ours is dropped at the next pass); the fees, the moves and the records as saved.
    const hk = s.housekeeping;
    if (hk) {
      const stages: ReadonlyArray<RetireMark["stage"]> = ["wanted", "sail", "listed", "breakup", "verify"];
      for (const [id, m] of hk.retiring ?? []) {
        if (typeof id === "string" && m && stages.includes(m.stage) && typeof m.yard === "string" && Number.isFinite(m.rebuild) && Number.isFinite(m.payout)) this.retiring.set(id, m);
      }
      this.retiredRecs = (hk.done ?? []).filter((r) => r && typeof r.shipId === "string" && Number.isFinite(r.pence)).slice(-RETIRED_KEPT);
      for (const r of this.retiredRecs) this.retiredIds.add(r.shipId);
      // An older save has no list: its sales stand for it.
      for (const id of [...(hk.disposed ?? []), ...this.retiredRecs.filter((r) => r.how === "sold").map((r) => r.shipId)]) if (typeof id === "string") this.disposedIds.add(id);
      for (const [region, until] of hk.refused ?? []) if (asRegion(region) && Number.isFinite(until)) this.crownRefused.set(region, until);
      this.homeFees = (hk.fees ?? []).filter((f) => f && asRegion(f.from) && Number.isFinite(f.at) && Number.isFinite(f.fee)).slice(-HOME_FEES_KEPT);
      this.feesSince = Number.isFinite(hk.feesSince) ? hk.feesSince! : null;
      this.movedAt = Number.isFinite(hk.movedAt) ? hk.movedAt! : 0;
      this.nextMoveAt = Number.isFinite(hk.nextMoveAt) ? hk.nextMoveAt! : 0;
      this.moveBlockedUntil = Number.isFinite(hk.moveBlockedUntil) ? hk.moveBlockedUntil! : 0;
      this.crownTopUps = (hk.topUps ?? []).filter((t) => t && Number.isFinite(t.at) && typeof t.title === "string").slice(-TOP_UPS_KEPT);
      for (const k of Object.keys(this.retireStats) as (keyof RetireStats)[]) {
        const v = hk.stats?.[k];
        if (typeof v === "number" && Number.isFinite(v)) this.retireStats[k] = v;
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
    // Smuggling allowed or withdrawn on the Underworld page (guide 3.18: scope `underworld`).
    const smuggle = who.scopes.includes("underworld");
    if (smuggle !== this.canSmuggle) {
      this.canSmuggle = smuggle;
      this.smuggleNote(
        "smuggling",
        smuggle
          ? `the company key now holds the underworld scope: the smuggling mode ${this.ownSettings.smuggling ? "may run" : "is available (off in the settings)"}`
          : "the company key no longer holds the underworld scope: the smuggling mode is unavailable (no buying, no new runs)",
      );
    }
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
    // The Free Trade needs its own scope (guide 3.18), never on a key by default: allowed on the Underworld page.
    this.canSmuggle = who.scopes.includes("underworld");
    if (this.ownSettings.smuggling && !this.canSmuggle) this.log("fleet", "smuggling is on but the key lacks the underworld scope: the mode is unavailable (allow smuggling on the Underworld page)");

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
    if (this.smuggleHalt && this.resumeSmuggling && this.ownSettings.smuggling) {
      this.smuggleNote("smuggling", `smuggling re-enabled at start (KIBB_SMUGGLING=resume) after the seizure (${this.smuggleHalt.why})`);
      this.smuggleHalt = null;
    } else if (this.smuggleHalt && this.ownSettings.smuggling) {
      this.log("fleet", `smuggling stays off since the seizure (${this.smuggleHalt.why}): turn it off and on again (CLI: KIBB_SMUGGLING=resume) to resume`);
    }
    this.progressSince ??= new Date().toISOString();
    await this.world.init();
    const profile = await this.client.companyProfile();
    this.setHome(profile.company.home_port_id);
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
    // Nor its break-up and home-port orders the bills pass (a ship it marks is retired at her own turn in port).
    if (now - this.lastAiHousekeepingTry > AI_HOUSEKEEPING_RETRY_MS && this.advisor.financeOrders().some((o) => isHousekeeping(o) && o.status !== "unmet")) {
      this.lastAiHousekeepingTry = now;
      await this.runAiHousekeeping().catch((e) => {
        if (this.isFatal(e) || isApiError(e, "world_paused")) throw e;
        this.log("fleet", `AI housekeeping orders: ${(e as Error).message}`);
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
      // The slow chores beside the bills (housekeeping.ts): dead weight judged (each ship's own turn retires her), and the home
      // moved to where the cash lands.
      await this.reviewDeadWeight().catch((e) => {
        if (this.isFatal(e) || isApiError(e, "world_paused")) throw e;
        this.log("fleet", `dead-weight check failed: ${(e as Error).message}`);
      });
      await this.reviewHome().catch((e) => {
        if (this.isFatal(e) || isApiError(e, "world_paused")) throw e;
        this.log("fleet", `home port check failed: ${(e as Error).message}`);
      });
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
    if (now - this.lastSmuggleCheck > SMUGGLE_CHECK_MS) {
      this.lastSmuggleCheck = now;
      await this.runSmuggling().catch((e) => {
        if (this.isFatal(e) || isApiError(e, "world_paused")) throw e;
        this.log("fleet", `smuggling check failed: ${(e as Error).message}`);
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
        // Built on a mortgage: its loan (made with the build, or not at all) is looked for on this ship among our loans.
        if (pending.mortgage) {
          const p = this.pendingCredit.find((x) => x.kind === "borrow" && x.mortgage && !x.ship);
          if (p) p.ship = found.ship.id;
          this.loansDirty = true;
          this.financeDirty = true;
        }
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
          ...(pending.mortgage ? { mortgagePence: pending.mortgage.principal } : {}),
        });
        this.log(
          "fleet",
          `the ${pending.cls} "${pending.name}" was ${pending.shipId ? "bought" : "built"} after all` +
            `${pending.mortgage ? ` on a mortgage of ~${cr(pending.mortgage.principal)} (installments of ~${cr(pending.mortgage.installment)} every ${MORTGAGE_INSTALLMENT_DAYS} game days; its loan is looked for among ours)` : ""}`,
        );
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
      // A hull of ours retired before and back in the fleet (bought back by hand): a ship like any other from now (lanes, her
      // dead-weight checks, a seizure counted). A restart's records add her id again; this scan clears it again.
      this.retiredIds.delete(r.ship.id);
      this.leftFleet.delete(r.ship.id);
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
        this.checkLostSmuggler(a);
        // Being retired when she went with no notice of why: a break-up whose answer was lost went through; otherwise her mark goes.
        const m = this.retiring.get(id);
        if (m) this.settleRetired(id, m.stage === "verify" ? "broken_up" : null, {});
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
   * What a hull of this class costs to replace (pence; guide 3.4 rebuild value, at full labour and markup whatever the
   * discount yards charge): the class's rebuild quote (knownQuotes), else a rough figure from its hold. Prices the chance
   * of pirates taking the ship or a storm sinking her, pledges, guns, convoys and our net-worth estimate.
   */
  private hullValue(shipClass: string): number {
    return this.knownQuotes(shipClass).get(shipClass) ?? (this.world.shipClass(shipClass)?.hold_capacity_tons ?? 40) * HULL_PENCE_PER_TON;
  }

  /** A discount yard (guide 3.4: Lisbon, Boston, Havana): the catalog's `yard_discount`, or a quote there that showed one. */
  private discountYard(yard: string, cls?: string): boolean {
    return !!this.world.port(yard)?.yard_discount || (cls !== undefined && this.hullUplift.has(`${yard}|${cls}`));
  }

  /**
   * Caches a turnkey quote (hullQuotes: what a build there costs us) and, at a discount yard (guide 3.4: labour cut, no
   * turnkey markup, the same rebuild value), what the discount took off it (hullUplift): its labour back at the full
   * rate, and the 15% markup on the NPC-bought materials it waived. A quote that can't be priced drops the cached one.
   */
  private noteHullQuote(yard: string, cls: string, q: BuildQuote): void {
    const key = `${yard}|${cls}`;
    if (!q.total_cost_pence) return this.dropHullQuote(yard, cls);
    this.hullQuotes.set(key, q.total_cost_pence);
    const d = q.yard_discount ?? this.world.port(yard)?.yard_discount ?? null;
    if (!d) {
      this.hullUplift.delete(key);
      return;
    }
    const bps = Math.min(9_000, Math.max(0, d.labour_discount_bps ?? 0));
    const labour = Math.round((Math.max(0, q.labour_pence) * bps) / (10_000 - bps));
    const markup = d.turnkey_markup_waived ? Math.max(0, Math.round((Math.max(0, q.npc_materials_pence ?? 0) * YARD_MARKUP_BPS) / 10_000) - (q.yard_markup_pence ?? 0)) : 0;
    this.hullUplift.set(key, labour + markup);
  }

  private dropHullQuote(yard: string, cls: string): void {
    this.hullQuotes.delete(`${yard}|${cls}`);
    this.hullUplift.delete(`${yard}|${cls}`);
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
    // The wealth levy is on net worth now (guide 3.12): cash put into loads or hulls is levied the same, so it never
    // makes spending free.
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
    // Being sold or broken up: her guns go with her (150 Cr each in the rebuild value), and a change of guns cancels a listing.
    if (policy === "off" || this.retiring.has(agent.shipId)) return undefined;
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
    // Valued as the planner values it: the goods at base price, freight at ~3x its collateral (return freight at nothing).
    const goodsTons = lane.parts.reduce((n, p) => n + p.tons, 0);
    const lootPerTon =
      lane.tons > 0
        ? (lane.parts.reduce((n, p) => n + p.tons * this.world.basePrice(p.good), 0) + lane.freight.reduce((n, f) => n + freightLoot(f), 0)) / Math.max(goodsTons + lane.freight.reduce((n, f) => n + f.tons, 0), 1)
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
      case "passengers_boarded":
      case "passengers_paid":
      case "passengers_lost": {
        // Ours (guide 3.20). Beyond the fields the guide names (heads, fare, `promised_arrival_at`; `fare_paid_pence`,
        // `game_days_late`; `cause`) the shapes are guessed, read defensively: a notice short of what it needs has the ship read
        // who is aboard again. The ship by its id, else by the offer or group it names.
        const gid = str("group_id", "passenger_group_id") ?? (e.event_type === "passengers_boarded" ? str("id") : undefined);
        const offerId = str("offer_id");
        const ship = agent ?? [...this.agents.values()].find((a) => !a.gone && a.knowsPax(offerId, gid));
        const size = num("size") ?? num("heads") ?? num("group_size");
        if (e.event_type === "passengers_boarded") {
          const per = num("fare_per_head_pence");
          const full = num("full_fare_pence") ?? num("fare_pence");
          if (ship) {
            ship.paxBoarded({
              id: gid,
              kind: str("kind"),
              size,
              origin: str("origin_port_id") ?? e.port_id ?? undefined,
              dest: str("dest_port_id", "destination_port_id"),
              perHead: per,
              farePence: full,
              promisedAt: str("promised_arrival_at"),
              boardedAt: str("boarded_at") ?? e.timestamp,
              offerId,
            });
          } else this.log("fleet", `passengers boarded a ship of ours${size ? ` (${size} heads)` : ""}${full ? ` for ${cr(full)}` : ""}, but which isn't known`);
        } else if (e.event_type === "passengers_paid") {
          const fare = num("fare_paid_pence") ?? num("amount_pence") ?? num("fare_pence");
          const late = num("game_days_late");
          const port = e.port_id ?? str("dest_port_id", "port_id");
          if (ship) ship.paxPaid({ fare, late, id: gid, port });
          else {
            // A ship we no longer command (it left the fleet as she landed): into the vault and the retired totals.
            if (fare && fare > 0) {
              if (port) this.world.vaults.set(this.world.region(port), this.world.vault(this.world.region(port)) + fare);
              else void this.world.refreshVaults().catch(() => undefined);
              this.retired.passengerPence += fare;
              this.cashArrived();
            }
            this.log("fleet", `passengers paid ${cr(fare ?? 0)}${port ? ` at ${port}` : ""}${late ? ` (${late} game days late)` : ""}`);
            this.persist(true);
          }
        } else {
          const cause = str("cause", "reason");
          if (ship) ship.paxLost({ cause, id: gid, size });
          else this.log("fleet", `passengers lost, unpaid${size ? ` (${size} heads)` : ""}: ${cause ?? "no cause given"}`);
        }
        break;
      }
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
          const leg = r?.route_legs[r.ship.current_leg_idx];
          const zone = storm.zone ?? leg?.to_node ?? null;
          // The leg's crossing counts when the storm is in the zone it ends in (the rougher water, guide 3.5).
          const edge = leg && zone && this.world.hazardZone(leg.to_node)?.id === this.world.hazardZone(zone)?.id ? leg.edge_class : null;
          this.world.noteStorm(zone, this.world.shipClass(agent.shipClass)?.hull_category ?? "coastal", storm.at ?? this.world.now(), storm.share, storm.sunk, edge, storm.stores);
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
      case "exchequer_remittance":
        this.noteCrownTopUp(p, e.timestamp);
        break;
      case "charter_posted":
      case "world_phase_unlocked":
      case "expansion_target_rescaled":
      case "world_event":
        // The Exchequer's daily top-up of a Crown run low (guide 3.1: public, never how much) is news, not a shock to plan on: up to
        // eight a game day would refresh the world, wake the loop and crowd real shocks out of the AI's queue. Said and kept.
        if (e.event_type === "world_event" && p.event_type === "exchequer_remittance") {
          this.noteCrownTopUp(p, e.timestamp);
          break;
        }
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
      case "loan_quote_received":
      case "loan_request_expired": {
        // Ours as borrower: a lender quoted on our request (it may refinance a Goldsmiths' loan for less), or it lapsed.
        this.financeDirty = true;
        this.requestsDirty = true;
        const reqId = str("request_id");
        const rate = num("annual_rate_bps");
        if (e.event_type === "loan_request_expired") {
          const r = reqId ? this.ourRequests.get(reqId) : undefined;
          if (reqId && r) {
            this.ourRequests.delete(reqId);
            this.log("fleet", `our request for ${cr(r.principal)} lapsed${r.quotes ? "" : " with no quote"}: the Goldsmiths' loan it would have refinanced runs on`);
          }
        } else if (reqId && this.ourRequests.has(reqId)) {
          // A bank's lending line quotes at once (`auto: true`, guide 3.13.8; it stands 6 game hours): read and weighed within seconds.
          const auto = p.auto === true;
          const line = str("lending_line_id");
          const lender = str("lender_name", "bank_name");
          this.log(
            "fleet",
            `${auto ? `${lender ? `${lender}'s` : "a bank's"} lending line quoted on its own` : "a lender quoted"} on our request (${reqId.slice(0, 8)})` +
              `${rate !== undefined ? ` at ${pctYear(rate)}` : ""}${line ? ` (line ${line.slice(0, 8)})` : ""}: weighed against the Goldsmiths' loan it would refinance`,
          );
        }
        break;
      }
      case "lending_line_posted": {
        // Public (guide 3.13.8): a bank's standing terms, quoting at once on every request they cover. Our refinance requests are shaped
        // to the cheapest line: the lines in its regions are read again at the next finance pass. Said once per line.
        const regions = Array.isArray(p.regions) ? p.regions.filter((x): x is string => typeof x === "string") : [];
        const named = [...new Set([...regions, str("banking_region") ?? ""])].map((x) => asRegion(x)).filter((x): x is BankingRegion => x !== null);
        if (named.length) for (const r of named) this.linesSeen.delete(r);
        else this.linesSeen.clear();
        const share = num("rate_pct_of_goldsmiths_bps");
        const lid = str("line_id", "lending_line_id", "id") ?? e.id;
        this.logOnceFor(
          `line-posted|${lid}`,
          "fleet",
          `${str("bank_name") ?? "a bank"} posted a lending line${named.length ? ` in ${named.join(", ")}` : ""}${share ? ` at ${Math.round(share / 100)}% of the Goldsmiths' rate` : ""}: weighed for refinancing our Goldsmiths' loans`,
        );
        // Only worth a finance pass while we owe a Goldsmiths' loan it could refinance.
        if ([...this.loanRecs.values()].some((r) => r.role === "borrower" && r.source === "goldsmiths" && !r.refinanced && !r.refiLineAsked && !r.isMortgage && r.status === "active")) this.financeDirty = true;
        break;
      }
      case "lending_line_quoted":
      case "lending_line_exhausted": {
        // Ours as a bank (the user's, run by hand: the autopilot posts no lines): logged only.
        const principal = num("principal_pence");
        const rate = num("annual_rate_bps");
        this.log(
          "fleet",
          e.event_type === "lending_line_quoted"
            ? `our bank's lending line quoted on a request${principal ? ` for ${cr(principal)}` : ""}${rate !== undefined ? ` at ${pctYear(rate)}` : ""} (escrowed until approved or released)`
            : "our bank's lending line has less room left than its smallest loan: it quotes no more until loans are repaid or its terms change",
        );
        break;
      }
      case "bank_draft": {
        // A remittance carried by a bank as a draft (guide 3.12; payer and bank both told). The vaults are already right: ours as payer
        // was booked and logged by its remit call (that ledger group isn't logged twice); one made by hand, or ours as the bank, is
        // logged here only.
        const tx = str("tx_group_id", "ledger_group_id");
        if (tx && this.draftsLogged.has(tx)) break;
        const payer = str("payer_company_id", "company_id");
        const bankId = str("bank_company_id");
        const asBank = !!bankId && this.isOurCompany(bankId) && !(payer && this.isOurCompany(payer));
        const from = str("from_region");
        const to = str("to_region");
        const gross = num("gross_amount_pence");
        const fee = num("fee_pence");
        this.log(
          "fleet",
          `${asBank ? "our bank carried a remittance as a draft" : `${str("bank_name") ?? "a bank"} carried a remittance of ours as a draft`}` +
            `${from && to ? ` ${from} → ${to}` : ""}${gross ? ` (${cr(gross)}` : ""}${gross && fee !== undefined ? `, fee ${cr(fee)})` : gross ? ")" : ""}`,
        );
        break;
      }
      case "charter_fill_dispatched": {
        // Ours as a charter's poster (posted by hand: the autopilot posts none): the Merchant Adventurers part-fill a stale, well-paid
        // charter from a nearby producer (guide 3.7); delivered like any carrier's when it lands. Logged only.
        const tons = num("quantity") ?? num("tons");
        const from = str("source_port_id", "origin_port_id");
        const at = str("arrives_at");
        this.log(
          "fleet",
          `the Merchant Adventurers sent${tons ? ` ${tons} t` : " a lot"}${str("commodity_id") ? ` of ${str("commodity_id")}` : ""} for our charter${e.port_id ? ` at ${e.port_id}` : ""}` +
            `${from ? ` from ${from}` : ""}${at ? `, landing ${at}` : ""}: paid from its escrow when it lands`,
        );
        break;
      }
      case "loan_quote_approved":
      case "loan_quote_released": {
        // Ours as lender (an idle-cash quote): approved, it is a loan we made (loan_disbursed follows); released, its escrow is back.
        this.financeDirty = true;
        this.loansDirty = true;
        const qid = str("quote_id", "id");
        const q = qid ? this.ourQuotes.get(qid) : undefined;
        if (qid && q) {
          this.ourQuotes.delete(qid);
          if (e.event_type === "loan_quote_approved") {
            this.log("fleet", `idle cash: our quote of ${cr(q.principal)} in ${q.region} at ${pctYear(q.rateBps)} for ${q.termDays} game days was approved: lent, secured, with recourse`);
          } else {
            this.log("fleet", `idle cash: our quote of ${cr(q.principal)} in ${q.region} was released (another quote won, or the request lapsed): its escrow is back in the vault`);
            // A failed read is harmless here: the next pass reads the vaults again.
            void this.world.refreshVaults().then(() => this.cashArrived(), () => undefined);
          }
          this.persist();
        }
        break;
      }
      case "loan_foreclosure_surplus_paid":
      case "loan_insurance_loss_paid":
      case "loan_walked_away":
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
        const loanId = str("loan_id") ?? str("id");
        const tag = loanId ? ` (${loanId.slice(0, 8)})` : "";
        const loanLike = !!str("id") && typeof p.principal_pence === "number" && typeof p.status === "string";
        if (loanLike) {
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
        if (e.event_type === "loan_foreclosure_surplus_paid") {
          const paid = num("surplus_pence") ?? num("amount_pence") ?? num("foreclosure_surplus_paid_pence");
          this.log("fleet", `a lender's foreclosure on a loan of ours${tag} paid us the surplus over the debt${paid !== undefined ? `: ${cr(paid)}` : ""}`);
          void this.world.refreshVaults().then(() => this.cashArrived(), () => undefined);
        } else if (e.event_type === "loan_insurance_loss_paid") {
          // A liened ship lost and insured: the claim paid the lender first (guide 3.13.1), the rest to the borrower.
          this.log("fleet", `an insurance claim on a pledged ship paid ${lender ? "us as the lender (loss payee) first" : "the lender first, and us the rest"}${tag}`);
        } else if (e.event_type === "loan_walked_away") {
          this.log("fleet", ours ? `a loan of ours${tag} was walked away from (by hand: the autopilot never does): the lender takes its pledge and the rest is written off, on our record for good` : lender ? `a borrower WALKED AWAY from a loan we made${tag}: its pledge comes to us, the rest is written off` : `a loan${tag} was walked away from`);
        }
        // Loans we made (an idle-cash quote approved, or one the user made): repayments, defaults and the pledge that comes to us.
        if (lender) {
          const amount = num("principal_pence");
          const kind = typeof p.collateral_kind === "string" ? p.collateral_kind : "";
          const rate = num("annual_rate_bps");
          if (e.event_type === "loan_disbursed") {
            this.log("fleet", `lent ${amount ? cr(amount) : "a loan"}${tag}${rate ? ` at ${pctYear(rate)}` : ""}${typeof p.term_game_days === "number" ? ` for ${p.term_game_days} game days` : ""}, secured by a ${kind.replace(/_/g, " ") || "pledge"}`);
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
      case "admiralty_commission_posted": {
        // Public (guide 3.4): a Crown wants a navy hull built at one of its yards. Weighed with the commissions soon (only where we have
        // presence at the yard, one Admiralty commission at a time, with ship deals on). Said once per commission.
        const cid = str("contract_id", "commission_id", "id") ?? e.id;
        const cls = str("ship_class", "ship_class_id", "class_id");
        const yard = e.port_id ?? str("port_id", "origin_port_id", "yard_port_id");
        const price = num("price_pence") ?? num("reward_pence");
        this.logOnceFor(
          `admiralty-posted|${cid}`,
          "fleet",
          `the Admiralty posted a commission${cls ? ` for a ${cls}` : ""}${yard ? ` at ${yard}` : ""}${price ? ` (${cr(price)} from the Crown on delivery)` : ""}: ` +
            `${this.settings.shipDeals ? "weighed with the commissions (one Admiralty commission at a time)" : "not weighed: ship deals are off"}`,
        );
        if (this.settings.shipDeals) this.dealsDirty = true;
        break;
      }
      case "admiralty_commission_delivered": {
        // Public: a navy hull handed to the Crown joins the Royal Navy and patrols its yard's zone a while (guide 3.5: lower piracy
        // there, read with the zones at the next world refresh). One of ours (the game said it took our acceptance, or the notice
        // names us as builder): settled as delivered (its own notice may follow). One whose acceptance had no answer may have gone
        // to another company, whose delivery this is: only said, and settled by our list or our own notice.
        const cid = str("contract_id", "commission_id", "id");
        const rec = cid ? this.commissionRecs.get(cid) : undefined;
        const builder = str("builder_company_id", "carrier_company_id");
        if (cid && rec && (rec.confirmed || (builder !== undefined && this.isOurCompany(builder)))) this.noteCommissionEvent(cid, rec, "commission_delivered", num("build_cost_pence"));
        else {
          const cls = str("ship_class", "ship_class_id", "class_id");
          const yard = e.port_id ?? str("port_id", "origin_port_id", "yard_port_id");
          this.logOnceFor(
            `admiralty-delivered|${cid ?? e.id}`,
            "fleet",
            `an Admiralty${cls ? ` ${cls}` : " hull"} was delivered${yard ? ` at ${yard}` : ""}: she joins the Royal Navy and patrols those waters a while` +
              `${rec ? " (the one we took with no answer: not counted ours until our commissions show it)" : ""}`,
          );
        }
        this.dealsDirty = true;
        break;
      }
      case "naval_patrol_funded": {
        // Public, never naming the sponsor (a player's patrol, or a Royal Navy hull from an Admiralty commission, guide 3.5): piracy
        // in the zone falls, read with the zones at the next world refresh. Said at most once a game day per zone.
        const zone = e.sea_zone_id ?? str("sea_zone_id", "zone_id");
        const bps = num("suppressed_piracy_bps") ?? num("bps");
        const day = Math.floor((Date.parse(e.timestamp) || this.world.now()) / this.gameDayMs);
        this.logOnceFor(`naval-patrol|${zone ?? "?"}|${day}`, "fleet", `a naval patrol was funded${zone ? ` in ${zone}` : ""}${bps ? ` (−${bps} bps piracy)` : ""}: piracy there falls while it lasts`);
        break;
      }
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
        // Seller and buyer: a ship we bought joins at the next scan; one of ours sold leaves the fleet then (her agent stops at its
        // next read). One housekeeping listed for the breakers is recorded as sold (once: by her id).
        const seller = str("seller_company_id");
        const price = num("price_pence");
        if (seller && this.isOurCompany(seller)) {
          const sold = str("ship_id");
          const m = sold ? this.retiring.get(sold) : undefined;
          if (sold && m) this.settleRetired(sold, "sold", { pence: price, port: e.port_id ?? str("port_id") });
          else this.log("fleet", `a ship of ours was sold where she lay${price ? ` for ${cr(price)}` : ""} (listed by hand)`);
          // Gone by sale: never taken for a seizure when she leaves the fleet.
          if (sold) this.noteLeftFleet(sold);
          void this.world.refreshVaults().then(() => this.cashArrived(), () => undefined);
          agent?.nudge();
        }
        this.lastScan = 0;
        break;
      }
      case "ship_broken_up": {
        // Ours (guide 3.4): sold to the yard for 35% of her rebuild value; she leaves the fleet at the next scan (never a seizure).
        // Broken up by housekeeping: booked when the call answered (the notice adds nothing), or now if its answer was lost.
        const id = str("ship_id");
        if (id) this.noteLeftFleet(id);
        const paid = num("payout_pence");
        if (id && this.retiredIds.has(id)) {
          this.lastScan = 0;
          break;
        }
        if (id && this.retiring.has(id)) this.settleRetired(id, "broken_up", { pence: paid, rebuild: num("rebuild_value_pence"), port: e.port_id ?? str("port_id") });
        else this.log(agent?.name ?? "fleet", `broken up at the yard${paid ? ` for ${cr(paid)}` : ""} (by hand)`);
        if (paid) void this.world.refreshVaults().then(() => this.cashArrived(), () => undefined);
        agent?.nudge();
        this.lastScan = 0;
        break;
      }
      case "auto_remittance": {
        // A bill its region couldn't cover, topped up from our others (guide 3.9; shape not published, read defensively): one into
        // home (or naming an upkeep bill) is a fee a home where the cash doesn't land costs (reviewHome). Always at the Crown's fee:
        // auto-remit never goes by bank draft (guide 3.12).
        const from = asRegion(str("from_region", "source_region", "donor_region"));
        const to = asRegion(str("to_region", "region", "banking_region", "dest_region"));
        const gross = num("gross_amount_pence") ?? num("amount_pence");
        const net = num("net_credited_pence") ?? num("net_amount_pence");
        const fee = num("fee_pence") ?? (gross !== undefined && net !== undefined ? gross - net : from && to && gross !== undefined ? Math.round((gross * this.world.remitBps(from, to)) / 10_000) : undefined);
        const bill = str("reason", "bill", "bill_kind", "kind") ?? "";
        const forHome = to !== null ? to === this.homeRegion : UPKEEP_REASON.test(bill);
        this.log("fleet", `auto-remit topped up ${to ?? "a region"}${from ? ` from ${from}` : ""}${net ?? gross ? ` with ${cr((net ?? gross)!)}` : ""}${fee ? ` (fee ${cr(fee)})` : ""}${bill ? ` for ${bill.replace(/_/g, " ")}` : ""}`);
        if (from && forHome && fee && fee > 0) this.noteHomeFee(from, fee, "auto", Date.parse(e.timestamp) || undefined);
        void this.world.refreshVaults().then(() => this.cashArrived(), () => undefined);
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
      case "home_port_relocated": {
        // Ours (guide 3.12): upkeep, marques, patrols and the Goldsmiths' default region follow the new home from now on. The
        // payload's shape isn't published: taken when it names a known port, and the profile is read again with the bills at once.
        const port = str("new_home_port_id", "home_port_id", "to_port_id", "port_id");
        if (port && this.world.port(port)) this.setHome(port);
        this.lastBillsCheck = 0;
        break;
      }
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
      case "smuggler_seized": {
        // Public (guide 3.18): a smuggler taken, her name and where. At sea, the patrols in force in that zone share half the base
        // value of her and everything aboard (guide 3.5); in port nobody does. The auto-patrol models each zone's prize money on
        // these. What was seized isn't published: priced only when the notice gives it (shapes guessed defensively).
        const at = Date.parse(e.timestamp) || this.world.now();
        const port = e.port_id ?? str("port_id") ?? null;
        const zone = e.sea_zone_id ?? str("sea_zone_id", "zone_id") ?? (port ? (this.world.port(port)?.sea_zone_id ?? null) : null);
        const inPort = p.at_sea === true ? false : p.at_sea === false || p.in_port === true || str("location", "where") === "port" || !!port;
        const pool = num("prize_pool_pence") ?? (() => {
          const value = num("seized_value_pence") ?? num("base_value_pence") ?? num("value_pence");
          if (value !== undefined) return value / 2;
          const hull = num("hull_value_pence") ?? num("ship_value_pence");
          const cls = str("ship_class", "ship_class_id", "class_id");
          const ship = hull ?? (cls && this.world.shipClass(cls) ? this.hullValue(cls) : undefined);
          return ship !== undefined ? (ship + (num("cargo_value_pence") ?? 0)) / 2 : undefined;
        })();
        this.world.noteSeizure({ id: e.id, at, zone, inPort, pool: pool !== undefined && pool > 0 ? pool : null });
        // Never counted as ours from this public notice (ship names aren't unique across companies): our own seizure comes as
        // ship_seized (by ship_id), or shows when she leaves the fleet (checkLostSmuggler). A ship of ours by that name carrying
        // contraband: the fleet is read again at once.
        const named = str("ship_name", "name");
        if (named && [...this.agents.values()].some((a) => !a.gone && a.name === named && this.carriesContraband(a))) this.lastScan = 0;
        // Our patrol in force there: prize money follows (patrol_prize_paid).
        const ours = zone && !inPort ? this.ownNaval?.patrols.find((x) => x.sea_zone_id === zone && Date.parse(x.expires_at) > at) : undefined;
        if (ours) this.log("fleet", `a smuggler${str("ship_name", "name") ? ` (${str("ship_name", "name")})` : ""} was seized at sea in ${zone}, where our patrol is in force: prize money should follow`);
        break;
      }
      case "ship_seized": {
        // Ours (guide 3.18): forfeit for smuggling, with everything aboard; the conviction goes on our public credit record.
        const at = Date.parse(e.timestamp) || this.world.now();
        // Sent to us alone: a ship of ours by its id (by name only within our own fleet, should the id be missing).
        const named = str("ship_name", "name");
        const byName = named ? [...this.agents.values()].filter((a) => a.name === named) : [];
        const seized = (() => {
          const sid = str("ship_id");
          if (sid) return this.agents.get(sid);
          return byName.length === 1 ? byName[0] : undefined;
        })();
        const sid = str("ship_id") ?? seized?.shipId ?? null;
        const port = e.port_id ?? str("port_id") ?? null;
        const zone = e.sea_zone_id ?? str("sea_zone_id") ?? null;
        const told = p.at_sea === true ? false : p.at_sea === false || p.in_port === true || !!port ? true : null;
        const inPort = told ?? this.lastWhere(seized);
        this.noteSeized(seized, sid, named ?? seized?.name ?? "a ship of ours", port ?? zone, inPort, at);
        break;
      }
      case "underworld_run_completed":
      case "underworld_run_cancelled": {
        // Ours (guide 3.18): a run ashore paid (into the port's region) or was cancelled by a departure (the goods stay aboard).
        // The mode's own runs count in its record; one started by hand (the Underworld page) is booked and logged only.
        const rid = str("run_id", "id");
        const sid = str("ship_id") ?? (rid ? [...this.smugglers].find(([, x]) => x.run?.id === rid)?.[0] : undefined);
        const ship = sid ? this.agents.get(sid) : undefined;
        const role = sid ? this.smugglers.get(sid) : undefined;
        const run = role?.run ?? null;
        const port = e.port_id ?? str("port_id") ?? run?.port ?? null;
        const good = str("commodity_id") ?? run?.good ?? "contraband";
        if (e.event_type === "underworld_run_completed") {
          const sold = num("sold_tons") ?? num("quantity") ?? 0;
          const proceeds = num("proceeds_pence") ?? 0;
          if (proceeds > 0 && port) {
            const region = this.world.region(port);
            this.world.vaults.set(region, this.world.vault(region) + proceeds);
            this.cashArrived();
          }
          if (run) {
            this.smuggleStats.landedTons += sold;
            this.smuggleStats.proceedsPence += proceeds;
            const rec = ship ? this.runRec(ship) : undefined;
            if (rec) {
              rec.proceedsPence = (rec.proceedsPence ?? 0) + proceeds;
              rec.outcome = sold > 0 ? "landed" : "nothing landed";
            }
            const hours = (Math.max(run.startedAt, Math.min(Date.parse(e.timestamp) || this.world.now(), run.completesAt + RUN_GRACE_MS)) - run.startedAt) / this.gameHourMs;
            if (hours > 0) this.smuggleModel.runHours = [...this.smuggleModel.runHours, hours].slice(-20);
          }
          this.smuggleNote(ship?.name ?? "smuggling", `ran ${sold} t ${good} ashore${port ? ` at ${port}` : ""} for ${cr(proceeds)}${sold > 0 ? ` (${cr(Math.round(proceeds / sold))}/t)` : ""}${run ? "" : " (a run started by hand)"}`);
        } else {
          const rec = run && ship ? this.runRec(ship) : undefined;
          if (rec && rec.proceedsPence === null) rec.outcome = "cancelled";
          this.smuggleNote(ship?.name ?? "smuggling", `the run ashore${port ? ` at ${port}` : ""} was cancelled (she departed first): the ${good} stays aboard`);
        }
        if (role) role.run = null;
        this.persist(true);
        ship?.nudge();
        break;
      }
      case "underworld_order_filled": {
        // Both parties to a cove fill (guide 3.18): a resting order of ours (placed by hand; the autopilot's are IOC) traded.
        const sid = str("ship_id", "buyer_ship_id", "seller_ship_id");
        const ship = sid ? this.agents.get(sid) : undefined;
        const tons = num("filled_quantity") ?? num("quantity");
        this.log(ship?.name ?? "fleet", `an underworld order filled at ${e.port_id ?? str("port_id") ?? "a cove"}${tons ? `: ${tons} t ${str("commodity_id") ?? ""}` : ""}`);
        void this.world.refreshVaults().then(() => this.cashArrived(), () => undefined);
        ship?.nudge();
        break;
      }
      case "patrol_prize_paid": {
        // Ours (guide 3.5): a smuggler seized at sea in a zone while our patrol was in force pays us our share, by bps, of half
        // her base value and everything aboard, less the Admiral's tenth, into the vault of the region the patrol was paid from.
        const amount = num("prize_pence") ?? num("amount_pence") ?? num("payout_pence");
        const tenth = num("admirals_tenth_pence");
        const pid = str("patrol_id", "id");
        const mine = pid ? this.ownNaval?.patrols.find((x) => x.id === pid) : undefined;
        const zone = e.sea_zone_id ?? str("sea_zone_id") ?? mine?.sea_zone_id ?? null;
        const named = str("banking_region");
        const region = (named && this.world.vaults.has(named as BankingRegion) ? (named as BankingRegion) : null) ?? mine?.banking_region ?? null;
        if (amount !== undefined && amount > 0) {
          if (region) this.world.vaults.set(region, this.world.vault(region) + amount);
          // Where it landed isn't known: the vaults are read again.
          else void this.world.refreshVaults().catch(() => undefined);
          if (mine) mine.prize_earned_pence = (mine.prize_earned_pence ?? 0) + amount;
          this.cashArrived();
        }
        // What the seizure's pool was, from our share of it (our bps over every patrol's in the zone, as last read): the model's
        // lesson on what a seized smuggler is worth.
        const total = zone ? (this.zoneStatus?.zones.find((z) => z.sea_zone_id === zone)?.patrol_suppression_bps ?? this.world.patrolBps.get(zone)) : undefined;
        if (amount && mine && total && total >= mine.suppressed_piracy_bps) {
          const gross = tenth !== undefined ? amount + tenth : amount / (1 - ADMIRALS_TENTH);
          this.world.notePrizePool((gross * total) / mine.suppressed_piracy_bps);
        }
        this.log(
          "fleet",
          `patrol prize money${zone ? ` in ${zone}` : ""}: ${amount !== undefined ? cr(amount) : "paid"}${tenth ? ` (after the Admiral's tenth of ${cr(tenth)})` : ""}${region ? ` into the ${region} vault` : ""}: a smuggler was seized there while our patrol was in force`,
        );
        this.persist();
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
    const voyages = new Map<string, Array<[number, number, RoutePlan["legs"]]>>();
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
      list.push([at, at + w.sailMs(plan.total_distance_nm, speed / 100) * 1.5 + 60 * w.gameMinuteMs, plan.legs]);
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
        const voyage = cls && s && t != null ? voyages.get(id)?.find(([a, b]) => t >= a && t <= b) : undefined;
        if (cls && s && t != null && voyage) {
          // The crossing into the storm's zone (its exposure counted the rougher water too).
          const z = s.zone ? w.hazardZone(s.zone)?.id : undefined;
          const edge = z ? (voyage[2].find((l) => w.hazardZone(l.to_node)?.id === z)?.edge_class ?? null) : null;
          storms.push(() => w.noteStorm(s.zone, w.shipClass(cls)?.hull_category ?? "coastal", t, s.share, s.sunk, edge, s.stores));
        } else if (s) unmatched++;
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
    // Our Crown and Admiralty charter earnings over the last 10 game days, for the premium taper (read once).
    const earned = w.charterEarnings(now);
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
      // The re-post takes no more than its own tons, held loads included (never loads a camp plans away).
      const intoRepost = Math.min(repostTons, tonsAfter + holdable);
      // The extra pay is premium over the goods' value: tapered by our charter earnings like any Admiralty pay (guide 3.7),
      // the re-post's own delivery counted in.
      const uplift = Math.round(w.charterPayValue(x, x.rate * w.escalation.pay, intoRepost, earned) - w.charterPayValue(x, x.rate, intoRepost, earned));
      const value = Math.round(p * uplift * intoRepost);
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
      // Loaded tons the smaller re-post can't take are sold off instead of paid this posting's rate (tapered).
      const spill = Math.max(0, Math.min(loadedBefore, x.remaining) - repostTons);
      const paid = w.charterPayValue(x, x.rate, Math.max(1, Math.min(loadedBefore, x.remaining)), earned);
      const salvage = Math.min(paid, w.price(x.port, x.good)?.bid ?? w.basePrice(x.good));
      const cost = Math.round(holdCost + p * spill * (paid - salvage) + (flow * hoursLeft + shut) * DEFER_LOSS_SHARE * Math.max(0, perTon));
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
    // A smuggler does no lawful work (guide 3.18: her seizure must cost nothing but her); nor a ship being sold or broken up
    // (housekeeping: listed she must lie where she is, and bound for the breakers she must arrive empty), or gone that way.
    if (this.smugglers.has(agent.shipId) || this.retiring.has(agent.shipId) || this.retiredIds.has(agent.shipId)) return null;
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
    // The voyage it was for may not be made now: no passengers board for it (posted again when she sails, guide 3.20).
    agent.dropOffers("her lane was given up");
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
    // A smuggler, or a ship with contraband aboard, sails alone (guide 3.18: only she is searched, but a convoy would carry our
    // lawful ships through her water and timetable, and her seizure must cost nothing more than her).
    if (this.smugglers.has(agent.shipId) || agent.contrabandAboard(r).length > 0) return alone;
    // Bound for the breakers (housekeeping): a convoy would keep her from changing hands where she arrives (guide 3.4).
    if (this.retiring.has(agent.shipId)) return alone;
    const now = w.now();
    const speed = (cls: string) => (w.shipClass(cls)?.base_speed_centiknots ?? 800) / 100;
    const ourSpeed = speed(agent.shipClass);
    const alike = (cls: string) => Math.min(speed(cls), ourSpeed) / Math.max(speed(cls), ourSpeed) >= CONVOY_MIN_SPEED_RATIO;
    // Passengers' fares aboard (guide 3.20) are lost unpaid with the ship (never insured), and draw pirates as the ransom makes her a richer prize.
    // Return freight's stake (its reward and collateral, guide 3.8) goes with her too, but draws no pirate: lost on a capture only.
    const exposure = (cls: string, guns: number, cargo: number, fares = 0, stake = 0) => {
      const risk = w.piracyRisk(plan, guns, speed(cls) * 0.8, cargo + fares);
      return risk.cargoShare * cargo + risk.capture * (this.hullValue(cls) + guns * GUN_PRICE_PENCE + fares + stake);
    };
    // Each hold at base prices, return freight left out (guide 3.8: worth nothing aboard, no raid or storm touches it); the member's own
    // agent knows which of its sealed tons those are.
    const cargoOf = (x: ShipResult) => {
      const owner = this.agents.get(x.ship.id);
      return owner ? owner.lootValue(x, (g) => w.basePrice(g)) : Object.entries(x.cargo_manifest).reduce((n, [g, t]) => n + t * w.basePrice(g), 0);
    };
    const ours = exposure(agent.shipClass, r.ship.cannons_count, cargoOf(r), agent.faresAboard(), agent.returnStake());
    // Each ship still rolls its own storms (guide 3.7), longer at sea at the convoy's slower pace: what a passage's
    // storms are expected to cost a ship (its cargo's share, and its hull, fares and return freight's stake if it sinks), at the
    // user's storm weight.
    const stormWeight = this.settings.stormWeightPct / 100;
    const storms = (cls: string, guns: number, cargo: number, knots: number, sailsAt: number, fares = 0, stake = 0) => {
      const s = w.stormRisk(plan, w.shipClass(cls)?.hull_category ?? "coastal", knots * 0.8, sailsAt, stormWeight);
      return s.cargoShare * cargo + s.sink * (this.hullValue(cls) + guns * GUN_PRICE_PENCE + fares + stake);
    };
    // A convoy's extra storm loss for one ship over how it would sail otherwise; never counted as a gain.
    const slower = (cls: string, guns: number, cargo: number, convoy: { knots: number; at: number }, otherwise: { knots: number; at: number }, fares = 0, stake = 0) =>
      Math.max(0, storms(cls, guns, cargo, convoy.knots, convoy.at, fares, stake) - storms(cls, guns, cargo, otherwise.knots, otherwise.at, fares, stake));
    const waitCost = (ms: number) => (agent.rate * Math.max(0, ms)) / 3_600_000;
    const baseLock = 30 * w.gameMinuteMs;
    // Can this ship sail in a convoy leaving at `departsAt` at `slowest` knots? (The stores as convoyWait judges them.)
    // Charters and sealed freight only (pay nothing late, or forfeit): the passengers' promise is weighed as paxLate below.
    const fits = (departsAt: number, slowest: number) => {
      if (r.stores.provisions_tons < this.convoyStores(agent, plan, departsAt, slowest).need) return false;
      const due = agent.deliverDeadline(false);
      const arrive = departsAt + w.sailMs(plan.total_distance_nm, slowest * 0.8) + baseLock;
      // Charters and freight pay nothing after the season ends (guide 3.11): the muster and the slower pace mustn't push it past.
      if (!w.beforeSeasonEnd(arrive)) return false;
      return due === null || arrive <= due;
    };
    // The fares a later landing cuts (guide 3.20.6: per game day past the promise, down to a floor) against sailing alone now.
    const aloneAt = now + w.sailMs(plan.total_distance_nm, ourSpeed * 0.8) + baseLock;
    const paxLate = (departsAt: number, slowest: number) =>
      agent.paxLateCost(dest, departsAt + w.sailMs(plan.total_distance_nm, slowest * 0.8) + baseLock, aloneAt);

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
      const pick = live
        .filter(({ c }) => c.members.every((m) => alike(m.ship_class) && !this.smugglers.has(m.ship_id) && !this.carriesContraband(this.agents.get(m.ship_id))))
        .sort((a, b) => a.departsAt - b.departsAt)[0];
      if (!pick) return alone;
      const n = Math.max(1, pick.c.members.length);
      // The members are ours: their cargo is known.
      const members = pick.c.members.reduce((sum, m) => {
        const a = this.agents.get(m.ship_id);
        return sum + (a?.last ? exposure(m.ship_class, m.cannons_count, cargoOf(a.last), a.faresAboard(), a.returnStake()) : 0);
      }, 0);
      const pace = Math.min(...pick.c.members.map((m) => speed(m.ship_class)));
      const slowest = Math.min(ourSpeed, pace);
      // All members' losses before (ours alone, theirs shared n ways) against after (n + 1 ways), less the storms
      // of the slower passage: ours (later and slower than alone now), and the members' when we slow them.
      const convoy = { knots: slowest, at: pick.departsAt };
      let stormCost = slower(agent.shipClass, r.ship.cannons_count, cargoOf(r), convoy, { knots: ourSpeed, at: now }, agent.faresAboard(), agent.returnStake());
      if (slowest < pace) {
        for (const m of pick.c.members) {
          const a = this.agents.get(m.ship_id);
          if (a?.last) stormCost += slower(m.ship_class, m.cannons_count, cargoOf(a.last), convoy, { knots: pace, at: pick.departsAt }, a.faresAboard(), a.returnStake());
        }
      }
      const gain = ours + members / n - (ours + members) / (n + 1) - stormCost - paxLate(pick.departsAt, slowest);
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
    const partners: Array<{ ready: number; exposure: number; speed: number; cls: string; guns: number; value: number; stake: number }> = [];
    for (const a of this.agents.values()) {
      const pr = a.last;
      const lane = a.lane;
      if (a === agent || a.gone || !pr || !lane || lane.source !== from || lane.dest !== dest || pr.ship.convoy_id || !alike(a.shipClass)) continue;
      if (this.smugglers.has(a.shipId) || a.contrabandAboard(pr).length > 0) continue;
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
      // Her lane's return freight (what rides this passage; lots aboard now may be for here).
      const stake = lane.freight.reduce((n, f) => n + returnLotStake(f), 0);
      const e = exposure(a.shipClass, pr.ship.cannons_count, value, a.faresAboard(), stake);
      // A partner with little at risk may not join on its own account: don't wait for it.
      if (e < CONVOY_MIN_EXPOSURE_PENCE / 2) continue;
      partners.push({ ready, exposure: e, speed: speed(a.shipClass), cls: a.shipClass, guns: pr.ship.cannons_count, value, stake });
    }
    if (partners.length === 0) return alone;
    const k = partners.length;
    const waitMs = Math.max(CONVOY_MIN_MUSTER_GAME_MIN * w.gameMinuteMs, Math.max(...partners.map((p) => p.ready)) - now + baseLock);
    const slowest = Math.min(ourSpeed, ...partners.map((p) => p.speed));
    // Less the storms of the slower, later passage: ours against alone now, each partner's against alone when ready.
    const convoy = { knots: slowest, at: now + waitMs };
    const stormCost =
      slower(agent.shipClass, r.ship.cannons_count, cargoOf(r), convoy, { knots: ourSpeed, at: now }, agent.faresAboard(), agent.returnStake()) +
      partners.reduce((n, p) => n + slower(p.cls, p.guns, p.value, convoy, { knots: p.speed, at: p.ready }, 0, p.stake), 0);
    const gain = ((ours + partners.reduce((n, p) => n + p.exposure, 0)) * k) / (k + 1) - stormCost - paxLate(now + waitMs, slowest);
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

  /**
   * Daily fleet upkeep (pence per game day), optionally with an extra hull: sprawl on coastal and regional tons plus half
   * the oceanic tons, a flat 1 Cr per oceanic ton, and the factors (guide 3.12).
   */
  private upkeepPerDay(extra?: { tons: number; oceanic: boolean }): number {
    const w = this.world;
    const bill = (lower: number, oceanic: number) => w.hullUpkeepPerDay(lower, oceanic) + w.factorUpkeepPerDay(this.factorCount);
    const now = bill(this.fleetTons(false), this.fleetTons(true));
    const withExtra = bill(this.fleetTons(false) + (extra && !extra.oceanic ? extra.tons : 0), this.fleetTons(true) + (extra?.oceanic ? extra.tons : 0));
    // The formula, or what the last billing passes charged if more, plus the extra hull.
    return Math.max(withExtra, this.bills.upkeep + withExtra - now);
  }

  /**
   * Home's floor: the reserve, or 1.5 game days of the bills home pays. The wealth levy (guide 3.12) is taken from cash
   * (the richest vault first, home as likely as any) every game day like upkeep, so a day and a half of it is kept too.
   */
  private homeFloor(extra?: { tons: number; oceanic: boolean }): number {
    return Math.max(this.settings.reservePence, Math.ceil(UPKEEP_DAYS_RESERVED * (this.upkeepPerDay(extra) + this.levyPerDay())));
  }

  private floorIn(region: BankingRegion): number {
    // Each region also keeps its own warehouses' rent (billed from the port's region).
    const rent = Math.ceil(UPKEEP_DAYS_RESERVED * (this.bills.rent.get(region) ?? 0));
    return (region === this.homeRegion ? this.homeFloor() : REGION_FLOOR_PENCE) + rent;
  }

  /**
   * What the daily bills really charge (guide 3.12: warehouse rent per port from its region, sprawl and
   * factors from home, the wealth levy from cash), learned from the ledger since the rates aren't published. A billing pass is a
   * cluster of bill debits from our vaults; per region (upkeep and levy: all regions, a short home is swept, the levy
   * takes the richest first) the larger of the last two passes counts. The reason strings aren't published either: those seen are
   * logged once, so the patterns can be checked. Nothing measured: the formula alone, as before.
   */
  private async learnBills(): Promise<void> {
    const w = this.world;
    // The user may have changed them on the company page since (auto-remit, or the home port: upkeep is billed there).
    await this.checkAutoRemit();
    const profile = await this.client.companyProfile().catch((e) => {
      if (this.isFatal(e)) throw e;
      return null;
    });
    if (profile) this.setHome(profile.company.home_port_id);
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

    const bills: Array<{ at: number; region: BankingRegion; pence: number; kind: "rent" | "upkeep" | "levy" }> = [];
    const reasons = new Map<string, string>();
    for (const e of entries) {
      const at = Date.parse(e.created_at);
      // Out of one of our vaults to someone else (the debit side, as the treasury page reads it).
      const region = w.vaultAccounts.get(e.debit_account_id);
      if (!region || w.vaultAccounts.has(e.credit_account_id) || !(at >= since)) continue;
      // The levy first: `crown_wealth_levy` is neither rent nor upkeep, and no one-off.
      const kind = LEVY_REASON.test(e.reason)
        ? "levy"
        : ONE_OFF_REASON.test(e.reason)
          ? null
          : RENT_REASON.test(e.reason)
            ? "rent"
            : UPKEEP_REASON.test(e.reason)
              ? "upkeep"
              : null;
      if (!reasons.has(e.reason)) reasons.set(e.reason, kind ?? "-");
      if (kind && e.amount_pence > 0) bills.push({ at, region, pence: e.amount_pence, kind });
    }
    if (!this.billReasonsLogged && reasons.size > 0) {
      this.billReasonsLogged = true;
      this.log("fleet", `ledger reasons seen (taken as a daily bill: rent/upkeep/levy): ${[...reasons].map(([r, k]) => `${r}${k === "-" ? "" : ` (${k})`}`).join(", ")}`);
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
    const levy = lastTwo((b) => b.kind === "levy");
    // Not back a whole game day (a busy ledger): what this read found, the rest as measured before.
    if (!covered) {
      for (const [r, p] of this.bills.rent) if (!rent.has(r)) rent.set(r, p);
    }
    const prev = this.bills;
    this.bills = { rent, upkeep: covered || upkeep > 0 ? upkeep : prev.upkeep, levy: covered || levy > 0 ? levy : prev.levy, at: now };
    const total = (b: typeof prev) => b.upkeep + b.levy + [...b.rent.values()].reduce((n, p) => n + p, 0);
    if (prev.at === null || Math.abs(total(this.bills) - total(prev)) >= Math.max(1_000, 0.1 * total(prev))) {
      const rents = [...rent].filter(([, p]) => p > 0).map(([r, p]) => `${r} ${cr(p)}`);
      this.log(
        "fleet",
        `daily bills from the ledger: upkeep ${cr(this.bills.upkeep)}${rents.length ? `, rent ${rents.join(", ")}` : ", no rent"}` +
          `${this.bills.levy > 0 ? `, wealth levy ${cr(this.bills.levy)}` : ""}; home keeps ${cr(this.homeRegion ? this.floorIn(this.homeRegion) : this.homeFloor())}`);
    }
    this.persist();
  }

  /**
   * Auto-remit (guide 3.9) tops a bill its region can't cover up from our other regions, never below its reserve and
   * all-or-nothing. Only read and reported, never changed: a reserve at the floor ensureCash drains donors to would
   * leave a covered bill unpaid (the bailiff seizes ships for unpaid upkeep). Home is kept at its floor from the
   * others instead (keepHomeFloor). Said when it changes; only a fatal error comes out.
   */
  /** The home port (guide 3.12: upkeep, marques, patrols and R&D are paid from its region), set at start and after a move. */
  private setHome(port: string): void {
    const region = this.world.region(port);
    if (port === this.homePort && region === this.homeRegion) return;
    const was = this.homePort;
    const wasRegion = this.homeRegion;
    this.homePort = port;
    this.homeRegion = region;
    if (was !== null && was !== port) {
      this.log("fleet", `home port moved from ${was} to ${port} (${this.homeRegion}): upkeep, marques and patrols are paid there from now on, and its floor is kept there`);
      // Fees that funded the old home are no case for the new one (reviewHome tracks afresh), and our gap between moves counts
      // from this one, ours or one by hand.
      if (wasRegion !== region) {
        this.homeFees = [];
        this.feesSince = this.world.now();
      }
      if (Date.now() - this.movedAt > 60_000) this.movedAt = Date.now();
      this.persist();
    }
  }

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
      // Its fees are what a home where the cash doesn't land costs (reviewHome).
      await this.ensureCash(home, 0, { homeFee: true });
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
   * were just read. `essential` (stores to sail safely): when still short, it may dip into the floor. `homeFee`: home's floor
   * top-up, whose remit fees are tracked per donor (reviewHome).
   */
  async ensureCash(region: BankingRegion, amount: number, opts: { fresh?: boolean; essential?: boolean; homeFee?: boolean } = {}): Promise<number> {
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
          // Carried by a bank as a draft (guide 3.12: its posted fee, less any client discount, strictly under the Crown's, and the cash
          // there to pay): the fee and the net as charged; what it saved against the Crown's fee is booked.
          const draft = res.carried_by === "bank";
          const saved = draft && Number.isFinite(res.crown_fee_pence) ? Math.max(0, res.crown_fee_pence! - res.fee_pence) : 0;
          if (draft) this.noteDraft(saved, res.tx_group_id);
          this.log(
            "fleet",
            `moved ${cr(res.net_credited_pence)} ${d.r} → ${region} (fee ${cr(res.fee_pence)}` +
              `${draft ? `; carried as a bank draft by ${res.bank_name ?? "a bank"}, ${cr(saved)} under the Crown's ${cr(res.crown_fee_pence ?? res.fee_pence)}` : ""})`,
          );
          if (opts.homeFee && region === this.homeRegion) this.noteHomeFee(d.r, res.fee_pence, "floor");
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
   * Net worth above the Crown's wealth-levy threshold (pence; guide 3.12): the leaderboard's figure for this company while
   * fresh, else our own estimate (refreshWorth, every finance pass); 0 while neither is known.
   */
  levyExcess(): number {
    return Math.max(0, (this.worth?.pence ?? 0) - WEALTH_LEVY_THRESHOLD_PENCE);
  }

  /**
   * The wealth levy a game day (pence): 0.1% of the excess, or what the ledger showed charged if more (our estimate of
   * net worth runs low), at most the cash we hold (it is taken from cash only).
   */
  levyPerDay(): number {
    const levy = Math.max(Math.round((this.levyExcess() * WEALTH_LEVY_BPS_PER_DAY) / 10_000), this.bills.levy);
    return Math.min(levy, Math.max(0, this.world.totalCash()));
  }

  // ── Housekeeping: dead weight and the home port (housekeeping.ts) ─────────

  /** Real ms in a game day. */
  private get gameDayMs(): number {
    return 24 * this.gameHourMs;
  }

  /** What housekeeping is doing with this ship (null: nothing): no passengers are offered to her meanwhile, and the panel says. */
  retireStage(agent: ShipAgent): RetireMark["stage"] | null {
    return this.retiring.get(agent.shipId)?.stage ?? null;
  }

  /** Why no ship is retired now (null: they may be): the switch, the key's scope (break-ups and listings need infra_manage), the season. */
  private retireBlocked(): string | null {
    if (!this.settings.autoBreakUp) return "breaking up dead weight is off";
    if (!this.canBuild) return "the key lacks infra_manage (a break-up or a listing needs it)";
    if (this.world.seasonMode() !== "normal") return "the season's endgame: nothing is broken up (the final standings count a hull at its build value)";
    return null;
  }

  /** Real hours the upkeep saved and the earnings given up are weighed over: to the season's end, at most HORIZON_MAX_MS. */
  private retireHorizonHours(): number {
    return Math.max(0, Math.min(this.world.seasonLeftMs(), HORIZON_MAX_MS)) / 3_600_000;
  }

  /** What the fleet would pay less a real hour without her (guide 3.12): the sprawl on her tons, an oceanic hull's flat 1 Cr/t too. */
  private upkeepShare(a: ShipAgent): number {
    const cls = this.world.shipClass(a.shipClass);
    if (!cls) return 0;
    const oceanic = cls.hull_category === "oceanic";
    const tons = cls.hold_capacity_tons;
    const lower = Math.max(0, this.fleetTons(false) - (oceanic ? 0 : tons));
    const ocean = Math.max(0, this.fleetTons(true) - (oceanic ? tons : 0));
    return Math.max(0, this.world.upkeepDeltaPerHour({ lower, oceanic: ocean }, tons, oceanic));
  }

  /** Her rebuild value as we reckon it (guide 3.4): her class at the yards' full price (hullValue) and 150 Cr a gun. */
  private rebuildOf(a: ShipAgent, r: ShipResult): number {
    return this.hullValue(a.shipClass) + r.ship.cannons_count * GUN_PRICE_PENCE;
  }

  private crownRefusedNow(region: BankingRegion): boolean {
    return (this.crownRefused.get(region) ?? 0) > this.world.now();
  }

  /** Logs a housekeeping verdict for `key` only when its `code` changed (a refusal repeated every pass is said once). */
  private retireSay(key: string, code: string, source: string, msg: string): void {
    if (this.retireSaid.get(key) === code) return;
    this.retireSaid.delete(key);
    this.retireSaid.set(key, code);
    if (this.retireSaid.size > 200) this.retireSaid.delete(this.retireSaid.keys().next().value!);
    this.log(source, msg);
  }

  /**
   * Dead weight (guide 3.4; housekeeping.ts), every bills pass: each ship judged, a run of checks before anything is done. The ship
   * whose run matured and whose break-up case passes best, her class quoted by a yard (never the hold guess) and a yard in reach,
   * is marked; her own turn in port does the rest (retireTurn). One at a time; refusals said once per change.
   */
  private async reviewDeadWeight(): Promise<void> {
    const w = this.world;
    const s = this.settings;
    const now = w.now();
    for (const [id, until] of this.retireSkip) if (until <= Date.now()) this.retireSkip.delete(id);
    for (const [region, until] of this.crownRefused) if (until <= now) this.crownRefused.delete(region);
    // A mark whose ship is no longer ours nor waiting to be taken command of (she left while we were down): a break-up whose
    // answer was lost went through; any other mark just goes (it would hold up the next, one at a time).
    for (const [id, m] of [...this.retiring]) if (!this.agents.has(id) && !this.restoredAgents.has(id)) this.settleRetired(id, m.stage === "verify" ? "broken_up" : null, {});
    const blocked = this.retireBlocked();
    if (blocked) {
      // A mark is withdrawn at her own turn (a listing cancelled there); the runs start again when it is back.
      this.deadStreaks.clear();
      this.deadSeen = [];
      this.retireAction = blocked;
      return;
    }
    const ships = [...this.agents.values()].filter((a) => !a.gone);
    const gameDay = this.gameDayMs;
    const horizon = this.retireHorizonHours();
    // A full fleet whose buyer may build: an out-of-date ship's slot is worth a paying new hull (worked out once a pass, only when
    // there is such a ship).
    const slotOpen = ships.length >= s.maxShips && s.autoBuy && this.canBuild;
    let slot: SlotOption | null | undefined;
    const perDay = (perHour: number) => Math.round((perHour * gameDay) / 3_600_000);
    const rows: HousekeepingReport["breakUp"]["candidates"] = [];
    const ripe: Array<{ a: ShipAgent; r: ShipResult; streak: Streak; why: string; upkeep: number; earn: number; repl: number | undefined; c: BreakUpCase }> = [];
    for (const a of ships) {
      const r = a.last;
      const cls = w.shipClass(a.shipClass);
      if (!r || !cls) continue;
      const courier = cls.can_seal_dispatches || cls.id === "packet";
      const never = neverRetire({ ships: ships.length, courier, smuggler: this.smugglers.has(a.shipId), arrested: a.arrested, aiOrder: !!this.advisor.shipOrder(a.shipId), components: r.components?.length ?? 0 });
      if (never || this.retiring.has(a.shipId) || this.retireSkip.has(a.shipId) || this.retiredIds.has(a.shipId)) {
        this.deadStreaks.delete(a.shipId);
        continue;
      }
      const mz = await this.retireMeasure(a, r, cls, slotOpen);
      // Not planned (a read failed): no judgement this pass, her run kept as it stands.
      if (!mz) continue;
      const { port, idle, upkeep, trail, best, obsolete, earn } = mz;
      if (obsolete && slot === undefined) {
        slot = await this.slotOption().catch((e: unknown) => {
          if (this.isFatal(e) || isApiError(e, "world_paused")) throw e;
          return null;
        });
      }
      const v = deadWeight({ idle, upkeepPerHour: upkeep, trailingPerHour: trail, bestLanePerHour: best, obsolete, slot: obsolete ? (slot ?? null) : null });
      const streak = nextStreak(this.deadStreaks.get(a.shipId), v, now);
      if (!streak) {
        // Her run ended: a verdict is said again should another run mature.
        this.deadStreaks.delete(a.shipId);
        this.retireSaid.delete(a.shipId);
        continue;
      }
      this.deadStreaks.set(a.shipId, streak);
      const days = Math.round(((now - streak.since) / gameDay) * 10) / 10;
      const why = streak.reason === "idle" ? `${streak.why} for ${days} game day${days === 1 ? "" : "s"}` : streak.why;
      const repl = streak.reason === "obsolete" ? slot?.perHour : undefined;
      const rebuild = this.rebuildOf(a, r);
      const c = breakUpCase({ rebuild, upkeepPerHour: upkeep, earnPerHour: earn, horizonHours: horizon, replacementPerHour: repl });
      const isRipe = matured(streak, now, gameDay);
      rows.push({
        shipId: a.shipId,
        ship: a.name,
        cls: cls.id,
        port,
        reason: streak.reason,
        why,
        since: new Date(streak.since).toISOString(),
        checks: streak.checks,
        matured: isRipe,
        rebuildPence: rebuild,
        payoutPence: c.payout,
        upkeepPerDayPence: perDay(upkeep),
        earnPerDayPence: perDay(earn),
        horizonHours: Math.round(horizon),
        gainPence: c.gain,
        worthLossPence: c.worthLoss,
        worthGainPence: c.worthGain,
        verdict: !isRipe ? `watching: ${streak.checks} of ${DEAD_STREAK_CHECKS} checks over ${days} of ${DEAD_STREAK_GAME_DAYS} game days` : c.ok ? "a break-up pays" : c.why,
      });
      if (isRipe) ripe.push({ a, r, streak, why, upkeep, earn, repl, c });
    }
    this.deadSeen = rows;
    for (const x of ripe) if (!x.c.ok) this.retireSay(x.a.shipId, `case:${x.c.gain <= 0 ? "earns" : "worth"}`, x.a.name, `dead weight (${x.why}), but not broken up: ${x.c.why}`);
    if (this.retiring.size > 0) {
      this.retireAction = `retiring ${[...this.retiring.keys()].map((id) => this.agents.get(id)?.name ?? id).join(", ")} (one at a time)`;
      return;
    }
    const pick = ripe.filter((x) => x.c.ok).sort((x, y) => y.c.worthGain - x.c.worthGain)[0];
    if (!pick) {
      this.retireAction = ripe.length ? `${ripe.length} ship${ripe.length === 1 ? "" : "s"} judged dead weight; no break-up pays` : rows.length ? `watching ${rows.length} ship${rows.length === 1 ? "" : "s"}` : "no dead weight";
      return;
    }
    const { a, r, streak, why } = pick;
    let c = pick.c;
    // Her rebuild value from a yard's quote of her class (never the hold guess): asked of a yard of ours at most hourly.
    if (!this.knownQuotes(a.shipClass).has(a.shipClass)) {
      if (!(await this.quoteClass(a.shipClass, r.ship.status !== "sailing" ? (r.ship.current_port_id ?? null) : null))) {
        this.retireAction = `${a.name} is dead weight, but no yard of ours could quote a ${a.shipClass} (her rebuild value)`;
        this.retireSay(a.shipId, "rebuild", a.name, `dead weight (${why}), but not broken up yet: no yard of ours could quote a ${a.shipClass}, so her rebuild value isn't known`);
        return;
      }
      c = breakUpCase({ rebuild: this.rebuildOf(a, r), upkeepPerHour: pick.upkeep, earnPerHour: pick.earn, horizonHours: horizon, replacementPerHour: pick.repl });
      if (!c.ok) {
        this.retireAction = `${a.name}: ${c.why}`;
        this.retireSay(a.shipId, `case:${c.gain <= 0 ? "earns" : "worth"}`, a.name, `dead weight (${why}), but not broken up: ${c.why}`);
        return;
      }
    }
    const rebuild = this.rebuildOf(a, r);
    const yard = await this.breakUpYard(a, r, c.payout);
    if (typeof yard === "string") {
      this.retireAction = `${a.name} is dead weight, but ${yard}`;
      this.retireSay(a.shipId, `yard:${yard}`, a.name, `dead weight (${why}), but not broken up: ${yard}`);
      return;
    }
    this.retiring.set(a.shipId, { stage: "wanted", reason: streak.reason, why, yard: yard.yard, ship: a.name, cls: a.shipClass, rebuild, payout: c.payout, at: now });
    this.deadStreaks.delete(a.shipId);
    this.retireSaid.delete(a.shipId);
    this.retireAction = `retiring ${a.name} (${why})`;
    this.log(
      a.name,
      `dead weight: ${why}. To be listed for sale on the Exchange at ${yard.yard}${yard.nm > 0 ? ` (${Math.round(yard.nm)} nm off, sailing empty)` : ""} ` +
        `(${ladderText()}: a player or the ship broker pays more than the yard), then, unsold, broken up there for ~${cr(c.payout)} (35% of her ~${cr(rebuild)} rebuild value, the worst case), ` +
        `−${cr(c.worthLoss)} of net worth at once: ${c.why}`,
    );
    this.persist(true);
    a.nudge();
  }

  /**
   * What a ship is weighed on for a break-up (reviewDeadWeight, an AI order): where she lies, whether she lies idle there (empty, no
   * convoy, passengers or lane), the upkeep she adds and her trips' rate over the trailing window (per real hour), the best lane from
   * where she lies when idle (cash no object, without the AI's bias or bans: its directives pass, a hull doesn't come back; null:
   * none clears the margin), why her class is out of date with the fleet full (`slotOpen`; null: it isn't), and what she would earn:
   * the most of her trips lately, her last trips' rate with the idle time since, that best lane and her own lane's rate (a lull
   * reads as earnings to come, not none). Null: her lanes couldn't be planned (a read failed).
   */
  private async retireMeasure(
    a: ShipAgent,
    r: ShipResult,
    cls: CatalogShipClass,
    slotOpen: boolean,
  ): Promise<{ port: string | null; idle: boolean; upkeep: number; trail: number; best: number | null; obsolete: string | null; earn: number } | null> {
    const w = this.world;
    const s = this.settings;
    const trailMs = DEAD_TRAIL_GAME_DAYS * this.gameDayMs;
    const upkeep = this.upkeepShare(a);
    const trail = trailingPerHour(a.tripLog, Date.now() - trailMs, trailMs / 3_600_000).perHour;
    const port = r.ship.status !== "sailing" ? (r.ship.current_port_id ?? null) : null;
    const cargo = Object.values(r.cargo_manifest).reduce((n, t) => n + Math.max(0, t), 0);
    const idle =
      !!port &&
      busyNow({ atSea: false, convoy: !!r.ship.convoy_id, cargoTons: Math.max(cargo, r.cargo_used_tons), sealedTons: a.sealedTons(), paxHeads: a.paxHeads(), lane: a.loaded ? "loaded" : a.lane ? "planned" : "none" }) === null;
    let best: number | null = null;
    if (idle && port) {
      const lanes = await rankLanes(w, this.specFor(a, r), port, this.reservations(a), { ...this.planOptions(null), bias: undefined, bans: undefined }).catch((e: unknown) => {
        if (this.isFatal(e) || isApiError(e, "world_paused")) throw e;
        return null;
      });
      if (lanes === null) return null;
      best = lanes.find((l) => !a.isAvoided(l.key))?.profitPerHour ?? null;
    }
    const obsolete = !slotOpen
      ? null
      : !s.buyClasses.includes(cls.id)
        ? `a ${cls.id}, a class the buyer isn't allowed to build`
        : cls.phase <= w.unlockedPhase - OBSOLETE_PHASES_BEHIND
          ? `a phase-${cls.phase} ${cls.id}, ${w.unlockedPhase - cls.phase} phases behind the open one`
          : null;
    const earn = Math.max(0, trail, recentPerHour(a.tripLog, Date.now()), best ?? 0, a.lane?.profitPerHour ?? 0);
    return { port, idle, upkeep, trail, best, obsolete, earn };
  }

  /**
   * The best new hull for a slot (the fleet full): a class the buyer may build, priced at the cheapest turnkey quote we hold for
   * it (a discount yard's too: what we'd pay), its first lane from there planned cash no object, net of the upkeep it adds, paying
   * back within maxPaybackHours (null: none). No quote is asked for: the buyer's own prices.
   */
  private async slotOption(): Promise<SlotOption | null> {
    const w = this.world;
    const s = this.settings;
    let best: SlotOption | null = null;
    for (const c of w.catalog.ship_classes) {
      if (!s.buyClasses.includes(c.id) || c.phase > w.unlockedPhase || c.can_seal_dispatches || c.id === "packet") continue;
      const quotes = [...this.hullQuotes]
        .filter(([k]) => k.endsWith(`|${c.id}`))
        .map(([k, v]) => ({ yard: k.slice(0, k.lastIndexOf("|")), v }))
        .filter((q) => w.isOpen(q.yard) && !w.isCove(q.yard))
        .sort((x, y) => x.v - y.v);
      const q = quotes[0];
      if (!q) continue;
      const guns = s.guns === "full" ? c.max_cannons : 0;
      const lanes = await rankLanes(w, this.specForClass(c.id, guns, FIRST_STORES_GUESS_TONS), q.yard, this.reservations(), { ...this.planOptions(null), bias: undefined, noSpeculativeOnward: true });
      const lane = lanes.find((l) => !l.speculative);
      if (!lane) continue;
      const net = lane.profitPerHour - w.upkeepDeltaPerHour({ lower: this.fleetTons(false), oceanic: this.fleetTons(true) }, c.hold_capacity_tons, c.hull_category === "oceanic");
      if (!(net > 0)) continue;
      const cost = q.v + guns * GUN_PRICE_PENCE;
      const payback = cost / net;
      if (payback > s.maxPaybackHours) continue;
      if (!best || payback < best.payback) best = { cls: c.id, yard: q.yard, perHour: net, payback, cost };
    }
    return best;
  }

  /**
   * A turnkey quote of a class no yard has quoted us lately (its rebuild value, guide 3.4), at a yard where we have presence (where
   * she lies first, then our other ships' yards, then our factors'): at most hourly a class. Whether the class is quoted now.
   */
  private async quoteClass(cls: string, at: string | null): Promise<boolean> {
    if (this.knownQuotes(cls).has(cls)) return true;
    if (Date.now() - (this.quoteTried.get(cls) ?? 0) < 60 * 60_000) return false;
    this.quoteTried.set(cls, Date.now());
    const w = this.world;
    const yards = new Set<string>();
    if (at) yards.add(at);
    for (const a of this.agents.values()) {
      const sh = a.last?.ship;
      if (!a.gone && sh && sh.status !== "sailing" && sh.current_port_id) yards.add(sh.current_port_id);
    }
    for (const p of this.factorPorts) yards.add(p);
    for (const y of yards) {
      if (!w.port(y)?.has_shipyard || !w.isOpen(y) || w.isCove(y)) continue;
      const q = await this.client.shipyardQuote(y, cls).catch((e: unknown) => {
        if (this.isFatal(e) || isApiError(e, "world_paused")) throw e;
        return null;
      });
      if (!q) continue;
      this.noteHullQuote(y, cls, q);
      if (this.knownQuotes(cls).has(cls)) return true;
    }
    return false;
  }

  /**
   * The yard to break her up at: where she lies, if it has an open yard whose Crown hasn't refused lately; else the nearest one over
   * water her hull is rated for and no AI ban, whose passage costs less than the payout (the stores it eats, and the odds of losing
   * her on the way at the payout's worth). A string: why none.
   */
  private async breakUpYard(a: ShipAgent, r: ShipResult, payout: number): Promise<{ yard: string; nm: number; cost: number } | string> {
    const w = this.world;
    // At sea (an out-of-date ship still working her lane): from the port she makes for, where her retiring begins.
    const here = r.ship.status !== "sailing" ? (r.ship.current_port_id ?? null) : (r.route_legs.at(-1)?.to_node ?? null);
    if (!here) return "where she will be isn't known";
    const yards = w.catalog.ports.filter((p) => p.has_shipyard && w.isOpen(p.id) && !w.isCove(p.id) && !this.crownRefusedNow(p.banking_region));
    if (yards.length === 0) return "no open yard whose Crown can pay (every one refused lately)";
    if (yards.some((p) => p.id === here)) return { yard: here, nm: 0, cost: 0 };
    const cls = w.shipClass(a.shipClass);
    const hull = cls?.hull_category ?? "coastal";
    const knots = ((cls?.base_speed_centiknots ?? 800) / 100) * 0.8;
    let best: { yard: string; nm: number; cost: number } | null = null;
    for (const p of yards) {
      const plan = await w.route(here, p.id, a.shipClass).catch((e: unknown) => {
        if (this.isFatal(e) || isApiError(e, "world_paused")) throw e;
        return null;
      });
      if (!plan || !w.routeRated(plan, hull) || this.offLimits(p.id, plan)) continue;
      const lose = Math.min(1, w.stormRisk(plan, hull, knots, w.now()).sink + w.piracyRisk(plan, r.ship.cannons_count, knots, 0).capture);
      const cost = Math.round(plan.expected_provisions_tons * w.basePrice("provisions") + lose * payout);
      if (cost >= payout) continue;
      if (!best || plan.total_distance_nm < best.nm) best = { yard: p.id, nm: plan.total_distance_nm, cost };
    }
    return best ?? `no open yard is within reach for less than the payout of ${cr(payout)}`;
  }

  /**
   * Why she can't change hands now (null: she can; guide 3.4, for a break-up or a sale): in port, empty, nothing sealed, no
   * passengers, convoy or lane; never one housekeeping leaves alone (neverRetire); never pledged (a mortgage or a lien) or arrested,
   * insured, listed (bar `ownListing`, ours for the breakers), sharing her ownership or carrying a venture. Reads it can't make
   * fail closed.
   */
  private async retireUnfit(a: ShipAgent, r: ShipResult, ownListing: string | null): Promise<string | null> {
    const w = this.world;
    const cargo = Object.values(r.cargo_manifest).reduce((n, t) => n + Math.max(0, t), 0);
    const busy = busyNow({
      atSea: r.ship.status === "sailing" || !r.ship.current_port_id,
      convoy: !!r.ship.convoy_id,
      cargoTons: Math.max(cargo, r.cargo_used_tons),
      sealedTons: a.sealedTons(),
      paxHeads: a.paxHeads(),
      lane: a.loaded ? "loaded" : a.lane ? "planned" : "none",
    });
    if (busy) return busy;
    const cls = w.shipClass(a.shipClass);
    const never = neverRetire({
      ships: [...this.agents.values()].filter((x) => !x.gone).length,
      courier: !!cls && (cls.can_seal_dispatches || cls.id === "packet"),
      smuggler: this.smugglers.has(a.shipId),
      arrested: a.arrested,
      aiOrder: !!this.advisor.shipOrder(a.shipId),
      components: r.components?.length ?? 0,
    });
    if (never) return never;
    const soft = (e: unknown) => {
      if (this.isFatal(e) || isApiError(e, "world_paused")) throw e;
      return null;
    };
    const pledges = await this.shipPledges(60_000);
    if (!pledges) return "our loans couldn't be read";
    if (pledges.liened.has(a.shipId) || pledges.arrested.has(a.shipId)) return "she is pledged to a loan (a lien or a mortgage)";
    const listed = await this.client.shipListingPages({}, 5).catch(soft);
    if (!listed?.complete) return "our ship listings couldn't be read";
    if (listed.items.some((x) => x.ship_id === a.shipId && x.status === "open" && x.id !== ownListing)) return "she is listed for sale (by hand)";
    const shares = await this.client.shareListings(a.shipId).catch(soft);
    if (!shares) return "her ship shares couldn't be read";
    if (shares.some((x) => x.ship_id === a.shipId && (x.status === "open" || x.status === "sold"))) return "shares in her are listed or held by others";
    const ventures = await this.client.ventures().catch(soft);
    if (!ventures) return "our ventures couldn't be read";
    if (ventures.some((v) => v.ship_id === a.shipId && !["settled", "lost", "cancelled"].includes(v.status))) return "a venture sails on her";
    const policy = await a.insuredPolicy(60_000, true);
    if (policy === undefined) return "her insurance couldn't be read";
    if (policy) return "she is insured";
    return null;
  }

  /**
   * A ship being retired, at her turn in port with nothing else to do (ShipAgent.atPort, before any new work): a wait (real ms),
   * or null to carry on as any ship (no mark, or it was withdrawn). `wanted`: her fresh checks, then on to the yard; away from it,
   * the passage there, empty and alone; at the yard, listed for sale on the Exchange down the ship broker's ladder; then broken up. A break-up with no
   * answer (`verify`) is read back, never sent again blind.
   */
  async retireTurn(agent: ShipAgent, r: ShipResult, port: string): Promise<number | null> {
    const m = this.retiring.get(agent.shipId);
    if (!m) return null;
    const w = this.world;
    const id = agent.shipId;
    const back = async (why: string, skip: boolean) => ((await this.unmark(agent, m, why, skip)) ? null : 30_000);
    if (m.stage === "verify") {
      const left = (m.sentAt ?? 0) + VERIFY_MS - Date.now();
      if (left > 0) {
        agent.setActivity(`retiring: the break-up at ${port} had no answer; reading it back in ${Math.ceil(left / 1000)}s`);
        return left + 1_000;
      }
      // Still ours (a ship broken up is gone, and her tick never gets here): it didn't go through.
      this.log(agent.name, `retiring: the break-up at ${port} had no answer and she is still ours ${Math.round(VERIFY_MS / 60_000)} min on: it didn't go through`);
      m.stage = "breakup";
      delete m.sentAt;
      this.persist(true);
    }
    // Withdrawn by the switch, the key or the season, by an AI order (it wins), or by work: a load, or paying work found since.
    const order = this.advisor.shipOrder(id);
    const found = m.reason === "idle" && m.stage === "wanted" && agent.tripLog.some((t) => Date.parse(t.at) >= m.at - w.skewMs);
    const off = this.retireBlocked() ?? (order ? `an AI order (${order.order}) is in force for her` : agent.loaded ? "she took on a load" : found ? "she found paying work since" : null);
    if (off) return back(off, false);
    // Nothing planned for her, no passengers offered: she must be free to change hands where she ends (guide 3.4).
    if (agent.lane) this.releaseLane(agent);
    agent.dropOffers("she is being retired");
    if (m.stage === "wanted") {
      const unfit = await this.retireUnfit(agent, r, null);
      if (unfit) return back(unfit, true);
      // The yard afresh from where she lies now: one chosen at sea was from the port she made for then, and she may have finished
      // her lane elsewhere (an open yard here, or a passage from here that costs more than the payout). Every Crown in reach refused
      // lately: the one chosen stands, and retireSail waits for one to pay.
      const y = await this.breakUpYard(agent, r, m.payout);
      if (typeof y === "string") {
        if (this.crownRefused.size === 0) return back(y, true);
      } else {
        if (y.yard !== m.yard) {
          this.log(agent.name, `retiring: to be broken up at ${y.yard} (from ${port}) instead of ${m.yard}`);
          freshLadder(m);
        }
        m.yard = y.yard;
      }
      m.stage = "sail";
      this.persist(true);
    }
    // Away from her yard (or its Crown refused meanwhile): there, empty and alone.
    if (port !== m.yard || this.crownRefusedNow(w.region(m.yard))) {
      const next = await this.retireSail(agent, r, port, m);
      return typeof next === "string" ? back(next, true) : next;
    }

    // At the yard: listed for sale on the Exchange first, whatever the ship-deals switch (guide 3.4: a player who buys pays at least
    // half her rebuild value and she sails on, and the ship broker buys a hull listed far below it at a yard port, paying more than
    // the yard's 35%), down the broker's ladder of the server's rebuild value; broken up only when unsold at its last step. A mark
    // saved for the breakers unlisted (ship deals were off then) is listed first too.
    if (m.stage === "breakup" && !m.listTried) m.stage = "sail";
    if (m.stage === "sail") {
      // The stage moves (and the listing counts as tried) only once the listing call has an answer: a pause or a fatal error thrown
      // before then leaves her at 'sail', listed on the next turn, never broken up unlisted on a saved 'breakup'.
      if (!m.listTried) {
        const unfit = await this.retireUnfit(agent, r, null);
        if (unfit) return back(unfit, true);
        // In the roadstead while listed: no berth dues run up, and berth moves don't close a listing.
        await agent.standBy(r, `retiring: listing her for sale at ${port}`);
        await this.retireList(agent, m, port, m.ladderStep ?? 0, m.ladderRebuild);
      } else m.stage = "breakup";
      this.persist(true);
      // Refused for the band (retireList): her step once more at the next turn, priced afresh.
      if (m.stage === "sail") {
        agent.setActivity(`retiring: her listing at ${port} was refused for the band; listing her again shortly, priced afresh`);
        return 30_000;
      }
    }
    if (m.stage === "listed") {
      const l = m.listed;
      if (l) {
        const step = l.step ?? 0;
        const last = step >= BROKER_LADDER.length - 1;
        // An older save's listing was to stand a day: it holds one step from when it went up, as a new one does.
        const until = l.step === undefined ? Math.min(l.until, l.at + this.brokerStepMs) : l.until;
        // Read back now and again, and at the step's end: sold (she goes with the notice), closed under her, our step-down's withdrawal
        // landed (its answer lost), or never made.
        let stepped = false;
        if (l.id === null || Date.now() - (l.checkedAt ?? 0) >= LIST_CHECK_MS || Date.now() >= until) {
          l.checkedAt = Date.now();
          const mine = await this.client.shipListingPages({}, 5).catch((e: unknown) => {
            if (this.isFatal(e) || isApiError(e, "world_paused")) throw e;
            return null;
          });
          if (mine?.complete) {
            const rec = l.id ? mine.items.find((x) => x.id === l.id) : mine.items.find((x) => x.ship_id === id && x.status === "open");
            if (rec && l.id === null) {
              l.id = rec.id;
              l.price = rec.price_pence;
              if (rec.rebuild_value_pence > 0) l.rebuild = rec.rebuild_value_pence;
              this.log(agent.name, `retiring: her listing for sale at ${port} stands after all (${cr(rec.price_pence)})`);
            }
            if (rec?.status === "sold") {
              this.settleRetired(id, "sold", { pence: rec.price_pence, port: rec.port_id });
              return 5_000;
            }
            if (rec?.status === "cancelled" && l.cancelSentAt !== undefined && rec.cancel_reason !== "ship_moved") {
              // Our own withdrawal at the step's end went through (its answer was lost): on down the ladder below.
              stepped = true;
            } else if (rec?.status === "cancelled" || (!rec && (l.id !== null || Date.now() - (l.sentAt ?? l.at) > VERIFY_MS))) {
              this.log(agent.name, `retiring: ${rec ? `her listing closed (${rec.cancel_reason ?? "no reason given"})` : "her listing wasn't made"}: broken up at ${port} instead`);
              delete m.listed;
              m.stage = "breakup";
            }
            this.persist(true);
          }
        }
        if (m.stage === "listed" && !stepped) {
          if (Date.now() < until || l.id === null) {
            agent.setActivity(
              `retiring: listed for sale at ${port} for ${cr(l.price)} (step ${step + 1} of ${BROKER_LADDER.length}) until ${new Date(until).toISOString().slice(11, 16)} UTC; ` +
                `${last ? "broken up here if unsold" : "a step lower then if unsold"}`,
            );
            return Math.max(5_000, Math.min(LIST_CHECK_MS, until - Date.now() + 1_000));
          }
          // Unsold through its step: withdrawn (an open listing would refuse the break-up, and the next step replaces it). Saved as
          // sent first: one with no answer is read back (a withdrawal by us is the step taken, a sale is a sale).
          l.cancelSentAt = Date.now();
          this.persist(true);
          try {
            await this.client.cancelShipListing(l.id);
          } catch (e) {
            if (this.isFatal(e) || isApiError(e, "world_paused")) throw e;
            // Sold or closed meanwhile, or no answer: read back at the next turn.
            l.checkedAt = 0;
            agent.setActivity(`retiring: withdrawing her listing at ${port} failed (${(e as Error).message}); reading it back`);
            return 15_000;
          }
          stepped = true;
        }
        if (stepped) {
          const hours = Math.round((Date.now() - l.at) / (60 * this.world.gameMinuteMs));
          const was = l.rebuild ?? m.rebuild;
          delete m.listed;
          if (last) {
            this.log(agent.name, `retiring: unsold at ${cr(l.price)} (the ladder's last step, just over half her rebuild value) after ~${hours} game hours on the Exchange: the listing is withdrawn; broken up at ${port}`);
            m.stage = "breakup";
            this.persist(true);
          } else {
            this.log(agent.name, `retiring: unsold at ${cr(l.price)} after ~${hours} game hours on the Exchange: the listing is withdrawn, to be listed a step lower`);
            // The next step is listed as the first was, at the next turn (her checks again: a policy, a lien or a listing by hand may
            // have come meanwhile). Saved first: a pause or a fatal error in between lists her at that step later, never breaks her up
            // unlisted.
            m.stage = "sail";
            m.listTried = false;
            m.ladderStep = step + 1;
            m.ladderRebuild = was;
            this.persist(true);
            return 1_000;
          }
        }
      } else m.stage = "breakup";
    }

    // Broken up (guide 3.4): her fresh checks, her case again, any passenger offer the server still lists cancelled, then the call.
    const unfit = await this.retireUnfit(agent, r, null);
    if (unfit) return back(unfit, true);
    const still = await this.retireStillPays(agent, r, m);
    if (still === null) {
      agent.setActivity(`retiring: her lanes from ${port} couldn't be planned to judge her again; breaking her up shortly`);
      return 30_000;
    }
    if (still) return back(`no longer dead weight: ${still}`, true);
    const offers = await this.client.passengerOffers(true, { ship_id: id }).catch((e: unknown) => {
      if (this.isFatal(e) || isApiError(e, "world_paused")) throw e;
      return null;
    });
    if (!offers) {
      agent.setActivity(`retiring: her passenger offers couldn't be read; breaking her up at ${port} shortly`);
      return 30_000;
    }
    for (const o of offers) {
      if (o.ship_id !== id || o.status !== "open") continue;
      const ok = await this.client.cancelPassengerOffer(o.id).then(
        () => true,
        (e: unknown) => {
          if (this.isFatal(e) || isApiError(e, "world_paused")) throw e;
          return isApiError(e) && (e.status === 404 || e.status === 409);
        },
      );
      if (!ok) {
        agent.setActivity(`retiring: a passenger offer of hers couldn't be withdrawn; breaking her up at ${port} shortly`);
        return 30_000;
      }
    }
    const region = w.region(port);
    m.sentAt = Date.now();
    let res: BreakUpShipResult;
    try {
      res = await this.client.breakUpShip(id);
    } catch (e) {
      if (this.isFatal(e) || isApiError(e, "world_paused")) throw e;
      if (outcomeUnknown(e)) {
        m.stage = "verify";
        this.persist(true);
        this.log(agent.name, `retiring: the break-up at ${port} had no answer: read back from the fleet (never sent again blind)`);
        agent.setActivity(`retiring: the break-up at ${port} had no answer; reading it back`);
        return VERIFY_MS + 1_000;
      }
      delete m.sentAt;
      // 409 is the Crown (guide 3.4) unless it names something else that keeps her from changing hands.
      if (isApiError(e) && e.status === 409 && !BREAK_UP_OTHER_409.test(`${e.code ?? ""} ${e.detail}`)) {
        this.crownRefused.set(region, w.now() + CROWN_REFUSED_GAME_DAYS * this.gameDayMs);
        this.log(agent.name, `retiring: the ${region} Crown can't pay for her break-up at ${port} now (409): no yard of that region for a game day; another region's if one is in reach`);
        this.persist(true);
        const next = await this.retireSail(agent, r, port, m);
        return typeof next === "string" ? back(next, true) : next;
      }
      return back(`the break-up at ${port} was refused (${(e as Error).message})`, true);
    }
    return this.brokeUp(agent, m, res);
  }

  /** How long a step of the ship broker's ladder is held (real ms): BROKER_STEP_GAME_H in game time. */
  private get brokerStepMs(): number {
    return BROKER_STEP_GAME_H * 60 * this.world.gameMinuteMs;
  }

  /**
   * Lists a ship being retired for sale where she lies (guide 3.4), on the Exchange (never `unlisted`: the ship broker buys only what
   * it shows), at step `step` of the broker's ladder (BROKER_LADDER) of the server's own rebuild value (the band is 50-150% of it,
   * the cheapest Crown price at full labour and markup): read off a Goldsmiths' quote on her as the dashboard's appraisal does
   * (nothing taken), else the higher of the figure her last listing gave (`hint`) and ours (hullValue): a guess under the server's
   * figure puts the price under the band, a 400, and the breakers' 35% for a sale's 50% or more. Refused for the band (a guess, or
   * the value moved between the two calls), her step is tried once more at the next turn (`ladderRetry`, stage `sail`), priced
   * afresh. The mark moves to `listed` (held a step) once the call has an answer, or as sent when it has none (looked for among our
   * listings, never sent again); refused otherwise: `breakup`. Listed either way: her id is kept (`disposedIds`), so the broker's
   * resale of her is never bought back by our own buyer.
   */
  private async retireList(agent: ShipAgent, m: RetireMark, port: string, step: number, hint?: number): Promise<void> {
    const id = agent.shipId;
    const appraised = await this.client
      .loanQuote({ principal_pence: LOAN_MIN_PRINCIPAL_PENCE, term_game_days: 30, repayment: "balloon", ship_id: id })
      .then((q) => (q.rebuild_value_pence > 0 ? q.rebuild_value_pence : null))
      .catch((e: unknown) => {
        if (this.isFatal(e) || isApiError(e, "world_paused")) throw e;
        return null;
      });
    const rebuild = appraised ?? Math.max(hint && hint > 0 ? hint : 0, m.rebuild);
    const price = ladderPrice(rebuild, step);
    const at = Date.now();
    const until = at + this.brokerStepMs;
    const of = `step ${step + 1} of ${BROKER_LADDER.length}`;
    try {
      const res = await this.client.listShip(id, price);
      m.listTried = true;
      delete m.ladderStep;
      delete m.ladderRebuild;
      delete m.ladderRetry;
      this.noteDisposed(id);
      m.listed = { id: res.id, price: res.price_pence, at, until, checkedAt: at, step, rebuild: res.rebuild_value_pence > 0 ? res.rebuild_value_pence : rebuild };
      m.stage = "listed";
      this.log(
        agent.name,
        `retiring: listed for sale on the Exchange at ${port} for ${cr(res.price_pence)} (${Math.round((res.price_pence / Math.max(1, res.rebuild_value_pence)) * 100)}% of her ` +
          `${cr(res.rebuild_value_pence)} rebuild value, ${of}) until ${new Date(until).toISOString()}: a player, or the ship broker once the listing is a game hour old, ` +
          `pays more than the yard's 35% (judged on that 35%, the worst case); ${step >= BROKER_LADDER.length - 1 ? "broken up here if unsold" : "a step lower if unsold"}`,
      );
    } catch (e) {
      if (this.isFatal(e) || isApiError(e, "world_paused")) throw e;
      if (isApiError(e) && e.status === 400 && m.ladderRetry !== step) {
        // Outside the band (guide 3.4: 50%..=150% of a rebuild value that moves with the yards' prices): the same step once more at
        // the next turn, appraised afresh, never straight to the breakers on a stale figure.
        m.stage = "sail";
        m.listTried = false;
        m.ladderStep = step;
        if (hint && hint > 0) m.ladderRebuild = hint;
        m.ladderRetry = step;
        this.log(agent.name, `retiring: her listing at ${port} for ${cr(price)} (${of}${appraised ? "" : ", her rebuild value not appraised just now"}) was refused (${(e as Error).message}): listed again at that step shortly, priced afresh`);
        return;
      }
      m.listTried = true;
      delete m.ladderStep;
      delete m.ladderRebuild;
      delete m.ladderRetry;
      if (outcomeUnknown(e)) {
        this.noteDisposed(id);
        m.listed = { id: null, price, at, until, sentAt: at, step, rebuild };
        m.stage = "listed";
        this.log(agent.name, `retiring: listing her for sale at ${port} (${of}, ${cr(price)}) had no answer: looked for among our listings (never sent again)`);
      } else {
        m.stage = "breakup";
        this.log(agent.name, `retiring: not listed for sale at ${port} at ${cr(price)} (${of}: ${(e as Error).message}): broken up instead`);
      }
    }
  }

  /**
   * Her break-up's case again just before the irreversible call (guide 3.4: the hull is destroyed), since the judgement she was marked
   * on may be a day listed and a passage old: measured afresh where she lies with the slot as it is now (the user may have raised
   * maxShips or turned the buyer off), still dead weight (an autonomous mark; an AI order stands on its own reason, a new hull counted
   * for her slot only while she is still out of date, as aiBreakUp), and the break-up still paying over what is left of the horizon.
   * "" : it still does; a string: why not; null: her lanes couldn't be planned (judged again shortly, never broken up blind).
   */
  private async retireStillPays(a: ShipAgent, r: ShipResult, m: RetireMark): Promise<string | null> {
    const cls = this.world.shipClass(a.shipClass);
    if (!cls) return null;
    const s = this.settings;
    const mz = await this.retireMeasure(a, r, cls, [...this.agents.values()].filter((x) => !x.gone).length >= s.maxShips && s.autoBuy && this.canBuild);
    if (!mz) return null;
    const slot = mz.obsolete
      ? await this.slotOption().catch((e: unknown) => {
          if (this.isFatal(e) || isApiError(e, "world_paused")) throw e;
          return null;
        })
      : null;
    const v = deadWeight({ idle: mz.idle, upkeepPerHour: mz.upkeep, trailingPerHour: mz.trail, bestLanePerHour: mz.best, obsolete: mz.obsolete, slot: mz.obsolete ? slot : null });
    if (!v && !m.why.startsWith(AI_RETIRE_WHY)) return m.reason === "obsolete" && !mz.obsolete ? "her slot isn't wanted for a new hull now" : "a lane from here now beats her upkeep";
    // Her class's quote dropped since (a price moved): the rebuild figure she was marked on, never the hold guess.
    const rebuild = this.knownQuotes(a.shipClass).has(a.shipClass) ? this.rebuildOf(a, r) : m.rebuild;
    const c = breakUpCase({ rebuild, upkeepPerHour: mz.upkeep, earnPerHour: mz.earn, horizonHours: this.retireHorizonHours(), replacementPerHour: v?.reason === "obsolete" ? slot?.perHour : undefined });
    if (!c.ok) return c.why;
    m.payout = c.payout;
    return "";
  }

  /**
   * Bound for the breakers: to her yard (the nearest other one when it can't be reached or its Crown refused), empty and alone. A
   * wait, or why she can't be (the mark is then withdrawn): also when she hasn't left the port she lies at in RETIRE_SAIL_GAME_DAYS
   * (no stores on sale, no cash for them: she would lie idle on her upkeep, and hold up every other retirement, one at a time),
   * unless that port has an open yard whose Crown can pay, where she is broken up instead.
   */
  private async retireSail(agent: ShipAgent, r: ShipResult, port: string, m: RetireMark): Promise<number | string> {
    const w = this.world;
    // Off the yard a listing closes with her (guide 3.4: `ship_moved`): a new one at the next yard.
    if (m.stage !== "sail") {
      m.stage = "sail";
      delete m.listed;
    }
    if (m.sailWait?.port !== port) {
      m.sailWait = { port, since: w.now() };
      this.persist(true);
    } else if (w.now() - m.sailWait.since > RETIRE_SAIL_GAME_DAYS * this.gameDayMs) {
      const here = w.port(port);
      if (here?.has_shipyard && w.isOpen(port) && !w.isCove(port) && !this.crownRefusedNow(here.banking_region)) {
        this.log(agent.name, `retiring: she couldn't sail for the yard at ${m.yard} from ${port} in ${RETIRE_SAIL_GAME_DAYS} game days: retired at the yard here instead (listed down the broker's ladder first)`);
        m.yard = port;
        freshLadder(m);
        delete m.sailWait;
        this.persist(true);
        return 1_000;
      }
      return `she couldn't sail from ${port} for a yard in ${RETIRE_SAIL_GAME_DAYS} game days`;
    }
    const hull = w.shipClass(agent.shipClass)?.hull_category ?? "coastal";
    const plan =
      port === m.yard
        ? null
        : await w.route(port, m.yard, agent.shipClass).catch((e: unknown) => {
            if (this.isFatal(e) || isApiError(e, "world_paused")) throw e;
            return null;
          });
    const refused = this.crownRefusedNow(w.region(m.yard));
    if (refused || (port !== m.yard && (!plan || !w.routeRated(plan, hull) || this.offLimits(m.yard, plan)))) {
      const y = await this.breakUpYard(agent, r, m.payout);
      if (typeof y === "string") {
        // Every yard in reach has a Crown that refused lately: she waits for one to pay (refusals lapse in a game day).
        if (this.crownRefused.size === 0) return y;
        await agent.standBy(r, `retiring: no yard whose Crown can pay is in reach (${y}); waiting at ${port}`);
        this.persist(true);
        return 10 * 60_000;
      }
      if (y.yard !== m.yard) {
        this.log(agent.name, `retiring: to be broken up at ${y.yard} instead of ${m.yard}${refused ? ` (the ${w.region(m.yard)} Crown couldn't pay)` : ""}`);
        freshLadder(m);
      }
      m.yard = y.yard;
      this.persist(true);
    }
    // There already: the next turn lists or breaks her up.
    if (m.yard === port) return 1_000;
    this.retireSay(agent.shipId, `sail:${m.yard}`, agent.name, `retiring: sailing empty from ${port} to the yard at ${m.yard}`);
    return agent.sailFor(r, m.yard);
  }

  /** Broken up: the payout booked where it was paid (the vaults read again after), recorded, and her autopilot stopped. */
  private brokeUp(agent: ShipAgent, m: RetireMark, res: BreakUpShipResult): number {
    const w = this.world;
    const region = w.region(res.port_id);
    // Its notice may have come first (booked there, the vaults read again): not twice.
    if (!this.retiredIds.has(agent.shipId)) w.vaults.set(region, w.vault(region) + res.payout_pence - (res.berth_dues_pence ?? 0));
    this.settleRetired(agent.shipId, "broken_up", { pence: res.payout_pence, rebuild: res.rebuild_value_pence, port: res.port_id }, m);
    void w.refreshVaults().then(() => this.cashArrived(), () => undefined);
    return agent.retired(`was broken up at the yard at ${res.port_id}`);
  }

  /**
   * Withdraws a ship's retirement (said once): she goes back to work, a listing of hers for the breakers cancelled first (with it
   * still open, false: she waits and it is tried again). `skip`: not judged again for RETIRE_SKIP_MS.
   */
  private async unmark(agent: ShipAgent, m: RetireMark, why: string, skip: boolean): Promise<boolean> {
    const l = m.listed;
    if (l) {
      const soft = (e: unknown) => {
        if (this.isFatal(e) || isApiError(e, "world_paused")) throw e;
        return null;
      };
      let lid = l.id;
      if (lid === null) {
        const mine = await this.client.shipListingPages({}, 5).catch(soft);
        if (!mine?.complete) return false;
        lid = mine.items.find((x) => x.ship_id === agent.shipId && x.status === "open")?.id ?? null;
      }
      if (lid) {
        const done = await this.client.cancelShipListing(lid).then(() => true, soft);
        if (!done) {
          // Closed already (sold, or she moved) is as good; still open, or not read, she waits.
          const mine = await this.client.shipListingPages({}, 5).catch(soft);
          const rec = mine?.items.find((x) => x.id === lid);
          if (!mine?.complete || rec?.status === "open") {
            agent.setActivity(`retiring withdrawn (${why}): her listing for sale couldn't be cancelled yet; trying again`);
            return false;
          }
          if (rec?.status === "sold") {
            this.settleRetired(agent.shipId, "sold", { pence: rec.price_pence, port: rec.port_id });
            return false;
          }
        }
      }
    }
    this.retiring.delete(agent.shipId);
    this.deadStreaks.delete(agent.shipId);
    this.retireWithdrawn.delete(agent.shipId);
    this.retireWithdrawn.set(agent.shipId, why);
    if (this.retireWithdrawn.size > 50) this.retireWithdrawn.delete(this.retireWithdrawn.keys().next().value!);
    if (skip) this.retireSkip.set(agent.shipId, Date.now() + RETIRE_SKIP_MS);
    this.log(agent.name, `no longer being retired (${why}): back to work${skip ? `; not judged again for ${Math.round(RETIRE_SKIP_MS / 3_600_000)} h` : ""}`);
    this.persist(true);
    return true;
  }

  /**
   * A ship housekeeping was retiring left the fleet (once: by her id): broken up (the yard's payout), sold (a buyer took her while
   * listed), or null (gone some other way: only her mark goes). Logged with the net worth it gave away, and kept for the record.
   */
  private settleRetired(id: string, how: RetireRec["how"] | null, x: { pence?: number; rebuild?: number; port?: string | null }, mark?: RetireMark): void {
    const m = mark ?? this.retiring.get(id);
    this.retiring.delete(id);
    this.deadStreaks.delete(id);
    if (!m) return;
    const a = this.agents.get(id);
    const name = a?.name ?? m.ship ?? id;
    if (!how) {
      this.log(name, `no longer in the fleet while being retired (${m.stage}), with no notice of a sale or a break-up: her mark is dropped`);
      this.persist(true);
      return;
    }
    if (this.retiredIds.has(id)) return;
    this.retiredIds.add(id);
    this.noteLeftFleet(id);
    if (how === "sold") this.noteDisposed(id);
    const rebuild = x.rebuild ?? m.rebuild;
    const pence = x.pence ?? (how === "broken_up" ? m.payout : (m.listed?.price ?? 0));
    const port = x.port ?? m.yard;
    const cls = a?.shipClass ?? m.cls ?? "ship";
    this.retiredRecs.push({ at: Date.now(), shipId: id, ship: name, cls, port, how, pence, rebuild, why: m.why });
    if (this.retiredRecs.length > RETIRED_KEPT) this.retiredRecs.splice(0, this.retiredRecs.length - RETIRED_KEPT);
    if (how === "broken_up") {
      this.retireStats.brokenUp++;
      this.retireStats.payout += pence;
    } else {
      this.retireStats.sold++;
      this.retireStats.soldPence += pence;
    }
    const loss = Math.max(0, rebuild - pence);
    // A sale's price lands in the vault there (a break-up's payout is booked by its caller).
    if (how === "sold") void this.world.refreshVaults().then(() => this.cashArrived(), () => undefined);
    this.log(
      "fleet",
      how === "broken_up"
        ? `broke up the ${cls} ${name} at ${port} for ${cr(pence)}${x.pence === undefined ? " (as reckoned: the answer was lost)" : ""}: ${m.why} (−${cr(loss)} of net worth: the hull counted at ${cr(rebuild)})`
        : `sold the ${cls} ${name} where she lay at ${port} for ${cr(pence)}${x.pence === undefined ? " (as listed)" : ""}, listed before the breakers: ${m.why} (−${cr(loss)} of net worth against her ${cr(rebuild)} rebuild value; she sails on for her buyer)`,
    );
    this.lastScan = 0;
    this.persist(true);
  }

  /**
   * A remittance of ours a bank carried as a draft (guide 3.12): counted, with what it saved against the Crown's fee, and its ledger
   * group kept a while so its `bank_draft` notice isn't logged twice.
   */
  private noteDraft(saved: number, tx?: string): void {
    this.drafts.n++;
    this.drafts.saved += Math.max(0, Math.round(saved));
    if (tx) {
      this.draftsLogged.add(tx);
      if (this.draftsLogged.size > 50) this.draftsLogged.delete(this.draftsLogged.values().next().value!);
    }
    this.persist();
  }

  /** A remit fee paid to keep home funded (keepHomeFloor, or auto-remit for a bill): a piece of the case for moving home (server ms). */
  private noteHomeFee(from: BankingRegion, fee: number, how: HomeFee["how"], at = this.world.now()): void {
    if (!(fee > 0) || from === this.homeRegion) return;
    this.homeFees.push({ at, from, fee, how });
    if (this.homeFees.length > HOME_FEES_KEPT) this.homeFees.splice(0, this.homeFees.length - HOME_FEES_KEPT);
    this.persist();
  }

  /** The Exchequer topped a Crown up (guide 3.1: public, never how much; the payload as `world/events` gives it): said and kept. */
  private noteCrownTopUp(p: Record<string, unknown>, timestamp: string): void {
    const str = (k: string) => (typeof p[k] === "string" ? (p[k] as string) : undefined);
    const title = (str("title") ?? str("description") ?? "the Exchequer's remittance").slice(0, 200);
    const port = str("target_port_id");
    const region =
      asRegion(str("banking_region") ?? str("region") ?? str("to_region")) ??
      (port && this.world.port(port) ? this.world.region(port) : null) ??
      regionIn(`${str("title") ?? ""} ${str("description") ?? ""}`);
    const at = Date.parse(str("starts_at") ?? timestamp) || this.world.now();
    if (this.crownTopUps.some((t) => t.at === at && t.region === region && t.title === title)) return;
    this.crownTopUps.push({ at, region, title });
    if (this.crownTopUps.length > TOP_UPS_KEPT) this.crownTopUps.splice(0, this.crownTopUps.length - TOP_UPS_KEPT);
    this.log("fleet", region ? `the Exchequer topped up the ${region.replace(/_/g, " ")} Crown` : `the Exchequer topped up a Crown (${title})`);
  }

  /**
   * The home port (guide 3.12; housekeeping.ts relocationCase), every bills pass: the case for moving it where the cash lands, then
   * the vault, presence and gap checks, then the move to the donor region's best port where we have presence. Said once per change;
   * a move whose answer was lost is read back from the profile, never sent again blind.
   */
  private async reviewHome(): Promise<void> {
    const w = this.world;
    const now = w.now();
    // Tracked from the first pass (fees before it weren't kept).
    this.feesSince ??= now;
    const gameDay = this.gameDayMs;
    this.homeFees = this.homeFees.filter((f) => f.at >= now - 2 * RELOCATE_WINDOW_GAME_DAYS * gameDay).slice(-HOME_FEES_KEPT);
    const daysLeft = Math.max(0, Math.min(w.seasonLeftMs(), HORIZON_MAX_MS)) / gameDay;
    const c = relocationCase({ fees: this.homeFees, now, since: this.feesSince, gameDayMs: gameDay, daysLeft, home: this.homeRegion });
    // The verdict for the panel; said once per change of `code` (the quiet states, nothing to move for, aren't said).
    const set = (verdict: string, code: string, target: string | null = null, quiet = false): void => {
      this.homeCase = { ...c, target, verdict, daysLeft };
      if (code === this.relocateSaid) return;
      this.relocateSaid = code;
      if (!quiet) this.log("fleet", `home port: ${verdict}`);
    };
    const iso = (t: number) => new Date(t).toISOString();
    if (!this.settings.autoRelocate) return set("moving the home port is off", "off", null, true);
    if (!this.canBuild) return set("the key lacks infra_manage (a move needs it)", "scope", null, true);
    if (w.seasonMode() !== "normal") return set("the season's endgame: the home stays where it is", "season", null, true);
    if (!c.ok) return set(c.why, `case:${c.code}`, null, c.code !== "split" && c.code !== "small");
    // The AI ordered a move that is still to be made (waiting on cash or presence): where the home goes is its call meanwhile.
    const ordered = this.advisor.financeOrders().find((o) => o.kind === "relocate" && (o.status === "pending" || o.status === "waiting"));
    if (ordered) return set(`${c.why}; but the AI ordered a move to ${ordered.ref}`, "ai", ordered.ref, true);
    const donor = c.donor!;
    if (this.movedAt && Date.now() - this.movedAt < RELOCATE_GAP_MS) return set(`${c.why}; but the home moved lately: the next move from ${iso(this.movedAt + RELOCATE_GAP_MS)}`, "gap");
    if (this.nextMoveAt > now) return set(`${c.why}; but the server allows the next move from ${iso(this.nextMoveAt)}`, "server");
    if (Date.now() < this.moveBlockedUntil) return set(`${c.why}; but the last try was refused: the next from ${iso(this.moveBlockedUntil)}`, "backoff");
    // The donor's vault pays the move, above the floor it would keep as home (upkeep and the levy, and its own rent).
    await w.refreshVaults();
    const keep = Math.max(this.floorIn(donor), this.homeFloor() + Math.ceil(UPKEEP_DAYS_RESERVED * (this.bills.rent.get(donor) ?? 0)));
    if (w.vault(donor) - keep < RELOCATE_FEE_PENCE) {
      return set(`${c.why}; but the ${donor} vault holds ${cr(w.vault(donor))}, short of the move's ${cr(RELOCATE_FEE_PENCE)} above the ${cr(keep)} it would keep as home`, "vault");
    }
    // Presence there: the region's hub with a shipyard first.
    const present = await this.homePresence();
    const target = [...present]
      .map((p) => w.port(p))
      .filter((p): p is CatalogPort => !!p && p.banking_region === donor && w.isOpen(p.id) && !w.isCove(p.id))
      .sort((x, y) => homeRank(x) - homeRank(y) || x.id.localeCompare(y.id))[0];
    if (!target) return set(`${c.why}; but we have no presence in ${donor} to move to (a ship in port, or a factor)`, "presence");
    const res = await this.moveHome(target, c.why);
    set(res.verdict, res.code, target.id, res.moved);
  }

  /**
   * Where we have presence a home may move to (guide 3.12: a Resident Factor, or a ship berthed or in the roadstead): our ships as
   * last read, our factors read now (none counted when that read fails). Coves are the caller's to leave out.
   */
  private async homePresence(): Promise<Set<string>> {
    const factors = await this.client.factors().catch((e: unknown) => {
      if (this.isFatal(e) || isApiError(e, "world_paused")) throw e;
      return null;
    });
    if (factors) {
      this.factorCount = factors.length;
      this.factorPorts = factors;
    }
    const present = new Set<string>(factors ?? []);
    for (const a of this.agents.values()) {
      const sh = a.last?.ship;
      if (!a.gone && sh && sh.status !== "sailing" && sh.current_port_id) present.add(sh.current_port_id);
    }
    return present;
  }

  /**
   * Moves the home port to `target` (guide 3.12), the caller's gates passed: its fee from that region's vault under the cash lock,
   * booked, logged with `why` and followed (setHome). A refusal backs off (409: once a real day, to the time it names; 403 no
   * presence, 400 funds or a cove: RELOCATE_RETRY_MS); a move with no answer is read back from the profile, never sent again blind.
   * Whether it moved, and the verdict with its code (`moved`, `lost`, `refused:<status>`).
   */
  private async moveHome(target: CatalogPort, why: string): Promise<{ moved: boolean; verdict: string; code: string }> {
    const w = this.world;
    const now = w.now();
    const region = target.banking_region;
    const iso = (t: number) => new Date(t).toISOString();
    let moved: RelocateHomePortResult | null = null;
    try {
      // Under the cash lock: its fee comes out of that region's vault.
      moved = await this.withCash(() => this.client.relocateHome(target.id));
    } catch (e) {
      if (this.isFatal(e) || isApiError(e, "world_paused")) throw e;
      if (outcomeUnknown(e)) {
        // Read back from the profile: moved or not, never sent again blind.
        const profile = await this.client.companyProfile().catch((x: unknown) => {
          if (this.isFatal(x)) throw x;
          return null;
        });
        if (profile?.company.home_port_id !== target.id) {
          this.moveBlockedUntil = Date.now() + RELOCATE_RETRY_MS;
          this.persist(true);
          const seen = profile ? `the profile still shows home at ${profile.company.home_port_id}` : "the profile couldn't be read";
          return { moved: false, verdict: `moving home to ${target.id} had no answer and ${seen}: not tried again before ${iso(this.moveBlockedUntil)}`, code: "lost" };
        }
        void w.refreshVaults().catch(() => undefined);
      } else {
        // 409: once a real day (the refusal says when); 403 no presence, 400 funds or a cove: tried again in an hour.
        const when = isApiError(e) && e.status === 409 ? namedTime(e.body, e.detail, now, 2 * 24 * 3_600_000) : null;
        if (isApiError(e) && e.status === 409) this.nextMoveAt = when ?? now + 24 * 3_600_000;
        else this.moveBlockedUntil = Date.now() + RELOCATE_RETRY_MS;
        this.persist(true);
        const next = isApiError(e) && e.status === 409 ? iso(this.nextMoveAt) : iso(this.moveBlockedUntil);
        return { moved: false, verdict: `moving home to ${target.id} was refused (${(e as Error).message}): not tried again before ${next}`, code: `refused:${isApiError(e) ? e.status : "?"}` };
      }
    }
    const fee = moved?.fee_pence ?? RELOCATE_FEE_PENCE;
    if (moved) w.vaults.set(region, w.vault(region) - fee);
    const next = Date.parse(moved?.next_relocation_at ?? "");
    if (Number.isFinite(next)) this.nextMoveAt = next;
    this.movedAt = Date.now();
    const from = this.homePort;
    this.log("fleet", `moved the home port from ${from ?? "?"} to ${target.id} (${region}) for ${cr(fee)}${moved ? "" : " (its answer was lost; the profile shows it)"}: ${why}`);
    this.setHome(moved?.to_port_id || target.id);
    void w.refreshVaults().then(() => this.cashArrived(), () => undefined);
    this.persist(true);
    return { moved: true, verdict: `moved to ${target.id}: ${why}`, code: "moved" };
  }

  /** Fleet housekeeping for the dashboard and the digest. */
  private housekeepingReport(): HousekeepingReport {
    const w = this.world;
    const iso = (t: number) => new Date(t).toISOString();
    const hc = this.homeCase;
    // The soonest the next move may be made: our gap, the server's day (server ms to local), a back-off.
    const nextAt = Math.max(this.movedAt ? this.movedAt + RELOCATE_GAP_MS : 0, this.nextMoveAt ? this.nextMoveAt - w.skewMs : 0, this.moveBlockedUntil);
    return {
      breakUp: {
        enabled: this.settings.autoBreakUp,
        blocked: this.retireBlocked(),
        candidates: this.deadSeen,
        pending: [...this.retiring].map(([id, m]) => ({
          shipId: id,
          ship: this.agents.get(id)?.name ?? m.ship ?? id,
          stage: m.stage,
          reason: m.reason,
          why: m.why,
          yard: m.yard,
          rebuildPence: m.rebuild,
          payoutPence: m.payout,
          listing: m.listed
            ? {
                id: m.listed.id,
                pricePence: m.listed.price,
                // An older save's day-long listing holds one step from when it went up.
                until: iso(m.listed.step === undefined ? Math.min(m.listed.until, m.listed.at + this.brokerStepMs) : m.listed.until),
                step: (m.listed.step ?? 0) + 1,
                steps: BROKER_LADDER.length,
              }
            : null,
          decidedAt: iso(m.at),
        })),
        done: this.retiredRecs.map((r) => ({
          at: iso(r.at),
          shipId: r.shipId,
          ship: r.ship,
          cls: r.cls,
          port: r.port,
          how: r.how,
          pence: r.pence,
          rebuildPence: r.rebuild,
          worthLossPence: Math.max(0, r.rebuild - r.pence),
          why: r.why,
        })),
        refusedRegions: [...this.crownRefused].filter(([, until]) => until > w.now()).map(([region, until]) => ({ region, until: iso(until) })),
        brokenUp: this.retireStats.brokenUp,
        payoutPence: this.retireStats.payout,
        sold: this.retireStats.sold,
        soldPence: this.retireStats.soldPence,
        action: this.retireAction,
      },
      relocate: {
        enabled: this.settings.autoRelocate,
        homePort: this.homePort,
        homeRegion: this.homeRegion,
        windowGameDays: RELOCATE_WINDOW_GAME_DAYS,
        feesPence: hc?.total ?? 0,
        perDayPence: hc?.perDay ?? 0,
        byRegion: (hc?.byRegion ?? []).map((x) => ({ region: x.region, feesPence: x.fees, share: Math.round(x.share * 1000) / 1000 })),
        trackedSince: this.feesSince !== null ? iso(this.feesSince) : null,
        gameDaysLeft: Math.round((hc?.daysLeft ?? 0) * 10) / 10,
        savingPence: hc?.saving ?? 0,
        thresholdPence: hc?.threshold ?? 0,
        feePence: RELOCATE_FEE_PENCE,
        donor: hc?.donor ?? null,
        target: hc?.target ?? null,
        lastMovedAt: this.movedAt ? iso(this.movedAt) : null,
        nextAllowedAt: nextAt > Date.now() ? iso(nextAt) : null,
        verdict: hc?.verdict ?? "not checked yet",
      },
      crownsToppedUp: this.crownTopUps.map((t) => ({ at: iso(t.at), region: t.region, title: t.title })),
    };
  }

  /**
   * The AI's housekeeping orders (directives.ts: `break_up` a ship, `relocate` the home port), one at a time: those still to act on
   * (pending, or waiting on a turn, cash or presence) and break-ups under way (active: her own turns retire her). An unmet one was
   * checked and isn't possible now: it stands as it is (a later answer may order it again).
   */
  private async runAiHousekeeping(): Promise<void> {
    for (const o of this.advisor.financeOrders()) {
      if (o.status === "unmet") continue;
      if (o.kind === "break_up") await this.aiBreakUp(o);
      else if (o.kind === "relocate" && o.status !== "active") await this.aiRelocate(o);
    }
  }

  /**
   * An AI order to break up a ship: marked for the breakers through every check the dead-weight path makes but its run of checks
   * (the switch, the key and the season; never one housekeeping leaves alone; one at a time; her class quoted at a yard of ours,
   * never the hold guess; a yard in reach for less than the payout; the break-up's value test over the horizon), then retired at
   * her own turns in port like any mark (retireTurn: her fresh checks, the passage, a listing first with ship deals on). A lane,
   * cargo or passengers aboard finish first. What became of it goes back to the AI as a status.
   */
  private async aiBreakUp(o: FinanceOrder): Promise<void> {
    const w = this.world;
    const id = o.ref;
    const a = this.agents.get(id);
    if (this.retiredIds.has(id)) return this.noteFinance(o, "done");
    if (!a || a.gone) return this.noteFinance(o, "refused", "gone", "the ship is no longer in the fleet");
    if (this.retiring.has(id)) {
      if (o.status !== "active") this.noteFinance(o, "active", undefined, "already being retired");
      return;
    }
    // Marked, and the mark withdrawn at her turn since (said in the log): what kept her from the breakers.
    if (o.status === "active") {
      const why = this.retireWithdrawn.get(id) ?? "her retiring was withdrawn";
      return this.noteFinance(o, "unmet", this.retireCode(why), why);
    }
    const blocked = this.retireBlocked();
    if (blocked) return this.noteFinance(o, "refused", this.retireCode(blocked), blocked);
    if (this.retiring.size > 0) {
      const first = [...this.retiring.keys()].map((x) => this.agents.get(x)?.name ?? x).join(", ");
      return this.noteFinance(o, "waiting", "busy", `${first} is being retired first (one at a time)`);
    }
    const r = a.last;
    const cls = w.shipClass(a.shipClass);
    if (!r || !cls) return this.noteFinance(o, "waiting", undefined, "she hasn't been read yet");
    const ships = [...this.agents.values()].filter((x) => !x.gone);
    const never = neverRetire({
      ships: ships.length,
      courier: cls.can_seal_dispatches || cls.id === "packet",
      smuggler: this.smugglers.has(id),
      arrested: a.arrested,
      aiOrder: !!this.advisor.shipOrder(id),
      components: r.components?.length ?? 0,
    });
    if (never) return this.noteFinance(o, "refused", "blocked", never);
    const soft = (e: unknown) => {
      if (this.isFatal(e) || isApiError(e, "world_paused")) throw e;
      return null;
    };
    const mz = await this.retireMeasure(a, r, cls, ships.length >= this.settings.maxShips && this.settings.autoBuy && this.canBuild);
    if (!mz) return this.noteFinance(o, "waiting", undefined, "her lanes couldn't be planned: tried again shortly");
    const slot = mz.obsolete ? await this.slotOption().catch(soft) : null;
    // A new hull's net counts for her slot only where the dead-weight path would count it: an out-of-date ship, not an idle one.
    const v = deadWeight({ idle: mz.idle, upkeepPerHour: mz.upkeep, trailingPerHour: mz.trail, bestLanePerHour: mz.best, obsolete: mz.obsolete, slot: mz.obsolete ? slot : null });
    // Her rebuild value from a yard's quote of her class (never the hold guess): asked of a yard of ours at most hourly.
    if (!this.knownQuotes(a.shipClass).has(a.shipClass) && !(await this.quoteClass(a.shipClass, mz.port))) {
      return this.noteFinance(o, "unmet", "no_presence", `no yard of ours could quote a ${a.shipClass} (her rebuild value)`);
    }
    const rebuild = this.rebuildOf(a, r);
    const c = breakUpCase({ rebuild, upkeepPerHour: mz.upkeep, earnPerHour: mz.earn, horizonHours: this.retireHorizonHours(), replacementPerHour: v?.reason === "obsolete" ? slot?.perHour : undefined });
    if (!c.ok) return this.noteFinance(o, "unmet", "margin", c.why);
    const yard = await this.breakUpYard(a, r, c.payout);
    if (typeof yard === "string") return this.noteFinance(o, "unmet", "route", yard);
    const said = o.reason || "no reason given";
    // As the dead-weight path would call her, else: idle where she lies (she takes no work while marked), or her lane finishes first,
    // as an out-of-date ship's does (work found since withdraws only an idle mark).
    this.retiring.set(id, { stage: "wanted", reason: v?.reason ?? (mz.idle ? "idle" : "obsolete"), why: `${AI_RETIRE_WHY}: ${said}`, yard: yard.yard, ship: a.name, cls: a.shipClass, rebuild, payout: c.payout, at: w.now() });
    this.deadStreaks.delete(id);
    this.retireSaid.delete(id);
    this.retireWithdrawn.delete(id);
    this.retireAction = `retiring ${a.name} (${AI_RETIRE_WHY})`;
    this.log(
      a.name,
      `${AI_RETIRE_WHY} (${said}): to be listed for sale on the Exchange at ${yard.yard}${yard.nm > 0 ? ` (${Math.round(yard.nm)} nm off, sailing empty)` : ""}${mz.idle ? "" : " once her work in hand is done"} ` +
        `(${ladderText()}: a player or the ship broker pays more than the yard), then, unsold, broken up there for ~${cr(c.payout)} (35% of her ~${cr(rebuild)} rebuild value, the worst case), ` +
        `−${cr(c.worthLoss)} of net worth at once: ${c.why}`,
    );
    this.noteFinance(o, "active");
    this.persist(true);
    a.nudge();
  }

  /**
   * An AI order to move the home port to the port it named, the fee's case its own to judge (the autopilot's own case is logged
   * beside its reason), through every hard gate of the autopilot's own move: the switch, the key and the season; never a cove;
   * our 3-real-day gap, the server's day and a back-off; that region's vault paying the fee above the floor it would keep as home;
   * presence there (a ship of ours in port, or a factor). What became of it goes back to the AI as a status.
   */
  private async aiRelocate(o: FinanceOrder): Promise<void> {
    const w = this.world;
    const now = w.now();
    const iso = (t: number) => new Date(t).toISOString();
    const target = w.port(o.ref);
    if (!target || w.isCove(target.id) || !w.isOpen(target.id)) return this.noteFinance(o, "refused", "no_presence", `${o.ref} can't be a home port (a cove, or not open)`);
    if (!this.settings.autoRelocate) return this.noteFinance(o, "refused", "switched_off", "moving the home port is off");
    if (!this.canBuild) return this.noteFinance(o, "refused", "scope", "the key lacks infra_manage (a move needs it)");
    if (w.seasonMode() !== "normal") return this.noteFinance(o, "refused", "season", "the season's endgame: the home stays where it is");
    if (this.homePort === target.id) return this.noteFinance(o, "refused", "not_needed", `the home port is ${target.id} already`);
    if (this.movedAt && Date.now() - this.movedAt < RELOCATE_GAP_MS) return this.noteFinance(o, "unmet", "too_soon", `the home moved lately: the next move from ${iso(this.movedAt + RELOCATE_GAP_MS)}`);
    if (this.nextMoveAt > now) return this.noteFinance(o, "unmet", "too_soon", `the server allows the next move from ${iso(this.nextMoveAt)}`);
    if (Date.now() < this.moveBlockedUntil) return this.noteFinance(o, "waiting", "too_soon", `the last try was refused: the next from ${iso(this.moveBlockedUntil)}`);
    // The new home's vault pays the move, above the floor it would keep as home (upkeep and the levy, and its own rent).
    const region = target.banking_region;
    await w.refreshVaults();
    const keep = Math.max(this.floorIn(region), this.homeFloor() + Math.ceil(UPKEEP_DAYS_RESERVED * (this.bills.rent.get(region) ?? 0)));
    if (w.vault(region) - keep < RELOCATE_FEE_PENCE) {
      return this.noteFinance(o, "waiting", "cash", `the ${region} vault holds ${cr(w.vault(region))}, short of the move's ${cr(RELOCATE_FEE_PENCE)} above the ${cr(keep)} it would keep as home`);
    }
    if (!(await this.homePresence()).has(target.id)) return this.noteFinance(o, "waiting", "no_presence", `no ship of ours lies at ${target.id}, nor a factor`);
    const own = this.homeCase ? this.homeCase.why : "not worked out yet";
    const res = await this.moveHome(target, `on the AI's order (${o.reason || "no reason given"}); the autopilot's own case: ${own}`);
    if (res.moved) {
      this.relocateSaid = "moved";
      return this.noteFinance(o, "done");
    }
    this.noteFinance(o, "unmet", res.code === "lost" ? "unknown_outcome" : "server", res.verdict);
  }

  /** The status code for why a ship's retiring was refused or withdrawn (retireBlocked, unmark's reason), for the AI. */
  private retireCode(why: string): OrderCode {
    if (why.includes("AI order")) return "blocked";
    if (why.includes("is off")) return "switched_off";
    if (why.includes("infra_manage")) return "scope";
    if (why.includes("season")) return "season";
    if (/couldn't be read|was refused/.test(why)) return "server";
    if (/load|work|cargo|freight|passengers|lane|at sea|convoy/.test(why)) return "cargo_aboard";
    if (/yard|reach|isn't known/.test(why)) return "route";
    return "blocked";
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
  private noteLoan(l: Loan, extra: { purpose?: string; use?: "hull" | "load"; source?: LoanRec["source"]; isMortgage?: boolean } = {}): void {
    if (typeof l.id !== "string") return;
    const role = this.isOurCompany(l.borrower_company_id) ? "borrower" : this.isOurCompany(l.lender_company_id) ? "lender" : null;
    if (!role) return;
    const prev = this.loanRecs.get(l.id);
    const t = (s: string | null | undefined) => {
      const x = Date.parse(s ?? "");
      return Number.isFinite(x) ? x : null;
    };
    // A loan made before loans by quote runs to maturity on its rate per game day; every other is annual.
    const daily = dailyBasis(l);
    this.loanRecs.set(l.id, {
      role,
      region: l.banking_region,
      principal: l.principal_pence,
      rateBps: daily ? l.daily_rate_bps : (l.annual_rate_bps ?? prev?.rateBps ?? 0),
      rateBasis: daily ? "daily" : "annual",
      repayment: l.repayment ?? prev?.repayment,
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
      refiAsked: prev?.refiAsked,
      refinanced: prev?.refinanced,
      refiLineAsked: prev?.refiLineAsked,
      // `is_mortgage` on every loan read; an event's payload without it keeps what was known.
      isMortgage: l.is_mortgage === true || extra.isMortgage === true || (typeof l.is_mortgage !== "boolean" && prev?.isMortgage === true) || undefined,
      seen: Date.now(),
    });
    if (this.loanRecs.size > LOAN_RECS_MAX) this.pruneLoanRecs();
  }

  /** A ship mortgage of ours (guide 3.4: `is_mortgage`; an event's payload without it, as its record says). */
  private isMortgage(l: Loan): boolean {
    return l.is_mortgage === true || (typeof l.is_mortgage !== "boolean" && !!this.loanRecs.get(l.id)?.isMortgage);
  }

  /**
   * Why no ship mortgage may be taken now beyond the leverage gates (guide 3.4: one at a time, a 409 while we owe on one),
   * or null: one still owed (as last read), or a mortgaged build with no answer, or one refused 409 lately.
   */
  private mortgageBusy(): string | null {
    if (this.pendingCredit.some((p) => p.kind === "borrow" && p.mortgage)) return "a mortgaged build had no answer: looking for its loan among ours first";
    const open = (this.loansCache?.loans ?? []).find((l) => this.isMortgage(l) && (l.status === "active" || l.status === "defaulted") && l.owed_pence > 0);
    if (open) return `we still owe ${cr(open.owed_pence)} on a ship mortgage (one at a time)`;
    if (Date.now() < this.mortgageBusyUntil) return "a mortgaged build was refused lately (one still owed, by the Goldsmiths' book)";
    return null;
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

  /** A Goldsmiths' loan a cheaper loan replaced: repaid in full at once (repayLoans), never refinanced again. */
  private markRefinanced(loanId: string): void {
    const rec = this.loanRecs.get(loanId);
    if (rec) this.loanRecs.set(loanId, { ...rec, refinanced: true, refiAsked: true });
  }

  /**
   * What a loan call with no answer may have borrowed (its principal): counted as owed until loan/list says. `fence`: what
   * it keeps back from spending meanwhile, a mortgaged build's only its next installments (as debtFlows fences one).
   */
  private pendingBorrowPence(fence = false): number {
    return this.pendingCredit
      .filter((p) => p.kind === "borrow" || p.kind === "approve")
      .reduce((n, p) => n + (fence && p.mortgage ? Math.min(p.principal, MORTGAGE_FENCED_INSTALLMENTS * (p.installment ?? p.principal)) : p.principal), 0);
  }

  /** What we owe on our loans now (principal and interest, as last read), with any loan call that had no answer. */
  private debtOwed(): number {
    return (this.loansCache?.loans ?? []).reduce((n, l) => n + Math.max(0, l.owed_pence), 0) + this.pendingBorrowPence();
  }

  /**
   * When a loan we owe is repaid in full by (server ms): REPAY_LEAD_DAYS before maturity; one the user took (no purpose
   * of ours) at most half its term before, so a short one isn't repaid the minute it is taken; a ship mortgage at maturity.
   */
  private repayDate(l: Loan, day: number): number | null {
    // A ship mortgage runs to maturity on its installments (guide 3.4): never repaid early.
    if (this.isMortgage(l)) return repayBy(l, day, 0);
    const term = l.term_game_days;
    const lead = this.loanRecs.get(l.id)?.purpose || !(term > 0) ? REPAY_LEAD_DAYS : Math.min(REPAY_LEAD_DAYS, term / 2);
    return repayBy(l, day, lead);
  }

  /**
   * Each loan we owe as the payments it will take (guide 3.13.1): an amortised loan's installments as they fall due (and
   * any in arrears, now: missed past its day of grace, the whole loan defaults), then the rest, owed plus interest until
   * it is repaid in full, by its repay date (repayDate; at once when defaulted or overdue). `exceptLoan`: one left out.
   * A ship mortgage still running (guide 3.4: 180 game days, never repaid early) counts only its installments due within
   * MORTGAGE_FENCE_DAYS: the later ones are the hull's own earnings' to pay (its case checked they cover them several
   * times over); the rest of it only once its maturity falls in that. At the season's endgame it is paid off as spare cash
   * allows (repayLoans), never fenced: that would stop the loads that pay it (and repaying it leaves net worth as it is).
   * Each installment is kept back REPAY_LEAD_DAYS before it falls due, as a balloon loan's repayment: cash due landing in its
   * last game days never covers one (a ship lost or a game day late misses it, and after the day of grace the whole loan
   * defaults, guide 3.13.1: a mortgaged hull arrested and taken at 80% of rebuild value, on the public record).
   */
  private debtFlows(now: number, exceptLoan?: string): Array<{ at: number; pence: number }> {
    const w = this.world;
    const day = 24 * 60 * w.gameMinuteMs;
    const out: Array<{ at: number; pence: number }> = [];
    const early = (xs: Array<{ at: number; pence: number }>) => xs.map((x) => ({ at: Math.max(now, x.at - REPAY_LEAD_DAYS * day), pence: x.pence }));
    for (const l of this.loansCache?.loans ?? []) {
      if (!(l.owed_pence > 0) || l.id === exceptLoan) continue;
      if (l.status === "active" && this.isMortgage(l)) {
        const maturity = Date.parse(l.matures_at ?? "");
        const settle = Math.max(now, Number.isFinite(maturity) ? maturity : Infinity);
        const horizon = now + MORTGAGE_FENCE_DAYS * day;
        const inst = installmentsBefore(l, now, Math.min(settle, horizon), day);
        out.push(...early(inst));
        if (settle <= horizon) out.push({ at: settle, pence: Math.max(0, owedAt(l, now, settle, day) - inst.reduce((n, x) => n + x.pence, 0)) });
        continue;
      }
      const by = this.repayDate(l, day);
      const at = l.status === "defaulted" || by === null ? now : Math.max(now, by);
      const inst = l.status === "active" ? installmentsBefore(l, now, at, day) : [];
      const paid = inst.reduce((n, x) => n + x.pence, 0);
      out.push(...early(inst), { at, pence: Math.max(0, owedAt(l, now, at, day) - paid) });
    }
    return out;
  }

  /**
   * What our loans will take to repay (a ship mortgage's next installments only: debtFlows), and the builds of commissions
   * we took and haven't delivered (their collateral rides on them) (pence): never spent on hulls, marques, patrols,
   * underwriting, lending or another commission.
   */
  private debtFence(): number {
    return this.debtFlows(this.world.now()).reduce((n, d) => n + d.pence, 0) + this.pendingBorrowPence(true) + this.commissionFence();
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
    let uncovered = this.pendingBorrowPence(true);
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
   * Whether a loan may be asked for now, and the most principal that keeps what we owe (with LOAN_INTEREST_HEADROOM for
   * its interest) within maxDebtPct of net worth (`pence`; `room`: the cap less what we owe, for a quote's own total), or
   * why not: leverage on, the key's treasury_remit, the world not paused nor the season ending, our loans read, none
   * overdue or defaulted, no repayment short, no loan call unanswered, under MAX_ACTIVE_LOANS (a mortgage aside), no idle cash of ours
   * quoted on a request, net worth read lately, no refusal lately. As last read (borrow() reads again).
   */
  private leverageRoom(): { pence: number; room: number; why: string | null } {
    const s = this.settings;
    const w = this.world;
    const no = (why: string) => ({ pence: 0, room: 0, why });
    if (!s.leverage) return no("leverage is off");
    if (!this.canRemit) return no("the key lacks treasury_remit");
    if (this.paused || this.stopRequested) return no("the world is paused");
    if (w.seasonMode() !== "normal") return no("the season is ending: no new loans");
    const c = this.loansCache;
    if (!c) return no("our loans haven't been read yet");
    const now = w.now();
    if (c.loans.some((l) => l.status === "defaulted" || (l.owed_pence > 0 && Date.parse(l.matures_at ?? "") <= now))) return no("a loan of ours is overdue or defaulted");
    if (c.loans.some((l) => l.status === "active" && (l.arrears_pence ?? 0) > 0)) return no("a loan of ours has an installment in arrears");
    if (this.debtShort) return no(`a repayment is short (${this.debtShort})`);
    if (this.pendingCredit.some((p) => p.kind === "borrow" || p.kind === "approve")) return no("a loan call had no answer: reconciling it from our loans first");
    // A ship mortgage is one at a time on its own (guide 3.4): never counted toward the instant loans' limit.
    if (c.loans.filter((l) => l.status === "active" && !this.isMortgage(l)).length >= MAX_ACTIVE_LOANS) return no(`we already owe on ${MAX_ACTIVE_LOANS} loans`);
    if (Date.now() < this.borrowRetryAt) return no("no lender fitted, or one refused, lately");
    if (w.now() < this.goldsmithsBanUntil) return no(this.goldsmithsBanText());
    // Never borrowed while our own idle cash is quoted on a request: it is taken back first (runIdleCash, soon).
    if (this.ourQuotes.size > 0 || this.pendingCredit.some((p) => p.kind === "quote")) {
      this.financeDirty = true;
      return no("our idle cash is quoted on loan requests: taking it back before borrowing");
    }
    if (!this.worth || this.worth.pence <= 0) return no("net worth isn't known yet");
    if (Date.now() - this.worth.at > 3 * WORTH_TTL_MS) return no("net worth hasn't been read lately");
    const room = (this.worth.pence * s.maxDebtPct) / 100 - this.debtOwed();
    const pence = Math.floor(room / (1 + LOAN_INTEREST_HEADROOM));
    return pence >= LOAN_MIN_PRINCIPAL_PENCE ? { pence, room, why: null } : no(`what we owe is at the ${s.maxDebtPct}%-of-net-worth cap`);
  }

  /** Why no loan while the Goldsmiths' walk-away ban lasts. */
  private goldsmithsBanText(): string {
    return `the Goldsmiths lend nothing until ${new Date(this.goldsmithsBanUntil).toISOString()} (a walk-away by us or a linked company within the last real day)`;
  }

  /**
   * 403 goldsmiths_walk_away_ban (guide 3.13.1): after any walk-away by us or one of our own or linked companies, the Goldsmiths
   * quote and lend nothing for a real day. No borrowing until the time the refusal gives (else a real day from now), logged once
   * a ban (a player lender's refinance of a loan we already owe isn't affected). Returns why, for the caller.
   */
  private noteGoldsmithsBan(e: unknown): string {
    const now = this.world.now();
    const until = isApiError(e) ? walkAwayBanEnd(e, now) : now + 24 * 3_600_000;
    const known = this.goldsmithsBanUntil > now;
    this.goldsmithsBanUntil = Math.max(this.goldsmithsBanUntil, until);
    const why = this.goldsmithsBanText();
    if (!known) this.log("fleet", `LEVERAGE: ${why}: no borrowing until then (refinancing a loan we owe through a player lender goes on)`);
    this.persist();
    return why;
  }

  /** A loan's case at the Goldsmiths' rate for the term its payback needs (the estimate before a quote: every ship gets that rate). */
  private goldsmithsCase(principal: number, paybackDays: number, returnOver: (termDays: number) => number) {
    const term = loanTerm(paybackDays) ?? LOAN_MAX_TERM_DAYS;
    return loanCase({ principal, annualBps: goldsmithsAnnualBps(term), paybackDays, returnOver, minReturnX: this.settings.minLoanReturnX });
  }

  /**
   * Our ships a lien may go on, least likely lost first (guide 3.13.1): not gone, arrested, sunk, in a convoy (or asking
   * to join one), already pledged, listed for sale or insured (a strict read: unknown counts as insured); ranked by the
   * piracy and storm losses of their lane (they sail only rated water), one at sea now after those in port. `value`: our
   * estimate of its rebuild value (hullValue). Empty when our loans or the ship listings can't be read.
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
      // Nor one being retired (housekeeping): a lien would withdraw her at the yard, often after an empty passage there.
      if (a.gone || a.arrested || !r || r.ship.status === "sunk" || r.ship.convoy_id || pledges.liened.has(a.shipId) || forSale.has(a.shipId) || this.retiring.has(a.shipId)) continue;
      // Never a smuggler or a ship with contraband aboard: her seizure would take the lender's lien with her (guide 3.18).
      if (this.smugglers.has(a.shipId) || a.contrabandAboard(r).length > 0) continue;
      if ((await a.insuredPolicy(60_000, true)) !== null) continue;
      const lane = a.lane;
      const risk = (lane ? (lane.piracyBps ?? 0) + (lane.stormBps ?? 0) : 0) + (r.ship.status === "sailing" ? 100 : 0);
      out.push({ agent: a, value: this.hullValue(a.shipClass), risk });
    }
    return out.sort((x, y) => x.risk - y.risk || y.value - x.value);
  }

  /**
   * Takes a loan of `principal` in `region` (guide 3.13.1): the Goldsmiths' instant quote (balloon) against a lien on the
   * ship of ours least likely lost that carries it (at most 40% of her rebuild value and 7,500 Cr; every ship gets the
   * same rate for a term, so the first that quotes is the cheapest), for the term its payback needs (loanCase on the
   * quote's own total), and only when it earns minLoanReturnX its interest over it and the total stays under the cap.
   * Taken at once (quotes live 6 game hours): saved as sent, and written, before accept-quote; one with no answer is
   * reconciled from loan/list by the quote's id and never sent again. A player lender may refinance it later
   * (runRequests). Hold the cash lock (the money is spent under it).
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
    if (principal > GOLDSMITHS_MAX_PRINCIPAL_PENCE) return { why: `${cr(principal)} is more than the Goldsmiths lend a loan (${cr(GOLDSMITHS_MAX_PRINCIPAL_PENCE)})` };
    const term = loanTerm(need.paybackDays);
    if (term === null) return { why: `it pays back in ~${need.paybackDays.toFixed(1)} game days: too slow for a loan of at most ${LOAN_MAX_TERM_DAYS} with half its term to spare` };
    // Every loan is repaid in full once the season's endgame starts: one that would still run then pays back too late.
    const dayMs = 24 * 60 * w.gameMinuteMs;
    if ((term - REPAY_LEAD_DAYS) * dayMs > w.seasonLeftMs() - SEASON_ENDGAME_MS) return { why: "the season's endgame starts before it would be repaid" };
    // Its case at the Goldsmiths' published rate first: no quote asked for a loan that can't pay.
    const est = this.goldsmithsCase(principal, need.paybackDays, need.returnOver);
    if (!est.ok) return { why: est.why };
    // Ships whose rebuild value (our estimate) carries the principal at the 40% cap first, each in order of risk.
    const ships = (await this.pledgeCandidates()).sort((a, b) => Number(b.value * GOLDSMITHS_LTV_BPS >= principal * 10_000) - Number(a.value * GOLDSMITHS_LTV_BPS >= principal * 10_000));
    let pick: { ship: ShipAgent; quote: GoldsmithsQuote } | null = null;
    let banned: unknown = null;
    for (const x of ships.slice(0, 3)) {
      // 400: more than the house lends against her; 409: she was liened, listed or carries a venture meanwhile; 403
      // goldsmiths_walk_away_ban: no quote for anyone of ours for a real day after a walk-away.
      const q: GoldsmithsQuote | null = await this.client.loanQuote({ principal_pence: principal, term_game_days: term, repayment: "balloon", ship_id: x.agent.shipId, banking_region: need.region }).catch((e) => {
        if (this.isFatal(e) || isApiError(e, "world_paused")) throw e;
        if (isApiError(e, WALK_AWAY_BAN)) banned = e;
        return null;
      });
      if (banned) return { why: this.noteGoldsmithsBan(banned) };
      if (!q || q.quote.principal_pence !== principal || q.quote.term_game_days !== term || q.quote.banking_region !== need.region) continue;
      pick = { ship: x.agent, quote: q };
      break;
    }
    if (!pick) {
      this.borrowRetryAt = Date.now() + BORROW_RETRY_MS;
      return {
        why: `the Goldsmiths in ${need.region} would lend ${cr(principal)} for ${term} game days on no ship of ours free to pledge (at most 40% of her rebuild value and 7,500 Cr; never one insured, listed, in a convoy or already pledged)`,
      };
    }
    const quote = pick.quote.quote;
    // The quote's own total: against the cap, and as the loan's interest in its case.
    const interest = Math.max(0, quote.total_repayable_pence - principal);
    if (principal + interest > room.room) return { why: `${cr(principal)} and its ~${cr(interest)} interest would take what we owe past ${s.maxDebtPct}% of net worth` };
    const c = loanCase({ principal, annualBps: quote.annual_rate_bps, paybackDays: need.paybackDays, returnOver: need.returnOver, minReturnX: s.minLoanReturnX, quotedInterest: interest });
    if (!c.ok) return { why: c.why };
    if (Date.parse(quote.expires_at) <= w.now()) return { why: "the Goldsmiths' quote lapsed before it could be taken" };
    const pend: PendingCredit = {
      kind: "borrow",
      at: w.now(),
      region: need.region,
      principal,
      ship: pick.ship.shipId,
      purpose: need.purpose,
      use: need.use,
      source: "goldsmiths",
      quoteId: quote.id,
      termDays: term,
      rateBps: quote.annual_rate_bps,
    };
    this.pendingCredit.push(pend);
    this.persist(true);
    await this.journal?.flush();
    try {
      const loan = await this.client.acceptLoanQuote(quote.id);
      this.pendingCredit = this.pendingCredit.filter((x) => x !== pend);
      this.noteLoan(loan, { purpose: need.purpose, use: need.use, source: "goldsmiths" });
      this.cacheLoan(loan);
      w.vaults.set(loan.banking_region, w.vault(loan.banking_region) + loan.principal_pence);
      this.loansDirty = true;
      this.financeDirty = true;
      this.log(
        "fleet",
        `borrowed ${cr(loan.principal_pence)} from the Goldsmiths' Company in ${loan.banking_region} at ${pctYear(loan.annual_rate_bps ?? quote.annual_rate_bps)} for ${loan.term_game_days} game days, balloon` +
          ` (${pick.ship.name} pledged) for ${need.purpose}: ~${cr(interest)} interest over the term against ~${cr(c.ret)} expected; repaid early from spare cash, and in full ${REPAY_LEAD_DAYS} game days before it matures` +
          `${principal >= REQUEST_MIN_PENCE ? "; a request for quotes follows, for a player lender to refinance it for less" : ""}`,
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
        this.log("fleet", `borrowing ${cr(principal)} from the Goldsmiths for ${need.purpose}: no answer (${msg}); looked for among our loans by its quote, never asked again`);
        return { why: "the loan call had no answer" };
      }
      if (isApiError(e, WALK_AWAY_BAN)) return { why: this.noteGoldsmithsBan(e) };
      this.borrowRetryAt = Date.now() + BORROW_RETRY_MS;
      this.log("fleet", `borrowing ${cr(principal)} from the Goldsmiths for ${need.purpose} was refused: ${msg}`);
      return { why: `refused: ${msg}` };
    }
  }

  /** A load short of cash at its source: for CASH_SHORT_MS the fleet needs cash, and idle cash quoted comes back soon (runIdleCash). */
  private noteCashShort(): void {
    this.cashShortAt = Date.now();
    if (this.ourQuotes.size > 0 || this.pendingCredit.some((p) => p.kind === "quote")) this.financeDirty = true;
  }

  /**
   * At a load's source (resizeLaneNow), when cash is what limits it (the hold not nearly full, the plan using the cash
   * there is): the load planned again with what a loan could add (the debt cap's room, at most LOAN_MAX_LOAD_PENCE).
   * Kept only when the bigger load's extra cash profit is at least minLoanReturnX times the loan's interest (at the
   * Goldsmiths' rate for the term its delivery needs) over that term, paid back within half of it. The loan itself is
   * asked for as the load is bought (borrowForLoad). Null: no loan.
   */
  private async leveragedLoad(agent: ShipAgent, r: ShipResult, port: string, opts: PlanOptions, pick: Lane | undefined, room: number): Promise<Lane | null> {
    // An AI order to borrow for this ship's load: its sum in place of the usual cap (every other check stands).
    const order = this.moneyOrder("borrow_load", agent.shipId);
    const spec = this.specFor(agent, r);
    const limited = !!pick && pick.tons < spec.cap * 0.9 && pick.capital >= room * 0.9;
    // Cash limits this load: the fleet needs cash, so idle cash of ours quoted on requests comes back (runIdleCash).
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
    // At most one Goldsmiths' loan (the only lender at once: a player's quote comes later, on a request).
    const extra = Math.min(lev.pence, order ? order.pence : LOAN_MAX_LOAD_PENCE, GOLDSMITHS_MAX_PRINCIPAL_PENCE);
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
    const c = this.goldsmithsCase(borrow, paybackDays, () => gain);
    if (!c.ok) {
      this.logOnceFor(`${agent.shipId}|loan|${lane.key}`, agent.name, `cash limits the load at ${port}; a loan of ${cr(borrow)} for more wouldn't pay: ${c.why}`);
      if (order) this.noteFinance(order, "unmet", "margin", c.why);
      return null;
    }
    this.log(
      agent.name,
      `cash limits the load at ${port}: planning ${loadText(lane)} to ${lane.dest} with up to ${cr(borrow)} borrowed as it is bought ` +
        `(+${cr(gain)} on the trip against ~${cr(c.interest)} interest over ${c.termDays} game days at the Goldsmiths' rate)${order ? " (the AI's order)" : ""}`,
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
   * Loans and idle cash (guide 3.13), every minute and soon after a loan event: our loans read (every pass while any are
   * out, or a quote, request or call is, else every 10 min), loan calls with no answer reconciled, net worth refreshed for
   * the cap, what we owe repaid, our refinancing requests handled, and idle cash quoted or taken back. Never while paused
   * (housekeeping stops before this).
   */
  private async runFinance(): Promise<void> {
    if (this.financeBusy) return;
    this.financeBusy = true;
    try {
      const c = this.loansCache;
      const busy =
        this.financeDirty || this.pendingCredit.length > 0 || this.ourQuotes.size > 0 || this.openRequests() > 0 || !!c?.loans.length || !!c?.lent.length;
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
      await this.runRequests();
      await this.runIdleCash();
    } finally {
      this.financeBusy = false;
      this.persist();
    }
  }

  /** Our requests for quotes still open (as last read). */
  private openRequests(): number {
    let n = 0;
    for (const r of this.ourRequests.values()) if (r.status === "open") n++;
    return n;
  }

  /**
   * A loan call with no answer, against loan/list: the loan it made (its quote's id; an older save's borrow call by the
   * same principal and region, the ship it pledged, created since) is ours and keeps what it was for; an approval's
   * replaces a Goldsmiths' loan, repaid at once. None after PENDING_CREDIT_MS: it wasn't made. Never asked again.
   */
  private reconcileBorrows(): void {
    // Given up only on a list read (successfully) PENDING_CREDIT_MS after the call: a failed read keeps the last list.
    const readAt = this.loansCache ? this.loansCache.at + this.world.skewMs : -Infinity;
    const loans = this.loansCache?.loans ?? [];
    for (const p of [...this.pendingCredit]) {
      if (p.kind !== "borrow" && p.kind !== "approve") continue;
      // A mortgaged build's loan: any mortgage of ours made since (one at a time, guide 3.4), on its ship once found.
      const hit = p.mortgage
        ? loans.find((l) => this.isMortgage(l) && (!p.ship || l.collateral_ship_id === p.ship) && Date.parse(l.created_at) >= p.at - 120_000 && !this.loanRecs.get(l.id)?.purpose)
        : p.quoteId
        ? loans.find((l) => l.quote_id === p.quoteId)
        : loans.find(
            (l) =>
              l.principal_pence === p.principal &&
              l.banking_region === p.region &&
              (!p.ship || l.collateral_ship_id === p.ship) &&
              Date.parse(l.created_at) >= p.at - 120_000 &&
              !this.loanRecs.get(l.id)?.purpose,
          );
      if (hit) {
        this.pendingCredit = this.pendingCredit.filter((x) => x !== p);
        this.noteLoan(hit, { purpose: p.purpose, use: p.use, source: p.source, isMortgage: p.mortgage });
        if (p.kind === "approve" && p.replaces) {
          this.markRefinanced(p.replaces);
          if (p.requestId) this.ourRequests.delete(p.requestId);
        }
        this.log(
          "fleet",
          p.mortgage
            ? `the ship mortgage of ${cr(hit.principal_pence)} whose build had no answer was taken with it after all${p.purpose ? ` (for ${p.purpose})` : ""}: its installments run every ${MORTGAGE_INSTALLMENT_DAYS} game days`
            : `the loan of ${cr(p.principal)} whose call had no answer was taken after all${p.purpose ? ` (for ${p.purpose})` : ""}: ` +
                `${p.kind === "approve" ? "the Goldsmiths' loan it refinances is repaid now" : "repaid like any other"}`,
        );
      } else if (readAt - p.at > PENDING_CREDIT_MS) {
        this.pendingCredit = this.pendingCredit.filter((x) => x !== p);
        this.log(
          "fleet",
          p.mortgage
            ? `the ship mortgage${p.purpose ? ` for ${p.purpose}` : ""} whose build had no answer isn't among our loans ${Math.round(PENDING_CREDIT_MS / 60_000)} min on: it wasn't taken (build and mortgage stand or fall together)`
            : `the loan of ${cr(p.principal)} whose call had no answer isn't among our loans ${Math.round(PENDING_CREDIT_MS / 60_000)} min on: it wasn't taken`,
        );
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
   * Our own net-worth estimate (guide 3.17), on the low side: vaults and escrow, our hulls at their rebuild value (hullValue),
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
      // Contraband aboard counts at base in net worth (goods in holds, guide 3.17), though no lawful market takes it.
      for (const [g, t] of a.contrabandAboard(r)) n += t * w.basePrice(g);
    }
    for (const wh of warehouses ?? []) for (const i of wh.inventory ?? []) n += i.quantity * w.basePrice(i.commodity_id);
    for (const l of this.loansCache?.loans ?? []) n -= Math.max(0, l.owed_pence);
    for (const l of this.loansCache?.lent ?? []) n += Math.max(0, l.owed_pence);
    return Math.round(n);
  }

  /**
   * Repays what we owe (guide 3.13.1: arrears first, then interest to date, then principal, from the loan's region). In
   * full once a loan reaches its repay date (repayDate: REPAY_LEAD_DAYS before maturity, half the term for a short one the
   * user took), defaulted (its claim: paying it frees an arrested ship) or the season is ending; an installment in arrears
   * (within its day of grace: missed, the whole loan defaults) is paid at once; both remit from every region's spare, and
   * short, debtShort stops new spending (loads, hulls, marques, lending) until paid. A Goldsmiths' loan a cheaper one
   * replaced is repaid in full at once. Otherwise (loans the autopilot took) early, dearest annual rate first, from spare
   * cash beyond what the fleet's loads are bound to buy, while no ship waits for cash to load (when one does, the cash
   * works and loads never spend what the repayment counts on: cashFlows); remitted for it only when the interest saved by
   * the repay date beats the fee. A repayment with no answer leaves its loan alone until our loans are read again. A ship
   * mortgage (guide 3.4) runs on the installments the server collects: paid by us only in arrears, defaulted or as the
   * season ends, never early (nor on the AI's order).
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
        const arrears = l.status === "active" ? Math.max(0, l.arrears_pence ?? 0) : 0;
        // A ship mortgage (guide 3.4) runs on its installments, collected by the server: repaid by us only in arrears,
        // defaulted, or as the season ends. Then (still running) only as spare cash allows (`payoff`): the game never asks
        // it repaid by the season's end, and repaying leaves net worth as it is, so a shortfall never stops the loads (debtShort).
        const mortgage = this.isMortgage(l);
        const payoff = mortgage && ending && l.status === "active";
        const allDue = l.status === "defaulted" || (ending && !payoff) || (!mortgage && by !== null && now >= by);
        const refi = !allDue && !mortgage && !!this.loanRecs.get(l.id)?.refinanced;
        return { l, by, arrears, allDue, must: allDue || arrears > 0, refi, mortgage, payoff };
      })
      .sort((a, b) => Number(b.must) - Number(a.must) || Number(b.refi) - Number(a.refi) || annualBpsOf(b.l) - annualBpsOf(a.l) || (a.by ?? Infinity) - (b.by ?? Infinity));
    // A ship waiting for cash to load: early repayment waits (the loads earn more than the interest saved).
    const scarce = [...this.agents.values()].some((a) => a.waitingForCash);
    let short: string | null = null;
    const did: string[] = [];
    for (const { l, by, arrears, allDue, must, refi, mortgage, payoff } of rows) {
      if ((this.repayHold.get(l.id) ?? 0) > Date.now()) continue;
      // Early only on loans the autopilot took (one the user took is theirs to repay before its repay date), and
      // not in the first minutes (its hull's or load's purchases come first); or one the AI orders repaid (never while
      // a ship waits for cash); or one refinanced (its replacement's cash is there for it). Never a ship mortgage.
      const ordered = repayOrders.find((o) => o.ref === l.id);
      if (mortgage && !must && !payoff) {
        if (ordered) this.noteFinance(ordered, "refused", "not_needed", "a ship mortgage runs on its installments: the autopilot never repays one early");
        continue;
      }
      if (!must && !refi && ordered && scarce) this.noteFinance(ordered, "waiting", "cash", "a ship waits for cash to load");
      if (!must && !refi && (scarce || (!payoff && !ordered && (!this.loanRecs.get(l.id)?.purpose || now - Date.parse(l.disbursed_at ?? l.created_at) < LOAN_EARLY_GRACE_MS)))) continue;
      const res = await this.withCash(async (): Promise<string | null> => {
        if (this.stopRequested || this.paused) return null;
        await w.refreshVaults();
        const region = l.banking_region;
        // A game day's interest more covers the whole sum whenever in the day the call lands.
        const full = owedAt(l, now, now + day, day);
        // In arrears only: the installment fallen due (a payment counts first toward it); otherwise everything.
        const need = must && !allDue ? Math.min(full, arrears) : full;
        let amount: number;
        if (must || refi) {
          amount = Math.min(need, await this.ensureCash(region, need, { fresh: true }));
        } else {
          let committed = 0;
          for (const a of this.agents.values()) committed += this.committedBy(a);
          const want = Math.min(full, Math.max(0, this.spareCash() - committed));
          const inRegion = Math.max(0, w.vault(region) - this.floorIn(region));
          const fee = Math.min(Infinity, ...[...w.vaults.keys()].filter((r) => r !== region).map((r) => w.remitBps(r, region)));
          const daysLeft = by === null ? 0 : Math.max(0, (by - now) / day);
          amount = want <= inRegion || !(perDayBps(l) * daysLeft > fee) ? Math.min(want, inRegion) : Math.min(want, await this.ensureCash(region, want, { fresh: true }));
        }
        const all = amount >= full;
        if (!all && amount < Math.min(need, l.owed_pence, MIN_REPAY_PENCE)) {
          if (ordered && !must) this.noteFinance(ordered, "waiting", "cash", "no spare cash after the fleet's loads");
          return must
            ? allDue
              ? `${cr(l.owed_pence)} due in ${region}${by !== null ? ` by ${new Date(by).toISOString()}` : ""}, only ${cr(Math.max(0, amount))} to hand`
              : `an installment of ${cr(arrears)} in arrears in ${region}${l.arrears_due_by ? ` (the loan defaults after ${l.arrears_due_by})` : ""}, only ${cr(Math.max(0, amount))} to hand`
            : null;
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
          const why = allDue
            ? l.status === "defaulted" ? " (its claim, after a default)" : ending ? " (the season is ending)" : " (due: its repay date before maturity)"
            : must ? " (an installment in arrears: unpaid past its day of grace, the whole loan defaults)"
            : refi ? " (a cheaper loan from a player lender replaced it)"
            : payoff ? " (the season is ending: a ship mortgage paid off as spare cash allows)"
            : ` early, from spare cash${ordered ? " (the AI's order)" : ""}`;
          this.log("fleet", `repaid ${pay === undefined ? "in full" : cr(pay)} on a loan of ${cr(l.principal_pence)} in ${region}${rec?.purpose ? ` (for ${rec.purpose})` : ""}${left > 0 ? `; ${cr(left)} still owed` : ""}${why}`);
          if (ordered) this.noteFinance(ordered, left > 0 ? "active" : "done");
          this.persist(true);
          if (!must) return null;
          if (allDue) return left > 0 ? `${cr(left)} still owed in ${region}` : null;
          return (after.arrears_pence ?? 0) > 0 ? `${cr(after.arrears_pence)} of an installment still in arrears in ${region}` : null;
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
      this.log("fleet", `WARNING: a loan payment due can't be made in full yet (${short}): no new loads, hulls, marques or lending until it is; remitting to its region`);
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
    const mortgaged = rows.some((x) => x.mortgage && x.l.status === "active") ? "; a ship mortgage runs on its installments" : "";
    this.financeAction =
      did.length ? `${did.join(", ")}; ${cr(owed)} owed`
      : short ? `short: ${short}`
      : scarce ? `${cr(owed)} owed: a ship waits for cash, so it works until the repay date (2 game days before maturity)${mortgaged}`
      : `${cr(owed)} owed (repaid in full by 2 game days before maturity${mortgaged})`;
  }

  /**
   * Our requests for quotes (guide 3.13.2), posted to refinance the Goldsmiths' loans the autopilot took: our own read
   * while any is open (or a post had no answer, or a lender quoted lately); a quote cheaper than the Goldsmiths' rate for
   * the same terms (and the loan it replaces), from a company not ours, approved while that loan is still owed and the
   * saving over what is left of it is worth it (refinance), the old loan then repaid from it; then one request posted for
   * a Goldsmiths' loan of ours that has none (postRefiRequest). A request nobody beats just lapses.
   */
  private async runRequests(): Promise<void> {
    if (this.openRequests() > 0 || this.pendingCredit.some((p) => p.kind === "request") || this.requestsDirty) {
      const mine = await this.client.loanRequests({ mine: true, limit: 50 }).catch((e) => {
        if (this.isFatal(e) || isApiError(e, "world_paused")) throw e;
        return null;
      });
      if (mine) {
        this.requestsDirty = false;
        this.noteOurRequests(mine);
      }
    }
    await this.refinance();
    await this.postRefiRequest();
  }

  /** Our requests as `loan/requests?mine=true` lists them (newest first, any status): records updated, a post with no answer adopted or given up. */
  private noteOurRequests(mine: LoanRequestView[]): void {
    const w = this.world;
    this.requestsMine = { at: Date.now(), list: mine };
    for (const r of mine) {
      if (!this.ourRequests.has(r.id)) {
        // A post with no answer: ours if listed (same terms and pledge, created since), never posted again.
        const p = this.pendingCredit.find(
          (x) =>
            x.kind === "request" &&
            x.principal === r.principal_pence &&
            x.termDays === r.term_game_days &&
            x.region === r.banking_region &&
            (!x.ship || r.collateral_ship_id === x.ship) &&
            Date.parse(r.created_at) >= x.at - 120_000,
        );
        if (!p?.replaces) continue;
        this.pendingCredit = this.pendingCredit.filter((x) => x !== p);
        this.ourRequests.set(r.id, { region: r.banking_region, principal: r.principal_pence, termDays: r.term_game_days, ship: r.collateral_ship_id ?? null, replaces: p.replaces, status: r.status, expiresAt: null, at: p.at, quotes: 0, bestBps: null });
        this.log("fleet", `the request for quotes whose call had no answer was posted after all (${cr(r.principal_pence)} in ${r.banking_region})`);
      }
      const rec = this.ourRequests.get(r.id)!;
      const open = (r.quotes ?? []).filter((q) => q.status === "open" && !this.isOurCompany(q.lender_company_id));
      const rates = open.map((q) => q.annual_rate_bps);
      this.ourRequests.set(r.id, { ...rec, status: r.status, expiresAt: Date.parse(r.expires_at) || null, quotes: open.length, bestBps: rates.length ? Math.min(...rates) : null });
    }
    // Closed (funded by our approval, lapsed, withdrawn), or gone from the list and past its time: no longer ours to watch.
    const listed = new Set(mine.map((r) => r.id));
    for (const [id, r] of [...this.ourRequests]) {
      if (r.status !== "open" || (!listed.has(id) && r.expiresAt !== null && w.now() > r.expiresAt)) this.ourRequests.delete(id);
    }
    const readAt = w.now();
    for (const p of [...this.pendingCredit]) {
      if (p.kind === "request" && readAt - p.at > PENDING_CREDIT_MS) {
        this.pendingCredit = this.pendingCredit.filter((x) => x !== p);
        this.log("fleet", `the request for quotes whose call had no answer isn't among ours ${Math.round(PENDING_CREDIT_MS / 60_000)} min on: it wasn't posted`);
      }
    }
  }

  /**
   * Approves the quote on one of our requests that saves most against the Goldsmiths' loan it would replace (refinance),
   * within every gate a new loan has but the count and the cap (it replaces one loan with a cheaper one): leverage on,
   * the key's treasury_remit, not paused nor the season ending, no repayment short, no loan call unanswered, our loans
   * read afresh with the old one still owed as it was. Under the cash lock; the old loan is repaid from the proceeds at
   * once (else repayLoans does it first). Saved as sent before approve; one with no answer is reconciled by its quote id.
   */
  private async refinance(): Promise<void> {
    const w = this.world;
    if (!this.settings.leverage || !this.canRemit || this.paused || this.stopRequested || Date.now() < this.refiRetryAt) return;
    // On our requests as just read (a failed read keeps the last list: never approved on that).
    if (w.seasonMode() !== "normal" || this.debtShort || !this.requestsMine || Date.now() - this.requestsMine.at > 2 * 60_000) return;
    if (this.pendingCredit.some((p) => p.kind === "borrow" || p.kind === "approve")) return;
    const c = this.loansCache;
    if (!c) return;
    const now = w.now();
    const day = 24 * 60 * w.gameMinuteMs;
    type Cand = { requestId: string; req: OurRequest; quoteId: string; rate: number; principal: number; term: number; old: Loan; saving: number; gsBps: number };
    let best: Cand | null = null;
    for (const view of this.requestsMine.list) {
      const req = this.ourRequests.get(view.id);
      if (!req || view.status !== "open") continue;
      const old = c.loans.find((l) => l.id === req.replaces && l.status === "active" && l.owed_pence > 0 && !(l.arrears_pence > 0));
      if (!old || this.loanRecs.get(old.id)?.refinanced) continue;
      const by = this.repayDate(old, day);
      const daysLeft = by === null ? 0 : (by - now) / day;
      if (daysLeft < 1) continue;
      const oldBps = annualBpsOf(old);
      for (const q of view.quotes ?? []) {
        if (q.status !== "open" || this.isOurCompany(q.lender_company_id) || Date.parse(q.expires_at) <= now) continue;
        // A swap, never new debt: more than the old loan still owes would skip the debt cap and the return test.
        if (q.principal_pence > old.owed_pence) continue;
        // Cheaper than the Goldsmiths' rate for these terms and than the loan it replaces, and worth the trouble.
        if (!(q.annual_rate_bps < Math.min(oldBps, view.goldsmiths_rate_bps))) continue;
        // Its repay date before the season's endgame starts, as for any new loan.
        if ((q.term_game_days - REPAY_LEAD_DAYS) * day > w.seasonLeftMs() - SEASON_ENDGAME_MS) continue;
        const saving = Math.floor((Math.max(0, old.outstanding_principal_pence) * (oldBps - q.annual_rate_bps) * daysLeft) / (10_000 * 360));
        if (saving < REFI_MIN_SAVING_PENCE || (best && best.saving >= saving)) continue;
        best = { requestId: view.id, req, quoteId: q.id, rate: q.annual_rate_bps, principal: q.principal_pence, term: q.term_game_days, old, saving, gsBps: view.goldsmiths_rate_bps };
      }
    }
    if (!best) return;
    const pick = best;
    const rec = this.loanRecs.get(pick.old.id);
    await this.withCash(async () => {
      if (this.stopRequested || this.paused || !this.settings.leverage) return;
      // Our loans afresh: the old loan still owed as it was (repaid, defaulted or refinanced meanwhile: nothing to do).
      const asked = Date.now();
      const read = await this.readLoans(0);
      if (!read || read.at < asked) return;
      const old = read.loans.find((l) => l.id === pick.old.id && l.status === "active" && l.owed_pence > 0);
      // Repaid down since the quote came: approving it now would borrow more than it clears.
      if (!old || this.loanRecs.get(old.id)?.refinanced || pick.principal > old.owed_pence) return;
      const pend: PendingCredit = {
        kind: "approve",
        at: w.now(),
        region: pick.req.region,
        principal: pick.principal,
        ship: pick.req.ship ?? undefined,
        purpose: rec?.purpose,
        use: rec?.use,
        source: "request",
        quoteId: pick.quoteId,
        requestId: pick.requestId,
        replaces: old.id,
        termDays: pick.term,
        rateBps: pick.rate,
      };
      this.pendingCredit.push(pend);
      this.persist(true);
      await this.journal?.flush();
      let loan: Loan;
      try {
        loan = await this.client.approveLoanQuote(pick.quoteId);
      } catch (e) {
        const unknown = outcomeUnknown(e);
        if (!unknown) {
          this.pendingCredit = this.pendingCredit.filter((x) => x !== pend);
          this.persist();
        }
        if (this.isFatal(e) || isApiError(e, "world_paused")) throw e;
        if (unknown) {
          this.loansDirty = true;
          this.log("fleet", `approving a quote on our request (${pick.requestId.slice(0, 8)}): no answer (${(e as Error).message}); looked for among our loans by its quote, never sent again`);
          return;
        }
        // The quote or request closed, or the pledge isn't free any more: read our requests again; a refusal waits a while.
        this.requestsDirty = true;
        this.refiRetryAt = Date.now() + IDLE_RETRY_MS;
        this.log("fleet", `approving a quote on our request (${pick.requestId.slice(0, 8)}) was refused: ${(e as Error).message}`);
        return;
      }
      this.pendingCredit = this.pendingCredit.filter((x) => x !== pend);
      this.noteLoan(loan, { purpose: rec?.purpose, use: rec?.use, source: "request" });
      this.cacheLoan(loan);
      w.vaults.set(loan.banking_region, w.vault(loan.banking_region) + loan.principal_pence);
      this.ourRequests.delete(pick.requestId);
      this.markRefinanced(old.id);
      this.loansDirty = true;
      this.financeDirty = true;
      this.log(
        "fleet",
        `refinanced: approved a player lender's quote of ${cr(loan.principal_pence)} at ${pctYear(loan.annual_rate_bps ?? pick.rate)} for ${loan.term_game_days} game days ` +
          `(the Goldsmiths charge ${pctYear(pick.gsBps)}) on our request${rec?.purpose ? ` (for ${rec.purpose})` : ""}; repaying the Goldsmiths' loan from it now (~${cr(pick.saving)} less interest)`,
      );
      this.persist(true);
      // The old loan repaid from the proceeds now (they landed in its region); left owed, repayLoans repays it first.
      const full = owedAt(old, w.now(), w.now() + day, day);
      const have = await this.ensureCash(old.banking_region, full);
      if (have < Math.min(old.owed_pence, MIN_REPAY_PENCE)) return;
      try {
        const after = await this.client.repayLoan(old.id, have >= full ? undefined : Math.floor(Math.min(have, old.owed_pence)));
        this.noteLoan(after);
        this.cacheLoan(after);
        this.log("fleet", `repaid ${have >= full ? "in full" : cr(Math.floor(have))} on the Goldsmiths' loan of ${cr(old.principal_pence)} the cheaper loan replaced${after.owed_pence > 0 ? `; ${cr(after.owed_pence)} still owed` : ""}`);
      } catch (e) {
        if (this.isFatal(e) || isApiError(e, "world_paused")) throw e;
        if (outcomeUnknown(e)) this.repayHold.set(old.id, Date.now() + REPAY_HOLD_MS);
        this.log("fleet", `repaying the refinanced Goldsmiths' loan (${old.id.slice(0, 8)}) failed: ${(e as Error).message}; tried again with the next repayments`);
      }
      this.loansDirty = true;
      await w.refreshVaults().catch((e) => {
        if (this.isFatal(e)) throw e;
      });
      this.persist(true);
    });
  }

  /**
   * One request for quotes a pass (guide 3.13.2) for a Goldsmiths' loan the autopilot took that has none, still owed with 2 game days
   * or more before its repay date: asked once of player lenders when it is REQUEST_MIN_PENCE or more and a quote at the request's
   * floor (a tenth of the Goldsmiths' rate) could save REFI_MIN_SAVING_PENCE; and asked once more (or first) when a bank's lending
   * line covers it (guide 3.13.8: it quotes the moment a matching request is posted) at a rate, its share of the Goldsmiths' rate for
   * the term, that saves that much. Its outstanding principal, balloon, for the days left to the old loan's maturity, pledging a free
   * ship of ours (the loan's own is liened): the least risky, or with a line the least risky whose rebuild value carries the principal
   * at that line's loan-to-value (the cheapest such line); with recourse, open REQUEST_OPEN_GAME_H. Nothing is escrowed. Our requests
   * are read again at once after a post (a line's quote is weighed by refinance within the minute, and taken only if strictly under
   * the Goldsmiths' rate and saving enough). Saved as sent; one with no answer is looked for among ours. No other ship free to pledge:
   * nothing posted (the player lenders' ask counts as had; a line's is looked at again after IDLE_RETRY_MS), and the next loan's turn.
   */
  private async postRefiRequest(): Promise<void> {
    const w = this.world;
    if (!this.settings.leverage || !this.canRemit || this.paused || this.stopRequested || Date.now() < this.refiRetryAt) return;
    if (w.seasonMode() !== "normal" || this.debtShort || this.pendingCredit.some((p) => p.kind === "request")) return;
    const c = this.loansCache;
    if (!c) return;
    const now = w.now();
    const day = 24 * 60 * w.gameMinuteMs;
    const asked = new Set([...this.ourRequests.values()].map((r) => r.replaces));
    // Read only once some loan could use them: the pledges, and our own credit record (a line's filters; cached).
    let ships: Array<{ agent: ShipAgent; value: number; risk: number }> | null = null;
    let credit: CreditReport | null | undefined;
    let pick: { loan: Loan; rec: LoanRec; term: number; ship: ShipAgent; line: LendingLine | null; lineBps: number | null } | null = null;
    for (const l of c.loans) {
      const rec = this.loanRecs.get(l.id);
      // Never a ship mortgage: it runs its term on its installments (guide 3.4).
      if (l.status !== "active" || !(l.owed_pence > 0) || !rec?.purpose || rec.source !== "goldsmiths" || rec.refinanced || rec.refiLineAsked || asked.has(l.id) || this.isMortgage(l)) continue;
      if ((this.refiNoShip.get(l.id) ?? 0) > Date.now()) continue;
      const by = this.repayDate(l, day);
      const daysLeft = by === null ? 0 : (by - now) / day;
      if (daysLeft < 2) continue;
      const principal = l.outstanding_principal_pence;
      const oldBps = annualBpsOf(l);
      const saves = (bps: number) => (Math.max(0, principal) * (oldBps - bps) * daysLeft) / (10_000 * 360);
      const maturity = Date.parse(l.matures_at ?? "");
      const term = Math.min(LOAN_MAX_TERM_DAYS, Math.max(1, Number.isFinite(maturity) ? Math.ceil((maturity - now) / day) : l.term_game_days));
      // Player lenders, once a loan: a quote at the request's floor could save enough.
      const board = !rec.refiAsked && principal >= REQUEST_MIN_PENCE && saves(oldBps * 0.1) >= REFI_MIN_SAVING_PENCE;
      // A bank's line covering it (cheapest first), strictly under the Goldsmiths' rate and saving enough at its rate for the term.
      const gsBps = goldsmithsAnnualBps(term);
      const lineBps = (x: LendingLine) => Math.ceil((gsBps * x.rate_pct_of_goldsmiths_bps) / 10_000);
      let lines = (await this.lendingLinesIn(l.banking_region)).filter((x) => x.rate_pct_of_goldsmiths_bps < 10_000 && saves(lineBps(x)) >= REFI_MIN_SAVING_PENCE);
      if (lines.length) {
        if (credit === undefined) credit = w.companyId ? await this.creditOf(w.companyId) : null;
        lines = lines.filter((x) => this.lineCovers(x, l.banking_region, principal, term, credit ?? null, now, day)).sort((a, b) => a.rate_pct_of_goldsmiths_bps - b.rate_pct_of_goldsmiths_bps);
      }
      if (!board && lines.length === 0) continue;
      ships ??= await this.pledgeCandidates();
      const free = ships.filter((x) => x.agent.shipId !== l.collateral_ship_id);
      if (free.length === 0) {
        // Nothing posted. The player lenders' one ask counts as had (as it always did); a line's ask waits for a ship to come free
        // (another loan repaid, a convoy or a policy ended: a while, not for good), and the next loan, perhaps with one free, has its turn.
        if (board) {
          this.loanRecs.set(l.id, { ...rec, refiAsked: true });
          this.persist();
        }
        this.refiNoShip.set(l.id, Date.now() + IDLE_RETRY_MS);
        if (this.refiNoShip.size > 50) this.refiNoShip.delete(this.refiNoShip.keys().next().value!);
        this.logOnceFor(
          `refi-noship|${l.id}|${lines.length ? "line" : "board"}`,
          "fleet",
          `no request for quotes to refinance the Goldsmiths' loan for ${rec.purpose}: no other ship of ours free to pledge${lines.length ? " (a lending line covers it: asked once one is)" : ""}`,
        );
        continue;
      }
      // The cheapest covering line a free ship of ours carries at its loan-to-value (her rebuild value: her class and guns), least risky first.
      let fit: { line: LendingLine; ship: ShipAgent } | null = null;
      for (const line of lines) {
        const ship = free.find((x) => principal <= ((x.agent.last ? this.rebuildOf(x.agent, x.agent.last) : x.value) * line.max_ltv_bps) / 10_000);
        if (ship) {
          fit = { line, ship: ship.agent };
          break;
        }
      }
      if (!board && !fit) continue;
      pick = { loan: l, rec, term, ship: fit?.ship ?? free[0].agent, line: fit?.line ?? null, lineBps: fit ? lineBps(fit.line) : null };
      break;
    }
    if (!pick) return;
    const { loan, rec, term, ship, line } = pick;
    // Asked once, whatever comes of it (and against a line, never again).
    this.loanRecs.set(loan.id, { ...rec, refiAsked: true, ...(line ? { refiLineAsked: true } : {}) });
    const principal = loan.outstanding_principal_pence;
    const region = loan.banking_region;
    const pend: PendingCredit = { kind: "request", at: now, region, principal, ship: ship.shipId, purpose: rec.purpose, use: rec.use, termDays: term, replaces: loan.id };
    this.pendingCredit.push(pend);
    this.persist(true);
    await this.journal?.flush();
    try {
      const r = await this.client.postLoanRequest({
        banking_region: region,
        principal_pence: principal,
        term_game_days: term,
        repayment: "balloon",
        collateral_kind: "ship_lien",
        ship_id: ship.shipId,
        recourse: true,
        open_game_hours: REQUEST_OPEN_GAME_H,
        // The banks' lending lines (and the Goldsmiths, never under their own rate) may quote on it at once (guide 3.13.8).
        auto_quote: true,
      });
      this.pendingCredit = this.pendingCredit.filter((x) => x !== pend);
      this.ourRequests.set(r.id, { region, principal, termDays: term, ship: ship.shipId, replaces: loan.id, status: r.status, expiresAt: Date.parse(r.expires_at) || null, at: now, quotes: 0, bestBps: null });
      // A covering line quotes at once (guide 3.13.8): our requests are read again within the minute, so its quote is weighed (and
      // approved by refinance if it saves enough) well before its 6 game hours run out.
      this.requestsDirty = true;
      this.financeDirty = true;
      this.log(
        "fleet",
        `asked for quotes: ${cr(principal)} in ${region} for ${term} game days, balloon, ${ship.name} pledged, with recourse, open ${REQUEST_OPEN_GAME_H} game hours ` +
          `(the Goldsmiths charge ${pctYear(r.goldsmiths_rate_bps)}): a cheaper quote refinances the Goldsmiths' loan for ${rec.purpose}` +
          `${line ? `; ${line.bank_name}'s lending line (${Math.round(line.rate_pct_of_goldsmiths_bps / 100)}% of the Goldsmiths' rate, ~${pctYear(pick.lineBps ?? 0)}) covers it and should quote at once` : ""}`,
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
        this.requestsDirty = true;
        this.log("fleet", `the request for quotes for ${rec.purpose} had no answer (${(e as Error).message}); looked for among ours, never posted again`);
        return;
      }
      this.refiRetryAt = Date.now() + IDLE_RETRY_MS;
      this.log("fleet", `the request for quotes for ${rec.purpose} was refused: ${(e as Error).message}`);
    }
  }

  /**
   * The open lending lines in a region (guide 3.13.8: cheapest share of the Goldsmiths' rate first), read at most every
   * LINES_TTL_GAME_H (sooner after a `lending_line_posted` notice); a failed read keeps the last (none at first).
   */
  private async lendingLinesIn(region: BankingRegion): Promise<LendingLine[]> {
    const seen = this.linesSeen.get(region);
    if (seen && Date.now() - seen.at < LINES_TTL_GAME_H * this.gameHourMs) return seen.lines;
    const lines = await this.client.lendingLines({ banking_region: region }).catch((e) => {
      if (this.isFatal(e) || isApiError(e, "world_paused")) throw e;
      return null;
    });
    const kept = Array.isArray(lines) ? lines.filter((x) => x && typeof x.id === "string") : (seen?.lines ?? []);
    this.linesSeen.set(region, { at: Date.now(), lines: kept });
    return kept;
  }

  /**
   * Whether a bank's open lending line (guide 3.13.8) plausibly covers a ship-lien request of ours for `principal` over `term` game
   * days, balloon, with recourse: it lends in that region against ship liens on balloon repayment, the principal is within its range
   * and its room (what the line has left, and what it may still lend our player's companies beyond its bank's loans to us now), the
   * term within its longest; never a bank of ours (a line never quotes on its own bank's requests, and ours aren't approved); and our
   * credit record within its filters (`credit`, ours alone: the server sums it with our linked companies', so this is a lower bound;
   * unread, taken to pass, since a post costs nothing). The loan-to-value on the pledged ship is the caller's.
   */
  private lineCovers(line: LendingLine, region: BankingRegion, principal: number, term: number, credit: CreditReport | null, now: number, day: number): boolean {
    if (line.status !== "open" || this.isOurCompany(line.bank_company_id)) return false;
    if (!line.regions.includes(region) || !line.collateral_kinds.includes("ship_lien") || !line.repayments.includes("balloon")) return false;
    if (principal < line.min_principal_pence || principal > line.max_principal_pence || principal > line.remaining_capacity_pence) return false;
    if (term > line.max_term_game_days) return false;
    const owedToBank = (this.loansCache?.loans ?? [])
      .filter((x) => x.lender_company_id === line.bank_company_id && (x.status === "active" || x.status === "defaulted"))
      .reduce((n, x) => n + Math.max(0, x.outstanding_principal_pence), 0);
    if (owedToBank + principal > line.max_per_borrower_pence) return false;
    if (credit) {
      if (line.max_defaults != null && credit.loans_defaulted > line.max_defaults) return false;
      if (credit.loans_walked_away > (line.max_walk_aways ?? 0)) return false;
      if (line.max_owed_pence != null && credit.active_owed_pence > line.max_owed_pence) return false;
      if (credit.loans_repaid < (line.min_loans_repaid ?? 0)) return false;
      const last = Date.parse(credit.last_default_at ?? "");
      if (line.no_default_within_game_days != null && Number.isFinite(last) && now - last < line.no_default_within_game_days * day) return false;
    }
    return true;
  }

  /** A region's open loan requests (oldest first), read at most every `maxAgeMs`; a failed read gives null (the last read is not reused). */
  private async readRequests(region: BankingRegion, maxAgeMs: number): Promise<LoanRequestView[] | null> {
    const seen = this.requestsSeen.get(region);
    if (seen && Date.now() - seen.at < maxAgeMs) return seen.requests;
    const list = await this.client.loanRequests({ banking_region: region }).catch((e) => {
      if (this.isFatal(e) || isApiError(e, "world_paused")) throw e;
      return null;
    });
    if (list) this.requestsSeen.set(region, { at: Date.now(), requests: list });
    return list;
  }

  /** A borrower's public credit record (guide 3.13.7), read at most every CREDIT_TTL_MS; null: unreadable. */
  private async creditOf(companyId: string): Promise<CreditReport | null> {
    const seen = this.creditSeen.get(companyId);
    if (seen && Date.now() - seen.at < CREDIT_TTL_MS) return seen.report;
    const report = await this.client.creditReport(companyId).catch((e) => {
      if (this.isFatal(e) || isApiError(e, "world_paused")) throw e;
      return null;
    });
    if (report) this.creditSeen.set(companyId, { at: Date.now(), report });
    if (this.creditSeen.size > 200) {
      for (const [id, x] of this.creditSeen) if (Date.now() - x.at > CREDIT_TTL_MS) this.creditSeen.delete(id);
    }
    return report;
  }

  /**
   * Our quotes as their region's open requests show them: one no longer standing on an open request was approved (a loan we
   * made, with its quote's id) or released or withdrawn; a quote call with no answer is ours if the request shows one of
   * ours it didn't, else not made once PENDING_CREDIT_MS is up (never quoted twice).
   */
  private noteOurQuotes(region: BankingRegion, reqs: LoanRequestView[]): void {
    const w = this.world;
    const me = w.companyId;
    const mine = new Map<string, { q: LoanRequestView["quotes"][number]; r: LoanRequestView }>();
    for (const r of reqs) for (const q of r.quotes ?? []) if (me && q.lender_company_id === me) mine.set(q.id, { q, r });
    for (const [id, o] of [...this.ourQuotes]) {
      if (o.region !== region) continue;
      const hit = mine.get(id);
      if (hit && hit.q.status === "open") {
        this.ourQuotes.set(id, { ...o, expiresAt: Date.parse(hit.q.expires_at) || o.expiresAt });
        continue;
      }
      this.ourQuotes.delete(id);
      const lent = (this.loansCache?.lent ?? []).some((l) => l.quote_id === id);
      this.log("fleet", `idle cash: our quote of ${cr(o.principal)} in ${region} ${lent ? "was approved: lent, secured, with recourse" : "no longer stands (released or lapsed): its escrow is back"}`);
    }
    for (const p of [...this.pendingCredit]) {
      if (p.kind !== "quote" || p.region !== region) continue;
      const hit = [...mine.values()].find((x) => x.r.id === p.requestId && !this.ourQuotes.has(x.q.id));
      if (hit && hit.q.status === "open") {
        this.pendingCredit = this.pendingCredit.filter((x) => x !== p);
        this.ourQuotes.set(hit.q.id, { region, requestId: hit.r.id, borrower: hit.r.borrower_company_id, principal: hit.q.principal_pence, rateBps: hit.q.annual_rate_bps, termDays: hit.q.term_game_days, expiresAt: Date.parse(hit.q.expires_at) || null, at: Date.now() });
        this.log("fleet", `idle cash: the quote whose call had no answer stands after all (${cr(hit.q.principal_pence)} at ${pctYear(hit.q.annual_rate_bps)})`);
      } else if (w.now() - p.at > PENDING_CREDIT_MS) {
        this.pendingCredit = this.pendingCredit.filter((x) => x !== p);
        this.log("fleet", `idle cash: the quote whose call had no answer isn't on its request: taken as not made (or approved at once)`);
      }
    }
  }

  /**
   * Idle cash (guide 3.13.2): spare cash beyond the fleet's loads, our loans and IDLE_BUFFER_PENCE that has had nothing to
   * fund for IDLE_SETTLE_GAME_H is quoted on players' open requests (quoteIdle): secured, with recourse, from borrowers with
   * a clean credit record, never our own companies. It is taken back when the fleet needs the cash (a ship waits for it, or
   * a load at its source was short of it lately: no loan is taken while it is out), while we owe on a loan, near the
   * season's end, or when the spare falls under half what is quoted. Only quotes we made are touched; bank deposits aren't made.
   */
  private async runIdleCash(): Promise<void> {
    const w = this.world;
    const s = this.settings;
    // Our quotes as their requests show them. A region whose requests can't be read keeps ours as last seen: taking them
    // back doesn't need it, quoting waits.
    const regions = new Set<BankingRegion>([...this.ourQuotes.values()].map((q) => q.region));
    for (const p of this.pendingCredit) if (p.kind === "quote") regions.add(p.region);
    const unread: BankingRegion[] = [];
    for (const region of regions) {
      const reqs = await this.readRequests(region, 0);
      if (!reqs) {
        unread.push(region);
        continue;
      }
      this.noteOurQuotes(region, reqs);
    }
    const { quoted, committed, target } = this.idleTarget();
    // A ship waiting for cash, loads bound to buy more than is spare, or a load found short of cash at its source lately.
    const needs = [...this.agents.values()].some((a) => a.waitingForCash) || this.spareCash() - committed < 0 || Date.now() - this.cashShortAt < CASH_SHORT_MS;
    const stop =
      !s.idleCash ? "idle-cash lending is off"
      : needs ? "the fleet needs the cash"
      : this.debtOwed() > 0 ? "we owe on a loan: repaying it comes first"
      : this.debtShort ? "a repayment is short"
      : w.seasonMode() !== "normal" ? "the season is ending"
      : quoted > 0 && target < quoted / 2 ? "the spare cash fell"
      : null;
    // Idle with nothing to fund since then (quotes wait IDLE_SETTLE_GAME_H of it).
    if (stop || target < IDLE_MIN_LOAN_PENCE) this.idleSince = 0;
    else if (!this.idleSince) this.idleSince = Date.now();
    if (stop) {
      if (this.ourQuotes.size) await this.withdrawQuotes([...this.ourQuotes.keys()], stop);
      this.idleAction = this.ourQuotes.size ? `taking our quotes back: ${stop}` : `nothing lent: ${stop}`;
      return;
    }
    if (this.pendingCredit.some((p) => p.kind === "quote")) {
      this.idleAction = "a quote's call had no answer: looking for it on its request";
      return;
    }
    if (unread.length) {
      this.idleAction = `the ${unread.join(", ")} loan requests couldn't be read: nothing more quoted`;
      return;
    }
    const settleMs = IDLE_SETTLE_GAME_H * 60 * w.gameMinuteMs;
    const waited = this.idleSince ? Date.now() - this.idleSince : 0;
    const add = target - quoted;
    const quotedText = quoted > 0 ? `${cr(quoted)} quoted on ${this.ourQuotes.size} loan request${this.ourQuotes.size === 1 ? "" : "s"}` : "";
    if (add < IDLE_MIN_LOAN_PENCE || this.ourQuotes.size >= IDLE_MAX_QUOTES || Date.now() < this.idleRetryAt || waited < settleMs) {
      this.idleAction =
        add >= IDLE_MIN_LOAN_PENCE && waited < settleMs
          ? `${quotedText ? `${quotedText}; ` : ""}${cr(add)} spare: quoted on loan requests once it has had nothing to fund for ${IDLE_SETTLE_GAME_H} game hours (~${Math.ceil((settleMs - waited) / 60_000)} min more)`
          : quotedText || "no spare cash beyond the fleet's loads, our loans and the buffer";
      return;
    }
    await this.quoteIdle(add, target);
    if (this.idleAction === "") this.idleAction = quotedText || "no request fits";
  }

  /**
   * Idle cash as things stand: what is quoted (`quoted`, escrowed), the fleet's loads still to buy (`committed`), and what
   * the fleet's loads and our loans don't need with our quotes back in the vaults, less the buffer (`target`: what may be
   * quoted in all).
   */
  private idleTarget(): { quoted: number; committed: number; target: number } {
    const quoted = [...this.ourQuotes.values()].reduce((n, q) => n + q.principal, 0);
    let committed = 0;
    for (const a of this.agents.values()) committed += this.committedBy(a);
    const free = this.spareCash() - committed - this.debtFence() + quoted;
    return { quoted, committed, target: Math.max(0, free - IDLE_BUFFER_PENCE) };
  }

  /**
   * Quotes one open request (guide 3.13.2) from the richest regions' spare (the principal is escrowed there: no remittance):
   * a ship lien or warehouse goods (worth the principal at base), with recourse, IDLE_MIN_LOAN_PENCE up to `add` (and
   * IDLE_MAX_LOAN_SHARE of `target`), at most IDLE_MAX_TERM_DAYS and maturing before the season's endgame, open a while
   * longer, never our own companies' nor one we quoted, from a borrower whose record shows no default or walk-away and
   * whose credit report is clean (creditBlemishes). The best expected interest first, at idleQuoteBps. Under the cash lock.
   */
  private async quoteIdle(add: number, target: number): Promise<void> {
    const w = this.world;
    const now = w.now();
    const day = 24 * 60 * w.gameMinuteMs;
    const hour = 60 * w.gameMinuteMs;
    const most = Math.floor(Math.min(add, target * IDLE_MAX_LOAN_SHARE));
    const regions = [...w.vaults]
      .map(([r, v]) => [r, v - this.floorIn(r)] as const)
      .filter(([, v]) => v >= IDLE_MIN_LOAN_PENCE)
      .sort((a, b) => b[1] - a[1])
      .slice(0, IDLE_REGIONS_PER_PASS);
    const quotedOn = new Set([...this.ourQuotes.values()].map((q) => q.requestId));
    const cands: Array<{ r: LoanRequestView; rate: number; interest: number }> = [];
    for (const [region, spare] of regions) {
      const reqs = await this.readRequests(region, REQUESTS_TTL_MS);
      if (!reqs) continue;
      for (const r of reqs) {
        if (r.status !== "open" || this.isOurCompany(r.borrower_company_id) || quotedOn.has(r.id) || (w.companyId && r.quotes?.some((q) => q.lender_company_id === w.companyId))) continue;
        if ((r.collateral_kind !== "ship_lien" && r.collateral_kind !== "warehouse_goods") || !r.recourse) continue;
        // A pledged ship's value isn't public: never more on one loan than the Goldsmiths lend against any ship.
        if (r.principal_pence < IDLE_MIN_LOAN_PENCE || r.principal_pence > Math.min(most, spare, GOLDSMITHS_MAX_PRINCIPAL_PENCE) || r.term_game_days > IDLE_MAX_TERM_DAYS) continue;
        const openLeft = Date.parse(r.expires_at) - now;
        if (!(openLeft >= IDLE_MIN_OPEN_GAME_H * hour)) continue;
        // Repaid (or defaulted, its pledge ours) before the season's endgame, even approved at the last moment.
        if (r.term_game_days * day + openLeft > w.seasonLeftMs() - SEASON_ENDGAME_MS) continue;
        const rec = r.borrower_record;
        if (rec && (rec.loans_defaulted > 0 || rec.loans_walked_away > 0)) continue;
        // Goods: worth the principal at base (the lender takes them at the local Crown bid); a ship's value isn't public.
        if (r.collateral_kind === "warehouse_goods" && !((r.collateral_tons ?? 0) * w.basePrice(r.collateral_commodity_id ?? "") >= r.principal_pence)) continue;
        const rate = idleQuoteBps(r);
        if (rate === null) continue;
        cands.push({ r, rate, interest: (r.principal_pence * rate * r.term_game_days) / (10_000 * 360) });
      }
    }
    this.idleAction = "";
    // The best interest first; at most 3 credit records read a pass.
    for (const c of cands.sort((a, b) => b.interest - a.interest).slice(0, 3)) {
      const report = await this.creditOf(c.r.borrower_company_id);
      if (!report) continue;
      const blemishes = creditBlemishes(report);
      if (blemishes.length) {
        this.logOnceFor(`credit|${c.r.borrower_company_id}`, "fleet", `idle cash: not quoting ${c.r.borrower_name}'s loan requests: its credit record shows ${blemishes.join(", ")}`);
        continue;
      }
      await this.placeQuote(c.r, c.rate);
      return;
    }
    this.idleAction = cands.length ? "no request from a borrower with a clean record fits" : "no open loan request fits (secured, with recourse, short enough, within our spare)";
  }

  /** Quotes `r` at `rate` (annual bps) under the cash lock, its principal escrowed from our vault in its region (runIdleCash). */
  private async placeQuote(r: LoanRequestView, rate: number): Promise<void> {
    const w = this.world;
    const region = r.banking_region;
    await this.withCash(async () => {
      if (this.stopRequested || this.paused || !this.settings.idleCash) return;
      // A loan taken, a repayment gone short or a load found short of cash while waiting for the lock: nothing lent.
      if (this.debtOwed() > 0 || this.debtShort || Date.now() - this.cashShortAt < CASH_SHORT_MS) return;
      await w.refreshVaults();
      // Sized again on the vaults just read and the loads as they stand now (they may have bought or grown meanwhile).
      const t = this.idleTarget();
      if (r.principal_pence > Math.min(t.target - t.quoted, w.vault(region) - this.floorIn(region))) return;
      const pend: PendingCredit = { kind: "quote", at: w.now(), region, principal: r.principal_pence, requestId: r.id, termDays: r.term_game_days, rateBps: rate };
      this.pendingCredit.push(pend);
      this.persist(true);
      await this.journal?.flush();
      try {
        const q = await this.client.quoteLoanRequest(r.id, rate);
        this.pendingCredit = this.pendingCredit.filter((x) => x !== pend);
        this.ourQuotes.set(q.id, { region, requestId: r.id, borrower: r.borrower_company_id, principal: q.principal_pence, rateBps: q.annual_rate_bps, termDays: q.term_game_days, expiresAt: Date.parse(q.expires_at) || null, at: Date.now() });
        w.vaults.set(region, w.vault(region) - q.principal_pence);
        this.idleAction = `quoted ${cr(q.principal_pence)} in ${region} at ${pctYear(q.annual_rate_bps)}`;
        this.log(
          "fleet",
          `idle cash: quoted ${cr(q.principal_pence)} to ${r.borrower_name} in ${region} at ${pctYear(q.annual_rate_bps)} for ${q.term_game_days} game days ` +
            `(${r.collateral_kind.replace(/_/g, " ")}, ${r.repayment}, with recourse; a clean credit record; the Goldsmiths charge ${pctYear(r.goldsmiths_rate_bps)}): escrowed until approved, released or withdrawn`,
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
          this.log("fleet", `idle cash: the quote on ${r.borrower_name}'s request had no answer (${(e as Error).message}); looking for it on the request, never quoted again`);
          return;
        }
        this.idleRetryAt = Date.now() + IDLE_RETRY_MS;
        this.requestsSeen.delete(region);
        this.log("fleet", `idle cash: the quote on ${r.borrower_name}'s request was refused: ${(e as Error).message}`);
      }
    });
  }

  /** Takes our idle-cash quotes back (their escrow comes back to the vault), under the cash lock. */
  private async withdrawQuotes(ids: string[], why: string): Promise<void> {
    let back = 0;
    await this.withCash(async () => {
      for (const id of ids) {
        const o = this.ourQuotes.get(id);
        if (!o) continue;
        try {
          await this.client.withdrawLoanQuote(id);
          this.ourQuotes.delete(id);
          back += o.principal;
        } catch (e) {
          if (this.isFatal(e) || isApiError(e, "world_paused")) throw e;
          // Not open any more (approved: a loan we made now, or released): gone. No answer: the requests say at the next pass.
          if (isApiError(e) && (e.status === 409 || e.status === 404)) {
            this.ourQuotes.delete(id);
            this.loansDirty = true;
          } else this.log("fleet", `idle cash: taking back our quote (${id.slice(0, 8)}) failed: ${(e as Error).message}`);
        }
      }
      if (back > 0) {
        await this.world.refreshVaults().catch((e) => {
          if (this.isFatal(e)) throw e;
        });
      }
    });
    if (back > 0) {
      this.log("fleet", `idle cash: took ${cr(back)} of quotes back (${why})`);
      this.persist(true);
      this.cashArrived();
    }
  }

  /** Leverage and idle cash for the panel. */
  private financeReport(): FinanceReport {
    const w = this.world;
    const s = this.settings;
    const day = 24 * 60 * w.gameMinuteMs;
    const iso = (ms: number | null) => (ms !== null ? new Date(ms).toISOString() : null);
    const row = (l: Loan): FinanceLoanRow => {
      const by = this.repayDate(l, day);
      const daily = dailyBasis(l);
      return {
        id: l.id,
        region: l.banking_region,
        principalPence: l.principal_pence,
        owedPence: l.owed_pence,
        rateBps: daily ? l.daily_rate_bps : (l.annual_rate_bps ?? 0),
        rateBasis: daily ? "daily" : "annual",
        repayment: l.repayment ?? "balloon",
        totalRepayablePence: l.total_repayable_pence ?? null,
        nextPaymentAt: l.next_payment_due_at ?? null,
        nextPaymentPence: l.next_payment_pence ?? null,
        arrearsPence: Math.max(0, l.arrears_pence ?? 0),
        status: l.status,
        maturesAt: l.matures_at ?? null,
        repayBy: iso(by),
        purpose: this.loanRecs.get(l.id)?.purpose ?? null,
        collateral: l.collateral_kind,
        shipId: l.collateral_ship_id ?? null,
        isMortgage: this.isMortgage(l),
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
      quotes: [...this.ourQuotes].map(([id, q]) => ({ id, region: q.region, principalPence: q.principal, rateBps: q.rateBps, termDays: q.termDays, expiresAt: iso(q.expiresAt) })),
      requests: [...this.ourRequests].map(([id, r]) => ({
        id,
        region: r.region,
        principalPence: r.principal,
        termDays: r.termDays,
        status: r.status,
        quotes: r.quotes,
        bestBps: r.bestBps,
        expiresAt: iso(r.expiresAt),
        refinances: r.replaces,
      })),
      idleFreePence: this.idleTarget().target,
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
    // Nor what a loan call with no answer keeps back (a mortgaged build's first installments), until loan/list says (fenceUncovered's too).
    const pending = this.pendingBorrowPence(true);
    if (pending > 0) flows.push({ at: now, pence: -pending, region: null });
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
      levy: {
        thresholdPence: WEALTH_LEVY_THRESHOLD_PENCE,
        excessPence: this.levyExcess(),
        perDayPence: this.levyPerDay(),
        worthPence: this.worth?.pence ?? null,
        worthSource: this.worth?.source ?? null,
      },
      charterTaper: this.charterTaperReport(),
    };
  }

  /** The charter premium taper as it stands (guide 3.7): our Crown and Admiralty charter earnings over its window, and the factor now. */
  private charterTaperReport(): NonNullable<CashReport["charterTaper"]> {
    const earned = this.world.charterEarnings();
    return { earnedPence: Math.round(earned), thresholdPence: TAPER_FREE_PENCE, windowGameDays: TAPER_WINDOW_GAME_DAYS, factor: this.world.charterTaper(0, earned) };
  }

  // ── Letters of marque ───────────────────────────────────────────────────────

  /**
   * Our own ships per sea zone, a game day: `exposure` (cargo value × game days in the zone × gun deterrence)
   * and `risk`, what they lose per unit of zone piracy (the cargo pirates seize, and the hull, guns and any
   * return freight's reward and collateral when they take the ship, as the pirates' pull on that cargo draws
   * them): a marque raises piracy on our passages too.
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
      // Per game day in the zone, at a whole unit of piracy. `stake`: return freight's reward and collateral (guide 3.8), lost only
      // with the hull and drawing no pirate (the attention stays on the loot).
      const lossPerDay = (value: number, stake = 0) => pirateAttention(value) * det * (value * seizedShare(take, capture) + (hull + stake) * capture);
      // Passengers aboard (guide 3.20): their fares are lost unpaid with a capture, and the ransom draws pirates; carried for the
      // rest of this voyage (they are no part of a lane's trips).
      const r = a.last;
      const fares = r?.ship.status === "sailing" ? a.faresAboard() : 0;
      if (r && fares > 0) {
        for (const [zone, days] of zoneDays(w.catalog, { legs: r.route_legs.slice(r.ship.current_leg_idx) }, knots)) add(zone, fares * days * det, pirateAttention(fares) * det * fares * capture * days);
      }
      if (!lane) {
        // No lane (yet): a ship at sea still carries its cargo through the rest of its voyage (return freight is worth nothing as
        // loot, but its stake rides on her hull).
        if (!r || r.ship.status !== "sailing") continue;
        const value = a.lootValue(r, (g) => w.basePrice(g));
        const stake = a.returnStake();
        if (value <= 0 && stake <= 0) continue;
        const rest = { legs: r.route_legs.slice(r.ship.current_leg_idx) };
        for (const [zone, days] of zoneDays(w.catalog, rest, knots)) add(zone, value * days * det, lossPerDay(value, stake) * days);
        continue;
      }
      const plan = await w.route(lane.source, lane.dest, a.shipClass).catch(() => null);
      if (!plan) continue;
      // Goods at what they fetch or cost (whichever is more); sealed freight at ~3x its collateral, return freight at nothing (guide
      // 3.8) but its reward and collateral charged with the hull.
      const value = lane.parts.reduce((n, p) => n + p.tons * Math.max(p.costPerTon, p.pay), 0) + lane.freight.reduce((n, f) => n + freightLoot(f), 0);
      const stake = lane.freight.reduce((n, f) => n + returnLotStake(f), 0);
      const tripsPerDay = lane.loopMs > 0 ? dayMs / Math.max(lane.loopMs, 60_000) : 1;
      for (const [zone, days] of zoneDays(w.catalog, plan, knots)) add(zone, value * days * det * tripsPerDay, lossPerDay(value, stake) * days * tripsPerDay);
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

  /**
   * Rebuild value per hull class from the quotes seen (guide 3.4: the cheapest price at full labour and markup, whatever the
   * discount yards charge; what the game values a hull at, for rival class inference too): the cheapest of the quotes at
   * yards without a discount and those at discount yards scaled back up rather than undervalued (each plus what its discount
   * took off: hullUplift, from the quote's own labour and NPC materials; with that unknown, a quote cached before it was
   * recorded, it is left out). A class with neither is left out (hullValue then guesses from the hold). `only`: one class.
   */
  private knownQuotes(only?: string): Map<string, number> {
    const out = new Map<string, number>();
    const scaled = new Map<string, number>();
    for (const [k, v] of this.hullQuotes) {
      const bar = k.indexOf("|");
      const cls = k.slice(bar + 1);
      if (only !== undefined && cls !== only) continue;
      if (!this.discountYard(k.slice(0, bar), cls)) out.set(cls, Math.min(out.get(cls) ?? Infinity, v));
      else {
        const up = this.hullUplift.get(k);
        if (up !== undefined) scaled.set(cls, Math.min(scaled.get(cls) ?? Infinity, v + up));
      }
    }
    for (const [cls, v] of scaled) out.set(cls, Math.min(out.get(cls) ?? Infinity, v));
    return out;
  }

  /**
   * Judges a marque in every zone rival traffic crosses (the last rival analysis), and (when enabled,
   * within the budget) sponsors the most profitable one for one game day. The game prices marques from
   * each zone's player traffic (guide 3.5: 60% of the prize money expected after the Admiral's tenth), so
   * the most promising zones by our own estimate are quoted (`marque-quote`), and one is issued only when
   * the quoted prize beats the quoted cost plus our own ships' extra losses there; never in a zone a voyage
   * we underwrite sails through (its claims would rise too), nor while our slices can't be read in full, nor
   * where our patrol is in force. Then the auto-patrol (runPatrols), on the same switch, budget and gates.
   */
  private async runMarques(): Promise<void> {
    const { world, client, settings } = this;
    if (!this.rivalAnalysis || Date.now() - this.rivalAnalysis.at > RIVAL_ANALYSIS_MAX_AGE_MS) await this.runRivals();
    const analysis = this.rivalAnalysis;
    const now = world.now();
    const [zones, ours, patrols] = await Promise.all([client.zones(), this.recentMarques(now), this.recentPatrols(now)]);
    this.zoneStatus = { at: Date.now(), zones };
    this.ownNaval = { at: Date.now(), marques: ours, patrols };
    // One budget for the marques and the patrols alike.
    const day = (x: { created_at: string }) => now - Date.parse(x.created_at) < 24 * 3_600_000;
    const patrolSpent = patrols.filter(day).reduce((n, p) => n + p.cost_pence, 0);
    const spent = ours.filter(day).reduce((n, m) => n + m.cost_pence, 0) + patrolSpent;
    const prize = ours.reduce((n, m) => n + m.prize_earned_pence, 0);
    const active = new Set(ours.filter((m) => Date.parse(m.expires_at) > now).map((m) => m.sea_zone_id));
    // A marque where our own patrol is in force would pay to undo what we paid for.
    const patrolled = new Set(patrols.filter((p) => Date.parse(p.expires_at) > now).map((p) => p.sea_zone_id));
    // No rival analysis (its read failed): no marque this pass, the patrols still weighed.
    const traffic = analysis?.zones ?? [];
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
        : patrolled.has(t.zone)
          ? "our patrol is in force (a marque would work against it)"
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
    // What a marque issued now spent (the patrols below see it in the budget).
    let marqueSpent = 0;
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
          marqueSpent = m.cost_pence;
          active.add(pick.zone);
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
    // The auto-patrol on the same switch, budget (what the marque just spent included) and gates.
    const patrol = await this.runPatrols({ zones, marqueZones: active, patrols, own, spent: spent + marqueSpent, unready }).catch((e: unknown) => {
      if (this.isFatal(e) || isApiError(e, "world_paused")) throw e;
      return { rows: [] as PatrolZoneVerdict[], action: `patrol check failed: ${(e as Error).message}`, spent: 0 };
    });
    this.marqueReport = {
      checkedAt: new Date().toISOString(),
      enabled: settings.marques,
      budgetPence: settings.marqueBudgetPence,
      spentPence: spent + marqueSpent + patrol.spent,
      patrolSpentPence: patrolSpent + patrol.spent,
      prizePence: prize,
      zones: rows,
      action,
      patrolPrizePence: patrols.reduce((n, p) => n + (p.prize_earned_pence ?? 0), 0),
      patrolAction: patrol.action,
      patrols: patrol.rows,
    };
  }

  /**
   * Auto-patrols (guide 3.5), on the marques' switch, budget and gates (the season, every ship reported, spare cash after the
   * fleet's loads and our loans, never by remitting; paused worlds never get here). A patrol earns two ways: prize money from the
   * smugglers the Crown seizes at sea in its zone while it is in force (half the base value of the ship and everything aboard,
   * split among the patrols in force pro rata by bps, less the Admiral's tenth; a seizure in port pays none), modelled from the
   * public `smuggler_seized` notices over the last 7 game days and our own prize money (World.seizureModel); and the piracy it
   * takes off our own ships' passages there (ownExposure's risk per unit of piracy × the bps it suppresses). The game prices
   * patrols per zone from their recent smuggling traffic, never under 2 Cr a bps-day: the zones that pay by our estimate even at
   * that floor are quoted (`patrol-quote`, the most promising few), each sized to what the budget has left at its price, and the
   * best is funded for one game day when its expected prize and relief beat the quoted cost, priced and judged again just before.
   * Never in a zone our own ships carry contraband through or our smuggling runs use (guide 3.18: a patrol there always loses
   * money), nor anywhere while that can't be told (smugglingZones); never where our marque is in force (it would cut that
   * marque's prize), nor where one of our patrols already is. Returns the verdicts, what it did or would do, and what it spent.
   */
  private async runPatrols(x: {
    zones: SeaZonePiracyResult[];
    marqueZones: Set<string>;
    patrols: NavalPatrol[];
    own: Map<string, { exposure: number; risk: number }>;
    spent: number;
    unready: boolean;
  }): Promise<{ rows: PatrolZoneVerdict[]; action: string; spent: number }> {
    const { world, client, settings } = this;
    const now = world.now();
    const days = PATROL_GAME_HOURS / 24;
    const active = new Set(x.patrols.filter((p) => Date.parse(p.expires_at) > now).map((p) => p.sea_zone_id));
    const smuggle = this.smugglingZones();
    const fallbackPool = this.smugglerPoolFallback();
    const left = Math.max(0, settings.marqueBudgetPence - x.spent);
    // Budget spent: still judged and quoted (as big as the zone allows), so the dry run shows what would pay.
    const budget = left >= MARQUE_MIN_PENCE ? left : Infinity;
    const fitsAt = (price: number) => (Number.isFinite(budget) ? Math.floor(budget / (Math.max(price, 1) * days) / 50) * 50 : 1_500);
    const modelOf = (zone: string) => {
      const m = world.seizureModel(zone, fallbackPool, now);
      return { seizuresPerDay: m.perDay, pool: m.pool, seenBps: m.patrolBps, ownRisk: x.own.get(zone)?.risk ?? 0, count: m.count };
    };

    const rows: PatrolZoneVerdict[] = [];
    for (const z of x.zones) {
      if (z.phase > world.unlockedPhase) continue;
      const m = modelOf(z.sea_zone_id);
      // Nothing to gain: no smuggler seized at sea there lately, and no piracy of ours to take off.
      if (m.count === 0 && (m.ownRisk <= 0 || z.net_piracy_bps <= 0) && !active.has(z.sea_zone_id)) continue;
      // Our own estimate at the 2 Cr floor: the game's price is never lower, so a zone that doesn't pay there never will. Per game
      // day, as the term is one.
      const best = bestPatrol(z, { ...m, price: PATROL_FLOOR_PENCE_PER_BPS_DAY, maxBps: fitsAt(PATROL_FLOOR_PENCE_PER_BPS_DAY) });
      const verdict = active.has(z.sea_zone_id)
        ? "our patrol is in force"
        : x.marqueZones.has(z.sea_zone_id)
          ? "our marque is in force (a patrol would cut its prize)"
          : smuggle === null
            ? "where our ships carry contraband can't be told yet (no patrol anywhere)"
            : smuggle.has(z.sea_zone_id)
              ? "a ship of ours carries contraband through it (a patrol here always loses)"
              : best.bps === 0
                ? ZONE_MARQUE_CAP - z.patrol_suppression_bps < NAVAL_BPS_MIN
                  ? "the zone's patrols are at their cap"
                  : `budget: 50 bps costs more than the ${cr(left)} left`
                : best.profit <= 0
                  ? `doesn't pay even at the 2 Cr floor: ~${cr(best.prize)} prize + ~${cr(best.relief)} off our losses vs ${cr(best.cost)} a game day`
                  : "";
      rows.push({ zone: z.sea_zone_id, seizuresPerDay: m.seizuresPerDay, pool: Math.round(m.pool), ownRisk: Math.round(m.ownRisk), best, active: active.has(z.sea_zone_id), verdict });
    }
    // The game's price for the most promising few, each sized again at it to what the budget has left.
    const open = rows.filter((r) => r.verdict === "").sort((a, b) => b.best.profit - a.best.profit);
    for (const r of open.slice(PATROL_QUOTE_ZONES)) r.verdict = "not quoted: other zones look better";
    for (const r of open.slice(0, PATROL_QUOTE_ZONES)) {
      const z = x.zones.find((y) => y.sea_zone_id === r.zone)!;
      const q = await (async (): Promise<PatrolOption | string> => {
        // A zone's price per bps-day doesn't depend on the size: quoted at our estimate's, re-sized at it, quoted again if that moved.
        let pq = await client.patrolQuote(r.zone, r.best.bps, PATROL_GAME_HOURS);
        this.notePatrolPrice(pq);
        const best = bestPatrol(z, { ...modelOf(r.zone), price: pq.price_per_bps_day_pence, maxBps: fitsAt(pq.price_per_bps_day_pence), quoted: true });
        if (best.bps < NAVAL_BPS_MIN) return `budget: 50 bps here costs more than the ${cr(left)} left`;
        if (best.bps !== pq.suppressed_piracy_bps) {
          pq = await client.patrolQuote(r.zone, best.bps, PATROL_GAME_HOURS);
          this.notePatrolPrice(pq);
        }
        if (pq.cost_pence > budget) return `budget: ${pq.suppressed_piracy_bps} bps costs ${cr(pq.cost_pence)}, more than the ${cr(left)} left`;
        // The term is one game day (PATROL_GAME_HOURS): judged on the quote's own cost.
        const v = patrolValue(z, modelOf(r.zone), pq.suppressed_piracy_bps);
        const [prize, relief] = [Math.round(v.prize * days), Math.round(v.relief * days)];
        return { bps: pq.suppressed_piracy_bps, prize, relief, cost: pq.cost_pence, profit: prize + relief - pq.cost_pence, price: pq.price_per_bps_day_pence, quoted: true };
      })().catch((e: unknown) => {
        if (this.isFatal(e) || isApiError(e, "world_paused")) throw e;
        return `quote failed: ${(e as Error).message}`;
      });
      if (typeof q === "string") {
        r.verdict = q;
        continue;
      }
      r.best = q;
      r.verdict =
        q.profit <= 0
          ? `doesn't pay at the zone's price (${(q.price / 100).toFixed(2)} Cr a bps-day): ~${cr(q.prize)} prize + ~${cr(q.relief)} off our losses vs ${cr(q.cost)} a game day`
          : "pays";
    }
    rows.sort((a, b) => Number(b.best.quoted) - Number(a.best.quoted) || b.best.profit - a.best.profit);

    const pick = rows.find((r) => r.verdict === "pays");
    let spentNow = 0;
    let action = rows.length === 0 ? "no smuggler seized at sea lately and no piracy of ours to take off" : "no zone pays";
    if (pick && !settings.marques) action = `off: would fund a ${pick.best.bps} bps patrol in ${pick.zone} for ${cr(pick.best.cost)} (~${cr(pick.best.profit)} a game day)`;
    else if (pick && world.seasonMode() !== "normal") action = `the season ends in ~${Math.round(world.seasonLeftMs() / 3_600_000)} h: no new patrols`;
    else if (pick && x.unready) action = "waiting for every ship to report before weighing our own losses";
    else if (pick && x.spent + pick.best.cost > settings.marqueBudgetPence) action = `budget: ${cr(x.spent)} of ${cr(settings.marqueBudgetPence)} spent in the last 24 h`;
    else if (pick) {
      action = await this.withCash(async () => {
        // Anything may have changed while waiting for the lock: the setting, a stop, contraband taken aboard.
        if (this.stopRequested || !this.settings.marques) return "cancelled: auto-marques were turned off";
        const sm = this.smugglingZones();
        if (sm === null || sm.has(pick.zone)) return "cancelled: a ship of ours may carry contraband through the zone";
        // fund-patrol charges the quote as it stands then: priced again, and judged again on it.
        const q = await client.patrolQuote(pick.zone, pick.best.bps, PATROL_GAME_HOURS);
        this.notePatrolPrice(q);
        const z = x.zones.find((y) => y.sea_zone_id === pick.zone)!;
        const v = patrolValue(z, modelOf(pick.zone), q.suppressed_piracy_bps);
        const gain = (v.prize + v.relief) * days;
        if (gain - q.cost_pence <= 0) return `no longer pays at ${cr(q.cost_pence)} (~${cr(v.prize * days)} prize + ~${cr(v.relief * days)} off our losses)`;
        if (x.spent + q.cost_pence > this.settings.marqueBudgetPence) return `budget: ${cr(x.spent)} of ${cr(this.settings.marqueBudgetPence)} spent in the last 24 h`;
        const short = await this.navalCashBlock(q.cost_pence, "patrol");
        if (short) return short;
        try {
          const p = await client.fundPatrol({ sea_zone_id: pick.zone, suppressed_piracy_bps: q.suppressed_piracy_bps, duration_game_hours: PATROL_GAME_HOURS });
          const region = p.banking_region ?? this.homeRegion ?? "channel";
          world.vaults.set(region, world.vault(region) - p.cost_pence);
          spentNow = p.cost_pence;
          // Counted in the budget at once (the next read lists it).
          this.ownNaval?.patrols.unshift(p);
          this.log(
            "fleet",
            `naval patrol: −${p.suppressed_piracy_bps} bps in ${pick.zone} for ${cr(p.cost_pence)} (${(q.price_per_bps_day_pence / 100).toFixed(2)} Cr a bps-day; ` +
              `expected ~${cr(v.prize * days)} smuggler prize after the Admiral's tenth and ~${cr(v.relief * days)} off our own ships' losses)`,
          );
          // Zone piracy (and so lanes and refits) changed.
          this.worldDirty = true;
          pick.active = true;
          pick.verdict = "our patrol is in force";
          return `funded a ${p.suppressed_piracy_bps} bps patrol in ${pick.zone} for ${cr(p.cost_pence)}`;
        } catch (e) {
          if (this.isFatal(e)) throw e;
          // A call with no answer may have been charged: it counts as spent until the next read shows it or not.
          if (outcomeUnknown(e)) spentNow = q.cost_pence;
          this.log("fleet", `naval patrol in ${pick.zone} refused: ${(e as Error).message}`);
          return `patrol refused: ${(e as Error).message}`;
        }
      }).catch((e: unknown) => {
        if (this.isFatal(e) || isApiError(e, "world_paused")) throw e;
        return `patrol not funded: ${(e as Error).message}`;
      });
    }
    return { rows, action, spent: spentNow };
  }

  /**
   * Why a naval spend of `cost` (pence) can't come out of spare cash now, or null: never what the fleet's loads need or our loans
   * will take to repay (the debt fence), never below the home floor, never by remitting. Reads the vaults; call under the cash lock.
   */
  private async navalCashBlock(cost: number, what: string): Promise<string | null> {
    if ([...this.agents.values()].some((a) => a.waitingForCash)) return `a ship is waiting for cash: no ${what}`;
    if (this.debtShort) return `a loan repayment is short: no ${what}`;
    await this.world.refreshVaults();
    const home = this.homeRegion ?? "channel";
    let committed = 0;
    for (const a of this.agents.values()) committed += this.committedBy(a);
    if (this.spareCash() - committed - this.debtFence() < cost || this.world.vault(home) - this.floorIn(home) < cost) return `no spare cash for a ${cr(cost)} ${what}`;
    return null;
  }

  /**
   * A seized smuggler's prize pool (pence) when neither the notices nor our own prize money have shown one: half the base value of
   * the cheapest hull open now, her cargo (unknown) counted as nothing: a floor, not a guess at the average.
   */
  private smugglerPoolFallback(): number {
    const w = this.world;
    const hulls = w.catalog.ship_classes.filter((c) => c.phase <= w.unlockedPhase).map((c) => this.hullValue(c.id));
    return hulls.length ? SMUGGLER_POOL_SHARE * Math.min(...hulls) : 0;
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
   * The AI's marques and patrols (live only). Each is checked against its zone (open, that side under its cap; a marque
   * never where a voyage we underwrite sails, a patrol never where a ship of ours carries contraband), the season, the
   * horizon left (the term is cut to it), priced by the game's quote for the zone (`marque-quote` / `patrol-quote`) and
   * checked against what the marque budget has left over the last 24 h (our marques and patrols together, cut in 50 bps
   * steps to fit), then issued under the cash lock from spare cash after the fleet's loads,
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
      // As runMarques: no marque where a voyage we underwrite sails (unreadable book: none at all), and no patrol where a ship of
      // ours carries contraband (unknown: none at all).
      const book = this.advisor.pendingNaval().some((o) => o.kind === "marque" && o.status !== "unknown") ? await this.underwrittenZones() : undefined;
      const smuggle = this.smugglingZones();
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
        else if (o.kind === "patrol" && smuggle === null) {
          // Not known yet (a ship hasn't reported, say): tried again on a later pass.
          this.advisor.noteNaval(o.id, { status: "pending", code: "zone" });
          this.logOnceFor(`naval|${o.id}|smuggle`, "fleet", `${label}: waiting, where our ships carry contraband can't be told yet`);
        } else if (o.kind === "patrol" && smuggle?.has(o.zone))
          // Guide 3.18: a patrol where our own ships smuggle always loses money (its search may take our ship).
          refuse("zone", "a ship of ours carries contraband through the zone");
        else {
          // The game prices both from the zone's traffic (a marque from its player passages, a patrol from its smuggling, never
          // under 2 Cr a bps-day): quoted now and checked against the budget on that price, cut in 50 bps steps to what it has
          // left (issue-marque / fund-patrol then charge their own quote at that moment).
          const quote = async (bps: number): Promise<{ bps: number; cost: number; price: number }> => {
            if (o.kind === "marque") {
              const m = await client.marqueQuote(o.zone, bps, hours);
              this.notePrice(m);
              return { bps: m.added_piracy_bps, cost: m.cost_pence, price: m.price_per_bps_day_pence };
            }
            const p = await client.patrolQuote(o.zone, bps, hours);
            this.notePatrolPrice(p);
            return { bps: p.suppressed_piracy_bps, cost: p.cost_pence, price: p.price_per_bps_day_pence };
          };
          let q: { bps: number; cost: number; price: number } | null = null;
          try {
            q = await quote(o.bps);
            const fits = Math.floor((budget - spent) / (Math.max(q.price, 0.1) * (hours / 24)) / 50) * 50;
            if (q.cost > budget - spent && fits >= NAVAL_BPS_MIN && fits < q.bps) q = await quote(fits);
          } catch (e) {
            if (this.isFatal(e) || isApiError(e, "world_paused")) throw e;
            // A transient failure is tried again on the next pass; a refusal ends it.
            if (outcomeUnknown(e) || (isApiError(e) && e.status === 429)) {
              this.advisor.noteNaval(o.id, { status: "pending", code: "server" });
              continue;
            }
            refuse("server", `the ${o.kind} couldn't be priced: ${(e as Error).message}`);
            continue;
          }
          if (spent + q.cost > budget) refuse("budget", `${q.bps} bps costs ${cr(q.cost)} at the zone's price; ${cr(spent)} of the ${cr(budget)} budget spent in the last 24 h`);
          else {
            if (q.bps !== o.bps) this.log("fleet", `${label}: cut to ${q.bps} bps, what the budget left covers at the zone's price`);
            this.advisor.noteNaval(o.id, { bps: q.bps, costPence: q.cost });
            spent += await this.issueNaval(o, q.bps, hours, q.cost, label);
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
      // A patrol: where our ships carry contraband may have changed while this waited (guide 3.18: its search may take our own ship).
      if (o.kind === "patrol") {
        const smuggle = this.smugglingZones();
        if (smuggle === null) {
          this.advisor.noteNaval(o.id, { status: "pending", code: "zone" });
          this.logOnceFor(`naval|${o.id}|smuggle`, "fleet", `${label}: waiting, where our ships carry contraband can't be told yet`);
          return 0;
        }
        if (smuggle.has(o.zone)) {
          this.advisor.noteNaval(o.id, { status: "refused", code: "zone", note: "a ship of ours carries contraband through the zone" });
          this.log("fleet", `${label} refused: a ship of ours carries contraband through the zone`);
          return 0;
        }
      }
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
          // Charged at the zone's quote as it stands now, fixed for the term.
          const p = await client.fundPatrol({ sea_zone_id: o.zone, suppressed_piracy_bps: bps, duration_game_hours: hours });
          [id, paid, region] = [p.id, p.cost_pence, p.banking_region ?? home];
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
      ourShips: new Set(this.agents.keys()),
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

  /** The open shipyard nearest the fleet's work, for a factor to build at (a discount yard a little preferred); null if none. */
  private factorYard(): string | null {
    const { world } = this;
    // Never a cove: no factor may be hired there (403 no_factor_at_cove, guide 3.12).
    const yards = world.catalog.ports.filter((p) => p.has_shipyard && world.isOpen(p.id) && !p.is_cove);
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
    // A discount yard (guide 3.4: 30% off labour, no turnkey markup) builds the same hull for less: a hub's tie-break, and a
    // little over a yard whose work scores about the same.
    for (const p of yards) if (p.yard_discount) score.set(p.id, (score.get(p.id)! + 1) * DISCOUNT_YARD_SCORE);
    return [...score].sort((a, b) => b[1] - a[1])[0][0];
  }

  /** Hires a factor at `yard` for a build (fee from that yard's region). False if it couldn't. */
  private async hireTempFactor(yard: string): Promise<boolean> {
    const { world } = this;
    // A cove takes no factor (403 no_factor_at_cove, guide 3.12): never asked, whatever chose it (an AI build order too).
    if (world.isCove(yard)) {
      this.logOnceFor(`factor-cove|${yard}`, "fleet", `not hiring a factor at ${yard}: no factor may be hired at a smugglers' cove`);
      return false;
    }
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

  /** A ship mortgage the buyer weighed for a build (`yard|class`): why it was refused, logged when that changes (`code` "ok": it passed). */
  private noteMortgage(key: string, code: string, why?: string): void {
    if (this.mortgageSeen.get(key) === code) return;
    this.mortgageSeen.delete(key);
    this.mortgageSeen.set(key, code);
    if (this.mortgageSeen.size > 100) this.mortgageSeen.delete(this.mortgageSeen.keys().next().value!);
    if (why) this.log("fleet", `buyer: ${why}`);
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

    /**
     * `borrow`: what a loan must add for it (0: our own cash). `mortgage`: built on a ship mortgage instead (guide 3.4: its
     * turnkey build, `hull` and `cost` at the turnkey price). `listing`: a ship for sale, bought where she lies (not built).
     */
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
      mortgage?: MortgagePlan;
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
    // A ship mortgage (guide 3.4) instead, on a turnkey build: the mortgages switch on, leverage's gates passed, none owed
    // (one at a time). Bound by the debt cap itself (principal and interest), not the cash due: the hull's own earnings
    // repay it over 180 game days, which its case checks.
    const mortgageWhy = !settings.mortgages ? "mortgages are off" : (lev.why ?? this.mortgageBusy());
    const hoursPerDay = (24 * 60 * world.gameMinuteMs) / 3_600_000;
    // Real hours to the season's endgame, when every loan still owed is repaid in full (repayLoans).
    const endgameHours = (world.seasonLeftMs() - SEASON_ENDGAME_MS) / 3_600_000;
    // Game days for the new hull's net (per real hour) to earn a loan back with its interest: at the Goldsmiths' rate for
    // the term that payback needs (taken over the whole term, the worst case).
    const loanDays = (principal: number, net: number) => {
      const term = loanTerm(principal / net / hoursPerDay) ?? LOAN_MAX_TERM_DAYS;
      return (principal + interestFor(principal, goldsmithsAnnualBps(term), term)) / net / hoursPerDay;
    };

    /**
     * One hull judged, built or bought: its first lane planned with the cash left after it (`stores`: the tons to start
     * from), the upkeep it adds, payback before the season ends and on the work it would serve. When our own cash can't
     * (builds only): an instant loan's case, and a ship mortgage's on its turnkey build (`turnkey`: that price; `mortgage`:
     * its terms); with both passing, the one cheaper in interest. Never either when our own cash does. The option, or why not.
     */
    const judge = async (c: {
      yard: string;
      cls: CatalogShipClass;
      guns: number;
      hull: number;
      cost: number;
      byom: boolean;
      stores: number;
      listing?: ShipListingResult;
      turnkey?: number;
      mortgage?: MortgagePlan | null;
    }): Promise<Option | string> => {
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
      // An oceanic hull adds half its tons to sprawl as well as its flat 1 Cr/t (guide 3.12): both tonnages count.
      const upkeepPerHour = world.upkeepDeltaPerHour({ lower: this.fleetTons(false), oceanic: this.fleetTons(true) }, cls.hold_capacity_tons, oceanic);
      // The hull's net per real hour on a lane, or why it can't earn `outlay` back before the season ends and on the work
      // it would serve.
      const pays = (lane: Lane, outlay: number): number | string => {
        const net = lane.profitPerHour - upkeepPerHour;
        if (net <= 0) return "upkeep eats the profit";
        if (outlay / net > seasonHours) return "can't pay back before the season ends";
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
        if (earnable < outlay) return "its charters can't pay it back in time";
        return net;
      };
      const own = (lane: Lane): Option | string => {
        const net = pays(lane, cost);
        if (typeof net === "string") return net;
        return { yard, cls: cls.id, hull: c.hull, byom: c.byom, guns, cost, payback: cost / net, net, lane, upkeepFloor, borrow: 0, listing: c.listing };
      };
      const first = await firstLane(afterBuy);
      // Our own cash funds it: never a loan or a mortgage.
      if (typeof first !== "string") return own(first);
      if (c.listing) return first;
      const financed: Array<{ o: Option; interest: number }> = [];
      const whys: string[] = [];
      // An instant loan: planned again with what one could add, and that much (no more) borrowed when it is built. At most
      // what one Goldsmiths' loan lends (a player lender only refinances it later).
      const maxLoan = Math.floor(Math.min(loanRoom, cost * LOAN_MAX_HULL_SHARE, GOLDSMITHS_MAX_PRINCIPAL_PENCE));
      if (maxLoan >= LOAN_MIN_PRINCIPAL_PENCE && afterBuy + maxLoan > 0) {
        const lent = await firstLane(afterBuy + maxLoan);
        if (typeof lent !== "string") {
          const short = Math.ceil(lent.capital - afterBuy);
          // That lane needs no more than our own cash after all.
          if (short <= 0) return own(lent);
          const borrow = Math.max(LOAN_MIN_PRINCIPAL_PENCE, short);
          const net = pays(lent, cost);
          if (typeof net === "string") whys.push(net);
          else {
            // A loan's case on the hull's net (worst case: the Goldsmiths' rate on the whole term): it must earn minLoanReturnX
            // its interest over the term and be earned back (with that interest) within half of it.
            const lc = this.goldsmithsCase(borrow, loanDays(borrow, net), (d) => net * d * hoursPerDay);
            if (!lc.ok) whys.push(`needs a loan of ${cr(borrow)}, which wouldn't pay (${lc.why})`);
            else financed.push({ o: { yard, cls: cls.id, hull: c.hull, byom: c.byom, guns, cost, payback: cost / net, net, lane: lent, upkeepFloor, borrow }, interest: lc.interest });
          }
        }
      }
      // A ship mortgage on its turnkey build (never own materials): the Goldsmiths pay `principal`, our vault the rest, its
      // first lane planned with the cash left after our part and the installments kept back at once (debtFence). It must fit
      // the debt cap, its installments and interest be covered by the hull's net (mortgageCase), our part and the interest
      // earned back (its payback), and the whole price and interest before the season's endgame if it would still run then.
      const m = c.mortgage;
      if (mortgageWhy === null && m && c.turnkey) {
        const key = `${yard}|${cls.id}`;
        const mCost = cost - c.hull + c.turnkey;
        const cashIn = mCost - m.principal;
        const interest = Math.max(0, m.total - m.principal);
        const refuse = (code: string, why: string) => {
          this.noteMortgage(key, code, `no mortgage of ~${cr(m.principal)} on a ${cls.id} at ${yard}${m.estimated ? " (terms estimated)" : ""}: ${why}`);
          whys.push(`a mortgage of ${cr(m.principal)} wouldn't do (${why})`);
        };
        if (m.principal > lev.pence || m.total > lev.room) {
          refuse("cap", `it and its ~${cr(interest)} interest would take what we owe past ${settings.maxDebtPct}% of net worth`);
        } else {
          const lane = await firstLane(spare - cashIn - upkeepFloor - MORTGAGE_FENCED_INSTALLMENTS * m.installment);
          const net = typeof lane === "string" ? lane : pays(lane, cashIn + interest);
          const mc = typeof net === "string" ? null : mortgageCase(m, net, hoursPerDay, settings.minLoanReturnX);
          if (typeof lane === "string") refuse("lane", lane);
          else if (typeof net === "string") refuse("payback", net);
          else if (mc && !mc.ok) refuse(mc.code, mc.why);
          else if (m.termDays * hoursPerDay > endgameHours && (mCost + interest) / net > endgameHours) {
            refuse("season", `the season's endgame (when every loan is repaid in full) comes before it earns its ${cr(mCost)} and the interest back`);
          } else {
            this.noteMortgage(key, "ok");
            financed.push({
              o: { yard, cls: cls.id, hull: c.turnkey, byom: false, guns, cost: mCost, payback: (cashIn + interest) / net, net, lane, upkeepFloor, borrow: 0, mortgage: m },
              interest,
            });
          }
        }
      }
      if (financed.length === 0) return whys.length ? whys.join("; ") : first;
      return financed.sort((a, b) => a.interest - b.interest)[0].o;
    };

    // What building each class costs at each yard this pass (the cheaper way): what a ship for sale there is weighed against.
    const buildHere = new Map<string, number>();
    for (const yard of factorPriced ? [factorYard!] : yards) {
      for (const cls of classes) {
        let price: number;
        // The turnkey price and its mortgage terms (a ship mortgage only ever on a turnkey build).
        let turnkey: number;
        let mortgage: MortgagePlan | null = null;
        if (factorPriced) {
          // Priced from the last quote seen (re-quoted for real once the factor is there), its mortgage estimated.
          const q = this.hullQuotes.get(`${yard}|${cls.id}`);
          if (q === undefined) continue;
          price = q;
          turnkey = q;
          mortgage = mortgageEstimate(q, cls.hull_category === "oceanic");
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
            this.dropHullQuote(yard, cls.id);
            notes.push(`${cls.id}@${yard}: materials not in stock`);
            continue;
          }
          // Own materials bought on this yard's market skip the markup on the NPC part: priced at the cheaper way.
          // (The cache keeps the turnkey price: always on offer, it is what a build costs us here. A discount yard's
          // quote is priced as it is, so it wins on payback by itself; rebuild value reads it without the discount.)
          const own = this.byomOk(yard) ? this.byomPrice(quote, yard) : null;
          price = own !== null && this.byomSaving(quote, own) >= BYOM_MIN_SAVING_PENCE ? own : quote.total_cost_pence;
          this.noteHullQuote(yard, cls.id, quote);
          buildHere.set(`${yard}|${cls.id}`, price);
          turnkey = quote.total_cost_pence;
          if (quote.mortgage?.available) mortgage = mortgagePlan(quote.mortgage);
          // The Goldsmiths' book says one is still owed where ours shows none: our loans are read again.
          else if (quote.mortgage && mortgageWhy === null) this.loansDirty = true;
        }
        // "full" arms new hulls at once; "auto" builds them bare and refits on a pirate-heavy lane.
        const guns = settings.guns === "full" ? cls.max_cannons : 0;
        // A build at a factor's yard pays the factor's fee too.
        const cost = price + guns * GUN_PRICE_PENCE + (yard === factorYard ? FACTOR_FEE_PENCE : 0);
        // Priced from a cached quote (factor path) the way is decided at build time.
        const o = await judge({ yard, cls, guns, hull: price, cost, byom: this.byomOk(yard), stores: FIRST_STORES_GUESS_TONS, turnkey, mortgage });
        if (typeof o === "string") notes.push(`${cls.id}@${yard}: ${o}`);
        else options.push(o);
      }
    }

    // Ships for sale: one priced under building her class (at that yard this pass, else its last quote there, else the cheaper
    // of the cheapest build seen and, listed lately, the listing's own rebuild value; her guns at their refit price) is judged like a build,
    // from the stores she comes with. Never one of our companies' (dealListings), never a hull we retired, never with a loan. The build is weighed at
    // what we'd really pay: a discount yard's quote as it is (guide 3.4), never its rebuild value (hullValue).
    const seenRows: DealsReport["listings"] = [];
    for (const l of forSale) {
      const row = { id: l.id, port: l.port_id, cls: l.ship_class, name: l.ship_name, pricePence: l.price_pence, guns: l.cannons_count, buildPence: null as number | null, verdict: "" };
      seenRows.push(row);
      // A hull we retired as dead weight, up again (the broker's resale, or her buyer's): never bought back, to churn through the
      // broker at a loss (her price under her rebuild value says nothing of the work she found none of).
      if (this.disposedIds.has(l.ship_id)) {
        row.verdict = "a hull of ours retired as dead weight: never bought back";
        this.logOnceFor(`disposed-listing|${l.id}`, "fleet", `not buying the ${l.ship_class} "${l.ship_name}" for sale at ${l.port_id} (${cr(l.price_pence)}): we retired her as dead weight`);
        continue;
      }
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
        // This pass's builds elsewhere at the cheaper way (own materials where they save).
        ...[...buildHere].filter(([k]) => k.endsWith(`|${cls.id}`)).map(([, v]) => v),
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
    // Our own cash first: a hull that needs a loan or a mortgage only when none that doesn't passes.
    const pick = options.find((o) => o.borrow === 0 && !o.mortgage && o.payback <= settings.maxPaybackHours) ?? options.find((o) => o.payback <= settings.maxPaybackHours);
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
    const purpose = `a ${pick.cls} at ${pick.yard}`;
    // Materials bought for an own-materials build (on top of the build's own charge, the labour),
    // and the warehouse lease before buying them grew it (to go back to after, whatever happens).
    let materialsSpent = 0;
    let leaseBefore: number | null = null;
    // A mortgaged build (guide 3.4): its terms as quoted at the build, and whether its loan is still to be found among ours
    // (the build's outcome had no answer, but the ship turned up).
    let mort = null as MortgagePlan | null;
    let mortgageUnknown = false as boolean;
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
        if (q?.total_cost_pence) this.noteHullQuote(pick.yard, pick.cls, q);
        else this.dropHullQuote(pick.yard, pick.cls);
        return failLater(`the price of a ${pick.cls} at ${pick.yard} moved or it can't be built now`);
      }
      const price = quoted;
      await world.refreshVaults();
      let committedNow = 0;
      for (const a of this.agents.values()) committedNow += this.committedBy(a);
      // Our own cash for it: after the fleet's loads, the share kept back and what our loans will take to repay.
      const fence = this.debtFence();
      const avail = this.spareCash() - committedNow - pick.upkeepFloor - chest - fence;
      // Planned on a mortgage: never when our own cash now covers the hull and its first load; otherwise its terms afresh
      // (the switch, leverage's gates, one owed meanwhile, the debt cap, its case on the hull's net).
      if (pick.mortgage && avail >= price + pick.lane.capital && (pick.cost - pick.hull + price) / pick.net <= this.settings.maxPaybackHours) {
        this.log("fleet", `buyer: our own cash now covers ${purpose} and its first load: built without the mortgage planned for it`);
      } else if (pick.mortgage) {
        const lev = this.leverageRoom();
        const why = !this.settings.mortgages ? "mortgages are off" : (lev.why ?? this.mortgageBusy());
        if (why) return failLater(`${purpose} was planned on a mortgage: none taken now (${why})`, lev.why ? this.levCode(lev.why) : this.settings.mortgages ? "no_lender" : "switched_off");
        if (!q.mortgage?.available) {
          // The Goldsmiths' book says one is still owed: our loans are read again.
          if (q.mortgage) this.loansDirty = true;
          return failLater(`the Goldsmiths offer no mortgage on ${purpose} now${q.mortgage ? " (one still owed, by their book)" : ""}`, "no_lender");
        }
        const m = mortgagePlan(q.mortgage);
        if (m.principal > lev.pence || m.total > lev.room) {
          return failLater(`a mortgage of ${cr(m.principal)} (${cr(m.total)} with its interest) on ${purpose} would now take what we owe past ${this.settings.maxDebtPct}% of net worth`, "debt_cap");
        }
        const mc = mortgageCase(m, pick.net, hoursPerDay, this.settings.minLoanReturnX);
        if (!mc.ok) return failLater(`a mortgage of ${cr(m.principal)} on ${purpose} no longer pays (${mc.why})`, "margin");
        mort = m;
      }
      // Our part of a mortgaged build: the price less what the Goldsmiths pay.
      const cashIn = price - (mort?.principal ?? 0);
      // Planned with a loan: what our cash now leaves short of the hull and its first load, borrowed in the yard's region
      // (never much more than planned); otherwise our own cash covers the hull (our part of it, and the installments the
      // fence keeps back at once, on a mortgage) or nothing is built.
      const short = Math.ceil(price + (pick.borrow > 0 ? pick.lane.capital : 0) - avail);
      if (mort) {
        // Her guns too (the plan's mCost counted them): her first yard stay mounts them (refitGuns) past the installments' fence.
        const need = cashIn + pick.guns * GUN_PRICE_PENCE + MORTGAGE_FENCED_INSTALLMENTS * mort.installment;
        if (avail < need) {
          return failLater(
            `after the fleet's loads${chest > 0 ? " and the cash kept for the next phase" : ""}${fence > 0 ? " and what our loans will take to repay" : ""} there is no longer ${cr(need)} spare for our part of a mortgaged ${pick.cls} and its first installments`,
            "cash",
          );
        }
      } else if (pick.borrow > 0 && short > 0) {
        const most = Math.ceil(pick.borrow * 1.1);
        if (price - avail > most) return failLater(`a ${pick.cls} at ${pick.yard} now needs more than the ${cr(pick.borrow)} loan planned for it`, "cash");
        const principal = Math.min(short, most);
        const got = await this.borrow({
          purpose,
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
      const cash = await this.ensureCash(region, cashIn);
      if (cash < cashIn) return failLater(`could not raise ${cr(cashIn)} in ${region} for a ${pick.cls}`, "cash");
      // Own materials: buy what the warehouse here lacks, then build from it (never on a mortgage: turnkey only).
      let mode: "byom" | "turnkey_cash" = "turnkey_cash";
      if (byom && !mort) {
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
      // When it was sent (server ms): a mortgage made by it, if the answer is lost, was created since (less the slack).
      const sentAt = world.now();
      try {
        return await this.client.buildShip(pick.yard, name, pick.cls, mode, mort ? { mortgage: true } : undefined);
      } catch (e) {
        // Paused: refused, not an outcome to watch for (housekeeping waits on the clock).
        if (this.isFatal(e) || isApiError(e, "world_paused")) throw e;
        if (outcomeUnknown(e)) {
          // On a mortgage, its loan (made with the build or not at all) is any mortgage of ours made since: looked for among
          // our loans (reconcileBorrows), counted as owed meanwhile and no new borrowing until it is settled.
          const pend: PendingCredit | null = mort
            ? { kind: "borrow", mortgage: true, at: sentAt, region, principal: mort.principal, installment: mort.installment, purpose, use: "hull", source: "goldsmiths" }
            : null;
          if (pend) {
            this.pendingCredit.push(pend);
            this.loansDirty = true;
            this.financeDirty = true;
            this.persist(true);
          }
          // Unknown outcome: look for the ship a few times before deciding it wasn't built.
          for (let i = 0; i < 3; i++) {
            const ships = await this.client.ships().catch(() => [] as ShipResult[]);
            const found = ships.find((x) => x.ship.name === name && x.ship.current_port_id === pick.yard);
            if (found) {
              if (pend) {
                pend.ship = found.ship.id;
                mortgageUnknown = true;
              }
              return { ship_id: found.ship.id, name, port_id: pick.yard, ship_class: pick.cls, build_mode: mode, status: found.ship.status, total_cost_pence: mode === "byom" ? q.labour_pence : price };
            }
            await new Promise((r) => setTimeout(r, 5_000));
          }
          // Still unknown: don't build again for a full cooldown; adopt the ship if it turns up.
          this.lastBuy = Date.now();
          // The lease goes back once the ship turns up (not before: the build may still need the materials).
          this.pendingBuild = {
            name,
            yard: pick.yard,
            cls: pick.cls,
            price: (mode === "byom" ? q.labour_pence : price) - (mort?.principal ?? 0),
            cost: price,
            leaseBefore,
            payback: pick.payback,
            lane: pick.lane.key,
            at: world.now(),
            ...(mort ? { mortgage: { principal: mort.principal, installment: mort.installment } } : {}),
          };
          leaseBefore = null;
          this.persist(true);
          say(`building a ${pick.cls} at ${pick.yard}${mort ? ` on a mortgage of ${cr(mort.principal)}` : ""}: outcome unknown (${(e as Error).message}); watching for "${name}"`, "waiting", "unknown_outcome", true);
          return null;
        }
        // A mortgage refused (guide 3.4: 409 while we still owe on one, which our loans didn't show): none asked for again
        // for a while, the quote still stands; a walk-away ban: no Goldsmiths' lending until it ends.
        if (mort && isApiError(e) && e.status === 409 && /mortgage/i.test(`${e.code ?? ""} ${e.detail}`)) {
          this.mortgageBusyUntil = Date.now() + MORTGAGE_BUSY_MS;
          this.loansDirty = true;
          return failLater(
            `building ${purpose} on a mortgage was refused: ${(e as Error).message} (one at a time: no mortgage asked for again for ${Math.round(MORTGAGE_BUSY_MS / 60_000)} min)`,
            "no_lender",
          );
        }
        if (mort && isApiError(e, WALK_AWAY_BAN)) return failLater(`building ${purpose} on a mortgage was refused: ${this.noteGoldsmithsBan(e)}`, "no_lender");
        // A turnkey 409: the ask book can't supply a material now (or a royal monopoly keeps one to players' asks):
        // the quote cached for this yard and class no longer stands (a factor build is priced from it).
        if (mode === "turnkey_cash" && isApiError(e) && e.status === 409) this.dropHullQuote(pick.yard, pick.cls);
        // Usually presence lost (the ship sailed) or the price moved past our cash.
        if (mode === "byom") this.byomBlockedUntil.set(pick.yard, Date.now() + BYOM_BLOCK_MS);
        return failLater(
          `building a ${pick.cls} at ${pick.yard}${mort ? " on a mortgage" : ""} failed: ${(e as Error).message}${mode === "byom" ? "; its materials stay in the warehouse there" : ""}`,
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
    // On a mortgage the Goldsmiths paid `lent` of the price (guide 3.4): our vault only the rest.
    const loan = built.mortgage ?? null;
    const lent = loan ? loan.principal_pence : (mort?.principal ?? 0);
    const paid = Math.max(0, built.total_cost_pence - lent);
    this.shipSpendPence += paid;
    world.vaults.set(region, world.vault(region) - paid);
    let terms = "";
    if (loan) {
      // The loan as the build returned it: its record, the cap and the fence follow at once (like borrow()).
      this.noteLoan(loan, { purpose, use: "hull", source: "goldsmiths", isMortgage: true });
      this.cacheLoan(loan);
      this.loansDirty = true;
      this.financeDirty = true;
      const each = loan.installment_pence ?? mort?.installment ?? null;
      const interest = Math.max(0, (loan.total_repayable_pence ?? mort?.total ?? loan.principal_pence) - loan.principal_pence);
      terms =
        ` on a mortgage of ${cr(lent)} from the Goldsmiths' Company in ${loan.banking_region} (${cr(paid)} from our vault${each ? `; installments of ${cr(each)} every ${MORTGAGE_INSTALLMENT_DAYS} game days` : ""}` +
        ` over ${loan.term_game_days} game days at ${pctYear(loan.annual_rate_bps ?? mort?.rateBps ?? 0)}, ~${cr(interest)} interest; never repaid early, its next ${MORTGAGE_FENCED_INSTALLMENTS} installments kept back)`;
      this.persist(true);
    } else if (mort) {
      // Built on a mortgage with no loan in the answer (no answer at all, the ship found since): read from our loans.
      this.loansDirty = true;
      this.financeDirty = true;
      terms = ` on a mortgage of ~${cr(lent)} (${cr(paid)} from our vault; installments of ~${cr(mort.installment)} every ${MORTGAGE_INSTALLMENT_DAYS} game days${mortgageUnknown ? "; its loan is looked for among ours" : ""})`;
    }
    // Planned on a mortgage but built without it (our own cash came to cover it): paid back on the whole cost.
    const payback = pick.mortgage && !mort ? (pick.cost - pick.hull + built.total_cost_pence) / pick.net : pick.payback;
    this.log(
      "fleet",
      `built ${pick.cls} "${name}" at ${pick.yard} for ${cr(spentOnHull)}${built.build_mode === "byom" ? " from our own materials" : ""}${terms}: lane ${pick.lane.key}, ~${cr(pick.net)}/h net, ` +
        `pays back${mort ? " our part and the interest" : ""} in ~${payback.toFixed(1)} h`,
    );
    this.purchases.push({
      at: new Date().toISOString(),
      shipId: built.ship_id,
      name,
      shipClass: pick.cls,
      port: pick.yard,
      costPence: spentOnHull,
      paybackHours: Math.round(payback * 10) / 10,
      lane: pick.lane.key,
      ...(lent > 0 ? { mortgagePence: lent } : {}),
    });
    this.setBuyer(`bought ${pick.cls} "${name}" at ${pick.yard}${lent > 0 ? " on a mortgage" : ""}`);
    if (current()) this.noteBuild("done", undefined, undefined, built.ship_id);
    if ((pick.borrow > 0 || lent > 0) && hullLoan) this.noteFinance(hullLoan, "done");
    await this.scanShips();
  }

  // ── Ship deals ──────────────────────────────────────────────────────────────

  /**
   * Ports where we have quay presence now, as last seen: a ship of ours berthed or in the roadstead there, or a factor.
   * Never a smugglers' cove: its book and board are the Underworld's (guide 3.18), not for listings or envelopes.
   */
  private quayPorts(): string[] {
    const out = new Set<string>(this.factorPorts);
    for (const a of this.agents.values()) {
      const s = a.last?.ship;
      if (!a.gone && s && s.status !== "sailing" && s.status !== "sunk" && s.current_port_id) out.add(s.current_port_id);
    }
    return [...out].filter((p) => this.world.isOpen(p) && !this.world.isCove(p));
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
    if (why.includes("Goldsmiths lend nothing")) return "no_lender";
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
          ? `the ${rec.cls} commissioned at ${rec.yard} wasn't delivered before its deadline: our ${cr(rec.collateral)} ${rec.admiralty ? "deposit goes to the Crown" : "collateral goes to the buyer"}`
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
    // Ours delivered: room for the next Admiralty commission (one taken at a time, guide 3.4).
    if (rec.admiralty) this.admiraltyBlockedUntil = 0;
    const net = d ? d.price_paid_pence - d.build_cost_pence - materials : rec.price - rec.cost;
    this.dealStats.commissionsDelivered++;
    this.dealStats.commissionNet += net;
    this.log(
      "fleet",
      rec.admiralty
        ? `delivered the Admiralty's ${rec.cls} at ${rec.yard} (she joins the Royal Navy, no company's fleet): the ${this.world.region(rec.yard)} Crown paid ${cr(d?.price_paid_pence ?? rec.price)} and our ${cr(rec.collateral)} deposit came back, ~${cr(net)} over the build${d ? "" : " (as planned)"}`
        : `delivered the ${rec.cls} commissioned at ${rec.yard}: paid ${cr(d?.price_paid_pence ?? rec.price)} and our ${cr(rec.collateral)} collateral back, ~${cr(net)} over the build${d ? "" : " (as planned)"}`,
    );
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
      if (rec.admiralty) this.admiraltyBlockedUntil = 0;
      this.log("fleet", `the ${rec.cls} commissioned at ${rec.yard} defaulted: our ${cr(rec.collateral)} ${rec.admiralty ? "deposit goes to the Crown" : "collateral goes to the buyer"}`);
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
    // One taken Admiralty commission at a time across our player's companies (guide 3.4: 409 until it is delivered or lapses).
    const admiraltyHeld = [...this.commissionRecs.values()].some((r) => r.admiralty && (r.status === "accepting" || r.status === "accepted" || r.status === "delivering"));
    for (const c of rows) {
      if (c.contract_type !== "commission" || c.status !== "open" || !c.ship_class) continue;
      const yard = c.origin_port_id;
      const order = orders.find((o) => o.ref === c.id);
      const admiralty = isAdmiralty(c);
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
        ...(admiralty ? { admiralty: true } : {}),
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
      if (admiralty && admiraltyHeld) {
        no("one Admiralty commission at a time: ours is still to be delivered", "busy");
        continue;
      }
      if (admiralty && this.admiraltyBlockedUntil > Date.now()) {
        no("one Admiralty commission at a time: taking one was refused lately (our companies hold one already)", "busy");
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
      this.noteHullQuote(yard, cls.id, q);
      // A commission's turnkey build skips the buyer's own asks with no cap on what it pays instead: with players' asks
      // in the walk (the buyer's, perhaps), own materials only (our bids may buy them), or not taken. The Admiralty's has no
      // buyer whose asks it passes over: its turnkey quote stands.
      const asks = !admiralty && playerAsks(q);
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
      row.verdict = `pays: ~${cr(cc.margin)} over our ${byom ? "own-materials" : "turnkey"} build${admiralty ? " (the Admiralty's: paid by the Crown, the hull to the Royal Navy)" : ""}`;
      cands.push({ c, cost, byom, margin: cc.margin, order });
    }
    this.commissionsSeen = { at: Date.now(), rows: seen };
    for (const o of orders) if (!rows.some((c) => c.id === o.ref) && !this.commissionRecs.has(o.ref)) this.noteFinance(o, "unmet", "gone", "no longer open");
    // One pass takes one commission, so the one-at-a-time rule for the Admiralty's holds within a pass too.
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
    const admiralty = isAdmiralty(c);
    const what = admiralty
      ? `the Admiralty's commission for a ${cls} at ${yard} (${cr(c.reward_pence)} from the ${region} Crown, deposit ${cr(c.collateral_pence)})`
      : `the commission for a ${cls} at ${yard} (${cr(c.reward_pence)}, collateral ${cr(c.collateral_pence)})`;
    // Name first: the TopStats fetch must not sit between raising the cash and spending it.
    const name = await pickShipName(new Set([...[...this.agents.values()].map((a) => a.name), ...[...this.commissionRecs.values()].map((r) => r.name ?? "")]));
    await this.withCash(async () => {
      if (this.stopRequested || this.paused) return;
      if (!this.settings.shipDeals && !(plan.order && this.advisor.financeOrders().includes(plan.order))) return;
      // One taken Admiralty commission at a time (guide 3.4): one of ours taken since the scan, or a refusal lately.
      if (admiralty && (this.admiraltyBlockedUntil > Date.now() || [...this.commissionRecs.values()].some((r) => r.admiralty && (r.status === "accepting" || r.status === "accepted" || r.status === "delivering")))) {
        this.dealsAction = `${what}: one Admiralty commission at a time`;
        if (plan.order) this.noteFinance(plan.order, "unmet", "busy", this.dealsAction);
        return;
      }
      const q = await this.client.shipyardQuote(yard, cls, "turnkey_cash").catch((e) => {
        if (this.isFatal(e) || isApiError(e, "world_paused")) throw e;
        return null;
      });
      if (!q?.available || !q.total_cost_pence) {
        this.dealsAction = `${what}: the yard can't build it now`;
        return;
      }
      // Players' asks in the turnkey walk: own materials only (takeCommission), or not taken; never so for the Admiralty's (no buyer).
      const asks = !admiralty && playerAsks(q);
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
        ...(admiralty ? { admiralty: true } : {}),
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
        // An Admiralty commission refused (409) while it is still open: our player's companies hold one taken already (guide 3.4), by
        // hand or another company of ours: none tried for a game day. Gone from the open list (another company took it first, or it
        // lapsed: the 409's other meaning) or not read: only this one is left alone.
        let why = "";
        if (admiralty && isApiError(e) && e.status === 409) {
          const open = await this.client.contractPages({ contract_type: "commission", status: "open" }, 3).catch((err: unknown) => {
            if (this.isFatal(err) || isApiError(err, "world_paused")) throw err;
            return null;
          });
          if (open?.items.some((x) => x.id === c.id && x.status === "open")) {
            this.admiraltyBlockedUntil = Date.now() + this.gameDayMs;
            why = " (still open: one Admiralty commission at a time across our companies, so none tried for a game day)";
          } else why = open ? " (not open any more: another company took it first, or it lapsed)" : " (the commissions couldn't be read again: only this one is left alone)";
        }
        this.dealsAction = `taking ${what} was refused`;
        this.log("fleet", `taking ${what} was refused: ${msg}${why}`);
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
    // delivery with no answer that may have landed): turnkey only, nothing bought ahead; with players' asks, it waits. The
    // Admiralty's has no buyer whose asks it passes over: its turnkey quote stands.
    const asks = !rec.admiralty && playerAsks(q);
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
          this.dropHullQuote(rec.yard, rec.cls);
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
        .map(([id, r]) => ({ id, yard: r.yard, cls: r.cls, pricePence: r.price, collateralPence: r.collateral, status: r.status, expiresAt: iso(r.expiresAt), note: r.note ?? null, ...(r.admiralty ? { admiralty: true } : {}) })),
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
      .map((c) => ({ id: c.id, yard: c.yard, cls: c.cls, price: c.pricePence, collateral: c.collateralPence, leftMs: left(c.expiresAt), margin: c.marginPence, ours: null, admiralty: !!c.admiralty }));
    for (const [id, r] of this.commissionRecs) {
      if (r.status === "delivered" || r.status === "failed") continue;
      commissions.unshift({ id, yard: r.yard, cls: r.cls, price: r.price, collateral: r.collateral, leftMs: r.expiresAt !== null ? Math.max(0, r.expiresAt - now) : null, margin: r.price - r.cost, ours: r.status, admiralty: !!r.admiralty });
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
