"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { RefreshCwIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Empty, ErrorNote, KV, Loading, NativeSelect, PageHeader, Panel, ShipStatusBadge, Table } from "@/components/kibb/bits";
import { DiscountYardBadge, yardDiscountText } from "@/components/kibb/deals-common";
import { AnnualRateText, CashLine, LOAN, WarnBox, regionName, useRegionOf, useVaults } from "@/components/kibb/finance-common";
import { Checkbox } from "@/components/kibb/naval-common";
import { Field } from "@/components/kibb/pickers";
import { useAction } from "@/hooks/use-action";
import { useCatalog } from "@/hooks/use-catalog";
import { usePoll } from "@/hooks/use-poll";
import { dash, kibbGet, kibbPost } from "@/lib/kibb/browser";
import { fmtCr, fmtIn, fmtTons } from "@/lib/kibb/format";
import type * as S from "@/lib/kibb/schema";
import type { BuildMode, BuildShipResult, CatalogShipClass, ShipResult, WorldClock } from "@/lib/kibb/types";

/** Daily sprawl upkeep in pence for this many sprawl tons (the first 40 t are free). */
function sprawlPerDay(tons: number): number {
  return tons <= 40 ? 0 : Math.round(4500 * ((tons - 40) / 100) ** 1.45);
}

/** The hulls' daily bill (guide 3.12): sprawl on coastal + regional tons plus half the oceanic tons (rounded down), plus 1 Cr per oceanic ton. */
function hullUpkeep(lower: number, oceanic: number): number {
  return sprawlPerDay(lower + Math.floor(oceanic / 2)) + 100 * oceanic;
}

/** "3 ships" for the hulls afloat; sunk hulls the fleet list still carries are counted apart, never as ships. */
function fleetCount(ships: ShipResult[]): string {
  const sunk = ships.filter((r) => r.ship.status === "sunk").length;
  const n = ships.length - sunk;
  return `${n} ship${n === 1 ? "" : "s"}${sunk ? ` (${sunk} sunk)` : ""}`;
}

/** Extra upkeep per game day the new hull adds to the fleet's bill, in pence. */
function upkeepDelta(ships: ShipResult[], classes: CatalogShipClass[], cls: CatalogShipClass): number {
  const afloat = ships.filter((r) => r.ship.status !== "sunk");
  const isOceanic = (r: ShipResult) => classes.find((c) => c.id === r.ship.ship_class)?.hull_category === "oceanic";
  const lower = afloat.filter((r) => !isOceanic(r)).reduce((n, r) => n + r.hold_capacity_tons, 0);
  const oceanic = afloat.filter(isOceanic).reduce((n, r) => n + r.hold_capacity_tons, 0);
  const add = cls.hold_capacity_tons;
  return cls.hull_category === "oceanic" ? hullUpkeep(lower, oceanic + add) - hullUpkeep(lower, oceanic) : hullUpkeep(lower + add, oceanic) - hullUpkeep(lower, oceanic);
}

function Shipyard({ ships, onBuilt }: { ships: ShipResult[]; onBuilt: () => void }) {
  const { catalog, portName, goodName } = useCatalog();
  const { data: clock } = usePoll(() => kibbGet<WorldClock>("/v1/world/clock"));
  const { data: factors } = usePoll(() => kibbGet<string[]>("/v1/company/factors"), 60_000);
  const vaults = useVaults();
  const regionOf = useRegionOf();
  const unlocked = clock?.unlocked_phase ?? 1;

  // A yard quotes and builds only for a company present there: a ship in port or a factor.
  const presence = new Set<string>([
    ...ships.filter((r) => r.ship.status !== "sailing" && r.ship.status !== "sunk").map((r) => r.ship.current_port_id ?? ""),
    ...(factors ?? []),
  ]);
  const yards = (catalog?.ports ?? [])
    .filter((p) => p.has_shipyard && p.phase <= unlocked)
    .sort((a, b) => Number(presence.has(b.id)) - Number(presence.has(a.id)) || a.name.localeCompare(b.name));
  const classes = catalog?.ship_classes ?? [];

  const [port, setPort] = useState("");
  const [cls, setCls] = useState("");
  const [mode, setMode] = useState<BuildMode>("turnkey_cash");
  const [name, setName] = useState("");
  const [mortgage, setMortgage] = useState(false);
  const yard = port || yards.find((p) => presence.has(p.id))?.id || "";
  const klass = classes.find((c) => c.id === (cls || "collier")) ?? classes[0];
  const here = presence.has(yard);

  // Turnkey prices follow the yard's ask ladder, so the quote is kept fresh.
  const getQuote = () => kibbGet<S.BuildQuoteResult>("/v1/shipyard/quote", { port_id: yard, ship_class: klass.id, build_mode: mode });
  const { data: quote, error: quoteError, loading: quoting, reload: requote } = usePoll(
    yard && klass && here ? getQuote : null,
    30_000,
    [yard, klass?.id, mode, here],
  );

  const suggest = useAction<{ name: string }>((r) => setName(r.name));
  // Resolves to null when the user declines the confirmation.
  const build = useAction<BuildShipResult | null>((r) => {
    void requote();
    if (!r) return;
    setMortgage(false);
    void vaults.reload();
    onBuilt();
    void suggest.run(() => dash.get<{ name: string }>("/api/kibb/ship-name"));
  });
  useEffect(() => {
    void suggest.run(() => dash.get<{ name: string }>("/api/kibb/ship-name"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!catalog) return <Loading />;
  const locked = klass && klass.phase > unlocked;
  const missing = quote?.materials.filter((m) => !m.in_stock) ?? [];
  const discount = quote?.yard_discount ?? catalog.ports.find((p) => p.id === yard)?.yard_discount ?? null;
  const region = regionOf(yard);
  // A ship mortgage (guide 3.4): the Goldsmiths of the yard's region pay 60% of the price (80% for an oceanic hull).
  const terms = quote?.mortgage ?? null;
  const mortgaged = mortgage && !!terms?.available;
  const price = quote?.total_cost_pence ?? null;
  const yourPart = price !== null ? Math.max(0, price - (mortgaged && terms ? terms.principal_pence : 0)) : null;

  return (
    <div className="grid items-start gap-6 lg:grid-cols-2">
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Yard" className="sm:col-span-2">
            <NativeSelect value={yard} onChange={(e) => setPort(e.target.value)}>
              {yards.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.yard_discount ? " · discount yard" : ""}
                  {presence.has(p.id) ? " ●" : " (no presence)"}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field label="Class">
            <NativeSelect value={klass?.id ?? ""} onChange={(e) => setCls(e.target.value)}>
              {classes.map((c) => (
                <option key={c.id} value={c.id} disabled={c.phase > unlocked}>
                  {c.name} · {c.hull_category} · {c.hold_capacity_tons} t{c.phase > unlocked ? ` (phase ${c.phase})` : ""}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field label="Build mode">
            <NativeSelect value={mode} onChange={(e) => setMode(e.target.value as BuildMode)}>
              <option value="turnkey_cash">Turnkey (yard buys materials)</option>
              <option value="byom">Own materials (from your warehouse)</option>
            </NativeSelect>
          </Field>
          <Field label="Name" className="sm:col-span-2">
            <div className="flex gap-2">
              <Input value={name} maxLength={64} onChange={(e) => setName(e.target.value)} placeholder="Ship name" />
              <Button
                type="button"
                variant="outline"
                size="icon"
                title="Another bot name"
                disabled={suggest.busy}
                onClick={() => void suggest.run(() => dash.get<{ name: string }>("/api/kibb/ship-name"))}
              >
                <RefreshCwIcon />
              </Button>
            </div>
          </Field>
        </div>
        {klass && (
          <KV
            rows={[
              ["Hull", `${klass.hull_category} · ${(klass.base_speed_centiknots / 100).toFixed(1)} kn · crew ${klass.crew_required}`],
              ["Hold", `${fmtTons(klass.hold_capacity_tons)} · up to ${klass.max_cannons} guns`],
              ["Extra fleet upkeep", `${fmtCr(upkeepDelta(ships, classes, klass))} / game day`],
            ]}
          />
        )}
        <p className="text-muted-foreground text-xs">
          New ships launch berthed with no guns (150 Cr each at a yard, 2 t of hold per gun) and no stores. Sprawl upkeep is 45 Cr ×
          ((t − 40)/100)^1.45 a game day, where t is your coastal and regional tonnage plus half your oceanic tonnage (rounded down);
          oceanic hulls also pay 1 Cr per ton a day on top.
        </p>
      </div>

      <div className="space-y-3">
        {!here ? (
          <Empty>
            You need a ship in port or a factor at {portName(yard)} to get a quote.
          </Empty>
        ) : locked ? (
          <Empty>The {klass.name} needs phase {klass.phase}.</Empty>
        ) : quoteError ? (
          <ErrorNote error={quoteError} />
        ) : !quote || quoting ? (
          <Loading />
        ) : (
          <>
            {discount && (
              <div className="flex flex-wrap items-center gap-2">
                <DiscountYardBadge discount={discount} />
                <span className="text-muted-foreground text-xs">
                  {yardDiscountText(discount)}, already taken off below. The hull&apos;s rebuild value is unchanged: the full Crown list price, which ship
                  sales, insurance, loans and break-ups go by.
                </span>
              </div>
            )}
            <KV
              rows={[
                [discount ? `Labour (${(discount.labour_discount_bps / 100).toLocaleString("en-GB", { maximumFractionDigits: 1 })}% off)` : "Labour", fmtCr(quote.labour_pence)],
                ...(mode === "byom"
                  ? ([] as Array<[string, string]>)
                  : ([
                      ["Materials (players' asks and the NPC ladder)", fmtCr(quote.materials_pence)],
                      ["Customs on every fill", fmtCr(quote.customs_pence)],
                      [
                        discount?.turnkey_markup_waived
                          ? "Yard markup (waived at this yard)"
                          : `Yard markup ${(quote.yard_markup_bps / 100).toFixed(1)}% on the NPC part (${fmtCr(quote.npc_materials_pence)})`,
                        fmtCr(quote.yard_markup_pence),
                      ],
                    ] as Array<[string, string]>)),
                ["Total", <span key="t" className="font-semibold">{quote.total_cost_pence != null ? fmtCr(quote.total_cost_pence) : "can't be built now"}</span>],
              ]}
            />
            <Table
              head={
                mode === "byom"
                  ? ["Material", "Tons", "In your warehouse"]
                  : ["Material", "Tons", "Yard supply", "From players / NPC", "Cost", "Customs"]
              }
            >
              {quote.materials.map((m) => (
                <tr key={m.commodity_id}>
                  <td>{goodName(m.commodity_id)}</td>
                  <td className="tabular-nums">{m.quantity}</td>
                  <td>{m.in_stock ? <Badge variant="success" size="sm">yes</Badge> : <Badge variant="error" size="sm">short</Badge>}</td>
                  {mode !== "byom" && (
                    <>
                      <td className="whitespace-nowrap tabular-nums">
                        {fmtTons(m.player_tons)} / {fmtTons(m.npc_tons)}
                      </td>
                      <td className="tabular-nums">
                        {m.cost_pence != null ? fmtCr(m.cost_pence) : "—"}
                        {m.npc_cost_pence != null && m.cost_pence != null && m.npc_cost_pence !== m.cost_pence && (
                          <div className="text-muted-foreground text-xs">NPC part {fmtCr(m.npc_cost_pence)}</div>
                        )}
                      </td>
                      <td className="tabular-nums">{m.customs_pence != null ? fmtCr(m.customs_pence) : "—"}</td>
                    </>
                  )}
                </tr>
              ))}
            </Table>
            {mode !== "byom" && (
              <p className="text-muted-foreground text-xs">
                Turnkey buys each material off this port&apos;s ask book, cheapest first: other players&apos; asks (never your own companies&apos;, none over 2.5×
                the mid) and the NPC ladder. Customs is paid on every fill; the yard&apos;s markup only on what came from the NPCs, so a yard where players
                sell materials builds cheaper. Under a royal monopoly on a material, only players&apos; asks can supply it.
              </p>
            )}
            {missing.length > 0 && (
              <ErrorNote
                error={
                  mode === "byom"
                    ? `Your warehouse here is short of ${missing.map((m) => goodName(m.commodity_id)).join(", ")}.`
                    : `The ask book here can't supply ${missing.map((m) => goodName(m.commodity_id)).join(", ")} right now (a build would be refused).`
                }
              />
            )}
            {terms && (
              <div className="space-y-2 rounded-lg border p-3">
                <Checkbox checked={mortgaged} onChange={(v) => setMortgage(v && terms.available)}>
                  <span className={terms.available ? undefined : "text-muted-foreground"}>
                    Ship mortgage from {terms.lender_name}
                    {!terms.available && " (not available: you still owe on one)"}
                  </span>
                </Checkbox>
                <KV
                  rows={[
                    ["They pay", `${fmtCr(terms.principal_pence)} (${klass.hull_category === "oceanic" ? "80%" : "60%"} of the price)`],
                    ["Rate", <AnnualRateText key="r" bps={terms.annual_rate_bps} />],
                    [
                      "Repaid",
                      `${terms.installments} installments${terms.installment_pence != null ? ` of ${fmtCr(terms.installment_pence)}` : ""} every ${LOAN.installmentEveryDays} game days over ${terms.term_game_days} game days`,
                    ],
                    ["Total repayable", fmtCr(terms.total_repayable_pence)],
                    ["You pay now", price !== null ? fmtCr(Math.max(0, price - terms.principal_pence)) : "—"],
                  ]}
                />
                <p className="text-muted-foreground text-xs">
                  An ordinary Goldsmiths&apos; loan, amortised, with recourse and a lien on the new ship: she can sail and trade, but can&apos;t be listed, sold or
                  pledged again until it is repaid. One mortgage at a time. Build and loan succeed or fail together. On a default she goes to them where she lies,
                  credited at {LOAN.foreclosureCreditPct}% of her rebuild value, and they pay you any surplus over what you owe. Guns fitted later never count toward
                  the price.
                </p>
              </div>
            )}
            <CashLine region={region} cash={vaults.cash(region)} need={yourPart ?? undefined} />
            <ErrorNote error={build.error} />
            {build.result && (
              <div className="space-y-2 text-sm">
                <p>
                  Built <Link href={`/fleet/${build.result.ship_id}`} className="font-medium hover:underline">{build.result.name}</Link> for{" "}
                  {fmtCr(build.result.total_cost_pence)}
                  {build.result.mortgage ? `, of which the Goldsmiths lent ${fmtCr(build.result.mortgage.principal_pence)}` : ""}.
                </p>
                {build.result.mortgage && (
                  <WarnBox tone="info">
                    Ship mortgage: {fmtCr(build.result.mortgage.owed_pence)} owed in {regionName(build.result.mortgage.banking_region)}
                    {build.result.mortgage.installment_pence != null ? `, ${fmtCr(build.result.mortgage.installment_pence)} every ${LOAN.installmentEveryDays} game days` : ""}
                    {build.result.mortgage.matures_at ? `, the last ${fmtIn(build.result.mortgage.matures_at)}` : ""}. See{" "}
                    <Link href="/loans" className="underline">
                      Loans
                    </Link>
                    .
                  </WarnBox>
                )}
              </div>
            )}
            <Button
              disabled={build.busy || !quote.available || quote.total_cost_pence == null || !name.trim()}
              onClick={() =>
                void build.run(async () => {
                  // Re-quote first: the charge is whatever the yard asks at the moment of building.
                  const fresh = await getQuote();
                  if (!fresh.available || fresh.total_cost_pence == null) throw new Error("The yard can't build this class right now.");
                  const m = mortgaged ? fresh.mortgage : null;
                  if (mortgaged && !m?.available) throw new Error("No ship mortgage is available on this build now (you may still owe on one): untick it to build without.");
                  const how = mode === "byom" ? "with your own materials" : "turnkey";
                  const loan = m
                    ? `\n\nWith a ship mortgage: ${m.lender_name} pay ${fmtCr(m.principal_pence)} and you pay ${fmtCr(Math.max(0, fresh.total_cost_pence - m.principal_pence))} from your ${regionName(region)} vault. ${m.installments} installments${m.installment_pence != null ? ` of ${fmtCr(m.installment_pence)}` : ""} every ${LOAN.installmentEveryDays} game days, ${fmtCr(m.total_repayable_pence)} in all, with recourse. Until it is repaid she can't be listed, sold or pledged; on a default she goes to them credited at ${LOAN.foreclosureCreditPct}% of her rebuild value, any surplus paid to you.`
                    : "";
                  if (!confirm(`Build the ${klass.name} "${name.trim()}" at ${portName(yard)} (${how}) for ${fmtCr(fresh.total_cost_pence)}?${loan}`)) return null;
                  return kibbPost<BuildShipResult>("/v1/shipyard/build-ship", {
                    port_id: yard,
                    name: name.trim(),
                    ship_class: klass.id,
                    build_mode: mode,
                    ...(m ? { mortgage: true } : {}),
                  });
                })
              }
            >
              {build.busy
                ? "Building…"
                : `Build ${klass.name}${quote.total_cost_pence != null ? ` for ${fmtCr(quote.total_cost_pence)}` : ""}${mortgaged && yourPart !== null ? ` (you pay ${fmtCr(yourPart)})` : ""}`}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

export default function FleetPage() {
  const { portName, goodName, shipClassName } = useCatalog();
  const { data: ships, error, reload } = usePoll(() => kibbGet<ShipResult[]>("/v1/fleet/ships", { limit: 200 }), 10_000);

  return (
    <div className="space-y-5 pb-8 sm:space-y-6">
      <PageHeader title="Fleet" subtitle="Ships, where they are and what they carry. Build more at a shipyard." />
      <ErrorNote error={error} />
      <Panel title={ships ? fleetCount(ships) : "Ships"}>
        {!ships ? (
          <Loading />
        ) : ships.length === 0 ? (
          <Empty>No ships.</Empty>
        ) : (
          <Table head={["Ship", "Class", "Status", "Where", "Hold used / free", "Cargo", "Stores", "Guns"]}>
            {ships.map((r) => {
              const s = r.ship;
              const dest = r.route_legs.at(-1)?.to_node;
              const cargo = Object.entries(r.cargo_manifest);
              return (
                <tr key={s.id}>
                  <td>
                    <Link href={`/fleet/${s.id}`} className="font-medium hover:underline">{s.name}</Link>
                    {s.convoy_id && <Badge variant="info" size="sm" className="ml-1.5">convoy</Badge>}
                  </td>
                  <td className="text-muted-foreground">{shipClassName(s.ship_class)}</td>
                  <td><ShipStatusBadge status={s.status} /></td>
                  <td>
                    {s.status === "sailing" ? (
                      <>
                        → {portName(dest)} <span className="text-muted-foreground text-xs">{fmtIn(r.voyage?.estimated_arrival_at ?? s.leg_arrives_at)}</span>
                      </>
                    ) : (
                      portName(s.current_port_id)
                    )}
                  </td>
                  <td className="whitespace-nowrap tabular-nums">
                    {fmtTons(r.cargo_used_tons)} / {fmtTons(Math.max(0, r.effective_hold_capacity_tons - r.cargo_used_tons))}
                  </td>
                  <td className="text-muted-foreground text-xs">
                    {cargo.length ? cargo.map(([g, t]) => `${t} t ${goodName(g)}`).join(", ") : "empty"}
                  </td>
                  <td className="whitespace-nowrap tabular-nums">
                    {fmtTons(r.stores.provisions_tons, 2)}{" "}
                    <span className="text-muted-foreground text-xs">{r.stores.sea_days_remaining.toFixed(1)} d</span>
                  </td>
                  <td className="tabular-nums">{s.cannons_count}</td>
                </tr>
              );
            })}
          </Table>
        )}
      </Panel>
      <Panel title="Shipyard">{ships ? <Shipyard ships={ships} onBuilt={() => void reload()} /> : <Loading />}</Panel>
    </div>
  );
}
