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
  BotIcon,
  BuildingIcon,
  PackageIcon,
  ShipIcon,
  StarIcon,
  TrendingDownIcon,
  TrendingUpIcon,
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
  const { state: ap, toggle: toggleAp } = useAutopilot();

  useEffect(() => {
    Promise.all([
      companyApi.getCompany(),
      companyApi.getEconomy(),
      fetch("/api/ledger").then((r) => r.json()).catch(() => []),
      fleetApi.getShips().catch(() => []),
      worldApi.getPorts().catch(() => []),
      worldApi.getGoods().catch(() => []),
      fetch("/api/warehouses/stocks").then((r) => r.json()).catch(() => []),
    ])
      .then(([c, e, l, s, p, g, stocks]) => {
        setCompany(c);
        setEconomy(e);
        setLedger(l);
        setShips(s as Ship[]);
        setPorts(p as Port[]);
        setGoods(g as Good[]);
        setWarehouseStocks(stocks as StoredWarehouseStock[]);
        // Fetch cargo for all ships in parallel
        const ships = s as Ship[];
        Promise.all(
          ships.map((ship) =>
            fleetApi.getInventory(ship.id).then((cargo) => ({ id: ship.id, cargo })).catch(() => ({ id: ship.id, cargo: [] as Cargo[] }))
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

  // ── Chart data ─────────────────────────────────────────────────────────────

  // Treasury balance over time (oldest → newest, running total)
  const treasuryChartData = (() => {
    if (!company || ledger.length === 0) return [];
    const sorted = [...ledger].reverse(); // oldest first
    const baseline = company.treasury - sorted.reduce((s, e) => s + e.amount, 0);
    let running = baseline;
    return sorted.map((e) => {
      running += e.amount;
      const d = new Date(e.occurred_at);
      return {
        label: d.toLocaleDateString([], { month: "short", day: "numeric" }) +
          " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        balance: running,
      };
    });
  })();

  // Daily income vs expenses
  const dailyPnlData = (() => {
    const byDay: Record<string, { day: string; income: number; expenses: number }> = {};
    for (const e of ledger) {
      const day = new Date(e.occurred_at).toLocaleDateString([], { month: "short", day: "numeric" });
      if (!byDay[day]) byDay[day] = { day, income: 0, expenses: 0 };
      if (e.amount >= 0) byDay[day].income += e.amount;
      else byDay[day].expenses += Math.abs(e.amount);
    }
    return Object.values(byDay).reverse();
  })();

  // Upkeep split for pie chart
  const upkeepData = economy && (economy.ship_upkeep + economy.warehouse_upkeep) > 0
    ? [
        { name: "Ships", value: economy.ship_upkeep },
        { name: "Warehouses", value: economy.warehouse_upkeep },
      ]
    : [];
  const PIE_COLORS = ["#6366f1", "#f59e0b"];

  const totalLedgerNet = ledger.reduce((s, e) => s + e.amount, 0);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-bold text-2xl">{company?.name ?? "Dashboard"}</h1>
          <p className="text-muted-foreground text-sm mt-0.5">{company?.ticker} · {company?.status}</p>
        </div>
      </div>

      {/* Stat cards */}
      <div className="gap-4 grid sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Treasury"
          value={`£${company?.treasury.toLocaleString() ?? 0}`}
          icon={<WalletIcon className="size-4" />}
          accent="green"
        />
        <StatCard
          label="Reputation"
          value={String(company?.reputation ?? 0)}
          icon={<StarIcon className="size-4" />}
          accent="yellow"
        />
        <StatCard
          label="Ship Upkeep"
          value={economy ? `£${economy.ship_upkeep.toLocaleString()}` : "—"}
          sub={`${ships.length} ship${ships.length !== 1 ? "s" : ""}`}
          icon={<ShipIcon className="size-4" />}
          accent="blue"
        />
        <StatCard
          label="Warehouse Upkeep"
          value={economy ? `£${economy.warehouse_upkeep.toLocaleString()}` : "—"}
          sub={economy ? `Total: £${economy.total_upkeep.toLocaleString()}/cycle` : undefined}
          icon={<BuildingIcon className="size-4" />}
          accent="purple"
        />
      </div>

      {/* Charts row */}
      {(treasuryChartData.length > 1 || upkeepData.length > 0) && (
        <div className="gap-4 grid lg:grid-cols-3">
          {/* Treasury over time */}
          {treasuryChartData.length > 1 && (
            <Card className="lg:col-span-2">
              <CardHeader>
                <CardTitle className="text-sm font-medium text-muted-foreground">Treasury Balance</CardTitle>
              </CardHeader>
              <CardContent>
                <ResponsiveContainer width="100%" height={200}>
                  <AreaChart data={treasuryChartData} margin={{ top: 4, right: 8, left: 8, bottom: 0 }}>
                    <defs>
                      <linearGradient id="treasuryGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#6366f1" stopOpacity={0.25} />
                        <stop offset="95%" stopColor="#6366f1" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                    <XAxis dataKey="label" hide />
                    <YAxis
                      tickFormatter={(v) => `£${(v as number / 1000).toFixed(0)}k`}
                      tick={{ fontSize: 11 }}
                      width={52}
                      className="fill-muted-foreground"
                    />
                    <Tooltip
                      content={({ active, payload }) => {
                        if (!active || !payload?.length) return null;
                        const d = payload[0].payload as { label: string; balance: number };
                        return (
                          <div className="bg-popover border rounded-lg px-3 py-2 shadow-md text-sm">
                            <p className="text-muted-foreground text-xs mb-1">{d.label}</p>
                            <p className="font-mono font-semibold">£{d.balance.toLocaleString()}</p>
                          </div>
                        );
                      }}
                    />
                    <Area
                      type="monotone"
                      dataKey="balance"
                      stroke="#6366f1"
                      strokeWidth={2}
                      fill="url(#treasuryGrad)"
                      dot={false}
                      activeDot={{ r: 4, fill: "#6366f1" }}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>
          )}

          {/* Upkeep split */}
          {upkeepData.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-sm font-medium text-muted-foreground">Upkeep Split</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col items-center justify-center gap-3">
                <ResponsiveContainer width="100%" height={160}>
                  <PieChart>
                    <Pie
                      data={upkeepData}
                      cx="50%"
                      cy="50%"
                      innerRadius={45}
                      outerRadius={70}
                      paddingAngle={3}
                      dataKey="value"
                    >
                      {upkeepData.map((_, i) => (
                        <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                      ))}
                    </Pie>
                    <Tooltip
                      content={({ active, payload }) => {
                        if (!active || !payload?.length) return null;
                        const d = payload[0].payload as { name: string; value: number };
                        return (
                          <div className="bg-popover border rounded-lg px-3 py-2 shadow-md text-sm">
                            <p className="text-muted-foreground text-xs">{d.name}</p>
                            <p className="font-mono font-semibold">£{d.value.toLocaleString()}</p>
                          </div>
                        );
                      }}
                    />
                  </PieChart>
                </ResponsiveContainer>
                <div className="flex gap-4 text-xs text-muted-foreground">
                  {upkeepData.map((d, i) => (
                    <span key={d.name} className="flex items-center gap-1.5">
                      <span className="inline-block size-2.5 rounded-full" style={{ backgroundColor: PIE_COLORS[i] }} />
                      {d.name}: £{d.value.toLocaleString()}
                    </span>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {/* Daily P&L bar chart */}
      {dailyPnlData.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium text-muted-foreground">Daily P&amp;L</CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={180}>
              <BarChart data={dailyPnlData} margin={{ top: 4, right: 8, left: 8, bottom: 0 }} barGap={2}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-border" vertical={false} />
                <XAxis dataKey="day" tick={{ fontSize: 11 }} className="fill-muted-foreground" />
                <YAxis
                  tickFormatter={(v) => `£${(v as number / 1000).toFixed(0)}k`}
                  tick={{ fontSize: 11 }}
                  width={52}
                  className="fill-muted-foreground"
                />
                <Tooltip
                  content={({ active, payload, label }) => {
                    if (!active || !payload?.length) return null;
                    return (
                      <div className="bg-popover border rounded-lg px-3 py-2 shadow-md text-sm space-y-1">
                        <p className="text-muted-foreground text-xs font-medium">{label as string}</p>
                        {payload.map((p) => (
                          <p key={p.name as string} className="font-mono font-semibold" style={{ color: p.color as string }}>
                            {p.name as string}: £{(p.value as number).toLocaleString()}
                          </p>
                        ))}
                      </div>
                    );
                  }}
                />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar dataKey="income" name="Income" fill="#22c55e" radius={[3, 3, 0, 0]} maxBarSize={40} />
                <Bar dataKey="expenses" name="Expenses" fill="#ef4444" radius={[3, 3, 0, 0]} maxBarSize={40} />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      )}

      {/* Autopilot card */}
      <Card>
        <CardHeader>
          <div className="flex justify-between items-center">
            <CardTitle className="flex items-center gap-2">
              <BotIcon className="size-4" />
              Autopilot
            </CardTitle>
            <Button
              size="sm"
              variant={ap.enabled ? "destructive" : "default"}
              onClick={toggleAp}
            >
              {ap.enabled ? "Disable" : "Enable"}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-4 text-sm">
            <span>
              Status:{" "}
              <Badge variant={ap.enabled ? "success" : "secondary"}>
                {ap.enabled ? "Running" : "Off"}
              </Badge>
            </span>
            <span className="text-muted-foreground">
              Profit accrued:{" "}
              <span className="font-mono font-semibold text-foreground">
                £{Math.round(ap.profitAccrued).toLocaleString()}
              </span>
            </span>
            {ap.enabled && (
              <span className="text-muted-foreground text-xs">
                Cycles every {CYCLE_MS / 1000}s
                {ap.lastCycleAt && ` · last ran ${new Date(ap.lastCycleAt).toLocaleTimeString()}`}
              </span>
            )}
          </div>

          {/* Per-ship status */}
          {ships.length > 0 && (
            <div className="border rounded-lg divide-y text-sm">
              {ships.map((ship) => {
                const ss = ap.ships[ship.id];
                const phase = ss?.phase ?? "idle";
                const cargo = shipCargo[ship.id] ?? [];
                return (
                  <div key={ship.id} className="flex justify-between items-center px-3 py-2">
                    <div>
                      <span className="font-medium">{ship.name}</span>
                      {cargo.length > 0 && (
                        <p className="text-muted-foreground text-xs">
                          {cargo.map((c) => `${c.quantity}× ${goodName(c.good_id)}`).join(", ")}
                        </p>
                      )}
                    </div>
                    <div className="flex items-center gap-2 text-muted-foreground text-xs">
                      <Badge
                        variant={ship.status === "docked" ? "success" : "info"}
                        className="text-xs"
                      >
                        {ship.status}
                      </Badge>
                      <span>{portName(ship.port_id)}</span>
                      {ship.status === "traveling" && ship.arriving_at && (
                        <Countdown to={ship.arriving_at} />
                      )}
                      {ap.enabled && (
                        <Badge variant={phase === "idle" ? "secondary" : "warning"} className="text-xs">
                          {phase === "transiting_to_sell"
                            ? `→ sell @ ${portName(ss?.plan?.sellPortId ?? null)}`
                            : phase === "transiting_to_buy"
                            ? `→ buy ${goodName(ss?.plan?.goodId)}`
                            : phase}
                        </Badge>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Warehouse stockpile summary */}
          {ap.enabled && warehouseStocks.length > 0 && (() => {
            const byPort = warehouseStocks.reduce<Record<string, StoredWarehouseStock[]>>((acc, s) => {
              (acc[s.portId] ??= []).push(s);
              return acc;
            }, {});
            return (
              <div>
                <p className="text-xs text-muted-foreground mb-1 flex items-center gap-1">
                  <PackageIcon className="size-3" /> Warehouse stockpile
                </p>
                <div className="border rounded-lg divide-y text-sm">
                  {Object.entries(byPort).map(([portId, items]) => (
                    <div key={portId} className="flex justify-between items-start px-3 py-2 gap-2">
                      <span className="font-medium shrink-0">{ports.find((p) => p.id === portId)?.name ?? portId.slice(0, 8)}</span>
                      <span className="text-muted-foreground text-xs text-right">
                        {items.map((i) => `${goods.find((g) => g.id === i.goodId)?.name ?? i.goodName}`).join(", ")}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            );
          })()}

          {/* Log */}
          {ap.log.length > 0 && (
            <div className="space-y-1 bg-muted/30 p-3 border rounded-lg max-h-48 overflow-y-auto">
              {ap.log.slice(0, 20).map((entry, i) => (
                <div key={i} className="flex gap-2 text-xs">
                  <span className="tabular-nums text-muted-foreground shrink-0">
                    {new Date(entry.at).toLocaleTimeString()}
                  </span>
                  <span>{entry.message}</span>
                </div>
              ))}
            </div>
          )}

          {ap.enabled && ap.log.length === 0 && (
            <p className="text-muted-foreground text-sm">
              Scanning for opportunities… (first cycle runs immediately on enable)
            </p>
          )}
        </CardContent>
      </Card>

      {ledger.length > 0 && (
        <Card>
          <CardHeader>
            <div className="flex justify-between items-center">
              <CardTitle>Recent Ledger</CardTitle>
              <span className={`text-sm font-mono font-semibold ${totalLedgerNet >= 0 ? "text-green-600" : "text-destructive"}`}>
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

function StatCard({
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
  accent?: "green" | "yellow" | "blue" | "purple" | "default";
}) {
  const accentClasses: Record<string, string> = {
    green:   "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-400",
    yellow:  "bg-yellow-100 text-yellow-700 dark:bg-yellow-950 dark:text-yellow-400",
    blue:    "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-400",
    purple:  "bg-purple-100 text-purple-700 dark:bg-purple-950 dark:text-purple-400",
    default: "bg-muted text-muted-foreground",
  };
  return (
    <Card>
      <CardContent className="pt-6">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <p className="text-muted-foreground text-xs font-medium uppercase tracking-wide">{label}</p>
            <p className="font-mono font-bold text-2xl mt-1 truncate">{value}</p>
            {sub && <p className="text-muted-foreground text-xs mt-1">{sub}</p>}
          </div>
          {icon && (
            <div className={`flex size-9 shrink-0 items-center justify-center rounded-lg ${accentClasses[accent]}`}>
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
      setLabel(diff === 0 ? "docking…" : `docks in ${m}:${String(s).padStart(2, "0")}`);
      if (diff > 0) rafRef.current = window.setTimeout(update, 1000);
    }

    update();
    return () => { if (rafRef.current) clearTimeout(rafRef.current); };
  }, [to]);

  return <span className="font-mono">{label}</span>;
}

function LedgerRow({ entry }: { entry: LedgerEntry }) {
  const positive = entry.amount >= 0;
  const Icon = positive ? TrendingUpIcon : TrendingDownIcon;
  const date = new Date(entry.occurred_at);
  const isToday = new Date().toDateString() === date.toDateString();
  const dateLabel = isToday
    ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleDateString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

  return (
    <div className="group flex items-center gap-3 hover:bg-muted/40 px-4 py-3 transition-colors">
      <div className={`flex size-8 shrink-0 items-center justify-center rounded-full ${positive ? "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-400" : "bg-red-100 text-destructive dark:bg-red-950"}`}>
        <Icon className="size-4" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm truncate">{entry.description}</p>
        <p className="tabular-nums text-muted-foreground text-xs">{dateLabel}</p>
      </div>
      <span className={`text-sm font-mono font-semibold shrink-0 ${positive ? "text-green-600 dark:text-green-400" : "text-destructive"}`}>
        {positive ? "+" : ""}£{Math.abs(entry.amount).toLocaleString()}
      </span>
    </div>
  );
}

