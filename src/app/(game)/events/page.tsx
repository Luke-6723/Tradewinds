"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsPanel, TabsTab } from "@/components/ui/tabs";
import { Empty, ErrorNote, Loading, NativeSelect, PageHeader, Panel } from "@/components/kibb/bits";
import { Field, PortSelect } from "@/components/kibb/pickers";
import { LoadMore, usePaged } from "@/components/kibb/company-paged";
import { useCatalog, type CatalogHelpers } from "@/hooks/use-catalog";
import { usePoll } from "@/hooks/use-poll";
import { DashboardApiError, kibbGet } from "@/lib/kibb/browser";
import { fmtBps, fmtCr, fmtDateTime, fmtTime, titleCase } from "@/lib/kibb/format";
import type * as S from "@/lib/kibb/schema";
import type { ShipResult } from "@/lib/kibb/types";

/** Most recent events kept in the live feed. */
const MAX_EVENTS = 1000;

const GROUPS: Array<{ label: string; match: string[] }> = [
  { label: "Ships", match: ["ship_", "voyage_hazard"] },
  // Sales include the ship broker's buys (ship_sold) and the Crown's commissions for navy hulls.
  { label: "Commissions & ship sales", match: ["commission_", "admiralty_commission_", "ship_listed", "ship_sold", "ship_broken_up"] },
  { label: "Passengers", match: ["passengers_"] },
  { label: "Convoys", match: ["convoy_"] },
  { label: "Market", match: ["order_filled", "maker_order_filled", "order_cancelled"] },
  { label: "Charters & expansion", match: ["charter_", "expansion_", "world_phase_unlocked"] },
  { label: "Freight", match: ["freight_"] },
  { label: "Futures", match: ["futures_"] },
  { label: "Insurance", match: ["insurance_"] },
  { label: "Loans & banks", match: ["loan_", "bank_", "lending_line_"] },
  // The NPC desks' co-investments, share buys and news buys arrive as the market's own events.
  { label: "Ventures, shares & envelopes", match: ["venture_", "ship_shares_", "envelope_"] },
  {
    label: "Money",
    match: ["company_upkeep_billed", "auto_remittance", "bank_draft", "tax_and_fee_charged", "home_port_relocated", "crown_bailiff_", "company_bankruptcy_reset"],
  },
  {
    label: "World & piracy",
    match: ["world_event", "letter_of_marque_issued", "naval_patrol_funded", "marque_prize_paid", "patrol_prize_paid", "admiralty_commission_"],
  },
  { label: "Exchange & bulletin", match: ["exchange_posted", "bulletin_posted"] },
  { label: "Server", match: ["server_announcement"] },
];

const WORLD_EVENT_TYPES: S.WorldEventType[] = [
  "supply_boom",
  "demand_shortage",
  "admiralty_mobilization",
  "pirate_outbreak",
  "production_collapse",
  "production_boom",
  "import_slump",
  "exchequer_remittance",
];

const inGroup = (type: string, group: string) => {
  const g = GROUPS.find((x) => x.label === group);
  return !g || g.match.some((m) => (m.endsWith("_") ? type.startsWith(m) : type === m));
};

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    });
  });

/** One long poll through the dashboard proxy; abortable, unlike kibbGet. */
async function pollEvents(query: Record<string, string>, signal: AbortSignal): Promise<S.StreamEvent[]> {
  const res = await fetch(`/api/kibb/v1/event/stream?${new URLSearchParams(query)}`, { cache: "no-store", signal });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const p = (data && typeof data === "object" ? data : {}) as { code?: string; detail?: string };
    if (res.status === 401) {
      if (p.code === "not_signed_in") window.location.href = "/login";
      else if (p.code === "no_company_key") window.location.href = "/companies";
    }
    // A rate limit (or the proxy's cap on live feeds) says when to come back.
    const retryAfterS = Number(res.headers.get("retry-after"));
    throw Object.assign(new DashboardApiError(res.status, p.code, p.detail ?? (typeof data === "string" && data ? data : res.statusText)), {
      retryAfterMs: retryAfterS > 0 ? retryAfterS * 1_000 : undefined,
    });
  }
  return (data as S.StreamEvent[]) ?? [];
}

/** Resolves once the tab is visible again (or the feed stops): a hidden tab doesn't hold one of the company's long polls. */
const untilVisible = (signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (!document.hidden || signal.aborted) return resolve();
    const done = () => {
      document.removeEventListener("visibilitychange", seen);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const seen = () => {
      if (!document.hidden) done();
    };
    document.addEventListener("visibilitychange", seen);
    signal.addEventListener("abort", done);
  });

type Payload = Record<string, unknown>;

/** Scalar payload fields as short labelled values: pence as Crowns, ids as names. */
function fields(p: Payload, h: CatalogHelpers, shipName: (id: string) => string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const [k, v] of Object.entries(p)) {
    if (v === null || v === undefined || typeof v === "object") continue;
    const label = k.replace(/_pence$|_id$/, "").replace(/_/g, " ");
    let text: string;
    if (typeof v === "number" && k.endsWith("_pence")) text = fmtCr(v, 2);
    else if (typeof v === "number" && k.endsWith("_bps")) text = fmtBps(v);
    else if (typeof v === "string" && (k === "port_id" || k.endsWith("_port_id"))) text = h.portName(v);
    else if (typeof v === "string" && k === "commodity_id") text = h.goodName(v);
    else if (typeof v === "string" && k === "ship_class") text = h.shipClassName(v);
    else if (typeof v === "string" && k === "ship_id") text = shipName(v);
    else if (typeof v === "string" && /_id$/.test(k)) text = v.slice(0, 8);
    else if (typeof v === "string" && /(_at|timestamp)$/.test(k)) text = fmtDateTime(v);
    else text = String(v).replace(/_/g, " ");
    out.push([label, text]);
  }
  return out;
}

function headline(e: S.StreamEvent, p: Payload, h: CatalogHelpers, shipName: (id: string) => string): string {
  const s = (k: string) => (typeof p[k] === "string" ? (p[k] as string) : undefined);
  const n = (k: string) => (typeof p[k] === "number" ? (p[k] as number) : undefined);
  const ship = s("ship_name") ?? (s("ship_id") ? shipName(s("ship_id")!) : "A ship");
  const port = h.portName(s("port_id") ?? e.port_id ?? undefined);
  switch (e.event_type) {
    case "ship_arrived":
      return s("status") === "anchored_roadstead"
        ? `${ship} reached ${port} and anchored in the roadstead${n("queue_position") ? ` (queue #${n("queue_position")})` : ""}`
        : `${ship} arrived at ${port}`;
    case "ship_berthed":
      return `${ship} berthed at ${port}`;
    case "ship_evicted":
      return `${ship} was evicted to the roadstead at ${port}`;
    case "ship_departed":
      return `${ship} sailed${s("dest_port_id") ? ` for ${h.portName(s("dest_port_id"))}` : ""}`;
    case "voyage_hazard":
      return `${ship}: ${(s("hazard") ?? "hazard").replace(/_/g, " ")}${p.sunk === true ? " — SUNK" : n("cargo_loss_pct") !== undefined ? `, ${n("cargo_loss_pct")}% of cargo lost` : ""}`;
    case "ship_mutinied":
      return `${ship}: the crew mutinied`;
    case "ship_provisions_exhausted":
      return `${ship} ran out of stores`;
    case "ship_broken_up":
      return `${ship} was broken up at ${port}${n("payout_pence") !== undefined ? ` for ${fmtCr(n("payout_pence")!)}` : ""}`;
    case "passengers_boarded":
      return `${n("size") ?? "A group of"} ${s("kind") ?? "passengers"} boarded ${ship}${s("dest_port_id") ? ` for ${h.portName(s("dest_port_id"))}` : ""}`;
    case "passengers_paid":
      return `${ship}: ${n("fare_paid_pence") !== undefined ? `${fmtCr(n("fare_paid_pence")!)} in fares paid` : "fares paid"}${n("game_days_late") ? `, ${n("game_days_late")} game day${n("game_days_late") === 1 ? "" : "s"} late` : ""}`;
    case "passengers_lost":
      return `${ship}: passengers lost unpaid${s("cause") ? ` (${s("cause")!.replace(/_/g, " ")})` : ""}`;
    case "admiralty_commission_posted":
      return `The Admiralty orders ${s("ship_class") ? `a ${h.shipClassName(s("ship_class")).toLowerCase()}` : "a navy hull"} at ${port}${n("price_pence") !== undefined ? ` for ${fmtCr(n("price_pence")!)}` : ""}`;
    case "admiralty_commission_delivered":
      return `${s("ship_name") ?? (s("ship_class") ? `A ${h.shipClassName(s("ship_class")).toLowerCase()}` : "A navy hull")} joined the Royal Navy at ${port}`;
    case "charter_fill_dispatched":
      return `The Merchant Adventurers sent ${n("quantity") !== undefined ? `${n("quantity")} t of ` : ""}${h.goodName(s("commodity_id"))} for your charter${s("source_port_id") ? ` from ${h.portName(s("source_port_id"))}` : ""}${s("arrives_at") ? `, landing ${fmtDateTime(s("arrives_at"))}` : ""}`;
    case "bank_draft":
      return `Bank draft${s("bank_name") ? ` by ${s("bank_name")}` : ""}: ${n("gross_amount_pence") !== undefined ? fmtCr(n("gross_amount_pence")!) : "a remittance"}${s("from_region") && s("to_region") ? ` ${s("from_region")!.replace(/_/g, " ")} → ${s("to_region")!.replace(/_/g, " ")}` : ""}${n("fee_pence") !== undefined ? `, fee ${fmtCr(n("fee_pence")!, 2)}` : ""}`;
    case "lending_line_posted":
      return `${s("bank_name") ?? "A bank"} posted a lending line${n("rate_pct_of_goldsmiths_bps") !== undefined ? ` at ${fmtBps(n("rate_pct_of_goldsmiths_bps")!)} of the Goldsmiths' rate` : ""}`;
    case "lending_line_quoted":
      return `Your lending line quoted${n("principal_pence") !== undefined ? ` ${fmtCr(n("principal_pence")!)}` : ""}${s("borrower_name") ? ` to ${s("borrower_name")}` : ""}${n("annual_rate_bps") !== undefined ? ` at ${fmtBps(n("annual_rate_bps")!)} a year` : ""}`;
    case "lending_line_exhausted":
      return "A lending line of yours has less room left than its smallest principal";
    case "loan_quote_received":
      return `${p.auto === true ? "Automatic quote" : "Quote"} on your loan request${s("lender_name") ? ` from ${s("lender_name")}` : ""}${n("annual_rate_bps") !== undefined ? ` at ${fmtBps(n("annual_rate_bps")!)} a year` : ""}`;
    case "home_port_relocated":
      return `Home port moved${s("from_port_id") ? ` from ${h.portName(s("from_port_id"))}` : ""}${s("to_port_id") ? ` to ${h.portName(s("to_port_id"))}` : ""}`;
    case "bulletin_posted":
      return `${s("company_name") ?? "A company"} ${p.is_reply === true ? "replied on" : "opened"} the bulletin${s("title") ? `: ${s("title")}` : ""}`;
    case "exchange_posted":
      return `New on the Exchange: ${(s("kind") ?? "an offer").replace(/_/g, " ")}`;
    case "server_announcement":
      return s("message") ?? "Server announcement";
    default:
      return titleCase(e.event_type);
  }
}

const SEVERE = ["voyage_hazard", "ship_mutinied", "ship_provisions_exhausted", "crown_bailiff_", "freight_defaulted", "futures_defaulted", "convoy_salvage", "passengers_lost", "loan_defaulted"];

function EventRow({ e, h, shipName }: { e: S.StreamEvent; h: CatalogHelpers; shipName: (id: string) => string }) {
  const [open, setOpen] = useState(false);
  const p = (e.payload && typeof e.payload === "object" ? e.payload : {}) as Payload;
  const severe =
    SEVERE.some((m) => (m.endsWith("_") ? e.event_type.startsWith(m) : e.event_type === m)) ||
    (e.event_type === "server_announcement" && p.severity !== "info");
  const chips = fields(p, h, shipName).slice(0, 8);
  return (
    <li className="border-b py-2 last:border-0">
      <button type="button" onClick={() => setOpen(!open)} className="w-full text-left">
        <div className="flex items-baseline gap-2">
          <span className="w-16 shrink-0 font-mono text-muted-foreground text-xs">{fmtTime(e.timestamp)}</span>
          <Badge variant={severe ? "error" : e.company_id ? "info" : "outline"} size="sm" className="shrink-0">
            {e.event_type.replace(/_/g, " ")}
          </Badge>
          <span className={`text-sm ${severe ? "font-medium" : ""}`}>{headline(e, p, h, shipName)}</span>
        </div>
        {chips.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 pl-18 text-muted-foreground text-xs">
            {chips.map(([k, v]) => (
              <span key={k}>
                {k}: <span className="text-foreground">{v}</span>
              </span>
            ))}
          </div>
        )}
      </button>
      {open && (
        <pre className="mt-2 ml-18 max-h-72 overflow-auto rounded-md bg-muted p-2 font-mono text-[11px]">{JSON.stringify(e, null, 2)}</pre>
      )}
    </li>
  );
}

function LiveFeed() {
  const h = useCatalog();
  const { data: ships } = usePoll(() => kibbGet<ShipResult[]>("/v1/fleet/ships", { limit: 200 }), 60_000);
  const names = useMemo(() => new Map((ships ?? []).map((r) => [r.ship.id, r.ship.name])), [ships]);
  const shipName = (id: string) => names.get(id) ?? `ship ${id.slice(0, 8)}`;

  const cursor = useRef<string | undefined>(undefined);
  const [events, setEvents] = useState<S.StreamEvent[]>([]);
  const [paused, setPaused] = useState(false);
  const [state, setState] = useState<"connecting" | "live" | "retrying" | "paused">("connecting");
  const [lastError, setLastError] = useState<string | null>(null);
  /** Events may have gone by unseen: the feed restarted without a cursor. */
  const [missed, setMissed] = useState(false);
  const [run, setRun] = useState(0);
  const [group, setGroup] = useState("");
  const [mineOnly, setMineOnly] = useState(false);

  useEffect(() => {
    if (paused) {
      setState("paused");
      return;
    }
    const ctl = new AbortController();
    void (async () => {
      let backoff = 2_000;
      setState("connecting");
      while (!ctl.signal.aborted) {
        if (document.hidden) {
          // The cursor is kept: nothing is missed, the log holds 7 days.
          setState("paused");
          await untilVisible(ctl.signal);
          if (ctl.signal.aborted) return;
          setState("connecting");
        }
        try {
          const q: Record<string, string> = { timeout_ms: "25000", limit: "200" };
          if (cursor.current) q.after_id = cursor.current;
          const batch = await pollEvents(q, ctl.signal);
          if (ctl.signal.aborted) return;
          backoff = 2_000;
          setState("live");
          setLastError(null);
          if (batch.length) {
            cursor.current = batch[batch.length - 1].id;
            setEvents((prev) => [...batch.slice().reverse(), ...prev].slice(0, MAX_EVENTS));
          }
        } catch (e) {
          if (ctl.signal.aborted) return;
          const err = e as DashboardApiError & { retryAfterMs?: number };
          if (err.status === 410 || err.code === "events_expired") {
            // The cursor fell out of the 7-day log: carry on from now.
            cursor.current = undefined;
            setMissed(true);
            continue;
          }
          setState("retrying");
          setLastError(err.message);
          // Without a cursor the next poll only sees events from then on.
          if (!cursor.current) setMissed(true);
          await sleep(Math.max(backoff, err.retryAfterMs ?? 0), ctl.signal);
          backoff = Math.min(backoff * 2, 30_000);
        }
      }
    })();
    return () => ctl.abort();
  }, [paused, run]);

  const shown = events.filter((e) => (!group || inGroup(e.event_type, group)) && (!mineOnly || !!e.company_id));

  return (
    <Panel
      title="Live company feed"
      action={
        <div className="flex items-center gap-2">
          <Badge variant={state === "live" ? "success" : state === "retrying" ? "error" : "secondary"} size="sm">
            {state}
          </Badge>
          <Button size="sm" variant="outline" onClick={() => setPaused(!paused)}>
            {paused ? "Resume" : "Pause"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            title="Replay everything the game still keeps (7 days)"
            onClick={() => {
              cursor.current = "0";
              setMissed(false);
              setEvents([]);
              setPaused(false);
              setRun((n) => n + 1);
            }}
          >
            Replay log
          </Button>
        </div>
      }
    >
      <div className="mb-3 flex flex-wrap items-end gap-3">
        <Field label="Show" className="w-full sm:w-56">
          <NativeSelect value={group} onChange={(e) => setGroup(e.target.value)}>
            <option value="">Everything</option>
            {GROUPS.map((g) => (
              <option key={g.label} value={g.label}>
                {g.label}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <label className="flex items-center gap-2 pb-1.5 text-sm">
          <input type="checkbox" checked={mineOnly} onChange={(e) => setMineOnly(e.target.checked)} />
          Only events about my company
        </label>
        <span className="pb-1.5 text-muted-foreground text-xs">
          {shown.length} of {events.length} kept · click a row for its raw JSON
        </span>
      </div>
      {lastError && <ErrorNote error={`Feed interrupted: ${lastError}. Retrying…`} className="mb-3" />}
      {missed && !lastError && (
        <p className="mb-3 text-muted-foreground text-xs">Some events may have gone by while the feed reconnected. Replay log shows everything the game keeps.</p>
      )}
      {shown.length === 0 ? (
        <Empty>
          {state === "connecting" ? "Connecting…" : "Waiting for events. New ones appear here as they happen; Replay log shows the last 7 days."}
        </Empty>
      ) : (
        <ul>
          {shown.map((e) => (
            <EventRow key={e.id} e={e} h={h} shipName={shipName} />
          ))}
        </ul>
      )}
    </Panel>
  );
}

function WorldEvents() {
  const { catalog, portName, goodName } = useCatalog();
  const [includeExpired, setIncludeExpired] = useState(true);
  const [structural, setStructural] = useState("");
  const [type, setType] = useState("");
  const [port, setPort] = useState("");
  const page = usePaged<S.WorldEventResult>(
    (cursor, limit) =>
      kibbGet<S.WorldEventResult[]>("/v1/world/events", {
        cursor,
        limit,
        include_expired: includeExpired,
        structural: structural || undefined,
        event_type: type,
        port_id: port,
      }),
    [includeExpired, structural, type, port],
  );
  const zoneName = (id: string | null | undefined) => (id ? (catalog?.sea_zones.find((z) => z.id === id)?.name ?? titleCase(id)) : "");

  return (
    <Panel title="World events">
      <div className="mb-3 flex flex-wrap items-end gap-3">
        <Field label="Type" className="w-full sm:w-52">
          <NativeSelect value={type} onChange={(e) => setType(e.target.value)}>
            <option value="">Any type</option>
            {WORLD_EVENT_TYPES.map((t) => (
              <option key={t} value={t}>
                {titleCase(t)}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field label="Kind" className="w-full sm:w-44">
          <NativeSelect value={structural} onChange={(e) => setStructural(e.target.value)}>
            <option value="">Shocks and shifts</option>
            <option value="true">Lasting shifts only</option>
            <option value="false">Temporary shocks only</option>
          </NativeSelect>
        </Field>
        <Field label="Port" className="w-full sm:w-48">
          <PortSelect value={port} onChange={setPort} placeholder="Any port" />
        </Field>
        <label className="flex items-center gap-2 pb-1.5 text-sm">
          <input type="checkbox" checked={includeExpired} onChange={(e) => setIncludeExpired(e.target.checked)} />
          Include expired
        </label>
      </div>
      <ErrorNote error={page.error} />
      {page.items.length === 0 ? (
        page.loading ? <Loading /> : <Empty>No world events match.</Empty>
      ) : (
        <ul className="space-y-3">
          {page.items.map((w) => (
            <li key={w.id} className="rounded-lg border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-sm">{w.title}</span>
                <Badge variant="outline" size="sm">{titleCase(w.event_type)}</Badge>
                {w.structural && <Badge variant="warning" size="sm">lasting shift</Badge>}
                <Badge variant={w.is_active ? "success" : "secondary"} size="sm">{w.is_active ? "active" : "over"}</Badge>
              </div>
              <p className="mt-1 text-sm">{w.description}</p>
              <div className="mt-1 flex flex-wrap gap-x-4 text-muted-foreground text-xs">
                {w.target_port_id && <span>Port: {portName(w.target_port_id)}</span>}
                {w.target_sea_zone_id && <span>Zone: {zoneName(w.target_sea_zone_id)}</span>}
                {w.commodity_id && <span>Good: {goodName(w.commodity_id)}</span>}
                {w.added_piracy_bps ? <span>Piracy +{fmtBps(w.added_piracy_bps)}</span> : null}
                {w.charter_id && <span>Charter {w.charter_id.slice(0, 8)}</span>}
                <span>
                  {fmtDateTime(w.starts_at)} → {fmtDateTime(w.expires_at)}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
      <LoadMore loading={page.loading} done={page.done} onClick={page.loadMore} count={page.items.length} />
    </Panel>
  );
}

export default function EventsPage() {
  return (
    <div className="space-y-5 pb-8 sm:space-y-6">
      <PageHeader title="Events" subtitle="Everything the game tells your company, live, and the world's economic shocks and lasting shifts." />
      <Tabs defaultValue="live">
        <TabsList>
          <TabsTab value="live">Live feed</TabsTab>
          <TabsTab value="world">World events</TabsTab>
        </TabsList>
        <TabsPanel value="live" keepMounted>
          <LiveFeed />
        </TabsPanel>
        <TabsPanel value="world">
          <WorldEvents />
        </TabsPanel>
      </Tabs>
    </div>
  );
}
