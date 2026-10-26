/**
 * Credit for the autopilot (guide 3.13: loans by quote), pure: no I/O. The manager reads the loans, quotes and requests
 * and makes every call; this says on what terms.
 *
 * Rates are annual (bps per 360 game days, fixed at approval) on simple interest for the game time elapsed; terms run
 * 1-360 game days. Loans made before loans by quote (`rate_basis: "daily"`) run to maturity on their per-day rate.
 *
 * Borrowing (leverage, conservative): only for a hull or a load that cash can't fund, when what the money is expected to
 * earn over the loan's term is at least `minLoanReturnX` times its interest and it pays back within half the term. The
 * term leaves 2 game days before maturity on top (when it is always repaid in full). Lender: the Goldsmiths' instant
 * quote against a lien on one of our ships (at most 40% of its rebuild value and 7,500 Cr a loan, with recourse; 45% a
 * year up to 30 game days, sliding to 30% at 360), balloon repayment; a request posted alongside lets a player lender
 * refinance it for less.
 *
 * Lending (idle cash): spare cash beyond what the fleet needs, less a buffer, quoted on players' secured requests (ship
 * liens or warehouse goods, with recourse) from borrowers with a clean credit record, at 0.9x the Goldsmiths' rate for
 * the term (never under 15% a year, always within the request's bounds).
 */

import type { CreditReport, Loan } from "../schema";

/** A loan year: annual rates are per this many game days. */
export const YEAR_DAYS = 360;
/** The Goldsmiths' Company (guide 3.13.1): the most it lends a loan, its loan-to-value cap, and its annual rate (bps) by term. */
export const GOLDSMITHS_MAX_PRINCIPAL_PENCE = 750_000;
export const GOLDSMITHS_LTV_BPS = 4_000;
export const GOLDSMITHS_SHORT_BPS = 4_500;
export const GOLDSMITHS_LONG_BPS = 3_000;
export const GOLDSMITHS_SHORT_DAYS = 30;
/** Longest term any loan may run (game days). */
export const LOAN_MAX_TERM_DAYS = 360;
/** The least a loan may be (guide: 100 Cr). */
export const LOAN_MIN_PRINCIPAL_PENCE = 10_000;
/** Every loan is repaid in full this many game days before it matures. */
export const REPAY_LEAD_DAYS = 2;
/** At most this many loans owed at once, and a load's loan at most this much (one Goldsmiths' loan). */
export const MAX_ACTIVE_LOANS = 2;
export const LOAN_MAX_LOAD_PENCE = GOLDSMITHS_MAX_PRINCIPAL_PENCE;
/** A loan bridges at most this share of a hull's cost: the rest is our own cash. */
export const LOAN_MAX_HULL_SHARE = 0.5;
/**
 * Room under the debt cap kept for interest before the term is known: principal × (1 + this), the Goldsmiths' 30-day
 * interest. borrow() checks the quote's own total against the cap.
 */
export const LOAN_INTEREST_HEADROOM = (GOLDSMITHS_SHORT_BPS * GOLDSMITHS_SHORT_DAYS) / (10_000 * YEAR_DAYS);
/** A request posted alongside a Goldsmiths' loan (for a player lender to refinance it): the least worth asking, and how long it stays open (game hours). */
export const REQUEST_MIN_PENCE = 100_000;
export const REQUEST_OPEN_GAME_H = 12;
/** A refinancing quote is approved only when it saves at least this much interest over what is left of the old loan. */
export const REFI_MIN_SAVING_PENCE = 5_000;

/** Idle cash: the buffer left idle, the least loan worth quoting, the longest term, the rate as a share of the Goldsmiths' and its floor (annual bps). */
export const IDLE_BUFFER_PENCE = 2_500_000;
export const IDLE_MIN_LOAN_PENCE = 50_000;
export const IDLE_MAX_TERM_DAYS = 60;
export const IDLE_RATE_SHARE = 0.9;
export const IDLE_RATE_FLOOR_BPS = 1_500;
/** Spare cash must have had nothing to fund for this many game hours before it is quoted. */
export const IDLE_SETTLE_GAME_H = 20;
/** At most this many quotes out at once, and one at most this share of what may be lent. */
export const IDLE_MAX_QUOTES = 4;
export const IDLE_MAX_LOAN_SHARE = 0.5;

/** The Goldsmiths' annual rate (bps) for a term: 45% up to 30 game days, sliding linearly to 30% at 360 (the estimate before a quote). */
export function goldsmithsAnnualBps(termDays: number): number {
  const t = Math.min(LOAN_MAX_TERM_DAYS, Math.max(1, termDays));
  if (t <= GOLDSMITHS_SHORT_DAYS) return GOLDSMITHS_SHORT_BPS;
  return Math.round(GOLDSMITHS_SHORT_BPS - ((GOLDSMITHS_SHORT_BPS - GOLDSMITHS_LONG_BPS) * (t - GOLDSMITHS_SHORT_DAYS)) / (LOAN_MAX_TERM_DAYS - GOLDSMITHS_SHORT_DAYS));
}

/**
 * The term (game days) a loan paying back in `paybackDays` needs: twice the payback (it must fall within half the term)
 * and the 2 days it is repaid before maturity, at least 1. Null when that is longer than `maxTerm` (at most 360).
 */
export function loanTerm(paybackDays: number, maxTerm = LOAN_MAX_TERM_DAYS): number | null {
  if (!Number.isFinite(paybackDays) || paybackDays < 0) return null;
  const term = Math.max(1, Math.ceil(2 * paybackDays) + REPAY_LEAD_DAYS);
  return term <= Math.min(maxTerm, LOAN_MAX_TERM_DAYS) ? term : null;
}

/** Simple interest on the whole principal at `annualBps` over `days` (the worst case: repaying early pays only interest to date). */
export function interestFor(principal: number, annualBps: number, days: number): number {
  return Math.ceil((principal * annualBps * days) / (10_000 * YEAR_DAYS));
}

export type LoanCase = { ok: true; termDays: number; interest: number; ret: number } | { ok: false; why: string };

/**
 * Whether a loan is worth taking: the term its payback needs (loanTerm), and what the money earns over that term
 * (`returnOver`) at least `minReturnX` times the interest: a quote's own (`quotedInterest`: its total repayable less the
 * principal, for that term), else at `annualBps`.
 */
export function loanCase(o: {
  principal: number;
  annualBps: number;
  paybackDays: number;
  returnOver: (termDays: number) => number;
  minReturnX: number;
  maxTermDays?: number;
  quotedInterest?: number;
}): LoanCase {
  const max = Math.min(o.maxTermDays ?? LOAN_MAX_TERM_DAYS, LOAN_MAX_TERM_DAYS);
  const termDays = loanTerm(o.paybackDays, max);
  if (termDays === null) {
    return { ok: false, why: `it pays back in ~${o.paybackDays.toFixed(1)} game days: a loan of at most ${max} can't leave half its term and 2 days to spare` };
  }
  const interest = o.quotedInterest !== undefined && Number.isFinite(o.quotedInterest) ? Math.max(0, Math.ceil(o.quotedInterest)) : interestFor(o.principal, o.annualBps, termDays);
  const ret = Math.round(o.returnOver(termDays));
  if (!(ret >= o.minReturnX * interest)) {
    return { ok: false, why: `it earns ~${Math.round(ret / 100)} Cr over ${termDays} game days, under ${o.minReturnX}x the ~${Math.round(interest / 100)} Cr interest` };
  }
  return { ok: true, termDays, interest, ret };
}

/** A loan's rate as a % a year ("45%", "4.5%"). */
export function pctYear(annualBps: number): string {
  const pct = annualBps / 100;
  return `${pct.toLocaleString("en-GB", { maximumFractionDigits: pct < 10 ? 1 : 0 })}% a year`;
}

/** A loan made before loans by quote, on a rate per game day (its `rate_basis`; or, with none given, a daily rate and no annual one). */
export function dailyBasis(l: Pick<Loan, "rate_basis" | "daily_rate_bps" | "annual_rate_bps">): boolean {
  return l.rate_basis === "daily" || (l.rate_basis !== "annual" && !l.annual_rate_bps && l.daily_rate_bps > 0);
}

/** A loan's rate in bps a game day (fractional for an annual one): what interest it accrues per game day per 10,000 of principal. */
export function perDayBps(l: Pick<Loan, "rate_basis" | "daily_rate_bps" | "annual_rate_bps">): number {
  return dailyBasis(l) ? l.daily_rate_bps : (l.annual_rate_bps ?? 0) / YEAR_DAYS;
}

/** A loan's rate as annual bps (a daily one × 360), for comparing and sorting. */
export function annualBpsOf(l: Pick<Loan, "rate_basis" | "daily_rate_bps" | "annual_rate_bps">): number {
  return dailyBasis(l) ? l.daily_rate_bps * YEAR_DAYS : (l.annual_rate_bps ?? 0);
}

/** When a loan must be repaid in full by (server ms): `leadDays` (REPAY_LEAD_DAYS) before it matures; null with no maturity. */
export function repayBy(l: Pick<Loan, "matures_at">, dayMs: number, leadDays = REPAY_LEAD_DAYS): number | null {
  const m = Date.parse(l.matures_at ?? "");
  return Number.isFinite(m) ? m - leadDays * dayMs : null;
}

/**
 * What a loan we owe will take to clear at server time `at`: owed now, plus interest on its outstanding principal until
 * then at its own basis (an amortised loan's principal falls as installments are paid: this is the most it can be).
 */
export function owedAt(
  l: Pick<Loan, "owed_pence" | "outstanding_principal_pence" | "rate_basis" | "daily_rate_bps" | "annual_rate_bps">,
  now: number,
  at: number,
  dayMs: number,
): number {
  const days = Math.max(0, (at - now) / dayMs);
  return Math.max(0, l.owed_pence) + Math.ceil((Math.max(0, l.outstanding_principal_pence) * perDayBps(l) * days) / 10_000);
}

/**
 * The installments an amortised loan we owe will take before server time `until` (guide 3.13.1: every 10 game days, the
 * loan's region first; one missed is in arrears for a game day, then the whole loan defaults): arrears now, then each
 * installment from the next due date. Empty for a balloon loan.
 */
export function installmentsBefore(
  l: Pick<Loan, "repayment" | "installment_pence" | "next_payment_due_at" | "next_payment_pence" | "arrears_pence" | "arrears_due_by" | "matures_at">,
  now: number,
  until: number,
  dayMs: number,
): Array<{ at: number; pence: number }> {
  if (l.repayment !== "amortised") return [];
  const out: Array<{ at: number; pence: number }> = [];
  const each = Math.max(0, l.installment_pence ?? 0);
  const maturity = Date.parse(l.matures_at ?? "");
  const last = Number.isFinite(maturity) ? Math.min(until, maturity) : until;
  const arrears = Math.max(0, l.arrears_pence ?? 0);
  // In arrears, the next payment shown is the arrears (due by the end of its day of grace): the next installment falls 10
  // game days after the one missed (a day before that grace ends).
  let next = Date.parse(l.next_payment_due_at ?? "");
  if (arrears > 0) {
    out.push({ at: now, pence: arrears });
    const by = Date.parse(l.arrears_due_by ?? "");
    next = Number.isFinite(by) ? by - dayMs + 10 * dayMs : NaN;
  } else if (Number.isFinite(next) && next < last) {
    out.push({ at: Math.max(now, next), pence: Math.max(0, l.next_payment_pence ?? each) });
    next += 10 * dayMs;
  }
  if (!(each > 0) || !Number.isFinite(next)) return out;
  for (let i = 0; i < 40 && next < last; i++, next += 10 * dayMs) out.push({ at: Math.max(now, next), pence: each });
  return out;
}

/**
 * Why a borrower's public credit record (guide 3.13.7) isn't clean enough to lend to, strictly: any default ever, a loan
 * walked away from or written off, an open futures claim, a bankruptcy, or a smuggling conviction. Empty: clean.
 */
export function creditBlemishes(r: CreditReport): string[] {
  const out: string[] = [];
  if (r.defaulted_open_loans > 0) out.push(`${r.defaulted_open_loans} defaulted loan${r.defaulted_open_loans === 1 ? "" : "s"} still owed`);
  else if (r.loans_defaulted > 0) out.push(`${r.loans_defaulted} past default${r.loans_defaulted === 1 ? "" : "s"}`);
  if ((r.loans_walked_away ?? 0) > 0) out.push(`walked away from ${r.loans_walked_away} loan${r.loans_walked_away === 1 ? "" : "s"}`);
  if (r.loans_written_off > 0) out.push(`${r.loans_written_off} written off`);
  if (r.futures_claims_open_pence > 0) out.push("open futures claims");
  if (r.bankrupt_at) out.push("bankrupt");
  if ((r.smuggling_convictions ?? 0) > 0) out.push(`${r.smuggling_convictions} smuggling conviction${r.smuggling_convictions === 1 ? "" : "s"}`);
  return out;
}

/**
 * The rate an idle-cash quote on a request is made at (annual bps): IDLE_RATE_SHARE of the Goldsmiths' rate for its
 * term, never under IDLE_RATE_FLOOR_BPS, within the request's bounds. Null when the floor is above its ceiling.
 */
export function idleQuoteBps(req: { goldsmiths_rate_bps: number; rate_floor_bps: number; rate_ceiling_bps: number }): number | null {
  const want = Math.round(req.goldsmiths_rate_bps * IDLE_RATE_SHARE);
  const rate = Math.max(want, IDLE_RATE_FLOOR_BPS, req.rate_floor_bps);
  return rate <= req.rate_ceiling_bps ? rate : null;
}
