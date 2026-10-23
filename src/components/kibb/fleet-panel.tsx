"use client";

import { useState } from "react";
import Link from "next/link";
import { PlayIcon, Settings2Icon, SquareIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Empty, ErrorNote, Loading, Metrics, NativeSelect, Panel, Table } from "@/components/kibb/bits";
import { useCatalog } from "@/hooks/use-catalog";
import { usePoll } from "@/hooks/use-poll";
import { dash } from "@/lib/kibb/browser";
import { fmtBps, fmtCr, fmtIn, fmtTime, fmtTons } from "@/lib/kibb/format";
import type { FleetView } from "@/lib/kibb/fleet-registry";
import type { TimeUse } from "@/lib/kibb/fleet/agent";
import type { FleetSettings, GunPolicy } from "@/lib/kibb/fleet/manager";
import type { Lane } from "@/lib/kibb/fleet/planner";

const TIME_PARTS: Array<{ key: keyof TimeUse; label: string; className: string }> = [
  { key: "laden", label: "Laden", className: "bg-success" },
  { key: "ballast", label: "Empty at sea", className: "bg-info" },
  { key: "port", label: "In port", className: "bg-warning" },
  { key: "idle", label: "Idle", className: "bg-destructive" },
];

const pct = (part: number, total: number) => (total > 0 ? Math.round((part / total) * 100) : 0);

/** One bar split by where the time went. */
function TimeBar({ t }: { t: TimeUse }) {
  const total = t.laden + t.ballast + t.port + t.idle;
  if (!total) return <div className="h-2 w-full rounded-full bg-muted" />;
  return (
    <div className="flex h-2 w-full overflow-hidden rounded-full bg-muted">
      {TIME_PARTS.map((p) => (
        <div key={p.key} className={p.className} style={{ width: `${(t[p.key] / total) * 100}%` }} title={`${p.label} ${pct(t[p.key], total)}%`} />
      ))}
    </div>
  );
}

function SettingsForm({
  settings,
  busy,
  onSave,
  onCancel,
}: {
  settings: FleetSettings;
  busy: boolean;
  /** Only the fields that changed. */
  onSave: (patch: Partial<FleetSettings>) => void;
  onCancel: () => void;
}) {
  const { catalog, shipClassName } = useCatalog();
  const [d, setD] = useState(settings);
  // What the form opened with: the diff is what the user changed here, not what changed elsewhere since.
  const [initial] = useState(settings);
  const crField = (label: string, key: "reservePence" | "minMarginPence" | "underwriteBudgetPence" | "underwriteMaxPerPolicyPence") => (
    <div className="space-y-1">
      <Label>{label}</Label>
      <Input type="number" min={0} value={d[key] / 100} onChange={(e) => setD({ ...d, [key]: Math.round(Number(e.target.value) * 100) })} />
    </div>
  );
  return (
    <form
      className="grid gap-3 rounded-lg border p-3 sm:grid-cols-2 sm:p-4 lg:grid-cols-3"
      onSubmit={(e) => {
        e.preventDefault();
        // Send only what changed: a stale copy of another setting (say, marques) must not overwrite it.
        const patch = Object.fromEntries(
          Object.entries(d).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(initial[k as keyof FleetSettings])),
        ) as Partial<FleetSettings>;
        if (patch.underwrite && !confirm(`Let the autopilot underwrite other companies' voyages, locking up to ${fmtCr(d.underwriteBudgetPence)} of collateral?`)) return;
        onSave(patch);
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
      <div className="space-y-1">
        <Label>Guns</Label>
        <NativeSelect value={d.guns} onChange={(e) => setD({ ...d, guns: e.target.value as GunPolicy })}>
          <option value="auto">Auto: what each lane&apos;s pirates justify</option>
          <option value="full">Full battery on every ship</option>
          <option value="off">Leave guns as they are</option>
        </NativeSelect>
      </div>
      <div className="space-y-1">
        <Label>Phase bonus counted (%)</Label>
        <Input
          type="number"
          min={0}
          max={100}
          step={5}
          value={d.bonusWeightPct}
          onChange={(e) => setD({ ...d, bonusWeightPct: Math.min(100, Math.max(0, Number(e.target.value))) })}
        />
      </div>
      <div className="col-span-full space-y-1.5">
        <Label>Classes the buyer may build</Label>
        <div className="grid gap-x-4 gap-y-1.5 text-sm sm:grid-cols-2 xl:grid-cols-4">
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
      <div className="col-span-full flex flex-col gap-2 text-sm sm:flex-row sm:flex-wrap sm:gap-4">
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={d.autoBuy} onChange={(e) => setD({ ...d, autoBuy: e.target.checked })} />
          Buy ships automatically
        </label>
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={d.useFreight} onChange={(e) => setD({ ...d, useFreight: e.target.checked })} />
          Carry freight on empty legs
        </label>
      </div>
      <div className="col-span-full space-y-2 rounded-lg border border-dashed p-3">
        <label className="flex items-center gap-1.5 text-sm">
          <input type="checkbox" checked={d.underwrite} onChange={(e) => setD({ ...d, underwrite: e.target.checked })} />
          Underwrite other companies&apos; voyages (off by default)
        </label>
        <div className="grid gap-3 sm:grid-cols-3">
          {crField("Collateral budget (Cr)", "underwriteBudgetPence")}
          {crField("Most per policy (Cr)", "underwriteMaxPerPolicyPence")}
          <div className="space-y-1">
            <Label>Least edge (bps)</Label>
            <Input type="number" min={0} step={10} value={d.underwriteMinEdgeBps} onChange={(e) => setD({ ...d, underwriteMinEdgeBps: Math.max(0, Math.floor(Number(e.target.value))) })} />
          </div>
        </div>
        <p className="text-muted-foreground text-xs">
          Writes small slices only on fresh policies whose premium beats the loss Lloyd&apos;s accepting the same lane implies,
          by the least edge. A sinking pays out the whole slice of the sum insured. All escrow counts against the budget.
        </p>
      </div>
      <p className="col-span-full text-muted-foreground text-xs">
        Each gun takes 2 t of hold. Auto refits a ship at shipyard calls when it pays: in quiet Channel and North Sea water that means none.
        Expansion charters also earn a share of the phase-completion bonus when the tier fills; the percentage is how much of that
        expected share counts when choosing lanes and buy prices.
      </p>
      <div className="col-span-full flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button size="sm" type="submit" disabled={busy}>Save (applies immediately)</Button>
      </div>
    </form>
  );
}

export function FleetPanel() {
  const { portName, goodName, shipClassName } = useCatalog();
  // "rye flour + timber (sell) + freight", main good first.
  const loadText = (l: Lane) =>
    [
      ...(l.parts ?? []).map((p) => `${goodName(p.good)}${p.kind === "market" ? " (sell)" : ""}`),
      ...((l.freight ?? []).length ? ["freight"] : []),
    ].join(" + ") || goodName(l.good);
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

  const agents = st?.agents ?? [];
  const doing = (a: (typeof agents)[number]) => (a.status === "sailing" ? `→ ${portName(a.dest)} ${fmtIn(a.eta)}` : a.activity);
  const laneText = (a: (typeof agents)[number]) => (a.lane ? `${loadText(a.lane)}: ${portName(a.lane.source)} → ${portName(a.lane.dest)}` : null);
  const agentNet = (a: (typeof agents)[number]) => a.stats.rewardPence + a.stats.freightPence - a.stats.spentPence;

  return (
    <Panel
      title={
        <span className="flex items-center gap-2">
          Fleet autopilot {statusBadge}
        </span>
      }
      action={
        <>
          <Button size="sm" variant="ghost" onClick={() => setEditing(!editing)}>
            <Settings2Icon />
            {editing ? "Close" : "Settings"}
          </Button>
          <Button size="sm" variant={on ? "outline" : "default"} disabled={busy} onClick={() => void send({ enabled: !on })}>
            {on ? <SquareIcon /> : <PlayIcon />}
            {on ? "Stop" : "Start"}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <p className="text-muted-foreground text-sm">
          {st ? `${agents.length} ship${agents.length === 1 ? "" : "s"} under command` : "Not running since the server started"}
          {" · "}
          Buyer: {view.settings.autoBuy ? (st?.buyer ?? "idle") : "off"}
        </p>

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
          <div className="space-y-1.5">
            <Metrics
              items={[
                { label: "Net", value: <span className={net < 0 ? "text-destructive" : undefined}>{fmtCr(net)}</span> },
                { label: "Charter pay", value: fmtCr(t.rewardPence) },
                { label: "Freight", value: fmtCr(t.freightPence) },
                { label: "Cargo bought", value: fmtCr(t.spentPence) },
                { label: "Delivered", value: fmtTons(t.deliveredTons), hint: `${t.trips} trip${t.trips === 1 ? "" : "s"}` },
                { label: "Ships bought", value: t.shipsBought, hint: t.shipsBought ? fmtCr(t.shipSpendPence) : undefined },
              ]}
            />
            <p className="text-muted-foreground text-xs">Since the autopilot started. Cargo bought includes loads still on their way to a charter.</p>
          </div>
        )}

        {agents.length > 0 && (
          <>
            {/* Phones: one card per ship. */}
            <div className="space-y-2 md:hidden">
              {agents.map((a) => (
                <Link key={a.shipId} href={`/fleet/${a.shipId}`} className="block rounded-lg border p-3 transition-colors hover:bg-accent/50">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="truncate font-medium">{a.name}</span>
                    <span className="shrink-0 text-muted-foreground text-xs">{shipClassName(a.shipClass)}</span>
                  </div>
                  <div className="mt-1 text-sm">{doing(a)}</div>
                  {laneText(a) && <div className="mt-0.5 text-muted-foreground text-xs">{laneText(a)}</div>}
                  <div className="mt-2 flex justify-between gap-2 text-muted-foreground text-xs tabular-nums">
                    <span>{fmtTons(a.cargoTons)} / {fmtTons(a.hold)}</span>
                    <span>{a.stats.trips} trips</span>
                    <span>{fmtCr(agentNet(a))}</span>
                  </div>
                </Link>
              ))}
            </div>
            <Table head={["Ship", "Doing", "Lane", "Hold", "Trips", "Net"]} className="hidden md:block">
              {agents.map((a) => (
                <tr key={a.shipId} className="align-top">
                  <td className="whitespace-nowrap">
                    <Link href={`/fleet/${a.shipId}`} className="font-medium hover:underline">{a.name}</Link>
                    <div className="text-muted-foreground text-xs">{shipClassName(a.shipClass)}</div>
                  </td>
                  <td className="text-xs">
                    {doing(a)}
                    {a.freight.length > 0 && <div className="text-muted-foreground">+ freight to {a.freight.map((f) => portName(f.dest)).join(", ")}</div>}
                  </td>
                  <td className="text-xs">
                    {a.lane ? (
                      <>
                        {laneText(a)}
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
                  <td className="whitespace-nowrap tabular-nums">{fmtCr(agentNet(a))}</td>
                </tr>
              ))}
            </Table>
          </>
        )}

        {agents.length > 0 && <Efficiency agents={agents} startedAt={st?.startedAt ?? null} stoppedAt={st?.stoppedAt ?? null} />}

        {st?.underwriting && (
          <details className="text-sm">
            <summary className="cursor-pointer text-muted-foreground text-xs">
              Underwriting: {st.underwriting.action} · escrow {fmtCr(st.underwriting.lockedPence)} of {fmtCr(st.underwriting.budgetPence)}
            </summary>
            {st.underwriting.rows.length === 0 ? (
              <Empty>No open policies from other companies.</Empty>
            ) : (
              <Table head={["Policy", "Premium", "Loss bound", "Edge", "Slice", "Verdict"]} className="mt-2">
                {st.underwriting.rows.map((u) => (
                  <tr key={u.policy} className="align-top">
                    <td className="text-xs">
                      <div className="font-medium text-sm">{u.lane}</div>
                      {u.cover === "hull" ? "hull only" : "with cargo"} · {fmtCr(u.insured)}
                    </td>
                    <td className="tabular-nums">{fmtBps(u.premiumBps)}</td>
                    <td className="tabular-nums">{u.lossBoundBps === null ? "—" : fmtBps(u.lossBoundBps)}</td>
                    <td className="tabular-nums">{u.edgeBps === null ? "—" : fmtBps(u.edgeBps)}</td>
                    <td className="whitespace-nowrap tabular-nums">{u.sliceBps ? `${fmtBps(u.sliceBps)} · ${fmtCr(u.collateral)}` : "—"}</td>
                    <td className="text-muted-foreground text-xs">{u.verdict}</td>
                  </tr>
                ))}
              </Table>
            )}
          </details>
        )}

        <div className="grid items-start gap-5 xl:grid-cols-5">
          <div className="space-y-1.5 xl:col-span-3">
            <div className="text-muted-foreground text-xs">Log</div>
            <div className="max-h-80 min-h-20 overflow-y-auto rounded-lg bg-muted/40 p-3 font-mono text-xs leading-relaxed">
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

          <div className="space-y-5 xl:col-span-2">
            {st && st.topLanes.length > 0 && (
              <div className="space-y-1.5">
                <div className="text-muted-foreground text-xs">Best lanes right now (planner&apos;s view)</div>
                <Table head={["Lane", "Load", "Margin", "Piracy", "Est. /h"]}>
                  {st.topLanes.map((l) => (
                    <tr key={l.key} className="align-top">
                      <td className="text-xs">
                        <div className="font-medium text-sm">{loadText(l)}</div>
                        {portName(l.source)} → {portName(l.dest)}
                        {l.next && <div className="text-muted-foreground">then {l.next}</div>}
                      </td>
                      <td className="tabular-nums">{fmtTons(l.tons)}</td>
                      <td className="whitespace-nowrap tabular-nums">
                        {fmtCr(l.margin)}/t{!l.askKnown && <span className="text-muted-foreground"> est.</span>}
                        {l.bonus > 0 && <div className="text-muted-foreground text-xs">incl. {fmtCr(l.bonus)} bonus</div>}
                      </td>
                      <td className="text-muted-foreground tabular-nums" title="Expected share of the load lost to pirates, priced into the margin">
                        {fmtBps(l.piracyBps ?? 0)}
                      </td>
                      <td className="whitespace-nowrap tabular-nums">{fmtCr(l.profitPerHour)}</td>
                    </tr>
                  ))}
                </Table>
              </div>
            )}

            {st && st.purchases.length > 0 && (
              <div className="space-y-1.5">
                <div className="text-muted-foreground text-xs">Ships bought</div>
                <ul className="space-y-1 text-xs">
                  {[...st.purchases].reverse().map((p) => (
                    <li key={p.shipId}>
                      <span className="text-muted-foreground">{fmtTime(p.at)}</span> {shipClassName(p.shipClass)} “{p.name}” at {portName(p.port)} for{" "}
                      {fmtCr(p.costPence)} · payback ~{p.paybackHours} h
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>
      </div>
    </Panel>
  );
}

/** Where each ship's time goes, what it earns an hour, and its recent trips against the planner's estimate. */
function Efficiency({
  agents,
  startedAt,
  stoppedAt,
}: {
  agents: NonNullable<FleetView["state"]>["agents"];
  startedAt: string | null;
  stoppedAt: string | null;
}) {
  const { portName, goodName } = useCatalog();
  const zero: TimeUse = { laden: 0, ballast: 0, port: 0, idle: 0 };
  const timeOf = (a: (typeof agents)[number]) => a.time ?? zero;
  const fleet = agents.reduce<TimeUse>((t, a) => {
    const x = timeOf(a);
    return { laden: t.laden + x.laden, ballast: t.ballast + x.ballast, port: t.port + x.port, idle: t.idle + x.idle };
  }, zero);
  const total = fleet.laden + fleet.ballast + fleet.port + fleet.idle;
  const end = stoppedAt ? Date.parse(stoppedAt) : Date.now();
  const hours = startedAt ? Math.max((end - Date.parse(startedAt)) / 3_600_000, 1 / 60) : null;
  const trips = agents
    .flatMap((a) => (a.trips ?? []).map((t) => ({ ...t, ship: a.name })))
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 8);
  const laneLabel = (lane: string) => {
    const m = /^(\S+) (\S+) → (\S+)$/.exec(lane);
    return m ? `${goodName(m[1])}: ${portName(m[2])} → ${portName(m[3])}` : lane;
  };

  return (
    <div className="grid items-start gap-5 lg:grid-cols-2">
      <div className="space-y-2">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <span className="text-muted-foreground text-xs">Where the time goes</span>
          <span className="flex flex-wrap gap-x-3 gap-y-1 text-muted-foreground text-xs">
            {TIME_PARTS.map((p) => (
              <span key={p.key} className="flex items-center gap-1">
                <span className={`inline-block size-2 rounded-full ${p.className}`} />
                {p.label} {pct(fleet[p.key], total)}%
              </span>
            ))}
          </span>
        </div>
        <ul className="space-y-2">
          {agents.map((a) => {
            const net = a.stats.rewardPence + a.stats.freightPence - a.stats.spentPence;
            return (
              <li key={a.shipId} className="space-y-1">
                <div className="flex items-baseline justify-between gap-2 text-xs">
                  <span className="truncate font-medium">
                    {a.name} <span className="font-normal text-muted-foreground">· {a.guns ?? "?"} guns</span>
                  </span>
                  <span className="shrink-0 text-muted-foreground tabular-nums">{hours ? `${fmtCr(net / hours)}/h` : "—"}</span>
                </div>
                <TimeBar t={timeOf(a)} />
              </li>
            );
          })}
        </ul>
        <p className="text-muted-foreground text-xs">Cr/h is net cash since the autopilot started; cargo still aboard counts as spent until it is delivered.</p>
      </div>

      <div className="space-y-1.5">
        <div className="text-muted-foreground text-xs">Recent trips: planner&apos;s cash estimate against what it made (both up to delivery, phase bonus excluded)</div>
        {trips.length === 0 ? (
          <Empty>No completed trips yet.</Empty>
        ) : (
          <Table head={["Trip", "Tons", "Est. /h", "Made /h"]}>
            {trips.map((t) => (
              <tr key={`${t.ship}-${t.at}`}>
                <td className="text-xs">
                  <div className="font-medium text-sm">{t.ship}</div>
                  {laneLabel(t.lane)} · {t.hours} h
                </td>
                <td className="tabular-nums">{fmtTons(t.tons)}</td>
                <td className="whitespace-nowrap tabular-nums">{fmtCr(t.estPerHour)}</td>
                <td className={`whitespace-nowrap tabular-nums ${t.actualPerHour < t.estPerHour * 0.7 ? "text-destructive" : ""}`}>
                  {fmtCr(t.actualPerHour)}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </div>
    </div>
  );
}
