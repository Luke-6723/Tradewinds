"use client";

import { useState } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsPanel, TabsTab } from "@/components/ui/tabs";
import { Empty, ErrorNote, KV, Loading, Metrics, NativeSelect, PageHeader, Panel, Table } from "@/components/kibb/bits";
import { AutopilotTag, ENVELOPE, ENVELOPE_CATEGORIES, ageText, useDeals, usePresence, type DealsView, type Presence } from "@/components/kibb/deals-common";
import {
  CompanyLabel,
  WarnBox,
  crToPence,
  firstProblem,
  num,
  regionName,
  useLearnCompanies,
  useRegionOf,
  useVaults,
} from "@/components/kibb/finance-common";
import { Checkbox, realTime, useCompanyId, useOurCompanyIds, useTimeScale } from "@/components/kibb/naval-common";
import { Field, PortSelect } from "@/components/kibb/pickers";
import { LoadMore, fetchAll, usePaged } from "@/components/kibb/trade-common";
import { useAction } from "@/hooks/use-action";
import { useCatalog } from "@/hooks/use-catalog";
import { usePoll } from "@/hooks/use-poll";
import { kibbGet, kibbPost } from "@/lib/kibb/browser";
import { fmtAgo, fmtCr, fmtDateTime, fmtGameHours, fmtIn, fmtTons } from "@/lib/kibb/format";
import type * as S from "@/lib/kibb/schema";
import type { PortDetail } from "@/lib/kibb/types";

type Vaults = ReturnType<typeof useVaults>;
type Tab = "browse" | "bought" | "sold" | "post";

const STATUS_VARIANT: Record<S.EnvelopeStatus, "info" | "success" | "outline" | "secondary"> = {
  open: "info",
  sold: "success",
  expired: "outline",
  withdrawn: "secondary",
};

const CATEGORY_NOUN: Record<S.EnvelopeCategory, [string, string]> = {
  port_reports: ["port report", "port reports"],
  charters: ["charter", "charters"],
  sailings: ["sailing", "sailings"],
};

/** "2 port reports · 1 charter" from the listing's counts. */
function Sections({ e }: { e: S.EnvelopeListing }) {
  return (
    <div className="flex flex-wrap gap-1">
      {e.categories.map((c) => {
        const n = e.item_counts[c] ?? 0;
        return (
          <Badge key={c} variant="outline" size="sm">
            {n} {CATEGORY_NOUN[c][n === 1 ? 0 : 1]}
          </Badge>
        );
      })}
    </div>
  );
}

/** Port names, the first few then "+N". */
function PortsText({ ids, max = 4 }: { ids: string[]; max?: number }) {
  const { portName } = useCatalog();
  if (ids.length === 0) return <>—</>;
  const shown = ids.slice(0, max).map(portName).join(", ");
  return (
    <span title={ids.map(portName).join(", ")}>
      {shown}
      {ids.length > max ? ` +${ids.length - max}` : ""}
    </span>
  );
}

/** Small multi-select: a select to add, chips to remove. */
function Chips({ options, value, onChange, placeholder }: { options: Array<[string, string]>; value: string[]; onChange: (v: string[]) => void; placeholder: string }) {
  const label = (id: string) => options.find(([x]) => x === id)?.[1] ?? id;
  return (
    <div className="space-y-1.5">
      <NativeSelect value="" onChange={(e) => e.target.value && onChange([...value, e.target.value])}>
        <option value="">{placeholder}</option>
        {options
          .filter(([id]) => !value.includes(id))
          .map(([id, l]) => (
            <option key={id} value={id}>
              {l}
            </option>
          ))}
      </NativeSelect>
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {value.map((id) => (
            <button
              key={id}
              type="button"
              onClick={() => onChange(value.filter((x) => x !== id))}
              className="rounded-md border px-2 py-0.5 text-xs hover:bg-accent"
              title="Remove"
            >
              {label(id)} ×
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Reading one ───────────────────────────────────────────────────────────────

function priceText(p: number | null | undefined, qty?: number | null) {
  if (p === null || p === undefined) return "—";
  return `${fmtCr(p, 2)}${qty !== null && qty !== undefined ? ` × ${fmtTons(qty)}` : ""}`;
}

function Contents({ env }: { env: S.EnvelopeDetail }) {
  const { portName, goodName, shipClassName } = useCatalog();
  const reports = env.contents.port_reports ?? [];
  const charters = env.contents.charters ?? [];
  const sailings = env.contents.sailings ?? [];
  return (
    <div className="space-y-5">
      <KV
        rows={[
          ["Sealed at", `${portName(env.port_id)}, ${fmtDateTime(env.created_at)}`],
          ["Seller", env.seller_company_name ?? "—"],
          ["Price", fmtCr(env.price_pence)],
          ["Items", `oldest ${fmtAgo(env.oldest_item_at)}, newest ${fmtAgo(env.newest_item_at)}`],
        ]}
      />
      {reports.length > 0 && (
        <div className="space-y-3">
          <div className="font-medium text-sm">Port reports</div>
          {reports.map((r) => (
            <div key={r.subject_port_id} className="space-y-1.5">
              <div className="flex flex-wrap items-baseline gap-2 text-sm">
                <Link href={`/ports/${r.subject_port_id}`} className="font-medium hover:underline">
                  {portName(r.subject_port_id)}
                </Link>
                <span className="text-muted-foreground text-xs">seen {fmtAgo(r.snapshot_at)}</span>
              </div>
              <Table head={["Good", "Stock", "Best bid", "Best ask", "Player bid", "Player ask", "Seen"]}>
                {r.commodities.map((c) => (
                  <tr key={c.commodity_id}>
                    <td>{goodName(c.commodity_id)}</td>
                    <td className="tabular-nums">{fmtTons(c.current_stock)}</td>
                    <td className="tabular-nums">{priceText(c.best_bid_pence)}</td>
                    <td className="tabular-nums">{priceText(c.best_ask_pence)}</td>
                    <td className="tabular-nums">{priceText(c.best_player_bid_pence, c.best_player_bid_quantity)}</td>
                    <td className="tabular-nums">{priceText(c.best_player_ask_pence, c.best_player_ask_quantity)}</td>
                    <td className="whitespace-nowrap text-muted-foreground text-xs">{fmtAgo(c.snapshot_at)}</td>
                  </tr>
                ))}
              </Table>
            </div>
          ))}
          <p className="text-muted-foreground text-xs">Player bid and ask: the best resting company order on each side and its tons, anonymous (your own orders count).</p>
        </div>
      )}
      {charters.length > 0 && (
        <div className="space-y-1.5">
          <div className="font-medium text-sm">Charters</div>
          <Table head={["Deliver to", "Good", "Remaining", "Pay/t", "Funded by", "Expires", "News as of"]}>
            {charters.map((c) => (
              <tr key={c.contract_id}>
                <td>
                  <Link href={`/ports/${c.port_id}`} className="hover:underline">
                    {portName(c.port_id)}
                  </Link>
                  {c.title && <div className="text-muted-foreground text-xs">{c.title}</div>}
                </td>
                <td>{goodName(c.commodity_id)}</td>
                <td className="whitespace-nowrap tabular-nums">
                  {fmtTons(c.remaining_quantity)} <span className="text-muted-foreground">/ {fmtTons(c.quantity_required)}</span>
                </td>
                <td className="tabular-nums">{fmtCr(c.reward_per_ton_pence, 2)}</td>
                <td className="text-xs">{c.funded_by === "issuer" ? "a player" : (c.funded_by ?? "—")}</td>
                <td className="whitespace-nowrap text-xs">{fmtIn(c.expires_at)}</td>
                <td className="whitespace-nowrap text-muted-foreground text-xs">{fmtAgo(c.news_as_of)}</td>
              </tr>
            ))}
          </Table>
          <p className="text-muted-foreground text-xs">As the news stood then: a charter may have been filled or lapsed since.</p>
        </div>
      )}
      {sailings.length > 0 && (
        <div className="space-y-1.5">
          <div className="font-medium text-sm">Sailings</div>
          <Table head={["Ship", "Owner", "", "Load", "Convoy", "Seen"]}>
            {sailings.map((n, i) => (
              <tr key={`${n.ship_name}-${n.seen_at}-${i}`}>
                <td>
                  {n.ship_name} <span className="text-muted-foreground text-xs">{shipClassName(n.ship_class)}</span>
                </td>
                <td className="text-muted-foreground">{n.company_name}</td>
                <td className="whitespace-nowrap text-xs">
                  {n.direction === "sailed" ? `${portName(n.port_id)} → ${portName(n.other_port_id)}` : `${portName(n.other_port_id)} → ${portName(n.port_id)}`}
                </td>
                <td className="text-xs">{n.load_state.replace("_", " ")}</td>
                <td className="text-xs">{n.convoy_name ?? "—"}</td>
                <td className="whitespace-nowrap text-muted-foreground text-xs">{fmtAgo(n.seen_at)}</td>
              </tr>
            ))}
          </Table>
        </div>
      )}
      {reports.length + charters.length + sailings.length === 0 && <Empty>Nothing inside.</Empty>}
    </div>
  );
}

// ── Browse and buy ────────────────────────────────────────────────────────────

function Browse({
  presence,
  vaults,
  companyId,
  deals,
  onBought,
}: {
  presence: Presence;
  vaults: Vaults;
  companyId: string | undefined;
  deals: DealsView;
  onBought: (e: S.EnvelopeDetail) => void;
}) {
  const { portName } = useCatalog();
  const regionOf = useRegionOf();
  const [port, setPort] = useState("");
  const [category, setCategory] = useState<S.EnvelopeCategory | "">("");
  const [covers, setCovers] = useState("");
  const list = usePaged(
    (cursor) => kibbGet<S.EnvelopeListing[]>("/v1/envelope/list", { port_id: port, category, covers_port_id: covers, cursor, limit: 100 }),
    100,
    [port, category, covers],
  );
  useLearnCompanies(list.items.map((e) => [e.seller_company_id, e.seller_company_name]));
  // Resolves to null when the confirmation is declined.
  const act = useAction<S.EnvelopeDetail | null>((r) => {
    if (!r) return;
    void list.reload();
    onBought(r);
  });

  function buy(e: S.EnvelopeListing) {
    const region = regionOf(e.port_id);
    void act.run(async () => {
      if (
        !confirm(
          `Buy "${e.title}" (sealed at ${portName(e.port_id)}) for ${fmtCr(e.price_pence)} from your ${regionName(region)} vault?\n\nIts newest item is ${ageText(e.newest_item_age_seconds)} old and its oldest ${ageText(e.oldest_item_age_seconds)} (real time). It covers ${e.ports_covered.map(portName).join(", ") || "—"}. The price goes to the seller; the envelope is yours alone, closed (no resale), and you can read it at once.`,
        )
      )
        return null;
      return kibbPost<S.EnvelopeDetail>("/v1/envelope/buy", { envelope_id: e.id });
    });
  }

  return (
    <Panel title="Envelopes for sale">
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Sealed at">
            <PortSelect value={port} onChange={setPort} placeholder="Any port" />
          </Field>
          <Field label="Has a section">
            <NativeSelect value={category} onChange={(e) => setCategory(e.target.value as S.EnvelopeCategory | "")}>
              <option value="">Any</option>
              {ENVELOPE_CATEGORIES.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field label="Speaks of">
            <PortSelect value={covers} onChange={setCovers} placeholder="Any port" />
          </Field>
        </div>
        <ErrorNote error={list.error ?? act.error} />
        {list.items.length === 0 ? (
          list.loading ? <Loading /> : <Empty>No envelopes for sale{port || category || covers ? " match" : ""}.</Empty>
        ) : (
          <Table head={["Envelope", "Sealed at", "Covers", "Ages (newest / oldest)", "Price", "Lapses", "Seller", ""]}>
            {list.items.map((e) => {
              const ours = !!companyId && e.seller_company_id === companyId;
              const present = presence.any.has(e.port_id);
              const cash = vaults.cash(regionOf(e.port_id));
              const short = cash !== undefined && cash < e.price_pence;
              return (
                <tr key={e.id}>
                  <td className="min-w-56">
                    <div className="font-medium">{e.title}</div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-1">
                      <Sections e={e} />
                      {ours && <Badge variant="secondary" size="sm">yours</Badge>}
                      {deals.ourEnvelope(e.id) && <AutopilotTag />}
                    </div>
                  </td>
                  <td>{portName(e.port_id)}</td>
                  <td className="text-xs">
                    <PortsText ids={e.ports_covered} />
                  </td>
                  <td className="whitespace-nowrap tabular-nums text-xs">
                    {ageText(e.newest_item_age_seconds)} / {ageText(e.oldest_item_age_seconds)}
                  </td>
                  <td className="tabular-nums">{fmtCr(e.price_pence)}</td>
                  <td className="whitespace-nowrap text-xs">{fmtIn(e.expires_at)}</td>
                  <td className="text-xs">{e.seller_company_name ?? <span className="text-muted-foreground" title="Shown only with quay presence at the port">hidden</span>}</td>
                  <td className="text-right">
                    {!ours && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={act.busy || !present || short}
                        title={
                          !present
                            ? `Buying needs presence at ${portName(e.port_id)}: a ship there, a factor or a warehouse lease`
                            : short
                              ? `Only ${fmtCr(cash)} in your ${regionName(regionOf(e.port_id))} vault`
                              : undefined
                        }
                        onClick={() => buy(e)}
                      >
                        Buy
                      </Button>
                    )}
                  </td>
                </tr>
              );
            })}
          </Table>
        )}
        <LoadMore done={list.done} loading={list.loading} onMore={() => void list.more()} />
        <p className="text-muted-foreground text-xs">
          Titles are generated from the contents, with the oldest item&apos;s age in game time; the ages beside them are real time. Never the contents, and the seller
          only if you have quay presence where it was sealed. Old news is cheap news.
        </p>
      </div>
    </Panel>
  );
}

// ── Ours (bought or sealed) ───────────────────────────────────────────────────

function Mine({
  role,
  rows,
  error,
  deals,
  companyId,
  ourIds,
  selected,
  onSelect,
  onDone,
}: {
  role: S.EnvelopeRole;
  rows: S.EnvelopeDetail[] | undefined;
  error: Error | null;
  deals: DealsView;
  companyId: string | undefined;
  ourIds: Set<string>;
  selected: string | null;
  onSelect: (id: string | null) => void;
  onDone: () => void;
}) {
  const { portName } = useCatalog();
  // Resolves to null when the confirmation is declined.
  const act = useAction<S.EnvelopeListing | null>((r) => r && onDone());
  const shown = rows?.find((e) => e.id === selected) ?? null;

  const withdraw = (e: S.EnvelopeDetail) =>
    void act.run(async () => {
      if (!confirm(`Withdraw "${e.title}" from sale at ${portName(e.port_id)}?${deals.ourEnvelope(e.id) ? " The autopilot sealed it; it may seal a fresh one there." : ""}`)) return null;
      return kibbPost<S.EnvelopeListing>("/v1/envelope/withdraw", { envelope_id: e.id });
    });

  return (
    <div className="space-y-4">
      <Panel title={role === "buyer" ? "Envelopes you bought" : "Envelopes you sealed"}>
        <ErrorNote error={error ?? act.error} />
        {!rows ? (
          !error && <Loading />
        ) : rows.length === 0 ? (
          <Empty>{role === "buyer" ? "You haven't bought any." : "You haven't sealed any. Post one on the Seal and sell tab."}</Empty>
        ) : (
          <Table
            head={
              role === "buyer"
                ? ["Envelope", "Sealed at", "Price", "Seller", "Bought", ""]
                : ["Envelope", "Sealed at", "Price", "Status", "Buyer", "Sealed", "Lapses / sold", ""]
            }
          >
            {rows.map((e) => (
              <tr key={e.id} className={e.id === selected ? "bg-accent" : undefined}>
                <td className="min-w-56">
                  <div className="font-medium">{e.title}</div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-1">
                    <Sections e={e} />
                    {role === "seller" && deals.ourEnvelope(e.id) && <AutopilotTag title="Sealed and listed by the autopilot" />}
                  </div>
                </td>
                <td>{portName(e.port_id)}</td>
                <td className="tabular-nums">{fmtCr(e.price_pence)}</td>
                {role === "buyer" ? (
                  <>
                    <td className="text-xs">{e.seller_company_name ?? <CompanyLabel id={e.seller_company_id} companyId={companyId} ourIds={ourIds} />}</td>
                    <td className="whitespace-nowrap text-muted-foreground text-xs">{fmtDateTime(e.sold_at)}</td>
                  </>
                ) : (
                  <>
                    <td>
                      <Badge variant={STATUS_VARIANT[e.status]} size="sm">
                        {e.status}
                      </Badge>
                    </td>
                    <td className="text-xs">{e.buyer_company_id ? <CompanyLabel id={e.buyer_company_id} companyId={companyId} ourIds={ourIds} /> : "—"}</td>
                    <td className="whitespace-nowrap text-muted-foreground text-xs">{fmtDateTime(e.created_at)}</td>
                    <td className="whitespace-nowrap text-xs">{e.status === "sold" ? fmtDateTime(e.sold_at) : e.status === "open" ? fmtIn(e.expires_at) : "—"}</td>
                  </>
                )}
                <td className="space-x-1 whitespace-nowrap text-right">
                  {role === "seller" && e.status === "open" && (
                    <Button size="sm" variant="outline" disabled={act.busy} onClick={() => withdraw(e)}>
                      Withdraw
                    </Button>
                  )}
                  <Button size="sm" variant={e.id === selected ? "secondary" : "outline"} onClick={() => onSelect(e.id === selected ? null : e.id)}>
                    {e.id === selected ? "Close" : "Read"}
                  </Button>
                </td>
              </tr>
            ))}
          </Table>
        )}
        {role === "seller" && deals.deals && (
          <p className="mt-3 text-muted-foreground text-xs">
            The autopilot{deals.deals.envelopes ? "" : " (envelopes off now)"} has {deals.deals.openEnvelopes.length} open and has sold {deals.deals.envelopesSold} for{" "}
            {fmtCr(deals.deals.envelopeIncomePence)}: {deals.deals.envelopeAction}. Only its open ones are tagged.
          </p>
        )}
      </Panel>
      {shown && (
        <Panel
          title={shown.title}
          action={
            <button type="button" className="text-muted-foreground text-xs hover:text-foreground" onClick={() => onSelect(null)}>
              Close
            </button>
          }
        >
          <Contents env={shown} />
        </Panel>
      )}
    </div>
  );
}

// ── Seal and sell ─────────────────────────────────────────────────────────────

function PostEnvelope({ presence, openCount, deals, onDone }: { presence: Presence; openCount: number | undefined; deals: DealsView; onDone: () => void }) {
  const { catalog, portName } = useCatalog();
  const regionOf = useRegionOf();
  const timeScale = useTimeScale();
  const [port, setPort] = useState("");
  const [cats, setCats] = useState<S.EnvelopeCategory[]>(["port_reports"]);
  const [reportPorts, setReportPorts] = useState<string[]>([]);
  const [goods, setGoods] = useState<string[]>([]);
  const [price, setPrice] = useState("");
  const [hours, setHours] = useState(String(ENVELOPE.lifeDefaultH));
  // Resolves to null when the confirmation is declined.
  const act = useAction<S.EnvelopeDetail | null>((r) => r && onDone());
  const quay = [...presence.quay].sort((a, b) => portName(a).localeCompare(portName(b)));
  const { data: view, error: viewError } = usePoll(port ? () => kibbGet<PortDetail>("/v1/world/port", { port_id: port }) : null, 60_000, [port]);
  const here = view && view.id === port ? view : undefined;
  const { data: charters } = usePoll(
    port ? () => kibbGet<S.ContractListing[]>("/v1/contract/list", { contract_type: "charter", port_id: port, status: "open", limit: 200 }) : null,
    60_000,
    [port],
  );
  const gossip = here?.coffee_house_gossip ?? [];
  const reportOptions: Array<[string, string]> = [
    ...new Map<string, string>([
      [port, `${portName(port)} (your crews' own reports)`],
      ...gossip.map((g) => [g.subject_port_id, `${portName(g.subject_port_id)} · ${fmtAgo(g.snapshot_at)}`] as [string, string]),
    ]),
  ];
  const boardReports = reportPorts.length ? gossip.filter((g) => reportPorts.includes(g.subject_port_id)).length : gossip.length;
  const sailings = here?.recent_sailings?.length ?? 0;
  const localCharters = (charters ?? []).filter((c) => c.origin_port_id === port && !c.is_public && !c.stale && (goods.length === 0 || goods.includes(c.commodity_id ?? ""))).length;
  const p = crToPence(price);
  const h = num(hours);
  const toggleCat = (c: S.EnvelopeCategory, on: boolean) => setCats((xs) => (on ? [...xs.filter((x) => x !== c), c] : xs.filter((x) => x !== c)));
  const why = firstProblem([
    [!!port, "Choose the port to seal it at."],
    [presence.quay.has(port), "Sealing needs quay tier there: a ship berthed or in the roadstead, or a factor."],
    [!here || here.visibility === "quay", `Your tier at ${portName(port)} is ${here?.visibility}: sealing needs quay tier.`],
    [cats.length > 0, "Choose at least one section."],
    [p > 0, "Enter the price."],
    [Number.isInteger(h) && h >= 1 && h <= ENVELOPE.lifeMaxH, "It lapses after 1..240 game hours."],
    [openCount === undefined || openCount < ENVELOPE.maxOpen, `You already have ${openCount} open envelopes: at most ${ENVELOPE.maxOpen}. Withdraw one first.`],
  ]);
  // Only sailings can be told empty from here: our own crews' reports and charter news that reached the port aren't shown.
  const emptySections = here ? cats.filter((c) => c === "sailings" && sailings === 0) : [];

  function submit() {
    void act.run(async () => {
      if (
        !confirm(
          `Seal ${cats.map((c) => CATEGORY_NOUN[c][1]).join(", ")} at ${portName(port)} into an envelope and list it for ${fmtCr(p)}?\n\nEverything is copied from game data with its original timestamps. A buyer needs presence at ${portName(port)} and pays into your ${regionName(regionOf(port))} vault. Unsold, it lapses in ${fmtGameHours(h)} (${realTime(h * 60, timeScale)}); you can withdraw it until it sells.`,
        )
      )
        return null;
      return kibbPost<S.EnvelopeDetail>("/v1/envelope/post", {
        port_id: port,
        price_pence: p,
        categories: cats,
        ...(reportPorts.length && cats.includes("port_reports") ? { report_port_ids: reportPorts } : {}),
        ...(goods.length && (cats.includes("port_reports") || cats.includes("charters")) ? { commodity_ids: goods } : {}),
        expires_in_game_hours: h,
      });
    });
  }

  return (
    <div className="grid items-start gap-4 xl:grid-cols-3">
      <Panel title="Seal and sell an envelope" className="xl:col-span-2">
        <div className="space-y-4">
          {presence.known && quay.length === 0 ? (
            <Empty>You have no quay anywhere (a ship in port or a factor): news can only be sealed where it has reached you.</Empty>
          ) : (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Seal at (your quays)">
                  <NativeSelect
                    value={port}
                    onChange={(e) => {
                      setPort(e.target.value);
                      setReportPorts([]);
                      act.reset();
                    }}
                  >
                    <option value="">Choose a port…</option>
                    {quay.map((id) => (
                      <option key={id} value={id}>
                        {portName(id)}
                      </option>
                    ))}
                  </NativeSelect>
                </Field>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Price (Cr)">
                    <Input type="number" min={1} step={1} value={price} onChange={(e) => setPrice(e.target.value)} />
                  </Field>
                  <Field label="Lapses after (game h)">
                    <Input type="number" min={1} max={ENVELOPE.lifeMaxH} step={1} value={hours} onChange={(e) => setHours(e.target.value)} />
                  </Field>
                </div>
              </div>
              <div className="space-y-1.5">
                <div className="font-medium text-sm">Sections</div>
                {ENVELOPE_CATEGORIES.map((c) => (
                  <Checkbox key={c.id} checked={cats.includes(c.id)} onChange={(on) => toggleCat(c.id, on)}>
                    <span>
                      {c.label} <span className="text-muted-foreground text-xs">— {c.hint}</span>
                    </span>
                  </Checkbox>
                ))}
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                {cats.includes("port_reports") && (
                  <Field label="Only reports of these ports (default: all held here)">
                    <Chips options={port ? reportOptions : []} value={reportPorts} onChange={setReportPorts} placeholder={port ? "Add a port…" : "Choose the port first"} />
                  </Field>
                )}
                {(cats.includes("port_reports") || cats.includes("charters")) && (
                  <Field label="Only these goods, in reports and charters (default: all)">
                    <Chips
                      options={(catalog?.commodities ?? []).map((c) => [c.id, c.name] as [string, string]).sort((a, b) => a[1].localeCompare(b[1]))}
                      value={goods}
                      onChange={setGoods}
                      placeholder="Add a good…"
                    />
                  </Field>
                )}
              </div>
              {port && (
                <KV
                  rows={[
                    ["Your tier here", here ? here.visibility : viewError ? "couldn't be read" : "…"],
                    ["Coffee-house reports on the board", here ? `${boardReports}${reportPorts.length ? " of the ports chosen" : ""} (plus your own crews' reports)` : "…"],
                    ["Sailing notices (24 game hours)", here ? String(sailings) : "…"],
                    ["This port's own non-public charters", charters ? `${localCharters} live (plus news of others' that reached it)` : "…"],
                    ["Your open envelopes", openCount === undefined ? "…" : `${openCount} of ${ENVELOPE.maxOpen}`],
                  ]}
                />
              )}
              {emptySections.length > 0 && (
                <WarnBox>
                  {emptySections.map((c) => CATEGORY_NOUN[c][1]).join(" and ")} look empty here: every section asked for must hold something, or the game refuses the
                  envelope (409).
                </WarnBox>
              )}
              <ErrorNote error={act.error ?? (port || price ? why : null)} />
              {act.result && (
                <p className="text-sm">
                  Listed &quot;{act.result.title}&quot; for {fmtCr(act.result.price_pence)}, lapsing {fmtIn(act.result.expires_at)}.
                </p>
              )}
              <Button disabled={!!why || act.busy} onClick={submit}>
                {act.busy ? "Sealing…" : "Seal and list"}
              </Button>
            </>
          )}
        </div>
      </Panel>
      <WarnBox tone="info">
        <p>News travels only by ship. An envelope sells what has reached one of your quays, sealed: nothing can be written into it, and every item keeps its original timestamp.</p>
        <p>Buyers see the generated title, the sections and counts, the ports covered, the ages and the price; never the contents.</p>
        <p>A packet with sealed dispatches records quays but posts nothing to the boards it calls at, so its crew&apos;s news is yours alone to seal here (set it on the ship&apos;s page).</p>
        {deals.deals && (
          <p>
            The autopilot{deals.deals.envelopes ? "" : " (envelopes off now)"} seals news and non-public charters it isn&apos;t working at its quays, priced at about 15 Cr a port report,
            20 a charter and 5 a sailing, halved every 12 game hours of age, and keeps at most 16 open, so leave it room under the 20.
          </p>
        )}
      </WarnBox>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function EnvelopesPage() {
  const companyId = useCompanyId();
  const ourIds = useOurCompanyIds();
  const presence = usePresence();
  const deals = useDeals();
  const vaults = useVaults();
  const [tab, setTab] = useState<Tab>("browse");
  const [selected, setSelected] = useState<string | null>(null);
  const { data: bought, error: boughtError, reload: reloadBought } = usePoll(() => fetchAll<S.EnvelopeDetail>("/v1/envelope/mine", { role: "buyer" }, 200, 5), 60_000);
  const { data: sealed, error: sealedError, reload: reloadSealed } = usePoll(() => fetchAll<S.EnvelopeDetail>("/v1/envelope/mine", { role: "seller" }, 200, 5), 30_000);
  useLearnCompanies((bought ?? []).map((e) => [e.seller_company_id, e.seller_company_name]));
  const openCount = sealed ? sealed.filter((e) => e.status === "open").length : undefined;
  const sold = (sealed ?? []).filter((e) => e.status === "sold");
  const refresh = () => {
    void reloadBought();
    void reloadSealed();
    void vaults.reload();
  };
  const go = (t: Tab) => {
    setTab(t);
    setSelected(null);
  };

  return (
    <div className="space-y-5 pb-8 sm:space-y-6">
      <PageHeader title="Intelligence envelopes" subtitle="Sealed news for sale: port reports, charters and sailings, as they reached a quay. Buy where you have presence; sell what reached your quays." />
      <Metrics
        className="sm:grid-cols-4 xl:grid-cols-4"
        items={[
          { label: "Bought", value: bought ? String(bought.length) : "…", hint: bought ? fmtCr(bought.reduce((n, e) => n + e.price_pence, 0)) : undefined },
          { label: "Yours open", value: openCount === undefined ? "…" : `${openCount} / ${ENVELOPE.maxOpen}` },
          { label: "Sold", value: sealed ? String(sold.length) : "…", hint: sealed ? fmtCr(sold.reduce((n, e) => n + e.price_pence, 0)) : undefined },
          { label: "Your quays", value: presence.known ? String(presence.quay.size) : "…", hint: presence.known ? `presence at ${presence.any.size} ports` : undefined },
        ]}
      />
      <Tabs value={tab} onValueChange={(v) => go(v as Tab)}>
        <TabsList>
          <TabsTab value="browse">Browse</TabsTab>
          <TabsTab value="bought">Bought</TabsTab>
          <TabsTab value="sold">Sealed by you</TabsTab>
          <TabsTab value="post">Seal and sell</TabsTab>
        </TabsList>
        <TabsPanel value="browse" className="pt-2">
          <Browse
            presence={presence}
            vaults={vaults}
            companyId={companyId}
            deals={deals}
            onBought={(e) => {
              refresh();
              setTab("bought");
              setSelected(e.id);
            }}
          />
        </TabsPanel>
        <TabsPanel value="bought" className="pt-2">
          <Mine role="buyer" rows={bought} error={boughtError} deals={deals} companyId={companyId} ourIds={ourIds} selected={selected} onSelect={setSelected} onDone={refresh} />
        </TabsPanel>
        <TabsPanel value="sold" className="pt-2">
          <Mine role="seller" rows={sealed} error={sealedError} deals={deals} companyId={companyId} ourIds={ourIds} selected={selected} onSelect={setSelected} onDone={refresh} />
        </TabsPanel>
        <TabsPanel value="post" className="pt-2">
          <PostEnvelope presence={presence} openCount={openCount} deals={deals} onDone={refresh} />
        </TabsPanel>
      </Tabs>
    </div>
  );
}
