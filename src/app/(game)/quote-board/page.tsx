"use client";

import { useCallback, useEffect, useState } from "react";
import { worldApi } from "@/lib/api/world";
import { tradeApi } from "@/lib/api/trade";
import type { Good, Port, TraderPosition } from "@/lib/types";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { RefreshCwIcon, ArrowUpDownIcon } from "lucide-react";
import { cn } from "@/lib/utils";

interface QuoteRow {
  key: string;
  position: TraderPosition;
  port: Port | undefined;
  good: Good | undefined;
  buyPrice: number | null;
  sellPrice: number | null;
  buyError: string | null;
  sellError: string | null;
}

type SortKey = "port" | "good" | "priceBounds" | "buyPrice" | "sellPrice" | "spread";
type SortDir = "asc" | "desc";

function priceBoundsClass(label: string): string {
  switch (label) {
    case "Very Cheap":     return "bg-emerald-500/20 text-emerald-400";
    case "Cheap":          return "bg-green-500/20 text-green-400";
    case "Average":        return "bg-yellow-500/20 text-yellow-400";
    case "Expensive":      return "bg-orange-500/20 text-orange-400";
    case "Very Expensive": return "bg-red-500/20 text-red-400";
    default:               return "text-muted-foreground";
  }
}

const PRICE_BOUNDS_ORDER: Record<string, number> = {
  "Very Cheap": 0,
  "Cheap": 1,
  "Average": 2,
  "Expensive": 3,
  "Very Expensive": 4,
};

function SortHeader({
  label,
  sortKey,
  current,
  dir,
  onSort,
  className,
}: {
  label: string;
  sortKey: SortKey;
  current: SortKey;
  dir: SortDir;
  onSort: (k: SortKey) => void;
  className?: string;
}) {
  const active = current === sortKey;
  return (
    <th
      className={cn(
        "px-4 py-3 font-semibold whitespace-nowrap cursor-pointer select-none hover:text-foreground transition-colors",
        active ? "text-foreground" : "text-muted-foreground",
        className,
      )}
      onClick={() => onSort(sortKey)}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        <ArrowUpDownIcon
          className={cn("size-3", active ? "opacity-100" : "opacity-30")}
          style={active ? { transform: dir === "desc" ? "scaleY(-1)" : "none" } : undefined}
        />
      </span>
    </th>
  );
}

export default function QuoteBoardPage() {
  const [ports, setPorts] = useState<Port[]>([]);
  const [goods, setGoods] = useState<Good[]>([]);
  const [positions, setPositions] = useState<TraderPosition[]>([]);
  const [rows, setRows] = useState<QuoteRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [fetchedAt, setFetchedAt] = useState<Date | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("port");
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  useEffect(() => {
    Promise.all([
      worldApi.getPorts(),
      worldApi.getGoods(),
      tradeApi.getTraderPositions(),
    ])
      .then(([p, g, tp]) => {
        setPorts(p.sort((a, b) => a.name.localeCompare(b.name)));
        setGoods(g);
        setPositions(tp);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  // Quote expiry countdown
  useEffect(() => {
    if (!fetchedAt) return;
    const interval = setInterval(() => {
      const left = Math.max(
        0,
        Math.floor((fetchedAt.getTime() + 120_000 - Date.now()) / 1000),
      );
      setSecondsLeft(left);
      if (left === 0) clearInterval(interval);
    }, 1000);
    return () => clearInterval(interval);
  }, [fetchedAt]);

  const fetchAllQuotes = useCallback(async () => {
    if (positions.length === 0) return;
    setFetching(true);
    setFetchError(null);
    try {
      // Deduplicate by (port_id, good_id) — the quote API doesn't take a trader_id
      const seen = new Set<string>();
      const unique: TraderPosition[] = [];
      for (const p of positions) {
        const key = `${p.port_id}:${p.good_id}`;
        if (!seen.has(key)) { seen.add(key); unique.push(p); }
      }

      const baseRequests = unique.map((p) => ({
        port_id: p.port_id,
        good_id: p.good_id,
        quantity: 1,
      }));

      const [buyResults, sellResults] = await Promise.all([
        tradeApi.batchCreateQuotes({
          requests: baseRequests.map((r) => ({ ...r, action: "buy" as const })),
        }),
        tradeApi.batchCreateQuotes({
          requests: baseRequests.map((r) => ({ ...r, action: "sell" as const })),
        }),
      ]);

      setRows(
        unique.map((pos, i) => {
          const buyR = buyResults[i];
          const sellR = sellResults[i];
          return {
            key: `${pos.port_id}:${pos.good_id}`,
            position: pos,
            port: ports.find((p) => p.id === pos.port_id),
            good: goods.find((g) => g.id === pos.good_id),
            buyPrice: buyR.status === "success" ? buyR.quote!.unit_price : null,
            sellPrice: sellR.status === "success" ? sellR.quote!.unit_price : null,
            buyError: buyR.status === "error" ? (buyR.message ?? "Error") : null,
            sellError: sellR.status === "error" ? (sellR.message ?? "Error") : null,
          };
        }),
      );
      setFetchedAt(new Date());
      setSecondsLeft(120);
    } catch (e: unknown) {
      setFetchError((e as Error).message);
    } finally {
      setFetching(false);
    }
  }, [positions, ports, goods]);

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  };

  const uniqueCount = (() => {
    const s = new Set(positions.map((p) => `${p.port_id}:${p.good_id}`));
    return s.size;
  })();

  const filtered = rows
    .filter((r) => {
      if (!search) return true;
      const q = search.toLowerCase();
      return (
        r.port?.name.toLowerCase().includes(q) ||
        r.port?.shortcode.toLowerCase().includes(q) ||
        r.good?.name.toLowerCase().includes(q) ||
        r.good?.category?.toLowerCase().includes(q) ||
        r.position.price_bounds.toLowerCase().includes(q)
      );
    })
    .sort((a, b) => {
      let cmp = 0;
      switch (sortKey) {
        case "port":
          cmp = (a.port?.name ?? "").localeCompare(b.port?.name ?? "");
          if (cmp === 0) cmp = (a.good?.name ?? "").localeCompare(b.good?.name ?? "");
          break;
        case "good":
          cmp = (a.good?.name ?? "").localeCompare(b.good?.name ?? "");
          if (cmp === 0) cmp = (a.port?.name ?? "").localeCompare(b.port?.name ?? "");
          break;
        case "priceBounds":
          cmp =
            (PRICE_BOUNDS_ORDER[a.position.price_bounds] ?? 99) -
            (PRICE_BOUNDS_ORDER[b.position.price_bounds] ?? 99);
          break;
        case "buyPrice":
          cmp = (a.buyPrice ?? Infinity) - (b.buyPrice ?? Infinity);
          break;
        case "sellPrice":
          cmp = (a.sellPrice ?? -Infinity) - (b.sellPrice ?? -Infinity);
          break;
        case "spread": {
          const sa =
            a.buyPrice !== null && a.sellPrice !== null
              ? a.buyPrice - a.sellPrice
              : null;
          const sb =
            b.buyPrice !== null && b.sellPrice !== null
              ? b.buyPrice - b.sellPrice
              : null;
          cmp = (sa ?? Infinity) - (sb ?? Infinity);
          break;
        }
      }
      return sortDir === "asc" ? cmp : -cmp;
    });

  if (loading)
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner className="size-8" />
      </div>
    );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Quote Board</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Buy &amp; sell quotes for all {uniqueCount} trader positions across every port.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {fetchedAt && (
            <Badge
              variant={
                secondsLeft > 60 ? "success" : secondsLeft > 0 ? "warning" : "destructive"
              }
            >
              {secondsLeft > 0 ? `Expires in ${secondsLeft}s` : "Expired — refresh"}
            </Badge>
          )}
          <Button onClick={fetchAllQuotes} disabled={fetching || positions.length === 0}>
            {fetching ? (
              <Spinner className="size-4 mr-2" />
            ) : (
              <RefreshCwIcon className="size-4 mr-2" />
            )}
            {rows.length === 0 ? `Fetch ${uniqueCount} Quotes` : "Refresh"}
          </Button>
        </div>
      </div>

      {fetchError && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/8 px-4 py-3 text-sm text-destructive-foreground">
          {fetchError}
        </div>
      )}

      {fetching && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner className="size-4" />
          Fetching {uniqueCount * 2} quotes (buy &amp; sell for each position)…
        </div>
      )}

      {rows.length > 0 && (
        <Input
          placeholder="Filter by port, good, category or price range…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="max-w-sm"
        />
      )}

      {rows.length === 0 && !fetching ? (
        <Card>
          <CardContent className="py-16 text-center text-muted-foreground text-sm">
            Click &ldquo;Fetch {uniqueCount} Quotes&rdquo; to load live buy &amp; sell prices for every
            trader position.
          </CardContent>
        </Card>
      ) : rows.length > 0 ? (
        <Card>
          <CardContent className="p-0 overflow-auto">
            <table className="min-w-full text-sm border-separate border-spacing-0">
              <thead>
                <tr>
                  <SortHeader
                    label="Port"
                    sortKey="port"
                    current={sortKey}
                    dir={sortDir}
                    onSort={handleSort}
                    className="sticky left-0 z-10 bg-card text-left border-b"
                  />
                  <SortHeader
                    label="Good"
                    sortKey="good"
                    current={sortKey}
                    dir={sortDir}
                    onSort={handleSort}
                    className="text-left border-b"
                  />
                  <SortHeader
                    label="Price Range"
                    sortKey="priceBounds"
                    current={sortKey}
                    dir={sortDir}
                    onSort={handleSort}
                    className="text-left border-b"
                  />
                  <th className="px-4 py-3 text-left font-semibold text-muted-foreground whitespace-nowrap border-b">
                    Stock Range
                  </th>
                  <SortHeader
                    label="Buy (£/unit)"
                    sortKey="buyPrice"
                    current={sortKey}
                    dir={sortDir}
                    onSort={handleSort}
                    className="text-right border-b"
                  />
                  <SortHeader
                    label="Sell (£/unit)"
                    sortKey="sellPrice"
                    current={sortKey}
                    dir={sortDir}
                    onSort={handleSort}
                    className="text-right border-b"
                  />
                  <SortHeader
                    label="Spread"
                    sortKey="spread"
                    current={sortKey}
                    dir={sortDir}
                    onSort={handleSort}
                    className="text-right border-b"
                  />
                </tr>
              </thead>
              <tbody>
                {filtered.map((row, i) => {
                  const spread =
                    row.buyPrice !== null && row.sellPrice !== null
                      ? row.buyPrice - row.sellPrice
                      : null;
                  return (
                    <tr
                      key={row.key}
                      className={cn(
                        "hover:bg-accent/20 transition-colors",
                        i % 2 !== 0 && "bg-accent/5",
                      )}
                    >
                      <td className="sticky left-0 z-10 bg-card px-4 py-2 whitespace-nowrap">
                        <div className="flex items-center gap-2">
                          <span className="font-medium">
                            {row.port?.name ?? row.position.port_id}
                          </span>
                          {row.port?.shortcode && (
                            <Badge variant="outline" className="text-xs font-mono py-0">
                              {row.port.shortcode}
                            </Badge>
                          )}
                          {row.port?.is_hub && (
                            <Badge variant="info" className="text-xs py-0">
                              Hub
                            </Badge>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-2 whitespace-nowrap font-medium">
                        {row.good?.name ?? row.position.good_id}
                        {row.good?.category && (
                          <span className="ml-1.5 text-xs text-muted-foreground">
                            {row.good.category}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2 whitespace-nowrap">
                        <span
                          className={cn(
                            "rounded px-1.5 py-0.5 text-xs font-medium",
                            priceBoundsClass(row.position.price_bounds),
                          )}
                        >
                          {row.position.price_bounds}
                        </span>
                      </td>
                      <td className="px-4 py-2 whitespace-nowrap text-xs text-muted-foreground">
                        {row.position.stock_bounds}
                      </td>
                      <td className="px-4 py-2 text-right whitespace-nowrap">
                        {row.buyPrice !== null ? (
                          <span className="font-mono text-green-400">
                            £{row.buyPrice.toLocaleString()}
                          </span>
                        ) : (
                          <span
                            className="text-xs text-muted-foreground/50"
                            title={row.buyError ?? undefined}
                          >
                            —
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2 text-right whitespace-nowrap">
                        {row.sellPrice !== null ? (
                          <span className="font-mono text-blue-400">
                            £{row.sellPrice.toLocaleString()}
                          </span>
                        ) : (
                          <span
                            className="text-xs text-muted-foreground/50"
                            title={row.sellError ?? undefined}
                          >
                            —
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2 text-right whitespace-nowrap">
                        {spread !== null ? (
                          <span
                            className={cn(
                              "font-mono text-xs",
                              spread === 0
                                ? "text-muted-foreground"
                                : spread > 0
                                  ? "text-orange-400"
                                  : "text-emerald-400",
                            )}
                          >
                            {spread > 0 ? "+" : ""}
                            {spread.toLocaleString()}
                          </span>
                        ) : (
                          <span className="text-muted-foreground/50 text-xs">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {filtered.length === 0 && (
              <p className="py-8 text-center text-sm text-muted-foreground">
                No results match your filter.
              </p>
            )}
            <div className="border-t px-4 py-2 text-xs text-muted-foreground">
              {filtered.length} of {rows.length} positions
              {fetchedAt && (
                <span className="ml-2">
                  · fetched at {fetchedAt.toLocaleTimeString()}
                </span>
              )}
            </div>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
