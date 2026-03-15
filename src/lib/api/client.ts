import type { ApiError } from "@/lib/types";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ── Environment detection ────────────────────────────────────────────────────
// In the browser: use the Next.js proxy at /api (it adds auth headers).
// In Node.js (worker process): call the upstream API directly with auth headers.

const IS_SERVER = typeof window === "undefined";
const BASE_URL = IS_SERVER
  ? `${process.env.TRADEWINDS_API_URL ?? "https://tradewinds.fly.dev"}/api/v1`
  : "/api";

// Runtime overrides set by the standalone worker after resolving credentials.
let _workerToken     = "";
let _workerCompanyId = "";

/** Set auth context for worker process API calls (avoids mutating process.env). */
export function setWorkerContext(token: string, companyId: string): void {
  _workerToken     = token;
  _workerCompanyId = companyId;
  console.log(`[setWorkerContext] token=${token ? `set(${token.slice(0, 8)}…)` : "EMPTY"} companyId=${companyId || "EMPTY"}`);
}

function buildHeaders(init?: HeadersInit): HeadersInit {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(init as Record<string, string> | undefined),
  };
  if (IS_SERVER) {
    const token     = _workerToken     || process.env.TRADEWINDS_TOKEN     || "";
    const companyId = _workerCompanyId || process.env.TRADEWINDS_COMPANY_ID || "";
    if (token)     headers["Authorization"]         = `Bearer ${token}`;
    if (companyId) headers["tradewinds-company-id"] = companyId;
    if (!token || !companyId) {
      console.warn(`[buildHeaders] WARNING: IS_SERVER=true but token=${token ? "set" : "EMPTY"} companyId=${companyId || "EMPTY"}`);
    }
  }
  return headers;
}


// API limit: ~900 req/60s = 15 req/s. We target 10 req/s for headroom.
const RATE_LIMIT_RPS = 10;
const REFILL_INTERVAL_MS = 1000 / RATE_LIMIT_RPS; // 125ms per token

let tokens = RATE_LIMIT_RPS * 3; // start with a small burst allowance
let lastRefill = Date.now();
const waitQueue: Array<() => void> = [];

function refillTokens() {
  const now = Date.now();
  const newTokens = Math.floor((now - lastRefill) / REFILL_INTERVAL_MS);
  if (newTokens > 0) {
    tokens = Math.min(tokens + newTokens, RATE_LIMIT_RPS * 3);
    lastRefill += newTokens * REFILL_INTERVAL_MS;
  }
}

function acquireToken(): Promise<void> {
  refillTokens();
  if (tokens > 0) {
    tokens--;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    waitQueue.push(resolve);
    scheduleRelease();
  });
}

let releaseScheduled = false;
function scheduleRelease() {
  if (releaseScheduled) return;
  releaseScheduled = true;
  setTimeout(() => {
    releaseScheduled = false;
    refillTokens();
    while (tokens > 0 && waitQueue.length > 0) {
      tokens--;
      waitQueue.shift()!();
    }
    if (waitQueue.length > 0) scheduleRelease();
  }, REFILL_INTERVAL_MS);
}

// ── Error types ─────────────────────────────────────────────────────────────

export class ApiRequestError extends Error {
  constructor(
    public status: number,
    public body: ApiError,
  ) {
    const detail = body.message ?? body.error ?? formatErrors(body.errors) ?? `HTTP ${status}`;
    super(detail);
    this.name = "ApiRequestError";
  }
}

function formatErrors(errors: Record<string, string | string[]> | undefined): string | undefined {
  if (!errors) return undefined;
  return Object.entries(errors)
    .map(([field, msgs]) => `${field}: ${Array.isArray(msgs) ? msgs.join(", ") : msgs}`)
    .join("; ");
}

const REQUEST_TIMEOUT_MS = 60_000;
const MAX_RETRIES = 2;

async function requestCore(
  path: string,
  options: RequestInit = {},
  attempt = 0,
): Promise<Response> {
  await acquireToken();

  const url = `${BASE_URL}${path}`;
  let res: Response;
  try {
    res = await fetch(url, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: buildHeaders(options.headers),
      ...options,
    });
  } catch (e) {
    // Timeout or network error — retry on idempotent methods
    if (attempt < MAX_RETRIES && (!options.method || options.method === "GET")) {
      await sleep(1_000 * (attempt + 1));
      return requestCore(path, options, attempt + 1);
    }
    throw e;
  }

  // Retry on 5xx for idempotent methods
  if (res.status >= 500 && attempt < MAX_RETRIES && (!options.method || options.method === "GET")) {
    await sleep(1_000 * (attempt + 1));
    return requestCore(path, options, attempt + 1);
  }

  if (!res.ok) {
    let body: ApiError;
    try {
      body = await res.json();
    } catch {
      body = { error: res.statusText, status: res.status };
    }
    throw new ApiRequestError(res.status, body);
  }

  return res;
}

/** Standard request — auto-unwraps the `{ data: T }` envelope. */
async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await requestCore(path, options);
  if (res.status === 204) return undefined as unknown as T;
  const { data } = await res.json();
  return data;
}

/** Raw request — returns the full JSON body without unwrapping `data`. */
export async function requestRaw<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await requestCore(path, options);
  if (res.status === 204) return undefined as unknown as T;
  return res.json();
}

type Paginated<T> = { data: T[]; metadata?: { after?: string | null } };

/** Fetch all pages of a cursor-paginated endpoint, returning a flat array. */
export async function fetchAllPages<T>(baseUrl: string): Promise<T[]> {
  const results: T[] = [];
  let after: string | null = null;
  do {
    const url: string = after
      ? `${baseUrl}${baseUrl.includes("?") ? "&" : "?"}after=${encodeURIComponent(after)}`
      : baseUrl;
    const page = await requestRaw<Paginated<T>>(url);
    results.push(...page.data);
    after = page.metadata?.after ?? null;
  } while (after);
  return results;
}

export const api = {
  get: <T>(path: string, options?: RequestInit) =>
    request<T>(path, { method: "GET", ...options }),

  post: <T>(path: string, body?: unknown, options?: RequestInit) => {
    return request<T>(path, {
      method: "POST",
      body: body !== undefined ? JSON.stringify(body) : undefined,
      ...options,
    })
  },

  patch: <T>(path: string, body?: unknown, options?: RequestInit) =>
    request<T>(path, {
      method: "PATCH",
      body: body !== undefined ? JSON.stringify(body) : undefined,
      ...options,
    }),

  delete: <T>(path: string, options?: RequestInit) =>
    request<T>(path, { method: "DELETE", ...options }),
};
