"use client";

import { useEffect, useState } from "react";
import { worldApi } from "@/lib/api/world";
import { tradeApi } from "@/lib/api/trade";
import type { Good, Port, TraderPosition } from "@/lib/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsList, TabsTab, TabsPanel } from "@/components/ui/tabs";
import { PackageIcon } from "lucide-react";
import { cn } from "@/lib/utils";

const PRICE_LEVELS: Record<string, number> = {
  "Very Cheap": 1,
  "Cheap": 2,
  "Average": 3,
  "Expensive": 4,
  "Very Expensive": 5,
};

function priceCellClass(label: string | undefined): string {
  switch (label) {
    case "Very Cheap":   return "bg-emerald-500/20 text-emerald-400";
    case "Cheap":        return "bg-green-500/20 text-green-400";
    case "Average":      return "bg-yellow-500/20 text-yellow-400";
    case "Expensive":    return "bg-orange-500/20 text-orange-400";
    case "Very Expensive": return "bg-red-500/20 text-red-400";
    default:             return "text-muted-foreground/40";
  }
}

function priceShort(label: string | undefined): string {
  switch (label) {
    case "Very Cheap":     return "V.Cheap";
    case "Very Expensive": return "V.Exp";
    default:               return label ?? "N / A";
  }
}

export default function GoodsPage() {
  const [goods, setGoods] = useState<Good[]>([]);
  const [ports, setPorts] = useState<Port[]>([]);
  const [positions, setPositions] = useState<TraderPosition[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");

  useEffect(() => {
    Promise.all([
      worldApi.getGoods(),
      worldApi.getPorts(),
      tradeApi.getTraderPositions(),
    ])
      .then(([g, p, tp]) => {
        setGoods(g);
        setPorts(p.sort((a, b) => a.shortcode.localeCompare(b.shortcode)));
        setPositions(tp);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  // Build lookup: portId → goodId → price_bounds label
  const priceMatrix = new Map<string, Map<string, string>>();
  for (const pos of positions) {
    if (!priceMatrix.has(pos.port_id)) priceMatrix.set(pos.port_id, new Map());
    priceMatrix.get(pos.port_id)!.set(pos.good_id, pos.price_bounds);
  }

  const filtered = goods.filter((g) =>
    g.name.toLowerCase().includes(search.toLowerCase()) ||
    g.category.toLowerCase().includes(search.toLowerCase()),
  );

  const categories = [...new Set(goods.map((g) => g.category))].sort();

  if (loading) return <div className="flex h-full items-center justify-center"><Spinner className="size-8" /></div>;

  return (
    <div className="flex flex-col gap-6 h-full">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-bold">Goods</h1>
        <Input
          className="max-w-xs"
          placeholder="Search…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <Tabs defaultValue="catalog" className="flex-1 min-h-0">
        <TabsList>
          <TabsTab value="catalog">Catalog</TabsTab>
          <TabsTab value="prices">Prices</TabsTab>
        </TabsList>

        {/* ── Catalog tab ── */}
        <TabsPanel value="catalog" className="overflow-y-auto">
          <div className="space-y-6 pt-2">
            {categories.map((cat) => {
              const catGoods = filtered.filter((g) => g.category === cat);
              if (catGoods.length === 0) return null;
              return (
                <div key={cat}>
                  <h2 className="mb-3 font-semibold text-muted-foreground uppercase tracking-wider text-xs">{cat}</h2>
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {catGoods.map((good) => (
                      <Card key={good.id}>
                        <CardHeader>
                          <CardTitle className="flex items-center gap-2 text-base">
                            <PackageIcon className="size-4 text-muted-foreground" />
                            {good.name}
                          </CardTitle>
                        </CardHeader>
                        <CardContent className="space-y-2">
                          <div className="flex items-center gap-2">
                            <Badge variant="secondary">{good.category}</Badge>
                          </div>
                          {good.description && (
                            <p className="text-sm text-muted-foreground">{good.description}</p>
                          )}
                        </CardContent>
                      </Card>
                    ))}
                  </div>
                </div>
              );
            })}
            {filtered.length === 0 && (
              <p className="text-muted-foreground">No goods match "{search}".</p>
            )}
          </div>
        </TabsPanel>

        {/* ── Prices tab ── */}
        <TabsPanel value="prices" className="overflow-auto pt-2">
          <table className="min-w-max border-separate border-spacing-0 text-sm">
            <thead>
              <tr>
                <th className="sticky left-0 top-0 z-20 bg-card px-3 py-2 text-left font-semibold border-b border-r">
                  Good
                </th>
                {ports.map((port) => (
                  <th
                    key={port.id}
                    className="sticky top-0 z-10 bg-card px-2 py-2 text-center font-mono text-xs font-semibold border-b min-w-[72px]"
                    title={port.name}
                  >
                    {port.shortcode}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {categories.map((cat) => {
                const catGoods = filtered.filter((g) => g.category === cat);
                if (catGoods.length === 0) return null;
                return (
                  <>
                    <tr key={`cat-${cat}`}>
                      <td
                        colSpan={ports.length + 1}
                        className="sticky left-0 bg-muted/40 px-3 py-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground"
                      >
                        {cat}
                      </td>
                    </tr>
                    {catGoods.map((good) => (
                      <tr key={good.id} className="hover:bg-accent/20">
                        <td className="sticky left-0 z-10 bg-card px-3 py-1.5 font-medium whitespace-nowrap border-r">
                          {good.name}
                        </td>
                        {ports.map((port) => {
                          const label = priceMatrix.get(port.id)?.get(good.id);
                          return (
                            <td
                              key={port.id}
                              className={cn(
                                "px-2 py-1.5 text-center text-xs rounded-sm",
                                priceCellClass(label),
                              )}
                            >
                              {priceShort(label)}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </>
                );
              })}
            </tbody>
          </table>
          {filtered.length === 0 && (
            <p className="mt-4 text-muted-foreground">No goods match "{search}".</p>
          )}
        </TabsPanel>
      </Tabs>
    </div>
  );
}
