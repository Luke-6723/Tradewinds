"use client";

/**
 * Leaflet map rendered client-side only (imported via next/dynamic in page.tsx).
 * Uses Esri World Dark Gray tiles — no API key needed (CARTO's free tiles now require one).
 */

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import L from "leaflet";
import { CircleMarker, MapContainer, Marker, Polyline, Popup, TileLayer, Tooltip, useMap } from "react-leaflet";
import "leaflet/dist/leaflet.css";
import { NODE_COORDS, legPath, rivalFix, seaLanes, shipFix, type LatLng, type ShipFix } from "@/lib/kibb/geo";
import { fmtAgo, fmtBps, fmtCr, fmtIn, fmtTons } from "@/lib/kibb/format";
import type { RivalShip } from "@/lib/kibb/rivals";
import type { Catalog, SeaZoneStatus, ShipResult, ShipStatus } from "@/lib/kibb/types";

const SHIP_COLOR: Record<ShipStatus, string> = {
  sailing: "#60a5fa",
  berthed: "#4ade80",
  anchored_roadstead: "#fbbf24",
  sunk: "#f87171",
};

function shipIcon(status: ShipStatus, heading: number, stackIdx: number): L.DivIcon {
  const color = SHIP_COLOR[status];
  const body =
    status === "sailing"
      ? `<svg viewBox="0 0 24 24" width="20" height="20" style="transform:rotate(${heading}deg)"><path d="M12 2 19 21 12 17 5 21Z" fill="${color}" stroke="#0b1220" stroke-width="1.5" stroke-linejoin="round"/></svg>`
      : `<svg viewBox="0 0 24 24" width="16" height="16"><circle cx="12" cy="12" r="7" fill="${color}" stroke="#0b1220" stroke-width="2.5"/></svg>`;
  const size = status === "sailing" ? 20 : 16;
  return L.divIcon({
    className: "kibb-ship-icon",
    html: body,
    iconSize: [size, size],
    // Ships in the same port stack upwards so each stays clickable.
    iconAnchor: [size / 2, size / 2 + stackIdx * 14],
  });
}

const RIVAL_COLOR = "#c084fc";

/** A rival ship: a hollow marker, since its position is an estimate. */
function rivalIcon(atSea: boolean, heading: number): L.DivIcon {
  const body = atSea
    ? `<svg viewBox="0 0 24 24" width="16" height="16" style="transform:rotate(${heading}deg)"><path d="M12 3 18 20 12 16.5 6 20Z" fill="none" stroke="${RIVAL_COLOR}" stroke-width="2.5" stroke-linejoin="round"/></svg>`
    : `<svg viewBox="0 0 24 24" width="12" height="12"><rect x="5" y="5" width="14" height="14" transform="rotate(45 12 12)" fill="none" stroke="${RIVAL_COLOR}" stroke-width="3"/></svg>`;
  const size = atSea ? 16 : 12;
  return L.divIcon({ className: "kibb-ship-icon", html: body, iconSize: [size, size], iconAnchor: [size / 2, size / 2] });
}

/** Flies to the focused ship once per focus change. */
function FlyTo({ target, nonce }: { target: LatLng | null; nonce: number }) {
  const map = useMap();
  useEffect(() => {
    if (target) map.flyTo(target, Math.max(map.getZoom(), 6), { duration: 0.8 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nonce]);
  return null;
}

export interface MapProps {
  catalog: Catalog;
  ships: ShipResult[];
  zones: SeaZoneStatus[] | undefined;
  unlockedPhase: number;
  showLocked: boolean;
  focus: { shipId: string; nonce: number } | null;
  onSelectShip: (shipId: string) => void;
  portName: (id: string | null | undefined) => string;
  goodName: (id: string | null | undefined) => string;
  shipClassName: (id: string | null | undefined) => string;
  /** Other companies' ships (estimated positions), and the server clock's lead over ours (ms). */
  rivals?: RivalShip[];
  serverOffsetMs?: number;
}

export default function KibbMap({
  catalog,
  ships,
  zones,
  unlockedPhase,
  showLocked,
  focus,
  onSelectShip,
  portName,
  goodName,
  shipClassName,
  rivals = [],
  serverOffsetMs = 0,
}: MapProps) {
  // Re-place sailing ships every second.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(t);
  }, []);

  const phaseOf = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of catalog.ports) m.set(p.id, p.phase);
    for (const z of catalog.sea_zones) m.set(z.id, z.phase);
    return m;
  }, [catalog]);
  const visible = (id: string) => showLocked || (phaseOf.get(id) ?? 99) <= unlockedPhase;

  const lanes = useMemo(
    () => seaLanes(catalog.ports).map(([a, b]) => ({ a, b, path: legPath(a, b) })),
    [catalog],
  );

  const fixes = ships
    .map((r) => ({ r, fix: shipFix(r, now) }))
    .filter((x): x is { r: ShipResult; fix: ShipFix } => x.fix !== null);

  // Stack index per port, for ships sharing a berth or roadstead.
  const stack = new Map<string, number>();
  const stackIdx = (r: ShipResult) => {
    if (r.ship.status === "sailing" || !r.ship.current_port_id) return 0;
    const n = stack.get(r.ship.current_port_id) ?? 0;
    stack.set(r.ship.current_port_id, n + 1);
    return n;
  };

  const shipsAt = new Set(ships.filter((r) => r.ship.status !== "sailing").map((r) => r.ship.current_port_id));
  const piracy = new Map(zones?.map((z) => [z.sea_zone_id, z]) ?? []);
  const bounds = useMemo(
    () =>
      L.latLngBounds(
        catalog.ports.filter((p) => p.phase <= unlockedPhase).map((p) => NODE_COORDS[p.id]).filter(Boolean),
      ),
    [catalog, unlockedPhase],
  );
  const focusFix = focus ? fixes.find((x) => x.r.ship.id === focus.shipId)?.fix.pos ?? null : null;

  return (
    <MapContainer
      bounds={bounds.isValid() ? bounds.pad(0.1) : undefined}
      center={bounds.isValid() ? undefined : [52, 5]}
      zoom={bounds.isValid() ? undefined : 5}
      minZoom={2}
      // Keep a hard fling from throwing the view off the world.
      maxBounds={[[-75, -200], [82, 200]]}
      maxBoundsViscosity={1}
      worldCopyJump={false}
      className="h-full w-full"
      style={{ background: "#0d1b2a" }}
    >
      <TileLayer
        url="https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}"
        attribution="Tiles &copy; Esri &mdash; Esri, DeLorme, NAVTEQ"
        maxZoom={16}
      />

      {lanes
        .filter((l) => visible(l.a) && visible(l.b) && l.path.length > 1)
        .map((l) => (
          <Polyline
            key={`${l.a}|${l.b}`}
            positions={l.path}
            pathOptions={{ color: "#94a3b8", weight: 1.25, opacity: 0.55, dashArray: "3 5" }}
            interactive={false}
          />
        ))}

      {catalog.sea_zones.filter((z) => visible(z.id) && NODE_COORDS[z.id]).map((z) => {
        const p = piracy.get(z.id);
        return (
          <CircleMarker
            key={z.id}
            center={NODE_COORDS[z.id]}
            radius={3}
            pathOptions={{ color: "#94a3b8", fillColor: "#94a3b8", fillOpacity: 0.5, weight: 0 }}
          >
            <Tooltip direction="top">
              <div className="text-xs">
                <div className="font-semibold">{z.name}</div>
                <div>{z.zone_class} water · phase {z.phase}</div>
                {p && (
                  <div>
                    piracy {fmtBps(p.net_piracy_bps)}
                    {p.active_marques > 0 && ` · ${p.active_marques} marque${p.active_marques > 1 ? "s" : ""}`}
                    {p.active_patrols > 0 && ` · ${p.active_patrols} patrol${p.active_patrols > 1 ? "s" : ""}`}
                  </div>
                )}
              </div>
            </Tooltip>
          </CircleMarker>
        );
      })}

      {catalog.ports.filter((p) => visible(p.id) && NODE_COORDS[p.id]).map((p) => {
        const locked = p.phase > unlockedPhase;
        const mine = shipsAt.has(p.id);
        const color = locked ? "#475569" : mine ? "#4ade80" : "#e2e8f0";
        return (
          <CircleMarker
            key={p.id}
            center={NODE_COORDS[p.id]}
            radius={p.is_hub ? 6 : 4}
            pathOptions={{ color: "#0b1220", weight: 1.5, fillColor: color, fillOpacity: locked ? 0.6 : 0.95 }}
          >
            <Tooltip direction="right" offset={[6, 0]}>
              <span className="font-medium">{p.name}</span>
              {locked && <span> · phase {p.phase}</span>}
            </Tooltip>
            <Popup>
              <div className="space-y-1 text-xs">
                <div className="font-semibold text-sm">{p.name}</div>
                <div className="capitalize">
                  {p.banking_region.replace(/_/g, " ")} · phase {p.phase}
                  {p.is_hub && " · hub"}
                  {p.has_shipyard && " · shipyard"}
                </div>
                {!!(p.produces?.length || p.manufactures?.length) && (
                  <div>Makes {[...(p.produces ?? []), ...(p.manufactures ?? [])].map(goodName).join(", ")}</div>
                )}
                <div className="flex gap-3 pt-1">
                  <Link href={`/ports/${p.id}`}>Port page →</Link>
                  {mine && <Link href={`/market?port=${p.id}`}>Market →</Link>}
                </div>
              </div>
            </Popup>
          </CircleMarker>
        );
      })}

      {fixes
        .filter((x) => x.fix.ahead.length > 1)
        .map(({ r, fix }) => (
          <Polyline
            key={`ahead-${r.ship.id}`}
            positions={fix.ahead}
            pathOptions={{ color: SHIP_COLOR.sailing, weight: 2, opacity: 0.85, dashArray: "6 6" }}
            interactive={false}
          />
        ))}

      {fixes.map(({ r, fix }) => {
        const s = r.ship;
        const cargo = Object.entries(r.cargo_manifest);
        const eta = r.voyage?.estimated_arrival_at ?? s.leg_arrives_at;
        return (
          <Marker
            key={s.id}
            position={fix.pos}
            icon={shipIcon(s.status, fix.heading, stackIdx(r))}
            zIndexOffset={1000}
            eventHandlers={{ click: () => onSelectShip(s.id) }}
          >
            <Tooltip direction="right" offset={[10, 0]} permanent className="kibb-ship-label">
              {s.name}
            </Tooltip>
            <Popup>
              <div className="space-y-1 text-xs">
                <div className="font-semibold text-sm">{s.name}</div>
                <div>{shipClassName(s.ship_class)} · {s.cannons_count} guns</div>
                <div>
                  {s.status === "sailing"
                    ? `→ ${portName(fix.dest)}, arrives ${fmtIn(eta)}`
                    : `${s.status === "berthed" ? "Berthed at" : s.status === "sunk" ? "Sunk near" : "Anchored off"} ${portName(s.current_port_id)}`}
                </div>
                <div>
                  {cargo.length ? cargo.map(([g, t]) => `${t} t ${goodName(g)}`).join(", ") : "Hold empty"} · stores {fmtTons(r.stores.provisions_tons, 2)}
                </div>
                <div className="pt-1">
                  <Link href={`/fleet/${s.id}`}>Ship page →</Link>
                </div>
              </div>
            </Popup>
          </Marker>
        );
      })}

      {rivals.map((r) => {
        const fix = rivalFix(r, now + serverOffsetMs);
        if (!fix) return null;
        const t = now + serverOffsetMs;
        const atSea = !!r.voyage && t >= r.voyage.departAt && t < r.voyage.arriveAt;
        return (
          <Marker key={`rival-${r.key}`} position={fix.pos} icon={rivalIcon(atSea, fix.heading)} zIndexOffset={500}>
            <Tooltip direction="top">
              {r.ship} · {r.company}
            </Tooltip>
            <Popup>
              <div className="space-y-1 text-xs">
                <div className="font-semibold text-sm">{r.ship}</div>
                <div>
                  {r.company} · {shipClassName(r.shipClass)} · {r.cargo ? `${fmtCr(r.cargo)} declared` : (r.loadState?.replace("_", " ") ?? "load unknown")}
                </div>
                <div>
                  {{ sailed: "Sailed from", arrived: "Arrived at", insured: "Insured at", convoy: "In a convoy from" }[r.seen.direction]} {portName(r.seen.port)}
                  {r.seen.otherPort ? ` ${r.seen.direction === "arrived" ? "from" : r.seen.direction === "convoy" ? "to" : "for"} ${portName(r.seen.otherPort)}` : ""},{" "}
                  {fmtAgo(new Date(r.seen.at - serverOffsetMs).toISOString())}
                </div>
                <div className="text-muted-foreground">
                  {atSea
                    ? `Estimated position; due ${fmtIn(new Date(r.voyage!.arriveAt - serverOffsetMs).toISOString())}`
                    : r.voyage && t < r.voyage.departAt
                      ? `In port; sails ${fmtIn(new Date(r.voyage.departAt - serverOffsetMs).toISOString())}`
                      : fix.estimated
                        ? "Probably in port"
                        : "Last seen here"}
                </div>
              </div>
            </Popup>
          </Marker>
        );
      })}

      <FlyTo target={focusFix} nonce={focus?.nonce ?? 0} />
    </MapContainer>
  );
}
