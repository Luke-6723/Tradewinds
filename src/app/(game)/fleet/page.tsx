"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { fleetApi } from "@/lib/api/fleet";
import { shipyardsApi } from "@/lib/api/shipyards";
import { worldApi } from "@/lib/api/world";
import type { Port, Ship } from "@/lib/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { ShipIcon } from "lucide-react";

type SellState =
  | { phase: "idle" }
  | { phase: "confirming" }
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | { phase: "sold"; price: number };

export default function FleetPage() {
  const [ships, setShips] = useState<Ship[]>([]);
  const [ports, setPorts] = useState<Port[]>([]);
  const [loading, setLoading] = useState(true);
  const [sellState, setSellState] = useState<Record<string, SellState>>({});

  useEffect(() => {
    Promise.all([fleetApi.getShips(), worldApi.getPorts().catch(() => [])])
      .then(([s, p]) => { setShips(s); setPorts(p as Port[]); })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  const portName = (id: string | null) =>
    id ? (ports.find((p) => p.id === id)?.name ?? id) : "At sea";

  const initiateSell = (ship: Ship) => {
    setSellState((s) => ({ ...s, [ship.id]: { phase: "confirming" } }));
  };

  const confirmSell = async (ship: Ship) => {
    if (!ship.port_id) return;
    setSellState((s) => ({ ...s, [ship.id]: { phase: "loading" } }));
    try {
      const shipyard = await shipyardsApi.getPortShipyard(ship.port_id);
      const result = await shipyardsApi.sellShip(shipyard.id, ship.id);
      setSellState((s) => ({ ...s, [ship.id]: { phase: "sold", price: result.price } }));
      setShips((prev) => prev.filter((s) => s.id !== ship.id));
    } catch (e: unknown) {
      const msg = (e as Error).message ?? "Sale failed";
      const friendly = msg.toLowerCase().includes("shipyard not found")
        ? "No shipyard at this port."
        : msg;
      setSellState((s) => ({ ...s, [ship.id]: { phase: "error", message: friendly } }));
    }
  };

  if (loading) return <div className="flex justify-center items-center h-full"><Spinner className="size-8" /></div>;

  return (
    <div className="space-y-6">
      <h1 className="font-bold text-2xl">Fleet</h1>
      {ships.length === 0 ? (
        <p className="text-muted-foreground">No ships. Buy one from a port shipyard.</p>
      ) : (
        <div className="gap-4 grid sm:grid-cols-2 lg:grid-cols-3">
          {ships.map((ship) => {
            const ss = sellState[ship.id] ?? { phase: "idle" };
            const isDocked = ship.status === "docked" && !!ship.port_id;
            return (
              <Card key={ship.id} className="flex flex-col">
                <Link href={`/fleet/${ship.id}`} className="flex-1 hover:bg-accent/40 transition-colors rounded-t-lg">
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <ShipIcon className="size-4 text-muted-foreground" />
                      {ship.name}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-1 text-sm">
                    <div className="flex items-center gap-2">
                      <Badge variant={ship.status === "docked" ? "success" : "info"}>
                        {ship.status}
                      </Badge>
                    </div>
                    <p className="text-muted-foreground">
                      {portName(ship.port_id)}
                      {ship.status === "traveling" && ship.arriving_at && (
                        <> · arriving {new Date(ship.arriving_at).toLocaleTimeString()}</>
                      )}
                    </p>
                  </CardContent>
                </Link>

                {ship.status === "docked" && (
                  <div className="px-6 pb-4 pt-0">
                    {ss.phase === "idle" && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="w-full text-muted-foreground"
                        onClick={() => initiateSell(ship)}
                      >
                        Sell Ship
                      </Button>
                    )}
                    {ss.phase === "loading" && (
                      <Button size="sm" variant="outline" className="w-full" disabled>
                        <Spinner className="size-3 mr-1" /> Loading…
                      </Button>
                    )}
                    {ss.phase === "confirming" && (
                      <div className="space-y-2">
                        <p className="text-xs text-muted-foreground text-center">
                          Sell <span className="font-semibold text-foreground">{ship.name}</span>? This cannot be undone.
                        </p>
                        <div className="flex gap-2">
                          <Button size="sm" variant="destructive" className="flex-1" onClick={() => confirmSell(ship)}>
                            Confirm
                          </Button>
                          <Button size="sm" variant="outline" className="flex-1" onClick={() => setSellState((s) => ({ ...s, [ship.id]: { phase: "idle" } }))}>
                            Cancel
                          </Button>
                        </div>
                      </div>
                    )}
                    {ss.phase === "error" && (
                      <div className="space-y-2">
                        <p className="text-xs text-destructive text-center">{ss.message}</p>
                        <Button size="sm" variant="outline" className="w-full" onClick={() => setSellState((s) => ({ ...s, [ship.id]: { phase: "idle" } }))}>
                          Dismiss
                        </Button>
                      </div>
                    )}
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
