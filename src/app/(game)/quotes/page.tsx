"use client";

import { useEffect, useState } from "react";
import { Good, Quote } from "@/lib/types";
import { worldApi } from "@/lib/api/world";
import { tradeApi } from "@/lib/api/trade";
import { fleetApi } from "@/lib/api/fleet";
import { warehousesApi } from "@/lib/api/warehouses";
import { getQuotes, removeQuote } from "@/lib/quote-store";
import type { Ship, Warehouse, Port } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";

function useSecondsLeft(expiresAt: string) {
  const [left, setLeft] = useState(() =>
    Math.max(0, Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000))
  );
  useEffect(() => {
    const interval = setInterval(() => {
      setLeft(Math.max(0, Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000)));
    }, 1000);
    return () => clearInterval(interval);
  }, [expiresAt]);
  return left;
}

function QuoteRow({
  quote,
  goods,
  ports,
  ships,
  warehouses,
  onExecuted,
  onDismissed,
}: {
  quote: Quote;
  goods: Good[];
  ports: Port[];
  ships: Ship[];
  warehouses: Warehouse[];
  onExecuted: (token: string) => void;
  onDismissed: (token: string) => void;
}) {
  const secondsLeft = useSecondsLeft(quote.expires_at);
  const [destType, setDestType] = useState<"ship" | "warehouse">("ship");
  const [selectedShip, setSelectedShip] = useState("");
  const [selectedWarehouse, setSelectedWarehouse] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const good = goods.find((g) => g.id === quote.good_id);
  const port = ports.find((p) => p.id === quote.port_id);
  const dockedAtPort = ships.filter((s) => s.status === "docked" && s.port_id === quote.port_id);

  const handleExecute = async () => {
    const destId = destType === "ship" ? selectedShip : selectedWarehouse;
    if (!destId) { setError("Select a destination first."); return; }
    setSubmitting(true);
    setError(null);
    try {
      await tradeApi.executeQuote({
        token: quote.token,
        destinations: [{ type: destType, id: destId, quantity: quote.quantity }],
      });
      removeQuote(quote.token);
      onExecuted(quote.token);
    } catch (e: unknown) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const expired = secondsLeft === 0;

  return (
    <div className={`rounded-lg border p-4 space-y-3 ${expired ? "opacity-50" : ""}`}>
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-0.5">
          <div className="flex items-center gap-2">
            <span className="font-semibold">{good?.name ?? quote.good_id}</span>
            <Badge variant={quote.action === "buy" ? "success" : "info"} className="capitalize">
              {quote.action}
            </Badge>
          </div>
          <p className="text-sm text-muted-foreground">
            {port?.name ?? quote.port_id} · {quote.quantity.toLocaleString()} units · £{quote.unit_price.toLocaleString()}/unit · Total £{quote.total_price.toLocaleString()}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Badge variant={secondsLeft > 30 ? "success" : expired ? "destructive" : "warning"}>
            {expired ? "Expired" : `${secondsLeft}s`}
          </Badge>
          <Button size="sm" variant="ghost" onClick={() => { removeQuote(quote.token); onDismissed(quote.token); }}>
            ✕
          </Button>
        </div>
      </div>

      {!expired && (
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <Label className="text-xs">Type</Label>
            <Select value={destType} onValueChange={(v: string) => { setDestType(v as "ship" | "warehouse"); setSelectedShip(""); setSelectedWarehouse(""); }}>
              <SelectTrigger className="h-8 w-28"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="ship">Ship</SelectItem>
                <SelectItem value="warehouse">Warehouse</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {destType === "ship" ? (
            <div className="space-y-1">
              <Label className="text-xs">Ship</Label>
              <Select value={selectedShip} onValueChange={setSelectedShip}>
                <SelectTrigger className="h-8 w-44"><SelectValue placeholder="Select..." /></SelectTrigger>
                <SelectContent>
                  {(dockedAtPort.length > 0 ? dockedAtPort : ships.filter((s) => s.status === "docked")).map((s) => (
                    <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : (
            <div className="space-y-1">
              <Label className="text-xs">Warehouse</Label>
              <Select value={selectedWarehouse} onValueChange={setSelectedWarehouse}>
                <SelectTrigger className="h-8 w-44"><SelectValue placeholder="Select..." /></SelectTrigger>
                <SelectContent>
                  {warehouses.map((w) => (
                    <SelectItem key={w.id} value={w.id}>
                      {ports.find((p) => p.id === w.port_id)?.name ?? w.port_id}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <Button size="sm" className="h-8" onClick={handleExecute} disabled={submitting}>
            {submitting ? <Spinner className="size-3" /> : "Execute"}
          </Button>
        </div>
      )}

      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

export default function QuotesPage() {
  const [quotes, setQuotes] = useState<Quote[]>([]);
  const [goods, setGoods] = useState<Good[]>([]);
  const [ports, setPorts] = useState<Port[]>([]);
  const [ships, setShips] = useState<Ship[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setQuotes(getQuotes());
    Promise.all([
      worldApi.getGoods(),
      worldApi.getPorts(),
      fleetApi.getShips(),
      warehousesApi.getWarehouses(),
    ])
      .then(([g, p, s, w]) => { setGoods(g); setPorts(p); setShips(s); setWarehouses(w); })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  const removeRow = (token: string) => setQuotes((prev) => prev.filter((q) => q.token !== token));

  if (loading) return <div className="flex h-full items-center justify-center"><Spinner className="size-8" /></div>;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Active Quotes</h1>

      {quotes.length === 0 ? (
        <p className="text-muted-foreground text-sm">No active quotes. Get one from the Trade page.</p>
      ) : (
        <div className="space-y-3">
          {quotes.map((q) => (
            <QuoteRow
              key={q.token}
              quote={q}
              goods={goods}
              ports={ports}
              ships={ships}
              warehouses={warehouses}
              onExecuted={removeRow}
              onDismissed={removeRow}
            />
          ))}
        </div>
      )}
    </div>
  );
}
