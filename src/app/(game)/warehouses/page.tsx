"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { warehousesApi } from "@/lib/api/warehouses";
import { worldApi } from "@/lib/api/world";
import type { Port, Warehouse } from "@/lib/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { AnchorIcon, PlusIcon } from "lucide-react";

export default function WarehousesPage() {
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [ports, setPorts] = useState<Port[]>([]);
  const [loading, setLoading] = useState(true);
  const [showBuy, setShowBuy] = useState(false);
  const [buyPort, setBuyPort] = useState("");
  const [buying, setBuying] = useState(false);
  const [message, setMessage] = useState("");

  const reload = () =>
    warehousesApi.getWarehouses().then(setWarehouses).catch(console.error);

  useEffect(() => {
    Promise.all([warehousesApi.getWarehouses(), worldApi.getPorts()])
      .then(([w, p]) => { setWarehouses(w); setPorts(p); })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  const handleBuy = async () => {
    if (!buyPort) return;
    setBuying(true); setMessage("");
    try {
      await warehousesApi.buyWarehouse({ port_id: buyPort });
      setMessage("Warehouse purchased!");
      setShowBuy(false);
      setBuyPort("");
      reload();
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
          {warehouses.map((w) => (
            <Link key={w.id} href={`/warehouses/${w.id}`}>
              <Card className="cursor-pointer transition-colors hover:bg-accent/40">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <AnchorIcon className="size-4 text-muted-foreground" />
                    {ports.find((p) => p.id === w.port_id)?.name ?? w.port_id}
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
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
