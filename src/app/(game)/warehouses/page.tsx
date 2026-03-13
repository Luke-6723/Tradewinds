"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { warehousesApi } from "@/lib/api/warehouses";
import { worldApi } from "@/lib/api/world";
import type { Good, Port, Warehouse, WarehouseInventory } from "@/lib/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { AnchorIcon, PlusIcon } from "lucide-react";

export default function WarehousesPage() {
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [ports, setPorts] = useState<Port[]>([]);
  const [goods, setGoods] = useState<Good[]>([]);
  const [inventory, setInventory] = useState<Record<string, WarehouseInventory[]>>({});
  const [loading, setLoading] = useState(true);
  const [showBuy, setShowBuy] = useState(false);
  const [buyPort, setBuyPort] = useState("");
  const [buying, setBuying] = useState(false);
  const [message, setMessage] = useState("");

  const loadInventory = async (ws: Warehouse[]) => {
    const entries = await Promise.all(
      ws.map(async (w) => {
        try { return [w.id, await warehousesApi.getInventory(w.id)] as const; }
        catch { return [w.id, [] as WarehouseInventory[]] as const; }
      }),
    );
    setInventory(Object.fromEntries(entries));
  };

  const reload = async () => {
    const ws = await warehousesApi.getWarehouses().catch(() => [] as Warehouse[]);
    setWarehouses(ws);
    await loadInventory(ws);
  };

  useEffect(() => {
    Promise.all([warehousesApi.getWarehouses(), worldApi.getPorts(), worldApi.getGoods()])
      .then(async ([w, p, g]) => {
        setWarehouses(w);
        setPorts(p);
        setGoods(g);
        await loadInventory(w);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleBuy = async () => {
    if (!buyPort) return;
    setBuying(true); setMessage("");
    try {
      await warehousesApi.buyWarehouse({ port_id: buyPort });
      setMessage("Warehouse purchased!");
      setShowBuy(false);
      setBuyPort("");
      await reload();
    } catch (e: unknown) {
      setMessage(`Error: ${(e as Error).message}`);
    } finally {
      setBuying(false);
    }
  };

  if (loading) return <div className="flex h-full items-center justify-center"><Spinner className="size-8" /></div>;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Warehouses</h1>
        <Button onClick={() => setShowBuy(!showBuy)}>
          <PlusIcon className="size-4 mr-2" /> Buy Warehouse
        </Button>
      </div>

      {showBuy && (
        <Card className="max-w-sm">
          <CardHeader><CardTitle>Purchase Warehouse</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label>Port</Label>
              <Select value={buyPort} onValueChange={setBuyPort}>
                <SelectTrigger><SelectValue placeholder="Select port…" /></SelectTrigger>
                <SelectContent>
                  {ports.map((p) => (
                    <SelectItem key={p.id} value={p.id}>{p.name} ({p.shortcode})</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button onClick={handleBuy} disabled={buying || !buyPort}>
              {buying ? <Spinner className="size-4" /> : "Purchase"}
            </Button>
            {message && <p className="text-sm text-muted-foreground">{message}</p>}
          </CardContent>
        </Card>
      )}

      {warehouses.length === 0 ? (
        <p className="text-muted-foreground">No warehouses yet.</p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {warehouses.map((w) => {
            const inv = inventory[w.id] ?? [];
            const usedCapacity = inv.reduce((sum, i) => sum + i.quantity, 0);
            const portName = ports.find((p) => p.id === w.port_id)?.name ?? w.port_id;
            return (
              <Link key={w.id} href={`/warehouses/${w.id}`}>
                <Card className="cursor-pointer transition-colors hover:bg-accent/40">
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <AnchorIcon className="size-4 text-muted-foreground" />
                      {portName}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-1 text-sm">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Level</span>
                      <span className="font-mono">{w.level}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Capacity</span>
                      <span className="font-mono">{w.capacity.toLocaleString()}</span>
                    </div>
                    {w.capacity > 0 && (
                      <div className="pt-1 space-y-1">
                        <div className="flex justify-between text-xs text-muted-foreground">
                          <span>Stock</span>
                          <span>{usedCapacity} / {w.capacity.toLocaleString()}</span>
                        </div>
                        <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                          <div
                            className="h-full rounded-full bg-primary transition-all"
                            style={{ width: `${Math.min(100, (usedCapacity / w.capacity) * 100)}%` }}
                          />
                        </div>
                        {inv.length > 0 && (
                          <p className="text-xs text-muted-foreground truncate">
                            {inv.slice(0, 3).map((i) => {
                              const name = goods.find((g) => g.id === i.good_id)?.name ?? i.good_id.slice(0, 6);
                              return `${i.quantity}× ${name}`;
                            }).join(", ")}
                            {inv.length > 3 && ` +${inv.length - 3} more`}
                          </p>
                        )}
                      </div>
                    )}
                  </CardContent>
                </Card>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
