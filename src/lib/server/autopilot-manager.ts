/**
 * Autopilot manager — MongoDB-backed state, child_process for dev / pm2 for prod.
 *
 * In production the standalone is started by pm2 (ecosystem.config.cjs).
 * In development the manager forks it as a child process so `pnpm dev` keeps working.
 *
 * Either way, communication goes through MongoDB:
 *   - Commands are written here, polled by the standalone every 2 s.
 *   - State is written by the standalone after every cycle and read here on GET.
 */

import { fork, type ChildProcess } from "child_process";
import path from "path";
import {
  loadAutopilotState,
  saveAutopilotCommand,
  getAutopilotCommand,
} from "@/lib/db/collections";
import { blank, type AutopilotState } from "@/lib/autopilot-types";

// ── Dev-mode worker fork ───────────────────────────────────────────────────────
// In production pm2 manages the process; in dev we fork it ourselves.

const IS_PM2 = !!process.env.PM2_HOME || process.env.NODE_APP_INSTANCE !== undefined;

const g = globalThis as { __autopilotProc?: ChildProcess | null };

function ensureDevWorker(): void {
  if (IS_PM2) return; // pm2 is managing the standalone — don't double-fork
  if (g.__autopilotProc && !g.__autopilotProc.exitCode !== null) return; // already running

  const standaloneScript = path.resolve(process.cwd(), "src/workers/autopilot-standalone.ts");

  const child = fork(standaloneScript, [], {
    execPath: process.execPath,
    execArgv: ["--import", "tsx"],
    env: { ...process.env },
    stdio: "inherit",
  });

  g.__autopilotProc = child;

  child.on("exit", (code) => {
    console.log(`[autopilot] standalone exited (code ${code}) — will restart on next request`);
    g.__autopilotProc = null;
  });
}

// ── Public interface ───────────────────────────────────────────────────────────

export const autopilotManager = {
  /** Current state — read directly from MongoDB (written by the standalone). */
  async getState(companyId: string): Promise<AutopilotState> {
    ensureDevWorker();
    return (await loadAutopilotState(companyId)) ?? blank();
  },

  /** Enable or disable the autopilot — writes a command; standalone picks it up in ≤2 s. */
  async setEnabled(companyId: string, _token: string, enabled: boolean): Promise<AutopilotState> {
    ensureDevWorker();
    const current = await loadAutopilotState(companyId) ?? blank();
    await saveAutopilotCommand(companyId, {
      enabled,
      fleetMgmt: current.fleetMgmt ?? { enabled: false },
    });
    return { ...current, enabled };
  },

  /** Toggle fleet auto-management — writes a command; standalone picks it up in ≤2 s. */
  async setFleetMgmtEnabled(companyId: string, _token: string, enabled: boolean): Promise<AutopilotState> {
    ensureDevWorker();
    const current = await loadAutopilotState(companyId) ?? blank();
    await saveAutopilotCommand(companyId, {
      enabled: current.enabled,
      fleetMgmt: { enabled },
    });
    return { ...current, fleetMgmt: { ...current.fleetMgmt, enabled } };
  },

  /** True when the standalone has an active command doc. */
  async isConfigured(companyId: string): Promise<boolean> {
    return (await getAutopilotCommand(companyId)) !== null;
  },
};

