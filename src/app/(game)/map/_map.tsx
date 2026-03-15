"use client";

/**
 * Leaflet map rendered client-side only (imported via next/dynamic in page.tsx).
 * Uses CartoDB Dark Matter tiles — no API key needed.
 */

import { useState, useEffect } from "react";
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

/** Interpolate a position at fraction t along a polyline (0 = start, 1 = end). */
function interpolatePolyline(
  coords: Array<[number, number]>,
  t: number,
): [number, number] {
  if (coords.length === 0) return [0, 0];
  if (t <= 0) return coords[0];
  if (t >= 1) return coords[coords.length - 1];

  const segLens: number[] = [];
  let totalLen = 0;
  for (let i = 1; i < coords.length; i++) {
    const d = Math.hypot(coords[i][0] - coords[i - 1][0], coords[i][1] - coords[i - 1][1]);
    segLens.push(d);
    totalLen += d;
  }

  let acc = 0;
  const target = t * totalLen;
  for (let i = 0; i < segLens.length; i++) {
    if (acc + segLens[i] >= target) {
      const segT = segLens[i] > 0 ? (target - acc) / segLens[i] : 0;
      return [
        coords[i][0] + segT * (coords[i + 1][0] - coords[i][0]),
        coords[i][1] + segT * (coords[i + 1][1] - coords[i][1]),
      ];
    }
    acc += segLens[i];
  }
  return coords[coords.length - 1];
}

// ── Ship position helper ───────────────────────────────────────────────────
function shipLatLng(
  ship: Ship,
  portById: Map<string, Port>,
  routeById: Map<string, Route>,
  geoRoutes: Map<string, Array<[number, number]>>,
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

    // Use GeoJSON polyline for accurate sea-lane position if available
    const coords =
      geoRoutes.get(`${fromPort.name}:${toPort.name}`) ??
      geoRoutes.get(`${toPort.name}:${fromPort.name}`)?.slice().reverse() as
        Array<[number, number]> | undefined;

    if (coords && coords.length >= 2) return interpolatePolyline(coords, t);
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

  // Keyed "FromPort:ToPort" → [lat, lon][] from the server GeoJSON
  const [geoRoutes, setGeoRoutes] = useState<Map<string, Array<[number, number]>>>(new Map());

  useEffect(() => {
    fetch("https://tradewinds.fly.dev/assets/routes.json")
      .then((r) => r.json())
      .then((fc: {
        features: Array<{
          properties: { from: string; to: string };
          geometry:   { coordinates: number[][] };
        }>;
      }) => {
        const map = new Map<string, Array<[number, number]>>();
        for (const f of fc.features) {
          // GeoJSON stores [lon, lat]; Leaflet needs [lat, lon]
          map.set(
            `${f.properties.from}:${f.properties.to}`,
            f.geometry.coordinates.map(([lon, lat]) => [lat, lon] as [number, number]),
          );
        }
        setGeoRoutes(map);
      })
      .catch(() => { /* fall back to seaLaneWaypoints */ });
  }, []);

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

      {/* Route lines — active ships only, plus port-hover highlights */}
      {routes.map((r) => {
        const isActive      = activeRouteIds.has(r.id);
        const isPortHovered = hoveredPort !== null &&
          (r.from_id === hoveredPort || r.to_id === hoveredPort);

        if (!isActive && !isPortHovered) return null;

        const fromPort = portById.get(r.from_id);
        const toPort   = portById.get(r.to_id);
        if (!fromPort || !toPort) return null;
        const from = PORT_COORDS[fromPort.name];
        const to   = PORT_COORDS[toPort.name];
        if (!from || !to) return null;

        // Prefer GeoJSON sea-lane coords; fall back to manual waypoints
        const geoCoords =
          geoRoutes.get(`${fromPort.name}:${toPort.name}`) ??
          geoRoutes.get(`${toPort.name}:${fromPort.name}`)?.slice().reverse() as
            Array<[number, number]> | undefined;

        const positions: Array<[number, number]> = geoCoords && geoCoords.length >= 2
          ? geoCoords
          : [from, ...seaLaneWaypoints(fromPort.name, toPort.name), to];

        return (
          <Polyline
            key={r.id}
            positions={positions}
            pathOptions={
              isActive
                ? { color: "#7dd3fc", weight: 2.5, dashArray: "8 6", opacity: 0.85 }
                : { color: "#a78bfa", weight: 2, dashArray: "6 5", opacity: 0.75 }
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
        const pos    = shipLatLng(ship, portById, routeById, geoRoutes);
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


