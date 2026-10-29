"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Empty, ErrorNote, KV, Loading, NativeSelect, PageHeader, Panel, Table } from "@/components/kibb/bits";
import { CreditRecordView, WarnBox } from "@/components/kibb/finance-common";
import { Field, GoodSelect, ShipSelect } from "@/components/kibb/pickers";
import { Checkbox, Segmented } from "@/components/kibb/naval-common";
import { useAction } from "@/hooks/use-action";
import { useCatalog } from "@/hooks/use-catalog";
import { usePoll } from "@/hooks/use-poll";
import { dash, DashboardApiError, kibbGet, kibbPost } from "@/lib/kibb/browser";
import { fmtCr, fmtDateTime, fmtIn, fmtTons } from "@/lib/kibb/format";
import type { FleetView } from "@/lib/kibb/fleet-registry";
import type { UnderworldAccess } from "@/lib/kibb/fleet/smuggle";
import type * as S from "@/lib/kibb/schema";
import type { CompanyProfile, ShipResult } from "@/lib/kibb/types";

// The Free Trade (guide 3.18): contraband lives only aboard ships; coves (seen only from a ship lying there, never searched,
// no factor) keep the Underworld's book; wants are seen at ports where we have presence, and on a cove's board with their
// age; a run ashore needs the ship in the roadstead of a port with a live want. Everything under /v1/underworld needs the
// key's `underworld` scope, which the company key holds only once allowed here.

/** Runs ashore started from this page (the game lists none), kept for the session so their countdown survives a reload. */
const RUNS_STORE = "kibb-underworld-runs";

function loadRuns(): S.RunAshoreResult[] {
  try {
    const all = JSON.parse(sessionStorage.getItem(RUNS_STORE) ?? "[]") as S.RunAshoreResult[];
    return Array.isArray(all) ? all.filter((r) => typeof r?.completes_at === "string") : [];
  } catch {
    return [];
  }
}

function saveRuns(runs: S.RunAshoreResult[]): void {
  try {
    sessionStorage.setItem(RUNS_STORE, JSON.stringify(runs.slice(-20)));
  } catch {
    // Storage blocked: the list lasts this page.
  }
}

/** A refusal for want of the scope reads as what to do about it. */
function scopeNote(e: Error | string | null | undefined): Error | string | null {
  if (!e) return null;
  if (e instanceof DashboardApiError && e.code === "missing_scope") return "The company key doesn't hold the underworld scope: allow smuggling above first.";
  if (e instanceof DashboardApiError && e.code === "no_ship_at_cove") return "A cove's book and board are seen only from a ship of yours lying there.";
  return e;
}

/** Re-renders every `ms` (countdowns). */
function useTick(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

const x = (bps: number) => `${(bps / 10_000).toLocaleString("en-GB", { maximumFractionDigits: 2 })}×`;

function Risks() {
  return (
    <WarnBox tone="error">
      <p className="font-medium">Smuggling can cost you the ship and everything aboard.</p>
      <ul className="list-disc space-y-0.5 pl-5">
        <li>
          A ship caught with contraband is <b>forfeit with everything aboard</b> (lawful cargo and stores too), exactly as if she sank: a lender&apos;s
          lien on her is lost, ship shares in her are worthless, a venture riding on her is lost.
        </li>
        <li>
          <b>Insurance pays nothing</b> for a seizure, and Lloyd&apos;s never covers a ship carrying contraband (its slice is dropped if she sails with it).
        </li>
        <li>
          The <b>conviction goes on your public credit record</b> for good: lenders (the autopilot&apos;s among them) read it.
        </li>
        <li>
          At sea only patrols search, in the zones they patrol. In an ordinary port a ship lying there with contraband aboard may be searched at any
          time, berthed more than in the roadstead. Coves are never searched. Faster is safer; running goods ashore often draws the Crown&apos;s attention.
        </li>
      </ul>
    </WarnBox>
  );
}

function AccessPanel({ access, error, onChanged }: { access: UnderworldAccess | undefined; error: Error | null; onChanged: () => void }) {
  const act = useAction<UnderworldAccess | null>(() => onChanged());
  const allowed = access?.underworld === true;

  function change(allow: boolean) {
    void act.run(async () => {
      const ok = allow
        ? confirm(
            "Allow smuggling for this company? The company key is minted again with the underworld scope (and keeps it on every renewal until you " +
              "withdraw it here). It lets this dashboard trade at the coves and run goods ashore, and lets the autopilot's smuggling mode run if you also " +
              "turn that on in the fleet settings. A seized ship is forfeit with everything aboard, insurance pays nothing, and the conviction goes on " +
              "the company's public credit record. Continue?",
          )
        : confirm(
            "Withdraw smuggling? The company key is minted again without the underworld scope and the old key is revoked: the Underworld page and the " +
              "autopilot's smuggling mode stop at once. Contraband already aboard stays aboard (a ship lying in an ordinary port with it may still be searched).",
          );
      if (!ok) return null;
      return dash.post<UnderworldAccess>("/api/kibb/company/underworld", { allow });
    });
  }

  return (
    <Panel
      title="Access"
      action={
        access && (
          <Badge variant={allowed ? "destructive" : "secondary"} size="sm">
            {allowed ? "smuggling allowed" : "smuggling not allowed"}
          </Badge>
        )
      }
    >
      <ErrorNote error={error} />
      {!access ? (
        !error && <Loading />
      ) : (
        <div className="space-y-3">
          <p className="text-sm">
            {allowed
              ? "The company key holds the underworld scope: this page may trade at the coves and run goods ashore, and the autopilot's smuggling mode may run if it is on in the fleet settings."
              : "The company key doesn't hold the underworld scope (it never does by default, so a trading key can't gamble ships). Allow smuggling to trade here; you must be signed in as the owner."}
          </p>
          <KV
            rows={[
              ["Key scopes", access.scopes.join(", ") || "—"],
              ["Key expires", access.keyExpiresAt ? `${fmtDateTime(access.keyExpiresAt)} (${fmtIn(access.keyExpiresAt)})` : "never"],
              ...(access.verified ? [] : ([["Checked", "as last recorded (the game couldn't be asked just now)"]] as Array<[string, string]>)),
            ]}
          />
          <ErrorNote error={act.error} />
          <Button variant={allowed ? "outline" : "destructive"} disabled={act.busy} onClick={() => change(!allowed)}>
            {act.busy ? "Minting a new key…" : allowed ? "Withdraw smuggling" : "Allow smuggling"}
          </Button>
          <p className="text-muted-foreground text-xs">
            The company key is minted again with your sign-in key (the scope is added or taken away), any running autopilot switches to it at once, and
            the key it replaces is revoked. Renewals keep the scope as you leave it here.
          </p>
        </div>
      )}
    </Panel>
  );
}

function ModePanel({ fleet }: { fleet: FleetView | undefined }) {
  const m = fleet?.state?.smuggling;
  const on = fleet?.settings.smuggling;
  return (
    <Panel title="The autopilot's smuggling mode">
      {!fleet ? (
        <Loading />
      ) : (
        <div className="space-y-2 text-sm">
          <p>
            {on ? "On in the fleet settings" : "Off in the fleet settings (the default)"}
            {m ? `: ${m.active ? "running" : m.state}.` : "."}{" "}
            <Link href="/dashboard" className="underline">
              Fleet settings
            </Link>
          </p>
          {m?.halt && <ErrorNote error={`Switched off after a seizure (${m.halt.why}): it stays off until you turn it on again.`} />}
          {m && (
            <KV
              rows={[
                ["Last decision", m.action],
                ["Smuggling now", m.ships.length ? m.ships.map((s) => s.name).join(", ") : "none"],
                ["Runs ashore", `${m.stats.runs} · ${fmtTons(m.stats.landedTons)} landed for ${fmtCr(m.stats.proceedsPence)} (goods ${fmtCr(m.stats.spentPence)})`],
                ["Seized", m.stats.seizures ? `${m.stats.seizures} (${m.stats.convictions} conviction${m.stats.convictions === 1 ? "" : "s"})` : "none"],
                ["Odds a run ends in a seizure", `~${(m.model.odds * 100).toFixed(1)}% (learned from ${m.model.runs} voyages)`],
                ["A run buys at most", `${fmtTons(m.maxTons)} and ${fmtCr(m.maxPence)}`],
              ]}
            />
          )}
          <p className="text-muted-foreground text-xs">
            One dedicated ship at a time buys small loads at a cove on a fresh want, sails only through zones no patrol works, never berths in an ordinary
            port with the goods aboard and runs them ashore at once, only when the expected gain is at least twice the expected loss. Its log is on the
            dashboard&apos;s fleet panel.
          </p>
        </div>
      )}
    </Panel>
  );
}

/** A cove's book (house ask, players' bids and asks) and its board of wants, from a ship of ours lying there; and trading on it. */
function CovePanel({ cove, ships, onTraded }: { cove: string; ships: ShipResult[]; onTraded: () => void }) {
  const { catalog, portName, goodName } = useCatalog();
  const isContraband = (g: string) => catalog?.commodities.find((c) => c.id === g)?.category === "contraband";
  const { data: bookRead, error: bookError, reload: reloadBook } = usePoll(
    cove ? () => kibbGet<S.CoveBookResult>("/v1/underworld/book", { port_id: cove }) : null,
    30_000,
    [cove],
  );
  const { data: wantsRead, error: wantsError } = usePoll(cove ? () => kibbGet<S.WantsResult>("/v1/underworld/wants", { port_id: cove }) : null, 60_000, [cove]);
  // An answer for the cove picked before (still in flight when the pick changed) is never shown as this one's.
  const book = bookRead?.port_id === cove ? bookRead : undefined;
  const wants = wantsRead?.port_id === cove ? wantsRead : undefined;
  const here = ships.filter((r) => r.ship.current_port_id === cove && r.ship.status !== "sailing");
  const [shipId, setShipId] = useState("");
  const [good, setGood] = useState("");
  const [side, setSide] = useState<"bid" | "ask">("bid");
  const [tif, setTif] = useState<"ioc" | "gtc">("ioc");
  const [price, setPrice] = useState("");
  const [qty, setQty] = useState("1");
  const act = useAction<S.UnderworldOrderResult | null>(() => {
    void reloadBook();
    onTraded();
  });
  const ship = here.find((r) => r.ship.id === shipId) ?? here[0];
  const p = Math.round(Number(price) * 100);
  const q = Math.floor(Number(qty));
  const aboard = ship && good ? (ship.cargo_manifest[good] ?? 0) : 0;
  const free = ship ? ship.effective_hold_capacity_tons - ship.cargo_used_tons : 0;
  // What a seizure would take with the goods (guide 3.18: the ship and everything aboard): lawful cargo and freight aboard,
  // a policy on her (void: Lloyd's never covers contraband), a lender's lien (the loans page shows it).
  const shipIdNow = ship?.ship.id ?? "";
  const { data: policies } = usePoll(
    shipIdNow ? () => kibbGet<S.InsurancePolicyListing[]>("/v1/insurance/list", { ship_id: shipIdNow, limit: 50 }) : null,
    60_000,
    [shipIdNow],
  );
  const lawful = ship ? Object.entries(ship.cargo_manifest).filter(([g, t]) => t > 0 && !isContraband(g)) : [];
  const insured = (policies ?? []).some((x) => x.ship_id === shipIdNow && (x.status === "open" || x.status === "active"));
  const exposed = [
    ...(lawful.length ? [`lawful cargo or freight aboard (${lawful.map(([g, t]) => `${fmtTons(t)} ${goodName(g)}`).join(", ")})`] : []),
    ...(insured ? ["an insurance policy on her (it pays nothing for a ship carrying contraband)"] : []),
  ];
  const problem = !ship
    ? "no ship of yours lies at this cove"
    : !good
      ? "choose a good"
      : !(p > 0)
        ? "a price per ton"
        : !(q >= 1)
          ? "at least a ton"
          : side === "ask" && q > aboard
            ? `only ${fmtTons(aboard)} aboard`
            : side === "bid" && q > free
              ? `only ${fmtTons(free, 1)} of hold free`
              : null;

  function submit() {
    if (problem || !ship) return;
    void act.run(async () => {
      const what = `${side === "bid" ? "Buy" : "Sell"} up to ${q} t of ${goodName(good)} at ${fmtCr(p)}/t ${tif === "ioc" ? "(what fills now; the rest is dropped)" : "(the rest rests on the book; a bid escrows its money; withdrawn if the ship sails)"}`;
      const warn =
        side === "bid"
          ? " Contraband aboard can't be sold on any lawful market or put in a warehouse; a ship lying in an ordinary port with it may be searched, and a patrol searches her at sea in its zones; if caught, she is forfeit with everything aboard (no insurance pays; a lender's lien and shares in her are lost)." +
            (exposed.length ? `\n\nWARNING: ${ship.ship.name} has ${exposed.join(" and ")}: a seizure takes all of it.` : "") +
            "\n\nThe autopilot then never sails her through a zone a patrol works, nor out of an ordinary port short of stores (none may be bought there with contraband aboard)."
          : "";
      if (!confirm(`${what} from ${ship.ship.name} at ${portName(cove)}?${warn}`)) return null;
      return kibbPost<S.UnderworldOrderResult>("/v1/underworld/order", {
        ship_id: ship.ship.id,
        commodity_id: good,
        side,
        time_in_force: tif,
        price_pence: p,
        quantity: q,
      });
    });
  }

  return (
    <div className="grid items-start gap-4 xl:grid-cols-3">
      <Panel title={`Book at ${portName(cove)}`} className="xl:col-span-2" action={<span className="text-muted-foreground text-xs">a cove is never searched</span>}>
        <ErrorNote error={scopeNote(bookError)} />
        {!book ? (
          !bookError && <Loading />
        ) : book.books.length === 0 ? (
          <Empty>Nothing on the book.</Empty>
        ) : (
          <Table head={["Good", "The Underworld sells", "Players' asks", "Players' bids"]}>
            {book.books.map((b) => (
              <tr key={b.commodity_id} className="cursor-pointer align-top hover:bg-accent/50" onClick={() => setGood(b.commodity_id)}>
                <td className="font-medium">{goodName(b.commodity_id)}</td>
                <td className="whitespace-nowrap tabular-nums">{b.house_ask ? `${fmtTons(b.house_ask.quantity)} at ${fmtCr(b.house_ask.price_pence)}` : <span className="text-muted-foreground">sold out</span>}</td>
                <td className="text-xs tabular-nums">
                  {b.asks.length ? b.asks.slice(0, 4).map((l) => `${fmtTons(l.quantity)} at ${fmtCr(l.price_pence)}`).join(", ") : "—"}
                </td>
                <td className="text-xs tabular-nums">
                  {b.bids.length ? b.bids.slice(0, 4).map((l) => `${fmtTons(l.quantity)} at ${fmtCr(l.price_pence)}`).join(", ") : "—"}
                </td>
              </tr>
            ))}
          </Table>
        )}
        <p className="mt-3 text-muted-foreground text-xs">
          The Underworld sells each good from a limited stock that refills over time, at a price drifting around its base; players post bids and asks
          on the same book. Fills are ship to ship at the maker&apos;s price, paid vault to vault in the cove&apos;s region. You never deal with yourself;
          your other companies deal with you like strangers.
        </p>
        <div className="mt-4 space-y-1.5">
          <div className="font-medium text-muted-foreground text-xs">Board of wants carried here (news travels only from the wanting ports to the coves)</div>
          <ErrorNote error={scopeNote(wantsError)} />
          {!wants ? (
            !wantsError && <Loading />
          ) : wants.board.length === 0 ? (
            <Empty>No wants carried in yet.</Empty>
          ) : (
            <Table head={["Port", "Good", "Multiple seen", "Seen"]}>
              {[...wants.board]
                .sort((a, b) => a.age_game_hours - b.age_game_hours)
                .map((w) => (
                  <tr key={`${w.port_id}|${w.commodity_id}`}>
                    <td>{portName(w.port_id)}</td>
                    <td>{goodName(w.commodity_id)}</td>
                    <td className="tabular-nums">{x(w.multiple_bps)} base</td>
                    <td className={`text-xs ${w.age_game_hours > 24 ? "text-muted-foreground" : ""}`}>
                      {w.age_game_hours} game h ago ({fmtDateTime(w.observed_at)})
                    </td>
                  </tr>
                ))}
            </Table>
          )}
          <p className="text-muted-foreground text-xs">A want fades with time and then is gone, and every ton run ashore walks its price down: an old report may be stale.</p>
        </div>
      </Panel>

      <Panel title="Trade on the book">
        <div className="space-y-3">
          <Field label="Your ship at the cove">
            <ShipSelect value={ship?.ship.id ?? ""} onChange={setShipId} ships={here} placeholder={here.length ? undefined : "No ship of yours here"} />
          </Field>
          <Segmented<"bid" | "ask">
            value={side}
            onChange={setSide}
            options={[
              { value: "bid", label: "Buy" },
              { value: "ask", label: "Sell" },
            ]}
          />
          <Field label="Good">
            <GoodSelect value={good} onChange={setGood} placeholder="Choose contraband…" contraband="only" />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Price (Cr per ton)">
              <Input type="number" min={0} step={0.01} value={price} onChange={(e) => setPrice(e.target.value)} />
            </Field>
            <Field label="Tons">
              <Input type="number" min={1} value={qty} onChange={(e) => setQty(e.target.value)} />
            </Field>
          </div>
          <Segmented<"ioc" | "gtc">
            value={tif}
            onChange={setTif}
            options={[
              { value: "ioc", label: "Fill now (IOC)" },
              { value: "gtc", label: "Rest on the book (GTC)" },
            ]}
          />
          <KV
            rows={[
              ["Aboard", ship && good ? fmtTons(aboard) : "—"],
              ["Hold free", ship ? fmtTons(free, 1) : "—"],
              ["Total at the limit", p > 0 && q >= 1 ? fmtCr(p * q) : "—"],
            ]}
          />
          {problem && <p className="text-muted-foreground text-xs">{problem}</p>}
          {side === "bid" && ship && exposed.length > 0 && (
            <WarnBox tone="error">
              {ship.ship.name} has {exposed.join(" and ")}. Buying contraband onto her puts all of it at risk: a seizure forfeits the ship and everything
              aboard. Better a ship with nothing else aboard, uninsured and unpledged.
            </WarnBox>
          )}
          <ErrorNote error={scopeNote(act.error)} />
          {act.result && (
            <p className="text-sm">
              Filled {fmtTons(act.result.filled_quantity)} of {fmtTons(act.result.requested_quantity)} for {fmtCr(act.result.total_gross_pence)}
              {act.result.resting_quantity > 0 ? `; ${fmtTons(act.result.resting_quantity)} resting on the book` : ""}.
            </p>
          )}
          <Button className="w-full" variant="destructive" disabled={!!problem || act.busy} onClick={submit}>
            {act.busy ? "Placing…" : side === "bid" ? "Buy contraband" : "Sell contraband"}
          </Button>
        </div>
      </Panel>
    </div>
  );
}

function OrdersPanel({ reloadKey }: { reloadKey: number }) {
  const { portName, goodName } = useCatalog();
  const [openOnly, setOpenOnly] = useState(true);
  const { data: orders, error, reload } = usePoll(() => kibbGet<S.UnderworldOrderView[]>("/v1/underworld/orders", { open_only: openOnly, limit: 100 }), 30_000, [openOnly, reloadKey]);
  const act = useAction<S.CancelUnderworldOrderResult | null>(() => void reload());
  return (
    <Panel
      title="Your cove orders"
      action={
        <Checkbox checked={openOnly} onChange={setOpenOnly}>
          <span className="text-xs">Open only</span>
        </Checkbox>
      }
    >
      <ErrorNote error={scopeNote(error)} />
      <ErrorNote error={scopeNote(act.error)} />
      {!orders ? (
        !error && <Loading />
      ) : orders.length === 0 ? (
        <Empty>{openOnly ? "No open orders." : "No orders."}</Empty>
      ) : (
        <Table head={["Cove", "Order", "Filled", "Status", "Placed", ""]}>
          {orders.map((o) => (
            <tr key={o.id} className="align-top">
              <td>{portName(o.port_id)}</td>
              <td className="text-xs">
                {o.side === "bid" ? "buy" : "sell"} {fmtTons(o.quantity)} {goodName(o.commodity_id)} at {fmtCr(o.price_pence)}
              </td>
              <td className="tabular-nums">{fmtTons(o.filled_quantity)}</td>
              <td className="text-xs">
                {o.status}
                {o.cancel_reason && <div className="text-muted-foreground">{o.cancel_reason}</div>}
              </td>
              <td className="whitespace-nowrap text-xs">{fmtDateTime(o.created_at)}</td>
              <td>
                {o.status === "open" && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={act.busy}
                    onClick={() =>
                      void act.run(async () =>
                        confirm("Withdraw this order? A bid's escrow returns to your vault.") ? kibbPost<S.CancelUnderworldOrderResult>("/v1/underworld/cancel-order", { order_id: o.id }) : null,
                      )
                    }
                  >
                    Cancel
                  </Button>
                )}
              </td>
            </tr>
          ))}
        </Table>
      )}
      <p className="mt-3 text-muted-foreground text-xs">A ship&apos;s orders are withdrawn when she sails. A resting ask is checked against her hold when it fills.</p>
    </Panel>
  );
}

/** Live wants at the ports where a ship of ours lies or a factor sits (ordinary ports only). */
function WantsPanel({ ports }: { ports: string[] }) {
  const { portName, goodName } = useCatalog();
  const key = ports.join(",");
  const { data, error } = usePoll(
    ports.length
      ? async () => {
          const got = await Promise.allSettled(ports.map((p) => kibbGet<S.WantsResult>("/v1/underworld/wants", { port_id: p })));
          const ok = got.flatMap((g) => (g.status === "fulfilled" ? [g.value] : []));
          const failed = got.find((g): g is PromiseRejectedResult => g.status === "rejected");
          if (!ok.length && failed) throw failed.reason as Error;
          return ok;
        }
      : null,
    60_000,
    [key],
  );
  const rows = (data ?? []).flatMap((w) => w.wants.map((x) => ({ port: w.port_id, ...x }))).sort((a, b) => b.multiple_bps - a.multiple_bps);
  return (
    <Panel title="Live wants where you have presence">
      <ErrorNote error={scopeNote(error)} />
      {!ports.length ? (
        <Empty>No ship of yours lies in an ordinary port, and no factor: wants are seen only where you have presence (or on a cove&apos;s board).</Empty>
      ) : !data ? (
        !error && <Loading />
      ) : rows.length === 0 ? (
        <Empty>No live wants at {ports.map((p) => portName(p)).join(", ")}.</Empty>
      ) : (
        <Table head={["Port", "Good", "First ton fetches", "Still takes"]}>
          {rows.map((w) => (
            <tr key={`${w.port}|${w.commodity_id}`}>
              <td>{portName(w.port)}</td>
              <td>{goodName(w.commodity_id)}</td>
              <td className="tabular-nums">{x(w.multiple_bps)} base</td>
              <td className="tabular-nums">{fmtTons(w.remaining_tons)}</td>
            </tr>
          ))}
        </Table>
      )}
      <p className="mt-3 text-muted-foreground text-xs">
        Read at {ports.length ? ports.map((p) => portName(p)).join(", ") : "—"}. Wants are told nowhere else: not at other ports, not in the coffee houses
        or envelopes; a ship that called here carries them to the next cove she reaches.
      </p>
    </Panel>
  );
}

/** Running goods ashore: a ship in the roadstead of a port with a live want for a good aboard. */
function RunPanel({ ships, onDone }: { ships: ShipResult[]; onDone: () => void }) {
  const { catalog, portName, goodName } = useCatalog();
  const now = useTick(1_000);
  const [runs, setRuns] = useState<S.RunAshoreResult[]>([]);
  useEffect(() => setRuns(loadRuns()), []);
  const isContraband = (g: string) => catalog?.commodities.find((c) => c.id === g)?.category === "contraband";
  const isCove = (p: string | null | undefined) => !!p && !!catalog?.ports.find((x) => x.id === p)?.is_cove;
  const carriers = ships.filter(
    (r) => r.ship.status !== "sailing" && r.ship.current_port_id && !isCove(r.ship.current_port_id) && Object.entries(r.cargo_manifest).some(([g, t]) => t > 0 && isContraband(g)),
  );
  const [shipId, setShipId] = useState("");
  const ship = carriers.find((r) => r.ship.id === shipId) ?? carriers[0];
  const port = ship?.ship.current_port_id ?? "";
  const { data: wantsRead, error: wantsError, reload: reloadWants } = usePoll(
    port ? () => kibbGet<S.WantsResult>("/v1/underworld/wants", { port_id: port }) : null,
    30_000,
    [port],
  );
  // An answer for the port of the ship picked before is never taken for this one's wants.
  const wants = wantsRead?.port_id === port ? wantsRead : undefined;
  const [good, setGood] = useState("");
  const [qty, setQty] = useState("");
  const aboard = ship ? Object.entries(ship.cargo_manifest).filter(([g, t]) => t > 0 && isContraband(g)) : [];
  const wanted = aboard.filter(([g]) => wants?.wants.some((w) => w.commodity_id === g && w.remaining_tons > 0));
  const pick = wanted.find(([g]) => g === good)?.[0] ?? wanted[0]?.[0] ?? "";
  const want = wants?.wants.find((w) => w.commodity_id === pick);
  const have = ship && pick ? (ship.cargo_manifest[pick] ?? 0) : 0;
  const q = qty.trim() === "" ? Math.min(Math.floor(have), want?.remaining_tons ?? 0) : Math.floor(Number(qty));
  const act = useAction<S.RunAshoreResult | null>((r) => {
    if (r) {
      const next = [...loadRuns(), r];
      saveRuns(next);
      setRuns(next);
    }
    void reloadWants();
    onDone();
  });
  const offshore = useAction<unknown>(() => onDone());
  const problem = !ship
    ? "no ship of yours lies in an ordinary port with contraband aboard"
    : ship.ship.status === "berthed"
      ? "she is berthed: a run needs her in the roadstead (and a berthed ship is searched more)"
      : !pick
        ? "no live want here for what she carries"
        : !(q >= 1)
          ? "at least a ton"
          : q > have
            ? `only ${fmtTons(have)} aboard`
            : null;

  function submit() {
    if (problem || !ship || !pick) return;
    void act.run(async () => {
      if (
        !confirm(
          `Run ${q} t of ${goodName(pick)} ashore at ${portName(port)} from ${ship.ship.name}? It takes a few game hours; she must stay in the roadstead ` +
            "until it completes (departing cancels it; the goods stay aboard). The price is fixed when it completes, each ton walking the want down. " +
            "While she lies here with contraband aboard she may be searched: if caught, she and everything aboard are forfeit, insurance pays nothing, " +
            "and the conviction goes on your public credit record.",
        )
      )
        return null;
      return kibbPost<S.RunAshoreResult>("/v1/underworld/run", { ship_id: ship.ship.id, commodity_id: pick, quantity: q });
    });
  }

  const recent = runs.filter((r) => Date.parse(r.completes_at) > now - 30 * 60_000).reverse();
  return (
    <Panel title="Run goods ashore">
      <div className="space-y-3">
        <Field label="Your ship (in an ordinary port, contraband aboard)">
          <ShipSelect value={ship?.ship.id ?? ""} onChange={setShipId} ships={carriers} placeholder={carriers.length ? undefined : "None"} />
        </Field>
        {ship && (
          <KV
            rows={[
              ["Lying", `${portName(port)} · ${ship.ship.status === "berthed" ? "berthed" : "in the roadstead"}`],
              ["Contraband aboard", aboard.map(([g, t]) => `${fmtTons(t)} ${goodName(g)}`).join(", ") || "—"],
            ]}
          />
        )}
        {ship?.ship.status === "berthed" && (
          <Button
            size="sm"
            variant="outline"
            disabled={offshore.busy}
            onClick={() => void offshore.run(() => kibbPost("/v1/fleet/offshore", { ship_id: ship.ship.id }))}
          >
            {offshore.busy ? "Moving…" : "Move her to the roadstead"}
          </Button>
        )}
        <ErrorNote error={offshore.error} />
        <ErrorNote error={scopeNote(wantsError)} />
        <Field label="Good (wanted here)">
          <NativeSelect value={pick} onChange={(e) => setGood(e.target.value)} disabled={!wanted.length}>
            {!wanted.length && <option value="">No want here for what she carries</option>}
            {wanted.map(([g, t]) => {
              const w = wants?.wants.find((x) => x.commodity_id === g);
              return (
                <option key={g} value={g}>
                  {goodName(g)} · {fmtTons(t)} aboard · {w ? `${x(w.multiple_bps)} base, ${w.remaining_tons} t wanted` : ""}
                </option>
              );
            })}
          </NativeSelect>
        </Field>
        <Field label="Tons">
          <Input type="number" min={1} value={qty} placeholder={q >= 1 ? String(q) : ""} onChange={(e) => setQty(e.target.value)} />
        </Field>
        {problem && <p className="text-muted-foreground text-xs">{problem}</p>}
        <ErrorNote error={scopeNote(act.error)} />
        <Button className="w-full" variant="destructive" disabled={!!problem || act.busy} onClick={submit}>
          {act.busy ? "Starting…" : "Run ashore"}
        </Button>
        {recent.length > 0 && (
          <Table head={["Run", "Completes"]}>
            {recent.map((r) => (
              <tr key={r.run_id}>
                <td className="text-xs">
                  {fmtTons(r.quantity)} {goodName(r.commodity_id)} at {portName(r.port_id)}
                </td>
                <td className="whitespace-nowrap text-xs">
                  {Date.parse(r.completes_at) > now ? fmtIn(r.completes_at) : "done: its pay (underworld_run_completed) goes to your vault in the port's region"}
                </td>
              </tr>
            ))}
          </Table>
        )}
        <p className="text-muted-foreground text-xs">
          The first ashore takes the best of a want, and the want may be gone by the time a run completes. One run at a time per ship.
        </p>
      </div>
    </Panel>
  );
}

/** Our ships with contraband aboard, and where (an ordinary port is where a search may find it). */
function AboardPanel({ ships }: { ships: ShipResult[] }) {
  const { catalog, portName, goodName } = useCatalog();
  const isContraband = (g: string) => catalog?.commodities.find((c) => c.id === g)?.category === "contraband";
  const isCove = (p: string | null | undefined) => !!p && !!catalog?.ports.find((x) => x.id === p)?.is_cove;
  const rows = ships
    .map((r) => ({ r, goods: Object.entries(r.cargo_manifest).filter(([g, t]) => t > 0 && isContraband(g)) }))
    .filter((x) => x.goods.length > 0);
  return (
    <Panel title="Contraband aboard your ships">
      {rows.length === 0 ? (
        <Empty>None.</Empty>
      ) : (
        <Table head={["Ship", "Where", "Aboard", ""]}>
          {rows.map(({ r, goods }) => {
            const port = r.ship.current_port_id;
            const risky = r.ship.status !== "sailing" && port && !isCove(port);
            return (
              <tr key={r.ship.id} className="align-top">
                <td>
                  <Link href={`/fleet/${r.ship.id}`} className="font-medium hover:underline">
                    {r.ship.name}
                  </Link>
                </td>
                <td className="text-xs">
                  {r.ship.status === "sailing" ? `at sea → ${portName(r.route_legs.at(-1)?.to_node)}` : `${portName(port)} · ${r.ship.status === "berthed" ? "berthed" : "roadstead"}`}
                </td>
                <td className="text-xs">{goods.map(([g, t]) => `${fmtTons(t)} ${goodName(g)}`).join(", ")}</td>
                <td>
                  {risky ? (
                    <Badge variant="destructive" size="sm" title="A ship lying in an ordinary port with contraband aboard may be searched at any time (berthed more than in the roadstead)">
                      may be searched
                    </Badge>
                  ) : r.ship.status === "sailing" ? (
                    <Badge variant="warning" size="sm" title="At sea only patrols search, in the zones they patrol">
                      patrols search
                    </Badge>
                  ) : (
                    <Badge variant="success" size="sm" title="Coves are never searched">
                      at a cove
                    </Badge>
                  )}
                </td>
              </tr>
            );
          })}
        </Table>
      )}
    </Panel>
  );
}

export default function UnderworldPage() {
  const { catalog, portName } = useCatalog();
  const { data: access, error: accessError, reload: reloadAccess } = usePoll(() => dash.get<UnderworldAccess>("/api/kibb/company/underworld"), 60_000);
  const { data: ships, error: shipsError, reload: reloadShips } = usePoll(() => kibbGet<ShipResult[]>("/v1/fleet/ships", { limit: 200 }), 15_000);
  const { data: profile } = usePoll(() => kibbGet<CompanyProfile>("/v1/company/profile"), 120_000);
  const { data: fleet } = usePoll(() => dash.get<FleetView>("/api/kibb/fleet"), 15_000);
  const { data: credit, error: creditError } = usePoll(
    profile ? () => kibbGet<S.CreditReport>("/v1/loan/credit", { company_id: profile.company.id }) : null,
    120_000,
    [profile?.company.id],
  );
  const [cove, setCove] = useState("");
  const [traded, setTraded] = useState(0);
  const allowed = access?.underworld === true;

  const isCove = (p: string | null | undefined) => !!p && !!catalog?.ports.find((x) => x.id === p)?.is_cove;
  const lying = (ships ?? []).filter((r) => r.ship.status !== "sailing" && r.ship.status !== "sunk" && !!r.ship.current_port_id);
  const coves = [...new Set(lying.map((r) => r.ship.current_port_id!).filter((p) => isCove(p)))];
  const coveId = coves.includes(cove) ? cove : (coves[0] ?? "");
  const presence = [...new Set([...lying.map((r) => r.ship.current_port_id!), ...(profile?.factor_ports ?? [])])].filter((p) => !isCove(p)).slice(0, 10);
  const allCoves = (catalog?.ports ?? []).filter((p) => p.is_cove);

  function refresh() {
    void reloadShips();
    setTraded((n) => n + 1);
  }

  return (
    <div className="space-y-5 pb-8 sm:space-y-6">
      <PageHeader
        title="Underworld"
        subtitle="The Free Trade: contraband bought at the smugglers' coves and run ashore where it is wanted. Every step risks the ship and everything aboard."
        badges={access && <Badge variant={allowed ? "destructive" : "secondary"}>{allowed ? "smuggling allowed" : "not allowed"}</Badge>}
      />

      <Risks />

      <div className="grid items-start gap-4 xl:grid-cols-2">
        <AccessPanel
          access={access}
          error={accessError}
          onChanged={() => {
            void reloadAccess();
            refresh();
          }}
        />
        <ModePanel fleet={fleet} />
      </div>

      {!allowed ? (
        access && (
          <Panel title="Coves">
            <p className="text-sm">
              Allow smuggling above to see a cove&apos;s book and board (from a ship of yours lying there), the wants where you have presence, and to run
              goods ashore.
            </p>
            {allCoves.length > 0 && <p className="mt-2 text-muted-foreground text-xs">The coves: {allCoves.map((p) => p.name).join(", ")}.</p>}
          </Panel>
        )
      ) : (
        <>
          <ErrorNote error={shipsError} />
          <Panel
            title="Coves"
            action={
              coves.length > 1 && (
                <NativeSelect value={coveId} onChange={(e) => setCove(e.target.value)} className="w-48">
                  {coves.map((c) => (
                    <option key={c} value={c}>
                      {portName(c)}
                    </option>
                  ))}
                </NativeSelect>
              )
            }
          >
            <p className="text-sm">
              {coves.length
                ? `A ship of yours lies at ${coves.map((c) => portName(c)).join(", ")}: its book and board are below.`
                : "No ship of yours lies at a cove: a cove's book and board are seen only from a ship lying there (no factor may be hired at a cove)."}
            </p>
            {allCoves.length > 0 && (
              <p className="mt-2 text-muted-foreground text-xs">
                The coves: {allCoves.map((p) => `${p.name}${p.phase > 1 ? ` (phase ${p.phase})` : ""}`).join(", ")}. A cove sells ships&apos; stores and is
                never searched.
              </p>
            )}
          </Panel>
          {coveId && <CovePanel cove={coveId} ships={ships ?? []} onTraded={refresh} />}

          <div className="grid items-start gap-4 xl:grid-cols-2">
            <WantsPanel ports={presence} />
            <RunPanel ships={ships ?? []} onDone={refresh} />
          </div>

          <div className="grid items-start gap-4 xl:grid-cols-2">
            <OrdersPanel reloadKey={traded} />
            <AboardPanel ships={ships ?? []} />
          </div>
        </>
      )}

      <Panel title="Your credit record">
        <ErrorNote error={creditError} />
        {!credit ? !creditError && <Loading /> : <CreditRecordView report={credit} />}
        <p className="mt-3 text-muted-foreground text-xs">Public: every lender can read it. A smuggling conviction stays on it.</p>
      </Panel>
    </div>
  );
}
