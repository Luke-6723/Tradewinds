
/**
 * Autopilot core cycle — server-only. Imported by the worker process.
 *
 * Phases per ship:
 *   idle              → scan local port first, then global; dispatch to buy or sell
 *   transiting_to_buy → traveling empty to a buy port; buys on arrival then switches phase
 *   transiting_to_sell → has cargo; sells on arrival (or posts limit order as fallback)
 *
 * Warehouse stockpiling strategy:
 *   - Auto-buys a warehouse at each port a ship docks at (if available funds exceed banking cap)
 *   - Stockpiles goods on arrival when sell price <= STOCKPILE_PRICE_LEVEL ("Cheap")
 *   - Sells from warehouses each cycle when price recovers to >= MIN_SELL_PRICE_LEVEL ("Expensive")
 *   - Loads idle ships from warehouses when a profitable delivery route exists
 */

import type { Good, Port, Route, Ship, ShipType, WarehouseInventory, Warehouse } from "@/lib/types";
import { companyApi } from "@/lib/api/company";
import { fleetApi } from "@/lib/api/fleet";
import { marketApi } from "@/lib/api/market";
import { tradeApi } from "@/lib/api/trade";
import { warehousesApi } from "@/lib/api/warehouses";
import { worldApi } from "@/lib/api/world";
import {
  appendLog,
  claimKey,
  type AutopilotState,
  type RouteLeg,
  type ShipPlan,
} from "@/lib/autopilot-types";
import {
  getWarehouseStocks,
  removeWarehouseStock,
  upsertWarehouseStock,
} from "@/lib/db/collections";

export * from "@/lib/autopilot-types";

// ── Config ─────────────────────────────────────────────────────────────────────

const MIN_MARGIN   = 0.01;  // accept any profit (>1% to cover fees/rounding)
const MAX_UNITS    = 50;
/** Sell-quote batch size (probes this many (destPort, good) pairs per scan). */
const SELL_BATCH   = 32;
/** Buy-quote batch size (validates top N sell-scored candidates). */
const BUY_BATCH    = 16;
/** Delay (ms) after docking before buying/selling. */
const DOCK_DELAY_MS = 5_000;
/** Set to false to disable all warehouse stockpiling (direct-buy scan + ship-arrival stockpile). */
const ENABLE_STOCKPILING = false;
/** Ships idle for longer than this (ms) with no viable trade will roam to a new port. */
const IDLE_TIMEOUT_MS = 90_000;

/** Price level at or above which we sell from warehouse / accept as sell destination (Expensive = 4). */
const MIN_SELL_PRICE_LEVEL = 4;
/** Price level at or below which we stockpile instead of selling / buy into warehouse (Average = 3). */
const STOCKPILE_PRICE_LEVEL = 3;

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
const ORDINAL_LABEL = Object.fromEntries(Object.entries(PRICE_LEVEL).map(([k, v]) => [v, k]));
function priceLevelLabel(ord: number): string {
  return ORDINAL_LABEL[ord] ?? "unknown";
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
      const newLegs: RouteLeg[] = [
        ...legs,
        { toPortId: r.to_id, routeId: r.id, distance: r.distance },
      ];
      const newDist = dist + r.distance;
      results.push({ destPortId: r.to_id, legs: newLegs, totalDistance: newDist });
      queue.push({ portId: r.to_id, legs: newLegs, dist: newDist });
    }
  }
  return results;
}

// ── Shared batch-quote helpers ─────────────────────────────────────────────────

interface RawCandidate {
  buyPortId: string;
  sellPortId: string;
  sellLegs: RouteLeg[];   // legs from buyPort → sellPort (may be empty if 0-dist, impossible here)
  toLegsBuy: RouteLeg[];  // legs from currentPort → buyPort (empty when buying locally)
  goodId: string;
  prescore: number;
}

interface ScoredCandidate extends RawCandidate {
  npcSellPrice: number;
}

/** Keep the single best candidate per (buyPort, good) pair (highest prescore sell port).
 *  Keying on buyPort×good ensures every buy-location gets a slot, not just the
 *  globally best sell port for each good. */
function dedupBestPerGood(candidates: RawCandidate[], limit: number): RawCandidate[] {
  const seen = new Map<string, RawCandidate>();
  for (const c of candidates) {
    const k = `${c.buyPortId}:${c.goodId}`;
    if (!seen.has(k) || c.prescore > seen.get(k)!.prescore) seen.set(k, c);
  }
  return [...seen.values()].sort((a, b) => b.prescore - a.prescore).slice(0, limit);
}

// ── Cycle ──────────────────────────────────────────────────────────────────────

/** How long to wait for stragglers before proceeding with whoever is at the buy port. */
const GATHER_TIMEOUT_MS = 5 * 60_000; // 5 minutes

export async function runCycle(s: AutopilotState, companyId: string): Promise<AutopilotState> {
  s = { ...s, lastCycleAt: new Date().toISOString() };

  try {
    const [ships, allRoutes, shipTypes, allPorts, allGoods, company, economy, allWarehouses] = await Promise.all([
      fleetApi.getShips().catch((e: Error) => { throw new Error(`getShips: ${e.message}`); }),
      worldApi.getRoutes().catch((e: Error) => { throw new Error(`getRoutes: ${e.message}`); }),
      worldApi.getShipTypes().catch((e: Error) => { throw new Error(`getShipTypes: ${e.message}`); }),
      worldApi.getPorts().catch((e: Error) => { throw new Error(`getPorts: ${e.message}`); }),
      worldApi.getGoods().catch((e: Error) => { throw new Error(`getGoods: ${e.message}`); }),
      companyApi.getCompany().catch((e: Error) => { throw new Error(`getCompany: ${e.message}`); }),
      companyApi.getEconomy().catch(() => ({ total_upkeep: 0 } as { total_upkeep: number })),
      warehousesApi.getWarehouses().catch(() => [] as Warehouse[]),
    ]);

    const bankingCap = economy.total_upkeep + 2_000;
    let availableFunds = Math.max(0, company.treasury - bankingCap);

    const portName = (id: string | null | undefined) =>
      allPorts.find((p: Port) => p.id === id)?.name ?? (id ?? "?").slice(0, 8);
    const goodName = (id: string) =>
      allGoods.find((g: Good) => g.id === id)?.name ?? id.slice(0, 8);
    const stMap = new Map<string, ShipType>(shipTypes.map((t: ShipType) => [t.id, t]));

    // ── Warehouse maps ─────────────────────────────────────────────────────────
    const warehouseByPort = new Map<string, Warehouse>(allWarehouses.map((w: Warehouse) => [w.port_id, w]));
    s = { ...s, warehousedPortIds: allWarehouses.map((w: Warehouse) => w.port_id) };

    const warehouseInventory = new Map<string, WarehouseInventory[]>();
    await Promise.all(
      allWarehouses.map(async (w: Warehouse) => {
        try {
          warehouseInventory.set(w.id, await warehousesApi.getInventory(w.id));
        } catch {
          warehouseInventory.set(w.id, []);
        }
      }),
    );

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

    // ── NPC trader positions ───────────────────────────────────────────────────
    const allTraders = (
      await Promise.all(
        allPorts.map((p: Port) => tradeApi.getTraderPositions(p.id).catch(() => [])),
      )
    ).flat();

    const npcGoods  = new Map<string, Set<string>>();
    const npcMinOrd = new Map<string, number>();
    const npcMaxOrd = new Map<string, number>();
    for (const tp of allTraders) {
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

    const dockedCount = ships.filter((sh: Ship) => sh.status !== "traveling").length;
    s = appendLog(s, `⟳ ${ships.length} ship(s) / ${dockedCount} docked / £${Math.round(availableFunds).toLocaleString()} available | phase: ${s.fleetPhase ?? "none"}`);

    // ── Warehouse sell scan (runs every cycle, independent of fleet phase) ─────
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
          warehouseInventory.set(warehouseId, (warehouseInventory.get(warehouseId) ?? []).filter((i: WarehouseInventory) => i.good_id !== item.good_id));
          s = appendLog(s, `🏭 Sold ${item.quantity}× ${goodName(item.good_id)} from warehouse @ £${sq.unit_price} (+£${Math.round(profit).toLocaleString()})`);
        } catch (e: unknown) {
          s = appendLog(s, `🏭 Warehouse sell failed (${goodName(item.good_id)}) — ${(e as Error).message}`);
        }
      }
    }

    // ── Fleet convoy state machine ─────────────────────────────────────────────

    // ══════════════════════════════════════════════════════════════════════════
    // PHASE: scanning — find best global trade, buy warehouse, dispatch fleet
    // ══════════════════════════════════════════════════════════════════════════
    if (!s.fleetPhase || s.fleetPhase === "scanning") {

      // Build all (buyPortId, good, sellPortId) candidate pairs across the whole map
      const allCandidates: RawCandidate[] = [];
      for (const buyPortId of npcGoods.keys()) {
        const buyGoods = npcGoods.get(buyPortId)!;
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
            allCandidates.push({ buyPortId, sellPortId: sp.destPortId, sellLegs: sp.legs, toLegsBuy: [], goodId, prescore });
          }
        }
      }

      if (allCandidates.length === 0) {
        s = appendLog(s, "Scanning: no arbitrage candidates — check trader position data");
        return s;
      }

      // Sell-quote batch to get real prices
      const sellBatch = dedupBestPerGood(allCandidates.sort((a, b) => b.prescore - a.prescore), SELL_BATCH);
      s = appendLog(s, `Scanning: probing ${sellBatch.length} sell quote(s) across ${npcGoods.size} port(s)…`);

      let batchSellItems: Awaited<ReturnType<typeof tradeApi.batchCreateQuotes>> = [];
      try {
        batchSellItems = await tradeApi.batchCreateQuotes({
          requests: sellBatch.map((c) => ({ port_id: c.sellPortId, good_id: c.goodId, quantity: MAX_UNITS, action: "sell" as const })),
        });
      } catch (e: unknown) {
        s = appendLog(s, `Scanning: sell batch failed — ${(e as Error).message}`);
        return s;
      }

      // Score by actual sell price and verify margin with a real buy quote
      const scored: ScoredCandidate[] = [];
      for (let i = 0; i < sellBatch.length; i++) {
        const item = batchSellItems[i];
        const c    = sellBatch[i];
        if (!item || item.status !== "success" || !item.quote) continue;
        scored.push({ ...c, npcSellPrice: item.quote.unit_price });
      }
      scored.sort((a, b) => b.npcSellPrice - a.npcSellPrice);

      if (scored.length === 0) {
        s = appendLog(s, "Scanning: no successful sell quotes");
        return s;
      }

      // Log top 5 candidates for visibility
      for (const c of scored.slice(0, 5)) {
        s = appendLog(s, `  ${goodName(c.goodId)}: buy@${portName(c.buyPortId)} → sell@${portName(c.sellPortId)}=£${c.npcSellPrice} (prescore ${c.prescore})`);
      }

      // Find first candidate with a viable margin
      let best: (ScoredCandidate & { buyPrice: number }) | null = null;
      for (const c of scored) {
        try {
          const bq = await tradeApi.createQuote({ port_id: c.buyPortId, good_id: c.goodId, quantity: MAX_UNITS, action: "buy" });
          const margin = (c.npcSellPrice - bq.unit_price) / bq.unit_price;
          s = appendLog(s, `  Checking ${goodName(c.goodId)} buy@${portName(c.buyPortId)}=£${bq.unit_price} → sell@${portName(c.sellPortId)}=£${c.npcSellPrice}: margin ${(margin * 100).toFixed(1)}%`);
          if (margin >= MIN_MARGIN) {
            best = { ...c, buyPrice: bq.unit_price };
            break;
          }
        } catch (e: unknown) {
          s = appendLog(s, `  Buy quote failed for ${goodName(c.goodId)} @ ${portName(c.buyPortId)} — ${(e as Error).message}`);
        }
      }

      if (!best) {
        s = appendLog(s, "Scanning: no candidate clears minimum margin — waiting");
        return s;
      }

      s = appendLog(s, `✅ Trade selected: ${goodName(best.goodId)} | buy@${portName(best.buyPortId)}=£${best.buyPrice} → sell@${portName(best.sellPortId)}=£${best.npcSellPrice} (${((best.npcSellPrice - best.buyPrice) / best.buyPrice * 100).toFixed(1)}%)`);

      // ── Ensure warehouse exists at buy port ────────────────────────────────
      let buyWarehouse = warehouseByPort.get(best.buyPortId);
      if (!buyWarehouse) {
        try {
          buyWarehouse = await warehousesApi.buyWarehouse({ port_id: best.buyPortId });
          warehouseByPort.set(best.buyPortId, buyWarehouse);
          s = { ...s, warehousedPortIds: [...s.warehousedPortIds, best.buyPortId] };
          warehouseInventory.set(buyWarehouse.id, []);
          s = appendLog(s, `🏗️ Bought warehouse at ${portName(best.buyPortId)}`);
        } catch (e: unknown) {
          s = appendLog(s, `⚠️ No warehouse at ${portName(best.buyPortId)} — ${(e as Error).message}. Will buy directly.`);
        }
      }

      // ── Pre-buy fleet capacity into warehouse ──────────────────────────────
      if (buyWarehouse && availableFunds > bankingCap) {
        const totalCap = ships.reduce((acc, sh: Ship) => acc + Math.min(stMap.get(sh.ship_type_id)?.capacity ?? 20, MAX_UNITS), 0);
        const maxAffordable = Math.floor((availableFunds - bankingCap) / best.buyPrice);
        const preBuyQty = Math.min(totalCap, maxAffordable);
        if (preBuyQty > 0) {
          try {
            const preBuyQ = await tradeApi.createQuote({ port_id: best.buyPortId, good_id: best.goodId, quantity: preBuyQty, action: "buy" });
            await tradeApi.executeQuote({ token: preBuyQ.token, destinations: [{ type: "warehouse", id: buyWarehouse.id, quantity: preBuyQty }] });
            availableFunds -= preBuyQty * preBuyQ.unit_price;
            const existing = warehouseInventory.get(buyWarehouse.id) ?? [];
            existing.push({ id: "", warehouse_id: buyWarehouse.id, good_id: best.goodId, quantity: preBuyQty });
            warehouseInventory.set(buyWarehouse.id, existing);
            await upsertWarehouseStock(companyId, { warehouseId: buyWarehouse.id, portId: best.buyPortId, goodId: best.goodId, goodName: goodName(best.goodId), avgBuyPrice: preBuyQ.unit_price });
            stockPrices.set(`${buyWarehouse.id}:${best.goodId}`, preBuyQ.unit_price);
            s = appendLog(s, `🏭 Pre-bought ${preBuyQty}× ${goodName(best.goodId)} @ £${preBuyQ.unit_price} into warehouse at ${portName(best.buyPortId)}`);
          } catch (e: unknown) {
            s = appendLog(s, `Pre-buy failed — ${(e as Error).message}`);
          }
        }
      }

      // ── Set fleet plan ─────────────────────────────────────────────────────
      s = {
        ...s,
        fleetPhase: "gathering",
        fleetPlan: {
          goodId: best.goodId, goodName: goodName(best.goodId),
          buyPortId: best.buyPortId, sellPortId: best.sellPortId,
          estimatedSellPrice: best.npcSellPrice,
          createdAt: new Date().toISOString(),
        },
      };

      // ── Dispatch all idle docked ships toward buy port ─────────────────────
      let dispatched = 0;
      for (const ship of ships) {
        const ss = s.ships[ship.id] ?? { phase: "idle" };
        if (ss.phase !== "idle") continue;
        if (ship.status === "traveling") continue;
        if (!ship.port_id) continue;

        if (ship.port_id === best.buyPortId) {
          s.ships = { ...s.ships, [ship.id]: { phase: "waiting_at_buy" } };
          s = appendLog(s, `${ship.name}: already at ${portName(best.buyPortId)}, waiting`);
          dispatched++;
          continue;
        }

        const paths = findPaths(ship.port_id, allRoutes, 99);
        const toPath = paths.find((p) => p.destPortId === best.buyPortId);
        if (!toPath) {
          s = appendLog(s, `${ship.name}: no route to ${portName(best.buyPortId)}`);
          continue;
        }
        try {
          await fleetApi.transit(ship.id, { route_id: toPath.legs[0].routeId });
          s.ships = {
            ...s.ships,
            [ship.id]: {
              phase: "transiting_to_buy",
              plan: {
                goodId: best.goodId, goodName: goodName(best.goodId),
                quantity: 0, actualBuyPrice: 0,
                legs: toPath.legs.slice(1),
                buyPortId: best.buyPortId, sellPortId: best.sellPortId, sellLegs: [], sellPrice: best.npcSellPrice,
              },
            },
          };
          s = appendLog(s, `${ship.name}: dispatched → ${portName(best.buyPortId)}`);
          dispatched++;
        } catch (e: unknown) {
          s = appendLog(s, `${ship.name}: dispatch failed — ${(e as Error).message}`);
        }
      }
      s = appendLog(s, `Fleet: ${dispatched} ship(s) heading to ${portName(best.buyPortId)}`);

    // ══════════════════════════════════════════════════════════════════════════
    // PHASE: gathering — wait for fleet at buy port, then buy + dispatch to sell
    // ══════════════════════════════════════════════════════════════════════════
    } else if (s.fleetPhase === "gathering") {
      const fp = s.fleetPlan!;
      const elapsedMs = Date.now() - new Date(fp.createdAt).getTime();

      for (const ship of ships) {
        const ss = s.ships[ship.id] ?? { phase: "idle" };
        if (ship.status === "traveling") continue;
        if (!ship.port_id) continue;

        if (ss.phase === "transiting_to_buy") {
          const plan = ss.plan!;
          if (plan.legs.length > 0 && ship.port_id !== fp.buyPortId) {
            // Advance waypoint
            try {
              await fleetApi.transit(ship.id, { route_id: plan.legs[0].routeId });
              s.ships = { ...s.ships, [ship.id]: { ...ss, plan: { ...plan, legs: plan.legs.slice(1) } } };
              s = appendLog(s, `${ship.name}: waypoint → ${portName(plan.legs[0].toPortId)}`);
            } catch (e: unknown) {
              s = appendLog(s, `${ship.name}: waypoint failed — ${(e as Error).message}`);
            }
            continue;
          }
          if (ship.port_id === fp.buyPortId) {
            s.ships = { ...s.ships, [ship.id]: { phase: "waiting_at_buy" } };
            s = appendLog(s, `${ship.name}: arrived at ${portName(fp.buyPortId)}, waiting for fleet`);
          }
          continue;
        }

        // Late idle ships — send them toward buy port too
        if (ss.phase === "idle") {
          if (ship.port_id === fp.buyPortId) {
            s.ships = { ...s.ships, [ship.id]: { phase: "waiting_at_buy" } };
          } else {
            const paths = findPaths(ship.port_id, allRoutes, 99);
            const toPath = paths.find((p) => p.destPortId === fp.buyPortId);
            if (toPath) {
              try {
                await fleetApi.transit(ship.id, { route_id: toPath.legs[0].routeId });
                s.ships = { ...s.ships, [ship.id]: { phase: "transiting_to_buy", plan: { goodId: fp.goodId, goodName: fp.goodName, quantity: 0, actualBuyPrice: 0, legs: toPath.legs.slice(1), buyPortId: fp.buyPortId, sellPortId: fp.sellPortId, sellLegs: [], sellPrice: fp.estimatedSellPrice } } };
                s = appendLog(s, `${ship.name}: late dispatch → ${portName(fp.buyPortId)}`);
              } catch { /* ignore */ }
            }
          }
        }
      }

      const waitingShips   = ships.filter((sh: Ship) => (s.ships[sh.id]?.phase ?? "idle") === "waiting_at_buy");
      const stillTraveling = ships.filter((sh: Ship) => sh.status === "traveling" && (s.ships[sh.id]?.phase ?? "idle") === "transiting_to_buy");
      const timedOut       = elapsedMs > GATHER_TIMEOUT_MS;

      s = appendLog(s, `Gathering: ${waitingShips.length} waiting, ${stillTraveling.length} en route${timedOut ? " [TIMEOUT — proceeding]" : ""}`);

      if (waitingShips.length > 0 && (stillTraveling.length === 0 || timedOut)) {
        // ── Re-evaluate sell price ───────────────────────────────────────────
        let sellPortId = fp.sellPortId;
        let sellPrice  = fp.estimatedSellPrice;
        try {
          const freshSell = await tradeApi.createQuote({ port_id: fp.sellPortId, good_id: fp.goodId, quantity: MAX_UNITS, action: "sell" });
          sellPrice = freshSell.unit_price;
          s = appendLog(s, `Re-evaluated sell: £${sellPrice} @ ${portName(sellPortId)}`);
        } catch { /* use estimate */ }

        // ── Find route buyPort → sellPort ────────────────────────────────────
        const sellPaths = findPaths(fp.buyPortId, allRoutes, 99);
        const sellPath  = sellPaths.find((p) => p.destPortId === sellPortId);
        if (!sellPath) {
          s = appendLog(s, `⚠️ No route ${portName(fp.buyPortId)} → ${portName(sellPortId)} — aborting trade`);
          for (const sh of waitingShips) s.ships = { ...s.ships, [sh.id]: { phase: "idle" } };
          s = { ...s, fleetPhase: "scanning", fleetPlan: undefined };
          return s;
        }

        const buyWarehouse = warehouseByPort.get(fp.buyPortId);
        let warehouseQty = buyWarehouse
          ? (warehouseInventory.get(buyWarehouse.id) ?? []).find((i: WarehouseInventory) => i.good_id === fp.goodId)?.quantity ?? 0
          : 0;
        const avgBuy = buyWarehouse ? (stockPrices.get(`${buyWarehouse.id}:${fp.goodId}`) ?? 0) : 0;

        await sleep(DOCK_DELAY_MS);

        for (const ship of waitingShips) {
          const capacity = stMap.get(ship.ship_type_id)?.capacity ?? 20;
          const qty = Math.min(capacity, MAX_UNITS);
          let boughtQty    = 0;
          let actualBuyPrice = 0;

          // Load from warehouse first
          if (buyWarehouse && warehouseQty > 0) {
            const fromWh = Math.min(qty, warehouseQty);
            try {
              await warehousesApi.transferToShip(buyWarehouse.id, { ship_id: ship.id, good_id: fp.goodId, quantity: fromWh });
              warehouseQty -= fromWh;
              boughtQty    = fromWh;
              actualBuyPrice = avgBuy;
              s = appendLog(s, `${ship.name}: loaded ${fromWh}× ${fp.goodName} from warehouse`);
            } catch (e: unknown) {
              s = appendLog(s, `${ship.name}: warehouse load failed — ${(e as Error).message}`);
            }
          }

          // Buy remainder from NPC
          const remaining = qty - boughtQty;
          if (remaining > 0 && availableFunds > 0) {
            try {
              const bq = await tradeApi.createQuote({ port_id: fp.buyPortId, good_id: fp.goodId, quantity: remaining, action: "buy" });
              const affordable = Math.floor(availableFunds / bq.unit_price);
              const buyQty = Math.min(remaining, affordable);
              if (buyQty > 0) {
                const execQ = buyQty < remaining
                  ? await tradeApi.createQuote({ port_id: fp.buyPortId, good_id: fp.goodId, quantity: buyQty, action: "buy" })
                  : bq;
                await tradeApi.executeQuote({ token: execQ.token, destinations: [{ type: "ship", id: ship.id, quantity: buyQty }] });
                availableFunds -= buyQty * execQ.unit_price;
                actualBuyPrice = boughtQty > 0
                  ? (actualBuyPrice * boughtQty + execQ.unit_price * buyQty) / (boughtQty + buyQty)
                  : execQ.unit_price;
                boughtQty += buyQty;
                s = appendLog(s, `${ship.name}: bought ${buyQty}× ${fp.goodName} @ £${execQ.unit_price}`);
              }
            } catch (e: unknown) {
              s = appendLog(s, `${ship.name}: NPC buy failed — ${(e as Error).message}`);
            }
          }

          if (boughtQty === 0) {
            s = appendLog(s, `${ship.name}: nothing to load — resetting to idle`);
            s.ships = { ...s.ships, [ship.id]: { phase: "idle" } };
            continue;
          }

          // Dispatch to sell port
          try {
            await fleetApi.transit(ship.id, { route_id: sellPath.legs[0].routeId });
            s.ships = {
              ...s.ships,
              [ship.id]: {
                phase: "transiting_to_sell",
                plan: {
                  goodId: fp.goodId, goodName: fp.goodName,
                  quantity: boughtQty, actualBuyPrice,
                  legs: sellPath.legs.slice(1), sellPortId, sellPrice,
                },
              },
            };
            const estProfit = (sellPrice - actualBuyPrice) * boughtQty;
            s = appendLog(s, `${ship.name}: → ${portName(sellPortId)} with ${boughtQty}× ${fp.goodName} (est. +£${Math.round(estProfit).toLocaleString()})`);
          } catch (e: unknown) {
            s = appendLog(s, `${ship.name}: sell dispatch failed — ${(e as Error).message}`);
            s.ships = { ...s.ships, [ship.id]: { phase: "idle" } };
          }
        }

        // Clean up warehouse inventory
        if (buyWarehouse) {
          const inv = warehouseInventory.get(buyWarehouse.id) ?? [];
          const idx = inv.findIndex((i: WarehouseInventory) => i.good_id === fp.goodId);
          if (idx >= 0) {
            if (warehouseQty <= 0) {
              inv.splice(idx, 1);
              await removeWarehouseStock(companyId, buyWarehouse.id, fp.goodId).catch(() => {});
            } else {
              inv[idx] = { ...inv[idx], quantity: warehouseQty };
            }
            warehouseInventory.set(buyWarehouse.id, inv);
          }
        }

        s = { ...s, fleetPhase: "selling" };
        s = appendLog(s, `Fleet: convoy dispatched to ${portName(sellPortId)}`);
      }

    // ══════════════════════════════════════════════════════════════════════════
    // PHASE: selling — advance ships, sell on arrival, reset when done
    // ══════════════════════════════════════════════════════════════════════════
    } else if (s.fleetPhase === "selling") {
      const fp = s.fleetPlan!;

      for (const ship of ships) {
        const ss = s.ships[ship.id] ?? { phase: "idle" };
        if (ss.phase !== "transiting_to_sell" || !ss.plan) continue;
        if (ship.status === "traveling") continue;
        if (!ship.port_id) continue;

        const plan = ss.plan;

        // Waypoint
        if (plan.legs.length > 0 && ship.port_id !== plan.sellPortId) {
          try {
            await fleetApi.transit(ship.id, { route_id: plan.legs[0].routeId });
            s.ships = { ...s.ships, [ship.id]: { ...ss, plan: { ...plan, legs: plan.legs.slice(1) } } };
            s = appendLog(s, `${ship.name}: waypoint → ${portName(plan.legs[0].toPortId)}`);
          } catch (e: unknown) {
            s = appendLog(s, `${ship.name}: waypoint failed — ${(e as Error).message}`);
          }
          continue;
        }

        if (ship.port_id !== plan.sellPortId) {
          s = appendLog(s, `${ship.name}: at ${portName(ship.port_id)}, expected ${portName(plan.sellPortId)} — resetting`);
          s.ships = { ...s.ships, [ship.id]: { phase: "idle" } };
          continue;
        }

        // Arrived — sell
        s = appendLog(s, `${ship.name}: arrived at ${portName(plan.sellPortId)}, selling ${plan.quantity}× ${plan.goodName}…`);
        await sleep(DOCK_DELAY_MS);

        let sold = false;
        try {
          const sq = await tradeApi.createQuote({ port_id: ship.port_id, good_id: plan.goodId, quantity: plan.quantity, action: "sell" });
          await tradeApi.executeQuote({ token: sq.token, destinations: [{ type: "ship", id: ship.id, quantity: plan.quantity }] });
          const profit = (sq.unit_price - plan.actualBuyPrice) * plan.quantity;
          s.profitAccrued += profit;
          s = appendLog(s, `${ship.name}: sold ${plan.quantity}× @ £${sq.unit_price} — profit +£${Math.round(profit).toLocaleString()}`);
          sold = true;
        } catch (e: unknown) {
          s = appendLog(s, `${ship.name}: NPC sell failed (${(e as Error).message}) — posting market order`);
        }

        if (!sold) {
          try {
            const askPrice = Math.round(plan.actualBuyPrice * 1.15);
            await marketApi.createOrder({ port_id: ship.port_id, good_id: plan.goodId, total: plan.quantity, price: askPrice, side: "sell" });
            s = appendLog(s, `${ship.name}: posted sell order ${plan.quantity}× @ £${askPrice}`);
          } catch (e2: unknown) {
            s = appendLog(s, `${ship.name}: market order also failed — ${(e2 as Error).message}`);
          }
        }

        s.ships = { ...s.ships, [ship.id]: { phase: "idle" } };
      }

      // Check if all ships are done selling
      const stillSelling = ships.filter((sh: Ship) => {
        const ss = s.ships[sh.id] ?? { phase: "idle" };
        return ss.phase === "transiting_to_sell" || sh.status === "traveling";
      });

      if (stillSelling.length === 0) {
        s = appendLog(s, `Fleet: all sold at ${portName(fp.sellPortId)} — scanning for next trade`);
        s = { ...s, fleetPhase: "scanning", fleetPlan: undefined, claimed: {} };
      } else {
        s = appendLog(s, `Selling: ${stillSelling.length} ship(s) still in transit`);
      }
    }

  } catch (e: unknown) {
    s = appendLog(s, `Cycle error: ${(e as Error).message}`);
  }

  return s;
}
