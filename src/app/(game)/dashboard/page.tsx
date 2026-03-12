"use client";

import { useEffect, useState } from "react";
import { companyApi } from "@/lib/api/company";
import type { Company, CompanyEconomy, LedgerEntry } from "@/lib/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { EventsFeed } from "@/components/layout/events-feed";

export default function DashboardPage() {
  const [company, setCompany] = useState<Company | null>(null);
  const [economy, setEconomy] = useState<CompanyEconomy | null>(null);
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      companyApi.getCompany(),
      companyApi.getEconomy(),
      companyApi.getLedger(),
    ])
      .then(([c, e, l]) => {
        setCompany(c);
        setEconomy(e);
        setLedger(l);
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
