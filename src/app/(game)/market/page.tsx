"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Empty, ErrorNote, KV, Loading, NativeSelect, Panel, Table } from "@/components/kibb/bits";
import { useCatalog } from "@/hooks/use-catalog";
import { usePoll } from "@/hooks/use-poll";
import { kibbGet, kibbPost } from "@/lib/kibb/browser";
import { fmtAgo, fmtBps, fmtCr, fmtTons } from "@/lib/kibb/format";
import type {
  CommodityBook,
  CompanyProfile,
  OrderSide,
  PlaceOrderResult,
  PortOrderBook,
  ShipResult,
  WorldClock,
} from "@/lib/kibb/types";

const VISIBILITY_NOTE: Record<string, string> = {
  quay: "Quay: live full depth (a ship or factor is here).",
  counting_house: "Counting house: live best bid/ask.",
  storage: "Storage: once-a-day snapshot of best bid/ask.",
};

function Ladder({ book }: { book: CommodityBook }) {
  if (!book.depth) return <Empty>Full depth needs a ship or factor in this port.</Empty>;
  const asks = book.depth.asks.slice(0, 8).reverse();
  const bids = book.depth.bids.slice(0, 8);
  return (
    <div className="space-y-2 font-mono text-xs">
      <div className="text-muted-foreground">NPC stock in port: {fmtTons(book.depth.npc_current_stock)}</div>
      <div className="grid grid-cols-[1fr_auto_auto] gap-x-4">
        {asks.map((l) => (
          <div key={l.order_id} className="contents text-destructive">
            <span>ask{l.is_npc ? "" : " (player)"}</span>
            <span className="text-right">{fmtCr(l.price_pence, 2)}</span>
            <span className="text-right">{fmtTons(l.remaining_quantity)}</span>
          </div>
        ))}
        <div className="col-span-3 my-1 border-t" />
        {bids.map((l) => (
          <div key={l.order_id} className="contents text-success-foreground">
            <span>bid{l.is_npc ? "" : " (player)"}</span>
            <span className="text-right">{fmtCr(l.price_pence, 2)}</span>
            <span className="text-right">{fmtTons(l.remaining_quantity)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function OrderForm({
  port,
  book,
  customsBps,
  ships,
  onDone,
}: {
  port: string;
  book: CommodityBook;
  customsBps: number;
  ships: ShipResult[];
  onDone: () => void;
}) {
  const { goodName } = useCatalog();
  const berthed = ships.filter((r) => r.ship.status === "berthed" && r.ship.current_port_id === port);
  const [side, setSide] = useState<OrderSide>("bid");
  const [shipId, setShipId] = useState(berthed[0]?.ship.id ?? "");
  const [qty, setQty] = useState(1);
  const [priceCr, setPriceCr] = useState(0);
  const [intoStores, setIntoStores] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PlaceOrderResult | null>(null);

  // Default the limit to the touch on the side we're crossing.
  useEffect(() => {
    const touch = side === "bid" ? book.best_ask?.price_pence : book.best_bid?.price_pence;
    setPriceCr(touch ? touch / 100 : 0);
    setIntoStores(false);
    setResult(null);
  }, [side, book.commodity_id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!berthed.some((r) => r.ship.id === shipId)) setShipId(berthed[0]?.ship.id ?? "");
  }, [berthed.map((r) => r.ship.id).join(",")]); // eslint-disable-line react-hooks/exhaustive-deps

  const ship = berthed.find((r) => r.ship.id === shipId);
  const held = ship?.cargo_manifest[book.commodity_id] ?? 0;
  const pricePence = Math.round(priceCr * 100);
  const gross = pricePence * qty;
  const customs = side === "bid" ? Math.ceil((gross * customsBps) / 10_000) : 0;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await kibbPost<PlaceOrderResult>("/v1/market/place-order", {
        port_id: port,
        commodity_id: book.commodity_id,
        side,
        time_in_force: "ioc",
        price_pence: pricePence,
        quantity: qty,
        ship_id: shipId,
        ...(intoStores ? { into_stores: true } : {}),
      });
      setResult(res);
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (berthed.length === 0) {
    return <Empty>Berth a ship here to trade. Orders fill straight into or out of a ship&apos;s hold.</Empty>;
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="flex gap-1 rounded-lg bg-muted p-0.5">
        {(["bid", "ask"] as const).map((sd) => (
          <button
            key={sd}
            type="button"
            onClick={() => setSide(sd)}
            className={`flex-1 rounded-md py-1 font-medium text-sm ${side === sd ? "bg-background shadow-sm" : "text-muted-foreground"}`}
          >
            {sd === "bid" ? "Buy" : "Sell"}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="col-span-2 space-y-1">
          <Label>Ship</Label>
          <NativeSelect value={shipId} onChange={(e) => setShipId(e.target.value)}>
            {berthed.map((r) => (
              <option key={r.ship.id} value={r.ship.id}>
                {r.ship.name} ({fmtTons(r.effective_hold_capacity_tons - r.cargo_used_tons)} free)
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="space-y-1">
          <Label>Tons</Label>
          <Input type="number" min={1} value={qty} onChange={(e) => setQty(Math.max(1, Math.floor(Number(e.target.value))))} />
        </div>
        <div className="space-y-1">
          <Label>Limit (Cr/t)</Label>
          <Input type="number" min={0.01} step={0.01} value={priceCr} onChange={(e) => setPriceCr(Number(e.target.value))} />
        </div>
      </div>
      {side === "bid" && book.commodity_id === "provisions" && (
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={intoStores} onChange={(e) => setIntoStores(e.target.checked)} />
          Into the crew&apos;s stores (not cargo)
        </label>
      )}
      <KV
        rows={
          side === "bid"
            ? [
                ["Up to", fmtCr(gross, 2)],
                [`Customs ${fmtBps(customsBps)}`, fmtCr(customs, 2)],
                ["Total at most", fmtCr(gross + customs, 2)],
              ]
            : [
                [`${goodName(book.commodity_id)} aboard`, fmtTons(held)],
                ["At least", fmtCr(gross, 2)],
                ["Customs", "sellers pay none"],
              ]
        }
      />
      <ErrorNote error={error} />
      {result && (
        <p className="text-sm">
          Filled {result.filled_quantity}/{result.requested_quantity} t for {fmtCr(result.total_gross_pence, 2)}
          {result.customs_duty_pence > 0 && ` + ${fmtCr(result.customs_duty_pence, 2)} customs`}. Unfilled tons were dropped (IOC).
        </p>
      )}
      <Button type="submit" className="w-full" disabled={busy || !shipId || pricePence <= 0}>
        {busy ? "Placing…" : `${side === "bid" ? "Buy" : "Sell"} ${qty} t ${goodName(book.commodity_id)} (IOC)`}
      </Button>
      <p className="text-muted-foreground text-xs">Each ton traded at a berth adds 2 game minutes (1 at hubs) to the ship&apos;s turnaround lock.</p>
    </form>
  );
}

function MarketView() {
  const router = useRouter();
  const params = useSearchParams();
  const { catalog, portName, goodName } = useCatalog();
  const { data: ships, reload: reloadShips } = usePoll(() => kibbGet<ShipResult[]>("/v1/fleet/ships", { limit: 200 }), 15_000);
  const { data: profile } = usePoll(() => kibbGet<CompanyProfile>("/v1/company/profile"));
  const { data: clock } = usePoll(() => kibbGet<WorldClock>("/v1/world/clock"));

  // Ports where the company has a ship or factor: full visibility.
  const presence = new Set<string>([
    ...(ships ?? []).map((r) => r.ship.current_port_id).filter((p): p is string => !!p),
    ...(profile?.factor_ports ?? []),
  ]);
  const port = params.get("port") ?? [...presence][0] ?? profile?.company.home_port_id ?? "";
  const [good, setGood] = useState<string | null>(null);

  const { data: book, error, reload } = usePoll(port ? () => kibbGet<PortOrderBook>("/v1/market/book", { port_id: port }) : null, 10_000, [port]);

  const ports = (catalog?.ports ?? [])
    .filter((p) => p.phase <= (clock?.unlocked_phase ?? 1))
    .sort((a, b) => Number(presence.has(b.id)) - Number(presence.has(a.id)) || a.name.localeCompare(b.name));
  const books = (book?.port_id === port ? book.books : []).slice().sort((a, b) => goodName(a.commodity_id).localeCompare(goodName(b.commodity_id)));
  const selected = books.find((b) => b.commodity_id === good) ?? null;

  return (
    <div className="space-y-6 pb-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-bold text-2xl tracking-tight">Market</h1>
          <p className="mt-0.5 text-muted-foreground text-sm">Port order books. Buyers pay customs; sellers don&apos;t.</p>
        </div>
        <div className="w-64">
          <NativeSelect
            value={port}
            onChange={(e) => {
              setGood(null);
              router.replace(`/market?port=${e.target.value}`);
            }}
          >
            {ports.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}{presence.has(p.id) ? " ●" : ""}
              </option>
            ))}
          </NativeSelect>
        </div>
      </div>

      {error && (error as { code?: string }).code === "no_port_presence" ? (
        <Panel title={portName(port)}>
          <p className="text-sm">
            You have no ship, factor or warehouse at {portName(port)}, so its book is hidden. Ports marked ● are visible.{" "}
            <Link href={`/ports/${port}`} className="text-primary hover:underline">Port page</Link> shows what it trades.
          </p>
        </Panel>
      ) : (
        <ErrorNote error={error} />
      )}

      {book && book.port_id === port && (
        <div className="grid gap-4 xl:grid-cols-3">
          <Panel
            title={`${portName(port)} · customs ${fmtBps(book.customs_bps)}`}
            action={<Badge variant="outline" size="sm">{book.visibility}</Badge>}
            className="xl:col-span-2"
          >
            <p className="mb-3 text-muted-foreground text-xs">
              {VISIBILITY_NOTE[book.visibility] ?? ""}
              {book.as_of && ` Snapshot ${fmtAgo(book.as_of)}.`}
            </p>
            {books.length === 0 ? (
              <Empty>No books.</Empty>
            ) : (
              <Table head={["Good", "Best bid", "Best ask", "Spread", "NPC stock"]}>
                {books.map((b) => {
                  const bid = b.best_bid?.price_pence;
                  const ask = b.best_ask?.price_pence;
                  return (
                    <tr
                      key={b.commodity_id}
                      onClick={() => setGood(b.commodity_id)}
                      className={`cursor-pointer hover:bg-accent/50 ${good === b.commodity_id ? "bg-accent" : ""}`}
                    >
                      <td className="font-medium">{goodName(b.commodity_id)}</td>
                      <td className="tabular-nums">{bid ? `${fmtCr(bid, 2)} × ${b.best_bid!.quantity}` : "—"}</td>
                      <td className="tabular-nums">{ask ? `${fmtCr(ask, 2)} × ${b.best_ask!.quantity}` : "—"}</td>
                      <td className="text-muted-foreground tabular-nums">{bid && ask ? fmtCr(ask - bid, 2) : "—"}</td>
                      <td className="text-muted-foreground tabular-nums">{b.depth ? fmtTons(b.depth.npc_current_stock) : "—"}</td>
                    </tr>
                  );
                })}
              </Table>
            )}
          </Panel>

          <div className="space-y-4">
            <Panel title={selected ? goodName(selected.commodity_id) : "Order"}>
              {selected ? (
                <OrderForm
                  port={port}
                  book={selected}
                  customsBps={book.customs_bps}
                  ships={ships ?? []}
                  onDone={() => {
                    void reload();
                    void reloadShips();
                  }}
                />
              ) : (
                <Empty>Pick a good to trade.</Empty>
              )}
            </Panel>
            {selected && (
              <Panel title="Depth">
                <Ladder book={selected} />
              </Panel>
            )}
          </div>
        </div>
      )}
      {!book && !error && port && <Loading />}
    </div>
  );
}

export default function MarketPage() {
  return (
    <Suspense fallback={<Loading />}>
      <MarketView />
    </Suspense>
  );
}
