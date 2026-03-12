"use client";

import { useEffect, useState } from "react";
import { marketApi } from "@/lib/api/market";
import { worldApi } from "@/lib/api/world";
import { warehousesApi } from "@/lib/api/warehouses";
import type { Good, MarketOrder, Port, Warehouse } from "@/lib/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Trash2Icon } from "lucide-react";

export default function MarketPage() {
  const [ports, setPorts] = useState<Port[]>([]);
  const [goods, setGoods] = useState<Good[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [orders, setOrders] = useState<MarketOrder[]>([]);

  const [filterPort, setFilterPort] = useState("");
  const [filterGood, setFilterGood] = useState("");

  const [newPort, setNewPort] = useState("");
  const [newGood, setNewGood] = useState("");
  const [newType, setNewType] = useState<"buy" | "sell">("buy");
  const [newQty, setNewQty] = useState("1");
  const [newPrice, setNewPrice] = useState("100");

  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState("");

  const loadOrders = () => {
    marketApi.getOrders(filterPort || undefined, filterGood || undefined)
      .then(setOrders)
      .catch(console.error);
  };

  useEffect(() => {
    Promise.all([worldApi.getPorts(), worldApi.getGoods(), warehousesApi.getWarehouses()])
      .then(([p, g, w]) => { setPorts(p); setGoods(g); setWarehouses(w); })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { loadOrders(); }, [filterPort, filterGood]);

  const handleCreate = async () => {
    if (!newPort || !newGood) return;
    setSubmitting(true); setMessage("");
    try {
      await marketApi.createOrder({ port_id: newPort, good_id: newGood, side: newType, total: Number(newQty), price: Number(newPrice) });
      setMessage("Order created!"); loadOrders();
    } catch (e: unknown) { setMessage(`Error: ${(e as Error).message}`); }
    finally { setSubmitting(false); }
  };

  const handleCancel = async (id: string) => {
    try { await marketApi.cancelOrder(id); loadOrders(); } catch (e: unknown) { setMessage(`Error: ${(e as Error).message}`); }
  };

  if (loading) return <div className="flex h-full items-center justify-center"><Spinner className="size-8" /></div>;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Order Book</h1>

      <Tabs defaultValue="browse">
        <TabsList>
          <TabsTrigger value="browse">Browse Orders</TabsTrigger>
          <TabsTrigger value="create">Create Order</TabsTrigger>
        </TabsList>

        <TabsContent value="browse" className="mt-4 space-y-4">
          <div className="flex gap-3">
            <Select value={filterPort} onValueChange={setFilterPort}>
              <SelectTrigger className="w-48"><SelectValue placeholder="All ports" /></SelectTrigger>
              <SelectContent>{ports.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}</SelectContent>
            </Select>
            <Select value={filterGood} onValueChange={setFilterGood}>
              <SelectTrigger className="w-48"><SelectValue placeholder="All goods" /></SelectTrigger>
              <SelectContent>{goods.map((g) => <SelectItem key={g.id} value={g.id}>{g.name}</SelectItem>)}</SelectContent>
            </Select>
            <Button variant="outline" onClick={() => { setFilterPort(""); setFilterGood(""); }}>Clear</Button>
          </div>

          <div className="divide-y rounded-lg border">
            {orders.length === 0 ? (
              <p className="p-4 text-muted-foreground text-sm">No orders match the filter.</p>
            ) : orders.map((o) => (
              <div key={o.id} className="flex items-center justify-between px-4 py-3 text-sm">
                <div className="space-y-0.5">
                  <div className="flex items-center gap-2">
                    <Badge variant={o.side === "sell" ? "info" : "success"}>{o.side.toUpperCase()}</Badge>
                    <span className="font-medium">{goods.find((g) => g.id === o.good_id)?.name ?? o.good_id.slice(0, 8)}</span>
                  </div>
                  <p className="text-muted-foreground">{ports.find((p) => p.id === o.port_id)?.name ?? o.port_id}</p>
                </div>
                <div className="flex items-center gap-4">
                  <div className="text-right">
                    <p className="font-mono font-semibold">£{o.price.toLocaleString()}</p>
                    <p className="text-xs text-muted-foreground">{o.remaining}/{o.total} remaining</p>
                  </div>
                  <Button size="icon-sm" variant="ghost" onClick={() => handleCancel(o.id)}>
                    <Trash2Icon className="size-4 text-destructive" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </TabsContent>

        <TabsContent value="create" className="mt-4">
          <Card className="max-w-md">
            <CardHeader><CardTitle>New Order</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2"><Label>Port</Label>
                <Select value={newPort} onValueChange={setNewPort}><SelectTrigger><SelectValue placeholder="Select port…" /></SelectTrigger>
                  <SelectContent>{ports.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}</SelectContent></Select></div>
              <div className="space-y-2"><Label>Good</Label>
                <Select value={newGood} onValueChange={setNewGood}><SelectTrigger><SelectValue placeholder="Select good…" /></SelectTrigger>
                  <SelectContent>{goods.map((g) => <SelectItem key={g.id} value={g.id}>{g.name}</SelectItem>)}</SelectContent></Select></div>
              <div className="space-y-2"><Label>Type</Label>
                <Select value={newType} onValueChange={(v: string) => setNewType(v as "buy" | "sell")}><SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value="buy">Buy</SelectItem><SelectItem value="sell">Sell</SelectItem></SelectContent></Select></div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2"><Label>Quantity</Label><Input type="number" min="1" value={newQty} onChange={(e) => setNewQty(e.target.value)} /></div>
                <div className="space-y-2"><Label>Price / unit</Label><Input type="number" min="1" value={newPrice} onChange={(e) => setNewPrice(e.target.value)} /></div>
              </div>
              <Button onClick={handleCreate} disabled={submitting || !newPort || !newGood}>
                {submitting ? <Spinner className="size-4" /> : "Create Order"}
              </Button>
              {message && <p className="text-sm text-muted-foreground">{message}</p>}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
