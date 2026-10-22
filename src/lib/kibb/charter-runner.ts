/**
 * Charter runner for the kibb.io Tradewinds API.
 *
 * Shuttles one ship between a source port and a charter port: buys the charter's goods at the
 * source, carries them in, delivers them to the best-paying open charter, and goes back for more.
 * Defaults run the Le Havre → Portsmouth provisions expansion charter with the starter hoy.
 *
 * Stateless between ticks: every tick re-reads the ship, books and charters over REST and acts on
 * what it finds, so the runner can be stopped and restarted at any point of the loop.
 *
 * Used in-process by the dashboard (see runner-registry.ts) and by the CLI worker
 * (src/workers/kibb-charter.ts).
 */

import { KibbClient, KIBB_DEFAULT_URL, isApiError } from "./client";
import type { ApiKeyScope, Catalog, RoutePlan, ShipResult, ZoneClass } from "./types";

// ── Config & state ────────────────────────────────────────────────────────────

/** User-tunable settings, persisted by the dashboard. */
export interface CharterSettings {
  /** Ship to run; empty means the company's first ship. */
  shipId: string;
  /** Where the goods are bought. */
  sourcePort: string;
  /** Where the charter takes delivery. */
  charterPort: string;
  commodity: string;
  /** Minimum profit per ton after customs. */
  minMarginPence: number;
  /** Cash left in the vault for dues and stores. */
  reservePence: number;
}

export const DEFAULT_CHARTER_SETTINGS: CharterSettings = {
  shipId: "",
  sourcePort: "le_havre",
  charterPort: "portsmouth",
  commodity: "provisions",
  minMarginPence: 2_000,
  reservePence: 100_000,
};

export interface CharterRunnerConfig extends CharterSettings {
  apiKey: string;
  baseUrl?: string;
  /** Log writes instead of sending them. */
  dryRun?: boolean;
}

export interface CharterRunnerStats {
  trips: number;
  deliveredTons: number;
  rewardPence: number;
  spentPence: number;
}

export interface RunnerLogLine {
  at: string;
  msg: string;
}

export type CharterRunnerStatus = "stopped" | "starting" | "running" | "failed";

export interface CharterRunnerState {
  status: CharterRunnerStatus;
  shipId: string | null;
  shipName: string | null;
  startedAt: string | null;
  nextTickAt: string | null;
  error: string | null;
  stats: CharterRunnerStats;
  /** Most recent last. */
  log: RunnerLogLine[];
}

// ── Tuning ────────────────────────────────────────────────────────────────────

const STORES_COMMODITY = "provisions";
/** Stores kept above the round trip's safe figure, in game days of eating in port. */
const STORES_BUFFER_PORT_DAYS = 2;
/** Don't buy against a charter that closes sooner than this (real time). */
const CHARTER_EXPIRY_MARGIN_MS = 20 * 60_000;

const POLL_MS              = 15_000;
const MAX_SAILING_SLEEP_MS = 60_000;
const REQUOTE_WAIT_MS      = 2 * 60_000; // NPC ladders re-quote every 6 game hours (6 real minutes at 60x)
const NO_CHARTER_WAIT_MS   = 5 * 60_000;
const ERROR_BACKOFF_MS     = 30_000;
const LOG_LIMIT            = 200;

const REQUIRED_SCOPES: ApiKeyScope[] = ["read", "fleet_navigate", "fleet_cargo", "market_spot", "market_derivatives"];
const HULL_RANK: Record<ZoneClass, number> = { coastal: 0, regional: 1, oceanic: 2 };
const FATAL_CODES = ["account_suspended", "company_frozen"];

// ── Helpers ───────────────────────────────────────────────────────────────────

export const cr = (pence: number) => `${(pence / 100).toLocaleString("en-GB", { maximumFractionDigits: 2 })} Cr`;
const secs = (ms: number) => `${Math.max(0, Math.round(ms / 1000))}s`;
const clampSleep = (ms: number) => Math.min(Math.max(ms, 2_000), MAX_SAILING_SLEEP_MS);

/** Stops the runner: bad key, ship sunk, unsailable route. */
class RunnerFatal extends Error {}

interface Charter {
  id: string;
  title: string;
  rewardPerTon: number;
  remaining: number;
  stale: boolean;
  expiresAt: number | null;
}

// ── Runner ────────────────────────────────────────────────────────────────────

export class CharterRunner {
  readonly cfg: CharterRunnerConfig;
  private readonly client: KibbClient;
  private readonly onLog?: (line: RunnerLogLine) => void;

  private status: CharterRunnerStatus = "stopped";
  private error: string | null = null;
  private startedAt: string | null = null;
  private nextTickAt: string | null = null;
  private logLines: RunnerLogLine[] = [];
  private stats: CharterRunnerStats = { trips: 0, deliveredTons: 0, rewardPence: 0, spentPence: 0 };

  private stopRequested = false;
  private wake: (() => void) | null = null;
  private loop: Promise<void> | null = null;

  private catalog!: Catalog;
  private shipId = "";
  private shipName = "";
  private shipClass = "";
  private hull: ZoneClass = "coastal";
  private readonly routeCache = new Map<string, RoutePlan>();
  /** Berth stays (`ship:port:berthed_at`) already traded at. Trade once, then only retry depart. */
  private readonly tradedAt = new Set<string>();

  constructor(
    cfg: CharterRunnerConfig,
    opts: {
      onLog?: (line: RunnerLogLine) => void;
      /** Totals and log from a previous runner for the same company, so a restart keeps them. */
      carryOver?: Pick<CharterRunnerState, "stats" | "log">;
    } = {},
  ) {
    this.cfg = cfg;
    this.client = new KibbClient({ baseUrl: cfg.baseUrl ?? KIBB_DEFAULT_URL, apiKey: cfg.apiKey });
    this.onLog = opts.onLog;
    if (opts.carryOver) {
      this.stats = { ...opts.carryOver.stats };
      this.logLines = opts.carryOver.log.slice(-LOG_LIMIT);
    }
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  get state(): CharterRunnerState {
    return {
      status: this.status,
      shipId: this.shipId || null,
      shipName: this.shipName || null,
      startedAt: this.startedAt,
      nextTickAt: this.nextTickAt,
      error: this.error,
      stats: { ...this.stats },
      log: [...this.logLines],
    };
  }

  /** Starts the loop in the background. Resolves `done` when it stops. */
  start(): void {
    if (this.loop) return;
    this.stopRequested = false;
    this.error = null;
    this.status = "starting";
    this.startedAt = new Date().toISOString();
    this.loop = this.run().finally(() => {
      this.loop = null;
      this.nextTickAt = null;
    });
  }

  /** Requests a stop and waits for the current tick to finish. */
  async stop(): Promise<void> {
    this.stopRequested = true;
    this.wake?.();
    await this.loop;
  }

  /** Resolves when the loop has stopped (or immediately if not running). */
  get done(): Promise<void> {
    return this.loop ?? Promise.resolve();
  }

  /** Startup checks plus one tick, for previewing what the runner would do. */
  async preview(): Promise<void> {
    await this.init();
    await this.tick();
  }

  private async run(): Promise<void> {
    try {
      await this.init();
      this.status = "running";
      while (!this.stopRequested) {
        let wait: number;
        try {
          wait = await this.tick();
        } catch (e) {
          if (e instanceof RunnerFatal) throw e;
          if (isApiError(e) && (e.status === 401 || FATAL_CODES.includes(e.code ?? ""))) throw new RunnerFatal(e.message);
          this.log(`tick failed: ${(e as Error).message}`);
          wait = ERROR_BACKOFF_MS;
        }
        await this.sleep(wait);
      }
      this.status = "stopped";
      this.log("stopped");
    } catch (e) {
      this.status = "failed";
      this.error = (e as Error).message;
      this.log(`FATAL: ${this.error}`);
    }
  }

  private sleep(ms: number): Promise<void> {
    if (this.stopRequested) return Promise.resolve();
    this.nextTickAt = new Date(Date.now() + ms).toISOString();
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      const self = this;
      function done() {
        clearTimeout(timer);
        self.wake = null;
        resolve();
      }
      this.wake = done;
    });
  }

  private log(msg: string): void {
    const line = { at: new Date().toISOString(), msg };
    this.logLines.push(line);
    if (this.logLines.length > LOG_LIMIT) this.logLines.splice(0, this.logLines.length - LOG_LIMIT);
    this.onLog?.(line);
  }

  private fail(msg: string): never {
    throw new RunnerFatal(msg);
  }

  /** Runs a write, or only logs it in dry-run mode (returns null). */
  private async act<T>(label: string, fn: () => Promise<T>): Promise<T | null> {
    if (this.cfg.dryRun) {
      this.log(`[dry-run] would ${label}`);
      return null;
    }
    this.log(label);
    return fn();
  }

  // ── Lookups ─────────────────────────────────────────────────────────────────

  private held(r: ShipResult): number {
    return r.cargo_manifest[this.cfg.commodity] ?? 0;
  }

  private async route(from: string, to: string): Promise<RoutePlan> {
    const key = `${from}>${to}`;
    let plan = this.routeCache.get(key);
    if (!plan) {
      plan = await this.client.route(from, to, this.shipClass);
      this.routeCache.set(key, plan);
    }
    return plan;
  }

  /** True when every leg is water this ship's hull is rated for. */
  private routeIsRated(plan: RoutePlan): boolean {
    return plan.legs.every((l) => HULL_RANK[l.edge_class] <= HULL_RANK[this.hull]);
  }

  /** Cash in the port's banking region, less the reserve. */
  private async spendable(portId: string): Promise<number> {
    const region = this.catalog.ports.find((p) => p.id === portId)?.banking_region;
    const { vaults } = await this.client.vaults();
    const vault = vaults.find((v) => v.account_type === "vault" && v.banking_region === region);
    return (vault?.balance_pence ?? 0) - this.cfg.reservePence;
  }

  /** Open charters for the commodity at the charter port, best pay first. */
  private async openCharters(): Promise<Charter[]> {
    const { charterPort, commodity } = this.cfg;
    const list = await this.client.listContracts({
      contract_type: "charter",
      port_id: charterPort,
      commodity_id: commodity,
      status: "open",
      limit: 200,
    });
    return list
      .filter((c) => c.origin_port_id === charterPort && c.commodity_id === commodity && c.status === "open" && c.remaining_quantity > 0)
      .map((c) => ({
        id: c.id,
        title: c.title ?? c.id.slice(0, 8),
        rewardPerTon: c.reward_per_ton_pence ?? Math.floor(c.reward_pence / Math.max(1, c.quantity_required)),
        remaining: c.remaining_quantity,
        stale: c.stale,
        expiresAt: c.expires_at ? Date.parse(c.expires_at) : null,
      }))
      .sort((a, b) => b.rewardPerTon - a.rewardPerTon);
  }

  /** Stores to hold at `port`: the safe figure for each leg left in the loop plus a port buffer. */
  private async storesTarget(port: string): Promise<number> {
    const { sourcePort, charterPort } = this.cfg;
    const out = await this.route(sourcePort, charterPort);
    const back = await this.route(charterPort, sourcePort);
    let need = out.safe_provisions_tons + back.safe_provisions_tons + STORES_BUFFER_PORT_DAYS * out.port_provisions_tons_per_day;
    if (port !== sourcePort && port !== charterPort) need += (await this.route(port, sourcePort)).safe_provisions_tons;
    return need;
  }

  // ── Actions ─────────────────────────────────────────────────────────────────

  private async dockOrWait(r: ShipResult): Promise<number> {
    const port = r.ship.current_port_id;
    if (r.ship.dock_queued_at) {
      this.log(`queued for a berth at ${port}`);
      return POLL_MS;
    }
    const res = await this.act(`dock at ${port}`, () => this.client.dock(this.shipId));
    if (res) this.log(`dock: ${res.status}${res.queue_position ? ` (queue #${res.queue_position})` : ""}`);
    return 2_000;
  }

  /**
   * Moves whole tons of surplus stores into cargo. Never at the charter port: unprovisioned stores
   * count as loaded where they come out, so they only fill a charter after being carried in.
   */
  private async trimStores(r: ShipResult, target: number): Promise<void> {
    const surplus = Math.floor(r.stores.provisions_tons - target);
    if (surplus < 1 || r.ship.current_port_id === this.cfg.charterPort) return;
    await this.act(
      `unprovision ${surplus} t of surplus stores into cargo (${r.stores.provisions_tons.toFixed(2)} t → keep ${target.toFixed(2)} t)`,
      () => this.client.unprovision(this.shipId, surplus, "cargo"),
    );
  }

  /** Buys whole tons of provisions straight into the stores. Ship must be berthed. */
  private async topUpStores(r: ShipResult, target: number): Promise<void> {
    const have = r.stores.provisions_tons;
    if (have >= target) return;
    const tons = Math.max(1, Math.ceil(target - have));
    const port = r.ship.current_port_id!;
    const book = await this.client.book(port, STORES_COMMODITY);
    const ask = book.books.find((b) => b.commodity_id === STORES_COMMODITY)?.best_ask;
    if (!ask) {
      this.log(`no ${STORES_COMMODITY} offered at ${port} for stores (have ${have.toFixed(2)} t, want ${target.toFixed(2)} t)`);
      return;
    }
    const res = await this.act(`buy ${tons} t into stores at ${port} (best ask ${cr(ask.price_pence)}/t)`, () =>
      this.client.placeOrder({
        port_id: port,
        commodity_id: STORES_COMMODITY,
        side: "bid",
        time_in_force: "ioc",
        price_pence: Math.ceil(ask.price_pence * 1.1),
        quantity: tons,
        ship_id: this.shipId,
        into_stores: true,
      }),
    );
    if (res) {
      this.stats.spentPence += res.total_gross_pence + res.customs_duty_pence;
      this.log(`stores: filled ${res.filled_quantity}/${tons} t for ${cr(res.total_gross_pence + res.customs_duty_pence)}`);
    }
  }

  /** Buys the commodity into the hold at the source port, capped by the charter's pay. Returns tons bought. */
  private async buyCargo(r: ShipResult, charters: Charter[]): Promise<number> {
    const { sourcePort, commodity, minMarginPence, reservePence } = this.cfg;
    const best = charters[0];
    const room = Math.min(
      r.effective_hold_capacity_tons - r.cargo_used_tons,
      charters.reduce((n, c) => n + c.remaining, 0) - this.held(r),
    );
    this.log(
      `hold: effective ${r.effective_hold_capacity_tons} t, used ${r.cargo_used_tons} t, stores ${r.stores.provisions_tons.toFixed(2)} t, ` +
        `${commodity} aboard ${this.held(r)} t → room ${room} t`,
    );
    if (room <= 0) return 0;

    const book = await this.client.book(sourcePort, commodity);
    const ask = book.books.find((b) => b.commodity_id === commodity)?.best_ask;
    // Highest price per ton that still clears the margin after the buyer's customs.
    const limit = Math.floor(((best.rewardPerTon - minMarginPence) * 10_000) / (10_000 + book.customs_bps));
    if (!ask) {
      this.log(`no ${commodity} on offer at ${sourcePort}`);
      return 0;
    }
    if (ask.price_pence > limit) {
      this.log(`best ask ${cr(ask.price_pence)}/t above limit ${cr(limit)}/t (charter ${cr(best.rewardPerTon)}/t, customs ${book.customs_bps} bps)`);
      return 0;
    }

    const costPerTon = Math.ceil((limit * (10_000 + book.customs_bps)) / 10_000);
    const qty = Math.min(room, Math.floor((await this.spendable(sourcePort)) / costPerTon));
    if (qty <= 0) {
      this.log(`not enough cash in the ${sourcePort} region above the ${cr(reservePence)} reserve`);
      return 0;
    }

    try {
      const res = await this.act(
        `bid ${qty} t ${commodity} at ${sourcePort}, IOC ≤ ${cr(limit)}/t (best ask ${cr(ask.price_pence)}, charter ${cr(best.rewardPerTon)}/t, customs ${book.customs_bps} bps)`,
        () =>
          this.client.placeOrder({
            port_id: sourcePort,
            commodity_id: commodity,
            side: "bid",
            time_in_force: "ioc",
            price_pence: limit,
            quantity: qty,
            ship_id: this.shipId,
          }),
      );
      if (!res) return qty;
      const paid = res.total_gross_pence + res.customs_duty_pence;
      this.stats.spentPence += paid;
      const avg = res.filled_quantity ? Math.round(paid / res.filled_quantity) : 0;
      this.log(`bought ${res.filled_quantity}/${qty} t for ${cr(paid)} incl. ${cr(res.customs_duty_pence)} customs (${cr(avg)}/t landed)`);
      return res.filled_quantity;
    } catch (e) {
      if (isApiError(e) && e.status === 400) {
        this.log(`buy refused: ${e.message}`);
        return 0;
      }
      throw e;
    }
  }

  /** Delivers the commodity aboard to open charters, best pay first. Returns tons delivered. */
  private async deliver(r: ShipResult, charters: Charter[]): Promise<number> {
    const { commodity } = this.cfg;
    let left = this.held(r);
    let delivered = 0;
    for (const c of charters) {
      if (left <= 0) break;
      const qty = Math.min(left, c.remaining);
      try {
        const res = await this.act(`deliver ${qty} t ${commodity} to "${c.title}" @ ${cr(c.rewardPerTon)}/t`, () =>
          this.client.deliverCharter({ contract_id: c.id, quantity: qty, ship_id: this.shipId }),
        );
        const n = res ? res.delivered_quantity : qty;
        left -= n;
        delivered += n;
        if (res) {
          this.stats.deliveredTons += n;
          this.stats.rewardPence += res.reward_paid_pence;
          this.log(`delivered ${n} t, paid ${cr(res.reward_paid_pence)}; charter ${res.contract_status}, world phase ${res.unlocked_phase}`);
        }
      } catch (e) {
        if (isApiError(e) && e.status < 500) {
          this.log(`"${c.title}" refused delivery: ${e.message}`);
          continue;
        }
        throw e;
      }
    }
    return delivered;
  }

  private async departTo(r: ShipResult, dest: string): Promise<number> {
    const s = r.ship;
    const plan = await this.route(s.current_port_id!, dest);
    if (!this.routeIsRated(plan)) {
      this.log(`${s.current_port_id} → ${dest} crosses water a ${this.hull} hull isn't rated for; not sailing`);
      return NO_CHARTER_WAIT_MS;
    }
    if (s.status === "berthed" && s.turnaround_unlocks_at) {
      const wait = Date.parse(s.turnaround_unlocks_at) - Date.now();
      if (wait > 0) {
        this.log(`turnaround lock: leaving for ${dest} in ${secs(wait)}`);
        return wait + 1_000;
      }
    }
    try {
      const res = await this.act(`depart ${s.current_port_id} → ${dest} with ${this.held(r)} t ${this.cfg.commodity}`, () =>
        this.client.depart({ ship_id: this.shipId, dest_port_id: dest }),
      );
      if (!res) return POLL_MS;
      for (const w of res.warnings) this.log(`depart warning ${w.code}: ${w.detail}`);
      const eta = Date.parse(res.estimated_arrival_at);
      this.log(`sailing to ${dest}, ETA ${res.estimated_arrival_at} (${secs(eta - Date.now())})${res.berth_dues_pence ? `, berth dues ${cr(res.berth_dues_pence)}` : ""}`);
      return clampSleep(eta - Date.now() + 2_000);
    } catch (e) {
      if (isApiError(e, "conflict")) {
        this.log(`depart refused: ${e.detail}`);
        return 5_000;
      }
      if (isApiError(e, "insufficient_provisions")) {
        // Let the next tick buy stores even though this berth stay already traded.
        this.log(`depart refused, stores short: ${e.detail}`);
        this.tradedAt.delete(`${s.id}:${s.current_port_id}:${s.berthed_at ?? ""}`);
        return 1_000;
      }
      throw e;
    }
  }

  private logStats(): void {
    const s = this.stats;
    this.log(
      `totals: ${s.trips} trips, ${s.deliveredTons} t delivered, reward ${cr(s.rewardPence)}, ` +
        `spent ${cr(s.spentPence)}, net ${cr(s.rewardPence - s.spentPence)}`,
    );
  }

  // ── Tick ────────────────────────────────────────────────────────────────────

  private async atPort(r: ShipResult): Promise<number> {
    const { sourcePort, charterPort, commodity } = this.cfg;
    const s = r.ship;
    const port = s.current_port_id;
    if (!port) return POLL_MS;
    const berthed = s.status === "berthed";
    const key = `${s.id}:${port}:${s.berthed_at ?? ""}`;
    const target = await this.storesTarget(port);

    if (port === charterPort) {
      if (this.held(r) > 0) {
        const charters = await this.openCharters();
        if (charters.length === 0) {
          this.log(`no open ${commodity} charter at ${charterPort}; holding ${this.held(r)} t`);
          return NO_CHARTER_WAIT_MS;
        }
        if ((await this.deliver(r, charters)) > 0) {
          this.stats.trips++;
          this.logStats();
        }
        if (this.cfg.dryRun) return POLL_MS;
        r = await this.client.ship(this.shipId);
        if (this.held(r) > 0) {
          this.log(`${this.held(r)} t ${commodity} left undelivered; holding at ${charterPort}`);
          return NO_CHARTER_WAIT_MS;
        }
      }
      if (r.stores.provisions_tons < target && !this.tradedAt.has(key)) {
        if (!berthed) return this.dockOrWait(r);
        await this.topUpStores(r, target);
        this.tradedAt.add(key);
        r = await this.client.ship(this.shipId);
      }
      return this.departTo(r, sourcePort);
    }

    if (port === sourcePort) {
      if (!this.tradedAt.has(key)) {
        const charters = (await this.openCharters()).filter(
          (c) => c.expiresAt === null || c.expiresAt - Date.now() > CHARTER_EXPIRY_MARGIN_MS,
        );
        if (charters.length === 0) {
          this.log(`no open ${commodity} charter at ${charterPort}; waiting at ${port}`);
          return NO_CHARTER_WAIT_MS;
        }
        if (!berthed) return this.dockOrWait(r);
        if (commodity === STORES_COMMODITY) await this.trimStores(r, target);
        await this.topUpStores(r, target);
        r = await this.client.ship(this.shipId);
        const bought = await this.buyCargo(r, charters);
        if (bought === 0 && this.held(r) === 0) return REQUOTE_WAIT_MS; // nothing to carry yet; wait for a re-quote
        this.tradedAt.add(key);
        if (this.cfg.dryRun) return POLL_MS;
        r = await this.client.ship(this.shipId);
      }
      return this.departTo(r, charterPort);
    }

    // Anywhere else (e.g. the home port): trim or top up stores, then head for the source.
    if (!this.tradedAt.has(key)) {
      if (commodity === STORES_COMMODITY) await this.trimStores(r, target);
      if (r.stores.provisions_tons < target) {
        if (!berthed) return this.dockOrWait(r);
        await this.topUpStores(r, target);
      }
      this.tradedAt.add(key);
      r = await this.client.ship(this.shipId);
    }
    return this.departTo(r, sourcePort);
  }

  private async tick(): Promise<number> {
    const r = await this.client.ship(this.shipId);
    switch (r.ship.status) {
      case "sunk":
        this.fail("ship has sunk");
      case "sailing": {
        const eta = r.voyage?.estimated_arrival_at ?? r.ship.leg_arrives_at;
        const ms = eta ? Date.parse(eta) - Date.now() : POLL_MS;
        this.log(`sailing to ${r.route_legs.at(-1)?.to_node ?? "?"}, ${this.held(r)} t ${this.cfg.commodity} aboard, arrives in ${secs(ms)}`);
        return clampSleep(ms + 2_000);
      }
      default:
        return this.atPort(r);
    }
  }

  // ── Startup ─────────────────────────────────────────────────────────────────

  private async init(): Promise<void> {
    const { apiKey, sourcePort, charterPort, commodity, minMarginPence, dryRun } = this.cfg;
    if (!apiKey) this.fail("no API key (log in with company_id to get a company-bound key)");

    const who = await this.client.whoami();
    if (!who.company_id) this.fail("the API key is player-level; a company-bound key is needed");
    const missing = REQUIRED_SCOPES.filter((sc) => !who.scopes.includes(sc));
    if (missing.length) this.fail(`key is missing scopes: ${missing.join(", ")}`);
    this.log(`company ${who.company_id}, key expires ${who.expires_at ?? "never"}${dryRun ? " — DRY RUN" : ""}`);

    this.catalog = await this.client.catalog();
    for (const id of [sourcePort, charterPort]) {
      if (!this.catalog.ports.some((p) => p.id === id)) this.fail(`unknown port ${id}`);
    }
    if (!this.catalog.commodities.some((c) => c.id === commodity)) this.fail(`unknown commodity ${commodity}`);

    const ships = await this.client.ships();
    const pick = this.cfg.shipId ? ships.find((x) => x.ship.id === this.cfg.shipId) : ships[0];
    if (!pick) this.fail(this.cfg.shipId ? `ship ${this.cfg.shipId} not found` : "company has no ships");
    this.shipId = pick.ship.id;
    this.shipName = pick.ship.name;
    this.shipClass = pick.ship.ship_class;
    this.hull = this.catalog.ship_classes.find((c) => c.id === this.shipClass)?.hull_category ?? "coastal";

    for (const [from, to] of [[sourcePort, charterPort], [charterPort, sourcePort]]) {
      const plan = await this.route(from, to);
      if (!this.routeIsRated(plan)) this.fail(`${from} → ${to} crosses water a ${this.shipClass} (${this.hull}) isn't rated for`);
    }

    const clock = await this.client.clock();
    const { calendar: cal } = clock;
    this.log(
      `ship ${this.shipName} (${this.shipClass}, ${pick.ship.cannons_count} guns) at ${pick.ship.current_port_id ?? "sea"}; ` +
        `game date ${cal.year}-${cal.month}-${cal.day} (${cal.season}), phase ${clock.unlocked_phase}`,
    );
    if ([11, 12, 1, 2].includes(cal.month)) this.log("storm season: expect more hazards even on rated water");
    if (clock.paused) this.log("world is paused; writes will fail until it resumes");

    const charters = await this.openCharters();
    for (const c of charters) {
      this.log(`charter "${c.title}": ${c.remaining} t left @ ${cr(c.rewardPerTon)}/t${c.stale ? " (gossip)" : ""}`);
    }
    this.log(`loop: buy ${commodity} at ${sourcePort} ≤ charter pay − ${cr(minMarginPence)}/t − customs, deliver at ${charterPort}`);
  }
}
