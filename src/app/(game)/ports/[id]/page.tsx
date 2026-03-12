"use client";

import { useEffect, useState } from "react";
import { use } from "react";
import { worldApi } from "@/lib/api/world";
import { tradeApi } from "@/lib/api/trade";
import { marketApi } from "@/lib/api/market";
import { shipyardsApi } from "@/lib/api/shipyards";
import type { MarketOrder, Port, Shipyard, ShipyardInventoryItem, TraderPosition } from "@/lib/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

export default function PortDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [port, setPort] = useState<Port | null>(null);
  const [traders, setTraders] = useState<TraderPosition[]>([]);
  const [orders, setOrders] = useState<MarketOrder[]>([]);
  const [shipyard, setShipyard] = useState<Shipyard | null>(null);
  const [inventory, setInventory] = useState<ShipyardInventoryItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Load port first — failures here mean the port truly doesn't exist
    worldApi.getPort(id)
      .then((p) => {
        setPort(p);
        // Load optional data in parallel; don't let failures hide the port
        Promise.all([
          tradeApi.getTraderPositions(id).catch(() => []),
          marketApi.getOrders(id).catch(() => []),
        ]).then(([t, o]) => {
          setTraders(t as TraderPosition[]);
          setOrders(o as MarketOrder[]);
          return shipyardsApi.getPortShipyard(id).catch(() => null);
        }).then((sy) => {
          if (sy) {
            setShipyard(sy);
            return shipyardsApi.getInventory(sy.id).catch(() => []);
          }
          return [];
        }).then(setInventory)
          .catch(console.error);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [id]);

  if (loading) return <div className="flex h-full items-center justify-center"><Spinner className="size-8" /></div>;
  if (!port) return <p className="text-muted-foreground">Port not found.</p>;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">{port.name}</h1>
        <div className="flex items-center gap-2 mt-1">
          <Badge variant="secondary">{port.shortcode}</Badge>
          {port.is_hub && <Badge variant="outline">Hub</Badge>}
        </div>
      </div>

      <Tabs defaultValue="traders">
        <TabsList>
          <TabsTrigger value="traders">Traders ({traders.length})</TabsTrigger>
          <TabsTrigger value="market">Orders ({orders.length})</TabsTrigger>
          {shipyard && <TabsTrigger value="shipyard">Shipyard</TabsTrigger>}
        </TabsList>

        <TabsContent value="traders" className="mt-4">
          <div className="divide-y rounded-lg border">
            {traders.length === 0 ? (
              <p className="p-4 text-muted-foreground text-sm">No traders at this port.</p>
            ) : traders.map((t) => (
              <div key={t.id} className="flex items-center justify-between px-4 py-3 text-sm">
                <span className="font-medium font-mono text-xs text-muted-foreground">{t.good_id}</span>
                <span className="text-muted-foreground">{t.stock_bounds}</span>
              </div>
            ))}
          </div>
        </TabsContent>

        <TabsContent value="market" className="mt-4">
          <div className="divide-y rounded-lg border">
            {orders.length === 0 ? (
              <p className="p-4 text-muted-foreground text-sm">No orders at this port.</p>
            ) : orders.map((o) => (
              <div key={o.id} className="flex items-center justify-between px-4 py-3 text-sm">
                <span className="font-medium font-mono text-xs text-muted-foreground">{o.good_id}</span>
                <div className="flex items-center gap-3">
                  <Badge variant={o.side === "sell" ? "info" : "success"}>
                    {o.side === "sell" ? "Sell" : "Buy"}
                  </Badge>
                  <span className="font-mono">£{o.price.toLocaleString()}</span>
                  <span className="text-muted-foreground">{o.remaining}/{o.total}</span>
                </div>
              </div>
            ))}
          </div>
        </TabsContent>

        {shipyard && (
          <TabsContent value="shipyard" className="mt-4">
            <div className="divide-y rounded-lg border">
              {inventory.map((item) => (
                <div key={item.id} className="flex items-center justify-between px-4 py-3 text-sm">
                  <span className="font-medium font-mono text-xs text-muted-foreground">{item.ship_type_id}</span>
                  <span className="font-mono font-semibold">£{item.cost.toLocaleString()}</span>
                </div>
              ))}
            </div>
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}
