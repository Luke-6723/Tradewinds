/**
 * Demand deposits for idle cash (guide 3.13.4 banks, 3.12 money, 3.17 net worth), pure: no I/O. The manager reads the banks and
 * our deposits, makes every call (runDeposits; ensureCash pulling a deposit back before it remits) and keeps the records; this
 * says which banks may hold our money, how much, and what comes back first.
 *
 * - **Banks:** `GET /v1/bank/list` shows each bank's demand rate, insurance, deposits, reserves against the Crown's 20%
 *   `required_reserve_pence`, and `overdue_withdrawals_pence`. A bank takes a deposit of ours only when it is open (not winding down,
 *   not failed), pays every withdrawal on time (nothing overdue: a bank that leaves one unpaid for a game day fails), keeps its
 *   reserves at or above the Crown's 20%, pays something on demand (and no more than the 25 bps a game day the Crown flags as
 *   mispriced: a bank paying that much is a red flag, not a bargain), and is none of our own companies. Insured banks first.
 * - **How much:** only cash the fleet doesn't need: spare above every region's floor, after the loads the fleet is bound to buy, what our
 *   loans and commissions keep back (the debt fence, our bank's lending lines' room too), a liquid buffer (25,000 Cr, or two game days
 *   of the daily bills if more) and, while the buyer may build, the price of the cheapest hull it has been quoted (with a quarter more
 *   for her first cargo): a hull is the better use of cash. Within `depositBudgetPence` in all; per bank at most the 2,500 Cr the Crown
 *   insures per player (on deposits 14+ game days old) unless the bank is insured with reserves at least twice the Crown's 20%, and
 *   never more than a tenth of that bank's deposits plus reserves (our money is never a large part of any one bank).
 * - **Deposit:** on demand only (`notice: false`: a notice deposit could not be had back when the fleet needs it), in the region where
 *   the cash already lies (no remittance), one a pass, once spare cash has had nothing to fund for DEPOSIT_SETTLE_GAME_H.
 * - **Withdraw:** a region short of cash takes ours there back first (free), or from another region with `to_region` when the bank's
 *   exchange fee less our client discount (both read again just before) is strictly under the Crown's known fee for that route, or
 *   else into its own region for the Crown's remittance to carry on; before anything is borrowed. A demand withdrawal is paid at once
 *   only as far as the bank's cash reaches: the rest is owed later and never counted as cash. A bank in trouble (overdue withdrawals,
 *   reserves under the Crown's 20%) has ours withdrawn at once. One not open (winding down, failed, gone from the list) pays nothing on
 *   demand (`409`): ours there is frozen, owed later (paid pro rata as its loans come in), asked for again only when its status changes
 *   or every DEPOSIT_FROZEN_RETRY_MS.
 * - **Accounting:** deposits count in net worth (the leaderboard counts them, guide 3.17). Ours at a healthy open bank count as cash
 *   the fleet may spend (they come back on demand, before anything is borrowed): parked idle cash never holds the fleet back.
 */

import type { BankingRegion, BankResult, DepositResult } from "../schema";
import { IDLE_BUFFER_PENCE, YEAR_DAYS } from "./finance";
import { asRegion } from "./housekeeping";

/** What may sit on deposit in all by default (pence: 25,000 Cr). */
export const DEPOSIT_DEFAULT_BUDGET_PENCE = 2_500_000;
/** The Crown's deposit insurance per player at a failed insured bank (guide 3.13.4: 2,500 Cr, on deposits 14+ game days old). */
export const DEPOSIT_INSURED_CAP_PENCE = 250_000;
export const DEPOSIT_INSURED_AGE_GAME_DAYS = 14;
/** Beyond the insured cap only at an insured bank whose reserves are at least this many times the Crown's required 20%. */
export const DEPOSIT_STRONG_RESERVE_X = 2;
/** Never more of ours at one bank than this share of its deposits plus reserves. */
export const DEPOSIT_BANK_SHARE = 0.1;
/** The Crown flags a deposit rate above this (bps a game day) as mispriced (guide 3.13.4): such a bank gets none of ours. */
export const DEPOSIT_MAX_RATE_BPS = 25;
/** The least worth depositing (the game's own floor is 10 Cr), and the least worth pulling back on its own. */
export const DEPOSIT_MIN_PENCE = 50_000;
export const DEPOSIT_MIN_PULL_PENCE = 1_000;
/** A deposit left with less than this after a pull is pulled whole (no dust left at a bank). */
export const DEPOSIT_DUST_PENCE = 50_000;
/** Deposits beyond the target are pulled back only past this much (the target moves with every load bought). */
export const DEPOSIT_HYSTERESIS_PENCE = 500_000;
/** Spare cash must have had nothing to fund for this many game hours before it is deposited. */
export const DEPOSIT_SETTLE_GAME_H = 6;
/** The liquid buffer: the idle-cash buffer, or this many game days of the daily bills if more. */
export const DEPOSIT_BUFFER_BILL_DAYS = 2;
/** While the buyer may build: the cheapest hull quoted, with this much more for her first cargo, stays out of deposits. */
export const DEPOSIT_BUYER_HEADROOM = 1.25;
/** A deposit call with no answer: looked for among our deposits this long (server ms), never sent again meanwhile. */
export const DEPOSIT_PENDING_MS = 10 * 60_000;
/** A withdrawal with no answer: that deposit is left alone until our deposits are read again, at least this long (real ms). */
export const DEPOSIT_HOLD_MS = 2 * 60_000;
/** A deposit at a bank that is not open (bankFrozen): asked for again only when the bank's status changes, or after this long (real ms). */
export const DEPOSIT_FROZEN_RETRY_MS = 3 * 3_600_000;
/** Pulls kept for the panel, closed deposits' records kept (local ms). */
export const DEPOSIT_PULLS_KEPT = 30;
export const DEPOSIT_REC_KEEP_MS = 7 * 24 * 3_600_000;

/** One deposit the autopilot made, as last read (`at` server ms opened; `seen` local ms): the only deposits it ever touches. */
export interface DepositRec {
  bank: string;
  bankName: string;
  region: BankingRegion;
  deposited: number;
  balance: number;
  /** Asked for back and not yet paid: owed later, never counted as cash. */
  pending: number;
  /** Locked by a loan it secures (the autopilot pledges none). */
  pledged: number;
  /** What it earns now (`effective_rate_bps`, bps a game day). */
  rateBps: number;
  interest: number;
  /** The bank's discount off its exchange fee for us (its client terms). */
  discountBps: number;
  writtenOff: number;
  status: string;
  at: number;
  seen: number;
}

/** A deposit call with no answer (server ms): looked for among our deposits, never sent again; given up after DEPOSIT_PENDING_MS. */
export interface PendingDeposit {
  bank: string;
  bankName: string;
  region: BankingRegion;
  amount: number;
  at: number;
}

/**
 * A withdrawal of ours (server ms): the deposit, into which region (`to`: another region by the bank's exchange; null: its own),
 * what was asked, what came at once (null: not known), what the bank still owes, the exchange fee, and why.
 */
export interface DepositPull {
  at: number;
  id: string;
  bank: string;
  region: BankingRegion;
  to: BankingRegion | null;
  amount: number;
  paid: number | null;
  owed: number;
  fee: number;
  why: string;
}

/** What deposits did since the records began (pence). */
export interface DepositStats {
  deposited: number;
  deposits: number;
  pulled: number;
  pulls: number;
}

/** What a deposit may still be withdrawn of: its balance less what is already asked for and any loan's lock. */
export function freeBalance(d: { balance: number; pending: number; pledged: number }): number {
  return Math.max(0, Math.floor(d.balance - Math.max(0, d.pending) - Math.max(0, d.pledged)));
}

/** A deposit as `GET /v1/bank/deposits` gives it, as our record (`prev`: as last seen, for what the list leaves out). */
export function depositRec(d: DepositResult, nowLocal: number, prev?: DepositRec): DepositRec {
  const region = asRegion(d.banking_region) ?? prev?.region ?? d.banking_region;
  return {
    bank: d.bank_company_id,
    bankName: d.bank_name || prev?.bankName || d.bank_company_id.slice(0, 8),
    region,
    deposited: d.deposited_pence,
    balance: Math.max(0, d.balance_pence),
    pending: Math.max(0, d.pending_withdrawal_pence ?? 0),
    pledged: Math.max(0, d.pledged_pence ?? 0),
    rateBps: Number.isFinite(d.effective_rate_bps) ? d.effective_rate_bps : d.daily_rate_bps,
    interest: Math.max(0, d.interest_credited_pence ?? 0),
    discountBps: Math.max(0, d.exchange_discount_bps ?? 0),
    writtenOff: Math.max(0, d.written_off_pence ?? 0),
    status: d.status,
    at: Date.parse(d.created_at) || prev?.at || 0,
    seen: nowLocal,
  };
}

/** Whether a deposit is still open (closed ones only keep their interest for the record). */
export function isOpen(r: { status: string }): boolean {
  return r.status === "open";
}

/**
 * Why a bank pays nothing on demand (guide 3.13.4: a failed or winding-down bank pays its depositors pro rata as its loans come in, and
 * refuses a withdrawal meanwhile), or null: listed, open, never failed. Ours there is frozen: owed later, never counted as cash.
 */
export function bankFrozen(b: BankResult | undefined): string | null {
  if (!b) return "it is no longer listed (closed or failed)";
  if (b.failed_at) return "it failed";
  if (b.status !== "open") return b.status === "winding_down" ? "it is winding down" : `it is ${b.status.replace(/_/g, " ")}`;
  return null;
}

/** What tells one frozen state of a bank from the next (a withdrawal of ours there is asked for again when it changes). */
export function frozenKey(b: BankResult | undefined): string {
  return b ? `${b.status}|${b.failed_at ?? ""}` : "unlisted";
}

/**
 * Why a bank is no place for our money any more (ours there is withdrawn at once, or frozen when it isn't open: bankFrozen), or null:
 * listed, open, never failed, every withdrawal paid on time, reserves at or above the Crown's 20% of its deposits.
 */
export function bankTrouble(b: BankResult | undefined): string | null {
  const frozen = bankFrozen(b);
  if (frozen || !b) return frozen;
  if (b.overdue_withdrawals_pence > 0) return `it has ${Math.round(b.overdue_withdrawals_pence / 100).toLocaleString("en-GB")} Cr of withdrawals overdue`;
  if (b.reserves_pence < b.required_reserve_pence) return "its reserves are under the Crown's 20% of its deposits";
  return null;
}

/** Why a bank takes no new deposit of ours (null: it may): in trouble, one of our own companies, a rate of nothing or a mispriced one. */
export function bankRefusal(b: BankResult, isOurs: (companyId: string) => boolean): string | null {
  const trouble = bankTrouble(b);
  if (trouble) return trouble;
  if (isOurs(b.company_id)) return "one of our own companies";
  if (!(b.demand_rate_bps > 0)) return "it pays nothing on demand deposits";
  if (b.demand_rate_bps > DEPOSIT_MAX_RATE_BPS) return `${b.demand_rate_bps} bps a game day: a rate the Crown flags as mispriced`;
  return null;
}

/** Reserves as a multiple of the Crown's required 20% (Infinity for a bank owing its depositors nothing). */
export function reserveCover(b: BankResult): number {
  return b.required_reserve_pence > 0 ? b.reserves_pence / b.required_reserve_pence : Infinity;
}

/**
 * The most of ours one bank may hold (pence): the Crown's insured 2,500 Cr, or (an insured bank with reserves at least twice the
 * Crown's 20%) the whole budget; never more than a tenth of its deposits plus reserves.
 */
export function bankCap(b: BankResult, budget: number): number {
  const strong = b.insured && reserveCover(b) >= DEPOSIT_STRONG_RESERVE_X;
  const share = Math.floor(DEPOSIT_BANK_SHARE * (Math.max(0, b.deposits_pence) + Math.max(0, b.reserves_pence)));
  return Math.max(0, Math.min(strong ? budget : DEPOSIT_INSURED_CAP_PENCE, share, budget));
}

/** Banks for a new deposit, best first: insured, then the higher demand rate, then the stronger reserves, then the larger. */
export function rankBanks(banks: BankResult[]): BankResult[] {
  const cover = (b: BankResult) => Math.min(reserveCover(b), 1_000);
  return [...banks].sort(
    (a, b) => Number(b.insured) - Number(a.insured) || b.demand_rate_bps - a.demand_rate_bps || cover(b) - cover(a) || b.reserves_pence - a.reserves_pence,
  );
}

/** The liquid buffer kept out of deposits: IDLE_BUFFER_PENCE, or DEPOSIT_BUFFER_BILL_DAYS of the daily bills (pence a game day) if more. */
export function depositBuffer(billsPerDay: number): number {
  return Math.max(IDLE_BUFFER_PENCE, Math.ceil(DEPOSIT_BUFFER_BILL_DAYS * Math.max(0, billsPerDay)));
}

/**
 * What may sit on deposit in all (pence): the cash the fleet doesn't need (`loose`: spare above the floors less the loads bound to
 * be bought and the fence) with what is on deposit now (`held`) counted back in, less the buffer and the buyer's keep, within the budget.
 */
export function depositTarget(o: { loose: number; held: number; buffer: number; keep: number; budget: number }): number {
  return Math.max(0, Math.min(Math.max(0, o.budget), Math.floor(o.loose + o.held - o.buffer - o.keep)));
}

/** Which deposits come back first: one at a bank in trouble, then the lowest rate, then the smallest (one call clears it). */
export function pullOrder<T extends { rateBps: number; free: number; trouble: string | null }>(xs: T[]): T[] {
  return [...xs].sort((a, b) => Number(!!b.trouble) - Number(!!a.trouble) || a.rateBps - b.rateBps || a.free - b.free);
}

/**
 * The fee (bps) to have a deposit paid into another region (guide 3.13.4): the bank's posted exchange fee there less our client
 * discount, only when that is strictly under the Crown's fee for the route; null when the bank doesn't offer the region or the Crown
 * is no dearer (then the deposit comes back into its own region, free, and the cash is remitted as any other).
 */
export function exchangeFee(b: BankResult | undefined, to: BankingRegion, discountBps: number, crownBps: number): number | null {
  const posted = b?.exchange_fee_bps?.[to];
  if (typeof posted !== "number" || !Number.isFinite(posted)) return null;
  const fee = Math.max(0, posted - Math.max(0, discountBps));
  return fee < crownBps ? fee : null;
}

/** Gross to withdraw for `net` to arrive after a fee of `bps`. */
export function grossFor(net: number, bps: number): number {
  return Math.ceil(net / Math.max(0.01, 1 - bps / 10_000));
}

/** How much of a deposit to pull for `need` (pence): the need and a margin, at least the smallest pull, its whole free balance when what is left would be dust. */
export function pullAmount(free: number, need: number): number {
  const want = Math.max(DEPOSIT_MIN_PULL_PENCE, Math.ceil(need) + 100);
  return free - want < DEPOSIT_DUST_PENCE ? free : want;
}

/** A deposit rate (bps a game day) as annual bps, to compare with a loan's. */
export function annualOf(dailyBps: number): number {
  return dailyBps * YEAR_DAYS;
}

/** Saved deposit records, calls with no answer and pulls (older saves have none): only well-formed entries come back. */
export function restoreDeposits(s: {
  recs?: Array<[string, DepositRec]>;
  pending?: PendingDeposit[];
  pulls?: DepositPull[];
  interestBefore?: number;
  stats?: Partial<DepositStats>;
} | undefined): { recs: Map<string, DepositRec>; pending: PendingDeposit[]; pulls: DepositPull[]; interestBefore: number; stats: DepositStats } {
  const recs = new Map<string, DepositRec>();
  for (const [id, r] of s?.recs ?? []) {
    const region = r ? asRegion(r.region) : null;
    if (typeof id === "string" && r && region && typeof r.bank === "string" && Number.isFinite(r.balance)) recs.set(id, { ...r, region });
  }
  const pending = (s?.pending ?? []).filter((p) => p && typeof p.bank === "string" && asRegion(p.region) && Number.isFinite(p.amount) && Number.isFinite(p.at));
  const pulls = (s?.pulls ?? []).filter((p) => p && typeof p.id === "string" && Number.isFinite(p.at) && Number.isFinite(p.amount)).slice(-DEPOSIT_PULLS_KEPT);
  const stats: DepositStats = { deposited: 0, deposits: 0, pulled: 0, pulls: 0 };
  for (const k of Object.keys(stats) as (keyof DepositStats)[]) {
    const v = s?.stats?.[k];
    if (typeof v === "number" && Number.isFinite(v)) stats[k] = v;
  }
  return { recs, pending, pulls, interestBefore: Number.isFinite(s?.interestBefore) ? s!.interestBefore! : 0, stats };
}

/** Bank deposits for the panel and the digest (pence; rates bps a game day; times ISO). */
export interface DepositsReport {
  /** The setting in force (the user's, or the AI's within it). */
  enabled: boolean;
  budgetPence: number;
  /** Why no new deposit is made now (null: one may be). */
  blocked: string | null;
  /** What the last pass did or would do. */
  action: string;
  checkedAt: string | null;
  /** What the last pass would keep on deposit in all (the cash the fleet doesn't need, within the budget). */
  targetPence: number;
  /**
   * On deposit now (the autopilot's: free balances, bar those frozen at a bank that isn't open), owed later by the banks (asked back and
   * not yet paid, and all of ours frozen at a bank that isn't open), and interest credited on them.
   */
  heldPence: number;
  owedLaterPence: number;
  interestPence: number;
  /**
   * Every deposit of ours as last read: `ours` the autopilot's (the only ones it touches; others were made by hand), whether its bank
   * is insured (null: not listed), and why its bank is in trouble (null: healthy).
   */
  deposits: Array<{
    id: string;
    bankId: string;
    bank: string;
    region: BankingRegion;
    balancePence: number;
    pendingWithdrawalPence: number;
    rateBps: number;
    insured: boolean | null;
    interestPence: number;
    openedAt: string | null;
    ours: boolean;
    trouble: string | null;
  }>;
  /** Banks as last listed, best first (at most 12): their terms, health, the room left for ours, and the verdict. */
  banks: Array<{
    id: string;
    name: string;
    rateBps: number;
    insured: boolean;
    depositsPence: number;
    reservesPence: number;
    requiredPence: number;
    roomPence: number;
    verdict: string;
  }>;
  /** Withdrawals of ours, newest last: what came at once (null: not known), what the bank still owes, the exchange fee, and why. */
  pulls: Array<{ at: string; bank: string; region: BankingRegion; to: BankingRegion | null; amountPence: number; paidPence: number | null; owedPence: number; feePence: number; why: string }>;
  /** Deposited and pulled back since the records began. */
  depositedPence: number;
  depositsMade: number;
  pulledPence: number;
}
