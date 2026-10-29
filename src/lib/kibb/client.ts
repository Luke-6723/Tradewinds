/**
 * HTTP client for the kibb.io Tradewinds API (v1).
 *
 * - Sends `Authorization: Bearer <key>` when a key is set (public world routes work without one).
 * - Every POST/PATCH carries a fresh `Idempotency-Key`. Network errors, timeouts, a body cut off
 *   mid-read and 5xx retry with the SAME key (the server replays the first answer). Once an attempt
 *   may have landed, only that key is ever sent again: a 429 gets a new key only when none could
 *   have (or the 429 is the key's own replayed answer).
 * - Rate limits: a 429 holds back every call on its bucket for `Retry-After`; a bucket running low
 *   (`x-ratelimit-remaining`) is paced over the time to its reset. `503 world_paused` is thrown at once.
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
/** A bucket with this share of its burst left is paced: what remains spread over the time to its reset. */
const PACE_BELOW_SHARE = 0.1;
const PACE_MIN_MS = 50;
const PACE_MAX_MS = 2_000;
const AUTH_STRICT_PATHS = new Set(["/v1/player/register", "/v1/auth/login", "/v1/auth/create-key", "/v1/auth/change-passphrase"]);

/** The rate-limit bucket a request spends from (guide 4.3). */
function bucketOf(method: string, path: string): string {
  const p = path.split("?")[0];
  if (p.startsWith("/v1/event/")) return "stream";
  if (method === "GET") return "read";
  if (p.endsWith("-batch")) return "batch";
  if (AUTH_STRICT_PATHS.has(p)) return "auth_strict";
  return "write";
}

/** Marks an error with whether an attempt of its request may have landed. */
function withLanded(e: unknown, maybeLanded: boolean): unknown {
  return e instanceof Error ? Object.assign(e, { maybeLanded }) : e;
}

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
  /** An earlier attempt with this request's Idempotency-Key may have reached the handler: what it did is unknown. */
  maybeLanded = false;

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

/** 403 codes no retry fixes: the operators suspended the account or froze the company. */
export const FATAL_CODES: readonly string[] = ["account_suspended", "company_frozen"];

/** The key is bad, expired or revoked (401), or the account or company is shut (FATAL_CODES): stop. */
export function isFatalApiError(e: unknown): e is KibbApiError {
  return e instanceof KibbApiError && (e.status === 401 || FATAL_CODES.includes(e.code ?? ""));
}

/**
 * A write whose effect is unknown: no answer (network, timeout), a 5xx, still in flight, or an earlier
 * attempt that may have landed. Never `world_paused` on its own: nothing ran.
 */
export function outcomeUnknown(e: unknown): boolean {
  if (!(e instanceof KibbApiError)) return true;
  if (e.maybeLanded) return true;
  if (e.code === "world_paused") return false;
  return e.status >= 500 || e.code === "idempotency_request_in_flight";
}

/**
 * Every page of a cursor-paged list (cursor = the last item's id), up to `maxPages` of `pageSize`. `complete`
 * is false when it stopped at the page limit with more to come: a caller that needs the whole set fails closed.
 */
export async function pages<T>(
  list: (cursor: string | undefined) => Promise<T[]>,
  idOf: (x: T) => string,
  pageSize: number,
  maxPages = 10,
): Promise<{ items: T[]; complete: boolean }> {
  const byId = new Map<string, T>();
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const batch = await list(cursor);
    for (const x of batch) byId.set(idOf(x), x);
    if (batch.length < pageSize) return { items: [...byId.values()], complete: true };
    cursor = idOf(batch[batch.length - 1]);
  }
  return { items: [...byId.values()], complete: false };
}

/**
 * Every page of a list paged by the answer's `next_cursor` (null on the last page), up to `maxPages`. `complete` is false
 * when it stopped at the page limit with more to come.
 */
export async function nextCursorPages<P extends { next_cursor?: string | null }, T>(
  list: (cursor: string | undefined) => Promise<P>,
  itemsOf: (page: P) => T[],
  maxPages = 10,
): Promise<{ items: T[]; complete: boolean }> {
  const items: T[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const res = await list(cursor);
    items.push(...itemsOf(res));
    if (!res.next_cursor) return { items, complete: true };
    cursor = res.next_cursor;
  }
  return { items, complete: false };
}

/** A fatal error in words for the dashboard and log (what to do about an expired key). */
export function fatalText(e: unknown): string {
  if (isApiError(e, "expired_api_key")) return "the company key expired: select the company again (dashboard) or mint a new KIBB_API_KEY (CLI)";
  return e instanceof Error ? e.message : String(e);
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
  private apiKey?: string;
  /** Per rate-limit bucket: no request before this local time (a 429's Retry-After, or pacing). Shared by every call on this client. */
  private readonly notBefore = new Map<string, number>();
  /** Per bucket running low: the gap kept between calls until it recovers. */
  private readonly pace = new Map<string, number>();

  constructor(opts: KibbClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? KIBB_DEFAULT_URL).replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
  }

  /** A new key for the same company (renewed before it expired); calls already sent keep the old one. */
  setApiKey(key: string): void {
    this.apiKey = key;
  }

  private hold(bucket: string, ms: number): void {
    this.notBefore.set(bucket, Math.max(this.notBefore.get(bucket) ?? 0, Date.now() + ms));
  }

  /** Waits out the bucket's backoff; while it is paced, each call takes the next slot (so calls in parallel spread too). */
  private async gate(bucket: string, signal?: AbortSignal): Promise<void> {
    for (let wait = (this.notBefore.get(bucket) ?? 0) - Date.now(); wait > 0; wait = (this.notBefore.get(bucket) ?? 0) - Date.now()) await sleep(wait, signal);
    const gap = this.pace.get(bucket);
    if (gap) this.hold(bucket, gap);
  }

  /** Paces a bucket with under a tenth of its burst left: the rest spread over the time to its reset. */
  private noteLimits(bucket: string, res: Response): void {
    const num = (k: string) => {
      const v = res.headers.get(k);
      return v === null ? NaN : Number(v);
    };
    const limit = num("x-ratelimit-limit");
    const left = num("x-ratelimit-remaining");
    const reset = num("x-ratelimit-reset");
    if (!(limit > 0) || !Number.isFinite(left) || !Number.isFinite(reset) || left > limit * PACE_BELOW_SHARE) {
      this.pace.delete(bucket);
      return;
    }
    // The reset is epoch seconds or seconds from now (the docs don't say which).
    const resetMs = reset > 1e9 ? reset * 1_000 - Date.now() : reset * 1_000;
    this.pace.set(bucket, Math.min(PACE_MAX_MS, Math.max(PACE_MIN_MS, resetMs / Math.max(left, 1))));
  }

  private async request<T>(method: "GET" | "POST" | "PATCH", path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const isWrite = method !== "GET";
    let idempotencyKey = isWrite ? randomUUID() : undefined;
    // Once an attempt with this key may have reached the handler, only this key may be sent: another could act twice.
    let maybeLanded = false;
    const bucket = bucketOf(method, path);

    for (let attempt = 0; ; attempt++) {
      await this.gate(bucket, signal);
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
        // A write may have landed before the connection dropped (or the timeout fired); the same key replays it safely.
        if (isWrite) maybeLanded = true;
        if (signal?.aborted) throw withLanded(e, maybeLanded);
        if (attempt < MAX_RETRIES) {
          console.error(`[kibb] ${method} ${path} network error (${(e as Error).message}), retry ${attempt + 1}/${MAX_RETRIES}`);
          await sleep(1_000 * 2 ** attempt, signal);
          continue;
        }
        throw withLanded(e, maybeLanded);
      }
      this.noteLimits(bucket, res);

      if (res.ok) {
        // No Content: nothing to parse.
        if (res.status === 204) return undefined as T;
        try {
          return (await res.json()) as T;
        } catch (e) {
          // A body cut off mid-read: the write happened; the same key replays its answer.
          if (isWrite) maybeLanded = true;
          if (signal?.aborted) throw withLanded(e, maybeLanded);
          if (attempt < MAX_RETRIES) {
            console.error(`[kibb] ${method} ${path} ${res.status} body unreadable (${(e as Error).message}), retry ${attempt + 1}/${MAX_RETRIES}`);
            await sleep(1_000 * 2 ** attempt, signal);
            continue;
          }
          throw withLanded(e, maybeLanded);
        }
      }

      // The status is the answer; a body lost on the way only costs the detail.
      const text = await res.text().catch(() => "");
      let problem: ProblemDetails | undefined;
      try {
        problem = JSON.parse(text) as ProblemDetails;
      } catch {
        problem = undefined;
      }
      const fail = () =>
        Object.assign(new KibbApiError(res.status, problem?.code, problem?.detail ?? problem?.title ?? (text || res.statusText), problem ?? text), { maybeLanded });

      // The bulletin's per-company hourly post limit (guide 3.21), not the token bucket: waiting it out here would hold every
      // write on the bucket for up to an hour. Thrown at once; `detail` says how long.
      if (res.status === 429 && problem?.code === "bulletin_limit") throw fail();

      if (res.status === 429) {
        const waitS = Number(res.headers.get("retry-after") ?? "5") || 5;
        // Every call on this bucket waits it out, not just this one.
        const named = res.headers.get("x-ratelimit-bucket");
        for (const b of new Set([bucket, named ?? bucket])) this.hold(b, waitS * 1_000);
        if (attempt < MAX_RETRIES) {
          console.error(`[kibb] ${method} ${path} rate limited (${problem?.code ?? "429"}), waiting ${waitS}s`);
          // The limiter answered, not the handler. A fresh key only if none of ours could have landed, or this
          // 429 is the key's own stored answer (replayed): either proves the key never ran.
          if (isWrite && (!maybeLanded || res.headers.get("idempotency-replayed") === "true")) {
            idempotencyKey = randomUUID();
            maybeLanded = false;
          }
          continue;
        }
        throw fail();
      }

      // Paused by the operators: nothing ran, and retrying won't change that soon; the caller waits on the clock.
      if (res.status === 503 && problem?.code === "world_paused") throw fail();

      const inFlight = res.status === 409 && problem?.code === "idempotency_request_in_flight";
      if (res.status >= 500 || inFlight) {
        if (isWrite) maybeLanded = true;
        if (attempt < MAX_RETRIES) {
          console.error(`[kibb] ${method} ${path} ${res.status} ${problem?.code ?? ""}, retry ${attempt + 1}/${MAX_RETRIES}`);
          await sleep(1_000 * 2 ** attempt, signal);
          continue;
        }
      }

      throw fail();
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
  /**
   * Moves our home port (guide 3.12): 2,500 Cr from our vault in the new home's region, once per real day (`409`). Needs a factor
   * or a ship berthed or in the roadstead there (`403 no_port_presence`); never a cove (`400`).
   */
  relocateHome = (portId: string) => this.post<S.RelocateHomePortResult>("/v1/company/relocate", { port_id: portId });
  declareBankruptcy = () => this.post<S.DeclareBankruptcyResult>("/v1/company/declare-bankruptcy");

  // ── World ───────────────────────────────────────────────────────────────────

  clock = () => this.get<WorldClock>("/v1/world/clock");
  catalog = () => this.get<Catalog>("/v1/world/catalog");
  expansion = () => this.get<ExpansionStatus>("/v1/world/expansion");
  port = (portId: string) => this.get<PortDetail>("/v1/world/port", { port_id: portId });
  /** The net-worth board and the `rising` board (growth over 7 real days), both refreshed hourly (guide 3.17). */
  leaderboard = () => this.get<LeaderboardResult>("/v1/world/leaderboard");
  /**
   * Public: the NPC desks' results board (guide 3.16): per desk (ships, ship_shares, envelopes, ventures, futures,
   * admiralty_commissions, charter_filler) what the house bought and what players traded among themselves over `days` game days.
   */
  desks = (days?: number) => this.get<S.DeskBoard>("/v1/world/desks", { days });
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

  /** Royal monopolies in force (with `include_expired`, their history too), newest first. Public. */
  monopolies = (
    filter: { banking_region?: BankingRegion; commodity_id?: string; include_expired?: boolean; cursor?: string; limit?: number } = {},
  ) => this.get<S.MonopolyResult[]>("/v1/world/monopolies", filter);
  /** Every page of a monopoly listing (200 a page). */
  monopolyPages = (filter: Omit<NonNullable<Parameters<KibbClient["monopolies"]>[0]>, "cursor" | "limit"> = {}, maxPages = 10) =>
    pages((cursor) => this.monopolies({ ...filter, cursor, limit: 200 }), (m) => m.id, 200, maxPages);
  /** The monopoly on a good in a region for `termGameDays` (5, 10 or 20) as it would be charged now, and whether it can be bought. */
  monopolyQuote = (region: BankingRegion, commodityId: string, termGameDays: number) =>
    this.get<S.MonopolyQuoteResult>("/v1/world/monopoly-quote", { banking_region: region, commodity_id: commodityId, term_game_days: termGameDays });

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

  /** Packets only (`can_seal_dispatches`): sealed, the crew's gossip stays off the boards it calls at; released, it posts at once in port. */
  sealDispatches = (shipId: string, sealed: boolean) =>
    this.post<S.SealDispatchesResult>("/v1/fleet/seal-dispatches", { ship_id: shipId, sealed });

  // ── Ship market ─────────────────────────────────────────────────────────────

  /** With `port_id`: the open listings there (needs quay presence). Without: our own listings, any status. */
  shipListings = (filter: { port_id?: string; cursor?: string; limit?: number } = {}) =>
    this.get<S.ShipListingResult[]>("/v1/fleet/ship-listings", filter);
  /** Every page of a ship listing (200 a page). */
  shipListingPages = (filter: { port_id?: string } = {}, maxPages = 10) =>
    pages((cursor) => this.shipListings({ ...filter, cursor, limit: 200 }), (l) => l.id, 200, maxPages);
  /**
   * Offers a ship lying in port for sale at 50–150% of its rebuild value (empty hold, no convoy, insurance or lien). `unlisted`
   * keeps it off the Exchange, seen only on the port's quay (guide 3.21).
   */
  listShip = (shipId: string, pricePence: number, unlisted?: boolean) =>
    this.post<S.ShipListingResult>("/v1/fleet/list-ship", { ship_id: shipId, price_pence: pricePence, ...(unlisted ? { unlisted: true } : {}) });
  /** Needs quay presence at the listing's port; paid from our vault in that region. `409` if the rebuild value moved. */
  buyShip = (listingId: string) => this.post<S.ShipSaleResult>("/v1/fleet/buy-ship", { listing_id: listingId });
  cancelShipListing = (listingId: string) => this.post<S.ShipListingResult>("/v1/fleet/cancel-ship-listing", { listing_id: listingId });

  // ── Convoys, marques, patrols ───────────────────────────────────────────────

  convoys = (filter: { convoy_id?: string; port_id?: string; status?: S.ConvoyStatus; cursor?: string; limit?: number } = {}) =>
    this.get<S.ConvoyResult[]>("/v1/fleet/convoys", filter);
  /** Every page of a convoy listing (50 a page: the docs give no maximum, and 50 is what has always been asked). */
  convoyPages = (filter: { port_id?: string; status?: S.ConvoyStatus } = {}, maxPages = 10) =>
    pages((cursor) => this.convoys({ ...filter, cursor, limit: 50 }), (c) => c.convoy.id, 50, maxPages);
  createConvoy = (req: S.CreateConvoyRequest) => this.post<S.ConvoyResult>("/v1/fleet/create-convoy", req);
  /** A convoy scheduled with no ship yet (1 game hour to 14 game days out; needs presence at the origin); ships join later. */
  announceConvoy = (req: S.AnnounceConvoyRequest) => this.post<S.ConvoyResult>("/v1/fleet/announce-convoy", req);
  joinConvoy = (req: S.JoinConvoyRequest) => this.post<S.ConvoyMembershipResult>("/v1/fleet/join-convoy", req);
  detachConvoy = (req: S.ConvoyMembershipRequest) => this.post<S.ConvoyMembershipResult>("/v1/fleet/detach-convoy", req);
  approveConvoyRequest = (req: S.ConvoyMembershipRequest) => this.post<S.ConvoyMembershipResult>("/v1/fleet/approve-convoy-request", req);
  rejectConvoyRequest = (req: S.ConvoyMembershipRequest) => this.post<S.ConvoyMembershipResult>("/v1/fleet/reject-convoy-request", req);
  kickConvoyMember = (req: S.ConvoyMembershipRequest) => this.post<S.ConvoyMembershipResult>("/v1/fleet/kick-convoy-member", req);
  inviteToConvoy = (req: S.ConvoyInviteRequest) => this.post<S.ConvoyInviteResult>("/v1/fleet/invite-to-convoy", req);
  /** What `issueMarque` would charge now for `addedBps` over `durationGameHours` (default 60) in a zone, and the net prize it expects. */
  marqueQuote = (seaZoneId: string, addedBps: number, durationGameHours?: number) =>
    this.get<S.MarqueQuote>("/v1/fleet/marque-quote", { sea_zone_id: seaZoneId, added_piracy_bps: addedBps, duration_game_hours: durationGameHours });
  /** Charged at the zone's quoted price, fixed for the term; `pricing` is the quote it was charged at. */
  issueMarque = (req: S.IssueMarqueRequest) => this.post<S.IssueMarqueResult>("/v1/fleet/issue-marque", req);
  /**
   * What `fundPatrol` would charge now for `suppressedBps` (clamped 50-1,500) over `durationGameHours` (default 60) in a zone: the
   * zone's price per bps-day (never under 2 Cr, dearer where smugglers sail lately), fixed once funded.
   */
  patrolQuote = (seaZoneId: string, suppressedBps: number, durationGameHours?: number) =>
    this.get<S.PatrolQuote>("/v1/fleet/patrol-quote", { sea_zone_id: seaZoneId, suppressed_piracy_bps: suppressedBps, duration_game_hours: durationGameHours });
  /** Charged at the zone's quoted price (`patrolQuote`), fixed for the term. */
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
  /** Buys a royal monopoly at the price `monopolyQuote` gives now (`max_price_pence` refuses it if that moved above). Never refunded. */
  buyMonopoly = (req: S.BuyMonopolyRequest) => this.post<S.MonopolyResult>("/v1/market/buy-monopoly", req);

  // ── Contracts ───────────────────────────────────────────────────────────────

  listContracts = (filter: ContractListFilter = {}) =>
    this.get<ContractListing[]>("/v1/contract/list", { ...filter });

  /**
   * Every page of a contract listing (cursor = last id), up to `maxPages` of 200. `complete` is
   * false when it stopped at the page limit with more to come.
   */
  contractPages = (filter: Omit<ContractListFilter, "cursor" | "limit"> = {}, maxPages = 10) =>
    pages((cursor) => this.listContracts({ ...filter, cursor, limit: 200 }), (c) => c.id, 200, maxPages);

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

  /** A player charter: goods delivered to our warehouse at `port_id`, the reward escrowed and the space reserved there. */
  postCharter = (req: S.PostCharterRequest) => this.post<ContractListing>("/v1/contract/post-charter", req);
  /** Withdraws one of our open charters: the undelivered reward is refunded and its warehouse space freed. */
  cancelCharter = (contractId: string) => this.post<S.CancelCharterResult>("/v1/contract/cancel-charter", { contract_id: contractId });
  /** Orders a hull built at a yard for `price_pence` (escrowed now, 50–150% of its rebuild value) by a deadline; `unlisted` keeps it off the Exchange. */
  createCommission = (req: S.CreateCommissionRequest) => this.post<S.Contract>("/v1/contract/create-commission", req);
  /** Binds us to build it (needs presence at the yard; escrows its collateral). */
  acceptCommission = (contractId: string) => this.post<S.CommissionResult>("/v1/contract/accept-commission", { contract_id: contractId });
  /** Withdraws one of our commissions nobody has accepted. */
  cancelCommission = (contractId: string) => this.post<S.CommissionResult>("/v1/contract/cancel-commission", { contract_id: contractId });
  /** Builds an accepted commission at its yard as build-ship would and hands the ship to the buyer; `409` if turnkey can't be supplied. */
  deliverCommission = (contractId: string, name: string, buildMode: BuildMode = "turnkey_cash") =>
    this.post<S.DeliverCommissionResult>("/v1/contract/deliver-commission", { contract_id: contractId, name, build_mode: buildMode });

  // Licence units for a patented design (guide 3.19): listed as `licence_offer` / `licence_request` contracts, no presence needed.
  /** The holder sells units; buyers pay from their vault in the holder's home region. */
  createLicenceOffer = (req: S.CreateLicenceContractRequest) => this.post<ContractListing>("/v1/contract/create-licence-offer", req);
  /** A buyer asks for units: the price for every unit asked is escrowed from our home-region vault. */
  createLicenceRequest = (req: S.CreateLicenceContractRequest) => this.post<ContractListing>("/v1/contract/create-licence-request", req);
  /** `per_unit`: 1..what is left; `total`: exactly what is left. */
  acceptLicenceOffer = (contractId: string, units: number) =>
    this.post<ContractListing>("/v1/contract/accept-licence-offer", { contract_id: contractId, units });
  /** The patent's holder fills a request, paid from its escrow. */
  fillLicenceRequest = (contractId: string, units: number) =>
    this.post<ContractListing>("/v1/contract/fill-licence-request", { contract_id: contractId, units });
  /** Withdraws one of our licence contracts (a request's unfilled escrow refunded). */
  cancelLicence = (contractId: string) => this.post<ContractListing>("/v1/contract/cancel-licence", { contract_id: contractId });

  // ── Passengers (guide 3.20) ─────────────────────────────────────────────────

  /** Public: the groups waiting at a port for a passage, oldest first (`kind`, `size`, `dest_port_id`, `board_by`); never what they'd pay. */
  passengersWaiting = (portId: string) => this.get<S.WaitingGroupView[]>("/v1/passengers/waiting", { port_id: portId });
  /** Public: fares groups accepted, newest first, from and/or to a port (either may be omitted); never who carried them. */
  passengerFares = (from?: string, to?: string, page: { cursor?: string; limit?: number } = {}) =>
    this.get<S.FareRecordView[]>("/v1/passengers/fares", { from, to, ...page });
  /**
   * Public: the fares board's summary (guide 3.20): per route-length band the fares accepted recently and their median per head,
   * and every route where groups gave up waiting unboarded (`unmet`, most heads first; `from`/`to` filter only that list).
   */
  passengerFaresSummary = (from?: string, to?: string) => this.get<S.FaresSummaryView>("/v1/passengers/fares/summary", { from, to });
  /** Every page of a fare listing (200 a page). */
  passengerFarePages = (from?: string, to?: string, maxPages = 10) =>
    pages((cursor) => this.passengerFares(from, to, { cursor, limit: 200 }), (f) => f.id, 200, maxPages);
  /**
   * Offers our ship lying in port (berthed or in the roadstead) to the groups there for `dest_port_id`, at most `max_berths`
   * heads in all; one open offer per ship and destination. It closes when she sails, changes hands or is lost.
   */
  postPassengerOffer = (req: S.PostOfferRequest) => this.post<S.PassengerOfferView>("/v1/passengers/offer", req);
  /** Closes one of our open sailing offers (heads already boarded stay aboard). */
  cancelPassengerOffer = (offerId: string) => this.post<S.PassengerOfferView>("/v1/passengers/cancel-offer", { offer_id: offerId });
  /** Our sailing offers, newest first; `openOnly` false adds the closed ones with their `close_reason`. */
  passengerOffers = (openOnly = true, filter: { ship_id?: string; cursor?: string; limit?: number } = {}) =>
    this.get<S.PassengerOfferView[]>("/v1/passengers/offers", { open_only: openOnly, ...filter });
  /** Every page of our sailing offers (200 a page). */
  passengerOfferPages = (openOnly = true, filter: { ship_id?: string } = {}, maxPages = 10) =>
    pages((cursor) => this.passengerOffers(openOnly, { ...filter, cursor, limit: 200 }), (o) => o.id, 200, maxPages);
  /** The groups aboard our ship: the fare agreed, `full_fare_pence` and `promised_arrival_at` (each game day later cuts the fare). */
  passengersAboard = (shipId: string) => this.get<S.AboardGroupView[]>("/v1/passengers/aboard", { ship_id: shipId });

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
  ) => this.get<S.InsurancePolicyListing[]>("/v1/insurance/list", filter);
  /** Every page of a policy listing (newest first, 200 a page). */
  policyPages = (filter: Omit<NonNullable<Parameters<KibbClient["policies"]>[0]>, "cursor" | "limit"> = {}, maxPages = 10) =>
    pages((cursor) => this.policies({ ...filter, cursor, limit: 200 }), (p) => p.id, 200, maxPages);
  /** Lloyd's posted price for insuring our ship in port to `destPortId` for `insuredValuePence`, as if written now. */
  insuranceQuote = (shipId: string, destPortId: string, insuredValuePence: number) =>
    this.get<S.LloydsQuoteResult>("/v1/insurance/quote", { ship_id: shipId, dest_port_id: destPortId, insured_value_pence: insuredValuePence });
  /** Underwriting results (Lloyd's, players, everyone): this season and over the last `days` game days (default 30). */
  lloydsList = (days?: number) => this.get<S.LloydsListResult>("/v1/insurance/lloyds-list", { days });
  /** The policy, plus Lloyd's posted price for its voyage (`lloyds_premium_bps`, `above_lloyds_price`). */
  insure = (req: S.CreateInsurancePolicyRequest) => this.post<S.CreateInsurancePolicyResult>("/v1/insurance/create", req);
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

  /**
   * Turnkey walks the port's ask book (players' asks and the NPC ladder, cheapest first) plus customs, and marks up the NPC part
   * only. A discount yard's cut is already taken off (`yard_discount`); `mortgage` gives the ship-mortgage terms (guide 3.4).
   */
  shipyardQuote = (portId: string, shipClass: string, buildMode: BuildMode = "turnkey_cash") =>
    this.get<BuildQuote>("/v1/shipyard/quote", { port_id: portId, ship_class: shipClass, build_mode: buildMode });

  /**
   * A turnkey build gets `409` when the ask book can't supply a material (or a royal monopoly bars it). `mortgage`: the yard
   * region's Goldsmiths pay 60% of the price (80% for an oceanic hull) as a ship mortgage (guide 3.4), one at a time (`409`
   * while we owe on one); build and loan stand or fall together, and the result's `mortgage` is the loan.
   */
  buildShip = (portId: string, name: string, shipClass: string, buildMode: BuildMode = "turnkey_cash", opts: { mortgage?: boolean } = {}) =>
    this.post<BuildShipResult>("/v1/shipyard/build-ship", {
      port_id: portId,
      name,
      ship_class: shipClass,
      build_mode: buildMode,
      ...(opts.mortgage ? { mortgage: true } : {}),
    });

  /**
   * Sells a ship lying at a port with an open yard to it for 35% of her rebuild value, paid by that region's Crown into our vault
   * there (guide 3.4). She must be free to change hands (empty hold, no convoy, insurance, lien, passengers or open offers, sale
   * listing, outside 64ths or venture); `409` while that Crown can't pay.
   */
  breakUpShip = (shipId: string) => this.post<S.BreakUpShipResult>("/v1/shipyard/break-up", { ship_id: shipId });

  /** Sets the cannon count; adding guns needs a shipyard port (150 Cr each). */
  modifyShip = (shipId: string, cannons: number) =>
    this.post<ShipResult>("/v1/shipyard/modify-ship", { ship_id: shipId, target_cannons_count: cannons });

  /**
   * Fits a component lying in our warehouse at the yard where the ship is berthed (slot free, no open insurance): 4% of her
   * rebuild value, and permanent (no removal or swap).
   */
  fitComponent = (shipId: string, itemId: string) => this.post<S.FitComponentResult>("/v1/shipyard/fit-component", { ship_id: shipId, item_id: itemId });

  // ── R&D (guide 3.19) ────────────────────────────────────────────────────────

  /** Whether our player may start a project now, and the live one (ours or a linked company's). */
  rndStatus = () => this.get<S.RndStatus>("/v1/rnd/status");
  /** Per slot and grade: designs still free and how many houses research it now (never the designs). */
  rndPool = () => this.get<S.PoolEntry[]>("/v1/rnd/pool");
  /** Starts a project on a slot and grade (the start fee from the home vault, never refunded); the design is drawn at random. */
  startRnd = (req: S.StartProjectRequest) => this.post<S.ProjectView>("/v1/rnd/start", req);
  /** Names another trial ship (once per project). */
  swapTrialShip = (trialShipId: string) => this.post<S.ProjectView>("/v1/rnd/trial-ship", { trial_ship_id: trialShipId });
  /** Gives the project up: nothing refunded, no cooldown. */
  abandonRnd = () => this.post<S.ProjectView>("/v1/rnd/abandon");
  /** The public patent register (`status`: `held` or `public`). */
  patentRegister = (filter: { slot?: S.Slot; status?: string } = {}) => this.get<S.PatentView[]>("/v1/rnd/register", filter);
  /** Our patents, with what each costs a game day. */
  ownPatents = () => this.get<S.OwnPatentView[]>("/v1/rnd/patents");
  /** Gives a patent up for good: its upkeep stops and anyone may make it. */
  makePatentPublic = (componentId: string) => this.post<S.PatentView>("/v1/rnd/make-public", { component_id: componentId });
  /** Our licence units by design (granted, used, left), with what making one takes. */
  licences = () => this.get<S.LicenceView[]>("/v1/rnd/licences");
  /** Makes 1-10 components at a yard from the materials in our warehouse there plus its labour (a licence unit each unless ours or public). */
  makeComponents = (req: S.MakeComponentRequest) => this.post<S.MakeComponentResult>("/v1/rnd/make", req);
  /** Components we made and haven't fitted, where they lie. */
  components = () => this.get<S.ComponentItemView[]>("/v1/rnd/components");

  // ── Treasury ────────────────────────────────────────────────────────────────

  vaults = () => this.get<TreasuryVaults>("/v1/treasury/vaults");
  rates = () => this.get<AchRate[]>("/v1/treasury/rates");

  remit = (from: BankingRegion, to: BankingRegion, grossPence: number) =>
    this.post<RemitResult>("/v1/treasury/remit", { from_region: from, to_region: to, gross_amount_pence: grossPence });

  ledger = (filter: { cursor?: string; limit?: number; banking_region?: BankingRegion; reason?: string } = {}) =>
    this.get<S.LedgerEntry[]>("/v1/treasury/ledger", filter);

  // ── Loans (by quote, guide 3.13.1-3.13.2) ───────────────────────────────────

  /**
   * Loans we made (`lender`) or owe (`borrower`), or both, newest first: `owed_pence`, the fixed `annual_rate_bps`
   * (`rate_basis: "daily"`: an older loan on `daily_rate_bps`), `total_repayable_pence` and the next payment due.
   * `is_mortgage`: a ship mortgage taken with a build (guide 3.4).
   */
  loans = (filter: { role?: S.LoanRole; status?: S.LoanStatus; cursor?: string; limit?: number } = {}) =>
    this.get<S.Loan[]>("/v1/loan/list", filter);
  /** Every page of our loans (50 a page: the docs give this endpoint no maximum). */
  loanPages = (filter: { role?: S.LoanRole; status?: S.LoanStatus } = {}, maxPages = 10) =>
    pages((cursor) => this.loans({ ...filter, cursor, limit: 50 }), (l) => l.id, 50, maxPages);
  /** Any company's public credit record (defaults, walk-aways, smuggling convictions, `open_mortgages`). */
  creditReport = (companyId: string) => this.get<S.CreditReport>("/v1/loan/credit", { company_id: companyId });
  /**
   * The Goldsmiths' instant quote (default region: home) against a lien on one of our ships: at most 40% of its rebuild
   * value and 7,500 Cr, 1-360 game days, with recourse. Stored for 6 game hours: take it with `acceptLoanQuote`. 400 over
   * what it lends on the ship; 409 the ship is liened, listed or carries a venture.
   */
  loanQuote = (q: { principal_pence: number; term_game_days: number; repayment: S.LoanRepayment; ship_id: string; banking_region?: BankingRegion }) =>
    this.get<S.GoldsmithsQuote>("/v1/loan/quote", q);
  /** Takes a Goldsmiths' quote before it expires: the lien goes on and the principal lands in the quote's region. */
  acceptLoanQuote = (quoteId: string) => this.post<S.Loan>("/v1/loan/accept-quote", { quote_id: quoteId });
  /**
   * Asks lenders for quotes, open 1-72 game hours (default 24). Nothing is escrowed; the pledge is checked now and at approval.
   * `collateral_kind: "deposit"` with `deposit_id`: only the bank holding it may quote, always with recourse (guide 3.13.4).
   */
  postLoanRequest = (req: S.PostLoanRequest) => this.post<S.LoanRequestView>("/v1/loan/request", req);
  /**
   * Open requests (oldest first; `banking_region` narrows them) with their rate bounds and our own quotes on them; `mine`:
   * our own requests of any status (newest first) with every quote. No cursor: at most `limit` (default 200) come back.
   */
  loanRequests = (filter: { banking_region?: BankingRegion; mine?: boolean; limit?: number } = {}) =>
    this.get<S.LoanRequestView[]>("/v1/loan/requests", { limit: 200, ...filter });
  /** Quotes a request at `annual_rate_bps` (within its bounds; never our own company's): the principal is escrowed from our vault in its region. */
  quoteLoanRequest = (requestId: string, annualRateBps: number) =>
    this.post<S.LoanQuote>("/v1/loan/quote-request", { request_id: requestId, annual_rate_bps: annualRateBps });
  /** Takes back one of our quotes the borrower hasn't approved: its escrow returns to our vault. */
  withdrawLoanQuote = (quoteId: string) => this.post<S.LoanQuote>("/v1/loan/withdraw-quote", { quote_id: quoteId });
  /** Approves a quote on one of our requests: the loan is disbursed, every other quote released and the request closed. */
  approveLoanQuote = (quoteId: string) => this.post<S.Loan>("/v1/loan/approve", { quote_id: quoteId });
  /** Pays `amountPence` (omitted: everything owed) from our vault in the loan's region: arrears first, interest to date, then principal. */
  repayLoan = (loanId: string, amountPence?: number) =>
    this.post<S.Loan>("/v1/loan/repay", { loan_id: loanId, amount_pence: amountPence });
  /**
   * Walks away from a loan we owe (guide 3.13.1): the lender takes the collateral and the rest is written off, permanently
   * on our credit record. By hand only: the autopilot never calls it.
   */
  walkAwayFromLoan = (loanId: string) => this.post<S.Loan>("/v1/loan/default", { loan_id: loanId });

  // ── The Free Trade (guide 3.18; scope `underworld`) ─────────────────────────

  /** A cove's book (house ask, players' bids and asks), seen only from a ship of ours at the cove (`403 no_ship_at_cove`). */
  underworldBook = (portId: string, commodityId?: string) =>
    this.get<S.CoveBookResult>("/v1/underworld/book", { port_id: portId, commodity_id: commodityId });
  /** Trades from our ship lying at the cove, ship to ship, paid vault to vault in the cove's region. */
  underworldOrder = (req: S.UnderworldOrderRequest) => this.post<S.UnderworldOrderResult>("/v1/underworld/order", req);
  underworldCancelOrder = (orderId: string) => this.post<S.CancelUnderworldOrderResult>("/v1/underworld/cancel-order", { order_id: orderId });
  underworldOrders = (filter: { port_id?: string; open_only?: boolean; cursor?: string; limit?: number } = {}) =>
    this.get<S.UnderworldOrderView[]>("/v1/underworld/orders", filter);
  /** Every page of our cove orders (200 a page). */
  underworldOrderPages = (filter: { port_id?: string; open_only?: boolean } = {}, maxPages = 10) =>
    pages((cursor) => this.underworldOrders({ ...filter, cursor, limit: 200 }), (o) => o.id, 200, maxPages);
  /** An ordinary port's live wants (a ship or factor there), or at a cove its board of wants carried in by ships. */
  underworldWants = (portId: string) => this.get<S.WantsResult>("/v1/underworld/wants", { port_id: portId });
  /** Runs goods ashore from our ship anchored in the roadstead of a port with a live want; priced when it completes. */
  runAshore = (req: S.RunAshoreRequest) => this.post<S.RunAshoreResult>("/v1/underworld/run", req);

  // ── Banks ───────────────────────────────────────────────────────────────────

  /** Every bank open or winding down, largest first. */
  banks = () => this.get<S.BankResult[]>("/v1/bank/list");
  bankStatus = (companyId: string) => this.get<S.BankResult>("/v1/bank/status", { company_id: companyId });
  /** Our deposits (for a bank, the deposits it holds). */
  deposits = () => this.get<S.DepositResult[]>("/v1/bank/deposits");
  deposit = (req: S.DepositRequest) => this.post<S.DepositResult>("/v1/bank/deposit", req);
  /**
   * A demand deposit is paid at once as far as the bank's cash reaches; a notice deposit after its notice. `toRegion`: paid into
   * our vault there less the bank's posted `exchange_fee_bps` for it, fixed when asked (guide 3.13.4); a region it doesn't offer is `409`.
   */
  withdrawDeposit = (depositId: string, amountPence?: number, toRegion?: BankingRegion) =>
    this.post<S.DepositResult>("/v1/bank/withdraw", { deposit_id: depositId, amount_pence: amountPence, to_region: toRegion });
  /** Takes a royal banking charter on these terms (`exchange_fee_bps`: region → fee on withdrawals paid into a vault there). */
  charterBank = (req: S.BankTermsRequest) => this.post<S.BankResult>("/v1/bank/charter", req);
  /** Our bank's terms for new deposits; `exchange_fee_bps` omitted keeps the schedule, `{}` withdraws every exchange offer. */
  setBankTerms = (req: S.BankTermsRequest) => this.post<S.BankResult>("/v1/bank/terms", req);
  windDownBank = () => this.post<S.BankResult>("/v1/bank/wind-down");
  /** Private client terms (guide 3.13.4): those our bank gives, and those banks give us, newest change first. */
  clientTerms = () => this.get<S.ClientTermsResult[]>("/v1/bank/client-terms");
  /** Our bank's terms for one company: `rate_bonus_bps` (0-50) on its deposits, `exchange_discount_bps` (0-1,200) off its fees; both 0 clears them. */
  setClientTerms = (req: S.ClientTermsRequest) => this.post<S.ClientTermsResult>("/v1/bank/client-terms", req);

  /**
   * Open lending lines (guide 3.13.8), cheapest share of the Goldsmiths' rate first (one bank's: `company_id`; lending in a
   * region: `banking_region`). A line quotes on its own on every matching loan request the moment it is posted.
   */
  lendingLines = (filter: { company_id?: string; banking_region?: BankingRegion } = {}) => this.get<S.LendingLine[]>("/v1/bank/lending-lines", filter);
  /** Our open bank's standing terms, matched against loan requests on their own (public: `lending_line_posted`, on the Exchange). */
  postLendingLine = (terms: S.LendingLineTerms) => this.post<S.LendingLine>("/v1/bank/lending-line", terms);
  /** Replaces a line's terms in full; quotes already made stand. */
  updateLendingLine = (req: S.UpdateLendingLine) => this.post<S.LendingLine>("/v1/bank/lending-line/update", req);
  /** Closes a line and releases its open quotes (escrow refunded); loans it made run on. */
  withdrawLendingLine = (lineId: string) => this.post<S.WithdrawnLine>("/v1/bank/lending-line/withdraw", { line_id: lineId });

  // ── Ventures (commenda) ─────────────────────────────────────────────────────

  /** With `port_id`: ventures raising capital there. Without: our own ventures and those we hold a stake in. */
  ventures = (filter: { port_id?: string; status?: string } = {}) => this.get<S.Venture[]>("/v1/venture/list", filter);
  /** `unlisted` keeps it off the Exchange, seen only on the origin's quay (guide 3.21). */
  openVenture = (req: S.OpenVentureRequest) => this.post<S.Venture>("/v1/venture/open", req);
  investInVenture = (ventureId: string, amountPence: number) =>
    this.post<S.Venture>("/v1/venture/invest", { venture_id: ventureId, amount_pence: amountPence });
  /** An IOC buy into the venture's ship at its origin, reimbursed at once from the venture's capital. */
  buyVentureCargo = (req: S.VentureTradeRequest) => this.post<S.Venture>("/v1/venture/buy", req);
  /** Sells the venture's cargo at its destination. */
  sellVentureCargo = (req: S.VentureTradeRequest) => this.post<S.Venture>("/v1/venture/sell", req);
  /** Settles our venture (before sailing: cancels it). */
  settleVenture = (ventureId: string) => this.post<S.Venture>("/v1/venture/settle", { venture_id: ventureId });

  // ── Ship shares (64ths) ─────────────────────────────────────────────────────

  /** Open listings of ship 64ths (of one ship, or all). */
  shareListings = (shipId?: string) => this.get<S.ShareListing[]>("/v1/ship-shares/listings", { ship_id: shipId });
  /** Our 64ths of other companies' ships, and our ships with outside holders. */
  shareHoldings = () => this.get<S.ShareHolding[]>("/v1/ship-shares/holdings");
  listShares = (req: S.ListSharesRequest) => this.post<S.ShareListing>("/v1/ship-shares/list", req);
  buyShares = (listingId: string) => this.post<S.ShareListing>("/v1/ship-shares/buy", { listing_id: listingId });
  cancelShareListing = (listingId: string) => this.post<S.ShareListing>("/v1/ship-shares/cancel", { listing_id: listingId });

  // ── Intelligence envelopes ──────────────────────────────────────────────────

  /** Public: open envelopes for sale anywhere, newest first (never their contents). */
  envelopes = (
    filter: { port_id?: string; category?: S.EnvelopeCategory; covers_port_id?: string; cursor?: string; limit?: number } = {},
  ) => this.get<S.EnvelopeListing[]>("/v1/envelope/list", filter);
  /** Every page of an envelope listing (200 a page). */
  envelopePages = (filter: Omit<NonNullable<Parameters<KibbClient["envelopes"]>[0]>, "cursor" | "limit"> = {}, maxPages = 10) =>
    pages((cursor) => this.envelopes({ ...filter, cursor, limit: 200 }), (e) => e.id, 200, maxPages);
  /** Envelopes we sealed (any status) or bought, with their contents. */
  myEnvelopes = (filter: { role?: S.EnvelopeRole; cursor?: string; limit?: number } = {}) =>
    this.get<S.EnvelopeDetail[]>("/v1/envelope/mine", filter);
  /** Every page of our envelopes (200 a page). */
  myEnvelopePages = (filter: { role?: S.EnvelopeRole } = {}, maxPages = 10) =>
    pages((cursor) => this.myEnvelopes({ ...filter, cursor, limit: 200 }), (e) => e.id, 200, maxPages);
  /** Seals news we hold at a port with quay presence and lists it (at most 20 open). */
  postEnvelope = (req: S.PostEnvelopeRequest) => this.post<S.EnvelopeDetail>("/v1/envelope/post", req);
  /** Needs presence (storage tier or better) at the envelope's port. */
  buyEnvelope = (envelopeId: string) => this.post<S.EnvelopeDetail>("/v1/envelope/buy", { envelope_id: envelopeId });
  withdrawEnvelope = (envelopeId: string) => this.post<S.EnvelopeListing>("/v1/envelope/withdraw", { envelope_id: envelopeId });

  // ── The Exchange and the bulletin (guide 3.21; reads are public) ────────────

  /** Every open player offer world-wide, newest first (default 50, at most 200 a page; the answer's `next_cursor` pages on). */
  exchange = (filter: { kind?: S.ExchangeKind; region?: BankingRegion; since?: string; cursor?: string; limit?: number } = {}) =>
    this.get<S.ExchangePage>("/v1/exchange", filter);
  /** Every page of the Exchange (200 a page). */
  exchangePages = (filter: { kind?: S.ExchangeKind; region?: BankingRegion; since?: string } = {}, maxPages = 10) =>
    nextCursorPages((cursor) => this.exchange({ ...filter, cursor, limit: 200 }), (p) => p.entries, maxPages);
  /** Pins a note to our own open entry: plain words, at most 200 characters, no digits (`400`); empty or null clears it. */
  setExchangeNote = (kind: S.ExchangeKind, id: string, note: string | null) =>
    this.post<S.ExchangeEntry>("/v1/exchange/note", { kind, id, note });

  /** Threads, most recently active first (`since`: a post after then; default 30, at most 100 a page; `next_cursor` pages on). */
  bulletin = (query: { since?: string; cursor?: string; limit?: number } = {}) => this.get<S.BulletinPage>("/v1/bulletin", query);
  /** A thread with every post, oldest first. */
  bulletinThread = (threadId: string) => this.get<S.BulletinThreadDetail>("/v1/bulletin/thread", { id: threadId });
  /**
   * Opens a thread signed with our company's name (title 1-120, body 1-1,000 characters; `link`: an Exchange entry or a company).
   * At most 10 posts, 3 of them new threads, a real hour (`429 bulletin_limit`, thrown at once).
   */
  openBulletinThread = (req: S.CreateThreadRequest) => this.post<S.BulletinThreadDetail>("/v1/bulletin/thread", req);
  /** Replies to a thread (1-1,000 characters); an archived or removed one is `409`. Counts against the hourly 10. */
  replyBulletin = (threadId: string, body: string) => this.post<S.BulletinPost>("/v1/bulletin/reply", { thread_id: threadId, body });
  /** Replaces our post's body (and an opening post's `title`) within 10 real minutes of posting (`409` after). */
  editBulletin = (postId: string, body: string, title?: string) => this.post<S.BulletinPost>("/v1/bulletin/edit", { post_id: postId, body, title });
  /** Deletes our post within 10 real minutes: it keeps its place as `deleted by its author` and still counts against the limit. */
  deleteBulletin = (postId: string) => this.post<S.BulletinPost>("/v1/bulletin/delete", { post_id: postId });
  /** Asks the harbourmaster to look at a post (`reason` 1-200 characters): once per post (`409`), never our own (`400`). */
  flagBulletin = (postId: string, reason: string) => this.post<S.FlagResult>("/v1/bulletin/flag", { post_id: postId, reason });
}
