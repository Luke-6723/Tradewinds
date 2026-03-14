"use client";

import { useEffect, useState } from "react";
import { passengersApi } from "@/lib/api/passengers";
import { worldApi } from "@/lib/api/world";
import { fleetApi } from "@/lib/api/fleet";
import type { Passenger, Port, Ship } from "@/lib/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { UsersIcon } from "lucide-react";

function Countdown({ to }: { to: string }) {
  const calc = () => {
    const diff = new Date(to).getTime() - Date.now();
    if (diff <= 0) return "Expired";
    const m = Math.floor(diff / 60000);
    const s = Math.floor((diff % 60000) / 1000);
    return `${m}m ${s}s`;
  };
  const [label, setLabel] = useState(calc);
  useEffect(() => {
    const id = setInterval(() => setLabel(calc()), 1000);
    return () => clearInterval(id);
  });
  return <span className="font-mono text-xs">{label}</span>;
}

export default function PassengersPage() {
  const [passengers, setPassengers] = useState<Passenger[]>([]);
  const [ports, setPorts] = useState<Port[]>([]);
  const [ships, setShips] = useState<Ship[]>([]);
  const [loading, setLoading] = useState(true);
  const [boarding, setBoarding] = useState<string | null>(null);
  const [shipSelections, setShipSelections] = useState<Record<string, string>>({});
  const [messages, setMessages] = useState<Record<string, string>>({});

  const portName = (id: string) => ports.find((p) => p.id === id)?.name ?? id.slice(0, 8);

  const reload = () =>
    passengersApi.getPassengers()
      .then(setPassengers)
      .catch(console.error);

  useEffect(() => {
    Promise.all([
      passengersApi.getPassengers().catch(() => [] as Passenger[]),
      worldApi.getPorts().catch(() => [] as Port[]),
      fleetApi.getShips().catch(() => [] as Ship[]),
    ])
      .then(([p, po, s]) => {
        setPassengers(p as Passenger[]);
        setPorts(po as Port[]);
        setShips(s as Ship[]);
      })
      .finally(() => setLoading(false));
  }, []);

  const handleBoard = async (passenger: Passenger) => {
    const shipId = shipSelections[passenger.id];
    if (!shipId) return;
    setBoarding(passenger.id);
    setMessages((prev) => ({ ...prev, [passenger.id]: "" }));
    try {
      await passengersApi.boardPassenger(passenger.id, { ship_id: shipId });
      setMessages((prev) => ({ ...prev, [passenger.id]: "✓ Boarded successfully!" }));
      await reload();
    } catch (e: unknown) {
      setMessages((prev) => ({ ...prev, [passenger.id]: `Error: ${(e as Error).message}` }));
    } finally {
      setBoarding(null);
    }
  };

  if (loading) return <div className="flex h-full items-center justify-center"><Spinner className="size-8" /></div>;

  const available = passengers.filter((p) => p.status === "available");
  const boarded = passengers.filter((p) => p.status === "boarded");

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2"><UsersIcon className="size-6" /> Passengers</h1>
        <p className="text-sm text-muted-foreground mt-1">Board passengers onto docked ships to earn revenue.</p>
      </div>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Available ({available.length})</h2>
        {available.length === 0 ? (
          <p className="text-sm text-muted-foreground">No passengers available right now.</p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {available.map((p) => {
              const dockedAtOrigin = ships.filter(
                (s) => s.status === "docked" && s.port_id === p.origin_port_id,
              );
              return (
                <Card key={p.id}>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm flex items-center justify-between">
                      <span>{portName(p.origin_port_id)} → {portName(p.destination_port_id)}</span>
                      <Badge variant="secondary">{p.count} pax</Badge>
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3 text-sm">
                    <div className="flex items-center justify-between text-muted-foreground">
                      <span>Bid</span>
                      <span className="font-mono font-semibold text-foreground">£{p.bid.toLocaleString()}</span>
                    </div>
                    <div className="flex items-center justify-between text-muted-foreground">
                      <span>Expires</span>
                      <Countdown to={p.expires_at} />
                    </div>
                    {dockedAtOrigin.length === 0 ? (
                      <p className="text-xs text-muted-foreground italic">No ships docked at {portName(p.origin_port_id)}.</p>
                    ) : (
                      <>
                        <Select
                          value={shipSelections[p.id] ?? ""}
                          onValueChange={(v: string) => setShipSelections((prev) => ({ ...prev, [p.id]: v }))}
                        >
                          <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Select ship…" /></SelectTrigger>
                          <SelectContent>
                            {dockedAtOrigin.map((s) => (
                              <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <Button
                          size="sm"
                          className="w-full"
                          disabled={!shipSelections[p.id] || boarding === p.id}
                          onClick={() => handleBoard(p)}
                        >
                          {boarding === p.id ? <Spinner className="size-3" /> : "Board"}
                        </Button>
                      </>
                    )}
                    {messages[p.id] && (
                      <p className={`text-xs ${messages[p.id].startsWith("✓") ? "text-green-600 dark:text-green-400" : "text-destructive"}`}>
                        {messages[p.id]}
                      </p>
                    )}
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Boarded ({boarded.length})</h2>
        {boarded.length === 0 ? (
          <p className="text-sm text-muted-foreground">No passengers currently boarded.</p>
        ) : (
          <div className="rounded-lg border overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="px-4 py-2 text-left font-medium">Route</th>
                  <th className="px-4 py-2 text-left font-medium">Count</th>
                  <th className="px-4 py-2 text-left font-medium">Bid</th>
                  <th className="px-4 py-2 text-left font-medium">Ship</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {boarded.map((p) => {
                  const ship = ships.find((s) => s.id === p.ship_id);
                  return (
                    <tr key={p.id} className="hover:bg-muted/30">
                      <td className="px-4 py-2">{portName(p.origin_port_id)} → {portName(p.destination_port_id)}</td>
                      <td className="px-4 py-2 font-mono">{p.count}</td>
                      <td className="px-4 py-2 font-mono">£{p.bid.toLocaleString()}</td>
                      <td className="px-4 py-2 text-muted-foreground">{ship?.name ?? p.ship_id?.slice(0, 8) ?? "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}