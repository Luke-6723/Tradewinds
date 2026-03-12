import type { ApiError } from "@/lib/types";

// ── Environment detection ────────────────────────────────────────────────────
// In the browser: use the Next.js proxy at /api (it adds auth headers).
// In Node.js (worker process): call the upstream API directly with auth headers.

const IS_SERVER = typeof window === "undefined";
const BASE_URL = IS_SERVER
  ? `${process.env.TRADEWINDS_API_URL ?? "https://tradewinds.fly.dev"}/api/v1`
  : "/api";

function buildHeaders(init?: HeadersInit): HeadersInit {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(init as Record<string, string> | undefined),
  };
  if (IS_SERVER) {
    if (process.env.TRADEWINDS_TOKEN)
      headers["Authorization"] = `Bearer ${process.env.TRADEWINDS_TOKEN}`;
    if (process.env.TRADEWINDS_COMPANY_ID)
      headers["tradewinds-company-id"] = process.env.TRADEWINDS_COMPANY_ID;
  }
  return headers;
}


// API limit: 300 req/60s. We target 4 req/s (240/min) for headroom.
const RATE_LIMIT_RPS = 4;
const REFILL_INTERVAL_MS = 1000 / RATE_LIMIT_RPS; // 250ms per token

let tokens = RATE_LIMIT_RPS * 2; // start with a small burst allowance
let lastRefill = Date.now();
const waitQueue: Array<() => void> = [];

function refillTokens() {
  const now = Date.now();
  const newTokens = Math.floor((now - lastRefill) / REFILL_INTERVAL_MS);
  if (newTokens > 0) {
    tokens = Math.min(tokens + newTokens, RATE_LIMIT_RPS * 2);
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

async function request<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  await acquireToken();

  const url = `${BASE_URL}${path}`;
  const res = await fetch(url, {
    headers: buildHeaders(options.headers),
    ...options,
  });

  if (!res.ok) {
    let body: ApiError;
    try {
      body = await res.json();
    } catch {
      body = { error: res.statusText, status: res.status };
    }
    throw new ApiRequestError(res.status, body);
  }

  if (res.status === 204) return undefined as unknown as T;
  const { data } = await res.json();
  return data;
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
