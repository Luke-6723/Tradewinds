/**
 * Lane planner: which charter to serve, from which source port, for a given hull and position.
 *
 * A lane is "buy good G at source S, carry it to charter port D". It is scored by profit per real
 * hour over one loop (deadhead to S, load, laden passage, unload, sail back to S), so lanes near the
 * ship win ties but a much richer lane further away still wins. Margins net off customs at S, the
 * fee to move charter pay (credited in D's region) to S's region, and the price impact of tons
 * other ships are already bound to buy at S.
 *
 * Only live charters are planned for: gossip copies may already be filled. A load only draws on
 * charters whose own pay clears the landed cost by the minimum margin. The landed cost includes the
 * cargo expected to be lost to pirates on the laden passage (live zone piracy, net of our guns).
 */

import type { ZoneClass } from "../types";
import type { World } from "./world";

export interface ShipSpec {
  shipClass: string;
  hull: ZoneClass;
  /** Unladen speed, knots. */
  knots: number;
  /** Cargo room once guns, stores and sealed freight are aboard. */
  cap: number;
  guns: number;
}

export interface Lane {
  key: string;
  good: string;
  source: string;
  dest: string;
  /** Charters this load fills, best pay first, with the tons going to each. */
  fills: Array<[charterId: string, tons: number]>;
  /** Weighted pay per ton across the charters this load would fill. */
  pay: number;
  /** Lowest pay per ton among those charters: the buy limit is set from this. */
  minPay: number;
  estAsk: number;
  askKnown: boolean;
  /** Landed cost per ton: ask + customs + remittance fee + expected piracy loss. */
  costPerTon: number;
  /** Expected share of the load lost to pirates on the laden passage (bps). */
  piracyBps: number;
  margin: number;
  tons: number;
  loopMs: number;
  profitPerHour: number;
}

/** Tons other ships are bound to deliver (per charter) or buy (per `source|good`). */
export interface Reservations {
  charterTons: Map<string, number>;
  sourceTons: Map<string, number>;
}

/** Estimated ask rise per ton bought, before the ladder re-quotes (~4% for a 30 t hoy load). */
const IMPACT_PER_TON = 0.0013;
/** Charters closing sooner than the ship can deliver plus this are skipped. */
const EXPIRY_SLACK_MS = 10 * 60_000;
/** Fixed per-loop overhead: arrival processing, polling, depart retries. */
const LOOP_OVERHEAD_MS = 60_000;

export async function rankLanes(
  world: World,
  ship: ShipSpec,
  from: string,
  res: Reservations,
  minMargin: number,
): Promise<Lane[]> {
  const lanes: Lane[] = [];
  if (ship.cap <= 0) return lanes;
  const now = world.now();
  const baseLockMs = 30 * world.gameMinuteMs;

  // Group live charters by delivery port and good, best pay first.
  const groups = new Map<string, typeof world.charters>();
  for (const c of world.charters) {
    if (c.stale || !world.isOpen(c.port)) continue;
    const k = `${c.port}|${c.good}`;
    groups.set(k, [...(groups.get(k) ?? []), c]);
  }

  for (const [k, charters] of groups) {
    const [dest, good] = k.split("|");
    charters.sort((a, b) => b.payPerTon - a.payPerTon);

    for (const source of world.sourcesOf(good)) {
      if (source === dest) continue;
      const est = world.estAsk(source, good);
      if (!est) continue; // sold out there until the ladder re-quotes

      let out, back, dead;
      try {
        [out, back, dead] = await Promise.all([
          world.route(source, dest, ship.shipClass),
          world.route(dest, source, ship.shipClass),
          from === source ? Promise.resolve(null) : world.route(from, source, ship.shipClass),
        ]);
      } catch {
        continue;
      }
      if (!world.routeRated(out, ship.hull) || !world.routeRated(back, ship.hull)) continue;
      if (dead && !world.routeRated(dead, ship.hull)) continue;

      const reserved = res.sourceTons.get(`${source}|${good}`) ?? 0;
      const fee = world.remitBps(world.region(dest), world.region(source));
      const piracy = world.piracyLoss(out, ship.guns, ship.knots * 0.8);
      const landed = (ask: number) => (ask * (1 + world.customsBps(source) / 10_000) * (1 + fee / 10_000)) / (1 - piracy);

      // Arrival auto-berths: one base lock at the source, extended per ton handled.
      const deadMs = dead ? world.sailMs(dead.total_distance_nm, ship.knots) : 0;
      const loadEstMs = baseLockMs + ship.cap * world.handlingMsPerTon(source);
      const deliverBy = now + deadMs + loadEstMs + world.sailMs(out.total_distance_nm, ship.knots * 0.8) + baseLockMs + EXPIRY_SLACK_MS;
      const usable = charters.filter((c) => c.expiresAt === null || c.expiresAt >= deliverBy);

      // Conservative landed cost for the load this ship could actually take, for deciding which
      // charters are worth filling at all.
      const avail = Math.min(ship.cap, usable.reduce((n, c) => n + Math.max(0, c.remaining - (res.charterTons.get(c.id) ?? 0)), 0));
      const fullCost = landed(est.ask * (1 + IMPACT_PER_TON * (reserved + avail / 2)));

      let tons = 0;
      let payTotal = 0;
      let minPay = Infinity;
      const fills: Array<[string, number]> = [];
      for (const c of usable) {
        if (c.payPerTon - fullCost < minMargin) break; // sorted by pay: the rest pay even less
        const room = c.remaining - (res.charterTons.get(c.id) ?? 0);
        if (room <= 0) continue;
        const take = Math.min(room, ship.cap - tons);
        tons += take;
        payTotal += take * c.payPerTon;
        minPay = Math.min(minPay, c.payPerTon);
        fills.push([c.id, take]);
        if (tons >= ship.cap) break;
      }
      if (tons < Math.min(10, ship.cap * 0.5)) continue;
      const pay = payTotal / tons;

      const ask = est.ask * (1 + IMPACT_PER_TON * (reserved + tons / 2));
      const costPerTon = landed(ask);
      const margin = pay - costPerTon;
      if (margin < minMargin) continue;

      const fill = tons / ship.cap;
      const loadMs = baseLockMs + tons * world.handlingMsPerTon(source);
      const ladenMs = world.sailMs(out.total_distance_nm, ship.knots * (1 - 0.2 * fill));
      const unloadMs = baseLockMs; // delivered from the roadstead once the base lock clears
      const backMs = world.sailMs(back.total_distance_nm, ship.knots);
      const loopMs = deadMs + loadMs + ladenMs + unloadMs + backMs + LOOP_OVERHEAD_MS;

      lanes.push({
        key: `${good}:${source}>${dest}`,
        good,
        source,
        dest,
        fills,
        pay: Math.round(pay),
        minPay,
        estAsk: Math.round(ask),
        askKnown: est.known,
        costPerTon: Math.round(costPerTon),
        piracyBps: Math.round(piracy * 10_000),
        margin: Math.round(margin),
        tons,
        loopMs,
        // Margin is per ton delivered; pirates are expected to take `piracy` of the tons bought.
        profitPerHour: Math.round((tons * (1 - piracy) * margin * 3_600_000) / loopMs),
      });
    }
  }

  return lanes.sort((a, b) => b.profitPerHour - a.profitPerHour);
}
