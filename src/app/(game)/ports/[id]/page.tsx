"use client";

import { useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, ErrorNote, KV, Loading, PageHeader, Panel, ShipStatusBadge, Table } from "@/components/kibb/bits";
import { FactorPanel, LeasePanel, PortEventsPanel } from "@/components/kibb/fleet-ui-port";
import { useCatalog } from "@/hooks/use-catalog";
import { usePoll } from "@/hooks/use-poll";
import { kibbGet } from "@/lib/kibb/browser";
import { fmtAgeSeconds, fmtAgo, fmtBps, fmtCr, fmtTons } from "@/lib/kibb/format";
import type { ContractListing, PortDetail, PortOrderBook, ShipResult } from "@/lib/kibb/types";

function GoodsList({ title, ids }: { title: string; ids: string[] | null | undefined }) {
  const { goodName } = useCatalog();
  return (
    <div>
      <div className="mb-1 text-muted-foreground text-xs">{title}</div>
      <div className="flex flex-wrap gap-1">
        {ids?.length ? ids.map((g) => <Badge key={g} variant="outline" size="sm">{goodName(g)}</Badge>) : <span className="text-sm">—</span>}
      </div>
    </div>
  );
}

export default function PortPage() {
  const { id } = useParams<{ id: string }>();
  const { catalog, portName, goodName, shipClassName } = useCatalog();
  const { data: port, error, reload } = usePoll(() => kibbGet<PortDetail>("/v1/world/port", { port_id: id }), 30_000, [id]);
  const visible = !!port && port.visibility !== "none";
  const { data: book } = usePoll(visible ? () => kibbGet<PortOrderBook>("/v1/market/book", { port_id: id }) : null, 30_000, [id, visible]);
  const { data: contracts } = usePoll(() => kibbGet<ContractListing[]>("/v1/contract/list", { port_id: id, status: "open", limit: 200 }), 60_000, [id]);
  const { data: ships } = usePoll(() => kibbGet<ShipResult[]>("/v1/fleet/ships", { port_id: id, limit: 200 }), 30_000, [id]);
  const [gossipPort, setGossipPort] = useState<string | null>(null);

  const cat = catalog?.ports.find((p) => p.id === id);
  if (!port) return error ? <ErrorNote error={error} /> : <Loading />;

  const gossip = (port.coffee_house_gossip ?? []).slice().sort((a, b) => a.age_seconds - b.age_seconds);
  const gossipShown = gossip.find((g) => g.subject_port_id === gossipPort) ?? null;
  const here = (contracts ?? []).filter((c) => c.origin_port_id === id);

  return (
    <div className="space-y-5 pb-8 sm:space-y-6">
      <PageHeader
        back={["/ports", "Ports"]}
        title={port.name}
        badges={
          <>
            {port.is_hub && <Badge variant="info">hub</Badge>}
            {port.has_shipyard && <Badge variant="outline">shipyard</Badge>}
            <Badge variant={visible ? "success" : "secondary"}>{port.visibility}</Badge>
          </>
        }
        subtitle={<span className="capitalize">{port.banking_region.replace(/_/g, " ")} · {portName(port.sea_zone_id)} · phase {port.phase}</span>}
        actions={
          <>
            {port.has_shipyard && (
              <Button variant="outline" render={<Link href="/fleet" />}>
                Shipyard →
              </Button>
            )}
            {visible && (
              <Button variant="outline" render={<Link href={`/market?port=${id}`} />}>
                Trade here →
              </Button>
            )}
          </>
        }
      />

      <div className="grid items-start gap-4 lg:grid-cols-3">
        <Panel title="Port">
          <KV
            rows={[
              ["Customs (base)", `${fmtBps(port.customs_bps)} (${fmtBps(port.base_customs_bps)})`],
              ["Berths", `${port.occupied_berths} / ${port.effective_berths} used (base ${port.base_berths})`],
              ["Queued for a berth", port.queued_ships],
              ["Berth dues", `${fmtCr(port.berth_dues_per_day_pence)} / game day (6 h minimum)`],
              ["Warehouses leased", `${fmtTons(port.total_leased_warehouse)} / ${fmtTons(port.total_warehouse_cap)}`],
              ["Health", fmtBps(port.health_score_bps)],
              ["Player volume (rolling)", `${fmtTons(port.rolling_player_volume_tons)} · ${fmtCr(port.rolling_player_turnover_pence)}`],
            ]}
          />
        </Panel>
        <Panel title="Trades" className="lg:col-span-2">
          <div className="space-y-3">
            <GoodsList title="Produces" ids={cat?.produces} />
            <GoodsList title="Manufactures" ids={cat?.manufactures} />
            <GoodsList title="Imports (pays more)" ids={cat?.imports} />
          </div>
        </Panel>
      </div>

      <div className="grid items-start gap-4 lg:grid-cols-3">
        <FactorPanel port={port} onChange={() => void reload()} />
        <LeasePanel port={port} onChange={() => void reload()} />
        <PortEventsPanel portId={id} />
      </div>

      <div className="grid items-start gap-4 lg:grid-cols-2">
        <Panel title="Your ships here">
          {!ships ? (
            <Loading />
          ) : ships.length === 0 ? (
            <Empty>None. A berthed or anchored ship gives quay visibility.</Empty>
          ) : (
            <Table head={["Ship", "Class", "Status", "Cargo"]}>
              {ships.map((r) => (
                <tr key={r.ship.id}>
                  <td><Link href={`/fleet/${r.ship.id}`} className="font-medium hover:underline">{r.ship.name}</Link></td>
                  <td className="text-muted-foreground">{shipClassName(r.ship.ship_class)}</td>
                  <td><ShipStatusBadge status={r.ship.status} /></td>
                  <td className="tabular-nums">{fmtTons(r.cargo_used_tons)}</td>
                </tr>
              ))}
            </Table>
          )}
        </Panel>
        <Panel title="Open contracts here">
          {!contracts ? (
            <Loading />
          ) : here.length === 0 ? (
            <Empty>{visible ? "None open." : "Local charters and freight are only listed with presence here."}</Empty>
          ) : (
            <Table head={["Type", "Good", "Remaining", "Pay", "To"]}>
              {here.map((c) => (
                <tr key={c.id}>
                  <td className="capitalize">
                    {c.contract_type}
                    {c.stale && <Badge variant="outline" size="sm" className="ml-1.5">gossip</Badge>}
                    {c.contract_type === "charter" && c.funded_by === "issuer" && <Badge variant="outline" size="sm" className="ml-1.5">player</Badge>}
                  </td>
                  {/* A commission is a hull built to order here (its price is the reward), never freight. */}
                  <td>{c.contract_type === "commission" ? `${shipClassName(c.ship_class)} hull` : goodName(c.commodity_id)}</td>
                  <td className="tabular-nums">{c.contract_type === "commission" ? "—" : fmtTons(c.remaining_quantity)}</td>
                  <td className="tabular-nums">
                    {c.contract_type === "charter"
                      ? `${fmtCr(c.reward_per_ton_pence ?? Math.floor(c.reward_pence / Math.max(1, c.quantity_required)), 2)}/t`
                      : c.contract_type === "commission"
                        ? `${fmtCr(c.reward_pence)} price (builder's collateral ${fmtCr(c.collateral_pence)})`
                        : `${fmtCr(c.reward_pence)} (collateral ${fmtCr(c.collateral_pence)})`}
                  </td>
                  <td>{c.contract_type === "freight" ? portName(c.dest_port_id) : "—"}</td>
                </tr>
              ))}
            </Table>
          )}
        </Panel>
      </div>

      {visible && book && (
        <Panel title={`Order book · ${book.visibility}${book.as_of ? ` · ${fmtAgo(book.as_of)}` : ""}`}>
          <Table head={["Good", "Best bid", "Best ask", "NPC stock"]}>
            {book.books.map((b) => (
              <tr key={b.commodity_id}>
                <td>{goodName(b.commodity_id)}</td>
                <td className="tabular-nums">{b.best_bid ? `${fmtCr(b.best_bid.price_pence, 2)} × ${b.best_bid.quantity}` : "—"}</td>
                <td className="tabular-nums">{b.best_ask ? `${fmtCr(b.best_ask.price_pence, 2)} × ${b.best_ask.quantity}` : "—"}</td>
                <td className="text-muted-foreground tabular-nums">{b.depth ? fmtTons(b.depth.npc_current_stock) : "—"}</td>
              </tr>
            ))}
          </Table>
        </Panel>
      )}

      {port.visibility === "quay" && (
        <div className="grid items-start gap-4 lg:grid-cols-2">
          <Panel title="Coffee house gossip">
            {gossip.length === 0 ? (
              <Empty>No news from other ports yet.</Empty>
            ) : (
              <div className="space-y-3">
                <div className="flex flex-wrap gap-1">
                  {gossip.map((g) => (
                    <button
                      key={g.subject_port_id}
                      type="button"
                      onClick={() => setGossipPort(g.subject_port_id)}
                      className={`rounded-md border px-2 py-1 text-xs ${gossipPort === g.subject_port_id ? "border-primary bg-accent" : "hover:bg-accent/50"}`}
                    >
                      {portName(g.subject_port_id)} <span className="text-muted-foreground">{fmtAgeSeconds(g.age_seconds)}</span>
                    </button>
                  ))}
                </div>
                {gossipShown ? (
                  <>
                    <Table head={["Good", "Stock", "Bid", "Ask", "Player bid", "Player ask"]}>
                      {gossipShown.commodities.map((c) => (
                        <tr key={c.commodity_id}>
                          <td>{goodName(c.commodity_id)}</td>
                          <td className="tabular-nums">{fmtTons(c.current_stock)}</td>
                          <td className="tabular-nums">{fmtCr(c.best_bid_pence, 2)}</td>
                          <td className="tabular-nums">{fmtCr(c.best_ask_pence, 2)}</td>
                          <td className="whitespace-nowrap tabular-nums">
                            {c.best_player_bid_pence ? `${fmtCr(c.best_player_bid_pence, 2)} × ${fmtTons(c.best_player_bid_quantity)}` : "—"}
                          </td>
                          <td className="whitespace-nowrap tabular-nums">
                            {c.best_player_ask_pence ? `${fmtCr(c.best_player_ask_pence, 2)} × ${fmtTons(c.best_player_ask_quantity)}` : "—"}
                          </td>
                        </tr>
                      ))}
                    </Table>
                    <p className="text-muted-foreground text-xs">
                      Player bid and ask: the best resting company order on each side when the crew saw it, and its tons. Anonymous: your own orders count.
                    </p>
                  </>
                ) : (
                  <Empty>Pick a port to see what crews reported there.</Empty>
                )}
              </div>
            )}
          </Panel>
          <Panel title="Recent sailings (24 game hours)">
            {(port.recent_sailings ?? []).length === 0 ? (
              <Empty>No traffic.</Empty>
            ) : (
              <Table head={["Ship", "Owner", "", "Load", "Seen"]}>
                {(port.recent_sailings ?? []).map((n, i) => (
                  <tr key={`${n.ship_name}-${n.seen_at}-${i}`}>
                    <td>
                      {n.ship_name} <span className="text-muted-foreground text-xs">{shipClassName(n.ship_class)}</span>
                    </td>
                    <td className="text-muted-foreground">{n.company_name}</td>
                    <td className="text-xs">
                      {n.direction === "sailed" ? `→ ${portName(n.other_port_id)}` : `← ${portName(n.other_port_id)}`}
                    </td>
                    <td className="text-xs">{n.load_state.replace("_", " ")}</td>
                    <td className="text-muted-foreground text-xs">{fmtAgo(n.seen_at)}</td>
                  </tr>
                ))}
              </Table>
            )}
          </Panel>
        </div>
      )}
    </div>
  );
}
