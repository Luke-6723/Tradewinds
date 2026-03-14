export const CYCLE_MS = 30_000;
export const MAX_LOG = 30;

export interface RouteLeg {
  toPortId: string;
  routeId: string;
  distance: number;
}

export interface ShipPlan {
  /** Final destination — sell port for cargo, passenger destination, or both when they coincide. */
  sellPortId: string;
  /** Remaining multi-hop legs to the next destination. */
  legs: RouteLeg[];

  // ── Cargo (optional) ──────────────────────────────────────────────────────
  goodId?: string;
  goodName?: string;
  quantity?: number;
  actualBuyPrice?: number;
  sellPrice?: number;
  /** Only set during transiting_to_buy: the port where we will purchase the goods. */
  buyPortId?: string;
  /** Only set during transiting_to_buy: legs from buyPort → sellPort. */
  sellLegs?: RouteLeg[];

  // ── Passengers (optional) ─────────────────────────────────────────────────
  /** Total bid earned at boarding. Delivery is automatic on arrival — no API call needed. */
  passengerBid?: number;
}

export type ShipPhase = "idle" | "transiting_to_buy" | "transiting_to_sell";

export interface AutopilotShipState {
  phase: ShipPhase;
  plan?: ShipPlan;
}

export interface LogEntry {
  at: string;
  message: string;
}

export interface AutopilotState {
  enabled: boolean;
  ships: Record<string, AutopilotShipState>;
  profitAccrued: number;
  log: LogEntry[];
  lastCycleAt: string | null;
}

export function blank(): AutopilotState {
  return { enabled: false, ships: {}, profitAccrued: 0, log: [], lastCycleAt: null };
}

export function appendLog(s: AutopilotState, message: string): AutopilotState {
  return { ...s, log: [{ at: new Date().toISOString(), message }, ...s.log].slice(0, MAX_LOG) };
}