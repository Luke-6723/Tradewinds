"use client";

import { useEffect, useState } from "react";
import { companyApi } from "@/lib/api/company";
import { fleetApi } from "@/lib/api/fleet";
import { worldApi } from "@/lib/api/world";
import type { Company, CompanyEconomy, LedgerEntry, Port, Ship } from "@/lib/types";
import { useAutopilot } from "@/hooks/use-autopilot";
import { CYCLE_MS } from "@/lib/autopilot-types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { EventsFeed } from "@/components/layout/events-feed";
import { BotIcon } from "lucide-react";

export default function DashboardPage() {
  const [company, setCompany] = useState<Company | null>(null);
  const [economy, setEconomy] = useState<CompanyEconomy | null>(null);
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  const [ships, setShips] = useState<Ship[]>([]);
  const [ports, setPorts] = useState<Port[]>([]);
  const [loading, setLoading] = useState(true);
  const { state: ap, toggle: toggleAp } = useAutopilot();

  useEffect(() => {
    Promise.all([
      companyApi.getCompany(),
      companyApi.getEconomy(),
      companyApi.getLedger(),
      fleetApi.getShips().catch(() => []),
      worldApi.getPorts().catch(() => []),
    ])
      .then(([c, e, l, s, p]) => {
        setCompany(c);
        setEconomy(e);
        setLedger(l);
        setShips(s as Ship[]);
        setPorts(p as Port[]);
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
          <div className="flex items-center justify-between">
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
            <div className="divide-y rounded-lg border text-sm">
              {ships.map((ship) => {
                const ss = ap.ships[ship.id];
                const phase = ss?.phase ?? "idle";
                return (
                  <div key={ship.id} className="flex items-center justify-between px-3 py-2">
                    <span className="font-medium">{ship.name}</span>
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Badge
                        variant={ship.status === "docked" ? "success" : "info"}
                        className="text-xs"
                      >
                        {ship.status}
                      </Badge>
                      <span>{portName(ship.port_id)}</span>
                      {ap.enabled && (
                        <Badge variant={phase === "idle" ? "secondary" : "warning"} className="text-xs">
                          {phase === "transiting_to_sell"
                            ? `→ ${portName(ss?.plan?.sellPortId ?? null)}`
                            : phase}
                        </Badge>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Log */}
          {ap.log.length > 0 && (
            <div className="rounded-lg border bg-muted/30 p-3 max-h-48 overflow-y-auto space-y-1">
              {ap.log.slice(0, 20).map((entry, i) => (
                <div key={i} className="flex gap-2 text-xs">
                  <span className="text-muted-foreground shrink-0 tabular-nums">
                    {new Date(entry.at).toLocaleTimeString()}
                  </span>
                  <span>{entry.message}</span>
                </div>
              ))}
            </div>
          )}

          {ap.enabled && ap.log.length === 0 && (
            <p className="text-sm text-muted-foreground">
              Scanning for opportunities… (first cycle runs immediately on enable)
            </p>
          )}
        </CardContent>
      </Card>

      <div className="gap-4 grid lg:grid-cols-2">
        <EventsFeed type="company" />
        <EventsFeed type="world" />
      </div>

      {ledger.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Recent Ledger</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="divide-y">
              {ledger.slice(0, 20).map((entry) => (
                <div key={entry.id} className="flex justify-between items-center py-2 text-sm">
                  <span className="text-muted-foreground">{entry.description}</span>
                  <span
                    className={
                      entry.amount >= 0 ? "text-green-600 font-mono" : "text-destructive font-mono"
                    }
                  >
                    {entry.amount >= 0 ? "+" : ""}£{entry.amount.toLocaleString()}
                  </span>
                </div>
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

