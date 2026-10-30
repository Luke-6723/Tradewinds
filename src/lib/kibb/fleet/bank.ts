/**
 * Our own bank (guide 3.13.4 "Run a bank", 3.12 bank drafts, 3.13.8 lending lines): a conservative first version, pure: no I/O. The
 * manager reads our bank, the Crown's fees and our lines, makes every call (runBank) and keeps the memory; this says when to charter,
 * what exchange fees to post, and the lending line's terms. OFF by default (`runBank`): the charter's 10,000 Cr fee goes to the Crown
 * and is never refunded, and it needs 50,000 Cr of our own funds after it.
 *
 * - **Charter** only with the setting on, net worth at least `bankMinNetWorthPence`, the fee, the own funds and the liquid buffer
 *   spare (our deposits at healthy banks counted: they come back for it) beyond the fleet's loads and fences, the buyer's next hull and
 *   spends short of cash lately, the season normal and no repayment short. Deposit rates 0 / 0 and uninsured: this
 *   version takes no depositors' money on purpose (anything a depositor puts with us anyway is kept out of spending in that region's
 *   floor). Saved before it is sent; a call with no answer is looked for among the banks and never sent blind again. The autopilot
 *   never winds the bank down (a warning is logged instead): that, and the deposit rates, stay the owner's, by hand.
 * - **Drafts** (passive fee income): every company's remittance into a region is carried by the cheapest open bank whose fee there
 *   (less any client discount) is strictly under the Crown's and whose vault there can already pay it. Into each region where our
 *   vault holds a clear surplus beyond its floor and the loads to be bought there (never home: the bills are paid from it), we post 85%
 *   of the median Crown fee into it, never under 20 bps. A draft pays only out of cash already in our destination vault, so a region
 *   whose surplus falls is dropped at once; others are re-posted only when the Crown's fees move materially, at most every few game hours
 *   (a schedule left unchanged longest wins ties). The fees, as the `bank_draft` notices and our bank's own figures show, are income.
 * - **Lending line** (interest income): one line, ship liens and balloon only, with recourse, in the regions where our vault has spare
 *   (home among them only then), at 70% of the Goldsmiths' rate for each request's term, at most 50% of the pledged ship's rebuild value
 *   (a foreclosed ship is credited at 80%), borrowers with no default ever, no walk-away and modest debts, 5,000 Cr per borrower, the
 *   lending budget in all, terms that mature before the season's endgame. Its room not yet lent is fenced from deposits and the charter,
 *   but never holds the fleet back: a spend that needs it counts it as cash and withdraws the line first, and it never stops a loan. The
 *   line comes down when the fleet needs the cash, a repayment is short, we owe on a loan or the season is ending.
 */

import type { BankingRegion, BankResult, LendingLine, LendingLineTerms } from "../schema";
import type { AchRate } from "../types";
import { asRegion } from "./housekeeping";

/** The charter (guide 3.13.4): the Crown's fee, never refunded, and the bank's own funds needed after it (pence). */
export const BANK_CHARTER_FEE_PENCE = 1_000_000;
export const BANK_OWN_FUNDS_PENCE = 5_000_000;
/** Defaults for the settings: least net worth before chartering, and the most our lending lines have out (pence). */
export const BANK_DEFAULT_MIN_WORTH_PENCE = 15_000_000;
export const BANK_DEFAULT_LENDING_PENCE = 2_000_000;
/** Our deposit terms: nothing paid, uninsured, and (should anyone make a notice deposit at 0%) the longest notice the Crown allows. */
export const BANK_DEPOSIT_RATE_BPS = 0;
export const BANK_NOTICE_GAME_H = 720;
/** Our exchange fee into a region: this share of the median Crown fee into it, never under the floor (bps). */
export const BANK_FEE_SHARE = 0.85;
export const BANK_FEE_FLOOR_BPS = 20;
/** A posted fee is re-posted when it would move by at least this many bps or this share of itself. */
export const BANK_FEE_MOVE_BPS = 10;
export const BANK_FEE_MOVE_SHARE = 0.1;
/** The schedule and the line are changed (other than shrinking) at most this often (game hours). */
export const BANK_TERMS_GAP_GAME_H = 3;
/** A region is offered for drafts with at least this much spare beyond its floor and loads (pence), and dropped under half of it. */
export const BANK_DRAFT_SURPLUS_PENCE = 2_500_000;
/** The lending line's terms (guide 3.13.8). */
export const BANK_LINE_RATE_SHARE_BPS = 7_000;
export const BANK_LINE_MAX_LTV_BPS = 5_000;
export const BANK_LINE_PER_BORROWER_PENCE = 500_000;
export const BANK_LINE_MIN_PRINCIPAL_PENCE = 50_000;
export const BANK_LINE_MAX_TERM_DAYS = 60;
export const BANK_LINE_MIN_TERM_DAYS = 5;
export const BANK_LINE_NO_DEFAULT_DAYS = 30;
/** A borrower owing more than this on loans now (its own and linked companies') is passed over. */
export const BANK_LINE_MAX_OWED_PENCE = 2_500_000;
/** A line smaller than one borrower's cap isn't worth posting; a region joins it with this much spare (and leaves under half). */
export const BANK_LINE_MIN_PENCE = BANK_LINE_PER_BORROWER_PENCE;
export const BANK_LINE_REGION_SURPLUS_PENCE = 1_000_000;
/** A line's quote stands at most this long (game hours) before the loan starts: its term must end before the endgame after it. */
export const BANK_LINE_QUOTE_GAME_H = 6;
/** A charter or line call with no answer: looked for this long (server ms) before it counts as not made; never sent again meanwhile. */
export const BANK_PENDING_MS = 10 * 60_000;
/** After a refused charter (or one given up), none is tried for this long (real ms); a 403/409 (e.g. a failed bank still owing) longer. */
export const BANK_RETRY_MS = 60 * 60_000;
export const BANK_REFUSED_RETRY_MS = 6 * 3_600_000;
/** Our bank is read this often (real ms), sooner after one of its notices; the Crown's fees at most this often. */
export const BANK_CHECK_MS = 5 * 60_000;
export const BANK_RATES_TTL_MS = 30 * 60_000;
/** Loans our lines made, remembered for the record (ids). */
export const BANK_LINE_LOANS_KEPT = 200;

export type OurBankStatus = "none" | "chartering" | "open" | "winding_down" | "closed" | "failed";

/** Our bank's state from its listing (null: not a bank), a charter call unanswered counting as chartering. */
export function statusOf(b: BankResult | null, pending: boolean): OurBankStatus {
  if (!b) return pending ? "chartering" : "none";
  if (b.failed_at) return "failed";
  if (b.status === "open" || b.status === "winding_down" || b.status === "closed") return b.status;
  return "closed";
}

const crText = (pence: number) => `${Math.round(pence / 100).toLocaleString("en-GB")} Cr`;

/**
 * Why no charter now, or null: the setting, a call unanswered, a refusal lately, the season, a repayment short, net worth (as the debt
 * cap reads it) under `minWorth`, or too little cash beyond the fleet's loads and fences for the fee, the own funds and the buffer.
 */
export function charterBlock(o: {
  on: boolean;
  pending: boolean;
  retryAt: number;
  nowLocal: number;
  seasonNormal: boolean;
  debtShort: boolean;
  worth: number | null;
  minWorth: number;
  loose: number;
  buffer: number;
}): string | null {
  if (!o.on) return "running a bank is off";
  if (o.pending) return "a charter call had no answer: looking for our bank among the banks first";
  if (o.nowLocal < o.retryAt) return `a charter was refused or given up lately: not tried again until ${new Date(o.retryAt).toISOString()}`;
  if (!o.seasonNormal) return "the season is ending: no charter";
  if (o.debtShort) return "a loan repayment is short";
  if (o.worth === null) return "net worth isn't known yet";
  if (o.worth < o.minWorth) return `net worth ${crText(o.worth)} is under the ${crText(o.minWorth)} the charter waits for`;
  const need = BANK_CHARTER_FEE_PENCE + BANK_OWN_FUNDS_PENCE + o.buffer;
  if (o.loose < need) {
    return `${crText(Math.max(0, o.loose))} spare after the fleet's loads and fences; the charter wants ${crText(need)} (the ${crText(BANK_CHARTER_FEE_PENCE)} fee, ${crText(BANK_OWN_FUNDS_PENCE)} of own funds and the buffer)`;
  }
  return null;
}

/** The median Crown fee (bps) into `to` from every other region the rates list; null with none listed. */
export function medianFeeInto(rates: AchRate[], to: BankingRegion): number | null {
  const fees = rates.filter((r) => r.to_region === to && r.from_region !== to && Number.isFinite(r.fee_bps)).map((r) => r.fee_bps).sort((a, b) => a - b);
  if (!fees.length) return null;
  const mid = Math.floor(fees.length / 2);
  return fees.length % 2 ? fees[mid] : (fees[mid - 1] + fees[mid]) / 2;
}

/** Our fee into a region whose median Crown fee is `medianBps`: BANK_FEE_SHARE of it, never under the floor; null when that leaves no margin under it. */
export function draftFee(medianBps: number): number | null {
  const fee = Math.max(BANK_FEE_FLOOR_BPS, Math.floor(medianBps * BANK_FEE_SHARE));
  return fee < medianBps ? Math.min(1_200, fee) : null;
}

/**
 * Regions our vault can pay drafts out of: spare beyond the floor and the loads to be bought there (`surplus`) of at least
 * BANK_DRAFT_SURPLUS_PENCE, or half of it for one already offered (`posted`); never home (the daily bills are paid from it).
 */
export function draftRegions(surplus: Map<BankingRegion, number>, home: BankingRegion | null, posted: ReadonlySet<string>): BankingRegion[] {
  const out: BankingRegion[] = [];
  for (const [r, s] of surplus) {
    if (r === home) continue;
    if (s >= (posted.has(r) ? BANK_DRAFT_SURPLUS_PENCE / 2 : BANK_DRAFT_SURPLUS_PENCE)) out.push(r);
  }
  return out.sort();
}

/** The exchange schedule we'd post now: our fee into each region given, where the Crown's median leaves a margin. */
export function draftSchedule(rates: AchRate[], regions: BankingRegion[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of regions) {
    const median = medianFeeInto(rates, r);
    const fee = median === null ? null : draftFee(median);
    if (fee !== null) out[r] = fee;
  }
  return out;
}

/**
 * How a posted schedule differs from the one we'd post: regions to drop (offered, not wanted: done at once), regions to add, and
 * fees that moved materially (at least BANK_FEE_MOVE_BPS and BANK_FEE_MOVE_SHARE of the posted fee).
 */
export function scheduleDiff(posted: Record<string, number>, want: Record<string, number>): { dropped: string[]; added: string[]; moved: string[] } {
  const dropped = Object.keys(posted).filter((r) => !(r in want));
  const added = Object.keys(want).filter((r) => !(r in posted));
  const moved = Object.keys(want).filter((r) => r in posted && Math.abs(want[r] - posted[r]) >= Math.max(BANK_FEE_MOVE_BPS, posted[r] * BANK_FEE_MOVE_SHARE));
  return { dropped, added, moved };
}

/** The schedule actually posted, as our bank's listing shows it (regions only). */
export function postedSchedule(b: BankResult | null): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [r, f] of Object.entries(b?.exchange_fee_bps ?? {})) if (asRegion(r) && typeof f === "number" && Number.isFinite(f)) out[r] = f;
  return out;
}

/**
 * The line's longest term (game days): its loans (after a quote standing up to BANK_LINE_QUOTE_GAME_H) mature before the season's
 * endgame, at most BANK_LINE_MAX_TERM_DAYS; null under BANK_LINE_MIN_TERM_DAYS (no line then).
 */
export function lineTermDays(seasonLeftMs: number, endgameMs: number, dayMs: number): number | null {
  if (!Number.isFinite(seasonLeftMs)) return BANK_LINE_MAX_TERM_DAYS;
  const days = Math.floor((seasonLeftMs - endgameMs - (BANK_LINE_QUOTE_GAME_H / 24) * dayMs) / dayMs) - 1;
  const term = Math.min(BANK_LINE_MAX_TERM_DAYS, days);
  return term >= BANK_LINE_MIN_TERM_DAYS ? term : null;
}

/**
 * Regions the line lends in: those whose vault has at least BANK_LINE_REGION_SURPLUS_PENCE spare beyond its floor and loads (half of
 * it for one the line already covers), home only on the same terms; sorted.
 */
export function lineRegions(surplus: Map<BankingRegion, number>, current: ReadonlySet<string>): BankingRegion[] {
  const out: BankingRegion[] = [];
  for (const [r, s] of surplus) if (s >= (current.has(r) ? BANK_LINE_REGION_SURPLUS_PENCE / 2 : BANK_LINE_REGION_SURPLUS_PENCE)) out.push(r);
  return out.sort();
}

/**
 * The line's size (`max_line_pence`): what it has out now (loans' principal and open quotes) plus the cash the fleet doesn't need,
 * within the lending budget (less what our other lines' loans still have out); 0 under BANK_LINE_MIN_PENCE, or with less room for a
 * new loan than its smallest principal (no line then: loans already made run on).
 */
export function lineSize(o: { budget: number; free: number; outstanding: number; quoted: number }): number {
  const out = Math.max(0, o.outstanding) + Math.max(0, o.quoted);
  const size = Math.floor(Math.min(o.budget, out + Math.max(0, o.free)));
  return size >= BANK_LINE_MIN_PENCE && size - out >= BANK_LINE_MIN_PRINCIPAL_PENCE ? size : 0;
}

/** Our line's terms (guide 3.13.8) for these regions, this size and longest term (a loan, and a borrower, never above the line itself). */
export function lineTerms(o: { regions: BankingRegion[]; maxLine: number; termDays: number }): LendingLineTerms {
  const each = Math.max(BANK_LINE_MIN_PRINCIPAL_PENCE, Math.min(BANK_LINE_PER_BORROWER_PENCE, Math.floor(o.maxLine)));
  return {
    regions: o.regions,
    collateral_kinds: ["ship_lien"],
    repayments: ["balloon"],
    rate_pct_of_goldsmiths_bps: BANK_LINE_RATE_SHARE_BPS,
    max_ltv_bps: BANK_LINE_MAX_LTV_BPS,
    max_term_game_days: o.termDays,
    min_principal_pence: BANK_LINE_MIN_PRINCIPAL_PENCE,
    max_principal_pence: each,
    allow_non_recourse: false,
    max_per_borrower_pence: each,
    max_line_pence: o.maxLine,
    max_defaults: 0,
    max_walk_aways: 0,
    max_owed_pence: BANK_LINE_MAX_OWED_PENCE,
    min_loans_repaid: 0,
    no_default_within_game_days: BANK_LINE_NO_DEFAULT_DAYS,
  };
}

/** A line's size is cut at once when the cash it may have falls under this share of it, and grown only past this multiple (the cash moves with every load). */
const LINE_SHRINK_AT = 0.8;
const LINE_GROW_AT = 1.25;

/**
 * How a posted line differs from the terms we'd post: "shrink" (a fifth less room or more, fewer regions or a shorter term: replaced
 * at once), "change" (a quarter more room or more, new regions, a longer term by 5 game days or more, or other terms: at most every few
 * game hours), or "none".
 */
export function lineChange(line: LendingLine, want: LendingLineTerms): "none" | "shrink" | "change" {
  const had = new Set<string>(line.regions);
  const wants = new Set<string>(want.regions);
  if ([...had].some((r) => !wants.has(r)) || want.max_line_pence < line.max_line_pence * LINE_SHRINK_AT || want.max_term_game_days < line.max_term_game_days) return "shrink";
  if ([...wants].some((r) => !had.has(r)) || want.max_line_pence >= line.max_line_pence * LINE_GROW_AT || want.max_term_game_days >= line.max_term_game_days + 5) return "change";
  const same =
    line.rate_pct_of_goldsmiths_bps === want.rate_pct_of_goldsmiths_bps &&
    line.max_ltv_bps === want.max_ltv_bps &&
    line.max_per_borrower_pence === want.max_per_borrower_pence &&
    line.max_principal_pence === want.max_principal_pence &&
    line.min_principal_pence === want.min_principal_pence &&
    line.allow_non_recourse === !!want.allow_non_recourse &&
    (line.max_defaults ?? null) === (want.max_defaults ?? null) &&
    line.max_walk_aways === (want.max_walk_aways ?? 0) &&
    (line.no_default_within_game_days ?? null) === (want.no_default_within_game_days ?? null) &&
    (line.max_owed_pence ?? null) === (want.max_owed_pence ?? null) &&
    line.collateral_kinds.length === want.collateral_kinds.length &&
    line.collateral_kinds.every((k) => want.collateral_kinds.includes(k)) &&
    line.repayments.length === want.repayments.length &&
    line.repayments.every((k) => want.repayments.includes(k));
  return same ? "none" : "change";
}

/** What the manager keeps about our bank (saved; server ms unless marked local). */
export interface BankMemory {
  /** A charter call with no answer (server ms): looked for among the banks, never sent again; given up after BANK_PENDING_MS. */
  pendingCharter: number | null;
  /** When our bank was chartered (server ms), as we chartered it or found it. */
  charteredAt: number | null;
  /** No charter tried before then (local ms): one refused, or one given up. */
  retryAt: number;
  /** Lending lines the autopilot posted (ids; a line posted by hand is never touched), and a post with no answer. */
  lineIds: string[];
  pendingLine: { at: number; maxLine: number } | null;
  /** Loans our bank's lines made (ids, newest last), for their count, defaults and interest. */
  lineLoans: string[];
  /** When the autopilot last changed the exchange schedule and the line (server ms; null: never). */
  feesAt: number | null;
  lineAt: number | null;
  /** Drafts our bank carried and the fees it kept, as the `bank_draft` notices told (the bank's own figures are shown when read). */
  drafts: number;
  draftFees: number;
  /** The warning that the bank stays chartered with runBank off has been given (wind-down is the owner's, by hand). */
  offWarned: boolean;
}

export function emptyBank(): BankMemory {
  return { pendingCharter: null, charteredAt: null, retryAt: 0, lineIds: [], pendingLine: null, lineLoans: [], feesAt: null, lineAt: null, drafts: 0, draftFees: 0, offWarned: false };
}

/** A saved memory (older saves have none): only well-formed fields come back. */
export function restoreBank(s: Partial<BankMemory> | undefined): BankMemory {
  const b = emptyBank();
  if (!s) return b;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  b.pendingCharter = num(s.pendingCharter);
  b.charteredAt = num(s.charteredAt);
  b.retryAt = num(s.retryAt) ?? 0;
  b.lineIds = Array.isArray(s.lineIds) ? s.lineIds.filter((x): x is string => typeof x === "string").slice(-10) : [];
  const pl = s.pendingLine;
  b.pendingLine = pl && num(pl.at) !== null && num(pl.maxLine) !== null ? { at: pl.at, maxLine: pl.maxLine } : null;
  b.lineLoans = Array.isArray(s.lineLoans) ? s.lineLoans.filter((x): x is string => typeof x === "string").slice(-BANK_LINE_LOANS_KEPT) : [];
  b.feesAt = num(s.feesAt);
  b.lineAt = num(s.lineAt);
  b.drafts = num(s.drafts) ?? 0;
  b.draftFees = num(s.draftFees) ?? 0;
  b.offWarned = s.offWarned === true;
  return b;
}

/** Our bank for the panel and the digest (pence; rates bps; times ISO). */
export interface BankReport {
  /** The setting in force (the user's, or the AI's within it). */
  enabled: boolean;
  status: OurBankStatus;
  /** The charter case while there is no bank (why not, or "ready"); else how the bank stands. */
  verdict: string;
  /** What the last pass did or would do. */
  action: string;
  checkedAt: string | null;
  charteredAt: string | null;
  minNetWorthPence: number;
  lendingBudgetPence: number;
  netWorthPence: number | null;
  /** Its deposit terms as listed (v1 posts 0 / 0, uninsured; the owner may change them by hand). */
  terms: { demandRateBps: number; noticeRateBps: number; noticeGameHours: number; insured: boolean } | null;
  /** What it owes depositors, by region where known (kept out of spending in that region's floor), its reserves and overdue withdrawals. */
  depositsOwedPence: number;
  owedByRegion: Array<{ region: BankingRegion; pence: number }>;
  reservesPence: number;
  requiredReservePence: number;
  overdueWithdrawalsPence: number;
  /** The exchange fees posted (drafts), with the median Crown fee into each region when last read. */
  fees: Array<{ region: BankingRegion; feeBps: number; crownMedianBps: number | null }>;
  feesChangedAt: string | null;
  /** Drafts carried and fees kept: the bank's own figures when read, else what the notices told. */
  drafts: number;
  draftFeesPence: number;
  /** Our bank's open lending lines (`ours`: posted by the autopilot; others by hand, never touched). */
  lines: Array<{
    id: string;
    ours: boolean;
    regions: BankingRegion[];
    ratePctBps: number;
    maxLtvBps: number;
    maxTermDays: number;
    maxPerBorrowerPence: number;
    maxLinePence: number;
    outstandingPence: number;
    quotedPence: number;
    remainingPence: number;
  }>;
  /** Loans our lines made: how many, still running, principal and interest owed us, defaults, interest received. */
  loans: { made: number; active: number; outstandingPence: number; defaults: number; interestPence: number };
  /** Things the owner should look at (the bank is never wound down by the autopilot). */
  warnings: string[];
}
