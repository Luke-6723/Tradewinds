export const CYCLE_MS = 10_000;
export const MAX_LOG = 30;
export const MAX_PROFIT_HISTORY = 200;

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
  /** Consecutive cycles this ship has been idle without dispatching. Reset on dispatch. */
  cyclesIdle: number;
  /** Net profit earned by this ship since it was added to autopilot. */
  lifetimeProfit: number;
  /** Number of completed cargo runs. */
  cargoTrips: number;
  /** Number of completed passenger runs. */
  paxTrips: number;
  /** Total cycles this ship has been tracked. */
  cyclesActive: number;
  /** Role derived each cycle from ship type name. */
  role?: "ferry" | "multi";
}

export interface LogEntry {
  at: string;
  message: string;
}

export interface ProfitSnapshot {
  at: string;
  cumulative: number;
  cycleProfit: number;
}

export interface TreasurySnapshot {
  at: string;
  balance: number;
}

export interface FleetMgmtState {
  enabled: boolean;
  lastBuyAt: string | null;
  lastSellAt: string | null;
  /** Ports confirmed to have a shipyard — populated lazily during fleet mgmt. */
  knownShipyardPortIds: string[];
}

export interface AutopilotState {
  enabled: boolean;
  ships: Record<string, AutopilotShipState>;
  profitAccrued: number;
  log: LogEntry[];
  lastCycleAt: string | null;
  /** Rolling profit history — one entry per cycle, capped at MAX_PROFIT_HISTORY entries. */
  profitHistory: ProfitSnapshot[];
  /** Rolling treasury balance history — one entry per cycle, capped at MAX_PROFIT_HISTORY entries. */
  treasuryHistory: TreasurySnapshot[];
  fleetMgmt: FleetMgmtState;
  cyclesRun: number;
}

export function blank(): AutopilotState {
  return {
    enabled: false,
    ships: {},
    profitAccrued: 0,
    log: [],
    lastCycleAt: null,
    profitHistory: [],
    treasuryHistory: [],
    fleetMgmt: { enabled: true, lastBuyAt: null, lastSellAt: null, knownShipyardPortIds: [] },
    cyclesRun: 0,
  };
}

export function appendLog(s: AutopilotState, message: string): AutopilotState {
  return { ...s, log: [{ at: new Date().toISOString(), message }, ...s.log].slice(0, MAX_LOG) };
}