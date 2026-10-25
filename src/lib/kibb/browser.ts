/**
 * Browser-side calls to the dashboard's own routes (`/api/kibb/*`). The server adds the API key.
 * Safe to import from client components (no Node imports).
 */

export class DashboardApiError extends Error {
  constructor(
    public status: number,
    public code: string | undefined,
    public detail: string,
  ) {
    super(detail);
    this.name = "DashboardApiError";
  }
}

type Query = Record<string, string | number | boolean | undefined | null>;

function qs(query?: Query): string {
  if (!query) return "";
  const parts = Object.entries(query)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  return parts.length ? `?${parts.join("&")}` : "";
}

/** Idempotency-Keys of proxy writes whose outcome is unknown, by `${method} ${url} ${body}` (survives a reload). */
const IDEM_STORE = "kibb-idem";
const IDEM_TTL_MS = 30 * 60_000;
type IdemKeys = Record<string, { key: string; at: number }>;

function idemKeys(): IdemKeys {
  try {
    const all = JSON.parse(sessionStorage.getItem(IDEM_STORE) ?? "{}") as IdemKeys;
    const now = Date.now();
    return Object.fromEntries(Object.entries(all).filter(([, v]) => typeof v?.key === "string" && now - v.at < IDEM_TTL_MS));
  } catch {
    return {};
  }
}

function saveIdemKeys(keys: IdemKeys): void {
  try {
    sessionStorage.setItem(IDEM_STORE, JSON.stringify(keys));
  } catch {
    // Storage full or blocked: the key lasts this attempt only.
  }
}

/** A random v4-style key: crypto.randomUUID needs HTTPS in the browser, getRandomValues doesn't. */
function newIdemKey(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * A write through the kibb.io proxy with one Idempotency-Key per user action. The key is kept (30 min) while
 * the outcome is unknown: no answer, any 5xx (the proxy's 502/504 too), still in flight, or a 429 after an
 * attempt that may have landed. Pressing the button again then replays the first attempt instead of acting
 * twice. A definite answer drops it, so the next press is a new action. Only proxy paths carry a key: the
 * dashboard's own routes (sign-in, passphrases) take none, and their bodies are never kept.
 */
export async function writeFetch(method: "POST" | "PATCH", url: string, body?: string): Promise<Response> {
  const headers: Record<string, string> = body !== undefined ? { "content-type": "application/json" } : {};
  const init = { method, headers, body, cache: "no-store" as const };
  if (!url.startsWith("/api/kibb/v1/") || typeof window === "undefined") return fetch(url, init);
  const action = `${method} ${url} ${body ?? ""}`;
  const keys = idemKeys();
  const had = keys[action];
  const key = had?.key ?? newIdemKey();
  // Saved before sending: a reload mid-request still retries with this key.
  saveIdemKeys({ ...keys, [action]: { key, at: Date.now() } });
  const res = await fetch(url, { ...init, headers: { ...headers, "idempotency-key": key } });
  let unknown = res.status >= 500;
  if (res.status === 409) {
    const code = await res
      .clone()
      .json()
      .then((p: { code?: string } | null) => p?.code, () => undefined);
    unknown = code === "idempotency_request_in_flight";
  }
  // The limiter answered, not the handler: a key that may have landed earlier is kept, unless this 429 is its replayed answer.
  if (res.status === 429) unknown = !!had && res.headers.get("idempotency-replayed") !== "true";
  if (!unknown) {
    const left = idemKeys();
    delete left[action];
    saveIdemKeys(left);
  }
  return res;
}

async function call<T>(method: "GET" | "POST" | "PATCH", url: string, body?: unknown): Promise<T> {
  const res =
    method === "GET"
      ? await fetch(url, { method, cache: "no-store" })
      : await writeFetch(method, url, body !== undefined ? JSON.stringify(body) : undefined);
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const p = (data && typeof data === "object" ? data : {}) as { code?: string; detail?: string; title?: string };
    // Session gone: send the user back to the right step.
    if (res.status === 401 && typeof window !== "undefined") {
      if (p.code === "not_signed_in") window.location.href = "/login";
      else if (p.code === "no_company_key" || p.code === "no_company") window.location.href = "/companies";
    }
    throw new DashboardApiError(res.status, p.code, p.detail ?? p.title ?? (typeof data === "string" && data ? data : res.statusText));
  }
  return data as T;
}

export const dash = {
  get: <T>(url: string, query?: Query) => call<T>("GET", `${url}${qs(query)}`),
  post: <T>(url: string, body: unknown = {}) => call<T>("POST", url, body),
  patch: <T>(url: string, body: unknown = {}) => call<T>("PATCH", url, body),
};

/** GET a kibb.io API path (e.g. `/v1/fleet/ships`) through the dashboard proxy. */
export const kibbGet = <T>(path: string, query?: Query) => dash.get<T>(`/api/kibb${path}`, query);

/** POST to a kibb.io API path through the dashboard proxy. */
export const kibbPost = <T>(path: string, body: unknown) => dash.post<T>(`/api/kibb${path}`, body);
