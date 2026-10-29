"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { CrosshairIcon, ShipIcon, SwordsIcon, TrendingUpIcon, UsersIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Empty, ErrorNote, KV, Loading, PageHeader, Panel, StatTile, Table } from "@/components/kibb/bits";
import { useAction } from "@/hooks/use-action";
import { useCatalog } from "@/hooks/use-catalog";
import { usePoll } from "@/hooks/use-poll";
import { dash } from "@/lib/kibb/browser";
import { fmtAgo, fmtBps, fmtCr, fmtDateTime, fmtIn, fmtTons } from "@/lib/kibb/format";
import type { FleetView } from "@/lib/kibb/fleet-registry";
import type { RivalShip, RivalsView } from "@/lib/kibb/rivals";

const LOAD_LABEL = { ballast: "in ballast", part_laden: "part laden", laden: "laden" } as const;
const SOURCE_LABEL = { quay: "quay", policy: "policy", convoy: "convoy", notice: "convoy news" } as const;

/** `now` and `local` are on the server's clock; `local` turns a server time into a browser one for "in"/"ago" texts. */
function whereabouts(r: RivalShip, now: number, local: (ts: number) => string, portName: (id: string | null | undefined) => string): string {
  const v = r.voyage;
  if (v && r.lost) return `lost on passage ${portName(v.from)} → ${portName(v.to)}`;
  // Not sailed yet: a standing policy (it sails when Lloyd's has covered it), or a forming convoy.
  if (v && now < v.departAt) {
    const when = v.departKnown || r.seen.direction === "convoy" ? `, sails ${fmtIn(local(v.departAt))}` : " (insured; sails soon)";
    return `in ${portName(v.from)}, bound for ${portName(v.to)}${when}`;
  }
  if (v && v.arriveKnown) return `at ${portName(v.to)} since ${fmtAgo(local(v.arriveAt))}`;
  if (v && now < v.arriveAt) {
    const pct = Math.round(((now - v.departAt) / Math.max(v.arriveAt - v.departAt, 1)) * 100);
    return `at sea ${portName(v.from)} → ${portName(v.to)}, ~${pct}% (arrives ${fmtIn(local(v.arriveAt))})`;
  }
  if (v) return `probably at ${portName(r.inPort ?? v.to)} (due ${fmtAgo(local(v.arriveAt))})`;
  if (r.inPort) return `at ${portName(r.inPort)} as of ${fmtAgo(local(r.seen.at))}`;
  return "unknown";
}

/** How a ship was last seen: on the quay (sailed or arrived), insured, or in a public convoy. */
function seenText(r: RivalShip, portName: (id: string | null | undefined) => string): string {
  const { port, otherPort, direction } = r.seen;
  if (direction === "insured") return `insured at ${portName(port)}${otherPort ? ` for ${portName(otherPort)}` : ""}`;
  if (direction === "convoy") return `in a convoy from ${portName(port)}${otherPort ? ` to ${portName(otherPort)}` : ""}`;
  const there = direction === "sailed" ? "sailed from" : "arrived at";
  return `${there} ${portName(port)}${otherPort ? ` ${direction === "sailed" ? "for" : "from"} ${portName(otherPort)}` : ""}`;
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
    if (enabled && !view.settings.marques && !confirm(`Let the autopilot sponsor letters of marque and naval patrols, up to ${fmtCr(budget)} in any 24 hours?`)) return;
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
        Sponsor letters of marque and naval patrols automatically when they pay
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
        A marque raises piracy in its zone for everyone, your ships included, and pays you a share of what pirates seize there, less the
        Admiral&apos;s tenth. The game prices it per zone from the last 7 game days of player traffic (60% of the prize it expects). The
        autopilot quotes the zones with rival traffic seen and sponsors one, for a game day at a time, only where the quoted prize beats
        the quoted cost plus your own ships&apos; extra losses (cargo seized and ships taken), and never past the budget. Your lanes already
        price the zone&apos;s piracy, so your ships steer around it when that is cheaper. Patrols share the switch and the budget: the game
        prices one per zone from its recent smuggling traffic (never under 2 Cr a bps-day), and it pays its sponsors half the base value
        of every smuggler seized at sea in the zone and everything aboard, split by bps, less the Admiral&apos;s tenth. The autopilot funds
        one for a game day where the prize expected from the seizures seen there lately, plus the piracy it takes off your own ships,
        beats the quote; never where your own ships carry contraband (a patrol there always loses) or your marque is in force.
      </p>
    </div>
  );
}

export default function RivalsPage() {
  const { catalog, portName, shipClassName, goodName } = useCatalog();
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
  // Our naval spend and prize money: marques and patrols together (one budget).
  const naval = [...(view?.marques ?? []), ...(view?.patrols ?? [])];
  const prize = naval.reduce((n, m) => n + (m.prize_earned_pence ?? 0), 0);
  const spent = naval.reduce((n, m) => n + m.cost_pence, 0);
  const leader = (view?.profiles ?? []).find((p) => p.earnPerHour !== null && p.rank !== null);

  return (
    <div className="space-y-5 pb-8 sm:space-y-6">
      <PageHeader
        title="Rivals"
        subtitle="Other companies' ships and voyages: sailings at ports where you have presence, plus public insurance policies, public convoys, expansion deliveries and the leaderboard; and whether a letter of marque on their routes would pay."
      />
      <ErrorNote error={error} />
      {!view ? (
        !error && <Loading />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
            <StatTile
              label="Rival companies"
              icon={<ShipIcon className="size-4" />}
              value={view.profiles.length}
              sub={`${view.rivals.length} ships known · ${view.coverage.activeCompanies ?? "?"} active in the world`}
            />
            <StatTile
              label="Watching"
              icon={<UsersIcon className="size-4" />}
              value={`${view.presence.length} port${view.presence.length === 1 ? "" : "s"}`}
              sub={
                view.settings.rivalIntel
                  ? `${view.coverage.policies} policies · ${view.coverage.convoys} convoy ships · ${view.coverage.deliveries} deliveries`
                  : view.presence.map((p) => portName(p)).join(", ") || "no ship or factor in port"
              }
            />
            <StatTile
              label="Laden rival passages"
              icon={<CrosshairIcon className="size-4" />}
              value={`${view.traffic.reduce((n, t) => Math.max(n, t.laden), 0).toFixed(1)}`}
              sub="a game day, busiest zone"
            />
            <StatTile
              label="Leader earns"
              icon={<TrendingUpIcon className="size-4" />}
              value={leader ? `${fmtCr(leader.earnPerHour)}/h` : "—"}
              sub={`you: ${view.you?.earnPerHour != null ? `${fmtCr(view.you.earnPerHour)}/h` : "—"}`}
            />
            <StatTile
              label="Auto-marques and patrols"
              icon={<SwordsIcon className="size-4" />}
              value={view.settings.marques ? "On" : "Off"}
              sub={`prize ${fmtCr(prize)} on ${fmtCr(spent)} spent`}
            />
          </div>

          <Panel title="Rival companies">
            {view.profiles.length === 0 ? (
              <Empty>No rival company known yet.</Empty>
            ) : (
              <Table head={["Company", "Net worth", "Earns/h", "Ships", "Lanes", "Cargo declared/h", "Feeds", "Losses"]}>
                {view.profiles.map((p) => (
                  <tr key={p.company} className="align-top">
                    <td>
                      <div className="font-medium">
                        {p.company}
                        {!p.linked && <span className="ml-1 text-muted-foreground text-xs">(id only)</span>}
                      </div>
                      <div className="text-muted-foreground text-xs">
                        {[p.homePort ? portName(p.homePort) : null, p.rank !== null ? `rank ${p.rank}` : null].filter(Boolean).join(" · ") || "—"}
                      </div>
                    </td>
                    <td className="whitespace-nowrap tabular-nums">{p.netWorth !== null ? fmtCr(p.netWorth) : "—"}</td>
                    <td className="whitespace-nowrap tabular-nums">{p.earnPerHour !== null ? fmtCr(p.earnPerHour) : "—"}</td>
                    <td className="text-xs">
                      <div className="tabular-nums">{p.ships}</div>
                      <div className="flex flex-wrap gap-1">
                        {p.classes.map(([c, n]) => (
                          <Badge key={c} variant="outline" size="sm">
                            {shipClassName(c)} ×{n}
                          </Badge>
                        ))}
                      </div>
                    </td>
                    <td className="text-xs">
                      {p.lanes.slice(0, 3).map((l) => (
                        <div key={`${l.from}>${l.to}`} className="whitespace-nowrap">
                          {portName(l.from)} → {portName(l.to)} ×{l.voyages} <span className="text-muted-foreground">(laden {l.laden})</span>
                        </div>
                      ))}
                      {p.lanes.length === 0 && "—"}
                    </td>
                    <td className="whitespace-nowrap tabular-nums">{p.cargoPerHour !== null ? fmtCr(p.cargoPerHour) : "—"}</td>
                    <td className="text-xs">
                      {p.feeds.slice(0, 4).map((f) => (
                        <div key={`${f.port}|${f.good}`} className="whitespace-nowrap">
                          {goodName(f.good)} → {portName(f.port)} {fmtTons(f.tons)}
                        </div>
                      ))}
                      {p.feeds.length === 0 && "—"}
                    </td>
                    <td className={`tabular-nums ${p.losses > 0 ? "text-destructive-foreground" : ""}`}>{p.losses}</td>
                  </tr>
                ))}
                {view.you && (
                  <tr className="border-t align-top">
                    <td className="font-medium">You</td>
                    <td className="whitespace-nowrap tabular-nums">
                      {fmtCr(view.you.netWorth)} <span className="text-muted-foreground text-xs">rank {view.you.rank}</span>
                    </td>
                    <td className="whitespace-nowrap tabular-nums">{view.you.earnPerHour !== null ? fmtCr(view.you.earnPerHour) : "—"}</td>
                    <td colSpan={5} />
                  </tr>
                )}
              </Table>
            )}
            <p className="mt-3 text-muted-foreground text-xs">
              Earning is the hourly leaderboard&apos;s net-worth slope (hulls count at build value). Lanes and cargo come from public insurance
              policies and quay sightings; feeds from the expansion board&apos;s deltas, attributed only when unambiguous. A company seen only by id
              in policies shows as #abc123 until a sighting ties it to a name.
              {!view.settings.rivalIntel && " Rival intel is off in the fleet settings: quay sightings only."}
            </p>
          </Panel>

          <div className="grid items-start gap-4 xl:grid-cols-3">
            <Panel title="Rival ships" className="xl:col-span-2" action={<Link href="/map" className="text-muted-foreground text-xs hover:text-foreground">On the map →</Link>}>
              {view.rivals.length === 0 ? (
                <Empty>
                  No rival ships seen yet. Ports list the ships that sailed or arrived in the last {view.windowGameHours} game hours, but only
                  where you have a ship or a factor; public policies and convoys show the rest.
                </Empty>
              ) : (
                <Table head={["Ship", "Seen by", "Last seen", "Cargo", "Probably"]}>
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
                          <td>
                            <div className="flex flex-wrap gap-1">
                              {r.sources.map((x) => (
                                <Badge key={x} variant={x === "quay" ? "outline" : "info"} size="sm">
                                  {SOURCE_LABEL[x]}
                                </Badge>
                              ))}
                            </div>
                          </td>
                          <td className="text-xs">
                            {seenText(r, portName)}
                            <div className="text-muted-foreground">{fmtAgo(local(r.seen.at))}</div>
                          </td>
                          <td className="text-xs">
                            {r.cargo !== null && r.cargo > 0 ? (
                              <span className="whitespace-nowrap tabular-nums">{fmtCr(r.cargo)} declared</span>
                            ) : (
                              <Badge variant={r.loadState === "laden" ? "warning" : "outline"} size="sm">
                                {r.loadState ? LOAD_LABEL[r.loadState] : "load unknown"}
                              </Badge>
                            )}
                            {r.guns !== null && <div className="text-muted-foreground">{r.guns} guns</div>}
                          </td>
                          <td className="text-xs">
                            {r.lost && (
                              <Badge variant="destructive" size="sm" className="mr-1">
                                lost
                              </Badge>
                            )}
                            {whereabouts(r, serverNow, local, portName)}
                          </td>
                        </tr>
                      )),
                  )}
                </Table>
              )}
              <p className="mt-3 text-muted-foreground text-xs">
                Positions are estimates: the route to where a ship said it was bound (or its policy or convoy names), at its class&apos;s speed. A
                policy declares the cargo insured, never what it is; a ship insured but not yet seen sailing is placed by how long that lane&apos;s
                policies take to close. Guns are public only in convoys.
              </p>
            </Panel>

            <Panel title="Letters of marque and patrols">
              <div className="space-y-4">
                <MarqueSettings view={view} onDone={() => void reload()} />
                <KV
                  rows={[
                    ["Autopilot", view.autopilot],
                    ["Last check", view.report ? fmtAgo(view.report.checkedAt) : "—"],
                    ["Marques", view.report?.action ?? (view.autopilot === "running" ? "first check within 5 minutes" : "checks run while the autopilot runs")],
                    ["Patrols", view.report?.patrolAction ?? "—"],
                    ["Spent, last 24 h", view.report ? `${fmtCr(view.report.spentPence)} of ${fmtCr(view.report.budgetPence)}${view.report.patrolSpentPence ? ` (patrols ${fmtCr(view.report.patrolSpentPence)})` : ""}` : "—"],
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
                {(view.patrols ?? []).length > 0 && (
                  <Table head={["Zone", "Suppressed", "Cost", "Prize", "Ends"]}>
                    {(view.patrols ?? []).map((p) => (
                      <tr key={p.id}>
                        <td className="text-xs">{zoneName(p.sea_zone_id)} <span className="text-muted-foreground">(patrol)</span></td>
                        <td className="tabular-nums">−{fmtBps(p.suppressed_piracy_bps)}</td>
                        <td className="tabular-nums">{fmtCr(p.cost_pence)}</td>
                        <td className={`tabular-nums ${(p.prize_earned_pence ?? 0) >= p.cost_pence ? "text-success-foreground" : ""}`}>{fmtCr(p.prize_earned_pence ?? 0)}</td>
                        <td className="text-muted-foreground text-xs">{Date.parse(p.expires_at) > Date.now() ? fmtIn(p.expires_at) : fmtDateTime(p.expires_at)}</td>
                      </tr>
                    ))}
                  </Table>
                )}
              </div>
            </Panel>
          </div>

          <Panel title="Charters rivals feed">
            {view.charters.length === 0 ? (
              <Empty>No expansion charters open.</Empty>
            ) : (
              <Table head={["Charter", "Rival tons", "Last rival delivery", "Stalled", "Rivals due before lapse", "Escalates"]}>
                {view.charters.map((c) => (
                  <tr key={`${c.port}|${c.good}`} className="align-top">
                    <td className="font-medium text-sm">
                      {goodName(c.good)} → {portName(c.port)}
                    </td>
                    <td className="text-xs">
                      {c.rivalTons.map(([company, tons]) => (
                        <div key={company} className="whitespace-nowrap">
                          {company} {fmtTons(tons)}
                        </div>
                      ))}
                      {c.rivalTons.length === 0 && "—"}
                    </td>
                    <td className="text-muted-foreground text-xs">{c.lastAt !== null ? fmtAgo(local(c.lastAt)) : "—"}</td>
                    <td>
                      {c.stalled ? (
                        <Badge variant="warning" size="sm">
                          stalled
                        </Badge>
                      ) : (
                        <span className="text-muted-foreground text-xs">being filled</span>
                      )}
                    </td>
                    <td className="tabular-nums">{c.dueBeforeLapse}</td>
                    <td className="tabular-nums">{c.survival !== null ? `${Math.round(c.survival * 100)}%` : "—"}</td>
                  </tr>
                ))}
              </Table>
            )}
            <p className="mt-3 text-muted-foreground text-xs">
              A stalled posting (under a tenth of its expected pace) re-posts richer only if no other company delivers before it lapses (and,
              until re-posts show otherwise, none of ours). Escalates: the autopilot&apos;s odds that it does if
              none of our ships delivers first (stalls seen, this charter&apos;s rival record, laden rivals due at the port before then; a
              likely rival delivery first stops it letting the posting lapse). Rival tons come from the expansion board&apos;s deltas while
              the autopilot runs.
            </p>
          </Panel>

          <Panel title="Rival traffic and marques by sea zone">
            {view.verdicts.length === 0 ? (
              <Empty>No rival sailings seen in the last game day.</Empty>
            ) : (
              <Table head={["Zone", "Piracy now", "Passages", "Laden", "Cargo", "Next day", "Best marque", "Prize (quoted)", "Cost (quoted)", "Our losses", "Verdict"]}>
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
                      <td className="tabular-nums">{v.next ? v.next.passages.toFixed(1) : "—"}</td>
                      <td className="tabular-nums">{fmtBps(v.best.bps)}</td>
                      <td className="whitespace-nowrap tabular-nums">
                        {v.best.quoted ? fmtCr(v.best.prize) : <span className="text-muted-foreground" title="Our own estimate from the rival traffic seen (not quoted)">~{fmtCr(v.best.prize)}</span>}
                        {v.best.quoted && v.best.rivalPrize !== undefined && (
                          <div className="text-muted-foreground text-xs" title="Our own estimate from the rival traffic seen">rivals seen ~{fmtCr(v.best.rivalPrize)}</div>
                        )}
                      </td>
                      <td className="whitespace-nowrap tabular-nums">{v.best.quoted ? fmtCr(v.best.cost) : <span className="text-muted-foreground">not quoted</span>}</td>
                      <td className="whitespace-nowrap tabular-nums">{fmtCr(v.best.ownLoss)}</td>
                      <td className={`text-xs ${v.verdict === "pays" ? "text-success-foreground" : "text-muted-foreground"}`}>{v.verdict}</td>
                    </tr>
                  );
                })}
              </Table>
            )}
            <p className="mt-3 text-muted-foreground text-xs">
              Per game day. Passages count rival sailings seen in the last {view.windowGameHours} game hours, plus the voyages public policies and
              convoys announce (no presence needed; next day: those not sailed yet), and convoys only the coffee houses&apos; news tells of (a
              guessed part load, until a listing or a sighting shows them); a convoy counts once (pirates board one ship), at its richest
              member&apos;s cargo. Cargo is the policy&apos;s declared cargo, else estimated from each ship&apos;s class and load and the goods its port
              of departure makes. Rivals that neither insure nor pass your ports aren&apos;t counted, so these figures run low. The prize court pays
              half the seized cargo&apos;s base value (all of it when pirates take the ship) times the marques&apos; share of the zone&apos;s piracy, less
              the Admiral&apos;s tenth. Quoted prize and cost are the game&apos;s marque quote for one game day, from every player ship&apos;s passages over
              the last 7 game days (ours included): it pays about 1.67× its price if that traffic holds. ~ marks our own estimate where a zone
              wasn&apos;t quoted.
            </p>
          </Panel>

          {(view.report?.patrols ?? []).length > 0 && (
            <Panel title="Smugglers and patrols by sea zone">
              <Table head={["Zone", "Piracy now", "Seized at sea", "Prize pool each", "Our losses / piracy", "Best patrol", "Prize", "Off our losses", "Cost", "Verdict"]}>
                {(view.report?.patrols ?? []).map((v) => {
                  const z = view.zones.find((x) => x.sea_zone_id === v.zone);
                  return (
                    <tr key={v.zone} className="align-top">
                      <td>
                        <div className="font-medium text-sm">{zoneName(v.zone)}</div>
                        <div className="text-muted-foreground text-xs capitalize">{zoneClass(v.zone)}</div>
                      </td>
                      <td className="tabular-nums">{z ? fmtBps(z.net_piracy_bps) : "—"}</td>
                      <td className="tabular-nums">{v.seizuresPerDay.toFixed(2)}</td>
                      <td className="whitespace-nowrap tabular-nums">{fmtCr(v.pool)}</td>
                      <td className="whitespace-nowrap tabular-nums">{fmtCr(v.ownRisk)}</td>
                      <td className="tabular-nums">{v.best.bps ? `−${fmtBps(v.best.bps)}` : "—"}</td>
                      <td className="whitespace-nowrap tabular-nums">{fmtCr(v.best.prize)}</td>
                      <td className="whitespace-nowrap tabular-nums">{fmtCr(v.best.relief)}</td>
                      <td className="whitespace-nowrap tabular-nums">
                        {v.best.quoted ? fmtCr(v.best.cost) : <span className="text-muted-foreground" title="At the 2 Cr floor (not quoted)">≥{fmtCr(v.best.cost)}</span>}
                      </td>
                      <td className={`text-xs ${v.verdict === "pays" ? "text-success-foreground" : "text-muted-foreground"}`}>{v.verdict}</td>
                    </tr>
                  );
                })}
              </Table>
              <p className="mt-3 text-muted-foreground text-xs">
                Per game day. Seized at sea: smugglers the Crown took at sea in the zone a game day over the last 7 game days (the public
                notices; a seizure in port pays no prize). The prize court pays half the base value of the ship and everything aboard, split
                among the patrols in force by bps, less the Admiral&apos;s tenth; the pool each is taken at is what our own prize money has shown,
                else what the notices said was seized, else half the cheapest hull (a floor). Seizures are taken not to rise with our patrol.
                Off our losses: what our own ships there lose per unit of piracy a game day × the bps it suppresses. Cost: the game&apos;s
                patrol quote for one game day, or our estimate at the 2 Cr floor where not quoted.
              </p>
            </Panel>
          )}
        </>
      )}
    </div>
  );
}
