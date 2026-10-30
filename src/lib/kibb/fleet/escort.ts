/**
 * Convoy escort fees (guide 3.10; the `escortFees` setting): other companies' ships pay to sail in our convoys.
 *
 * Pure logic, no calls. The game's terms: a non-escort ship of another company pays `escort_fee_pence_per_ton × hold_capacity_tons`
 * (at most 1,000 Cr a ton) into escrow on joining (refunded if it doesn't sail or is lost); armed ships may join `as_escort`, pay
 * nothing, and the ESCORTS that arrive share the fees pro rata to their cannons. The organizer's own ships pay nothing either way.
 * So the fees come to us only through our own armed ships joined as escorts: a convoy that charges is announced
 * (`announce-convoy`, no ship needed: our presence is the ship forming it) and our ships join it `as_escort` when they mount guns.
 *
 * What we charge: about half what pooling with our ships is expected to save a joiner per ton of its hold (in a convoy of n ships
 * pirates board one per interception, so a ship's expected piracy loss falls to about 1/n of sailing alone), between a floor and the
 * game's cap; with the fareBandit setting, a multiplier on that fee learned by Thompson sampling from whether a paying ship joined
 * (bandit.ts ESCORT_GRID; FleetManager.escortFeeArm). Who we admit (`approval`): ships no slower than our slowest member's base speed (our check only: no
 * `min_speed_centiknots` is set on the convoy, since the game may compare a laden joiner, up to a fifth slower, and refuse our own
 * ships, the forming one included), escorts only with guns, a few outsiders at most, and none while a ship of ours in it holds a
 * policy Lloyd's may have priced on its consorts. A ship of ours with a policy (or one that can't be read) never forms or joins a
 * convoy open to outsiders. A joiner never costs us: its fee is escrowed by the game before it is in, and our ships' stores, timing
 * and charters are judged as before. An announcement the game refuses (a company's five forming ones) falls back to a private convoy.
 */

/** The game's cap on the fee (pence per ton of a joiner's hold), and ours: a floor so a quiet passage still charges a little. */
export const ESCORT_FEE_MAX_PENCE_PER_TON = 100_000;
export const ESCORT_FEE_FLOOR_PENCE_PER_TON = 300;
/** Share of the joiner's expected saving per ton asked. */
export const ESCORT_FEE_SHARE = 0.5;
/** Most other companies' ships admitted to one convoy of ours. */
export const ESCORT_MAX_OUTSIDERS = 6;
/** Convoy events kept for the report, newest last. */
export const ESCORT_EVENTS_KEPT = 30;
/** A pending request is decided once (approve or reject); its id is remembered this long (real ms) so two of our ships never both act. */
export const ESCORT_DECIDED_MS = 30 * 60_000;

/**
 * The fee per ton of a joiner's hold: half what sailing with our `ships` is expected to save it per ton (`lossPerTonAlone`: its
 * expected piracy loss per ton sailing alone, cargo and hull), within the floor and the cap. Whole pence.
 */
export function escortFee(lossPerTonAlone: number, ships: number): number {
  const n = Math.max(1, Math.floor(ships));
  const saved = Math.max(0, lossPerTonAlone) * (1 - 1 / (n + 1));
  return Math.min(ESCORT_FEE_MAX_PENCE_PER_TON, Math.max(ESCORT_FEE_FLOOR_PENCE_PER_TON, Math.round(saved * ESCORT_FEE_SHARE)));
}

/** A request to join one of our convoys, as the organizer sees it. */
export interface JoinRequest {
  escort: boolean;
  cannons: number;
  /** The joiner's speed (centiknots, its class's base speed) against the convoy's floor (our slowest member's). */
  speedCk: number;
  minSpeedCk: number;
  /** Ships of other companies already in. */
  outsiders: number;
  /** Ours (never pending: the organizer's ships join at once). */
  ours: boolean;
}

/** Approve or reject, and why (our words). */
export function joinVerdict(m: JoinRequest): { approve: boolean; why: string } {
  if (m.ours) return { approve: true, why: "one of ours" };
  if (m.minSpeedCk > 0 && m.speedCk < m.minSpeedCk) return { approve: false, why: `it would slow the convoy (${(m.speedCk / 100).toFixed(1)} kn under our ${(m.minSpeedCk / 100).toFixed(1)} kn)` };
  if (m.escort && !(m.cannons > 0)) return { approve: false, why: "an escort with no guns" };
  if (m.outsiders >= ESCORT_MAX_OUTSIDERS) return { approve: false, why: `the convoy has ${m.outsiders} ships of other companies already` };
  return { approve: true, why: m.escort ? `an escort with ${m.cannons} guns (pays nothing, adds guns)` : "pays the escort fee" };
}

/** One thing that happened to the escort business, for the panel. Times ISO. */
export interface EscortEvent {
  at: string;
  convoyId: string;
  dest: string | null;
  what: "offered" | "approved" | "rejected" | "settled" | "failed";
  note: string;
  pence?: number;
}

export interface EscortStats {
  /** Convoys we offered to others (public, with a fee). */
  offered: number;
  approved: number;
  escortsApproved: number;
  rejected: number;
  /** Fee settlements seen, and what they paid our escorts (as far as the notices said). */
  settlements: number;
  feesPence: number;
}

/** Escort fees for the panel and the digest (pence; times ISO). */
export interface EscortReport {
  /** The setting in force (convoys must be on too). */
  enabled: boolean;
  /** Why no convoy is offered now (the switches); null: one may be. */
  blocked: string | null;
  floorPerTonPence: number;
  capPerTonPence: number;
  /** Our convoys forming now that charge: fee per ton, other companies' ships in and pending, their fees in escrow. */
  open: Array<{ convoyId: string; from: string; dest: string; departsAt: string; feePerTonPence: number; minSpeedCk: number | null; ours: number; outsiders: number; pending: number; escrowPence: number }>;
  stats: EscortStats;
  recent: EscortEvent[];
}

export function restoreEscort(s: { stats?: Partial<EscortStats>; recent?: EscortEvent[] } | undefined): { stats: EscortStats; recent: EscortEvent[] } {
  const stats: EscortStats = { offered: 0, approved: 0, escortsApproved: 0, rejected: 0, settlements: 0, feesPence: 0 };
  for (const k of Object.keys(stats) as (keyof EscortStats)[]) {
    const v = s?.stats?.[k];
    if (typeof v === "number" && Number.isFinite(v)) stats[k] = v;
  }
  const recent = (Array.isArray(s?.recent) ? s!.recent : []).filter((e) => e && typeof e.convoyId === "string" && typeof e.what === "string").slice(-ESCORT_EVENTS_KEPT);
  return { stats, recent };
}

/**
 * Our share of a `convoy_escort_fees_settled` notice (its shape isn't published): a list of shares (`shares`, `payouts`,
 * `escorts`) with a company and an amount, ours summed; else one amount named for an escort's share when the notice is ours alone.
 * Null: the notice says nothing we can read.
 */
export function escortShare(p: Record<string, unknown>, ours: (companyId: string) => boolean): number | null {
  const amount = (o: Record<string, unknown>) => {
    for (const k of ["share_pence", "amount_pence", "fee_pence", "paid_pence", "escort_fee_pence", "payout_pence"]) if (typeof o[k] === "number" && Number.isFinite(o[k])) return o[k] as number;
    return null;
  };
  for (const key of ["shares", "payouts", "escorts", "members"]) {
    const list = p[key];
    if (!Array.isArray(list)) continue;
    let sum = 0;
    let seen = false;
    for (const x of list) {
      if (!x || typeof x !== "object") continue;
      const o = x as Record<string, unknown>;
      const who = typeof o.company_id === "string" ? o.company_id : typeof o.escort_company_id === "string" ? o.escort_company_id : null;
      const a = amount(o);
      if (who && ours(who) && a !== null) {
        sum += a;
        seen = true;
      }
    }
    if (seen) return sum;
  }
  // One amount: ours only when the notice names our company, or names the amount as a share (a total of the fees isn't ours).
  const who = typeof p.company_id === "string" ? p.company_id : typeof p.escort_company_id === "string" ? p.escort_company_id : null;
  if (who !== null && ours(who)) return amount(p);
  for (const k of ["share_pence", "payout_pence", "our_share_pence"]) if (typeof p[k] === "number" && Number.isFinite(p[k])) return p[k] as number;
  return null;
}
