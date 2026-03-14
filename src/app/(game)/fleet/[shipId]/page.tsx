"use client";

import { use, useEffect, useState } from "react";
import { fleetApi } from "@/lib/api/fleet";
import { worldApi } from "@/lib/api/world";
import { warehousesApi } from "@/lib/api/warehouses";
import { shipyardsApi } from "@/lib/api/shipyards";
import type { Cargo, Good, Port, Route, Ship, Warehouse } from "@/lib/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

export default function ShipDetailPage({ params }: { params: Promise<{ shipId: string }> }) {
  const { shipId } = use(params);
  const [ship, setShip] = useState<Ship | null>(null);
  const [ports, setPorts] = useState<Port[]>([]);
  const [routes, setRoutes] = useState<Route[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [cargo, setCargo] = useState<Cargo[]>([]);
  const [goods, setGoods] = useState<Good[]>([]);
  const [loading, setLoading] = useState(true);

  const [newName, setNewName] = useState("");
  const [selectedRoute, setSelectedRoute] = useState("");
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Sell state
  const [sellPrice, setSellPrice] = useState<number | null>(null);
  const [selling, setSelling] = useState(false);
  const [sellConfirm, setSellConfirm] = useState(false);

  const portName = (id: string | null) =>
    id ? (ports.find((p) => p.id === id)?.name ?? id) : "At sea";

  const reload = () => {
    fleetApi.getShip(shipId)
      .then((s) => {
        setShip(s);
        setNewName(s.name);
        if (s.port_id) {
          worldApi.getRoutes(s.port_id).then(setRoutes).catch(() => setRoutes([]));
        }
      })
      .catch(console.error);
  };

  useEffect(() => {
    Promise.all([
      fleetApi.getShip(shipId),
      worldApi.getPorts().catch(() => []),
      warehousesApi.getWarehouses().catch(() => []),
      fleetApi.getInventory(shipId).catch(() => []),
      worldApi.getGoods().catch(() => []),
    ])
      .then(([s, p, w, c, g]) => {
        setShip(s);
        setNewName(s.name);
        setPorts(p as Port[]);
        setWarehouses(w as Warehouse[]);
        setCargo(c as Cargo[]);
        setGoods(g as Good[]);
        if (s.port_id) {
          return worldApi.getRoutes(s.port_id).catch(() => []);
        }
        return [];
      })
      .then((r) => setRoutes(r as Route[]))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [shipId]);

  const handle = async (fn: () => Promise<unknown>, msg: string) => {
    setSubmitting(true); setMessage("");
    try { await fn(); reload(); setMessage(msg); }
    catch (e: unknown) { setMessage(`Error: ${(e as Error).message}`); }
    finally { setSubmitting(false); }
  };

  const handleSell = async () => {
    if (!ship?.port_id) return;
    setSelling(true);
    setMessage("");
    try {
      const shipyard = await shipyardsApi.getPortShipyard(ship.port_id);
      const result = await shipyardsApi.sellShip(shipyard.id, ship.id);
      setSellPrice(result.price);
      setSellConfirm(false);
    } catch (e: unknown) {
      setMessage(`Error: ${(e as Error).message}`);
    } finally {
      setSelling(false);
    }
  };

  if (loading) return <div className="flex h-full items-center justify-center"><Spinner className="size-8" /></div>;
  if (!ship) return <p className="text-muted-foreground">Ship not found.</p>;

  const isSold = sellPrice !== null;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">{ship.name}</h1>
        <div className="mt-1 flex items-center gap-2">
          <Badge variant="secondary">{ship.ship_type_id.slice(0, 8)}…</Badge>
          <Badge variant={ship.status === "docked" ? "success" : "info"}>{ship.status}</Badge>
        </div>
      </div>

      {isSold ? (
        <div className="rounded-lg border border-green-500/40 bg-green-500/8 p-4 text-sm text-green-700 dark:text-green-400">
          ✓ Ship sold for <span className="font-mono font-semibold">£{sellPrice!.toLocaleString()}</span>. It has been removed from your fleet.
        </div>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-3 text-sm">
            <div className="rounded-lg border p-3">
              <p className="text-muted-foreground">Location</p>
              <p className="font-medium">{portName(ship.port_id)}</p>
            </div>
            {ship.status === "traveling" && ship.arriving_at && (
              <div className="rounded-lg border p-3">
                <p className="text-muted-foreground">Arriving</p>
                <p className="font-medium">{new Date(ship.arriving_at).toLocaleTimeString()}</p>
              </div>
            )}
          </div>

          {message && <div className="rounded-lg border p-3 text-sm text-muted-foreground">{message}</div>}

          <Tabs defaultValue="cargo">
            <TabsList>
              <TabsTrigger value="cargo">Cargo</TabsTrigger>
              <TabsTrigger value="transit">Transit</TabsTrigger>
              <TabsTrigger value="rename">Rename</TabsTrigger>
              {ship.status === "docked" && ship.port_id && (
                <TabsTrigger value="sell">Sell Ship</TabsTrigger>
              )}
            </TabsList>

            <TabsContent value="cargo" className="mt-4">
              <Card className="max-w-sm">
                <CardHeader><CardTitle>Cargo Hold</CardTitle></CardHeader>
                <CardContent>
                  {cargo.length === 0 ? (
                    <p className="text-sm text-muted-foreground">Empty hold.</p>
                  ) : (
                    <div className="divide-y">
                      {cargo.map((c) => {
                        const good = goods.find((g) => g.id === c.good_id);
                        return (
                          <div key={c.good_id} className="flex items-center justify-between py-2 text-sm">
                            <span>{good?.name ?? c.good_id.slice(0, 8)}</span>
                            <span className="font-mono text-muted-foreground">{c.quantity.toLocaleString()} units</span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="transit" className="mt-4">
              <Card className="max-w-sm">
                <CardHeader><CardTitle>Set Route</CardTitle></CardHeader>
                <CardContent className="space-y-4">
                  {ship.status !== "docked" ? (
                    <p className="text-sm text-muted-foreground">
                      Ship is traveling · arriving {ship.arriving_at ? new Date(ship.arriving_at).toLocaleString() : "soon"}.
                    </p>
                  ) : routes.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No routes available from this port.</p>
                  ) : (
                    <>
                      <div className="space-y-2">
                        <Label>Destination</Label>
                        <Select value={selectedRoute} onValueChange={setSelectedRoute}>
                          <SelectTrigger><SelectValue placeholder="Select route…" /></SelectTrigger>
                          <SelectContent>
                            {routes.map((r) => (
                              <SelectItem key={r.id} value={r.id}>
                                {portName(r.to_id)} · {r.distance} km
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <Button
                        onClick={() => handle(() => fleetApi.transit(shipId, { route_id: selectedRoute }), "Transit started!")}
                        disabled={submitting || !selectedRoute}
                      >
                        {submitting ? <Spinner className="size-4" /> : "Begin Transit"}
                      </Button>
                    </>
                  )}
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="rename" className="mt-4">
              <Card className="max-w-sm">
                <CardHeader><CardTitle>Rename Ship</CardTitle></CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-2"><Label>New Name</Label><Input value={newName} onChange={(e) => setNewName(e.target.value)} /></div>
                  <Button onClick={() => handle(() => fleetApi.renameShip(shipId, { name: newName }), "Ship renamed!")} disabled={submitting || !newName}>
                    {submitting ? <Spinner className="size-4" /> : "Rename"}
                  </Button>
                </CardContent>
              </Card>
            </TabsContent>

            {ship.status === "docked" && ship.port_id && (
              <TabsContent value="sell" className="mt-4">
                <Card className="max-w-sm">
                  <CardHeader><CardTitle>Sell Ship</CardTitle></CardHeader>
                  <CardContent className="space-y-4">
                    <p className="text-sm text-muted-foreground">
                      Sell <span className="font-semibold text-foreground">{ship.name}</span> back to the shipyard at a variable loss. This cannot be undone.
                    </p>
                    {!sellConfirm ? (
                      <Button variant="destructive" onClick={() => setSellConfirm(true)}>
                        Sell Ship
                      </Button>
                    ) : (
                      <div className="space-y-3">
                        <p className="text-sm font-medium text-destructive">Are you sure? This will permanently remove the ship.</p>
                        <div className="flex gap-2">
                          <Button variant="destructive" onClick={handleSell} disabled={selling}>
                            {selling ? <Spinner className="size-4" /> : "Confirm Sale"}
                          </Button>
                          <Button variant="outline" onClick={() => setSellConfirm(false)} disabled={selling}>
                            Cancel
                          </Button>
                        </div>
                      </div>
                    )}
                  </CardContent>
                </Card>
              </TabsContent>
            )}
          </Tabs>
        </>
      )}
    </div>
  );
}