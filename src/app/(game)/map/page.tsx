"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { Empty, ErrorNote, Loading, ShipStatusBadge } from "@/components/kibb/bits";
import { Card } from "@/components/ui/card";
import { useCatalog } from "@/hooks/use-catalog";
import { usePoll } from "@/hooks/use-poll";
import { kibbGet } from "@/lib/kibb/browser";
import { fmtIn, fmtTons } from "@/lib/kibb/format";
import type { SeaZoneStatus, ShipResult, WorldClock } from "@/lib/kibb/types";

// Leaflet touches `window` on import, so it must load client-side only.
const KibbMap = dynamic(() => import("./_map"), { ssr: false, loading: () => <Loading /> });

const LEGEND: Array<[string, string]> = [
  ["#60a5fa", "Sailing"],
  ["#4ade80", "Berthed / your port"],
  ["#fbbf24", "Roadstead"],
  ["#e2e8f0", "Port"],
  ["#94a3b8", "Sea zone"],
];

export default function MapPage() {
  const { catalog, portName, goodName, shipClassName } = useCatalog();
  const { data: ships, error } = usePoll(() => kibbGet<ShipResult[]>("/v1/fleet/ships", { limit: 200 }), 5_000);
  const { data: clock } = usePoll(() => kibbGet<WorldClock>("/v1/world/clock"), 60_000);
  const { data: zones } = usePoll(() => kibbGet<SeaZoneStatus[]>("/v1/world/zones"), 60_000);
  const [focus, setFocus] = useState<{ shipId: string; nonce: number } | null>(null);
  const [showLocked, setShowLocked] = useState(false);

  const select = (shipId: string) => setFocus({ shipId, nonce: Date.now() });

  return (
    <div className="flex flex-col gap-4 lg:h-[calc(100dvh-8rem)] lg:flex-row">
      {/* Phones: title above the map; the side column carries it on large screens. */}
      <div className="lg:hidden">
        <h1 className="font-bold text-xl tracking-tight">Map</h1>
        <p className="mt-0.5 text-muted-foreground text-sm">Where your ships are, live.</p>
      </div>
      <Card className="relative h-[60dvh] min-h-80 min-w-0 overflow-hidden lg:h-auto lg:flex-1">
        {catalog && ships ? (
          <KibbMap
            catalog={catalog}
            ships={ships}
            zones={zones}
            unlockedPhase={clock?.unlocked_phase ?? 1}
            showLocked={showLocked}
            focus={focus}
            onSelectShip={select}
            portName={portName}
            goodName={goodName}
            shipClassName={shipClassName}
          />
        ) : (
          <Loading />
        )}
      </Card>

      <div className="flex flex-col gap-4 lg:w-72 lg:shrink-0 lg:overflow-y-auto">
        <div className="hidden lg:block">
          <h1 className="font-bold text-2xl tracking-tight">Map</h1>
          <p className="mt-0.5 text-muted-foreground text-sm">Where your ships are, live.</p>
        </div>
        <ErrorNote error={error} />

        <Card className="p-3">
          <div className="mb-2 font-medium text-muted-foreground text-xs">Ships</div>
          {!ships ? (
            <Loading />
          ) : ships.length === 0 ? (
            <Empty>No ships.</Empty>
          ) : (
            <ul className="space-y-1">
              {ships.map((r) => {
                const s = r.ship;
                const dest = r.route_legs.at(-1)?.to_node;
                const cargo = Object.values(r.cargo_manifest).reduce((n, t) => n + t, 0);
                return (
                  <li key={s.id}>
                    <button
                      type="button"
                      onClick={() => select(s.id)}
                      className={`w-full rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-accent ${focus?.shipId === s.id ? "bg-accent" : ""}`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate font-medium text-sm">{s.name}</span>
                        <ShipStatusBadge status={s.status} />
                      </div>
                      <div className="text-muted-foreground text-xs">
                        {s.status === "sailing"
                          ? `→ ${portName(dest)} ${fmtIn(r.voyage?.estimated_arrival_at ?? s.leg_arrives_at)}`
                          : portName(s.current_port_id)}
                        {" · "}
                        {fmtTons(cargo)} aboard
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        <Card className="space-y-1.5 p-3 text-xs">
          {LEGEND.map(([color, label]) => (
            <div key={label} className="flex items-center gap-2">
              <span className="inline-block size-2.5 rounded-full" style={{ backgroundColor: color }} />
              {label}
            </div>
          ))}
          <div className="flex items-center gap-2">
            <span className="inline-block w-4 border-t border-dashed border-slate-500" />
            Sea lane
          </div>
          <label className="flex items-center gap-2 pt-1.5">
            <input type="checkbox" checked={showLocked} onChange={(e) => setShowLocked(e.target.checked)} />
            Show ports not yet open
          </label>
          <p className="pt-1 text-muted-foreground">
            Hover a sea zone for its live piracy. Click a port or ship for details. Positions at sea are estimated from
            leg times. <Link href="/ports" className="underline">All ports</Link>
          </p>
        </Card>
      </div>
    </div>
  );
}
