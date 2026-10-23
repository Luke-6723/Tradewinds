"use client";

import { useState } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { ErrorNote, Loading, NativeSelect, PageHeader, Panel, Table } from "@/components/kibb/bits";
import { RegionSelect } from "@/components/kibb/pickers";
import { useCatalog } from "@/hooks/use-catalog";
import { usePoll } from "@/hooks/use-poll";
import { kibbGet } from "@/lib/kibb/browser";
import { fmtBps, fmtTons } from "@/lib/kibb/format";
import type * as S from "@/lib/kibb/schema";
import type { ShipResult, WorldClock } from "@/lib/kibb/types";

export default function PortsPage() {
  const { catalog, goodName } = useCatalog();
  const { data: clock } = usePoll(() => kibbGet<WorldClock>("/v1/world/clock"));
  const [region, setRegion] = useState("");
  const [phase, setPhase] = useState("open");
  const [query, setQuery] = useState("");

  const unlocked = clock?.unlocked_phase ?? 1;
  // The API filters by maximum phase.
  const phaseFilter = phase === "open" ? (clock ? unlocked : undefined) : phase === "" ? undefined : Number(phase);
  const { data: listed, error } = usePoll(
    () => kibbGet<S.PortCatalogEntry[]>("/v1/world/ports", { phase: phaseFilter, banking_region: region || undefined }),
    0,
    [phaseFilter, region],
  );
  const { data: ships } = usePoll(() => kibbGet<ShipResult[]>("/v1/fleet/ships", { limit: 200 }), 30_000);
  const { data: factors } = usePoll(() => kibbGet<string[]>("/v1/company/factors"), 60_000);
  const { data: warehouses } = usePoll(() => kibbGet<S.PortWarehouseResult[]>("/v1/warehouse/list"), 60_000);

  const shipsAt = new Map<string, number>();
  for (const r of ships ?? []) {
    if (r.ship.current_port_id && r.ship.status !== "sailing") shipsAt.set(r.ship.current_port_id, (shipsAt.get(r.ship.current_port_id) ?? 0) + 1);
  }
  const factorAt = new Set(factors ?? []);
  const leaseAt = new Map((warehouses ?? []).filter((w) => w.leased_tonnage > 0).map((w) => [w.port_id, w]));

  const q = query.trim().toLowerCase();
  const ports = (listed ?? [])
    .filter((p) => {
      if (!q) return true;
      const goods = [...p.produces, ...p.manufactures, ...p.imports];
      return p.name.toLowerCase().includes(q) || goods.some((g) => g.includes(q) || goodName(g).toLowerCase().includes(q));
    })
    .sort((a, b) => a.phase - b.phase || a.name.localeCompare(b.name));
  const zoneName = (id: string) => catalog?.sea_zones.find((z) => z.id === id)?.name ?? id;
  const zoneClass = (id: string) => catalog?.sea_zones.find((z) => z.id === id)?.zone_class;
  const phases = [...new Set((catalog?.ports ?? []).map((p) => p.phase))].sort();

  return (
    <div className="space-y-5 pb-8 sm:space-y-6">
      <PageHeader
        title="Ports"
        subtitle="What each port makes and buys, and where you have a presence. Producers sit cheap, importers dear."
        actions={
          <>
            <Input placeholder="Port or good…" value={query} onChange={(e) => setQuery(e.target.value)} className="w-full sm:w-48" />
            <RegionSelect value={region} onChange={setRegion} placeholder="All regions" className="w-full sm:w-40" />
            <NativeSelect value={phase} onChange={(e) => setPhase(e.target.value)} className="w-full sm:w-36">
              <option value="open">Open phases</option>
              <option value="">All phases</option>
              {phases.map((n) => (
                <option key={n} value={n}>Up to phase {n}</option>
              ))}
            </NativeSelect>
          </>
        }
      />

      <ErrorNote error={error} />
      <Panel title={`${ports.length} ports`}>
        {!listed ? (
          <Loading />
        ) : (
          <Table head={["Port", "Region", "Sea zone", "Customs", "Berths", "Presence", "Makes", "Imports"]}>
            {ports.map((p) => {
              const makes = [...p.produces, ...p.manufactures];
              const lease = leaseAt.get(p.id);
              return (
                <tr key={p.id} className={p.phase > unlocked ? "opacity-50" : undefined}>
                  <td className="whitespace-nowrap">
                    <Link href={`/ports/${p.id}`} className="font-medium hover:underline">{p.name}</Link>
                    <span className="ml-1.5 inline-flex gap-1 align-middle">
                      {p.is_hub && <Badge variant="info" size="sm">hub</Badge>}
                      {p.has_shipyard && <Badge variant="outline" size="sm">yard</Badge>}
                      {p.phase > unlocked && <Badge variant="secondary" size="sm">phase {p.phase}</Badge>}
                    </span>
                  </td>
                  <td className="whitespace-nowrap capitalize text-muted-foreground">{p.banking_region.replace(/_/g, " ")}</td>
                  <td className="whitespace-nowrap text-xs">
                    {zoneName(p.sea_zone_id)} <span className="text-muted-foreground">{zoneClass(p.sea_zone_id)}</span>
                  </td>
                  <td className="tabular-nums">{fmtBps(p.customs_bps)}</td>
                  <td className="tabular-nums">{p.effective_berths}</td>
                  <td className="whitespace-nowrap">
                    <span className="inline-flex gap-1">
                      {shipsAt.has(p.id) && <Badge variant="success" size="sm">{shipsAt.get(p.id)} ship</Badge>}
                      {factorAt.has(p.id) && <Badge variant="info" size="sm">factor</Badge>}
                      {lease && <Badge variant="outline" size="sm">{fmtTons(lease.leased_tonnage)} lease</Badge>}
                    </span>
                  </td>
                  <td className="text-xs">{makes.map(goodName).join(", ") || "—"}</td>
                  <td className="text-muted-foreground text-xs">{p.imports.map(goodName).join(", ") || "—"}</td>
                </tr>
              );
            })}
          </Table>
        )}
      </Panel>
    </div>
  );
}
