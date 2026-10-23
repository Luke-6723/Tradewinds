/**
 * Shared view of the game world for the fleet autopilot: catalog, server clock, open charters,
 * vaults, remittance fees, cached routes and everything learned about prices (live books where we
 * have presence, coffee-house gossip elsewhere). One instance per company, refreshed by the manager.
 */

import type { KibbClient } from "../client";
import { RivalTracker } from "../rivals";
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
/** A pirate interception or storm hit destroys this share of every cargo stack. */
const HIT_LOSS = 0.25;
/** Assumed cut in interception odds per gun ("cut sharply by cannons"; the formula isn't published). */
const GUN_DETERRENCE = 0.5;
/**
 * A tier's completion bonus is 12% of its value, split by the value each company delivered. Shares
 * value a ton at its charter's premium-inclusive rate (base price × premium), which the live share
 * movements bear out; this is the fallback rate when the pool can't be projected.
 */
const EXPANSION_BONUS_SHARE = 0.12;

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
  /** For gossip: server time the news describes (it may since have been filled). */
  newsAt: number | null;
}

/** An open freight lot we can see (listed only at its origin port, to companies present there). */
export interface FreightInfo {
  id: string;
  origin: string;
  dest: string;
  good: string;
  tons: number;
  reward: number;
  collateral: number;
  expiresAt: number | null;
  issuer: string | null;
}

function toFreight(list: ContractListing[]): FreightInfo[] {
  return list
    .filter((c) => c.contract_type === "freight" && c.status === "open" && !c.stale && c.dest_port_id && c.commodity_id)
    .map((c) => ({
      id: c.id,
      origin: c.origin_port_id,
      dest: c.dest_port_id!,
      good: c.commodity_id!,
      tons: c.quantity_required,
      reward: c.reward_pence,
      collateral: c.collateral_pence,
      expiresAt: c.expires_at ? Date.parse(c.expires_at) : null,
      issuer: c.issuer_company_id ?? null,
    }));
}

export interface PriceObs {
  ask: number | null;
  askQty: number;
  bid: number | null;
  bidQty: number;
  /** Tons the visible bid ladder takes in all (live books with depth only). */
  bidDepth: number | null;
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
      newsAt: c.stale && c.gossip?.news_as_of ? Date.parse(c.gossip.news_as_of) : null,
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
  /** Open freight lots we can see, at ports where we have presence. */
  freight: FreightInfo[] = [];
  /** Our company (to skip freight we posted ourselves). */
  companyId: string | null = null;
  /** Other companies' ships seen at ports where we have presence. */
  readonly rivals = new RivalTracker();
  vaults = new Map<BankingRegion, number>();
  /** Live net piracy per sea zone (bps): base + letters of marque − naval patrols. */
  piracy = new Map<string, number>();
  /** Charters of the expansion tier in play (their deliveries earn a share of its completion bonus). */
  expansionCharters = new Set<string>();
  /** Tons the tier still needs; tons beyond that arrive after it completes and earn no bonus. */
  expansionTonsLeft = 0;
  /** Share value of a ton per expansion charter (pence: base price × premium), and the pool's rate on it. */
  private expansionValue = new Map<string, number>();
  private expansionRate = EXPANSION_BONUS_SHARE;
  private rates = new Map<string, number>();
  private prices = new Map<string, PriceObs>();
  /** Last live copy of each charter seen live, for recall when it drops out of a listing. */
  private readonly liveSeen = new Map<string, { c: CharterInfo; seenAt: number }>();
  /** When each port's charters were last listed live on arrival (local ms). */
  private readonly mergedAt = new Map<string, number>();
  /** Charters we saw filled or closed. */
  private readonly closed = new Set<string>();
  private routes = new Map<string, Promise<RoutePlan>>();
  private routeSlots = 8;
  private portIndex: Map<string, CatalogPort> | null = null;
  private readonly routeWaiters: Array<() => void> = [];

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
    const [listing, freight, rates, zones, expansion] = await Promise.all([
      this.client.contractPages({ contract_type: "charter", status: "open" }),
      this.client.contractPages({ contract_type: "freight", status: "open" }).catch(() => null),
      this.client.rates(),
      this.client.zones().catch(() => null),
      this.client.expansion().catch(() => null),
      this.refreshVaults(),
    ]);
    const list = listing.items;
    if (freight) this.freight = toFreight(freight.items);
    if (zones) this.piracy = new Map(zones.map((z) => [z.sea_zone_id, z.net_piracy_bps]));
    if (expansion) {
      const tier = expansion.current_tier;
      this.expansionCharters = new Set(tier && !tier.completed ? tier.charters.map((c) => c.contract_id) : []);
      this.expansionTonsLeft = tier && !tier.completed ? tier.tons_remaining : 0;
      if (tier && !tier.completed) {
        // Project the tier's final value: what is delivered, plus the tons still needed at the mix
        // delivered so far. The pool over that is the bonus per unit of value.
        const value = new Map(tier.charters.map((c) => [c.contract_id, this.basePrice(c.commodity_id) * (c.premium_bps / 10_000)]));
        let delivered = 0;
        let tons = 0;
        for (const c of tier.charters) {
          const t = c.tons_delivered_total ?? c.quantity_delivered;
          delivered += t * value.get(c.contract_id)!;
          tons += t;
        }
        const avg = tons > 0 ? delivered / tons : [...value.values()].reduce((n, v) => n + v, 0) / Math.max(value.size, 1);
        const projected = delivered + tier.tons_remaining * avg;
        this.expansionValue = value;
        this.expansionRate = projected > 0 ? Math.min(0.2, Math.max(0.06, tier.completion_bonus_pence / projected)) : EXPANSION_BONUS_SHARE;
      }
    }
    const fresh = toCharters(list).filter((c) => !this.closed.has(c.id));
    // Ports re-listed live on arrival while this request was in flight keep that newer view.
    const newer = new Set([...this.mergedAt].filter(([, t]) => t > asked).map(([p]) => p));
    this.remember(fresh.filter((c) => !newer.has(c.port)));
    // Public charters are listed to everyone: one missing from a complete listing is closed.
    if (listing.complete) {
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

  /** Replaces the open freight we know of at one port with a listing taken there. */
  mergePortFreight(port: string, list: ContractListing[]): void {
    this.freight = [...this.freight.filter((f) => f.origin !== port), ...toFreight(list.filter((c) => c.origin_port_id === port))];
  }

  /** A freight lot was taken (by us or anyone): stop planning on it. */
  dropFreight(id: string): void {
    this.freight = this.freight.filter((f) => f.id !== id);
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
    if (!this.portIndex || this.portIndex.size !== this.catalog.ports.length) this.portIndex = new Map(this.catalog.ports.map((p) => [p.id, p]));
    return this.portIndex.get(id);
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

  /**
   * Ports to buy the good at: the open ports that make it, plus any open port trading it where an
   * ask has been seen lately (an importer with a glut can undercut the producers).
   */
  sellersOf(good: string): string[] {
    const out = new Set(this.sourcesOf(good));
    for (const p of this.catalog.ports) {
      if (p.phase <= this.unlockedPhase && this.trades(p.id, good) && this.price(p.id, good)?.ask) out.add(p.id);
    }
    return [...out];
  }

  /** Goods on sale at a port: what it makes, plus anything with an ask seen there lately. */
  goodsAt(portId: string): string[] {
    const p = this.port(portId);
    if (!p) return [];
    const out = new Set([...(p.produces ?? []), ...(p.manufactures ?? [])]);
    for (const c of this.catalog.commodities) if (this.trades(portId, c.id) && this.price(portId, c.id)?.ask) out.add(c.id);
    return [...out];
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
      p = this.fetchRoute(from, to, shipClass);
      p.catch(() => this.routes.delete(key));
      this.routes.set(key, p);
    }
    return p;
  }

  /** At most a few route lookups in flight: a first planning pass asks for hundreds. */
  private async fetchRoute(from: string, to: string, shipClass: string): Promise<RoutePlan> {
    while (this.routeSlots === 0) await new Promise<void>((r) => this.routeWaiters.push(r));
    this.routeSlots--;
    try {
      return await this.client.route(from, to, shipClass);
    } finally {
      this.routeSlots++;
      this.routeWaiters.shift()?.();
    }
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

  /** Phase-completion bonus a ton delivered to this charter is expected to earn (pence, unweighted). */
  charterBonus(c: { id: string; good: string }): number {
    if (!this.expansionCharters.has(c.id)) return 0;
    return Math.round((this.expansionValue.get(c.id) ?? this.basePrice(c.good) * 1.3) * this.expansionRate);
  }

  /**
   * Expected share of the cargo lost to pirates on a passage. Each leg rolls for the zone it ends
   * in (a port's own zone for the last leg); the guide's prize-money rule of thumb implies a zone's
   * net piracy acts as a rate per game day at sea, so longer legs count for more. A hit destroys a
   * quarter of every stack; guns deter. An estimate for ranking lanes, capped at half the load.
   */
  piracyLoss(plan: RoutePlan, guns: number, knots: number): number {
    const dayMs = 24 * 60 * this.gameMinuteMs;
    let hits = 0;
    for (const l of plan.legs) {
      const bps = this.piracy.get(l.to_node) ?? this.piracy.get(this.port(l.to_node)?.sea_zone_id ?? "");
      if (bps) hits += Math.min(1, (bps / 10_000) * (this.sailMs(l.distance_nm, knots) / dayMs));
    }
    return Math.min(0.5, (hits * HIT_LOSS) / (1 + guns * GUN_DETERRENCE));
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
        bidDepth: b.depth ? b.depth.bids.reduce((n, l) => n + l.remaining_quantity, 0) : null,
        stock: b.depth?.npc_current_stock ?? null,
        customsBps: book.customs_bps,
        at,
        live,
      });
    }
  }

  /** Learns other ports' prices from the coffee-house gossip at a quay we stand on, and who sailed there. */
  observeGossip(detail: PortDetail): void {
    this.rivals.addNotices(detail.recent_sailings);
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
          bidDepth: null,
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

  /**
   * Records that a port had nothing of this good on offer just now. The bid is what the same book
   * showed (an older bid would otherwise be restamped as fresh).
   */
  observeNoAsk(portId: string, good: string, bid: { price_pence: number; quantity: number } | null = null): void {
    const key = `${portId}|${good}`;
    const prev = this.prices.get(key);
    this.prices.set(key, {
      ask: null,
      askQty: 0,
      bid: bid?.price_pence ?? null,
      bidQty: bid?.quantity ?? 0,
      bidDepth: null,
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
