/**
 * Autopilot core cycle — server-only. Imported by the worker process.
 *
 * runCycle() is a pure function: accepts current state, returns updated state.
 * It makes no assumptions about how state is persisted or how the loop runs.
 */

import type { Good, Port, Route, Ship, ShipType } from "@/lib/types";
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

const MIN_MARGIN = 0.08;
const MAX_UNITS = 50;
const MAX_HOPS = 2;

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
      const newLegs = [...legs, { toPortId: r.to_id, routeId: r.id, distance: r.distance }];
      const newDist = dist + r.distance;
      results.push({ destPortId: r.to_id, legs: newLegs, totalDistance: newDist });
      queue.push({ portId: r.to_id, legs: newLegs, dist: newDist });
    }
  }
  return results;
}

// ── Cycle ──────────────────────────────────────────────────────────────────────

export async function runCycle(s: AutopilotState): Promise<AutopilotState> {
  s = { ...s, lastCycleAt: new Date().toISOString() };

  // Purge stale claims
  const activeClaims: Record<string, string> = {};
  for (const [key, shipId] of Object.entries(s.claimed)) {
    if (s.ships[shipId]?.phase === "transiting_to_sell") activeClaims[key] = shipId;
  }
  s = { ...s, claimed: activeClaims };

  try {
    const [ships, allRoutes, shipTypes, allPorts, allGoods] = await Promise.all([
      fleetApi.getShips().catch((e: Error) => { throw new Error(`getShips: ${e.message}`); }),
      worldApi.getRoutes().catch((e: Error) => { throw new Error(`getRoutes: ${e.message}`); }),
      worldApi.getShipTypes().catch((e: Error) => { throw new Error(`getShipTypes: ${e.message}`); }),
      worldApi.getPorts().catch((e: Error) => { throw new Error(`getPorts: ${e.message}`); }),
      worldApi.getGoods().catch((e: Error) => { throw new Error(`getGoods: ${e.message}`); }),
    ]);

    const portName = (id: string | null | undefined) =>
      allPorts.find((p: Port) => p.id === id)?.name ?? (id ?? "?").slice(0, 8);
    const goodName = (id: string) =>
      allGoods.find((g: Good) => g.id === id)?.name ?? id.slice(0, 8);
    const stMap = new Map<string, ShipType>(shipTypes.map((t: ShipType) => [t.id, t]));

    // Fetch trader positions for ALL ports so we know NPC goods everywhere
    const allTraders = (
      await Promise.all(
        allPorts.map((p: Port) => tradeApi.getTraderPositions(p.id).catch(() => [])),
      )
    ).flat();

    const npcGoods = new Map<string, Set<string>>();
    for (const tp of allTraders) {
      if (!npcGoods.has(tp.port_id)) npcGoods.set(tp.port_id, new Set());
      npcGoods.get(tp.port_id)!.add(tp.good_id);
    }

    const dockedCount = ships.filter((sh: Ship) => sh.status !== "traveling").length;
    s = appendLog(s, `⟳ Cycle — ${ships.length} ship(s), ${dockedCount} docked`);

    for (const ship of ships) {
      const ss = s.ships[ship.id] ?? { phase: "idle" };

      // ── Traveling ──────────────────────────────────────────────────────────
      if (ship.status === "traveling") {
        if (ss.phase === "transiting_to_sell" && ss.plan) {
          const dest = ss.plan.legs[0]?.toPortId ?? ss.plan.sellPortId;
          s = appendLog(s, `${ship.name}: ✈ traveling to ${portName(dest)}`);
        }
        continue;
      }

      if (!ship.port_id) continue;

      // ── Arrived: handle waypoint or sell ────────────────────────────────────
      if (ss.phase === "transiting_to_sell" && ss.plan) {
        const plan = ss.plan;

        if (plan.legs.length > 0 && ship.port_id !== plan.sellPortId) {
          const nextLeg = plan.legs[0];
          const updatedPlan: ShipPlan = { ...plan, legs: plan.legs.slice(1) };
          try {
            await fleetApi.transit(ship.id, { route_id: nextLeg.routeId });
            s.ships = { ...s.ships, [ship.id]: { phase: "transiting_to_sell", plan: updatedPlan } };
            s = appendLog(s, `${ship.name}: waypoint ${portName(ship.port_id)} → continuing to ${portName(nextLeg.toPortId)}`);
          } catch (e: unknown) {
            s = appendLog(s, `${ship.name}: waypoint transit failed — ${(e as Error).message}`);
          }
          continue;
        }

        if (ship.port_id !== plan.sellPortId) {
          s = appendLog(s, `${ship.name}: unexpected port ${portName(ship.port_id)}, resetting`);
          delete s.claimed[claimKey(plan.goodId, plan.sellPortId)];
          s.ships = { ...s.ships, [ship.id]: { phase: "idle" } };
          continue;
        }

        s = appendLog(s, `${ship.name}: arrived at ${portName(ship.port_id)}, selling ${plan.quantity}× ${goodName(plan.goodId)}…`);
        let sold = false;

        // Attempt 1: NPC sell quote
        try {
          const sellQuote = await tradeApi.createQuote({ port_id: ship.port_id, good_id: plan.goodId, quantity: plan.quantity, action: "sell" });
          await tradeApi.executeQuote({ token: sellQuote.token, destinations: [{ type: "ship", id: ship.id, quantity: plan.quantity }] });
          const profit = (sellQuote.unit_price - plan.actualBuyPrice) * plan.quantity;
          s.profitAccrued += profit;
          s = appendLog(s, `${ship.name}: sold ${plan.quantity}× @ £${sellQuote.unit_price} — profit +£${Math.round(profit).toLocaleString()}`);
          sold = true;
        } catch (e: unknown) {
          s = appendLog(s, `${ship.name}: NPC sell failed (${(e as Error).message}) — posting sell order`);
        }

        // Attempt 2: post own sell order at 15% markup
        if (!sold) {
          try {
            const askPrice = Math.round(plan.actualBuyPrice * 1.15);
            await marketApi.createOrder({ port_id: ship.port_id, good_id: plan.goodId, total: plan.quantity, price: askPrice, side: "sell" });
            s = appendLog(s, `${ship.name}: posted sell order — ${plan.quantity}× ${goodName(plan.goodId)} @ £${askPrice}`);
            sold = true;
          } catch (e: unknown) {
            s = appendLog(s, `${ship.name}: all sell attempts failed — ${(e as Error).message}`);
          }
        }

        delete s.claimed[claimKey(plan.goodId, plan.sellPortId)];
        s.ships = { ...s.ships, [ship.id]: { phase: "idle" } };
        continue;
      }

      // ── Idle: find best NPC arbitrage opportunity ────────────────────────────
      if (ss.phase === "idle") {
        const localNpcGoods = npcGoods.get(ship.port_id);
        if (!localNpcGoods || localNpcGoods.size === 0) {
          s = appendLog(s, `${ship.name}: no NPC traders at ${portName(ship.port_id)}`);
          continue;
        }

        const paths = findPaths(ship.port_id, allRoutes, MAX_HOPS);
        if (paths.length === 0) {
          s = appendLog(s, `${ship.name}: no routes out of ${portName(ship.port_id)}`);
          continue;
        }

        s = appendLog(s, `${ship.name}: scanning ${paths.length} path(s) × ${localNpcGoods.size} good(s) from ${portName(ship.port_id)}…`);

        interface Candidate {
          path: Path;
          goodId: string;
          npcBuyPrice: number;
          score: number;
        }
        const candidates: Candidate[] = [];
        const capacity = stMap.get(ship.ship_type_id)?.capacity ?? 20;
        const qty = Math.min(capacity, MAX_UNITS);

        const npcDestPaths = paths.filter((p) => {
          const destGoods = npcGoods.get(p.destPortId);
          return destGoods && [...localNpcGoods].some((g) => destGoods.has(g));
        });

        if (npcDestPaths.length === 0) {
          s = appendLog(s, `${ship.name}: no reachable ports with matching NPC goods`);
          continue;
        }

        const npcQueries = npcDestPaths.slice(0, 8).flatMap((path) => {
          const destGoods = npcGoods.get(path.destPortId) ?? new Set<string>();
          return [...localNpcGoods].filter((g) => destGoods.has(g)).map((goodId) => ({ path, goodId }));
        });

        const npcSellResults = await Promise.all(
          npcQueries.map(({ path, goodId }) =>
            tradeApi.createQuote({ port_id: path.destPortId, good_id: goodId, quantity: qty, action: "sell" })
              .then((q) => ({ path, goodId, npcBuyPrice: q.unit_price }))
              .catch(() => null),
          ),
        );

        for (const r of npcSellResults) {
          if (!r || !r.npcBuyPrice) continue;
          if (s.claimed[claimKey(r.goodId, ship.port_id)] &&
              s.claimed[claimKey(r.goodId, ship.port_id)] !== ship.id) continue;
          const score = (r.npcBuyPrice * qty) / Math.max(1, r.path.totalDistance);
          candidates.push({ path: r.path, goodId: r.goodId, npcBuyPrice: r.npcBuyPrice, score });
        }

        candidates.sort((a, b) => b.score - a.score);

        if (candidates.length === 0) {
          s = appendLog(s, `${ship.name}: no NPC arbitrage opportunities found`);
          continue;
        }
        s = appendLog(s, `${ship.name}: ${candidates.length} NPC route(s) — trying best…`);

        let executed = false;
        for (const cand of candidates.slice(0, 5)) {
          const { path, goodId, npcBuyPrice } = cand;

          try {
            const buyQuote = await tradeApi.createQuote({ port_id: ship.port_id, good_id: goodId, quantity: qty, action: "buy" });
            const margin = (npcBuyPrice - buyQuote.unit_price) / buyQuote.unit_price;

            if (margin < MIN_MARGIN) {
              s = appendLog(s, `${ship.name}: skipped ${goodName(goodId)} @ ${portName(path.destPortId)} (margin ${(margin * 100).toFixed(1)}%)`);
              continue;
            }

            await tradeApi.executeQuote({ token: buyQuote.token, destinations: [{ type: "ship", id: ship.id, quantity: qty }] });
            await fleetApi.transit(ship.id, { route_id: path.legs[0].routeId });

            s.claimed = { ...s.claimed, [claimKey(goodId, ship.port_id)]: ship.id };
            s.ships = {
              ...s.ships,
              [ship.id]: {
                phase: "transiting_to_sell",
                plan: {
                  goodId,
                  quantity: qty,
                  actualBuyPrice: buyQuote.unit_price,
                  legs: path.legs.slice(1),
                  sellPortId: path.destPortId,
                  sellPrice: npcBuyPrice,
                },
              },
            };

            const estProfit = (npcBuyPrice - buyQuote.unit_price) * qty;
            const via = path.legs.length > 1
              ? ` via ${path.legs.slice(0, -1).map((l) => portName(l.toPortId)).join(" → ")}`
              : "";
            s = appendLog(
              s,
              `${ship.name}: bought ${qty}× ${goodName(goodId)} @ £${buyQuote.unit_price} → ${portName(path.destPortId)}${via} (est. +£${Math.round(estProfit).toLocaleString()})`,
            );
            executed = true;
            break;
          } catch (e: unknown) {
            s = appendLog(s, `${ship.name}: buy/transit failed — ${(e as Error).message}`);
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
