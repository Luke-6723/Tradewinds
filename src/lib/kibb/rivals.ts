/**
 * Other companies' ships, as far as we can see them. Every port where we have quay presence (a
 * ship berthed or anchored there, or a Resident Factor) lists the ships that sailed from or arrived
 * at it in the last 24 game hours, and sends a notice as each one does: name, class, owner, where it
 * is bound or came from, and whether it is in ballast, part laden or laden. Nothing else about a
 * rival ship is public (never its cargo, guns, stores or timings).
 *
 * From those sightings: each rival ship's last known movement and an estimated position (along the
 * route to the port it said it was bound for, at its class's speed), and how much rival cargo
 * crosses each sea zone a game day. That traffic is what a letter of marque earns prize money from.
 *
 * Pure functions plus a small store, shared by the fleet autopilot and the dashboard route.
 *
 * Rival intel goes further (setting `rivalIntel`): the public insurance list says which ship of
 * which company (by id) means to sail where with how much cargo declared, when it arrived (the
 * policy closes on arrival) or sank; public convoys give schedules, hull classes and guns; the
 * expansion board's contribution deltas say who delivered how much to which charter; the hourly
 * leaderboard gives net worth, so earning rate. Sources are tied together (company id <-> name,
 * ship id <-> name) only on unambiguous matches.
 */

import type { Catalog, ExpansionTier, LeaderboardResult, RoutePlan, SailingNotice } from "./types";
import type { ConvoyResult, InsurancePolicy, InsuranceStatus } from "./schema";

export type LoadState = "ballast" | "part_laden" | "laden";

export interface Sighting {
  company: string;
  ship: string;
  shipClass: string;
  /** Where it was seen. */
  port: string;
  /** Where it was bound (sailed) or came from (arrived). */
  otherPort: string | null;
  direction: "sailed" | "arrived";
  loadState: LoadState;
  convoy: string | null;
  /** Server time it was seen (ms). */
  at: number;
  /** The policy or convoy voyage this sighting was matched to (`pol:<id>` / `cvy:<convoy>|<ship>`): counted there, not twice. */
  matched?: string;
}

/** What saw a rival: a quay sighting, a public policy, a public convoy. */
export type IntelSource = "quay" | "policy" | "convoy";

export interface RivalShip {
  key: string;
  company: string;
  ship: string;
  shipClass: string;
  /** Null when only a public convoy saw it (a load isn't public there). */
  loadState: LoadState | null;
  seen: { port: string; otherPort: string | null; direction: "sailed" | "arrived" | "insured" | "convoy"; at: number };
  /** The voyage it set out on (or, insured or in a forming convoy, is about to), with estimated times; or null. */
  voyage: {
    from: string;
    to: string;
    departAt: number;
    arriveAt: number;
    legs: Array<[from: string, to: string]>;
    /** Times seen (a sailing notice, a closed policy) rather than estimated. */
    departKnown: boolean;
    arriveKnown: boolean;
  } | null;
  /** In this port as of the sighting, or (estimated) before or after its voyage; null while at sea. */
  inPort: string | null;
  /** What saw it. */
  sources: IntelSource[];
  /** Declared cargo on its latest voyage (pence), and guns (public convoys only), or null. */
  cargo: number | null;
  guns: number | null;
  /** Its latest voyage ended in a sinking or capture. */
  lost: boolean;
}

export interface ZoneTraffic {
  zone: string;
  /** Rival passages through the zone a game day (any load). */
  passages: number;
  /** Laden passages a game day (part laden counts half). */
  laden: number;
  /** Rival cargo crossing a game day, at base prices (pence). */
  cargo: number;
  /**
   * Σ cargo value × game days spent in the zone × gun deterrence, per game day: the prize money a
   * marque there earns scales with this (pence·days).
   */
  exposure: number;
  /** Rival passages already announced for the next game day (policies standing, convoys forming), same units. */
  next: { passages: number; laden: number; exposure: number };
}

/** Another company's voyage policy, as last listed. */
export interface PolicyRec {
  id: string;
  companyId: string;
  shipId: string;
  from: string;
  to: string;
  /** Rebuild quote when written, plus 150 Cr a gun (pence). */
  hull: number;
  /** Declared cargo: the sum insured above the hull (pence; 0 for hull-only cover). */
  cargo: number;
  premiumBps: number;
  coveredBps: number;
  status: InsuranceStatus;
  /** Server ms: written, last changed (closed: arrival or loss), lapses; local ms last listed. */
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  seenAt: number;
  /** Server ms a matched quay sighting saw it sail. */
  sailedAt?: number;
  /** Lifetime already learned. */
  spanned?: boolean;
}

/** Another company's ship in a public convoy. */
export interface ConvoyRec {
  convoyId: string;
  name: string;
  companyId: string;
  shipId: string;
  shipClass: string;
  guns: number;
  from: string;
  to: string;
  /** Server ms: organised, scheduled to sail, estimated to arrive (null: unknown); local ms last listed. */
  createdAt: number;
  departsAt: number;
  arriveAt: number | null;
  seenAt: number;
  /** pending, joined, sailed, arrived or lost. */
  status: string;
  convoyStatus: string;
}

/** Tons a rival delivered to a charter (from the expansion board's deltas, or a notice that named it). */
export interface RivalDelivery {
  /** Null when no single rival can be named. */
  company: string | null;
  port: string;
  good: string;
  tons: number;
  /** Server ms. */
  at: number;
  /** The phase the tier it went to unlocks. */
  phase: number;
}

/**
 * One rival voyage, merged from every source that saw it. Confidence differs: a quay sighting has
 * the exact sailing and destination but a coarse load; a policy has the route and the declared cargo
 * but (until it closes) only an estimated sailing; a public convoy has the schedule, hull and guns.
 */
export interface RivalVoyage {
  key: string;
  sources: IntelSource[];
  /** Name once linked, else `#` + the id's last 6. */
  company: string;
  companyId: string | null;
  ship: string | null;
  shipId: string | null;
  shipClass: string | null;
  guns: number | null;
  from: string;
  to: string;
  load: LoadState | null;
  /** Declared cargo (pence), or null when only a load state (or nothing) is known. */
  cargo: number | null;
  convoy: string | null;
  departAt: number;
  departKnown: boolean;
  arriveAt: number;
  arriveKnown: boolean;
  state: "in_port" | "at_sea" | "arrived" | "lost";
}

/** A policy or convoy voyage as the records give it: the analysis estimates the times they don't. */
export interface IntelVoyage extends Omit<RivalVoyage, "departAt" | "arriveAt" | "departKnown" | "arriveKnown"> {
  shipId: string;
  convoyId: string | null;
  convoyStatus: string | null;
  /** Policy hull value (pence), or null. */
  hull: number | null;
  /** Server ms: written or organised; seen to sail; scheduled to sail; ended (arrival or loss); estimated arrival. */
  listedAt: number;
  sailedAt: number | null;
  departsAt: number | null;
  endedAt: number | null;
  arriveEst: number | null;
  /** Still standing but not listed lately: closed without our noticing how. */
  stale: boolean;
  /** The latest quay sighting matched to it. */
  sighting: Sighting | null;
}

/** A rival ship due at a port, as the planner weighs it. */
export interface RivalLanding {
  at: number;
  /** Where it sails from (the voyage's origin, an arrival's port of departure), if known. */
  from: string | null;
  company: string;
  load: LoadState;
  cargo: number | null;
  hold: number | null;
  source: IntelSource;
}

/** Everything learned from rival intel, saved with the world model. */
export interface RivalIntelSnapshot {
  policies: PolicyRec[];
  convoys: ConvoyRec[];
  deliveries: RivalDelivery[];
  names: Array<[string, string]>;
  evidence: Array<[string, number]>;
  shipNames: Array<[string, { name: string; shipClass: string | null }]>;
  worth: Array<[string, Array<[number, number, number]>]>;
  ownWorth: Array<[number, number, number]>;
  spans: Array<[string, number[]]>;
  homePorts: Array<[string, string]>;
  board: { phase: number; tons: Array<[string, number]>; charters: Array<[string, number]> } | null;
}

/** A pirate hit destroys this share of every stack; the prize court pays half its base value. */
const HIT_LOSS = 0.25;
const PRIZE_OF_SEIZED = 0.5;
/** Assumed cut in interception odds per gun (the formula isn't published; as the planner assumes). */
const GUN_DETERRENCE = 0.5;
/** How full a hold is taken to be for each load state. */
const FILL: Record<LoadState, number> = { ballast: 0, part_laden: 0.45, laden: 0.85 };
/** Laden ships are slower (up to 20% when full). */
const SPEED: Record<LoadState, number> = { ballast: 1, part_laden: 0.91, laden: 0.83 };
/**
 * Sightings kept, in game days: long enough for most voyages to be seen leaving and arriving, so an
 * arrival can be matched to its sailing (ports list only the last day; notices add to that).
 */
const KEEP_GAME_DAYS = 6;
/** Policies, convoy members and deliveries outlive sightings: they make up the rival profiles (game days). */
const INTEL_KEEP_GAME_DAYS = 30;
/** Most records of each kind kept (and saved). */
const INTEL_MAX_RECORDS = 600;
/** A policy's ship waits about a game hour in port for Lloyd's (guide §3.4): its sailing until the lane's closed policies say otherwise. */
const POLICY_WAIT_GAME_MIN = 60;
/** A standing policy whose ship we never saw sail is taken to land no sooner than this (game minutes). */
const MIN_LEFT_GAME_MIN = 10;
/** A listed record not seen again for this long (real ms) has closed without our noticing how: no longer counted as landing. */
const STALE_RECORD_MS = 5 * 60_000;
/** A rival that landed this recently (game minutes) may still deliver. */
export const RECENT_LANDING_GAME_MIN = 60;
/** Policy lifetimes (written -> closed on arrival) kept per lane. */
const SPAN_SAMPLES = 20;
/** A quote and a policy's hull value agree within this (quotes drift with material prices). */
const HULL_MATCH = 0.12;
/** Sightings and policies or convoys are the same movement within this (real ms; the port list and notices differ a little). */
const MATCH_SLACK_MS = 3 * 60_000;
/** Points before a company id is taken to be a name (and at least twice any other name's). */
const LINK_EVIDENCE = 3;
/** Company id <-> name pairings kept, and observations remembered so one isn't counted twice. */
const EVIDENCE_KEYS = 200;
const COUNTED_KEYS = 1_000;
/**
 * Odds a laden rival delivers a given good where it lands (estimates): it delivered that good there
 * lately; its declared cargo is about what a hold of the good is worth; it is worth far more (something
 * dearer); only its load state is known.
 */
const ODDS_FED = 0.8;
const ODDS_FITS = 0.5;
const ODDS_MISFIT = 0.1;
export const ODDS_UNKNOWN = 0.25;
/** Hold assumed for a rival whose class isn't known (t). */
const DEFAULT_HOLD_T = 90;
/** Hourly leaderboard refreshes kept per company. */
const WORTH_SAMPLES = 48;
/** A zone's marques are capped at this in total (bps); its patrols too. */
export const ZONE_MARQUE_CAP = 5_000;
/** Pirates go for the richest prizes: a cargo worth this (pence) draws the zone's raw piracy; richer more, cheaper less, empty almost none (estimates). */
const ATTENTION_REF_PENCE = 1_000_000;
const ATTENTION_MIN = 0.1;
const ATTENTION_MAX = 3;

/** How much more (or less) than a zone's raw piracy a passage carrying `cargoValue` (pence) draws. */
export function pirateAttention(cargoValue: number): number {
  return cargoValue <= 0 ? ATTENTION_MIN : Math.min(ATTENTION_MAX, Math.max(ATTENTION_MIN, Math.sqrt(cargoValue / ATTENTION_REF_PENCE)));
}

const spanKey = (from: string, to: string, cargo: boolean) => `${from}>${to}|${cargo ? "cargo" : "hull"}`;

/** Drops the entries `age` says are oldest until at most `max` are left. */
function trimOldest<V>(map: Map<string, V>, max: number, age: (v: V) => number): void {
  if (map.size <= max) return;
  for (const [k] of [...map].sort((a, b) => age(a[1]) - age(b[1])).slice(0, map.size - max)) map.delete(k);
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

// ── Store ─────────────────────────────────────────────────────────────────────

export class RivalTracker {
  private readonly seen = new Map<string, Sighting>();
  /** Names of the player's own companies: their ships are not rivals. */
  readonly ours = new Set<string>();
  /** Our player's company ids: their policies and convoy ships are not rivals'. */
  readonly ourIds = new Set<string>();
  /**
   * This company's own name among `ours` (the autopilot sets it; null: all of `ours` count as one). The others are
   * our sibling companies: the server counts their deliveries as another company's (observeExpansion).
   */
  self: string | null = null;
  private readonly policies = new Map<string, PolicyRec>();
  /** Policies by lane (`from>to`), rebuilt after the list changes: every sighting is matched against it. */
  private byLane: Map<string, PolicyRec[]> | null = null;
  private readonly convoyShips = new Map<string, ConvoyRec>();
  private deliveries: RivalDelivery[] = [];
  /** Named rival deliveries by `company|port|good` ([server ms, tons]): read per landing per plan. */
  private readonly feeds = new Map<string, Array<[number, number]>>();
  /** Company id -> name once linked; points for each `id|name` pairing, and the observations already counted. */
  readonly names = new Map<string, string>();
  private readonly evidence = new Map<string, number>();
  private readonly counted = new Set<string>();
  private readonly shipNames = new Map<string, { name: string; shipClass: string | null }>();
  /** [server ms, net worth, rank] per leaderboard refresh, by company name; ours apart. */
  private readonly worth = new Map<string, Array<[number, number, number]>>();
  ownWorth: Array<[number, number, number]> = [];
  /** Real ms from written to closed on arrival, by `from>to|cargo|hull`. */
  private readonly spans = new Map<string, number[]>();
  /** Home ports from the leaderboard, by company name. */
  readonly homePorts = new Map<string, string>();
  /** The expansion board at the last look: contributor tons by company, delivered totals by `port|good`. */
  private board: { phase: number; tons: Map<string, number>; charters: Map<string, number> } | null = null;

  /** `unit`: a good's base value per ton (ties a delivery to the policy that carried it). */
  constructor(private readonly unit?: (good: string) => number) {}

  /** `authoritative`: the port's sailing list, whose class and load state beat an event's guesses. */
  add(s: Sighting, authoritative = false): void {
    if (!s.company || !s.ship || this.ours.has(s.company) || !Number.isFinite(s.at)) return;
    // The port list and the live notice report the same movement at slightly different times.
    const base = `${s.company}|${s.ship}|${s.port}|${s.direction}`;
    for (const [k, prev] of this.seen) {
      if (k.startsWith(`${base}|`) && Math.abs(prev.at - s.at) < 3 * 60_000) {
        const merged = { ...prev, otherPort: prev.otherPort ?? s.otherPort, convoy: prev.convoy ?? s.convoy };
        if (authoritative || !prev.shipClass) merged.shipClass = s.shipClass || prev.shipClass;
        if (authoritative) merged.loadState = s.loadState;
        this.seen.set(k, merged);
        this.matchSighting(merged);
        return;
      }
    }
    // A copy: matching marks it, and the caller's may be another tracker's.
    const own = { ...s };
    this.seen.set(`${base}|${s.at}`, own);
    this.matchSighting(own);
  }

  addNotices(list: SailingNotice[] | null | undefined): void {
    for (const n of list ?? []) {
      this.add({
        company: n.company_name,
        ship: n.ship_name,
        shipClass: n.ship_class,
        port: n.port_id,
        otherPort: n.other_port_id ?? null,
        direction: n.direction,
        loadState: n.load_state,
        convoy: n.convoy_name ?? null,
        at: Date.parse(n.seen_at),
      }, true);
    }
  }

  /** A port-scoped `ship_sailed` / `ship_entered_port` event (its payload isn't documented: read defensively). */
  addEvent(type: string, portId: string | null | undefined, payload: unknown, timestamp: string): void {
    if (!portId || (type !== "ship_sailed" && type !== "ship_entered_port")) return;
    const p = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
    const str = (...keys: string[]) => {
      for (const k of keys) if (typeof p[k] === "string" && p[k]) return p[k] as string;
      return null;
    };
    const sailed = type === "ship_sailed";
    const load = str("load_state");
    this.add({
      company: str("company_name", "owner_name", "company") ?? "",
      ship: str("ship_name", "name") ?? "",
      shipClass: str("ship_class", "class") ?? "",
      port: portId,
      otherPort: sailed
        ? str("other_port_id", "bound_for_port_id", "dest_port_id", "to_port_id", "destination_port_id")
        : str("other_port_id", "came_from_port_id", "from_port_id", "origin_port_id"),
      direction: sailed ? "sailed" : "arrived",
      loadState: load === "laden" || load === "part_laden" ? load : "ballast",
      convoy: str("convoy_name"),
      at: Date.parse(timestamp),
    });
  }

  /**
   * Other companies' policies from the public list: which ship means to sail where with how much
   * cargo declared; closed `settled_safe` on arrival (its last change is then the arrival),
   * `claimed_loss` when it sank, `cancelled` if it sailed elsewhere or lapsed.
   */
  addPolicies(list: InsurancePolicy[]): void {
    const at = Date.now();
    // Oldest first (lists come newest first), so the map holds them in about the order they were written.
    for (const p of [...list].reverse()) {
      if (this.ourIds.has(p.insured_company_id)) continue;
      const createdAt = Date.parse(p.created_at);
      const updatedAt = Date.parse(p.updated_at);
      if (!Number.isFinite(createdAt) || !Number.isFinite(updatedAt)) continue;
      const prev = this.policies.get(p.id);
      // A list fetched before a newer one (the underwriter's and the rival check's interleave): keep the newer.
      if (prev && prev.updatedAt > updatedAt) {
        prev.seenAt = at;
        continue;
      }
      const expiresAt = Date.parse(p.expires_at);
      const rec: PolicyRec = {
        ...prev,
        id: p.id,
        companyId: p.insured_company_id,
        shipId: p.ship_id,
        from: p.origin_port_id,
        to: p.dest_port_id,
        hull: p.hull_value_pence,
        cargo: Math.max(0, p.insured_value_pence - p.hull_value_pence),
        premiumBps: p.premium_bps,
        coveredBps: p.covered_bps,
        status: p.status,
        createdAt,
        updatedAt,
        expiresAt: Number.isFinite(expiresAt) ? expiresAt : createdAt + 6 * 3_600_000,
        seenAt: at,
      };
      this.policies.set(p.id, rec);
      if (rec.status === "settled_safe" && !rec.spanned && updatedAt > createdAt) {
        rec.spanned = true;
        const k = spanKey(rec.from, rec.to, rec.cargo > 0);
        this.spans.set(k, [...(this.spans.get(k) ?? []), updatedAt - createdAt].slice(-SPAN_SAMPLES));
      }
    }
    this.byLane = null;
    this.rematch();
  }

  /** How long policies on this lane lived, written -> arrival (median real ms), or null. */
  span(from: string, to: string, cargo: boolean): number | null {
    const s = this.spans.get(spanKey(from, to, cargo));
    return s?.length ? median(s) : null;
  }

  /** Other companies' ships in public convoys (schedule, hull class, guns); ties convoy names seen on the quay to company ids. */
  addConvoys(list: ConvoyResult[]): void {
    const at = Date.now();
    for (const r of list) {
      const c = r.convoy;
      const departsAt = Date.parse(c.departs_at);
      if (!Number.isFinite(departsAt)) continue;
      const createdAt = Date.parse(c.created_at);
      const eta = Date.parse(r.voyage?.estimated_arrival_at ?? "");
      for (const m of r.members ?? []) {
        if (this.ourIds.has(m.company_id)) continue;
        this.convoyShips.set(`${c.id}|${m.ship_id}`, {
          convoyId: c.id,
          name: c.name,
          companyId: m.company_id,
          shipId: m.ship_id,
          shipClass: m.ship_class,
          guns: m.cannons_count,
          from: c.origin_port_id,
          to: c.dest_port_id,
          createdAt: Number.isFinite(createdAt) ? createdAt : departsAt,
          departsAt,
          arriveAt: Number.isFinite(eta) ? eta : null,
          seenAt: at,
          status: m.status,
          convoyStatus: c.status,
        });
        // A class with no name yet: `display` treats "" as unnamed.
        this.shipNames.set(m.ship_id, { name: this.shipNames.get(m.ship_id)?.name ?? "", shipClass: m.ship_class });
      }
    }
    this.rematch();
  }

  /** Sightings that matched nothing so far may match now (new records, or a name or class now known). */
  private rematch(): void {
    for (const s of this.seen.values()) if (!s.matched && s.otherPort) this.matchSighting(s);
  }

  private lanes(): Map<string, PolicyRec[]> {
    if (!this.byLane) {
      this.byLane = new Map();
      for (const p of this.policies.values()) {
        const k = `${p.from}>${p.to}`;
        const list = this.byLane.get(k);
        if (list) list.push(p);
        else this.byLane.set(k, [p]);
      }
    }
    return this.byLane;
  }

  /**
   * Ties a quay sighting to the policy or convoy voyage it shows: the same ports, while that voyage
   * stood (convoy: its name, near its departure), by a company and ship not known to be someone else.
   * One candidate only. It names the ship, fixes the sailing (or arrival) time, and counts towards the
   * company's name: certain for a convoy whose rival members are all one company's. Several candidates
   * of one company (its ships sailing together, none named yet): it counts on one of them, nothing learned.
   */
  private matchSighting(s: Sighting): void {
    if (s.matched || !s.otherPort) return;
    const [from, to] = s.direction === "sailed" ? [s.port, s.otherPort] : [s.otherPort, s.port];
    const free = (companyId: string, shipId: string) => {
      const n = this.names.get(companyId);
      const sh = this.shipNames.get(shipId);
      return (!n || n === s.company) && (!sh?.name || sh.name === s.ship) && (!sh?.shipClass || !s.shipClass || sh.shipClass === s.shipClass);
    };
    // The sighting is one of these (one company's, its name not known to be another's): it counts on one
    // not already holding such a sighting, not again on the quay. All held: likely another voyage, so it
    // stays on the quay. Which ship stays unknown: nothing named, no evidence, no sailing time.
    const anyOf = (cands: Array<{ companyId: string; ref: string }>): string | null => {
      if (!cands.length || cands.some((c) => c.companyId !== cands[0].companyId)) return null;
      for (const [id, n] of this.names) if (n === s.company && id !== cands[0].companyId) return null;
      const taken = new Set<string>();
      for (const o of this.seen.values()) if (o !== s && o.matched && o.direction === s.direction) taken.add(o.matched);
      return cands.find((c) => !taken.has(c.ref))?.ref ?? null;
    };
    let inConvoy: Array<{ companyId: string; shipId: string; ref: string }> = [];
    let waiting = false;
    if (s.convoy && s.direction === "sailed" && this.convoyShips.size) {
      const near = [...this.convoyShips.values()].filter((c) => c.name === s.convoy && c.from === from && Math.abs(c.departsAt - s.at) <= MATCH_SLACK_MS);
      // Ships join a forming convoy unseen (only its parties are told): only a listing made after it sailed has every member.
      const members = near.filter((c) => c.convoyStatus === "sailing" || c.convoyStatus === "completed");
      // Listed only while forming: the next look at sailing convoys says which ship this is (rematch).
      waiting = near.length > 0 && !members.length;
      const firms = new Set(members.map((m) => m.companyId));
      if (firms.size === 1 && members.length) this.addEvidence(members[0].companyId, s.company, LINK_EVIDENCE, `cvy:${members[0].convoyId}`);
      const mine = members.filter((m) => free(m.companyId, m.shipId) && (!s.shipClass || m.shipClass === s.shipClass));
      if (mine.length === 1) {
        s.matched = `cvy:${mine[0].convoyId}|${mine[0].shipId}`;
        this.nameShip(mine[0].shipId, s);
        return;
      }
      inConvoy = mine.map((m) => ({ companyId: m.companyId, shipId: m.shipId, ref: `cvy:${m.convoyId}|${m.shipId}` }));
    }
    const fits = (this.lanes().get(`${from}>${to}`) ?? []).filter((p) => {
      if (p.status === "cancelled" || !free(p.companyId, p.shipId)) return false;
      const closed = p.status === "settled_safe" || p.status === "claimed_loss";
      return s.direction === "sailed"
        ? s.at >= p.createdAt - MATCH_SLACK_MS && s.at <= (closed ? p.updatedAt : p.expiresAt)
        : p.status === "settled_safe" && Math.abs(s.at - p.updatedAt) <= MATCH_SLACK_MS;
    });
    if (fits.length !== 1) {
      // The convoy's members are the closer match (name, departure, class); its insured ones are the same
      // voyages as their policies, so they go by the policy's ref: one form per voyage for `taken`.
      const members = inConvoy.map((m) => {
        const p = fits.find((x) => x.shipId === m.shipId);
        return { companyId: m.companyId, ref: p ? `pol:${p.id}` : m.ref };
      });
      const ref = waiting ? null : (anyOf(members) ?? anyOf(fits.map((p) => ({ companyId: p.companyId, ref: `pol:${p.id}` }))));
      if (ref) s.matched = ref;
      return;
    }
    const p = fits[0];
    s.matched = `pol:${p.id}`;
    if (s.direction === "sailed") p.sailedAt = s.at;
    this.nameShip(p.shipId, s);
    this.addEvidence(p.companyId, s.company, 2, `pol:${p.id}`);
  }

  private nameShip(id: string, s: Sighting): void {
    const prev = this.shipNames.get(id);
    this.shipNames.set(id, { name: s.ship, shipClass: s.shipClass || prev?.shipClass || null });
  }

  /**
   * Points for company id `id` being `name`, once per observation (`obs`). Linked once the pairing has
   * LINK_EVIDENCE points and at least twice any other name's for that id; a name belongs to one id.
   */
  private addEvidence(id: string, name: string, pts: number, obs: string): void {
    if (!name || this.ours.has(name) || this.ourIds.has(id)) return;
    const once = `${obs}|${id}|${name}`;
    if (this.counted.has(once)) return;
    this.counted.add(once);
    if (this.counted.size > COUNTED_KEYS) this.counted.delete(this.counted.values().next().value!);
    const k = `${id}|${name}`;
    const total = (this.evidence.get(k) ?? 0) + pts;
    // Re-inserted, so the pairings dropped first are the ones not seen for longest.
    this.evidence.delete(k);
    this.evidence.set(k, total);
    while (this.evidence.size > EVIDENCE_KEYS) this.evidence.delete(this.evidence.keys().next().value!);
    let other = 0;
    for (const [key, v] of this.evidence) if (key !== k && key.startsWith(`${id}|`)) other = Math.max(other, v);
    if (total < LINK_EVIDENCE || total < 2 * other) return;
    for (const [i, n] of [...this.names]) {
      if (n !== name || i === id) continue;
      if ((this.evidence.get(`${i}|${name}`) ?? 0) >= total) return;
      this.names.delete(i);
    }
    this.names.set(id, name);
  }

  /** The name a company id goes by: linked, or `#` + its last 6. */
  display(companyId: string): string {
    return this.names.get(companyId) ?? `#${companyId.slice(-6)}`;
  }

  /**
   * The public contribution board: rival tons per charter (`port|good`) since the last look, its
   * delivered total's growth less our own share of it (`ours`: how much of a charter's growth was our
   * deliveries). Named when exactly one rival's tier contribution grew, by just those tons. Without
   * our own delivery record (the dashboard), or with more of ours on the board than it accounts for
   * (a restart), an interval we delivered in can't be split. A sibling company's tons (`self` set) stay
   * in what is returned, since the server counts them as another company's (they end a stall), but an
   * interval one delivered in isn't put on the rival record: it can't be split from a rival's by charter.
   */
  observeExpansion(tier: ExpansionTier | null, now: number, ours?: (key: string, delta: number) => number): Map<string, number> {
    const out = new Map<string, number>();
    if (!tier?.contributors) {
      this.board = null;
      return out;
    }
    const tons = new Map(tier.contributors.map((c) => [c.company_name, c.tons]));
    const totals = new Map(tier.charters.map((c) => [`${c.port_id}|${c.commodity_id}`, c.tons_delivered_total ?? c.quantity_delivered]));
    const prev = this.board;
    this.board = { phase: tier.target_phase, tons, charters: totals };
    // Until our own names are known (start-up), our tons can't be told from theirs.
    if (!prev || prev.phase !== tier.target_phase || !this.ours.size) return out;
    const growth = (n: string) => Math.max(0, (tons.get(n) ?? 0) - (prev.tons.get(n) ?? 0));
    const grew = [...tons.keys()].filter((n) => !this.ours.has(n) && growth(n) > 0);
    // Only this company's own growth is in our delivery record; a sibling's is the server's "another company".
    const own = (name: string) => this.self === null || name === this.self;
    const ourGrowth = [...this.ours].filter(own).reduce((n, name) => n + growth(name), 0);
    const siblingGrowth = [...this.ours].filter((name) => !own(name)).reduce((n, name) => n + growth(name), 0);
    let accounted = 0;
    let rivalSum = 0;
    for (const [key, total] of totals) {
      const before = prev.charters.get(key);
      if (before === undefined || total <= before) continue; // new, or a count that restarted at a re-post
      const mine = Math.min(total - before, ours?.(key, total - before) ?? 0);
      accounted += mine;
      if (total - before - mine <= 0) continue;
      out.set(key, total - before - mine);
      rivalSum += total - before - mine;
    }
    if (ourGrowth > accounted + 0.5) return new Map();
    if (siblingGrowth > 0.5) return out;
    const named = grew.length === 1 && Math.abs(growth(grew[0]) - rivalSum) <= 0.5 ? grew[0] : null;
    for (const [key, t] of out) {
      const [port, good] = key.split("|");
      this.addDelivery({ company: named, port, good, tons: t, at: now, phase: tier.target_phase });
    }
    return out;
  }

  /** A rival delivery (the board, or a notice that named it); the same one seen both ways counts once, named. */
  addDelivery(d: RivalDelivery): void {
    if ((d.company !== null && this.ours.has(d.company)) || !(d.tons > 0) || !Number.isFinite(d.at)) return;
    const twin = this.deliveries.find(
      (x) => x.port === d.port && x.good === d.good && x.tons === d.tons && Math.abs(x.at - d.at) < MATCH_SLACK_MS && (x.company === null || d.company === null || x.company === d.company),
    );
    if (twin) {
      if (twin.company === null && d.company !== null) {
        twin.company = d.company;
        this.noteFeed(twin, d.company);
      }
      return;
    }
    this.deliveries.push({ ...d });
    if (d.company !== null) this.noteFeed(d, d.company);
  }

  /** A named delivery: indexed for `fed`, and the policy that likely carried it points to the company's name. */
  private noteFeed(d: RivalDelivery, company: string): void {
    const k = `${company}|${d.port}|${d.good}`;
    this.feeds.set(k, [...(this.feeds.get(k) ?? []), [d.at, d.tons]]);
    // Closed on arrival there just before, its cargo worth about these tons.
    const unit = this.unit?.(d.good) ?? 0;
    if (!(unit > 0)) return;
    const value = d.tons * unit;
    const fits = [...this.policies.values()].filter(
      (p) => p.to === d.port && p.status === "settled_safe" && d.at - p.updatedAt >= 0 && d.at - p.updatedAt <= 2 * MATCH_SLACK_MS && Math.abs(p.cargo - value) <= 0.35 * value,
    );
    if (fits.length === 1) this.addEvidence(fits[0].companyId, company, 1, `dlv:${fits[0].id}`);
  }

  private reindexFeeds(): void {
    this.feeds.clear();
    for (const d of this.deliveries) {
      if (d.company === null) continue;
      const k = `${d.company}|${d.port}|${d.good}`;
      this.feeds.set(k, [...(this.feeds.get(k) ?? []), [d.at, d.tons]]);
    }
  }

  /** Tons this company delivered of `good` at `port` since `since` (server ms). */
  fed(company: string, port: string, good: string, since: number): number {
    let n = 0;
    for (const [at, t] of this.feeds.get(`${company}|${port}|${good}`) ?? []) if (at >= since) n += t;
    return n;
  }

  /** Rival deliveries seen into the tier unlocking `phase` (null: any), newest first. */
  deliveriesSeen(phase: number | null, limit = 20): RivalDelivery[] {
    return this.deliveries
      .filter((d) => phase === null || d.phase === phase)
      .sort((a, b) => b.at - a.at)
      .slice(0, limit);
  }

  /** Net worth at each hourly refresh (hulls count at build value, so building is about neutral): its slope is what a company earns. */
  observeLeaderboard(lb: LeaderboardResult): void {
    const at = Date.parse(lb.refreshed_at ?? "");
    if (!Number.isFinite(at)) return;
    const push = (list: Array<[number, number, number]>, worth: number, rank: number) => {
      if (!list.length || list[list.length - 1][0] < at) list.push([at, worth, rank]);
      if (list.length > WORTH_SAMPLES) list.shift();
    };
    for (const e of lb.entries ?? []) {
      if (this.ours.has(e.company_name)) continue;
      const list = this.worth.get(e.company_name) ?? [];
      push(list, e.net_worth_pence, e.rank);
      this.worth.set(e.company_name, list);
      if (e.home_port_id) this.homePorts.set(e.company_name, e.home_port_id);
    }
    if (lb.you) push(this.ownWorth, lb.you.net_worth_pence, lb.you.rank);
  }

  /** Net worth gained per real hour: the median of the last (up to) six hourly changes, so a bonus payout is one jump, not a trend. Null: ours. */
  earnRate(company: string | null): number | null {
    const list = company === null ? this.ownWorth : (this.worth.get(company) ?? []);
    const rates: number[] = [];
    for (let i = Math.max(1, list.length - 6); i < list.length; i++) {
      const dt = list[i][0] - list[i - 1][0];
      if (dt > 0) rates.push(((list[i][1] - list[i - 1][1]) * 3_600_000) / dt);
    }
    return rates.length ? median(rates) : null;
  }

  /** A company's net worth and rank at the latest leaderboard it was on. */
  standing(company: string): { worth: number; rank: number; at: number } | null {
    const last = this.worth.get(company)?.at(-1);
    return last ? { at: last[0], worth: last[1], rank: last[2] } : null;
  }

  /** Companies on the latest leaderboard seen (ours aside). */
  leaders(): string[] {
    let latest = -Infinity;
    for (const list of this.worth.values()) latest = Math.max(latest, list.at(-1)?.[0] ?? -Infinity);
    return [...this.worth].filter(([, list]) => list.at(-1)?.[0] === latest).map(([n]) => n);
  }

  /**
   * An insured company's public record on a lane and cover band: policies closed, sinkings among
   * them (claimed_loss; partial losses never show), and the last premium someone covered (bps, server ms).
   */
  policyRecord(companyId: string, from: string, to: string, cargo: boolean): { closed: number; losses: number; lastCovered: { bps: number; at: number } | null } {
    let closed = 0;
    let losses = 0;
    let lastCovered: { bps: number; at: number } | null = null;
    for (const p of this.policies.values()) {
      if (p.companyId !== companyId || p.from !== from || p.to !== to || p.cargo > 0 !== cargo) continue;
      if (p.status === "settled_safe" || p.status === "claimed_loss") closed++;
      if (p.status === "claimed_loss") losses++;
      if (p.coveredBps > 0 && (!lastCovered || p.createdAt > lastCovered.at)) lastCovered = { bps: p.premiumBps, at: p.createdAt };
    }
    return { closed, losses, lastCovered };
  }

  /** Whether the policy or convoy voyage a sighting was matched to is still held. */
  knows(ref: string): boolean {
    return ref.startsWith("pol:") ? this.policies.has(ref.slice(4)) : ref.startsWith("cvy:") && this.convoyShips.has(ref.slice(4));
  }

  /** Rival records held: policies, convoy ships, deliveries. */
  counts(): { policies: number; convoys: number; deliveries: number } {
    return { policies: this.policies.size, convoys: this.convoyShips.size, deliveries: this.deliveries.length };
  }

  /**
   * The voyages policies and public convoys describe, merged per ship and passage (a convoy member
   * insured for the same passage is one voyage), with matched sightings folded in. Times the
   * records don't give are left null for the analysis (it has the routes).
   */
  intelVoyages(): IntelVoyage[] {
    const now = Date.now();
    const bySight = new Map<string, Sighting>();
    for (const s of this.seen.values()) {
      if (!s.matched) continue;
      const prev = bySight.get(s.matched);
      if (!prev || s.at > prev.at) bySight.set(s.matched, s);
    }
    const byShip = new Map<string, ConvoyRec[]>();
    for (const c of this.convoyShips.values()) if (c.convoyStatus !== "cancelled") byShip.set(c.shipId, [...(byShip.get(c.shipId) ?? []), c]);
    const merged = new Set<ConvoyRec>();
    const out: IntelVoyage[] = [];
    const sources = (...xs: Array<IntelSource | false>) => xs.filter((x): x is IntelSource => !!x);
    for (const p of this.policies.values()) {
      if (p.status === "cancelled") continue;
      const cvy = byShip.get(p.shipId)?.find((c) => c.from === p.from && c.to === p.to && c.departsAt >= p.createdAt - MATCH_SLACK_MS && c.departsAt <= p.expiresAt);
      if (cvy) merged.add(cvy);
      const sight = bySight.get(`pol:${p.id}`) ?? (cvy ? bySight.get(`cvy:${cvy.convoyId}|${cvy.shipId}`) : undefined) ?? null;
      const named = this.shipNames.get(p.shipId);
      const cvySailed = !!cvy && (cvy.status === "sailed" || cvy.convoyStatus === "sailing");
      const sailedAt = p.sailedAt ?? (cvySailed ? cvy!.departsAt : null);
      out.push({
        key: `pol:${p.id}`,
        sources: sources("policy", !!cvy && "convoy", !!sight && "quay"),
        company: this.display(p.companyId),
        companyId: p.companyId,
        ship: named?.name || null,
        shipId: p.shipId,
        shipClass: cvy?.shipClass ?? named?.shipClass ?? (sight?.shipClass || null),
        guns: cvy?.guns ?? null,
        from: p.from,
        to: p.to,
        // A hull-only policy goes with a ballast leg (data: they were the empty returns).
        load: sight?.loadState ?? (p.cargo > 0 ? "laden" : "ballast"),
        cargo: p.cargo,
        convoy: cvy?.name ?? sight?.convoy ?? null,
        convoyId: cvy?.convoyId ?? null,
        convoyStatus: cvy?.convoyStatus ?? null,
        hull: p.hull,
        listedAt: p.createdAt,
        sailedAt,
        departsAt: cvy?.departsAt ?? null,
        endedAt: p.status === "settled_safe" || p.status === "claimed_loss" ? p.updatedAt : null,
        arriveEst: cvy?.arriveAt ?? null,
        state: p.status === "settled_safe" ? "arrived" : p.status === "claimed_loss" || cvy?.status === "lost" ? "lost" : sailedAt !== null ? "at_sea" : "in_port",
        stale: (p.status === "open" || p.status === "active") && now - p.seenAt > STALE_RECORD_MS,
        sighting: sight,
      });
    }
    for (const c of this.convoyShips.values()) {
      if (merged.has(c) || c.convoyStatus === "cancelled") continue;
      const sight = bySight.get(`cvy:${c.convoyId}|${c.shipId}`) ?? null;
      const named = this.shipNames.get(c.shipId);
      const arrived = c.status === "arrived" || c.convoyStatus === "completed";
      const sailed = c.status === "sailed" || c.convoyStatus === "sailing";
      const state = c.status === "lost" ? "lost" : arrived ? "arrived" : sailed ? "at_sea" : "in_port";
      out.push({
        key: `cvy:${c.convoyId}|${c.shipId}`,
        sources: sources("convoy", !!sight && "quay"),
        company: this.display(c.companyId),
        companyId: c.companyId,
        ship: named?.name || null,
        shipId: c.shipId,
        shipClass: c.shipClass,
        guns: c.guns,
        from: c.from,
        to: c.to,
        load: sight?.loadState ?? null,
        cargo: null,
        convoy: c.name,
        convoyId: c.convoyId,
        convoyStatus: c.convoyStatus,
        hull: null,
        listedAt: c.createdAt,
        sailedAt: sight?.direction === "sailed" ? sight.at : sailed || arrived ? c.departsAt : null,
        departsAt: c.departsAt,
        endedAt: arrived ? c.arriveAt : null,
        arriveEst: c.arriveAt,
        state,
        stale: (c.convoyStatus === "forming" || c.convoyStatus === "sailing") && state !== "lost" && now - c.seenAt > STALE_RECORD_MS,
        sighting: sight,
      });
    }
    return out;
  }

  prune(now: number, gameMinuteMs: number): void {
    const keep = KEEP_GAME_DAYS * 24 * 60 * gameMinuteMs;
    for (const [k, s] of this.seen) if (now - s.at > keep) this.seen.delete(k);
    const intel = INTEL_KEEP_GAME_DAYS * 24 * 60 * gameMinuteMs;
    for (const [k, p] of this.policies) if (now - p.updatedAt > intel || (p.status === "open" && now > p.expiresAt + intel)) this.policies.delete(k);
    for (const [k, c] of this.convoyShips) if (now - c.departsAt > intel) this.convoyShips.delete(k);
    trimOldest(this.policies, INTEL_MAX_RECORDS, (p) => p.updatedAt);
    trimOldest(this.convoyShips, INTEL_MAX_RECORDS, (c) => c.departsAt);
    while (this.shipNames.size > INTEL_MAX_RECORDS) this.shipNames.delete(this.shipNames.keys().next().value!);
    this.deliveries = this.deliveries.filter((d) => now - d.at <= intel).slice(-INTEL_MAX_RECORDS);
    for (const [k, list] of this.worth) if (now - (list.at(-1)?.[0] ?? 0) > intel) this.worth.delete(k);
    this.byLane = null;
    this.reindexFeeds();
  }

  all(): Sighting[] {
    return [...this.seen.values()];
  }

  snapshot(): RivalIntelSnapshot {
    return {
      policies: [...this.policies.values()],
      convoys: [...this.convoyShips.values()],
      deliveries: [...this.deliveries],
      names: [...this.names],
      evidence: [...this.evidence],
      shipNames: [...this.shipNames],
      worth: [...this.worth],
      ownWorth: [...this.ownWorth],
      spans: [...this.spans],
      homePorts: [...this.homePorts],
      board: this.board ? { phase: this.board.phase, tons: [...this.board.tons], charters: [...this.board.charters] } : null,
    };
  }

  /** Picks up a snapshot (older saves lack fields; every one is optional). Never touches `ours` or `ourIds`. */
  restore(s: Partial<RivalIntelSnapshot>): void {
    for (const p of s.policies ?? []) if (p?.id) this.policies.set(p.id, { ...p });
    for (const c of s.convoys ?? []) if (c?.convoyId) this.convoyShips.set(`${c.convoyId}|${c.shipId}`, { ...c });
    this.deliveries = (s.deliveries ?? []).filter((d) => d && d.tons > 0).map((d) => ({ ...d, company: d.company ?? null, phase: d.phase ?? 0 })).slice(-INTEL_MAX_RECORDS);
    for (const [k, v] of s.names ?? []) this.names.set(k, v);
    for (const [k, v] of s.evidence ?? []) this.evidence.set(k, v);
    for (const [k, v] of s.shipNames ?? []) this.shipNames.set(k, { ...v });
    for (const [k, v] of s.worth ?? []) this.worth.set(k, [...v].slice(-WORTH_SAMPLES));
    this.ownWorth = [...(s.ownWorth ?? [])].slice(-WORTH_SAMPLES);
    for (const [k, v] of s.spans ?? []) this.spans.set(k, [...v].slice(-SPAN_SAMPLES));
    for (const [k, v] of s.homePorts ?? []) this.homePorts.set(k, v);
    const b = s.board;
    this.board = b ? { phase: b.phase, tons: new Map(b.tons ?? []), charters: new Map((b.charters ?? []).filter(([, v]) => typeof v === "number")) } : null;
    this.byLane = null;
    this.reindexFeeds();
  }
}

// ── Analysis ──────────────────────────────────────────────────────────────────

export interface RivalDeps {
  catalog: Catalog;
  route: (from: string, to: string, shipClass: string) => Promise<RoutePlan | null>;
  /** Server time now (ms). */
  now: number;
  gameMinuteMs: number;
  /** Net piracy per zone (bps), to cap a leg's interception odds at one hit. */
  piracy?: Map<string, number>;
  /** Use policies and public convoys (the `rivalIntel` setting); off: quay sightings only, exactly as before. */
  intel?: boolean;
  /** Cheapest turnkey quote seen per hull class (pence): tells a policy's hull class from its hull value. */
  quotes?: Map<string, number>;
}

export interface RivalAnalysis {
  ships: RivalShip[];
  zones: ZoneTraffic[];
  windowGameHours: number;
  /** Rival ships due at each port (any load), from every source. */
  landings: Array<[port: string, RivalLanding[]]>;
  /** Voyages from policies and public convoys, with estimated times (profiles, dashboard). */
  voyages: RivalVoyage[];
}

/** Base value per ton of what a port ships out: the average of the goods it makes. */
function valuePerTon(catalog: Catalog, port: string): number {
  const p = catalog.ports.find((x) => x.id === port);
  const goods = [...(p?.produces ?? []), ...(p?.manufactures ?? [])];
  const prices = goods.map((g) => catalog.commodities.find((c) => c.id === g)?.base_price_pence ?? 0).filter((x) => x > 0);
  if (prices.length) return prices.reduce((n, x) => n + x, 0) / prices.length;
  const all = catalog.commodities.map((c) => c.base_price_pence).sort((a, b) => a - b);
  return all[Math.floor(all.length / 2)] ?? 20_000;
}

/** The sea zone a leg's hazards roll for: the zone it ends in, or the arrival port's own zone. */
function zoneOf(catalog: Catalog, node: string): string | null {
  if (catalog.sea_zones.some((z) => z.id === node)) return node;
  return catalog.ports.find((p) => p.id === node)?.sea_zone_id ?? null;
}

/** Game days spent in each zone on a route, at `knots`. */
export function zoneDays(catalog: Catalog, plan: { legs: Array<{ to_node: string; distance_nm: number }> }, knots: number): Map<string, number> {
  const out = new Map<string, number>();
  for (const l of plan.legs) {
    const z = zoneOf(catalog, l.to_node);
    if (z) out.set(z, (out.get(z) ?? 0) + l.distance_nm / Math.max(knots, 0.1) / 24);
  }
  return out;
}

/**
 * The class a policy's hull value points to: that value is the class's cheapest turnkey rebuild quote
 * plus 150 Cr a gun, so the class whose quote (`quotes`: cheapest seen per class) sits at or just
 * under it. Null without a quote near it, or when two classes fit about as well (cutter and collier
 * cost alike).
 */
export function classOfHull(hull: number, quotes: Map<string, number>, catalog: Catalog): string | null {
  const fits: Array<[string, number]> = [];
  for (const c of catalog.ship_classes) {
    const q = quotes.get(c.id);
    if (!q) continue;
    if (hull < q * (1 - HULL_MATCH) || hull > (q + c.max_cannons * 15_000) * (1 + HULL_MATCH)) continue;
    fits.push([c.id, Math.abs(hull - q) / q]);
  }
  fits.sort((a, b) => a[1] - b[1]);
  return fits.length && !(fits[1] && fits[1][1] - fits[0][1] < 0.05) ? fits[0][0] : null;
}

/**
 * How likely a laden rival delivers `good` where it lands, and how many tons of it it may carry
 * (`unit`: the good's value per ton): a company that delivered it there lately most likely; else by
 * its declared cargo against a hold of the good (worth far more: it carries something dearer). Null
 * when only a load state is known, or when its hull class is unknown and it hasn't fed the good there
 * (no hold to weigh the cargo against): callers then take a share per ship, as before.
 */
export function landingOdds(l: RivalLanding, unit: number, fed: boolean): { odds: number; tons: number } | null {
  if (l.load === "ballast") return { odds: 0, tons: 0 };
  const hold = l.hold ?? DEFAULT_HOLD_T;
  const carried = l.cargo !== null && l.cargo > 0 && unit > 0 ? Math.min(hold, l.cargo / unit) : null;
  if (fed) return { odds: ODDS_FED, tons: carried ?? hold * FILL[l.load] };
  // Not DEFAULT_HOLD_T: a fluyt or an indiaman full of the cheap good would read as a misfit.
  if (carried === null || l.hold === null) return null;
  return { odds: l.cargo! <= l.hold * unit * 1.3 ? ODDS_FITS : ODDS_MISFIT, tons: carried };
}

/** One rival passage for the traffic count; a convoy's members share a group (pirates board one ship). */
interface Passage {
  group: string;
  from: string;
  to: string;
  shipClass: string;
  knots: number;
  load: LoadState;
  cargo: number;
  /** Known guns, or null (half the class's battery is assumed). */
  guns: number | null;
  /** Sails within the next game day (announced), not the last. */
  next: boolean;
}

export async function analyseRivals(t: RivalTracker, deps: RivalDeps): Promise<RivalAnalysis> {
  const { catalog, now, gameMinuteMs } = deps;
  const cls = (id: string | null) => (id ? catalog.ship_classes.find((c) => c.id === id) : undefined);
  // An event that named no class still needs a route: plan it for the first class (lanes rarely differ).
  const route = (from: string, to: string, shipClass: string) => deps.route(from, to, shipClass || catalog.ship_classes[0]?.id || "");
  const knotsOf = (s: Sighting) => ((cls(s.shipClass)?.base_speed_centiknots ?? 800) / 100) * SPEED[s.loadState];

  // Quay sightings; with rival intel, one matched to a policy or convoy counts there instead.
  const sightings = t.all().filter((s) => !(deps.intel && s.matched && t.knows(s.matched)));

  // Each ship's latest sighting, and its estimated whereabouts.
  const latest = new Map<string, Sighting>();
  for (const s of sightings) {
    const k = `${s.company}|${s.ship}`;
    const prev = latest.get(k);
    if (!prev || s.at > prev.at) latest.set(k, s);
  }
  const quay = await Promise.all(
    [...latest].map(async ([key, s]): Promise<RivalShip> => {
      const base = {
        key, company: s.company, ship: s.ship, shipClass: s.shipClass, loadState: s.loadState,
        seen: { port: s.port, otherPort: s.otherPort, direction: s.direction, at: s.at },
        sources: ["quay"] as IntelSource[], cargo: null, guns: null, lost: false,
      };
      if (s.direction !== "sailed" || !s.otherPort) return { ...base, voyage: null, inPort: s.direction === "arrived" ? s.port : null };
      const plan = await route(s.port, s.otherPort, s.shipClass).catch(() => null);
      if (!plan) return { ...base, voyage: null, inPort: null };
      const durMs = (plan.total_distance_nm / Math.max(knotsOf(s), 0.1)) * 60 * gameMinuteMs;
      return {
        ...base,
        voyage: { from: s.port, to: s.otherPort, departAt: s.at, arriveAt: s.at + durMs, legs: plan.legs.map((l) => [l.from_node, l.to_node]), departKnown: true, arriveKnown: false },
        inPort: now >= s.at + durMs ? s.otherPort : null,
      };
    }),
  );

  // Voyages policies and public convoys describe (rival intel), their missing times estimated.
  const est = await Promise.all(
    (deps.intel ? t.intelVoyages() : []).map(async (x) => {
      const shipClass = x.shipClass ?? (x.hull !== null && deps.quotes ? classOfHull(x.hull, deps.quotes, catalog) : null);
      const c = cls(shipClass);
      const knots = ((c?.base_speed_centiknots ?? 1_000) / 100) * SPEED[x.load ?? "part_laden"];
      const plan = await route(x.from, x.to, shipClass ?? "").catch(() => null);
      const sailMs = plan ? (plan.total_distance_nm / Math.max(knots, 0.1)) * 60 * gameMinuteMs : 0;
      let departAt: number;
      let arriveAt: number;
      if (x.endedAt !== null) {
        arriveAt = x.endedAt;
        departAt = x.sailedAt ?? arriveAt - sailMs;
      } else if (x.sailedAt !== null) {
        departAt = x.sailedAt;
        arriveAt = x.arriveEst ?? departAt + sailMs;
      } else if (x.departsAt !== null) {
        // A convoy's schedule.
        departAt = x.departsAt;
        arriveAt = x.arriveEst ?? departAt + sailMs;
      } else {
        // A standing policy, its ship not seen to sail: it lands about when the lane's policies close,
        // never in the past (unless the record went stale: then wherever that left it).
        const span = t.span(x.from, x.to, (x.cargo ?? 0) > 0);
        arriveAt = Math.max(x.listedAt + (span ?? POLICY_WAIT_GAME_MIN * gameMinuteMs + sailMs), x.stale ? 0 : now + MIN_LEFT_GAME_MIN * gameMinuteMs);
        departAt = arriveAt - sailMs;
      }
      const v: RivalVoyage = {
        key: x.key, sources: x.sources, company: x.company, companyId: x.companyId, ship: x.ship, shipId: x.shipId, shipClass, guns: x.guns,
        from: x.from, to: x.to, load: x.load, cargo: x.cargo, convoy: x.convoy,
        departAt, departKnown: x.sailedAt !== null, arriveAt, arriveKnown: x.state === "arrived" && x.endedAt !== null, state: x.state,
      };
      return { x, v, c, plan, knots };
    }),
  );

  // Ships: each intel ship's latest voyage, merged with its quay sightings when both names are known.
  const ships = new Map(quay.map((s) => [s.key, s]));
  const latestVoyage = new Map<string, (typeof est)[number]>();
  for (const e of est) {
    const prev = latestVoyage.get(e.x.shipId);
    if (!prev || e.v.departAt > prev.v.departAt) latestVoyage.set(e.x.shipId, e);
  }
  for (const { x, v, plan } of latestVoyage.values()) {
    const key = x.ship && x.companyId && t.names.has(x.companyId) ? `${v.company}|${x.ship}` : `#${x.shipId}`;
    const s = x.sighting;
    const ship: RivalShip = {
      key,
      company: v.company,
      ship: x.ship ?? `#${x.shipId.slice(-6)}`,
      shipClass: v.shipClass ?? "",
      loadState: v.load,
      seen: s && s.at >= x.listedAt
        ? { port: s.port, otherPort: s.otherPort, direction: s.direction, at: s.at }
        : { port: x.from, otherPort: x.to, direction: x.sources.includes("policy") ? "insured" : "convoy", at: x.listedAt },
      voyage: { from: v.from, to: v.to, departAt: v.departAt, arriveAt: v.arriveAt, legs: plan?.legs.map((l) => [l.from_node, l.to_node]) ?? [], departKnown: v.departKnown, arriveKnown: v.arriveKnown },
      inPort: v.state === "lost" ? null : now < v.departAt ? v.from : v.state === "arrived" || now >= v.arriveAt ? v.to : null,
      sources: v.sources,
      cargo: v.cargo,
      guns: v.guns,
      lost: v.state === "lost",
    };
    const q = ships.get(key);
    if (!q) {
      ships.set(key, ship);
      continue;
    }
    // Seen on the quay too: the newer of the two says where it is; the records' cargo and guns stay.
    const newer = ship.seen.at >= q.seen.at ? ship : q;
    ships.set(key, { ...newer, sources: [...new Set([...q.sources, ...ship.sources])], cargo: ship.cargo, guns: ship.guns, lost: ship.lost });
  }

  // Landings: rival ships due at each port (charter crowding, stall odds).
  const landings = new Map<string, RivalLanding[]>();
  const land = (port: string, l: RivalLanding) => landings.set(port, [...(landings.get(port) ?? []), l]);
  for (const s of quay) {
    if (!s.voyage || s.voyage.arriveAt <= now || !s.loadState || s.loadState === "ballast") continue;
    land(s.voyage.to, { at: s.voyage.arriveAt, from: s.voyage.from, company: s.company, load: s.loadState, cargo: null, hold: cls(s.shipClass)?.hold_capacity_tons ?? null, source: "quay" });
  }
  if (deps.intel) {
    const recent = now - RECENT_LANDING_GAME_MIN * gameMinuteMs;
    for (const { x, v, c } of est) {
      // Records that went stale, sinkings, and convoy ships of unknown load say nothing about a landing.
      if (x.stale || v.state === "lost" || v.load === null || v.arriveAt < recent) continue;
      const source: IntelSource = v.sources.includes("policy") ? "policy" : v.sources.includes("convoy") ? "convoy" : "quay";
      land(v.to, { at: v.arriveAt, from: v.from, company: v.company, load: v.load, cargo: v.cargo, hold: c?.hold_capacity_tons ?? null, source });
    }
    // Arrivals seen on the quay that no record holds: just in, and may still deliver.
    for (const s of sightings) {
      if (s.direction !== "arrived" || s.loadState === "ballast" || s.at < recent || s.at > now) continue;
      land(s.port, { at: s.at, from: s.otherPort, company: s.company, load: s.loadState, cargo: null, hold: cls(s.shipClass)?.hold_capacity_tons ?? null, source: "quay" });
    }
  }

  // Traffic over the last game day: sailings seen, plus arrivals whose sailing we never saw. An
  // arrival is the end of a seen voyage only when the ship's previous sighting is that sailing, so a
  // voyage seen at both ends counts once and a repeat run on the same lane still counts.
  const windowMs = 24 * 60 * gameMinuteMs;
  const recent = sightings.filter((s) => now - s.at <= windowMs && s.otherPort);
  const sailedSeen = (a: Sighting) => {
    let prev: Sighting | null = null;
    for (const s of sightings) {
      if (s !== a && s.company === a.company && s.ship === a.ship && s.at <= a.at && (!prev || s.at > prev.at)) prev = s;
    }
    return prev?.direction === "sailed" && prev.port === a.otherPort && prev.otherPort === a.port;
  };
  const passages: Passage[] = [
    ...recent.filter((s) => s.direction === "sailed").map((s) => ({ s, from: s.port, to: s.otherPort! })),
    ...recent.filter((a) => a.direction === "arrived" && !sailedSeen(a)).map((a) => ({ s: a, from: a.otherPort!, to: a.port })),
  ].map(({ s, from, to }, i) => ({
    // Convoys are grouped only with rival intel on, so with it off the counts stay as they were.
    group: deps.intel && s.convoy ? `${from}|${s.convoy}` : `s${i}`,
    from, to, shipClass: s.shipClass, knots: knotsOf(s), load: s.loadState,
    cargo: (cls(s.shipClass)?.hold_capacity_tons ?? 40) * FILL[s.loadState] * valuePerTon(catalog, from),
    guns: null, next: false,
  }));
  for (const { x, v, c, knots } of est) {
    const ahead = v.departAt > now;
    if (Math.abs(v.departAt - now) > windowMs || (ahead && x.stale)) continue;
    const hold = c?.hold_capacity_tons ?? DEFAULT_HOLD_T;
    // Declared cargo; else (a hull-only policy seen laden on the quay, a convoy ship) as for a sighting.
    const load = v.load ?? (v.cargo === null ? "part_laden" : "ballast");
    const cargo = v.cargo !== null && v.cargo > 0 ? v.cargo : hold * FILL[load] * valuePerTon(catalog, v.from);
    passages.push({ group: x.convoyId ? `cvy:${x.convoyId}` : v.key, from: v.from, to: v.to, shipClass: v.shipClass ?? "", knots, load, cargo, guns: v.guns, next: ahead });
  }
  const groups = new Map<string, Passage[]>();
  for (const p of passages) groups.set(p.group, [...(groups.get(p.group) ?? []), p]);
  const zones = new Map<string, ZoneTraffic>();
  await Promise.all(
    [...groups.values()].map(async (members) => {
      // Pirates board one ship of a convoy (the richest) and its guns are pooled; it sails at its slowest.
      const lead = members.reduce((a, b) => (b.cargo > a.cargo ? b : a));
      const slow = members.reduce((a, b) => (b.knots < a.knots ? b : a));
      const plan = await route(lead.from, lead.to, slow.shipClass).catch(() => null);
      if (!plan) return;
      // A rival's guns are unknown unless a convoy lists them: assume half its class's battery.
      const guns = members.reduce((n, m) => n + (m.guns ?? (cls(m.shipClass)?.max_cannons ?? 0) / 2), 0);
      const det = 1 / (1 + GUN_DETERRENCE * guns);
      const laden = Math.max(...members.map((m) => (m.load === "laden" ? 1 : m.load === "part_laden" ? 0.5 : 0)));
      // Pirates go for the richest prizes (the planner's own guess): rival intel weighs each passage by its cargo's pull.
      const pull = deps.intel ? pirateAttention(lead.cargo) : 1;
      for (const [zone, days] of zoneDays(catalog, plan, slow.knots)) {
        const z = zones.get(zone) ?? { zone, passages: 0, laden: 0, cargo: 0, exposure: 0, next: { passages: 0, laden: 0, exposure: 0 } };
        const into = lead.next ? z.next : z;
        into.passages += 1;
        into.laden += laden;
        if (!lead.next) z.cargo += lead.cargo;
        // At most one interception per passage, even with the largest marque added.
        const net = (deps.piracy?.get(zone) ?? 0) + 1_500;
        into.exposure += lead.cargo * Math.min(days * det * pull, 10_000 / net);
        zones.set(zone, z);
      }
    }),
  );
  return {
    ships: [...ships.values()],
    zones: [...zones.values()].sort((a, b) => b.exposure - a.exposure),
    windowGameHours: 24,
    landings: [...landings],
    voyages: est.map((e) => e.v),
  };
}

// ── Profiles ──────────────────────────────────────────────────────────────────

export interface RivalProfile {
  company: string;
  /** The name is known (a company seen only by id in policies shows as #abc123). */
  linked: boolean;
  homePort: string | null;
  rank: number | null;
  netWorth: number | null;
  /** Net worth gained per real hour (hourly leaderboard), or null. */
  earnPerHour: number | null;
  /** Expansion tons it delivered per real hour over the attributed window, or null. */
  tonsPerHour: number | null;
  ships: number;
  classes: Array<[cls: string, n: number]>;
  lanes: Array<{ from: string; to: string; voyages: number; laden: number; cargo: number }>;
  feeds: Array<{ port: string; good: string; tons: number; lastAt: number }>;
  /** Declared cargo landed per real hour (closed policies), or null. */
  cargoPerHour: number | null;
  losses: number;
  sources: IntelSource[];
}

/** Rates are measured over at most the last real day, and at least an hour. */
const PROFILE_WINDOW_MS = 24 * 3_600_000;

/**
 * Each rival company as far as it is seen: its ships, classes, lanes and declared cargo (analysis),
 * the charters it delivered to (board deltas and notices), its net worth and earning rate
 * (leaderboard). Every company on the latest leaderboard has one, even with no ship seen. By net worth, then ships.
 */
export function rivalProfiles(t: RivalTracker, a: RivalAnalysis, now: number): RivalProfile[] {
  const out = new Map<string, RivalProfile>();
  const get = (company: string): RivalProfile => {
    let p = out.get(company);
    if (!p) {
      const s = t.standing(company);
      p = {
        company, linked: !company.startsWith("#"), homePort: t.homePorts.get(company) ?? null, rank: s?.rank ?? null, netWorth: s?.worth ?? null,
        earnPerHour: t.earnRate(company), tonsPerHour: null, ships: 0, classes: [], lanes: [], feeds: [], cargoPerHour: null, losses: 0, sources: [],
      };
      out.set(company, p);
    }
    return p;
  };
  for (const n of t.leaders()) get(n);
  for (const s of a.ships) {
    const p = get(s.company);
    p.ships++;
    if (s.shipClass) {
      const c = p.classes.find(([k]) => k === s.shipClass);
      if (c) c[1]++;
      else p.classes.push([s.shipClass, 1]);
    }
    p.sources = [...new Set([...p.sources, ...s.sources])];
  }
  // Lanes: the records' voyages (their history), plus quay-only ships' last voyages.
  const lane = (p: RivalProfile, from: string, to: string, load: LoadState | null, cargo: number | null) => {
    let l = p.lanes.find((x) => x.from === from && x.to === to);
    if (!l) p.lanes.push((l = { from, to, voyages: 0, laden: 0, cargo: 0 }));
    l.voyages++;
    if (load === "laden" || load === "part_laden") l.laden++;
    l.cargo += cargo ?? 0;
  };
  const landed = new Map<string, Array<[number, number]>>();
  for (const v of a.voyages) {
    const p = get(v.company);
    lane(p, v.from, v.to, v.load, v.cargo);
    if (v.state === "lost") p.losses++;
    if (v.arriveKnown && v.state === "arrived" && v.cargo !== null && now - v.arriveAt <= PROFILE_WINDOW_MS) landed.set(v.company, [...(landed.get(v.company) ?? []), [v.arriveAt, v.cargo]]);
  }
  for (const s of a.ships) if (s.voyage && s.sources.length === 1 && s.sources[0] === "quay") lane(get(s.company), s.voyage.from, s.voyage.to, s.loadState, null);
  const perHour = (xs: Array<[number, number]> | undefined) =>
    xs && xs.length >= 2 ? (xs.reduce((n, [, v]) => n + v, 0) * 3_600_000) / Math.max(3_600_000, now - Math.min(...xs.map(([at]) => at))) : null;
  const delivered = new Map<string, Array<[number, number]>>();
  for (const d of t.deliveriesSeen(null, INTEL_MAX_RECORDS)) {
    if (d.company === null) continue;
    const p = get(d.company);
    const f = p.feeds.find((x) => x.port === d.port && x.good === d.good);
    if (f) {
      f.tons += d.tons;
      f.lastAt = Math.max(f.lastAt, d.at);
    } else p.feeds.push({ port: d.port, good: d.good, tons: d.tons, lastAt: d.at });
    if (now - d.at <= PROFILE_WINDOW_MS) delivered.set(d.company, [...(delivered.get(d.company) ?? []), [d.at, d.tons]]);
  }
  for (const p of out.values()) {
    p.classes.sort((x, y) => y[1] - x[1]);
    p.lanes.sort((x, y) => y.voyages - x.voyages || y.cargo - x.cargo);
    p.feeds.sort((x, y) => y.tons - x.tons);
    p.cargoPerHour = perHour(landed.get(p.company));
    p.tonsPerHour = perHour(delivered.get(p.company));
  }
  return [...out.values()].sort((x, y) => (y.netWorth ?? -1) - (x.netWorth ?? -1) || y.ships - x.ships);
}

// ── Letters of marque ─────────────────────────────────────────────────────────

export interface ZonePiracy {
  base_piracy_bps: number;
  marque_piracy_bps: number;
  patrol_suppression_bps: number;
}

export interface MarqueOption {
  bps: number;
  /** Per game day, pence. */
  prize: number;
  cost: number;
  /** Extra cargo our own ships are expected to lose in the zone. */
  ownLoss: number;
  profit: number;
}

/** Marque cost: 2 Cr per bps per game day. */
export const MARQUE_PENCE_PER_BPS_DAY = 200;

/**
 * The marque size that earns most per game day in a zone, given the rival exposure there and our
 * own ships' exposure (both pence·days a game day, as ZoneTraffic.exposure). The prize court pays
 * half the seized cargo's base value times the marques' share of the zone's piracy, split among
 * marques by bps; interception odds per passage run at the zone's net piracy per game day at sea.
 * Returns the best option even when it loses money (callers decide).
 */
export function bestMarque(zone: ZonePiracy, rivalExposure: number, ownExposure: number, maxBps = 1_500): MarqueOption {
  const b = zone.base_piracy_bps;
  const others = zone.marque_piracy_bps;
  // The zone's marques are capped: past the cap a marque adds cost but no piracy.
  const top = Math.min(maxBps, 1_500, ZONE_MARQUE_CAP - others);
  if (top < 50) return { bps: 0, prize: 0, cost: 0, ownLoss: 0, profit: -1 };
  let best: MarqueOption | null = null;
  for (let bps = 50; bps <= top; bps += 50) {
    const net = Math.max(0, b + others + bps - zone.patrol_suppression_bps);
    const share = bps / Math.max(b + others + bps, 1);
    const prize = rivalExposure * (net / 10_000) * HIT_LOSS * PRIZE_OF_SEIZED * share;
    const cost = MARQUE_PENCE_PER_BPS_DAY * bps;
    const ownLoss = ownExposure * (bps / 10_000) * HIT_LOSS;
    const profit = prize - cost - ownLoss;
    if (!best || profit > best.profit) best = { bps, prize: Math.round(prize), cost, ownLoss: Math.round(ownLoss), profit: Math.round(profit) };
  }
  return best!;
}

/** What `/api/kibb/rivals` returns. */
export interface RivalsView {
  now: number;
  gameMinuteMs: number;
  windowGameHours: number;
  /** Ports where we have presence now (only their sailings are visible). */
  presence: string[];
  rivals: RivalShip[];
  traffic: ZoneTraffic[];
  zones: Array<ZonePiracy & { sea_zone_id: string; name: string; phase: number; net_piracy_bps: number }>;
  verdicts: Array<{ zone: string; passages: number; laden: number; cargo: number; next?: ZoneTraffic["next"]; best: MarqueOption; active: boolean; verdict: string }>;
  marques: Array<{ id: string; sea_zone_id: string; added_piracy_bps: number; cost_pence: number; prize_earned_pence: number; created_at: string; expires_at: string }>;
  report: { checkedAt: string; enabled: boolean; budgetPence: number; spentPence: number; prizePence: number; action: string } | null;
  settings: { marques: boolean; marqueBudgetPence: number; rivalIntel: boolean };
  profiles: RivalProfile[];
  /** Ours, for comparison: net worth, rank and earning per hour (leaderboard). */
  you: { netWorth: number; rank: number; earnPerHour: number | null } | null;
  /** Where the picture comes from. */
  coverage: { quayPorts: number; policies: number; convoys: number; deliveries: number; activeCompanies: number | null };
  /** Expansion charters of the tier in play: what rivals delivered, and for a stalled posting the rivals due before it lapses. */
  charters: Array<{
    port: string;
    good: string;
    rivalTons: Array<[company: string, tons: number]>;
    lastAt: number | null;
    stalled: boolean;
    expiresAt: number | null;
    dueBeforeLapse: number;
    /** A stalled posting's odds of re-posting richer if none of our ships delivers first (the running autopilot's call), or null. */
    survival: number | null;
  }>;
  autopilot: string;
}
