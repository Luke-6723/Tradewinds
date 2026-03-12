"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { Port } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { Badge } from "@/components/ui/badge";

export default function NewCompanyPage() {
  const router = useRouter();
  const [ports,       setPorts]       = useState<Port[]>([]);
  const [portsLoading, setPortsLoading] = useState(true);
  const [name,        setName]        = useState("");
  const [ticker,      setTicker]      = useState("");
  const [homePortId,  setHomePortId]  = useState("");
  const [error,       setError]       = useState<string | null>(null);
  const [loading,     setLoading]     = useState(false);

  useEffect(() => {
    fetch("/api/world/ports")
      .then((r) => r.json())
      .then((d) => {
        const list: Port[] = d.data ?? [];
        // Sort: hubs first, then alphabetical
        list.sort((a, b) => {
          if (a.is_hub !== b.is_hub) return a.is_hub ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
        setPorts(list);
        // Pre-select first hub
        const firstHub = list.find((p) => p.is_hub);
        if (firstHub) setHomePortId(firstHub.id);
      })
      .catch(() => setError("Failed to load ports."))
      .finally(() => setPortsLoading(false));
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (ticker.length > 5) {
      setError("Ticker must be 5 characters or fewer.");
      return;
    }

    setLoading(true);
    try {
      const res = await fetch("/api/companies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, ticker: ticker.toUpperCase(), home_port_id: homePortId }),
      });

      const data = await res.json();

      if (!res.ok) {
        const errs = data?.errors ?? {};
        const msg =
          errs.name?.[0] ??
          errs.ticker?.[0] ??
          errs.home_port_id?.[0] ??
          errs.detail ??
          "Failed to create company.";
        setError(msg);
        return;
      }

      const company = data.data;

      // Select the new company
      await fetch("/api/auth/select-company", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ company_id: company.id }),
      });

      router.push("/dashboard");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <h1 className="text-3xl font-bold tracking-tight">⚓ Tradewinds</h1>
          <p className="mt-1 text-sm text-muted-foreground">Found a new trading company</p>
        </div>

        <div className="rounded-xl border bg-card p-6 shadow-lg">
          <h2 className="mb-5 text-lg font-semibold">New company</h2>

          {error && (
            <p className="mb-4 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </p>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="name">Company name</Label>
              <Input
                id="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="East India Trading Co."
                required
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="ticker">
                Ticker
                <span className="ml-1.5 text-xs text-muted-foreground">(up to 5 chars)</span>
              </Label>
              <Input
                id="ticker"
                value={ticker}
                onChange={(e) => setTicker(e.target.value.toUpperCase())}
                placeholder="EITC"
                maxLength={5}
                required
              />
            </div>

            <div className="space-y-1.5">
              <Label>Home port</Label>
              {portsLoading ? (
                <div className="flex h-10 items-center"><Spinner /></div>
              ) : (
                <div className="grid grid-cols-2 gap-2">
                  {ports.map((port) => (
                    <button
                      key={port.id}
                      type="button"
                      onClick={() => setHomePortId(port.id)}
                      className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm transition-colors ${
                        homePortId === port.id
                          ? "border-primary bg-primary/10 text-foreground"
                          : "hover:border-border/80 text-muted-foreground"
                      }`}
                    >
                      <span className="font-medium">{port.name}</span>
                      {port.is_hub && (
                        <Badge variant="warning" size="sm">hub</Badge>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <Button
              type="submit"
              className="w-full"
              disabled={loading || !homePortId || portsLoading}
            >
              {loading ? "Creating…" : "Found company"}
            </Button>
          </form>

          <div className="mt-4 text-center">
            <button
              type="button"
              onClick={() => router.push("/companies")}
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              ← Back to companies
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
