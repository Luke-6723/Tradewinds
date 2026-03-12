"use client";

import { useEffect, useState } from "react";
import { worldApi } from "@/lib/api/world";
import type { Good } from "@/lib/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { PackageIcon } from "lucide-react";

export default function GoodsPage() {
  const [goods, setGoods] = useState<Good[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");

  useEffect(() => {
    worldApi.getGoods().then(setGoods).catch(console.error).finally(() => setLoading(false));
  }, []);

  const filtered = goods.filter((g) =>
    g.name.toLowerCase().includes(search.toLowerCase()) ||
    g.category.toLowerCase().includes(search.toLowerCase()),
  );

  const categories = [...new Set(goods.map((g) => g.category))].sort();

  if (loading) return <div className="flex h-full items-center justify-center"><Spinner className="size-8" /></div>;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-bold">Goods</h1>
        <Input
          className="max-w-xs"
          placeholder="Search…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

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
  );
}
