/**
 * Autopilot core cycle — server-only. Imported by the worker process.
 *
 * Strategy: per-ship independent routing.
 *   1. Passengers are FIRST-CLASS income — always board them when docked (pure profit, no cost).
 *   2. Cargo fills the gaps — each ship independently picks the best buy→sell route.
 *   3. Ships never wait for each other.
 *
 * Per-ship phases:
 *   idle              → board passengers → scan for cargo → dispatch
 *   transiting_to_buy → traveling to buy port; buys on arrival, then heads to sell
 *   transiting_to_sell → has cargo/passengers; sells on arrival, then idles
 *
 * Passenger delivery is automatic server-side on arrival at destination_port_id.
 */

import type { Cargo, Good, Passenger, Port, Route, Ship, ShipType, ShipyardInventoryItem, TraderPosition, Warehouse, WarehouseInventory } from "@/lib/types";
import { api } from "@/lib/api/client";
import { companyApi } from "@/lib/api/company";
import { fleetApi } from "@/lib/api/fleet";
import { passengersApi } from "@/lib/api/passengers";
import { shipyardsApi } from "@/lib/api/shipyards";
import { tradeApi } from "@/lib/api/trade";
import { warehousesApi } from "@/lib/api/warehouses";
import { worldApi } from "@/lib/api/world";
import { appendLog, CYCLE_MS, MAX_PROFIT_HISTORY, type AutopilotState, type AutopilotShipState, type RouteLeg, type ShipPlan } from "@/lib/autopilot-types";
import { getWarehouseStocks, removeWarehouseStock, upsertWarehouseStock } from "@/lib/db/collections";

export * from "@/lib/autopilot-types";

// ── Config ─────────────────────────────────────────────────────────────────────

const MIN_MARGIN   = 0;     // any positive margin is enough — idle ships lose money
const MAX_UNITS    = 50;
/** Delay (ms) after docking before buying/selling (lets server process the dock). */
const DOCK_DELAY_MS = 0;
/** Price level at or above which we sell from warehouse (Expensive = 4). */
const MIN_SELL_PRICE_LEVEL = 4;
/** Number of docked ships to process per cycle (rolling window). */
const SHIP_WINDOW_SIZE = 100;

// ── Fleet management constants ─────────────────────────────────────────────
/** Cycles a ship must be consecutively idle before it's a sell candidate. */
const SELL_IDLE_CYCLES = 18;       // 3 min at 10s cycle
/** Minimum fleet size — never sell below this. */
const MIN_FLEET_SIZE = 2;
/** Available-funds multiplier required before buying a ship.
 *  High value keeps treasury intact for cargo/pax trading capital. */
const BUY_RESERVE_MULTIPLIER = 20;
/** Cooldown between automated buys — infrequent to deprioritise expansion. */
const BUY_COOLDOWN_MS  = 60 * 60_000; // 1 hour
/** Cooldown between automated sells. */
const SELL_COOLDOWN_MS = 2 * 60_000;
/** Minimum treasury balance to maintain at all times.
 *  Cargo buying stops when treasury is at or below this floor. */
const MIN_TREASURY_FLOOR = 1_500_000;

// ── Warehouse buy constants ────────────────────────────────────────────────
/** Maximum price level at which we buy for warehouse stockpiling (Cheap = 2). */
const MAX_BUY_PRICE_LEVEL = 2;
/** Maximum units of a single good type to hold per warehouse. */
const MAX_WAREHOUSE_STOCK = 100;
/** Maximum distinct good types to stock per warehouse. */
const MAX_WAREHOUSE_GOODS = 2;

// ── Passenger-chasing constants ────────────────────────────────────────────
/** travel_time_ms = (distance / shipSpeed) * MS_PER_SPEED_UNIT
 *  Derived: Cog speed 4 → 6250 ms/unit → 25_000 / 4 = 6250 ✓ */
const MS_PER_SPEED_UNIT = 25_000;
/** Safety buffer added on top of estimated travel time (ms). */
const TRAVEL_BUFFER_MS = 30_000;  // 30 seconds
/** Minimum time remaining on a passenger before we bother chasing them (ms). */
const MIN_PAX_EXPIRY_BUFFER_MS = 2 * 60_000;  // 2 minutes (exact ETA now available)
/** Maximum route hops an idle ship will travel to reach passengers. */
const MAX_PAX_CHASE_HOPS = 3;
/** Ship type name pattern that designates a "ferry" (passenger-only) role. */
const FERRY_TYPE_PATTERN = /caravel/i;
const COG_TYPE_PATTERN   = /cog/i;

/** Estimate travel time in ms for a given distance and ship speed. */
function travelTimeMs(distance: number, shipSpeed: number): number {
  return (distance / shipSpeed) * MS_PER_SPEED_UNIT;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ── Price-level helpers ────────────────────────────────────────────────────────

const PRICE_LEVEL: Record<string, number> = {
  "Very Cheap":     1,
  "Cheap":          2,
  "Average":        3,
  "Expensive":      4,
  "Very Expensive": 5,
};
function priceLevelOrdinal(label: string): number {
  return PRICE_LEVEL[label] ?? 0;
}

// ── Route pathfinding ──────────────────────────────────────────────────────────

interface Path {
  destPortId: string;
  legs: RouteLeg[];
  totalDistance: number;
}

function findPaths(fromPortId: string, adj: Map<string, Route[]>, maxHops: number): Path[] {
  const results: Path[] = [];
  const visited = new Set<string>([fromPortId]);
  const queue: Array<{ portId: string; legs: RouteLeg[]; dist: number }> = [
    { portId: fromPortId, legs: [], dist: 0 },
  ];
  while (queue.length > 0) {
    const { portId, legs, dist } = queue.shift()!;
    if (legs.length >= maxHops) continue;
    for (const r of adj.get(portId) ?? []) {
      if (visited.has(r.to_id)) continue;
      visited.add(r.to_id);
      const newLegs: RouteLeg[] = [...legs, { toPortId: r.to_id, routeId: r.id, distance: r.distance }];
      const newDist = dist + r.distance;
      results.push({ destPortId: r.to_id, legs: newLegs, totalDistance: newDist });
      queue.push({ portId: r.to_id, legs: newLegs, dist: newDist });
    }
  }
  return results;
}

// ── Candidate types ────────────────────────────────────────────────────────────

interface RawCandidate {
  buyPortId: string;
  sellPortId: string;
  sellLegs: RouteLeg[];
  toLegsBuy: RouteLeg[];  // legs from ship's current port → buy port (empty if already there)
  goodId: string;
  prescore: number;
  totalDist: number;      // total distance: currentPort→buyPort + buyPort→sellPort
}

interface ScoredCandidate extends RawCandidate {
  npcSellPrice: number;
}

/** Default per-ship state for newly tracked ships. */
function defaultShipState(): AutopilotShipState {
  return { phase: "idle", cyclesIdle: 0, lifetimeProfit: 0, cargoTrips: 0, paxTrips: 0, cyclesActive: 0 };
}

// ── SSE passenger event handler ───────────────────────────────────────────────

/**
 * Immediately boards a passenger that just appeared via the world events SSE stream.
 * Runs outside the main cycle (triggered by the worker's event listener).
 */
export async function handlePassengerEvent(
  s: AutopilotState,
  _companyId: string,
  eventData: {
    id: string;
    origin_port_id: string;
    destination_port_id: string;
    bid: number;
    count: number;
    expires_at: string;
  },
): Promise<AutopilotState> {
  if (new Date(eventData.expires_at) <= new Date()) return s;

  try {
    const [ships, shipTypes] = await Promise.all([
      fleetApi.getShips().catch(() => [] as Ship[]),
      worldApi.getShipTypes().catch(() => [] as ShipType[]),
    ]);
    const stMap = new Map<string, ShipType>(shipTypes.map((t: ShipType) => [t.id, t]));

    const eligible = ships.filter(
      (sh: Ship) =>
        sh.status !== "traveling" &&
        sh.port_id === eventData.origin_port_id &&
        (stMap.get(sh.ship_type_id)?.passengers ?? 0) > 0 &&
        (s.ships[sh.id]?.phase ?? "idle") === "idle",
    );

    for (const ship of eligible) {
      try {
        await passengersApi.boardPassenger(eventData.id, { ship_id: ship.id });
        const ss = s.ships[ship.id] ?? defaultShipState();
        s = {
          ...s,
          profitAccrued: s.profitAccrued + eventData.bid,
          ships: {
            ...s.ships,
            [ship.id]: {
              ...ss,
              lifetimeProfit: ss.lifetimeProfit + eventData.bid,
              paxTrips: ss.paxTrips + 1,
            },
          },
        };
        s = appendLog(s, `⚡ ${ship.name}: 🧳 instant pax → ${eventData.destination_port_id.slice(0, 8)} (£${eventData.bid})`);
        break;
      } catch (e: unknown) {
        s = appendLog(s, `⚡ pax board failed (${ship.name}) — ${(e as Error).message}`);
      }
    }
  } catch (e: unknown) {
    s = appendLog(s, `⚡ pax event error — ${(e as Error).message}`);
  }
  return s;
}

// ── Fleet management ──────────────────────────────────────────────────────────

async function runFleetManagement(
  s: AutopilotState,
  ships: Ship[],
  shipTypes: ShipType[],
  economy: { total_upkeep: number },
  availableFunds: number,
  allPassengers: Passenger[],
): Promise<AutopilotState> {
  const fleetMgmt = s.fleetMgmt ?? { enabled: true, lastBuyAt: null, lastSellAt: null, knownShipyardPortIds: [] };
  if (!fleetMgmt.enabled) return s;

  const now = Date.now();
  const stMap = new Map<string, ShipType>(shipTypes.map((t: ShipType) => [t.id, t]));
  const fleetTarget = fleetMgmt.fleetTarget ?? Infinity;
  const overTarget = ships.length > fleetTarget;
  console.log(`[fleetMgmt] ships=${ships.length} target=${fleetTarget === Infinity ? "∞" : fleetTarget} overTarget=${overTarget} enabled=${fleetMgmt.enabled}`);

  // ── DISCOVER shipyard ports ────────────────────────────────────────────────
  // When over target and we have few/no known shipyard ports, probe a batch of
  // docked ship ports in parallel to populate knownShipyardPortIds.
  if (overTarget) {
    const dockedPortIds = [...new Set(
      ships.filter((sh) => sh.status !== "traveling" && sh.port_id).map((sh) => sh.port_id!)
    )].filter((pid) => !fleetMgmt.knownShipyardPortIds.includes(pid));

    if (dockedPortIds.length > 0) {
      const PROBE_BATCH = 20;
      const probe = dockedPortIds.slice(0, PROBE_BATCH);
      console.log(`[fleetMgmt:discover] probing ${probe.length} ports for shipyards`);
      const results = await Promise.allSettled(probe.map(async (pid) => ({ pid, sy: await shipyardsApi.getPortShipyard(pid) })));
      const newYards: string[] = [];
      for (const r of results) {
        if (r.status === "fulfilled") newYards.push(r.value.pid);
      }
      if (newYards.length > 0) {
        const merged = [...new Set([...fleetMgmt.knownShipyardPortIds, ...newYards])];
        s = { ...s, fleetMgmt: { ...s.fleetMgmt!, knownShipyardPortIds: merged } };
        // Sync local ref so the sell loop below uses the updated list
        fleetMgmt.knownShipyardPortIds = merged;
        console.log(`[fleetMgmt:discover] found ${newYards.length} shipyard ports: ${newYards.join(", ")}`);
      } else {
        console.log(`[fleetMgmt:discover] no shipyards found in batch`);
      }
    }
  }

  // ── SELL: idle ships at shipyard ports ────────────────────────────────────
  // When over fleet target: sell any idle ship immediately (no idle-cycle requirement).
  // When at/under target: only sell ships that have been idle for SELL_IDLE_CYCLES.
  const canSell =
    !fleetMgmt.lastSellAt ||
    now - new Date(fleetMgmt.lastSellAt).getTime() > SELL_COOLDOWN_MS;

  if (canSell && ships.length > MIN_FLEET_SIZE) {
    // Prioritise Cogs for selling; never sell ferries
    const sellCandidates = ships
      .filter((sh) => sh.status !== "traveling" && sh.port_id)
      .sort((a, b) => {
        const aCog = COG_TYPE_PATTERN.test(stMap.get(a.ship_type_id)?.name ?? "") ? 0 : 1;
        const bCog = COG_TYPE_PATTERN.test(stMap.get(b.ship_type_id)?.name ?? "") ? 0 : 1;
        return aCog - bCog;
      });
    console.log(`[fleetMgmt:sell] canSell=true candidates=${sellCandidates.length} overTarget=${overTarget}`);
    for (const ship of sellCandidates) {
      if (!ship.port_id) continue;
      const ss = s.ships[ship.id];
      if (!ss || ss.role === "ferry") continue; // ferries are never auto-sold
      if (ss.phase !== "idle") continue; // never sell a ship that still has cargo or an active plan
      if (!overTarget && ss.cyclesIdle < SELL_IDLE_CYCLES) continue;

      console.log(`[fleetMgmt:sell] trying ${ship.name} @ port=${ship.port_id} cyclesIdle=${ss.cyclesIdle}`);
      try {
        const sy = await shipyardsApi.getPortShipyard(ship.port_id);
        if (!fleetMgmt.knownShipyardPortIds.includes(ship.port_id)) {
          s = { ...s, fleetMgmt: { ...s.fleetMgmt!, knownShipyardPortIds: [...fleetMgmt.knownShipyardPortIds, ship.port_id] } };
        }
        const result = await shipyardsApi.sellShip(sy.id, ship.id);
        s.profitAccrued += result.price;
        const { [ship.id]: _, ...remainingShips } = s.ships;
        s = { ...s, ships: remainingShips, fleetMgmt: { ...s.fleetMgmt!, lastSellAt: new Date().toISOString() } };
        const reason = overTarget ? `over target (${ships.length}/${fleetTarget})` : `idle ${ss.cyclesIdle} cycles`;
        s = appendLog(s, `💰 Sold ${ship.name} @ £${result.price.toLocaleString()} (${reason})`);
        console.log(`[fleetMgmt:sell] ✓ sold ${ship.name} for £${result.price}`);
        break; // one sell per cycle
      } catch (e: unknown) {
        console.log(`[fleetMgmt:sell] ✗ ${ship.name} @ port=${ship.port_id} — ${(e as Error).message}`);
      }
    }
  } else {
    console.log(`[fleetMgmt:sell] skipped canSell=${canSell} fleetSize=${ships.length} minFleet=${MIN_FLEET_SIZE}`);
  }

  // ── RELOCATE: tag idle ships at non-shipyard ports toward a shipyard ──────
  // Handled in runCycle (where getPathsFrom is in scope) via runRelocations().
  // Here we only clear stale tags when back under target.
  if (!overTarget) {
    const updatedShips = { ...s.ships };
    let cleared = false;
    for (const [id, ss] of Object.entries(updatedShips)) {
      if (ss.relocatingToPortId) { updatedShips[id] = { ...ss, relocatingToPortId: undefined }; cleared = true; }
    }
    if (cleared) s = { ...s, ships: updatedShips };
  }

  // ── BUY: expand fleet when profitable, unbalanced, and under target ─────────────────────
  const canBuy =
    !fleetMgmt.lastBuyAt ||
    now - new Date(fleetMgmt.lastBuyAt).getTime() > BUY_COOLDOWN_MS;

  if (canBuy && !overTarget) {
    const stMap2 = stMap; // already defined above
    const ferryCount = ships.filter((sh: Ship) => FERRY_TYPE_PATTERN.test(stMap2.get(sh.ship_type_id)?.name ?? "")).length;
    const activePortCount = new Set(allPassengers.map((p) => p.origin_port_id)).size;
    const needMoreFerries = ferryCount < activePortCount && ferryCount < Math.ceil(ships.length / 2);

    const paxShips = ships.filter((sh: Ship) => (stMap.get(sh.ship_type_id)?.passengers ?? 0) > 0).length;
    const paxRatio = ships.length > 0 ? paxShips / ships.length : 0.5;

    let preferPassengers: boolean | null = null;
    if (needMoreFerries) preferPassengers = true; // coverage gap — buy a passenger ship (Caravel preferred)
    else if (paxRatio < 0.4) preferPassengers = true;
    else if (paxRatio > 0.6) preferPassengers = false;

    const prevPH = s.profitHistory ?? [];
    const lastProfit = prevPH.length > 0 ? prevPH[prevPH.length - 1].cycleProfit : 0;
    const perCycleUpkeep = economy.total_upkeep * (CYCLE_MS / 3_600_000);

    if (lastProfit > 10 * perCycleUpkeep) {
      for (const ship of ships.filter((sh: Ship) => sh.status !== "traveling" && sh.port_id)) {
        const portId = ship.port_id!;
        try {
          const sy = await shipyardsApi.getPortShipyard(portId);
          const inventoryItems = await shipyardsApi.getInventory(sy.id);
          if (!fleetMgmt.knownShipyardPortIds.includes(portId)) {
            s = { ...s, fleetMgmt: { ...(s.fleetMgmt ?? fleetMgmt), knownShipyardPortIds: [...fleetMgmt.knownShipyardPortIds, portId] } };
          }
          if (inventoryItems.length === 0) continue;

          const candidates = inventoryItems
            .map((item: ShipyardInventoryItem) => ({ item, type: stMap.get(item.ship_type_id) }))
            .filter((c): c is { item: ShipyardInventoryItem; type: ShipType } => c.type != null);

          let chosen: { item: ShipyardInventoryItem; type: ShipType } | null = null;
          if (needMoreFerries) {
            // Coverage gap — prefer a Caravel (ferry) first, fall back to any pax ship
            chosen = candidates
              .filter((c) => FERRY_TYPE_PATTERN.test(c.type.name) && c.type.passengers > 0)
              .sort((a, b) => b.type.passengers - a.type.passengers)[0] ?? null;
            if (!chosen) chosen = candidates
              .filter((c) => c.type.passengers > 0)
              .sort((a, b) => b.type.passengers - a.type.passengers)[0] ?? null;
          } else if (preferPassengers === true) {
            chosen = candidates
              .filter((c) => c.type.passengers > 0)
              .sort((a, b) => b.type.passengers - a.type.passengers)[0] ?? null;
          } else if (preferPassengers === false) {
            chosen = candidates
              .filter((c) => c.type.passengers === 0)
              .sort((a, b) => b.type.capacity - a.type.capacity)[0] ?? null;
          }
          if (!chosen) chosen = candidates.sort((a, b) => a.item.cost - b.item.cost)[0] ?? null;
          if (!chosen) continue;

          if (availableFunds < BUY_RESERVE_MULTIPLIER * chosen.item.cost) continue;

          const newShip = await shipyardsApi.purchaseShip(sy.id, { ship_type_id: chosen.type.id });
          s = { ...s, fleetMgmt: { ...(s.fleetMgmt ?? fleetMgmt), lastBuyAt: new Date().toISOString() } };
          const buyReason = needMoreFerries ? ` | coverage ${ferryCount}/${activePortCount} ports` : ` | pax: ${Math.round(paxRatio * 100)}%`;
          s = appendLog(s, `🚢 Bought ${newShip.name} (${chosen.type.name}) @ £${chosen.item.cost.toLocaleString()}${buyReason}`);
          break;
        } catch { /* no shipyard or insufficient funds — try next ship's port */ }
      }
    }
  }

  return s;
}

// ── Cycle data cache ───────────────────────────────────────────────────────────
// Static game data (routes, ports, goods, ship types) almost never changes —
// cache indefinitely until process restart to avoid burning rate-limit budget.
// Trader positions (NPC prices) change slowly — refresh every TRADER_POS_TTL_MS.

const TRADER_POS_TTL_MS = 5 * 60 * 1_000; // 5 min = 15 cycles at 20s
const SHIPS_TTL_MS = 18_000; // 18s — refreshes each cycle (20s) but avoids double-hit on back-to-back starts

let _cachedRoutes: Route[] | null = null;
let _cachedShipTypes: ShipType[] | null = null;
let _cachedPorts: Port[] | null = null;
let _cachedGoods: Good[] | null = null;
let _cachedTraderPositions: TraderPosition[] | null = null;
let _traderPositionsFetchedAt = 0;
let _cachedShips: Ship[] | null = null;
let _shipsFetchedAt = 0;

async function cachedRoutes(): Promise<Route[]> {
  if (!_cachedRoutes) {
    _cachedRoutes = await worldApi.getRoutes();
    console.log(`[cache] routes loaded (${_cachedRoutes.length})`);
  }
  return _cachedRoutes;
}

async function cachedShipTypes(): Promise<ShipType[]> {
  if (!_cachedShipTypes) {
    _cachedShipTypes = await worldApi.getShipTypes();
    console.log(`[cache] shipTypes loaded (${_cachedShipTypes.length})`);
  }
  return _cachedShipTypes;
}

async function cachedPorts(): Promise<Port[]> {
  if (!_cachedPorts) {
    _cachedPorts = await worldApi.getPorts();
    console.log(`[cache] ports loaded (${_cachedPorts.length})`);
  }
  return _cachedPorts;
}

async function cachedGoods(): Promise<Good[]> {
  if (!_cachedGoods) {
    _cachedGoods = await worldApi.getGoods();
    console.log(`[cache] goods loaded (${_cachedGoods.length})`);
  }
  return _cachedGoods;
}

async function cachedTraderPositions(): Promise<TraderPosition[]> {
  const now = Date.now();
  if (!_cachedTraderPositions || now - _traderPositionsFetchedAt > TRADER_POS_TTL_MS) {
    _cachedTraderPositions = await tradeApi.getTraderPositions();
    _traderPositionsFetchedAt = now;
    console.log(`[cache] traderPositions refreshed (${_cachedTraderPositions.length})`);
  }
  return _cachedTraderPositions;
}

async function cachedShips(): Promise<Ship[]> {
  const now = Date.now();
  if (!_cachedShips || now - _shipsFetchedAt > SHIPS_TTL_MS) {
    const raw = await fleetApi.getShips();
    // Deduplicate by ID (upstream cursor pagination can return the same ship twice)
    const seen = new Set<string>();
    _cachedShips = raw.filter((s) => {
      if (seen.has(s.id)) return false;
      seen.add(s.id);
      return true;
    });
    _shipsFetchedAt = now;
    console.log(`[cache] ships refreshed (${_cachedShips.length})`);
  }
  return _cachedShips;
}

// ── Cycle ──────────────────────────────────────────────────────────────────────

export async function runCycle(s: AutopilotState, companyId: string): Promise<AutopilotState> {
  s = { ...s, lastCycleAt: new Date().toISOString() };
  let treasuryBalance: number | null = null;
  const cycleT0 = Date.now();
  const shipBatches = Math.max(1, parseInt(process.env.AUTOPILOT_SHIP_BATCHES ?? "1", 10) || 1);

  // Fire a transit immediately and roll back optimistic state on failure
  const dispatchTransit = async (shipId: string, routeId: string, onError: (msg: string) => void): Promise<void> => {
    try {
      await api.post<Ship>(`/ships/${shipId}/transit`, { route_id: routeId });
    } catch (e: unknown) {
      onError((e as Error).message ?? "transit failed");
    }
  };

  const timed = async <T>(label: string, fn: () => Promise<T>): Promise<T> => {
    const t0 = Date.now();
    s = appendLog(s, `⏳ fetching ${label}…`);
    const result = await fn();
    const ms = Date.now() - t0;
    const count = Array.isArray(result) ? ` (${(result as unknown[]).length})` : "";
    s = appendLog(s, `✓ ${label}${count} in ${(ms / 1000).toFixed(1)}s`);
    return result;
  };

  let shipsActionedTotal = 0;

  try {
    s = appendLog(s, `── cycle start ──`);
    const fetchStart = Date.now();
    // Fresh each cycle: company, economy, warehouses, passengers
    // Cached: ships (25s), routes (forever), shipTypes (forever), ports (forever), goods (forever), traderPositions (5 min)
    const [ships, allRoutes, shipTypes, allPorts, allGoods, company, economy, allWarehouses, allPassengers, allTraderPositions] = await Promise.all([
      cachedShips().catch((e: Error) => { throw new Error(`getShips: ${e.message}`); }),
      cachedRoutes().catch((e: Error) => { throw new Error(`getRoutes: ${e.message}`); }),
      cachedShipTypes().catch((e: Error) => { throw new Error(`getShipTypes: ${e.message}`); }),
      cachedPorts().catch((e: Error) => { throw new Error(`getPorts: ${e.message}`); }),
      cachedGoods().catch((e: Error) => { throw new Error(`getGoods: ${e.message}`); }),
      timed("company", () => companyApi.getCompany()).catch((e: Error) => { throw new Error(`getCompany: ${e.message}`); }),
      companyApi.getEconomy().catch(() => ({ total_upkeep: 0 } as { total_upkeep: number })),
      timed("warehouses", () => warehousesApi.getWarehouses()).catch(() => [] as Warehouse[]),
      timed("passengers", () => passengersApi.getPassengers({ status: "available" })).catch(() => [] as Passenger[]),
      cachedTraderPositions().catch(() => []),
    ]);
    s = appendLog(s, `📦 all data fetched in ${((Date.now() - fetchStart) / 1000).toFixed(1)}s`);
    // Sort docked ships by ID for a stable window across cycles
    const dockedShips = ships.filter((sh: Ship) => sh.status !== "traveling").sort((a, b) => a.id.localeCompare(b.id));
    // Rolling window — clamp offset in case fleet size shrank since last cycle
    const windowOffset = dockedShips.length > 0 ? (s.shipWindowOffset ?? 0) % dockedShips.length : 0;
    const windowEnd = Math.min(windowOffset + SHIP_WINDOW_SIZE * shipBatches, dockedShips.length);
    const windowShips = dockedShips.slice(windowOffset, windowEnd);
    const nextWindowOffset = windowEnd >= dockedShips.length ? 0 : windowEnd;
    console.log(`[runCycle] ${ships.length} ships total, ${dockedShips.length} docked, window=${windowOffset}–${windowEnd - 1}, companyId=${companyId}`);
    console.log(`[runCycle:fetch] data ready in ${((Date.now() - fetchStart) / 1000).toFixed(1)}s`);

    const bankingCap = Math.max(MIN_TREASURY_FLOOR, economy.total_upkeep * 2 + 2_000);
    let availableFunds = Math.max(0, company.treasury - bankingCap);
    treasuryBalance = company.treasury;

    const portName = (id: string | null | undefined) =>
      allPorts.find((p: Port) => p.id === id)?.name ?? (id ?? "?").slice(0, 8);
    const goodNameFn = (id: string) =>
      allGoods.find((g: Good) => g.id === id)?.name ?? id.slice(0, 8);
    const stMap = new Map<string, ShipType>(shipTypes.map((t: ShipType) => [t.id, t]));

    // ── NPC price maps ─────────────────────────────────────────────────────────
    const npcGoods  = new Map<string, Set<string>>();
    const npcMinOrd = new Map<string, number>();
    const npcMaxOrd = new Map<string, number>();
    for (const tp of allTraderPositions) {
      if (!npcGoods.has(tp.port_id)) npcGoods.set(tp.port_id, new Set());
      npcGoods.get(tp.port_id)!.add(tp.good_id);
      if (tp.price_bounds) {
        const k = `${tp.port_id}:${tp.good_id}`;
        const ord = priceLevelOrdinal(tp.price_bounds);
        if (ord > 0) {
          if (ord < (npcMinOrd.get(k) ?? Infinity)) npcMinOrd.set(k, ord);
          if (ord > (npcMaxOrd.get(k) ?? 0))        npcMaxOrd.set(k, ord);
        }
      }
    }

    // ── Warehouse maps ─────────────────────────────────────────────────────────
    const warehouseInventory = new Map<string, WarehouseInventory[]>();
    const wInvStart = Date.now();
    if (allWarehouses.length > 0) s = appendLog(s, `⏳ fetching warehouse inventories (${allWarehouses.length})…`);
    await Promise.all(
      allWarehouses.map(async (w: Warehouse) => {
        try { warehouseInventory.set(w.id, await warehousesApi.getInventory(w.id)); }
        catch  { warehouseInventory.set(w.id, []); }
      }),
    );
    if (allWarehouses.length > 0) s = appendLog(s, `✓ warehouse inventories in ${((Date.now() - wInvStart) / 1000).toFixed(1)}s`);

    // Sync MongoDB stock records with live inventory
    const mongoStocks = await getWarehouseStocks(companyId).catch(() => []);
    const stockPrices = new Map<string, number>();
    for (const ms of mongoStocks) {
      stockPrices.set(`${ms.warehouseId}:${ms.goodId}`, ms.avgBuyPrice);
      const liveInv = warehouseInventory.get(ms.warehouseId) ?? [];
      if (!liveInv.some((i: WarehouseInventory) => i.good_id === ms.goodId && i.quantity > 0)) {
        await removeWarehouseStock(companyId, ms.warehouseId, ms.goodId).catch(() => {});
        stockPrices.delete(`${ms.warehouseId}:${ms.goodId}`);
      }
    }

    const dockedCount = ships.filter((sh: Ship) => sh.status !== "traveling").length;
    s = appendLog(s, `⟳ ${ships.length} ship(s) / ${dockedCount} docked / £${Math.round(availableFunds).toLocaleString()} avail | ${allPassengers.length} pax available`);

    // ── Warehouse sell scan (independent — runs every cycle) ───────────────────
    // Collect all items eligible for selling, batch-quote them, then execute in parallel.
    {
      const wsT0 = Date.now();
      type WSSellItem = { warehouseId: string; portId: string; good_id: string; quantity: number; avgBuy: number };
      const sellItems: WSSellItem[] = [];
      for (const [warehouseId, inventory] of warehouseInventory) {
        const warehouse = allWarehouses.find((w: Warehouse) => w.id === warehouseId);
        if (!warehouse) continue;
        for (const item of inventory) {
          if (item.quantity <= 0) continue;
          const priceLevel = npcMaxOrd.get(`${warehouse.port_id}:${item.good_id}`) ?? 0;
          if (priceLevel < MIN_SELL_PRICE_LEVEL) continue;
          sellItems.push({ warehouseId, portId: warehouse.port_id, good_id: item.good_id, quantity: item.quantity, avgBuy: stockPrices.get(`${warehouseId}:${item.good_id}`) ?? 0 });
        }
      }
      if (sellItems.length > 0) {
        let sellQuotes: Awaited<ReturnType<typeof tradeApi.batchCreateQuotes>> = [];
        try {
          sellQuotes = await tradeApi.batchCreateQuotes({
            requests: sellItems.map((it) => ({ port_id: it.portId, good_id: it.good_id, quantity: it.quantity, action: "sell" as const })),
          });
        } catch { /* proceed with empty */ }
        const sellResults = await Promise.allSettled(
          sellItems.map(async (it, i) => {
            const sq = sellQuotes[i];
            if (!sq || sq.status !== "success" || !sq.quote) throw new Error("no quote");
            await tradeApi.executeQuote({ token: sq.token, destinations: [{ type: "warehouse", id: it.warehouseId, quantity: it.quantity }] });
            return { ...it, unitPrice: sq.quote.unit_price };
          }),
        );
        for (let i = 0; i < sellItems.length; i++) {
          const result = sellResults[i];
          const it = sellItems[i];
          if (result.status === "fulfilled") {
            const { unitPrice, quantity, good_id, avgBuy, warehouseId } = result.value;
            const totalRevenue = unitPrice * quantity;
            const profit = totalRevenue - avgBuy * quantity;
            s.profitAccrued += profit;
            s = appendLog(s, `🏭 NPC sold ${quantity}× ${goodNameFn(good_id)} @ £${unitPrice} (+£${Math.round(profit).toLocaleString()} profit)`);
            await removeWarehouseStock(companyId, warehouseId, good_id).catch(() => {});
          } else {
            s = appendLog(s, `🏭 Warehouse sell failed (${goodNameFn(it.good_id)}) — ${(result.reason as Error).message ?? "unknown"}`);
          }
        }
        const sold = sellResults.filter((r) => r.status === "fulfilled").length;
        console.log(`[runCycle:wh:sell] ${sold}/${sellItems.length} sold in ${((Date.now() - wsT0) / 1000).toFixed(1)}s`);
      } else {
        console.log(`[runCycle:wh:sell] nothing eligible to sell`);
      }
    }

    // ── Warehouse buy scan (opportunistic stockpiling) ────────────────────────
    // Batch-quote all candidates upfront; execute sequentially to respect budget + slot limits.
    {
      const wbT0 = Date.now();
      type WSBuyCandidate = { warehouseId: string; portId: string; goodId: string; goodName: string; toBuy: number; npcPriceOrd: number; stockedGoods: string[] };
      const buyCandidates: WSBuyCandidate[] = [];
      for (const [warehouseId, inventory] of warehouseInventory) {
        const warehouse = allWarehouses.find((w: Warehouse) => w.id === warehouseId);
        if (!warehouse) continue;
        const stockedGoods = inventory.filter((i) => i.quantity > 0).map((i) => i.good_id);
        if (stockedGoods.length >= MAX_WAREHOUSE_GOODS) continue;
        const candidateGoods = new Set(npcGoods.get(warehouse.port_id) ?? []);
        let pendingSlots = 0;
        for (const goodId of candidateGoods) {
          if (stockedGoods.length + pendingSlots >= MAX_WAREHOUSE_GOODS) break;
          if (stockedGoods.includes(goodId)) continue;
          const npcPriceOrd = npcMinOrd.get(`${warehouse.port_id}:${goodId}`) ?? 0;
          if (npcPriceOrd <= 0 || npcPriceOrd > MAX_BUY_PRICE_LEVEL) continue;
          const existingQty = inventory.find((i) => i.good_id === goodId)?.quantity ?? 0;
          const toBuy = MAX_WAREHOUSE_STOCK - existingQty;
          if (toBuy <= 0) continue;
          buyCandidates.push({ warehouseId, portId: warehouse.port_id, goodId, goodName: goodNameFn(goodId), toBuy, npcPriceOrd, stockedGoods });
          pendingSlots++;
        }
      }
      if (buyCandidates.length > 0) {
        let buyQuotes: Awaited<ReturnType<typeof tradeApi.batchCreateQuotes>> = [];
        try {
          buyQuotes = await tradeApi.batchCreateQuotes({
            requests: buyCandidates.map((c) => ({ port_id: c.portId, good_id: c.goodId, quantity: c.toBuy, action: "buy" as const })),
          });
        } catch { /* proceed with empty */ }

        // Reserve funds for each affordable candidate (sequential — shared state),
        // then execute all reserved buys in parallel.
        type Reserved = { c: (typeof buyCandidates)[0]; token: string; unitPrice: number };
        const reserved: Reserved[] = [];
        for (let i = 0; i < buyCandidates.length; i++) {
          const c = buyCandidates[i];
          const bq = buyQuotes[i];
          if (!bq || bq.status !== "success" || !bq.quote) continue;
          const cost = bq.quote.unit_price * c.toBuy;
          if (cost > availableFunds) continue;
          availableFunds -= cost; // reserve
          reserved.push({ c, token: bq.token, unitPrice: bq.quote.unit_price });
        }

        const buyResults = await Promise.allSettled(
          reserved.map(({ c, token }) =>
            tradeApi.executeQuote({ token, destinations: [{ type: "warehouse", id: c.warehouseId, quantity: c.toBuy }] }),
          ),
        );

        await Promise.all(reserved.map(async ({ c, unitPrice }, i) => {
          if (buyResults[i].status === "fulfilled") {
            s = appendLog(s, `🏭 Stocked ${c.toBuy}× ${c.goodName} @ £${unitPrice} (level ${c.npcPriceOrd})`);
            await upsertWarehouseStock(companyId, { warehouseId: c.warehouseId, portId: c.portId, goodId: c.goodId, goodName: c.goodName, avgBuyPrice: unitPrice }).catch(() => {});
          } else {
            availableFunds += unitPrice * c.toBuy; // refund reserved funds
            s = appendLog(s, `🏭 Warehouse stock failed (${c.goodName}) — ${(buyResults[i] as PromiseRejectedResult).reason?.message ?? "unknown"}`);
          }
        }));
        const bought = buyResults.filter((r) => r.status === "fulfilled").length;
        console.log(`[runCycle:wh:buy] ${bought}/${reserved.length} stocked (${buyCandidates.length} candidates) in ${((Date.now() - wbT0) / 1000).toFixed(1)}s`);
      } else {
        console.log(`[runCycle:wh:buy] no buy candidates`);
      }
    }

    // ── Per-ship independent routing ───────────────────────────────────────────

    // ① Route adjacency index — O(1) neighbour lookup instead of O(routes) filter per BFS step
    const routeAdj = new Map<string, Route[]>();
    for (const r of allRoutes) {
      if (!routeAdj.has(r.from_id)) routeAdj.set(r.from_id, []);
      routeAdj.get(r.from_id)!.push(r);
    }

    // ② Memoized path finder — results cached by (portId:maxHops) within this cycle
    const _pathCache = new Map<string, Path[]>();
    const getPathsFrom = (portId: string, maxHops = 99): Path[] => {
      const key = `${portId}:${maxHops}`;
      if (!_pathCache.has(key)) _pathCache.set(key, findPaths(portId, routeAdj, maxHops));
      return _pathCache.get(key)!;
    };

    // ③ Pre-fetch inventories for the current window with a concurrency cap.
    //    Unbounded Promise.all floods the server; 20 concurrent is plenty.
    const INV_CONCURRENCY = 20;
    const shipInventoryCache = new Map<string, Cargo[]>();
    {
      const toFetch = windowShips;
      const results: Array<readonly [string, Cargo[]]> = [];
      for (let i = 0; i < toFetch.length; i += INV_CONCURRENCY) {
        const slice = toFetch.slice(i, i + INV_CONCURRENCY);
        const sliceResults = await Promise.all(
          slice.map(async (sh: Ship) => {
            try { return [sh.id, await fleetApi.getInventory(sh.id)] as const; }
            catch { return [sh.id, [] as Cargo[]] as const; }
          }),
        );
        results.push(...sliceResults);
      }
      for (const [id, inv] of results) shipInventoryCache.set(id, inv);
      const invElapsed = ((Date.now() - fetchStart) / 1000).toFixed(1);
      console.log(`[runCycle:inv] ${toFetch.length} inventories pre-fetched in ${invElapsed}s`);
      s = appendLog(s, `🗃️ inventories pre-fetched for ${toFetch.length} window ships`);
    }

    // ④ Pre-compute coveredPorts once (was O(n²) — rebuilt per ship inside the loop)
    //    Updated incrementally when a pax-chase dispatch is pushed.
    const coveredPorts = new Set<string>();
    for (const sh of ships) {
      if (sh.status === "docked" && sh.port_id) coveredPorts.add(sh.port_id);
      const shSs = s.ships[sh.id];
      if (shSs?.phase === "transiting_to_buy" && !shSs.plan?.goodId && shSs.plan?.buyPortId) {
        coveredPorts.add(shSs.plan.buyPortId);
      }
    }

    // ⑤ Pre-compute trade candidates per unique port in the current window only
    //    Key: portId → RawCandidate[]  (full unfiltered list; per-ship pax filter applied below)
    const candidatesT0 = Date.now();
    const candidatesByPort = new Map<string, RawCandidate[]>();
    const uniqueDockedPorts = new Set(windowShips.filter((sh: Ship) => sh.port_id).map((sh: Ship) => sh.port_id!));
    for (const portId of uniqueDockedPorts) {
      const paths = getPathsFrom(portId);
      const allCandidates: RawCandidate[] = [];
      for (const buyPortId of npcGoods.keys()) {
        const toBuyPath = buyPortId === portId ? null : paths.find((p) => p.destPortId === buyPortId);
        if (buyPortId !== portId && !toBuyPath) continue;
        const toBuyDist = toBuyPath?.totalDistance ?? 0;
        const toLegsBuy = toBuyPath?.legs ?? [];
        const sellPaths = getPathsFrom(buyPortId);
        for (const sp of sellPaths) {
          const destGoods = npcGoods.get(sp.destPortId);
          if (!destGoods) continue;
          for (const goodId of npcGoods.get(buyPortId) ?? []) {
            if (!destGoods.has(goodId)) continue;
            const destOrd  = npcMaxOrd.get(`${sp.destPortId}:${goodId}`) ?? 0;
            const srcOrd   = npcMinOrd.get(`${buyPortId}:${goodId}`) ?? 0;
            const prescore = destOrd - srcOrd;
            if (prescore < 0) continue;
            allCandidates.push({
              buyPortId, sellPortId: sp.destPortId,
              sellLegs: sp.legs, toLegsBuy,
              goodId, prescore,
              totalDist: toBuyDist + sp.totalDistance,
            });
          }
        }
      }
      candidatesByPort.set(portId, allCandidates);
    }
    console.log(`[runCycle:cands] ${uniqueDockedPorts.size} ports pre-computed in ${((Date.now() - candidatesT0) / 1000).toFixed(1)}s`);

    // ⑥ Pre-fetch ALL sell + buy quotes for window candidates in chunked parallel batches.
    //    Quotes are valid for 120 s — safe to reuse for all per-ship routing decisions
    //    this cycle, eliminating every per-ship quote API call.
    //    Chunked to respect server batch-size limits; chunks run in parallel.
    const QUOTE_BATCH_CHUNK = 100; // max items per batchCreateQuotes call
    const quoteCache = new Map<string, number>(); // "portId:goodId:action" → unit_price
    {
      const seen = new Set<string>();
      const requests: Array<{ port_id: string; good_id: string; quantity: number; action: "buy" | "sell" }> = [];
      const keys: string[] = [];
      for (const candidates of candidatesByPort.values()) {
        for (const c of candidates) {
          const sellKey = `${c.sellPortId}:${c.goodId}:sell`;
          if (!seen.has(sellKey)) {
            seen.add(sellKey);
            requests.push({ port_id: c.sellPortId, good_id: c.goodId, quantity: MAX_UNITS, action: "sell" });
            keys.push(sellKey);
          }
          const buyKey = `${c.buyPortId}:${c.goodId}:buy`;
          if (!seen.has(buyKey)) {
            seen.add(buyKey);
            requests.push({ port_id: c.buyPortId, good_id: c.goodId, quantity: MAX_UNITS, action: "buy" });
            keys.push(buyKey);
          }
        }
      }
      if (requests.length > 0) {
        const quoteFetchT0 = Date.now();
        const QUOTE_MAX_RETRIES = 3;
        // Split into chunks; retry failed chunks up to QUOTE_MAX_RETRIES times
        const chunks: Array<{ reqs: typeof requests; startIdx: number }> = [];
        for (let i = 0; i < requests.length; i += QUOTE_BATCH_CHUNK) {
          chunks.push({ reqs: requests.slice(i, i + QUOTE_BATCH_CHUNK), startIdx: i });
        }

        // Track which chunks still need to run (initially all)
        let pending = chunks.map((_, ci) => ci);
        const settled = new Map<number, Awaited<ReturnType<typeof tradeApi.batchCreateQuotes>>>();

        for (let attempt = 0; attempt < QUOTE_MAX_RETRIES && pending.length > 0; attempt++) {
          const results = await Promise.allSettled(
            pending.map((ci) => tradeApi.batchCreateQuotes({ requests: chunks[ci].reqs })),
          );
          const stillFailing: number[] = [];
          for (let i = 0; i < pending.length; i++) {
            const ci = pending[i];
            const result = results[i];
            if (result.status === "fulfilled") {
              settled.set(ci, result.value);
            } else {
              stillFailing.push(ci);
            }
          }
          pending = stillFailing;
        }

        let totalHits = 0;
        for (const [ci, value] of settled) {
          const { startIdx } = chunks[ci];
          for (let j = 0; j < value.length; j++) {
            const item = value[j];
            if (item?.status === "success" && item.quote) { quoteCache.set(keys[startIdx + j], item.quote.unit_price); totalHits++; }
          }
        }
        const failNote = pending.length > 0 ? ` (${pending.length} chunks failed after ${QUOTE_MAX_RETRIES} retries)` : "";
        console.log(`[runCycle:quotes] ${requests.length} quotes (${chunks.length} chunks) pre-fetched in ${((Date.now() - quoteFetchT0) / 1000).toFixed(1)}s (${totalHits} hits${failNote})`);
      }
    }

    // ── Tag ships for relocation when over fleet target ────────────────────
    // Must run after getPathsFrom is available. Cogs first; ferries excluded.
    {
      const fm = s.fleetMgmt;
      const fleetTarget = fm?.fleetTarget ?? Infinity;
      console.log(`[runCycle:reloc] ships=${ships.length} target=${fleetTarget === Infinity ? "∞" : fleetTarget} knownYards=${fm?.knownShipyardPortIds.length ?? 0}`);
      if (ships.length > fleetTarget && (fm?.knownShipyardPortIds.length ?? 0) > 0) {
        const knownYards = fm!.knownShipyardPortIds;
        const relocCandidates = ships
          .filter((sh) => sh.status !== "traveling" && sh.port_id)
          .sort((a, b) => {
            const aCog = COG_TYPE_PATTERN.test(stMap.get(a.ship_type_id)?.name ?? "") ? 0 : 1;
            const bCog = COG_TYPE_PATTERN.test(stMap.get(b.ship_type_id)?.name ?? "") ? 0 : 1;
            return aCog - bCog;
          });
        for (const sh of relocCandidates) {
          if (!sh.port_id) continue;
          const ss = s.ships[sh.id];
          if (!ss || ss.role === "ferry") continue;
          if (knownYards.includes(sh.port_id)) continue;
          if (ss.relocatingToPortId) continue;
          const shPaths = getPathsFrom(sh.port_id!);
          const nearest = knownYards
            .map((pid) => ({ portId: pid, path: shPaths.find((p) => p.destPortId === pid) }))
            .filter((x): x is { portId: string; path: NonNullable<typeof x.path> } => x.path != null)
            .sort((a, b) => a.path.totalDistance - b.path.totalDistance)[0];
          if (!nearest) continue;
          s = { ...s, ships: { ...s.ships, [sh.id]: { ...ss, relocatingToPortId: nearest.portId } } };
          s = appendLog(s, `🏴 ${sh.name}: queued for relocation → ${portName(nearest.portId)} (fleet ${ships.length}/${fleetTarget})`);
        }
      }
    }

    // Inline inventory fetch helper — now just reads from the pre-populated cache
    const fetchShipInv = (shipId: string): Cargo[] => shipInventoryCache.get(shipId) ?? [];

    const shipLoopStart = Date.now();

    // Pass 1: traveling ships — cheap metric tick over all ships (no API calls)
    for (const ship of ships) {
      if (ship.status !== "traveling") continue;
      const tss = s.ships[ship.id] ?? defaultShipState();
      const travelingShipType = stMap.get(ship.ship_type_id);
      const travelingRole: "ferry" | "multi" = FERRY_TYPE_PATTERN.test(travelingShipType?.name ?? "") ? "ferry" : "multi";
      s = { ...s, ships: { ...s.ships, [ship.id]: { ...tss, role: travelingRole, cyclesActive: tss.cyclesActive + 1, cyclesIdle: 0 } } };
    }

    // Pass 2: docked ships in the current window — full routing logic (parallel batches)
    const chunkArray = <T>(arr: T[], size: number): T[][] => {
      const chunks: T[][] = [];
      for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
      return chunks;
    };

    const fundsRef = { value: availableFunds };

    const subBatches = chunkArray(windowShips, SHIP_WINDOW_SIZE);
    let shipsActioned = 0;

    for (const batch of subBatches) {
      type ShipResult = { shipId: string; finalState: AutopilotShipState | null; logs: string[]; profitDelta: number; actioned: boolean };

      const batchResults = await Promise.allSettled(
        batch.map(async (ship): Promise<ShipResult> => {
          const logs: string[] = [];
          let profitDelta = 0;
          let actioned = false;

          if (!ship.port_id) return { shipId: ship.id, finalState: null, logs, profitDelta, actioned };

          let shipState = s.ships[ship.id] ?? defaultShipState();
          const shipType = stMap.get(ship.ship_type_id);
          const isFerry = FERRY_TYPE_PATTERN.test(shipType?.name ?? "");
          const role: "ferry" | "multi" = isFerry ? "ferry" : "multi";

          // Persist the role so the dashboard can display it
          if (shipState.role !== role) {
            shipState = { ...shipState, role };
          }

          const capacity = Math.min(shipType?.capacity ?? 20, MAX_UNITS);

          // Actual remaining cargo space — prevents "Capacity exceeded" on buy
          const shipInv = fetchShipInv(ship.id);
          const usedCapacity = shipInv.reduce((sum, c) => sum + c.quantity, 0);
          const freeCapacity = Math.max(0, capacity - usedCapacity);

          // ── RELOCATION: route ship toward a shipyard port for sale ───────────
          if (shipState.phase === "idle" && shipState.relocatingToPortId) {
            const targetPortId = shipState.relocatingToPortId;
            const relocPaths = getPathsFrom(ship.port_id);
            const relocPath = relocPaths.find((p) => p.destPortId === targetPortId);
            if (relocPath && relocPath.legs.length > 0) {
              const ssBeforeReloc = shipState;
              const relocPlan: ShipPlan = { sellPortId: targetPortId, legs: relocPath.legs.slice(1) };
              shipState = { ...shipState, phase: "transiting_to_sell", plan: relocPlan, cyclesIdle: 0, cyclesActive: shipState.cyclesActive + 1 };
              logs.push(`🏴 ${ship.name}: relocating → ${portName(targetPortId)} for sale`);
              await dispatchTransit(ship.id, relocPath.legs[0].routeId, (msg) => {
                shipState = ssBeforeReloc;
                logs.push(`${ship.name}: relocation dispatch failed — ${msg}`);
              });
              actioned = true;
              return { shipId: ship.id, finalState: shipState, logs, profitDelta, actioned };
            } else if (ship.port_id === targetPortId) {
              // Arrived — clear the tag, let fleet management sell it next cycle
              shipState = { ...shipState, relocatingToPortId: undefined };
            }
          }

          // ══════════════════════════════════════════════════════════════════════════
          // IDLE — board passengers + scan for cargo, then dispatch
          // ══════════════════════════════════════════════════════════════════════════
          if (shipState.phase === "idle") {
            await sleep(DOCK_DELAY_MS);
            actioned = true;

            // ── 0. Clear leftover cargo before buying/boarding ─────────────────────
            // A ship can end up idle-with-cargo after a failed sell or state reset.
            // Try to sell all items at current port in parallel; any that fail get dispatched.
            if (usedCapacity > 0) {
              let dispatched = false;
              const leftoverItems = shipInv.filter((c) => c.quantity > 0);
              let leftoverQuotes: Awaited<ReturnType<typeof tradeApi.batchCreateQuotes>> = [];
              try {
                leftoverQuotes = await tradeApi.batchCreateQuotes({
                  requests: leftoverItems.map((it) => ({ port_id: ship.port_id!, good_id: it.good_id, quantity: it.quantity, action: "sell" as const })),
                });
              } catch { /* try fallback dispatch below */ }
              const leftoverSells = await Promise.allSettled(
                leftoverItems.map(async (it, i) => {
                  const sq = leftoverQuotes[i];
                  if (!sq || sq.status !== "success" || !sq.quote) throw new Error("no quote");
                  await tradeApi.executeQuote({ token: sq.token, destinations: [{ type: "ship", id: ship.id, quantity: it.quantity }] });
                  return { good_id: it.good_id, quantity: it.quantity, unitPrice: sq.quote.unit_price };
                }),
              );
              for (let i = 0; i < leftoverItems.length; i++) {
                const result = leftoverSells[i];
                const it = leftoverItems[i];
                if (result.status === "fulfilled") {
                  profitDelta += result.value.unitPrice * it.quantity;
                  logs.push(`${ship.name}: 🧹 cleared ${it.quantity}× ${goodNameFn(it.good_id)} @ £${result.value.unitPrice}`);
                  shipInventoryCache.delete(ship.id);
                } else if (!dispatched) {
                  // Can't sell here — dispatch to best sell port for first unsold item
                  const sellPaths = getPathsFrom(ship.port_id);
                  const bestSellPath = sellPaths
                    .filter((sp) => (npcMaxOrd.get(`${sp.destPortId}:${it.good_id}`) ?? 0) >= MIN_SELL_PRICE_LEVEL)
                    .sort((a, b) => (npcMaxOrd.get(`${b.destPortId}:${it.good_id}`) ?? 0) - (npcMaxOrd.get(`${a.destPortId}:${it.good_id}`) ?? 0))[0];
                  if (bestSellPath && bestSellPath.legs.length > 0) {
                    const plan: ShipPlan = {
                      goodId: it.good_id, goodName: goodNameFn(it.good_id),
                      quantity: it.quantity, actualBuyPrice: 0,
                      sellPortId: bestSellPath.destPortId, legs: bestSellPath.legs.slice(1),
                    };
                    const ssBeforeDispatch = shipState;
                    shipState = { ...shipState, phase: "transiting_to_sell", plan, cyclesIdle: 0, cyclesActive: shipState.cyclesActive + 1 };
                    logs.push(`${ship.name}: → ${portName(bestSellPath.destPortId)} to sell leftover ${it.quantity}× ${goodNameFn(it.good_id)}`);
                    await dispatchTransit(ship.id, bestSellPath.legs[0].routeId, (msg) => {
                      shipState = ssBeforeDispatch;
                      logs.push(`${ship.name}: leftover dispatch failed — ${msg}`);
                    });
                    dispatched = true;
                  } else {
                    logs.push(`${ship.name}: ⚠️ stuck with ${it.quantity}× ${goodNameFn(it.good_id)} — no sell route`);
                  }
                }
              }
              if (dispatched) return { shipId: ship.id, finalState: shipState, logs, profitDelta, actioned };
            }

            const paths = getPathsFrom(ship.port_id);

            // ── 1. Board best passenger at current port (always — pure profit) ─────
            const cycleNow = new Date();
            const paxHere = allPassengers.filter((p) =>
              p.origin_port_id === ship.port_id && new Date(p.expires_at) > cycleNow,
            );

            let boardedPaxDestination: string | null = null;
            let boardedPaxBid = 0;

            if (paxHere.length > 0 && (shipType?.passengers ?? 0) > 0) {
              // Score passengers by bid per unit of distance (best value first)
              const scored = paxHere
                .map((p) => {
                  const path = paths.find((pa) => pa.destPortId === p.destination_port_id);
                  return { ...p, dist: path?.totalDistance ?? Infinity };
                })
                .filter((p) => p.dist < Infinity)
                .sort((a, b) => b.bid / a.dist - a.bid / b.dist);

              for (const p of scored) {
                try {
                  await passengersApi.boardPassenger(p.id, { ship_id: ship.id });
                  boardedPaxDestination = p.destination_port_id;
                  boardedPaxBid = p.bid;
                  profitDelta += p.bid; // accrue at boarding — delivery is automatic
                  logs.push(`${ship.name}: 🧳 boarded ${p.count} pax → ${portName(p.destination_port_id)} (£${p.bid})`);
                  break;
                } catch (e: unknown) {
                  logs.push(`${ship.name}: pax board failed — ${(e as Error).message}`);
                }
              }
            }

            // ── 2. Scan for best cargo (multi-purpose ships only) ─────────────────
            let bestCargo: (ScoredCandidate & { buyPrice: number }) | null = null;

            if (!isFerry) {
              const allCandidates = candidatesByPort.get(ship.port_id) ?? [];

              // If pax were boarded: only consider co-routable cargo (same dest, buy here)
              const candidates = boardedPaxDestination
                ? allCandidates.filter(
                    (c) => c.sellPortId === boardedPaxDestination && c.buyPortId === ship.port_id,
                  )
                : allCandidates;

              // All quotes pre-fetched this cycle — pure synchronous lookup, zero API calls
              let bestMargin = -Infinity;
              for (const c of candidates) {
                const sellPrice = quoteCache.get(`${c.sellPortId}:${c.goodId}:sell`);
                const buyPrice  = quoteCache.get(`${c.buyPortId}:${c.goodId}:buy`);
                if (sellPrice === undefined || buyPrice === undefined) continue;
                const margin = (sellPrice - buyPrice) / buyPrice;
                if (margin >= MIN_MARGIN && margin > bestMargin) {
                  bestMargin = margin;
                  bestCargo = { ...c, npcSellPrice: sellPrice, buyPrice };
                }
              }
            }

            // ── 3. Decide and dispatch ─────────────────────────────────────────────

            if (boardedPaxDestination) {
              // Passengers boarded — MUST go to their destination
              const destPath = paths.find((p) => p.destPortId === boardedPaxDestination);
              if (!destPath || destPath.legs.length === 0) {
                logs.push(`${ship.name}: ⚠️ no route to pax destination ${portName(boardedPaxDestination)} — resetting`);
                shipState = { ...shipState, phase: "idle" };
                return { shipId: ship.id, finalState: shipState, logs, profitDelta, actioned };
              }

              // Buy cargo to the same destination if available and affordable
              let cargoGoodId: string | undefined;
              let cargoGoodName: string | undefined;
              let cargoQty = 0;
              let cargoBuyPrice = 0;
              let cargoSellPrice: number | undefined;

              if (bestCargo && fundsRef.value > 0 && freeCapacity > 0) {
                try {
                  // Use pre-fetched price to calculate exact qty, then ONE fresh quote for execution
                  const affordable = Math.floor(fundsRef.value / bestCargo.buyPrice);
                  const buyQty = Math.min(freeCapacity, affordable);
                  if (buyQty > 0) {
                    const eq = await tradeApi.createQuote({ port_id: ship.port_id, good_id: bestCargo.goodId, quantity: buyQty, action: "buy" });
                    await tradeApi.executeQuote({ token: eq.token, destinations: [{ type: "ship", id: ship.id, quantity: buyQty }] });
                    fundsRef.value -= buyQty * eq.unit_price;
                    cargoGoodId    = bestCargo.goodId;
                    cargoGoodName  = goodNameFn(bestCargo.goodId);
                    cargoQty       = buyQty;
                    cargoBuyPrice  = eq.unit_price;
                    cargoSellPrice = bestCargo.npcSellPrice;
                    logs.push(`${ship.name}: 📦 bought ${buyQty}× ${cargoGoodName} @ £${eq.unit_price} (co-routing with pax)`);
                  }
                } catch (e: unknown) {
                  logs.push(`${ship.name}: co-route cargo buy failed — ${(e as Error).message}`);
                }
              }

              const plan: ShipPlan = {
                sellPortId: boardedPaxDestination,
                legs: destPath.legs.slice(1),
                passengerBid: boardedPaxBid,
                ...(cargoQty > 0 ? { goodId: cargoGoodId, goodName: cargoGoodName, quantity: cargoQty, actualBuyPrice: cargoBuyPrice, sellPrice: cargoSellPrice } : {}),
              };

              const ssBeforePaxDispatch = shipState;
              shipState = { ...shipState, phase: "transiting_to_sell", plan, cyclesIdle: 0, cyclesActive: shipState.cyclesActive + 1 };
              logs.push(`${ship.name}: → ${portName(boardedPaxDestination)} (pax £${boardedPaxBid}${cargoQty > 0 ? ` + ${cargoQty}× ${cargoGoodName}` : ""})`);
              await dispatchTransit(ship.id, destPath.legs[0].routeId, (msg) => {
                shipState = ssBeforePaxDispatch;
                logs.push(`${ship.name}: pax dispatch failed — ${msg}`);
              });

            } else if (bestCargo) {
              // No passengers — execute best cargo trade

              if (bestCargo.buyPortId === ship.port_id) {
                // ── Local buy: purchase here, head to sell port ──────────────────
                const destPath = paths.find((p) => p.destPortId === bestCargo.sellPortId);
                if (!destPath || destPath.legs.length === 0) {
                  logs.push(`${ship.name}: no route to sell port ${portName(bestCargo.sellPortId)}`);
                  return { shipId: ship.id, finalState: shipState, logs, profitDelta, actioned };
                }
                try {
                  // Use pre-fetched price to calculate exact qty, then ONE fresh quote for execution
                  const affordable = Math.floor(fundsRef.value / bestCargo.buyPrice);
                  const buyQty = Math.min(freeCapacity, affordable);
                  if (buyQty <= 0) {
                    logs.push(`${ship.name}: insufficient funds for ${goodNameFn(bestCargo.goodId)}`);
                    return { shipId: ship.id, finalState: shipState, logs, profitDelta, actioned };
                  }
                  const eq = await tradeApi.createQuote({ port_id: ship.port_id, good_id: bestCargo.goodId, quantity: buyQty, action: "buy" });
                  await tradeApi.executeQuote({ token: eq.token, destinations: [{ type: "ship", id: ship.id, quantity: buyQty }] });
                  fundsRef.value -= buyQty * eq.unit_price;

                  const plan: ShipPlan = {
                    goodId: bestCargo.goodId, goodName: goodNameFn(bestCargo.goodId),
                    quantity: buyQty, actualBuyPrice: eq.unit_price, sellPrice: bestCargo.npcSellPrice,
                    sellPortId: bestCargo.sellPortId, legs: destPath.legs.slice(1),
                  };
                  const ssBeforeLocalDispatch = shipState;
                  shipState = { ...shipState, phase: "transiting_to_sell", plan, cyclesIdle: 0, cyclesActive: shipState.cyclesActive + 1 };
                  logs.push(`${ship.name}: 📦 ${buyQty}× ${plan.goodName} → ${portName(bestCargo.sellPortId)} (£${eq.unit_price}→£${bestCargo.npcSellPrice}, ${((bestCargo.npcSellPrice - eq.unit_price) / eq.unit_price * 100).toFixed(1)}%)`);
                  await dispatchTransit(ship.id, destPath.legs[0].routeId, (msg) => {
                    shipState = ssBeforeLocalDispatch;
                    logs.push(`${ship.name}: local buy failed — ${msg}`);
                  });
                } catch (e: unknown) {
                  logs.push(`${ship.name}: local buy failed — ${(e as Error).message}`);
                }

              } else {
                // ── Remote buy: head to buy port first ───────────────────────────
                const toBuyPath = paths.find((p) => p.destPortId === bestCargo.buyPortId);
                if (!toBuyPath || toBuyPath.legs.length === 0) {
                  logs.push(`${ship.name}: no route to buy port ${portName(bestCargo.buyPortId)}`);
                  return { shipId: ship.id, finalState: shipState, logs, profitDelta, actioned };
                }
                const plan: ShipPlan = {
                  goodId: bestCargo.goodId, goodName: goodNameFn(bestCargo.goodId),
                  quantity: 0, actualBuyPrice: 0,
                  buyPortId: bestCargo.buyPortId,
                  sellPortId: bestCargo.sellPortId, sellPrice: bestCargo.npcSellPrice,
                  sellLegs: bestCargo.sellLegs,
                  legs: toBuyPath.legs.slice(1),
                };
                const ssBeforeRemoteDispatch = shipState;
                shipState = { ...shipState, phase: "transiting_to_buy", plan, cyclesIdle: 0, cyclesActive: shipState.cyclesActive + 1 };
                logs.push(`${ship.name}: → ${portName(bestCargo.buyPortId)} to buy ${goodNameFn(bestCargo.goodId)}`);
                await dispatchTransit(ship.id, toBuyPath.legs[0].routeId, (msg) => {
                  shipState = ssBeforeRemoteDispatch;
                  logs.push(`${ship.name}: remote dispatch failed — ${msg}`);
                });
              }

            } else {
              // ── No cargo opportunity — route ship to best uncovered passenger port ──
              let chasedPax = false;
              if ((shipType?.passengers ?? 0) > 0) {
                const now = Date.now();
                const speed = shipType?.speed ?? 4;
                const paxPaths = getPathsFrom(ship.port_id, MAX_PAX_CHASE_HOPS);

                // coveredPorts is pre-computed before the loop and updated incrementally

                // Build a path lookup map for O(1) access instead of repeated .find() calls
                const paxPathMap = new Map<string, Path>(paxPaths.map((p) => [p.destPortId, p]));

                // Group valid passengers by origin port, compute total bid per port.
                // Filter out passengers this ship cannot reach before they expire.
                const portBids = new Map<string, { total: number; best: Passenger }>();
                for (const p of allPassengers) {
                  const path = paxPathMap.get(p.origin_port_id);
                  if (!path) continue;
                  const eta = travelTimeMs(path.totalDistance, speed) + TRAVEL_BUFFER_MS;
                  const timeLeft = new Date(p.expires_at).getTime() - now;
                  if (timeLeft < eta + MIN_PAX_EXPIRY_BUFFER_MS) continue;
                  const existing = portBids.get(p.origin_port_id);
                  if (!existing || p.bid > existing.best.bid) {
                    portBids.set(p.origin_port_id, {
                      total: (existing?.total ?? 0) + p.bid,
                      best: existing && existing.best.bid >= p.bid ? existing.best : p,
                    });
                  } else {
                    existing.total += p.bid;
                  }
                }

                // Score each reachable port: uncovered ports get a 2× multiplier
                const portCandidates = Array.from(portBids.entries())
                  .filter(([portId]) => portId !== ship.port_id)
                  .map(([portId, { total, best }]) => {
                    const path = paxPathMap.get(portId)!;
                    const coverageBonus = coveredPorts.has(portId) ? 1 : 2;
                    return { portId, path, best, totalBid: total, score: (total / path.totalDistance) * coverageBonus };
                  })
                  .sort((a, b) => b.score - a.score);

                const bestPort = portCandidates[0];
                if (bestPort) {
                  const ssBeforePaxChase = shipState;
                  shipState = { ...shipState, phase: "transiting_to_buy", plan: {
                    goodId: "", goodName: "",
                    quantity: 0, actualBuyPrice: 0,
                    buyPortId: bestPort.portId,
                    sellPortId: bestPort.best.destination_port_id, sellPrice: 0,
                    sellLegs: [], legs: bestPort.path.legs.slice(1),
                    passengerBid: bestPort.totalBid,
                  }, cyclesIdle: 0, cyclesActive: shipState.cyclesActive + 1 };
                  const covTag = coveredPorts.has(bestPort.portId) ? "" : " (uncovered)";
                  const etaSec = Math.round(travelTimeMs(bestPort.path.totalDistance, speed) / 1000);
                  logs.push(`${ship.name}: 🧳 → ${portName(bestPort.portId)}${covTag} (£${bestPort.totalBid} pax, ETA ~${etaSec}s)`);
                  coveredPorts.add(bestPort.portId); // incremental update — prevents next ship choosing same port
                  await dispatchTransit(ship.id, bestPort.path.legs[0].routeId, (msg) => {
                    shipState = ssBeforePaxChase;
                    logs.push(`${ship.name}: pax-chase dispatch failed — ${msg}`);
                  });
                  chasedPax = true;
                }
              }

              if (!chasedPax) {
                if (isFerry) {
                  logs.push(`${ship.name}: ⚓ covering ${portName(ship.port_id)}`);
                  shipState = { ...shipState, cyclesActive: shipState.cyclesActive + 1 };
                } else {
                  logs.push(`${ship.name}: idle at ${portName(ship.port_id)} — no opportunity`);
                  shipState = { ...shipState, cyclesIdle: shipState.cyclesIdle + 1, cyclesActive: shipState.cyclesActive + 1 };
                }
              }
            }

          // ══════════════════════════════════════════════════════════════════════════
          // TRANSITING_TO_BUY — advance waypoints; buy and dispatch on arrival
          // ══════════════════════════════════════════════════════════════════════════
          } else if (shipState.phase === "transiting_to_buy") {
            const plan = shipState.plan!;

            // Advance waypoint if not yet at buy port
            if (plan.legs.length > 0 && ship.port_id !== plan.buyPortId) {
              const ssBeforeWaypoint = shipState;
              shipState = { ...shipState, plan: { ...plan, legs: plan.legs.slice(1) } };
              logs.push(`${ship.name}: waypoint → ${portName(plan.legs[0].toPortId)}`);
              await dispatchTransit(ship.id, plan.legs[0].routeId, (msg) => {
                shipState = ssBeforeWaypoint;
                logs.push(`${ship.name}: waypoint failed — ${msg}`);
              });
              return { shipId: ship.id, finalState: shipState, logs, profitDelta, actioned };
            }

            if (ship.port_id !== plan.buyPortId) {
              logs.push(`${ship.name}: ⚠️ lost in transit (expected ${portName(plan.buyPortId)}) — resetting`);
              shipState = { ...shipState, phase: "idle" };
              return { shipId: ship.id, finalState: shipState, logs, profitDelta, actioned };
            }

            // Arrived at buy port
            await sleep(DOCK_DELAY_MS);

            // Passenger-chase: arrived at origin port — reset to idle so the passenger
            // boarding logic in the idle branch picks them up this cycle.
            if (!plan.goodId) {
              logs.push(`${ship.name}: arrived at ${portName(ship.port_id)} to board pax`);
              shipState = { ...shipState, phase: "idle" };
              return { shipId: ship.id, finalState: shipState, logs, profitDelta, actioned };
            }

            let boughtQty = 0;
            let actualBuyPrice = 0;

            if (fundsRef.value > 0 && freeCapacity > 0) {
              try {
                // Use cached price to estimate qty — avoids a round-trip for affordability check
                const priceEstimate = quoteCache.get(`${ship.port_id}:${plan.goodId!}:buy`) ?? 0;
                const affordable = priceEstimate > 0 ? Math.floor(fundsRef.value / priceEstimate) : freeCapacity;
                const buyQty = Math.min(freeCapacity, Math.max(1, affordable));
                const eq = await tradeApi.createQuote({ port_id: ship.port_id, good_id: plan.goodId!, quantity: buyQty, action: "buy" });
                // Re-check affordability at actual price in case market moved
                const actualBuyQty = Math.min(buyQty, Math.floor(fundsRef.value / eq.unit_price));
                if (actualBuyQty > 0) {
                  await tradeApi.executeQuote({ token: eq.token, destinations: [{ type: "ship", id: ship.id, quantity: actualBuyQty }] });
                  fundsRef.value -= actualBuyQty * eq.unit_price;
                  boughtQty = actualBuyQty;
                  actualBuyPrice = eq.unit_price;
                  logs.push(`${ship.name}: bought ${actualBuyQty}× ${plan.goodName} @ £${eq.unit_price} at ${portName(ship.port_id)}`);
                }
              } catch (e: unknown) {
                logs.push(`${ship.name}: buy failed at ${portName(ship.port_id)} — ${(e as Error).message}`);
              }
            }

            if (boughtQty === 0) {
              logs.push(`${ship.name}: nothing bought at ${portName(ship.port_id)} — resetting`);
              shipState = { ...shipState, phase: "idle" };
              return { shipId: ship.id, finalState: shipState, logs, profitDelta, actioned };
            }

            // Dispatch to sell port (use pre-computed sellLegs, or find path if needed)
            const sellLegs = plan.sellLegs ?? [];
            if (sellLegs.length > 0) {
              const ssBeforeSellLegs = shipState;
              shipState = { ...shipState, phase: "transiting_to_sell", plan: { ...plan, quantity: boughtQty, actualBuyPrice, legs: sellLegs.slice(1) }, cyclesIdle: 0 };
              logs.push(`${ship.name}: → ${portName(plan.sellPortId)} to sell ${boughtQty}× ${plan.goodName}`);
              await dispatchTransit(ship.id, sellLegs[0].routeId, (msg) => {
                shipState = { ...ssBeforeSellLegs, phase: "idle" };
                logs.push(`${ship.name}: sell dispatch failed — ${msg}`);
              });
            } else {
              // Rare: sellLegs was empty (same port buy/sell?), re-find path
              const sellPaths = getPathsFrom(ship.port_id);
              const toSell = sellPaths.find((p) => p.destPortId === plan.sellPortId);
              if (!toSell || toSell.legs.length === 0) {
                logs.push(`${ship.name}: ⚠️ no sell route from ${portName(ship.port_id)} — resetting`);
                shipState = { ...shipState, phase: "idle" };
                return { shipId: ship.id, finalState: shipState, logs, profitDelta, actioned };
              }
              const ssBeforeAltSell = shipState;
              shipState = { ...shipState, phase: "transiting_to_sell", plan: { ...plan, quantity: boughtQty, actualBuyPrice, legs: toSell.legs.slice(1) }, cyclesIdle: 0 };
              logs.push(`${ship.name}: → ${portName(plan.sellPortId)} to sell ${boughtQty}× ${plan.goodName}`);
              await dispatchTransit(ship.id, toSell.legs[0].routeId, (msg) => {
                shipState = { ...ssBeforeAltSell, phase: "idle" };
                logs.push(`${ship.name}: sell dispatch failed — ${msg}`);
              });
            }

          // ══════════════════════════════════════════════════════════════════════════
          // TRANSITING_TO_SELL — advance waypoints; sell cargo on arrival, then idle
          // ══════════════════════════════════════════════════════════════════════════
          } else if (shipState.phase === "transiting_to_sell") {
            const plan = shipState.plan!;

            // Advance waypoint
            if (plan.legs.length > 0 && ship.port_id !== plan.sellPortId) {
              const ssBeforeWaypoint = shipState;
              shipState = { ...shipState, plan: { ...plan, legs: plan.legs.slice(1) } };
              logs.push(`${ship.name}: waypoint → ${portName(plan.legs[0].toPortId)}`);
              await dispatchTransit(ship.id, plan.legs[0].routeId, (msg) => {
                shipState = ssBeforeWaypoint;
                logs.push(`${ship.name}: waypoint failed — ${msg}`);
              });
              return { shipId: ship.id, finalState: shipState, logs, profitDelta, actioned };
            }

            if (ship.port_id !== plan.sellPortId) {
              logs.push(`${ship.name}: ⚠️ at ${portName(ship.port_id)}, expected ${portName(plan.sellPortId)} — resetting`);
              shipState = { ...shipState, phase: "idle" };
              return { shipId: ship.id, finalState: shipState, logs, profitDelta, actioned };
            }

            // Arrived at destination
            await sleep(DOCK_DELAY_MS);

            // Sell cargo if any — use ACTUAL inventory to avoid "Cargo not found"
            if (plan.goodId) {
              const actualItem = shipInv.find((c) => c.good_id === plan.goodId);
              const sellQty = actualItem?.quantity ?? 0;
              if (sellQty > 0) {
                let sold = false;
                try {
                  const sq = await tradeApi.createQuote({ port_id: ship.port_id, good_id: plan.goodId, quantity: sellQty, action: "sell" });
                  await tradeApi.executeQuote({ token: sq.token, destinations: [{ type: "ship", id: ship.id, quantity: sellQty }] });
                  const profit = (sq.unit_price - (plan.actualBuyPrice ?? 0)) * sellQty;
                  profitDelta += profit;
                  shipState = { ...shipState, cargoTrips: shipState.cargoTrips + 1, lifetimeProfit: shipState.lifetimeProfit + profit };
                  logs.push(`${ship.name}: sold ${sellQty}× ${plan.goodName} @ £${sq.unit_price} (+£${Math.round(profit).toLocaleString()})`);
                  sold = true;
                } catch (e: unknown) {
                  logs.push(`${ship.name}: NPC sell failed — ${(e as Error).message}`);
                }

                if (!sold) {
                  logs.push(`${ship.name}: ⚠️ NPC sell failed for ${sellQty}× ${plan.goodName} — cargo remains on ship`);
                }
              } else if ((plan.quantity ?? 0) > 0) {
                logs.push(`${ship.name}: ⚠️ cargo gone (${plan.goodName}) — skipping sell`);
              }
            }

            if (plan.passengerBid) {
              shipState = { ...shipState, paxTrips: shipState.paxTrips + 1, lifetimeProfit: shipState.lifetimeProfit + plan.passengerBid };
              logs.push(`${ship.name}: 🧳 pax delivered to ${portName(ship.port_id)} (+£${plan.passengerBid} at boarding)`);
            }

            // Back to idle — will re-scan next cycle
            shipState = { ...shipState, phase: "idle", cyclesIdle: 0 };
          }

          return { shipId: ship.id, finalState: shipState, logs, profitDelta, actioned };
        })
      );

      // Apply all results to s
      for (const result of batchResults) {
        if (result.status === "rejected") {
          s = appendLog(s, `Ship processing error: ${(result.reason as Error).message}`);
          continue;
        }
        const r = result.value;
        for (const msg of r.logs) s = appendLog(s, msg);
        s.profitAccrued += r.profitDelta;
        if (r.finalState !== null) {
          s = { ...s, ships: { ...s.ships, [r.shipId]: r.finalState } };
        }
        if (r.actioned) shipsActioned++;
      }
    }

    availableFunds = fundsRef.value;
    shipsActionedTotal = shipsActioned;

    s = appendLog(s, `🚢 window ${windowOffset}–${windowEnd - 1}/${dockedShips.length} (${shipBatches} batch${shipBatches > 1 ? "es" : ""}) — ${shipsActioned} ships in ${((Date.now() - shipLoopStart) / 1000).toFixed(1)}s`);
    console.log(`[runCycle:loop] done — ${shipsActioned}/${windowShips.length} window ships processed in ${((Date.now() - shipLoopStart) / 1000).toFixed(1)}s`);
    s = { ...s, shipWindowOffset: nextWindowOffset };

    // ── Fleet management ───────────────────────────────────────────────────────
    s = await runFleetManagement(s, ships, shipTypes, economy, availableFunds, allPassengers);

  } catch (e: unknown) {
    s = appendLog(s, `Cycle error: ${(e as Error).message}`);
    console.error(`[runCycle:error] ${(e as Error).message}`, (e as Error).stack);
  }

  // ── Profit & treasury history snapshots ───────────────────────────────────
  const prevHistory = s.profitHistory ?? [];
  const prevCumulative = prevHistory.length > 0 ? prevHistory[prevHistory.length - 1].cumulative : 0;
  const cycleProfit = s.profitAccrued - prevCumulative;
  const snapshot = { at: new Date().toISOString(), cumulative: s.profitAccrued, cycleProfit };
  const profitHistory = [...prevHistory, snapshot].slice(-MAX_PROFIT_HISTORY);

  const prevTreasury = s.treasuryHistory ?? [];
  const treasuryHistory = treasuryBalance !== null
    ? [...prevTreasury, { at: new Date().toISOString(), balance: treasuryBalance }].slice(-MAX_PROFIT_HISTORY)
    : prevTreasury;

  s = { ...s, profitHistory, treasuryHistory, cyclesRun: s.cyclesRun + 1 };

  console.log(`[runCycle:done] cycle #${s.cyclesRun + 1} in ${((Date.now() - cycleT0) / 1000).toFixed(1)}s | dispatched=${shipsActionedTotal} | profit=£${Math.round(cycleProfit).toLocaleString()} | cumulative=£${Math.round(s.profitAccrued).toLocaleString()}`);
  return s;
}