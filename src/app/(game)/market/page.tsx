"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsPanel, TabsTab } from "@/components/ui/tabs";
import { Empty, ErrorNote, KV, Loading, NativeSelect, PageHeader, Panel, Table } from "@/components/kibb/bits";
import { useOurCompanyIds } from "@/components/kibb/naval-common";
import { Field, GoodSelect, PortSelect, ShipSelect } from "@/components/kibb/pickers";
import {
  AutopilotWarning,
  BatchError,
  LoadMore,
  postBatch,
  toggle,
  toPence,
  useAutopilotShips,
  usePaged,
} from "@/components/kibb/trade-common";
import { useAction } from "@/hooks/use-action";
import { useCatalog } from "@/hooks/use-catalog";
import { usePoll } from "@/hooks/use-poll";
import { kibbGet, kibbPost } from "@/lib/kibb/browser";
import { fmtAgo, fmtBps, fmtCr, fmtDateTime, fmtTons } from "@/lib/kibb/format";
import type * as S from "@/lib/kibb/schema";
import type {
  CommodityBook,
  CompanyProfile,
  OrderSide,
  PlaceOrderResult,
  PortOrderBook,
  ShipResult,
  TimeInForce,
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

/** Segmented two-way toggle, like the buy/sell switch. */
function Toggle<T extends string>({ value, options, onChange }: { value: T; options: Array<[T, string]>; onChange: (v: T) => void }) {
  return (
    <div className="flex gap-1 rounded-lg bg-muted p-0.5">
      {options.map(([v, label]) => (
        <button
          key={v}
          type="button"
          onClick={() => onChange(v)}
          className={`flex-1 rounded-md py-1 font-medium text-sm ${value === v ? "bg-background shadow-sm" : "text-muted-foreground"}`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/** Who holds a monopoly, from our side: this company, another of our player's (still barred), or someone else. */
type Holder = "you" | "sibling" | "other";

/** Royal monopolies in force on goods of this port's region (guide 3.9). */
function MonopolyBanner({ monopolies, holderOf, region }: { monopolies: S.MonopolyResult[]; holderOf: (m: S.MonopolyResult) => Holder; region: string }) {
  const { goodName } = useCatalog();
  return (
    <div className="space-y-1.5 rounded-md bg-warning/10 px-3 py-2 text-sm text-warning-foreground">
      {monopolies.map((m) => {
        const h = holderOf(m);
        return (
          <p key={m.id}>
            <strong>Royal monopoly on {goodName(m.commodity_id)}</strong> in {region.replace(/_/g, " ")}, held by{" "}
            {h === "you" ? "you" : h === "sibling" ? `your other company ${m.holder_company_name} (this one is barred too)` : m.holder_company_name} until{" "}
            {fmtDateTime(m.expires_at)}.{" "}
            {h === "you"
              ? "Only you buy it from the Crown's asks at this region's ports, and only your resting bids are filled by the Crown's ladder."
              : "Here you can buy it only from players' resting asks (the holder's or others'): an IOC buy only the monopoly kept from filling is refused (409), and a GTC bid rests unfilled by the Crown's ladder."}
          </p>
        );
      })}
      <p className="text-xs">
        Selling to the Crown is unaffected.{" "}
        <Link href="/monopolies" className="underline">
          Monopolies
        </Link>
      </p>
    </div>
  );
}

function OrderForm({
  port,
  book,
  customsBps,
  ships,
  autopilot,
  monopoly,
  holder,
  onDone,
}: {
  port: string;
  book: CommodityBook;
  customsBps: number;
  ships: ShipResult[];
  autopilot: Set<string>;
  /** A royal monopoly in force on this good in the port's region. */
  monopoly?: S.MonopolyResult;
  holder?: Holder;
  onDone: () => void;
}) {
  const { goodName } = useCatalog();
  const berthed = ships.filter((r) => r.ship.status === "berthed" && r.ship.current_port_id === port);
  const [side, setSide] = useState<OrderSide>("bid");
  const [tif, setTif] = useState<TimeInForce>("ioc");
  // "" settles against the warehouse at this port.
  const [shipId, setShipId] = useState(berthed[0]?.ship.id ?? "");
  const [qty, setQty] = useState(1);
  const [priceCr, setPriceCr] = useState(0);
  const [intoStores, setIntoStores] = useState(false);
  const { data: warehouse, reload: reloadWarehouse } = usePoll(
    () => kibbGet<S.PortWarehouseResult>("/v1/warehouse/inventory", { port_id: port }),
    0,
    [port],
  );
  const order = useAction<PlaceOrderResult>(() => {
    onDone();
    void reloadWarehouse();
  });

  // Default the limit to the touch on the side we're crossing.
  useEffect(() => {
    const touch = side === "bid" ? book.best_ask?.price_pence : book.best_bid?.price_pence;
    setPriceCr(touch ? touch / 100 : 0);
    setIntoStores(false);
    order.reset();
  }, [side, book.commodity_id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (shipId && !berthed.some((r) => r.ship.id === shipId)) setShipId(berthed[0]?.ship.id ?? "");
  }, [berthed.map((r) => r.ship.id).join(",")]); // eslint-disable-line react-hooks/exhaustive-deps

  // A resting (GTC) order never names a ship.
  const effShip = tif === "gtc" ? "" : shipId;
  const ship = berthed.find((r) => r.ship.id === effShip);
  const stock = warehouse?.inventory.find((i) => i.commodity_id === book.commodity_id);
  const held = ship ? (ship.cargo_manifest[book.commodity_id] ?? 0) : stock ? stock.quantity - stock.locked_quantity : 0;
  const pricePence = toPence(priceCr);
  const gross = pricePence * qty;
  const customs = side === "bid" ? Math.ceil((gross * customsBps) / 10_000) : 0;
  const canStores = side === "bid" && tif === "ioc" && !!effShip && book.commodity_id === "provisions";
  const r = order.result;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    void order.run(() =>
      kibbPost<PlaceOrderResult>("/v1/market/place-order", {
        port_id: port,
        commodity_id: book.commodity_id,
        side,
        time_in_force: tif,
        price_pence: pricePence,
        quantity: qty,
        ...(effShip ? { ship_id: effShip } : {}),
        ...(canStores && intoStores ? { into_stores: true } : {}),
      }),
    );
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <Toggle value={side} options={[["bid", "Buy"], ["ask", "Sell"]]} onChange={setSide} />
      <Toggle value={tif} options={[["ioc", "Fill now (IOC)"], ["gtc", "Rest on book (GTC)"]]} onChange={setTif} />
      <div className="grid grid-cols-2 gap-3">
        <div className="col-span-2 space-y-1">
          <Label>Settle with</Label>
          <NativeSelect value={effShip} disabled={tif === "gtc"} onChange={(e) => setShipId(e.target.value)}>
            {berthed.map((r) => (
              <option key={r.ship.id} value={r.ship.id}>
                {r.ship.name} ({fmtTons(r.effective_hold_capacity_tons - r.cargo_used_tons)} free)
              </option>
            ))}
            <option value="">Warehouse at this port{warehouse ? ` (${fmtTons(warehouse.free_tonnage)} free)` : ""}</option>
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
      {canStores && (
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={intoStores} onChange={(e) => setIntoStores(e.target.checked)} />
          Into the crew&apos;s stores (not cargo)
        </label>
      )}
      {effShip && autopilot.has(effShip) && <AutopilotWarning shipName={ship?.ship.name} />}
      {side === "bid" && monopoly && holder !== "you" && (
        <p className="rounded-md bg-warning/10 px-3 py-2 text-sm text-warning-foreground">
          Under royal monopoly ({monopoly.holder_company_name}{holder === "sibling" ? ", your other company" : ""}): you can buy only from players&apos; resting asks.{" "}
          {tif === "ioc"
            ? "If only the monopoly keeps this buy from filling, it is refused (409)."
            : "A resting bid is never filled by the Crown's ladder; only players' asks cross it."}
        </p>
      )}
      <KV
        rows={
          side === "bid"
            ? [
                ["Up to", fmtCr(gross, 2)],
                [`Customs ${fmtBps(customsBps)}`, fmtCr(customs, 2)],
                [tif === "gtc" ? "Escrowed now" : "Total at most", fmtCr(gross + customs, 2)],
              ]
            : [
                [`${goodName(book.commodity_id)} ${effShip ? "aboard" : "in warehouse (unlocked)"}`, fmtTons(held)],
                ["At least", fmtCr(gross, 2)],
                ["Customs", "sellers pay none"],
              ]
        }
      />
      <ErrorNote error={order.error} />
      {r && (
        <p className="text-sm">
          Filled {r.filled_quantity}/{r.requested_quantity} t for {fmtCr(r.total_gross_pence, 2)}
          {r.customs_duty_pence > 0 && ` + ${fmtCr(r.customs_duty_pence, 2)} customs`}.
          {r.resting_quantity > 0
            ? ` ${r.resting_quantity} t rests on the book; see My orders.`
            : r.filled_quantity < r.requested_quantity && tif === "ioc"
              ? " Unfilled tons were dropped (IOC)."
              : ""}
        </p>
      )}
      <Button type="submit" className="w-full" disabled={order.busy || pricePence <= 0}>
        {order.busy ? "Placing…" : `${side === "bid" ? "Buy" : "Sell"} ${qty} t ${goodName(book.commodity_id)} (${tif.toUpperCase()})`}
      </Button>
      <p className="text-muted-foreground text-xs">
        {tif === "gtc"
          ? "Rests on the book against your warehouse here: a bid escrows price plus customs and reserves warehouse space, an ask locks the goods. NPC ladders cross resting orders when they re-quote (every 6 game hours); players cross them at once."
          : effShip
            ? "Fills straight into or out of the hold. Each ton traded at a berth adds 2 game minutes (1 at hubs) to the ship's turnaround lock."
            : "Settles against your warehouse here: purchases need free leased space, sales come out of unlocked stock."}
      </p>
    </form>
  );
}

function FilterBar({
  port,
  good,
  side,
  setPort,
  setGood,
  setSide,
}: {
  port: string;
  good: string;
  side: string;
  setPort: (v: string) => void;
  setGood: (v: string) => void;
  setSide: (v: string) => void;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      <Field label="Port">
        <PortSelect value={port} onChange={setPort} placeholder="All ports" />
      </Field>
      <Field label="Good">
        <GoodSelect value={good} onChange={setGood} placeholder="All goods" />
      </Field>
      <Field label="Side">
        <NativeSelect value={side} onChange={(e) => setSide(e.target.value)}>
          <option value="">Both</option>
          <option value="bid">Bids (buying)</option>
          <option value="ask">Asks (selling)</option>
        </NativeSelect>
      </Field>
    </div>
  );
}

function OrdersPanel() {
  const { portName, goodName } = useCatalog();
  const [port, setPort] = useState("");
  const [good, setGood] = useState("");
  const [side, setSide] = useState("");
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [failedId, setFailedId] = useState<string | null>(null);
  const list = usePaged(
    (cursor) => kibbGet<S.OrderBook[]>("/v1/market/orders", { port_id: port, commodity_id: good, side, cursor, limit: 100 }),
    100,
    [port, good, side],
  );
  const cancel = useAction<S.CancelOrderResult[]>(() => {
    setSel(new Set());
    void list.reload();
  });
  const released = cancel.result?.reduce((n, c) => n + c.released_quantity, 0);
  // Only orders on screen can be cancelled in a batch: a filter change or reload drops the rest.
  const picked = list.items.filter((o) => sel.has(o.id)).slice(0, 50);
  const describe = (o: S.OrderBook) => `${o.side === "bid" ? "buy" : "sell"} ${goodName(o.commodity_id)} at ${portName(o.port_id)}`;

  useEffect(() => {
    setSel((prev) => {
      const next = new Set([...prev].filter((id) => list.items.some((o) => o.id === id)));
      return next.size === prev.size ? prev : next;
    });
  }, [list.items]);

  const refilter = <T,>(set: (v: T) => void) => (v: T) => {
    set(v);
    setSel(new Set());
    setFailedId(null);
  };

  function cancelOne(o: S.OrderBook) {
    if (!confirm(`Cancel your ${describe(o)}?`)) return;
    setFailedId(null);
    void cancel.run(async () => [await kibbPost<S.CancelOrderResult>("/v1/market/cancel-order", { order_id: o.id })]);
  }

  function cancelSelected() {
    const orders = picked;
    if (orders.length === 0) return;
    if (!confirm(`Cancel ${orders.length} resting order${orders.length === 1 ? "" : "s"}?`)) return;
    setFailedId(null);
    void cancel.run(async () => {
      try {
        return await postBatch<S.CancelOrderResult[]>("/v1/market/cancel-orders-batch", { order_ids: orders.map((o) => o.id) });
      } catch (e) {
        const bad = e instanceof BatchError && e.batchIndex !== null ? orders[e.batchIndex] : undefined;
        if (!bad) throw e;
        setFailedId(bad.id);
        throw new Error(`Nothing was cancelled: your ${describe(bad)} was refused (${(e as Error).message.replace(/^Item \d+: /, "")}). Untick it and try again.`);
      }
    });
  }

  return (
    <Panel
      title="Resting orders"
      action={
        <Button size="sm" variant="outline" disabled={picked.length === 0 || cancel.busy} onClick={cancelSelected}>
          Cancel selected{picked.length ? ` (${picked.length})` : ""}
        </Button>
      }
    >
      <div className="space-y-4">
        <FilterBar port={port} good={good} side={side} setPort={refilter(setPort)} setGood={refilter(setGood)} setSide={refilter(setSide)} />
        <ErrorNote error={list.error ?? cancel.error} />
        {cancel.result && <p className="text-sm">Cancelled {cancel.result.length}; released {fmtTons(released)}.</p>}
        {list.items.length === 0 ? (
          list.loading ? <Loading /> : <Empty>No resting orders. Place a GTC order on the Books tab.</Empty>
        ) : (
          <Table
            head={[
              <input
                key="all"
                type="checkbox"
                aria-label="Select all"
                checked={list.items.length > 0 && list.items.every((o) => sel.has(o.id))}
                onChange={(e) => setSel(e.target.checked ? new Set(list.items.map((o) => o.id)) : new Set())}
              />,
              "Placed",
              "Port",
              "Good",
              "Side",
              "Limit",
              "Remaining",
              "Filled",
              "",
            ]}
          >
            {list.items.map((o) => (
              <tr key={o.id} className={o.id === failedId ? "bg-destructive/10" : undefined}>
                <td>
                  <input type="checkbox" checked={sel.has(o.id)} onChange={() => setSel((s) => toggle(s, o.id))} />
                </td>
                <td className="whitespace-nowrap text-muted-foreground">{fmtDateTime(o.created_at)}</td>
                <td>{portName(o.port_id)}</td>
                <td className="font-medium">{goodName(o.commodity_id)}</td>
                <td>
                  <Badge variant={o.side === "bid" ? "success" : "error"} size="sm">
                    {o.side === "bid" ? "buy" : "sell"}
                  </Badge>
                </td>
                <td className="tabular-nums">{fmtCr(o.price_pence, 2)}</td>
                <td className="tabular-nums">{fmtTons(o.quantity - o.filled_quantity)}</td>
                <td className="text-muted-foreground tabular-nums">{fmtTons(o.filled_quantity)}</td>
                <td className="text-right">
                  <Button size="sm" variant="ghost" disabled={cancel.busy} onClick={() => cancelOne(o)}>
                    Cancel
                  </Button>
                </td>
              </tr>
            ))}
          </Table>
        )}
        <LoadMore done={list.done} loading={list.loading} onMore={() => void list.more()} />
        <p className="text-muted-foreground text-xs">
          A resting bid holds price plus customs in escrow and reserves warehouse space; a resting ask locks the goods. Cancelling releases both.
        </p>
      </div>
    </Panel>
  );
}

function FillsPanel() {
  const { portName, goodName } = useCatalog();
  const [port, setPort] = useState("");
  const [good, setGood] = useState("");
  const [side, setSide] = useState("");
  const list = usePaged(
    (cursor) => kibbGet<S.CompanyTradeFillResult[]>("/v1/market/fills", { port_id: port, commodity_id: good, side, cursor, limit: 100 }),
    100,
    [port, good, side],
  );
  const shown = list.items;
  const bought = shown.filter((f) => f.side === "bid").reduce((n, f) => n + f.price_pence * f.quantity + f.customs_duty_pence, 0);
  const sold = shown.filter((f) => f.side === "ask").reduce((n, f) => n + f.price_pence * f.quantity, 0);

  return (
    <Panel title="Trade fills" action={<span className="text-muted-foreground text-xs">shown: bought {fmtCr(bought)} · sold {fmtCr(sold)}</span>}>
      <div className="space-y-4">
        <FilterBar port={port} good={good} side={side} setPort={setPort} setGood={setGood} setSide={setSide} />
        <ErrorNote error={list.error} />
        {shown.length === 0 ? (
          list.loading ? <Loading /> : <Empty>No fills yet.</Empty>
        ) : (
          <Table head={["Time", "Port", "Good", "Side", "Tons", "Price", "Value", "Customs", "Role"]}>
            {shown.map((f) => (
              <tr key={f.id}>
                <td className="whitespace-nowrap text-muted-foreground">{fmtDateTime(f.created_at)}</td>
                <td>{portName(f.port_id)}</td>
                <td className="font-medium">{goodName(f.commodity_id)}</td>
                <td>
                  <Badge variant={f.side === "bid" ? "success" : "error"} size="sm">
                    {f.side === "bid" ? "bought" : "sold"}
                  </Badge>
                </td>
                <td className="tabular-nums">{f.quantity}</td>
                <td className="tabular-nums">{fmtCr(f.price_pence, 2)}</td>
                <td className="tabular-nums">{fmtCr(f.price_pence * f.quantity, 2)}</td>
                <td className="text-muted-foreground tabular-nums">{f.customs_duty_pence ? fmtCr(f.customs_duty_pence, 2) : "—"}</td>
                <td className="text-muted-foreground">{f.is_maker ? "maker" : "taker"}</td>
              </tr>
            ))}
          </Table>
        )}
        <LoadMore done={list.done} loading={list.loading} onMore={() => void list.more()} />
      </div>
    </Panel>
  );
}

interface BatchRow {
  key: number;
  port: string;
  good: string;
  side: OrderSide;
  tif: TimeInForce;
  priceCr: number;
  qty: number;
  /** "" = warehouse. */
  ship: string;
}

let rowSeq = 0;
const newRow = (port: string, from?: BatchRow): BatchRow => ({
  key: ++rowSeq,
  port: from?.port ?? port,
  good: from?.good ?? "",
  side: from?.side ?? "bid",
  tif: from?.tif ?? "ioc",
  priceCr: from?.priceCr ?? 0,
  qty: from?.qty ?? 1,
  ship: from?.ship ?? "",
});

function BatchPanel({
  defaultPort,
  ships,
  maxPhase,
  autopilot,
  onDone,
}: {
  defaultPort: string;
  ships: ShipResult[] | undefined;
  maxPhase: number | undefined;
  autopilot: Set<string>;
  onDone: () => void;
}) {
  const { portName, goodName } = useCatalog();
  const [rows, setRows] = useState<BatchRow[]>(() => [newRow(defaultPort)]);
  const [failed, setFailed] = useState<number | null>(null);
  const batch = useAction<PlaceOrderResult[]>(onDone);

  const set = (key: number, patch: Partial<BatchRow>) => {
    setFailed(null);
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  };
  const incomplete = rows.some((r) => !r.port || !r.good || r.qty < 1 || r.priceCr <= 0);
  const autopilotRows = rows.filter((r) => r.tif === "ioc" && r.ship && autopilot.has(r.ship));

  function submit() {
    setFailed(null);
    const orders = rows.map((r) => ({
      port_id: r.port,
      commodity_id: r.good,
      side: r.side,
      time_in_force: r.tif,
      price_pence: toPence(r.priceCr),
      quantity: r.qty,
      ...(r.tif === "ioc" && r.ship ? { ship_id: r.ship } : {}),
    }));
    void batch.run(async () => {
      try {
        return await postBatch<PlaceOrderResult[]>("/v1/market/place-orders-batch", { orders });
      } catch (e) {
        if (e instanceof BatchError) setFailed(e.batchIndex);
        throw e;
      }
    });
  }

  return (
    <Panel
      title="Batch orders"
      action={
        <Button size="sm" variant="outline" disabled={rows.length >= 25} onClick={() => setRows((rs) => [...rs, newRow(defaultPort, rs.at(-1))])}>
          Add row
        </Button>
      }
    >
      <div className="space-y-4">
        <Table head={["#", "Port", "Good", "Side", "Type", "Limit Cr/t", "Tons", "Settle with", ""]}>
          {rows.map((r, i) => (
            <tr key={r.key} className={failed === i ? "bg-destructive/10" : undefined}>
              <td className="text-muted-foreground">{i + 1}</td>
              <td className="min-w-36">
                <PortSelect value={r.port} onChange={(v) => set(r.key, { port: v, ship: "" })} placeholder="Port…" maxPhase={maxPhase} />
              </td>
              <td className="min-w-36">
                <GoodSelect value={r.good} onChange={(v) => set(r.key, { good: v })} placeholder="Good…" />
              </td>
              <td className="min-w-20">
                <NativeSelect value={r.side} onChange={(e) => set(r.key, { side: e.target.value as OrderSide })}>
                  <option value="bid">Buy</option>
                  <option value="ask">Sell</option>
                </NativeSelect>
              </td>
              <td className="min-w-20">
                <NativeSelect value={r.tif} onChange={(e) => set(r.key, { tif: e.target.value as TimeInForce })}>
                  <option value="ioc">IOC</option>
                  <option value="gtc">GTC</option>
                </NativeSelect>
              </td>
              <td className="min-w-24">
                <Input type="number" min={0.01} step={0.01} value={r.priceCr} onChange={(e) => set(r.key, { priceCr: Number(e.target.value) })} />
              </td>
              <td className="min-w-20">
                <Input type="number" min={1} value={r.qty} onChange={(e) => set(r.key, { qty: Math.max(1, Math.floor(Number(e.target.value))) })} />
              </td>
              <td className="min-w-44">
                <ShipSelect
                  value={r.tif === "gtc" ? "" : r.ship}
                  onChange={(v) => set(r.key, { ship: v })}
                  placeholder="Warehouse"
                  disabled={r.tif === "gtc"}
                  ships={ships}
                  filter={(s) => s.ship.status === "berthed" && s.ship.current_port_id === r.port}
                />
              </td>
              <td className="text-right">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={rows.length === 1}
                  onClick={() => {
                    setFailed(null);
                    setRows((rs) => rs.filter((x) => x.key !== r.key));
                  }}
                >
                  Remove
                </Button>
              </td>
            </tr>
          ))}
        </Table>
        {autopilotRows.length > 0 && <AutopilotWarning shipName="some of these ships" />}
        <ErrorNote error={batch.error} />
        {batch.result && (
          <Table head={["#", "Order", "Filled", "Resting", "Value", "Customs"]}>
            {batch.result.map((res, i) => (
              <tr key={i}>
                <td className="text-muted-foreground">{i + 1}</td>
                <td>
                  {res.side === "bid" ? "Buy" : "Sell"} {goodName(res.commodity_id)} at {portName(res.port_id)}
                </td>
                <td className="tabular-nums">
                  {res.filled_quantity}/{res.requested_quantity} t
                </td>
                <td className="tabular-nums">{res.resting_quantity ? fmtTons(res.resting_quantity) : "—"}</td>
                <td className="tabular-nums">{fmtCr(res.total_gross_pence, 2)}</td>
                <td className="tabular-nums">{res.customs_duty_pence ? fmtCr(res.customs_duty_pence, 2) : "—"}</td>
              </tr>
            ))}
          </Table>
        )}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-muted-foreground text-xs">
            Up to 25 orders, all or nothing: if one is refused, none is placed and its row turns red. IOC with a ship fills the hold
            (the ship must be berthed there); IOC without one settles against your warehouse; GTC rests on the book.
          </p>
          <Button disabled={batch.busy || incomplete} onClick={submit}>
            {batch.busy ? "Placing…" : `Place ${rows.length} order${rows.length === 1 ? "" : "s"}`}
          </Button>
        </div>
      </div>
    </Panel>
  );
}

function MarketView() {
  const router = useRouter();
  const params = useSearchParams();
  const { catalog, portName, goodName } = useCatalog();
  const { data: ships, reload: reloadShips } = usePoll(() => kibbGet<ShipResult[]>("/v1/fleet/ships", { limit: 200 }), 15_000);
  const { data: profile } = usePoll(() => kibbGet<CompanyProfile>("/v1/company/profile"));
  const { data: clock } = usePoll(() => kibbGet<WorldClock>("/v1/world/clock"));
  const autopilot = useAutopilotShips();

  // Ports where the company has a ship or factor: full visibility.
  const presence = new Set<string>([
    ...(ships ?? []).map((r) => r.ship.current_port_id).filter((p): p is string => !!p),
    ...(profile?.factor_ports ?? []),
  ]);
  const port = params.get("port") ?? [...presence][0] ?? profile?.company.home_port_id ?? "";
  const [good, setGood] = useState<string | null>(null);

  const { data: book, error, reload } = usePoll(port ? () => kibbGet<PortOrderBook>("/v1/market/book", { port_id: port }) : null, 10_000, [port]);
  // Royal monopolies bar non-holders from the Crown's asks across the whole banking region (guide 3.9).
  const ourIds = useOurCompanyIds();
  const region = catalog?.ports.find((p) => p.id === port)?.banking_region ?? "";
  const { data: monopolies } = usePoll(
    region ? () => kibbGet<S.MonopolyResult[]>("/v1/world/monopolies", { banking_region: region, limit: 200 }) : null,
    60_000,
    [region],
  );
  const inForce = (monopolies ?? []).filter((m) => m.in_force && m.banking_region === region);
  const monopolyOf = (good: string) => inForce.find((m) => m.commodity_id === good);
  const holderOf = (m: S.MonopolyResult): Holder =>
    m.holder_company_id === profile?.company.id ? "you" : ourIds.has(m.holder_company_id) ? "sibling" : "other";

  const ports = (catalog?.ports ?? [])
    .filter((p) => p.phase <= (clock?.unlocked_phase ?? 1))
    .sort((a, b) => Number(presence.has(b.id)) - Number(presence.has(a.id)) || a.name.localeCompare(b.name));
  const books = (book?.port_id === port ? book.books : []).slice().sort((a, b) => goodName(a.commodity_id).localeCompare(goodName(b.commodity_id)));
  const selected = books.find((b) => b.commodity_id === good) ?? null;

  return (
    <div className="space-y-5 pb-8 sm:space-y-6">
      <PageHeader
        title="Market"
        subtitle="Port order books, your resting orders and fills. Buyers pay customs; sellers don't."
        actions={
          <>
            <div className="w-full sm:w-64">
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
          </>
        }
      />

      <Tabs defaultValue="books">
        <TabsList>
          <TabsTab value="books">Books</TabsTab>
          <TabsTab value="orders">My orders</TabsTab>
          <TabsTab value="fills">Fills</TabsTab>
          <TabsTab value="batch">Batch</TabsTab>
        </TabsList>

        <TabsPanel value="books" className="space-y-4 pt-2">
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

          {inForce.length > 0 && <MonopolyBanner monopolies={inForce} holderOf={holderOf} region={region} />}

          {book && book.port_id === port && (
            <div className="grid items-start gap-4 xl:grid-cols-3">
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
                          <td className="font-medium">
                            {goodName(b.commodity_id)}
                            {monopolyOf(b.commodity_id) && (
                              <Badge
                                variant={holderOf(monopolyOf(b.commodity_id)!) === "you" ? "info" : "warning"}
                                size="sm"
                                className="ml-1.5"
                                title={`Royal monopoly: ${monopolyOf(b.commodity_id)!.holder_company_name}`}
                              >
                                {holderOf(monopolyOf(b.commodity_id)!) === "you" ? "your monopoly" : "monopoly"}
                              </Badge>
                            )}
                          </td>
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
                      autopilot={autopilot}
                      monopoly={monopolyOf(selected.commodity_id)}
                      holder={monopolyOf(selected.commodity_id) ? holderOf(monopolyOf(selected.commodity_id)!) : undefined}
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
        </TabsPanel>

        <TabsPanel value="orders" className="pt-2">
          <OrdersPanel />
        </TabsPanel>

        <TabsPanel value="fills" className="pt-2">
          <FillsPanel />
        </TabsPanel>

        <TabsPanel value="batch" className="pt-2">
          <BatchPanel
            defaultPort={port}
            ships={ships}
            maxPhase={clock?.unlocked_phase}
            autopilot={autopilot}
            onDone={() => {
              void reload();
              void reloadShips();
            }}
          />
        </TabsPanel>
      </Tabs>
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
