/**
 * Passenger voyages (guide 3.20; the `passengerVoyages` setting, under `usePassengers`): the fares of groups waiting where a ship
 * lies, counted in the lanes she could sail from there, so a lane whose first passage carries passengers ranks for them, and a
 * passage for fares alone (no cargo: a "passengers" lane) is planned where enough groups wait for one port.
 *
 * Pure logic, no calls. The planner (planner.ts buildLeg / buildPaxLeg) asks paxValue for one passage out of the ship's port:
 *
 *   - the groups: those waiting where she lies (World.waitingAt, read for her own port only and cached a few game minutes; never
 *     for every port), bound for the passage's port, that board whole in the hold left after the lane's cargo and a stores
 *     reserve, and still wait at the first game-hour round after the offer could go up (`board_by`; the offer is posted at the
 *     sail-time hook, after the loading);
 *   - per group: the fare the pricer would ask (passengers.ts fareFor: the route's own median, else its length band's on the fares
 *     summary, open high where nobody competes, the route's learned levels; only cached data here, never the world's per sea mile,
 *     which needs routes read) × the odds our offer wins a round on the route (winChance; on every kind, the safe side) × the share
 *     of the passage expected to land (pirates taking the ship, a storm sinking her: fares are never insured) × the late cut at our
 *     landing against the promise the boarding round would give (a direct passage lands on it);
 *   - the weight of the berths (passengers weigh like cargo) slows her: the extra sailing time is a floor on the fare (as the
 *     sail-time pricer has it) and is added to the leg's time.
 *
 * Nothing here posts an offer or holds a ship: the offer is posted at the sail-time hook as before (ShipAgent.offerBerths, one
 * round's wait at most, paxHoldMs), so the fill-spare-hold flow stands. A passenger-only voyage is planned only when even the
 * smallest group that fits, boarding alone, pays the passage's cost (her time to the landing at her rate, and the hull's risk:
 * `least`), since a group aboard pins her to it; one whose groups didn't board isn't sailed empty (ShipAgent.sailTo gives the
 * lane up, and none is planned again that stay).
 */

import type { FareBandView, FareRecordView, PassengerKind, WaitingGroupView } from "../schema";
import { bandReference, berthsFor, fareFor, fittingGroups, lateShare, routeReference, winChance, type PaxRoute } from "./passengers";

/** A passenger-only voyage is planned only for at least this much expected in fares (pence; 500 Cr) and this many heads. */
export const PAX_ONLY_MIN_PENCE = 50_000;
export const PAX_ONLY_MIN_HEADS = 4;
/** Ports tried for a passenger-only voyage from one port, those with the most heads waiting first. */
export const PAX_ONLY_DESTS = 4;
/** The groups waiting at a port stand this long once read (game minutes): new groups come every game hour. */
export const PAX_WAITING_TTL_GAME_MIN = 30;
/** Ports whose waiting groups are cached at once (each read is one port's: the ship's own). */
export const PAX_WAITING_PORTS_KEPT = 24;
/** A hold for a round ends this long after it (game minutes): as the sail-time hold (agent.ts PAX_ROUND_SLACK_GAME_MIN). */
export const PAX_ROUND_SLACK_GAME_MIN = 3;
/** Voyages chosen for their fares kept for the report, newest last. */
export const PAX_VOYAGES_KEPT = 20;

/** The pricer's references for one route as the planner may use them (cached data only). */
export interface PaxPricing {
  /** Reference fare per head by kind (pence): the route's own median, else its length band's. */
  refs: Map<PassengerKind, number>;
  /** Kinds nobody competes for on the route (groups gave up unboarded lately): opened high. */
  open: Set<PassengerKind>;
  /** Kinds whose reference is the route's own median. */
  own: Set<PassengerKind>;
  /** The route's learned nudge (contested) and level (uncontested), and the odds our offer wins a round there. */
  adj: number;
  adjOpen?: number;
  win: number;
}

/** What the planner is given to value passengers waiting where the ship lies (built by the manager for one planning pass). */
export interface PaxLanes {
  /** The port she lies at: the groups wait and board here. */
  from: string;
  /** The groups waiting there as last read (World.waitingAt). */
  groups: WaitingGroupView[];
  /** Heads a ton of hold carries (a packet two), and tons kept free for a stores top-up. */
  perTon: number;
  reserve: number;
  /** What her time is worth (pence an hour): the weight's extra sailing time is the least per head. */
  ratePerHour: number;
  /** The ask's factor for her speed against the catalog's middling hull (passengers.ts speedFactor). */
  speed: number;
  /** A game day (real ms), for the late cut. */
  dayMs: number;
  /** Server time of the next whole game hour after `t`, when the groups choose (null: no clock read yet). */
  nextRound: (t: number) => number | null;
  /** The pricer's references for `from` → `dest` (`nm`: our sea distance for the passage); null: no fare known for it. */
  pricing: (dest: string, nm: number) => PaxPricing | null;
  /** Passenger-only voyages may be planned (no hold for a round decided this stay, none given up here). */
  only: boolean;
}

/** The fares a passage is expected to bring (one offer: one fare per head), for the lane and the log. */
export interface PaxValue {
  dest: string;
  /** Heads expected to fit and take the ask (before the odds of winning), the ask, the kind it was set for, whether uncontested. */
  heads: number;
  perHead: number;
  kind: PassengerKind;
  open: boolean;
  /** Expected fares landed (pence): ask × heads × odds × share landing × late cut. */
  value: number;
  /** Real ms the berths' weight adds to the passage (all heads aboard). */
  extraMs: number;
  /** Groups that could board. */
  groups: number;
  /**
   * The pessimistic case (groups never split, and none can be put ashore once aboard): the smallest group that fits boarding alone,
   * at the ask, landed (pence; no odds of winning: it boarded). A passage for fares alone must pay for itself on this.
   */
  least: number;
}

/** What a lane counts of passengers (planner.ts Lane.pax), for the log and the panel. */
export interface LanePax {
  /** The port the fares are for (the lane's destination, or its source when she sails empty there first). */
  dest: string;
  heads: number;
  perHead: number;
  /** Expected fares landed (pence), counted in the lane's profit. */
  value: number;
}

/**
 * The pricer's references for `from` → `dest` from cached data only (no call): the route's own accepted fares by kind (`records`:
 * the route's own as read when an offer there was priced, else the world-wide ones), else the median of its length band on the
 * fares summary (the band a fare on the route counted in, else our sea distance mapped into one); kinds groups of it gave up
 * unboarded lately (`route_unmet_groups`, or the summary's `unmet`) are uncontested. Null: no reference for any kind waiting.
 */
export function paxPricing(x: {
  from: string;
  dest: string;
  nm: number;
  groups: WaitingGroupView[];
  records: FareRecordView[];
  bands: readonly FareBandView[];
  since: number;
  unmet: (kind: PassengerKind) => boolean;
  route: PaxRoute | undefined;
}): PaxPricing | null {
  const kinds = new Set(x.groups.filter((g) => g.dest_port_id === x.dest).map((g) => g.kind));
  if (kinds.size === 0) return null;
  const refs = new Map<PassengerKind, number>();
  const own = new Set<PassengerKind>();
  const routeBand = x.records.find((f) => f.origin_port_id === x.from && f.dest_port_id === x.dest && f.band)?.band ?? null;
  for (const kind of kinds) {
    const r = routeReference(x.records, x.from, x.dest, kind, x.since) ?? routeReference(x.records, x.from, x.dest, undefined, x.since);
    if (r) {
      refs.set(kind, r.perHead);
      own.add(kind);
      continue;
    }
    const b = bandReference(x.bands, routeBand, x.nm);
    if (b) refs.set(kind, b.perHead);
  }
  if (refs.size === 0) return null;
  const open = new Set<PassengerKind>();
  for (const kind of refs.keys()) {
    if (x.groups.some((g) => g.dest_port_id === x.dest && g.kind === kind && (g.route_unmet_groups ?? 0) > 0) || x.unmet(kind)) open.add(kind);
  }
  return { refs, open, own, adj: x.route?.adj ?? 1, adjOpen: x.route?.adjOpen, win: winChance(x.route) };
}

/**
 * The fares one passage out of the ship's port is expected to bring: groups waiting for `dest` that board whole in `freeTons`
 * (less the stores reserve) and still wait at the first round after `postAt`, at the ask the pricer would post, weighed by the
 * odds of winning the round, the share `kept` landing and the late cut at `landsAt` against the promise that round would give
 * (`passageMs` after it). `weightMs(addFill)`: real ms the passage gains with `addFill` more of the hold filled. Null: nothing.
 */
export function paxValue(
  p: PaxLanes,
  a: { dest: string; nm: number; cap: number; freeTons: number; postAt: number; landsAt: number; passageMs: number; kept: number; weightMs: (addFill: number) => number },
): PaxValue | null {
  const berths = berthsFor(a.freeTons, p.perTon, p.reserve);
  if (berths < 1) return null;
  const round = p.nextRound(a.postAt);
  if (round === null) return null;
  // Groups never split, and must still wait at the round the offer stands for (board_by after it).
  const groups = fittingGroups(p.groups, a.dest, berths, round);
  if (groups.length === 0) return null;
  const pricing = p.pricing(a.dest, a.nm);
  if (!pricing) return null;
  const cap = Math.max(a.cap, 1);
  // The weight's extra sailing time, at what her time is worth, is the least asked per head (as the sail-time pricer has it).
  const fullMs = a.weightMs(berths / Math.max(p.perTon, 1) / cap);
  const floor = ((fullMs / 3_600_000) * Math.max(0, p.ratePerHour)) / Math.max(berths, 1);
  const q = fareFor({ refs: pricing.refs, groups, berths, floor, adj: pricing.adj, adjOpen: pricing.adjOpen, speed: p.speed, open: pricing.open, own: pricing.own, win: pricing.win });
  if (!q || q.heads <= 0) return null;
  // Promised at boarding: the passage at our pace from the round, plus leeway (unpublished: none counted, the safe side).
  const late = lateShare(new Date(round + Math.max(0, a.passageMs)).toISOString(), a.landsAt, p.dayMs);
  const win = Math.min(1, Math.max(0, pricing.win));
  const value = q.perHead * q.heads * win * Math.min(1, Math.max(0, a.kept)) * late;
  if (!(value > 0)) return null;
  const smallest = Math.min(...groups.map((g) => g.size));
  return {
    dest: a.dest,
    heads: q.heads,
    perHead: q.perHead,
    kind: q.kind,
    open: q.open,
    value: Math.round(value),
    extraMs: Math.round(a.weightMs(q.heads / Math.max(p.perTon, 1) / cap)),
    groups: groups.length,
    least: Math.round(q.perHead * smallest * Math.min(1, Math.max(0, a.kept)) * late),
  };
}

/** Ports the groups waiting at `from` are bound for, most heads first (at most PAX_ONLY_DESTS): where a passenger-only voyage is tried. */
export function paxDests(groups: WaitingGroupView[], from: string, by: number): string[] {
  const heads = new Map<string, number>();
  for (const g of groups) {
    if (g.dest_port_id === from || !(g.size >= 1) || !(Date.parse(g.board_by) > by)) continue;
    heads.set(g.dest_port_id, (heads.get(g.dest_port_id) ?? 0) + g.size);
  }
  return [...heads]
    .sort((a, b) => b[1] - a[1])
    .slice(0, PAX_ONLY_DESTS)
    .map(([d]) => d);
}

/** One voyage the planner chose with passengers counted (a lane taken with fares in it), for the report. Times ISO. */
export interface PaxVoyageRec {
  at: string;
  shipId: string;
  ship: string;
  lane: string;
  /** A passage for fares alone (no cargo). */
  only: boolean;
  dest: string;
  heads: number;
  perHead: number;
  valuePence: number;
  /**
   * What became of it: `sailed` with passengers aboard, `unboarded` (a cargo lane sailed with none of them), `given_up` (a passage for
   * fares alone nobody boarded: not sailed empty), or `planned` (not known yet).
   */
  outcome: "planned" | "sailed" | "unboarded" | "given_up";
}

/** Passenger voyages for the panel and the digest (pence; times ISO). */
export interface PaxVoyagesReport {
  /** The setting in force (`usePassengers` must be on too). */
  enabled: boolean;
  /** Why no fares are counted now (the switches, a key refused offers); null: they are. */
  blocked: string | null;
  /** Lanes chosen with fares counted, passenger-only voyages among them, sailed with passengers, and those given up (nobody boarded). */
  chosen: number;
  only: number;
  sailed: number;
  givenUp: number;
  /** Fares expected on the voyages chosen (planned value), since the records began. */
  expectedPence: number;
  /** Ports whose waiting groups are cached now, and how many groups. */
  portsCached: number;
  groupsCached: number;
  recent: PaxVoyageRec[];
}

/** Counters kept across restarts. */
export interface PaxVoyageStats {
  chosen: number;
  only: number;
  sailed: number;
  givenUp: number;
  expected: number;
}

export function restorePaxVoyages(s: { stats?: Partial<PaxVoyageStats>; recent?: PaxVoyageRec[] } | undefined): { stats: PaxVoyageStats; recent: PaxVoyageRec[] } {
  const stats: PaxVoyageStats = { chosen: 0, only: 0, sailed: 0, givenUp: 0, expected: 0 };
  for (const k of Object.keys(stats) as (keyof PaxVoyageStats)[]) {
    const v = s?.stats?.[k];
    if (typeof v === "number" && Number.isFinite(v)) stats[k] = v;
  }
  const recent = (Array.isArray(s?.recent) ? s!.recent : []).filter((r) => r && typeof r.shipId === "string" && typeof r.lane === "string" && Number.isFinite(r.valuePence)).slice(-PAX_VOYAGES_KEPT);
  return { stats, recent };
}
