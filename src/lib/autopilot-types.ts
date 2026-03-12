export const CYCLE_MS = 30_000;
export const MAX_LOG = 30;

export interface RouteLeg {
  toPortId: string;
  routeId: string;
  distance: number;
}

export interface ShipPlan {
  goodId: string;
  goodName: string;
  quantity: number;
  actualBuyPrice: number;
  /** Remaining legs in current journey phase (to buy port OR to sell port). */
  legs: RouteLeg[];
  sellPortId: string;
  sellPrice: number;
  /** Only set during transiting_to_buy: the port where we'll purchase the goods. */
  buyPortId?: string;
  /** Only set during transiting_to_buy: the legs from buyPort → sellPort. */
  sellLegs?: RouteLeg[];
}

export interface AutopilotShipState {
  phase: "idle" | "transiting_to_buy" | "transiting_to_sell";
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
