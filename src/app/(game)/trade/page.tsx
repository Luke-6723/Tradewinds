"use client";

import { useEffect, useState } from "react";
import { Good, Port, Quote, TraderPosition } from "@/lib/types";
import { worldApi } from "@/lib/api/world";
import { tradeApi } from "@/lib/api/trade";
import { warehousesApi } from "@/lib/api/warehouses";
import type { Warehouse } from "@/lib/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";

export default function TradePage() {
  const [ports, setPorts] = useState<Port[]>([]);
  const [goods, setGoods] = useState<Good[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [traders, setTraders] = useState<TraderPosition[]>([]);

  const [selectedPort, setSelectedPort] = useState("");
  const [selectedTrader, setSelectedTrader] = useState("");
  const [selectedGood, setSelectedGood] = useState("");
  const [selectedWarehouse, setSelectedWarehouse] = useState("");
  const [direction, setDirection] = useState<"buy" | "sell">("buy");
  const [quantity, setQuantity] = useState("1");

  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoteSecondsLeft, setQuoteSecondsLeft] = useState(0);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    Promise.all([worldApi.getPorts(), worldApi.getGoods(), warehousesApi.getWarehouses()])
      .then(([p, g, w]) => { setPorts(p); setGoods(g); setWarehouses(w); })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!selectedPort) return;
    tradeApi.getTraderPositions(selectedPort).then(setTraders).catch(console.error);
  }, [selectedPort]);

  // Quote countdown timer
  useEffect(() => {
    if (!quote) return;
    const interval = setInterval(() => {
      const left = Math.max(0, Math.floor((new Date(quote.expires_at).getTime() - Date.now()) / 1000));
      setQuoteSecondsLeft(left);
      if (left === 0) { setQuote(null); clearInterval(interval); }
    }, 1000);
    return () => clearInterval(interval);
  }, [quote]);

  const handleGetQuote = async () => {
    if (!selectedTrader || !selectedGood || !quantity) return;
    setSubmitting(true);
    setMessage("");
    try {
      const q = await tradeApi.createQuote({
        trader_id: selectedTrader,
        good_id: selectedGood,
        quantity: Number(quantity),
        direction,
      });
      setQuote(q);
    } catch (e: unknown) {
      setMessage(`Error: ${(e as Error).message}`);
    } finally {
      setSubmitting(false);
    }
  };

  const handleExecuteQuote = async () => {
    if (!quote) return;
    setSubmitting(true);
    setMessage("");
    try {
      await tradeApi.executeQuote({ quote_id: quote.id, warehouse_id: selectedWarehouse || undefined });
      setMessage("Trade executed successfully!");
      setQuote(null);
    } catch (e: unknown) {
      setMessage(`Error: ${(e as Error).message}`);
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) return <div className="flex h-full items-center justify-center"><Spinner className="size-8" /></div>;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">NPC Trade</h1>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Configure Trade</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label>Port</Label>
              <Select value={selectedPort} onValueChange={setSelectedPort}>
                <SelectTrigger><SelectValue placeholder="Select a port…" /></SelectTrigger>
                <SelectContent>
                  {ports.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>

            {traders.length > 0 && (
              <div className="space-y-2">
                <Label>Trader</Label>
                <Select value={selectedTrader} onValueChange={setSelectedTrader}>
                  <SelectTrigger><SelectValue placeholder="Select a trader…" /></SelectTrigger>
                  <SelectContent>
                    {[...new Map(traders.map((t) => [t.trader_id, t])).values()].map((t) => (
                      <SelectItem key={t.trader_id} value={t.trader_id}>{t.trader_id.slice(0, 8)}…</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            <div className="space-y-2">
              <Label>Good</Label>
              <Select value={selectedGood} onValueChange={setSelectedGood}>
                <SelectTrigger><SelectValue placeholder="Select a good…" /></SelectTrigger>
                <SelectContent>
                  {goods.map((g) => <SelectItem key={g.id} value={g.id}>{g.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>Direction</Label>
              <Select value={direction} onValueChange={(v: string) => setDirection(v as "buy" | "sell")}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="buy">Buy from trader</SelectItem>
                  <SelectItem value="sell">Sell to trader</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>Quantity</Label>
              <Input type="number" min="1" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
            </div>

            <div className="space-y-2">
              <Label>Warehouse (optional)</Label>
              <Select value={selectedWarehouse} onValueChange={setSelectedWarehouse}>
                <SelectTrigger><SelectValue placeholder="No warehouse (ship cargo)" /></SelectTrigger>
                <SelectContent>
                  {warehouses.map((w) => (
                    <SelectItem key={w.id} value={w.id}>{ports.find((p) => p.id === w.port_id)?.name ?? w.port_id}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <Button onClick={handleGetQuote} disabled={submitting || !selectedTrader || !selectedGood}>
              {submitting ? <Spinner className="size-4" /> : "Get Quote (120s)"}
            </Button>
          </CardContent>
        </Card>

        {quote && (
          <Card>
            <CardHeader><CardTitle>Quote</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-1 text-sm">
                <div className="flex justify-between"><span className="text-muted-foreground">Good</span><span>{goods.find((g) => g.id === quote.good_id)?.name ?? quote.good_id}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Quantity</span><span>{quote.quantity.toLocaleString()}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Price / unit</span><span className="font-mono">£{quote.price_per_unit.toLocaleString()}</span></div>
                <div className="flex justify-between font-semibold"><span>Total</span><span className="font-mono">£{quote.total_price.toLocaleString()}</span></div>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant={quoteSecondsLeft > 30 ? "success" : "warning"}>
                  {quoteSecondsLeft}s left
                </Badge>
              </div>
              <Button onClick={handleExecuteQuote} disabled={submitting || quoteSecondsLeft === 0}>
                {submitting ? <Spinner className="size-4" /> : "Execute Trade"}
              </Button>
            </CardContent>
          </Card>
        )}
      </div>

      {message && (
        <div className={`rounded-lg border p-3 text-sm ${message.startsWith("Error") ? "border-destructive/40 bg-destructive/8 text-destructive-foreground" : "border-green-500/40 bg-green-500/8 text-green-700 dark:text-green-400"}`}>
          {message}
        </div>
      )}
    </div>
  );
}
