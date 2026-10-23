"use client";

import { useState } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsPanel, TabsTab } from "@/components/ui/tabs";
import { Empty, ErrorNote, KV, Loading, NativeSelect, PageHeader, Panel, Table } from "@/components/kibb/bits";
import { Field, GoodSelect, PortSelect, ShipSelect } from "@/components/kibb/pickers";
import {
  AutopilotWarning,
  BatchError,
  LoadMore,
  postBatch,
  toPence,
  useAutopilotShips,
  usePaged,
  useSealedTons,
} from "@/components/kibb/trade-common";
import { useAction } from "@/hooks/use-action";
import { useCatalog } from "@/hooks/use-catalog";
import { usePoll } from "@/hooks/use-poll";
import { kibbGet, kibbPost } from "@/lib/kibb/browser";
import { fmtAgo, fmtCr, fmtDateTime, fmtIn, fmtTons } from "@/lib/kibb/format";
import type * as S from "@/lib/kibb/schema";
import type { CompanyProfile, ShipResult, WorldClock } from "@/lib/kibb/types";

const AT_PORT = new Set(["berthed", "anchored_roadstead"]);
const STATUSES: S.ContractStatus[] = ["open", "active", "completed", "cancelled", "defaulted"];

function payPerTon(c: S.ContractListing): number {
  return c.reward_per_ton_pence ?? (c.quantity_required ? Math.round(c.reward_pence / c.quantity_required) : 0);
}

function targetPhase(c: S.ContractListing): number | null {
  const m = c.metadata as { target_phase?: number } | null;
  return typeof m?.target_phase === "number" ? m.target_phase : null;
}

function Refresh({ onClick, loading }: { onClick: () => void; loading: boolean }) {
  return (
    <Button size="sm" variant="outline" disabled={loading} onClick={onClick}>
      {loading ? "Loading…" : "Refresh"}
    </Button>
  );
}

// ── Charters ──────────────────────────────────────────────────────────────────

interface CharterPlan {
  ship: string;
  qty: number;
}

function ChartersTab({ ships, autopilot, onDone }: { ships: ShipResult[] | undefined; autopilot: Set<string>; onDone: () => void }) {
  const { portName, goodName } = useCatalog();
  const [port, setPort] = useState("");
  const [good, setGood] = useState("");
  const [status, setStatus] = useState<string>("open");
  const [plan, setPlan] = useState<Record<string, CharterPlan>>({});
  const sealed = useSealedTons();
  const [failed, setFailed] = useState<number | null>(null);
  const list = usePaged(
    (cursor) =>
      kibbGet<S.ContractListing[]>("/v1/contract/list", {
        contract_type: "charter",
        port_id: port,
        commodity_id: good,
        status,
        cursor,
        limit: 100,
      }),
    100,
    [port, good, status],
  );
  const deliver = useAction<S.DeliverCharterResult[]>(() => {
    setPlan({});
    void list.reload();
    onDone();
  });

  // Our own tons of the good aboard: sealed freight of the same good is someone else's.
  const held = (shipId: string, good: string | null | undefined) =>
    Math.max(0, (ships?.find((r) => r.ship.id === shipId)?.cargo_manifest[good ?? ""] ?? 0) - sealed(shipId, good));
  // Ships at the charter port with the good aboard (carried-in cargo is all that counts).
  const candidates = (c: S.ContractListing) =>
    (ships ?? []).filter((r) => AT_PORT.has(r.ship.status) && r.ship.current_port_id === c.origin_port_id && held(r.ship.id, c.commodity_id) > 0);

  function pick(c: S.ContractListing, on: boolean) {
    setFailed(null);
    setPlan((p) => {
      const next = { ...p };
      if (!on) delete next[c.id];
      else {
        const first = candidates(c)[0];
        const ship = first?.ship.id ?? "";
        next[c.id] = { ship, qty: Math.max(1, Math.min(c.remaining_quantity, Math.floor(held(ship, c.commodity_id)))) };
      }
      return next;
    });
  }

  const planned = list.items.filter((c) => plan[c.id]);
  const ready = planned.length > 0 && planned.length <= 25 && planned.every((c) => plan[c.id].ship && plan[c.id].qty >= 1);
  const results = deliver.result;

  function submit() {
    setFailed(null);
    const deliveries = planned.map((c) => ({ contract_id: c.id, ship_id: plan[c.id].ship, quantity: plan[c.id].qty }));
    void deliver.run(async () => {
      if (deliveries.length === 1) return [await kibbPost<S.DeliverCharterResult>("/v1/contract/deliver-charter", deliveries[0])];
      try {
        return await postBatch<S.DeliverCharterResult[]>("/v1/contract/deliver-charters-batch", { deliveries });
      } catch (e) {
        if (e instanceof BatchError) setFailed(e.batchIndex);
        throw e;
      }
    });
  }

  return (
    <div className="space-y-4">
      <Panel title="Charters" action={<Refresh onClick={() => void list.reload()} loading={list.loading} />}>
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Deliver to">
              <PortSelect value={port} onChange={setPort} placeholder="All ports" />
            </Field>
            <Field label="Good">
              <GoodSelect value={good} onChange={setGood} placeholder="All goods" />
            </Field>
            <Field label="Status">
              <NativeSelect value={status} onChange={(e) => setStatus(e.target.value)}>
                {STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </NativeSelect>
            </Field>
          </div>
          <ErrorNote error={list.error} />
          {list.items.length === 0 ? (
            list.loading ? <Loading /> : <Empty>No charters match.</Empty>
          ) : (
            <Table head={["", "Charter", "Deliver to", "Good", "Remaining", "Pay/t", "Expires", "Your ships there"]}>
              {list.items.map((c) => {
                const phase = targetPhase(c);
                const here = candidates(c);
                const deliverable = c.status === "open" && !c.stale && c.remaining_quantity > 0;
                return (
                  <tr key={c.id} className={plan[c.id] ? "bg-accent/50" : undefined}>
                    <td>
                      <input
                        type="checkbox"
                        disabled={!deliverable}
                        title={c.stale ? "Gossip: sail there to see it live and deliver" : undefined}
                        checked={!!plan[c.id]}
                        onChange={(e) => pick(c, e.target.checked)}
                      />
                    </td>
                    <td>
                      <div className="font-medium">{c.title ?? "Charter"}</div>
                      <div className="mt-0.5 flex flex-wrap gap-1">
                        {c.is_public && <Badge variant="info" size="sm">public</Badge>}
                        {phase !== null && <Badge variant="success" size="sm">expansion · phase {phase}</Badge>}
                        {c.funded_by && <Badge variant="outline" size="sm">{c.funded_by}</Badge>}
                        {c.status !== "open" && <Badge variant="secondary" size="sm">{c.status}</Badge>}
                        {c.stale && c.gossip && (
                          <Badge variant="warning" size="sm" title={`News as of ${fmtDateTime(c.gossip.news_as_of)}`}>
                            gossip from {portName(c.gossip.heard_at_port_id)} · {fmtAgo(c.gossip.news_as_of)}
                          </Badge>
                        )}
                      </div>
                    </td>
                    <td>
                      <Link href={`/ports/${c.origin_port_id}`} className="hover:underline">
                        {portName(c.origin_port_id)}
                      </Link>
                    </td>
                    <td>{goodName(c.commodity_id)}</td>
                    <td className="whitespace-nowrap tabular-nums">
                      {fmtTons(c.remaining_quantity)} <span className="text-muted-foreground">/ {fmtTons(c.quantity_required)}</span>
                    </td>
                    <td className="tabular-nums">{fmtCr(payPerTon(c), 2)}</td>
                    <td className="whitespace-nowrap">{fmtIn(c.expires_at)}</td>
                    <td className="text-muted-foreground">{here.length ? here.map((r) => r.ship.name).join(", ") : "—"}</td>
                  </tr>
                );
              })}
            </Table>
          )}
          <LoadMore done={list.done} loading={list.loading} onMore={() => void list.more()} />
          <p className="text-muted-foreground text-xs">
            Governor, crisis and guild charters are listed live only where you have quay presence; elsewhere you hear of them as
            gossip, as they stood when the news left (they may be filled by now). Delivery is first come, first served.
          </p>
        </div>
      </Panel>

      {planned.length > 0 && (
        <Panel title={`Deliver ${planned.length} charter${planned.length === 1 ? "" : "s"}`}>
          <div className="space-y-4">
            <Table head={["#", "Charter", "Ship at the port", "Aboard", "Tons to deliver", "Pays"]}>
              {planned.map((c, i) => {
                const p = plan[c.id];
                return (
                  <tr key={c.id} className={failed === i ? "bg-destructive/10" : undefined}>
                    <td className="text-muted-foreground">{i + 1}</td>
                    <td>
                      {goodName(c.commodity_id)} to {portName(c.origin_port_id)}
                    </td>
                    <td className="min-w-52">
                      <ShipSelect
                        value={p.ship}
                        onChange={(v) => setPlan((x) => ({ ...x, [c.id]: { ...x[c.id], ship: v } }))}
                        placeholder="No ship here with this good"
                        ships={candidates(c)}
                      />
                    </td>
                    <td className="tabular-nums">{fmtTons(held(p.ship, c.commodity_id))}</td>
                    <td className="w-28">
                      <Input
                        type="number"
                        min={1}
                        max={c.remaining_quantity}
                        value={p.qty}
                        onChange={(e) =>
                          setPlan((x) => ({ ...x, [c.id]: { ...x[c.id], qty: Math.max(1, Math.floor(Number(e.target.value))) } }))
                        }
                      />
                    </td>
                    <td className="tabular-nums">{fmtCr(payPerTon(c) * p.qty)}</td>
                  </tr>
                );
              })}
            </Table>
            {planned.some((c) => autopilot.has(plan[c.id].ship)) && <AutopilotWarning shipName="one of these ships" />}
            <ErrorNote error={deliver.error} />
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-muted-foreground text-xs">
                The ship must be berthed or in the roadstead at the charter port. Only cargo it carried in from another port counts:
                goods bought or loaded there since it arrived, warehouse stock and stores don&apos;t.
                {planned.length > 1 && " Several deliveries go as one batch: if one is refused none applies, and its row turns red."}
                {planned.length > 25 && " A batch takes at most 25."}
              </p>
              <Button disabled={!ready || deliver.busy} onClick={submit}>
                {deliver.busy ? "Delivering…" : "Deliver"}
              </Button>
            </div>
          </div>
        </Panel>
      )}

      {results && (
        <Panel title="Delivered">
          <Table head={["Charter", "Delivered", "Paid", "Prestige", "Charter now"]}>
            {results.map((r) => (
              <tr key={r.contract_id}>
                <td>
                  {goodName(r.commodity_id)} to {portName(r.port_id)}
                </td>
                <td className="tabular-nums">{fmtTons(r.delivered_quantity)}</td>
                <td className="tabular-nums">{fmtCr(r.reward_paid_pence)}</td>
                <td className="tabular-nums">+{r.prestige_awarded}</td>
                <td>{r.contract_status}</td>
              </tr>
            ))}
          </Table>
          {results.some((r) => r.unlocked_phase > 1) && (
            <p className="mt-3 text-muted-foreground text-xs">World phase open: {Math.max(...results.map((r) => r.unlocked_phase))}.</p>
          )}
        </Panel>
      )}
    </div>
  );
}

// ── Freight ───────────────────────────────────────────────────────────────────

function FreightTab({
  ships,
  companyId,
  maxPhase,
  autopilot,
  onDone,
}: {
  ships: ShipResult[] | undefined;
  companyId: string | undefined;
  maxPhase: number | undefined;
  autopilot: Set<string>;
  onDone: () => void;
}) {
  const { portName, goodName } = useCatalog();
  const [origin, setOrigin] = useState("");
  const [dest, setDest] = useState("");
  const [plan, setPlan] = useState<Record<string, string>>({});
  const [failed, setFailed] = useState<number | null>(null);
  const open = usePaged(
    (cursor) =>
      kibbGet<S.ContractListing[]>("/v1/contract/list", {
        contract_type: "freight",
        status: "open",
        port_id: origin,
        dest_port_id: dest,
        cursor,
        limit: 100,
      }),
    100,
    [origin, dest],
  );
  // Our side of freight: what we carry and what we issued.
  const { data: ours, error: oursError, reload: reloadOurs } = usePoll(
    async () => {
      const [active, listed] = await Promise.all(
        (["active", "open"] as const).map((status) =>
          kibbGet<S.ContractListing[]>("/v1/contract/list", { contract_type: "freight", status, limit: 200 }),
        ),
      );
      return [...active, ...listed];
    },
    30_000,
  );
  const accept = useAction<S.AcceptFreightResult[]>(() => {
    setPlan({});
    void open.reload();
    void reloadOurs();
    onDone();
  });
  const deliver = useAction<S.DeliverFreightResult>(() => {
    void reloadOurs();
    onDone();
  });

  const free = (r: ShipResult) => r.effective_hold_capacity_tons - r.cargo_used_tons;
  const candidates = (c: S.ContractListing) =>
    (ships ?? []).filter((r) => r.ship.status === "berthed" && r.ship.current_port_id === c.origin_port_id && free(r) >= c.quantity_required);

  const listings = open.items.filter((c) => !companyId || c.issuer_company_id !== companyId);
  const planned = listings.filter((c) => plan[c.id] !== undefined);
  const carried = (ours ?? []).filter((c) => c.carrier_company_id && c.carrier_company_id === companyId);
  const issued = (ours ?? []).filter((c) => c.issuer_company_id && c.issuer_company_id === companyId);
  const shipOf = (id: string | null | undefined) => ships?.find((r) => r.ship.id === id);

  function pick(c: S.ContractListing, on: boolean) {
    setFailed(null);
    setPlan((p) => {
      const next = { ...p };
      if (on) next[c.id] = candidates(c)[0]?.ship.id ?? "";
      else delete next[c.id];
      return next;
    });
  }

  function submitAccept() {
    setFailed(null);
    const items = planned.map((c) => ({ contract_id: c.id, ship_id: plan[c.id] }));
    void accept.run(async () => {
      if (items.length === 1) return [await kibbPost<S.AcceptFreightResult>("/v1/contract/accept-freight", items[0])];
      try {
        return await postBatch<S.AcceptFreightResult[]>("/v1/contract/accept-freight-batch", { items });
      } catch (e) {
        if (e instanceof BatchError) setFailed(e.batchIndex);
        throw e;
      }
    });
  }

  return (
    <div className="space-y-4">
      <Panel title="Open freight" action={<Refresh onClick={() => void open.reload()} loading={open.loading} />}>
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="From">
              <PortSelect value={origin} onChange={setOrigin} placeholder="Any origin" maxPhase={maxPhase} />
            </Field>
            <Field label="To">
              <PortSelect value={dest} onChange={setDest} placeholder="Any destination" maxPhase={maxPhase} />
            </Field>
          </div>
          <ErrorNote error={open.error} />
          {listings.length === 0 ? (
            open.loading ? (
              <Loading />
            ) : (
              <Empty>No open freight. Lots are listed only at their origin port, to companies with a ship or factor there.</Empty>
            )
          ) : (
            <Table head={["", "From", "To", "Good", "Tons", "Reward", "Per ton", "Collateral", "Listing expires"]}>
              {listings.map((c) => {
                const can = candidates(c).length > 0;
                return (
                  <tr key={c.id} className={plan[c.id] !== undefined ? "bg-accent/50" : undefined}>
                    <td>
                      <input
                        type="checkbox"
                        disabled={!can}
                        title={can ? undefined : "Needs a ship berthed at the origin with room for the lot"}
                        checked={plan[c.id] !== undefined}
                        onChange={(e) => pick(c, e.target.checked)}
                      />
                    </td>
                    <td>{portName(c.origin_port_id)}</td>
                    <td>{portName(c.dest_port_id)}</td>
                    <td className="font-medium">{goodName(c.commodity_id)}</td>
                    <td className="tabular-nums">{fmtTons(c.quantity_required)}</td>
                    <td className="tabular-nums">{fmtCr(c.reward_pence)}</td>
                    <td className="text-muted-foreground tabular-nums">{fmtCr(payPerTon(c), 2)}</td>
                    <td className="tabular-nums">{fmtCr(c.collateral_pence)}</td>
                    <td className="whitespace-nowrap">{fmtIn(c.expires_at)}</td>
                  </tr>
                );
              })}
            </Table>
          )}
          <LoadMore done={open.done} loading={open.loading} onMore={() => void open.more()} />
        </div>
      </Panel>

      {planned.length > 0 && (
        <Panel title={`Accept ${planned.length} lot${planned.length === 1 ? "" : "s"}`}>
          <div className="space-y-4">
            <Table head={["#", "Lot", "Ship berthed at origin", "Collateral escrowed"]}>
              {planned.map((c, i) => (
                <tr key={c.id} className={failed === i ? "bg-destructive/10" : undefined}>
                  <td className="text-muted-foreground">{i + 1}</td>
                  <td>
                    {fmtTons(c.quantity_required)} {goodName(c.commodity_id)}, {portName(c.origin_port_id)} → {portName(c.dest_port_id)}
                  </td>
                  <td className="min-w-52">
                    <ShipSelect
                      value={plan[c.id]}
                      onChange={(v) => setPlan((p) => ({ ...p, [c.id]: v }))}
                      placeholder="No ship with room here"
                      ships={candidates(c)}
                    />
                  </td>
                  <td className="tabular-nums">{fmtCr(c.collateral_pence)}</td>
                </tr>
              ))}
            </Table>
            {planned.some((c) => autopilot.has(plan[c.id])) && <AutopilotWarning shipName="one of these ships" />}
            <ErrorNote error={accept.error} />
            {accept.result && (
              <p className="text-sm">
                Accepted {accept.result.length}: deliver{" "}
                {accept.result.map((a) => `${goodName(a.commodity_id)} to ${portName(a.dest_port_id)} ${fmtIn(a.delivery_deadline)}`).join("; ")}.
              </p>
            )}
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-muted-foreground text-xs">
                The goods load straight into the hold, sealed: they can&apos;t be sold, unloaded or delivered to a charter. The
                collateral is escrowed and comes back with the reward on delivery; miss the deadline and both the collateral and the
                cargo are lost. Each ton loaded adds to the berth&apos;s turnaround lock.
              </p>
              <Button disabled={accept.busy || planned.length > 25 || planned.some((c) => !plan[c.id])} onClick={submitAccept}>
                {accept.busy ? "Accepting…" : "Accept"}
              </Button>
            </div>
          </div>
        </Panel>
      )}

      <Panel title="Carried by us" action={<Refresh onClick={() => void reloadOurs()} loading={false} />}>
        <div className="space-y-3">
          <ErrorNote error={oursError ?? deliver.error} />
          {deliver.result && (
            <p className="text-sm">
              Delivered {fmtTons(deliver.result.delivered_quantity)} {goodName(deliver.result.commodity_id)}: reward{" "}
              {fmtCr(deliver.result.reward_paid_pence)}, collateral back {fmtCr(deliver.result.collateral_returned_pence)}.
            </p>
          )}
          {carried.length === 0 ? (
            <Empty>No freight aboard.</Empty>
          ) : (
            <Table head={["Good", "Tons", "Route", "Ship", "Reward", "Collateral", "Deadline", ""]}>
              {carried.map((c) => {
                const r = shipOf(c.carrier_ship_id);
                const there = !!r && AT_PORT.has(r.ship.status) && r.ship.current_port_id === c.dest_port_id;
                return (
                  <tr key={c.id}>
                    <td className="font-medium">{goodName(c.commodity_id)}</td>
                    <td className="tabular-nums">{fmtTons(c.quantity_required)}</td>
                    <td>
                      {portName(c.origin_port_id)} → {portName(c.dest_port_id)}
                    </td>
                    <td>
                      {r ? (
                        <Link href={`/fleet/${r.ship.id}`} className="hover:underline">
                          {r.ship.name}
                        </Link>
                      ) : (
                        "—"
                      )}
                      {r && <span className="text-muted-foreground"> · {r.ship.status === "sailing" ? "at sea" : portName(r.ship.current_port_id)}</span>}
                    </td>
                    <td className="tabular-nums">{fmtCr(c.reward_pence)}</td>
                    <td className="tabular-nums">{fmtCr(c.collateral_pence)}</td>
                    <td className="whitespace-nowrap">{fmtIn(c.expires_at)}</td>
                    <td className="text-right">
                      <Button
                        size="sm"
                        disabled={!there || deliver.busy}
                        title={there ? undefined : "The carrier ship must be at the destination (berthed or roadstead)"}
                        onClick={() => {
                          if (r && autopilot.has(r.ship.id) && !confirm(`The autopilot is sailing ${r.ship.name}. Deliver anyway?`)) return;
                          void deliver.run(() =>
                            kibbPost<S.DeliverFreightResult>("/v1/contract/deliver-freight", { contract_id: c.id, ship_id: c.carrier_ship_id }),
                          );
                        }}
                      >
                        Deliver
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </Table>
          )}
          <p className="text-muted-foreground text-xs">
            Deliver with the same ship at the destination, berthed or in the roadstead. A 409 refusal means the issuer has no free
            warehouse space there: wait in port. If the contract expires while you wait with the cargo, the issuer is in breach and you
            are paid, refunded and keep the cargo.
          </p>
        </div>
      </Panel>

      <Panel title="Issued by us">
        {issued.length === 0 ? (
          <Empty>None. Post a lot on the Issue freight tab.</Empty>
        ) : (
          <Table head={["Status", "Good", "Tons", "Route", "Reward", "Collateral", "Expires", "Posted"]}>
            {issued.map((c) => (
              <tr key={c.id}>
                <td>
                  <Badge variant={c.status === "active" ? "info" : "outline"} size="sm">
                    {c.status === "active" ? "carried" : c.status}
                  </Badge>
                </td>
                <td className="font-medium">{goodName(c.commodity_id)}</td>
                <td className="tabular-nums">{fmtTons(c.quantity_required)}</td>
                <td>
                  {portName(c.origin_port_id)} → {portName(c.dest_port_id)}
                </td>
                <td className="tabular-nums">{fmtCr(c.reward_pence)}</td>
                <td className="tabular-nums">{fmtCr(c.collateral_pence)}</td>
                <td className="whitespace-nowrap">{fmtIn(c.expires_at)}</td>
                <td className="whitespace-nowrap text-muted-foreground">{fmtDateTime(c.created_at)}</td>
              </tr>
            ))}
          </Table>
        )}
      </Panel>
    </div>
  );
}

// ── Issue freight ─────────────────────────────────────────────────────────────

function IssueFreightTab({ maxPhase, onDone }: { maxPhase: number | undefined; onDone: () => void }) {
  const { catalog, portName, goodName } = useCatalog();
  const { data: warehouses, error, reload } = usePoll(() => kibbGet<S.PortWarehouseResult[]>("/v1/warehouse/list"), 30_000);
  const [origin, setOrigin] = useState("");
  const [good, setGood] = useState("");
  const [dest, setDest] = useState("");
  const [qty, setQty] = useState(1);
  const [rewardCr, setRewardCr] = useState(0);
  const [collateralCr, setCollateralCr] = useState(0);
  const create = useAction<S.Contract>(() => {
    void reload();
    onDone();
  });

  const avail = (i: S.WarehouseInventory) => i.quantity - i.locked_quantity;
  const stocked = (warehouses ?? []).filter((w) => w.inventory.some((i) => avail(i) > 0));
  const wh = stocked.find((w) => w.port_id === origin);
  const goods = (wh?.inventory ?? []).filter((i) => avail(i) > 0);
  const item = goods.find((i) => i.commodity_id === good);
  const base = catalog?.commodities.find((c) => c.id === good)?.base_price_pence ?? 0;
  // Merchant Adventurers ask 25% of the cargo's value as collateral up to 30 t, 40% above.
  const suggestedCollateral = Math.round((base * qty * (qty > 30 ? 40 : 25)) / 100);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    void create.run(() =>
      kibbPost<S.Contract>("/v1/contract/create-freight", {
        origin_port_id: origin,
        dest_port_id: dest,
        commodity_id: good,
        quantity: qty,
        reward_pence: toPence(rewardCr),
        collateral_pence: toPence(collateralCr),
      }),
    );
  }

  return (
    <div className="grid items-start gap-4 lg:grid-cols-3">
      <Panel title="Post a freight contract" className="lg:col-span-2">
        {!warehouses ? (
          error ? <ErrorNote error={error} /> : <Loading />
        ) : stocked.length === 0 ? (
          <Empty>
            Freight ships goods out of one of your warehouses, and none holds unlocked stock. Lease space and unload cargo on the{" "}
            <Link href="/warehouses" className="text-primary hover:underline">Warehouses</Link> page first.
          </Empty>
        ) : (
          <form onSubmit={submit} className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="From (your warehouse)">
                <NativeSelect
                  value={origin}
                  onChange={(e) => {
                    setOrigin(e.target.value);
                    setGood("");
                  }}
                >
                  <option value="">Choose…</option>
                  {stocked.map((w) => (
                    <option key={w.port_id} value={w.port_id}>
                      {portName(w.port_id)}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
              <Field label="Good">
                <NativeSelect value={good} disabled={!origin} onChange={(e) => setGood(e.target.value)}>
                  <option value="">Choose…</option>
                  {goods.map((i) => (
                    <option key={i.commodity_id} value={i.commodity_id}>
                      {goodName(i.commodity_id)} ({fmtTons(avail(i))} free)
                    </option>
                  ))}
                </NativeSelect>
              </Field>
              <Field label="To">
                <PortSelect value={dest} onChange={setDest} placeholder="Choose…" maxPhase={maxPhase} filter={(p) => p !== origin} />
              </Field>
              <Field label="Tons">
                <Input
                  type="number"
                  min={1}
                  max={item ? avail(item) : undefined}
                  value={qty}
                  onChange={(e) => setQty(Math.max(1, Math.floor(Number(e.target.value))))}
                />
              </Field>
              <Field label="Reward (Cr, paid on delivery)">
                <Input type="number" min={0.01} step={0.01} value={rewardCr} onChange={(e) => setRewardCr(Number(e.target.value))} />
              </Field>
              <Field label="Collateral (Cr, from the carrier)">
                <Input type="number" min={0} step={0.01} value={collateralCr} onChange={(e) => setCollateralCr(Number(e.target.value))} />
              </Field>
            </div>
            {good && (
              <KV
                rows={[
                  ["Cargo at base price", fmtCr(base * qty)],
                  ["Usual collateral (25% to 30 t, 40% above)", fmtCr(suggestedCollateral)],
                  ["Reward per ton", qty ? fmtCr(toPence(rewardCr) / qty, 2) : "—"],
                ]}
              />
            )}
            <ErrorNote error={create.error} />
            {create.result && (
              <p className="text-sm">
                Posted: {fmtTons(create.result.quantity_required)} {goodName(create.result.commodity_id)} to{" "}
                {portName(create.result.dest_port_id)}, listing expires {fmtIn(create.result.expires_at)}.
              </p>
            )}
            <Button type="submit" disabled={create.busy || !origin || !good || !dest || rewardCr <= 0 || (item ? qty > avail(item) : true)}>
              {create.busy ? "Posting…" : "Post freight"}
            </Button>
          </form>
        )}
      </Panel>
      <Panel title="How freight works">
        <div className="space-y-2 text-muted-foreground text-sm">
          <p>Posting locks the goods in your warehouse at the origin and escrows the reward.</p>
          <p>
            A carrier accepts with a ship berthed at the origin, escrows the collateral and sails the sealed cargo to the destination.
            It can&apos;t be one of your own companies.
          </p>
          <p>
            On delivery the goods go into your warehouse there: lease free space before they arrive. With no room the delivery is refused,
            and if the contract expires while the carrier waits, you are in breach: it is paid, refunded and keeps the cargo.
          </p>
          <p>If the carrier misses the deadline, it forfeits its collateral and the cargo is confiscated.</p>
        </div>
      </Panel>
    </div>
  );
}

export default function ContractsPage() {
  const { data: ships, reload: reloadShips } = usePoll(() => kibbGet<ShipResult[]>("/v1/fleet/ships", { limit: 200 }), 15_000);
  const { data: profile } = usePoll(() => kibbGet<CompanyProfile>("/v1/company/profile"));
  const { data: clock } = usePoll(() => kibbGet<WorldClock>("/v1/world/clock"));
  const autopilot = useAutopilotShips();
  const refresh = () => void reloadShips();

  return (
    <div className="space-y-5 pb-8 sm:space-y-6">
      <PageHeader title="Contracts" subtitle="Charters pay a premium for goods carried in from another port; freight pays to carry someone else's sealed cargo." />
      <Tabs defaultValue="charters">
        <TabsList>
          <TabsTab value="charters">Charters</TabsTab>
          <TabsTab value="freight">Freight</TabsTab>
          <TabsTab value="issue">Issue freight</TabsTab>
        </TabsList>
        <TabsPanel value="charters" className="pt-2">
          <ChartersTab ships={ships} autopilot={autopilot} onDone={refresh} />
        </TabsPanel>
        <TabsPanel value="freight" className="pt-2">
          <FreightTab ships={ships} companyId={profile?.company.id} maxPhase={clock?.unlocked_phase} autopilot={autopilot} onDone={refresh} />
        </TabsPanel>
        <TabsPanel value="issue" className="pt-2">
          <IssueFreightTab maxPhase={clock?.unlocked_phase} onDone={refresh} />
        </TabsPanel>
      </Tabs>
    </div>
  );
}
