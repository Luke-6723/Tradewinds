import { type NextRequest, NextResponse } from "next/server";
import { fleetRivals, getFleetView } from "@/lib/kibb/fleet-registry";
import { analyseRivals, bestMarque, RECENT_LANDING_GAME_MIN, rivalProfiles, RivalTracker, ZONE_MARQUE_CAP, type MarqueOption, type RivalAnalysis, type RivalsView } from "@/lib/kibb/rivals";
import { authorizedCompany, errorResponse, kibb, unauthorizedResponse } from "@/lib/kibb/server";
import { getCompanyKey } from "@/lib/kibb/store";
import type { Catalog, ExpansionStatus, RoutePlan } from "@/lib/kibb/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Routes and the catalog are fixed for a season: cache them for the server's life.
const g = globalThis as { __kibbRivalRoutes?: Map<string, Promise<RoutePlan | null>>; __kibbRivalCatalog?: Promise<Catalog> };
const routes = (g.__kibbRivalRoutes ??= new Map());
/** Zones quoted for a marque when the autopilot isn't running (the busiest by rival traffic). */
const QUOTED_ZONES = 6;

/**
 * Rival companies and ships: a running autopilot's rival intel and last analysis when it is fresh;
 * otherwise a one-shot look (sailings at the ports where we have presence, plus whatever the
 * autopilot collected, and with rival intel the public policy list). Their estimated whereabouts,
 * rival traffic per sea zone, the expansion charters rivals feed, and letters of marque: the
 * autopilot's last verdicts (or a fresh estimate when it isn't running) and our own marques.
 */
export async function GET(req: NextRequest) {
  let companyId: string | null;
  try {
    companyId = await authorizedCompany(req);
  } catch (e) {
    return unauthorizedResponse(req, e);
  }
  const key = companyId ? await getCompanyKey(companyId) : null;
  if (!companyId || !key) return unauthorizedResponse(req);
  const client = kibb(key.apiKey);

  try {
    g.__kibbRivalCatalog ??= client.catalog().catch((e) => {
      g.__kibbRivalCatalog = undefined;
      throw e;
    });
    const clockAsked = Date.now();
    const [catalog, clock, profile, player, ships, factors, zones, marques, view] = await Promise.all([
      g.__kibbRivalCatalog,
      client.clock(),
      client.companyProfile(),
      client.playerProfile().catch(() => null),
      client.ships(),
      client.factors().catch(() => [] as string[]),
      client.zones(),
      client.marques({ limit: 200 }),
      getFleetView(companyId),
    ]);
    // The server clock, carried forward to the end of this (slow) request.
    const serverNow = () => Date.parse(clock.real_utc) + (Date.now() - clockAsked);
    const presence = new Set<string>(factors);
    for (const r of ships) if (r.ship.status !== "sailing" && r.ship.current_port_id) presence.add(r.ship.current_port_id);

    const gameMinuteMs = 60_000 / (clock.calendar.time_scale || 60);
    const route = (from: string, to: string, shipClass: string) => {
      const k = `${from}>${to}>${shipClass}`;
      let p = routes.get(k);
      if (!p) {
        // A failed lookup isn't kept: the next request tries again.
        p = client.route(from, to, shipClass).catch(() => {
          routes.delete(k);
          return null;
        });
        routes.set(k, p);
      }
      return p;
    };
    const piracy = new Map(zones.map((z) => [z.sea_zone_id, z.net_piracy_bps]));
    const intelOn = view.settings.rivalIntel;

    const fleet = fleetRivals(companyId);
    const tracker = new RivalTracker((good) => catalog.commodities.find((c) => c.id === good)?.base_price_pence ?? 0);
    tracker.ours.add(profile.company.name);
    tracker.ourIds.add(profile.company.id);
    for (const c of player?.companies ?? []) {
      tracker.ours.add(c.name);
      tracker.ourIds.add(c.id);
    }
    let analysis: RivalAnalysis;
    let expansion: ExpansionStatus | null = null;
    if (fleet.intel?.analysis) {
      // The running autopilot read the presence ports and the public lists within minutes: its picture as is.
      tracker.restore(fleet.intel.snapshot);
      for (const s of fleet.intel.sightings) tracker.add(s);
      analysis = fleet.intel.analysis;
    } else {
      // A one-shot look. The board's deliveries need a second look to attribute, so none show here,
      // and with no net-worth history there is no earning rate.
      const [details, policies, exp] = await Promise.all([
        Promise.all([...presence].map((p) => client.port(p).catch(() => null))),
        intelOn ? client.policies({ limit: 200 }).catch(() => null) : null,
        client.expansion().catch(() => null),
      ]);
      expansion = exp;
      if (policies) tracker.addPolicies(policies);
      for (const d of details) {
        if (!d) continue;
        tracker.addNotices(d.recent_sailings);
        // Public forming convoys in the port's news (counted only with rival intel on, never on top of a listed one).
        tracker.addConvoyNotices(d.convoy_notices);
      }
      for (const s of fleet.sightings) tracker.add(s);
      tracker.prune(serverNow(), gameMinuteMs);
      analysis = await analyseRivals(tracker, { catalog, route, now: serverNow(), gameMinuteMs, piracy, intel: intelOn, quotes: new Map(fleet.intel?.quotes ?? []) });
    }
    const now = serverNow();
    const traffic = analysis.zones;

    // The autopilot's verdicts include our own ships' exposure; without it, the game's quote alone (a game day at
    // the most bps the zone's cap allows) for the busiest zones, our own estimate from rival traffic beside it.
    const inForce = new Set(marques.filter((m) => Date.parse(m.expires_at) > now).map((m) => m.sea_zone_id));
    const busiest = new Set([...traffic].sort((a, b) => b.exposure - a.exposure).slice(0, QUOTED_ZONES).map((t) => t.zone));
    const verdicts =
      fleet.report?.zones ??
      (await Promise.all(
        traffic.map(async (t) => {
          const z = zones.find((x) => x.sea_zone_id === t.zone);
          if (!z) return null;
          const est = bestMarque(z, t.exposure, 0);
          const active = inForce.has(t.zone);
          const top = Math.floor(Math.min(1_500, ZONE_MARQUE_CAP - z.marque_piracy_bps) / 50) * 50;
          const q = !active && top >= 50 && busiest.has(t.zone) ? await client.marqueQuote(t.zone, top, 24).catch(() => null) : null;
          const best: MarqueOption = q
            ? { bps: q.added_piracy_bps, prize: q.expected_net_prize_pence, cost: q.cost_pence, ownLoss: 0, profit: q.expected_net_prize_pence - q.cost_pence, quoted: true, rivalPrize: est.prize, floor: q.floor_applied }
            : est;
          const verdict = active
            ? "our marque is in force"
            : best.bps === 0
              ? "the zone's marques are at their cap"
              : !q
                ? "not quoted (start the autopilot to quote and weigh our own ships)"
                : q.floor_applied
                  ? "the zone's traffic is worth less than the price floor"
                  : best.profit > 0
                    ? "pays on the quote if traffic holds (start the autopilot to weigh our own ships)"
                    : "doesn't pay";
          return { zone: t.zone, passages: t.passages, laden: t.laden, cargo: Math.round(t.cargo), next: t.next, best, active, verdict };
        }),
      )).filter((v): v is NonNullable<typeof v> => v !== null);

    // The expansion charters of the tier in play: as the running autopilot follows them, else as listed now.
    const running = view.state?.status === "running" ? view.state.expansion : null;
    const tier = expansion?.current_tier && !expansion.current_tier.completed ? expansion.current_tier : null;
    const posted = running
      ? running.charters.map((c) => ({ port: c.port, good: c.good, stalled: c.stalled, expiresAt: c.expiresAt }))
      : (tier?.charters ?? [])
          .filter((c) => c.status === "open")
          .map((c) => ({ port: c.port_id, good: c.commodity_id, stalled: c.quantity_delivered === 0, expiresAt: c.expires_at ? Date.parse(c.expires_at) || null : null }));
    const phase = running?.targetPhase ?? tier?.target_phase ?? null;
    const delivered = phase === null ? [] : tracker.deliveriesSeen(phase, 600);
    const landings = new Map(analysis.landings);
    const recent = now - RECENT_LANDING_GAME_MIN * gameMinuteMs;
    const charters: RivalsView["charters"] = posted.map((c) => {
      const mine = delivered.filter((d) => d.port === c.port && d.good === c.good);
      const by = new Map<string, number>();
      for (const d of mine) by.set(d.company ?? "unattributed", (by.get(d.company ?? "unattributed") ?? 0) + d.tons);
      return {
        port: c.port,
        good: c.good,
        rivalTons: [...by].sort((a, b) => b[1] - a[1]),
        lastAt: mine.length ? Math.max(...mine.map((d) => d.at)) : null,
        stalled: c.stalled,
        expiresAt: c.expiresAt,
        dueBeforeLapse: (landings.get(c.port) ?? []).filter((l) => l.load !== "ballast" && l.at >= recent && l.at <= (c.expiresAt ?? Infinity)).length,
        survival: running?.stallOdds?.[`${c.port}|${c.good}`] ?? null,
      };
    });

    const last = tracker.ownWorth.at(-1);
    const body: RivalsView = {
      now,
      gameMinuteMs,
      windowGameHours: analysis.windowGameHours,
      presence: [...presence],
      rivals: analysis.ships,
      traffic,
      zones,
      verdicts,
      marques,
      report: fleet.report,
      settings: { marques: view.settings.marques, marqueBudgetPence: view.settings.marqueBudgetPence, rivalIntel: intelOn },
      profiles: rivalProfiles(tracker, analysis, now),
      you: last ? { netWorth: last[1], rank: last[2], earnPerHour: tracker.earnRate(null) } : null,
      coverage: { quayPorts: presence.size, ...tracker.counts(), activeCompanies: fleet.intel?.activeCompanies ?? expansion?.active_trading_companies ?? null },
      charters,
      autopilot: view.state?.status ?? "stopped",
    };
    return NextResponse.json(body);
  } catch (e) {
    return errorResponse(e);
  }
}
