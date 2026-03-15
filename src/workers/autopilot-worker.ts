/**
 * Autopilot worker — runs as a child process via child_process.fork().
 *
 * Credentials (TRADEWINDS_TOKEN, TRADEWINDS_COMPANY_ID) are baked into the
 * environment at fork time by autopilot-manager — one worker per company.
 *
 * State is persisted to MongoDB so it survives server restarts (ship cargo,
 * phase, plan). If MONGODB_URI is not set the worker operates in-memory only.
 *
 * IPC in:  { type: "setEnabled", enabled: boolean }
 * IPC out: { type: "state", data: AutopilotState }
 */

import { handlePassengerEvent, handleShipSoldEvent, runCycle } from "@/lib/autopilot";
import { appendLog, blank, CYCLE_MS, type AutopilotState } from "@/lib/autopilot-types";
import { loadAutopilotState, saveAutopilotState } from "@/lib/db/collections";
import { UPSTREAM } from "@/lib/auth-cookies";

const companyId = process.env.TRADEWINDS_COMPANY_ID ?? "unknown";
const token = process.env.TRADEWINDS_TOKEN ?? "";

let state: AutopilotState = blank();
let timer: ReturnType<typeof setInterval> | null = null;
let esAbort: AbortController | null = null;
/** Mutex: prevents the SSE handler and the main cycle from running concurrently. */
let cycleRunning = false;

function sendState(): void {
  process.send?.({ type: "state", data: state });
}

async function tick(): Promise<void> {
  if (!state.enabled || cycleRunning) return;
  cycleRunning = true;
  try {
    state = await runCycle(state, companyId);
  } catch (e: unknown) {
    state = appendLog(state, `Fatal cycle error: ${(e as Error).message}`);
  } finally {
    cycleRunning = false;
  }
  sendState();
  // Persist after every cycle so ship cargo / phase survives restarts
  void saveAutopilotState(companyId, state);
}

interface PassengerEventData {
  id: string;
  origin_port_id: string;
  destination_port_id: string;
  bid: number;
  count: number;
  expires_at: string;
}

interface ShipSoldEventData {
  ship_id: string;
  company_id: string;
  ship_type_id: string;
  company_name: string;
  name: string;
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
              try {
                state = await handlePassengerEvent(state, companyId, event.data as PassengerEventData);
              } finally {
                cycleRunning = false;
              }
              sendState();
              void saveAutopilotState(companyId, state);
            } else if (event.type === "ship_sold" && state.enabled && !cycleRunning) {
              cycleRunning = true;
              try {
                state = await handleShipSoldEvent(state, companyId, event.data as ShipSoldEventData);
              } finally {
                cycleRunning = false;
              }
              sendState();
              void saveAutopilotState(companyId, state);
            }
          } catch { /* non-JSON line */ }
        }
      }
    } catch (e: unknown) {
      if ((e as Error).name === "AbortError") return;
      // Reconnect after 5 s if still enabled
      if (state.enabled) setTimeout(() => startEventStream(), 5_000);
    }
  })();
}

// Load persisted state before first tick
async function init(): Promise<void> {
  const saved = await loadAutopilotState(companyId);
  if (saved) {
    // Merge with blank() so any new fields added after the last save get their defaults
    state = { ...blank(), ...saved, enabled: false };
    state = appendLog(state, "↩ Restored state from database");
    sendState();
  }
}

void init();

process.on("message", (msg: { type: string; enabled?: boolean }) => {
  if (msg.type === "setFleetMgmt" && msg.enabled !== undefined) {
    state = { ...state, fleetMgmt: { ...state.fleetMgmt, enabled: msg.enabled } };
    sendState();
    void saveAutopilotState(companyId, state);
    return;
  }
  if (msg.type !== "setEnabled" || msg.enabled === undefined) return;

  const wasEnabled = state.enabled;
  state = { ...state, enabled: msg.enabled };

  if (msg.enabled && !wasEnabled) {
    state = appendLog(state, "▶ Autopilot enabled");
    sendState();
    void tick();
    timer = setInterval(() => void tick(), CYCLE_MS);
    startEventStream();
  } else if (!msg.enabled && wasEnabled) {
    state = appendLog(state, "⏹ Autopilot disabled");
    if (timer) { clearInterval(timer); timer = null; }
    if (esAbort) { esAbort.abort(); esAbort = null; }
    sendState();
    void saveAutopilotState(companyId, state);
  }
});

// Signal ready
sendState();
