/**
 * Escorting other companies' convoys (the escortOthers setting, with convoys on; guide 3.10). Pure logic, no calls.
 *
 * The game's terms: other companies' non-escort ships pay `escort_fee_pence_per_ton × hold_capacity_tons` into escrow when they join a
 * convoy that charges; armed ships may join `as_escort`, pay nothing, and the escorts that arrive split those fees by cannon count. So an
 * armed ship of ours lying at a convoy's origin, about to sail for its destination anyway, earns a share of its fee pool for the wait.
 *
 * When (FleetManager.convoyDecision, at sail time, after any convoy of ours and before forming one): the convoy is another company's,
 * public, forming here for the very port she sails for, not invite-only, charging a fee with something in its pool (the paying members'
 * escrow, as the listing shows it), no speed floor over hers, its pace (the slowest joined member) no slower than CONVOY_MIN_SPEED_RATIO of
 * hers, sailing within ESCORT_JOIN_MAX_WAIT_GAME_H; she mounts guns, holds no policy (or one that can't be read), carries no contraband,
 * no venture, no passengers bound elsewhere; the stores, the charters' and sealed freight's deadlines and the season fit the convoy's
 * timing and pace (the join path's own checks). Then joined when what she expects (joinCase) beats waiting for it:
 *
 *   share     = pool × our guns / (escorts' guns + ours) × the odds she arrives (escorts that arrive share)
 *   protection = ESCORT_JOIN_PIRACY_SHARE × her own piracy loss alone × (1 − 1/(members + 1))  (pirates board one member per interception)
 *   net       = share + protection − the slower passage's storms − passengers' late cut − her time at the slower pace − her time waiting
 *
 * Joining by approval leaves the request pending: the organizer is waited for at most ESCORT_PENDING_MAX_GAME_MIN (never closer than
 * ESCORT_PENDING_MARGIN_GAME_MIN to the departure), then withdrawn. Once in, every pass (convoyWait) she leaves before departure if
 * the switch goes off, her plan no longer makes for its port, a policy or contraband comes aboard, a slower ship joins, or nothing is left
 * in the pool. Lane choice values the share only lightly (ESCORT_PLAN_WEIGHT of it, for a convoy the quays' notices still show, on the real
 * pool the last convoy listing at its port gave; none seen, nothing counted). A passage's escort record closes unsettled only past its
 * departure, its passage at the convoy's pace and ESCORT_SETTLE_MARGIN_GAME_DAYS; a settlement notice is booked to any record of that convoy.
 */

/** A convoy sailing later than this (game hours) isn't waited for. */
export const ESCORT_JOIN_MAX_WAIT_GAME_H = 3;
/** Least net expected for a join (pence; 50 Cr). */
export const ESCORT_JOIN_MIN_GAIN_PENCE = 5_000;
/** Share of the pooled protection counted (the others' holds and guns are guessed). */
export const ESCORT_JOIN_PIRACY_SHARE = 0.5;
/** An organizer's answer is waited for at most this long (game minutes), never closer than the margin to its departure. */
export const ESCORT_PENDING_MAX_GAME_MIN = 20;
export const ESCORT_PENDING_MARGIN_GAME_MIN = 10;
/** A request with no answer, or a status read that failed: looked at again after this (real ms). */
export const ESCORT_STATUS_READ_MS = 10_000;
/** A request refused, withdrawn or lapsed: no other company's convoy tried for that ship at that port for this long (game hours). */
export const ESCORT_JOIN_RETRY_GAME_H = 2;
/** Records kept for the report, newest last. */
export const ESCORT_JOINS_KEPT = 30;
/** A passage sailed with no settlement notice seen is closed this long (game days) after its departure and passage (fees go to the vaults). */
export const ESCORT_SETTLE_MARGIN_GAME_DAYS = 3;
/** Lane choice counts this share of the expected fee share (escortOthers: lightly). */
export const ESCORT_PLAN_WEIGHT = 0.25;

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/** Our expected share of a convoy's escort fees (pence): the pool by our guns' share of the escorts', times the odds she arrives. */
export function escortShareOf(x: { pool: number; ourGuns: number; escortGuns: number; arrive: number }): number {
  if (!(x.pool > 0) || !(x.ourGuns > 0)) return 0;
  return (x.pool * x.ourGuns) / (Math.max(0, x.escortGuns) + x.ourGuns) * clamp(x.arrive, 0, 1);
}

/** Whether joining as an escort pays (pence): the share and part of the protection against the slower passage and the wait. */
export function joinCase(x: { share: number; protection: number; stormCost: number; paxLate: number; paceCost: number; waitCost: number }): { ok: boolean; net: number } {
  const net = x.share + ESCORT_JOIN_PIRACY_SHARE * Math.max(0, x.protection) - Math.max(0, x.stormCost) - Math.max(0, x.paxLate) - Math.max(0, x.paceCost) - Math.max(0, x.waitCost);
  return { ok: x.share > 0 && net >= ESCORT_JOIN_MIN_GAIN_PENCE, net: Math.round(net) };
}

/**
 * Light lane value of a convoy (planner: ESCORT_PLAN_WEIGHT of it): its real fee pool as the convoy listing at its port last showed it (the
 * joined members' escrow: only other companies' non-escort ships pay, never the organizer's own ships or the escorts), our guns' share of
 * the escorts'. Pence; nothing without a pool seen (a notice's member count can't tell payers from the organizer's own ships).
 */
export function planShare(x: { pool: number; escortGuns: number; ourGuns: number }): number {
  return ESCORT_PLAN_WEIGHT * escortShareOf({ pool: x.pool, ourGuns: x.ourGuns, escortGuns: x.escortGuns, arrive: 1 });
}

/** Until when (server ms) a pending request is waited for: the cap, never closer than the margin to the departure. */
export function pendingUntil(now: number, departsAt: number, gameMinuteMs: number): number {
  return Math.min(now + ESCORT_PENDING_MAX_GAME_MIN * gameMinuteMs, departsAt - ESCORT_PENDING_MARGIN_GAME_MIN * gameMinuteMs);
}

/**
 * One ship of ours escorting (or asking to escort) another company's convoy. Times server ms. `status`: `joining` (the call sent, no
 * answer yet), `pending` (the organizer decides), `joined`, `sailed` (departed with her), `settled` (fees paid), `refused` (rejected or
 * lapsed), `withdrawn` (we left before departure), `cancelled` (the convoy was), `failed` (the join refused).
 */
export interface EscortJoinRec {
  shipId: string;
  ship: string;
  convoyId: string;
  from: string;
  dest: string;
  departsAt: number;
  status: "joining" | "pending" | "joined" | "sailed" | "settled" | "refused" | "withdrawn" | "cancelled" | "failed";
  at: number;
  /** A pending request is withdrawn after this (server ms). */
  until?: number;
  /** The fee pool and the escorts' guns when she asked, her guns, our expected share and the case's net (pence). */
  pool: number;
  escortGuns: number;
  guns: number;
  expected: number;
  net: number;
  /** Real ms of the passage at the convoy's pace when she asked (absent on older saves): an unsettled record closes only after it. */
  passageMs?: number;
  /** Fees paid her (as the settlement notice said), and why it ended. */
  pence?: number;
  why?: string;
}

export interface EscortJoinStats {
  asked: number;
  joined: number;
  refused: number;
  withdrawn: number;
  sailed: number;
  settled: number;
  feesPence: number;
  expectedPence: number;
}

export const emptyEscortJoinStats = (): EscortJoinStats => ({ asked: 0, joined: 0, refused: 0, withdrawn: 0, sailed: 0, settled: 0, feesPence: 0, expectedPence: 0 });

/** Escorting others' convoys for the panel and the digest (pence; times ISO). */
export interface EscortJoinReport {
  /** The setting in force (convoys must be on too). */
  enabled: boolean;
  blocked: string | null;
  /** Ours asking, in, or sailing as escorts now, and the last ones. */
  active: Array<{ ship: string; convoyId: string; route: string; departsAt: string; status: EscortJoinRec["status"]; expectedPence: number; poolPence: number }>;
  recent: Array<{ at: string; ship: string; route: string; status: EscortJoinRec["status"]; expectedPence: number; pence: number | null; why: string | null }>;
  stats: EscortJoinStats;
  /** Others' fee-charging convoys the quays' notices show forming now. */
  offers: number;
}

const STATUSES: ReadonlyArray<EscortJoinRec["status"]> = ["joining", "pending", "joined", "sailed", "settled", "refused", "withdrawn", "cancelled", "failed"];

/** Live: asking, in, or sailing (fees not settled yet). */
export const joinLive = (r: EscortJoinRec) => r.status === "joining" || r.status === "pending" || r.status === "joined" || r.status === "sailed";

export function restoreEscortJoins(s: { recs?: EscortJoinRec[]; stats?: Partial<EscortJoinStats> } | undefined): { recs: EscortJoinRec[]; stats: EscortJoinStats } {
  const stats = emptyEscortJoinStats();
  for (const k of Object.keys(stats) as (keyof EscortJoinStats)[]) {
    const v = s?.stats?.[k];
    if (typeof v === "number" && Number.isFinite(v)) stats[k] = v;
  }
  const recs = (Array.isArray(s?.recs) ? s!.recs : [])
    .filter((r) => r && typeof r.shipId === "string" && typeof r.convoyId === "string" && STATUSES.includes(r.status) && Number.isFinite(r.at) && Number.isFinite(r.departsAt))
    .map((r) => ({ ...r }))
    .slice(-ESCORT_JOINS_KEPT);
  return { recs, stats };
}
