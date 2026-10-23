import { type NextRequest, NextResponse } from "next/server";
import { fleetRivals, getFleetView } from "@/lib/kibb/fleet-registry";
import { analyseRivals, bestMarque, RivalTracker } from "@/lib/kibb/rivals";
import { authorizedCompany, errorResponse, kibb, unauthorizedResponse } from "@/lib/kibb/server";
import { getCompanyKey } from "@/lib/kibb/store";
import type { Catalog, RoutePlan } from "@/lib/kibb/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Routes and the catalog are fixed for a season: cache them for the server's life.
const g = globalThis as { __kibbRivalRoutes?: Map<string, Promise<RoutePlan | null>>; __kibbRivalCatalog?: Promise<Catalog> };
const routes = (g.__kibbRivalRoutes ??= new Map());

/**
 * Rival ships seen at the ports where we have presence (now, plus whatever a running autopilot has
 * collected), their estimated whereabouts, rival traffic per sea zone, and letters of marque: the
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
    const [catalog, clock, profile, player, ships, factors, zones, marques] = await Promise.all([
      g.__kibbRivalCatalog,
      client.clock(),
      client.companyProfile(),
      client.playerProfile().catch(() => null),
      client.ships(),
      client.factors().catch(() => [] as string[]),
      client.zones(),
      client.marques({ limit: 200 }),
    ]);
    // The server clock, carried forward to the end of this (slow) request.
    const serverNow = () => Date.parse(clock.real_utc) + (Date.now() - clockAsked);
    const presence = new Set<string>(factors);
    for (const r of ships) if (r.ship.status !== "sailing" && r.ship.current_port_id) presence.add(r.ship.current_port_id);

    const tracker = new RivalTracker();
    tracker.ours.add(profile.company.name);
    for (const c of player?.companies ?? []) tracker.ours.add(c.name);
    const details = await Promise.all([...presence].map((p) => client.port(p).catch(() => null)));
    for (const d of details) if (d) tracker.addNotices(d.recent_sailings);
    const fleet = fleetRivals(companyId);
    for (const s of fleet.sightings) tracker.add(s);

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
    tracker.prune(serverNow(), gameMinuteMs);
    const piracy = new Map(zones.map((z) => [z.sea_zone_id, z.net_piracy_bps]));
    const { ships: rivals, zones: traffic, windowGameHours } = await analyseRivals(tracker.all(), { catalog, route, now: serverNow(), gameMinuteMs, piracy });
    const now = serverNow();

    // The autopilot's verdicts include our own ships' exposure; without it, judge on rival traffic alone.
    const inForce = new Set(marques.filter((m) => Date.parse(m.expires_at) > now).map((m) => m.sea_zone_id));
    const verdicts =
      fleet.report?.zones ??
      traffic.flatMap((t) => {
        const z = zones.find((x) => x.sea_zone_id === t.zone);
        if (!z) return [];
        const best = bestMarque(z, t.exposure, 0);
        const active = inForce.has(t.zone);
        const verdict = active
          ? "our marque is in force"
          : best.bps === 0
            ? "the zone's marques are at their cap"
            : best.profit > 0
              ? "pays on rival traffic alone (start the autopilot to weigh our own ships)"
              : "doesn't pay";
        return [{ zone: t.zone, passages: t.passages, laden: t.laden, cargo: Math.round(t.cargo), best, active, verdict }];
      });

    const view = await getFleetView(companyId);
    return NextResponse.json({
      now,
      gameMinuteMs,
      windowGameHours,
      presence: [...presence],
      rivals,
      traffic,
      zones,
      verdicts,
      marques,
      report: fleet.report,
      settings: { marques: view.settings.marques, marqueBudgetPence: view.settings.marqueBudgetPence },
      autopilot: view.state?.status ?? "stopped",
    });
  } catch (e) {
    return errorResponse(e);
  }
}
