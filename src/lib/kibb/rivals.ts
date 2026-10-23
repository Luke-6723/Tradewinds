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
 */

import type { Catalog, RoutePlan, SailingNotice } from "./types";

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
}

export interface RivalShip {
  key: string;
  company: string;
  ship: string;
  shipClass: string;
  loadState: LoadState;
  seen: Pick<Sighting, "port" | "otherPort" | "direction" | "at">;
  /** The voyage it set out on when last seen sailing (estimated times), or null. */
  voyage: { from: string; to: string; departAt: number; arriveAt: number; legs: Array<[from: string, to: string]> } | null;
  /** In this port as of the sighting, or (estimated) after its voyage; null while at sea. */
  inPort: string | null;
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
/** A zone's marques are capped at this in total (bps). */
const ZONE_MARQUE_CAP = 5_000;

// ── Store ─────────────────────────────────────────────────────────────────────

export class RivalTracker {
  private readonly seen = new Map<string, Sighting>();
  /** Names of the player's own companies: their ships are not rivals. */
  readonly ours = new Set<string>();

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
        return;
      }
    }
    this.seen.set(`${base}|${s.at}`, s);
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

  prune(now: number, gameMinuteMs: number): void {
    const keep = KEEP_GAME_DAYS * 24 * 60 * gameMinuteMs;
    for (const [k, s] of this.seen) if (now - s.at > keep) this.seen.delete(k);
  }

  all(): Sighting[] {
    return [...this.seen.values()];
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

export async function analyseRivals(
  sightings: Sighting[],
  deps: RivalDeps,
): Promise<{ ships: RivalShip[]; zones: ZoneTraffic[]; windowGameHours: number }> {
  const { catalog, now, gameMinuteMs } = deps;
  const cls = (id: string) => catalog.ship_classes.find((c) => c.id === id);
  // An event that named no class still needs a route: plan it for the first class (lanes rarely differ).
  const route = (from: string, to: string, shipClass: string) => deps.route(from, to, shipClass || catalog.ship_classes[0]?.id || "");
  const knotsOf = (s: Sighting) => ((cls(s.shipClass)?.base_speed_centiknots ?? 800) / 100) * SPEED[s.loadState];

  // Each ship's latest sighting, and its estimated whereabouts.
  const latest = new Map<string, Sighting>();
  for (const s of sightings) {
    const k = `${s.company}|${s.ship}`;
    const prev = latest.get(k);
    if (!prev || s.at > prev.at) latest.set(k, s);
  }
  const ships = await Promise.all(
    [...latest].map(async ([key, s]): Promise<RivalShip> => {
      const base = { key, company: s.company, ship: s.ship, shipClass: s.shipClass, loadState: s.loadState, seen: { port: s.port, otherPort: s.otherPort, direction: s.direction, at: s.at } };
      if (s.direction !== "sailed" || !s.otherPort) return { ...base, voyage: null, inPort: s.direction === "arrived" ? s.port : null };
      const plan = await route(s.port, s.otherPort, s.shipClass).catch(() => null);
      if (!plan) return { ...base, voyage: null, inPort: null };
      const durMs = (plan.total_distance_nm / Math.max(knotsOf(s), 0.1)) * 60 * gameMinuteMs;
      return {
        ...base,
        voyage: { from: s.port, to: s.otherPort, departAt: s.at, arriveAt: s.at + durMs, legs: plan.legs.map((l) => [l.from_node, l.to_node]) },
        inPort: now >= s.at + durMs ? s.otherPort : null,
      };
    }),
  );

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
  const voyages = [
    ...recent.filter((s) => s.direction === "sailed").map((s) => ({ s, from: s.port, to: s.otherPort! })),
    ...recent
      .filter((a) => a.direction === "arrived" && !sailedSeen(a))
      .map((a) => ({ s: a, from: a.otherPort!, to: a.port })),
  ];
  const zones = new Map<string, ZoneTraffic>();
  await Promise.all(
    voyages.map(async ({ s, from, to }) => {
      const plan = await route(from, to, s.shipClass).catch(() => null);
      if (!plan) return;
      const c = cls(s.shipClass);
      const cargo = (c?.hold_capacity_tons ?? 40) * FILL[s.loadState] * valuePerTon(catalog, from);
      // A rival's guns are unknown: assume half its class's battery.
      const det = 1 / (1 + GUN_DETERRENCE * ((c?.max_cannons ?? 0) / 2));
      for (const [zone, days] of zoneDays(catalog, plan, knotsOf(s))) {
        const z = zones.get(zone) ?? { zone, passages: 0, laden: 0, cargo: 0, exposure: 0 };
        z.passages += 1;
        z.laden += s.loadState === "laden" ? 1 : s.loadState === "part_laden" ? 0.5 : 0;
        z.cargo += cargo;
        // At most one interception per passage, even with the largest marque added.
        const net = (deps.piracy?.get(zone) ?? 0) + 1_500;
        z.exposure += cargo * Math.min(days * det, 10_000 / net);
        zones.set(zone, z);
      }
    }),
  );
  return { ships, zones: [...zones.values()].sort((a, b) => b.exposure - a.exposure), windowGameHours: 24 };
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
  verdicts: Array<{ zone: string; passages: number; laden: number; cargo: number; best: MarqueOption; active: boolean; verdict: string }>;
  marques: Array<{ id: string; sea_zone_id: string; added_piracy_bps: number; cost_pence: number; prize_earned_pence: number; created_at: string; expires_at: string }>;
  report: { checkedAt: string; enabled: boolean; budgetPence: number; spentPence: number; prizePence: number; action: string } | null;
  settings: { marques: boolean; marqueBudgetPence: number };
  autopilot: string;
}
