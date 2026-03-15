"use client";

import { useEffect, useState, useCallback } from "react";
import { shipyardsApi } from "@/lib/api/shipyards";
import { worldApi } from "@/lib/api/world";
import type { Port, Shipyard, ShipyardInventoryItem, ShipType } from "@/lib/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { ShipIcon, ShoppingCartIcon } from "lucide-react";
interface InventoryRow {
  item: ShipyardInventoryItem;
  shipyardId: string;
  portName: string;
  error?: string;
}

function fmt(n: number) {
  return `£${n.toLocaleString()}`;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export default function ShipyardsPage() {
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState<InventoryRow[]>([]);
  const [shipTypes, setShipTypes] = useState<Map<string, ShipType>>(new Map());
  const [buyingAll, setBuyingAll] = useState(false);
  const [buyingAllProgress, setBuyingAllProgress] = useState<{ done: number; total: number } | null>(null);
  const [buyingId, setBuyingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [allPorts, allShipTypes] = await Promise.all([
        worldApi.getPorts(),
        worldApi.getShipTypes(),
      ]);

      const typesMap = new Map<string, ShipType>(allShipTypes.map((t) => [t.id, t]));
      setShipTypes(typesMap);

      const hubPorts: Port[] = allPorts.filter((p) => p.is_hub);

      // Fetch shipyard + inventory for each hub in parallel
      const results = await Promise.allSettled(
        hubPorts.map(async (port) => {
          const shipyard: Shipyard = await shipyardsApi.getPortShipyard(port.id);
          const inventory: ShipyardInventoryItem[] = await shipyardsApi.getInventory(shipyard.id);
          return { port, shipyard, inventory };
        }),
      );

      const newRows: InventoryRow[] = [];
      for (const result of results) {
        if (result.status === "fulfilled") {
          const { port, shipyard, inventory } = result.value;
          for (const item of inventory) {
            newRows.push({ item, shipyardId: shipyard.id, portName: port.name });
          }
        }
      }

      setRows(newRows);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const buyOne = useCallback(async (row: InventoryRow): Promise<boolean> => {
    try {
      await shipyardsApi.purchaseShip(row.shipyardId, { ship_type_id: row.item.ship_type_id });
      setRows((prev) => prev.filter((r) => r.item.id !== row.item.id));
      return true;
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Purchase failed";
      setRows((prev) =>
        prev.map((r) =>
          r.item.id === row.item.id ? { ...r, error: message } : r,
        ),
      );
      return false;
    }
  }, []);

  const handleBuyOne = useCallback(
    async (row: InventoryRow) => {
      setBuyingId(row.item.id);
      await buyOne(row);
      setBuyingId(null);
    },
    [buyOne],
  );

  const handleBuyAll = useCallback(async () => {
    const snapshot = rows.filter((r) => !r.error);
    if (snapshot.length === 0) return;

    setBuyingAll(true);
    setBuyingAllProgress({ done: 0, total: snapshot.length });

    for (let i = 0; i < snapshot.length; i++) {
      setBuyingAllProgress({ done: i, total: snapshot.length });
      await buyOne(snapshot[i]);
      if (i < snapshot.length - 1) await sleep(200);
    }

    setBuyingAllProgress(null);
    setBuyingAll(false);
  }, [rows, buyOne]);

  const totalCost = rows.reduce((acc, r) => acc + r.item.cost, 0);

  // Group rows by port
  const grouped = new Map<string, InventoryRow[]>();
  for (const row of rows) {
    const list = grouped.get(row.portName) ?? [];
    list.push(row);
    grouped.set(row.portName, list);
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <ShipIcon className="size-6 text-primary" />
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Shipyard Market</h1>
            <p className="text-sm text-muted-foreground">
              Ships available across all hub shipyards
            </p>
          </div>
        </div>

        {!loading && rows.length > 0 && (
          <div className="flex items-center gap-4">
            <div className="text-right">
              <div className="text-xs text-muted-foreground">Total cost</div>
              <div className="text-lg font-semibold text-primary">{fmt(totalCost)}</div>
            </div>
            <Button
              onClick={handleBuyAll}
              disabled={buyingAll || buyingId !== null}
              size="lg"
              className="gap-2"
            >
              <ShoppingCartIcon className="size-4" />
              {buyingAll && buyingAllProgress
                ? `Buying ${buyingAllProgress.done} / ${buyingAllProgress.total}…`
                : `Buy All (${rows.length})`}
            </Button>
          </div>
        )}
      </div>

      {/* Content */}
      {loading ? (
        <div className="flex items-center justify-center py-24">
          <Spinner className="size-8" />
        </div>
      ) : rows.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16 text-muted-foreground">
            <ShipIcon className="mb-3 size-10 opacity-30" />
            <p className="text-lg font-medium">No ships available</p>
            <p className="text-sm">All hub shipyards are currently empty.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {Array.from(grouped.entries()).map(([portName, portRows]) => (
            <Card key={portName}>
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-base">
                  <ShipIcon className="size-4 text-muted-foreground" />
                  {portName}
                  <Badge variant="secondary" className="ml-1">
                    {portRows.length} ship{portRows.length !== 1 ? "s" : ""}
                  </Badge>
                </CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b">
                      <th className="px-4 py-2 text-left text-xs font-medium text-muted-foreground">Ship Type</th>
                      <th className="px-4 py-2 text-right text-xs font-medium text-muted-foreground">Cost</th>
                      <th className="w-36 px-4 py-2 text-right text-xs font-medium text-muted-foreground">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {portRows.map((row) => {
                      const typeName =
                        shipTypes.get(row.item.ship_type_id)?.name ?? row.item.ship_type_id;
                      const isBuying = buyingId === row.item.id || buyingAll;

                      return (
                        <tr key={row.item.id} className="border-b last:border-0 hover:bg-muted/30 transition-colors">
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-2">
                              <span className="font-medium">{typeName}</span>
                              {row.error && (
                                <Badge variant="destructive" className="text-xs">
                                  {row.error}
                                </Badge>
                              )}
                            </div>
                          </td>
                          <td className="px-4 py-3 text-right font-mono">
                            {fmt(row.item.cost)}
                          </td>
                          <td className="px-4 py-3 text-right">
                            <Button
                              size="sm"
                              variant={row.error ? "outline" : "default"}
                              disabled={isBuying}
                              onClick={() => handleBuyOne(row)}
                              className="w-16"
                            >
                              {buyingId === row.item.id ? (
                                <Spinner className="size-3" />
                              ) : row.error ? (
                                "Retry"
                              ) : (
                                "Buy"
                              )}
                            </Button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
