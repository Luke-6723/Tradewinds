"use client";

import { useState } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Loading, NativeSelect, Panel, Table } from "@/components/kibb/bits";
import { useCatalog } from "@/hooks/use-catalog";
import { usePoll } from "@/hooks/use-poll";
import { kibbGet } from "@/lib/kibb/browser";
import { fmtBps } from "@/lib/kibb/format";
import type { ShipResult, WorldClock } from "@/lib/kibb/types";

export default function PortsPage() {
  const { catalog, goodName } = useCatalog();
  const { data: clock } = usePoll(() => kibbGet<WorldClock>("/v1/world/clock"));
  const { data: ships } = usePoll(() => kibbGet<ShipResult[]>("/v1/fleet/ships", { limit: 200 }), 30_000);
  const [region, setRegion] = useState("");
  const [query, setQuery] = useState("");
  const [openOnly, setOpenOnly] = useState(true);

  const unlocked = clock?.unlocked_phase ?? 1;
  const shipsAt = new Map<string, number>();
  for (const r of ships ?? []) {
    if (r.ship.current_port_id) shipsAt.set(r.ship.current_port_id, (shipsAt.get(r.ship.current_port_id) ?? 0) + 1);
  }
  const regions = [...new Set(catalog?.ports.map((p) => p.banking_region))].sort();
  const q = query.trim().toLowerCase();
  const ports = (catalog?.ports ?? [])
    .filter((p) => !openOnly || p.phase <= unlocked)
    .filter((p) => !region || p.banking_region === region)
    .filter((p) => {
      if (!q) return true;
      const goods = [...(p.produces ?? []), ...(p.manufactures ?? []), ...(p.imports ?? [])];
      return p.name.toLowerCase().includes(q) || goods.some((g) => g.includes(q) || goodName(g).toLowerCase().includes(q));
    })
    .sort((a, b) => a.phase - b.phase || a.name.localeCompare(b.name));

  return (
    <div className="space-y-6 pb-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-bold text-2xl tracking-tight">Ports</h1>
          <p className="mt-0.5 text-muted-foreground text-sm">What each port makes and buys. Producers sit cheap, importers dear.</p>
        </div>
        <div className="flex items-center gap-2">
          <Input placeholder="Port or good…" value={query} onChange={(e) => setQuery(e.target.value)} className="w-48" />
          <NativeSelect value={region} onChange={(e) => setRegion(e.target.value)} className="w-40">
            <option value="">All regions</option>
            {regions.map((r) => <option key={r} value={r}>{r.replace(/_/g, " ")}</option>)}
          </NativeSelect>
          <label className="flex items-center gap-1.5 whitespace-nowrap text-sm">
            <input type="checkbox" checked={openOnly} onChange={(e) => setOpenOnly(e.target.checked)} />
            Open only
          </label>
        </div>
      </div>

      <Panel title={`${ports.length} ports`}>
        {!catalog ? (
          <Loading />
        ) : (
          <Table head={["Port", "Region", "Customs", "Makes", "Imports"]}>
            {ports.map((p) => {
              const makes = [...(p.produces ?? []), ...(p.manufactures ?? [])];
              return (
                <tr key={p.id} className={p.phase > unlocked ? "opacity-50" : undefined}>
                  <td className="whitespace-nowrap">
                    <Link href={`/ports/${p.id}`} className="font-medium hover:underline">{p.name}</Link>
                    <span className="ml-1.5 inline-flex gap-1 align-middle">
                      {p.is_hub && <Badge variant="info" size="sm">hub</Badge>}
                      {p.has_shipyard && <Badge variant="outline" size="sm">yard</Badge>}
                      {p.phase > unlocked && <Badge variant="secondary" size="sm">phase {p.phase}</Badge>}
                      {shipsAt.has(p.id) && <Badge variant="success" size="sm">{shipsAt.get(p.id)} ship</Badge>}
                    </span>
                  </td>
                  <td className="whitespace-nowrap capitalize text-muted-foreground">{p.banking_region.replace(/_/g, " ")}</td>
                  <td className="tabular-nums">{fmtBps(p.customs_bps)}</td>
                  <td className="text-xs">{makes.map(goodName).join(", ") || "—"}</td>
                  <td className="text-muted-foreground text-xs">{(p.imports ?? []).map(goodName).join(", ") || "—"}</td>
                </tr>
              );
            })}
          </Table>
        )}
      </Panel>
    </div>
  );
}
