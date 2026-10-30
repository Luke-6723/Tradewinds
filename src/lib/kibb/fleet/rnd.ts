/**
 * R&D, patents, licences and ship components (guide 3.19; the `components` and `rndResearch` settings). Pure logic, no calls: the
 * manager reads the register, our licences, patents and components, the licence offers and the yard's book, and makes every call.
 *
 * The game's terms: every hull has six slots (hull, sails, rigging, hold, armament, helm), each taking one component. A design's
 * `effects` are honest direction words, never sizes. Whoever researched it holds its patent and makes it freely; anyone else needs a
 * licence unit (bought from the holder's `licence_offer` contracts, paid from our vault in the holder's home region) or the design
 * public. Making one (`rnd/make`) takes its make materials from our warehouse at a yard plus the yard's labour, and the component lies
 * in that warehouse until fitted. Fitting (`shipyard/fit-component`) needs the ship berthed at the yard where it lies, its slot free and
 * no policy open on her; it costs 4% of her rebuild value and is permanent (no removal or swap); it raises her rebuild value by the
 * component's worth plus the fee, and a listing of hers lapses.
 *
 * How the autopilot fits (components, on by default; manager.ts fitComponents at a yard call, never a detour):
 *   - effects are read conservatively (effectsOf): every word must name one thing (hold, speed, turnaround, storms, capture, guns) and
 *     one direction, or the design is skipped; quality words keep their direction (worse delays, loses time: weaknesses) and only
 *     quantity words read through a harm noun (less time in port: a strength); a storm, capture or gun strength only from a short list
 *     of clear phrases, and any negative word there a weakness; a design with any weakness is never fitted (a trade-off's size is unknown);
 *   - a strength's size is a small prior by grade (EFFECT_PRIOR), or the hold share our own fits of that design measured; its worth to
 *     a ship is her own recent net a real hour (her trips over the trailing window, idle time in) times what it buys: a bigger hold more
 *     cargo (HOLD_USE of it), more speed less time at sea (her share of it, SPEED_USE), a quicker turnaround less port time (her share,
 *     TURNAROUND_USE); safety and guns count for nothing (never a reason to fit on their own);
 *   - over the horizon (the season left, at most COMPONENT_HORIZON_MS, discounted for her loss) that must beat COMPONENT_MIN_RETURN_X
 *     times everything spent (fitCase): the licence unit, the make materials at the yard's asks and the labour, and the fitting fee,
 *     by COMPONENT_MIN_GAIN_PENCE at least. Only designs whose make materials are known (our licences, the licence offers) are made.
 *
 * Research (rndResearch, OFF by default: a project draws a random design, costs a start fee never refunded and daily upkeep for two to
 * three real days): started only when the game allows one, the whole expected cost (fee and upkeep) fits `rndBudgetPence` and the
 * season leaves time to use it; slot by priority (hold, sails, hull), the highest grade the phase has opened with designs still free;
 * the trial ship our ship that sails the right water most; the prototype's materials bought into a yard warehouse of ours; abandoned
 * when the spending would pass the budget, the upkeep goes unpaid, or the season would end before the grant. After a grant: a design
 * worth having (strengths only, safety alone included) is licensed out per unit and fitted like any other where its gain pays; a
 * disappointing one (any weakness, or no effect words at all) is made public at once, so its upkeep stops.
 */

import type { BankingRegion } from "../types";
import type { FittedComponentView, LicenceTerms, MaterialLine, PoolEntry, ProjectView, RndStatus, Slot } from "../schema";

export const SLOTS: readonly Slot[] = ["hull", "sails", "rigging", "hold", "armament", "helm"];
/** Research slots in priority order (the plan: hold, then sails, then hull). */
export const RND_SLOT_PRIORITY: readonly Slot[] = ["hold", "sails", "hull"];

/** The fitting fee (guide 3.19: 4% of the ship's rebuild value). */
export const FITTING_FEE_BPS = 400;
/** Our rebuild figure leaves out components already fitted (their worth isn't published): the fee is reckoned on this much more. */
export const REBUILD_COMPONENT_MARGIN = 1.1;
/** A strength's size when nothing measured it, by grade (a share: 0.03 = 3%), deliberately small. */
export const EFFECT_PRIOR: Record<number, number> = { 1: 0.03, 2: 0.05, 3: 0.08 };
/** How much of a bigger hold a ship fills on average, of her time at sea saved by more speed, of her port time a quicker turnaround saves. */
export const HOLD_USE = 0.6;
export const SPEED_USE = 0.8;
export const TURNAROUND_USE = 0.5;
/** The horizon a component's gain is counted over (real ms) at most, and the share of it counted (she may be lost or sold before). */
export const COMPONENT_HORIZON_MS = 14 * 24 * 3_600_000;
export const COMPONENT_SURVIVAL = 0.85;
/** What a fit must return: this many times what it costs, and this much over it (pence; 500 Cr). */
export const COMPONENT_MIN_RETURN_X = 2;
export const COMPONENT_MIN_GAIN_PENCE = 50_000;
/** Default budget: the most spent on components (licences, materials, labour, fitting fees) in any 24 real hours (pence; 20,000 Cr). */
export const COMPONENT_DEFAULT_BUDGET_PENCE = 2_000_000;
/** Materials are bid this much over the book's walk (a ladder moves while we buy). */
export const MATERIALS_BID_MARKUP = 1.1;
/** A job's call with no answer is reconciled this long (real ms), then taken as not done. */
export const COMPONENT_PENDING_MS = 10 * 60_000;
/**
 * Materials left by a fit stopped or a project closed are sold into the port's bids at no less than this share of their base price
 * (as a ship's leftover cargo is), tried each pass; after LEFTOVER_GIVE_UP_MS (real ms) what is left stays for the owner.
 */
export const LEFTOVER_FLOOR_SHARE = 0.5;
export const LEFTOVER_GIVE_UP_MS = 24 * 3_600_000;
/** The register, our licences and the offers are read at most this often (real ms). */
export const DESIGNS_TTL_MS = 30 * 60_000;
/** Fits kept for the panel; learned hold shares kept. */
export const FITS_KEPT = 30;
export const LEARNED_KEPT = 60;

/** Research: the default budget (pence; 50,000 Cr), game days a project is expected to take (two and a half real days at 60 a real day). */
export const RND_DEFAULT_BUDGET_PENCE = 5_000_000;
export const RND_EXPECTED_GAME_DAYS = 150;
/** Game days of the season a grant must still have left to be used (a real day). */
export const RND_USE_GAME_DAYS = 60;
/** Unpaid upkeep days (consecutive) at which the project is given up (the game gives it up at three, with nothing back). */
export const RND_ABANDON_UNPAID_DAYS = 2;
/** Spare cash kept beyond the start fee (pence; 10,000 Cr). */
export const RND_CASH_BUFFER_PENCE = 1_000_000;
/** Licence offers for a design of ours: per unit, by grade (pence), how many units, how long open (game hours). */
export const LICENCE_UNIT_PENCE: Record<number, number> = { 1: 100_000, 2: 200_000, 3: 350_000 };
export const LICENCE_OFFER_UNITS = 10;
export const LICENCE_OFFER_GAME_H = 240;
/** Our R&D standing is read at most this often (real ms). */
export const RND_CHECK_MS = 10 * 60_000;
/** A start or a stage call with no answer is reconciled this long (real ms). */
export const RND_PENDING_MS = 10 * 60_000;

// ── Effect words ──────────────────────────────────────────────────────────────

export type EffectKind = "hold" | "speed" | "turnaround" | "storm" | "capture" | "guns";

/** A design's effects as read: what it strengthens and what it weakens. */
export interface EffectRead {
  ups: EffectKind[];
  downs: EffectKind[];
}

/** A negation reads two ways (not as fast, no slower): the word can't be read. */
const NEGATION = /\b(not|no|never|nor|without)\b/;
/** Quantity words: they say how much of the noun, so a harm noun turns them round (less damage, fewer delays, more time in port). */
const QTY_UP = /\b(more|extra|greater|higher|bigger|larger|increased?|increases|added|additional)\b/;
const QTY_DOWN = /\b(less|fewer|reduced|reduces|lower|smaller|decreased?|decreases)\b/;
/** Harm nouns: what a ship wants less of. They turn quantity words round, never quality words (worse delays, loses time stay weaknesses). */
const HARM = /\b(damage|losses|loss|risk|time|delays?|days?|hours?|waits?|waiting)\b/;
/** Quality words for hold, speed and turnaround: their direction is fixed whatever noun follows (quicker turnaround time is a strength). */
const GOOD = /\b(better|faster|quicker|quickly|swifter|swiftly|sooner|roomier|easier|easily)\b/;
const BAD = /\b(worse|slower|slowly|sluggish|cramped|harder|loses?|lost|losing|clumsier)\b/;
/** "less" before a good quality turns it (less quick: a weakness); before a bad one it reads two ways (less sluggish): unreadable. */
const LESS_GOOD = /\bless (\w+ )?(good|fast|quick|swift|roomy|easy|handy|nimble)\b/;
const LESS_BAD = /\bless (\w+ )?(bad|slow|slowly|sluggish|cramped|hard|clumsy)\b/;
/** Safety words in a hold, speed or turnaround word mix the kinds (safer for cargo): unreadable, never valued as a gain. */
const SAFETY_WORD = /\b(safe|safer|stronger|sturdier|resists?|resistant|weathers|vulnerable|exposed|prone|susceptible|riskier|weaker|defended|defensible)\b/;
/** Lengths: shorter is better (a turnaround, a passage), longer worse, whatever noun follows. */
const SHORT = /\bshorter\b/;
const LONG = /\blonger\b/;
/** Storms, capture and guns: a negative word anywhere makes the word a weakness (worse damage, more exposed, harder to handle). */
const SAFETY_BAD =
  /\b(worse|weaker|riskier|vulnerable|exposed|prone|susceptible|loses?|lost|losing|fragile|leaky|leaks?|sluggish|clumsier|harder to (handle|steer|manage|sail|work|control|defend)|less (safe|sturdy|strong|steady|stable|seaworthy|defensible|armed)|lighter (armament|broadside|guns?)|fewer (guns?|cannons?))\b/;
const KIND_BAD: Partial<Record<EffectKind, RegExp>> = { capture: /\b(easier|easily)\b/ };
/** "less" before a negative there reads two ways (less vulnerable, less easily carried off): unreadable. */
const SAFETY_LESS_BAD = /\bless (\w+ )?(vulnerable|exposed|prone|susceptible|risky|likely|easy|easily|often)\b/;
const STORMS = "(storms?|gales?|heavy seas?|bad weather|foul weather|rough water|rough seas?)";
const RAIDERS = "(pirates?|privateers?|corsairs?|raiders?|boarders?)";
/**
 * Storm, capture and gun strengths: only these clear phrases (they are valued at nothing, so being strict costs nothing; anything else
 * is a weakness when it says so, or unreadable).
 */
const STRENGTHS: Record<"storm" | "capture" | "guns", RegExp[]> = {
  storm: [
    new RegExp(`\\bsafer (in|from|against|through) ${STORMS}`),
    new RegExp(`\\b(resists?|resistant to|weathers|rides out|stands up to|withstands) ${STORMS}`),
    new RegExp(`\\b(stronger|sturdier|steadier|stabler|better) (in|against) ${STORMS}`),
    new RegExp(`\\b(handles|rides) (${STORMS} )?better\\b`),
    new RegExp(`\\beasier to (handle|steer|manage|sail) in ${STORMS}`),
    /\bharder to (sink|swamp|founder|wreck|damage)\b/,
    /\b(less|lower|reduced|smaller) (storm |weather )?(damage|losses|loss|risk)\b/,
    /\bfewer (storm )?(losses|sinkings)\b/,
  ],
  capture: [
    new RegExp(`\\bharder (for ${RAIDERS} )?to (capture|take|board|carry (her |them |it )?off|catch|seize)\\b`),
    new RegExp(`\\b(resists?|resistant to|repels?|beats off|fends off|drives off) (${RAIDERS}|boarding|capture)\\b`),
    new RegExp(`\\bsafer (from|against) (${RAIDERS}|capture|boarding)\\b`),
    new RegExp(`\\b(stronger|better) against (${RAIDERS}|boarding|capture)\\b`),
    /\b(less|lower|reduced|smaller) (risk|chance|odds|danger) of (capture|being (taken|captured|boarded|carried off))\b/,
    new RegExp(`\\b(less|lower|reduced|smaller|fewer) (capture )?(risk|losses|loss)( to ${RAIDERS})?\\b`),
    /\bfewer captures\b/,
  ],
  guns: [
    /\b(more|extra|additional|heavier) (guns?|cannons?)\b/,
    /\b(bigger|larger|heavier|stronger|greater) (armament|broadside)\b/,
    /\b(higher|greater|bigger|larger|increased) (guns? allowance|gun allowance)\b/,
  ],
};

/** What one effect word speaks of, or null (a word we can't place: the design is skipped). Turnaround first ("quicker to turn around"). */
function kindOf(w: string): EffectKind | null {
  if (/turn ?-?around|turnaround|in port|to load|loading|unload|\bloads? (and unloads? )?(faster|quicker|more quickly|sooner|slower|more slowly)\b/.test(w)) return "turnaround";
  if (/storm|gale|weather|heavy seas?/.test(w)) return "storm";
  if (/pirat|captur|carry (her |them |it )?off|boarding|prize|privateer|corsair/.test(w)) return "capture";
  if (/\b(guns?|cannons?|armament|broadside)\b/.test(w)) return "guns";
  if (/\b(hold|cargo|capacity|tonnage|room)\b/.test(w)) return "hold";
  if (/\b(fast|faster|slow|slower|speed|swift|swifter|quick|quicker|knots?)\b/.test(w)) return "speed";
  return null;
}

/**
 * Hold, speed or turnaround: a quality word fixes the direction (worse, loses, quicker; "more" or "much" before it only says how much),
 * a quantity word reads through its noun (less time, more cargo), a length word is its own. Two readings, or none: null.
 */
function tradeDir(w: string): "up" | "down" | null {
  if (SAFETY_WORD.test(w) || LESS_BAD.test(w)) return null;
  const good = GOOD.test(w);
  const bad = BAD.test(w);
  let qual: "up" | "down" | null = null;
  if (LESS_GOOD.test(w)) {
    if (bad) return null;
    qual = "down";
  } else if (good && bad) return null;
  else if (good) qual = "up";
  else if (bad) qual = "down";
  const qUp = QTY_UP.test(w);
  const qDown = QTY_DOWN.test(w);
  const short = SHORT.test(w);
  const long = LONG.test(w);
  if (short || long) {
    if ((short && long) || qual || qUp || qDown) return null;
    return short ? "up" : "down";
  }
  const harm = HARM.test(w);
  const nUp = harm ? qDown : qUp;
  const nDown = harm ? qUp : qDown;
  if (qual) {
    // A harm noun's quantity saying the other way (loses less time): two readings.
    if (harm && (nUp || nDown) && ((nUp && nDown) || (nUp ? "up" : "down") !== qual)) return null;
    return qual;
  }
  if (nUp === nDown) return null;
  return nUp ? "up" : "down";
}

/**
 * Storms, capture or guns: a negative word makes it a weakness (anything with one is), a whitelisted strength phrase a strength, a harm
 * grown or a good thing shrunk (more damage, fewer guns) a weakness; anything else can't be read.
 */
function safetyDir(w: string, kind: "storm" | "capture" | "guns"): "up" | "down" | null {
  if (SAFETY_LESS_BAD.test(w)) return null;
  if (SAFETY_BAD.test(w) || KIND_BAD[kind]?.test(w)) return "down";
  if (STRENGTHS[kind].some((re) => re.test(w))) return "up";
  if (HARM.test(w) ? QTY_UP.test(w) : QTY_DOWN.test(w)) return "down";
  return null;
}

/** One effect word: what it speaks of and which way, or null (it can't be read). */
function readWord(raw: string): { kind: EffectKind; dir: "up" | "down" } | null {
  const w = raw.toLowerCase().replace(/[^a-z\s-]/g, " ").replace(/\s+/g, " ").trim();
  if (!w || NEGATION.test(w)) return null;
  const kind = kindOf(w);
  if (!kind) return null;
  const dir = kind === "storm" || kind === "capture" || kind === "guns" ? safetyDir(w, kind) : tradeDir(w);
  return dir ? { kind, dir } : null;
}

/**
 * A design's effect words read conservatively: each word must name one thing and one direction. Null: some word can't be read, or
 * there are none (the design is skipped).
 */
export function effectsOf(words: readonly string[]): EffectRead | null {
  if (!words.length) return null;
  const out: EffectRead = { ups: [], downs: [] };
  for (const raw of words) {
    const r = readWord(raw);
    if (!r) return null;
    (r.dir === "up" ? out.ups : out.downs).push(r.kind);
  }
  return out;
}

/**
 * "a disappointing design": a weakness among its words, or no effect words at all (it does nothing). A clean strength of any kind,
 * safety alone included, is worth keeping (licensed out; fitted by us only where its gain passes the value test, never on safety
 * alone). Null: no weakness read, but a word can't be read (kept for the owner to judge: making it public can't be undone).
 */
export function disappointing(words: readonly string[]): boolean | null {
  if (!words.length) return true;
  let unread = false;
  for (const raw of words) {
    const r = readWord(raw);
    if (!r) unread = true;
    else if (r.dir === "down") return true;
  }
  return unread ? null : false;
}

/** How a ship spends her time and what she earns (real hours; her net per real hour, idle time in). */
export interface ShipUse {
  perHour: number;
  /** Shares of her time at sea and in port (working or idle). */
  seaShare: number;
  portShare: number;
}

/**
 * What a component would add to a ship a real hour (pence): her net × each strength's size (the hold share measured for this
 * design if we have it, else the grade's prior) × what that strength buys her. Never anything for a design with a weakness.
 */
export function componentGain(e: EffectRead, grade: number, use: ShipUse, measuredHold?: number): number {
  if (e.downs.length > 0 || !(use.perHour > 0)) return 0;
  const prior = EFFECT_PRIOR[Math.min(3, Math.max(1, Math.round(grade)))] ?? EFFECT_PRIOR[1];
  let share = 0;
  for (const k of e.ups) {
    if (k === "hold") share += HOLD_USE * (measuredHold !== undefined && measuredHold > 0 ? Math.min(0.5, measuredHold) : prior);
    else if (k === "speed") share += SPEED_USE * Math.min(1, Math.max(0, use.seaShare)) * (prior / (1 + prior));
    else if (k === "turnaround") share += TURNAROUND_USE * Math.min(1, Math.max(0, use.portShare)) * prior;
  }
  return Math.max(0, use.perHour * share);
}

/** The fitting fee on our rebuild figure (pence), with the margin for components already fitted. */
export function fittingFee(rebuild: number): number {
  return Math.ceil((Math.max(0, rebuild) * REBUILD_COMPONENT_MARGIN * FITTING_FEE_BPS) / 10_000);
}

export interface FitCost {
  licence: number;
  materials: number;
  labour: number;
  fee: number;
}

/**
 * Whether fitting pays: the gain a real hour over the horizon (survival-discounted) against everything spent on it. `value`: what it
 * should bring; `cost`: what it takes in cash.
 */
export function fitCase(c: { gainPerHour: number; horizonHours: number; cost: FitCost }): { ok: boolean; value: number; cost: number; why: string } {
  const cost = Math.max(0, c.cost.licence) + Math.max(0, c.cost.materials) + Math.max(0, c.cost.labour) + Math.max(0, c.cost.fee);
  const value = Math.round(Math.max(0, c.gainPerHour) * Math.max(0, c.horizonHours) * COMPONENT_SURVIVAL);
  const cr = (p: number) => `${Math.round(p / 100).toLocaleString("en-GB")} Cr`;
  if (value < COMPONENT_MIN_RETURN_X * cost) return { ok: false, value, cost, why: `~${cr(value)} over the horizon is under ${COMPONENT_MIN_RETURN_X}x its ${cr(cost)}` };
  if (value - cost < COMPONENT_MIN_GAIN_PENCE) return { ok: false, value, cost, why: `~${cr(value - cost)} over its ${cr(cost)} is under ${cr(COMPONENT_MIN_GAIN_PENCE)}` };
  return { ok: true, value, cost, why: `~${cr(value)} over the horizon for ${cr(cost)}` };
}

/** Whether her slot is free (guide 3.19: one component a slot, no swap). */
export function slotFree(fitted: readonly FittedComponentView[] | undefined, slot: Slot): boolean {
  return !(fitted ?? []).some((c) => c.slot === slot);
}

/** One licence unit's price from an offer (pence): `per_unit` as posted; `total` only for a lot of one unit (all-or-nothing). Null: not one unit. */
export function unitPrice(t: Pick<LicenceTerms, "price_basis" | "price_pence">, unitsLeft: number): number | null {
  if (t.price_basis === "per_unit") return t.price_pence;
  return unitsLeft === 1 ? t.price_pence : null;
}

/** A design we could make and fit (one of DesignOption's sources). */
export interface DesignOption {
  componentId: string;
  name: string;
  slot: Slot;
  grade: number;
  effects: string[];
  /** `made`: one lying in our warehouse here; `licence`/`own`/`public`: ours to make; `offer`: a unit to buy from a licence offer first. */
  source: "made" | "licence" | "own" | "public" | "offer";
  materials: MaterialLine[] | null;
  labour: number;
  offer?: { contractId: string; price: number; region: BankingRegion };
  itemId?: string;
}

// ── Saved state ───────────────────────────────────────────────────────────────

/**
 * A fit under way at a yard (saved; local ms). Its stages in order: `licence` (a unit bought), `materials` (bought into the warehouse
 * there), `make`, `fit`. `sentAt`: that stage's call went with no answer, reconciled before anything more (never sent again blind):
 * `before` is our units of the design (licence) or our items of it at the port (make) as they stood.
 */
export interface FitJob {
  shipId: string;
  ship: string;
  port: string;
  componentId: string;
  name: string;
  slot: Slot;
  grade: number;
  stage: "licence" | "materials" | "make" | "fit";
  sentAt: number | null;
  before?: number;
  itemId?: string;
  offer?: { contractId: string; price: number; region: BankingRegion };
  /** What making one takes (absent for one already made): the materials, the labour, and the materials' price as weighed (pence). */
  materials?: MaterialLine[];
  labour?: number;
  materialsPence?: number;
  /** The fitting fee as weighed (pence): booked when a fit with no answer turns out to have landed. */
  fee: number;
  /** The warehouse lease here before the materials grew it (gone back to once they are used). */
  leaseBefore?: number | null;
  /** The materials this job bought into the warehouse here (commodity, tons): held for its make, sold off if it stops before. */
  bought?: Array<[string, number]>;
  spent: number;
  at: number;
  gainPerHour: number;
  value: number;
  cost: number;
  /** Her effective hold before the fit (measured after, for the design's hold share). */
  holdBefore?: number;
}

export interface FitRec {
  at: string;
  shipId: string;
  ship: string;
  port: string;
  name: string;
  slot: Slot;
  spentPence: number;
  feePence: number;
  gainPerHourPence: number;
  outcome: "fitted" | "stopped";
  why?: string;
}

export interface ComponentStats {
  fitted: number;
  spentPence: number;
  feesPence: number;
  unitsBought: number;
  made: number;
}

/** Our research project as the autopilot keeps it (local ms), and a start with no answer (never sent again). */
export interface RndProjectRec {
  id: string | null;
  slot: Slot;
  grade: number;
  trialShipId: string;
  /** Server ms the start was sent. */
  startedAt: number;
  startFee: number;
  /** Prototype materials we bought, where, what they cost (pence), and the warehouse lease there before (gone back to once used). */
  protoYard?: string;
  protoSpent?: number;
  protoLeaseBefore?: number | null;
  /**
   * What the prototype takes (commodity, tons; held at `protoYard` for it until taken, so no make or own-materials build there counts
   * them), what we bought for it there (sold off if the project closes before taking them), and whether it has taken them.
   */
  protoNeed?: Array<[string, number]>;
  protoBought?: Array<[string, number]>;
  protoDone?: boolean;
  pending?: { at: number } | null;
}

/** Materials left in a warehouse of ours by a fit stopped or a project closed (local ms): sold into that port's bids, the lease back after. */
export interface LeftoverRec {
  port: string;
  /** Commodity, tons still to sell. */
  goods: Array<[string, number]>;
  /** The lease to go back to once they are gone (null: none grown for them). */
  leaseBefore: number | null;
  at: number;
  what: string;
}

/** A design granted to us and what was done with it. */
export interface GrantRec {
  componentId: string;
  name: string;
  slot: Slot;
  grade: number;
  effects: string[];
  at: number;
  verdict: "worth having" | "disappointing" | "unreadable";
  action: "kept" | "made public" | "public failed";
}

export interface RndStats {
  started: number;
  abandoned: number;
  granted: number;
  spentPence: number;
  licenceIncomePence: number;
}

export interface RndMemory {
  job: FitJob | null;
  fits: FitRec[];
  /** Spends on components (local ms, pence) over the last 24 real hours: the budget. */
  spends: Array<[number, number]>;
  /** Hold share a design added, as our fits measured it. */
  learned: Array<[string, number]>;
  stats: ComponentStats;
  project: RndProjectRec | null;
  grants: GrantRec[];
  /** Our licence offers (contract ids) for designs of ours, and when a post last went with no answer (local ms; none posted again before RND_PENDING_MS). */
  offerIds: string[];
  offerSentAt: number;
  rndStats: RndStats;
  /** Materials left by a fit stopped or a project closed, waiting to be sold (absent in older saves: none). */
  leftovers?: LeftoverRec[];
}

export function emptyRnd(): RndMemory {
  return {
    job: null,
    fits: [],
    spends: [],
    learned: [],
    stats: { fitted: 0, spentPence: 0, feesPence: 0, unitsBought: 0, made: 0 },
    project: null,
    grants: [],
    offerIds: [],
    offerSentAt: 0,
    rndStats: { started: 0, abandoned: 0, granted: 0, spentPence: 0, licenceIncomePence: 0 },
  };
}

const JOB_STAGES: ReadonlyArray<FitJob["stage"]> = ["licence", "materials", "make", "fit"];

/** (commodity, tons) pairs as saved: only those that parse, tons above zero. */
function goodsPairs(x: unknown): Array<[string, number]> {
  return (Array.isArray(x) ? x : []).filter((p): p is [string, number] => Array.isArray(p) && typeof p[0] === "string" && Number.isFinite(p[1]) && p[1] > 0).map(([g, q]) => [g, q]);
}

/** An older save (or none): everything optional, nothing trusted that doesn't parse. */
export function restoreRnd(s: Partial<RndMemory> | undefined): RndMemory {
  const m = emptyRnd();
  if (!s) return m;
  const j = s.job;
  if (j && typeof j.shipId === "string" && typeof j.port === "string" && typeof j.componentId === "string" && JOB_STAGES.includes(j.stage) && Number.isFinite(j.at)) {
    m.job = { ...j, sentAt: Number.isFinite(j.sentAt) ? j.sentAt : null, spent: Number.isFinite(j.spent) ? j.spent : 0, fee: Number.isFinite(j.fee) ? j.fee : 0 };
    if (j.bought !== undefined) m.job.bought = goodsPairs(j.bought);
  }
  m.fits = (Array.isArray(s.fits) ? s.fits : []).filter((f) => f && typeof f.shipId === "string" && typeof f.at === "string").slice(-FITS_KEPT);
  m.spends = (Array.isArray(s.spends) ? s.spends : []).filter((x) => Array.isArray(x) && Number.isFinite(x[0]) && Number.isFinite(x[1])).slice(-200);
  m.learned = (Array.isArray(s.learned) ? s.learned : []).filter((x) => Array.isArray(x) && typeof x[0] === "string" && Number.isFinite(x[1])).slice(-LEARNED_KEPT);
  for (const k of Object.keys(m.stats) as (keyof ComponentStats)[]) {
    const v = s.stats?.[k];
    if (typeof v === "number" && Number.isFinite(v)) m.stats[k] = v;
  }
  const p = s.project;
  if (p && SLOTS.includes(p.slot) && Number.isFinite(p.grade) && typeof p.trialShipId === "string" && Number.isFinite(p.startedAt)) {
    m.project = { ...p, id: typeof p.id === "string" ? p.id : null, startFee: Number.isFinite(p.startFee) ? p.startFee : 0, pending: p.pending && Number.isFinite(p.pending.at) ? { at: p.pending.at } : null };
    if (p.protoNeed !== undefined) m.project.protoNeed = goodsPairs(p.protoNeed);
    if (p.protoBought !== undefined) m.project.protoBought = goodsPairs(p.protoBought);
  }
  const lo = (Array.isArray(s.leftovers) ? s.leftovers : [])
    .filter((l) => l && typeof l.port === "string" && Number.isFinite(l.at))
    .map((l) => ({ port: l.port, goods: goodsPairs(l.goods), leaseBefore: Number.isFinite(l.leaseBefore) ? l.leaseBefore : null, at: l.at, what: typeof l.what === "string" ? l.what : "materials" }))
    .filter((l) => l.goods.length > 0 || l.leaseBefore !== null)
    .slice(-20);
  if (lo.length) m.leftovers = lo;
  m.grants = (Array.isArray(s.grants) ? s.grants : []).filter((g) => g && typeof g.componentId === "string" && Number.isFinite(g.at)).slice(-20);
  m.offerIds = (Array.isArray(s.offerIds) ? s.offerIds : []).filter((x) => typeof x === "string").slice(-20);
  if (Number.isFinite(s.offerSentAt)) m.offerSentAt = s.offerSentAt!;
  for (const k of Object.keys(m.rndStats) as (keyof RndStats)[]) {
    const v = s.rndStats?.[k];
    if (typeof v === "number" && Number.isFinite(v)) m.rndStats[k] = v;
  }
  return m;
}

/** (commodity, tons) lists added together. */
export function addGoods(a: ReadonlyArray<[string, number]> | undefined, b: ReadonlyArray<[string, number]>): Array<[string, number]> {
  const out = new Map<string, number>(a ?? []);
  for (const [g, q] of b) out.set(g, (out.get(g) ?? 0) + q);
  return [...out];
}

/** Spent on components over the last 24 real hours (pence), the older entries dropped. */
export function spentLastDay(m: RndMemory, now: number): number {
  m.spends = m.spends.filter(([t]) => now - t < 24 * 3_600_000);
  return m.spends.reduce((n, [, p]) => n + p, 0);
}

// ── Research ─────────────────────────────────────────────────────────────────

/**
 * The slot and grade to research (guide 3.19: you choose a slot and a grade, the design is drawn at random among the free ones): by
 * slot priority, the highest grade the world has opened (and the phase allows) with more designs free than houses researching them.
 */
export function rndPick(pool: readonly PoolEntry[], phase: number): { slot: Slot; grade: number } | null {
  for (const slot of RND_SLOT_PRIORITY) {
    const rows = pool.filter((p) => p.slot === slot && p.released && p.grade <= Math.min(3, phase) && p.free > p.researching).sort((a, b) => b.grade - a.grade);
    if (rows[0]) return { slot, grade: rows[0].grade };
  }
  return null;
}

/**
 * Whether to start a project now: the game allows it, its whole expected cost (the start fee and RND_EXPECTED_GAME_DAYS of upkeep)
 * fits the budget, the season leaves time for it and a day's use after, and the fee is spare beyond a buffer. The cost, or why not.
 */
export function rndStartCase(st: RndStatus, c: { budget: number; seasonLeftGameDays: number; spare: number }): { ok: true; cost: number } | { ok: false; why: string } {
  const cr = (p: number) => `${Math.round(p / 100).toLocaleString("en-GB")} Cr`;
  if (!st.can_start) return { ok: false, why: st.cannot_start_reason ? `the game says no: ${st.cannot_start_reason}` : "the game doesn't allow a start now" };
  const cost = Math.max(0, st.start_fee_pence) + Math.max(0, st.upkeep_per_game_day_pence) * RND_EXPECTED_GAME_DAYS;
  if (cost > c.budget) return { ok: false, why: `its expected cost ${cr(cost)} (fee and ~${RND_EXPECTED_GAME_DAYS} game days of upkeep) is over the ${cr(c.budget)} budget` };
  if (c.seasonLeftGameDays < RND_EXPECTED_GAME_DAYS + RND_USE_GAME_DAYS) return { ok: false, why: "the season would end before a grant could be used" };
  if (c.spare < st.start_fee_pence + RND_CASH_BUFFER_PENCE) return { ok: false, why: `no ${cr(st.start_fee_pence + RND_CASH_BUFFER_PENCE)} spare for the fee and a buffer` };
  return { ok: true, cost };
}

/**
 * Why a live project should be given up now (null: carry on): its upkeep unpaid RND_ABANDON_UNPAID_DAYS running, what it has cost
 * and is still expected to cost past the budget by a quarter, or the season ending before the grant could be used.
 */
export function rndAbandonCase(p: ProjectView, c: { spent: number; budget: number; seasonLeftGameDays: number }): string | null {
  if (p.unpaid_days >= RND_ABANDON_UNPAID_DAYS) return `its upkeep went unpaid ${p.unpaid_days} game days running (three give it up with nothing back)`;
  const left = Math.max(0, 4 - p.stage) * (RND_EXPECTED_GAME_DAYS / 4);
  const still = left * Math.max(0, p.upkeep_per_game_day_pence);
  if (c.spent + still > c.budget * 1.25) return `what it has cost and still would (~${Math.round((c.spent + still) / 100)} Cr) is well past the budget`;
  if (c.seasonLeftGameDays < left) return "the season would end before the grant";
  return null;
}

/** The trial ship (guide 3.19: grade 2 counts legs ending in regional or rougher water, grade 3 oceanic): a hull rated for that water. */
export function trialHullOk(grade: number, hull: string): boolean {
  if (grade >= 3) return hull === "oceanic";
  if (grade === 2) return hull === "regional" || hull === "oceanic";
  return true;
}

// ── Report ────────────────────────────────────────────────────────────────────

/** R&D and components for the panel (`/rnd`) and the digest. Pence; times ISO. */
export interface RndReport {
  components: {
    /** The switch in force, its budget, what was spent on components in the last 24 real hours. */
    enabled: boolean;
    budgetPence: number;
    spent24hPence: number;
    blocked: string | null;
    action: string;
    /** A fit under way (stage) and the last fits. */
    job: { ship: string; port: string; name: string; slot: Slot; stage: string; sentAt: string | null } | null;
    fits: FitRec[];
    /** Designs we could make, as last read: where they come from, and the effect words. */
    designs: Array<{ componentId: string; name: string; slot: Slot; grade: number; effects: string[]; source: string; readable: boolean; unitPricePence: number | null }>;
    stats: ComponentStats;
  };
  research: {
    enabled: boolean;
    budgetPence: number;
    blocked: string | null;
    action: string;
    checkedAt: string | null;
    canStart: boolean | null;
    project: {
      slot: Slot;
      grade: number;
      stage: number;
      stageName: string;
      points: number;
      required: number;
      trialShip: string | null;
      unpaidDays: number;
      upkeepPerDayPence: number;
      spentPence: number;
      startedAt: string | null;
    } | null;
    patents: Array<{ componentId: string; name: string; slot: Slot; grade: number; status: string; upkeepPerDayPence: number; arrearsDays: number }>;
    grants: GrantRec[];
    stats: RndStats;
  };
}
