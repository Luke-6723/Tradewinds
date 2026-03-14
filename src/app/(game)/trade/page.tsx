"use client";

import { useEffect, useState } from "react";
import { Good, Port, Quote, Ship, TraderPosition, Warehouse } from "@/lib/types";
import { worldApi } from "@/lib/api/world";
import { tradeApi } from "@/lib/api/trade";
import { fleetApi } from "@/lib/api/fleet";
import { warehousesApi } from "@/lib/api/warehouses";
import { saveQuote, removeQuote } from "@/lib/quote-store";
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
  const [ships, setShips] = useState<Ship[]>([]);
  const [allPositions, setAllPositions] = useState<TraderPosition[]>([]);
  const [traderNames, setTraderNames] = useState<Map<string, string>>(new Map());

  const [selectedPort, setSelectedPort] = useState("");
  const [selectedTrader, setSelectedTrader] = useState("");
  const [selectedGood, setSelectedGood] = useState("");
  const [direction, setDirection] = useState<"buy" | "sell">("buy");
  const [quantity, setQuantity] = useState("1");

  const [destType, setDestType] = useState<"ship" | "warehouse">("ship");
  const [selectedShip, setSelectedShip] = useState("");
  const [selectedWarehouse, setSelectedWarehouse] = useState("");

  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoteSecondsLeft, setQuoteSecondsLeft] = useState(0);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    Promise.all([
      worldApi.getPorts(),
      worldApi.getGoods(),
      warehousesApi.getWarehouses(),
      fleetApi.getShips(),
      tradeApi.getTraderPositions(),
      tradeApi.getTraders(),
    ])
      .then(([p, g, w, s, tp, traders]) => {
        setPorts(p);
        setGoods(g);
        setWarehouses(w);
        setShips(s);
        setAllPositions(tp);
        setTraderNames(new Map(traders.map((t) => [t.id, t.name])));
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!quote) return;
    const interval = setInterval(() => {
      const left = Math.max(0, Math.floor((new Date(quote.expires_at).getTime() - Date.now()) / 1000));
      setQuoteSecondsLeft(left);
      if (left === 0) { setQuote(null); clearInterval(interval); }
    }, 1000);
    return () => clearInterval(interval);
  }, [quote]);

  const tradersAtPort = selectedPort
    ? [...new Map(
        allPositions
          .filter((p) => p.port_id === selectedPort)
          .map((p) => [p.trader_id, p])
      ).values()]
    : [];

  const goodsForTrader = selectedPort && selectedTrader
    ? allPositions.filter((p) => p.port_id === selectedPort && p.trader_id === selectedTrader)
    : [];

  const dockedShipsAtPort = ships.filter((s) => s.status === "docked" && s.port_id === selectedPort);

  const handleGetQuote = async () => {
    if (!selectedGood || !quantity) return;
    setSubmitting(true);
    setMessage("");
    try {
      const q = await tradeApi.createQuote({
        port_id: selectedPort,
        good_id: selectedGood,
        quantity: Number(quantity),
        action: direction,
      });
      setQuote(q);
      saveQuote(q);
    } catch (e: unknown) {
      setMessage(`Error: ${(e as Error).message}`);
    } finally {
      setSubmitting(false);
    }
  };

  const handleExecuteQuote = async () => {
    if (!quote) return;
    const destId = destType === "ship" ? selectedShip : selectedWarehouse;
    if (!destId) { setMessage("Please select a destination."); return; }
    setSubmitting(true);
    setMessage("");
    try {
      await tradeApi.executeQuote({
        token: quote.token,
        destinations: [{ type: destType, id: destId, quantity: quote.quantity }],
      });
      removeQuote(quote.token);
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
              <Select value={selectedPort} onValueChange={(v: string) => { setSelectedPort(v); setSelectedTrader(""); setSelectedGood(""); }}>
                <SelectTrigger><SelectValue placeholder="Select a port..." /></SelectTrigger>
                <SelectContent>
                  {ports.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>

            {tradersAtPort.length > 0 && (
              <div className="space-y-2">
                <Label>Trader</Label>
                <Select value={selectedTrader} onValueChange={(v: string) => { setSelectedTrader(v); setSelectedGood(""); }}>
                  <SelectTrigger><SelectValue placeholder="Select a trader..." /></SelectTrigger>
                  <SelectContent>
                    {tradersAtPort.map((t) => (
                      <SelectItem key={t.trader_id} value={t.trader_id}>
                        {traderNames.get(t.trader_id) ?? t.trader_id.slice(0, 8) + "…"}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {goodsForTrader.length > 0 && (
              <div className="space-y-2">
                <Label>Good</Label>
                <Select value={selectedGood} onValueChange={setSelectedGood}>
                  <SelectTrigger><SelectValue placeholder="Select a good..." /></SelectTrigger>
                  <SelectContent>
                    {goodsForTrader.map((p) => {
                      const good = goods.find((g) => g.id === p.good_id);
                      return (
                        <SelectItem key={p.good_id} value={p.good_id}>
                          {good?.name ?? p.good_id.slice(0, 8)}
                        </SelectItem>
                      );
                    })}
                  </SelectContent>
                </Select>
              </div>
            )}

            {selectedPort && tradersAtPort.length === 0 && (
              <p className="text-sm text-muted-foreground">No traders at this port.</p>
            )}

            {selectedGood && (
              <>
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
                <Button onClick={handleGetQuote} disabled={submitting || !selectedPort || !selectedGood}>
                  {submitting ? <Spinner className="size-4" /> : "Get Quote (120s)"}
                </Button>
              </>
            )}
          </CardContent>
        </Card>

        {quote && (
          <Card>
            <CardHeader><CardTitle>Quote</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-1 text-sm">
                <div className="flex justify-between"><span className="text-muted-foreground">Good</span><span>{goods.find((g) => g.id === quote.good_id)?.name ?? quote.good_id}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Action</span><span className="capitalize">{quote.action}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Quantity</span><span>{quote.quantity.toLocaleString()}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Price / unit</span><span className="font-mono">{quote.unit_price.toLocaleString()}</span></div>
                <div className="flex justify-between font-semibold"><span>Total</span><span className="font-mono">{quote.total_price.toLocaleString()}</span></div>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant={quoteSecondsLeft > 30 ? "success" : "warning"}>{quoteSecondsLeft}s left</Badge>
              </div>
              <div className="space-y-3 border-t pt-3">
                <div className="space-y-2">
                  <Label>Destination type</Label>
                  <Select value={destType} onValueChange={(v: string) => { setDestType(v as "ship" | "warehouse"); setSelectedShip(""); setSelectedWarehouse(""); }}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="ship">Ship</SelectItem>
                      <SelectItem value="warehouse">Warehouse</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {destType === "ship" ? (
                  <div className="space-y-2">
                    <Label>Ship</Label>
                    <Select value={selectedShip} onValueChange={setSelectedShip}>
                      <SelectTrigger><SelectValue placeholder="Select a ship..." /></SelectTrigger>
                      <SelectContent>
                        {(dockedShipsAtPort.length > 0 ? dockedShipsAtPort : ships.filter((s) => s.status === "docked")).map((s) => (
                          <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {selectedPort && dockedShipsAtPort.length === 0 && (
                      <p className="text-xs text-muted-foreground">No ships docked at this port — showing all docked ships.</p>
                    )}
                  </div>
                ) : (
                  <div className="space-y-2">
                    <Label>Warehouse</Label>
                    <Select value={selectedWarehouse} onValueChange={setSelectedWarehouse}>
                      <SelectTrigger><SelectValue placeholder="Select a warehouse..." /></SelectTrigger>
                      <SelectContent>
                        {warehouses.map((w) => (
                          <SelectItem key={w.id} value={w.id}>{ports.find((p) => p.id === w.port_id)?.name ?? w.port_id}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
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
