"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Empty, ErrorNote, KV, Loading, NativeSelect, PageHeader, Panel, Table } from "@/components/kibb/bits";
import { Field, GoodSelect, PortSelect } from "@/components/kibb/pickers";
import { Pager, PAGE_SIZE, Segmented, num, realTime, shortId, useCompanyId, useCursor, useTimeScale } from "@/components/kibb/naval-common";
import { BatchError, postBatch } from "@/components/kibb/trade-common";
import { useAction } from "@/hooks/use-action";
import { useCatalog } from "@/hooks/use-catalog";
import { usePoll } from "@/hooks/use-poll";
import { kibbGet, kibbPost } from "@/lib/kibb/browser";
import { fmtCr, fmtDateTime, fmtGameHours, fmtIn, fmtTons } from "@/lib/kibb/format";
import type * as S from "@/lib/kibb/schema";
import type { PortOrderBook } from "@/lib/kibb/types";

const MARGIN_BPS = 2_500;
const STATUSES: S.FuturesStatus[] = ["open", "active", "settled", "defaulted", "cancelled"];
const STATUS_VARIANT: Record<S.FuturesStatus, "info" | "success" | "secondary" | "error" | "outline"> = {
  open: "info",
  active: "success",
  settled: "secondary",
  defaulted: "error",
  cancelled: "outline",
};

const margin = (strikePence: number, tons: number) => Math.ceil((strikePence * tons * MARGIN_BPS) / 10_000);

function CreateFutures({ hubs, onDone }: { hubs: Set<string>; onDone: () => void }) {
  const { portName, goodName } = useCatalog();
  const [port, setPort] = useState("");
  const [good, setGood] = useState("");
  const [side, setSide] = useState<S.OrderSide>("bid");
  const [lot, setLot] = useState("10");
  const [strikeCr, setStrikeCr] = useState("");
  const [hours, setHours] = useState("30");
  const [basket, setBasket] = useState<S.CreateFuturesOrderRequest[]>([]);
  const [failedRow, setFailedRow] = useState<number | null>(null);
  const timeScale = useTimeScale();
  const one = useAction<S.FuturesContract>(onDone);
  const many = useAction<S.FuturesContract[]>(() => {
    setBasket([]);
    onDone();
  });

  function postBasket() {
    setFailedRow(null);
    void many.run(async () => {
      try {
        return await postBatch<S.FuturesContract[]>("/v1/future/create-batch", { orders: basket });
      } catch (e) {
        if (e instanceof BatchError) setFailedRow(e.batchIndex);
        throw e;
      }
    });
  }

  const { data: book, error: bookError } = usePoll(
    port && good ? () => kibbGet<PortOrderBook>("/v1/market/book", { port_id: port, commodity_id: good }) : null,
    30_000,
    [port, good],
  );
  const top = book?.port_id === port ? book.books.find((b) => b.commodity_id === good) : undefined;
  const bid = top?.best_bid?.price_pence;
  const ask = top?.best_ask?.price_pence;
  const mid = bid && ask ? Math.round((bid + ask) / 2) : (bid ?? ask);

  const tons = num(lot);
  const strike = Math.round(num(strikeCr) * 100);
  const h = num(hours);
  const inBand = !mid || (strike >= mid * 0.75 && strike <= mid * 1.25);
  const valid = hubs.has(port) && !!good && tons > 0 && Number.isInteger(tons) && strike > 0 && h >= 1 && h <= 1440;
  const order = (): S.CreateFuturesOrderRequest => ({
    port_id: port,
    commodity_id: good,
    side,
    lot_tons: tons,
    strike_price_pence: strike,
    matures_in_game_hours: Math.round(h),
  });

  return (
    <div className="space-y-3">
      <Segmented<S.OrderSide>
        value={side}
        onChange={setSide}
        options={[
          { value: "bid", label: "Buy forward" },
          { value: "ask", label: "Sell forward" },
        ]}
      />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Hub">
          <PortSelect value={port} onChange={setPort} placeholder="Choose a hub…" filter={(p) => hubs.has(p)} />
        </Field>
        <Field label="Good">
          <GoodSelect value={good} onChange={setGood} placeholder="Choose a good…" />
        </Field>
        <Field label="Lot (t)">
          <Input type="number" min={1} step={1} value={lot} onChange={(e) => setLot(e.target.value)} />
        </Field>
        <Field label="Strike (Cr/t)">
          <Input type="number" min={0.01} step={0.01} value={strikeCr} onChange={(e) => setStrikeCr(e.target.value)} />
        </Field>
        <Field label="Matures in (game h)" className="sm:col-span-2">
          <Input type="number" min={1} max={1440} value={hours} onChange={(e) => setHours(e.target.value)} />
        </Field>
      </div>
      <KV
        rows={[
          [
            "NPC mid",
            mid ? (
              <span>
                {fmtCr(mid, 2)} <span className="text-muted-foreground text-xs">(strike band {fmtCr(mid * 0.75, 2)}–{fmtCr(mid * 1.25, 2)})</span>
              </span>
            ) : bookError ? (
              <span className="text-muted-foreground text-xs">book hidden (no presence at this hub)</span>
            ) : (
              "—"
            ),
          ],
          ["Notional", valid ? fmtCr(strike * tons) : "—"],
          ["Your margin (25%)", valid ? fmtCr(margin(strike, tons)) : "—"],
          ["Matures", Number.isFinite(h) ? `${fmtGameHours(h)} from now (${realTime(h * 60, timeScale)})` : "—"],
        ]}
      />
      {!inBand && <ErrorNote error="The strike must be within ±25% of the hub's NPC mid." />}
      {mid && (
        <Button size="sm" variant="outline" onClick={() => setStrikeCr(String(mid / 100))}>
          Strike at mid
        </Button>
      )}
      <ErrorNote error={one.error} />
      {one.result && (
        <p className="text-sm">
          Posted: {one.result.side === "bid" ? "buy" : "sell"} {fmtTons(one.result.lot_tons)} {goodName(one.result.commodity_id)} at{" "}
          {portName(one.result.port_id)}, {fmtCr(one.result.strike_price_pence, 2)}/t, matures {fmtIn(one.result.matures_at)}.
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button className="flex-1" disabled={!valid || !inBand || one.busy} onClick={() => one.run(() => kibbPost<S.FuturesContract>("/v1/future/create", order()))}>
          {one.busy ? "Posting…" : "Post order"}
        </Button>
        <Button variant="outline" disabled={!valid || !inBand || basket.length >= 25} onClick={() => { setFailedRow(null); setBasket((b) => [...b, order()]); }}>
          Add to batch
        </Button>
      </div>

      {basket.length > 0 && (
        <div className="space-y-2 border-t pt-3">
          <div className="font-medium text-sm">Batch ({basket.length}/25, all or nothing)</div>
          <Table head={["Side", "Hub", "Good", "Lot", "Strike", ""]}>
            {basket.map((o, i) => (
              <tr key={i} className={i === failedRow ? "bg-destructive/10" : undefined}>
                <td>{o.side === "bid" ? "buy" : "sell"}</td>
                <td>{portName(o.port_id)}</td>
                <td>{goodName(o.commodity_id)}</td>
                <td className="tabular-nums">{fmtTons(o.lot_tons)}</td>
                <td className="tabular-nums">{fmtCr(o.strike_price_pence, 2)}</td>
                <td className="text-right">
                  <button type="button" className="text-muted-foreground text-xs hover:text-foreground" onClick={() => { setFailedRow(null); setBasket((b) => b.filter((_, j) => j !== i)); }}>
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </Table>
          <p className="text-muted-foreground text-xs">Margin locked: {fmtCr(basket.reduce((n, o) => n + margin(o.strike_price_pence, o.lot_tons), 0))}</p>
          <ErrorNote error={many.error} />
          {many.result && <p className="text-sm">Posted {many.result.length} orders.</p>}
          <Button className="w-full" disabled={many.busy} onClick={postBasket}>
            {many.busy ? "Posting…" : `Post ${basket.length} orders`}
          </Button>
        </div>
      )}
    </div>
  );
}

export default function FuturesPage() {
  const { catalog, portName, goodName } = useCatalog();
  const ourId = useCompanyId();
  const [port, setPort] = useState("");
  const [good, setGood] = useState("");
  const [status, setStatus] = useState<S.FuturesStatus | "">("open");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [failedId, setFailedId] = useState<string | null>(null);
  const pager = useCursor();
  const hubs = new Set((catalog?.ports ?? []).filter((p) => p.is_hub).map((p) => p.id));
  const { data: futures, error, reload } = usePoll(
    () => kibbGet<S.FuturesContract[]>("/v1/future/list", { port_id: port, commodity_id: good, status, cursor: pager.cursor, limit: PAGE_SIZE }),
    20_000,
    [port, good, status, pager.cursor],
  );
  const act = useAction<unknown>(() => {
    setPicked(new Set());
    void reload();
  });

  const refilter = () => {
    setPicked(new Set());
    setFailedId(null);
    pager.reset();
  };

  function acceptPicked() {
    const rows = pickedRows;
    if (!confirm(`Take the other side of ${rows.length} contracts, locking ${fmtCr(pickedMargin)} margin?`)) return;
    setFailedId(null);
    void act.run(async () => {
      try {
        return await postBatch<S.FuturesContract[]>("/v1/future/accept-batch", { futures_ids: rows.map((f) => f.id) });
      } catch (e) {
        const bad = e instanceof BatchError && e.batchIndex !== null ? rows[e.batchIndex] : undefined;
        if (!bad) throw e;
        setFailedId(bad.id);
        throw new Error(
          `Nothing was accepted: the ${fmtTons(bad.lot_tons)} ${goodName(bad.commodity_id)} contract at ${portName(bad.port_id)} was refused (${(e as Error).message.replace(/^Item \d+: /, "")}).`,
        );
      }
    });
  }
  const role = (f: S.FuturesContract) =>
    f.buyer_company_id === ourId ? "buyer" : f.seller_company_id === ourId ? "seller" : f.creator_company_id === ourId ? "creator" : null;
  const canAccept = (f: S.FuturesContract) => f.status === "open" && f.creator_company_id !== ourId;
  const matured = (f: S.FuturesContract) => Date.parse(f.matures_at) <= Date.now();
  const pickedRows = (futures ?? []).filter((f) => picked.has(f.id) && canAccept(f));
  const pickedMargin = pickedRows.reduce((n, f) => n + margin(f.strike_price_pence, f.lot_tons), 0);

  function accept(f: S.FuturesContract) {
    const mySide = f.side === "bid" ? "sell" : "buy";
    if (!confirm(`${mySide === "buy" ? "Buy" : "Sell"} ${f.lot_tons} t ${goodName(f.commodity_id)} at ${portName(f.port_id)} for ${fmtCr(f.strike_price_pence, 2)}/t at maturity, locking ${fmtCr(margin(f.strike_price_pence, f.lot_tons))} margin?`)) return;
    void act.run(() => kibbPost<S.FuturesContract>("/v1/future/accept", { futures_id: f.id }));
  }

  return (
    <div className="space-y-5 pb-8 sm:space-y-6">
      <PageHeader
        title="Futures"
        subtitle="Physical forward contracts at the regional hubs, settled from the parties' hub warehouses at maturity."
        actions={
          <>
            <div className="w-full sm:w-40">
              <PortSelect value={port} onChange={(v) => { setPort(v); refilter(); }} placeholder="All hubs" filter={(p) => hubs.has(p)} />
            </div>
            <div className="w-full sm:w-44">
              <GoodSelect value={good} onChange={(v) => { setGood(v); refilter(); }} placeholder="All goods" />
            </div>
            <div className="w-full sm:w-32">
              <NativeSelect value={status} onChange={(e) => { setStatus(e.target.value as S.FuturesStatus | ""); refilter(); }}>
                <option value="">Any status</option>
                {STATUSES.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </NativeSelect>
            </div>
          </>
        }
      />

      <div className="grid items-start gap-4 xl:grid-cols-3">
        <Panel title="Contracts" className="xl:col-span-2">
          <ErrorNote error={error} />
          {!futures ? (
            !error && <Loading />
          ) : futures.length === 0 ? (
            <Empty>No contracts.</Empty>
          ) : (
            <Table head={["", "Hub", "Good", "Offer", "Lot", "Strike", "Notional", "Status", "Matures", "You", ""]}>
              {futures.map((f) => {
                const r = role(f);
                return (
                  <tr key={f.id} className={f.id === failedId ? "bg-destructive/10" : undefined}>
                    <td>
                      {canAccept(f) && (
                        <input
                          type="checkbox"
                          checked={picked.has(f.id)}
                          onChange={(e) =>
                            setPicked((prev) => {
                              const next = new Set(prev);
                              if (e.target.checked) next.add(f.id);
                              else next.delete(f.id);
                              return next;
                            })
                          }
                        />
                      )}
                    </td>
                    <td>{portName(f.port_id)}</td>
                    <td>{goodName(f.commodity_id)}</td>
                    <td className="text-xs">{f.side === "bid" ? "wants to buy" : "wants to sell"}</td>
                    <td className="tabular-nums">{fmtTons(f.lot_tons)}</td>
                    <td className="tabular-nums">{fmtCr(f.strike_price_pence, 2)}</td>
                    <td className="tabular-nums">{fmtCr(f.strike_price_pence * f.lot_tons)}</td>
                    <td><Badge variant={STATUS_VARIANT[f.status]} size="sm">{f.status}</Badge></td>
                    <td className="text-xs" title={fmtDateTime(f.matures_at)}>{matured(f) ? "matured" : fmtIn(f.matures_at)}</td>
                    <td className="text-xs">{r ?? <span className="font-mono text-muted-foreground">{shortId(f.creator_company_id)}</span>}</td>
                    <td className="whitespace-nowrap text-right">
                      {canAccept(f) && (
                        <Button size="sm" disabled={act.busy} onClick={() => accept(f)}>
                          {f.side === "bid" ? "Sell to" : "Buy from"}
                        </Button>
                      )}
                      {f.status === "active" && (r === "buyer" || r === "seller") && matured(f) && (
                        <Button size="sm" variant="outline" disabled={act.busy} onClick={() => act.run(() => kibbPost<S.SettleFuturesResult>("/v1/future/settle", { futures_id: f.id }))}>
                          Settle
                        </Button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </Table>
          )}
          <Pager pager={pager} rows={futures} />
          {pickedRows.length > 0 && (
            <div className="mt-4 flex flex-wrap items-center gap-3 border-t pt-4">
              <span className="text-muted-foreground text-xs">
                {pickedRows.length} selected · margin {fmtCr(pickedMargin)}
              </span>
              <Button
                size="sm"
                disabled={act.busy || pickedRows.length > 25}
                onClick={acceptPicked}
              >
                Accept {pickedRows.length} (all or nothing)
              </Button>
              {pickedRows.length > 25 && <span className="text-destructive text-xs">At most 25 per batch.</span>}
            </div>
          )}
          <ErrorNote error={act.error} className="mt-3" />
          {act.result !== null && typeof act.result === "object" && "settled_tons" in act.result && (
            <p className="mt-2 text-sm">
              {(() => {
                const s = act.result as S.SettleFuturesResult;
                return `Settled ${fmtTons(s.settled_tons)}: ${s.status}${s.penalty_paid_pence ? `, penalty ${fmtCr(s.penalty_paid_pence)}` : ""}${s.claim_pence ? `, claim ${fmtCr(s.claim_pence)}` : ""}.`;
              })()}
            </p>
          )}
        </Panel>

        <div className="space-y-4">
          <Panel title="Post a futures order">
            <CreateFutures hubs={hubs} onDone={() => void reload()} />
          </Panel>
          <Panel title="How futures work">
            <ul className="list-disc space-y-1.5 pl-4 text-muted-foreground text-xs">
              <li>Hub ports only. The strike must sit within ±25% of the hub&apos;s NPC mid; maturity is 1–1,440 game hours (default 30).</li>
              <li>Both sides lock 25% of the notional as margin in their regional escrow.</li>
              <li>At maturity the goods move from the seller&apos;s hub warehouse to the buyer&apos;s, and the strike from buyer to seller: lease space and stock the hub warehouse beforehand.</li>
              <li>A defaulter forfeits its margin plus the adverse move; the rest becomes a claim. Either party may settle a matured contract early; the scheduler settles it otherwise.</li>
              <li>NPC houses use only public information and price poorly on purpose.</li>
            </ul>
          </Panel>
        </div>
      </div>
    </div>
  );
}
