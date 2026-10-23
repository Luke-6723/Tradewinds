"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Empty, ErrorNote, KV, Loading, NativeSelect, PageHeader, Panel, Table } from "@/components/kibb/bits";
import { Field, PortSelect, ShipSelect } from "@/components/kibb/pickers";
import { AutopilotWarning, useAutopilotShips, useSealedTons } from "@/components/kibb/trade-common";
import { useAction } from "@/hooks/use-action";
import { useCatalog } from "@/hooks/use-catalog";
import { usePoll } from "@/hooks/use-poll";
import { kibbGet, kibbPost } from "@/lib/kibb/browser";
import { fmtCr, fmtIn, fmtTons } from "@/lib/kibb/format";
import type * as S from "@/lib/kibb/schema";
import type { CompanyProfile, PortDetail, ShipResult, WorldClock } from "@/lib/kibb/types";

function tier(leased: number, port: PortDetail | undefined): { label: string; variant: "success" | "info" | "outline" } {
  if (leased <= 0) return { label: "none", variant: "outline" };
  if (port && leased >= port.counting_house_min_lease_tons) return { label: "counting house", variant: "success" };
  return { label: "storage", variant: "info" };
}

function LeaseForm({ port, wh, detail, onDone }: { port: string; wh: S.PortWarehouseResult | undefined; detail: PortDetail | undefined; onDone: () => void }) {
  const [tons, setTons] = useState(0);
  const lease = useAction<S.PortWarehouseResult>(onDone);
  useEffect(() => {
    setTons(wh?.leased_tonnage ?? 0);
    lease.reset();
  }, [port, wh?.leased_tonnage]); // eslint-disable-line react-hooks/exhaustive-deps

  const used = (wh?.used_tonnage ?? 0) + (wh?.reserved_tonnage ?? 0);
  const fill = detail && detail.total_warehouse_cap > 0 ? detail.total_leased_warehouse / detail.total_warehouse_cap : 0;

  return (
    <div className="space-y-3">
      <KV
        rows={[
          ["Leased", fmtTons(wh?.leased_tonnage ?? 0)],
          ["Used / reserved", `${fmtTons(wh?.used_tonnage ?? 0)} / ${fmtTons(wh?.reserved_tonnage ?? 0)}`],
          ["Counting house from", detail ? fmtTons(detail.counting_house_min_lease_tons) : "—"],
          ["Port leased", detail ? `${fmtTons(detail.total_leased_warehouse)} of ${fmtTons(detail.total_warehouse_cap)} (${Math.round(fill * 100)}%)` : "—"],
        ]}
      />
      <Field label="Lease (tons)">
        <Input type="number" min={0} value={tons} onChange={(e) => setTons(Math.max(0, Math.floor(Number(e.target.value))))} />
      </Field>
      {tons < used && <ErrorNote error={`${fmtTons(used)} is in use or reserved here; a smaller lease is likely refused.`} />}
      <ErrorNote error={lease.error} />
      {lease.result && <p className="text-sm">Lease now {fmtTons(lease.result.leased_tonnage)}.</p>}
      <Button
        disabled={lease.busy || tons === (wh?.leased_tonnage ?? 0)}
        onClick={() => void lease.run(() => kibbPost<S.PortWarehouseResult>("/v1/warehouse/set-lease", { port_id: port, target_leased_tonnage: tons }))}
      >
        {lease.busy ? "Saving…" : tons === 0 && (wh?.leased_tonnage ?? 0) > 0 ? "End lease" : "Set lease"}
      </Button>
      <p className="text-muted-foreground text-xs">
        You need presence here first (a ship in port or a factor). Rent is billed every game day from your vault in this port&apos;s
        region, dearer when the port is congested; unused leased tons cost triple once the port is over 70% leased{fill > 0.7 ? " (it is now)" : ""}.
        Any lease gives storage visibility (a daily snapshot of the best bid/ask); a lease of at least the counting-house figure gives the
        live best bid/ask.
      </p>
    </div>
  );
}

interface Row {
  key: number;
  good: string;
  qty: number;
}
let rowSeq = 0;

function TransferForm({
  port,
  wh,
  ships,
  autopilot,
  onDone,
}: {
  port: string;
  wh: S.PortWarehouseResult | undefined;
  ships: ShipResult[] | undefined;
  autopilot: Set<string>;
  onDone: () => void;
}) {
  const { goodName } = useCatalog();
  const berthed = (ships ?? []).filter((r) => r.ship.status === "berthed" && r.ship.current_port_id === port);
  const [shipId, setShipId] = useState("");
  const [dir, setDir] = useState<"load" | "unload">("unload");
  const [rows, setRows] = useState<Row[]>(() => [{ key: ++rowSeq, good: "", qty: 1 }]);
  const move = useAction<S.ShipWarehouseTransferResult>(onDone);
  const sealed = useSealedTons();

  useEffect(() => {
    if (!berthed.some((r) => r.ship.id === shipId)) setShipId(berthed[0]?.ship.id ?? "");
  }, [port, berthed.map((r) => r.ship.id).join(",")]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setRows([{ key: ++rowSeq, good: "", qty: 1 }]);
    move.reset();
  }, [port, shipId]); // eslint-disable-line react-hooks/exhaustive-deps

  const ship = berthed.find((r) => r.ship.id === shipId);
  // What can move: unlocked warehouse stock to load, our own cargo aboard to unload (sealed freight stays aboard).
  const source: Array<[string, number]> =
    dir === "load"
      ? (wh?.inventory ?? []).map((i) => [i.commodity_id, i.quantity - i.locked_quantity] as [string, number]).filter(([, q]) => q > 0)
      : Object.entries(ship?.cargo_manifest ?? {})
          .map(([g, q]) => [g, q - sealed(shipId, g)] as [string, number])
          .filter(([, q]) => q > 0);
  const tons = rows.reduce((n, r) => n + (r.good ? r.qty : 0), 0);
  const ready = !!ship && rows.length > 0 && rows.every((r) => r.good && r.qty >= 1);

  function submit() {
    const body =
      rows.length === 1
        ? { ship_id: shipId, commodity_id: rows[0].good, quantity: rows[0].qty }
        : { ship_id: shipId, items: rows.map((r) => ({ commodity_id: r.good, quantity: r.qty })) };
    void move.run(() => kibbPost<S.ShipWarehouseTransferResult>(`/v1/warehouse/${dir === "load" ? "load-ship" : "unload-ship"}`, body));
  }

  if (berthed.length === 0) return <Empty>Berth a ship here to load or unload. Transfers need a berthed ship.</Empty>;

  return (
    <div className="space-y-3">
      <div className="flex gap-1 rounded-lg bg-muted p-0.5">
        {(
          [
            ["unload", "Ship → warehouse"],
            ["load", "Warehouse → ship"],
          ] as const
        ).map(([d, label]) => (
          <button
            key={d}
            type="button"
            onClick={() => {
              setDir(d);
              setRows([{ key: ++rowSeq, good: "", qty: 1 }]);
              move.reset();
            }}
            className={`flex-1 rounded-md py-1 font-medium text-sm ${dir === d ? "bg-background shadow-sm" : "text-muted-foreground"}`}
          >
            {label}
          </button>
        ))}
      </div>
      <Field label="Ship">
        <ShipSelect value={shipId} onChange={setShipId} ships={berthed} />
      </Field>
      {ship && autopilot.has(ship.ship.id) && <AutopilotWarning shipName={ship.ship.name} />}
      {source.length === 0 ? (
        <Empty>{dir === "load" ? "Nothing unlocked in this warehouse." : "The hold is empty."}</Empty>
      ) : (
        <>
          {rows.map((r) => {
            const have = source.find(([g]) => g === r.good)?.[1] ?? 0;
            return (
              <div key={r.key} className="grid grid-cols-[1fr_6rem_auto] items-end gap-2">
                <Field label="Good">
                  <NativeSelect value={r.good} onChange={(e) => setRows((rs) => rs.map((x) => (x.key === r.key ? { ...x, good: e.target.value } : x)))}>
                    <option value="">Choose…</option>
                    {source.map(([g, q]) => (
                      <option key={g} value={g}>
                        {goodName(g)} ({fmtTons(q)})
                      </option>
                    ))}
                  </NativeSelect>
                </Field>
                <Field label="Tons">
                  <Input
                    type="number"
                    min={1}
                    max={have || undefined}
                    value={r.qty}
                    onChange={(e) =>
                      setRows((rs) => rs.map((x) => (x.key === r.key ? { ...x, qty: Math.max(1, Math.floor(Number(e.target.value))) } : x)))
                    }
                  />
                </Field>
                <Button size="sm" variant="ghost" disabled={rows.length === 1} onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}>
                  Remove
                </Button>
              </div>
            );
          })}
          <Button size="sm" variant="outline" onClick={() => setRows((rs) => [...rs, { key: ++rowSeq, good: "", qty: 1 }])}>
            Add good
          </Button>
        </>
      )}
      {dir === "load" && ship && tons > ship.effective_hold_capacity_tons - ship.cargo_used_tons && (
        <ErrorNote error={`Only ${fmtTons(ship.effective_hold_capacity_tons - ship.cargo_used_tons)} free in the hold.`} />
      )}
      {dir === "unload" && wh && tons > wh.free_tonnage && <ErrorNote error={`Only ${fmtTons(wh.free_tonnage)} free in the warehouse.`} />}
      <ErrorNote error={move.error} />
      {move.result && (
        <p className="text-sm">
          Moved {move.result.items_transferred.map((i) => `${i.quantity} t ${goodName(i.commodity_id)}`).join(", ")}
          {move.result.turnaround_unlocks_at && `; ship free to sail ${fmtIn(move.result.turnaround_unlocks_at)}`}.
        </p>
      )}
      <Button disabled={!ready || move.busy || source.length === 0} onClick={submit}>
        {move.busy ? "Moving…" : `${dir === "load" ? "Load" : "Unload"} ${tons} t`}
      </Button>
      <p className="text-muted-foreground text-xs">
        Each ton moved across the quay adds 2 game minutes (1 at hubs) to the ship&apos;s turnaround lock. Sealed freight can&apos;t be
        unloaded.
      </p>
    </div>
  );
}

export default function WarehousesPage() {
  const { portName, goodName } = useCatalog();
  const { data: list, error: listError, reload: reloadList } = usePoll(() => kibbGet<S.PortWarehouseResult[]>("/v1/warehouse/list"), 30_000);
  const { data: ships, reload: reloadShips } = usePoll(() => kibbGet<ShipResult[]>("/v1/fleet/ships", { limit: 200 }), 15_000);
  const { data: profile } = usePoll(() => kibbGet<CompanyProfile>("/v1/company/profile"));
  const { data: clock } = usePoll(() => kibbGet<WorldClock>("/v1/world/clock"));
  const autopilot = useAutopilotShips();
  const [port, setPort] = useState("");

  const listPorts = (list ?? []).map((w) => w.port_id).join(",");
  // Port details for the counting-house threshold of every warehouse port.
  const { data: details } = usePoll(
    list
      ? async () => {
          const ids = [...new Set([...(list ?? []).map((w) => w.port_id), ...(port ? [port] : [])])];
          const ds = await Promise.all(ids.map((id) => kibbGet<PortDetail>("/v1/world/port", { port_id: id }).catch(() => null)));
          return Object.fromEntries(ds.filter((d): d is PortDetail => !!d).map((d) => [d.id, d]));
        }
      : null,
    60_000,
    [listPorts, port],
  );

  // Default to a warehouse port, else where a ship is, else home.
  useEffect(() => {
    if (port) return;
    const first = list?.[0]?.port_id ?? ships?.find((r) => r.ship.current_port_id)?.ship.current_port_id ?? profile?.company.home_port_id;
    if (first) setPort(first);
  }, [port, list, ships, profile]);

  const { data: wh, error: whError, reload: reloadWh } = usePoll(
    port ? () => kibbGet<S.PortWarehouseResult>("/v1/warehouse/inventory", { port_id: port }) : null,
    30_000,
    [port],
  );
  const reloadAll = () => {
    void reloadList();
    void reloadWh();
    void reloadShips();
  };
  const noWarehouse = whError && ["not_found", "no_port_presence"].includes((whError as { code?: string }).code ?? "");
  const current = wh?.port_id === port ? wh : undefined;

  return (
    <div className="space-y-5 pb-8 sm:space-y-6">
      <PageHeader
        title="Warehouses"
        subtitle="Leased space in port: trade without a ship, rest GTC orders, stage freight, and see the book from afar."
        actions={
          <>
            <div className="w-full sm:w-64">
              <PortSelect value={port} onChange={setPort} maxPhase={clock?.unlocked_phase} />
            </div>
          </>
        }
      />

      <Panel title="Your warehouses">
        {!list ? (
          listError ? <ErrorNote error={listError} /> : <Loading />
        ) : list.length === 0 ? (
          <Empty>No leases yet. Pick a port where you have a ship or factor and set a lease below.</Empty>
        ) : (
          <Table head={["Port", "Leased", "Used", "Reserved", "Free", "Goods", "Visibility", "Factor"]}>
            {list.map((w) => {
              const t = tier(w.leased_tonnage, details?.[w.port_id]);
              return (
                <tr
                  key={w.port_id}
                  onClick={() => setPort(w.port_id)}
                  className={`cursor-pointer hover:bg-accent/50 ${w.port_id === port ? "bg-accent" : ""}`}
                >
                  <td className="font-medium">{portName(w.port_id)}</td>
                  <td className="tabular-nums">{fmtTons(w.leased_tonnage)}</td>
                  <td className="tabular-nums">{fmtTons(w.used_tonnage)}</td>
                  <td className="text-muted-foreground tabular-nums">{fmtTons(w.reserved_tonnage)}</td>
                  <td className="tabular-nums">{fmtTons(w.free_tonnage)}</td>
                  <td className="text-muted-foreground">{w.inventory.filter((i) => i.quantity > 0).length || "—"}</td>
                  <td>
                    <Badge variant={t.variant} size="sm">
                      {t.label}
                    </Badge>
                  </td>
                  <td>{w.has_factor ? "yes" : "—"}</td>
                </tr>
              );
            })}
          </Table>
        )}
      </Panel>

      {port && (
        <div className="grid items-start gap-4 lg:grid-cols-3">
          <Panel
            title={`Inventory · ${portName(port)}`}
            action={
              <Link href={`/market?port=${port}`} className="text-muted-foreground text-xs hover:text-foreground">
                Market →
              </Link>
            }
          >
            {noWarehouse || (current && current.inventory.length === 0) ? (
              <Empty>Nothing stored here.</Empty>
            ) : whError ? (
              <ErrorNote error={whError} />
            ) : !current ? (
              <Loading />
            ) : (
              <Table head={["Good", "Tons", "Locked", "Value at base"]}>
                {current.inventory.map((i) => (
                  <InventoryRow key={i.commodity_id} item={i} name={goodName(i.commodity_id)} />
                ))}
              </Table>
            )}
            <p className="mt-3 text-muted-foreground text-xs">Locked tons back resting asks and listed freight.</p>
          </Panel>
          <Panel title="Lease">
            <LeaseForm port={port} wh={current} detail={details?.[port]} onDone={reloadAll} />
          </Panel>
          <Panel title="Ship ⇄ warehouse">
            <TransferForm port={port} wh={current} ships={ships} autopilot={autopilot} onDone={reloadAll} />
          </Panel>
        </div>
      )}
    </div>
  );
}

function InventoryRow({ item, name }: { item: S.WarehouseInventory; name: string }) {
  const { catalog } = useCatalog();
  const base = catalog?.commodities.find((c) => c.id === item.commodity_id)?.base_price_pence ?? 0;
  return (
    <tr>
      <td className="font-medium">{name}</td>
      <td className="tabular-nums">{fmtTons(item.quantity)}</td>
      <td className="text-muted-foreground tabular-nums">{item.locked_quantity ? fmtTons(item.locked_quantity) : "—"}</td>
      <td className="text-muted-foreground tabular-nums">{fmtCr(base * item.quantity)}</td>
    </tr>
  );
}
