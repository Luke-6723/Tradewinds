"use client";

import { useState } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsPanel, TabsTab } from "@/components/ui/tabs";
import { Empty, ErrorNote, KV, Loading, NativeSelect, PageHeader, Panel, Table } from "@/components/kibb/bits";
import { CommissionsView } from "@/components/kibb/commissions";
import { CHARTER } from "@/components/kibb/deals-common";
import { CashLine, crToPence, firstProblem, regionName, useRegionOf, useVaults } from "@/components/kibb/finance-common";
import { Checkbox } from "@/components/kibb/naval-common";
import { Field, GoodSelect, PortSelect, ShipSelect } from "@/components/kibb/pickers";
import {
  AutopilotWarning,
  BatchError,
  fetchAll,
  LoadMore,
  postBatch,
  type SealedTons,
  toPence,
  useAutopilotShips,
  usePaged,
  useSealedTons,
} from "@/components/kibb/trade-common";
import { useAction } from "@/hooks/use-action";
import { useCatalog } from "@/hooks/use-catalog";
import { usePoll } from "@/hooks/use-poll";
import { dash, kibbGet, kibbPost } from "@/lib/kibb/browser";
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

/** When a ship in port got there: the earlier of its berthing and its last arrival, if known. */
function arrivedAt(r: ShipResult): number | null {
  const now = Date.now();
  const times = [r.ship.berthed_at, r.ship.leg_arrives_at].map((t) => Date.parse(t ?? "")).filter((t) => t <= now);
  return times.length ? Math.min(...times) : null;
}

/** Our bid fills at a port, back to `since` (all of them when the order isn't newest first). */
async function bidsSince(port: string, since: number): Promise<S.CompanyTradeFillResult[]> {
  const all: S.CompanyTradeFillResult[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 10; i++) {
    const page = await kibbGet<S.CompanyTradeFillResult[]>("/v1/market/fills", { port_id: port, side: "bid", cursor, limit: 200 });
    all.push(...page);
    if (page.length < 200) break;
    const first = Date.parse(page[0].created_at);
    const last = Date.parse(page.at(-1)!.created_at);
    if (first >= last && last < since) break;
    cursor = page.at(-1)?.id;
  }
  return all;
}

function ChartersTab({
  ships,
  sealed,
  unlockedPhase,
  autopilot,
  ourIds,
  onDone,
}: {
  ships: ShipResult[] | undefined;
  sealed: SealedTons;
  unlockedPhase: number | undefined;
  autopilot: Set<string>;
  /** Every company of our player: a charter one of them posted can't be delivered to by ours. */
  ourIds: Set<string>;
  onDone: () => void;
}) {
  const { portName, goodName } = useCatalog();
  const [port, setPort] = useState("");
  const [good, setGood] = useState("");
  const [status, setStatus] = useState<string>("open");
  const [plan, setPlan] = useState<Record<string, CharterPlan>>({});
  const [failed, setFailed] = useState<number | null>(null);
  const [phaseBefore, setPhaseBefore] = useState<number | null>(null);
  const [ignoreFills, setIgnoreFills] = useState(false);
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
  // Our bids filled at charter ports where our ships lie: bought there since arrival, so never carried in.
  const fillPorts = [
    ...new Set(
      (ships ?? [])
        .filter((r) => AT_PORT.has(r.ship.status) && list.items.some((c) => c.origin_port_id === r.ship.current_port_id))
        .map((r) => r.ship.current_port_id ?? ""),
    ),
  ]
    .sort()
    .join(",");
  const { data: fills, error: fillsError } = usePoll(
    fillPorts
      ? async () => {
          const ports = fillPorts.split(",");
          const pages = await Promise.all(
            ports.map((p) => {
              const times = (ships ?? [])
                .filter((r) => AT_PORT.has(r.ship.status) && r.ship.current_port_id === p)
                .map(arrivedAt)
                .filter((t): t is number => t !== null);
              return times.length ? bidsSince(p, Math.min(...times)) : Promise.resolve<S.CompanyTradeFillResult[]>([]);
            }),
          );
          return Object.fromEntries(ports.map((p, i) => [p, pages[i]])) as Record<string, S.CompanyTradeFillResult[]>;
        }
      : null,
    30_000,
    [fillPorts],
  );

  const shipOf = (id: string) => ships?.find((r) => r.ship.id === id);
  // Tons of the good bought at the ship's port since it arrived. Only an IOC (taker) bid can fill a hold,
  // but a fill doesn't say which ship or warehouse took it, so all of them are left out.
  const fillsIn = (shipId: string, good: string | null | undefined) => {
    const r = shipOf(shipId);
    const since = r ? arrivedAt(r) : null;
    if (!r || since === null) return 0;
    return (fills?.[r.ship.current_port_id ?? ""] ?? [])
      .filter((f) => f.commodity_id === good && !f.is_maker && Date.parse(f.created_at) >= since)
      .reduce((n, f) => n + f.quantity, 0);
  };
  // The user can count the fills out (they may have gone into the warehouse): the server still checks.
  const bought = (shipId: string, good: string | null | undefined) => (ignoreFills ? 0 : fillsIn(shipId, good));
  // Our own tons of the good aboard: sealed freight of the same good is someone else's.
  const raw = (shipId: string, good: string | null | undefined) =>
    Math.max(0, (shipOf(shipId)?.cargo_manifest[good ?? ""] ?? 0) - sealed(shipId, good));
  // ...less what was bought at the port since arrival (carried-in cargo is all that counts).
  const held = (shipId: string, good: string | null | undefined) => Math.max(0, raw(shipId, good) - bought(shipId, good));
  const atPort = (c: S.ContractListing) =>
    (ships ?? []).filter((r) => AT_PORT.has(r.ship.status) && r.ship.current_port_id === c.origin_port_id);
  // Ships at the charter port with the good aboard.
  const candidates = (c: S.ContractListing) => atPort(c).filter((r) => held(r.ship.id, c.commodity_id) > 0);
  // Ships whose whole load of the good is taken off as bought here.
  const allBought = (c: S.ContractListing) => atPort(c).filter((r) => raw(r.ship.id, c.commodity_id) > 0 && held(r.ship.id, c.commodity_id) === 0);
  // Tons of a good already planned from a ship on the other ticked charters.
  const usedElsewhere = (p: Record<string, CharterPlan>, shipId: string, good: string | null | undefined, except: string) =>
    list.items.reduce((n, x) => (x.id !== except && p[x.id]?.ship === shipId && x.commodity_id === good ? n + p[x.id].qty : n), 0);
  // Most a charter can take from a ship, beside what the other rows plan from it.
  const cap = (p: Record<string, CharterPlan>, c: S.ContractListing, shipId: string) =>
    Math.max(0, Math.min(c.remaining_quantity, Math.floor(held(shipId, c.commodity_id)) - usedElsewhere(p, shipId, c.commodity_id, c.id)));

  function pick(c: S.ContractListing, on: boolean) {
    setFailed(null);
    setPlan((p) => {
      const next = { ...p };
      if (!on) delete next[c.id];
      else {
        const ship = candidates(c).sort((a, b) => cap(p, c, b.ship.id) - cap(p, c, a.ship.id))[0]?.ship.id ?? "";
        next[c.id] = { ship, qty: Math.max(1, cap(p, c, ship)) };
      }
      return next;
    });
  }

  function setShip(c: S.ContractListing, ship: string) {
    setPlan((x) => {
      const prev = x[c.id];
      // An untouched row (full load) follows the new ship's room; a typed amount is only clamped.
      const qty = prev.qty >= cap(x, c, prev.ship) ? cap(x, c, ship) : Math.min(prev.qty, cap(x, c, ship));
      return { ...x, [c.id]: { ship, qty: Math.max(1, qty) } };
    });
  }

  function setQty(c: S.ContractListing, value: number) {
    setPlan((x) => ({ ...x, [c.id]: { ...x[c.id], qty: Math.max(1, Math.min(Math.floor(value) || 1, cap(x, c, x[c.id].ship))) } }));
  }

  const planned = list.items.filter((c) => plan[c.id]);
  const over = (c: S.ContractListing) => {
    const p = plan[c.id];
    return p.qty > c.remaining_quantity || usedElsewhere(plan, p.ship, c.commodity_id, c.id) + p.qty > held(p.ship, c.commodity_id);
  };
  // Until the fills are in, what was carried in is unknown.
  const fillsReady = ignoreFills || !fillPorts || fillPorts.split(",").every((p) => fills?.[p]);
  const ready =
    fillsReady && planned.length > 0 && planned.length <= 25 && planned.every((c) => plan[c.id].ship && plan[c.id].qty >= 1 && !over(c));
  // Every ship at a ticked charter's port with fills of its good taken off, not just the planned one.
  const boughtHere = planned.flatMap((c) =>
    atPort(c)
      .filter((r) => raw(r.ship.id, c.commodity_id) > 0 && fillsIn(r.ship.id, c.commodity_id) > 0)
      .map((r) => ({ c, r })),
  );
  const results = deliver.result;
  const unlocked = Math.max(0, ...(results ?? []).map((r) => r.unlocked_phase));

  function submit() {
    setFailed(null);
    setPhaseBefore(null);
    const deliveries = planned.map((c) => ({ contract_id: c.id, ship_id: plan[c.id].ship, quantity: plan[c.id].qty }));
    void deliver.run(async () => {
      // Read just before delivering: another company may have unlocked a phase since the page loaded.
      setPhaseBefore(await kibbGet<WorldClock>("/v1/world/clock").then((c) => c.unlocked_phase, () => unlockedPhase ?? null));
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
                const ours = !!c.issuer_company_id && ourIds.has(c.issuer_company_id);
                const deliverable = c.status === "open" && !c.stale && c.remaining_quantity > 0 && !ours;
                return (
                  <tr key={c.id} className={plan[c.id] ? "bg-accent/50" : undefined}>
                    <td>
                      <input
                        type="checkbox"
                        disabled={!deliverable}
                        title={ours ? "Posted by one of your companies: the game refuses your deliveries to it" : c.stale ? "Gossip: sail there to see it live and deliver" : undefined}
                        checked={!!plan[c.id]}
                        onChange={(e) => pick(c, e.target.checked)}
                      />
                    </td>
                    <td>
                      <div className="font-medium">{c.title ?? "Charter"}</div>
                      <div className="mt-0.5 flex flex-wrap gap-1">
                        {c.is_public && <Badge variant="info" size="sm">public</Badge>}
                        {phase !== null && <Badge variant="success" size="sm">expansion · phase {phase}</Badge>}
                        {c.funded_by && <Badge variant="outline" size="sm">{c.funded_by === "issuer" ? "player charter" : c.funded_by}</Badge>}
                        {ours && <Badge variant="secondary" size="sm">yours: not deliverable</Badge>}
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
                    <td className="text-muted-foreground">
                      {[...here.map((r) => r.ship.name), ...allBought(c).map((r) => `${r.ship.name} (bought here since arrival)`)].join(", ") || "—"}
                    </td>
                  </tr>
                );
              })}
            </Table>
          )}
          <LoadMore done={list.done} loading={list.loading} onMore={() => void list.more()} />
          <p className="text-muted-foreground text-xs">
            Governor, crisis, guild and players&apos; own charters are listed live only where you have quay presence; elsewhere you hear of them as
            gossip, as they stood when the news left (they may be filled by now). Delivery is first come, first served. A player&apos;s charter pays
            from its poster&apos;s escrow and earns no prestige; one posted by any of your own companies can&apos;t be delivered to by them.
          </p>
        </div>
      </Panel>

      {planned.length > 0 && (
        <Panel title={`Deliver ${planned.length} charter${planned.length === 1 ? "" : "s"}`}>
          <div className="space-y-4">
            <Table head={["#", "Charter", "Ship at the port", "Carried in", "Tons to deliver", "Pays"]}>
              {planned.map((c, i) => {
                const p = plan[c.id];
                const elsewhere = usedElsewhere(plan, p.ship, c.commodity_id, c.id);
                return (
                  <tr key={c.id} className={failed === i || over(c) ? "bg-destructive/10" : undefined}>
                    <td className="text-muted-foreground">{i + 1}</td>
                    <td>
                      {goodName(c.commodity_id)} to {portName(c.origin_port_id)}
                    </td>
                    <td className="min-w-52">
                      <ShipSelect value={p.ship} onChange={(v) => setShip(c, v)} placeholder="No ship here with this good" ships={candidates(c)} />
                    </td>
                    <td className="tabular-nums">
                      {fmtTons(held(p.ship, c.commodity_id))}
                      {elsewhere > 0 && <div className="text-muted-foreground text-xs">{fmtTons(elsewhere)} on other rows</div>}
                    </td>
                    <td className="w-28">
                      <Input
                        type="number"
                        min={1}
                        max={Math.max(1, cap(plan, c, p.ship))}
                        value={p.qty}
                        onChange={(e) => setQty(c, Number(e.target.value))}
                      />
                    </td>
                    <td className="tabular-nums">{fmtCr(payPerTon(c) * p.qty)}</td>
                  </tr>
                );
              })}
            </Table>
            {planned.some(over) && (
              <p className="text-destructive text-sm">
                A red row asks for more than its ship carried in (less what the other rows take from it) or than the charter still wants.
              </p>
            )}
            {boughtHere.length > 0 && (
              <div className="space-y-2 rounded-md bg-warning/10 px-3 py-2 text-sm text-warning-foreground">
                <p>
                  Bought at the charter port since the ship arrived{ignoreFills ? " (counted as carried in)" : ", and left out of what it can deliver"}:{" "}
                  {[...new Map(boughtHere.map((x) => [`${x.r.ship.id}|${x.c.commodity_id}`, x])).values()]
                    .map(({ c, r }) => `${fmtTons(fillsIn(r.ship.id, c.commodity_id))} ${goodName(c.commodity_id)} (${r.ship.name})`)
                    .join(", ")}
                  . Your fills don&apos;t say which ship or warehouse took them, so all are taken off; goods loaded from the warehouse
                  here don&apos;t count either.
                </p>
                <Checkbox checked={ignoreFills} onChange={setIgnoreFills}>
                  Those went to the warehouse or another ship: count this cargo as carried in (the server refuses it if not)
                </Checkbox>
              </div>
            )}
            {!fillsReady && !fillsError && <p className="text-muted-foreground text-xs">Checking what was bought at these ports since arrival…</p>}
            {fillsError && !ignoreFills && (
              <ErrorNote error={`Couldn't read your fills (${fillsError.message}), so what was carried in is unknown. Tick below to deliver anyway.`} />
            )}
            {fillsError && boughtHere.length === 0 && (
              <Checkbox checked={ignoreFills} onChange={setIgnoreFills}>
                Deliver without checking fills (the server refuses cargo not carried in)
              </Checkbox>
            )}
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
          {phaseBefore !== null && unlocked > phaseBefore && (
            <p className="mt-3 text-muted-foreground text-xs">Phase {unlocked} unlocked.</p>
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
  ourIds,
  maxPhase,
  autopilot,
  onDone,
}: {
  ships: ShipResult[] | undefined;
  companyId: string | undefined;
  ourIds: Set<string>;
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
  // Our side of freight: what we carry and what we issued. Every open lot in reach shares the list, so read it all.
  const { data: ours, error: oursError, reload: reloadOurs } = usePoll(
    async () => {
      const [active, listed] = await Promise.all(
        (["active", "open"] as const).map((status) => fetchAll<S.ContractListing>("/v1/contract/list", { contract_type: "freight", status })),
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

  // Lots from any of our companies would be same-player dealing, refused.
  const listings = open.items.filter((c) => !c.issuer_company_id || !ourIds.has(c.issuer_company_id));
  const planned = listings.filter((c) => plan[c.id] !== undefined);
  const carried = (ours ?? []).filter((c) => c.carrier_company_id && c.carrier_company_id === companyId);
  const issued = (ours ?? []).filter((c) => c.issuer_company_id && c.issuer_company_id === companyId);
  const shipOf = (id: string | null | undefined) => ships?.find((r) => r.ship.id === id);

  const free = (r: ShipResult) => r.effective_hold_capacity_tons - r.cargo_used_tons;
  // Tons of the ticked lots planned on a ship, leaving one lot out.
  const plannedOn = (p: Record<string, string>, shipId: string, except?: string) =>
    listings.reduce((n, x) => (x.id !== except && p[x.id] === shipId ? n + x.quantity_required : n), 0);
  const fits = (c: S.ContractListing, r: ShipResult, p: Record<string, string>) => free(r) - plannedOn(p, r.ship.id, c.id) >= c.quantity_required;
  const berthedAt = (c: S.ContractListing) =>
    (ships ?? []).filter((r) => r.ship.status === "berthed" && r.ship.current_port_id === c.origin_port_id);
  // Ships berthed at the origin with room for the lot beside the other lots planned on them.
  const candidates = (c: S.ContractListing, p = plan) => berthedAt(c).filter((r) => fits(c, r, p));
  const overfull = (ships ?? []).filter((r) => planned.some((c) => plan[c.id] === r.ship.id) && plannedOn(plan, r.ship.id) > free(r));

  function pick(c: S.ContractListing, on: boolean) {
    setFailed(null);
    setPlan((p) => {
      const next = { ...p };
      if (on) next[c.id] = candidates(c, p)[0]?.ship.id ?? "";
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
                        disabled={!can && plan[c.id] === undefined}
                        title={can ? undefined : "Needs a ship berthed at the origin with room for the lot, beside the lots already ticked"}
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
                <tr
                  key={c.id}
                  className={failed === i || overfull.some((r) => r.ship.id === plan[c.id]) ? "bg-destructive/10" : undefined}
                >
                  <td className="text-muted-foreground">{i + 1}</td>
                  <td>
                    {fmtTons(c.quantity_required)} {goodName(c.commodity_id)}, {portName(c.origin_port_id)} → {portName(c.dest_port_id)}
                  </td>
                  <td className="min-w-52">
                    <ShipSelect
                      value={plan[c.id]}
                      onChange={(v) => setPlan((p) => ({ ...p, [c.id]: v }))}
                      placeholder="No ship with room here"
                      ships={berthedAt(c)}
                      filter={(r) => r.ship.id === plan[c.id] || fits(c, r, plan)}
                    />
                  </td>
                  <td className="tabular-nums">{fmtCr(c.collateral_pence)}</td>
                </tr>
              ))}
            </Table>
            {overfull.length > 0 && (
              <p className="text-destructive text-sm">
                Too much on{" "}
                {overfull.map((r) => `${r.ship.name} (${fmtTons(plannedOn(plan, r.ship.id))} planned, ${fmtTons(free(r))} free)`).join(", ")}
                : move a lot to another ship or untick one.
              </p>
            )}
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
              <Button
                disabled={accept.busy || planned.length > 25 || planned.some((c) => !plan[c.id]) || overfull.length > 0}
                onClick={submitAccept}
              >
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

function IssueFreightTab({ companyId, maxPhase, onDone }: { companyId: string | undefined; maxPhase: number | undefined; onDone: () => void }) {
  const { catalog, portName, goodName } = useCatalog();
  const { data: warehouses, error, reload } = usePoll(() => kibbGet<S.PortWarehouseResult[]>("/v1/warehouse/list"), 30_000);
  // Our freight still to arrive: each lot needs its own room at its destination.
  const { data: ourFreight, error: freightError, reload: reloadOurFreight } = usePoll(
    companyId
      ? async () => {
          const pages = await Promise.all(
            (["open", "active"] as const).map((status) => fetchAll<S.ContractListing>("/v1/contract/list", { contract_type: "freight", status })),
          );
          return pages.flat().filter((c) => c.issuer_company_id === companyId);
        }
      : null,
    30_000,
    [companyId],
  );
  const [origin, setOrigin] = useState("");
  const [good, setGood] = useState("");
  const [dest, setDest] = useState("");
  const [qty, setQty] = useState(1);
  const [rewardCr, setRewardCr] = useState(0);
  const [collateralCr, setCollateralCr] = useState(0);
  const create = useAction<S.Contract>(() => {
    void reload();
    void reloadOurFreight();
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
  // The goods land in our warehouse at the destination: without the room there the delivery is refused.
  const destWh = (warehouses ?? []).find((w) => w.port_id === dest);
  const pending = (ourFreight ?? []).filter((c) => c.dest_port_id === dest).reduce((n, c) => n + c.remaining_quantity, 0);
  const destFree = Math.max(0, (destWh?.free_tonnage ?? 0) - pending);
  // Until our other freight is known, the room isn't: ask before posting.
  const pendingKnown = ourFreight !== undefined;
  const noRoom = !!dest && (!pendingKnown || destFree < qty);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (
      noRoom &&
      !confirm(
        `${pendingKnown ? `Your warehouse at ${portName(dest)} has ${fmtTons(destFree)} free, short of ${fmtTons(qty)}.` : `Your other freight bound for ${portName(dest)} couldn't be read, so the free room there is unknown.`} Unless you lease the room before the carrier arrives, the delivery is refused and you are in breach when the contract expires (the carrier is paid and keeps the cargo). Post anyway?`,
      )
    )
      return;
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
            {dest && (
              <p className={noRoom ? "rounded-md bg-warning/10 px-3 py-2 text-sm text-warning-foreground" : "text-muted-foreground text-xs"}>
                {!pendingKnown
                  ? `${freightError ? `Couldn't read your other freight (${freightError.message})` : "Reading your other freight"} bound for ${portName(dest)}, so the free room there is unknown. `
                  : destWh
                    ? `${fmtTons(destFree)} free in your warehouse at ${portName(dest)}${pending > 0 ? ` after the ${fmtTons(pending)} your other freight brings there` : ""}`
                    : `You lease no warehouse space at ${portName(dest)}`}
                {!pendingKnown ? "" : noRoom ? `, short of the ${fmtTons(qty)} this lot needs. ` : ". "}
                The goods go there on delivery, so that room must stay free until the carrier arrives (other freight you issued to
                this port needs its own). With no room the delivery is refused, and if the contract expires meanwhile you are in
                breach.{" "}
                <Link href="/warehouses" className="text-primary hover:underline">
                  Lease space
                </Link>
              </p>
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

// ── Post a charter ────────────────────────────────────────────────────────────

/** Our own player charters (guide 3.7): post one to have goods brought to our warehouse, and cancel. */
function PostCharterTab({ companyId, maxPhase }: { companyId: string | undefined; maxPhase: number | undefined }) {
  const { catalog, portName, goodName } = useCatalog();
  const regionOf = useRegionOf();
  const vaults = useVaults();
  const { data: warehouses, reload: reloadWarehouses } = usePoll(() => kibbGet<S.PortWarehouseResult[]>("/v1/warehouse/list"), 30_000);
  // Ours still open: every open charter we can see, less everyone else's (the issuer always sees its own).
  const { data: mine, error: mineError, reload: reloadMine } = usePoll(
    companyId
      ? async () =>
          (await fetchAll<S.ContractListing>("/v1/contract/list", { contract_type: "charter", status: "open" }, 200, 10)).filter(
            (c) => c.issuer_company_id === companyId && !c.stale,
          )
      : null,
    30_000,
    [companyId],
  );
  const [port, setPort] = useState("");
  const [good, setGood] = useState("");
  const [qty, setQty] = useState("");
  const [reward, setReward] = useState("");
  const [days, setDays] = useState(String(CHARTER.defaultDays));
  const [isPublic, setIsPublic] = useState(false);
  const [title, setTitle] = useState("");
  const refresh = () => {
    void reloadMine();
    void reloadWarehouses();
    void vaults.reload();
  };
  // Resolve to null when the confirmation is declined.
  const post = useAction<S.ContractListing | null>((r) => r && refresh());
  const cancel = useAction<S.CancelCharterResult | null>((r) => r && refresh());

  const base = catalog?.commodities.find((c) => c.id === good)?.base_price_pence ?? 0;
  const maxReward = base * CHARTER.rewardMaxX;
  const wh = (warehouses ?? []).find((w) => w.port_id === port);
  const free = wh?.free_tonnage ?? 0;
  const region = regionOf(port);
  const cash = vaults.cash(region);
  const q = Number(qty);
  const rp = crToPence(reward);
  const d = Number(days);
  const total = Number.isFinite(q) && rp > 0 ? Math.round(q * rp) : Number.NaN;
  const why = firstProblem([
    [!!port, "Choose the port the goods are delivered to."],
    [!!good, "Choose the good."],
    [Number.isInteger(q) && q >= 1, "Enter the tons wanted (whole tons)."],
    [rp > 0, "Enter the reward per ton."],
    [!base || rp <= maxReward, `The reward is at most 10× the good's base price: ${fmtCr(maxReward, 2)} a ton.`],
    [Number.isInteger(d) && d >= CHARTER.minDays && d <= CHARTER.maxDays, "The term is 2..20 game days."],
    [title.trim().length <= CHARTER.titleMax, "The title is at most 120 characters."],
    [warehouses === undefined || free >= q, `Every ton needs free leased warehouse space at ${portName(port)}, reserved now: you have ${fmtTons(free)} free there. Lease more first.`],
    [cash === undefined || !(total > 0) || cash >= total, `The whole reward (${fmtCr(total)}) is escrowed from your ${regionName(region)} vault, which holds ${fmtCr(cash)}.`],
    [mine === undefined || mine.length < CHARTER.maxOpen, `You have ${mine?.length} open charters: at most ${CHARTER.maxOpen}. Cancel one first.`],
  ]);

  function submit() {
    void post.run(async () => {
      if (
        !confirm(
          `Post a charter for ${fmtTons(q)} of ${goodName(good)} delivered to ${portName(port)} at ${fmtCr(rp, 2)} a ton?\n\nThe whole reward (${fmtCr(total)}) is escrowed now from your ${regionName(region)} vault, and ${fmtTons(q)} of your free warehouse space there is reserved. Whoever delivers cargo carried in from another port is paid per ton from it, and the goods land in your warehouse. After ${d} game days (or when you cancel) what is left of the reward and the space comes back. Your own companies can't deliver to it.\n\n${isPublic ? "Listed to everyone." : "Seen live on its quay, and spreads elsewhere as coffee-house gossip."}`,
        )
      )
        return null;
      return kibbPost<S.ContractListing>("/v1/contract/post-charter", {
        port_id: port,
        commodity_id: good,
        quantity: q,
        reward_per_ton_pence: rp,
        duration_game_days: d,
        is_public: isPublic,
        ...(title.trim() ? { title: title.trim() } : {}),
      });
    });
  }

  function cancelOne(c: S.ContractListing) {
    const left = c.remaining_quantity * payPerTon(c);
    void cancel.run(async () => {
      if (
        !confirm(
          `Cancel "${c.title ?? "your charter"}"? The reward for the undelivered ${fmtTons(c.remaining_quantity)} (about ${fmtCr(left)}) comes back to your ${regionName(regionOf(c.origin_port_id))} vault and its warehouse space is freed. Deliveries already made stand.`,
        )
      )
        return null;
      return kibbPost<S.CancelCharterResult>("/v1/contract/cancel-charter", { contract_id: c.id });
    });
  }

  return (
    <div className="grid items-start gap-4 xl:grid-cols-3">
      <div className="space-y-4 xl:col-span-2">
        <Panel title="Your open charters">
          <ErrorNote error={mineError ?? cancel.error} />
          {cancel.result && (
            <p className="mb-3 text-sm">
              Cancelled: {fmtCr(cancel.result.refunded_pence)} refunded, {fmtTons(cancel.result.released_tons)} of warehouse space freed.
            </p>
          )}
          {!mine ? (
            !mineError && <Loading />
          ) : mine.length === 0 ? (
            <Empty>None open. Post one to have goods brought to your warehouse.</Empty>
          ) : (
            <Table head={["Charter", "Deliver to", "Good", "Remaining", "Pay/t", "Escrow left", "Expires", ""]}>
              {mine.map((c) => (
                <tr key={c.id}>
                  <td>
                    <div className="font-medium">{c.title ?? "Charter"}</div>
                    <div className="mt-0.5 flex flex-wrap gap-1">{c.is_public ? <Badge variant="info" size="sm">public</Badge> : <Badge variant="outline" size="sm">quay and gossip</Badge>}</div>
                  </td>
                  <td>{portName(c.origin_port_id)}</td>
                  <td>{goodName(c.commodity_id)}</td>
                  <td className="whitespace-nowrap tabular-nums">
                    {fmtTons(c.remaining_quantity)} <span className="text-muted-foreground">/ {fmtTons(c.quantity_required)}</span>
                  </td>
                  <td className="tabular-nums">{fmtCr(payPerTon(c), 2)}</td>
                  <td className="tabular-nums">{fmtCr(c.remaining_quantity * payPerTon(c))}</td>
                  <td className="whitespace-nowrap">{fmtIn(c.expires_at)}</td>
                  <td className="text-right">
                    <Button size="sm" variant="outline" disabled={cancel.busy} onClick={() => cancelOne(c)}>
                      Cancel
                    </Button>
                  </td>
                </tr>
              ))}
            </Table>
          )}
          <p className="mt-3 text-muted-foreground text-xs">
            Deliveries arrive as events (charter delivery received) and land in your warehouse at the charter&apos;s port. At most {CHARTER.maxOpen} open at once.
          </p>
        </Panel>
        <Panel title="Post a charter">
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Deliver to (your warehouse there)">
                <PortSelect value={port} onChange={setPort} placeholder="Choose…" maxPhase={maxPhase} />
              </Field>
              <Field label="Good">
                <GoodSelect value={good} onChange={setGood} placeholder="Choose…" />
              </Field>
              <Field label="Tons wanted">
                <Input type="number" min={1} step={1} value={qty} onChange={(e) => setQty(e.target.value)} />
              </Field>
              <Field label="Reward per ton (Cr)">
                <Input type="number" min={0.01} step={0.01} value={reward} onChange={(e) => setReward(e.target.value)} placeholder={base ? (base / 100).toFixed(2) : undefined} />
              </Field>
              <Field label="Term (game days)">
                <Input type="number" min={CHARTER.minDays} max={CHARTER.maxDays} step={1} value={days} onChange={(e) => setDays(e.target.value)} />
              </Field>
              <Field label={`Title (optional, ≤ ${CHARTER.titleMax})`}>
                <Input value={title} maxLength={CHARTER.titleMax} onChange={(e) => setTitle(e.target.value)} placeholder={good && port ? `Wanted: ${q || "…"}t of ${goodName(good)} at ${portName(port)}` : undefined} />
              </Field>
            </div>
            <Checkbox checked={isPublic} onChange={setIsPublic}>
              List it to everyone (otherwise it is seen live on its quay and spreads elsewhere as coffee-house gossip, like a Crown charter)
            </Checkbox>
            {(port || good) && (
              <KV
                rows={[
                  ["Base price", good ? `${fmtCr(base, 2)} a ton (reward at most ${fmtCr(maxReward, 2)})` : "—"],
                  ["Reward escrowed now", total > 0 ? fmtCr(total) : "—"],
                  [
                    "Free warehouse space there",
                    !port ? "—" : warehouses === undefined ? "…" : wh ? `${fmtTons(free)} free of ${fmtTons(wh.leased_tonnage)} leased` : "none leased",
                  ],
                ]}
              />
            )}
            <CashLine region={region} cash={cash} need={total > 0 ? total : undefined} />
            {port && warehouses !== undefined && Number.isFinite(q) && free < q && (
              <p className="text-muted-foreground text-xs">
                <Link href="/warehouses" className="text-primary hover:underline">
                  Lease warehouse space
                </Link>{" "}
                at {portName(port)} first: each ton of the charter reserves a ton of it until delivered or released.
              </p>
            )}
            <ErrorNote error={post.error ?? (port || good || qty || reward ? why : null)} />
            {post.result && (
              <p className="text-sm">
                Posted &quot;{post.result.title ?? "charter"}&quot;: {fmtTons(post.result.quantity_required)} {goodName(post.result.commodity_id)} to{" "}
                {portName(post.result.origin_port_id)}, lapsing {fmtIn(post.result.expires_at)}.
              </p>
            )}
            <Button disabled={!!why || post.busy} onClick={submit}>
              {post.busy ? "Posting…" : "Post charter"}
            </Button>
          </div>
        </Panel>
      </div>
      <Panel title="How player charters work">
        <div className="space-y-2 text-muted-foreground text-sm">
          <p>A charter asks for goods delivered to your warehouse at its port, paying a reward per ton to whoever delivers, in parts, first come first served.</p>
          <p>
            Posting escrows the whole reward from your vault in the port&apos;s region and reserves a ton of free leased warehouse space for every ton wanted: you need
            both up front.
          </p>
          <p>Only cargo carried in from another port counts for a deliverer. The goods go into your warehouse; deliverers earn no prestige.</p>
          <p>
            Cancel any time: the reward for the undelivered tons comes back and the space is freed; deliveries already made stand. The same happens when the term
            (2–20 game days) ends.
          </p>
          <p>Your own companies (and linked ones) can&apos;t deliver to it, and the autopilot never targets it. Rewards far above the market are flagged to the Admiralty.</p>
        </div>
      </Panel>
    </div>
  );
}

export default function ContractsPage() {
  const { data: ships, reload: reloadShips } = usePoll(() => kibbGet<ShipResult[]>("/v1/fleet/ships", { limit: 200 }), 15_000);
  const { data: profile } = usePoll(() => kibbGet<CompanyProfile>("/v1/company/profile"));
  const { data: clock, reload: reloadClock } = usePoll(() => kibbGet<WorldClock>("/v1/world/clock"));
  const { data: player } = usePoll(() => dash.get<{ companies: Array<{ id: string; name: string }> }>("/api/kibb/companies"));
  const autopilot = useAutopilotShips();
  // One sealed-freight lookup for every tab, refetched with each ships poll so the two always agree.
  const sealed = useSealedTons([ships]);
  const ourIds = new Set([...(player?.companies.map((c) => c.id) ?? []), ...(profile ? [profile.company.id] : [])]);
  // The sealed tons follow the ships reload on their own.
  const refresh = () => {
    void reloadShips();
    void reloadClock();
  };

  return (
    <div className="space-y-5 pb-8 sm:space-y-6">
      <PageHeader
        title="Contracts"
        subtitle="Charters pay a premium for goods carried in from another port; freight pays to carry someone else's sealed cargo; commissions pay for a hull built to order."
      />
      <Tabs defaultValue="charters">
        <TabsList>
          <TabsTab value="charters">Charters</TabsTab>
          <TabsTab value="freight">Freight</TabsTab>
          <TabsTab value="issue">Issue freight</TabsTab>
          <TabsTab value="post-charter">Post a charter</TabsTab>
          <TabsTab value="commissions">Commissions</TabsTab>
        </TabsList>
        <TabsPanel value="charters" className="pt-2">
          <ChartersTab ships={ships} sealed={sealed} unlockedPhase={clock?.unlocked_phase} autopilot={autopilot} ourIds={ourIds} onDone={refresh} />
        </TabsPanel>
        <TabsPanel value="freight" className="pt-2">
          <FreightTab
            ships={ships}
            companyId={profile?.company.id}
            ourIds={ourIds}
            maxPhase={clock?.unlocked_phase}
            autopilot={autopilot}
            onDone={refresh}
          />
        </TabsPanel>
        <TabsPanel value="issue" className="pt-2">
          <IssueFreightTab companyId={profile?.company.id} maxPhase={clock?.unlocked_phase} onDone={refresh} />
        </TabsPanel>
        <TabsPanel value="post-charter" className="pt-2">
          <PostCharterTab companyId={profile?.company.id} maxPhase={clock?.unlocked_phase} />
        </TabsPanel>
        <TabsPanel value="commissions" className="pt-2">
          <CommissionsView />
        </TabsPanel>
      </Tabs>
    </div>
  );
}
