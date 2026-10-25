/**
 * The strategist's directives: what one answer may change, how far, and what stays in force (pure: no
 * I/O). Shared by the digest (the schema's enums, the ranges it shows), the advisor (validation, what is
 * in force) and the manager (the settings overlay and its hard floors).
 *
 * Ranges (the user's decisions): every setting in its full valid range, with hard floors: max ships, the
 * marque and underwriting budgets, the debt cap and the cash due counted on never above the user's values,
 * leverage and idle-cash lending only ever switched off (the user's "off" is a ceiling), the home reserve and a
 * loan's required return only ever raised, and the AI's own settings not even nameable (they are not in the
 * schema's enum). Money orders (borrow for a load or a hull, repay a loan early, build a commission to order) refer
 * only to what the digest listed and are carried out through the autopilot's own checks.
 */

import type { FleetSettings, GunPolicy } from "../fleet/manager";
import type { Bans, Lane } from "../fleet/planner";
import type { Catalog, ZoneClass } from "../types";
import { PATROL_PENCE_PER_BPS_DAY, ZONE_MARQUE_CAP } from "../rivals";
import { LOAN_MIN_PRINCIPAL_PENCE } from "../fleet/finance";
import type { Aliases, RawAdvice } from "./digest";

// ── Limits on one answer ─────────────────────────────────────────────────────

/** Lane bias: a factor on a lane's rank (never makes a lane eligible). */
export const BIAS_MIN = 0.5;
export const BIAS_MAX = 1.5;
export const MAX_BIASES = 12;
export const MAX_STALL_CALLS = 10;
export const MAX_BANS = 12;
export const MAX_NAVAL = 2;
/** Money orders in one answer: one loan, and at most this many repayments and commissions each. */
export const MAX_REPAY = 2;
export const MAX_COMMISSIONS = 2;
/** One order per ship; a list longer than any fleet is cut here. */
const MAX_SHIP_ORDERS = 30;
/** How long its directives last before they lapse (real minutes). */
export const HORIZON_MIN = 15;
export const HORIZON_MAX = 180;
/** Marques and patrols as the Crown takes them (guide: 50-1500 bps, 5-1440 game hours, 100 Cr at least). */
export const NAVAL_BPS_MIN = 50;
export const NAVAL_BPS_MAX = 1_500;
export const NAVAL_TERM_MIN_H = 5;
const NAVAL_TERM_MAX_H = 1_440;
const NAVAL_MIN_PENCE = 10_000;

// ── Settings it may move ─────────────────────────────────────────────────────

type KeysOfType<T, V> = { [K in keyof T]-?: T[K] extends V ? K : never }[keyof T];

export const NUMBER_KEYS = [
  "maxShips",
  "reservePence",
  "minMarginPence",
  "maxPaybackHours",
  "bonusWeightPct",
  "stormWeightPct",
  "marqueBudgetPence",
  "underwriteBudgetPence",
  "underwriteMaxPerPolicyPence",
  "underwriteMinEdgeBps",
  "phaseChestPct",
  "cashDuePct",
  "maxDebtPct",
  "minLoanReturnX",
] as const satisfies readonly KeysOfType<FleetSettings, number>[];
export const SWITCH_KEYS = [
  "autoBuy",
  "marques",
  "underwrite",
  "useFreight",
  "convoys",
  "rivalIntel",
  "byomBuilds",
  "yardFactor",
  "holdForRepost",
  "captureEscalations",
  "actOnEvents",
  "resizeLoads",
  "leverage",
  "idleCash",
  "shipDeals",
  "envelopes",
] as const satisfies readonly KeysOfType<FleetSettings, boolean>[];
/** Risky switches the user's "off" is a ceiling for: the AI may only turn them off. */
export const CEILING_SWITCHES = ["leverage", "idleCash"] as const satisfies readonly SwitchKey[];
/** Never the AI's: its mode, caps, model, effort and cadence. */
export const AI_KEYS = ["ai", "aiDailyCapUsd", "aiTotalCapUsd", "aiModel", "aiEffort", "aiIntervalMin"] as const satisfies readonly (keyof FleetSettings)[];

export type NumberKey = (typeof NUMBER_KEYS)[number];
export type SwitchKey = (typeof SWITCH_KEYS)[number];
export type OverrideKey = Exclude<keyof FleetSettings, (typeof AI_KEYS)[number]>;
export type OverrideSettings = Partial<Pick<FleetSettings, OverrideKey>>;
export const OVERRIDE_KEYS: readonly OverrideKey[] = [...NUMBER_KEYS, ...SWITCH_KEYS, "guns", "buyClasses"];
/** A new setting must be given a range here: the build fails while one is left out. */
type MustBeNever<T extends never> = T;
export type UnlistedSettings = MustBeNever<Exclude<OverrideKey, NumberKey | SwitchKey | "guns" | "buyClasses">>;

const GUNS: readonly GunPolicy[] = ["auto", "full", "off"];

/** What the AI may set a number to, from the user's own settings (the table in README; spend ceilings are the user's). */
const RANGES: Record<NumberKey, (v: number) => { min: number; max: number; int: boolean }> = {
  maxShips: (v) => ({ min: 1, max: Math.max(1, v), int: true }),
  // A floor it can only raise: it covers bills the planner can't see.
  reservePence: (v) => ({ min: v, max: Math.max(10 * v, v + 1_000_000), int: true }),
  minMarginPence: (v) => ({ min: 0, max: Math.max(4 * v, 6_000), int: true }),
  maxPaybackHours: (v) => ({ min: 0.1, max: Math.max(0.1, 2 * v), int: false }),
  bonusWeightPct: () => ({ min: 0, max: 100, int: true }),
  stormWeightPct: () => ({ min: 0, max: 200, int: true }),
  marqueBudgetPence: (v) => ({ min: 0, max: Math.max(0, v), int: true }),
  underwriteBudgetPence: (v) => ({ min: 0, max: Math.max(0, v), int: true }),
  underwriteMaxPerPolicyPence: (v) => ({ min: 0, max: Math.max(0, v), int: true }),
  // Below ~50 bps the edge is inside the noise of the Lloyd's-implied bound.
  underwriteMinEdgeBps: (v) => ({ min: 50, max: Math.max(4 * v, 600), int: true }),
  phaseChestPct: () => ({ min: 0, max: 90, int: true }),
  // A ceiling: never more of the cash due counted on than the user counts.
  cashDuePct: (v) => ({ min: 0, max: Math.min(90, Math.max(0, v)), int: true }),
  // A ceiling: what may be owed never above the user's share of net worth.
  maxDebtPct: (v) => ({ min: 0, max: Math.max(0, v), int: false }),
  // Only ever stricter than the user's: up to 4x.
  minLoanReturnX: (v) => ({ min: v, max: Math.max(v, 4 * v), int: false }),
};

export function aiRange(k: NumberKey, user: FleetSettings): { min: number; max: number; int: boolean } {
  return RANGES[k](user[k]);
}

function clampTo(k: NumberKey, v: number, user: FleetSettings): number {
  const r = aiRange(k, user);
  const x = r.int ? Math.round(v) : Math.round(v * 10) / 10;
  return Math.min(r.max, Math.max(r.min, x));
}

/** Value equality (a class list read back from the store is a new array). */
export function sameSetting(a: unknown, b: unknown): boolean {
  return Array.isArray(a) && Array.isArray(b) ? [...a].sort().join() === [...b].sort().join() : a === b;
}

/**
 * The hard floors, applied wherever settings are read (defence in depth, whatever an override says): the
 * AI's own settings are the user's, every number within its range, spend ceilings, the debt cap, the cash due
 * counted on and max ships at most the user's, the reserve and a loan's required return at least the user's,
 * leverage and idle-cash lending never on while the user's are off, only classes the user allows, and no ship
 * buying without the key's `infra_manage` scope.
 */
export function enforceFloors(own: FleetSettings, eff: FleetSettings, caps: { canBuild: boolean }): FleetSettings {
  const out: FleetSettings = { ...eff };
  const w = out as unknown as Record<string, unknown>;
  for (const k of AI_KEYS) w[k] = own[k];
  for (const k of NUMBER_KEYS) {
    if (out[k] === own[k]) continue;
    const v = Number(out[k]);
    w[k] = Number.isFinite(v) ? clampTo(k, v, own) : own[k];
  }
  for (const k of SWITCH_KEYS) if (typeof out[k] !== "boolean") w[k] = own[k];
  // Borrowing and lending stay off while the user's are off.
  for (const k of CEILING_SWITCHES) if (!own[k]) out[k] = false;
  if (!GUNS.includes(out.guns)) out.guns = own.guns;
  // One extra class comes only through a build order, never this list.
  out.buyClasses = Array.isArray(out.buyClasses) ? out.buyClasses.filter((c) => own.buyClasses.includes(c)) : own.buyClasses;
  if (!caps.canBuild) out.autoBuy = false;
  return out;
}

// ── Directives ───────────────────────────────────────────────────────────────

export const BIAS_MATCHES = ["dest", "source", "port", "zone", "good", "charter", "lane"] as const;
export interface Bias {
  match: (typeof BIAS_MATCHES)[number];
  /** Port, zone or good id, charter id, or lane key. */
  ref: string;
  factor: number;
  label: string;
  reason: string;
}

export interface StallCall {
  /** `port|good` of the expansion charter. */
  key: string;
  call: "wait" | "deliver";
  label: string;
  reason: string;
}

export const BAN_KINDS = ["port", "zone", "good", "charter", "contested"] as const;
export type BanKind = (typeof BAN_KINDS)[number];
/** A hard ban for the horizon, on new plans only. `ref`: port, zone or good id, charter (posting) id; "" for contested. */
export interface Ban {
  kind: BanKind;
  ref: string;
  label: string;
  reason: string;
}

export const SHIP_ORDERS = ["lane", "charter", "port", "hold", "release"] as const;
export type ShipOrderKind = (typeof SHIP_ORDERS)[number];
export type OrderStatus = "pending" | "waiting" | "active" | "done" | "unmet" | "refused" | "lapsed";
/** Why an order stands where it does: a fixed vocabulary, all the digest shows (the game's own text stays in the log). */
export const ORDER_CODES = [
  "no_passing_lane",
  "route",
  "cargo_aboard",
  "repositioning",
  "fleet_full",
  "season",
  "payback",
  "no_paying_lane",
  "no_presence",
  "cash",
  "budget",
  "cap",
  "zone",
  "scope",
  "class",
  "server",
  "unknown_outcome",
  "horizon",
  "switched_off",
  "debt_cap",
  "no_lender",
  "not_needed",
  "margin",
  "deadline",
  "gone",
  "underwritten",
] as const;
export type OrderCode = (typeof ORDER_CODES)[number];

export interface ShipOrder {
  /** Ship id. */
  ship: string;
  order: ShipOrderKind;
  /** Lane key, charter (posting) id or port id; "" for hold and release. */
  ref: string;
  label: string;
  reason: string;
  status: OrderStatus;
  code?: OrderCode;
  /** Detail for the owner (may quote the game): the log and dashboard only, never the digest. */
  note?: string;
}

export interface BuildOrder {
  cls: string;
  yard: string;
  reason: string;
  status: OrderStatus;
  code?: OrderCode;
  note?: string;
  shipId?: string;
}

export type NavalStatus = "pending" | "issuing" | "issued" | "refused" | "unknown" | "lapsed";
export interface NavalOrder {
  id: string;
  kind: "marque" | "patrol";
  zone: string;
  bps: number;
  gameHours: number;
  /** Expected cost (pence): a patrol's formula, a marque at its zone's last quoted price (0: not quoted yet, priced when issued); the game's own once issued. */
  costPence: number;
  reason: string;
  status: NavalStatus;
  code?: OrderCode;
  note?: string;
  /** The marque or patrol it became, and when (server ms) it was sent. */
  issuedId?: string;
  sentAt?: number;
}

/**
 * A money order, carried out with every check of the autopilot's own (the debt cap, a loan's required return and
 * payback, cash after loads, a commission's margin, presence and deadline): `borrow_load` up to `pence` for that ship's
 * next load at its source (leverage and re-sizing on), `borrow_hull` up to `pence` for a hull our cash can't fund (not
 * only against cash due), `repay` that loan early in full from spare cash, `commission` build that commission to order.
 */
export type FinanceKind = "borrow_load" | "borrow_hull" | "repay" | "commission";
export interface FinanceOrder {
  id: string;
  kind: FinanceKind;
  /** Ship id (borrow_load), loan id (repay), commission (contract) id; "" for borrow_hull. */
  ref: string;
  /** The most to borrow (pence; borrows only, else 0). */
  pence: number;
  label: string;
  reason: string;
  status: OrderStatus;
  code?: OrderCode;
  note?: string;
}

export interface Directives {
  settings: OverrideSettings;
  settingReasons: Partial<Record<OverrideKey, string>>;
  avoid: Ban[];
  biases: Bias[];
  stallCalls: StallCall[];
  shipOrders: ShipOrder[];
  buyHold: string | null;
  build: BuildOrder | null;
  /** Classes the buyer may not build (folded into buyClasses while the user's list is unchanged). */
  forbid: string[];
  naval: NavalOrder[];
  /** Borrow, repay, accept a commission (absent from older saves: normalizeActive). */
  finance: FinanceOrder[];
}

/** The directives in force (live mode only). */
export interface Active extends Directives {
  decisionId: string;
  /** Local ms when they lapse. */
  until: number;
  /** The user's value each override was set against: an override lapses once the user changes it. */
  base: OverrideSettings;
}

type Core = "decisionId" | "until" | "settings" | "biases" | "stallCalls" | "buyHold";
/** As saved: older saves lack everything but the core. */
export type StoredActive = Pick<Active, Core> & Partial<Omit<Active, Core>>;

const list = <T>(x: T[] | null | undefined): T[] => (Array.isArray(x) ? x : []);

/** A save restored (older ones included): every list there, unknown setting keys gone, a naval order cut off mid-call unknown. */
export function normalizeActive(s: StoredActive): Active {
  const keys = new Set<string>(OVERRIDE_KEYS);
  const only = <T extends object>(o: T | undefined): T => Object.fromEntries(Object.entries(o ?? {}).filter(([k]) => keys.has(k))) as T;
  return {
    decisionId: s.decisionId,
    until: s.until,
    settings: only(s.settings),
    base: only(s.base),
    settingReasons: only(s.settingReasons),
    biases: list(s.biases),
    stallCalls: list(s.stallCalls),
    buyHold: s.buyHold ?? null,
    avoid: list(s.avoid),
    shipOrders: list(s.shipOrders),
    build: s.build ?? null,
    forbid: list(s.forbid),
    // It may have landed: never sent again, reconciled from our marques and patrols.
    naval: list(s.naval).map((n) => (n.status === "issuing" ? { ...n, status: "unknown" as const } : n)),
    finance: list(s.finance),
  };
}

/** The bans as sets (charters by the posting that now stands for each), or null with none. */
export function bansOf(avoid: Ban[], currentId: (id: string) => string): Bans | null {
  if (avoid.length === 0) return null;
  const of = (k: BanKind) => new Set(avoid.filter((b) => b.kind === k).map((b) => (k === "charter" ? currentId(b.ref) : b.ref)));
  return { ports: of("port"), zones: of("zone"), goods: of("good"), charters: of("charter"), contested: avoid.some((b) => b.kind === "contested") };
}

/** Whether a planned lane touches a ban: either end, a good, a charter it fills, a zone of its laden passage. */
export function laneBanned(l: Lane, b: Bans, currentId: (id: string) => string): boolean {
  return (
    b.ports.has(l.source) ||
    b.ports.has(l.dest) ||
    b.goods.has(l.good) ||
    l.parts.some((p) => b.goods.has(p.good)) ||
    l.fills.some(([id]) => b.charters.has(currentId(id))) ||
    !!l.zones?.some((z) => b.zones.has(z))
  );
}

/** What a patrol costs (guide: 2 Cr per bps per game day of the term, 100 Cr at least). */
export function patrolCost(bps: number, gameHours: number): number {
  return marqueCost(PATROL_PENCE_PER_BPS_DAY, bps, gameHours);
}

/** A marque at its zone's quoted price per bps per game day (`marque-quote`: set by the zone's traffic), 100 Cr at least. */
export function marqueCost(pricePerBpsDay: number, bps: number, gameHours: number): number {
  return Math.max(NAVAL_MIN_PENCE, Math.ceil(pricePerBpsDay * bps * (gameHours / 24)));
}

// ── Validation ───────────────────────────────────────────────────────────────

export interface ValidateCtx {
  /** The user's own settings. */
  user: FleetSettings;
  /** The key may build ships (`infra_manage`). */
  canBuild: boolean;
  catalog: Catalog;
  unlockedPhase: number;
  isOpen(port: string): boolean;
  currentId(id: string): string;
  renews(c: { id: string }): boolean;
  hazardZone(node: string): { id: string; zone_class: ZoneClass } | undefined;
  /** Our ships, with their hull's rating. */
  fleet: Array<{ id: string; hull: ZoneClass; gone: boolean }>;
  /** Spent on our marques and patrols in the last 24 real hours, as last read (pence). */
  navalSpent24h: number;
  /** Each zone's marque and patrol totals (bps), as last read. */
  zoneBps: Map<string, { marque: number; patrol: number }>;
  /** A marque's price per bps per game day (pence) in each zone, from the last quotes read; a zone not quoted is priced when issued. */
  marquePrice: Map<string, number>;
  gameMinuteMs: number;
}

const RANK: Record<ZoneClass, number> = { coastal: 0, regional: 1, oceanic: 2 };

/**
 * Validates, clamps and resolves an answer into directives, and counts its items and the invalid ones
 * (an unknown alias or id, a key out of the enum, a ban the answer itself contradicts, over a limit).
 * Clamping isn't a drop; values equal to the user's are no change.
 */
export function validateAnswer(raw: RawAdvice, aliases: Aliases, ctx: ValidateCtx): { d: Directives; horizonMin: number; items: number; dropped: number } {
  const u = ctx.user;
  const cat = ctx.catalog;
  let items = 0;
  let dropped = 0;
  const text = (s: unknown, n = 200) => String(s ?? "").slice(0, n);
  const horizonMin = Math.round(Math.min(HORIZON_MAX, Math.max(HORIZON_MIN, Number(raw.horizonMin) || 60)));
  const d: Directives = { settings: {}, settingReasons: {}, avoid: [], biases: [], stallCalls: [], shipOrders: [], buyHold: null, build: null, forbid: [], naval: [], finance: [] };
  const set = (k: OverrideKey, v: unknown, reason: unknown) => {
    (d.settings as Record<string, unknown>)[k] = v;
    d.settingReasons[k] = text(reason);
  };
  const isPort = (id: string) => cat.ports.some((p) => p.id === id);
  const isZone = (id: string) => cat.sea_zones.some((z) => z.id === id);
  const isGood = (id: string) => cat.commodities.some((c) => c.id === id);

  // Numbers and switches: one of each key, within its range; only real changes kept.
  const seen = new Set<string>();
  for (const n of list(raw.numbers)) {
    items++;
    const k = n?.key as NumberKey;
    const v = Number(n?.value);
    if (!NUMBER_KEYS.includes(k) || seen.has(k) || !Number.isFinite(v)) {
      dropped++;
      continue;
    }
    seen.add(k);
    const c = clampTo(k, v, u);
    if (c !== u[k]) set(k, c, n.reason);
  }
  for (const s of list(raw.switches)) {
    items++;
    const k = s?.key as SwitchKey;
    const ceiling = (CEILING_SWITCHES as readonly string[]).includes(k) && s?.value === true && !u[k];
    if (!SWITCH_KEYS.includes(k) || seen.has(k) || typeof s.value !== "boolean" || (k === "autoBuy" && s.value && !ctx.canBuild) || ceiling) {
      dropped++;
      continue;
    }
    seen.add(k);
    if (s.value !== u[k]) set(k, s.value, s.reason);
  }
  const g = raw.guns?.policy;
  if (g && g !== "keep") {
    items++;
    if (!GUNS.includes(g)) dropped++;
    else if (g !== u.guns) set("guns", g, raw.guns.reason);
  }

  // Bans: real ids (a charter by alias, kept as its posting id).
  for (const b of list(raw.avoid).slice(0, MAX_BANS)) {
    items++;
    let ref: string | null = null;
    let label = "";
    if (b.kind === "port" && isPort(b.ref)) [ref, label] = [b.ref, `port ${b.ref}`];
    else if (b.kind === "zone" && isZone(b.ref)) [ref, label] = [b.ref, `zone ${b.ref}`];
    else if (b.kind === "good" && isGood(b.ref)) [ref, label] = [b.ref, `${b.ref}`];
    else if (b.kind === "charter") {
      const c = aliases.charters.get(b.ref);
      if (c) [ref, label] = [c.id, `${c.good} -> ${c.port} charter`];
    } else if (b.kind === "contested") [ref, label] = ["", "public charters rivals are due at first"];
    if (ref === null || d.avoid.some((x) => x.kind === b.kind && x.ref === ref)) {
      dropped++;
      continue;
    }
    d.avoid.push({ kind: b.kind, ref, label, reason: text(b.reason) });
  }
  const bans = bansOf(d.avoid, ctx.currentId);
  const portOff = (p: string) => !!bans && (bans.ports.has(p) || bans.zones.has(ctx.hazardZone(p)?.id ?? ""));
  const laneOff = (l: Lane | undefined) => !!bans && !!l && laneBanned(l, bans, ctx.currentId);
  const charterOff = (c: { id: string; port: string; good: string }) => !!bans && (bans.charters.has(ctx.currentId(c.id)) || portOff(c.port) || bans.goods.has(c.good));

  // Lane biases: real refs that the answer's own bans don't contradict.
  for (const b of list(raw.laneBias).slice(0, MAX_BIASES)) {
    items++;
    const factor = Math.min(BIAS_MAX, Math.max(BIAS_MIN, Number(b.factor)));
    let ref: string | undefined;
    let label = "";
    if (b.match === "dest" || b.match === "source" || b.match === "port") {
      if (isPort(b.ref) && ctx.isOpen(b.ref) && !portOff(b.ref)) ref = b.ref;
      label = `${b.match === "dest" ? "to" : b.match === "source" ? "from" : "at"} ${b.ref}`;
    } else if (b.match === "zone") {
      if (isZone(b.ref) && !bans?.zones.has(b.ref)) ref = b.ref;
      label = `through ${b.ref}`;
    } else if (b.match === "good") {
      if (isGood(b.ref) && !bans?.goods.has(b.ref)) ref = b.ref;
      label = b.ref;
    } else if (b.match === "charter") {
      const c = aliases.charters.get(b.ref);
      if (c && !charterOff(c)) [ref, label] = [c.id, `${c.good} -> ${c.port} charter`];
    } else if (b.match === "lane") {
      const key = aliases.lanes.get(b.ref);
      const l = aliases.laneOf?.get(b.ref);
      // Labelled as ship orders are: a lane key holds other companies' lot ids, never shown to the model.
      if (key && !laneOff(l)) [ref, label] = [key, `lane ${l ? `${l.good} ${l.source}->${l.dest}` : b.ref}`];
    }
    if (!ref || !Number.isFinite(factor)) {
      dropped++;
      continue;
    }
    d.biases.push({ match: b.match, ref, factor, label, reason: text(b.reason) });
  }

  // Stall calls: expansion charters only.
  for (const sc of list(raw.stallCalls).slice(0, MAX_STALL_CALLS)) {
    items++;
    const c = aliases.charters.get(sc.charter);
    if (!c || !ctx.renews(c) || (sc.call !== "wait" && sc.call !== "deliver")) {
      dropped++;
      continue;
    }
    d.stallCalls.push({ key: `${c.port}|${c.good}`, call: sc.call, label: `${c.good} -> ${c.port}`, reason: text(sc.reason) });
  }

  // Ship orders: one per ship of ours; holds on at most a third of the fleet (so holds alone can't trip the tripwire).
  const fleet = ctx.fleet.filter((s) => !s.gone);
  let holds = Math.floor(fleet.length / 3);
  for (const o of list(raw.shipOrders).slice(0, MAX_SHIP_ORDERS)) {
    items++;
    const id = aliases.ships.get(o.ship);
    const ship = fleet.find((s) => s.id === id);
    let ref: string | null = null;
    let label = "";
    if (ship && !d.shipOrders.some((x) => x.ship === ship.id)) {
      if (o.order === "lane") {
        const key = aliases.lanes.get(o.ref);
        const l = aliases.laneOf?.get(o.ref);
        if (key && !laneOff(l)) [ref, label] = [key, l ? `${l.good} ${l.source}->${l.dest}` : o.ref];
      } else if (o.order === "charter") {
        const c = aliases.charters.get(o.ref);
        if (c && !c.provisional && c.remaining > 0 && ctx.isOpen(c.port) && !charterOff(c)) [ref, label] = [c.id, `${c.good} -> ${c.port} charter`];
      } else if (o.order === "port") {
        // A quick hull check (the port's own waters); the whole route is checked when it sails.
        const z = ctx.hazardZone(o.ref);
        if (isPort(o.ref) && ctx.isOpen(o.ref) && !portOff(o.ref) && z && RANK[z.zone_class] <= RANK[ship.hull]) [ref, label] = [o.ref, o.ref];
      } else if (o.order === "hold") {
        if (holds > 0) {
          holds--;
          ref = "";
        }
      } else if (o.order === "release") ref = "";
    }
    if (ref === null) {
      dropped++;
      continue;
    }
    d.shipOrders.push({ ship: ship!.id, order: o.order, ref, label, reason: text(o.reason), status: "pending" });
  }

  // The buyer: forbidden classes, then hold or one build (every buyer check still applies to it).
  const buy = raw.buy;
  for (const c of list(buy?.forbid)) {
    items++;
    if (typeof c !== "string" || !cat.ship_classes.some((x) => x.id === c) || d.forbid.includes(c)) {
      dropped++;
      continue;
    }
    d.forbid.push(c);
  }
  if (buy?.action === "hold") {
    items++;
    d.buyHold = text(buy.reason) || "held by the AI";
  } else if (buy?.action === "build") {
    items++;
    const cls = cat.ship_classes.find((c) => c.id === buy.cls);
    const yard = cat.ports.find((p) => p.id === buy.yard);
    if (!cls || cls.phase > ctx.unlockedPhase || d.forbid.includes(cls.id) || !yard?.has_shipyard || !ctx.isOpen(yard.id) || !!bans?.ports.has(yard.id)) dropped++;
    else d.build = { cls: cls.id, yard: yard.id, reason: text(buy.reason), status: "pending" };
  }

  // Naval: an open zone each, under the zone's cap, within the horizon and what the marque budget has left
  // over the last 24 h (reduced in 50 bps steps to what fits). A patrol costs 2 Cr a bps-day; a marque its
  // zone's quoted price (traffic-set): one not quoted yet is sized and checked on its quote when issued
  // (manager runAiNaval). Issued ones can't be withdrawn.
  const budget = Math.min(u.marqueBudgetPence, d.settings.marqueBudgetPence ?? u.marqueBudgetPence);
  let room = budget - ctx.navalSpent24h;
  const maxH = Math.min(NAVAL_TERM_MAX_H, Math.floor((horizonMin * 60_000) / (60 * ctx.gameMinuteMs)));
  for (const [i, n] of list(raw.naval).slice(0, MAX_NAVAL).entries()) {
    items++;
    const z = cat.sea_zones.find((x) => x.id === n.zone);
    const kind = n.kind === "marque" || n.kind === "patrol" ? n.kind : null;
    const asked = Number(n.bps);
    if (!kind || !z || z.phase > ctx.unlockedPhase || maxH < NAVAL_TERM_MIN_H || !Number.isFinite(asked) || d.naval.some((x) => x.zone === z.id)) {
      dropped++;
      continue;
    }
    const hours = Math.min(maxH, Math.max(NAVAL_TERM_MIN_H, Math.round(Number(n.gameHours) || NAVAL_TERM_MIN_H)));
    const live = ctx.zoneBps.get(z.id);
    const capLeft = ZONE_MARQUE_CAP - (kind === "marque" ? (live?.marque ?? 0) : (live?.patrol ?? 0));
    const price = kind === "patrol" ? PATROL_PENCE_PER_BPS_DAY : (ctx.marquePrice.get(z.id) ?? null);
    const fits = price === null ? NAVAL_BPS_MAX : Math.floor(room / (Math.max(price, 0.1) * (hours / 24)) / 50) * 50;
    const bps = Math.min(NAVAL_BPS_MAX, capLeft, fits, Math.max(NAVAL_BPS_MIN, Math.round(asked)));
    const cost = price === null ? 0 : marqueCost(price, bps, hours);
    if (bps < NAVAL_BPS_MIN || cost > room || room < NAVAL_MIN_PENCE) {
      dropped++;
      continue;
    }
    room -= cost;
    d.naval.push({ id: String(i), kind, zone: z.id, bps, gameHours: hours, costPence: cost, reason: text(n.reason), status: "pending" });
  }

  // Money: one loan (for a ship of ours' next load, or a hull), early repayment of loans the digest lists, commissions the
  // digest lists to build. Acted on through every check of the autopilot's own (debt cap, return, payback, cash, margin).
  const money = raw.money;
  const b = money?.borrow;
  if (b && b.use !== "none") {
    items++;
    const pence = Math.round(Number(b.pence));
    const ship = b.use === "load" ? fleet.find((s) => s.id === aliases.ships.get(b.ship)) : undefined;
    if (!Number.isFinite(pence) || pence < LOAN_MIN_PRINCIPAL_PENCE || (b.use !== "load" && b.use !== "hull") || (b.use === "load" && !ship)) dropped++;
    else {
      const load = b.use === "load";
      d.finance.push({
        id: "b",
        kind: load ? "borrow_load" : "borrow_hull",
        ref: ship?.id ?? "",
        pence,
        label: `borrow up to ${crs(pence)} for ${load ? "a ship's next load" : "a new hull"}`,
        reason: text(b.reason),
        status: "pending",
      });
    }
  }
  for (const [i, r] of list(money?.repay).slice(0, MAX_REPAY).entries()) {
    items++;
    const loan = aliases.loans.get(r?.loan);
    if (!loan || d.finance.some((x) => x.kind === "repay" && x.ref === loan.id)) {
      dropped++;
      continue;
    }
    d.finance.push({ id: `r${i}`, kind: "repay", ref: loan.id, pence: 0, label: `repay early a loan owing ${crs(loan.owed)}`, reason: text(r.reason), status: "pending" });
  }
  for (const [i, c] of list(money?.accept).slice(0, MAX_COMMISSIONS).entries()) {
    items++;
    const k = aliases.commissions.get(c?.commission);
    if (!k || k.ours || !!bans?.ports.has(k.yard) || d.finance.some((x) => x.kind === "commission" && x.ref === k.id)) {
      dropped++;
      continue;
    }
    d.finance.push({ id: `k${i}`, kind: "commission", ref: k.id, pence: 0, label: `build a ${k.cls} at ${k.yard} to order for ${crs(k.price)}`, reason: text(c.reason), status: "pending" });
  }

  return { d, horizonMin, items, dropped };
}

const crs = (pence: number) => `${Math.round(pence / 100).toLocaleString("en-GB")} Cr`;
