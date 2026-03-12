/**
 * Server-side autopilot manager.
 *
 * Maintains one worker process per company. Workers are forked on first enable
 * with credentials baked into their environment and run independently for the
 * lifetime of the service — switching companies in the UI does not stop other
 * companies' autopilots.
 *
 * Uses a globalThis singleton so Next.js HMR doesn't re-fork on module reload.
 */

import { fork, type ChildProcess } from "child_process";
import path from "path";
import { loadAutopilotState } from "@/lib/db/collections";
import { blank, type AutopilotState } from "@/lib/autopilot-types";

interface WorkerMessage {
  type: "state";
  data: AutopilotState;
}

interface CompanyWorker {
  worker: ChildProcess;
  state: AutopilotState;
  companyId: string;
  token: string;
}

// Persist the worker map across Next.js HMR reloads
const g = globalThis as { __autopilotWorkers?: Map<string, CompanyWorker> };

function getWorkers(): Map<string, CompanyWorker> {
  if (!g.__autopilotWorkers) g.__autopilotWorkers = new Map();
  return g.__autopilotWorkers;
}

function forkWorker(companyId: string, token: string): CompanyWorker {
  const workerPath = path.resolve(process.cwd(), "src/workers/autopilot-worker.ts");

  const child = fork(workerPath, [], {
    execPath: process.execPath,
    execArgv: ["--import", "tsx"],
    env: {
      ...process.env,
      TRADEWINDS_TOKEN: token,
      TRADEWINDS_COMPANY_ID: companyId,
    },
    stdio: "inherit",
  });

  const entry: CompanyWorker = { worker: child, state: blank(), companyId, token };

  child.on("message", (msg: WorkerMessage) => {
    if (msg.type === "state") entry.state = msg.data;
  });

  child.on("exit", (code) => {
    console.error(`[autopilot:${companyId.slice(0, 8)}] worker exited (code ${code})`);
    const lastState = entry.state;
    getWorkers().delete(companyId);

    // Auto-restart if the autopilot was still enabled when it exited
    if (lastState.enabled) {
      console.log(`[autopilot:${companyId.slice(0, 8)}] restarting worker in 5s…`);
      setTimeout(() => {
        // Only restart if no one else already started a new worker
        if (!getWorkers().has(companyId)) {
          const newEntry = forkWorker(companyId, token);
          newEntry.state = { ...lastState };
          newEntry.worker.send({ type: "setEnabled", enabled: true });
        }
      }, 5_000);
    }
  });

  getWorkers().set(companyId, entry);
  return entry;
}

function ensureWorker(companyId: string, token: string): CompanyWorker {
  return getWorkers().get(companyId) ?? forkWorker(companyId, token);
}

export const autopilotManager = {
  /** State for a specific company (blank if no worker exists yet). */
  async getState(companyId: string): Promise<AutopilotState> {
    const running = getWorkers().get(companyId);
    if (running) return running.state;
    return (await loadAutopilotState(companyId)) ?? blank();
  },

  /** State for all companies currently running a worker. */
  getAllStates(): Array<{ companyId: string; state: AutopilotState }> {
    return Array.from(getWorkers().entries()).map(([companyId, entry]) => ({
      companyId,
      state: entry.state,
    }));
  },

  /** Enable or disable the autopilot for a specific company. */
  setEnabled(companyId: string, token: string, enabled: boolean): AutopilotState {
    const entry = ensureWorker(companyId, token);
    entry.worker.send({ type: "setEnabled", enabled });
    entry.state = { ...entry.state, enabled };
    return entry.state;
  },
};
