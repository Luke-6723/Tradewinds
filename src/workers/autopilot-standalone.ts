/**
 * Standalone autopilot process — run via pm2, separate from the Next.js dashboard.
 *
 * Communicates with the dashboard exclusively through MongoDB:
 *   - Reads enable/disable commands from `autopilot_commands` collection (polls every 2 s)
 *   - Writes state to `autopilot_states` collection after every cycle / SSE event
 *
 * No IPC / child_process — can be restarted independently of the dashboard.
 *
 * Required env vars (loaded from .env.local by ecosystem.config.cjs):
 *   MONGODB_URI, TRADEWINDS_COMPANY_ID, TRADEWINDS_API_URL
 *   Credentials are read from MongoDB (stored on first dashboard login).
 */

import { handlePassengerEvent, runCycle } from "@/lib/autopilot";
import { appendLog, blank, CYCLE_MS, type AutopilotState } from "@/lib/autopilot-types";
import {
  loadAutopilotState,
  saveAutopilotState,
  getAutopilotCommand,
  getAutopilotCredentials,
} from "@/lib/db/collections";
import { UPSTREAM } from "@/lib/auth-cookies";
import { refreshToken as doRefreshToken } from "@/lib/server/token-refresh";
import { setWorkerContext } from "@/lib/api/client";

// Company ID: prefer env (allows overriding), fall back to MongoDB-stored value
async function resolveCompanyId(): Promise<string> {
  if (process.env.TRADEWINDS_COMPANY_ID) return process.env.TRADEWINDS_COMPANY_ID;
  const creds = await getAutopilotCredentials();
  if (creds?.companyId) return creds.companyId;
  throw new Error("No company ID available — select a company in the dashboard first");
}

let companyId = "unknown";
let token = "";

let state: AutopilotState = blank();
let timer: ReturnType<typeof setInterval> | null = null;
let esAbort: AbortController | null = null;
let cycleRunning = false;
let activeRunId = 0;

function sendState(): void {
  void saveAutopilotState(companyId, state);
}

// ── Token refresh ──────────────────────────────────────────────────────────────

const TOKEN_REFRESH_INTERVAL_MS = 16 * 60 * 60 * 1000;

async function rotateToken(): Promise<void> {
  try {
    const newToken = await doRefreshToken();
    token = newToken;
    setWorkerContext(token, companyId);
    startEventStream();
    state = appendLog(state, "🔑 Token refreshed");
    sendState();
  } catch (e: unknown) {
    state = appendLog(state, `⚠️ Token refresh failed: ${(e as Error).message}`);
    sendState();
  }
}

setInterval(() => void rotateToken(), TOKEN_REFRESH_INTERVAL_MS);

// ── Cycle ──────────────────────────────────────────────────────────────────────

const CYCLE_TIMEOUT_MS = 900_000; // 15 min — large fleets can run much longer

async function tick(): Promise<void> {
  if (!state.enabled || cycleRunning) return;
  console.log(`[tick] starting cycle — token=${token ? "set" : "EMPTY"} companyId=${companyId}`);
  cycleRunning = true;
  const runId = ++activeRunId;
  const guard = setTimeout(() => {
    if (runId !== activeRunId) return;
    console.warn(`[tick] CYCLE_TIMEOUT guard fired after ${CYCLE_TIMEOUT_MS / 1000}s — resetting cycleRunning`);
    cycleRunning = false;
  }, CYCLE_TIMEOUT_MS);
  try {
    state = await runCycle(state, companyId);
  } catch (e: unknown) {
    state = appendLog(state, `Fatal cycle error: ${(e as Error).message}`);
    console.error(`[tick] fatal cycle error: ${(e as Error).message}`);
  } finally {
    clearTimeout(guard);
    if (runId === activeRunId) cycleRunning = false;
  }
  sendState();
}

// ── SSE stream ─────────────────────────────────────────────────────────────────

interface PassengerEventData {
  id: string;
  origin_port_id: string;
  destination_port_id: string;
  bid: number;
  count: number;
  expires_at: string;
}

function startEventStream(): void {
  if (esAbort) { esAbort.abort(); esAbort = null; }
  if (!token) return;
  esAbort = new AbortController();

  void (async () => {
    try {
      const res = await fetch(`${UPSTREAM}/api/v1/world/events`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: esAbort!.signal,
      });

      if (!res.ok || !res.body) throw new Error(`SSE connect failed: ${res.status}`);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          const raw = line.slice(5).trim();
          if (!raw) continue;
          try {
            const event = JSON.parse(raw) as { type: string; data: unknown };
            if (event.type === "passenger_request_created" && state.enabled && !cycleRunning) {
              cycleRunning = true;
              const runId = ++activeRunId;
              const guard = setTimeout(() => {
                if (runId !== activeRunId) return;
                cycleRunning = false;
              }, CYCLE_TIMEOUT_MS);
              try {
                state = await handlePassengerEvent(state, companyId, event.data as PassengerEventData);
              } finally {
                clearTimeout(guard);
                if (runId === activeRunId) cycleRunning = false;
              }
              sendState();
              void saveAutopilotState(companyId, state);
            }
          } catch { /* non-JSON line */ }
        }
      }
    } catch (e: unknown) {
      if ((e as Error).name === "AbortError") return;
      if (state.enabled) setTimeout(() => startEventStream(), 5_000);
    }
  })();
}

// ── Command polling ────────────────────────────────────────────────────────────

let lastCommandUpdatedAt: Date | null = null;

async function checkCommands(): Promise<void> {
  try {
    // If we started before credentials were stored, retry resolving company ID
    if (companyId === "unknown") {
      try {
        companyId = await resolveCompanyId();
        setWorkerContext(token, companyId);
        console.log(`[autopilot:${companyId.slice(0, 8)}] company ID resolved`);
      } catch {
        return; // still no credentials — try again next poll
      }
    }

    const cmd = await getAutopilotCommand(companyId);
    if (!cmd) return;

    // Always sync fleetTarget — repull every poll so frontend changes are picked up immediately
    const wantsFleetTarget: number | undefined = cmd.fleetTarget ?? undefined;
    if (wantsFleetTarget !== state.fleetMgmt?.fleetTarget) {
      state = { ...state, fleetMgmt: { ...state.fleetMgmt, fleetTarget: wantsFleetTarget } };
      sendState();
    }

    // Skip remaining command processing if nothing else changed
    if (lastCommandUpdatedAt && cmd.updatedAt <= lastCommandUpdatedAt) return;
    lastCommandUpdatedAt = cmd.updatedAt;

    const wantsEnabled = cmd.enabled;
    const wantsFleetMgmt = cmd.fleetMgmt?.enabled ?? false;

    if (wantsFleetMgmt !== (state.fleetMgmt?.enabled ?? false)) {
      state = { ...state, fleetMgmt: { ...state.fleetMgmt, enabled: wantsFleetMgmt } };
      sendState();
    }

    if (wantsEnabled && !state.enabled) {
      // If we started before credentials were stored, try acquiring the token now
      if (!token) {
        try {
          token = await doRefreshToken();
          setWorkerContext(token, companyId);
          console.log(`[autopilot:${companyId.slice(0, 8)}] token acquired on enable`);
        } catch (e: unknown) {
          const msg = `⚠️ Cannot enable — token refresh failed: ${(e as Error).message}`;
          state = appendLog(state, msg);
          sendState();
          return;
        }
      }
      // Also resolve company ID if it was unknown at startup
      if (companyId === "unknown") {
        try { companyId = await resolveCompanyId(); } catch { /* keep unknown */ }
      }
      state = { ...state, enabled: true };
      state = appendLog(state, "▶ Autopilot enabled");
      sendState();
      void tick();
      timer = setInterval(() => void tick(), CYCLE_MS);
      startEventStream();
    } else if (!wantsEnabled && state.enabled) {
      state = { ...state, enabled: false };
      state = appendLog(state, "⏹ Autopilot disabled");
      if (timer) { clearInterval(timer); timer = null; }
      if (esAbort) { esAbort.abort(); esAbort = null; }
      sendState();
    }
  } catch { /* DB unavailable — keep running with current state */ }
}

// ── Init ───────────────────────────────────────────────────────────────────────

async function init(): Promise<void> {
  // Resolve company ID from env or MongoDB
  try {
    companyId = await resolveCompanyId();
  } catch (e: unknown) {
    console.error(`[autopilot] ${(e as Error).message}`);
  }

  console.log(`[autopilot:${companyId.slice(0, 8)}] starting…`);

  // Acquire initial token from MongoDB credentials
  try {
    token = await doRefreshToken();
    setWorkerContext(token, companyId);
    console.log(`[autopilot:${companyId.slice(0, 8)}] token acquired`);
  } catch (e: unknown) {
    console.error(`[autopilot:${companyId.slice(0, 8)}] initial token refresh failed:`, (e as Error).message);
    console.error("Log in via the dashboard first to store credentials in MongoDB.");
  }

  // Restore persisted state
  const saved = await loadAutopilotState(companyId);
  if (saved) {
    state = { ...blank(), ...saved, enabled: false };
    state = appendLog(state, "↩ Restored state from database");
    sendState();
  }

  // Apply current command (in case autopilot was enabled before restart)
  await checkCommands();
}

// Wait for init to complete before polling — prevents checkCommands from enabling
// the worker before setWorkerContext has been called (race condition).
void (async () => {
  await init();
  setInterval(() => void checkCommands(), 2_000);
})();
