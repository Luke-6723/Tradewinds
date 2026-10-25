"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { RefreshCwIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Empty, ErrorNote, KV, Loading, NativeSelect, PageHeader, Panel, ShipStatusBadge, Table } from "@/components/kibb/bits";
import { Field } from "@/components/kibb/pickers";
import { useAction } from "@/hooks/use-action";
import { useCatalog } from "@/hooks/use-catalog";
import { usePoll } from "@/hooks/use-poll";
import { dash, kibbGet, kibbPost } from "@/lib/kibb/browser";
import { fmtCr, fmtIn, fmtTons } from "@/lib/kibb/format";
import type * as S from "@/lib/kibb/schema";
import type { BuildMode, BuildShipResult, CatalogShipClass, ShipResult, WorldClock } from "@/lib/kibb/types";

/** Daily sprawl upkeep in pence for coastal and regional hull tonnage (the first 40 t are free). */
function sprawlPerDay(tons: number): number {
  return tons <= 40 ? 0 : Math.round(4500 * ((tons - 40) / 100) ** 1.45);
}

/** Extra upkeep per game day the new hull adds to the fleet's bill, in pence. */
function upkeepDelta(ships: ShipResult[], classes: CatalogShipClass[], cls: CatalogShipClass): number {
  if (cls.hull_category === "oceanic") return cls.hold_capacity_tons * 100;
  const tons = ships
    .filter((r) => r.ship.status !== "sunk" && classes.find((c) => c.id === r.ship.ship_class)?.hull_category !== "oceanic")
    .reduce((n, r) => n + r.hold_capacity_tons, 0);
  return sprawlPerDay(tons + cls.hold_capacity_tons) - sprawlPerDay(tons);
}

function Shipyard({ ships, onBuilt }: { ships: ShipResult[]; onBuilt: () => void }) {
  const { catalog, portName, goodName } = useCatalog();
  const { data: clock } = usePoll(() => kibbGet<WorldClock>("/v1/world/clock"));
  const { data: factors } = usePoll(() => kibbGet<string[]>("/v1/company/factors"), 60_000);
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

  return (
    <div className="grid items-start gap-6 lg:grid-cols-2">
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Yard" className="sm:col-span-2">
            <NativeSelect value={yard} onChange={(e) => setPort(e.target.value)}>
              {yards.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
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
          New ships launch berthed with no guns (150 Cr each at a yard, 2 t of hold per gun) and no stores. Hulls beyond the first 40 t
          of coastal and regional tonnage cost 45 Cr × ((t − 40)/100)^1.45 a game day between them; oceanic hulls 1 Cr per ton a day.
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
            <KV
              rows={[
                ["Labour", fmtCr(quote.labour_pence)],
                ...(mode === "byom"
                  ? ([] as Array<[string, string]>)
                  : ([
                      ["Materials (players' asks and the NPC ladder)", fmtCr(quote.materials_pence)],
                      ["Customs on every fill", fmtCr(quote.customs_pence)],
                      [
                        `Yard markup ${(quote.yard_markup_bps / 100).toFixed(1)}% on the NPC part (${fmtCr(quote.npc_materials_pence)})`,
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
            <ErrorNote error={build.error} />
            {build.result && (
              <p className="text-sm">
                Built <Link href={`/fleet/${build.result.ship_id}`} className="font-medium hover:underline">{build.result.name}</Link> for{" "}
                {fmtCr(build.result.total_cost_pence)}.
              </p>
            )}
            <Button
              disabled={build.busy || !quote.available || quote.total_cost_pence == null || !name.trim()}
              onClick={() =>
                void build.run(async () => {
                  // Re-quote first: the charge is whatever the yard asks at the moment of building.
                  const fresh = await getQuote();
                  if (!fresh.available || fresh.total_cost_pence == null) throw new Error("The yard can't build this class right now.");
                  const how = mode === "byom" ? "with your own materials" : "turnkey";
                  if (!confirm(`Build the ${klass.name} "${name.trim()}" at ${portName(yard)} (${how}) for ${fmtCr(fresh.total_cost_pence)}?`)) return null;
                  return kibbPost<BuildShipResult>("/v1/shipyard/build-ship", { port_id: yard, name: name.trim(), ship_class: klass.id, build_mode: mode });
                })
              }
            >
              {build.busy ? "Building…" : `Build ${klass.name}${quote.total_cost_pence != null ? ` for ${fmtCr(quote.total_cost_pence)}` : ""}`}
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
      <Panel title={ships ? `${ships.length} ship${ships.length === 1 ? "" : "s"}` : "Ships"}>
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
