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
import type {
  Catalog,
  CompanyProfile,
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

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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

  private async request<T>(method: "GET" | "POST" | "PATCH", path: string, body?: unknown): Promise<T> {
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
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (e) {
        // A write may have landed before the connection dropped; same key replays it safely.
        if (attempt < MAX_RETRIES) {
          console.error(`[kibb] ${method} ${path} network error (${(e as Error).message}), retry ${attempt + 1}/${MAX_RETRIES}`);
          await sleep(1_000 * 2 ** attempt);
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
        await sleep(waitS * 1_000);
        if (isWrite) idempotencyKey = randomUUID();
        continue;
      }

      const inFlight = res.status === 409 && problem?.code === "idempotency_request_in_flight";
      if ((res.status >= 500 || inFlight) && attempt < MAX_RETRIES) {
        console.error(`[kibb] ${method} ${path} ${res.status} ${problem?.code ?? ""}, retry ${attempt + 1}/${MAX_RETRIES}`);
        await sleep(1_000 * 2 ** attempt);
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

  // ── Auth / player / company ─────────────────────────────────────────────────

  register = (handle: string, passphrase: string) =>
    this.post<{ player: Player }>("/v1/player/register", { handle, passphrase });

  login = (req: LoginRequest) => this.post<CreateKeyResult>("/v1/auth/login", req);
  /** Mints a sub-key with the caller's Bearer key (needs `account_manage`). */
  createKey = (req: CreateKeyRequest) => this.post<CreateKeyResult>("/v1/auth/create-key", req);
  /** Revokes `keyId`, or the calling key when omitted. */
  revokeKey = (keyId?: string) => this.post<{ key_id: string; revoked: boolean }>("/v1/auth/revoke", keyId ? { key_id: keyId } : {});
  whoami = () => this.get<WhoAmI>("/v1/auth/whoami");

  playerProfile = () => this.get<PlayerProfile>("/v1/player/profile");
  createCompany = (req: CreateCompanyRequest) => this.post<CreateCompanyResult>("/v1/company/create", req);
  companyProfile = () => this.get<CompanyProfile>("/v1/company/profile");

  // ── World ───────────────────────────────────────────────────────────────────

  clock = () => this.get<WorldClock>("/v1/world/clock");
  catalog = () => this.get<Catalog>("/v1/world/catalog");
  expansion = () => this.get<ExpansionStatus>("/v1/world/expansion");
  port = (portId: string) => this.get<PortDetail>("/v1/world/port", { port_id: portId });
  leaderboard = () => this.get<LeaderboardResult>("/v1/world/leaderboard");

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

  // ── Market ──────────────────────────────────────────────────────────────────

  book = (portId: string, commodityId?: string) =>
    this.get<PortOrderBook>("/v1/market/book", { port_id: portId, commodity_id: commodityId });

  placeOrder = (req: PlaceOrderRequest) => this.post<PlaceOrderResult>("/v1/market/place-order", req);

  // ── Contracts ───────────────────────────────────────────────────────────────

  listContracts = (filter: ContractListFilter = {}) =>
    this.get<ContractListing[]>("/v1/contract/list", { ...filter });

  deliverCharter = (req: DeliverCharterRequest) =>
    this.post<DeliverCharterResult>("/v1/contract/deliver-charter", req);

  // ── Treasury ────────────────────────────────────────────────────────────────

  vaults = () => this.get<TreasuryVaults>("/v1/treasury/vaults");
}
