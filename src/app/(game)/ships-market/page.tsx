"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsPanel, TabsTab } from "@/components/ui/tabs";
import { Empty, ErrorNote, KV, Loading, Metrics, NativeSelect, PageHeader, Panel, Table } from "@/components/kibb/bits";
import { CommissionsView } from "@/components/kibb/commissions";
import { GUN_PENCE, atPort, bandOf, pctOf, useDeals, usePresence, type DealsView, type Presence } from "@/components/kibb/deals-common";
import {
  CompanyLabel,
  WarnBox,
  crToPence,
  firstProblem,
  regionName,
  useCompanyDirectory,
  usePledgedShips,
  useRegionOf,
  useVaults,
} from "@/components/kibb/finance-common";
import { Checkbox, useCompanyId, useOurCompanyIds } from "@/components/kibb/naval-common";
import { Field } from "@/components/kibb/pickers";
import { fetchAll } from "@/components/kibb/trade-common";
import { useAction } from "@/hooks/use-action";
import { useCatalog } from "@/hooks/use-catalog";
import { usePoll } from "@/hooks/use-poll";
import { kibbGet, kibbPost } from "@/lib/kibb/browser";
import { fmtAgo, fmtCr, fmtDateTime, fmtTons } from "@/lib/kibb/format";
import type * as S from "@/lib/kibb/schema";
import type { PortDetail } from "@/lib/kibb/types";

type Vaults = ReturnType<typeof useVaults>;

const CANCEL_REASON: Record<string, string> = { seller: "withdrawn", ship_moved: "lapsed: the ship moved" };

// ── Listing one of our ships ──────────────────────────────────────────────────

function ListShipForm({
  initial,
  presence,
  ours,
  deals,
  onDone,
}: {
  initial: string;
  presence: Presence;
  /** Our listings (any status), to refuse a second listing of a ship. */
  ours: S.ShipListingResult[] | undefined;
  deals: DealsView;
  onDone: () => void;
}) {
  const { catalog, portName, shipClassName } = useCatalog();
  const regionOf = useRegionOf();
  const pledged = usePledgedShips();
  const [shipId, setShipId] = useState(initial);
  const [price, setPrice] = useState("");
  const [override, setOverride] = useState(false);
  // Resolves to null when the confirmation is declined.
  const act = useAction<S.ShipListingResult | null>((r) => r && onDone());
  const ships = (presence.ships ?? []).filter((r) => r.ship.status !== "sunk");
  const r = ships.find((x) => x.ship.id === shipId);
  // Her rebuild value (guns included), as the Goldsmiths appraise her: the price band is 50%..150% of it.
  const { data: appraisal, error: appraisalError } = usePoll(shipId ? () => kibbGet<S.BackstopQuote>("/v1/loan/backstop-quote", { ship_id: shipId }) : null, 0, [shipId]);
  const rebuild = appraisal && appraisal.ship_id === shipId ? appraisal.rebuild_value_pence : undefined;
  const band = rebuild !== undefined ? bandOf(rebuild) : undefined;
  // Without the appraisal, a turnkey quote at the yard she lies at (plus her guns) is at least her rebuild value: an upper bound.
  const yardHere = !!r && atPort(r) && !!catalog?.ports.find((p) => p.id === r.ship.current_port_id)?.has_shipyard;
  const { data: yardQuote } = usePoll(
    appraisalError && yardHere && r
      ? () => kibbGet<S.BuildQuoteResult>("/v1/shipyard/quote", { port_id: r.ship.current_port_id ?? "", ship_class: r.ship.ship_class, build_mode: "turnkey_cash" })
      : null,
    0,
    [shipId, !!appraisalError, yardHere],
  );
  const upper =
    rebuild === undefined && r && yardQuote?.ship_class === r.ship.ship_class && yardQuote.total_cost_pence != null
      ? yardQuote.total_cost_pence + r.ship.cannons_count * GUN_PENCE
      : undefined;
  const { data: policies } = usePoll(shipId ? () => kibbGet<S.InsurancePolicy[]>("/v1/insurance/list", { ship_id: shipId, limit: 20 }) : null, 30_000, [shipId]);
  const insured = (policies ?? []).find((p) => p.status === "open" || p.status === "active");
  const lien = shipId ? pledged.byShip.get(shipId) : undefined;
  const listed = (ours ?? []).find((l) => l.ship_id === shipId && l.status === "open");
  const autopilot = !!shipId && deals.ships.has(shipId);
  const p = crToPence(price);
  const why = firstProblem([
    [!!r, "Choose a ship."],
    [!r || atPort(r), "She must be lying at a port (berthed or in the roadstead) to be listed."],
    [!listed, `She is already listed for ${fmtCr(listed?.price_pence)}: cancel that listing first.`],
    [!r || r.cargo_used_tons <= 0, `Her hold must be empty: ${fmtTons(r?.cargo_used_tons, 1)} aboard (sealed freight and salvage count). Sell or unload it first.`],
    [!r?.ship.convoy_id, "She is in a convoy: leave it first (an open convoy request blocks a sale too)."],
    [pledged.known, "Reading your loans for liens…"],
    [!lien, `She is pledged to a loan (lien${lien?.status === "defaulted" ? ", defaulted: she is arrested" : ""}): repay it first.`],
    [policies !== undefined, "Reading her insurance…"],
    [!insured, `She holds an ${insured?.status} policy to ${portName(insured?.dest_port_id)}: a ship with open insurance can't change hands.`],
    [p > 0, "Enter the price."],
    [!band || (p >= band.min && p <= band.max), `The price must lie within ${fmtCr(band?.min)} – ${fmtCr(band?.max)} (50%–150% of her rebuild value, ${fmtCr(rebuild)}).`],
    [upper === undefined || p <= Math.floor(upper * 1.5), `Over 150% of a turnkey build here plus her guns (${fmtCr(upper)}), so over 150% of her rebuild value: it would be refused.`],
    [!autopilot || override, "The autopilot sails her: tick the box to list her anyway."],
  ]);

  function submit() {
    if (!r) return;
    const region = regionOf(r.ship.current_port_id);
    void act.run(async () => {
      if (
        !confirm(
          `List ${r.ship.name} (${shipClassName(r.ship.ship_class)}, ${r.ship.cannons_count} guns, ${fmtTons(r.stores.provisions_tons, 1)} of stores) at ${portName(r.ship.current_port_id)} for ${fmtCr(p)}${rebuild ? ` (${pctOf(p, rebuild)} of her rebuild value, ${fmtCr(rebuild)})` : ""}?\n\nA buyer pays it into your ${regionName(region)} vault and she is theirs at once, with her berth or roadstead place, stores and guns (not her crew's gossip). The listing lapses if she sails, sinks, joins a convoy, changes guns or has stores taken off.${autopilot ? "\n\nThe autopilot sails her: unless you stop it, it will load or sail her and the listing lapses." : ""}`,
        )
      )
        return null;
      return kibbPost<S.ShipListingResult>("/v1/fleet/list-ship", { ship_id: r.ship.id, price_pence: p });
    });
  }

  return (
    <div className="space-y-3">
      <Field label="Ship">
        <NativeSelect
          value={shipId}
          onChange={(e) => {
            setShipId(e.target.value);
            setOverride(false);
            act.reset();
          }}
        >
          <option value="">Choose a ship…</option>
          {ships.map((x) => (
            <option key={x.ship.id} value={x.ship.id}>
              {x.ship.name} · {shipClassName(x.ship.ship_class)} · {atPort(x) ? portName(x.ship.current_port_id) : "at sea"}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <Field label="Price (Cr)">
        <Input type="number" min={1} step={1} value={price} onChange={(e) => setPrice(e.target.value)} placeholder={rebuild ? String(Math.round(rebuild / 100)) : undefined} />
      </Field>
      {r && (
        <KV
          rows={[
            ["Where", atPort(r) ? `${portName(r.ship.current_port_id)} (${r.ship.status === "berthed" ? "berthed" : "roadstead"})` : "at sea"],
            [
              "Rebuild value (guns included)",
              rebuild !== undefined
                ? fmtCr(rebuild)
                : upper !== undefined
                  ? `at most ${fmtCr(upper)} (a turnkey build here plus her guns)`
                  : appraisalError
                    ? "couldn't be appraised"
                    : "…",
            ],
            [
              "Allowed price",
              band ? `${fmtCr(band.min)} – ${fmtCr(band.max)}` : upper !== undefined ? `at most ${fmtCr(Math.floor(upper * 1.5))}` : "50%–150% of it, checked by the game",
            ],
            ["Price vs rebuild", p > 0 && rebuild ? pctOf(p, rebuild) : "—"],
            ["Goes with her", `${r.ship.cannons_count} guns, ${fmtTons(r.stores.provisions_tons, 1)} of stores`],
            ["Hold", r.cargo_used_tons > 0 ? `${fmtTons(r.cargo_used_tons, 1)} aboard: must be empty` : "empty"],
            ["Lien", !pledged.known ? "…" : lien ? `pledged to a loan (${lien.status})` : "none"],
            ["Insurance", policies === undefined ? "…" : insured ? `${insured.status} policy to ${portName(insured.dest_port_id)}` : "none open"],
          ]}
        />
      )}
      {autopilot && (
        <div className="space-y-1.5">
          <WarnBox>
            The fleet autopilot sails this ship and knows nothing of listings: it will load or sail her, which cancels the listing (ship moved). Stop the autopilot
            on the dashboard first if you mean to sell her.
          </WarnBox>
          <Checkbox checked={override} onChange={setOverride}>
            <span className="text-xs">I know, list her anyway</span>
          </Checkbox>
        </div>
      )}
      <ErrorNote error={act.error ?? (shipId ? why : null)} />
      {act.result && (
        <p className="text-sm">
          Listed {act.result.ship_name} at {portName(act.result.port_id)} for {fmtCr(act.result.price_pence)}.
        </p>
      )}
      <Button className="w-full" disabled={!!why || act.busy} onClick={submit}>
        {act.busy ? "Listing…" : "List for sale"}
      </Button>
      <p className="text-muted-foreground text-xs">
        To be sold a ship must be free to change hands: lying at a port with an empty hold, outside any convoy (and with no convoy request open), with no open
        insurance policy and no loan lien. Cancel the listing any time before a buyer takes it.
      </p>
    </div>
  );
}

// ── Ships for sale at our quays ───────────────────────────────────────────────

function ForSale({
  presence,
  deals,
  vaults,
  companyId,
  ourIds,
  onDone,
}: {
  presence: Presence;
  deals: DealsView;
  vaults: Vaults;
  companyId: string | undefined;
  ourIds: Set<string>;
  onDone: () => void;
}) {
  const { portName, shipClassName } = useCatalog();
  const regionOf = useRegionOf();
  const [port, setPort] = useState("");
  const quayKey = [...presence.quay].sort().join(",");
  // Listings are shown only at ports where we have quay presence: read each.
  const { data, error, reload } = usePoll(
    quayKey
      ? async () => {
          const ports = quayKey.split(",");
          const pages = await Promise.all(
            ports.map((p) =>
              fetchAll<S.ShipListingResult>("/v1/fleet/ship-listings", { port_id: p }, 200, 2).then(
                (rows) => ({ port: p, rows, error: null as string | null }),
                (e: Error) => ({ port: p, rows: [] as S.ShipListingResult[], error: e.message }),
              ),
            ),
          );
          return { rows: pages.flatMap((x) => x.rows), failed: pages.filter((x) => x.error).map((x) => `${x.port}: ${x.error}`) };
        }
      : null,
    30_000,
    [quayKey],
  );
  // Resolves to null when the confirmation is declined.
  const act = useAction<S.ShipSaleResult | S.ShipListingResult | null>((r) => {
    if (r === null) return;
    void reload();
    onDone();
  });
  const rows = (data?.rows ?? []).filter((l) => l.status === "open" && (!port || l.port_id === port));

  function buy(l: S.ShipListingResult) {
    const region = regionOf(l.port_id);
    void act.run(async () => {
      const view = await kibbGet<PortDetail>("/v1/world/port", { port_id: l.port_id }).catch(() => null);
      const seen = deals.listingSeen(l.id);
      const build = seen?.buildPence ?? null;
      if (
        !confirm(
          `Buy ${l.ship_name} (${shipClassName(l.ship_class)}, ${l.cannons_count} guns, ${fmtTons(l.stores_provisions_tons, 1)} of stores) at ${portName(l.port_id)} for ${fmtCr(l.price_pence)} from your ${regionName(region)} vault?\n\nThat is ${pctOf(l.price_pence, l.rebuild_value_pence)} of her rebuild value when listed (${fmtCr(l.rebuild_value_pence)}, guns included)${build !== null ? `; building the class here costs ~${fmtCr(build)} (the autopilot's last quote)` : ""}.\n\nShe is yours at once with her berth or roadstead place, stores and guns (her crew's gossip from other ports is cleared). Berth dues from now on are yours${view ? ` (${fmtCr(view.berth_dues_per_day_pence)} a game day berthed there now)` : ""}. The price band is checked again: if her rebuild value has moved outside 50%–150%, the purchase is refused and the seller must relist.${deals.running ? "\n\nThe fleet autopilot is running: it takes command of every ship of yours, so it will sail her too." : ""}`,
        )
      )
        return null;
      return kibbPost<S.ShipSaleResult>("/v1/fleet/buy-ship", { listing_id: l.id });
    });
  }

  function cancel(l: S.ShipListingResult) {
    void act.run(async () => {
      if (!confirm(`Withdraw the listing of ${l.ship_name} at ${fmtCr(l.price_pence)}?`)) return null;
      return kibbPost<S.ShipListingResult>("/v1/fleet/cancel-ship-listing", { listing_id: l.id });
    });
  }

  const sale = act.result && "listing_id" in act.result ? (act.result as S.ShipSaleResult) : null;

  return (
    <Panel
      title="Ships for sale at your quays"
      action={
        <div className="w-full sm:w-48">
          <NativeSelect value={port} onChange={(e) => setPort(e.target.value)}>
            <option value="">All your quays</option>
            {[...presence.quay].sort().map((p) => (
              <option key={p} value={p}>
                {portName(p)}
              </option>
            ))}
          </NativeSelect>
        </div>
      }
    >
      <ErrorNote error={error} />
      {data && data.failed.length > 0 && <ErrorNote error={`Couldn't read ${data.failed.length} port${data.failed.length === 1 ? "" : "s"}: ${data.failed.join("; ")}`} className="mb-3" />}
      <ErrorNote error={act.error} className="mb-3" />
      {sale && (
        <p className="mb-3 text-sm">
          Bought for {fmtCr(sale.price_pence)}:{" "}
          <Link href={`/fleet/${sale.ship_id}`} className="font-medium hover:underline">
            she is yours at {portName(sale.port_id)}
          </Link>
          .
        </p>
      )}
      {!presence.known ? (
        <Loading />
      ) : presence.quay.size === 0 ? (
        <Empty>You have no ship in port and no factor anywhere: ships for sale are listed only where you have quay presence.</Empty>
      ) : !data ? (
        !error && <Loading />
      ) : rows.length === 0 ? (
        <Empty>No ships for sale at {port ? portName(port) : "your quays"}.</Empty>
      ) : (
        <Table head={["Ship", "Port", "Price", "Rebuild (listed)", "Of rebuild", "Seller", "Listed", "Autopilot's view", ""]}>
          {rows.map((l) => {
            const ours = l.seller_company_id === companyId;
            const sibling = !ours && ourIds.has(l.seller_company_id);
            const cash = vaults.cash(regionOf(l.port_id));
            const short = cash !== undefined && cash < l.price_pence;
            const seen = deals.listingSeen(l.id);
            const pct = l.rebuild_value_pence > 0 ? l.price_pence / l.rebuild_value_pence : null;
            return (
              <tr key={l.id}>
                <td>
                  <div className="font-medium">{l.ship_name}</div>
                  <div className="text-muted-foreground text-xs">
                    {shipClassName(l.ship_class)} · {l.cannons_count} guns · {fmtTons(l.stores_provisions_tons, 1)} stores
                  </div>
                  <div className="mt-0.5 flex flex-wrap gap-1">
                    {ours && <Badge variant="secondary" size="sm">yours</Badge>}
                    {sibling && <Badge variant="outline" size="sm">your other company</Badge>}
                  </div>
                </td>
                <td>{portName(l.port_id)}</td>
                <td className="tabular-nums">{fmtCr(l.price_pence)}</td>
                <td className="tabular-nums">{fmtCr(l.rebuild_value_pence)}</td>
                <td className={`tabular-nums ${pct !== null && pct < 0.8 ? "text-success-foreground" : ""}`}>{pctOf(l.price_pence, l.rebuild_value_pence)}</td>
                <td>
                  <CompanyLabel id={l.seller_company_id} companyId={companyId} ourIds={ourIds} />
                </td>
                <td className="whitespace-nowrap text-muted-foreground text-xs">{fmtAgo(l.created_at)}</td>
                <td className="max-w-56 text-muted-foreground text-xs">
                  {seen ? (
                    <>
                      {seen.buildPence !== null && <div>build here ~{fmtCr(seen.buildPence)}</div>}
                      <div>{seen.verdict}</div>
                    </>
                  ) : (
                    "—"
                  )}
                </td>
                <td className="text-right">
                  {ours ? (
                    <Button size="sm" variant="outline" disabled={act.busy} onClick={() => cancel(l)}>
                      Cancel
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={act.busy || short}
                      title={short ? `Only ${fmtCr(cash)} in your ${regionName(regionOf(l.port_id))} vault` : undefined}
                      onClick={() => buy(l)}
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
      <p className="mt-3 text-muted-foreground text-xs">
        Buying needs quay presence at the ship&apos;s port and pays the seller from your vault in that port&apos;s region. A price outside 80%–125% of the rebuild value is
        flagged for review. The autopilot&apos;s view is its buyer&apos;s last look at your quays{deals.deals?.listingsAt ? ` (${fmtAgo(deals.deals.listingsAt)})` : ""}: what
        building the class costs there, and whether the ship would pay back.
      </p>
    </Panel>
  );
}

function OurListings({ rows, error, onDone }: { rows: S.ShipListingResult[] | undefined; error: Error | null; onDone: () => void }) {
  const { portName, shipClassName } = useCatalog();
  const companyId = useCompanyId();
  const ourIds = useOurCompanyIds();
  // Resolves to null when the confirmation is declined.
  const act = useAction<S.ShipListingResult | null>((r) => r && onDone());
  const cancel = (l: S.ShipListingResult) =>
    void act.run(async () => {
      if (!confirm(`Withdraw the listing of ${l.ship_name} at ${fmtCr(l.price_pence)}?`)) return null;
      return kibbPost<S.ShipListingResult>("/v1/fleet/cancel-ship-listing", { listing_id: l.id });
    });
  return (
    <Panel title="Your listings">
      <ErrorNote error={error ?? act.error} />
      {!rows ? (
        !error && <Loading />
      ) : rows.length === 0 ? (
        <Empty>You have never listed a ship.</Empty>
      ) : (
        <Table head={["Ship", "Port", "Price", "Of rebuild", "Status", "Buyer", "Listed", "Closed", ""]}>
          {rows.map((l) => (
            <tr key={l.id}>
              <td>
                <Link href={`/fleet/${l.ship_id}`} className="font-medium hover:underline">
                  {l.ship_name}
                </Link>
                <div className="text-muted-foreground text-xs">{shipClassName(l.ship_class)}</div>
              </td>
              <td>{portName(l.port_id)}</td>
              <td className="tabular-nums">{fmtCr(l.price_pence)}</td>
              <td className="tabular-nums">{pctOf(l.price_pence, l.rebuild_value_pence)}</td>
              <td>
                <Badge variant={l.status === "open" ? "info" : l.status === "sold" ? "success" : "outline"} size="sm">
                  {l.status}
                </Badge>
                {l.cancel_reason && <div className="text-muted-foreground text-xs">{CANCEL_REASON[l.cancel_reason] ?? l.cancel_reason}</div>}
              </td>
              <td>{l.buyer_company_id ? <CompanyLabel id={l.buyer_company_id} companyId={companyId} ourIds={ourIds} /> : <span className="text-muted-foreground">—</span>}</td>
              <td className="whitespace-nowrap text-muted-foreground text-xs">{fmtDateTime(l.created_at)}</td>
              <td className="whitespace-nowrap text-muted-foreground text-xs">{l.closed_at ? fmtDateTime(l.closed_at) : "—"}</td>
              <td className="text-right">
                {l.status === "open" && (
                  <Button size="sm" variant="outline" disabled={act.busy} onClick={() => cancel(l)}>
                    Cancel
                  </Button>
                )}
              </td>
            </tr>
          ))}
        </Table>
      )}
    </Panel>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

function ShipsMarketView() {
  const params = useSearchParams();
  const initialShip = params.get("list") ?? "";
  const [tab, setTab] = useState(params.get("tab") === "commissions" ? "commissions" : "ships");
  useCompanyDirectory();
  const companyId = useCompanyId();
  const ourIds = useOurCompanyIds();
  const presence = usePresence();
  const deals = useDeals();
  const vaults = useVaults();
  // Our own listings, any status (no port: the game lists ours), newest first.
  const { data: ours, error: oursError, reload: reloadOurs } = usePoll(() => fetchAll<S.ShipListingResult>("/v1/fleet/ship-listings", {}, 200, 5), 30_000);
  const refresh = () => {
    void reloadOurs();
    void vaults.reload();
    presence.reload();
  };
  const open = (ours ?? []).filter((l) => l.status === "open");
  const sold = (ours ?? []).filter((l) => l.status === "sold");

  return (
    <div className="space-y-5 pb-8 sm:space-y-6">
      <PageHeader
        title="Ship market"
        subtitle="Ships for sale where you have quay presence, your own listings, and hulls built to order (commissions)."
      />
      <Metrics
        className="sm:grid-cols-4 xl:grid-cols-4"
        items={[
          { label: "Your quays", value: presence.known ? String(presence.quay.size) : "…", hint: "ships in port and factors" },
          { label: "Your open listings", value: ours ? String(open.length) : "…" },
          { label: "Ships you sold", value: ours ? String(sold.length) : "…", hint: ours ? fmtCr(sold.reduce((n, l) => n + l.price_pence, 0)) : undefined },
          {
            label: "Autopilot deals",
            value: deals.deals ? `${deals.deals.shipsBought} bought` : "—",
            hint: deals.deals ? `${deals.deals.commissionsDelivered} built to order${deals.deals.shipDeals ? "" : " · ship deals off"}` : "no autopilot state",
          },
        ]}
      />
      <Tabs value={tab} onValueChange={(v) => setTab(String(v))}>
        <TabsList>
          <TabsTab value="ships">Ships for sale</TabsTab>
          <TabsTab value="commissions">Commissions</TabsTab>
        </TabsList>
        <TabsPanel value="ships" className="pt-2">
          <div className="grid items-start gap-4 xl:grid-cols-3">
            <div className="space-y-4 xl:col-span-2">
              <ForSale presence={presence} deals={deals} vaults={vaults} companyId={companyId} ourIds={ourIds} onDone={refresh} />
              <OurListings rows={ours} error={oursError} onDone={refresh} />
            </div>
            <div className="space-y-4">
              <Panel title="List a ship for sale">
                <ListShipForm initial={initialShip} presence={presence} ours={ours} deals={deals} onDone={refresh} />
              </Panel>
              <WarnBox tone="info">
                <p>
                  Ships sell at 50%–150% of their rebuild value: the class&apos;s cheapest current turnkey quote at an open yard plus 150 Cr a gun. The band is
                  checked again when a buyer takes her (refused if the rebuild value has moved: the seller must relist).
                </p>
                <p>A bought ship keeps her berth or roadstead place, stores and guns. Berth dues up to the sale are the seller&apos;s, the buyer&apos;s from then on.</p>
                <p>The Goldsmiths list the ships they foreclose on here too.</p>
                {deals.running && (
                  <p>
                    The autopilot&apos;s buyer also looks at these listings{deals.deals?.shipDeals ? "" : " (ship deals are off now)"}, and buys one when it costs less than
                    building the class there and passes the same payback checks as a new hull.
                  </p>
                )}
              </WarnBox>
            </div>
          </div>
        </TabsPanel>
        <TabsPanel value="commissions" className="pt-2">
          <CommissionsView />
        </TabsPanel>
      </Tabs>
    </div>
  );
}

export default function ShipsMarketPage() {
  return (
    <Suspense fallback={<Loading />}>
      <ShipsMarketView />
    </Suspense>
  );
}
