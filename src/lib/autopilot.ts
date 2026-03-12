
/**
 * Autopilot core cycle — server-only. Imported by the worker process.
 *
 * Phases per ship:
 *   idle              → scan local port first, then global; dispatch to buy or sell
 *   transiting_to_buy → traveling empty to a buy port; buys on arrival then switches phase
 *   transiting_to_sell → has cargo; sells on arrival (or posts limit order as fallback)
 */

import type { Good, Port, Route, Ship, ShipType } from "@/lib/types";
import { companyApi } from "@/lib/api/company";
import { fleetApi } from "@/lib/api/fleet";
import { marketApi } from "@/lib/api/market";
import { tradeApi } from "@/lib/api/trade";
import { worldApi } from "@/lib/api/world";
import {
  appendLog,
  claimKey,
  type AutopilotState,
  type RouteLeg,
  type ShipPlan,
} from "@/lib/autopilot-types";

export * from "@/lib/autopilot-types";

// ── Config ─────────────────────────────────────────────────────────────────────

const MIN_MARGIN   = 0.08;
const MAX_UNITS    = 50;
/** Sell-quote batch size (probes this many (destPort, good) pairs per scan). */
const SELL_BATCH   = 8;
/** Buy-quote batch size (validates top N sell-scored candidates). */
const BUY_BATCH    = 5;
/** Delay (ms) after docking before buying/selling. */
const DOCK_DELAY_MS = 5_000;

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

/** Pick the best prescore candidate per (buyPortId, goodId) to cap batch size. */
/** Keep best candidate per sell-port (ensures we probe different destinations). */
function dedupBestPerSellPort(candidates: RawCandidate[], limit: number): RawCandidate[] {
  const seen = new Map<string, RawCandidate>();
  for (const c of candidates) {
    const k = `${c.sellPortId}:${c.goodId}`;
    if (!seen.has(k) || c.prescore > seen.get(k)!.prescore) seen.set(k, c);
  }
  return [...seen.values()].sort((a, b) => b.prescore - a.prescore).slice(0, limit);
}

// ── Cycle ──────────────────────────────────────────────────────────────────────

export async function runCycle(s: AutopilotState): Promise<AutopilotState> {
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
    const [ships, allRoutes, shipTypes, allPorts, allGoods, company] = await Promise.all([
      fleetApi.getShips().catch((e: Error) => { throw new Error(`getShips: ${e.message}`); }),
      worldApi.getRoutes().catch((e: Error) => { throw new Error(`getRoutes: ${e.message}`); }),
      worldApi.getShipTypes().catch((e: Error) => { throw new Error(`getShipTypes: ${e.message}`); }),
      worldApi.getPorts().catch((e: Error) => { throw new Error(`getPorts: ${e.message}`); }),
      worldApi.getGoods().catch((e: Error) => { throw new Error(`getGoods: ${e.message}`); }),
      companyApi.getCompany().catch((e: Error) => { throw new Error(`getCompany: ${e.message}`); }),
    ]);

    // Track available funds across ships in this cycle to avoid over-committing
    let availableFunds = company.treasury;

    const portName = (id: string | null | undefined) =>
      allPorts.find((p: Port) => p.id === id)?.name ?? (id ?? "?").slice(0, 8);
    const goodName = (id: string) =>
      allGoods.find((g: Good) => g.id === id)?.name ?? id.slice(0, 8);
    const stMap = new Map<string, ShipType>(shipTypes.map((t: ShipType) => [t.id, t]));

    const allTraders = (
      await Promise.all(
        allPorts.map((p: Port) => tradeApi.getTraderPositions(p.id).catch(() => [])),
      )
    ).flat();

    const npcGoods      = new Map<string, Set<string>>();
    const npcPriceLabel = new Map<string, string>();   // "portId:goodId" → "Healthy"|…
    for (const tp of allTraders) {
      if (!npcGoods.has(tp.port_id)) npcGoods.set(tp.port_id, new Set());
      npcGoods.get(tp.port_id)!.add(tp.good_id);
      if (tp.price_bounds) npcPriceLabel.set(`${tp.port_id}:${tp.good_id}`, tp.price_bounds);
    }

    const dockedCount = ships.filter((sh: Ship) => sh.status !== "traveling").length;
    s = appendLog(s, `⟳ Cycle — ${ships.length} ship(s), ${dockedCount} docked`);

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

        // Arrived — buy the goods
        s = appendLog(s, `${ship.name}: arrived at buy port ${portName(ship.port_id)}, buying ${plan.quantity}× ${goodName(plan.goodId)}…`);
        await sleep(DOCK_DELAY_MS);
        try {
          const buyQuote = await tradeApi.createQuote({
            port_id: ship.port_id,
            good_id: plan.goodId,
            quantity: plan.quantity,
            action: "buy",
          });

          const maxAffordable = Math.floor(availableFunds / buyQuote.unit_price);
          const actualQty = Math.min(plan.quantity, maxAffordable);
          if (actualQty < 1) {
            s = appendLog(s, `${ship.name}: insufficient funds (£${availableFunds.toLocaleString()} < £${buyQuote.unit_price}/unit), resetting`);
            if (plan.buyPortId) delete s.claimed[claimKey(plan.goodId, plan.buyPortId)];
            s.ships = { ...s.ships, [ship.id]: { phase: "idle" } };
            continue;
          }
          if (actualQty < plan.quantity) {
            s = appendLog(s, `${ship.name}: funds capped — buying ${actualQty}× instead of ${plan.quantity}×`);
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

        // ── Build candidate list ──────────────────────────────────────────────
        // Check EVERY reachable port as a potential buy port, and every port
        // reachable from there as a potential sell port. No distance penalty —
        // we just want the best price spread and will travel wherever needed.

        const allCandidates: RawCandidate[] = [];

        // All ports reachable from current port (these are candidate buy ports).
        // Current port itself is also a valid buy port (toLegsBuy = []).
        const toBuyPaths = findPaths(portId, allRoutes, 99);
        const buyLocations: Array<{ buyPortId: string; toLegsBuy: RouteLeg[] }> = [
          { buyPortId: portId, toLegsBuy: [] },
          ...toBuyPaths.map((p) => ({ buyPortId: p.destPortId, toLegsBuy: p.legs })),
        ];

        for (const { buyPortId, toLegsBuy } of buyLocations) {
          const buyGoods = npcGoods.get(buyPortId);
          if (!buyGoods) continue;
          // All ports reachable from this buy port (candidate sell ports)
          const fromBuyPaths = findPaths(buyPortId, allRoutes, 99);
          for (const sellPath of fromBuyPaths) {
            const destGoods = npcGoods.get(sellPath.destPortId);
            if (!destGoods) continue;
            for (const goodId of buyGoods) {
              if (!destGoods.has(goodId)) continue;
              if (s.claimed[claimKey(goodId, buyPortId)] &&
                  s.claimed[claimKey(goodId, buyPortId)] !== ship.id) continue;
              const destOrd = priceLevelOrdinal(npcPriceLabel.get(`${sellPath.destPortId}:${goodId}`) ?? "");
              const srcOrd  = priceLevelOrdinal(npcPriceLabel.get(`${buyPortId}:${goodId}`) ?? "");
              // Score purely on price level spread — no distance bias
              const prescore = destOrd - srcOrd;
              allCandidates.push({
                buyPortId,
                sellPortId: sellPath.destPortId,
                sellLegs:   sellPath.legs,
                toLegsBuy,
                goodId,
                prescore,
              });
            }
          }
        }

        if (allCandidates.length === 0) {
          s = appendLog(s, `${ship.name}: no reachable arbitrage candidates from ${portName(portId)}`);
          continue;
        }

        // ── Debug: price_bounds dump ──────────────────────────────────────────
        s = appendLog(s, `${ship.name}: 🔍 ${allCandidates.length} candidate(s) from ${portName(portId)} — price_bounds dump:`);
        const seenGoodDest = new Set<string>();
        for (const c of [...allCandidates].sort((a, b) => b.prescore - a.prescore).slice(0, 10)) {
          const k = `${c.goodId}:${c.sellPortId}`;
          if (seenGoodDest.has(k)) continue;
          seenGoodDest.add(k);
          const srcLabel  = npcPriceLabel.get(`${c.buyPortId}:${c.goodId}`)  ?? "unknown";
          const destLabel = npcPriceLabel.get(`${c.sellPortId}:${c.goodId}`) ?? "unknown";
          const tag = c.toLegsBuy.length > 0 ? ` (travel to buy @ ${portName(c.buyPortId)})` : "";
          s = appendLog(s, `  ${goodName(c.goodId)}: buy@${portName(c.buyPortId)}="${srcLabel}" → sell@${portName(c.sellPortId)}="${destLabel}"${tag}`);
        }

        // ── Batch sell quotes to get actual NPC prices ────────────────────────
        // Deduplicate to one best candidate per (buyPort, good) before batching
        const sellBatch = dedupBestPerSellPort(
          allCandidates.sort((a, b) => b.prescore - a.prescore),
          SELL_BATCH,
        );
        s = appendLog(s, `${ship.name}: fetching sell quotes (batch ${sellBatch.length})…`);

        let batchSellItems: Awaited<ReturnType<typeof tradeApi.batchCreateQuotes>> = [];
        try {
          batchSellItems = await tradeApi.batchCreateQuotes({
            requests: sellBatch.map((c) => ({
              port_id:  c.sellPortId,
              good_id:  c.goodId,
              quantity: qty,
              action:   "sell" as const,
            })),
          });
        } catch (e: unknown) {
          s = appendLog(s, `${ship.name}: batch sell quote failed — ${(e as Error).message}`);
        }

        const scored: ScoredCandidate[] = [];
        for (let i = 0; i < sellBatch.length; i++) {
          const item = batchSellItems[i];
          const c    = sellBatch[i];
          if (!item || item.status !== "success" || !item.quote) {
            const msg = item?.status === "error" ? item.message : "no response";
            s = appendLog(s, `  [sell] ${goodName(c.goodId)} @ ${portName(c.sellPortId)}: ✗ ${msg}`);
            continue;
          }
          s = appendLog(s, `  [sell] ${goodName(c.goodId)} @ ${portName(c.sellPortId)}: NPC pays £${item.quote.unit_price}`);
          scored.push({ ...c, npcSellPrice: item.quote.unit_price });
        }

        // Sort by raw sell price — buy quotes will give us true margin
        scored.sort((a, b) => b.npcSellPrice - a.npcSellPrice);

        if (scored.length === 0) {
          s = appendLog(s, `${ship.name}: no sell quotes succeeded`);
          continue;
        }

        // ── Batch buy quotes for top sell-scored candidates ───────────────────
        const buyBatch = scored.slice(0, BUY_BATCH);
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

          const margin = (c.npcSellPrice - buyItem.quote.unit_price) / buyItem.quote.unit_price;
          const isGlobal = c.toLegsBuy.length > 0;
          s = appendLog(
            s,
            `  [buy] ${goodName(c.goodId)}: buy@${portName(c.buyPortId)}=£${buyItem.quote.unit_price} sell@${portName(c.sellPortId)}=£${c.npcSellPrice} margin=${(margin * 100).toFixed(1)}% ${margin >= MIN_MARGIN ? "✓" : `✗ (< ${(MIN_MARGIN * 100).toFixed(0)}%)`}${isGlobal ? " [global]" : ""}`,
          );

          if (margin < MIN_MARGIN) continue;

          const maxAffordable = Math.floor(availableFunds / buyItem.quote.unit_price);
          const actualQty = Math.min(qty, maxAffordable);
          if (actualQty < 1) {
            s = appendLog(s, `${ship.name}: insufficient funds (£${availableFunds.toLocaleString()} < £${buyItem.quote.unit_price}/unit for ${goodName(c.goodId)}), skipping`);
            continue;
          }
          if (actualQty < qty) {
            s = appendLog(s, `${ship.name}: funds capped — will buy ${actualQty}× instead of ${qty}×`);
          }

          try {
            if (isGlobal) {
              // Travel empty to buy port first — quantity will be re-checked on arrival
              await fleetApi.transit(ship.id, { route_id: c.toLegsBuy[0].routeId });
              s.claimed = { ...s.claimed, [claimKey(c.goodId, c.buyPortId)]: ship.id };
              s.ships = {
                ...s.ships,
                [ship.id]: {
                  phase: "transiting_to_buy",
                  plan: {
                    goodId:         c.goodId,
                    goodName:       goodName(c.goodId),
                    quantity:       actualQty,
                    actualBuyPrice: 0,
                    legs:           c.toLegsBuy.slice(1),
                    buyPortId:      c.buyPortId,
                    sellPortId:     c.sellPortId,
                    sellLegs:       c.sellLegs,
                    sellPrice:      c.npcSellPrice,
                  },
                },
              };
              availableFunds -= actualQty * buyItem.quote.unit_price;
              const estProfit = (c.npcSellPrice - buyItem.quote.unit_price) * actualQty;
              s = appendLog(s, `${ship.name}: heading to ${portName(c.buyPortId)} to buy ${actualQty}× ${goodName(c.goodId)}, then → ${portName(c.sellPortId)} (est. +£${Math.round(estProfit).toLocaleString()})`);
            } else {
              // Buy immediately here, then travel to sell
              await tradeApi.executeQuote({
                token:        buyItem.token,
                destinations: [{ type: "ship", id: ship.id, quantity: actualQty }],
              });
              availableFunds -= actualQty * buyItem.quote.unit_price;
              await fleetApi.transit(ship.id, { route_id: c.sellLegs[0].routeId });
              s.claimed = { ...s.claimed, [claimKey(c.goodId, portId)]: ship.id };
              s.ships = {
                ...s.ships,
                [ship.id]: {
                  phase: "transiting_to_sell",
                  plan: {
                    goodId:         c.goodId,
                    goodName:       goodName(c.goodId),
                    quantity:       actualQty,
                    actualBuyPrice: buyItem.quote.unit_price,
                    legs:           c.sellLegs.slice(1),
                    sellPortId:     c.sellPortId,
                    sellPrice:      c.npcSellPrice,
                  },
                },
              };
              const estProfit = (c.npcSellPrice - buyItem.quote.unit_price) * actualQty;
              s = appendLog(s, `${ship.name}: bought ${actualQty}× ${goodName(c.goodId)} @ £${buyItem.quote.unit_price} → ${portName(c.sellPortId)} (est. +£${Math.round(estProfit).toLocaleString()})`);
            }

            executed = true;
            break;
          } catch (e: unknown) {
            s = appendLog(s, `${ship.name}: dispatch failed — ${(e as Error).message}`);
          }
        }

        if (!executed) {
          s = appendLog(s, `${ship.name}: no profitable trade found this cycle`);
        }
      }
    }
  } catch (e: unknown) {
    s = appendLog(s, `Cycle error: ${(e as Error).message}`);
  }

  return s;
}
