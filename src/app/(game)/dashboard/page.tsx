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
import { BotIcon, PackageIcon, TrendingDownIcon, TrendingUpIcon } from "lucide-react";

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
      companyApi.getLedger(),
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

  return (
    <div className="space-y-6">
      <h1 className="font-bold text-2xl">Dashboard</h1>

      <div className="gap-4 grid sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Treasury" value={`£${company?.treasury.toLocaleString() ?? 0}`} />
        <StatCard label="Reputation" value={String(company?.reputation ?? 0)} />
        <StatCard
          label="Ship Upkeep"
          value={economy ? `£${economy.ship_upkeep.toLocaleString()}` : "—"}
        />
        <StatCard
          label="Warehouse Upkeep"
          value={economy ? `£${economy.warehouse_upkeep.toLocaleString()}` : "—"}
        />
      </div>

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
              <span className={`text-sm font-mono font-semibold ${ledger.slice(0, 20).reduce((s, e) => s + e.amount, 0) >= 0 ? "text-green-600" : "text-destructive"}`}>
                net {ledger.slice(0, 20).reduce((s, e) => s + e.amount, 0) >= 0 ? "+" : ""}£{ledger.slice(0, 20).reduce((s, e) => s + e.amount, 0).toLocaleString()}
              </span>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            <div className="divide-y">
              {ledger.slice(0, 20).map((entry) => (
                <LedgerRow key={entry.id} entry={entry} />
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="font-medium text-muted-foreground text-sm">{label}</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="font-mono font-bold text-2xl">{value}</p>
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

