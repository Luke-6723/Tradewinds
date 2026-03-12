"use client";

import { use, useEffect, useState } from "react";
import { warehousesApi } from "@/lib/api/warehouses";
import { fleetApi } from "@/lib/api/fleet";
import { worldApi } from "@/lib/api/world";
import type { Port, Ship, Warehouse } from "@/lib/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";

export default function WarehouseDetailPage({ params }: { params: Promise<{ warehouseId: string }> }) {
  const { warehouseId } = use(params);
  const [warehouse, setWarehouse] = useState<Warehouse | null>(null);
  const [ships, setShips] = useState<Ship[]>([]);
  const [ports, setPorts] = useState<Port[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const reload = () => {
    warehousesApi.getWarehouse(warehouseId)
      .then(setWarehouse)
      .catch(console.error);
  };

  useEffect(() => {
    Promise.all([
      warehousesApi.getWarehouse(warehouseId),
      fleetApi.getShips().catch(() => []),
      worldApi.getPorts().catch(() => []),
    ])
      .then(([w, sh, p]) => { setWarehouse(w); setShips(sh as Ship[]); setPorts(p as Port[]); })
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
      </div>

      {message && <div className="rounded-lg border p-3 text-sm text-muted-foreground">{message}</div>}

      <Tabs defaultValue="resize">
        <TabsList>
          <TabsTrigger value="resize">Resize</TabsTrigger>
          <TabsTrigger value="ships">Docked Ships</TabsTrigger>
        </TabsList>

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

