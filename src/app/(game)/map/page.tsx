"use client";

import { useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { fleetApi } from "@/lib/api/fleet";
import { worldApi } from "@/lib/api/world";
import type { Port, Route, Ship } from "@/lib/types";
import { useAutopilot } from "@/hooks/use-autopilot";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";

// ── Leaflet must be loaded client-side only ────────────────────────────────
const LeafletMap = dynamic(() => import("./_map"), { ssr: false, loading: () => (
  <div className="flex h-full items-center justify-center bg-[#0d1b2a]">
    <Spinner />
  </div>
)});

// ── Port coordinates ───────────────────────────────────────────────────────
// (defined in @/lib/map-data)

// ── Kruskal MST ────────────────────────────────────────────────────────────
// (defined in @/lib/map-data)

// ── Page ───────────────────────────────────────────────────────────────────
export default function MapPage() {
  const [ports,   setPorts]   = useState<Port[]>([]);
  const [routes,  setRoutes]  = useState<Route[]>([]);
  const [ships,   setShips]   = useState<Ship[]>([]);
  const [loading, setLoading] = useState(true);
  const [hovered,      setHovered]      = useState<string | null>(null);
  const [hoveredPort,  setHoveredPort]  = useState<string | null>(null);
  const { state: ap } = useAutopilot();

  useEffect(() => {
    Promise.all([worldApi.getPorts(), worldApi.getRoutes(), fleetApi.getShips()])
      .then(([p, r, s]) => { setPorts(p as Port[]); setRoutes(r as Route[]); setShips(s as Ship[]); })
      .catch(console.error)
      .finally(() => setLoading(false));

    const id = setInterval(() => {
      fleetApi.getShips().then((s) => setShips(s as Ship[])).catch(() => {});
    }, 10_000);
    return () => clearInterval(id);
  }, []);

  const portById  = useMemo(() => new Map(ports.map((p) => [p.id, p])),  [ports]);
  const routeById = useMemo(() => new Map(routes.map((r) => [r.id, r])), [routes]);

  if (loading) {
    return (
      <div className="flex h-96 items-center justify-center">
        <Spinner />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-bold">World Map</h1>
        <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <span className="inline-block size-3 rounded-full bg-amber-400" /> Hub port
          </span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block size-3 rounded-full bg-sky-400/80" /> Port
          </span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block size-3 rounded-full bg-emerald-400" /> Docked ship
          </span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block size-3 rounded-full bg-rose-400" /> Ship at sea
          </span>
        </div>
      </div>

      {/* Map container — fixed height so Leaflet can measure it */}
      <div className="overflow-hidden rounded-xl border" style={{ height: "520px" }}>
        <LeafletMap
          ports={ports}
          routes={routes}
          ships={ships}
          portById={portById}
          routeById={routeById}
          ap={ap}
          hovered={hovered}
          onHover={setHovered}
          hoveredPort={hoveredPort}
          onPortHover={setHoveredPort}
        />
      </div>

      {/* Ship cards */}
      {ships.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {ships.map((ship) => {
            const docked = !!ship.port_id;
            const ast    = ap.ships[ship.id];
            const route  = routeById.get(ship.route_id ?? "");
            return (
              <div key={ship.id}
                className={`cursor-pointer rounded-lg border p-3 text-sm transition-colors ${
                  hovered === ship.id ? "border-amber-500/50 bg-amber-500/5" : "border-border"
                }`}
                onMouseEnter={() => setHovered(ship.id)}
                onMouseLeave={() => setHovered(null)}>
                <div className="mb-1 flex items-center justify-between">
                  <span className="font-medium">{ship.name}</span>
                  <Badge variant={docked ? "success" : "info"} size="sm">
                    {docked ? "docked" : "at sea"}
                  </Badge>
                </div>
                <p className="text-xs text-muted-foreground">
                  {docked
                    ? `⚓ ${portById.get(ship.port_id!)?.name ?? "unknown"}`
                    : `⛵ ${portById.get(route?.from_id ?? "")?.name ?? "?"} → ${portById.get(route?.to_id ?? "")?.name ?? "?"}`}
                </p>
                {ship.arriving_at && !docked && (
                  <p className="mt-0.5 text-xs text-muted-foreground/60">
                    Arriving {new Date(ship.arriving_at).toLocaleTimeString()}
                  </p>
                )}
                {ast?.plan && (
                  <p className="mt-1 text-xs text-amber-400/90">
                    {ast.phase === "transiting_to_buy"
                      ? `🛒 → ${portById.get(ast.plan.buyPortId ?? "")?.name ?? "?"} (buy)`
                      : ast.phase === "transiting_to_sell"
                      ? `💰 → ${portById.get(ast.plan.sellPortId)?.name ?? "?"} (sell)`
                      : ast.phase}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

