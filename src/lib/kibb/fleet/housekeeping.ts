/**
 * Fleet housekeeping (pure; the fleet manager reads, judges with these and makes the calls): breaking up dead weight (guide
 * 3.4) and moving the home port when the trade and the cash have moved (guide 3.12). Both are autonomous (`autoBreakUp`,
 * `autoRelocate`; the user's "off" is a ceiling the AI can't lift) and can't be undone, so every threshold leans towards
 * doing nothing.
 *
 * Disposal: the yard where a ship lies buys her for 35% of her rebuild value (her class at the yards' full price, 150 Cr a gun,
 * fitted components), paid by that region's Crown (409 while it can't). Net worth counts a hull at its build value, so a
 * break-up gives 65% of it away at once: only a ship that has earned less than her share of the upkeep for days on end, with no
 * lane from where she lies that beats it (or an out-of-date class whose slot a paying new hull would take, the fleet being
 * full), and only when the upkeep saved by the horizon, less what she would earn, makes up the net worth given away (judged on
 * that 35%, the worst case). A sale pays at least half and keeps her sailing, and the ship broker (guide 3.4: the Merchant
 * Adventurers of her region) buys a hull listed on the Exchange at a yard port far below its rebuild value once the listing is a
 * game hour old, looking every 2 game hours: so at the yard she is always listed first, on the Exchange, down a ladder of the
 * server's rebuild value (BROKER_LADDER, each step held BROKER_STEP_GAME_H), and broken up only when unsold just over the band's
 * floor. A hull we disposed of that way and the broker resells is never bought back by our own buyer.
 *
 * Home: upkeep is billed in the home region every game day (and marques, patrols and R&D are paid there); a home where the cash
 * no longer lands is kept funded by remits whose fees are the measurable cost of it (keepHomeFloor, auto-remit). A move costs
 * 2,500 Cr from the new home's vault, at most once a real day (we keep three): taken when one region paid most of those fees and
 * the fees to the season's end (or the horizon) beat the move 1.5x over.
 */

import type { BankingRegion, CatalogPort } from "../types";
import type { TripRecord } from "./agent";

/** A break-up pays this share of the rebuild value (guide 3.4); a sale to another company at least SALE_MIN_SHARE of it. */
export const BREAK_UP_SHARE = 0.35;
export const SALE_MIN_SHARE = 0.5;
/**
 * At the yard she is listed for sale on the Exchange (never `unlisted`: the ship broker buys only what the Exchange shows, guide
 * 3.4) before any break-up, down this ladder of the server's rebuild value, each step held this many game hours (the broker looks
 * only at listings a game hour old, every 2 game hours). The last step is a point over the band's 50% floor: the band is checked
 * again at purchase (a `409` if the rebuild value moved, guide 3.4), so a listing at the floor itself is left unbuyable by any rise
 * in the yards' prices. A step down is a withdrawal and a new listing. Unsold at the last step after its time: broken up.
 */
export const BROKER_LADDER: readonly number[] = [0.6, 0.55, 0.51];
export const BROKER_STEP_GAME_H = 3;
/** A listed ship's listing is read back at most this often (real ms) while she waits: sold, or closed under her. */
export const LIST_CHECK_MS = 5 * 60_000;

/** The ladder in words, for the log: "60%, 55% then 51% of her rebuild value, 3 game hours a step". */
export function ladderText(): string {
  const pct = BROKER_LADDER.map((x) => `${Math.round(x * 100)}%`);
  return `${pct.slice(0, -1).join(", ")} then ${pct.at(-1)} of her rebuild value, ${BROKER_STEP_GAME_H} game hours a step`;
}

/** The ladder's price for `step` (pence): its share of `rebuild` rounded up, never under the band's floor of it (guide 3.4: 50%..=150%). */
export function ladderPrice(rebuild: number, step: number): number {
  const share = Math.max(SALE_MIN_SHARE, BROKER_LADDER[Math.min(Math.max(0, step), BROKER_LADDER.length - 1)]);
  return Math.max(100, Math.ceil(Math.max(0, rebuild) * share));
}

/**
 * A ship being retired bound for another yard (its Crown refused, out of reach, or the port she is stuck at): she is listed there
 * from the ladder's top, since that yard's buyers (and another region's broker, guide 3.4) never saw her, never broken up unlisted.
 */
export function freshLadder(m: RetireMark): void {
  m.listTried = false;
  delete m.ladderStep;
  delete m.ladderRebuild;
  delete m.ladderRetry;
}
/** Dead weight: trips over this many trailing game days are what she earned lately. */
export const DEAD_TRAIL_GAME_DAYS = 4;
/** A candidate this many checks running (the bills cadence, 10 real min) over this many game days at least: never one bad trip. */
export const DEAD_STREAK_CHECKS = 3;
export const DEAD_STREAK_GAME_DAYS = 2;
/** A class this many phases behind the one open counts as out of date (the buyer wouldn't build it now). */
export const OBSOLETE_PHASES_BEHIND = 2;
/** Upkeep saved and earnings given up are weighed to the season's end, never further than this (real ms). */
export const HORIZON_MAX_MS = 7 * 24 * 3_600_000;
/** A new hull's net counted for the slot a break-up frees (it may not be built at once, or pay as planned). */
export const REPLACEMENT_WEIGHT = 0.5;
/** A Crown that couldn't pay for a break-up (409) isn't asked again for this many game days. */
export const CROWN_REFUSED_GAME_DAYS = 1;
/** A break-up or listing with no answer is read back after this (real ms), never sent blind again. */
export const VERIFY_MS = 2 * 60_000;
/** A ship whose retirement was refused (by the server, or a check on her) isn't judged again for this long (real ms). */
export const RETIRE_SKIP_MS = 6 * 3_600_000;
/** A ship asked to sail for the yard that hasn't left the port she lies at in this many game days: her retiring is withdrawn. */
export const RETIRE_SAIL_GAME_DAYS = 2;
/** Moving home (guide 3.12): the price, the margin the fees must beat it by, the window they are read over (game days), the share one region must have paid, and our gap between moves (real ms; the server's is a day). */
export const RELOCATE_FEE_PENCE = 250_000;
export const RELOCATE_MARGIN = 1.5;
export const RELOCATE_WINDOW_GAME_DAYS = 3;
export const RELOCATE_DONOR_SHARE = 0.6;
export const RELOCATE_GAP_MS = 3 * 24 * 3_600_000;
/** A refused move (no presence, funds, a cove) or one with no answer waits this long before the next try (real ms). */
export const RELOCATE_RETRY_MS = 60 * 60_000;
/** Records kept: fees, the Exchequer's top-ups, ships retired. */
export const HOME_FEES_KEPT = 200;
export const TOP_UPS_KEPT = 30;
export const RETIRED_KEPT = 30;

export const REGIONS: readonly BankingRegion[] = ["channel", "north_sea", "baltic", "iberia", "caribbean", "indian_ocean", "east_indies", "america"];

const cr = (pence: number) => `${Math.round(pence / 100).toLocaleString("en-GB")} Cr`;

export type RetireReason = "idle" | "obsolete";

/**
 * A ship the fleet is retiring (saved). `wanted`: judged dead weight, her fresh checks still to pass at her next turn in port;
 * `sail`: bound empty for `yard` (or there, between steps of the broker's ladder); `listed`: for sale on the Exchange at the yard
 * (`listed.id` null while a listing with no answer is looked for); `breakup`: broken up at her next turn there; `verify`: a
 * break-up with no answer (`sentAt`, local ms), read back first.
 */
export interface RetireMark {
  stage: "wanted" | "sail" | "listed" | "breakup" | "verify";
  reason: RetireReason;
  why: string;
  yard: string;
  /** Her name and class when marked (the record, should she go before her agent is read again). */
  ship?: string;
  cls?: string;
  /** Our rebuild figure (her class at full price and her guns), the payout it gives, and server ms decided. */
  rebuild: number;
  payout: number;
  at: number;
  /**
   * Local ms. `step`: her step on the broker's ladder (BROKER_LADDER; absent on an older save's day-long listing, which then holds
   * one step from `at` and steps down like the first); `rebuild`: the server's rebuild value the listing gave; `cancelSentAt`: our
   * withdrawal at the step's end was sent (a cancelled listing read back then is that step taken, not a listing closed under her).
   */
  listed?: { id: string | null; price: number; at: number; until: number; sentAt?: number; checkedAt?: number; step?: number; rebuild?: number; cancelSentAt?: number };
  /** A listing was tried (or wasn't to be): she is broken up at the yard. Cleared at another yard (its ladder starts again). */
  listTried?: boolean;
  /** Between steps of the ladder: the step to list at next, and the server's rebuild value the last listing gave (absent: the first). */
  ladderStep?: number;
  ladderRebuild?: number;
  /** The step whose listing was refused for the band (400) and is tried once more, priced afresh (absent: none). */
  ladderRetry?: number;
  sentAt?: number;
  /** Where she was first asked to sail for the yard from, and since when (server ms): reset at each port she reaches. */
  sailWait?: { port: string; since: number };
}

/** A ship housekeeping retired: broken up at a yard, or sold where she lay while listed (local ms). */
export interface RetireRec {
  at: number;
  shipId: string;
  ship: string;
  cls: string;
  port: string;
  how: "broken_up" | "sold";
  /** The yard's payout, or the sale price. */
  pence: number;
  rebuild: number;
  why: string;
}

/** A remit fee paid to keep the home region funded (server ms): our own floor top-up (keepHomeFloor), or auto-remit for a bill. */
export interface HomeFee {
  at: number;
  from: BankingRegion;
  fee: number;
  how: "floor" | "auto";
}

/** The Exchequer topped a Crown up (guide 3.1: public, never how much; server ms). */
export interface CrownTopUp {
  at: number;
  region: BankingRegion | null;
  title: string;
}

/** A dead-weight candidate's run of checks (server ms). */
export interface Streak {
  reason: RetireReason;
  why: string;
  since: number;
  checks: number;
}

export function asRegion(v: unknown): BankingRegion | null {
  return typeof v === "string" && (REGIONS as readonly string[]).includes(v) ? (v as BankingRegion) : null;
}

/** A region named in words ("the North Sea Crown", "north_sea"): the first found, or null. */
export function regionIn(text: string): BankingRegion | null {
  const t = text.toLowerCase().replace(/[_-]+/g, " ");
  for (const r of REGIONS) if (t.includes(r.replace(/_/g, " "))) return r;
  return null;
}

/**
 * A time a refusal names (a field of its body, or the first timestamp in its detail; server ms), within `maxMs` of now, else
 * null: when the server lets a move be made again (`409`, guide 3.12).
 */
export function namedTime(body: unknown, detail: string, now: number, maxMs: number): number | null {
  const b = (typeof body === "object" && body ? body : {}) as Record<string, unknown>;
  const named = ["next_relocation_at", "retry_at", "available_at", "allowed_at", "until"].map((k) => b[k]).find((v): v is string => typeof v === "string");
  const text = named ?? detail.match(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/)?.[0];
  const t = text ? Date.parse(text) : Number.NaN;
  return Number.isFinite(t) && t > now && t <= now + maxMs ? t : null;
}

/** What her trips made per real hour over the trailing window (`since`: local ms), and how many finished in it. */
export function trailingPerHour(trips: readonly TripRecord[], since: number, windowHours: number): { perHour: number; trips: number } {
  const recent = trips.filter((t) => Date.parse(t.at) >= since);
  const profit = recent.reduce((n, t) => n + (Number.isFinite(t.profitPence) ? t.profitPence : 0), 0);
  return { perHour: windowHours > 0 ? profit / windowHours : 0, trips: recent.length };
}

/**
 * What her last trips made a real hour over all the time since the first of them began, idle time to `now` (local ms) included: a
 * slow-fading measure of what she earns when work comes, so a lull of a game day or two doesn't read as a ship that never pays.
 */
export function recentPerHour(trips: readonly TripRecord[], now: number): number {
  let start = Infinity;
  let profit = 0;
  for (const t of trips) {
    const end = Date.parse(t.at);
    if (!Number.isFinite(end)) continue;
    start = Math.min(start, end - Math.max(0, t.hours) * 3_600_000);
    profit += Number.isFinite(t.profitPence) ? t.profitPence : 0;
  }
  const hours = (now - start) / 3_600_000;
  return Number.isFinite(hours) && hours > 0 ? profit / hours : 0;
}

/** The next check's run: the same reason carries it on, another starts it again, none ends it. */
export function nextStreak(prev: Streak | undefined, v: { reason: RetireReason; why: string } | null, now: number): Streak | undefined {
  if (!v) return undefined;
  if (prev && prev.reason === v.reason) return { ...prev, why: v.why, checks: prev.checks + 1 };
  return { reason: v.reason, why: v.why, since: now, checks: 1 };
}

/** A run long enough to act on: DEAD_STREAK_CHECKS checks over DEAD_STREAK_GAME_DAYS at least. */
export function matured(s: Streak, now: number, gameDayMs: number): boolean {
  return s.checks >= DEAD_STREAK_CHECKS && now - s.since >= DEAD_STREAK_GAME_DAYS * gameDayMs;
}

/** What may never be retired, whatever she earns (null: she may be judged). */
export function neverRetire(f: { ships: number; courier: boolean; smuggler: boolean; arrested: boolean; aiOrder: boolean; components: number }): string | null {
  if (f.ships <= 1) return "the fleet's last ship";
  if (f.courier) return "a courier (a packet), never a trader";
  if (f.smuggler) return "she smuggles for the fleet";
  if (f.arrested) return "she is arrested";
  if (f.aiOrder) return "an AI order is in force for her";
  // Their worth (research, licences) isn't priced here: never scrapped on a figure that leaves them out.
  if (f.components > 0) return "components are fitted (their worth isn't priced)";
  return null;
}

/** What keeps her from changing hands now (guide 3.4): at sea, in a convoy, cargo or sealed freight aboard, passengers, a lane. */
export function busyNow(h: { atSea: boolean; convoy: boolean; cargoTons: number; sealedTons: number; paxHeads: number; lane: "none" | "planned" | "loaded" }): string | null {
  if (h.atSea) return "she is at sea";
  if (h.convoy) return "she is in a convoy";
  if (h.sealedTons > 0) return "sealed freight is aboard";
  if (h.cargoTons > 0) return "cargo is aboard";
  if (h.paxHeads > 0) return "passengers are aboard";
  if (h.lane === "loaded") return "a loaded lane";
  if (h.lane === "planned") return "a lane is planned for her";
  return null;
}

/**
 * Whether she is dead weight now, and why (null: she isn't). `idle`: in port, empty, no lane, earning no more than the upkeep she
 * adds lately, with no lane from where she lies beating it (cash no object). `obsolete`: a class the buyer wouldn't build now,
 * with the fleet full and a new hull that would pay back within the limit waiting for her slot.
 */
export function deadWeight(x: {
  idle: boolean;
  /** What the fleet would pay less a real hour without her (sprawl on her tons, an oceanic hull's flat rate). */
  upkeepPerHour: number;
  trailingPerHour: number;
  /** The best lane from where she lies, per real hour (null: none clears the margin). */
  bestLanePerHour: number | null;
  obsolete: string | null;
  slot: { cls: string; yard: string; payback: number } | null;
}): { reason: RetireReason; why: string } | null {
  if (x.idle && x.upkeepPerHour > 0 && x.trailingPerHour <= x.upkeepPerHour && (x.bestLanePerHour ?? 0) <= x.upkeepPerHour) {
    return { reason: "idle", why: "no lane beat her upkeep" };
  }
  if (x.obsolete && x.slot) {
    return { reason: "obsolete", why: `${x.obsolete}, and her slot would take a ${x.slot.cls} at ${x.slot.yard} paying back in ~${x.slot.payback.toFixed(1)} h` };
  }
  return null;
}

export interface BreakUpCase {
  payout: number;
  upkeepSaved: number;
  /** Her earnings given up, and a new hull's in her slot (weighted), over the horizon. */
  expected: number;
  replacement: number;
  /** Cash by the horizon, broken up against kept: the payout, the upkeep saved and the slot's new hull, less her earnings. */
  gain: number;
  /** Net worth given away at once (the hull counts at its build value, the payout is 35% of it). */
  worthLoss: number;
  /** Net worth by the horizon, broken up against kept: the gain less the hull given up. */
  worthGain: number;
  ok: boolean;
  why: string;
}

/**
 * The break-up's case over `horizonHours` (real): the payout plus the upkeep saved (plus a new hull's net in her slot, at
 * REPLACEMENT_WEIGHT) must beat what she would earn, and make up the net worth the hull gives away by then.
 */
export function breakUpCase(c: { rebuild: number; upkeepPerHour: number; earnPerHour: number; horizonHours: number; replacementPerHour?: number }): BreakUpCase {
  const h = Math.max(0, c.horizonHours);
  const payout = Math.round(Math.max(0, c.rebuild) * BREAK_UP_SHARE);
  const upkeepSaved = Math.round(Math.max(0, c.upkeepPerHour) * h);
  const expected = Math.round(Math.max(0, c.earnPerHour) * h);
  const replacement = Math.round(Math.max(0, c.replacementPerHour ?? 0) * h * REPLACEMENT_WEIGHT);
  const gain = payout + upkeepSaved + replacement - expected;
  const worthLoss = Math.max(0, c.rebuild) - payout;
  const worthGain = gain - Math.max(0, c.rebuild);
  const ok = h > 0 && gain > 0 && worthGain >= 0;
  const over = `over ${Math.round(h)} h`;
  const saved = `~${cr(upkeepSaved)} of upkeep saved${replacement > 0 ? ` and ~${cr(replacement)} from a new hull in her slot` : ""}`;
  const why =
    h <= 0
      ? "no time left before the season's end to weigh it"
      : gain <= 0
        ? `what she would earn ${over} (~${cr(expected)}) beats the payout of ${cr(payout)} and ${saved}`
        : worthGain < 0
          ? `${saved}, less her earnings (~${cr(expected)}), ${over} doesn't make up the ${cr(worthLoss)} of net worth the hull gives away`
          : `${saved}, less her earnings (~${cr(expected)}), ${over} makes up the ${cr(worthLoss)} of net worth the hull gives away`;
  return { payout, upkeepSaved, expected, replacement, gain, worthLoss, worthGain, ok, why };
}

export interface RelocationCase {
  windowDays: number;
  /** Fees paid from other regions to fund home over the window, per game day, and per donor (largest first). */
  total: number;
  perDay: number;
  byRegion: Array<{ region: BankingRegion; fees: number; share: number }>;
  donor: BankingRegion | null;
  /** The fees to the horizon at this pace, and what they must beat (the move 1.5x over). */
  saving: number;
  threshold: number;
  ok: boolean;
  /** `unknown` (no home yet), `untracked` (under a window of fees), `none` (no fees), `split` (no one region paid most), `small` (not worth the move), `ok`. */
  code: "unknown" | "untracked" | "none" | "split" | "small" | "ok";
  why: string;
}

/**
 * Whether the home is in the wrong region (guide 3.12): the remit fees paid to fund it over the last RELOCATE_WINDOW_GAME_DAYS
 * (tracked that long at least), one region having paid RELOCATE_DONOR_SHARE of them, and at that pace over `daysLeft` game days
 * more than the move's fee RELOCATE_MARGIN times over. The vault, presence and gap checks are the caller's.
 */
export function relocationCase(x: { fees: readonly HomeFee[]; now: number; since: number | null; gameDayMs: number; daysLeft: number; home: BankingRegion | null }): RelocationCase {
  const windowDays = RELOCATE_WINDOW_GAME_DAYS;
  const windowMs = windowDays * x.gameDayMs;
  const recent = x.fees.filter((f) => f.at >= x.now - windowMs && f.at <= x.now + 60_000 && f.from !== x.home && f.fee > 0);
  const total = recent.reduce((n, f) => n + f.fee, 0);
  const by = new Map<BankingRegion, number>();
  for (const f of recent) by.set(f.from, (by.get(f.from) ?? 0) + f.fee);
  const byRegion = [...by]
    .map(([region, fees]) => ({ region, fees, share: total > 0 ? fees / total : 0 }))
    .sort((a, b) => b.fees - a.fees);
  const perDay = total / windowDays;
  const saving = Math.round(perDay * Math.max(0, x.daysLeft));
  const threshold = Math.round(RELOCATE_FEE_PENCE * RELOCATE_MARGIN);
  const top = byRegion[0];
  const base = { windowDays, total, perDay: Math.round(perDay), byRegion, saving, threshold };
  const no = (code: RelocationCase["code"], why: string, donor: BankingRegion | null = null): RelocationCase => ({ ...base, donor, ok: false, code, why });
  if (!x.home) return no("unknown", "the home port isn't known yet");
  if (x.since === null || x.now - x.since < windowMs) return no("untracked", `remit fees tracked for under ${windowDays} game days`);
  if (!top || total <= 0) return no("none", `no remit fees paid to fund ${x.home} over the last ${windowDays} game days`);
  if (top.share < RELOCATE_DONOR_SHARE) return no("split", `no one region paid most of the ${cr(total)} in remit fees that kept ${x.home} funded (${top.region} ${Math.round(top.share * 100)}%)`);
  if (saving <= threshold) {
    return no(
      "small",
      `remit fees of ~${cr(perDay)} a game day (${top.region} ${Math.round(top.share * 100)}%) over the ${Math.round(x.daysLeft)} game days ahead (~${cr(saving)}) don't beat the move's ${cr(RELOCATE_FEE_PENCE)} ${RELOCATE_MARGIN}x over`,
      top.region,
    );
  }
  return {
    ...base,
    donor: top.region,
    ok: true,
    code: "ok",
    why: `${top.region} paid ${Math.round(top.share * 100)}% of the ${cr(total)} in remit fees that kept ${x.home} funded over ${windowDays} game days: ~${cr(saving)} by the season's end at that pace, against the move's ${cr(RELOCATE_FEE_PENCE)}`,
  };
}

/** A new home port's rank among those where we have presence: a hub with a shipyard first, then a hub, then a yard. */
export function homeRank(p: CatalogPort): number {
  return p.is_hub && p.has_shipyard ? 0 : p.is_hub ? 1 : p.has_shipyard ? 2 : 3;
}
