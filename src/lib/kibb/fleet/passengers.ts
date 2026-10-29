/**
 * Passengers (guide 3.20) in the spare hold of voyages the fleet sails anyway: never a lane of their own, never a detour.
 *
 * Pure logic, no calls. What to ask per head: the median fare groups accepted on the route lately (by kind), else the world's
 * fares per sea mile times this passage; a little under it (cheaper wins), less for a slow hull (a group counts its days at sea
 * against the fare), nudged by what our offers on the route won or left unfilled; never under what the weight's extra sailing
 * time costs the ship. Which waiting groups an offer can take (whole, before they give up), how many berths the free hold
 * gives, what a late arrival is guessed to pay, and whether holding a ship for the next game-hour round is worth its time.
 *
 * Berths are not a lane Part (a Part is a good bought and carried): the agent keeps its offers and the groups aboard itself.
 */

import type { AboardGroupView, FareRecordView, PassengerKind, WaitingGroupView } from "../schema";

/** Fewest recent accepted fares on a route (or in the world, per sea mile) for their median to stand. */
export const PAX_MIN_RECORDS = 3;
/** How far back a route's accepted fares count (game days): fares move with the season and the competition. */
export const PAX_RECENT_GAME_DAYS = 7;
/** Asked under the reference: groups take the cheapest value, the earlier offer on a tie (guide 3.20). */
export const PAX_UNDERCUT = 0.97;
/**
 * The route's nudge on the fare: up after a group boards on our offer, down after a game-hour round it stood unfilled with
 * groups waiting that it could take; its bounds. Up beats the undercut, so a route we carry alone climbs until groups refuse.
 */
export const PAX_ADJ_UP = 1.05;
export const PAX_ADJ_DOWN = 0.96;
export const PAX_ADJ_MIN = 0.6;
export const PAX_ADJ_MAX = 1.6;
/** Least asked per head (pence): the server wants a positive fare. */
export const PAX_MIN_FARE_PENCE = 100;
/** Our speed against the catalog's middling hull, weighted into the ask: the most a fast hull asks over, a slow one under. */
const PAX_SPEED_WEIGHT = 0.25;
const PAX_SPEED_MIN = 0.85;
const PAX_SPEED_MAX = 1.05;
/**
 * A late arrival (guide 3.20: cut for every game day past the promise, down to a floor; long overdue, ashore unpaid). The cut,
 * the floor and "long" aren't published: guessed on the safe side, for cash due only (the server pays what it pays).
 */
export const PAX_LATE_CUT_PER_DAY = 0.1;
export const PAX_LATE_FLOOR = 0.3;
export const PAX_OVERDUE_GAME_DAYS = 3;

/** A passenger group aboard one of our ships, as `passengers/aboard` (or the boarding notice) gave it. Times ISO. */
export interface PaxAboard {
  id: string;
  kind: string;
  size: number;
  origin: string | null;
  dest: string;
  /** The fare per head agreed, and the whole fare paid on arrival by the promise. */
  perHead: number;
  farePence: number;
  promisedAt: string | null;
  boardedAt: string | null;
}

/** An open sailing offer of ours (server ms). */
export interface PaxOffer {
  id: string;
  port: string;
  dest: string;
  perHead: number;
  berths: number;
  /** Heads boarded on it so far (passengers_boarded). */
  taken: number;
  /** Where she lay when it was posted (`berthed`, `anchored_roadstead`): a move since closes it (assumed: `ship_moved`). */
  spot: string;
  /** Posted at; and the latest `board_by` of the groups it was posted for (a round in between with none boarding: unfilled). */
  at: number;
  until: number;
  /** Share of the fares expected to land (pirates and storms take the rest; Lloyd's never insures fares). */
  kept: number;
}

/** What the pricer learned on one route (`from>to`): its nudge, and the game-hour rounds our offers won and stood unfilled. */
export interface PaxRoute {
  adj: number;
  won: number;
  lost: number;
  /** Server ms of the last round counted. */
  at: number;
}

export const routeKey = (from: string, to: string) => `${from}>${to}`;

export function median(xs: number[]): number | null {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/** A group aboard as we keep it. */
export function aboardOf(g: AboardGroupView): PaxAboard {
  return {
    id: g.id,
    kind: g.kind,
    size: g.size,
    origin: g.origin_port_id ?? null,
    dest: g.dest_port_id,
    perHead: g.fare_per_head_pence,
    farePence: g.full_fare_pence,
    promisedAt: g.promised_arrival_at ?? null,
    boardedAt: g.boarded_at ?? null,
  };
}

/** The median fare per head groups of `kind` (any kind: undefined) accepted on `from` → `to` since `since` (server ms), if enough did. */
export function routeReference(records: FareRecordView[], from: string, to: string, kind: PassengerKind | undefined, since: number): { perHead: number; n: number } | null {
  const xs = records
    .filter((f) => f.origin_port_id === from && f.dest_port_id === to && (kind === undefined || f.kind === kind) && Date.parse(f.accepted_at) >= since)
    .map((f) => f.fare_per_head_pence);
  if (xs.length < PAX_MIN_RECORDS) return null;
  const m = median(xs);
  return m !== null && m > 0 ? { perHead: m, n: xs.length } : null;
}

/** Distinct routes (`from>to`) of the newest fare records (of `kind`, if given), up to `max`: the ones whose length to read. */
export function routesToMeasure(records: FareRecordView[], kind: PassengerKind | undefined, max: number): Array<[string, string]> {
  const out = new Map<string, [string, string]>();
  for (const f of records) {
    if (out.size >= max) break;
    if (kind !== undefined && f.kind !== kind) continue;
    const k = routeKey(f.origin_port_id, f.dest_port_id);
    if (!out.has(k) && f.origin_port_id !== f.dest_port_id) out.set(k, [f.origin_port_id, f.dest_port_id]);
  }
  return [...out.values()];
}

/**
 * The world's fare per head per sea mile (pence): the median over fare records (of `kind`, if given) whose route length is
 * known, if enough are. A sea mile stands for a sea-hour at any one pace (the speed is weighed into the ask on its own).
 */
export function perHeadPerNm(records: FareRecordView[], nmOf: (from: string, to: string) => number | undefined, kind?: PassengerKind): number | null {
  const xs: number[] = [];
  for (const f of records) {
    if (kind !== undefined && f.kind !== kind) continue;
    const nm = nmOf(f.origin_port_id, f.dest_port_id);
    if (nm !== undefined && nm > 0 && f.fare_per_head_pence > 0) xs.push(f.fare_per_head_pence / nm);
  }
  return xs.length >= PAX_MIN_RECORDS ? median(xs) : null;
}

/** Berths an offer may take: whole heads in the free hold after a reserve (a packet carries two to the ton), at most 10,000. */
export function berthsFor(freeTons: number, perTon: number, reserveTons: number): number {
  const tons = Math.max(0, freeTons - reserveTons);
  return Math.max(0, Math.min(10_000, Math.floor(tons * Math.max(perTon, 1) + 1e-9)));
}

/** Groups waiting for `dest` that board whole within `berths` (groups never split) and still wait at server time `by`. */
export function fittingGroups(groups: WaitingGroupView[], dest: string, berths: number, by: number): WaitingGroupView[] {
  return groups.filter((g) => g.dest_port_id === dest && g.size >= 1 && g.size <= berths && Date.parse(g.board_by) > by);
}

/** Heads that could board together: the groups fitted whole, largest first, into the berths. */
export function fillHeads(groups: WaitingGroupView[], berths: number): number {
  let left = berths;
  for (const g of [...groups].sort((a, b) => b.size - a.size)) if (g.size <= left) left -= g.size;
  return berths - left;
}

/** The ask's factor for our speed against the catalog's middling hull: a fast hull may ask a little more, a slow one less. */
export function speedFactor(knots: number, refKnots: number): number {
  if (!(knots > 0) || !(refKnots > 0)) return 1;
  return Math.min(PAX_SPEED_MAX, Math.max(PAX_SPEED_MIN, 1 + PAX_SPEED_WEIGHT * (knots / refKnots - 1)));
}

/** Real ms the weight of `addFill` more of the hold adds to a passage (the planner's pace: knots × (1 − 0.2 × fill)). */
export function weightMs(nm: number, knots: number, fill: number, addFill: number, sailMs: (nm: number, knots: number) => number): number {
  const f0 = Math.min(1, Math.max(0, fill));
  const f1 = Math.min(1, Math.max(0, fill + addFill));
  return Math.max(0, sailMs(nm, knots * (1 - 0.2 * f1)) - sailMs(nm, knots * (1 - 0.2 * f0)));
}

export interface FareInput {
  /** Reference fare per head by kind (pence): the route's, or the world's per sea mile times this passage. */
  refs: Map<PassengerKind, number>;
  /** Waiting groups the offer could take (fittingGroups). */
  groups: WaitingGroupView[];
  berths: number;
  /** Least per head: what the weight's extra sailing time costs the ship, per head. */
  floor: number;
  /** The route's learned nudge, and the factor for our speed. */
  adj: number;
  speed: number;
}

/**
 * The fare per head to ask (one per offer): for each kind waiting, a little under its reference (nudged, speed weighed); the
 * ask that boards the most fare wins, a group taken to accept while the ask is within its kind's reference as nudged and
 * speed-weighed. Null: no group would take an ask over the floor.
 */
export function fareFor(x: FareInput): { perHead: number; heads: number; ref: number; kind: PassengerKind } | null {
  const limit = (kind: PassengerKind) => (x.refs.get(kind) ?? 0) * x.adj * x.speed;
  let best: { perHead: number; heads: number; ref: number; kind: PassengerKind; take: number } | null = null;
  for (const [kind, ref] of x.refs) {
    if (!(ref > 0)) continue;
    const ask = Math.max(PAX_MIN_FARE_PENCE, Math.ceil(x.floor), Math.round(ref * PAX_UNDERCUT * x.adj * x.speed));
    const heads = fillHeads(x.groups.filter((g) => ask <= limit(g.kind)), x.berths);
    if (heads <= 0) continue;
    const take = ask * heads;
    if (!best || take > best.take) best = { perHead: ask, heads, ref, kind, take };
  }
  return best ? { perHead: best.perHead, heads: best.heads, ref: best.ref, kind: best.kind } : null;
}

/** Share of a fare a landing at server time `at` is guessed to pay, promised by `promisedAt` (ISO; none: in full). */
export function lateShare(promisedAt: string | null, at: number, dayMs: number): number {
  const p = promisedAt ? Date.parse(promisedAt) : NaN;
  if (!Number.isFinite(p) || at <= p) return 1;
  const days = (at - p) / Math.max(dayMs, 1);
  if (days > PAX_OVERDUE_GAME_DAYS) return 0;
  return Math.max(PAX_LATE_FLOOR, 1 - Math.ceil(days) * PAX_LATE_CUT_PER_DAY);
}

/** Odds our offer wins a round on a route: the rounds won and stood unfilled there, from an even prior. */
export function winChance(r: PaxRoute | undefined): number {
  return ((r?.won ?? 0) + 1) / ((r?.won ?? 0) + (r?.lost ?? 0) + 2);
}

/** The route's nudge after a round: up when a group boarded, down when none did. */
export function nudged(adj: number, won: boolean): number {
  const a = Number.isFinite(adj) && adj > 0 ? adj : 1;
  return Math.min(PAX_ADJ_MAX, Math.max(PAX_ADJ_MIN, a * (won ? PAX_ADJ_UP : PAX_ADJ_DOWN)));
}

/** Whether holding the ship `waitMs` for the next round is worth it: the fares expected (`value`) against her time and dues. */
export function waitWorth(value: number, waitMs: number, ratePerHour: number, dues: number): { worth: boolean; cost: number } {
  const cost = (Math.max(0, waitMs) * Math.max(0, ratePerHour)) / 3_600_000 + Math.max(0, dues);
  return { worth: value > cost, cost };
}
