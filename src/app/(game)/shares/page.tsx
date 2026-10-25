"use client";

import { useState } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Empty, ErrorNote, KV, Loading, Metrics, NativeSelect, PageHeader, Panel, Table } from "@/components/kibb/bits";
import {
  CompanyLabel,
  WarnBox,
  crToPence,
  firstProblem,
  num,
  regionName,
  useCompanyDirectory,
  useCompanyNames,
  useFleetFinance,
  useRegionOf,
  useShips,
  useVaults,
} from "@/components/kibb/finance-common";
import { useCompanyId, useOurCompanyIds } from "@/components/kibb/naval-common";
import { Field, RegionSelect } from "@/components/kibb/pickers";
import { useAction } from "@/hooks/use-action";
import { useCatalog } from "@/hooks/use-catalog";
import { usePoll } from "@/hooks/use-poll";
import { kibbGet, kibbPost } from "@/lib/kibb/browser";
import { fmtCr, fmtDateTime } from "@/lib/kibb/format";
import type * as S from "@/lib/kibb/schema";
import type { CompanyProfile, ShipResult } from "@/lib/kibb/types";

type Vaults = ReturnType<typeof useVaults>;

/** A ship whose 64ths we can list: one of ours, or another company's we hold shares in. */
interface Listable {
  shipId: string;
  name: string;
  owned: boolean;
  /** 64ths we hold (an owner holds every one nobody else does). */
  held: number;
  /** Of which already on offer in our open listings. */
  listed: number;
}

function listables(ships: ShipResult[] | undefined, holdings: S.ShareHolding[] | undefined, listings: S.ShareListing[] | undefined, companyId: string | undefined): Listable[] {
  const onOffer = (shipId: string) =>
    (listings ?? []).filter((l) => l.ship_id === shipId && l.seller_company_id === companyId && l.status === "open").reduce((n, l) => n + l.sixty_fourths, 0);
  const own = (ships ?? [])
    .filter((r) => r.ship.status !== "sunk")
    .map((r) => {
      const h = holdings?.find((x) => x.ship_id === r.ship.id && x.is_owner);
      return { shipId: r.ship.id, name: r.ship.name, owned: true, held: h ? h.sixty_fourths : 64, listed: onOffer(r.ship.id) };
    });
  const others = (holdings ?? [])
    .filter((h) => !h.is_owner && !h.sunk && h.sixty_fourths > 0)
    .map((h) => ({ shipId: h.ship_id, name: h.ship_name, owned: false, held: h.sixty_fourths, listed: onOffer(h.ship_id) }));
  return [...own, ...others];
}

function ListForm({
  options,
  initial,
  homeRegion,
  fleet,
  onDone,
}: {
  options: Listable[];
  initial: string;
  homeRegion: string;
  fleet: ReturnType<typeof useFleetFinance>;
  onDone: () => void;
}) {
  const [shipId, setShipId] = useState(initial);
  const [count, setCount] = useState("8");
  const [price, setPrice] = useState("");
  const [region, setRegion] = useState("");
  const act = useAction<S.ShareListing>(onDone);
  const pick = options.find((o) => o.shipId === shipId);
  const at = region || homeRegion;
  // Our own ship's rebuild value (from the Goldsmiths' quote) gives the price band; another company's isn't ours to quote.
  const { data: quote } = usePoll(pick?.owned ? () => kibbGet<S.BackstopQuote>("/v1/loan/backstop-quote", { ship_id: shipId }) : null, 0, [shipId, pick?.owned]);
  const sixtyFourth = quote && quote.ship_id === shipId ? quote.rebuild_value_pence / 64 : undefined;
  const band = sixtyFourth !== undefined ? { min: Math.ceil(sixtyFourth * 0.5), max: Math.floor(sixtyFourth * 1.5) } : undefined;
  const n = num(count);
  const p = crToPence(price);
  const free = pick ? pick.held - pick.listed : 0;
  const why = firstProblem([
    [!!pick, "Choose a ship."],
    [Number.isInteger(n) && n >= 1, "List at least one 64th."],
    [!pick || n <= free, `You have ${free} of its 64ths free to list${pick && pick.listed ? ` (${pick.listed} already on offer)` : ""}.`],
    [p > 0, "Enter the price per 64th."],
    [!band || (p >= band.min && p <= band.max), `The price must lie within ${fmtCr(band?.min, 2)} – ${fmtCr(band?.max, 2)} a 64th (50%–150% of a 64th of the rebuild value).`],
  ]);

  function submit() {
    if (!pick) return;
    const ap = pick.owned && fleet.ships.has(pick.shipId) ? "\n\nThe fleet autopilot sails this ship: its profits will be shared with the buyers." : "";
    if (
      !confirm(
        `List ${n}/64 of ${pick.name} at ${fmtCr(p, 2)} a 64th (${fmtCr(p * n, 2)} in all), paid into your ${regionName(at)} vault?${pick.owned ? " Every game day you will pay each outside holder its 64ths of the ship's realised profit, from your home vault." : ""}${ap}`,
      )
    )
      return;
    void act.run(() => kibbPost<S.ShareListing>("/v1/ship-shares/list", { ship_id: shipId, sixty_fourths: n, price_per_64th_pence: p, banking_region: at }));
  }

  return (
    <div className="space-y-3">
      <Field label="Ship">
        <NativeSelect value={shipId} onChange={(e) => setShipId(e.target.value)}>
          <option value="">Choose a ship…</option>
          {options.map((o) => (
            <option key={o.shipId} value={o.shipId}>
              {o.name} · {o.owned ? "yours" : "held"} · {o.held}/64{o.listed ? `, ${o.listed} listed` : ""}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Field label="64ths">
          <Input type="number" min={1} max={free || 64} step={1} value={count} onChange={(e) => setCount(e.target.value)} />
        </Field>
        <Field label="Price per 64th (Cr)">
          <Input type="number" min={0.01} step={0.01} value={price} onChange={(e) => setPrice(e.target.value)} placeholder={sixtyFourth ? (sixtyFourth / 100).toFixed(2) : undefined} />
        </Field>
        <Field label="Paid into" className="col-span-2 sm:col-span-1">
          <RegionSelect value={at} onChange={setRegion} />
        </Field>
      </div>
      {pick && (
        <KV
          rows={[
            ["A 64th of the rebuild value", sixtyFourth !== undefined ? fmtCr(sixtyFourth, 2) : pick.owned ? "…" : "not known for another company's ship"],
            ["Allowed price", band ? `${fmtCr(band.min, 2)} – ${fmtCr(band.max, 2)}` : "50%–150% of that, checked by the game"],
            ["Total", Number.isFinite(p) && Number.isFinite(n) ? fmtCr(p * n, 2) : "—"],
          ]}
        />
      )}
      {pick?.owned && (
        <p className="text-muted-foreground text-xs">
          As owner you sell from the 64ths nobody else holds and keep the rest. Holders are paid a dividend every game day from the ship&apos;s realised profit (sales
          from its hold less cargo bought into it, freight rewards, its berth dues, its venture shares), from your home vault.
        </p>
      )}
      <ErrorNote error={act.error ?? (shipId ? why : null)} />
      {act.result && <p className="text-sm">Listed {act.result.sixty_fourths}/64 of {act.result.ship_name}.</p>}
      <Button className="w-full" disabled={!!why || act.busy} onClick={submit}>
        {act.busy ? "Listing…" : "List 64ths"}
      </Button>
    </div>
  );
}

export default function SharesPage() {
  useCompanyDirectory();
  const names = useCompanyNames();
  const companyId = useCompanyId();
  const ourIds = useOurCompanyIds();
  const regionOf = useRegionOf();
  const { portName } = useCatalog();
  const { data: profile } = usePoll(() => kibbGet<CompanyProfile>("/v1/company/profile"));
  const { data: ships } = useShips();
  const fleet = useFleetFinance();
  const vaults: Vaults = useVaults();
  const { data: holdings, error: holdingsError, reload: reloadHoldings } = usePoll(() => kibbGet<S.ShareHolding[]>("/v1/ship-shares/holdings"), 30_000);
  const [filter, setFilter] = useState("");
  const { data: listings, error: listingsError, reload: reloadListings } = usePoll(
    () => kibbGet<S.ShareListing[]>("/v1/ship-shares/listings", { ship_id: filter }),
    30_000,
    [filter],
  );
  // Our own open listings (for what is left to list), whatever the filter.
  const { data: allListings, reload: reloadAll } = usePoll(() => kibbGet<S.ShareListing[]>("/v1/ship-shares/listings"), 30_000);
  const [listShip, setListShip] = useState("");
  const act = useAction<S.ShareListing>(() => refresh());
  const homeRegion = regionOf(profile?.company.home_port_id) ?? "channel";
  const options = listables(ships, holdings, allListings, companyId);

  function refresh() {
    void reloadHoldings();
    void reloadListings();
    void reloadAll();
    void vaults.reload();
  }

  function buy(l: S.ShareListing) {
    const total = l.price_per_64th_pence * l.sixty_fourths;
    if (
      !confirm(
        `Buy ${l.sixty_fourths}/64 of ${l.ship_name} for ${fmtCr(total, 2)} (${fmtCr(l.price_per_64th_pence, 2)} a 64th) from your ${regionName(l.banking_region)} vault?\n\nEvery game day the owner (${names.label(l.owner_company_id)}) pays you your 64ths of the ship's realised profit. Shares follow the ship to a new owner and are worthless if it sinks.`,
      )
    )
      return;
    void act.run(() => kibbPost<S.ShareListing>("/v1/ship-shares/buy", { listing_id: l.id }));
  }

  const cancel = (l: S.ShareListing) =>
    confirm(`Withdraw your listing of ${l.sixty_fourths}/64 of ${l.ship_name}?`) && void act.run(() => kibbPost<S.ShareListing>("/v1/ship-shares/cancel", { listing_id: l.id }));

  const outside = (holdings ?? []).filter((h) => !h.is_owner);
  const ownWithHolders = (holdings ?? []).filter((h) => h.is_owner);
  const filterShips = [...new Map([...(ships ?? []).map((r) => [r.ship.id, r.ship.name] as const), ...(holdings ?? []).map((h) => [h.ship_id, h.ship_name] as const)]).entries()];

  return (
    <div className="space-y-5 pb-8 sm:space-y-6">
      <PageHeader title="Ship shares" subtitle="A ship is 64ths. Outside holders are paid a daily dividend from the ship's realised profit; its owner holds every 64th nobody else does." />
      <Metrics
        className="sm:grid-cols-4 xl:grid-cols-4"
        items={[
          { label: "Ships you hold shares in", value: holdings ? String(outside.length) : "…" },
          { label: "Dividends received", value: holdings ? fmtCr(outside.reduce((n, h) => n + h.dividends_paid_pence, 0)) : "…" },
          { label: "Your ships with outside holders", value: holdings ? String(ownWithHolders.length) : "…" },
          { label: "Open listings", value: listings ? String(listings.length) : "…", hint: filter ? "this ship" : "all ships" },
        ]}
      />
      <div className="grid items-start gap-4 xl:grid-cols-3">
        <div className="space-y-4 xl:col-span-2">
          <Panel title="Your holdings">
            <ErrorNote error={holdingsError} />
            {!holdings ? (
              !holdingsError && <Loading />
            ) : holdings.length === 0 ? (
              <Empty>You hold no 64ths of other companies&apos; ships, and none of your ships has outside holders.</Empty>
            ) : (
              <Table head={["Ship", "Owner", "Your 64ths", "Realised P&L", "Dividends paid", ""]}>
                {holdings.map((h) => (
                  <tr key={`${h.ship_id}-${h.is_owner}`}>
                    <td>
                      <span className="inline-flex flex-wrap items-center gap-1">
                        {h.is_owner ? (
                          <Link href={`/fleet/${h.ship_id}`} className="font-medium hover:underline">
                            {h.ship_name}
                          </Link>
                        ) : (
                          <span className="font-medium">{h.ship_name}</span>
                        )}
                        {h.sunk && <Badge variant="error" size="sm">sunk</Badge>}
                      </span>
                    </td>
                    <td>
                      <CompanyLabel id={h.owner_company_id} companyId={companyId} ourIds={ourIds} />
                    </td>
                    <td className="tabular-nums">{h.sixty_fourths}/64</td>
                    <td className={`tabular-nums ${h.realised_pnl_pence < 0 ? "text-destructive" : ""}`}>{fmtCr(h.realised_pnl_pence)}</td>
                    <td className="tabular-nums">{fmtCr(h.dividends_paid_pence)}</td>
                    <td className="text-right">
                      {!h.sunk && h.sixty_fourths > 0 && (
                        <Button size="sm" variant="outline" onClick={() => setListShip(h.ship_id)}>
                          List
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </Table>
            )}
            <p className="mt-3 text-muted-foreground text-xs">
              On your own ships, &quot;your 64ths&quot; are what nobody else holds and the dividends are what you paid out. Only sales from the hold count toward
              profit (goods unloaded to a warehouse first don&apos;t).
            </p>
          </Panel>
          <Panel
            title="Listings"
            action={
              <div className="w-full sm:w-48">
                <NativeSelect value={filter} onChange={(e) => setFilter(e.target.value)}>
                  <option value="">All ships</option>
                  {filterShips.map(([id, name]) => (
                    <option key={id} value={id}>
                      {name}
                    </option>
                  ))}
                </NativeSelect>
              </div>
            }
          >
            <ErrorNote error={listingsError} />
            <ErrorNote error={act.error} className="mb-3" />
            {!listings ? (
              !listingsError && <Loading />
            ) : listings.length === 0 ? (
              <Empty>No 64ths listed{filter ? " for this ship" : ""}.</Empty>
            ) : (
              <Table head={["Ship", "64ths", "Per 64th", "Total", "Paid in", "Seller", "Owner", "Listed", ""]}>
                {listings.map((l) => {
                  const ours = l.seller_company_id === companyId;
                  const sibling = !ours && ourIds.has(l.seller_company_id);
                  const total = l.price_per_64th_pence * l.sixty_fourths;
                  const cash = vaults.cash(l.banking_region);
                  return (
                    <tr key={l.id}>
                      <td className="font-medium">{l.ship_name}</td>
                      <td className="tabular-nums">{l.sixty_fourths}/64</td>
                      <td className="tabular-nums">{fmtCr(l.price_per_64th_pence, 2)}</td>
                      <td className="tabular-nums">{fmtCr(total)}</td>
                      <td className="capitalize">{regionName(l.banking_region)}</td>
                      <td>
                        <CompanyLabel id={l.seller_company_id} companyId={companyId} ourIds={ourIds} />
                      </td>
                      <td>
                        <CompanyLabel id={l.owner_company_id} companyId={companyId} ourIds={ourIds} />
                      </td>
                      <td className="whitespace-nowrap text-muted-foreground text-xs">{fmtDateTime(l.created_at)}</td>
                      <td className="text-right">
                        {ours ? (
                          <Button size="sm" variant="outline" disabled={act.busy} onClick={() => cancel(l)}>
                            Cancel
                          </Button>
                        ) : (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={act.busy || (cash !== undefined && cash < total)}
                            title={cash !== undefined && cash < total ? `Only ${fmtCr(cash)} in your ${regionName(l.banking_region)} vault` : sibling ? "Another of your companies: dealt with as with any other" : undefined}
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
              Buying needs no presence at any port; the price band (50%–150% of a 64th of the rebuild value) is checked again when you buy. A buy takes the whole
              listing.
            </p>
          </Panel>
        </div>
        <div className="space-y-4">
          <Panel title="List 64ths for sale">
            <ListForm key={listShip} options={options} initial={listShip} homeRegion={homeRegion} fleet={fleet} onDone={refresh} />
          </Panel>
          <WarnBox tone="info">
            <p>Shares follow the ship to a new owner, and are worthless if it sinks. A bankrupt company&apos;s shares in others&apos; ships go to their owners.</p>
            <p>
              Ship shares count toward net worth. Your home port is {portName(profile?.company.home_port_id)}, so dividends on your own ships come from your{" "}
              {regionName(homeRegion)} vault.
            </p>
          </WarnBox>
        </div>
      </div>
    </div>
  );
}
