/**
 * Token refresh utility — server/worker only.
 *
 * Calls the upstream login endpoint with credentials from environment variables
 * (TRADEWINDS_EMAIL / TRADEWINDS_PASSWORD) and returns a fresh token.
 *
 * Used by:
 *  - autopilot-worker: scheduled every 16 h, also on 401
 *  - proxy route: on 401 from upstream, retry once with fresh token
 */

import { UPSTREAM } from "@/lib/auth-cookies";
import { getAutopilotCredentials } from "@/lib/db/collections";

/** Login and return a fresh bearer token. Throws on failure. */
export async function refreshToken(): Promise<string> {
  let email    = process.env.TRADEWINDS_EMAIL    ?? "";
  let password = process.env.TRADEWINDS_PASSWORD ?? "";

  // Fall back to MongoDB-stored credentials (set on dashboard login)
  if (!email || !password) {
    const stored = await getAutopilotCredentials();
    if (stored) { email = stored.email; password = stored.password; }
  }

  if (!email || !password) {
    throw new Error("No credentials available — log in via the dashboard first");
  }

  const res = await fetch(`${UPSTREAM}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });

  if (!res.ok) {
    throw new Error(`Token refresh failed: HTTP ${res.status}`);
  }

  const data = (await res.json()) as { data?: { token?: string } };
  const token = data?.data?.token;
  if (!token) throw new Error("Token refresh: no token in response");

  return token;
}
