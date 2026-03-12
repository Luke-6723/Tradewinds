/**
 * Server-side autopilot manager.
 *
 * Forks the autopilot worker as a child process and bridges state/commands
 * through IPC. Uses a globalThis singleton so Next.js HMR doesn't re-fork
 * on every module reload.
 */

import { fork, type ChildProcess } from "child_process";
import path from "path";
import { blank, type AutopilotState } from "@/lib/autopilot-types";

interface WorkerMessage {
  type: "state";
  data: AutopilotState;
}

interface Manager {
  worker: ChildProcess | null;
  state: AutopilotState;
}

// Persist the manager across Next.js HMR reloads
const g = globalThis as { __autopilotManager?: Manager };

function getManager(): Manager {
  if (!g.__autopilotManager) {
    g.__autopilotManager = { worker: null, state: blank() };
  }
  return g.__autopilotManager;
}

function ensureWorker(): ChildProcess {
  const mgr = getManager();
  if (mgr.worker) return mgr.worker;

  const workerPath = path.resolve(process.cwd(), "src/workers/autopilot-worker.ts");

  const child = fork(workerPath, [], {
    execPath: process.execPath,
    execArgv: ["--import", "tsx"],
    env: { ...process.env },
    stdio: "inherit",
  });

  child.on("message", (msg: WorkerMessage) => {
    if (msg.type === "state") {
      getManager().state = msg.data;
    }
  });

  child.on("exit", (code) => {
    console.error(`[autopilot] worker exited with code ${code}`);
    getManager().worker = null;
  });

  mgr.worker = child;
  return child;
}

export const autopilotManager = {
  getState(): AutopilotState {
    return getManager().state;
  },

  setEnabled(enabled: boolean): void {
    const worker = ensureWorker();
    worker.send({ type: "setEnabled", enabled });
    // Optimistically update local state so GET returns immediately
    getManager().state = { ...getManager().state, enabled };
  },
};
