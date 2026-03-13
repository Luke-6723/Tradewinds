
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

export async function runCycle(s: AutopilotState, companyId: string): Promise<AutopilotState> {
  s = { ...s, lastCycleAt: new Date().toISOString() };

  // Purge stale claims
  const activeClaims: Record<string, string> = {};
  for (const [key, shipId] of Object.entries(s.claimed)) {
    const phase = s.ships[shipId]?.phase;
    if (phase === "transiting_to_sell" || phase === "transiting_to_buy") {
      activeClaims[key] = shipId;
    }
  }
  s = { ...s, claimed: activeClaims };

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

    // Minimum treasury to keep in reserve: covers ≥1 week of upkeep + £2k buffer
    const bankingCap = economy.total_upkeep + 2_000;
    // Track available funds across ships in this cycle to avoid over-committing
    let availableFunds = Math.max(0, company.treasury - bankingCap);

    const portName = (id: string | null | undefined) =>
      allPorts.find((p: Port) => p.id === id)?.name ?? (id ?? "?").slice(0, 8);
    const goodName = (id: string) =>
      allGoods.find((g: Good) => g.id === id)?.name ?? id.slice(0, 8);
    const stMap = new Map<string, ShipType>(shipTypes.map((t: ShipType) => [t.id, t]));

    // ── Warehouse maps ─────────────────────────────────────────────────────────
    const warehouseByPort = new Map<string, Warehouse>(allWarehouses.map((w: Warehouse) => [w.port_id, w]));
    s = { ...s, warehousedPortIds: allWarehouses.map((w: Warehouse) => w.port_id) };

    // Fetch live inventory for all warehouses + reconcile MongoDB avg-price records
    const warehouseInventory = new Map<string, WarehouseInventory[]>();
    await Promise.all(
      allWarehouses.map(async (w: Warehouse) => {
        try {
          const inv = await warehousesApi.getInventory(w.id);
          warehouseInventory.set(w.id, inv);
        } catch {
          warehouseInventory.set(w.id, []);
        }
      }),
    );

    const mongoStocks = await getWarehouseStocks(companyId).catch(() => []);
    const stockPrices = new Map<string, number>(); // "warehouseId:goodId" → avgBuyPrice
    for (const ms of mongoStocks) {
      stockPrices.set(`${ms.warehouseId}:${ms.goodId}`, ms.avgBuyPrice);

      // Reconcile: remove MongoDB record if the warehouse no longer has this good
      const liveInv = warehouseInventory.get(ms.warehouseId) ?? [];
      const stillPresent = liveInv.some((item: WarehouseInventory) => item.good_id === ms.goodId && item.quantity > 0);
      if (!stillPresent) {
        await removeWarehouseStock(companyId, ms.warehouseId, ms.goodId).catch(() => {});
        stockPrices.delete(`${ms.warehouseId}:${ms.goodId}`);
      }
    }

    const allTraders = (
      await Promise.all(
        allPorts.map((p: Port) => tradeApi.getTraderPositions(p.id).catch(() => [])),
      )
    ).flat();

    const npcGoods  = new Map<string, Set<string>>();
    const npcMinOrd = new Map<string, number>(); // "portId:goodId" → cheapest price ordinal (buy)
    const npcMaxOrd = new Map<string, number>(); // "portId:goodId" → priciest price ordinal (sell)
    for (const tp of allTraders) {
      if (!npcGoods.has(tp.port_id)) npcGoods.set(tp.port_id, new Set());
      npcGoods.get(tp.port_id)!.add(tp.good_id);
      if (tp.price_bounds) {
        const k = `${tp.port_id}:${tp.good_id}`;
        const ord = priceLevelOrdinal(tp.price_bounds);
        if (ord > 0) {
          const prevMin = npcMinOrd.get(k) ?? Infinity;
          const prevMax = npcMaxOrd.get(k) ?? 0;
          if (ord < prevMin) npcMinOrd.set(k, ord);
          if (ord > prevMax) npcMaxOrd.set(k, ord);
        }
      }
    }

    const dockedCount = ships.filter((sh: Ship) => sh.status !== "traveling").length;
    s = appendLog(s, `⟳ Cycle — ${ships.length} ship(s), ${dockedCount} docked, ${allWarehouses.length} warehouse(s)`);

    // ── Warehouse sell scan ────────────────────────────────────────────────────
    // Check all warehouses for goods that can be sold at a good price — no ship needed
    for (const [warehouseId, inventory] of warehouseInventory) {
      const warehouse = allWarehouses.find((w: Warehouse) => w.id === warehouseId);
      if (!warehouse) continue;
      for (const item of inventory) {
        if (item.quantity <= 0) continue;
        const priceLevel = npcMaxOrd.get(`${warehouse.port_id}:${item.good_id}`) ?? 0;
        if (priceLevel >= MIN_SELL_PRICE_LEVEL) {
          try {
            const sellQuote = await tradeApi.createQuote({
              port_id: warehouse.port_id,
              good_id: item.good_id,
              quantity: item.quantity,
              action: "sell",
            });
            await tradeApi.executeQuote({
              token: sellQuote.token,
              destinations: [{ type: "warehouse", id: warehouseId, quantity: item.quantity }],
            });
            const avgBuy = stockPrices.get(`${warehouseId}:${item.good_id}`) ?? 0;
            const profit = (sellQuote.unit_price - avgBuy) * item.quantity;
            s.profitAccrued += profit;
            await removeWarehouseStock(companyId, warehouseId, item.good_id).catch(() => {});
            stockPrices.delete(`${warehouseId}:${item.good_id}`);
            // Refresh live inventory after sale
            warehouseInventory.set(warehouseId, (warehouseInventory.get(warehouseId) ?? []).filter((i: WarehouseInventory) => i.good_id !== item.good_id));
            s = appendLog(s, `🏭 Warehouse ${portName(warehouse.port_id)}: sold ${item.quantity}× ${goodName(item.good_id)} @ £${sellQuote.unit_price} ("${priceLevelLabel(priceLevel)}") — profit +£${Math.round(profit).toLocaleString()}`);
          } catch (e: unknown) {
            s = appendLog(s, `🏭 Warehouse ${portName(warehouse.port_id)}: sell failed — ${(e as Error).message}`);
          }
        }
      }
    }

    // ── Warehouse direct-buy scan ──────────────────────────────────────────────
    // Every cycle, buy cheap goods directly into warehouses — no ship needed.
    // Mirrors the sell scan above: runs regardless of whether any ships are docked.
    if (ENABLE_STOCKPILING) for (const [portId, warehouse] of warehouseByPort) {
      if (availableFunds <= bankingCap) break;
      const portGoods = npcGoods.get(portId);
      if (!portGoods) continue;
      for (const goodId of portGoods) {
        if (availableFunds <= bankingCap) break;
        const priceLevel = npcMinOrd.get(`${portId}:${goodId}`) ?? 0;
        if (priceLevel === 0 || priceLevel > STOCKPILE_PRICE_LEVEL) continue;
        // Skip if already stockpiled at this warehouse to avoid complex price-averaging
        const wInv = warehouseInventory.get(warehouse.id) ?? [];
        if (wInv.some((i: WarehouseInventory) => i.good_id === goodId && i.quantity > 0)) continue;
        try {
          const probeQuote = await tradeApi.createQuote({
            port_id: portId,
            good_id: goodId,
            quantity: MAX_UNITS,
            action: "buy",
          });
          const maxAffordable = Math.floor((availableFunds - bankingCap) / probeQuote.unit_price);
          const buyQty = Math.min(MAX_UNITS, maxAffordable);
          if (buyQty < 1) continue;
          const buyQuote = buyQty < MAX_UNITS
            ? await tradeApi.createQuote({ port_id: portId, good_id: goodId, quantity: buyQty, action: "buy" })
            : probeQuote;
          await tradeApi.executeQuote({
            token: buyQuote.token,
            destinations: [{ type: "warehouse", id: warehouse.id, quantity: buyQty }],
          });
          availableFunds -= buyQty * buyQuote.unit_price;
          await upsertWarehouseStock(companyId, {
            warehouseId: warehouse.id,
            portId,
            goodId,
            goodName: goodName(goodId),
            avgBuyPrice: buyQuote.unit_price,
          });
          // Update local inventory so the sell scan can act on it next cycle
          wInv.push({ id: "", warehouse_id: warehouse.id, good_id: goodId, quantity: buyQty });
          warehouseInventory.set(warehouse.id, wInv);
          s = appendLog(s, `🏭 Warehouse ${portName(portId)}: stockpiled ${buyQty}× ${goodName(goodId)} @ £${buyQuote.unit_price} ("${priceLevelLabel(priceLevel)}")`);
        } catch (e: unknown) {
          s = appendLog(s, `🏭 Warehouse ${portName(portId)}: stockpile buy failed (${goodName(goodId)}) — ${(e as Error).message}`);
        }
      }
    }

    // Pre-fetch inventory for all docked idle ships so we can sell any untracked cargo
    const idleDockedShips = ships.filter(
      (sh: Ship) => sh.status === "docked" && sh.port_id && (s.ships[sh.id]?.phase ?? "idle") === "idle",
    );
    const idleCargoMap = new Map<string, Array<{ good_id: string; quantity: number }>>();
    await Promise.all(
      idleDockedShips.map(async (sh: Ship) => {
        try {
          const inv = await fleetApi.getInventory(sh.id);
          if (inv.length > 0) idleCargoMap.set(sh.id, inv);
        } catch {
          // Non-critical — skip if inventory fetch fails
        }
      }),
    );

    // ── Pre-scan: build sell-quote pool once per unique idle port ──────────────
    // Shares one batch of sell quotes across all ships at the same port, eliminating
    // N redundant API round-trips for N idle ships. Claims are NOT filtered here —
    // they are applied per-ship in the loop below.
    const portScanCache = new Map<string, ScoredCandidate[]>();
    {
      const idleDocked = ships.filter(
        (sh: Ship) => sh.status !== "traveling" && sh.port_id && (s.ships[sh.id]?.phase ?? "idle") === "idle",
      );
      for (const portId of [...new Set(idleDocked.map((sh: Ship) => sh.port_id!))]) {
        const allCandidates: RawCandidate[] = [];
        const toBuyPaths = findPaths(portId, allRoutes, 99);
        const buyLocations: Array<{ buyPortId: string; toLegsBuy: RouteLeg[] }> = [
          { buyPortId: portId, toLegsBuy: [] },
          ...toBuyPaths.map((p) => ({ buyPortId: p.destPortId, toLegsBuy: p.legs })),
        ];
        for (const { buyPortId, toLegsBuy } of buyLocations) {
          const buyGoods = npcGoods.get(buyPortId);
          if (!buyGoods) continue;
          const fromBuyPaths = findPaths(buyPortId, allRoutes, 99);
          for (const sellPath of fromBuyPaths) {
            const destGoods = npcGoods.get(sellPath.destPortId);
            if (!destGoods) continue;
            for (const goodId of buyGoods) {
              if (!destGoods.has(goodId)) continue;
              const destOrd  = npcMaxOrd.get(`${sellPath.destPortId}:${goodId}`) ?? 0;
              const srcOrd   = npcMinOrd.get(`${buyPortId}:${goodId}`) ?? 0;
              const prescore = destOrd - srcOrd;
              if (prescore < 0) continue;
              allCandidates.push({ buyPortId, sellPortId: sellPath.destPortId, sellLegs: sellPath.legs, toLegsBuy, goodId, prescore });
            }
          }
        }
        if (allCandidates.length === 0) continue;

        const sellBatch      = dedupBestPerGood(allCandidates.sort((a, b) => b.prescore - a.prescore), SELL_BATCH);
        const portShipNames  = idleDocked.filter((sh: Ship) => sh.port_id === portId).map((sh: Ship) => sh.name).join(", ");
        s = appendLog(s, `Port ${portName(portId)}: scanning [${portShipNames}] — ${sellBatch.length} sell quote(s)…`);

        let batchSellItems: Awaited<ReturnType<typeof tradeApi.batchCreateQuotes>> = [];
        try {
          batchSellItems = await tradeApi.batchCreateQuotes({
            requests: sellBatch.map((c) => ({
              port_id:  c.sellPortId,
              good_id:  c.goodId,
              quantity: MAX_UNITS,
              action:   "sell" as const,
            })),
          });
        } catch (e: unknown) {
          s = appendLog(s, `Port ${portName(portId)}: sell batch failed — ${(e as Error).message}`);
          continue;
        }

        const scored: ScoredCandidate[] = [];
        for (let i = 0; i < sellBatch.length; i++) {
          const item = batchSellItems[i];
          const c    = sellBatch[i];
          if (!item || item.status !== "success" || !item.quote) continue;
          scored.push({ ...c, npcSellPrice: item.quote.unit_price });
        }
        scored.sort((a, b) => b.npcSellPrice - a.npcSellPrice);
        portScanCache.set(portId, scored);
      }
    }

    for (const ship of ships) {
      const ss = s.ships[ship.id] ?? { phase: "idle" };

      // ── Traveling ──────────────────────────────────────────────────────────
      if (ship.status === "traveling") {
        if (ss.plan) {
          const dest = ss.phase === "transiting_to_buy"
            ? ss.plan.buyPortId
            : (ss.plan.legs[0]?.toPortId ?? ss.plan.sellPortId);
          s = appendLog(s, `${ship.name}: ✈ ${ss.phase === "transiting_to_buy" ? "heading to buy port" : "traveling to sell"} → ${portName(dest)}`);
        }
        continue;
      }

      if (!ship.port_id) continue;

      // ── Arrived at buy port ─────────────────────────────────────────────────
      if (ss.phase === "transiting_to_buy" && ss.plan) {
        const plan = ss.plan;

        // Waypoint en route to buy port
        if (plan.legs.length > 0 && ship.port_id !== plan.buyPortId) {
          const nextLeg = plan.legs[0];
          try {
            await fleetApi.transit(ship.id, { route_id: nextLeg.routeId });
            s.ships = { ...s.ships, [ship.id]: { phase: "transiting_to_buy", plan: { ...plan, legs: plan.legs.slice(1) } } };
            s = appendLog(s, `${ship.name}: waypoint ${portName(ship.port_id)} → ${portName(nextLeg.toPortId)} (en route to buy)`);
          } catch (e: unknown) {
            s = appendLog(s, `${ship.name}: waypoint transit failed — ${(e as Error).message}`);
          }
          continue;
        }

        if (ship.port_id !== plan.buyPortId) {
          s = appendLog(s, `${ship.name}: unexpected port ${portName(ship.port_id)}, resetting`);
          if (plan.buyPortId) delete s.claimed[claimKey(plan.goodId, plan.buyPortId)];
          s.ships = { ...s.ships, [ship.id]: { phase: "idle" } };
          continue;
        }

        // Roaming arrival — reset to idle so next cycle re-scans from new port
        if (plan.goodId === "roaming") {
          s.ships = { ...s.ships, [ship.id]: { phase: "idle" } };
          s = appendLog(s, `${ship.name}: arrived at roam destination ${portName(ship.port_id)}, scanning next cycle…`);
          continue;
        }

        // Arrived — buy the goods
        s = appendLog(s, `${ship.name}: arrived at buy port ${portName(ship.port_id)}, buying ${plan.quantity}× ${goodName(plan.goodId)}…`);
        await sleep(DOCK_DELAY_MS);
        try {
          // First quote: get the unit price to compute what we can afford
          const priceQuote = await tradeApi.createQuote({
            port_id: ship.port_id,
            good_id: plan.goodId,
            quantity: plan.quantity,
            action: "buy",
          });

          const maxAffordable = Math.floor(availableFunds / priceQuote.unit_price);
          const actualQty = Math.min(plan.quantity, maxAffordable);
          if (actualQty < 1) {
            s = appendLog(s, `${ship.name}: insufficient funds (£${availableFunds.toLocaleString()} < £${priceQuote.unit_price}/unit), resetting`);
            if (plan.buyPortId) delete s.claimed[claimKey(plan.goodId, plan.buyPortId)];
            s.ships = { ...s.ships, [ship.id]: { phase: "idle" } };
            continue;
          }
          if (actualQty < plan.quantity) {
            s = appendLog(s, `${ship.name}: funds capped — buying ${actualQty}× instead of ${plan.quantity}×`);
          }

          // If quantity changed, get a fresh quote so the token matches the execute quantity exactly
          const buyQuote = actualQty < plan.quantity
            ? await tradeApi.createQuote({ port_id: ship.port_id, good_id: plan.goodId, quantity: actualQty, action: "buy" })
            : priceQuote;

          // Verify affordability against the fresh quote's price (may differ from priceQuote)
          if (actualQty * buyQuote.unit_price > availableFunds) {
            const finalQty = Math.floor(availableFunds / buyQuote.unit_price);
            if (finalQty < 1) {
              s = appendLog(s, `${ship.name}: insufficient funds after re-quote, resetting`);
              if (plan.buyPortId) delete s.claimed[claimKey(plan.goodId, plan.buyPortId)];
              s.ships = { ...s.ships, [ship.id]: { phase: "idle" } };
              continue;
            }
            // One final re-quote for the verified affordable amount
            const finalQuote = await tradeApi.createQuote({ port_id: ship.port_id, good_id: plan.goodId, quantity: finalQty, action: "buy" });
            await tradeApi.executeQuote({ token: finalQuote.token, destinations: [{ type: "ship", id: ship.id, quantity: finalQty }] });
            availableFunds -= finalQty * finalQuote.unit_price;
            const sellLegs = plan.sellLegs ?? [];
            const newPlan: ShipPlan = { goodId: plan.goodId, goodName: plan.goodName, quantity: finalQty, actualBuyPrice: finalQuote.unit_price, legs: sellLegs.slice(1), sellPortId: plan.sellPortId, sellPrice: plan.sellPrice };
            s.ships = { ...s.ships, [ship.id]: { phase: "transiting_to_sell", plan: newPlan } };
            if (sellLegs.length > 0) await fleetApi.transit(ship.id, { route_id: sellLegs[0].routeId });
            if (plan.buyPortId) delete s.claimed[claimKey(plan.goodId, plan.buyPortId)];
            s.claimed = { ...s.claimed, [claimKey(plan.goodId, plan.sellPortId)]: ship.id };
            s = appendLog(s, `${ship.name}: bought ${finalQty}× ${goodName(plan.goodId)} @ £${finalQuote.unit_price} → ${portName(plan.sellPortId)}`);
            continue;
          }

          await tradeApi.executeQuote({
            token: buyQuote.token,
            destinations: [{ type: "ship", id: ship.id, quantity: actualQty }],
          });
          availableFunds -= actualQty * buyQuote.unit_price;

          const sellLegs = plan.sellLegs ?? [];
          const newPlan: ShipPlan = {
            goodId:          plan.goodId,
            goodName:        plan.goodName,
            quantity:        actualQty,
            actualBuyPrice:  buyQuote.unit_price,
            legs:            sellLegs.slice(1),
            sellPortId:      plan.sellPortId,
            sellPrice:       plan.sellPrice,
          };
          s.ships = { ...s.ships, [ship.id]: { phase: "transiting_to_sell", plan: newPlan } };

          if (sellLegs.length > 0) {
            await fleetApi.transit(ship.id, { route_id: sellLegs[0].routeId });
          }

          if (plan.buyPortId) delete s.claimed[claimKey(plan.goodId, plan.buyPortId)];
          s.claimed = { ...s.claimed, [claimKey(plan.goodId, plan.sellPortId)]: ship.id };

          const estProfit = (plan.sellPrice - buyQuote.unit_price) * actualQty;
          s = appendLog(s, `${ship.name}: bought ${actualQty}× ${goodName(plan.goodId)} @ £${buyQuote.unit_price} → ${portName(plan.sellPortId)} (est. +£${Math.round(estProfit).toLocaleString()})`);
        } catch (e: unknown) {
          s = appendLog(s, `${ship.name}: buy failed — ${(e as Error).message}, resetting`);
          if (plan.buyPortId) delete s.claimed[claimKey(plan.goodId, plan.buyPortId)];
          s.ships = { ...s.ships, [ship.id]: { phase: "idle" } };
        }
        continue;
      }

      // ── Arrived at sell port (or waypoint) ─────────────────────────────────
      if (ss.phase === "transiting_to_sell" && ss.plan) {
        const plan = ss.plan;

        if (plan.legs.length > 0 && ship.port_id !== plan.sellPortId) {
          const nextLeg = plan.legs[0];
          try {
            await fleetApi.transit(ship.id, { route_id: nextLeg.routeId });
            s.ships = { ...s.ships, [ship.id]: { phase: "transiting_to_sell", plan: { ...plan, legs: plan.legs.slice(1) } } };
            s = appendLog(s, `${ship.name}: waypoint ${portName(ship.port_id)} → ${portName(nextLeg.toPortId)}`);
          } catch (e: unknown) {
            s = appendLog(s, `${ship.name}: waypoint transit failed — ${(e as Error).message}`);
          }
          continue;
        }

        if (ship.port_id !== plan.sellPortId) {
          s = appendLog(s, `${ship.name}: unexpected port ${portName(ship.port_id)} (expected ${portName(plan.sellPortId)}) — attempting sell here`);
          // Try selling at the current port before giving up
          let soldAtUnexpected = false;
          try {
            const uSellQuote = await tradeApi.createQuote({
              port_id: ship.port_id,
              good_id: plan.goodId,
              quantity: plan.quantity,
              action: "sell",
            });
            await tradeApi.executeQuote({
              token: uSellQuote.token,
              destinations: [{ type: "ship", id: ship.id, quantity: plan.quantity }],
            });
            const uProfit = (uSellQuote.unit_price - plan.actualBuyPrice) * plan.quantity;
            s.profitAccrued += uProfit;
            s = appendLog(s, `${ship.name}: sold ${plan.quantity}× @ £${uSellQuote.unit_price} at unexpected port — profit +£${Math.round(uProfit).toLocaleString()}`);
            soldAtUnexpected = true;
          } catch {
            // NPC sell failed — try market order
            try {
              const askPrice = Math.round(plan.actualBuyPrice * 1.15);
              await marketApi.createOrder({
                port_id: ship.port_id,
                good_id: plan.goodId,
                total: plan.quantity,
                price: askPrice,
                side: "sell",
              });
              s = appendLog(s, `${ship.name}: posted sell order — ${plan.quantity}× ${goodName(plan.goodId)} @ £${askPrice}`);
              soldAtUnexpected = true;
            } catch (e2: unknown) {
              s = appendLog(s, `${ship.name}: sell failed at unexpected port — ${(e2 as Error).message}`);
            }
          }
          if (!soldAtUnexpected) {
            s = appendLog(s, `${ship.name}: could not sell at unexpected port, resetting`);
          }
          delete s.claimed[claimKey(plan.goodId, plan.sellPortId)];
          s.ships = { ...s.ships, [ship.id]: { phase: "idle" } };
          continue;
        }

        s = appendLog(s, `${ship.name}: arrived at ${portName(ship.port_id)}, selling ${plan.quantity}× ${goodName(plan.goodId)}…`);

        // ── Stockpile check: if price is too low and we have a warehouse, store instead ──
        const arrivalPriceLevel = npcMaxOrd.get(`${ship.port_id}:${plan.goodId}`) ?? 0;
        const arrivalWarehouse  = warehouseByPort.get(ship.port_id);
        if (ENABLE_STOCKPILING && arrivalPriceLevel > 0 && arrivalPriceLevel <= STOCKPILE_PRICE_LEVEL && arrivalWarehouse) {
          try {
            await fleetApi.transferToWarehouse(ship.id, {
              warehouse_id: arrivalWarehouse.id,
              good_id:      plan.goodId,
              quantity:     plan.quantity,
            });
            await upsertWarehouseStock(companyId, {
              warehouseId:  arrivalWarehouse.id,
              portId:       ship.port_id,
              goodId:       plan.goodId,
              goodName:     plan.goodName,
              avgBuyPrice:  plan.actualBuyPrice,
            });
            // Update local inventory map so warehouse sell scan sees it next cycle
            const existing = warehouseInventory.get(arrivalWarehouse.id) ?? [];
            const idx = existing.findIndex((i: WarehouseInventory) => i.good_id === plan.goodId);
            if (idx >= 0) {
              existing[idx] = { ...existing[idx], quantity: existing[idx].quantity + plan.quantity };
            } else {
              existing.push({ id: "", warehouse_id: arrivalWarehouse.id, good_id: plan.goodId, quantity: plan.quantity });
            }
            warehouseInventory.set(arrivalWarehouse.id, existing);
            delete s.claimed[claimKey(plan.goodId, plan.sellPortId)];
            s.ships = { ...s.ships, [ship.id]: { phase: "idle" } };
            s = appendLog(s, `${ship.name}: price "${priceLevelLabel(arrivalPriceLevel)}" too low — stockpiled ${plan.quantity}× ${goodName(plan.goodId)} in warehouse at ${portName(ship.port_id)}`);
            continue;
          } catch (e: unknown) {
            s = appendLog(s, `${ship.name}: stockpile failed (${(e as Error).message}) — attempting NPC sell`);
          }
        }

        let sold = false;

        try {
          const sellQuote = await tradeApi.createQuote({
            port_id: ship.port_id,
            good_id: plan.goodId,
            quantity: plan.quantity,
            action: "sell",
          });
          await tradeApi.executeQuote({
            token: sellQuote.token,
            destinations: [{ type: "ship", id: ship.id, quantity: plan.quantity }],
          });
          const profit = (sellQuote.unit_price - plan.actualBuyPrice) * plan.quantity;
          s.profitAccrued += profit;
          s = appendLog(s, `${ship.name}: sold ${plan.quantity}× @ £${sellQuote.unit_price} — profit +£${Math.round(profit).toLocaleString()}`);
          sold = true;
        } catch (e: unknown) {
          s = appendLog(s, `${ship.name}: NPC sell failed (${(e as Error).message}) — posting sell order`);
        }

        if (!sold) {
          try {
            const askPrice = Math.round(plan.actualBuyPrice * 1.15);
            await marketApi.createOrder({
              port_id: ship.port_id,
              good_id: plan.goodId,
              total: plan.quantity,
              price: askPrice,
              side: "sell",
            });
            s = appendLog(s, `${ship.name}: posted sell order — ${plan.quantity}× ${goodName(plan.goodId)} @ £${askPrice}`);
          } catch (e: unknown) {
            s = appendLog(s, `${ship.name}: all sell attempts failed — ${(e as Error).message}`);
          }
        }

        delete s.claimed[claimKey(plan.goodId, plan.sellPortId)];
        s.ships = { ...s.ships, [ship.id]: { phase: "idle" } };
        continue;
      }

      // ── Idle: scan for arbitrage ────────────────────────────────────────────
      if (ss.phase === "idle") {
        const capacity = stMap.get(ship.ship_type_id)?.capacity ?? 20;
        const qty      = Math.min(capacity, MAX_UNITS);
        const portId   = ship.port_id!;

        // ── Auto-buy warehouse at this port if none exists ────────────────────
        if (!warehouseByPort.has(portId) && availableFunds > bankingCap) {
          try {
            const newWarehouse = await warehousesApi.buyWarehouse({ port_id: portId });
            warehouseByPort.set(portId, newWarehouse);
            s = { ...s, warehousedPortIds: [...s.warehousedPortIds, portId] };
            s = appendLog(s, `🏗️ ${ship.name}: bought warehouse at ${portName(portId)}`);
          } catch (e: unknown) {
            s = appendLog(s, `${ship.name}: warehouse purchase at ${portName(portId)} failed — ${(e as Error).message}`);
          }
        }

        // ── Warehouse pickup: load stockpiled goods from local warehouse ──────
        const localWarehouse = warehouseByPort.get(portId);
        if (localWarehouse) {
          const localInv = warehouseInventory.get(localWarehouse.id) ?? [];
          for (const item of localInv) {
            if (item.quantity <= 0) continue;
            // Find the best sell destination for this good
            const sellPaths = findPaths(portId, allRoutes, 99);
            let bestSellPath: typeof sellPaths[0] | null = null;
            let bestLevel = 0;
            for (const sp of sellPaths) {
              const level = npcMaxOrd.get(`${sp.destPortId}:${item.good_id}`) ?? 0;
              if (level >= MIN_SELL_PRICE_LEVEL && level > bestLevel) {
                bestLevel = level;
                bestSellPath = sp;
              }
            }
            if (!bestSellPath) continue;

            // Check margin using avgBuyPrice from MongoDB
            const avgBuy = stockPrices.get(`${localWarehouse.id}:${item.good_id}`);
            if (!avgBuy) continue;
            // Get actual sell quote to verify
            let sellQuotePrice = 0;
            try {
              const sq = await tradeApi.createQuote({ port_id: bestSellPath.destPortId, good_id: item.good_id, quantity: item.quantity, action: "sell" });
              sellQuotePrice = sq.unit_price;
            } catch { continue; }
            const margin = (sellQuotePrice - avgBuy) / avgBuy;
            if (margin < MIN_MARGIN) continue;

            // Load from warehouse onto ship
            try {
              await warehousesApi.transferToShip(localWarehouse.id, { ship_id: ship.id, good_id: item.good_id, quantity: item.quantity });
              await removeWarehouseStock(companyId, localWarehouse.id, item.good_id).catch(() => {});
              stockPrices.delete(`${localWarehouse.id}:${item.good_id}`);
              // Update local inventory map
              warehouseInventory.set(localWarehouse.id, (warehouseInventory.get(localWarehouse.id) ?? []).filter((i: WarehouseInventory) => i.good_id !== item.good_id));

              const sellLegs = bestSellPath.legs;
              s.ships = {
                ...s.ships,
                [ship.id]: {
                  phase: "transiting_to_sell",
                  plan: {
                    goodId:         item.good_id,
                    goodName:       goodName(item.good_id),
                    quantity:       item.quantity,
                    actualBuyPrice: avgBuy,
                    legs:           sellLegs.slice(1),
                    sellPortId:     bestSellPath.destPortId,
                    sellPrice:      sellQuotePrice,
                  },
                },
              };
              if (sellLegs.length > 0) await fleetApi.transit(ship.id, { route_id: sellLegs[0].routeId });
              const estProfit = (sellQuotePrice - avgBuy) * item.quantity;
              s = appendLog(s, `${ship.name}: loaded ${item.quantity}× ${goodName(item.good_id)} from warehouse → ${portName(bestSellPath.destPortId)} (est. +£${Math.round(estProfit).toLocaleString()})`);
              break; // one pickup per ship per cycle
            } catch (e: unknown) {
              s = appendLog(s, `${ship.name}: warehouse pickup failed — ${(e as Error).message}`);
            }
          }
          // If ship now has a plan from warehouse pickup, skip NPC scan
          if ((s.ships[ship.id]?.phase ?? "idle") !== "idle") continue;
        }

        // ── Sell untracked cargo first ────────────────────────────────────────
        const existingCargo = idleCargoMap.get(ship.id);
        if (existingCargo && existingCargo.length > 0) {
          s = appendLog(s, `${ship.name}: found untracked cargo (${existingCargo.map(c => `${c.quantity}× ${goodName(c.good_id)}`).join(", ")}) — selling`);
          for (const cargoItem of existingCargo) {
            try {
              const sellQuote = await tradeApi.createQuote({
                port_id: portId,
                good_id: cargoItem.good_id,
                quantity: cargoItem.quantity,
                action: "sell",
              });
              await tradeApi.executeQuote({
                token: sellQuote.token,
                destinations: [{ type: "ship", id: ship.id, quantity: cargoItem.quantity }],
              });
              s = appendLog(s, `${ship.name}: sold untracked ${cargoItem.quantity}× ${goodName(cargoItem.good_id)} @ £${sellQuote.unit_price}`);
            } catch {
              // NPC won't buy — try market order
              try {
                await marketApi.createOrder({
                  port_id: portId,
                  good_id: cargoItem.good_id,
                  total: cargoItem.quantity,
                  price: 1,
                  side: "sell",
                });
                s = appendLog(s, `${ship.name}: posted market sell for untracked ${cargoItem.quantity}× ${goodName(cargoItem.good_id)}`);
              } catch (e2: unknown) {
                s = appendLog(s, `${ship.name}: could not sell untracked ${goodName(cargoItem.good_id)} — ${(e2 as Error).message}`);
              }
            }
          }
          // Re-fetch treasury after unexpected sales
          try {
            const refreshed = await companyApi.getCompany();
            availableFunds = refreshed.treasury;
          } catch { /* ignore */ }
        }

        // ── Idle: pick from pre-computed sell-quote pool ──────────────────────
        // Track when the ship first became idle (resets when dispatched)
        if (!ss.idleSince) {
          s.ships = { ...s.ships, [ship.id]: { ...ss, idleSince: new Date().toISOString() } };
        }
        const idleMs   = ss.idleSince ? Date.now() - new Date(ss.idleSince).getTime() : 0;
        const portPool = portScanCache.get(portId) ?? [];
        // Filter out routes already claimed by another ship this cycle
        const available = portPool.filter(
          (c) => !s.claimed[claimKey(c.goodId, c.buyPortId)] ||
                  s.claimed[claimKey(c.goodId, c.buyPortId)] === ship.id,
        );

        // ── Idle timeout: roam if stuck too long ──────────────────────────────
        if (available.length === 0) {
          if (idleMs > IDLE_TIMEOUT_MS) {
            const roamPaths = findPaths(portId, allRoutes, 99)
              .filter((p) => p.destPortId !== portId && npcGoods.has(p.destPortId))
              .sort((a, b) => a.totalDistance - b.totalDistance);
            const roamTarget = roamPaths[0];
            if (roamTarget) {
              try {
                await fleetApi.transit(ship.id, { route_id: roamTarget.legs[0].routeId });
                s.ships = {
                  ...s.ships,
                  [ship.id]: {
                    phase: "transiting_to_buy",
                    plan: {
                      goodId: "roaming", goodName: "roaming", quantity: 0,
                      actualBuyPrice: 0, legs: roamTarget.legs.slice(1),
                      buyPortId: roamTarget.destPortId,
                      sellPortId: roamTarget.destPortId, sellLegs: [], sellPrice: 0,
                    },
                  },
                };
                s = appendLog(s, `${ship.name}: idle ${Math.round(idleMs / 60_000)}min at ${portName(portId)}, no trades — roaming to ${portName(roamTarget.destPortId)}`);
              } catch (e: unknown) {
                s = appendLog(s, `${ship.name}: roam transit failed — ${(e as Error).message}`);
              }
            } else {
              s = appendLog(s, `${ship.name}: idle ${Math.round(idleMs / 60_000)}min — no profitable trade and no roam targets`);
            }
          } else {
            s = appendLog(s, `${ship.name}: no profitable trade found this cycle`);
          }
          continue;
        }

        // ── Batch buy quotes for top available candidates ─────────────────────
        const buyBatch = available.slice(0, BUY_BATCH);
        s = appendLog(s, `${ship.name}: 🔍 checking ${buyBatch.length} candidate(s) (pool: ${available.length})…`);

        let batchBuyItems: Awaited<ReturnType<typeof tradeApi.batchCreateQuotes>> = [];
        try {
          batchBuyItems = await tradeApi.batchCreateQuotes({
            requests: buyBatch.map((c) => ({
              port_id:  c.buyPortId,
              good_id:  c.goodId,
              quantity: qty,
              action:   "buy" as const,
            })),
          });
        } catch (e: unknown) {
          s = appendLog(s, `${ship.name}: batch buy quote failed — ${(e as Error).message}`);
          continue;
        }

        let executed = false;
        for (let ci = 0; ci < buyBatch.length; ci++) {
          const buyItem = batchBuyItems[ci];
          const c       = buyBatch[ci];
          if (!buyItem || buyItem.status !== "success" || !buyItem.quote || !buyItem.token) {
            const msg = buyItem?.status === "error" ? buyItem.message : "no response";
            s = appendLog(s, `  [buy] ${goodName(c.goodId)} @ ${portName(c.buyPortId)}: ✗ ${msg}`);
            continue;
          }
          const margin   = (c.npcSellPrice - buyItem.quote.unit_price) / buyItem.quote.unit_price;
          const isGlobal = c.toLegsBuy.length > 0;
          s = appendLog(
            s,
            `  [buy] ${goodName(c.goodId)}: buy@${portName(c.buyPortId)}=£${buyItem.quote.unit_price} sell@${portName(c.sellPortId)}=£${c.npcSellPrice} margin=${(margin * 100).toFixed(1)}% ${margin >= MIN_MARGIN ? "✓" : `✗ (< ${(MIN_MARGIN * 100).toFixed(0)}%)`}${isGlobal ? " [global]" : ""}`,
          );

          if (margin < MIN_MARGIN) continue;

          if (availableFunds < buyItem.quote.unit_price) {
            s = appendLog(s, `${ship.name}: insufficient funds (£${availableFunds.toLocaleString()} < £${buyItem.quote.unit_price}/unit for ${goodName(c.goodId)}), skipping`);
            continue;
          }

          try {
            if (isGlobal) {
              const maxAffordable = Math.floor(availableFunds / buyItem.quote.unit_price);
              const reserveQty    = Math.min(qty, maxAffordable);
              await fleetApi.transit(ship.id, { route_id: c.toLegsBuy[0].routeId });
              s.claimed = { ...s.claimed, [claimKey(c.goodId, c.buyPortId)]: ship.id };
              s.ships = {
                ...s.ships,
                [ship.id]: {
                  phase: "transiting_to_buy",
                  plan: {
                    goodId:         c.goodId,
                    goodName:       goodName(c.goodId),
                    quantity:       reserveQty,
                    actualBuyPrice: 0,
                    legs:           c.toLegsBuy.slice(1),
                    buyPortId:      c.buyPortId,
                    sellPortId:     c.sellPortId,
                    sellLegs:       c.sellLegs,
                    sellPrice:      c.npcSellPrice,
                  },
                },
              };
              availableFunds -= reserveQty * buyItem.quote.unit_price;
              const estProfit = (c.npcSellPrice - buyItem.quote.unit_price) * reserveQty;
              s = appendLog(s, `${ship.name}: heading to ${portName(c.buyPortId)} to buy ${reserveQty}× ${goodName(c.goodId)}, then → ${portName(c.sellPortId)} (est. +£${Math.round(estProfit).toLocaleString()})`);
            } else {
              const freshQuote = await tradeApi.createQuote({ port_id: portId, good_id: c.goodId, quantity: qty, action: "buy" });
              const freshAffordable = Math.floor(availableFunds / freshQuote.unit_price);
              const buyQty = Math.min(qty, freshAffordable);
              if (buyQty < 1) {
                s = appendLog(s, `${ship.name}: insufficient funds after fresh quote (£${availableFunds.toLocaleString()} at £${freshQuote.unit_price}/unit), skipping`);
                continue;
              }
              if (buyQty < qty) {
                s = appendLog(s, `${ship.name}: funds capped — buying ${buyQty}× instead of ${qty}×`);
              }
              const buyToken = buyQty < qty
                ? (await tradeApi.createQuote({ port_id: portId, good_id: c.goodId, quantity: buyQty, action: "buy" })).token
                : freshQuote.token;
              await tradeApi.executeQuote({ token: buyToken, destinations: [{ type: "ship", id: ship.id, quantity: buyQty }] });
              availableFunds -= buyQty * freshQuote.unit_price;
              await fleetApi.transit(ship.id, { route_id: c.sellLegs[0].routeId });
              s.claimed = { ...s.claimed, [claimKey(c.goodId, portId)]: ship.id };
              s.ships = {
                ...s.ships,
                [ship.id]: {
                  phase: "transiting_to_sell",
                  plan: {
                    goodId:         c.goodId,
                    goodName:       goodName(c.goodId),
                    quantity:       buyQty,
                    actualBuyPrice: freshQuote.unit_price,
                    legs:           c.sellLegs.slice(1),
                    sellPortId:     c.sellPortId,
                    sellPrice:      c.npcSellPrice,
                  },
                },
              };
              const estProfit = (c.npcSellPrice - freshQuote.unit_price) * buyQty;
              s = appendLog(s, `${ship.name}: bought ${buyQty}× ${goodName(c.goodId)} @ £${freshQuote.unit_price} → ${portName(c.sellPortId)} (est. +£${Math.round(estProfit).toLocaleString()})`);
            }
            executed = true;
            break;
          } catch (e: unknown) {
            s = appendLog(s, `${ship.name}: dispatch failed — ${(e as Error).message}`);
          }
        }

        if (!executed) {
          s = appendLog(s, `${ship.name}: all buy candidates exhausted this cycle`);
        }
      }
    }
  } catch (e: unknown) {
    s = appendLog(s, `Cycle error: ${(e as Error).message}`);
  }

  return s;
}
