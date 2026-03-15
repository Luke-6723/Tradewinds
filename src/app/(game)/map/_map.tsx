"use client";

/**
 * Leaflet map rendered client-side only (imported via next/dynamic in page.tsx).
 * Uses CartoDB Dark Matter tiles — no API key needed.
 */

import {
  MapContainer,
  TileLayer,
  CircleMarker,
  Polyline,
  Tooltip,
} from "react-leaflet";
import "leaflet/dist/leaflet.css";
import type { Port, Route, Ship } from "@/lib/types";
import type { AutopilotState } from "@/lib/autopilot-types";
import { PORT_COORDS, seaLaneWaypoints } from "@/lib/map-data";

// ── Types ──────────────────────────────────────────────────────────────────
interface Props {
  ports:        Port[];
  routes:       Route[];
  ships:        Ship[];
  portById:     Map<string, Port>;
  routeById:    Map<string, Route>;
  ap:           AutopilotState;
  hovered:      string | null;
  onHover:      (id: string | null) => void;
  hoveredPort:  string | null;
  onPortHover:  (id: string | null) => void;
}

// ── Ship position helper ───────────────────────────────────────────────────
function shipLatLng(
  ship: Ship,
  portById: Map<string, Port>,
  routeById: Map<string, Route>,
): [number, number] | null {
  if (ship.port_id) {
    const port = portById.get(ship.port_id);
    if (!port) return null;
    return PORT_COORDS[port.name] ?? null;
  }
  if (ship.route_id) {
    const route  = routeById.get(ship.route_id);
    if (!route) return null;
    const fromPort = portById.get(route.from_id);
    const toPort   = portById.get(route.to_id);
    if (!fromPort || !toPort) return null;
    const from = PORT_COORDS[fromPort.name];
    const to   = PORT_COORDS[toPort.name];
    if (!from || !to) return null;

    let t = 0.5;
    if (ship.arriving_at) {
      const remMs      = new Date(ship.arriving_at).getTime() - Date.now();
      const estTotalMs = route.distance * 60_000;
      t = Math.max(0, Math.min(1, 1 - remMs / estTotalMs));
    }
    return [from[0] + t * (to[0] - from[0]), from[1] + t * (to[1] - from[1])];
  }
  return null;
}

// ── Resolve coords for an ordered list of port IDs ────────────────────────
function portChain(
  portIds: string[],
  portById: Map<string, Port>,
): Array<[number, number]> {
  return portIds.flatMap((id) => {
    const port = portById.get(id);
    if (!port) return [];
    const coords = PORT_COORDS[port.name];
    return coords ? [coords] : [];
  });
}

// ── Main map component ─────────────────────────────────────────────────────
export default function LeafletMap({
  ports, routes, ships, portById, routeById, ap,
  hovered, onHover, hoveredPort, onPortHover,
}: Props) {

  // Set of route IDs actively being traveled
  const activeRouteIds = new Set(ships.map((s) => s.route_id).filter(Boolean) as string[]);

  return (
    <MapContainer
      center={[44, 8]}
      zoom={4}
      minZoom={3}
      maxZoom={10}
      style={{ height: "100%", width: "100%", background: "#0d1b2a" }}
      zoomControl={true}
    >
      {/* Dark nautical tile layer — CartoDB Dark Matter */}
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'
        url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
      />

      {/* Route lines — full network always visible; active routes highlighted */}
      {routes.map((r) => {
        const isActive      = activeRouteIds.has(r.id);
        const isPortHovered = hoveredPort !== null &&
          (r.from_id === hoveredPort || r.to_id === hoveredPort);

        const fromPort = portById.get(r.from_id);
        const toPort   = portById.get(r.to_id);
        if (!fromPort || !toPort) return null;
        const from = PORT_COORDS[fromPort.name];
        const to   = PORT_COORDS[toPort.name];
        if (!from || !to) return null;

        const via = seaLaneWaypoints(fromPort.name, toPort.name);
        const positions: Array<[number, number]> = [from, ...via, to];

        return (
          <Polyline
            key={r.id}
            positions={positions}
            pathOptions={
              isActive
                ? { color: "#7dd3fc", weight: 2.5, dashArray: "8 6", opacity: 0.85 }
                : isPortHovered
                ? { color: "#a78bfa", weight: 2, dashArray: "6 5", opacity: 0.75 }
                : { color: "#334155", weight: 1, dashArray: undefined, opacity: 0.6 }
            }
          />
        );
      })}

      {/* Hovered-ship planned route — full multi-hop legs, port-anchored */}
      {ships.map((ship) => {
        if (hovered !== ship.id) return null;
        const ast = ap.ships[ship.id];
        if (!ast?.plan) return null;

        const segments: Array<{ portIds: string[]; color: string }> = [];

        if (ast.phase === "transiting_to_buy" && ast.plan.buyPortId) {
          // Origin: current docked port OR next port on current route
          const originId = ship.port_id
            ?? routeById.get(ship.route_id ?? "")?.to_id;
          if (originId) {
            const buyLegsIds = [originId, ...ast.plan.legs.map((l) => l.toPortId)];
            segments.push({ portIds: buyLegsIds, color: "#f59e0b" }); // amber — to buy port
          }
          if (ast.plan.sellLegs && ast.plan.buyPortId) {
            const sellLegIds = [ast.plan.buyPortId, ...ast.plan.sellLegs.map((l) => l.toPortId)];
            segments.push({ portIds: sellLegIds, color: "#2dd4bf" }); // teal — to sell port
          }
        } else if (ast.phase === "transiting_to_sell") {
          const originId = ship.port_id
            ?? routeById.get(ship.route_id ?? "")?.to_id;
          if (originId) {
            const legIds = [originId, ...ast.plan.legs.map((l) => l.toPortId)];
            segments.push({ portIds: legIds, color: "#2dd4bf" }); // teal — to sell port
          }
        }

        return segments.map((seg, i) => {
          const positions = portChain(seg.portIds, portById);
          if (positions.length < 2) return null;
          return (
            <Polyline
              key={`plan-${ship.id}-${i}`}
              positions={positions}
              pathOptions={{ color: seg.color, weight: 2.5, dashArray: "10 5", opacity: 0.9 }}
            />
          );
        });
      })}

      {/* Port markers */}
      {ports.map((port) => {
        const coords  = PORT_COORDS[port.name];
        if (!coords) return null;
        const hub     = port.is_hub;
        const isHovP  = hoveredPort === port.id;
        return (
          <CircleMarker
            key={port.id}
            center={coords}
            radius={hub ? 8 : 6}
            pathOptions={{
              color:       isHovP ? "#c4b5fd" : hub ? "#fcd34d" : "#38bdf8",
              fillColor:   isHovP ? "#a78bfa"  : hub ? "#f59e0b" : "#7dd3fc",
              fillOpacity: 0.9,
              weight:      isHovP ? 2.5 : hub ? 2 : 1.5,
            }}
            eventHandlers={{
              mouseover: () => onPortHover(port.id),
              mouseout:  () => onPortHover(null),
            }}
          >
            <Tooltip
              permanent
              direction="top"
              offset={[0, -8]}
              className="leaflet-port-label"
            >
              {port.shortcode}
            </Tooltip>
          </CircleMarker>
        );
      })}

      {/* Ship markers */}
      {ships.map((ship) => {
        const pos    = shipLatLng(ship, portById, routeById);
        if (!pos) return null;
        const docked  = !!ship.port_id;
        const isHov   = hovered === ship.id;
        const ast     = ap.ships[ship.id];
        const color   = docked ? "#34d399" : "#fb7185";

        const destId   = ast?.plan
          ? (ast.phase === "transiting_to_buy" ? ast.plan.buyPortId : ast.plan.sellPortId)
          : undefined;
        const destName = portById.get(destId ?? "")?.name;

        return (
          <CircleMarker
            key={ship.id}
            center={pos}
            radius={isHov ? 11 : 8}
            pathOptions={{
              color,
              fillColor:   color,
              fillOpacity: 0.9,
              weight:      isHov ? 3 : 2,
            }}
            eventHandlers={{
              mouseover: () => onHover(ship.id),
              mouseout:  () => onHover(null),
            }}
          >
            <Tooltip direction="top" offset={[0, -10]} opacity={1}>
              <div className="text-xs font-semibold">{ship.name}</div>
              <div className="text-xs text-slate-400">
                {docked
                  ? `⚓ ${portById.get(ship.port_id!)?.name ?? "?"}`
                  : (() => {
                      const r = routeById.get(ship.route_id ?? "");
                      return `⛵ ${portById.get(r?.from_id ?? "")?.name ?? "?"} → ${portById.get(r?.to_id ?? "")?.name ?? "?"}`;
                    })()}
              </div>
              {destName && (
                <div className="text-xs text-amber-400">
                  {ast?.phase === "transiting_to_buy" ? "🛒" : "💰"} → {destName}
                </div>
              )}
            </Tooltip>
          </CircleMarker>
        );
      })}
    </MapContainer>
  );
}
