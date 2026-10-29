"use client";

import { useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Empty, ErrorNote, KV, Loading, NativeSelect, PageHeader, Panel, ShipStatusBadge, Table } from "@/components/kibb/bits";
import { usePledgedShips } from "@/components/kibb/finance-common";
import { ContractsPanel, ConvoysPanel, GunsPanel, InsurancePanel, OwnershipPanel, PassengersPanel, StoresPanel, WarehousePanel } from "@/components/kibb/fleet-ui-ship";
import { useCatalog } from "@/hooks/use-catalog";
import { usePoll } from "@/hooks/use-poll";
import { dash, kibbGet, kibbPost } from "@/lib/kibb/browser";
import { fmtBps, fmtCr, fmtIn, fmtTime, fmtTons } from "@/lib/kibb/format";
import type { FleetView } from "@/lib/kibb/fleet-registry";
import type * as S from "@/lib/kibb/schema";
import type { DepartResult, DockActionResult, RoutePlan, ShipResult, WorldClock, ZoneClass } from "@/lib/kibb/types";

const HULL_RANK: Record<ZoneClass, number> = { coastal: 0, regional: 1, oceanic: 2 };

function DepartForm({
  r,
  blocked,
  locked,
  policy,
  onDone,
}: {
  r: ShipResult;
  blocked: boolean;
  locked: boolean;
  /** The ship's open or active policy: it covers only the voyage to its port. */
  policy: S.InsurancePolicy | undefined;
  onDone: () => void;
}) {
  const { catalog, portName } = useCatalog();
  const { data: clock } = usePoll(() => kibbGet<WorldClock>("/v1/world/clock"));
  const [picked, setPicked] = useState<string | null>(null);
  const dest = picked ?? policy?.dest_port_id ?? "";
  const voids = !!policy && !!dest && dest !== policy.dest_port_id;
  // Cargo loaded since the policy was written voids it at departure. The game values cargo at the
  // higher of base price and the local mid, so cargo worth more than declared even at base prices
  // means more was loaded.
  const declared = policy ? Math.max(0, policy.insured_value_pence - policy.hull_value_pence) : 0;
  const aboardAtBase = Object.entries(r.cargo_manifest).reduce(
    (n, [g, t]) => n + t * (catalog?.commodities.find((c) => c.id === g)?.base_price_pence ?? 0),
    0,
  );
  // Hull-only cover declares no cargo on purpose: nothing to compare.
  const overDeclared = !!policy && policy.insured_value_pence > policy.hull_value_pence && aboardAtBase > declared * 1.02 + 100;
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
    // The policy's port stays listed while the clock loads, so a defaulted destination always shows.
    .filter((p) => p.id !== from && (p.phase <= (clock?.unlocked_phase ?? 1) || p.id === policy?.dest_port_id))
    .sort((a, b) => a.name.localeCompare(b.name));
  // A leg is rated when the hull covers both the lane and the sea zone it ends in (hazards roll there; the last leg ends
  // at the port, whose own zone counts): the rougher of the two (guide 3.3/3.5).
  const legClass = (l: RoutePlan["legs"][number]): ZoneClass => {
    const zoneId = catalog?.sea_zones.some((z) => z.id === l.to_node) ? l.to_node : catalog?.ports.find((p) => p.id === l.to_node)?.sea_zone_id;
    const zone = catalog?.sea_zones.find((z) => z.id === zoneId)?.zone_class;
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
        <NativeSelect value={dest} onChange={(e) => { setPicked(e.target.value); setResult(null); }}>
          <option value="">Choose a port…</option>
          {ports.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </NativeSelect>
      </div>
      {voids && policy && <ErrorNote error={`Sailing here voids the ${policy.status} policy to ${portName(policy.dest_port_id)}: no claim would ever be paid.`} />}
      {!voids && overDeclared && policy && (
        <ErrorNote
          error={`The cargo aboard looks worth more (${fmtCr(aboardAtBase)} at base prices) than the ${fmtCr(declared)} declared on the policy. If it was loaded after insuring, the policy is void when the ship sails.`}
        />
      )}
      {policy && !voids && dest && policy.covered_bps < 10_000 && (
        <p className="rounded-md bg-warning/10 px-3 py-2 text-sm text-warning-foreground">
          {policy.covered_bps === 0
            ? "No underwriter has written this policy yet: the voyage sails uninsured."
            : `The policy is covered ${fmtBps(policy.covered_bps)}: the rest is uninsured.`}
        </p>
      )}
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
      {r.ship.convoy_id && <p className="text-muted-foreground text-xs">This ship is in a convoy: it sails with the convoy, not alone.</p>}
      <Button disabled={!dest || busy || unrated.length > 0 || blocked || locked || !!r.ship.convoy_id} onClick={depart}>
        {busy ? "Departing…" : locked ? `Locked ${fmtIn(r.ship.turnaround_unlocks_at)}` : "Depart"}
      </Button>
    </div>
  );
}

export default function ShipPage() {
  const { shipId } = useParams<{ shipId: string }>();
  const { catalog, portName, goodName, shipClassName } = useCatalog();
  const { data: r, error, reload } = usePoll(() => kibbGet<ShipResult>("/v1/fleet/ship", { ship_id: shipId }), 5_000, [shipId]);
  const { data: fleet } = usePoll(() => dash.get<FleetView>("/api/kibb/fleet"), 10_000);
  const { data: policies, reload: reloadPolicies } = usePoll(
    () => kibbGet<S.InsurancePolicy[]>("/v1/insurance/list", { ship_id: shipId, limit: 20 }),
    30_000,
    [shipId],
  );
  // A lien is a borrower loan pledging her; a defaulted one arrests her (guide 3.13.1).
  const pledges = usePledgedShips();
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [override, setOverride] = useState(false);

  if (!r) {
    return error ? <ErrorNote error={error} /> : <Loading />;
  }
  const s = r.ship;
  const cls = catalog?.ship_classes.find((c) => c.id === s.ship_class);
  const runnerOwnsShip = !!fleet?.enabled && !!fleet.state?.agents.some((a) => a.shipId === s.id);
  const locked = s.status === "berthed" && !!s.turnaround_unlocks_at && Date.parse(s.turnaround_unlocks_at) > Date.now();
  const blocked = runnerOwnsShip && !override;
  const insured = (policies ?? []).some((p) => p.status === "open" || p.status === "active");
  const lien = pledges.byShip.get(s.id);
  const arrested = lien?.status === "defaulted";
  const done = () => {
    void reload();
    void pledges.reload();
  };

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
    <div className="space-y-5 pb-8 sm:space-y-6">
      <PageHeader
        back={["/fleet", "Fleet"]}
        title={s.name}
        badges={
          <>
            <ShipStatusBadge status={s.status} />
            {arrested ? <Badge variant="error">arrested</Badge> : lien ? <Badge variant="warning">{lien.is_mortgage ? "mortgaged" : "liened"}</Badge> : null}
            {s.dispatches_sealed && <Badge variant="outline">dispatches sealed</Badge>}
          </>
        }
        subtitle={`${shipClassName(s.ship_class)} · ${cls?.hull_category ?? "?"} hull · ${s.cannons_count}/${cls?.max_cannons ?? "?"} guns · crew ${cls?.crew_required ?? "?"}`}
      />

      {runnerOwnsShip && (
        <div className="space-y-1.5 rounded-md bg-warning/10 px-3 py-2 text-sm text-warning-foreground">
          <p>The fleet autopilot is sailing this ship. Stop it on the dashboard before giving manual orders.</p>
          <label className="flex items-center gap-2 text-xs">
            <input type="checkbox" checked={override} onChange={(e) => setOverride(e.target.checked)} />
            I know, act anyway
          </label>
        </div>
      )}

      {arrested && (
        <p className="rounded-md bg-destructive/10 px-3 py-2 text-destructive text-sm">
          Arrested: the loan pledging her defaulted, so she can&apos;t depart or join a convoy until the lender has her or the debt is paid (
          <Link href="/loans" className="underline">
            Loans
          </Link>
          ).
        </p>
      )}

      <div className="grid items-start gap-4 lg:grid-cols-3">
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
              ["After guns, stores and passengers", fmtTons(r.effective_hold_capacity_tons)],
              ...(s.passenger_hold_tons > 0 ? ([["Passengers take", fmtTons(s.passenger_hold_tons)]] as Array<[string, string]>) : []),
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

        <StoresPanel r={r} blocked={blocked} onDone={done} />
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
        <div className="grid items-start gap-4 lg:grid-cols-3">
          <Panel title="Berth">
            <div className="space-y-3 text-sm">
              {s.status === "anchored_roadstead" ? (
                <>
                  <p className="text-muted-foreground">
                    In the roadstead: free, but you can only deliver charters and freight from here. Dock to trade.
                  </p>
                  {s.convoy_id && <p className="text-muted-foreground text-xs">In a convoy: leave it before docking.</p>}
                  <Button size="sm" disabled={busy || blocked || !!s.dock_queued_at || !!s.convoy_id} onClick={() => dockAction("dock")}>
                    {s.dock_queued_at ? "Queued for a berth" : "Dock"}
                  </Button>
                </>
              ) : (
                <>
                  <p className="text-muted-foreground">Berthed: berth dues accrue daily. Move to the roadstead to wait for free.</p>
                  <Button size="sm" variant="outline" disabled={busy || blocked || locked} onClick={() => dockAction("offshore")}>
                    {locked ? `Locked ${fmtIn(s.turnaround_unlocks_at)}` : "Move to roadstead"}
                  </Button>
                </>
              )}
              <ErrorNote error={actionError} />
            </div>
          </Panel>
          <Panel title="Depart" className="lg:col-span-2">
            <DepartForm
              r={r}
              blocked={blocked || arrested}
              locked={locked}
              policy={(policies ?? []).find((p) => p.status === "open" || p.status === "active")}
              onDone={done}
            />
          </Panel>
        </div>
      )}

      <div className="grid items-start gap-4 lg:grid-cols-2">
        <div className="space-y-4">
          <ContractsPanel r={r} blocked={blocked} onDone={done} />
          <PassengersPanel r={r} blocked={blocked} onDone={done} />
        </div>
        <div className="space-y-4">
          <WarehousePanel r={r} blocked={blocked} onDone={done} />
          <GunsPanel r={r} blocked={blocked} onDone={done} insured={insured} />
          <OwnershipPanel r={r} insured={insured} lien={lien} liensKnown={pledges.known} blocked={blocked} onDone={done} />
        </div>
      </div>

      <div className="grid items-start gap-4 lg:grid-cols-2">
        <InsurancePanel r={r} blocked={blocked} onDone={done} policies={policies} reload={() => void reloadPolicies()} />
        <ConvoysPanel r={r} blocked={blocked} onDone={done} policies={policies} />
      </div>
    </div>
  );
}
