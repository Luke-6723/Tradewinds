"use client";

import { useState } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, ErrorNote, Loading, Metrics, PageHeader, Panel, Table } from "@/components/kibb/bits";
import { LoadMore, usePaged } from "@/components/kibb/company-paged";
import { atPort } from "@/components/kibb/deals-common";
import { useShips } from "@/components/kibb/finance-common";
import { Segmented, useAutopilotShips } from "@/components/kibb/naval-common";
import { PortSelect } from "@/components/kibb/pickers";
import {
  AboardTable,
  OfferForm,
  OffersTable,
  PassengerRules,
  median,
  useCancelOffer,
  useFaresSummary,
  useOffers,
} from "@/components/kibb/passengers-common";
import { useCatalog } from "@/hooks/use-catalog";
import { usePoll } from "@/hooks/use-poll";
import { kibbGet } from "@/lib/kibb/browser";
import { fmtCr, fmtDateTime, fmtIn, fmtTons } from "@/lib/kibb/format";
import type * as S from "@/lib/kibb/schema";
import type { ShipResult } from "@/lib/kibb/types";

const KINDS: S.PassengerKind[] = ["travellers", "emigrants"];

function WaitingPanel({ ships, onOffer }: { ships: ShipResult[] | undefined; onOffer: (port: string, dest: string) => void }) {
  const { portName } = useCatalog();
  const lying = [...new Set((ships ?? []).filter(atPort).map((r) => r.ship.current_port_id as string))];
  const [picked, setPicked] = useState("");
  const port = picked || lying[0] || "";
  // Tagged with its port: a poll keeps its last answer across a change (and for good if the new read fails), never shown under another port.
  const { data: read, error } = usePoll(
    port ? () => kibbGet<S.WaitingGroupView[]>("/v1/passengers/waiting", { port_id: port }).then((groups) => ({ port, groups })) : null,
    60_000,
    [port],
  );
  const data = read && read.port === port ? read.groups : undefined;
  const groups = (data ?? []).filter((g) => g.origin_port_id === port).sort((a, b) => Date.parse(a.board_by) - Date.parse(b.board_by));
  const ours = lying.includes(port);
  return (
    <Panel
      title="Waiting for a passage"
      action={
        <div className="w-full sm:w-48">
          <PortSelect value={port} onChange={setPicked} placeholder="Choose a port…" />
        </div>
      }
    >
      <ErrorNote error={error} />
      {!port ? (
        <Empty>Choose a port to see the groups waiting there.</Empty>
      ) : !data ? (
        !error && <Loading />
      ) : groups.length === 0 ? (
        <Empty>No groups waiting at {portName(port)}.</Empty>
      ) : (
        <Table head={["Group", "Bound for", "Gives up", "Route unserved lately", ""]}>
          {groups.map((g) => (
            <tr key={g.id}>
              <td className="whitespace-nowrap">
                {g.size} {g.kind}
                {g.kind === "emigrants" && (
                  <Badge variant="info" size="sm" className="ml-1.5">
                    long haul
                  </Badge>
                )}
              </td>
              <td>{portName(g.dest_port_id)}</td>
              <td className="whitespace-nowrap text-xs">{fmtIn(g.board_by)}</td>
              <td className="whitespace-nowrap text-xs">
                {(g.route_unmet_groups ?? 0) > 0 ? (
                  <span title={`Groups of ${g.kind} on this route that gave up waiting without a passage lately: if no other ship offers for it, open high`}>
                    {g.route_unmet_groups} group{g.route_unmet_groups === 1 ? "" : "s"}, {g.route_unmet_heads} heads{" "}
                    <Badge variant="success" size="sm">
                      open high?
                    </Badge>
                  </span>
                ) : (
                  <span className="text-muted-foreground">none</span>
                )}
              </td>
              <td className="text-right">
                {ours && (
                  <Button size="sm" variant="outline" onClick={() => onOffer(port, g.dest_port_id)}>
                    Offer
                  </Button>
                )}
              </td>
            </tr>
          ))}
        </Table>
      )}
      <p className="mt-3 text-muted-foreground text-xs">
        A group boards whole or not at all, and gives up waiting at its time. What it will pay at most is never shown: the median of the route&apos;s length band
        is the guide. A route whose groups keep giving up unboarded may have nobody offering for it.
        {lying.length > 0 ? ` Your ships lie at ${lying.map(portName).join(", ")}.` : " None of your ships is in port."}
      </p>
    </Panel>
  );
}

function FaresPanel() {
  const { portName } = useCatalog();
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const page = usePaged<S.FareRecordView>(
    (cursor, limit) => kibbGet<S.FareRecordView[]>("/v1/passengers/fares", { from, to, cursor, limit }),
    [from, to],
    100,
  );
  const all = median(page.items.map((f) => f.fare_per_head_pence));
  const byKind = KINDS.map((k) => {
    const rows = page.items.filter((f) => f.kind === k);
    return { kind: k, n: rows.length, median: median(rows.map((f) => f.fare_per_head_pence)) };
  }).filter((x) => x.n > 0);
  return (
    <Panel
      title="Fares accepted"
      action={
        <>
          <div className="w-full sm:w-40">
            <PortSelect value={from} onChange={setFrom} placeholder="From any port" />
          </div>
          <div className="w-full sm:w-40">
            <PortSelect value={to} onChange={setTo} placeholder="To any port" />
          </div>
        </>
      }
    >
      <ErrorNote error={page.error} />
      {page.items.length > 0 && (
        <p className="mb-3 text-sm">
          Median {fmtCr(all, 2)} a head over {page.items.length} fare{page.items.length === 1 ? "" : "s"}
          {byKind.length > 1 && `: ${byKind.map((x) => `${x.kind} ${fmtCr(x.median, 2)} (${x.n})`).join(", ")}`}
          {from && to ? `, ${portName(from)} → ${portName(to)}` : ""}.
        </p>
      )}
      {page.items.length === 0 ? (
        page.loading ? <Loading /> : <Empty>No fares recorded{from || to ? " on this route" : ""}.</Empty>
      ) : (
        <Table head={["Accepted", "Group", "Route", "Length", "Fare / head", "Whole fare"]}>
          {page.items.map((f) => (
            <tr key={f.id}>
              <td className="whitespace-nowrap text-muted-foreground text-xs">{fmtDateTime(f.accepted_at)}</td>
              <td className="whitespace-nowrap">
                {f.size} {f.kind}
              </td>
              <td className="whitespace-nowrap text-xs">
                {portName(f.origin_port_id)} → {portName(f.dest_port_id)}
              </td>
              <td className="whitespace-nowrap text-xs tabular-nums">
                {f.route_nm != null ? `${f.route_nm.toLocaleString("en-GB")} nm` : "—"}
                {f.band && <div className="text-muted-foreground">{f.band}</div>}
              </td>
              <td className="tabular-nums">{fmtCr(f.fare_per_head_pence, 2)}</td>
              <td className="tabular-nums">{fmtCr(f.fare_per_head_pence * f.size)}</td>
            </tr>
          ))}
        </Table>
      )}
      <LoadMore loading={page.loading} done={page.done} onClick={page.loadMore} count={page.items.length} />
      <p className="mt-3 text-muted-foreground text-xs">
        Newest first, never who carried them. Each is what the cheapest ship asked, not what the group would have paid: judge a route by its length band&apos;s
        median below. A fast ship can ask a little more than these and still win; a slow one must be cheaper.
      </p>
    </Panel>
  );
}

/** The fares board's summary (guide 3.20): medians by route-length band, and routes where groups gave up waiting unboarded. */
function FaresSummaryPanel() {
  const { portName } = useCatalog();
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const { summary, error } = useFaresSummary(from, to);
  return (
    <Panel title="Fares by route length">
      <ErrorNote error={error} />
      {!summary ? (
        !error && <Loading />
      ) : (
        <div className="space-y-5">
          <div>
            <Table head={["Band", "Fares", "Heads", "Median / head"]}>
              {summary.bands.map((b) => (
                <tr key={b.band}>
                  <td className="whitespace-nowrap">{b.band}</td>
                  <td className="tabular-nums">{b.fares}</td>
                  <td className="tabular-nums">{b.heads}</td>
                  <td className="font-medium tabular-nums">{b.median_fare_per_head_pence != null ? fmtCr(b.median_fare_per_head_pence, 2) : "—"}</td>
                </tr>
              ))}
            </Table>
            <p className="mt-2 text-muted-foreground text-xs">
              Fares accepted over the last {summary.fares_window_game_days} game days (since {fmtDateTime(summary.fares_since)}), by the length of their route.
              Compare like with like: a long passage against its own band.
            </p>
          </div>
          <div>
            <div className="mb-2 flex flex-wrap items-end justify-between gap-2">
              <h3 className="font-medium text-muted-foreground text-xs">Routes where groups gave up waiting</h3>
              <div className="flex w-full flex-wrap gap-2 sm:w-auto">
                <div className="w-full sm:w-40">
                  <PortSelect value={from} onChange={setFrom} placeholder="From any port" />
                </div>
                <div className="w-full sm:w-40">
                  <PortSelect value={to} onChange={setTo} placeholder="To any port" />
                </div>
              </div>
            </div>
            {summary.unmet.length === 0 ? (
              <Empty>No group gave up unboarded{from || to ? " on these routes" : ""} lately.</Empty>
            ) : (
              <Table head={["Route", "Kind", "Groups", "Heads", "Length"]}>
                {summary.unmet.map((u) => (
                  <tr key={`${u.origin_port_id}>${u.dest_port_id}|${u.kind}`}>
                    <td className="whitespace-nowrap text-xs">
                      {portName(u.origin_port_id)} → {portName(u.dest_port_id)}
                    </td>
                    <td className="whitespace-nowrap">
                      {u.kind}
                      {u.kind === "emigrants" && (
                        <Badge variant="info" size="sm" className="ml-1.5">
                          long haul
                        </Badge>
                      )}
                    </td>
                    <td className="tabular-nums">{u.groups}</td>
                    <td className="tabular-nums">{u.heads}</td>
                    <td className="whitespace-nowrap text-xs tabular-nums">
                      {u.route_nm != null ? `${u.route_nm.toLocaleString("en-GB")} nm` : "—"}
                      {u.band && <div className="text-muted-foreground">{u.band}</div>}
                    </td>
                  </tr>
                ))}
              </Table>
            )}
            <p className="mt-2 text-muted-foreground text-xs">
              Most heads first, over the last {summary.unmet_window_game_days} game days. Where groups keep giving up and no other ship offers for that destination,
              nobody is competing: open well above the band median and step down after an unfilled round or two, stopping at the first fare taken.
            </p>
          </div>
        </div>
      )}
    </Panel>
  );
}

function AboardPanel({ ships }: { ships: ShipResult[] | undefined }) {
  const carrying = (ships ?? []).filter((r) => r.ship.status !== "sunk" && r.ship.passenger_hold_tons > 0);
  const key = carrying.map((r) => r.ship.id).join(",");
  const { data, error } = usePoll(
    key
      ? () =>
          Promise.all(
            key.split(",").map((id) =>
              kibbGet<S.AboardGroupView[]>("/v1/passengers/aboard", { ship_id: id }).then(
                (groups) => ({ id, groups, error: null as string | null }),
                (e: Error) => ({ id, groups: [] as S.AboardGroupView[], error: e.message }),
              ),
            ),
          )
      : null,
    30_000,
    [key],
  );
  const { portName } = useCatalog();
  return (
    <Panel title="Aboard your ships">
      <ErrorNote error={error} />
      {!ships ? (
        <Loading />
      ) : carrying.length === 0 ? (
        <Empty>No passengers aboard any of your ships.</Empty>
      ) : !data ? (
        !error && <Loading />
      ) : (
        <div className="space-y-4">
          {carrying.map((r) => {
            const row = data.find((x) => x.id === r.ship.id);
            return (
              <div key={r.ship.id}>
                <div className="mb-1 flex flex-wrap items-baseline gap-2 text-sm">
                  <Link href={`/fleet/${r.ship.id}`} className="font-medium hover:underline">
                    {r.ship.name}
                  </Link>
                  <span className="text-muted-foreground text-xs">
                    {r.ship.status === "sailing" ? `→ ${portName(r.route_legs.at(-1)?.to_node)}` : portName(r.ship.current_port_id)} · {fmtTons(r.ship.passenger_hold_tons)} of
                    hold
                  </span>
                </div>
                {row?.error ? <ErrorNote error={row.error} /> : <AboardTable groups={row?.groups ?? []} />}
              </div>
            );
          })}
        </div>
      )}
    </Panel>
  );
}

export default function PassengersPage() {
  const { data: ships, reload: reloadShips } = useShips();
  const autopilot = useAutopilotShips();
  const [openOnly, setOpenOnly] = useState(true);
  const { data: offers, error: offersError, reload: reloadOffers } = useOffers(openOnly);
  const { data: open, reload: reloadOpen } = useOffers(true);
  const [prefill, setPrefill] = useState<{ ship: string; dest: string; n: number }>({ ship: "", dest: "", n: 0 });
  const refresh = () => {
    void reloadOffers();
    void reloadOpen();
    void reloadShips();
  };
  const cancel = useCancelOffer(refresh);
  const shipName = (id: string) => ships?.find((r) => r.ship.id === id)?.ship.name ?? `ship ${id.slice(0, 8)}`;
  const carrying = (ships ?? []).filter((r) => r.ship.status !== "sunk" && r.ship.passenger_hold_tons > 0);

  return (
    <div className="space-y-5 pb-8 sm:space-y-6">
      <PageHeader
        title="Passengers"
        subtitle="Groups wait at ports for a passage. Offer a ship lying there, name the fare per head, and the groups choose: cheaper wins, and so does faster. Fares are an auction, paid on arrival."
      />
      <Metrics
        className="sm:grid-cols-3 xl:grid-cols-3"
        items={[
          { label: "Open offers", value: open ? String(open.length) : "…", hint: open ? `${open.reduce((n, o) => n + o.berths_taken, 0)} heads boarded on them` : undefined },
          { label: "Ships carrying passengers", value: ships ? String(carrying.length) : "…" },
          { label: "Hold they take", value: ships ? fmtTons(carrying.reduce((n, r) => n + r.ship.passenger_hold_tons, 0)) : "…", hint: "a ton a head, two to the ton in a packet" },
        ]}
      />
      <div className="grid items-start gap-4 xl:grid-cols-3">
        <div className="space-y-4 xl:col-span-2">
          <WaitingPanel
            ships={ships}
            onOffer={(port, dest) => {
              const r = (ships ?? []).find((x) => atPort(x) && x.ship.current_port_id === port);
              setPrefill((p) => ({ ship: r?.ship.id ?? "", dest, n: p.n + 1 }));
            }}
          />
          <Panel
            title="Your offers"
            action={
              <Segmented
                value={openOnly ? "open" : "all"}
                onChange={(v) => setOpenOnly(v === "open")}
                options={[
                  { value: "open", label: "Open" },
                  { value: "all", label: "All" },
                ]}
              />
            }
          >
            <ErrorNote error={offersError ?? cancel.error} />
            {!offers ? (
              !offersError && <Loading />
            ) : offers.length === 0 ? (
              <Empty>{openOnly ? "No open offers." : "You have never offered a passage."}</Empty>
            ) : (
              <OffersTable offers={offers} shipName={shipName} busy={cancel.busy} onCancel={(o) => cancel.cancel(o, shipName(o.ship_id))} />
            )}
            <p className="mt-3 text-muted-foreground text-xs">
              One open offer per ship and destination; a ship may hold offers for several. An offer closes when the ship sails, changes hands or is lost; a
              closed one shows why. Cancelling keeps the heads already aboard.
            </p>
          </Panel>
          <AboardPanel ships={ships} />
          <FaresSummaryPanel />
          <FaresPanel />
        </div>
        <div className="space-y-4">
          <Panel title="Offer a passage">
            <OfferForm
              key={prefill.n}
              ships={ships}
              initialShip={prefill.ship}
              initialDest={prefill.dest}
              autopilotShips={autopilot}
              openOffers={open}
              onDone={refresh}
            />
          </Panel>
          <Panel title="How passengers choose">
            <PassengerRules />
          </Panel>
        </div>
      </div>
    </div>
  );
}
