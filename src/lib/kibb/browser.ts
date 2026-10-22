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

async function call<T>(method: "GET" | "POST", url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    cache: "no-store",
  });
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
};

/** GET a kibb.io API path (e.g. `/v1/fleet/ships`) through the dashboard proxy. */
export const kibbGet = <T>(path: string, query?: Query) => dash.get<T>(`/api/kibb${path}`, query);

/** POST to a kibb.io API path through the dashboard proxy. */
export const kibbPost = <T>(path: string, body: unknown) => dash.post<T>(`/api/kibb${path}`, body);
