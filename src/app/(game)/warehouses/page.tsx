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
import type { CompanyProfile, PortDetail, PortVisibility, ShipResult, WorldClock } from "@/lib/kibb/types";

type Tier = { label: string; variant: "success" | "info" | "outline" };

const VISIBILITY: Record<PortVisibility, Tier> = {
  none: { label: "none", variant: "outline" },
  storage: { label: "storage", variant: "info" },
  counting_house: { label: "counting house", variant: "success" },
  quay: { label: "quay", variant: "success" },
};

/** The visibility a lease gives, while the port's own figure (which counts ships and factors too) loads. */
function tier(leased: number, port: PortDetail | undefined): Tier {
  if (port) return VISIBILITY[port.visibility] ?? VISIBILITY.none;
  return leased > 0 ? VISIBILITY.storage : VISIBILITY.none;
}

/** Whole tons from an input, 0 for anything else. */
const wholeTons = (v: string) => Math.max(0, Math.floor(Number(v) || 0));

function LeaseForm({
  port,
  wh,
  detail,
  ready,
  presence,
  onDone,
}: {
  port: string;
  wh: S.PortWarehouseResult | undefined;
  detail: PortDetail | undefined;
  /** The warehouse here has loaded (or is known not to exist). */
  ready: boolean;
  /** A ship berthed or anchored here, or a Resident Factor. */
  presence: boolean;
  onDone: () => void;
}) {
  const leased = wh?.leased_tonnage ?? 0;
  // The figure typed, kept through polls until the lease itself changes (a save lands); else the lease.
  const [draft, setDraft] = useState<number | null>(null);
  useEffect(() => setDraft(null), [port, leased]);
  const tons = draft ?? leased;
  const lease = useAction<S.PortWarehouseResult>(onDone);
  useEffect(() => lease.reset(), [port]); // eslint-disable-line react-hooks/exhaustive-deps

  // The server refuses a lease below what's stored or reserved, a bigger one without presence
  // (an existing lease counts), and one beyond the port's free warehouse space.
  const floor = (wh?.used_tonnage ?? 0) + (wh?.reserved_tonnage ?? 0);
  const spaceLeft = detail ? Math.max(0, detail.total_warehouse_cap - detail.total_leased_warehouse) : null;
  const max = spaceLeft === null ? null : spaceLeft + leased;
  const fill = detail && detail.total_warehouse_cap > 0 ? detail.total_leased_warehouse / detail.total_warehouse_cap : 0;
  const growing = tons > leased;
  const problem =
    tons < floor
      ? `${fmtTons(floor)} is stored or reserved here: the lease can't go below that.`
      : growing && !presence && leased === 0
        ? "Bring a ship here or hire a factor first: a lease needs presence in the port."
        : growing && max !== null && tons > max
          ? `The port has only ${fmtTons(spaceLeft ?? 0)} of warehouse space left: at most ${fmtTons(max)} for you.`
          : null;

  return (
    <div className="space-y-3">
      <KV
        rows={[
          ["Leased", fmtTons(leased)],
          ["Used / reserved", `${fmtTons(wh?.used_tonnage ?? 0)} / ${fmtTons(wh?.reserved_tonnage ?? 0)}`],
          ["Counting house from", detail ? fmtTons(detail.counting_house_min_lease_tons) : "—"],
          ["Port leased", detail ? `${fmtTons(detail.total_leased_warehouse)} of ${fmtTons(detail.total_warehouse_cap)} (${Math.round(fill * 100)}%)` : "—"],
          ["Port space left", spaceLeft === null ? "—" : fmtTons(spaceLeft)],
        ]}
      />
      <Field label="Lease (tons)">
        <Input
          type="number"
          min={floor}
          max={max ?? undefined}
          value={tons}
          onChange={(e) => setDraft(wholeTons(e.target.value))}
        />
      </Field>
      {ready && <ErrorNote error={problem} />}
      <ErrorNote error={lease.error} />
      {lease.result && <p className="text-sm">Lease now {fmtTons(lease.result.leased_tonnage)}.</p>}
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={!ready || lease.busy || tons === leased || !!problem}
          onClick={() => void lease.run(() => kibbPost<S.PortWarehouseResult>("/v1/warehouse/set-lease", { port_id: port, target_leased_tonnage: tons }))}
        >
          {!ready ? "Loading…" : lease.busy ? "Saving…" : tons === 0 && leased > 0 ? "End lease" : "Set lease"}
        </Button>
        {ready && leased > floor && (
          <Button variant="outline" disabled={lease.busy} onClick={() => setDraft(floor)}>
            Shrink to minimum
          </Button>
        )}
      </div>
      <p className="text-muted-foreground text-xs">
        A lease can grow only where you have presence (a ship berthed or anchored here, a Resident Factor, or a lease already) and
        while the port has warehouse space; it can&apos;t shrink below what&apos;s stored or reserved. Rent is billed every game day
        from your vault in this port&apos;s region, dearer when the port is congested; unused leased tons cost triple once the port
        is over 70% leased{fill > 0.7 ? " (it is now)" : ""}. Any lease gives storage visibility (a daily snapshot of the best
        bid/ask); a lease of at least the counting-house figure gives the live best bid/ask.
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
const freshRows = (): Row[] => [{ key: ++rowSeq, good: "", qty: 1 }];

function TransferForm({
  port,
  wh,
  noWarehouse,
  ships,
  autopilot,
  onDone,
}: {
  port: string;
  wh: S.PortWarehouseResult | undefined;
  /** No lease here (the warehouse lookup said so). */
  noWarehouse: boolean;
  ships: ShipResult[] | undefined;
  autopilot: Set<string>;
  onDone: () => void;
}) {
  const { goodName } = useCatalog();
  const berthed = (ships ?? []).filter((r) => r.ship.status === "berthed" && r.ship.current_port_id === port);
  const [shipId, setShipId] = useState("");
  const [dir, setDir] = useState<"load" | "unload">("unload");
  const [rows, setRows] = useState<Row[]>(freshRows);
  const move = useAction<S.ShipWarehouseTransferResult>(() => {
    setRows(freshRows());
    onDone();
  });
  const sealed = useSealedTons();

  useEffect(() => {
    if (!berthed.some((r) => r.ship.id === shipId)) setShipId(berthed[0]?.ship.id ?? "");
  }, [port, berthed.map((r) => r.ship.id).join(",")]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setRows(freshRows());
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
  const have = (good: string) => source.find(([g]) => g === good)?.[1] ?? 0;
  // Where it goes: the hold's free space, or the warehouse's free leased space.
  const room = dir === "load" ? (ship ? Math.max(0, ship.effective_hold_capacity_tons - ship.cargo_used_tons) : 0) : (wh?.free_tonnage ?? 0);
  const noLease = dir === "unload" && (noWarehouse || (!!wh && wh.leased_tonnage === 0));
  const tons = rows.reduce((n, r) => n + (r.good ? r.qty : 0), 0);
  // Each good is chosen once (other rows' goods are left out of a row's choices), so a row's tons are all of that good.
  const ready = !!ship && !!wh && !noLease && tons > 0 && tons <= room && rows.every((r) => r.good && r.qty >= 1 && r.qty <= have(r.good));

  function setRow(key: number, patch: Partial<Row>) {
    setRows((rs) =>
      rs.map((x) => {
        if (x.key !== key) return x;
        const next = { ...x, ...patch };
        // Clamped to what's there to move.
        const max = have(next.good);
        return max > 0 ? { ...next, qty: Math.min(next.qty, max) } : next;
      }),
    );
  }

  function submit() {
    const body =
      rows.length === 1
        ? { ship_id: shipId, commodity_id: rows[0].good, quantity: rows[0].qty }
        : { ship_id: shipId, items: rows.map((r) => ({ commodity_id: r.good, quantity: r.qty })) };
    void move.run(() => kibbPost<S.ShipWarehouseTransferResult>(`/v1/warehouse/${dir === "load" ? "load-ship" : "unload-ship"}`, body));
  }

  if (berthed.length === 0) return <Empty>Berth a ship here to load or unload. Transfers need a berthed ship.</Empty>;

  const chosen = new Set(rows.map((r) => r.good).filter(Boolean));
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
              setRows(freshRows());
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
      {noLease ? (
        <Empty>Lease space here first: unloading needs free leased warehouse tons.</Empty>
      ) : source.length === 0 ? (
        <Empty>{dir === "load" ? "Nothing unlocked in this warehouse." : "The hold is empty."}</Empty>
      ) : (
        <>
          {rows.map((r) => {
            const max = have(r.good);
            return (
              <div key={r.key} className="grid grid-cols-[1fr_6rem_auto] items-end gap-2">
                <Field label="Good">
                  <NativeSelect value={r.good} onChange={(e) => setRow(r.key, { good: e.target.value })}>
                    <option value="">Choose…</option>
                    {source
                      .filter(([g]) => g === r.good || !chosen.has(g))
                      .map(([g, q]) => (
                        <option key={g} value={g}>
                          {goodName(g)} ({fmtTons(q)})
                        </option>
                      ))}
                  </NativeSelect>
                </Field>
                <Field label={max > 0 ? `Tons (max ${max})` : "Tons"}>
                  <Input
                    type="number"
                    min={1}
                    max={max || undefined}
                    value={r.qty}
                    onChange={(e) => setRow(r.key, { qty: Math.max(1, wholeTons(e.target.value)) })}
                  />
                </Field>
                <Button size="sm" variant="ghost" disabled={rows.length === 1} onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}>
                  Remove
                </Button>
              </div>
            );
          })}
          <Button
            size="sm"
            variant="outline"
            disabled={rows.length >= source.length}
            onClick={() => setRows((rs) => [...rs, { key: ++rowSeq, good: "", qty: 1 }])}
          >
            Add good
          </Button>
        </>
      )}
      {!noLease && ship && (wh || dir === "load") && tons > room && (
        <ErrorNote error={`Only ${fmtTons(room)} free ${dir === "load" ? "in the hold" : "in the warehouse"}.`} />
      )}
      <ErrorNote error={move.error} />
      {move.result && (
        <p className="text-sm">
          Moved {move.result.items_transferred.map((i) => `${i.quantity} t ${goodName(i.commodity_id)}`).join(", ")}
          {move.result.turnaround_unlocks_at && `; ship free to sail ${fmtIn(move.result.turnaround_unlocks_at)}`}.
        </p>
      )}
      <Button disabled={!ready || move.busy} onClick={submit}>
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
  const { data: ships, error: shipsError, reload: reloadShips } = usePoll(() => kibbGet<ShipResult[]>("/v1/fleet/ships", { limit: 200 }), 15_000);
  const { data: profile } = usePoll(() => kibbGet<CompanyProfile>("/v1/company/profile"));
  const { data: clock } = usePoll(() => kibbGet<WorldClock>("/v1/world/clock"));
  const autopilot = useAutopilotShips();
  const [port, setPort] = useState("");

  const listPorts = (list ?? []).map((w) => w.port_id).join(",");
  // Port details (visibility, counting-house threshold, warehouse space) of every warehouse port and the one picked.
  const { data: details, reload: reloadDetails } = usePoll(
    list || listError || port
      ? async () => {
          const ids = [...new Set([...(list ?? []).map((w) => w.port_id), ...(port ? [port] : [])])];
          const ds = await Promise.all(ids.map((id) => kibbGet<PortDetail>("/v1/world/port", { port_id: id }).catch(() => null)));
          return Object.fromEntries(ds.filter((d): d is PortDetail => !!d).map((d) => [d.id, d]));
        }
      : null,
    60_000,
    [listPorts, port],
  );

  // Default to a port with a lease, else any warehouse, else where a ship is, else home.
  useEffect(() => {
    if (port || (!list && !listError)) return;
    const fromList = list?.find((w) => w.leased_tonnage > 0)?.port_id ?? list?.[0]?.port_id;
    const fromShips = ships?.find((r) => r.ship.status === "berthed" || r.ship.status === "anchored_roadstead")?.ship.current_port_id;
    if (!fromList && !fromShips && !ships && !shipsError) return;
    const first = fromList ?? fromShips ?? profile?.company.home_port_id;
    if (first) setPort(first);
  }, [port, list, listError, ships, shipsError, profile]);

  const { data: wh, error: whError, reload: reloadWh } = usePoll(
    port ? () => kibbGet<S.PortWarehouseResult>("/v1/warehouse/inventory", { port_id: port }) : null,
    30_000,
    [port],
  );
  const reloadAll = () => {
    void reloadList();
    void reloadWh();
    void reloadShips();
    void reloadDetails();
  };
  const noWarehouse = !!whError && ["not_found", "no_port_presence"].includes((whError as { code?: string }).code ?? "");
  const current = wh?.port_id === port ? wh : undefined;
  const detail = details?.[port];
  // Quay visibility means a ship berthed or anchored here, or a Resident Factor.
  const presence =
    !!current?.has_factor ||
    detail?.visibility === "quay" ||
    (ships ?? []).some((r) => r.ship.current_port_id === port && (r.ship.status === "berthed" || r.ship.status === "anchored_roadstead"));

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
            <LeaseForm port={port} wh={current} detail={detail} ready={!!current || noWarehouse} presence={presence} onDone={reloadAll} />
          </Panel>
          <Panel title="Ship ⇄ warehouse">
            <TransferForm port={port} wh={current} noWarehouse={noWarehouse} ships={ships} autopilot={autopilot} onDone={reloadAll} />
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
