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

import { runCycle } from "@/lib/autopilot";
import { appendLog, blank, CYCLE_MS, type AutopilotState } from "@/lib/autopilot-types";
import { loadAutopilotState, saveAutopilotState } from "@/lib/db/collections";

const companyId = process.env.TRADEWINDS_COMPANY_ID ?? "unknown";

let state: AutopilotState = blank();
let timer: ReturnType<typeof setInterval> | null = null;

function sendState(): void {
  process.send?.({ type: "state", data: state });
}

async function tick(): Promise<void> {
  if (!state.enabled) return;
  try {
    state = await runCycle(state);
  } catch (e: unknown) {
    state = appendLog(state, `Fatal cycle error: ${(e as Error).message}`);
  }
  sendState();
  // Persist after every cycle so ship cargo / phase survives restarts
  void saveAutopilotState(companyId, state);
}

// Load persisted state before first tick
async function init(): Promise<void> {
  const saved = await loadAutopilotState(companyId);
  if (saved) {
    // Restore ship plans but start disabled — the user must re-enable explicitly
    state = { ...saved, enabled: false };
    state = appendLog(state, "↩ Restored state from database");
    sendState();
  }
}

void init();

process.on("message", (msg: { type: string; enabled?: boolean }) => {
  if (msg.type !== "setEnabled" || msg.enabled === undefined) return;

  const wasEnabled = state.enabled;
  state = { ...state, enabled: msg.enabled };

  if (msg.enabled && !wasEnabled) {
    state = appendLog(state, "▶ Autopilot enabled");
    sendState();
    void tick();
    timer = setInterval(() => void tick(), CYCLE_MS);
  } else if (!msg.enabled && wasEnabled) {
    state = appendLog(state, "⏹ Autopilot disabled");
    if (timer) { clearInterval(timer); timer = null; }
    sendState();
    void saveAutopilotState(companyId, state);
  }
});

// Signal ready
sendState();
