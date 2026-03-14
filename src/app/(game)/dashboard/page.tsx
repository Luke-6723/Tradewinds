"use client";

import { useEffect, useRef, useState } from "react";
import { companyApi } from "@/lib/api/company";
import { fleetApi } from "@/lib/api/fleet";
import { worldApi } from "@/lib/api/world";
import type { Cargo, Company, CompanyEconomy, Good, LedgerEntry, Port, Ship } from "@/lib/types";
import type { StoredWarehouseStock } from "@/lib/db/collections";
import { useAutopilot } from "@/hooks/use-autopilot";
import { CYCLE_MS } from "@/lib/autopilot-types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import {
  ArchiveIcon,
  BotIcon,
  BuildingIcon,
  PackageIcon,
  ShipIcon,
  TrendingDownIcon,
  TrendingUpIcon,
  UsersIcon,
  WalletIcon,
} from "lucide-react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

export default function DashboardPage() {
  const [company, setCompany] = useState<Company | null>(null);
  const [economy, setEconomy] = useState<CompanyEconomy | null>(null);
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  const [ships, setShips] = useState<Ship[]>([]);
  const [ports, setPorts] = useState<Port[]>([]);
  const [goods, setGoods] = useState<Good[]>([]);
  const [shipCargo, setShipCargo] = useState<Record<string, Cargo[]>>({});
  const [warehouseStocks, setWarehouseStocks] = useState<StoredWarehouseStock[]>([]);
  const [loading, setLoading] = useState(true);
  const { state: ap, toggle: toggleAp, toggleFleetMgmt } = useAutopilot();

  useEffect(() => {
    Promise.all([
      companyApi.getCompany(),
      companyApi.getEconomy(),
      fetch("/api/ledger").then((r) => r.ok ? r.json() : []).catch(() => []),
      fleetApi.getShips().catch(() => []),
      worldApi.getPorts().catch(() => []),
      worldApi.getGoods().catch(() => []),
      fetch("/api/warehouses/stocks").then((r) => r.ok ? r.json() : []).catch(() => []),
    ])
      .then(([c, e, l, s, p, g, stocks]) => {
        setCompany(c);
        setEconomy(e);
        setLedger(l);
        setShips(s as Ship[]);
        setPorts(p as Port[]);
        setGoods(g as Good[]);
        setWarehouseStocks(stocks as StoredWarehouseStock[]);
        const ships = s as Ship[];
        Promise.all(
          ships.map((ship) =>
            fleetApi.getInventoryCached(ship).then((cargo) => ({ id: ship.id, cargo })).catch(() => ({ id: ship.id, cargo: [] as Cargo[] }))
          )
        ).then((results) => {
          setShipCargo(Object.fromEntries(results.map(({ id, cargo }) => [id, cargo])));
        });
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="flex justify-center items-center h-full">
        <Spinner className="size-8 text-muted-foreground" />
      </div>
    );
  }

  const portName = (id: string | null) =>
    id ? (ports.find((p) => p.id === id)?.name ?? id.slice(0, 8)) : "at sea";
  const goodName = (id: string | null | undefined) =>
    id ? (goods.find((g) => g.id === id)?.name ?? id.slice(0, 8)) : "?";

  // ── KPI computations ───────────────────────────────────────────────────────

  const treasury = company?.treasury ?? 0;

  // Cargo in transit: sum sell value (or cost basis) for all ships with cargo plans
  const cargoInTransitValue = ships.reduce((sum, ship) => {
    const ss = ap.ships[ship.id];
    if (!ss?.plan?.goodId) return sum;
    const qty = ss.plan.quantity ?? 0;
    const price = ss.plan.sellPrice ?? ss.plan.actualBuyPrice ?? 0;
    return sum + qty * price;
  }, 0);

  // PAX bids in transit: ships in transiting_to_sell with a passenger bid
  const paxInTransit = ships.reduce((sum, ship) => {
    const ss = ap.ships[ship.id];
    if (ss?.phase === "transiting_to_sell" && ss.plan?.passengerBid) {
      return sum + ss.plan.passengerBid;
    }
    return sum;
  }, 0);

  const netProfit = ap.profitAccrued;

  // Total assets: treasury + cargo in transit (at cost) + pax bids
  const cargoAtCost = ships.reduce((sum, ship) => {
    const ss = ap.ships[ship.id];
    if (!ss?.plan?.goodId) return sum;
    return sum + (ss.plan.actualBuyPrice ?? 0) * (ss.plan.quantity ?? 0);
  }, 0);
  const totalAssets = treasury + cargoAtCost + paxInTransit;

  // ── Chart data ─────────────────────────────────────────────────────────────

  const validLedger = ledger.filter((e) => e.occurred_at && !isNaN(new Date(e.occurred_at).getTime()));

  const profitChartData = (ap.profitHistory ?? []).map((snap) => ({
    label: new Date(snap.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    cumulative: snap.cumulative,
    cycleProfit: snap.cycleProfit,
  }));

  const treasuryChartData = (() => {
    const snaps = ap.treasuryHistory ?? [];
    if (snaps.length > 1) {
      return snaps.map((snap) => ({
        label: new Date(snap.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        balance: snap.balance,
      }));
    }
    if (!company || validLedger.length === 0) return [];
    const baseline = company.treasury - validLedger.reduce((sum, e) => sum + e.amount, 0);
    let running = baseline;
    return validLedger.map((e) => {
      running += e.amount;
      const d = new Date(e.occurred_at);
      return {
        label: d.toLocaleDateString([], { month: "short", day: "numeric" }) + " " +
          d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        balance: running,
      };
    });
  })();

  const dailyPnlData = (() => {
    const byDay: Record<string, { day: string; income: number; expenses: number }> = {};
    for (const e of validLedger) {
      const d = new Date(e.occurred_at);
      const day = d.toLocaleDateString([], { month: "short", day: "numeric" });
      if (!byDay[day]) byDay[day] = { day, income: 0, expenses: 0 };
      if (e.amount >= 0) byDay[day].income += e.amount;
      else byDay[day].expenses += Math.abs(e.amount);
    }
    return Object.values(byDay);
  })();

  const upkeepData = economy && (economy.ship_upkeep + economy.warehouse_upkeep) > 0
    ? [
        { name: "Ships", value: economy.ship_upkeep },
        { name: "Warehouses", value: economy.warehouse_upkeep },
      ]
    : [];
  const PIE_COLORS = ["#6366f1", "#f59e0b"];

  const totalLedgerNet = ledger.reduce((s, e) => s + e.amount, 0);

  const shipsInTransit = ships.filter((s) => s.status === "traveling").length;
  const shipsDocked = ships.filter((s) => s.status !== "traveling").length;

  return (
    <div className="space-y-6 pb-8">

      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="font-bold text-2xl tracking-tight">{company?.name ?? "Dashboard"}</h1>
          <p className="text-muted-foreground text-sm mt-0.5">
            {company?.ticker} · <span className="capitalize">{company?.status}</span>
            {economy && (
              <span className="ml-2 text-xs">
                · upkeep £{economy.total_upkeep.toLocaleString()}/cycle
              </span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Badge variant={ap.enabled ? "success" : "secondary"} className="gap-1.5">
            <BotIcon className="size-3" />
            {ap.enabled ? "Autopilot On" : "Autopilot Off"}
          </Badge>
        </div>
      </div>

      {/* KPI cards — 5 across */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        <KpiCard
          label="Treasury"
          value={`£${treasury.toLocaleString()}`}
          icon={<WalletIcon className="size-4" />}
          accent="green"
          sub={economy ? `After upkeep: £${Math.max(0, treasury - economy.total_upkeep).toLocaleString()}` : undefined}
        />
        <KpiCard
          label="Cargo in Transit"
          value={cargoInTransitValue > 0 ? `£${Math.round(cargoInTransitValue).toLocaleString()}` : "—"}
          icon={<PackageIcon className="size-4" />}
          accent="blue"
          sub={`${shipsInTransit} ship${shipsInTransit !== 1 ? "s" : ""} traveling`}
        />
        <KpiCard
          label="PAX in Transit"
          value={paxInTransit > 0 ? `£${paxInTransit.toLocaleString()}` : "—"}
          icon={<UsersIcon className="size-4" />}
          accent="purple"
          sub="pending delivery"
        />
        <KpiCard
          label="Net Profit"
          value={netProfit !== 0 ? `£${Math.round(netProfit).toLocaleString()}` : "—"}
          icon={netProfit >= 0 ? <TrendingUpIcon className="size-4" /> : <TrendingDownIcon className="size-4" />}
          accent={netProfit >= 0 ? "emerald" : "red"}
          sub={ap.cyclesRun > 0 ? `over ${ap.cyclesRun} cycles` : "autopilot"}
        />
        <KpiCard
          label="Total Assets"
          value={`£${Math.round(totalAssets).toLocaleString()}`}
          icon={<ArchiveIcon className="size-4" />}
          accent="indigo"
          sub="treasury + cargo + pax"
        />
      </div>

      {/* Fleet summary strip */}
      <div className="flex flex-wrap gap-3 text-sm">
        <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-muted/60 text-muted-foreground">
          <ShipIcon className="size-3.5" />
          <span>{ships.length} ships total</span>
          <span className="text-foreground font-medium">{shipsDocked} docked</span>
          <span>·</span>
          <span>{shipsInTransit} traveling</span>
        </div>
        {economy && (
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-muted/60 text-muted-foreground">
            <BuildingIcon className="size-3.5" />
            <span>Ships £{economy.ship_upkeep.toLocaleString()}</span>
            <span>·</span>
            <span>Warehouses £{economy.warehouse_upkeep.toLocaleString()}</span>
          </div>
        )}
      </div>

      {/* Charts row */}
      {(profitChartData.length > 1 || treasuryChartData.length > 1 || upkeepData.length > 0) && (
        <div className="grid gap-4 lg:grid-cols-3">
          {profitChartData.length > 1 && (
            <Card className={treasuryChartData.length <= 1 ? "lg:col-span-2" : "lg:col-span-1"}>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">Autopilot Profit</CardTitle>
              </CardHeader>
              <CardContent>
                <ResponsiveContainer width="100%" height={180}>
                  <AreaChart data={profitChartData} margin={{ top: 4, right: 4, left: 4, bottom: 0 }}>
                    <defs>
                      <linearGradient id="profitGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#10b981" stopOpacity={0.3} />
                        <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                    <XAxis dataKey="label" tick={false} axisLine={false} tickLine={false} />
                    <YAxis tickFormatter={(v: number) => `£${(v / 1000).toFixed(0)}k`} tick={{ fontSize: 11 }} width={48} />
                    <Tooltip
                      formatter={(value, name) => [`£${Number(value).toLocaleString()}`, name === "cumulative" ? "Total" : "+cycle"]}
                      labelFormatter={(l) => String(l)}
                      contentStyle={{ fontSize: 12, borderRadius: 8 }}
                    />
                    <Area type="monotone" dataKey="cumulative" stroke="#10b981" strokeWidth={2} fill="url(#profitGrad)" dot={false} activeDot={{ r: 4, fill: "#10b981", strokeWidth: 0 }} />
                  </AreaChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>
          )}

          {treasuryChartData.length > 1 && (
            <Card className={profitChartData.length <= 1 ? "lg:col-span-2" : "lg:col-span-1"}>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">Treasury Balance</CardTitle>
              </CardHeader>
              <CardContent>
                <ResponsiveContainer width="100%" height={180}>
                  <AreaChart data={treasuryChartData} margin={{ top: 4, right: 4, left: 4, bottom: 0 }}>
                    <defs>
                      <linearGradient id="treasuryGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#6366f1" stopOpacity={0.3} />
                        <stop offset="95%" stopColor="#6366f1" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                    <XAxis dataKey="label" tick={false} axisLine={false} tickLine={false} />
                    <YAxis tickFormatter={(v: number) => `£${(v / 1000).toFixed(0)}k`} tick={{ fontSize: 11 }} width={48} />
                    <Tooltip
                      formatter={(value) => [`£${Number(value).toLocaleString()}`, "Balance"]}
                      labelFormatter={(l) => String(l)}
                      contentStyle={{ fontSize: 12, borderRadius: 8 }}
                    />
                    <Area type="monotone" dataKey="balance" stroke="#6366f1" strokeWidth={2} fill="url(#treasuryGrad)" dot={false} activeDot={{ r: 4, fill: "#6366f1", strokeWidth: 0 }} />
                  </AreaChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>
          )}

          {upkeepData.length > 0 && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">Upkeep Split</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col items-center gap-2">
                <ResponsiveContainer width="100%" height={150}>
                  <PieChart>
                    <Pie data={upkeepData} cx="50%" cy="50%" innerRadius={40} outerRadius={65} paddingAngle={3} dataKey="value">
                      {upkeepData.map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
                    </Pie>
                    <Tooltip formatter={(v, n) => [`£${Number(v).toLocaleString()}`, String(n)]} contentStyle={{ fontSize: 12, borderRadius: 8 }} />
                  </PieChart>
                </ResponsiveContainer>
                <div className="flex gap-4 text-xs text-muted-foreground">
                  {upkeepData.map((d, i) => (
                    <span key={d.name} className="flex items-center gap-1.5">
                      <span className="inline-block size-2 rounded-full" style={{ backgroundColor: PIE_COLORS[i] }} />
                      {d.name}: £{d.value.toLocaleString()}
                    </span>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {/* Daily P&L */}
      {dailyPnlData.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Daily P&amp;L</CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={160}>
              <BarChart data={dailyPnlData} margin={{ top: 4, right: 4, left: 4, bottom: 0 }} barGap={2}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-border" vertical={false} />
                <XAxis dataKey="day" tick={{ fontSize: 11 }} />
                <YAxis tickFormatter={(v) => `£${(v as number / 1000).toFixed(0)}k`} tick={{ fontSize: 11 }} width={48} />
                <Tooltip formatter={(v, n) => [`£${Number(v).toLocaleString()}`, String(n)]} labelFormatter={(l) => String(l)} contentStyle={{ fontSize: 12, borderRadius: 8 }} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar dataKey="income" name="Income" fill="#10b981" radius={[3, 3, 0, 0]} maxBarSize={36} />
                <Bar dataKey="expenses" name="Expenses" fill="#ef4444" radius={[3, 3, 0, 0]} maxBarSize={36} />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      )}

      {/* Autopilot card */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <BotIcon className="size-4 text-muted-foreground" />
              <CardTitle>Autopilot</CardTitle>
              <Badge variant={ap.enabled ? "success" : "secondary"}>
                {ap.enabled ? "Running" : "Off"}
              </Badge>
              {ap.cyclesRun > 0 && (
                <span className="text-muted-foreground text-xs">{ap.cyclesRun} cycles</span>
              )}
            </div>
            <div className="flex items-center gap-2">
              {ap.enabled && ap.lastCycleAt && (
                <span className="text-muted-foreground text-xs hidden sm:inline">
                  Last ran {new Date(ap.lastCycleAt).toLocaleTimeString()} · every {CYCLE_MS / 1000}s
                </span>
              )}
              <Button size="sm" variant={ap.enabled ? "destructive" : "default"} onClick={toggleAp}>
                {ap.enabled ? "Disable" : "Enable"}
              </Button>
            </div>
          </div>

          {/* Profit + fleet mgmt strip */}
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 pt-2 text-sm">
            <span>
              <span className="text-muted-foreground">Profit: </span>
              <span className="font-mono font-semibold text-emerald-600 dark:text-emerald-400">
                £{Math.round(ap.profitAccrued).toLocaleString()}
              </span>
            </span>

            <div className="flex items-center gap-2">
              <span className="text-muted-foreground">Fleet mgmt:</span>
              <Badge variant={(ap.fleetMgmt?.enabled ?? true) ? "success" : "secondary"} className="text-xs">
                {(ap.fleetMgmt?.enabled ?? true) ? "On" : "Off"}
              </Badge>
              <Button size="sm" variant="outline" className="text-xs h-6 px-2" onClick={toggleFleetMgmt}>
                Toggle
              </Button>
            </div>

            {(() => {
              const paxShips = ships.filter((sh) => (ap.ships[sh.id]?.paxTrips ?? 0) > 0).length;
              const paxRatio = ships.length > 0 ? Math.round((paxShips / ships.length) * 100) : 0;
              return (
                <span className="flex items-center gap-2 text-muted-foreground text-xs">
                  Pax {paxRatio}%
                  <span className="inline-block w-20 h-1.5 bg-muted rounded-full">
                    <span className="block h-full bg-indigo-500 rounded-full" style={{ width: `${paxRatio}%` }} />
                  </span>
                </span>
              );
            })()}

            {ap.fleetMgmt?.lastBuyAt && (
              <span className="text-muted-foreground text-xs">
                Bought: {new Date(ap.fleetMgmt.lastBuyAt).toLocaleTimeString()}
              </span>
            )}
            {ap.fleetMgmt?.lastSellAt && (
              <span className="text-muted-foreground text-xs">
                Sold: {new Date(ap.fleetMgmt.lastSellAt).toLocaleTimeString()}
              </span>
            )}
          </div>
        </CardHeader>

        <CardContent className="space-y-3 pt-0">
          {/* Ship table */}
          {ships.length > 0 && (
            <div className="rounded-lg border overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-muted/50 border-b">
                    <th className="text-left px-3 py-2 font-medium text-muted-foreground text-xs">Ship</th>
                    <th className="text-left px-3 py-2 font-medium text-muted-foreground text-xs">Status</th>
                    <th className="text-left px-3 py-2 font-medium text-muted-foreground text-xs hidden sm:table-cell">Location</th>
                    <th className="text-left px-3 py-2 font-medium text-muted-foreground text-xs hidden md:table-cell">Cargo / PAX</th>
                    <th className="text-left px-3 py-2 font-medium text-muted-foreground text-xs hidden lg:table-cell">Autopilot phase</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {ships.map((ship) => {
                    const ss = ap.ships[ship.id];
                    const phase = ss?.phase ?? "idle";
                    const plan = ss?.plan;
                    const cargo = shipCargo[ship.id] ?? [];
                    const traveling = ship.status === "traveling";
                    return (
                      <tr key={ship.id} className="hover:bg-muted/30 transition-colors">
                        <td className="px-3 py-2">
                          <span className="font-medium">{ship.name}</span>
                          {ss && (ss.lifetimeProfit > 0) && (
                            <p className="text-xs text-muted-foreground">£{Math.round(ss.lifetimeProfit).toLocaleString()} lifetime</p>
                          )}
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex flex-col gap-0.5">
                            <Badge variant={traveling ? "info" : "success"} className="text-xs w-fit">
                              {traveling ? "traveling" : "docked"}
                            </Badge>
                            {traveling && ship.arriving_at && (
                              <span className="text-xs text-muted-foreground font-mono">
                                <Countdown to={ship.arriving_at} />
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="px-3 py-2 text-muted-foreground hidden sm:table-cell">
                          {portName(ship.port_id)}
                        </td>
                        <td className="px-3 py-2 hidden md:table-cell">
                          <div className="text-xs text-muted-foreground space-y-0.5">
                            {cargo.length > 0 && (
                              <p>{cargo.map((c) => `${c.quantity}× ${goodName(c.good_id)}`).join(", ")}</p>
                            )}
                            {plan?.passengerBid && (
                              <p className="text-purple-600 dark:text-purple-400">🧳 £{plan.passengerBid.toLocaleString()}</p>
                            )}
                            {cargo.length === 0 && !plan?.passengerBid && (
                              <span className="text-muted-foreground/60">empty</span>
                            )}
                          </div>
                        </td>
                        <td className="px-3 py-2 hidden lg:table-cell">
                          {ap.enabled ? (
                            <Badge
                              variant={phase === "idle" ? "secondary" : phase === "transiting_to_buy" ? "info" : "warning"}
                              className="text-xs"
                            >
                              {phase === "transiting_to_sell"
                                ? `→ ${portName(plan?.sellPortId ?? null)}${plan?.goodName ? ` (${plan.goodName})` : plan?.passengerBid ? " (pax)" : ""}`
                                : phase === "transiting_to_buy"
                                ? `→ buy ${plan?.goodName ?? ""}`
                                : "idle"}
                            </Badge>
                          ) : (
                            <span className="text-muted-foreground/60 text-xs">—</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* Warehouse stockpile */}
          {ap.enabled && warehouseStocks.length > 0 && (() => {
            const byPort = warehouseStocks.reduce<Record<string, StoredWarehouseStock[]>>((acc, s) => {
              (acc[s.portId] ??= []).push(s);
              return acc;
            }, {});
            return (
              <div>
                <p className="text-xs text-muted-foreground mb-1.5 flex items-center gap-1">
                  <PackageIcon className="size-3" /> Warehouse stockpile
                </p>
                <div className="rounded-lg border divide-y text-sm">
                  {Object.entries(byPort).map(([portId, items]) => (
                    <div key={portId} className="flex justify-between items-center px-3 py-2 gap-2">
                      <span className="font-medium shrink-0">{ports.find((p) => p.id === portId)?.name ?? portId.slice(0, 8)}</span>
                      <span className="text-muted-foreground text-xs text-right">
                        {items.map((i) => goods.find((g) => g.id === i.goodId)?.name ?? i.goodName).join(", ")}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            );
          })()}

          {/* Activity log */}
          {ap.log.length > 0 && (
            <div className="rounded-lg border bg-muted/20">
              <p className="text-xs text-muted-foreground px-3 pt-2 pb-1 font-medium border-b">Activity log</p>
              <div className="divide-y max-h-52 overflow-y-auto">
                {ap.log.slice(0, 30).map((entry, i) => (
                  <div key={i} className="flex gap-2.5 px-3 py-1.5 text-xs">
                    <span className="tabular-nums text-muted-foreground shrink-0 pt-px">
                      {new Date(entry.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                    </span>
                    <span className="leading-relaxed">{entry.message}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {ap.enabled && ap.log.length === 0 && (
            <p className="text-muted-foreground text-sm">
              Scanning for opportunities… (first cycle runs immediately on enable)
            </p>
          )}
        </CardContent>
      </Card>

      {/* Recent Ledger */}
      {ledger.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <div className="flex justify-between items-center">
              <CardTitle>Recent Ledger</CardTitle>
              <span className={`text-sm font-mono font-semibold ${totalLedgerNet >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-destructive"}`}>
                net {totalLedgerNet >= 0 ? "+" : ""}£{totalLedgerNet.toLocaleString()}
              </span>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            <div className="divide-y">
              {[...ledger].reverse().slice(0, 20).map((entry) => (
                <LedgerRow key={entry.id} entry={entry} />
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function KpiCard({
  label,
  value,
  sub,
  icon,
  accent = "default",
}: {
  label: string;
  value: string;
  sub?: string;
  icon?: React.ReactNode;
  accent?: "green" | "emerald" | "yellow" | "blue" | "purple" | "indigo" | "red" | "default";
}) {
  const accentClasses: Record<string, string> = {
    green:   "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-400",
    emerald: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400",
    yellow:  "bg-yellow-100 text-yellow-700 dark:bg-yellow-950 dark:text-yellow-400",
    blue:    "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-400",
    purple:  "bg-purple-100 text-purple-700 dark:bg-purple-950 dark:text-purple-400",
    indigo:  "bg-indigo-100 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-400",
    red:     "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-400",
    default: "bg-muted text-muted-foreground",
  };
  return (
    <Card className="hover:shadow-md transition-shadow">
      <CardContent className="pt-5 pb-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <p className="text-muted-foreground text-xs font-medium uppercase tracking-wide">{label}</p>
            <p className="font-mono font-bold text-xl mt-1 truncate">{value}</p>
            {sub && <p className="text-muted-foreground text-xs mt-0.5 truncate">{sub}</p>}
          </div>
          {icon && (
            <div className={`flex size-8 shrink-0 items-center justify-center rounded-lg ${accentClasses[accent]}`}>
              {icon}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function Countdown({ to }: { to: string }) {
  const [label, setLabel] = useState("");
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    const target = new Date(to).getTime();
    function update() {
      const diff = Math.max(0, Math.floor((target - Date.now()) / 1000));
      const m = Math.floor(diff / 60);
      const s = diff % 60;
      setLabel(diff === 0 ? "docking…" : `${m}:${String(s).padStart(2, "0")}`);
      if (diff > 0) rafRef.current = window.setTimeout(update, 1000);
    }
    update();
    return () => { if (rafRef.current) clearTimeout(rafRef.current); };
  }, [to]);

  return <span>{label}</span>;
}

const REASON_LABELS: Record<string, string> = {
  initial_deposit: "Initial Deposit",
  transfer: "Transfer",
  ship_purchase: "Ship Purchase",
  tax: "Tax",
  market_trade: "Market Trade",
  market_listing_fee: "Market Listing Fee",
  market_penalty_fine: "Market Penalty",
  warehouse_upgrade: "Warehouse Upgrade",
  warehouse_upkeep: "Warehouse Upkeep",
  ship_upkeep: "Ship Upkeep",
  npc_trade: "NPC Trade",
  bailout: "Bailout",
};

function LedgerRow({ entry }: { entry: LedgerEntry }) {
  const positive = entry.amount >= 0;
  const Icon = positive ? TrendingUpIcon : TrendingDownIcon;
  const date = new Date(entry.occurred_at);
  const isToday = new Date().toDateString() === date.toDateString();
  const dateLabel = isToday
    ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleDateString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  const label = REASON_LABELS[entry.reason] ?? (entry.reason ?? "unknown").replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

  return (
    <div className="flex items-center gap-3 hover:bg-muted/40 px-4 py-2.5 transition-colors">
      <div className={`flex size-7 shrink-0 items-center justify-center rounded-full ${positive ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400" : "bg-red-100 text-destructive dark:bg-red-950"}`}>
        <Icon className="size-3.5" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm truncate">{label}</p>
        <p className="tabular-nums text-muted-foreground text-xs">{dateLabel}</p>
      </div>
      <span className={`text-sm font-mono font-semibold shrink-0 ${positive ? "text-emerald-600 dark:text-emerald-400" : "text-destructive"}`}>
        {positive ? "+" : ""}£{Math.abs(entry.amount).toLocaleString()}
      </span>
    </div>
  );
}
