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

import type { Cargo, Good, MarketOrder, Passenger, Port, Route, Ship, ShipType, ShipyardInventoryItem, Warehouse, WarehouseInventory } from "@/lib/types";
import { api } from "@/lib/api/client";
import { companyApi } from "@/lib/api/company";
import { fleetApi } from "@/lib/api/fleet";
import { marketApi } from "@/lib/api/market";
import { passengersApi } from "@/lib/api/passengers";
import { shipyardsApi } from "@/lib/api/shipyards";
import { tradeApi } from "@/lib/api/trade";
import { warehousesApi } from "@/lib/api/warehouses";
import { worldApi } from "@/lib/api/world";
import { appendLog, CYCLE_MS, MAX_PROFIT_HISTORY, type AutopilotState, type AutopilotShipState, type RouteLeg, type ShipPlan } from "@/lib/autopilot-types";
import { getWarehouseStocks, removeWarehouseStock, upsertWarehouseStock } from "@/lib/db/collections";

export * from "@/lib/autopilot-types";

// ── Config ─────────────────────────────────────────────────────────────────────

const MIN_MARGIN   = 0.01;  // 1% minimum margin to accept a cargo trade
const MAX_UNITS    = 50;
/** Sell-quote batch size per ship scan. */
const SCAN_BATCH   = 16;
/** Delay (ms) after docking before buying/selling (lets server process the dock). */
const DOCK_DELAY_MS = 0;
/** Price level at or above which we sell from warehouse (Expensive = 4). */
const MIN_SELL_PRICE_LEVEL = 4;
/** Number of docked ships to process per cycle (rolling window). */
const SHIP_WINDOW_SIZE = 50;

// ── Fleet management constants ─────────────────────────────────────────────
/** Cycles a ship must be consecutively idle before it's a sell candidate. */
const SELL_IDLE_CYCLES = 18;       // 3 min at 10s cycle
/** Minimum fleet size — never sell below this. */
const MIN_FLEET_SIZE = 2;
/** Available-funds multiplier required before buying a ship. */
const BUY_RESERVE_MULTIPLIER = 3;
/** Cooldown between automated buys. */
const BUY_COOLDOWN_MS  = 5 * 60_000;
/** Cooldown between automated sells. */
const SELL_COOLDOWN_MS = 2 * 60_000;

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

/** Keep the best candidate per (buyPort, good) pair — highest prescore/distance ratio wins. */
function dedupBestPerGood(candidates: RawCandidate[], limit: number): RawCandidate[] {
  const seen = new Map<string, RawCandidate>();
  for (const c of candidates) {
    const k = `${c.buyPortId}:${c.goodId}`;
    const score = c.prescore / (c.totalDist || 1);
    const existing = seen.get(k);
    if (!existing || score > existing.prescore / (existing.totalDist || 1)) seen.set(k, c);
  }
  return [...seen.values()]
    .sort((a, b) => (b.prescore / (b.totalDist || 1)) - (a.prescore / (a.totalDist || 1)))
    .slice(0, limit);
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
  const fleetMgmt = s.fleetMgmt ?? { enabled: true, lastBuyAt: null, lastSellAt: null, knownShipyardPortIds: [], secondaryBuys: 0 };
  if (!fleetMgmt.enabled) return s;

  const now = Date.now();
  const stMap = new Map<string, ShipType>(shipTypes.map((t: ShipType) => [t.id, t]));

  // ── SELL: idle ships that have been stuck for 3+ minutes ─────────────────
  const canSell =
    !fleetMgmt.lastSellAt ||
    now - new Date(fleetMgmt.lastSellAt).getTime() > SELL_COOLDOWN_MS;

  if (canSell && ships.length > MIN_FLEET_SIZE) {
    for (const ship of ships) {
      if (ship.status === "traveling" || !ship.port_id) continue;
      const ss = s.ships[ship.id];
      if (!ss || ss.role === "ferry") continue; // ferries are never auto-sold
      if (ss.cyclesIdle < SELL_IDLE_CYCLES) continue;

      try {
        const sy = await shipyardsApi.getPortShipyard(ship.port_id);
        if (!fleetMgmt.knownShipyardPortIds.includes(ship.port_id)) {
          s = { ...s, fleetMgmt: { ...fleetMgmt, knownShipyardPortIds: [...fleetMgmt.knownShipyardPortIds, ship.port_id] } };
        }
        const result = await shipyardsApi.sellShip(sy.id, ship.id);
        s.profitAccrued += result.price;
        const { [ship.id]: _, ...remainingShips } = s.ships;
        s = { ...s, ships: remainingShips, fleetMgmt: { ...fleetMgmt, lastSellAt: new Date().toISOString() } };
        s = appendLog(s, `💰 Sold ${ship.name} @ £${result.price.toLocaleString()} (idle ${ss.cyclesIdle} cycles)`);
        break; // one sell per cycle
      } catch { /* no shipyard at this port — try next */ }
    }
  }

  // ── BUY: expand fleet when profitable and unbalanced ─────────────────────
  const canBuy =
    !fleetMgmt.lastBuyAt ||
    now - new Date(fleetMgmt.lastBuyAt).getTime() > BUY_COOLDOWN_MS;

  if (canBuy) {
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

    if (lastProfit > 2 * perCycleUpkeep) {
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

// ── Cycle ──────────────────────────────────────────────────────────────────────

export async function runCycle(s: AutopilotState, companyId: string): Promise<AutopilotState> {
  s = { ...s, lastCycleAt: new Date().toISOString() };
  let treasuryBalance: number | null = null;
  const cycleT0 = Date.now();

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

  try {
    s = appendLog(s, `── cycle start ──`);
    const fetchStart = Date.now();
    const [ships, allRoutes, shipTypes, allPorts, allGoods, company, economy, allWarehouses, allPassengers, allTraderPositions] = await Promise.all([
      timed("ships", () => fleetApi.getShips()).catch((e: Error) => { throw new Error(`getShips: ${e.message}`); }),
      timed("routes", () => worldApi.getRoutes()).catch((e: Error) => { throw new Error(`getRoutes: ${e.message}`); }),
      timed("shipTypes", () => worldApi.getShipTypes()).catch((e: Error) => { throw new Error(`getShipTypes: ${e.message}`); }),
      timed("ports", () => worldApi.getPorts()).catch((e: Error) => { throw new Error(`getPorts: ${e.message}`); }),
      timed("goods", () => worldApi.getGoods()).catch((e: Error) => { throw new Error(`getGoods: ${e.message}`); }),
      timed("company", () => companyApi.getCompany()).catch((e: Error) => { throw new Error(`getCompany: ${e.message}`); }),
      timed("economy", () => companyApi.getEconomy()).catch(() => ({ total_upkeep: 0 } as { total_upkeep: number })),
      timed("warehouses", () => warehousesApi.getWarehouses()).catch(() => [] as Warehouse[]),
      timed("passengers", () => passengersApi.getPassengers({ status: "available" })).catch(() => [] as Passenger[]),
      timed("traderPositions", () => tradeApi.getTraderPositions()).catch(() => []),
    ]);
    s = appendLog(s, `📦 all data fetched in ${((Date.now() - fetchStart) / 1000).toFixed(1)}s`);
    // Sort docked ships by ID for a stable window across cycles
    const dockedShips = ships.filter((sh: Ship) => sh.status !== "traveling").sort((a, b) => a.id.localeCompare(b.id));
    // Rolling window — clamp offset in case fleet size shrank since last cycle
    const windowOffset = dockedShips.length > 0 ? (s.shipWindowOffset ?? 0) % dockedShips.length : 0;
    const windowEnd = Math.min(windowOffset + SHIP_WINDOW_SIZE, dockedShips.length);
    const windowShips = dockedShips.slice(windowOffset, windowEnd);
    const nextWindowOffset = windowEnd >= dockedShips.length ? 0 : windowEnd;
    console.log(`[runCycle] ${ships.length} ships total, ${dockedShips.length} docked, window=${windowOffset}–${windowEnd - 1}, companyId=${companyId}`);
    console.log(`[runCycle:fetch] data ready in ${((Date.now() - fetchStart) / 1000).toFixed(1)}s`);

    const bankingCap = economy.total_upkeep + 2_000;
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
    const warehouseByPort = new Map<string, Warehouse>(allWarehouses.map((w: Warehouse) => [w.port_id, w]));
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
    // Tries order book buy orders first (better prices), then falls back to NPC sell.
    for (const [warehouseId, inventory] of warehouseInventory) {
      const warehouse = allWarehouses.find((w: Warehouse) => w.id === warehouseId);
      if (!warehouse) continue;
      for (const item of inventory) {
        if (item.quantity <= 0) continue;
        const priceLevel = npcMaxOrd.get(`${warehouse.port_id}:${item.good_id}`) ?? 0;
        if (priceLevel < MIN_SELL_PRICE_LEVEL) continue;

        const avgBuy = stockPrices.get(`${warehouseId}:${item.good_id}`) ?? 0;
        let remainingQty = item.quantity;
        let totalRevenue = 0;

        // ── 1. Fill order book buy orders first (may offer better prices) ─────
        try {
          const buyOrders = await marketApi.getOrders([warehouse.port_id], [item.good_id], "buy").catch(() => [] as MarketOrder[]);
          const openBuyOrders = buyOrders
            .filter((o) => o.status === "open" && o.remaining > 0)
            .sort((a, b) => b.price - a.price);
          for (const order of openBuyOrders) {
            if (remainingQty <= 0) break;
            const fillQty = Math.min(remainingQty, order.remaining);
            try {
              await marketApi.fillOrder(order.id, { quantity: fillQty });
              totalRevenue += fillQty * order.price;
              remainingQty -= fillQty;
              s = appendLog(s, `📒 Filled buy order ${fillQty}× ${goodNameFn(item.good_id)} @ £${order.price} (+£${Math.round(fillQty * order.price).toLocaleString()})`);
            } catch { /* order may have been filled/cancelled */ }
          }
        } catch { /* non-fatal */ }

        // ── 2. Sell remaining to NPC ───────────────────────────────────────────
        if (remainingQty > 0) {
          try {
            const sq = await tradeApi.createQuote({ port_id: warehouse.port_id, good_id: item.good_id, quantity: remainingQty, action: "sell" });
            await tradeApi.executeQuote({ token: sq.token, destinations: [{ type: "warehouse", id: warehouseId, quantity: remainingQty }] });
            totalRevenue += sq.unit_price * remainingQty;
            remainingQty = 0;
            s = appendLog(s, `🏭 NPC sold ${Math.round(sq.unit_price * (item.quantity - remainingQty))} worth of ${goodNameFn(item.good_id)} @ £${sq.unit_price}`);
          } catch (e: unknown) {
            if (totalRevenue === 0) {
              s = appendLog(s, `🏭 Warehouse sell failed (${goodNameFn(item.good_id)}) — ${(e as Error).message}`);
            }
          }
        }

        if (totalRevenue > 0) {
          const profit = totalRevenue - avgBuy * item.quantity;
          s.profitAccrued += profit;
          await removeWarehouseStock(companyId, warehouseId, item.good_id).catch(() => {});
          s = appendLog(s, `🏭 ${goodNameFn(item.good_id)}: total £${Math.round(totalRevenue).toLocaleString()} (+£${Math.round(profit).toLocaleString()} profit)`);
        }
      }
    }

    // ── Warehouse buy scan (opportunistic stockpiling) ────────────────────────
    // Tries order book sell orders first (may be cheaper), then falls back to NPC buy.
    for (const [warehouseId, inventory] of warehouseInventory) {
      const warehouse = allWarehouses.find((w: Warehouse) => w.id === warehouseId);
      if (!warehouse) continue;

      const stockedGoods = inventory.filter((i) => i.quantity > 0).map((i) => i.good_id);
      if (stockedGoods.length >= MAX_WAREHOUSE_GOODS) continue;

      // Collect candidate goods: NPC goods + any open sell orders at this port
      const candidateGoods = new Set(npcGoods.get(warehouse.port_id) ?? []);
      let orderBookSellOrders: MarketOrder[] = [];
      try {
        orderBookSellOrders = await marketApi.getOrders([warehouse.port_id], undefined, "sell").catch(() => [] as MarketOrder[]);
        for (const o of orderBookSellOrders) {
          if (o.status === "open" && o.remaining > 0) candidateGoods.add(o.good_id);
        }
      } catch { /* non-fatal */ }

      for (const goodId of candidateGoods) {
        if (stockedGoods.includes(goodId)) continue;

        const npcPriceOrd = npcMinOrd.get(`${warehouse.port_id}:${goodId}`) ?? 0;
        // Order book sell orders for this good (sorted cheapest first)
        const goodSellOrders = orderBookSellOrders
          .filter((o) => o.good_id === goodId && o.status === "open" && o.remaining > 0)
          .sort((a, b) => a.price - b.price);

        const existingQty = inventory.find((i) => i.good_id === goodId)?.quantity ?? 0;
        const toBuy = MAX_WAREHOUSE_STOCK - existingQty;
        if (toBuy <= 0) continue;

        // Decide: use order book if cheapest order price is below NPC buy level threshold
        const cheapestOrderPrice = goodSellOrders[0]?.price ?? Infinity;
        const useOrderBook = goodSellOrders.length > 0 && cheapestOrderPrice * toBuy <= availableFunds;
        const useNpc = npcPriceOrd > 0 && npcPriceOrd <= MAX_BUY_PRICE_LEVEL;

        if (!useOrderBook && !useNpc) continue;

        let boughtQty = 0;
        let totalCost = 0;

        if (useOrderBook) {
          // Fill sell orders (goods go to warehouse)
          let remaining = toBuy;
          for (const order of goodSellOrders) {
            if (remaining <= 0) break;
            if (order.price * remaining > availableFunds) break;
            const fillQty = Math.min(remaining, order.remaining);
            try {
              await marketApi.fillOrder(order.id, { quantity: fillQty });
              totalCost += fillQty * order.price;
              availableFunds -= fillQty * order.price;
              boughtQty += fillQty;
              remaining -= fillQty;
              s = appendLog(s, `📒 Filled sell order ${fillQty}× ${goodNameFn(goodId)} @ £${order.price}`);
            } catch { /* non-fatal */ }
          }
        }

        if (boughtQty === 0 && useNpc) {
          // Fallback: NPC buy
          try {
            const bq = await tradeApi.createQuote({ port_id: warehouse.port_id, good_id: goodId, quantity: toBuy, action: "buy" });
            if (bq.unit_price * toBuy > availableFunds) continue;
            await tradeApi.executeQuote({ token: bq.token, destinations: [{ type: "warehouse", id: warehouseId, quantity: toBuy }] });
            totalCost = bq.unit_price * toBuy;
            availableFunds -= totalCost;
            boughtQty = toBuy;
            s = appendLog(s, `🏭 Stocked ${toBuy}× ${goodNameFn(goodId)} @ £${bq.unit_price} (level ${npcPriceOrd})`);
          } catch (e: unknown) {
            s = appendLog(s, `🏭 Warehouse stock failed (${goodNameFn(goodId)}) — ${(e as Error).message}`);
          }
        }

        if (boughtQty > 0) {
          const avgPrice = totalCost / boughtQty;
          await upsertWarehouseStock(companyId, {
            warehouseId, portId: warehouse.port_id,
            goodId, goodName: goodNameFn(goodId), avgBuyPrice: avgPrice,
          }).catch(() => {});
          stockedGoods.push(goodId);
          if (stockedGoods.length >= MAX_WAREHOUSE_GOODS) break;
        }
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

    // ③ Pre-fetch inventories for the current window only (was all 490 — now just 50)
    const shipInventoryCache = new Map<string, Cargo[]>();
    {
      const toFetch = windowShips;
      const invResults = await Promise.all(
        toFetch.map(async (sh: Ship) => {
          try { return [sh.id, await fleetApi.getInventory(sh.id)] as const; }
          catch { return [sh.id, [] as Cargo[]] as const; }
        }),
      );
      for (const [id, inv] of invResults) shipInventoryCache.set(id, inv);
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

    // Inline inventory fetch helper — now just reads from the pre-populated cache
    const fetchShipInv = (shipId: string): Cargo[] => shipInventoryCache.get(shipId) ?? [];

    const shipLoopStart = Date.now();
    let shipsActioned = 0;

    // Pass 1: traveling ships — cheap metric tick over all ships (no API calls)
    for (const ship of ships) {
      if (ship.status !== "traveling") continue;
      const tss = s.ships[ship.id] ?? defaultShipState();
      const travelingShipType = stMap.get(ship.ship_type_id);
      const travelingRole: "ferry" | "multi" = FERRY_TYPE_PATTERN.test(travelingShipType?.name ?? "") ? "ferry" : "multi";
      s = { ...s, ships: { ...s.ships, [ship.id]: { ...tss, role: travelingRole, cyclesActive: tss.cyclesActive + 1, cyclesIdle: 0 } } };
    }

    // Pass 2: docked ships in the current window — full routing logic
    let windowIdx = 0;
    for (const ship of windowShips) {
      windowIdx++;
      if (windowIdx % 10 === 0) {
        console.log(`[runCycle:loop] ${windowIdx}/${windowShips.length} window ships, ${shipsActioned} actioned, ${((Date.now() - shipLoopStart) / 1000).toFixed(1)}s`);
      }
      if (!ship.port_id) continue;

      const ss = s.ships[ship.id] ?? defaultShipState();
      const shipType = stMap.get(ship.ship_type_id);
      const isFerry = FERRY_TYPE_PATTERN.test(shipType?.name ?? "");
      const role: "ferry" | "multi" = isFerry ? "ferry" : "multi";

      // Persist the role so the dashboard can display it
      if (ss.role !== role) {
        s = { ...s, ships: { ...s.ships, [ship.id]: { ...ss, role } } };
      }

      const capacity = Math.min(shipType?.capacity ?? 20, MAX_UNITS);

      // Actual remaining cargo space — prevents "Capacity exceeded" on buy
      const shipInv = fetchShipInv(ship.id);
      const usedCapacity = shipInv.reduce((sum, c) => sum + c.quantity, 0);
      const freeCapacity = Math.max(0, capacity - usedCapacity);

      // ══════════════════════════════════════════════════════════════════════════
      // IDLE — board passengers + scan for cargo, then dispatch
      // ══════════════════════════════════════════════════════════════════════════
      if (ss.phase === "idle") {
        await sleep(DOCK_DELAY_MS);
        shipsActioned++;

        // ── 0. Clear leftover cargo before buying/boarding ─────────────────────
        // A ship can end up idle-with-cargo after a failed sell or state reset.
        // Try to sell at current port; if that fails, dispatch to the best sell port.
        if (usedCapacity > 0) {
          let dispatched = false;
          for (const item of shipInv.filter((c) => c.quantity > 0)) {
            try {
              const sq = await tradeApi.createQuote({ port_id: ship.port_id, good_id: item.good_id, quantity: item.quantity, action: "sell" });
              await tradeApi.executeQuote({ token: sq.token, destinations: [{ type: "ship", id: ship.id, quantity: item.quantity }] });
              s.profitAccrued += sq.unit_price * item.quantity;
              s = appendLog(s, `${ship.name}: 🧹 cleared ${item.quantity}× ${goodNameFn(item.good_id)} @ £${sq.unit_price}`);
              shipInventoryCache.delete(ship.id); // invalidate so freeCapacity is recalculated if needed
            } catch {
              // Can't sell here — find best sell port and dispatch
              const sellPaths = getPathsFrom(ship.port_id);
              const bestSellPath = sellPaths
                .filter((sp) => (npcMaxOrd.get(`${sp.destPortId}:${item.good_id}`) ?? 0) >= MIN_SELL_PRICE_LEVEL)
                .sort((a, b) => (npcMaxOrd.get(`${b.destPortId}:${item.good_id}`) ?? 0) - (npcMaxOrd.get(`${a.destPortId}:${item.good_id}`) ?? 0))[0];
              if (bestSellPath && bestSellPath.legs.length > 0) {
                const plan: ShipPlan = {
                  goodId: item.good_id, goodName: goodNameFn(item.good_id),
                  quantity: item.quantity, actualBuyPrice: 0,
                  sellPortId: bestSellPath.destPortId, legs: bestSellPath.legs.slice(1),
                };
                const ssBeforeDispatch = ss;
                s = { ...s, ships: { ...s.ships, [ship.id]: { ...ss, phase: "transiting_to_sell", plan, cyclesIdle: 0, cyclesActive: ss.cyclesActive + 1 } } };
                s = appendLog(s, `${ship.name}: → ${portName(bestSellPath.destPortId)} to sell leftover ${item.quantity}× ${goodNameFn(item.good_id)}`);
                await dispatchTransit(ship.id, bestSellPath.legs[0].routeId, (msg) => {
                  s = { ...s, ships: { ...s.ships, [ship.id]: ssBeforeDispatch } };
                  s = appendLog(s, `${ship.name}: leftover dispatch failed — ${msg}`);
                });
                dispatched = true;
              } else {
                s = appendLog(s, `${ship.name}: ⚠️ stuck with ${item.quantity}× ${goodNameFn(item.good_id)} — no sell route`);
              }
              if (dispatched) break;
            }
          }
          if (dispatched) continue;
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
              s.profitAccrued += p.bid; // accrue at boarding — delivery is automatic
              s = appendLog(s, `${ship.name}: 🧳 boarded ${p.count} pax → ${portName(p.destination_port_id)} (£${p.bid})`);
              break;
            } catch (e: unknown) {
              s = appendLog(s, `${ship.name}: pax board failed — ${(e as Error).message}`);
            }
          }
        }

        // ── 2. Scan for best cargo (multi-purpose ships only) ─────────────────
        let bestCargo: (ScoredCandidate & { buyPrice: number }) | null = null;

        if (!isFerry) {
          // Use pre-computed candidates for this port; apply per-ship pax filter below
          const allCandidates = candidatesByPort.get(ship.port_id) ?? [];

          // If pax were boarded: filter to cargo co-routable to the same destination
          // (buy at current port, sell at pax destination = no extra detour)
          const candidates = boardedPaxDestination
            ? allCandidates.filter(
                (c) => c.sellPortId === boardedPaxDestination && c.buyPortId === ship.port_id,
              )
            : allCandidates;

          const sellBatch = dedupBestPerGood(candidates, SCAN_BATCH);

          if (sellBatch.length > 0) {
            let batchItems: Awaited<ReturnType<typeof tradeApi.batchCreateQuotes>> = [];
            try {
              batchItems = await tradeApi.batchCreateQuotes({
                requests: sellBatch.map((c) => ({
                  port_id: c.sellPortId, good_id: c.goodId, quantity: capacity, action: "sell" as const,
                })),
              });
            } catch { /* proceed with empty */ }

            const scored: ScoredCandidate[] = sellBatch
              .map((c, i) => {
                const item = batchItems[i];
                if (!item || item.status !== "success" || !item.quote) return null;
                return { ...c, npcSellPrice: item.quote.unit_price };
              })
              .filter(Boolean) as ScoredCandidate[];

            for (const c of scored.sort((a, b) => b.npcSellPrice - a.npcSellPrice)) {
              try {
                const bq = await tradeApi.createQuote({ port_id: c.buyPortId, good_id: c.goodId, quantity: capacity, action: "buy" });
                const margin = (c.npcSellPrice - bq.unit_price) / bq.unit_price;
                if (margin >= MIN_MARGIN) { bestCargo = { ...c, buyPrice: bq.unit_price }; break; }
              } catch { /* try next */ }
            }
          }
        }

        // ── 3. Decide and dispatch ─────────────────────────────────────────────

        if (boardedPaxDestination) {
          // Passengers boarded — MUST go to their destination
          const destPath = paths.find((p) => p.destPortId === boardedPaxDestination);
          if (!destPath || destPath.legs.length === 0) {
            s = appendLog(s, `${ship.name}: ⚠️ no route to pax destination ${portName(boardedPaxDestination)} — resetting`);
            s = { ...s, ships: { ...s.ships, [ship.id]: { ...ss, phase: "idle" } } };
            continue;
          }

          // Buy cargo to the same destination if available and affordable
          let cargoGoodId: string | undefined;
          let cargoGoodName: string | undefined;
          let cargoQty = 0;
          let cargoBuyPrice = 0;
          let cargoSellPrice: number | undefined;

          if (bestCargo && availableFunds > 0 && freeCapacity > 0) {
            try {
              const bq = await tradeApi.createQuote({ port_id: ship.port_id, good_id: bestCargo.goodId, quantity: freeCapacity, action: "buy" });
              const affordable = Math.floor(availableFunds / bq.unit_price);
              const buyQty = Math.min(freeCapacity, affordable);
              if (buyQty > 0) {
                const eq = buyQty < freeCapacity
                  ? await tradeApi.createQuote({ port_id: ship.port_id, good_id: bestCargo.goodId, quantity: buyQty, action: "buy" })
                  : bq;
                await tradeApi.executeQuote({ token: eq.token, destinations: [{ type: "ship", id: ship.id, quantity: buyQty }] });
                availableFunds -= buyQty * eq.unit_price;
                cargoGoodId    = bestCargo.goodId;
                cargoGoodName  = goodNameFn(bestCargo.goodId);
                cargoQty       = buyQty;
                cargoBuyPrice  = eq.unit_price;
                cargoSellPrice = bestCargo.npcSellPrice;
                s = appendLog(s, `${ship.name}: 📦 bought ${buyQty}× ${cargoGoodName} @ £${eq.unit_price} (co-routing with pax)`);
              }
            } catch (e: unknown) {
              s = appendLog(s, `${ship.name}: co-route cargo buy failed — ${(e as Error).message}`);
            }
          }

          const plan: ShipPlan = {
            sellPortId: boardedPaxDestination,
            legs: destPath.legs.slice(1),
            passengerBid: boardedPaxBid,
            ...(cargoQty > 0 ? { goodId: cargoGoodId, goodName: cargoGoodName, quantity: cargoQty, actualBuyPrice: cargoBuyPrice, sellPrice: cargoSellPrice } : {}),
          };

          const ssBeforePaxDispatch = ss;
          s = { ...s, ships: { ...s.ships, [ship.id]: { ...ss, phase: "transiting_to_sell", plan, cyclesIdle: 0, cyclesActive: ss.cyclesActive + 1 } } };
          s = appendLog(s, `${ship.name}: → ${portName(boardedPaxDestination)} (pax £${boardedPaxBid}${cargoQty > 0 ? ` + ${cargoQty}× ${cargoGoodName}` : ""})`);
          await dispatchTransit(ship.id, destPath.legs[0].routeId, (msg) => {
            s = { ...s, ships: { ...s.ships, [ship.id]: ssBeforePaxDispatch } };
            s = appendLog(s, `${ship.name}: pax dispatch failed — ${msg}`);
          });

        } else if (bestCargo) {
          // No passengers — execute best cargo trade

          if (bestCargo.buyPortId === ship.port_id) {
            // ── Local buy: purchase here, head to sell port ──────────────────
            const destPath = paths.find((p) => p.destPortId === bestCargo.sellPortId);
            if (!destPath || destPath.legs.length === 0) {
              s = appendLog(s, `${ship.name}: no route to sell port ${portName(bestCargo.sellPortId)}`);
              continue;
            }
            try {
              const bq = await tradeApi.createQuote({ port_id: ship.port_id, good_id: bestCargo.goodId, quantity: freeCapacity, action: "buy" });
              const affordable = Math.floor(availableFunds / bq.unit_price);
              const buyQty = Math.min(freeCapacity, affordable);
              if (buyQty <= 0) {
                s = appendLog(s, `${ship.name}: insufficient funds for ${goodNameFn(bestCargo.goodId)}`);
                continue;
              }
              const eq = buyQty < freeCapacity
                ? await tradeApi.createQuote({ port_id: ship.port_id, good_id: bestCargo.goodId, quantity: buyQty, action: "buy" })
                : bq;
              await tradeApi.executeQuote({ token: eq.token, destinations: [{ type: "ship", id: ship.id, quantity: buyQty }] });
              availableFunds -= buyQty * eq.unit_price;

              const plan: ShipPlan = {
                goodId: bestCargo.goodId, goodName: goodNameFn(bestCargo.goodId),
                quantity: buyQty, actualBuyPrice: eq.unit_price, sellPrice: bestCargo.npcSellPrice,
                sellPortId: bestCargo.sellPortId, legs: destPath.legs.slice(1),
              };
              const ssBeforeLocalDispatch = ss;
              s = { ...s, ships: { ...s.ships, [ship.id]: { ...ss, phase: "transiting_to_sell", plan, cyclesIdle: 0, cyclesActive: ss.cyclesActive + 1 } } };
              s = appendLog(s, `${ship.name}: 📦 ${buyQty}× ${plan.goodName} → ${portName(bestCargo.sellPortId)} (£${eq.unit_price}→£${bestCargo.npcSellPrice}, ${((bestCargo.npcSellPrice - eq.unit_price) / eq.unit_price * 100).toFixed(1)}%)`);
              await dispatchTransit(ship.id, destPath.legs[0].routeId, (msg) => {
                s = { ...s, ships: { ...s.ships, [ship.id]: ssBeforeLocalDispatch } };
                s = appendLog(s, `${ship.name}: local buy failed — ${msg}`);
              });
            } catch (e: unknown) {
              s = appendLog(s, `${ship.name}: local buy failed — ${(e as Error).message}`);
            }

          } else {
            // ── Remote buy: head to buy port first ───────────────────────────
            const toBuyPath = paths.find((p) => p.destPortId === bestCargo.buyPortId);
            if (!toBuyPath || toBuyPath.legs.length === 0) {
              s = appendLog(s, `${ship.name}: no route to buy port ${portName(bestCargo.buyPortId)}`);
              continue;
            }
            const plan: ShipPlan = {
              goodId: bestCargo.goodId, goodName: goodNameFn(bestCargo.goodId),
              quantity: 0, actualBuyPrice: 0,
              buyPortId: bestCargo.buyPortId,
              sellPortId: bestCargo.sellPortId, sellPrice: bestCargo.npcSellPrice,
              sellLegs: bestCargo.sellLegs,
              legs: toBuyPath.legs.slice(1),
            };
            const ssBeforeRemoteDispatch = ss;
            s = { ...s, ships: { ...s.ships, [ship.id]: { ...ss, phase: "transiting_to_buy", plan, cyclesIdle: 0, cyclesActive: ss.cyclesActive + 1 } } };
            s = appendLog(s, `${ship.name}: → ${portName(bestCargo.buyPortId)} to buy ${goodNameFn(bestCargo.goodId)}`);
            await dispatchTransit(ship.id, toBuyPath.legs[0].routeId, (msg) => {
              s = { ...s, ships: { ...s.ships, [ship.id]: ssBeforeRemoteDispatch } };
              s = appendLog(s, `${ship.name}: remote dispatch failed — ${msg}`);
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

            // Group valid passengers by origin port, compute total bid per port.
            // Filter out passengers this ship cannot reach before they expire.
            const portBids = new Map<string, { total: number; best: Passenger }>();
            for (const p of allPassengers) {
              const path = paxPaths.find((pa) => pa.destPortId === p.origin_port_id);
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
                const path = paxPaths.find((pa) => pa.destPortId === portId)!;
                const coverageBonus = coveredPorts.has(portId) ? 1 : 2;
                return { portId, path, best, totalBid: total, score: (total / path.totalDistance) * coverageBonus };
              })
              .sort((a, b) => b.score - a.score);

            const bestPort = portCandidates[0];
            if (bestPort) {
              const ssBeforePaxChase = ss;
              s = { ...s, ships: { ...s.ships, [ship.id]: { ...ss, phase: "transiting_to_buy", plan: {
                goodId: "", goodName: "",
                quantity: 0, actualBuyPrice: 0,
                buyPortId: bestPort.portId,
                sellPortId: bestPort.best.destination_port_id, sellPrice: 0,
                sellLegs: [], legs: bestPort.path.legs.slice(1),
                passengerBid: bestPort.totalBid,
              }, cyclesIdle: 0, cyclesActive: ss.cyclesActive + 1 } } };
              const covTag = coveredPorts.has(bestPort.portId) ? "" : " (uncovered)";
              const etaSec = Math.round(travelTimeMs(bestPort.path.totalDistance, speed) / 1000);
              s = appendLog(s, `${ship.name}: 🧳 → ${portName(bestPort.portId)}${covTag} (£${bestPort.totalBid} pax, ETA ~${etaSec}s)`);
              coveredPorts.add(bestPort.portId); // incremental update — prevents next ship choosing same port
              await dispatchTransit(ship.id, bestPort.path.legs[0].routeId, (msg) => {
                s = { ...s, ships: { ...s.ships, [ship.id]: ssBeforePaxChase } };
                s = appendLog(s, `${ship.name}: pax-chase dispatch failed — ${msg}`);
              });
              chasedPax = true;
            }
          }

          if (!chasedPax) {
            if (isFerry) {
              s = appendLog(s, `${ship.name}: ⚓ covering ${portName(ship.port_id)}`);
              s = { ...s, ships: { ...s.ships, [ship.id]: { ...ss, cyclesActive: ss.cyclesActive + 1 } } };
            } else {
              s = appendLog(s, `${ship.name}: idle at ${portName(ship.port_id)} — no opportunity`);
              s = { ...s, ships: { ...s.ships, [ship.id]: { ...ss, cyclesIdle: ss.cyclesIdle + 1, cyclesActive: ss.cyclesActive + 1 } } };
            }
          }
        }

      // ══════════════════════════════════════════════════════════════════════════
      // TRANSITING_TO_BUY — advance waypoints; buy and dispatch on arrival
      // ══════════════════════════════════════════════════════════════════════════
      } else if (ss.phase === "transiting_to_buy") {
        const plan = ss.plan!;

        // Advance waypoint if not yet at buy port
        if (plan.legs.length > 0 && ship.port_id !== plan.buyPortId) {
          const ssBeforeWaypoint = ss;
          s = { ...s, ships: { ...s.ships, [ship.id]: { ...ss, plan: { ...plan, legs: plan.legs.slice(1) } } } };
          s = appendLog(s, `${ship.name}: waypoint → ${portName(plan.legs[0].toPortId)}`);
          await dispatchTransit(ship.id, plan.legs[0].routeId, (msg) => {
            s = { ...s, ships: { ...s.ships, [ship.id]: ssBeforeWaypoint } };
            s = appendLog(s, `${ship.name}: waypoint failed — ${msg}`);
          });
          continue;
        }

        if (ship.port_id !== plan.buyPortId) {
          s = appendLog(s, `${ship.name}: ⚠️ lost in transit (expected ${portName(plan.buyPortId)}) — resetting`);
          s = { ...s, ships: { ...s.ships, [ship.id]: { ...ss, phase: "idle" } } };
          continue;
        }

        // Arrived at buy port
        await sleep(DOCK_DELAY_MS);

        // Passenger-chase: arrived at origin port — reset to idle so the passenger
        // boarding logic in the idle branch picks them up this cycle.
        if (!plan.goodId) {
          s = appendLog(s, `${ship.name}: arrived at ${portName(ship.port_id)} to board pax`);
          s = { ...s, ships: { ...s.ships, [ship.id]: { ...ss, phase: "idle" } } };
          continue;
        }

        let boughtQty = 0;
        let actualBuyPrice = 0;

        if (availableFunds > 0 && freeCapacity > 0) {
          try {
            const bq = await tradeApi.createQuote({ port_id: ship.port_id, good_id: plan.goodId!, quantity: freeCapacity, action: "buy" });
            const affordable = Math.floor(availableFunds / bq.unit_price);
            const buyQty = Math.min(freeCapacity, affordable);
            if (buyQty > 0) {
              const eq = buyQty < freeCapacity
                ? await tradeApi.createQuote({ port_id: ship.port_id, good_id: plan.goodId!, quantity: buyQty, action: "buy" })
                : bq;
              await tradeApi.executeQuote({ token: eq.token, destinations: [{ type: "ship", id: ship.id, quantity: buyQty }] });
              availableFunds -= buyQty * eq.unit_price;
              boughtQty = buyQty;
              actualBuyPrice = eq.unit_price;
              s = appendLog(s, `${ship.name}: bought ${buyQty}× ${plan.goodName} @ £${eq.unit_price} at ${portName(ship.port_id)}`);
            }
          } catch (e: unknown) {
            s = appendLog(s, `${ship.name}: buy failed at ${portName(ship.port_id)} — ${(e as Error).message}`);
          }
        }

        if (boughtQty === 0) {
          s = appendLog(s, `${ship.name}: nothing bought at ${portName(ship.port_id)} — resetting`);
          s = { ...s, ships: { ...s.ships, [ship.id]: { ...ss, phase: "idle" } } };
          continue;
        }

        // Dispatch to sell port (use pre-computed sellLegs, or find path if needed)
        const sellLegs = plan.sellLegs ?? [];
        if (sellLegs.length > 0) {
          const ssBeforeSellLegs = ss;
          s = { ...s, ships: { ...s.ships, [ship.id]: { ...ss, phase: "transiting_to_sell", plan: { ...plan, quantity: boughtQty, actualBuyPrice, legs: sellLegs.slice(1) }, cyclesIdle: 0 } } };
          s = appendLog(s, `${ship.name}: → ${portName(plan.sellPortId)} to sell ${boughtQty}× ${plan.goodName}`);
          await dispatchTransit(ship.id, sellLegs[0].routeId, (msg) => {
            s = { ...s, ships: { ...s.ships, [ship.id]: { ...ssBeforeSellLegs, phase: "idle" } } };
            s = appendLog(s, `${ship.name}: sell dispatch failed — ${msg}`);
          });
        } else {
          // Rare: sellLegs was empty (same port buy/sell?), re-find path
          const sellPaths = getPathsFrom(ship.port_id);
          const toSell = sellPaths.find((p) => p.destPortId === plan.sellPortId);
          if (!toSell || toSell.legs.length === 0) {
            s = appendLog(s, `${ship.name}: ⚠️ no sell route from ${portName(ship.port_id)} — resetting`);
            s = { ...s, ships: { ...s.ships, [ship.id]: { ...ss, phase: "idle" } } };
            continue;
          }
          const ssBeforeAltSell = ss;
          s = { ...s, ships: { ...s.ships, [ship.id]: { ...ss, phase: "transiting_to_sell", plan: { ...plan, quantity: boughtQty, actualBuyPrice, legs: toSell.legs.slice(1) }, cyclesIdle: 0 } } };
          s = appendLog(s, `${ship.name}: → ${portName(plan.sellPortId)} to sell ${boughtQty}× ${plan.goodName}`);
          await dispatchTransit(ship.id, toSell.legs[0].routeId, (msg) => {
            s = { ...s, ships: { ...s.ships, [ship.id]: { ...ssBeforeAltSell, phase: "idle" } } };
            s = appendLog(s, `${ship.name}: sell dispatch failed — ${msg}`);
          });
        }

      // ══════════════════════════════════════════════════════════════════════════
      // TRANSITING_TO_SELL — advance waypoints; sell cargo on arrival, then idle
      // ══════════════════════════════════════════════════════════════════════════
      } else if (ss.phase === "transiting_to_sell") {
        const plan = ss.plan!;

        // Advance waypoint
        if (plan.legs.length > 0 && ship.port_id !== plan.sellPortId) {
          const ssBeforeWaypoint = ss;
          s = { ...s, ships: { ...s.ships, [ship.id]: { ...ss, plan: { ...plan, legs: plan.legs.slice(1) } } } };
          s = appendLog(s, `${ship.name}: waypoint → ${portName(plan.legs[0].toPortId)}`);
          await dispatchTransit(ship.id, plan.legs[0].routeId, (msg) => {
            s = { ...s, ships: { ...s.ships, [ship.id]: ssBeforeWaypoint } };
            s = appendLog(s, `${ship.name}: waypoint failed — ${msg}`);
          });
          continue;
        }

        if (ship.port_id !== plan.sellPortId) {
          s = appendLog(s, `${ship.name}: ⚠️ at ${portName(ship.port_id)}, expected ${portName(plan.sellPortId)} — resetting`);
          s = { ...s, ships: { ...s.ships, [ship.id]: { ...ss, phase: "idle" } } };
          continue;
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
              s.profitAccrued += profit;
              const updSs = s.ships[ship.id] ?? defaultShipState();
              s = { ...s, ships: { ...s.ships, [ship.id]: { ...updSs, cargoTrips: updSs.cargoTrips + 1, lifetimeProfit: updSs.lifetimeProfit + profit } } };
              s = appendLog(s, `${ship.name}: sold ${sellQty}× ${plan.goodName} @ £${sq.unit_price} (+£${Math.round(profit).toLocaleString()})`);
              sold = true;
            } catch (e: unknown) {
              s = appendLog(s, `${ship.name}: NPC sell failed — ${(e as Error).message}`);
            }

            if (!sold) {
              try {
                const askPrice = Math.round((plan.actualBuyPrice ?? 0) * 1.15);
                await marketApi.createOrder({ port_id: ship.port_id, good_id: plan.goodId, total: sellQty, price: askPrice, side: "sell" });
                s = appendLog(s, `${ship.name}: posted sell order ${sellQty}× @ £${askPrice}`);
              } catch (e2: unknown) {
                s = appendLog(s, `${ship.name}: market order also failed — ${(e2 as Error).message}`);
              }
            }
          } else if ((plan.quantity ?? 0) > 0) {
            s = appendLog(s, `${ship.name}: ⚠️ cargo gone (${plan.goodName}) — skipping sell`);
          }
        }

        if (plan.passengerBid) {
          const paxSs = s.ships[ship.id] ?? defaultShipState();
          s = { ...s, ships: { ...s.ships, [ship.id]: { ...paxSs, paxTrips: paxSs.paxTrips + 1, lifetimeProfit: paxSs.lifetimeProfit + plan.passengerBid } } };
          s = appendLog(s, `${ship.name}: 🧳 pax delivered to ${portName(ship.port_id)} (+£${plan.passengerBid} at boarding)`);
        }

        // Back to idle — will re-scan next cycle
        s = { ...s, ships: { ...s.ships, [ship.id]: { ...(s.ships[ship.id] ?? defaultShipState()), phase: "idle", cyclesIdle: 0 } } };
      }
    }

    s = appendLog(s, `🚢 window ${windowOffset}–${windowEnd - 1}/${dockedShips.length} — ${shipsActioned} ships in ${((Date.now() - shipLoopStart) / 1000).toFixed(1)}s`);
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

  console.log(`[runCycle:done] cycle complete in ${((Date.now() - cycleT0) / 1000).toFixed(1)}s`);
  return s;
}