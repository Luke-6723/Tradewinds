"use client";

import { useState } from "react";
import Link from "next/link";
import { PlayIcon, SquareIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Empty, ErrorNote, KV, Loading, Panel, Table } from "@/components/kibb/bits";
import { useCatalog } from "@/hooks/use-catalog";
import { usePoll } from "@/hooks/use-poll";
import { dash } from "@/lib/kibb/browser";
import { fmtCr, fmtIn, fmtTime, fmtTons } from "@/lib/kibb/format";
import type { FleetView } from "@/lib/kibb/fleet-registry";
import type { FleetSettings } from "@/lib/kibb/fleet/manager";

function SettingsForm({
  settings,
  busy,
  onSave,
  onCancel,
}: {
  settings: FleetSettings;
  busy: boolean;
  onSave: (s: FleetSettings) => void;
  onCancel: () => void;
}) {
  const { catalog, shipClassName } = useCatalog();
  const [d, setD] = useState(settings);
  const crField = (label: string, key: "reservePence" | "minMarginPence") => (
    <div className="space-y-1">
      <Label>{label}</Label>
      <Input type="number" min={0} value={d[key] / 100} onChange={(e) => setD({ ...d, [key]: Math.round(Number(e.target.value) * 100) })} />
    </div>
  );
  return (
    <form
      className="grid grid-cols-2 gap-3 rounded-lg border p-3 lg:grid-cols-4"
      onSubmit={(e) => {
        e.preventDefault();
        onSave(d);
      }}
    >
      {crField("Cash reserve (Cr)", "reservePence")}
      {crField("Min margin (Cr/t)", "minMarginPence")}
      <div className="space-y-1">
        <Label>Max ships</Label>
        <Input type="number" min={1} value={d.maxShips} onChange={(e) => setD({ ...d, maxShips: Math.max(1, Math.floor(Number(e.target.value))) })} />
      </div>
      <div className="space-y-1">
        <Label>Max payback (hours)</Label>
        <Input type="number" min={0.5} step={0.5} value={d.maxPaybackHours} onChange={(e) => setD({ ...d, maxPaybackHours: Number(e.target.value) })} />
      </div>
      <div className="col-span-full space-y-1.5">
        <Label>Classes the buyer may build</Label>
        <div className="flex flex-wrap gap-3 text-sm">
          {(catalog?.ship_classes ?? []).map((c) => (
            <label key={c.id} className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={d.buyClasses.includes(c.id)}
                onChange={(e) =>
                  setD({ ...d, buyClasses: e.target.checked ? [...d.buyClasses, c.id] : d.buyClasses.filter((x) => x !== c.id) })
                }
              />
              {shipClassName(c.id)} <span className="text-muted-foreground text-xs">({c.hull_category}, {c.hold_capacity_tons} t)</span>
            </label>
          ))}
        </div>
      </div>
      <div className="col-span-full flex flex-wrap gap-4 text-sm">
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={d.autoBuy} onChange={(e) => setD({ ...d, autoBuy: e.target.checked })} />
          Buy ships automatically
        </label>
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={d.armNewShips} onChange={(e) => setD({ ...d, armNewShips: e.target.checked })} />
          Arm new ships fully
        </label>
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={d.useFreight} onChange={(e) => setD({ ...d, useFreight: e.target.checked })} />
          Carry freight on empty legs
        </label>
      </div>
      <div className="col-span-full flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button size="sm" type="submit" disabled={busy}>Save (applies immediately)</Button>
      </div>
    </form>
  );
}

export function FleetPanel() {
  const { portName, goodName, shipClassName } = useCatalog();
  const { data: view, error, reload } = usePoll(() => dash.get<FleetView>("/api/kibb/fleet"), 4_000);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  if (!view) return <Panel title="Fleet autopilot">{error ? <ErrorNote error={error} /> : <Loading />}</Panel>;

  const st = view.state;
  const on = view.enabled;
  const t = st?.totals;
  const net = t ? t.rewardPence + t.freightPence - t.spentPence - t.shipSpendPence : 0;

  async function send(body: { enabled?: boolean; settings?: Partial<FleetSettings> }) {
    setBusy(true);
    setActionError(null);
    try {
      await dash.post<FleetView>("/api/kibb/fleet", body);
      await reload();
      return true;
    } catch (e) {
      setActionError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  const statusBadge =
    st?.status === "running" ? <Badge variant="success">Running</Badge>
    : st?.status === "starting" ? <Badge variant="info">Starting</Badge>
    : st?.status === "failed" ? <Badge variant="error">Failed</Badge>
    : <Badge variant="secondary">Stopped</Badge>;

  return (
    <Panel
      title="Fleet autopilot"
      action={
        <Button size="sm" variant={on ? "outline" : "default"} disabled={busy} onClick={() => void send({ enabled: !on })}>
          {on ? <SquareIcon /> : <PlayIcon />}
          {on ? "Stop" : "Start"}
        </Button>
      }
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
          {statusBadge}
          <span>
            {st ? `${st.agents.length} ship${st.agents.length === 1 ? "" : "s"} under command` : "Not running since the server started"}
          </span>
          <span className="text-muted-foreground text-xs">
            Buyer: {view.settings.autoBuy ? (st?.buyer ?? "idle") : "off"}
          </span>
          <button type="button" className="ml-auto text-muted-foreground text-xs hover:text-foreground" onClick={() => setEditing(!editing)}>
            {editing ? "Close settings" : "Settings"}
          </button>
        </div>

        <ErrorNote error={actionError ?? st?.error ?? null} />

        {editing && (
          <SettingsForm
            settings={view.settings}
            busy={busy}
            onCancel={() => setEditing(false)}
            onSave={async (s) => {
              if (await send({ settings: s })) setEditing(false);
            }}
          />
        )}

        {t && (
          <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4 xl:grid-cols-7">
            <KV rows={[["Trips", t.trips]]} />
            <KV rows={[["Delivered", fmtTons(t.deliveredTons)]]} />
            <KV rows={[["Charter pay", fmtCr(t.rewardPence)]]} />
            <KV rows={[["Freight", fmtCr(t.freightPence)]]} />
            <KV rows={[["Cargo bought", fmtCr(t.spentPence)]]} />
            <KV rows={[["Ships bought", `${t.shipsBought} · ${fmtCr(t.shipSpendPence)}`]]} />
            <KV rows={[["Net", fmtCr(net)]]} />
            <p className="col-span-full text-muted-foreground text-xs">
              Since the autopilot started. Cargo bought includes loads still on their way to a charter.
            </p>
          </div>
        )}

        {st && st.agents.length > 0 && (
          <Table head={["Ship", "Doing", "Lane", "Hold", "Trips", "Net"]}>
            {st.agents.map((a) => (
              <tr key={a.shipId}>
                <td className="whitespace-nowrap">
                  <Link href={`/fleet/${a.shipId}`} className="font-medium hover:underline">{a.name}</Link>
                  <div className="text-muted-foreground text-xs">{shipClassName(a.shipClass)}</div>
                </td>
                <td className="text-xs">
                  {a.status === "sailing" ? `→ ${portName(a.dest)} ${fmtIn(a.eta)}` : a.activity}
                  {a.freight.length > 0 && <div className="text-muted-foreground">+ freight to {a.freight.map((f) => portName(f.dest)).join(", ")}</div>}
                </td>
                <td className="text-xs">
                  {a.lane ? (
                    <>
                      {goodName(a.lane.good)}: {portName(a.lane.source)} → {portName(a.lane.dest)}
                      <div className="text-muted-foreground">
                        ~{fmtCr(a.lane.margin)}/t · ~{fmtCr(a.lane.profitPerHour)}/h
                      </div>
                    </>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </td>
                <td className="whitespace-nowrap tabular-nums">{fmtTons(a.cargoTons)} / {fmtTons(a.hold)}</td>
                <td className="tabular-nums">{a.stats.trips}</td>
                <td className="whitespace-nowrap tabular-nums">{fmtCr(a.stats.rewardPence + a.stats.freightPence - a.stats.spentPence)}</td>
              </tr>
            ))}
          </Table>
        )}

        {st && st.topLanes.length > 0 && (
          <details className="text-sm">
            <summary className="cursor-pointer text-muted-foreground text-xs">Best lanes right now (planner&apos;s view)</summary>
            <Table head={["Good", "Route", "Load", "Margin", "Est. /h"]} className="mt-2">
              {st.topLanes.map((l) => (
                <tr key={l.key}>
                  <td>{goodName(l.good)}</td>
                  <td className="text-xs">{portName(l.source)} → {portName(l.dest)}</td>
                  <td className="tabular-nums">{fmtTons(l.tons)}</td>
                  <td className="tabular-nums">
                    {fmtCr(l.margin)}/t{!l.askKnown && <span className="text-muted-foreground"> est.</span>}
                  </td>
                  <td className="tabular-nums">{fmtCr(l.profitPerHour)}</td>
                </tr>
              ))}
            </Table>
          </details>
        )}

        {st && st.purchases.length > 0 && (
          <div className="text-sm">
            <div className="mb-1 text-muted-foreground text-xs">Ships bought</div>
            <ul className="space-y-0.5 text-xs">
              {[...st.purchases].reverse().map((p) => (
                <li key={p.shipId}>
                  {fmtTime(p.at)} · {shipClassName(p.shipClass)} “{p.name}” at {portName(p.port)} for {fmtCr(p.costPence)} · payback ~{p.paybackHours} h
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="h-72 overflow-y-auto rounded-lg bg-muted/40 p-3 font-mono text-xs leading-relaxed">
          {st && st.log.length > 0 ? (
            [...st.log].reverse().map((l, i) => (
              <div key={`${l.at}-${i}`} className={l.msg.startsWith("FATAL") ? "text-destructive" : undefined}>
                <span className="text-muted-foreground">{fmtTime(l.at)}</span>{" "}
                <span className="text-primary">{l.source}</span> {l.msg}
              </div>
            ))
          ) : (
            <Empty>{on ? "Waiting for the first log line…" : "Press Start to put every ship under the autopilot."}</Empty>
          )}
        </div>
      </div>
    </Panel>
  );
}
