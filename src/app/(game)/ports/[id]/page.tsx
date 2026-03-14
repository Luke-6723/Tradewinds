"use client";

import { useEffect, useState } from "react";
import { use } from "react";
import { worldApi } from "@/lib/api/world";
import { tradeApi } from "@/lib/api/trade";
import { marketApi } from "@/lib/api/market";
import { shipyardsApi } from "@/lib/api/shipyards";
import type { Good, MarketOrder, Port, Shipyard, ShipyardInventoryItem, ShipType, TraderPosition } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

export default function PortDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [port, setPort] = useState<Port | null>(null);
  const [traders, setTraders] = useState<TraderPosition[]>([]);
  const [goods, setGoods] = useState<Good[]>([]);
  const [orders, setOrders] = useState<MarketOrder[]>([]);
  const [shipyard, setShipyard] = useState<Shipyard | null>(null);
  const [inventory, setInventory] = useState<ShipyardInventoryItem[]>([]);
  const [shipTypes, setShipTypes] = useState<Map<string, ShipType>>(new Map());
  const [loading, setLoading] = useState(true);

  const [purchasingItemId, setPurchasingItemId] = useState<string | null>(null);
  const [purchasing, setPurchasing] = useState(false);
  const [purchaseError, setPurchaseError] = useState<string | null>(null);
  const [purchasedShipName, setPurchasedShipName] = useState<string | null>(null);

  useEffect(() => {
    worldApi.getPort(id)
      .then((p) => {
        setPort(p);
        Promise.all([
          tradeApi.getTraderPositions().catch(() => [] as TraderPosition[]),
          worldApi.getGoods().catch(() => [] as Good[]),
          marketApi.getOrders([id]).catch(() => [] as MarketOrder[]),
          worldApi.getShipTypes().catch(() => [] as ShipType[]),
        ]).then(([allPositions, g, o, st]) => {
          setTraders((allPositions as TraderPosition[]).filter((tp) => tp.port_id === id));
          setGoods(g as Good[]);
          setOrders(o as MarketOrder[]);
          setShipTypes(new Map((st as ShipType[]).map((s) => [s.id, s])));
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

  async function confirmPurchase(item: ShipyardInventoryItem) {
    if (!shipyard) return;
    setPurchasing(true);
    setPurchaseError(null);
    try {
      const ship = await shipyardsApi.purchaseShip(shipyard.id, { ship_type_id: item.ship_type_id });
      setInventory((prev) => prev.filter((i) => i.id !== item.id));
      setPurchasingItemId(null);
      setPurchasedShipName(ship.name);
    } catch (err: unknown) {
      setPurchaseError(err instanceof Error ? err.message : "Purchase failed.");
    } finally {
      setPurchasing(false);
    }
  }

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
            ) : traders.map((t) => {
              const good = goods.find((g) => g.id === t.good_id);
              return (
                <div key={t.id} className="flex items-center justify-between px-4 py-3 text-sm">
                  <span className="font-medium">{good?.name ?? t.good_id.slice(0, 8)}</span>
                  <div className="flex items-center gap-3">
                    <span className="text-xs text-muted-foreground">{t.stock_bounds}</span>
                    <Badge variant="outline" className="text-xs">{t.price_bounds}</Badge>
                  </div>
                </div>
              );
            })}
          </div>
        </TabsContent>

        <TabsContent value="market" className="mt-4">
          <div className="divide-y rounded-lg border">
            {orders.length === 0 ? (
              <p className="p-4 text-muted-foreground text-sm">No orders at this port.</p>
            ) : orders.map((o) => (
              <div key={o.id} className="flex items-center justify-between px-4 py-3 text-sm">
                <span className="font-medium">{goods.find((g) => g.id === o.good_id)?.name ?? o.good_id.slice(0, 8)}</span>
                <div className="flex items-center gap-3">
                  <Badge variant={o.side === "sell" ? "info" : "success"}>{o.side === "sell" ? "Sell" : "Buy"}</Badge>
                  <span className="font-mono">£{o.price.toLocaleString()}</span>
                  <span className="text-muted-foreground">{o.remaining}/{o.total}</span>
                </div>
              </div>
            ))}
          </div>
        </TabsContent>

        {shipyard && (
          <TabsContent value="shipyard" className="mt-4">
            <div className="space-y-2">
              {purchasedShipName && (
                <p className="text-sm text-green-600 font-medium px-1">
                  ✓ <span className="font-semibold">{purchasedShipName}</span> purchased and added to your fleet.
                </p>
              )}
              {inventory.length === 0 ? (
                <div className="rounded-lg border">
                  <p className="p-4 text-muted-foreground text-sm">No ships available for purchase.</p>
                </div>
              ) : (
                <div className="divide-y rounded-lg border">
                  {inventory.map((item) => {
                    const shipType = shipTypes.get(item.ship_type_id);
                    const isExpanded = purchasingItemId === item.id;
                    return (
                      <div key={item.id} className="px-4 py-3 text-sm">
                        <div className="flex items-center justify-between">
                          <div className="space-y-0.5">
                            <p className="font-semibold">{shipType?.name ?? item.ship_type_id.slice(0, 8)}</p>
                            {shipType && (
                              <p className="text-xs text-muted-foreground">
                                Capacity {shipType.capacity}
                                {shipType.passengers > 0 && ` · ${shipType.passengers} passengers`}
                                {" · "}Speed {shipType.speed} · Upkeep £{shipType.upkeep.toLocaleString()}/wk
                              </p>
                            )}
                          </div>
                          <div className="flex items-center gap-3">
                            <span className="font-mono font-semibold">£{item.cost.toLocaleString()}</span>
                            {!isExpanded && (
                              <Button size="sm" onClick={() => { setPurchasingItemId(item.id); setPurchaseError(null); setPurchasedShipName(null); }}>
                                Purchase
                              </Button>
                            )}
                          </div>
                        </div>
                        {isExpanded && (
                          <div className="mt-3 space-y-3 rounded-md border bg-muted/40 p-3">
                            <p className="text-xs text-muted-foreground">
                              Confirm purchase of <span className="font-medium">{shipType?.name ?? "this ship"}</span> for £{item.cost.toLocaleString()}. The ship will be named by the shipyard.
                            </p>
                            {purchaseError && <p className="text-xs text-destructive">{purchaseError}</p>}
                            <div className="flex gap-2">
                              <Button size="sm" onClick={() => confirmPurchase(item)} disabled={purchasing}>
                                {purchasing ? <Spinner className="size-3" /> : "Confirm Purchase"}
                              </Button>
                              <Button size="sm" variant="outline" onClick={() => setPurchasingItemId(null)} disabled={purchasing}>
                                Cancel
                              </Button>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}