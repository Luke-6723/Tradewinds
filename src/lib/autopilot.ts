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

import type { Good, Port, Route, Ship, ShipType, Warehouse, WarehouseInventory } from "@/lib/types";
import type { Passenger } from "@/lib/types";
import { companyApi } from "@/lib/api/company";
import { fleetApi } from "@/lib/api/fleet";
import { marketApi } from "@/lib/api/market";
import { passengersApi } from "@/lib/api/passengers";
import { tradeApi } from "@/lib/api/trade";
import { warehousesApi } from "@/lib/api/warehouses";
import { worldApi } from "@/lib/api/world";
import { appendLog, type AutopilotState, type RouteLeg, type ShipPlan } from "@/lib/autopilot-types";
import { getWarehouseStocks, removeWarehouseStock } from "@/lib/db/collections";

export * from "@/lib/autopilot-types";

// ── Config ─────────────────────────────────────────────────────────────────────

const MIN_MARGIN   = 0.01;  // 1% minimum margin to accept a cargo trade
const MAX_UNITS    = 50;
/** Sell-quote batch size per ship scan. */
const SCAN_BATCH   = 16;
/** Delay (ms) after docking before buying/selling (lets server process the dock). */
const DOCK_DELAY_MS = 5_000;
/** Price level at or above which we sell from warehouse (Expensive = 4). */
const MIN_SELL_PRICE_LEVEL = 4;

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

function findPaths(fromPortId: string, allRoutes: Route[], maxHops: number): Path[] {
  const results: Path[] = [];
  const visited = new Set<string>([fromPortId]);
  const queue: Array<{ portId: string; legs: RouteLeg[]; dist: number }> = [
    { portId: fromPortId, legs: [], dist: 0 },
  ];
  while (queue.length > 0) {
    const { portId, legs, dist } = queue.shift()!;
    if (legs.length >= maxHops) continue;
    for (const r of allRoutes.filter((r) => r.from_id === portId)) {
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

// ── Cycle ──────────────────────────────────────────────────────────────────────

export async function runCycle(s: AutopilotState, companyId: string): Promise<AutopilotState> {
  s = { ...s, lastCycleAt: new Date().toISOString() };

  try {
    const [ships, allRoutes, shipTypes, allPorts, allGoods, company, economy, allWarehouses, allPassengers, allTraderPositions] = await Promise.all([
      fleetApi.getShips().catch((e: Error) => { throw new Error(`getShips: ${e.message}`); }),
      worldApi.getRoutes().catch((e: Error) => { throw new Error(`getRoutes: ${e.message}`); }),
      worldApi.getShipTypes().catch((e: Error) => { throw new Error(`getShipTypes: ${e.message}`); }),
      worldApi.getPorts().catch((e: Error) => { throw new Error(`getPorts: ${e.message}`); }),
      worldApi.getGoods().catch((e: Error) => { throw new Error(`getGoods: ${e.message}`); }),
      companyApi.getCompany().catch((e: Error) => { throw new Error(`getCompany: ${e.message}`); }),
      companyApi.getEconomy().catch(() => ({ total_upkeep: 0 } as { total_upkeep: number })),
      warehousesApi.getWarehouses().catch(() => [] as Warehouse[]),
      passengersApi.getPassengers({ status: "available" }).catch(() => [] as Passenger[]),
      tradeApi.getTraderPositions().catch(() => []),  // Single call — no per-port loop
    ]);

    const bankingCap = economy.total_upkeep + 2_000;
    let availableFunds = Math.max(0, company.treasury - bankingCap);

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
    await Promise.all(
      allWarehouses.map(async (w: Warehouse) => {
        try { warehouseInventory.set(w.id, await warehousesApi.getInventory(w.id)); }
        catch  { warehouseInventory.set(w.id, []); }
      }),
    );

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
    for (const [warehouseId, inventory] of warehouseInventory) {
      const warehouse = allWarehouses.find((w: Warehouse) => w.id === warehouseId);
      if (!warehouse) continue;
      for (const item of inventory) {
        if (item.quantity <= 0) continue;
        const priceLevel = npcMaxOrd.get(`${warehouse.port_id}:${item.good_id}`) ?? 0;
        if (priceLevel < MIN_SELL_PRICE_LEVEL) continue;
        try {
          const sq = await tradeApi.createQuote({ port_id: warehouse.port_id, good_id: item.good_id, quantity: item.quantity, action: "sell" });
          await tradeApi.executeQuote({ token: sq.token, destinations: [{ type: "warehouse", id: warehouseId, quantity: item.quantity }] });
          const avgBuy = stockPrices.get(`${warehouseId}:${item.good_id}`) ?? 0;
          const profit = (sq.unit_price - avgBuy) * item.quantity;
          s.profitAccrued += profit;
          await removeWarehouseStock(companyId, warehouseId, item.good_id).catch(() => {});
          s = appendLog(s, `🏭 Sold ${item.quantity}× ${goodNameFn(item.good_id)} from warehouse @ £${sq.unit_price} (+£${Math.round(profit).toLocaleString()})`);
        } catch (e: unknown) {
          s = appendLog(s, `🏭 Warehouse sell failed (${goodNameFn(item.good_id)}) — ${(e as Error).message}`);
        }
      }
    }

    // ── Per-ship independent routing ───────────────────────────────────────────

    for (const ship of ships) {
      if (ship.status === "traveling") continue;
      if (!ship.port_id) continue;

      const ss = s.ships[ship.id] ?? { phase: "idle" as const };
      const shipType = stMap.get(ship.ship_type_id);
      const capacity = Math.min(shipType?.capacity ?? 20, MAX_UNITS);

      // ══════════════════════════════════════════════════════════════════════════
      // IDLE — board passengers + scan for cargo, then dispatch
      // ══════════════════════════════════════════════════════════════════════════
      if (ss.phase === "idle") {
        await sleep(DOCK_DELAY_MS);

        const paths = findPaths(ship.port_id, allRoutes, 99);

        // ── 1. Board best passenger at current port (always — pure profit) ─────
        const paxHere = allPassengers.filter((p) =>
          p.origin_port_id === ship.port_id && new Date(p.expires_at) > new Date(),
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
              s = appendLog(s, `${ship.name}: 🧳 boarded ${p.count} pax → ${portName(p.destination_port_id)} (£${p.bid})`);
              break;
            } catch (e: unknown) {
              s = appendLog(s, `${ship.name}: pax board failed — ${(e as Error).message}`);
            }
          }
        }

        // ── 2. Scan for best cargo ─────────────────────────────────────────────
        // If passengers boarded, only consider cargo destined to the SAME port.
        // Otherwise scan all possible routes.
        const allCandidates: RawCandidate[] = [];

        for (const buyPortId of npcGoods.keys()) {
          const buyGoods = npcGoods.get(buyPortId)!;
          const toBuyPath = buyPortId === ship.port_id
            ? null
            : paths.find((p) => p.destPortId === buyPortId);
          if (buyPortId !== ship.port_id && !toBuyPath) continue;
          const toBuyDist = toBuyPath?.totalDistance ?? 0;
          const toLegsBuy = toBuyPath?.legs ?? [];

          const sellPaths = findPaths(buyPortId, allRoutes, 99);
          for (const sp of sellPaths) {
            const destGoods = npcGoods.get(sp.destPortId);
            if (!destGoods) continue;
            for (const goodId of buyGoods) {
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

        // If pax were boarded: filter to cargo co-routable to the same destination
        // (buy at current port, sell at pax destination = no extra detour)
        const candidates = boardedPaxDestination
          ? allCandidates.filter(
              (c) => c.sellPortId === boardedPaxDestination && c.buyPortId === ship.port_id,
            )
          : allCandidates;

        const sellBatch = dedupBestPerGood(candidates, SCAN_BATCH);
        let bestCargo: (ScoredCandidate & { buyPrice: number }) | null = null;

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

        // ── 3. Decide and dispatch ─────────────────────────────────────────────

        if (boardedPaxDestination) {
          // Passengers boarded — MUST go to their destination
          const destPath = paths.find((p) => p.destPortId === boardedPaxDestination);
          if (!destPath || destPath.legs.length === 0) {
            s = appendLog(s, `${ship.name}: ⚠️ no route to pax destination ${portName(boardedPaxDestination)} — resetting`);
            s = { ...s, ships: { ...s.ships, [ship.id]: { phase: "idle" } } };
            continue;
          }

          // Buy cargo to the same destination if available and affordable
          let cargoGoodId: string | undefined;
          let cargoGoodName: string | undefined;
          let cargoQty = 0;
          let cargoBuyPrice = 0;
          let cargoSellPrice: number | undefined;

          if (bestCargo && availableFunds > 0) {
            try {
              const bq = await tradeApi.createQuote({ port_id: ship.port_id, good_id: bestCargo.goodId, quantity: capacity, action: "buy" });
              const affordable = Math.floor(availableFunds / bq.unit_price);
              const buyQty = Math.min(capacity, affordable);
              if (buyQty > 0) {
                const eq = buyQty < capacity
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

          try {
            await fleetApi.transit(ship.id, { route_id: destPath.legs[0].routeId });
            s = { ...s, ships: { ...s.ships, [ship.id]: { phase: "transiting_to_sell", plan } } };
            s = appendLog(s, `${ship.name}: → ${portName(boardedPaxDestination)} (pax £${boardedPaxBid}${cargoQty > 0 ? ` + ${cargoQty}× ${cargoGoodName}` : ""})`);
          } catch (e: unknown) {
            s = appendLog(s, `${ship.name}: pax dispatch failed — ${(e as Error).message}`);
          }

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
              const bq = await tradeApi.createQuote({ port_id: ship.port_id, good_id: bestCargo.goodId, quantity: capacity, action: "buy" });
              const affordable = Math.floor(availableFunds / bq.unit_price);
              const buyQty = Math.min(capacity, affordable);
              if (buyQty <= 0) {
                s = appendLog(s, `${ship.name}: insufficient funds for ${goodNameFn(bestCargo.goodId)}`);
                continue;
              }
              const eq = buyQty < capacity
                ? await tradeApi.createQuote({ port_id: ship.port_id, good_id: bestCargo.goodId, quantity: buyQty, action: "buy" })
                : bq;
              await tradeApi.executeQuote({ token: eq.token, destinations: [{ type: "ship", id: ship.id, quantity: buyQty }] });
              availableFunds -= buyQty * eq.unit_price;

              const plan: ShipPlan = {
                goodId: bestCargo.goodId, goodName: goodNameFn(bestCargo.goodId),
                quantity: buyQty, actualBuyPrice: eq.unit_price, sellPrice: bestCargo.npcSellPrice,
                sellPortId: bestCargo.sellPortId, legs: destPath.legs.slice(1),
              };
              await fleetApi.transit(ship.id, { route_id: destPath.legs[0].routeId });
              s = { ...s, ships: { ...s.ships, [ship.id]: { phase: "transiting_to_sell", plan } } };
              s = appendLog(s, `${ship.name}: 📦 ${buyQty}× ${plan.goodName} → ${portName(bestCargo.sellPortId)} (£${eq.unit_price}→£${bestCargo.npcSellPrice}, ${((bestCargo.npcSellPrice - eq.unit_price) / eq.unit_price * 100).toFixed(1)}%)`);
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
            try {
              await fleetApi.transit(ship.id, { route_id: toBuyPath.legs[0].routeId });
              s = { ...s, ships: { ...s.ships, [ship.id]: { phase: "transiting_to_buy", plan } } };
              s = appendLog(s, `${ship.name}: → ${portName(bestCargo.buyPortId)} to buy ${goodNameFn(bestCargo.goodId)}`);
            } catch (e: unknown) {
              s = appendLog(s, `${ship.name}: remote dispatch failed — ${(e as Error).message}`);
            }
          }

        } else {
          s = appendLog(s, `${ship.name}: idle at ${portName(ship.port_id)} — no opportunity`);
        }

      // ══════════════════════════════════════════════════════════════════════════
      // TRANSITING_TO_BUY — advance waypoints; buy and dispatch on arrival
      // ══════════════════════════════════════════════════════════════════════════
      } else if (ss.phase === "transiting_to_buy") {
        const plan = ss.plan!;

        // Advance waypoint if not yet at buy port
        if (plan.legs.length > 0 && ship.port_id !== plan.buyPortId) {
          try {
            await fleetApi.transit(ship.id, { route_id: plan.legs[0].routeId });
            s = { ...s, ships: { ...s.ships, [ship.id]: { ...ss, plan: { ...plan, legs: plan.legs.slice(1) } } } };
            s = appendLog(s, `${ship.name}: waypoint → ${portName(plan.legs[0].toPortId)}`);
          } catch (e: unknown) {
            s = appendLog(s, `${ship.name}: waypoint failed — ${(e as Error).message}`);
          }
          continue;
        }

        if (ship.port_id !== plan.buyPortId) {
          s = appendLog(s, `${ship.name}: ⚠️ lost in transit (expected ${portName(plan.buyPortId)}) — resetting`);
          s = { ...s, ships: { ...s.ships, [ship.id]: { phase: "idle" } } };
          continue;
        }

        // Arrived at buy port
        await sleep(DOCK_DELAY_MS);

        let boughtQty = 0;
        let actualBuyPrice = 0;

        if (availableFunds > 0) {
          try {
            const bq = await tradeApi.createQuote({ port_id: ship.port_id, good_id: plan.goodId!, quantity: capacity, action: "buy" });
            const affordable = Math.floor(availableFunds / bq.unit_price);
            const buyQty = Math.min(capacity, affordable);
            if (buyQty > 0) {
              const eq = buyQty < capacity
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
          s = { ...s, ships: { ...s.ships, [ship.id]: { phase: "idle" } } };
          continue;
        }

        // Dispatch to sell port (use pre-computed sellLegs, or find path if needed)
        const sellLegs = plan.sellLegs ?? [];
        if (sellLegs.length > 0) {
          try {
            await fleetApi.transit(ship.id, { route_id: sellLegs[0].routeId });
            s = { ...s, ships: { ...s.ships, [ship.id]: { phase: "transiting_to_sell", plan: { ...plan, quantity: boughtQty, actualBuyPrice, legs: sellLegs.slice(1) } } } };
            s = appendLog(s, `${ship.name}: → ${portName(plan.sellPortId)} to sell ${boughtQty}× ${plan.goodName}`);
          } catch (e: unknown) {
            s = appendLog(s, `${ship.name}: sell dispatch failed — ${(e as Error).message}`);
            s = { ...s, ships: { ...s.ships, [ship.id]: { phase: "idle" } } };
          }
        } else {
          // Rare: sellLegs was empty (same port buy/sell?), re-find path
          const sellPaths = findPaths(ship.port_id, allRoutes, 99);
          const toSell = sellPaths.find((p) => p.destPortId === plan.sellPortId);
          if (!toSell || toSell.legs.length === 0) {
            s = appendLog(s, `${ship.name}: ⚠️ no sell route from ${portName(ship.port_id)} — resetting`);
            s = { ...s, ships: { ...s.ships, [ship.id]: { phase: "idle" } } };
            continue;
          }
          try {
            await fleetApi.transit(ship.id, { route_id: toSell.legs[0].routeId });
            s = { ...s, ships: { ...s.ships, [ship.id]: { phase: "transiting_to_sell", plan: { ...plan, quantity: boughtQty, actualBuyPrice, legs: toSell.legs.slice(1) } } } };
            s = appendLog(s, `${ship.name}: → ${portName(plan.sellPortId)} to sell ${boughtQty}× ${plan.goodName}`);
          } catch (e: unknown) {
            s = appendLog(s, `${ship.name}: sell dispatch failed — ${(e as Error).message}`);
            s = { ...s, ships: { ...s.ships, [ship.id]: { phase: "idle" } } };
          }
        }

      // ══════════════════════════════════════════════════════════════════════════
      // TRANSITING_TO_SELL — advance waypoints; sell cargo on arrival, then idle
      // ══════════════════════════════════════════════════════════════════════════
      } else if (ss.phase === "transiting_to_sell") {
        const plan = ss.plan!;

        // Advance waypoint
        if (plan.legs.length > 0 && ship.port_id !== plan.sellPortId) {
          try {
            await fleetApi.transit(ship.id, { route_id: plan.legs[0].routeId });
            s = { ...s, ships: { ...s.ships, [ship.id]: { ...ss, plan: { ...plan, legs: plan.legs.slice(1) } } } };
            s = appendLog(s, `${ship.name}: waypoint → ${portName(plan.legs[0].toPortId)}`);
          } catch (e: unknown) {
            s = appendLog(s, `${ship.name}: waypoint failed — ${(e as Error).message}`);
          }
          continue;
        }

        if (ship.port_id !== plan.sellPortId) {
          s = appendLog(s, `${ship.name}: ⚠️ at ${portName(ship.port_id)}, expected ${portName(plan.sellPortId)} — resetting`);
          s = { ...s, ships: { ...s.ships, [ship.id]: { phase: "idle" } } };
          continue;
        }

        // Arrived at destination
        await sleep(DOCK_DELAY_MS);

        // Sell cargo if any
        if (plan.goodId && (plan.quantity ?? 0) > 0) {
          let sold = false;
          try {
            const sq = await tradeApi.createQuote({ port_id: ship.port_id, good_id: plan.goodId, quantity: plan.quantity!, action: "sell" });
            await tradeApi.executeQuote({ token: sq.token, destinations: [{ type: "ship", id: ship.id, quantity: plan.quantity! }] });
            const profit = (sq.unit_price - (plan.actualBuyPrice ?? 0)) * plan.quantity!;
            s.profitAccrued += profit;
            s = appendLog(s, `${ship.name}: sold ${plan.quantity}× ${plan.goodName} @ £${sq.unit_price} (+£${Math.round(profit).toLocaleString()})`);
            sold = true;
          } catch (e: unknown) {
            s = appendLog(s, `${ship.name}: NPC sell failed — ${(e as Error).message}`);
          }

          if (!sold) {
            try {
              const askPrice = Math.round((plan.actualBuyPrice ?? 0) * 1.15);
              await marketApi.createOrder({ port_id: ship.port_id, good_id: plan.goodId, total: plan.quantity!, price: askPrice, side: "sell" });
              s = appendLog(s, `${ship.name}: posted sell order ${plan.quantity}× @ £${askPrice}`);
            } catch (e2: unknown) {
              s = appendLog(s, `${ship.name}: market order also failed — ${(e2 as Error).message}`);
            }
          }
        }

        if (plan.passengerBid) {
          s = appendLog(s, `${ship.name}: 🧳 pax delivered to ${portName(ship.port_id)} (+£${plan.passengerBid} at boarding)`);
        }

        // Back to idle — will re-scan next cycle
        s = { ...s, ships: { ...s.ships, [ship.id]: { phase: "idle" } } };
      }
    }

  } catch (e: unknown) {
    s = appendLog(s, `Cycle error: ${(e as Error).message}`);
  }

  return s;
}