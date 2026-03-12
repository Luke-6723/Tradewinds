export const CYCLE_MS = 30_000;
export const MAX_LOG = 100;

export interface RouteLeg {
  toPortId: string;
  routeId: string;
  distance: number;
}

export interface ShipPlan {
  goodId: string;
  quantity: number;
  actualBuyPrice: number;
  /** Remaining legs after first transit (may be empty for direct routes). */
  legs: RouteLeg[];
  sellPortId: string;
  sellPrice: number;
}

export interface AutopilotShipState {
  phase: "idle" | "transiting_to_sell";
  plan?: ShipPlan;
}

export interface LogEntry {
  at: string;
  message: string;
}

export interface AutopilotState {
  enabled: boolean;
  ships: Record<string, AutopilotShipState>;
  /** `${goodId}@${sourcePortId}` → shipId */
  claimed: Record<string, string>;
  profitAccrued: number;
  log: LogEntry[];
  lastCycleAt: string | null;
}

export function blank(): AutopilotState {
  return { enabled: false, ships: {}, claimed: {}, profitAccrued: 0, log: [], lastCycleAt: null };
}

export function appendLog(s: AutopilotState, message: string): AutopilotState {
  return { ...s, log: [{ at: new Date().toISOString(), message }, ...s.log].slice(0, MAX_LOG) };
}

export function claimKey(goodId: string, portId: string): string {
  return `${goodId}@${portId}`;
}
