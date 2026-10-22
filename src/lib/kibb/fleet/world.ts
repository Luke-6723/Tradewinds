/**
 * Shared view of the game world for the fleet autopilot: catalog, server clock, open charters,
 * vaults, remittance fees, cached routes and everything learned about prices (live books where we
 * have presence, coffee-house gossip elsewhere). One instance per company, refreshed by the manager.
 */

import type { KibbClient } from "../client";
import type {
  BankingRegion,
  Catalog,
  CatalogPort,
  CatalogShipClass,
  ContractListing,
  PortDetail,
  PortOrderBook,
  RoutePlan,
  ZoneClass,
} from "../types";

export const ZONE_RANK: Record<ZoneClass, number> = { coastal: 0, regional: 1, oceanic: 2 };

/** A gossip or snapshot price older than this is treated as unknown. */
const PRICE_TTL_MS = 3 * 60 * 60 * 1000;
/** An empty ask side counts as "sold out" for one NPC re-quote (6 game hours; real ms at 60×). */
const SOLD_OUT_MS = 6 * 60 * 1000;
/** A charter last seen live is recalled for this long (2 game days; real ms at 60×). */
const RECALL_MS = 2 * 24 * 60 * 1000;

export interface CharterInfo {
  id: string;
  port: string;
  good: string;
  payPerTon: number;
  remaining: number;
  expiresAt: number | null;
  /** Second-hand news: `remaining` may be out of date, the charter may already be filled. */
  stale: boolean;
  /** Listed to everyone (expansion/Admiralty): absent from an open listing means closed. */
  isPublic: boolean;
  title: string;
}

export interface PriceObs {
  ask: number | null;
  askQty: number;
  bid: number | null;
  bidQty: number;
  stock: number | null;
  customsBps: number | null;
  /** Server time the observation describes. */
  at: number;
  /** From a live book (true) or gossip/snapshot (false). */
  live: boolean;
}

function toCharters(list: ContractListing[]): CharterInfo[] {
  return list
    .filter((c) => c.contract_type === "charter" && c.status === "open" && c.remaining_quantity > 0 && c.commodity_id)
    .map((c) => ({
      id: c.id,
      port: c.origin_port_id,
      good: c.commodity_id!,
      payPerTon: c.reward_per_ton_pence ?? Math.floor(c.reward_pence / Math.max(1, c.quantity_required)),
      remaining: c.remaining_quantity,
      expiresAt: c.expires_at ? Date.parse(c.expires_at) : null,
      stale: c.stale,
      isPublic: c.is_public,
      title: c.title ?? `${c.commodity_id} to ${c.origin_port_id}`,
    }));
}

export class World {
  catalog!: Catalog;
  unlockedPhase = 1;
  timeScale = 60;
  paused = false;
  /** Server clock minus local clock, ms. */
  skewMs = 0;
  charters: CharterInfo[] = [];
  vaults = new Map<BankingRegion, number>();
  private rates = new Map<string, number>();
  private prices = new Map<string, PriceObs>();
  /** Last live copy of each charter seen live, for recall when it drops out of a listing. */
  private readonly liveSeen = new Map<string, { c: CharterInfo; seenAt: number }>();
  /** When each port's charters were last listed live on arrival (local ms). */
  private readonly mergedAt = new Map<string, number>();
  /** Charters we saw filled or closed. */
  private readonly closed = new Set<string>();
  private routes = new Map<string, Promise<RoutePlan>>();

  constructor(readonly client: KibbClient) {}

  /** Current server time. */
  now(): number {
    return Date.now() + this.skewMs;
  }

  /** Real milliseconds per game minute (1 s at 60×). */
  get gameMinuteMs(): number {
    return 60_000 / this.timeScale;
  }

  async init(): Promise<void> {
    this.catalog = await this.client.catalog();
    await this.refresh();
  }

  /** Clock, charters, fees and vaults. */
  async refresh(): Promise<void> {
    const t0 = Date.now();
    const clock = await this.client.clock();
    const t1 = Date.now();
    this.skewMs = Date.parse(clock.real_utc) - (t0 + t1) / 2;
    this.unlockedPhase = clock.unlocked_phase;
    this.timeScale = clock.calendar.time_scale || 60;
    this.paused = clock.paused;

    const asked = Date.now();
    const [list, rates] = await Promise.all([
      this.client.listContracts({ contract_type: "charter", status: "open", limit: 200 }),
      this.client.rates(),
      this.refreshVaults(),
    ]);
    const fresh = toCharters(list).filter((c) => !this.closed.has(c.id));
    // Ports re-listed live on arrival while this request was in flight keep that newer view.
    const newer = new Set([...this.mergedAt].filter(([, t]) => t > asked).map(([p]) => p));
    this.remember(fresh.filter((c) => !newer.has(c.port)));
    // Public charters are listed to everyone: one missing from a complete listing is closed.
    if (list.length < 200) {
      const ids = new Set(fresh.map((c) => c.id));
      for (const [id, { c }] of this.liveSeen) if (c.isPublic && !newer.has(c.port) && !ids.has(id)) this.liveSeen.delete(id);
    }
    this.charters = this.withRecalled([
      ...fresh.filter((c) => !newer.has(c.port)),
      ...this.charters.filter((c) => newer.has(c.port)),
    ]);
    this.rates = new Map(rates.map((r) => [`${r.from_region}>${r.to_region}`, r.fee_bps]));
  }

  /** Replaces what we know about one port's charters with a live listing taken there. */
  mergePortCharters(port: string, list: ContractListing[]): void {
    const fresh = toCharters(list.filter((c) => c.origin_port_id === port)).filter((c) => !this.closed.has(c.id));
    // Taken with our ship in port, so the listing is complete there: missing means closed.
    const ids = new Set(fresh.map((c) => c.id));
    for (const [id, { c }] of this.liveSeen) if (c.port === port && !ids.has(id)) this.liveSeen.delete(id);
    this.remember(fresh);
    this.mergedAt.set(port, Date.now());
    this.charters = this.withRecalled([...this.charters.filter((c) => c.port !== port), ...fresh]);
  }

  /** A charter was filled or closed: drop it now and ignore it in listings already in flight. */
  markClosed(id: string): void {
    this.closed.add(id);
    this.liveSeen.delete(id);
    this.charters = this.charters.filter((c) => c.id !== id);
  }

  private remember(list: CharterInfo[]): void {
    const now = this.now();
    // Keep the object itself: deliveries update its `remaining` in place.
    for (const c of list) if (!c.stale) this.liveSeen.set(c.id, { c, seenAt: now });
  }

  /**
   * Non-public charters are listed live only while we have presence at their port. Keep the last
   * live copy of one we saw (for a while, until it expires or is closed) where a listing now shows
   * it only as gossip or not at all, so a ship already bound for it doesn't lose it on the way.
   */
  private withRecalled(list: CharterInfo[]): CharterInfo[] {
    const now = this.now();
    const live = new Set(list.filter((c) => !c.stale).map((c) => c.id));
    const out = list.filter((c) => !(c.stale && this.liveSeen.has(c.id)));
    for (const [id, { c, seenAt }] of this.liveSeen) {
      const expired = c.expiresAt !== null && c.expiresAt < now;
      if (expired || c.remaining <= 0 || now - seenAt > RECALL_MS * (60 / this.timeScale)) {
        this.liveSeen.delete(id);
        continue;
      }
      if (!live.has(id)) out.push(c);
    }
    return out;
  }

  async refreshVaults(): Promise<void> {
    const { vaults } = await this.client.vaults();
    this.vaults = new Map(vaults.filter((v) => v.account_type === "vault").map((v) => [v.banking_region, v.balance_pence]));
  }

  // ── Catalog lookups ─────────────────────────────────────────────────────────

  port(id: string): CatalogPort | undefined {
    return this.catalog.ports.find((p) => p.id === id);
  }

  shipClass(id: string): CatalogShipClass | undefined {
    return this.catalog.ship_classes.find((c) => c.id === id);
  }

  region(portId: string): BankingRegion {
    return this.port(portId)?.banking_region ?? "channel";
  }

  isOpen(portId: string): boolean {
    return (this.port(portId)?.phase ?? 99) <= this.unlockedPhase;
  }

  /** Ports that produce or manufacture the good: where it is cheap. */
  sourcesOf(good: string): string[] {
    return this.catalog.ports
      .filter((p) => p.phase <= this.unlockedPhase && [...(p.produces ?? []), ...(p.manufactures ?? [])].includes(good))
      .map((p) => p.id);
  }

  /** Whether the port has a market for the good at all. */
  trades(portId: string, good: string): boolean {
    const p = this.port(portId);
    if (!p) return false;
    return good === "provisions" || [...(p.produces ?? []), ...(p.manufactures ?? []), ...(p.imports ?? [])].includes(good);
  }

  basePrice(good: string): number {
    return this.catalog.commodities.find((c) => c.id === good)?.base_price_pence ?? 0;
  }

  /** Extra berth lock per ton handled: 1 game minute at hubs, 2 elsewhere. */
  handlingMsPerTon(portId: string): number {
    return (this.port(portId)?.is_hub ? 1 : 2) * this.gameMinuteMs;
  }

  /** Real ms to sail `nm` at `knots`. */
  sailMs(nm: number, knots: number): number {
    return (nm / Math.max(knots, 0.1)) * 60 * this.gameMinuteMs;
  }

  // ── Routes ──────────────────────────────────────────────────────────────────

  route(from: string, to: string, shipClass: string): Promise<RoutePlan> {
    const key = `${from}>${to}>${shipClass}`;
    let p = this.routes.get(key);
    if (!p) {
      p = this.client.route(from, to, shipClass);
      p.catch(() => this.routes.delete(key));
      this.routes.set(key, p);
    }
    return p;
  }

  /**
   * True when a hull of class `hull` is rated for every leg: the lane's own class and the class of
   * the sea zone each leg ends in (hazards roll for that zone).
   */
  routeRated(plan: RoutePlan, hull: ZoneClass): boolean {
    const max = ZONE_RANK[hull];
    return plan.legs.every((l) => {
      const zone = this.catalog.sea_zones.find((z) => z.id === l.to_node);
      return ZONE_RANK[l.edge_class] <= max && (!zone || ZONE_RANK[zone.zone_class] <= max);
    });
  }

  // ── Prices ──────────────────────────────────────────────────────────────────

  observeBook(book: PortOrderBook): void {
    const at = book.as_of ? Date.parse(book.as_of) : this.now();
    const live = book.visibility === "quay" || book.visibility === "counting_house";
    for (const b of book.books) {
      this.prices.set(`${book.port_id}|${b.commodity_id}`, {
        ask: b.best_ask?.price_pence ?? null,
        askQty: b.best_ask?.quantity ?? 0,
        bid: b.best_bid?.price_pence ?? null,
        bidQty: b.best_bid?.quantity ?? 0,
        stock: b.depth?.npc_current_stock ?? null,
        customsBps: book.customs_bps,
        at,
        live,
      });
    }
  }

  /** Learns other ports' prices from the coffee-house gossip at a quay we stand on. */
  observeGossip(detail: PortDetail): void {
    for (const g of detail.coffee_house_gossip ?? []) {
      const at = this.now() - g.age_seconds * 1000;
      for (const c of g.commodities) {
        const key = `${g.subject_port_id}|${c.commodity_id}`;
        const prev = this.prices.get(key);
        if (prev && prev.at >= at) continue;
        this.prices.set(key, {
          ask: c.best_ask_pence ?? null,
          askQty: 0,
          bid: c.best_bid_pence ?? null,
          bidQty: 0,
          stock: c.current_stock,
          customsBps: prev?.customsBps ?? null,
          at,
          live: false,
        });
      }
    }
  }

  price(portId: string, good: string): PriceObs | undefined {
    const p = this.prices.get(`${portId}|${good}`);
    return p && this.now() - p.at < PRICE_TTL_MS ? p : undefined;
  }

  /**
   * Best guess at the ask: last seen, else base price (a producer sits near base when stocked).
   * Null while a recent look found nothing on offer (sold out until the ladder re-quotes).
   */
  estAsk(portId: string, good: string): { ask: number; known: boolean } | null {
    const p = this.price(portId, good);
    if (p && p.ask === null && this.now() - p.at < SOLD_OUT_MS * (60 / this.timeScale)) return null;
    if (p?.ask) return { ask: p.ask, known: true };
    return { ask: Math.round(this.basePrice(good) * 1.05), known: false };
  }

  /** Records that a port had nothing of this good on offer just now. */
  observeNoAsk(portId: string, good: string): void {
    const key = `${portId}|${good}`;
    const prev = this.prices.get(key);
    this.prices.set(key, {
      ask: null,
      askQty: 0,
      bid: prev?.bid ?? null,
      bidQty: prev?.bidQty ?? 0,
      stock: 0,
      customsBps: prev?.customsBps ?? null,
      at: this.now(),
      live: true,
    });
  }

  customsBps(portId: string): number {
    return this.prices.get(`${portId}|provisions`)?.customsBps ?? this.port(portId)?.customs_bps ?? 300;
  }

  // ── Money ───────────────────────────────────────────────────────────────────

  remitBps(from: BankingRegion, to: BankingRegion): number {
    return from === to ? 0 : (this.rates.get(`${from}>${to}`) ?? 200);
  }

  vault(region: BankingRegion): number {
    return this.vaults.get(region) ?? 0;
  }

  totalCash(): number {
    let n = 0;
    for (const v of this.vaults.values()) n += Math.max(0, v);
    return n;
  }

  /** Fleet sprawl upkeep per game day for this much coastal/regional hull tonnage. */
  sprawlPerDay(tons: number): number {
    return tons <= 40 ? 0 : Math.round(4_500 * Math.pow((tons - 40) / 100, 1.45));
  }

  /** Extra upkeep per real hour from adding `addTons` of hull to a fleet of `fleetTons`. */
  upkeepDeltaPerHour(fleetTons: number, addTons: number, oceanic = false): number {
    const gameDaysPerHour = this.timeScale / 24;
    const perDay = oceanic ? addTons * 100 : this.sprawlPerDay(fleetTons + addTons) - this.sprawlPerDay(fleetTons);
    return perDay * gameDaysPerHour;
  }
}
