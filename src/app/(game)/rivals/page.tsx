"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { CrosshairIcon, ShipIcon, SwordsIcon, UsersIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Empty, ErrorNote, KV, Loading, PageHeader, Panel, StatTile, Table } from "@/components/kibb/bits";
import { useAction } from "@/hooks/use-action";
import { useCatalog } from "@/hooks/use-catalog";
import { usePoll } from "@/hooks/use-poll";
import { dash } from "@/lib/kibb/browser";
import { fmtAgo, fmtBps, fmtCr, fmtDateTime, fmtIn } from "@/lib/kibb/format";
import type { FleetView } from "@/lib/kibb/fleet-registry";
import type { RivalShip, RivalsView } from "@/lib/kibb/rivals";

const LOAD_LABEL = { ballast: "in ballast", part_laden: "part laden", laden: "laden" } as const;

/** `now` and `local` are on the server's clock; `local` turns a server time into a browser one for "in"/"ago" texts. */
function whereabouts(r: RivalShip, now: number, local: (ts: number) => string, portName: (id: string | null | undefined) => string): string {
  const v = r.voyage;
  if (v && now < v.arriveAt) {
    const pct = Math.round(((now - v.departAt) / Math.max(v.arriveAt - v.departAt, 1)) * 100);
    return `at sea ${portName(v.from)} → ${portName(v.to)}, ~${pct}% (arrives ${fmtIn(local(v.arriveAt))})`;
  }
  if (v) return `probably at ${portName(r.inPort ?? v.to)} (due ${fmtAgo(local(v.arriveAt))})`;
  if (r.inPort) return `at ${portName(r.inPort)} as of ${fmtAgo(local(r.seen.at))}`;
  return "unknown";
}

function MarqueSettings({ view, onDone }: { view: RivalsView; onDone: () => void }) {
  const [enabled, setEnabled] = useState(view.settings.marques);
  const [budgetCr, setBudgetCr] = useState(String(view.settings.marqueBudgetPence / 100));
  const act = useAction<FleetView>(onDone);
  useEffect(() => {
    setEnabled(view.settings.marques);
    setBudgetCr(String(view.settings.marqueBudgetPence / 100));
  }, [view.settings.marques, view.settings.marqueBudgetPence]);
  const budget = Math.round(Number(budgetCr) * 100);
  const dirty = enabled !== view.settings.marques || budget !== view.settings.marqueBudgetPence;

  function save() {
    if (enabled && !view.settings.marques && !confirm(`Let the autopilot sponsor letters of marque, up to ${fmtCr(budget)} in any 24 hours?`)) return;
    // Only what changed, so nothing else in the fleet settings is overwritten.
    const settings: Record<string, unknown> = {};
    if (enabled !== view.settings.marques) settings.marques = enabled;
    if (budget !== view.settings.marqueBudgetPence) settings.marqueBudgetPence = budget;
    void act.run(() => dash.post<FleetView>("/api/kibb/fleet", { settings }));
  }

  return (
    <div className="space-y-3">
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        Sponsor letters of marque automatically when they pay
      </label>
      <div className="flex flex-wrap items-end gap-2">
        <div className="w-full space-y-1 sm:w-48">
          <label className="text-muted-foreground text-xs">Budget per 24 hours (Cr)</label>
          <Input type="number" min={0} step={100} value={budgetCr} onChange={(e) => setBudgetCr(e.target.value)} />
        </div>
        <Button size="sm" disabled={!dirty || act.busy || !Number.isFinite(budget) || budget < 0} onClick={save}>
          {act.busy ? "Saving…" : "Save"}
        </Button>
      </div>
      <ErrorNote error={act.error} />
      <p className="text-muted-foreground text-xs">
        A marque raises piracy in its zone for everyone, your ships included, and pays you a share of what pirates seize there. The
        autopilot sponsors one, for a game day at a time, only where the rival traffic it has seen makes the expected prize money beat
        the cost plus your own ships&apos; extra losses by half again, and never past the budget. Your lanes already price the zone&apos;s
        piracy, so your ships steer around it when that is cheaper.
      </p>
    </div>
  );
}

export default function RivalsPage() {
  const { catalog, portName, shipClassName } = useCatalog();
  const { data: view, error, reload } = usePoll(() => dash.get<RivalsView>("/api/kibb/rivals"), 30_000);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(t);
  }, []);

  // The server's clock, carried forward from the last fetch.
  const [fetchedAt, setFetchedAt] = useState(() => Date.now());
  useEffect(() => {
    if (view) setFetchedAt(Date.now());
  }, [view]);
  const serverNow = view ? view.now + (now - fetchedAt) : now;
  const offset = view ? view.now - fetchedAt : 0;
  const local = (ts: number) => new Date(ts - offset).toISOString();
  const zoneName = (id: string) => catalog?.sea_zones.find((z) => z.id === id)?.name ?? id;
  const zoneClass = (id: string) => catalog?.sea_zones.find((z) => z.id === id)?.zone_class ?? "";
  const companies = new Map<string, RivalShip[]>();
  for (const r of view?.rivals ?? []) companies.set(r.company, [...(companies.get(r.company) ?? []), r]);
  const prize = (view?.marques ?? []).reduce((n, m) => n + m.prize_earned_pence, 0);
  const spent = (view?.marques ?? []).reduce((n, m) => n + m.cost_pence, 0);

  return (
    <div className="space-y-5 pb-8 sm:space-y-6">
      <PageHeader
        title="Rivals"
        subtitle="Other companies' ships, as seen at the ports where you have a ship or a Resident Factor, and whether a letter of marque on their routes would pay."
      />
      <ErrorNote error={error} />
      {!view ? (
        !error && <Loading />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatTile label="Rival ships seen" icon={<ShipIcon className="size-4" />} value={view.rivals.length} sub={`${companies.size} companies`} />
            <StatTile
              label="Watching"
              icon={<UsersIcon className="size-4" />}
              value={`${view.presence.length} port${view.presence.length === 1 ? "" : "s"}`}
              sub={view.presence.map((p) => portName(p)).join(", ") || "no ship or factor in port"}
            />
            <StatTile
              label="Laden rival passages"
              icon={<CrosshairIcon className="size-4" />}
              value={`${view.traffic.reduce((n, t) => Math.max(n, t.laden), 0).toFixed(1)}`}
              sub="a game day, busiest zone"
            />
            <StatTile
              label="Auto-marques"
              icon={<SwordsIcon className="size-4" />}
              value={view.settings.marques ? "On" : "Off"}
              sub={`prize ${fmtCr(prize)} on ${fmtCr(spent)} spent`}
            />
          </div>

          <div className="grid items-start gap-4 xl:grid-cols-3">
            <Panel title="Rival ships" className="xl:col-span-2" action={<Link href="/map" className="text-muted-foreground text-xs hover:text-foreground">On the map →</Link>}>
              {view.rivals.length === 0 ? (
                <Empty>
                  No rival ships seen yet. Ports list the ships that sailed or arrived in the last {view.windowGameHours} game hours, but only
                  where you have a ship or a factor.
                </Empty>
              ) : (
                <Table head={["Ship", "Last seen", "Load", "Probably"]}>
                  {[...companies].flatMap(([company, list]) =>
                    list
                      .sort((a, b) => b.seen.at - a.seen.at)
                      .map((r) => (
                        <tr key={r.key} className="align-top">
                          <td>
                            <div className="font-medium">{r.ship}</div>
                            <div className="text-muted-foreground text-xs">
                              {company} · {shipClassName(r.shipClass)}
                            </div>
                          </td>
                          <td className="text-xs">
                            {r.seen.direction === "sailed" ? "sailed from" : "arrived at"} {portName(r.seen.port)}
                            {r.seen.otherPort && ` ${r.seen.direction === "sailed" ? "for" : "from"} ${portName(r.seen.otherPort)}`}
                            <div className="text-muted-foreground">{fmtAgo(local(r.seen.at))}</div>
                          </td>
                          <td>
                            <Badge variant={r.loadState === "laden" ? "warning" : "outline"} size="sm">
                              {LOAD_LABEL[r.loadState]}
                            </Badge>
                          </td>
                          <td className="text-xs">{whereabouts(r, serverNow, local, portName)}</td>
                        </tr>
                      )),
                  )}
                </Table>
              )}
              <p className="mt-3 text-muted-foreground text-xs">
                Positions are estimates: the route to where a ship said it was bound, at its class&apos;s speed. Cargo, guns and timings are never public.
              </p>
            </Panel>

            <Panel title="Letters of marque">
              <div className="space-y-4">
                <MarqueSettings view={view} onDone={() => void reload()} />
                <KV
                  rows={[
                    ["Autopilot", view.autopilot],
                    ["Last check", view.report ? fmtAgo(view.report.checkedAt) : "—"],
                    ["Outcome", view.report?.action ?? (view.autopilot === "running" ? "first check within 5 minutes" : "checks run while the autopilot runs")],
                    ["Spent, last 24 h", view.report ? `${fmtCr(view.report.spentPence)} of ${fmtCr(view.report.budgetPence)}` : "—"],
                  ]}
                />
                {view.marques.length > 0 && (
                  <Table head={["Zone", "Added", "Cost", "Prize", "Ends"]}>
                    {view.marques.map((m) => (
                      <tr key={m.id}>
                        <td className="text-xs">{zoneName(m.sea_zone_id)}</td>
                        <td className="tabular-nums">{fmtBps(m.added_piracy_bps)}</td>
                        <td className="tabular-nums">{fmtCr(m.cost_pence)}</td>
                        <td className={`tabular-nums ${m.prize_earned_pence >= m.cost_pence ? "text-success-foreground" : ""}`}>{fmtCr(m.prize_earned_pence)}</td>
                        <td className="text-muted-foreground text-xs">{Date.parse(m.expires_at) > Date.now() ? fmtIn(m.expires_at) : fmtDateTime(m.expires_at)}</td>
                      </tr>
                    ))}
                  </Table>
                )}
              </div>
            </Panel>
          </div>

          <Panel title="Rival traffic and marques by sea zone">
            {view.verdicts.length === 0 ? (
              <Empty>No rival sailings seen in the last game day.</Empty>
            ) : (
              <Table head={["Zone", "Piracy now", "Passages", "Laden", "Cargo", "Best marque", "Prize", "Cost", "Our losses", "Verdict"]}>
                {view.verdicts.map((v) => {
                  const z = view.zones.find((x) => x.sea_zone_id === v.zone);
                  return (
                    <tr key={v.zone} className="align-top">
                      <td>
                        <div className="font-medium text-sm">{zoneName(v.zone)}</div>
                        <div className="text-muted-foreground text-xs capitalize">{zoneClass(v.zone)}</div>
                      </td>
                      <td className="tabular-nums">{z ? fmtBps(z.net_piracy_bps) : "—"}</td>
                      <td className="tabular-nums">{v.passages.toFixed(1)}</td>
                      <td className="tabular-nums">{v.laden.toFixed(1)}</td>
                      <td className="whitespace-nowrap tabular-nums">{fmtCr(v.cargo)}</td>
                      <td className="tabular-nums">{fmtBps(v.best.bps)}</td>
                      <td className="whitespace-nowrap tabular-nums">{fmtCr(v.best.prize)}</td>
                      <td className="whitespace-nowrap tabular-nums">{fmtCr(v.best.cost)}</td>
                      <td className="whitespace-nowrap tabular-nums">{fmtCr(v.best.ownLoss)}</td>
                      <td className={`text-xs ${v.verdict === "pays" ? "text-success-foreground" : "text-muted-foreground"}`}>{v.verdict}</td>
                    </tr>
                  );
                })}
              </Table>
            )}
            <p className="mt-3 text-muted-foreground text-xs">
              Per game day. Passages count rival sailings seen in the last {view.windowGameHours} game hours; cargo is estimated from each ship&apos;s
              class and load and the goods its port of departure makes. Traffic you can&apos;t see (ports without your ships or factors) isn&apos;t counted,
              so these figures run low. The prize court pays half the seized cargo&apos;s base value times the marques&apos; share of the zone&apos;s piracy.
            </p>
          </Panel>
        </>
      )}
    </div>
  );
}
