"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { fleetApi } from "@/lib/api/fleet";
import { worldApi } from "@/lib/api/world";
import type { Port, Ship } from "@/lib/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { ShipIcon } from "lucide-react";

export default function FleetPage() {
  const [ships, setShips] = useState<Ship[]>([]);
  const [ports, setPorts] = useState<Port[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([fleetApi.getShips(), worldApi.getPorts().catch(() => [])])
      .then(([s, p]) => { setShips(s); setPorts(p as Port[]); })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  const portName = (id: string | null) =>
    id ? (ports.find((p) => p.id === id)?.name ?? id) : "At sea";

  if (loading) return <div className="flex justify-center items-center h-full"><Spinner className="size-8" /></div>;

  return (
    <div className="space-y-6">
      <h1 className="font-bold text-2xl">Fleet</h1>
      {ships.length === 0 ? (
        <p className="text-muted-foreground">No ships. Buy one from a port shipyard.</p>
      ) : (
        <div className="gap-4 grid sm:grid-cols-2 lg:grid-cols-3">
          {ships.map((ship) => (
            <Link key={ship.id} href={`/fleet/${ship.id}`}>
              <Card className="hover:bg-accent/40 transition-colors cursor-pointer">
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
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
