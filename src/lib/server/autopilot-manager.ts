/**
 * Autopilot manager — MongoDB-backed, no child_process.
 *
 * The autopilot logic runs in a separate pm2 process (autopilot-standalone.ts).
 * This module is the dashboard-side interface: it reads state from MongoDB and
 * writes commands that the standalone process picks up within ~2 seconds.
 */

import {
  loadAutopilotState,
  saveAutopilotCommand,
  getAutopilotCommand,
} from "@/lib/db/collections";
import { blank, type AutopilotState } from "@/lib/autopilot-types";

export const autopilotManager = {
  /** Current state for a company — read directly from MongoDB. */
  async getState(companyId: string): Promise<AutopilotState> {
    return (await loadAutopilotState(companyId)) ?? blank();
  },

  /** Enable or disable the autopilot — writes a command doc; standalone picks it up in ~2 s. */
  async setEnabled(companyId: string, _token: string, enabled: boolean): Promise<AutopilotState> {
    const current = await loadAutopilotState(companyId) ?? blank();
    await saveAutopilotCommand(companyId, {
      enabled,
      fleetMgmt: current.fleetMgmt ?? { enabled: false },
    });
    return { ...current, enabled };
  },

  /** Toggle fleet auto-management — writes a command doc; standalone picks it up in ~2 s. */
  async setFleetMgmtEnabled(companyId: string, _token: string, enabled: boolean): Promise<AutopilotState> {
    const current = await loadAutopilotState(companyId) ?? blank();
    await saveAutopilotCommand(companyId, {
      enabled: current.enabled,
      fleetMgmt: { enabled },
    });
    return { ...current, fleetMgmt: { ...current.fleetMgmt, enabled } };
  },

  /** Check if the standalone process has an active command doc (i.e. is configured). */
  async isConfigured(companyId: string): Promise<boolean> {
    return (await getAutopilotCommand(companyId)) !== null;
  },
};

