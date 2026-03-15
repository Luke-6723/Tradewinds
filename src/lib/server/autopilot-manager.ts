/**
 * Autopilot manager — MongoDB-backed, no child_process.
 *
 * The standalone process (autopilot-standalone.ts) is managed by pm2.
 * This module is the dashboard-side interface:
 *   - Commands written here are picked up by the standalone within ~2 s.
 *   - State is also patched here immediately so dashboard polls stay consistent.
 */

import {
  loadAutopilotState,
  saveAutopilotState,
  saveAutopilotCommandEnabled,
  saveAutopilotCommandFleetMgmt,
  getAutopilotCommand,
} from "@/lib/db/collections";
import { blank, type AutopilotState } from "@/lib/autopilot-types";

export const autopilotManager = {
  /** Current state — read directly from MongoDB (written by the standalone). */
  async getState(companyId: string): Promise<AutopilotState> {
    return (await loadAutopilotState(companyId)) ?? blank();
  },

  /** Enable or disable the autopilot. Writes the command AND patches state so the
   *  next dashboard poll reflects the change without waiting for the standalone. */
  async setEnabled(companyId: string, _token: string, enabled: boolean): Promise<AutopilotState> {
    const current = await loadAutopilotState(companyId) ?? blank();
    const next: AutopilotState = { ...current, enabled };
    await Promise.all([
      saveAutopilotCommandEnabled(companyId, enabled),
      saveAutopilotState(companyId, next),
    ]);
    return next;
  },

  /** Toggle fleet auto-management. Same dual-write pattern. */
  async setFleetMgmtEnabled(companyId: string, _token: string, enabled: boolean): Promise<AutopilotState> {
    const current = await loadAutopilotState(companyId) ?? blank();
    const next: AutopilotState = { ...current, fleetMgmt: { ...current.fleetMgmt, enabled } };
    await Promise.all([
      saveAutopilotCommandFleetMgmt(companyId, { enabled }),
      saveAutopilotState(companyId, next),
    ]);
    return next;
  },

  /** Set or clear the fleet size target. Pass undefined to remove the limit. */
  async setFleetTarget(companyId: string, fleetTarget: number | undefined): Promise<AutopilotState> {
    const current = await loadAutopilotState(companyId) ?? blank();
    const next: AutopilotState = {
      ...current,
      fleetMgmt: { ...current.fleetMgmt, fleetTarget },
    };
    await saveAutopilotState(companyId, next);
    return next;
  },

  /** True when the standalone has an active command doc. */
  async isConfigured(companyId: string): Promise<boolean> {
    return (await getAutopilotCommand(companyId)) !== null;
  },
};


