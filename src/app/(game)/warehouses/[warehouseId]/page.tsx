"use client";

import { use, useEffect, useState } from "react";
import { warehousesApi } from "@/lib/api/warehouses";
import { fleetApi } from "@/lib/api/fleet";
import { worldApi } from "@/lib/api/world";
import type { Good, Port, Ship, Warehouse, WarehouseInventory } from "@/lib/types";
import type { StoredWarehouseStock } from "@/lib/db/collections";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { PackageIcon } from "lucide-react";

export default function WarehouseDetailPage({ params }: { params: Promise<{ warehouseId: string }> }) {
  const { warehouseId } = use(params);
  const [warehouse, setWarehouse] = useState<Warehouse | null>(null);
  const [ships, setShips] = useState<Ship[]>([]);
  const [ports, setPorts] = useState<Port[]>([]);
  const [goods, setGoods] = useState<Good[]>([]);
  const [inventory, setInventory] = useState<WarehouseInventory[]>([]);
  const [autopilotStocks, setAutopilotStocks] = useState<StoredWarehouseStock[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const reload = () => {
    Promise.all([
      warehousesApi.getWarehouse(warehouseId),
      warehousesApi.getInventory(warehouseId),
    ])
      .then(([w, inv]) => { setWarehouse(w); setInventory(inv); })
      .catch(console.error);
  };

  useEffect(() => {
    Promise.all([
      warehousesApi.getWarehouse(warehouseId),
      warehousesApi.getInventory(warehouseId).catch(() => [] as WarehouseInventory[]),
      fleetApi.getShips().catch(() => []),
      worldApi.getPorts().catch(() => []),
      worldApi.getGoods().catch(() => []),
      fetch("/api/warehouses/stocks").then((r) => r.json()).catch(() => []),
    ])
      .then(([w, inv, sh, p, g, stocks]) => {
        setWarehouse(w as Warehouse);
        setInventory(inv as WarehouseInventory[]);
        setShips(sh as Ship[]);
        setPorts(p as Port[]);
        setGoods(g as Good[]);
        setAutopilotStocks((stocks as StoredWarehouseStock[]).filter((s) => s.warehouseId === warehouseId));
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [warehouseId]);

  const handle = async (fn: () => Promise<unknown>, msg: string) => {
    setSubmitting(true); setMessage("");
    try { await fn(); reload(); setMessage(msg); }
    catch (e: unknown) { setMessage(`Error: ${(e as Error).message}`); }
    finally { setSubmitting(false); }
  };

  if (loading) return <div className="flex h-full items-center justify-center"><Spinner className="size-8" /></div>;
  if (!warehouse) return <p className="text-muted-foreground">Warehouse not found.</p>;

  const portName = ports.find((p) => p.id === warehouse.port_id)?.name ?? warehouse.port_id;
  const goodName = (id: string) => goods.find((g) => g.id === id)?.name ?? id.slice(0, 8);
  const usedCapacity = inventory.reduce((sum, i) => sum + i.quantity, 0);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">{portName}</h1>
        <p className="text-muted-foreground">Warehouse</p>
      </div>

      <div className="grid gap-3 sm:grid-cols-3 text-sm">
        <div className="rounded-lg border p-3">
          <p className="text-muted-foreground">Level</p>
          <p className="font-medium font-mono">{warehouse.level}</p>
        </div>
        <div className="rounded-lg border p-3">
          <p className="text-muted-foreground">Capacity</p>
          <p className="font-medium font-mono">{warehouse.capacity.toLocaleString()}</p>
        </div>
        <div className="rounded-lg border p-3">
          <p className="text-muted-foreground">Stock</p>
          <p className="font-medium font-mono">{usedCapacity.toLocaleString()} / {warehouse.capacity.toLocaleString()}</p>
        </div>
      </div>

      {message && <div className="rounded-lg border p-3 text-sm text-muted-foreground">{message}</div>}

      <Tabs defaultValue="stock">
        <TabsList>
          <TabsTrigger value="stock">
            Stock {inventory.length > 0 && <Badge variant="secondary" className="ml-1">{inventory.length}</Badge>}
          </TabsTrigger>
          <TabsTrigger value="resize">Resize</TabsTrigger>
          <TabsTrigger value="ships">Docked Ships</TabsTrigger>
        </TabsList>

        <TabsContent value="stock" className="mt-4">
          {inventory.length === 0 ? (
            <p className="text-sm text-muted-foreground">No goods currently stored in this warehouse.</p>
          ) : (
            <div className="divide-y rounded-lg border">
              {inventory.map((item) => {
                const avgBuy = autopilotStocks.find((s) => s.goodId === item.good_id)?.avgBuyPrice;
                return (
                  <div key={item.id} className="flex items-center justify-between px-4 py-3 text-sm">
                    <div className="flex items-center gap-2">
                      <PackageIcon className="size-4 text-muted-foreground" />
                      <span className="font-medium">{goodName(item.good_id)}</span>
                    </div>
                    <div className="flex items-center gap-3 text-right">
                      <span className="font-mono">{item.quantity.toLocaleString()} units</span>
                      {avgBuy != null && (
                        <span className="text-xs text-muted-foreground">avg £{avgBuy.toLocaleString()}</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </TabsContent>

        <TabsContent value="resize" className="mt-4">
          <div className="flex gap-3">
            <Button disabled={submitting} onClick={() => handle(() => warehousesApi.growWarehouse(warehouseId), "Expanded!")}>
              Expand (next tier)
            </Button>
            <Button variant="outline" disabled={submitting} onClick={() => handle(() => warehousesApi.shrinkWarehouse(warehouseId), "Shrunk!")}>
              Shrink (previous tier)
            </Button>
          </div>
        </TabsContent>

        <TabsContent value="ships" className="mt-4">
          <div className="divide-y rounded-lg border">
            {ships.filter((s) => s.port_id === warehouse.port_id && s.status === "docked").length === 0
              ? <p className="p-4 text-sm text-muted-foreground">No ships docked at this port.</p>
              : ships
                  .filter((s) => s.port_id === warehouse.port_id && s.status === "docked")
                  .map((s) => (
                    <div key={s.id} className="flex items-center justify-between px-4 py-3 text-sm">
                      <span className="font-medium">{s.name}</span>
                      <Badge variant="secondary">Docked</Badge>
                    </div>
                  ))
            }
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
