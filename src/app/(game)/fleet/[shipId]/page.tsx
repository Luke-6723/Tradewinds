"use client";

import { useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Empty, ErrorNote, KV, Loading, NativeSelect, Panel, ShipStatusBadge, Table } from "@/components/kibb/bits";
import { useCatalog } from "@/hooks/use-catalog";
import { usePoll } from "@/hooks/use-poll";
import { dash, kibbGet, kibbPost } from "@/lib/kibb/browser";
import { fmtCr, fmtIn, fmtTime, fmtTons } from "@/lib/kibb/format";
import type { FleetView } from "@/lib/kibb/fleet-registry";
import type { DepartResult, DockActionResult, RoutePlan, ShipResult, WorldClock, ZoneClass } from "@/lib/kibb/types";

const HULL_RANK: Record<ZoneClass, number> = { coastal: 0, regional: 1, oceanic: 2 };

function DepartForm({ r, onDone }: { r: ShipResult; onDone: () => void }) {
  const { catalog, portName } = useCatalog();
  const { data: clock } = usePoll(() => kibbGet<WorldClock>("/v1/world/clock"));
  const [dest, setDest] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<DepartResult | null>(null);
  const from = r.ship.current_port_id ?? "";
  const { data: plan, error: planError } = usePoll(
    dest ? () => kibbGet<RoutePlan>("/v1/world/route", { from, to: dest, ship_class: r.ship.ship_class }) : null,
    0,
    [dest, from],
  );

  const hull = catalog?.ship_classes.find((c) => c.id === r.ship.ship_class)?.hull_category ?? "coastal";
  const ports = (catalog?.ports ?? [])
    .filter((p) => p.id !== from && p.phase <= (clock?.unlocked_phase ?? 1))
    .sort((a, b) => a.name.localeCompare(b.name));
  // A leg is rated when the hull covers both the lane and the sea zone it ends in (hazards roll there).
  const legClass = (l: RoutePlan["legs"][number]): ZoneClass => {
    const zone = catalog?.sea_zones.find((z) => z.id === l.to_node)?.zone_class;
    return zone && HULL_RANK[zone] > HULL_RANK[l.edge_class] ? zone : l.edge_class;
  };
  const unrated = plan?.legs.filter((l) => HULL_RANK[legClass(l)] > HULL_RANK[hull]) ?? [];
  const short = plan ? r.stores.provisions_tons < plan.safe_provisions_tons : false;

  async function depart() {
    setBusy(true);
    setError(null);
    try {
      setResult(await kibbPost<DepartResult>("/v1/fleet/depart", { ship_id: r.ship.id, dest_port_id: dest }));
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <Label>Sail to</Label>
        <NativeSelect value={dest} onChange={(e) => { setDest(e.target.value); setResult(null); }}>
          <option value="">Choose a port…</option>
          {ports.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </NativeSelect>
      </div>
      <ErrorNote error={planError} />
      {plan && (
        <div className="space-y-2 rounded-lg border p-3 text-sm">
          <KV
            rows={[
              ["Distance", `${plan.total_distance_nm} nm`],
              ["Stores needed (safe)", `${fmtTons(plan.expected_provisions_tons, 2)} (${fmtTons(plan.safe_provisions_tons, 2)})`],
              ["Stores aboard", fmtTons(r.stores.provisions_tons, 2)],
            ]}
          />
          <div className="flex flex-wrap gap-1">
            {plan.legs.map((l, i) => (
              <Badge key={i} variant={HULL_RANK[legClass(l)] > HULL_RANK[hull] ? "error" : "outline"} size="sm">
                {portName(l.to_node)} · {legClass(l)}
              </Badge>
            ))}
          </div>
          {unrated.length > 0 && (
            <ErrorNote error={`A ${hull} hull isn't rated for ${unrated.map(legClass).join(", ")} water on this route: real risk of sinking.`} />
          )}
          {short && <ErrorNote error="Stores are below the safe figure for this route. Buy provisions into stores first (Market page)." />}
        </div>
      )}
      <ErrorNote error={error} />
      {result && (
        <p className="text-sm">
          Sailing to {portName(result.dest_port_id)}, arrives {fmtIn(result.estimated_arrival_at)}
          {result.berth_dues_pence > 0 && `; berth dues ${fmtCr(result.berth_dues_pence)}`}.
          {result.warnings.map((w) => ` ⚠ ${w.detail}`)}
        </p>
      )}
      <Button disabled={!dest || busy || unrated.length > 0} onClick={depart}>
        {busy ? "Departing…" : "Depart"}
      </Button>
    </div>
  );
}

export default function ShipPage() {
  const { shipId } = useParams<{ shipId: string }>();
  const { catalog, portName, goodName, shipClassName } = useCatalog();
  const { data: r, error, reload } = usePoll(() => kibbGet<ShipResult>("/v1/fleet/ship", { ship_id: shipId }), 5_000, [shipId]);
  const { data: fleet } = usePoll(() => dash.get<FleetView>("/api/kibb/fleet"), 10_000);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  if (!r) {
    return error ? <ErrorNote error={error} /> : <Loading />;
  }
  const s = r.ship;
  const cls = catalog?.ship_classes.find((c) => c.id === s.ship_class);
  const runnerOwnsShip = !!fleet?.enabled && !!fleet.state?.agents.some((a) => a.shipId === s.id);
  const locked = s.status === "berthed" && !!s.turnaround_unlocks_at && Date.parse(s.turnaround_unlocks_at) > Date.now();

  async function dockAction(kind: "dock" | "offshore") {
    setBusy(true);
    setActionError(null);
    try {
      await kibbPost<DockActionResult>(`/v1/fleet/${kind}`, { ship_id: s.id });
      await reload();
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6 pb-8">
      <div>
        <Link href="/fleet" className="text-muted-foreground text-xs hover:text-foreground">← Fleet</Link>
        <div className="mt-1 flex items-center gap-3">
          <h1 className="font-bold text-2xl tracking-tight">{s.name}</h1>
          <ShipStatusBadge status={s.status} />
        </div>
        <p className="mt-0.5 text-muted-foreground text-sm">
          {shipClassName(s.ship_class)} · {cls?.hull_category ?? "?"} hull · {s.cannons_count}/{cls?.max_cannons ?? "?"} guns · crew {cls?.crew_required ?? "?"}
        </p>
      </div>

      {runnerOwnsShip && (
        <p className="rounded-md bg-warning/10 px-3 py-2 text-sm text-warning-foreground">
          The fleet autopilot is sailing this ship. Stop it on the dashboard before giving manual orders.
        </p>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        <Panel title="Position">
          <KV
            rows={[
              ["Status", s.status.replace("_", " ")],
              s.status === "sailing"
                ? ["Bound for", portName(r.route_legs.at(-1)?.to_node)]
                : ["Port", portName(s.current_port_id)],
              ...(s.status === "sailing"
                ? ([["Arrives", fmtIn(r.voyage?.estimated_arrival_at ?? s.leg_arrives_at)], ["Speed", `${((r.voyage?.speed_centiknots ?? 0) / 100).toFixed(1)} kn`]] as Array<[string, string]>)
                : []),
              ...(s.status === "berthed"
                ? ([["Berthed", fmtTime(s.berthed_at)], ["Turnaround", locked ? fmtIn(s.turnaround_unlocks_at) : "free to sail"]] as Array<[string, string]>)
                : []),
              ...(s.dock_queued_at ? ([["Queued for berth", fmtTime(s.dock_queued_at)]] as Array<[string, string]>) : []),
            ]}
          />
        </Panel>

        <Panel title="Hold">
          <KV
            rows={[
              ["Capacity", fmtTons(r.hold_capacity_tons)],
              ["After guns and stores", fmtTons(r.effective_hold_capacity_tons)],
              ["Cargo aboard", fmtTons(r.cargo_used_tons)],
            ]}
          />
          <div className="mt-3">
            {Object.keys(r.cargo_manifest).length === 0 ? (
              <Empty>Hold empty.</Empty>
            ) : (
              <Table head={["Good", "Tons"]}>
                {Object.entries(r.cargo_manifest).map(([g, t]) => (
                  <tr key={g}>
                    <td>{goodName(g)}</td>
                    <td className="tabular-nums">{t}</td>
                  </tr>
                ))}
              </Table>
            )}
          </div>
        </Panel>

        <Panel title="Stores">
          <KV
            rows={[
              ["Provisions", fmtTons(r.stores.provisions_tons, 2)],
              ["Feeds the crew at sea for", `${r.stores.sea_days_remaining.toFixed(1)} game days`],
            ]}
          />
          <p className="mt-3 text-muted-foreground text-xs">
            Crews eat in port too, at half the sea rate. Buy stores with an IOC provisions bid “into stores” on the Market page.
          </p>
        </Panel>
      </div>

      {s.status === "sailing" && r.voyage && (
        <Panel title="Voyage">
          <Table head={["Leg", "To", "Distance", "Arrives"]}>
            {r.voyage.legs.map((l) => (
              <tr key={l.leg_idx} className={l.leg_idx < r.voyage!.current_leg_idx ? "text-muted-foreground" : undefined}>
                <td>{l.leg_idx + 1}</td>
                <td>
                  {portName(l.to_node)}
                  {l.starving && <Badge variant="error" size="sm" className="ml-1.5">starving</Badge>}
                </td>
                <td className="tabular-nums">{l.distance_nm} nm</td>
                <td>{fmtIn(l.estimated_arrival_at)}</td>
              </tr>
            ))}
          </Table>
        </Panel>
      )}

      {(s.status === "berthed" || s.status === "anchored_roadstead") && (
        <div className="grid gap-4 lg:grid-cols-3">
          <Panel title="Berth">
            <div className="space-y-3 text-sm">
              {s.status === "anchored_roadstead" ? (
                <>
                  <p className="text-muted-foreground">
                    In the roadstead: free, but you can only deliver charters and freight from here. Dock to trade.
                  </p>
                  <Button size="sm" disabled={busy || !!s.dock_queued_at} onClick={() => dockAction("dock")}>
                    {s.dock_queued_at ? "Queued for a berth" : "Dock"}
                  </Button>
                </>
              ) : (
                <>
                  <p className="text-muted-foreground">Berthed: berth dues accrue daily. Move to the roadstead to wait for free.</p>
                  <Button size="sm" variant="outline" disabled={busy || locked} onClick={() => dockAction("offshore")}>
                    {locked ? `Locked ${fmtIn(s.turnaround_unlocks_at)}` : "Move to roadstead"}
                  </Button>
                </>
              )}
              <ErrorNote error={actionError} />
            </div>
          </Panel>
          <Panel title="Depart" className="lg:col-span-2">
            <DepartForm r={r} onDone={() => void reload()} />
          </Panel>
        </div>
      )}
    </div>
  );
}
