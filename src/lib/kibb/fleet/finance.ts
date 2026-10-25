/**
 * Credit for the autopilot (guide 3.12-3.14), pure: no I/O. The manager reads the loans and the board and makes
 * every call; this says on what terms.
 *
 * Borrowing (leverage, conservative): only for a hull or a load that cash can't fund, when what the money is
 * expected to earn over the loan's term is at least `minLoanReturnX` times its interest and it pays back within
 * half the term. The term leaves 2 game days before maturity on top (when it is always repaid in full), within
 * 1-30 game days. Lenders: the cheapest standing credit-board offer that fits (never one of ours, never dearer than
 * the Goldsmiths' 50 bps a game day), else the Goldsmiths' backstop against a lien on one of our ships (at most 40%
 * of its rebuild value and 7,500 Cr a loan, with recourse).
 *
 * Lending (idle cash): vault cash above the wealth levy's threshold, less a buffer, posted as one secured board
 * offer (ship liens, at most half the pledge's appraisal, with recourse) at or just under the best rival offer of
 * that kind, never below the levy's own rate (10 bps a game day: cash lent out isn't levied).
 */

import type { BoardOffer, CollateralKind, Loan } from "../schema";

/** The Goldsmiths' Company (guide 3.13.1): its rate (bps a game day), the most it lends a loan, its loan-to-value cap and longest term. */
export const GOLDSMITHS_RATE_BPS = 50;
export const GOLDSMITHS_MAX_PRINCIPAL_PENCE = 750_000;
export const GOLDSMITHS_LTV_BPS = 4_000;
export const LOAN_MAX_TERM_DAYS = 30;
/** The least a loan may be (guide: 100 Cr), and the Crown's lowest rate (a tenth of the Goldsmiths'). */
export const LOAN_MIN_PRINCIPAL_PENCE = 10_000;
export const RATE_FLOOR_BPS = 5;
/** Every loan is repaid in full this many game days before it matures. */
export const REPAY_LEAD_DAYS = 2;
/** At most this many loans owed at once, and a load's loan at most this much (one Goldsmiths' loan). */
export const MAX_ACTIVE_LOANS = 2;
export const LOAN_MAX_LOAD_PENCE = GOLDSMITHS_MAX_PRINCIPAL_PENCE;
/** A loan bridges at most this share of a hull's cost: the rest is our own cash. */
export const LOAN_MAX_HULL_SHARE = 0.5;
/** Room under the debt cap is kept for the worst-case interest: principal × (1 + this). */
export const LOAN_INTEREST_HEADROOM = (GOLDSMITHS_RATE_BPS * LOAN_MAX_TERM_DAYS) / 10_000;
/** Our estimate of a ship's rebuild value counts at this share against a board offer's loan-to-value cap (its appraisal may be lower). */
export const PLEDGE_VALUE_MARGIN = 0.9;

/** Idle cash: the least rate (the levy's 0.1% a game day), the buffer left idle, the loan-to-value cap, the least post and loan, term and expiry. */
export const IDLE_RATE_FLOOR_BPS = 10;
export const IDLE_BUFFER_PENCE = 2_500_000;
export const IDLE_MAX_LTV_BPS = 5_000;
export const IDLE_MIN_POST_PENCE = 1_000_000;
export const IDLE_MIN_LOAN_PENCE = 50_000;
export const IDLE_TERM_DAYS = 10;
export const IDLE_EXPIRY_GAME_H = 48;

/**
 * The term (game days) a loan paying back in `paybackDays` needs: twice the payback (it must fall within half the term)
 * and the 2 days it is repaid before maturity, at least 1. Null when that is longer than `maxTerm`.
 */
export function loanTerm(paybackDays: number, maxTerm = LOAN_MAX_TERM_DAYS): number | null {
  if (!Number.isFinite(paybackDays) || paybackDays < 0) return null;
  const term = Math.max(1, Math.ceil(2 * paybackDays) + REPAY_LEAD_DAYS);
  return term <= Math.min(maxTerm, LOAN_MAX_TERM_DAYS) ? term : null;
}

/** Interest on the whole principal over the whole term (the worst case: repaying early pays only interest to date). */
export function interestFor(principal: number, rateBps: number, days: number): number {
  return Math.ceil((principal * rateBps * days) / 10_000);
}

export type LoanCase = { ok: true; termDays: number; interest: number; ret: number } | { ok: false; why: string };

/**
 * Whether a loan is worth taking: the term its payback needs (loanTerm), and what the money earns over that term
 * (`returnOver`) at least `minReturnX` times the interest at `rateBps`.
 */
export function loanCase(o: {
  principal: number;
  rateBps: number;
  paybackDays: number;
  returnOver: (termDays: number) => number;
  minReturnX: number;
  maxTermDays?: number;
}): LoanCase {
  const max = Math.min(o.maxTermDays ?? LOAN_MAX_TERM_DAYS, LOAN_MAX_TERM_DAYS);
  const termDays = loanTerm(o.paybackDays, max);
  if (termDays === null) {
    return { ok: false, why: `it pays back in ~${o.paybackDays.toFixed(1)} game days: a loan of at most ${max} can't leave half its term and 2 days to spare` };
  }
  const interest = interestFor(o.principal, o.rateBps, termDays);
  const ret = Math.round(o.returnOver(termDays));
  if (!(ret >= o.minReturnX * interest)) {
    return { ok: false, why: `it earns ~${Math.round(ret / 100)} Cr over ${termDays} game days, under ${o.minReturnX}x the ~${Math.round(interest / 100)} Cr interest` };
  }
  return { ok: true, termDays, interest, ret };
}

/**
 * Standing board offers a borrower may take for `principal` over `termDays`, cheapest first (unsecured before a lien
 * at the same rate): open, not ours, never dearer than the Goldsmiths, enough left, a minimum we meet, a long enough
 * term and, for a ship lien, a pledge worth enough at its loan-to-value cap (`pledgeValue`: our best ship's rebuild
 * value; null: none to pledge). Goods are never pledged.
 */
export function fittingOffers(
  offers: BoardOffer[],
  o: { principal: number; termDays: number; now: number; ours: (companyId: string) => boolean; pledgeValue: number | null },
): BoardOffer[] {
  return offers
    .filter(
      (x) =>
        x.status === "open" &&
        !o.ours(x.lender_company_id) &&
        x.daily_rate_bps <= GOLDSMITHS_RATE_BPS &&
        x.available_pence >= o.principal &&
        x.min_principal_pence <= o.principal &&
        x.max_term_game_days >= o.termDays &&
        !(Date.parse(x.expires_at) <= o.now) &&
        (x.collateral_kind === "unsecured" ||
          (x.collateral_kind === "ship_lien" && o.pledgeValue !== null && o.principal <= ((x.max_ltv_bps ?? 0) * o.pledgeValue * PLEDGE_VALUE_MARGIN) / 10_000)),
    )
    .sort((a, b) => a.daily_rate_bps - b.daily_rate_bps || Number(b.collateral_kind === "unsecured") - Number(a.collateral_kind === "unsecured"));
}

/**
 * The rate an idle-cash offer of `kind` is posted at: just under the best rival offer of that kind (with none, just
 * under the Goldsmiths' rate), never below the floor (the levy's rate) nor the Crown's minimum.
 */
export function idleRate(offers: BoardOffer[], kind: CollateralKind, ours: (companyId: string) => boolean): number {
  const rivals = offers.filter((x) => x.status === "open" && x.collateral_kind === kind && !ours(x.lender_company_id)).map((x) => x.daily_rate_bps);
  const best = rivals.length ? Math.min(...rivals) : GOLDSMITHS_RATE_BPS;
  return Math.max(IDLE_RATE_FLOOR_BPS, RATE_FLOOR_BPS, Math.min(best - 1, GOLDSMITHS_RATE_BPS - 1));
}

/** When a loan must be repaid in full by (server ms): `leadDays` (REPAY_LEAD_DAYS) before it matures; null with no maturity. */
export function repayBy(l: Pick<Loan, "matures_at">, dayMs: number, leadDays = REPAY_LEAD_DAYS): number | null {
  const m = Date.parse(l.matures_at ?? "");
  return Number.isFinite(m) ? m - leadDays * dayMs : null;
}

/** What a loan we owe will take to clear at server time `at`: owed now, plus interest on its principal until then. */
export function owedAt(l: Pick<Loan, "owed_pence" | "outstanding_principal_pence" | "daily_rate_bps">, now: number, at: number, dayMs: number): number {
  const days = Math.max(0, (at - now) / dayMs);
  return Math.max(0, l.owed_pence) + Math.ceil((Math.max(0, l.outstanding_principal_pence) * l.daily_rate_bps * days) / 10_000);
}
