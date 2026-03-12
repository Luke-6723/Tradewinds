/**
 * Autopilot worker — runs as a child process via child_process.fork().
 *
 * IPC in:  { type: "setEnabled", enabled: boolean }
 * IPC out: { type: "state", data: AutopilotState }
 */

import { runCycle } from "@/lib/autopilot";
import { appendLog, blank, CYCLE_MS, type AutopilotState } from "@/lib/autopilot-types";

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
}

process.on("message", (msg: { type: string; enabled?: boolean }) => {
  if (msg.type !== "setEnabled" || msg.enabled === undefined) return;

  const wasEnabled = state.enabled;
  state = { ...state, enabled: msg.enabled };

  if (msg.enabled && !wasEnabled) {
    state = appendLog(state, "▶ Autopilot enabled");
    sendState();
    void tick(); // run immediately
    timer = setInterval(() => void tick(), CYCLE_MS);
  } else if (!msg.enabled && wasEnabled) {
    state = appendLog(state, "⏹ Autopilot disabled");
    if (timer) { clearInterval(timer); timer = null; }
    sendState();
  }
});

// Signal ready
sendState();
