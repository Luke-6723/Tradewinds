/**
 * Passengers (guide 3.20) in the spare hold of voyages the fleet sails anyway: never a lane of their own, never a detour.
 *
 * Pure logic, no calls. Fares are an auction (guide 3.20 item 9): what a route paid is what the cheapest ship there asked, so
 * like is compared with like. The reference per head: the median fare groups accepted on the route lately (by kind), else the
 * median of its route-length band on the fares summary (the band a fare on the route counted in, or our sea distance mapped into
 * one), else the world's fares per sea mile times this passage. Where others offer (a contested route), a little under it
 * (cheaper wins); where groups keep giving up unboarded (an uncontested route: `route_unmet_groups` on a waiting group, or the
 * route on the summary's `unmet` list), opened well above a band's or the world's median (PAX_OPEN_HIGH), or at the route's own
 * median once it has one (the fares groups took there: ours), on a level of its own learned across visits: stepped down faster
 * after each unfilled round, up again after a boarding, so the route settles at the first fare taken. Less for a slow hull either
 * way (a group counts its days at sea against the fare); never under what the weight's extra sailing time costs the ship. Which
 * waiting groups an offer can take (whole, before they give up), how many berths the free hold gives, what a late arrival is
 * guessed to pay, and whether holding a ship for the next game-hour round is worth its time.
 *
 * Berths are not a lane Part (a Part is a good bought and carried): the agent keeps its offers and the groups aboard itself.
 */

import type { AboardGroupView, FareBandView, FareRecordView, PassengerKind, WaitingGroupView } from "../schema";

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
/**
 * An uncontested route (guide 3.20 item 9: groups giving up unboarded, nobody competing): the opening ask over a band's median or
 * the world's per sea mile ("well above the band's median"; never over the route's own median, which is the fares groups took
 * there, our learned asks already), and the faster step down of its level after a round it stood unfilled ("a step lower"). A
 * high opening costs only a little time: groups that won't pay it stay ashore.
 */
export const PAX_OPEN_HIGH = 1.5;
export const PAX_ADJ_DOWN_OPEN = 0.9;
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
  /**
   * Priced as uncontested (fareFor): its rounds teach the route's uncontested level (`adjOpen`, an unfilled one a faster step down),
   * never the contested nudge. Absent on older saves: not.
   */
  open?: boolean;
}

/**
 * What the pricer learned on one route (`from>to`): its nudge on a contested ask (`adj`), its level on an uncontested one
 * (`adjOpen`; absent on older saves and until an uncontested round: 1), and the game-hour rounds our offers won and stood unfilled.
 */
export interface PaxRoute {
  adj: number;
  adjOpen?: number;
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

/**
 * The median fare per head of a route's length band on the fares summary (guide 3.20: like compared with like), if enough fares
 * counted in it: the band a fare record on the route counted in (`band`), else the band whose `[min_nm, max_nm)` holds `nm` (our
 * sea distance for the passage). Null: no such band, or too few fares in it.
 */
export function bandReference(bands: readonly FareBandView[], band: string | null, nm: number): { perHead: number; band: string } | null {
  const b = (band ? bands.find((x) => x.band === band) : undefined) ?? (nm > 0 ? bands.find((x) => nm >= x.min_nm && (x.max_nm == null || nm < x.max_nm)) : undefined);
  const m = b?.median_fare_per_head_pence;
  if (!b || !(b.fares >= PAX_MIN_RECORDS) || typeof m !== "number" || !(m > 0)) return null;
  return { perHead: m, band: b.band };
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
  /** Reference fare per head by kind (pence): the route's, its length band's, or the world's per sea mile times this passage. */
  refs: Map<PassengerKind, number>;
  /** Waiting groups the offer could take (fittingGroups). */
  groups: WaitingGroupView[];
  berths: number;
  /** Least per head: what the weight's extra sailing time costs the ship, per head. */
  floor: number;
  /** The route's learned nudge on a contested ask, its level on an uncontested one (absent: 1), and the factor for our speed. */
  adj: number;
  adjOpen?: number;
  speed: number;
  /** Kinds the route is uncontested for (groups of it gave up unboarded lately): priced on `adjOpen`, not undercut. Absent: none. */
  open?: ReadonlySet<PassengerKind>;
  /** Kinds whose reference is the route's own median (fares groups took there): an uncontested ask doesn't open high over it. */
  own?: ReadonlySet<PassengerKind>;
  /** The odds our offer wins a round on the route (winChance): the share of an opening ask's heads expected to board. */
  win?: number;
}

/**
 * The fare per head to ask (one per offer): for each kind waiting, a little under its reference on the contested nudge (speed
 * weighed), or for a kind the route is uncontested for, on the route's uncontested level: PAX_OPEN_HIGH over a band's or the
 * world's median, the route's own median as it is; the ask that is expected to board the most fare wins. A group is taken to
 * accept while the ask is within its kind's reference as nudged and speed-weighed, or, for an uncontested kind, within our own
 * ask (a probe: never thrown away by the model that set it), its heads then weighed by the route's odds of a round won.
 * Null: no group would take an ask over the floor.
 */
export function fareFor(x: FareInput): { perHead: number; heads: number; ref: number; kind: PassengerKind; open: boolean } | null {
  const open = x.open ?? new Set<PassengerKind>();
  const own = x.own ?? new Set<PassengerKind>();
  const adjOpen = Number.isFinite(x.adjOpen) && x.adjOpen! > 0 ? x.adjOpen! : 1;
  // Over the reference: uncontested, on its own level (high over a median not the route's); contested, under it on the nudge.
  const mult = (kind: PassengerKind) => (open.has(kind) ? (own.has(kind) ? 1 : PAX_OPEN_HIGH) * adjOpen : PAX_UNDERCUT * x.adj);
  // A pence of slack: an uncontested ask is this figure rounded, and must stand within it.
  const limit = (kind: PassengerKind) => (x.refs.get(kind) ?? 0) * (open.has(kind) ? mult(kind) : x.adj) * x.speed + 1;
  const win = Number.isFinite(x.win) ? Math.min(1, Math.max(0, x.win!)) : 0.5;
  let best: { perHead: number; heads: number; ref: number; kind: PassengerKind; open: boolean; take: number } | null = null;
  for (const [kind, ref] of x.refs) {
    if (!(ref > 0)) continue;
    const ask = Math.max(PAX_MIN_FARE_PENCE, Math.ceil(x.floor), Math.round(ref * mult(kind) * x.speed));
    const heads = fillHeads(x.groups.filter((g) => ask <= limit(g.kind)), x.berths);
    if (heads <= 0) continue;
    const take = ask * heads * (open.has(kind) ? win : 1);
    if (!best || take > best.take) best = { perHead: ask, heads, ref, kind, open: open.has(kind), take };
  }
  return best ? { perHead: best.perHead, heads: best.heads, ref: best.ref, kind: best.kind, open: best.open } : null;
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

/**
 * A route's nudge (or uncontested level) after a round: up when a group boarded, down when none did (`open`: our offer was priced
 * as uncontested, a step lower each unfilled round, PAX_ADJ_DOWN_OPEN).
 */
export function nudged(adj: number, won: boolean, open = false): number {
  const a = Number.isFinite(adj) && adj > 0 ? adj : 1;
  return Math.min(PAX_ADJ_MAX, Math.max(PAX_ADJ_MIN, a * (won ? PAX_ADJ_UP : open ? PAX_ADJ_DOWN_OPEN : PAX_ADJ_DOWN)));
}

/** Whether holding the ship `waitMs` for the next round is worth it: the fares expected (`value`) against her time and dues. */
export function waitWorth(value: number, waitMs: number, ratePerHour: number, dues: number): { worth: boolean; cost: number } {
  const cost = (Math.max(0, waitMs) * Math.max(0, ratePerHour)) / 3_600_000 + Math.max(0, dues);
  return { worth: value > cost, cost };
}
