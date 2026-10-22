"use client";

import Link from "next/link";
import { Empty, ErrorNote, Loading, Panel, ShipStatusBadge, Table } from "@/components/kibb/bits";
import { useCatalog } from "@/hooks/use-catalog";
import { usePoll } from "@/hooks/use-poll";
import { kibbGet } from "@/lib/kibb/browser";
import { fmtIn, fmtTons } from "@/lib/kibb/format";
import type { ShipResult } from "@/lib/kibb/types";

export default function FleetPage() {
  const { portName, goodName, shipClassName } = useCatalog();
  const { data: ships, error } = usePoll(() => kibbGet<ShipResult[]>("/v1/fleet/ships", { limit: 200 }), 10_000);

  return (
    <div className="space-y-6 pb-8">
      <div>
        <h1 className="font-bold text-2xl tracking-tight">Fleet</h1>
        <p className="mt-0.5 text-muted-foreground text-sm">Ships, where they are and what they carry.</p>
      </div>
      <ErrorNote error={error} />
      <Panel title={ships ? `${ships.length} ship${ships.length === 1 ? "" : "s"}` : "Ships"}>
        {!ships ? (
          <Loading />
        ) : ships.length === 0 ? (
          <Empty>No ships.</Empty>
        ) : (
          <Table head={["Ship", "Class", "Status", "Where", "Hold", "Cargo", "Stores", "Guns"]}>
            {ships.map((r) => {
              const s = r.ship;
              const dest = r.route_legs.at(-1)?.to_node;
              const cargo = Object.entries(r.cargo_manifest);
              return (
                <tr key={s.id}>
                  <td>
                    <Link href={`/fleet/${s.id}`} className="font-medium hover:underline">{s.name}</Link>
                  </td>
                  <td className="text-muted-foreground">{shipClassName(s.ship_class)}</td>
                  <td><ShipStatusBadge status={s.status} /></td>
                  <td>
                    {s.status === "sailing" ? (
                      <>
                        → {portName(dest)} <span className="text-muted-foreground text-xs">{fmtIn(r.voyage?.estimated_arrival_at ?? s.leg_arrives_at)}</span>
                      </>
                    ) : (
                      portName(s.current_port_id)
                    )}
                  </td>
                  <td className="tabular-nums">{fmtTons(r.cargo_used_tons)} / {fmtTons(r.effective_hold_capacity_tons)}</td>
                  <td className="text-muted-foreground text-xs">
                    {cargo.length ? cargo.map(([g, t]) => `${t} t ${goodName(g)}`).join(", ") : "empty"}
                  </td>
                  <td className="tabular-nums">{fmtTons(r.stores.provisions_tons, 2)}</td>
                  <td className="tabular-nums">{s.cannons_count}</td>
                </tr>
              );
            })}
          </Table>
        )}
      </Panel>
    </div>
  );
}
