/**
 * HTTP client for the kibb.io Tradewinds API (v1).
 *
 * - Sends `Authorization: Bearer <key>` when a key is set (public world routes work without one).
 * - Every POST/PATCH carries a fresh `Idempotency-Key`. Network errors, timeouts and 5xx retry
 *   with the SAME key (the server replays the first answer); a 429 waits `Retry-After` and
 *   retries with a new key, since a rate-limited request never reached the handler.
 * - Errors come back as `KibbApiError`; branch on `.code` (e.g. `conflict`, `insufficient_provisions`).
 */

import { randomUUID } from "node:crypto";
import type * as S from "./schema";
import type {
  AcceptFreightResult,
  AchRate,
  BankingRegion,
  BuildMode,
  BuildQuote,
  BuildShipResult,
  Catalog,
  CompanyProfile,
  DeliverFreightResult,
  RemitResult,
  ContractListFilter,
  ContractListing,
  CreateCompanyRequest,
  CreateCompanyResult,
  CreateKeyRequest,
  CreateKeyResult,
  DeliverCharterRequest,
  DeliverCharterResult,
  DepartRequest,
  DepartResult,
  DockActionResult,
  ExpansionStatus,
  LeaderboardResult,
  LoginRequest,
  PlaceOrderRequest,
  PlaceOrderResult,
  Player,
  PlayerProfile,
  PortDetail,
  PortOrderBook,
  ProblemDetails,
  RoutePlan,
  ShipResult,
  StoresTransferResult,
  TreasuryVaults,
  WhoAmI,
  WorldClock,
} from "./types";

export const KIBB_DEFAULT_URL = "https://tradewinds.kibb.io";

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 4;

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const done = () => {
      clearTimeout(t);
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const abort = () => {
      clearTimeout(t);
      reject(signal?.reason);
    };
    const t = setTimeout(done, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });

// ── Error type ────────────────────────────────────────────────────────────────

export class KibbApiError extends Error {
  constructor(
    public status: number,
    /** Problem `code`, or undefined for the plain-text 4xx the server sends for malformed input. */
    public code: string | undefined,
    public detail: string,
    public body: ProblemDetails | string,
  ) {
    super(`${status}${code ? ` ${code}` : ""}: ${detail}`);
    this.name = "KibbApiError";
  }
}

export function isApiError(e: unknown, code?: string): e is KibbApiError {
  return e instanceof KibbApiError && (code === undefined || e.code === code);
}

// ── Client ────────────────────────────────────────────────────────────────────

type Query = Record<string, string | number | boolean | undefined>;

function qs(params: Query): string {
  const parts = Object.entries(params)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  return parts.length ? `?${parts.join("&")}` : "";
}

export interface KibbClientOptions {
  baseUrl?: string;
  /** Company-bound key (`tw_live_…`). Omit for public world routes only. */
  apiKey?: string;
}

export class KibbClient {
  readonly baseUrl: string;
  private readonly apiKey?: string;

  constructor(opts: KibbClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? KIBB_DEFAULT_URL).replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
  }

  private async request<T>(method: "GET" | "POST" | "PATCH", path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const isWrite = method !== "GET";
    let idempotencyKey = isWrite ? randomUUID() : undefined;

    for (let attempt = 0; ; attempt++) {
      const headers: Record<string, string> = { accept: "application/json" };
      if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
      if (body !== undefined) headers["content-type"] = "application/json";
      if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;

      let res: Response;
      try {
        res = await fetch(`${this.baseUrl}${path}`, {
          method,
          headers,
          body: body !== undefined ? JSON.stringify(body) : undefined,
          // Long polls pass their own signal and may wait up to 30 s server-side.
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS + 30_000)]) : AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (e) {
        if (signal?.aborted) throw e;
        // A write may have landed before the connection dropped; same key replays it safely.
        if (attempt < MAX_RETRIES) {
          console.error(`[kibb] ${method} ${path} network error (${(e as Error).message}), retry ${attempt + 1}/${MAX_RETRIES}`);
          await sleep(1_000 * 2 ** attempt, signal);
          continue;
        }
        throw e;
      }

      if (res.ok) return (await res.json()) as T;

      const text = await res.text();
      let problem: ProblemDetails | undefined;
      try {
        problem = JSON.parse(text) as ProblemDetails;
      } catch {
        problem = undefined;
      }

      if (res.status === 429 && attempt < MAX_RETRIES) {
        const waitS = Number(res.headers.get("retry-after") ?? "5") || 5;
        console.error(`[kibb] ${method} ${path} rate limited (${problem?.code ?? "429"}), waiting ${waitS}s`);
        await sleep(waitS * 1_000, signal);
        if (isWrite) idempotencyKey = randomUUID();
        continue;
      }

      const inFlight = res.status === 409 && problem?.code === "idempotency_request_in_flight";
      if ((res.status >= 500 || inFlight) && attempt < MAX_RETRIES) {
        console.error(`[kibb] ${method} ${path} ${res.status} ${problem?.code ?? ""}, retry ${attempt + 1}/${MAX_RETRIES}`);
        await sleep(1_000 * 2 ** attempt, signal);
        continue;
      }

      throw new KibbApiError(
        res.status,
        problem?.code,
        problem?.detail ?? problem?.title ?? (text || res.statusText),
        problem ?? text,
      );
    }
  }

  private get<T>(path: string, query: Query = {}): Promise<T> {
    return this.request<T>("GET", `${path}${qs(query)}`);
  }

  private post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("POST", path, body);
  }

  private patch<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>("PATCH", path, body);
  }

  // ── Auth / player / company ─────────────────────────────────────────────────

  register = (handle: string, passphrase: string) =>
    this.post<{ player: Player }>("/v1/player/register", { handle, passphrase });

  login = (req: LoginRequest) => this.post<CreateKeyResult>("/v1/auth/login", req);
  /** Mints a sub-key with the caller's Bearer key (needs `account_manage`). */
  createKey = (req: CreateKeyRequest) => this.post<CreateKeyResult>("/v1/auth/create-key", req);
  /** Revokes `keyId`, or the calling key when omitted. */
  revokeKey = (keyId?: string) => this.post<{ key_id: string; revoked: boolean }>("/v1/auth/revoke", keyId ? { key_id: keyId } : {});
  whoami = () => this.get<WhoAmI>("/v1/auth/whoami");
  /** The player's keys (optionally only those bound to one company). */
  listKeys = (companyId?: string) => this.get<S.ApiKey[]>("/v1/auth/keys", { company_id: companyId });
  revokeAllKeys = (req: S.RevokeAllKeysRequest = {}) => this.post<S.RevokeAllKeysResult>("/v1/auth/revoke-all", req);
  /** Revokes every key unless `revoke_all_keys: false`. */
  changePassphrase = (req: S.ChangePassphraseRequest) => this.post<S.ChangePassphraseResult>("/v1/auth/change-passphrase", req);

  playerProfile = () => this.get<PlayerProfile>("/v1/player/profile");
  createCompany = (req: CreateCompanyRequest) => this.post<CreateCompanyResult>("/v1/company/create", req);
  companyProfile = () => this.get<CompanyProfile>("/v1/company/profile");
  companySettings = () => this.get<S.CompanySettings>("/v1/company/settings");
  /** Needs `account_manage`; sends only the fields given. */
  updateCompanySettings = (req: S.UpdateCompanySettingsRequest) => this.patch<S.CompanySettings>("/v1/company/settings", req);
  factors = () => this.get<string[]>("/v1/company/factors");
  hireFactor = (portId: string) => this.post<S.FactorActionResult>("/v1/company/hire-factor", { port_id: portId });
  dismissFactor = (portId: string) => this.post<S.FactorActionResult>("/v1/company/dismiss-factor", { port_id: portId });
  declareBankruptcy = () => this.post<S.DeclareBankruptcyResult>("/v1/company/declare-bankruptcy");

  // ── World ───────────────────────────────────────────────────────────────────

  clock = () => this.get<WorldClock>("/v1/world/clock");
  catalog = () => this.get<Catalog>("/v1/world/catalog");
  expansion = () => this.get<ExpansionStatus>("/v1/world/expansion");
  port = (portId: string) => this.get<PortDetail>("/v1/world/port", { port_id: portId });
  leaderboard = () => this.get<LeaderboardResult>("/v1/world/leaderboard");
  hallOfFame = () => this.get<S.HallOfFameSeason[]>("/v1/world/hall-of-fame");
  publicCompany = (name: string) => this.get<S.PublicCompanyProfile>("/v1/world/company", { name });
  ports = (filter: { phase?: number; banking_region?: BankingRegion } = {}) => this.get<S.PortCatalogEntry[]>("/v1/world/ports", filter);
  zones = () => this.get<S.SeaZonePiracyResult[]>("/v1/world/zones");
  worldEvents = (
    filter: { include_expired?: boolean; event_type?: string; structural?: boolean; port_id?: string; since?: string; cursor?: string; limit?: number } = {},
  ) => this.get<S.WorldEventResult[]>("/v1/world/events", filter);
  health = () => this.get<S.HealthResult>("/healthz");
  ready = () => this.get<S.HealthResult>("/readyz");

  route = (from: string, to: string, shipClass?: string) =>
    this.get<RoutePlan>("/v1/world/route", { from, to, ship_class: shipClass });

  // ── Fleet ───────────────────────────────────────────────────────────────────

  ship = (shipId: string) => this.get<ShipResult>("/v1/fleet/ship", { ship_id: shipId });

  /** All of the company's ships, following the `cursor` (last id) pagination. */
  async ships(): Promise<ShipResult[]> {
    const all: ShipResult[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await this.get<ShipResult[]>("/v1/fleet/ships", { cursor, limit: 200 });
      all.push(...page);
      if (page.length < 200) return all;
      cursor = page[page.length - 1].ship.id;
    }
  }

  depart = (req: DepartRequest) => this.post<DepartResult>("/v1/fleet/depart", req);
  dock = (shipId: string) => this.post<DockActionResult>("/v1/fleet/dock", { ship_id: shipId });
  offshore = (shipId: string) => this.post<DockActionResult>("/v1/fleet/offshore", { ship_id: shipId });

  provision = (shipId: string, tons: number, source: "cargo" | "warehouse") =>
    this.post<StoresTransferResult>("/v1/fleet/provision", { ship_id: shipId, tons, source });

  unprovision = (shipId: string, tons: number, destination: "cargo" | "warehouse") =>
    this.post<StoresTransferResult>("/v1/fleet/unprovision", { ship_id: shipId, tons, destination });

  // ── Convoys, marques, patrols ───────────────────────────────────────────────

  convoys = (filter: { convoy_id?: string; port_id?: string; status?: S.ConvoyStatus; cursor?: string; limit?: number } = {}) =>
    this.get<S.ConvoyResult[]>("/v1/fleet/convoys", filter);
  createConvoy = (req: S.CreateConvoyRequest) => this.post<S.ConvoyResult>("/v1/fleet/create-convoy", req);
  joinConvoy = (req: S.JoinConvoyRequest) => this.post<S.ConvoyMembershipResult>("/v1/fleet/join-convoy", req);
  detachConvoy = (req: S.ConvoyMembershipRequest) => this.post<S.ConvoyMembershipResult>("/v1/fleet/detach-convoy", req);
  approveConvoyRequest = (req: S.ConvoyMembershipRequest) => this.post<S.ConvoyMembershipResult>("/v1/fleet/approve-convoy-request", req);
  rejectConvoyRequest = (req: S.ConvoyMembershipRequest) => this.post<S.ConvoyMembershipResult>("/v1/fleet/reject-convoy-request", req);
  kickConvoyMember = (req: S.ConvoyMembershipRequest) => this.post<S.ConvoyMembershipResult>("/v1/fleet/kick-convoy-member", req);
  inviteToConvoy = (req: S.ConvoyInviteRequest) => this.post<S.ConvoyInviteResult>("/v1/fleet/invite-to-convoy", req);
  issueMarque = (req: S.IssueMarqueRequest) => this.post<S.LetterOfMarque>("/v1/fleet/issue-marque", req);
  fundPatrol = (req: S.FundPatrolRequest) => this.post<S.NavalPatrol>("/v1/fleet/fund-patrol", req);
  marques = (filter: { sea_zone_id?: string; cursor?: string; limit?: number } = {}) => this.get<S.LetterOfMarque[]>("/v1/fleet/marques", filter);
  patrols = (filter: { sea_zone_id?: string; cursor?: string; limit?: number } = {}) => this.get<S.NavalPatrol[]>("/v1/fleet/patrols", filter);

  // ── Market ──────────────────────────────────────────────────────────────────

  book = (portId: string, commodityId?: string) =>
    this.get<PortOrderBook>("/v1/market/book", { port_id: portId, commodity_id: commodityId });

  placeOrder = (req: PlaceOrderRequest) => this.post<PlaceOrderResult>("/v1/market/place-order", req);
  /** All-or-nothing, 1–25 orders. */
  placeOrders = (orders: PlaceOrderRequest[]) => this.post<PlaceOrderResult[]>("/v1/market/place-orders-batch", { orders });
  cancelOrder = (orderId: string) => this.post<S.CancelOrderResult>("/v1/market/cancel-order", { order_id: orderId });
  cancelOrders = (orderIds: string[]) => this.post<S.CancelOrderResult[]>("/v1/market/cancel-orders-batch", { order_ids: orderIds });
  /** The company's resting orders. */
  orders = (filter: { port_id?: string; commodity_id?: string; side?: S.OrderSide; cursor?: string; limit?: number } = {}) =>
    this.get<S.OrderBook[]>("/v1/market/orders", filter);
  fills = (filter: { port_id?: string; commodity_id?: string; side?: S.OrderSide; cursor?: string; limit?: number } = {}) =>
    this.get<S.CompanyTradeFillResult[]>("/v1/market/fills", filter);

  // ── Contracts ───────────────────────────────────────────────────────────────

  listContracts = (filter: ContractListFilter = {}) =>
    this.get<ContractListing[]>("/v1/contract/list", { ...filter });

  /**
   * Every page of a contract listing (cursor = last id), up to `maxPages` of 200. `complete` is
   * false when it stopped at the page limit with more to come.
   */
  async contractPages(filter: Omit<ContractListFilter, "cursor" | "limit"> = {}, maxPages = 10): Promise<{ items: ContractListing[]; complete: boolean }> {
    const byId = new Map<string, ContractListing>();
    let cursor: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      const batch = await this.listContracts({ ...filter, cursor, limit: 200 });
      for (const c of batch) byId.set(c.id, c);
      if (batch.length < 200) return { items: [...byId.values()], complete: true };
      cursor = batch[batch.length - 1].id;
    }
    return { items: [...byId.values()], complete: false };
  }

  deliverCharter = (req: DeliverCharterRequest) =>
    this.post<DeliverCharterResult>("/v1/contract/deliver-charter", req);

  acceptFreight = (contractId: string, shipId: string) =>
    this.post<AcceptFreightResult>("/v1/contract/accept-freight", { contract_id: contractId, ship_id: shipId });

  deliverFreight = (contractId: string, shipId: string) =>
    this.post<DeliverFreightResult>("/v1/contract/deliver-freight", { contract_id: contractId, ship_id: shipId });

  /** All-or-nothing, 1–25 deliveries; a failure carries `batch_index`. */
  deliverCharters = (deliveries: DeliverCharterRequest[]) =>
    this.post<DeliverCharterResult[]>("/v1/contract/deliver-charters-batch", { deliveries });
  acceptFreights = (items: Array<{ contract_id: string; ship_id: string }>) =>
    this.post<AcceptFreightResult[]>("/v1/contract/accept-freight-batch", { items });
  createFreight = (req: S.CreateFreightRequest) => this.post<S.Contract>("/v1/contract/create-freight", req);

  // ── Futures and insurance ───────────────────────────────────────────────────

  futures = (filter: { port_id?: string; commodity_id?: string; status?: S.FuturesStatus; cursor?: string; limit?: number } = {}) =>
    this.get<S.FuturesContract[]>("/v1/future/list", filter);
  createFuture = (req: S.CreateFuturesOrderRequest) => this.post<S.FuturesContract>("/v1/future/create", req);
  createFutures = (orders: S.CreateFuturesOrderRequest[]) => this.post<S.FuturesContract[]>("/v1/future/create-batch", { orders });
  acceptFuture = (futuresId: string) => this.post<S.FuturesContract>("/v1/future/accept", { futures_id: futuresId });
  acceptFutures = (futuresIds: string[]) => this.post<S.FuturesContract[]>("/v1/future/accept-batch", { futures_ids: futuresIds });
  settleFuture = (futuresId: string) => this.post<S.SettleFuturesResult>("/v1/future/settle", { futures_id: futuresId });

  policies = (
    filter: {
      status?: S.InsuranceStatus;
      origin_port_id?: string;
      dest_port_id?: string;
      ship_id?: string;
      insured_company_id?: string;
      underwriter_company_id?: string;
      cursor?: string;
      limit?: number;
    } = {},
  ) => this.get<S.InsurancePolicy[]>("/v1/insurance/list", filter);
  insure = (req: S.CreateInsurancePolicyRequest) => this.post<S.InsurancePolicy>("/v1/insurance/create", req);
  underwrite = (req: S.UnderwriteInsuranceRequest) => this.post<S.InsurancePolicyDetailResult>("/v1/insurance/underwrite", req);
  underwriteBatch = (items: S.UnderwriteInsuranceRequest[]) =>
    this.post<S.InsurancePolicyDetailResult[]>("/v1/insurance/underwrite-batch", { items });

  // ── Warehouses ──────────────────────────────────────────────────────────────

  warehouses = () => this.get<S.PortWarehouseResult[]>("/v1/warehouse/list");
  warehouse = (portId: string) => this.get<S.PortWarehouseResult>("/v1/warehouse/inventory", { port_id: portId });
  setLease = (portId: string, tons: number) =>
    this.post<S.PortWarehouseResult>("/v1/warehouse/set-lease", { port_id: portId, target_leased_tonnage: tons });
  loadShip = (req: S.ShipWarehouseTransferRequest) => this.post<S.ShipWarehouseTransferResult>("/v1/warehouse/load-ship", req);
  unloadShip = (req: S.ShipWarehouseTransferRequest) => this.post<S.ShipWarehouseTransferResult>("/v1/warehouse/unload-ship", req);

  // ── Events ──────────────────────────────────────────────────────────────────

  /**
   * Long-polls the company's event log: everything after `after_id` (only new events when
   * omitted, the oldest retained with "0"), waiting up to `timeout_ms` (max 30 s) for one.
   * `410 events_expired` means the cursor fell out of the 7-day log: resync over REST.
   */
  events = (q: { after_id?: string; timeout_ms?: number; limit?: number; event_type?: string } = {}, signal?: AbortSignal) =>
    this.request<S.StreamEvent[]>("GET", `/v1/event/stream${qs(q)}`, undefined, signal);

  // ── Shipyard ────────────────────────────────────────────────────────────────

  shipyardQuote = (portId: string, shipClass: string, buildMode: BuildMode = "turnkey_cash") =>
    this.get<BuildQuote>("/v1/shipyard/quote", { port_id: portId, ship_class: shipClass, build_mode: buildMode });

  buildShip = (portId: string, name: string, shipClass: string, buildMode: BuildMode = "turnkey_cash") =>
    this.post<BuildShipResult>("/v1/shipyard/build-ship", { port_id: portId, name, ship_class: shipClass, build_mode: buildMode });

  /** Sets the cannon count; adding guns needs a shipyard port (150 Cr each). */
  modifyShip = (shipId: string, cannons: number) =>
    this.post<ShipResult>("/v1/shipyard/modify-ship", { ship_id: shipId, target_cannons_count: cannons });

  // ── Treasury ────────────────────────────────────────────────────────────────

  vaults = () => this.get<TreasuryVaults>("/v1/treasury/vaults");
  rates = () => this.get<AchRate[]>("/v1/treasury/rates");

  remit = (from: BankingRegion, to: BankingRegion, grossPence: number) =>
    this.post<RemitResult>("/v1/treasury/remit", { from_region: from, to_region: to, gross_amount_pence: grossPence });

  ledger = (filter: { cursor?: string; limit?: number; banking_region?: BankingRegion; reason?: string } = {}) =>
    this.get<S.LedgerEntry[]>("/v1/treasury/ledger", filter);
}
