"use client";

// Per-ship action panels for the ship page: stores, guns, sale and break-up, passengers, warehouse, contracts, insurance, convoys.
// `blocked` disables writes while the autopilot sails the ship (reads still show).

import { useState } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Empty, ErrorNote, KV, Loading, NativeSelect, Panel, Table } from "@/components/kibb/bits";
import { ReturnFreightBadge, isReturnFreight } from "@/components/kibb/deals-common";
import { Field, PortSelect } from "@/components/kibb/pickers";
import {
  InsurableCap,
  LaneGuide,
  QuoteGuide,
  capFrom,
  createPolicy,
  createdText,
  laneKey,
  useInsuranceQuote,
  useLaneFloors,
  type InsurableValue,
} from "@/components/kibb/insurance-common";
import { WarnBox, regionName, useAppraisal, useCompanyNames, useRegionOf } from "@/components/kibb/finance-common";
import { num, useOurCompanyIds } from "@/components/kibb/naval-common";
import { AboardTable, OfferForm, OffersTable, PassengerRules, useAboard, useCancelOffer, useOffers } from "@/components/kibb/passengers-common";
import { fetchAll } from "@/components/kibb/trade-common";
import { useAction } from "@/hooks/use-action";
import { useCatalog } from "@/hooks/use-catalog";
import { usePoll } from "@/hooks/use-poll";
import { DashboardApiError, kibbGet, kibbPost } from "@/lib/kibb/browser";
import { fmtBps, fmtCr, fmtDateTime, fmtIn, fmtTons } from "@/lib/kibb/format";
import type * as S from "@/lib/kibb/schema";
import type {
  ContractListing,
  DeliverCharterResult,
  DeliverFreightResult,
  AcceptFreightResult,
  PlaceOrderResult,
  PortOrderBook,
  RoutePlan,
  ShipResult,
  StoresTransferResult,
  WorldClock,
} from "@/lib/kibb/types";

interface Props {
  r: ShipResult;
  blocked: boolean;
  onDone: () => void;
}

const int = (v: string, min = 0) => Math.max(min, Math.floor(Number(v) || 0));

function Result({ children }: { children: React.ReactNode }) {
  return <p className="text-sm">{children}</p>;
}

// ── Stores ────────────────────────────────────────────────────────────────────

export function StoresPanel({ r, blocked, onDone }: Props) {
  const { portName } = useCatalog();
  const { data: clock } = usePoll(() => kibbGet<WorldClock>("/v1/world/clock"));
  const s = r.ship;
  const port = s.current_port_id ?? "";
  const inPort = s.status === "berthed" || s.status === "anchored_roadstead";
  const cargoProvisions = r.cargo_manifest.provisions ?? 0;
  const wholeInStores = Math.floor(r.stores.provisions_tons + 1e-9);
  // Warehouse transfers happen at the berth; in the roadstead only cargo is reachable.
  const berthed = s.status === "berthed";

  const [tons, setTons] = useState(1);
  const [source, setSource] = useState<"cargo" | "warehouse">("cargo");
  const [outTons, setOutTons] = useState(1);
  const [dest, setDest] = useState<"cargo" | "warehouse">("cargo");
  const [routeTo, setRouteTo] = useState("");
  const move = useAction<StoresTransferResult>(onDone);
  const buy = useAction<PlaceOrderResult>(onDone);

  const { data: plan, error: planError } = usePoll(
    routeTo && port ? () => kibbGet<RoutePlan>("/v1/world/route", { from: port, to: routeTo, ship_class: s.ship_class }) : null,
    0,
    [routeTo, port],
  );
  const need = plan ? Math.max(0, Math.ceil(plan.safe_provisions_tons - r.stores.provisions_tons - 1e-9)) : 0;
  const { data: book } = usePoll(
    need > 0 && s.status === "berthed" ? () => kibbGet<PortOrderBook>("/v1/market/book", { port_id: port, commodity_id: "provisions" }) : null,
    0,
    [need, port, s.status],
  );
  const ask = book?.books.find((b) => b.commodity_id === "provisions")?.best_ask?.price_pence;

  return (
    <Panel title="Stores">
      <div className="space-y-4">
        <KV
          rows={[
            ["Provisions", fmtTons(r.stores.provisions_tons, 2)],
            ["Feeds the crew at sea for", `${r.stores.sea_days_remaining.toFixed(1)} game days`],
            ["Provisions as cargo", fmtTons(cargoProvisions)],
          ]}
        />
        {!inPort ? (
          <p className="text-muted-foreground text-xs">Stores can only be moved in port.</p>
        ) : (
          <>
            <div className="space-y-2 rounded-lg border p-3">
              <div className="font-medium text-xs">Top up for a route</div>
              <PortSelect value={routeTo} onChange={setRouteTo} placeholder="Sail to…" maxPhase={clock?.unlocked_phase} filter={(id) => id !== port} />
              <ErrorNote error={planError} />
              {plan && (
                <div className="space-y-2 text-sm">
                  <p>
                    Safe figure to {portName(routeTo)}: {fmtTons(plan.safe_provisions_tons, 2)} (bare need {fmtTons(plan.expected_provisions_tons, 2)}).{" "}
                    {need === 0 ? "Stores already cover it." : `Short by ${need} t.`}
                  </p>
                  {need > 0 && (
                    <div className="flex flex-wrap gap-2">
                      {cargoProvisions >= need && (
                        <Button size="sm" variant="outline" disabled={blocked || move.busy}
                          onClick={() => void move.run(() => kibbPost<StoresTransferResult>("/v1/fleet/provision", { ship_id: s.id, tons: need, source: "cargo" }))}>
                          Move {need} t from cargo
                        </Button>
                      )}
                      {s.status === "berthed" && ask && (
                        <Button size="sm" disabled={blocked || buy.busy}
                          onClick={() =>
                            void buy.run(() =>
                              kibbPost<PlaceOrderResult>("/v1/market/place-order", {
                                port_id: port,
                                commodity_id: "provisions",
                                side: "bid",
                                time_in_force: "ioc",
                                price_pence: Math.ceil(ask * 1.25),
                                quantity: need,
                                ship_id: s.id,
                                into_stores: true,
                              }),
                            )
                          }>
                          Buy {need} t into stores (from {fmtCr(ask, 2)}/t)
                        </Button>
                      )}
                      {s.status !== "berthed" && <span className="text-muted-foreground text-xs">Dock to buy provisions.</span>}
                    </div>
                  )}
                </div>
              )}
              {buy.result && (
                <Result>
                  Bought {buy.result.filled_quantity}/{buy.result.requested_quantity} t for {fmtCr(buy.result.total_gross_pence + buy.result.customs_duty_pence, 2)} incl. customs.
                </Result>
              )}
              <ErrorNote error={buy.error} />
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <Field label="Into stores (t)">
                  <Input type="number" min={1} value={tons} onChange={(e) => setTons(int(e.target.value, 1))} />
                </Field>
                <NativeSelect value={berthed ? source : "cargo"} disabled={!berthed} onChange={(e) => setSource(e.target.value as "cargo" | "warehouse")}>
                  <option value="cargo">from cargo</option>
                  {berthed && <option value="warehouse">from warehouse</option>}
                </NativeSelect>
                <Button size="sm" className="w-full" disabled={blocked || move.busy}
                  onClick={() =>
                    void move.run(() => kibbPost<StoresTransferResult>("/v1/fleet/provision", { ship_id: s.id, tons, source: berthed ? source : "cargo" }))
                  }>
                  Provision
                </Button>
              </div>
              <div className="space-y-2">
                <Field label={`Out of stores (max ${wholeInStores} t)`}>
                  <Input type="number" min={1} max={Math.max(1, wholeInStores)} value={Math.min(outTons, Math.max(1, wholeInStores))}
                    onChange={(e) => setOutTons(Math.min(int(e.target.value, 1), Math.max(1, wholeInStores)))} />
                </Field>
                <NativeSelect value={berthed ? dest : "cargo"} disabled={!berthed} onChange={(e) => setDest(e.target.value as "cargo" | "warehouse")}>
                  <option value="cargo">to cargo</option>
                  {berthed && <option value="warehouse">to warehouse</option>}
                </NativeSelect>
                <Button size="sm" variant="outline" className="w-full" disabled={blocked || move.busy || wholeInStores < 1}
                  onClick={() =>
                    void move.run(() =>
                      kibbPost<StoresTransferResult>("/v1/fleet/unprovision", {
                        ship_id: s.id,
                        tons: Math.min(outTons, wholeInStores),
                        destination: berthed ? dest : "cargo",
                      }),
                    )
                  }>
                  Unprovision
                </Button>
              </div>
            </div>
            {!berthed && <p className="text-muted-foreground text-xs">Dock to move stores to or from the warehouse.</p>}
            <ErrorNote error={move.error} />
            {move.result && <Result>Stores now {fmtTons(move.result.stores.provisions_tons, 2)}.</Result>}
          </>
        )}
        <p className="text-muted-foreground text-xs">
          Stores are whole tons of hold (0.3 t takes a ton). Crews eat at half the sea rate in port. A storm destroys a share of the
          stores (most take little, a heavy one much more) and pirates who let the ship go seize up to half; the safe figure covers the
          worst storm on one leg only, so stock above it on long or pirate water.
        </p>
      </div>
    </Panel>
  );
}

// ── Guns ──────────────────────────────────────────────────────────────────────

export function GunsPanel({ r, blocked, onDone, insured }: Props & { insured: boolean }) {
  const { catalog, portName } = useCatalog();
  const s = r.ship;
  const cls = catalog?.ship_classes.find((c) => c.id === s.ship_class);
  const yard = catalog?.ports.find((p) => p.id === s.current_port_id)?.has_shipyard ?? false;
  const max = cls?.max_cannons ?? 0;
  const [target, setTarget] = useState(s.cannons_count);
  const act = useAction<ShipResult>(onDone);
  const added = Math.max(0, target - s.cannons_count);
  const removing = target < s.cannons_count;
  const holdChange = (s.cannons_count - target) * 2;

  return (
    <Panel title="Guns">
      <div className="space-y-3">
        <KV rows={[["Mounted", `${s.cannons_count} / ${max}`], ["Hold taken by guns", fmtTons(s.cannons_count * 2)]]} />
        {s.status !== "berthed" || !yard ? (
          <p className="text-muted-foreground text-xs">Guns are refitted at a shipyard while berthed{s.current_port_id && !yard ? `; ${portName(s.current_port_id)} has none` : ""}.</p>
        ) : (
          <>
            <Field label="Target guns">
              <Input type="number" min={0} max={max} value={target} onChange={(e) => setTarget(Math.min(max, int(e.target.value)))} />
            </Field>
            <p className="text-muted-foreground text-xs">
              {added > 0 && `${added} new gun${added === 1 ? "" : "s"}: ${fmtCr(added * 15_000)}. `}
              {holdChange !== 0 && `${holdChange > 0 ? "Frees" : "Takes"} ${Math.abs(holdChange)} t of hold.`}
            </p>
            {removing && insured && <ErrorNote error="Guns can't be removed while the ship is insured." />}
            <ErrorNote error={act.error} />
            <Button size="sm" disabled={blocked || act.busy || target === s.cannons_count || (removing && insured)}
              onClick={() => void act.run(() => kibbPost<ShipResult>("/v1/shipyard/modify-ship", { ship_id: s.id, target_cannons_count: target }))}>
              {act.busy ? "Refitting…" : "Refit"}
            </Button>
          </>
        )}
        <p className="text-muted-foreground text-xs">Guns cut piracy sharply; each displaces 2 t of cargo.</p>
      </div>
    </Panel>
  );
}

// ── Sale, liens and dispatches ────────────────────────────────────────────────

/**
 * Whether the ship can change hands (guide 3.4), her lien and arrest state (3.13.1: a lien is a borrower loan's
 * `collateral_ship_id`; a defaulted one arrests her), her listing, and a packet's sealed dispatches (3.11).
 */
export function OwnershipPanel({
  r,
  insured,
  lien,
  liensKnown,
  blocked = false,
  onDone,
}: {
  r: ShipResult;
  insured: boolean;
  /** The borrower loan she is pledged to (active or defaulted), if any. */
  lien: S.Loan | undefined;
  liensKnown: boolean;
  /** The autopilot sails her: no break-up. */
  blocked?: boolean;
  onDone: () => void;
}) {
  const { catalog, portName } = useCatalog();
  const names = useCompanyNames();
  const s = r.ship;
  const cls = catalog?.ship_classes.find((c) => c.id === s.ship_class);
  const arrested = lien?.status === "defaulted";
  // Our listings, any status (no port: the game lists ours).
  const { data: listings, reload } = usePoll(() => fetchAll<S.ShipListingResult>("/v1/fleet/ship-listings", {}, 200, 5), 60_000);
  const listed = listings?.find((l) => l.ship_id === s.id && l.status === "open");
  // Resolves to null when the confirmation is declined.
  const seal = useAction<S.SealDispatchesResult | null>((x) => x && onDone());
  const inPort = s.status === "berthed" || s.status === "anchored_roadstead";
  const blockers = [
    !inPort ? "she must be lying at a port" : null,
    r.cargo_used_tons > 0 ? `her hold must be empty (${fmtTons(r.cargo_used_tons, 1)} aboard)` : null,
    s.convoy_id ? "she must leave her convoy" : null,
    insured ? "her open insurance policy must settle first" : null,
    lien ? "her loan must be repaid (lien)" : null,
  ].filter((x): x is string => !!x);

  function toggleSeal() {
    const sealed = !s.dispatches_sealed;
    void seal.run(async () => {
      const ask = sealed
        ? `Seal ${s.name}'s dispatches? Her crew keeps recording every quay she sees but posts nothing to the coffee-house boards she calls at, so the news stays yours to sell sealed in an envelope where she lies.`
        : `Release ${s.name}'s dispatches? ${inPort ? `Her crew's log is posted to ${portName(s.current_port_id)}'s coffee-house board at once` : "Her crew's log is posted at the next port she reaches"}, and she shares again from then on.`;
      if (!confirm(ask)) return null;
      return kibbPost<S.SealDispatchesResult>("/v1/fleet/seal-dispatches", { ship_id: s.id, sealed });
    });
  }

  return (
    <Panel title="Sale, liens and dispatches" action={<Link href="/ships-market" className="text-muted-foreground text-xs hover:text-foreground">Ship market →</Link>}>
      <div className="space-y-3">
        {arrested && lien && (
          <ErrorNote
            error={`Arrested: the loan pledging her defaulted ${lien.defaulted_at ? fmtDateTime(lien.defaulted_at) : ""}. She can't depart or join a convoy until the lender has her or you pay (${fmtCr(lien.owed_pence)} owed); any of your cargo left aboard is sold at half base price toward the debt.`}
          />
        )}
        <KV
          rows={[
            [
              "Lien",
              !liensKnown ? (
                "…"
              ) : lien ? (
                <span key="l">
                  {lien.is_mortgage ? "ship mortgage from" : "pledged to"} {names.label(lien.lender_company_id)}: {fmtCr(lien.owed_pence)} owed
                  {lien.matures_at && !arrested ? `, matures ${fmtIn(lien.matures_at)}` : ""} ·{" "}
                  <Link href="/loans" className="text-primary hover:underline">
                    Loans
                  </Link>
                </span>
              ) : (
                "none"
              ),
            ],
            ["Arrest", !liensKnown ? "…" : arrested ? <span key="a" className="text-destructive">arrested</span> : "no"],
            [
              "For sale",
              !listings ? "…" : listed ? `listed at ${fmtCr(listed.price_pence)} since ${fmtDateTime(listed.created_at)}` : "not listed",
            ],
            ["Free to sell", blockers.length ? `no: ${blockers.join("; ")}` : liensKnown ? "yes" : "…"],
          ]}
        />
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" render={<Link href={listed ? "/ships-market" : `/ships-market?list=${s.id}`} />}>
            {listed ? "Manage the listing" : "List for sale"}
          </Button>
          {listed && (
            <Button size="sm" variant="ghost" onClick={() => void reload()}>
              Refresh
            </Button>
          )}
        </div>
        {lien && !arrested && (
          <p className="text-muted-foreground text-xs">
            A liened ship can still sail before any default, but can&apos;t be listed, sold, pledged again, broken up or carry a venture until the loan is repaid
            {lien.is_mortgage ? " (a ship mortgage too)" : ""}. If she sinks the lien is lost and the loan stays owed.
          </p>
        )}
        <BreakUpSection r={r} insured={insured} lien={lien} liensKnown={liensKnown} listed={listings ? !!listed : undefined} blocked={blocked} onDone={onDone} />
        {cls?.can_seal_dispatches && (
          <div className="space-y-2 border-t pt-3">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="font-medium">Dispatches</span>
              <Badge variant={s.dispatches_sealed ? "warning" : "outline"} size="sm">
                {s.dispatches_sealed ? "sealed" : "shared"}
              </Badge>
            </div>
            <p className="text-muted-foreground text-xs">
              {s.dispatches_sealed
                ? "Her crew records every quay she sees and posts nothing: seal the news into an envelope where she lies (Envelopes page), or release it."
                : "A packet may seal her dispatches: her crew still records quays but posts nothing to the boards she calls at, so her news is yours alone to sell."}
            </p>
            <ErrorNote error={seal.error} />
            {seal.result && (
              <Result>
                Dispatches {seal.result.sealed ? "sealed" : "released"}
                {seal.result.released_at_port_id ? `, posted at ${portName(seal.result.released_at_port_id)}` : ""}.
              </Result>
            )}
            <Button size="sm" variant="outline" disabled={seal.busy} onClick={toggleSeal}>
              {s.dispatches_sealed ? "Release dispatches" : "Seal dispatches"}
            </Button>
          </div>
        )}
      </div>
    </Panel>
  );
}

/** Break-up pays 35% of the rebuild value (guide 3.4); a sale to another company pays at least 50%. */
const BREAK_UP_SHARE = 0.35;

/**
 * Selling her to the yard where she lies, the buyer of last resort (guide 3.4): 35% of her rebuild value, paid by that
 * region's Crown. She must lie at a port with an open shipyard and be free to change hands, with no passengers or
 * sailing offers, listing, outside 64ths or venture; a 409 while that Crown can't pay.
 */
function BreakUpSection({
  r,
  insured,
  lien,
  liensKnown,
  listed,
  blocked,
  onDone,
}: {
  r: ShipResult;
  insured: boolean;
  lien: S.Loan | undefined;
  liensKnown: boolean;
  /** An open sale listing of hers (undefined while unread). */
  listed: boolean | undefined;
  blocked: boolean;
  onDone: () => void;
}) {
  const { catalog, portName } = useCatalog();
  const regionOf = useRegionOf();
  const s = r.ship;
  const [open, setOpen] = useState(false);
  const inPort = s.status === "berthed" || s.status === "anchored_roadstead";
  const yard = !!catalog?.ports.find((p) => p.id === s.current_port_id)?.has_shipyard;
  const region = regionOf(s.current_port_id);
  const { data: offers } = useOffers(true, s.id, open);
  const { data: ventures } = usePoll(open ? () => kibbGet<S.Venture[]>("/v1/venture/list", {}) : null, 60_000, [open]);
  const { rebuild } = useAppraisal(open && !lien && !listed ? s.id : null);
  const venture = (ventures ?? []).find((v) => v.ship_id === s.id && ["raising", "sailing", "arrived"].includes(v.status));
  const openOffers = open ? (offers ?? []).filter((o) => o.ship_id === s.id && o.status === "open") : [];
  // Resolves to null when the confirmation is declined.
  const act = useAction<S.BreakUpShipResult | null>((x) => x && onDone());
  const blockers = [
    !inPort ? "she must lie at a port (berthed or in the roadstead)" : null,
    inPort && !yard ? `${portName(s.current_port_id)} has no shipyard` : null,
    r.cargo_used_tons > 0 ? `her hold must be empty (${fmtTons(r.cargo_used_tons, 1)} aboard, sealed freight and salvage included)` : null,
    s.convoy_id ? "she must leave her convoy (and any convoy request)" : null,
    insured ? "her open or bound insurance must settle first" : null,
    lien ? `${lien.is_mortgage ? "her ship mortgage" : "the loan pledging her"} must be repaid first` : null,
    s.passenger_hold_tons > 0 ? "she has passengers aboard" : null,
    openOffers.length ? `she has ${openOffers.length} open sailing offer${openOffers.length === 1 ? "" : "s"}: cancel ${openOffers.length === 1 ? "it" : "them"} first` : null,
    listed ? "she is listed for sale: cancel the listing first" : null,
    venture ? `she carries an open venture (${venture.status})` : null,
  ].filter((x): x is string => !!x);
  const ready = liensKnown && listed !== undefined && offers !== undefined && ventures !== undefined;
  const payout = rebuild !== undefined ? Math.floor(rebuild * BREAK_UP_SHARE) : undefined;

  function breakUp() {
    void act.run(async () => {
      if (
        !confirm(
          `Break up ${s.name} at ${portName(s.current_port_id)}? The yard pays ${payout !== undefined ? `about ${fmtCr(payout)} (35% of her rebuild value, ${fmtCr(rebuild)})` : "35% of her rebuild value"}, from the Crown of ${regionName(region)} into your vault there. The hull is destroyed with her guns, components and stores; berth dues up to now are yours. This cannot be undone.\n\nShe must lie at a port with an open shipyard and be free to change hands: empty hold (no cargo, sealed freight or salvage), no convoy or convoy request, no open or bound insurance, no loan lien or mortgage, no passengers aboard or open sailing offers, no sale listing, no 64ths held by other companies or listed, and no open venture.\n\nA sale to another company always pays more when a buyer exists: at least 50% of the same rebuild value, and she keeps sailing.`,
        ) ||
        !confirm(`Last check: break up ${s.name} for good?`)
      )
        return null;
      try {
        return await kibbPost<S.BreakUpShipResult>("/v1/shipyard/break-up", { ship_id: s.id });
      } catch (e) {
        if (e instanceof DashboardApiError && e.status === 409) {
          throw new Error(`The yard refused: ${e.detail}. If the Crown of ${regionName(region)} can't pay for a break-up now, try a yard in another region, or later.`);
        }
        throw e;
      }
    });
  }

  return (
    <div className="space-y-2 border-t pt-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium text-sm">Break up</span>
        {!open && !act.result && (
          <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
            Check…
          </Button>
        )}
      </div>
      <p className="text-muted-foreground text-xs">
        The yard where she lies buys her as a last resort: 35% of her rebuild value, paid by that region&apos;s Crown. A sale to another company pays at least 50% and
        she sails on, so list her first if a buyer may exist. Your hulls count in your net worth at build value, so breaking one up lowers it.
      </p>
      {act.result ? (
        <WarnBox tone="info">
          <p>
            {act.result.ship_name} was broken up at {portName(act.result.port_id)}: {fmtCr(act.result.payout_pence)} paid (35% of {fmtCr(act.result.rebuild_value_pence)})
            {act.result.berth_dues_pence > 0 ? `, ${fmtCr(act.result.berth_dues_pence)} of berth dues settled` : ""}
            {act.result.stores_lost_tons > 0 ? `, ${fmtTons(act.result.stores_lost_tons, 1)} of stores lost with her` : ""}.
          </p>
          <p>
            <Link href="/fleet" className="underline">
              Back to the fleet
            </Link>
          </p>
        </WarnBox>
      ) : (
        open && (
          <>
            <KV
              rows={[
                ["Rebuild value", rebuild !== undefined ? fmtCr(rebuild) : lien || listed ? "not appraised while liened or listed" : "…"],
                ["The yard pays", payout !== undefined ? `about ${fmtCr(payout)} into your ${regionName(region)} vault` : "35% of it"],
                ["Free to break up", !ready ? "…" : blockers.length ? `no: ${blockers.join("; ")}` : "yes, as far as can be seen (outside 64ths are checked by the game)"],
              ]}
            />
            {blocked && <p className="text-muted-foreground text-xs">The fleet autopilot sails her: stop it, or tick &quot;act anyway&quot; above, first.</p>}
            <ErrorNote error={act.error} />
            <Button size="sm" variant="destructive" disabled={act.busy || blocked || !ready || blockers.length > 0} onClick={breakUp}>
              {act.busy ? "Breaking up…" : `Break up ${s.name}`}
            </Button>
          </>
        )
      )}
    </div>
  );
}

// ── Passengers ────────────────────────────────────────────────────────────────

/** Her passengers aboard (guide 3.20), her open sailing offers, and an offer form while she lies in port. */
export function PassengersPanel({ r, blocked, onDone }: Props) {
  const { portName } = useCatalog();
  const s = r.ship;
  const inPort = s.status === "berthed" || s.status === "anchored_roadstead";
  // Read only what can be there: groups while she carries any, offers while she lies in port (sailing closes them).
  const carrying = s.passenger_hold_tons > 0;
  const aboard = useAboard(carrying ? s.id : null);
  const groups = carrying ? aboard.groups : [];
  const listed = useOffers(true, s.id, inPort);
  const offers = inPort ? listed.data : [];
  const [offering, setOffering] = useState(false);
  const done = () => {
    void aboard.reload();
    void listed.reload();
    onDone();
  };
  const cancel = useCancelOffer(done);
  const open = (offers ?? []).filter((o) => o.ship_id === s.id && o.status === "open");
  const heads = (groups ?? []).reduce((n, g) => n + g.size, 0);
  const due = (groups ?? []).reduce((n, g) => n + g.full_fare_pence, 0);
  return (
    <Panel title="Passengers" action={<Link href="/passengers" className="text-muted-foreground text-xs hover:text-foreground">Passengers →</Link>}>
      <div className="space-y-3">
        <KV
          rows={[
            ["Aboard", groups === undefined ? "…" : heads ? `${heads} head${heads === 1 ? "" : "s"} in ${groups.length} group${groups.length === 1 ? "" : "s"}, ${fmtTons(s.passenger_hold_tons)} of hold` : "none"],
            ["Fares due on arrival", groups === undefined ? "…" : heads ? `${fmtCr(due)} if on time` : "—"],
            ["Open sailing offers", offers === undefined ? "…" : open.length ? open.map((o) => `${portName(o.dest_port_id)} at ${fmtCr(o.fare_per_head_pence, 2)}`).join(", ") : "none"],
          ]}
        />
        <ErrorNote error={(carrying ? aboard.error : null) ?? cancel.error} />
        {groups && groups.length > 0 && <AboardTable groups={groups} />}
        {open.length > 0 && <OffersTable offers={open} shipName={() => s.name} busy={cancel.busy || blocked} onCancel={(o) => cancel.cancel(o, s.name)} />}
        {!inPort ? (
          <p className="text-muted-foreground text-xs">Passengers board only while she lies in port (berthed or in the roadstead). Sailing closes her offers.</p>
        ) : offering ? (
          <div className="space-y-3 rounded-lg border p-3">
            <OfferForm ship={r} blocked={blocked} autopilotShips={new Set()} openOffers={offers} onDone={done} />
            <Button size="sm" variant="ghost" onClick={() => setOffering(false)}>
              Close
            </Button>
          </div>
        ) : (
          <Button size="sm" variant="outline" disabled={blocked} onClick={() => setOffering(true)}>
            Offer passengers
          </Button>
        )}
        {offering && <PassengerRules />}
      </div>
    </Panel>
  );
}

// ── Warehouse ─────────────────────────────────────────────────────────────────

export function WarehousePanel({ r, blocked, onDone }: Props) {
  const { goodName, portName } = useCatalog();
  const s = r.ship;
  const port = s.current_port_id ?? "";
  const { data: wh, error, reload } = usePoll(
    port ? () => kibbGet<S.PortWarehouseResult>("/v1/warehouse/inventory", { port_id: port }) : null,
    20_000,
    [port],
  );
  const [loadGood, setLoadGood] = useState("");
  const [loadQty, setLoadQty] = useState(1);
  const [unloadGood, setUnloadGood] = useState("");
  const [unloadQty, setUnloadQty] = useState(1);
  const { data: carried } = usePoll(
    () => kibbGet<ContractListing[]>("/v1/contract/list", { contract_type: "freight", status: "active", limit: 200 }),
    60_000,
  );
  const act = useAction<S.ShipWarehouseTransferResult>(() => {
    onDone();
    void reload();
  });

  const stock = (wh?.inventory ?? []).filter((i) => i.quantity - i.locked_quantity > 0);
  // Sealed freight rides in the same manifest but can't be unloaded: offer only our own tons.
  const sealed = new Map<string, number>();
  for (const c of carried ?? []) {
    if (c.carrier_ship_id === s.id && c.commodity_id) sealed.set(c.commodity_id, (sealed.get(c.commodity_id) ?? 0) + c.quantity_required);
  }
  const aboard = Object.entries(r.cargo_manifest)
    .map(([g, t]) => [g, Math.max(0, t - (sealed.get(g) ?? 0))] as [string, number])
    .filter(([, t]) => t > 0);
  const free = Math.max(0, r.effective_hold_capacity_tons - r.cargo_used_tons);
  const lg = loadGood || stock[0]?.commodity_id || "";
  const ug = unloadGood || aboard[0]?.[0] || "";

  return (
    <Panel title={`Warehouse${port ? ` · ${portName(port)}` : ""}`}>
      {!port ? (
        <Empty>At sea.</Empty>
      ) : error ? (
        <p className="text-muted-foreground text-sm">
          No warehouse here. <Link href={`/ports/${port}`} className="text-primary hover:underline">Lease space</Link> on the port page.
        </p>
      ) : !wh ? (
        <Loading />
      ) : (
        <div className="space-y-3">
          <KV rows={[["Leased", fmtTons(wh.leased_tonnage)], ["Used / reserved / free", `${fmtTons(wh.used_tonnage)} / ${fmtTons(wh.reserved_tonnage)} / ${fmtTons(wh.free_tonnage)}`]]} />
          {wh.inventory.length > 0 && (
            <Table head={["Good", "Tons", "Locked"]}>
              {wh.inventory.map((i) => (
                <tr key={i.commodity_id}>
                  <td>{goodName(i.commodity_id)}</td>
                  <td className="tabular-nums">{i.quantity}</td>
                  <td className="text-muted-foreground tabular-nums">{i.locked_quantity || "—"}</td>
                </tr>
              ))}
            </Table>
          )}
          {s.status !== "berthed" ? (
            <p className="text-muted-foreground text-xs">Dock to load or unload.</p>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <Field label="Load onto ship">
                  <NativeSelect value={lg} onChange={(e) => setLoadGood(e.target.value)} disabled={stock.length === 0}>
                    {stock.length === 0 && <option value="">nothing stored</option>}
                    {stock.map((i) => (
                      <option key={i.commodity_id} value={i.commodity_id}>
                        {goodName(i.commodity_id)} ({i.quantity - i.locked_quantity} t)
                      </option>
                    ))}
                  </NativeSelect>
                </Field>
                <Input type="number" min={1} value={loadQty} onChange={(e) => setLoadQty(int(e.target.value, 1))} />
                <Button size="sm" className="w-full" disabled={blocked || act.busy || !lg || loadQty > free}
                  onClick={() => void act.run(() => kibbPost<S.ShipWarehouseTransferResult>("/v1/warehouse/load-ship", { ship_id: s.id, commodity_id: lg, quantity: loadQty }))}>
                  Load ({fmtTons(free)} free)
                </Button>
              </div>
              <div className="space-y-2">
                <Field label="Unload into warehouse">
                  <NativeSelect value={ug} onChange={(e) => setUnloadGood(e.target.value)} disabled={aboard.length === 0}>
                    {aboard.length === 0 && <option value="">hold empty</option>}
                    {aboard.map(([g, t]) => (
                      <option key={g} value={g}>
                        {goodName(g)} ({t} t)
                      </option>
                    ))}
                  </NativeSelect>
                </Field>
                <Input type="number" min={1} value={unloadQty} onChange={(e) => setUnloadQty(int(e.target.value, 1))} />
                <Button size="sm" variant="outline" className="w-full" disabled={blocked || act.busy || !ug || unloadQty > wh.free_tonnage}
                  onClick={() => void act.run(() => kibbPost<S.ShipWarehouseTransferResult>("/v1/warehouse/unload-ship", { ship_id: s.id, commodity_id: ug, quantity: unloadQty }))}>
                  Unload
                </Button>
              </div>
            </div>
          )}
          <ErrorNote error={act.error} />
          {act.result && <Result>Moved {act.result.items_transferred.map((i) => `${i.quantity} t ${goodName(i.commodity_id)}`).join(", ")}.</Result>}
          <p className="text-muted-foreground text-xs">Each ton loaded or unloaded at a berth adds to the turnaround lock. Sealed freight can&apos;t be unloaded.</p>
        </div>
      )}
    </Panel>
  );
}

// ── Contracts ─────────────────────────────────────────────────────────────────

export function ContractsPanel({ r, blocked, onDone }: Props) {
  const { goodName, portName } = useCatalog();
  const s = r.ship;
  const port = s.current_port_id ?? "";
  const inPort = s.status === "berthed" || s.status === "anchored_roadstead";
  const { data: here, reload: reloadHere } = usePoll(
    port ? () => kibbGet<ContractListing[]>("/v1/contract/list", { port_id: port, status: "open", limit: 200 }) : null,
    30_000,
    [port],
  );
  const { data: active, reload: reloadActive } = usePoll(
    () => kibbGet<ContractListing[]>("/v1/contract/list", { contract_type: "freight", status: "active", limit: 200 }),
    30_000,
  );
  const [qty, setQty] = useState<Record<string, number>>({});
  const done = () => {
    onDone();
    void reloadHere();
    void reloadActive();
  };
  const charter = useAction<DeliverCharterResult>(done);
  const accept = useAction<AcceptFreightResult>(done);
  const deliver = useAction<DeliverFreightResult>(done);
  // A charter or freight lot any of our player's companies issued can't be delivered to or carried by ours.
  const ourIds = useOurCompanyIds();
  const ours = (c: ContractListing) => !!c.issuer_company_id && (ourIds.has(c.issuer_company_id) || c.issuer_company_id === s.company_id);

  const sealed = (active ?? []).filter((c) => c.carrier_ship_id === s.id);
  const sealedTons = new Map<string, number>();
  for (const c of sealed) if (c.commodity_id) sealedTons.set(c.commodity_id, (sealedTons.get(c.commodity_id) ?? 0) + c.quantity_required);
  const charters = (here ?? []).filter((c) => c.contract_type === "charter" && c.origin_port_id === port && !c.stale);
  const freight = (here ?? []).filter((c) => c.contract_type === "freight" && c.origin_port_id === port && !c.carrier_ship_id && !ours(c));
  const free = Math.max(0, r.effective_hold_capacity_tons - r.cargo_used_tons);

  return (
    <Panel title="Contracts">
      <div className="space-y-5">
        <div className="space-y-2">
          <div className="font-medium text-xs">Sealed freight aboard</div>
          {sealed.length === 0 ? (
            <Empty>None.</Empty>
          ) : (
            <Table head={["Good", "Tons", "To", "Reward", "Deadline", ""]}>
              {sealed.map((c) => {
                const there = inPort && port === c.dest_port_id;
                return (
                  <tr key={c.id}>
                    <td>
                      {goodName(c.commodity_id)}
                      {isReturnFreight(c) && (
                        <div className="mt-0.5">
                          <ReturnFreightBadge />
                        </div>
                      )}
                    </td>
                    <td className="tabular-nums">{c.quantity_required}</td>
                    <td>{portName(c.dest_port_id)}</td>
                    <td className="tabular-nums">{fmtCr(c.reward_pence)}</td>
                    <td className="text-xs">{fmtIn(c.expires_at)}</td>
                    <td className="text-right">
                      <Button size="sm" disabled={!there || blocked || deliver.busy}
                        onClick={() => void deliver.run(() => kibbPost<DeliverFreightResult>("/v1/contract/deliver-freight", { contract_id: c.id, ship_id: s.id }))}>
                        Deliver
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </Table>
          )}
          <ErrorNote error={deliver.error} />
          {deliver.result && (
            <Result>
              Delivered: {fmtCr(deliver.result.reward_paid_pence)} reward, {fmtCr(deliver.result.collateral_returned_pence)} collateral back.
            </Result>
          )}
        </div>

        {!inPort ? (
          <p className="text-muted-foreground text-xs">Charters and freight at a port show once the ship is there.</p>
        ) : (
          <>
            <div className="space-y-2">
              <div className="font-medium text-xs">Charters at {portName(port)}</div>
              {!here ? (
                <Loading />
              ) : charters.length === 0 ? (
                <Empty>No open charters here.</Empty>
              ) : (
                <Table head={["Good", "Remaining", "Pay/t", "Aboard", "Expires", "Deliver"]}>
                  {charters.map((c) => {
                    const held = Math.max(0, (r.cargo_manifest[c.commodity_id ?? ""] ?? 0) - (sealedTons.get(c.commodity_id ?? "") ?? 0));
                    // Our own player's charter: the game refuses our deliveries to it.
                    const max = ours(c) ? 0 : Math.min(held, c.remaining_quantity);
                    const q = Math.min(qty[c.id] ?? max, max);
                    return (
                      <tr key={c.id}>
                        <td>
                          {goodName(c.commodity_id)}
                          {c.title && <div className="text-muted-foreground text-xs">{c.title}</div>}
                          {ours(c) && <div className="text-muted-foreground text-xs">posted by one of your companies: not yours to deliver</div>}
                          {!ours(c) && c.funded_by === "issuer" && <div className="text-muted-foreground text-xs">a player&apos;s charter: no prestige</div>}
                        </td>
                        <td className="tabular-nums">{fmtTons(c.remaining_quantity)}</td>
                        <td className="tabular-nums">{fmtCr(c.reward_per_ton_pence ?? Math.floor(c.reward_pence / Math.max(1, c.quantity_required)), 2)}</td>
                        <td className="tabular-nums">{fmtTons(held)}</td>
                        <td className="text-xs">{fmtIn(c.expires_at)}</td>
                        <td>
                          <div className="flex items-center justify-end gap-1">
                            <Input type="number" min={1} max={max} value={q} className="w-20" disabled={max < 1}
                              onChange={(e) => setQty({ ...qty, [c.id]: int(e.target.value, 1) })} />
                            <Button size="sm" disabled={max < 1 || q < 1 || blocked || charter.busy}
                              onClick={() => void charter.run(() => kibbPost<DeliverCharterResult>("/v1/contract/deliver-charter", { contract_id: c.id, quantity: q, ship_id: s.id }))}>
                              Deliver
                            </Button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </Table>
              )}
              <ErrorNote error={charter.error} />
              {charter.result && (
                <Result>
                  Delivered {charter.result.delivered_quantity} t for {fmtCr(charter.result.reward_paid_pence)} (+{charter.result.prestige_awarded} prestige).
                </Result>
              )}
              <p className="text-muted-foreground text-xs">Only cargo carried in from another port counts; goods bought here since arriving don&apos;t.</p>
            </div>

            <div className="space-y-2">
              <div className="font-medium text-xs">Freight offered at {portName(port)}</div>
              {!here ? (
                <Loading />
              ) : freight.length === 0 ? (
                <Empty>No open freight here.</Empty>
              ) : (
                <Table head={["Good", "Tons", "To", "Reward", "Collateral", "Expires", ""]}>
                  {freight.map((c) => (
                    <tr key={c.id}>
                      <td>
                        {goodName(c.commodity_id)}
                        {isReturnFreight(c) && (
                          <div className="mt-0.5">
                            <ReturnFreightBadge />
                          </div>
                        )}
                      </td>
                      <td className="tabular-nums">{c.quantity_required}</td>
                      <td>{portName(c.dest_port_id)}</td>
                      <td className="tabular-nums">{fmtCr(c.reward_pence)}</td>
                      <td className="tabular-nums">{fmtCr(c.collateral_pence)}</td>
                      <td className="text-xs">{fmtIn(c.expires_at)}</td>
                      <td className="text-right">
                        <Button size="sm" variant="outline"
                          disabled={s.status !== "berthed" || c.quantity_required > free || blocked || accept.busy}
                          onClick={() => void accept.run(() => kibbPost<AcceptFreightResult>("/v1/contract/accept-freight", { contract_id: c.id, ship_id: s.id }))}>
                          Accept
                        </Button>
                      </td>
                    </tr>
                  ))}
                </Table>
              )}
              <ErrorNote error={accept.error} />
              {accept.result && (
                <Result>
                  Loaded {accept.result.quantity} t sealed for {portName(accept.result.dest_port_id)}, due {fmtDateTime(accept.result.delivery_deadline)}.
                </Result>
              )}
              <p className="text-muted-foreground text-xs">
                Accepting needs the ship berthed with room ({fmtTons(free)} free). The cargo is sealed and the collateral escrowed until delivery.
                {freight.some(isReturnFreight) && " Return freight (Crown) is a sealed token worth nothing, carried for its fixed pay: only a few such lots at a time."}
              </p>
            </div>
          </>
        )}
      </div>
    </Panel>
  );
}

// ── Insurance ─────────────────────────────────────────────────────────────────

export function InsurancePanel({ r, blocked, onDone, policies, reload }: Props & { policies: S.InsurancePolicy[] | undefined; reload: () => void }) {
  const { portName } = useCatalog();
  const { data: clock } = usePoll(() => kibbGet<WorldClock>("/v1/world/clock"));
  const s = r.ship;
  const port = s.current_port_id ?? "";
  const inPort = s.status === "berthed" || s.status === "anchored_roadstead";
  const current = (policies ?? []).filter((p) => p.status === "open" || p.status === "active");
  const [dest, setDest] = useState("");
  const [valueCr, setValueCr] = useState("");
  const [premium, setPremium] = useState("");
  const [cap, setCap] = useState<InsurableValue | null>(null);
  const value = Math.round(num(valueCr) * 100);
  const valueOk = Number.isFinite(value) && value > 0;
  const bps = num(premium);
  const bpsOk = Number.isInteger(bps) && bps >= 10 && bps <= 3000;
  const floors = useLaneFloors(port && dest ? [[port, dest]] : []).get(laneKey(port, dest));
  // Quoted first: Lloyd's price for this voyage (only while she is in port and uninsured).
  const { data: quote, error: quoteError } = useInsuranceQuote(inPort && current.length === 0 && dest && dest !== port ? s.id : "", dest, value);
  const quoted = quote && quote.ship_id === s.id && quote.dest_port_id === dest && quote.insured_value_pence === value ? quote : undefined;
  // Cover type: from the quote or a cap once seen; an empty hold can only be hull-only; otherwise unknown.
  const hull = quoted?.hull_value_pence ?? cap?.hull_value_pence;
  const hullOnly = hull !== undefined && valueOk ? value <= hull : r.cargo_used_tons <= 0 ? true : null;
  const act = useAction<S.CreateInsurancePolicyResult>(() => {
    onDone();
    reload();
  });

  async function submit() {
    const res = await act.run(async () => {
      try {
        return await createPolicy({ ship_id: s.id, dest_port_id: dest, insured_value_pence: value, premium_bps: bps });
      } catch (e) {
        const c = capFrom(e);
        if (c) setCap(c);
        throw e;
      }
    });
    if (res) setCap(null);
  }

  return (
    <Panel title="Insurance" action={<Link href="/insurance" className="text-muted-foreground text-xs hover:text-foreground">Insurance →</Link>}>
      <div className="space-y-3">
        {!policies ? (
          <Loading />
        ) : current.length === 0 ? (
          <Empty>Not insured.</Empty>
        ) : (
          current.map((p) => (
            <KV
              key={p.id}
              rows={[
                ["Status", <Badge key="s" variant={p.status === "active" ? "success" : "warning"} size="sm">{p.status}</Badge>],
                ["Voyage", `${portName(p.origin_port_id)} → ${portName(p.dest_port_id)}`],
                ["Sum insured", `${fmtCr(p.insured_value_pence)} (hull ${fmtCr(p.hull_value_pence)})`],
                ["Covered", fmtBps(p.covered_bps)],
                ["Premium", `${fmtBps(p.premium_bps)} · ${fmtCr(p.total_premium_pence)}`],
                ["Lapses", fmtIn(p.expires_at)],
              ]}
            />
          ))
        )}
        {inPort && current.length === 0 && (
          <div className="space-y-2 rounded-lg border p-3">
            <div className="font-medium text-xs">Insure the next voyage</div>
            <PortSelect value={dest} onChange={setDest} placeholder="Bound for…" maxPhase={clock?.unlocked_phase} filter={(id) => id !== port} />
            <div className="grid gap-2 sm:grid-cols-2">
              <Field label="Sum insured (Cr): hull plus all the cargo aboard">
                <Input type="number" min={0.01} step={0.01} value={valueCr} onChange={(e) => setValueCr(e.target.value)} />
              </Field>
              <Field label="Premium (bps)">
                <Input type="number" min={10} max={3000} step={1} placeholder="10–3,000" value={premium} onChange={(e) => setPremium(e.target.value)} />
              </Field>
            </div>
            {premium !== "" && !bpsOk && <ErrorNote error="The premium must be a whole number of bps from 10 to 3,000." />}
            <p className="text-muted-foreground text-xs">
              Load everything first and declare it all: cargo loaded after the policy is written voids it when the ship sails. A capture by pirates pays out as a total loss.
            </p>
            {dest && <QuoteGuide quote={quoted} error={quoteError} valueCr={valueCr} premiumBps={bps} onValue={setValueCr} onPremium={setPremium} />}
            {dest && <LaneGuide floors={floors} hullOnly={hullOnly} premiumBps={bps} />}
            {cap && <InsurableCap cap={cap} valueCr={valueCr} onUseMax={setValueCr} />}
            <p className="text-muted-foreground text-xs">
              Premium {bpsOk && valueOk ? fmtCr(Math.ceil((value * bps) / 10_000)) : "—"} escrowed. Cap: hull rebuild quote + 150 Cr a gun + cargo aboard (ask for
              more and the cap shows here). Sailing anywhere but the named port voids it; Lloyd&apos;s looks after about a game hour.
            </p>
            <ErrorNote error={act.error} />
            <Button size="sm" disabled={blocked || act.busy || !dest || !valueOk || !bpsOk} onClick={() => void submit()}>
              Request cover
            </Button>
          </div>
        )}
        {act.result && <p className="text-sm">Policy open on the voyage to {portName(act.result.dest_port_id)}. {createdText(act.result)}</p>}
      </div>
    </Panel>
  );
}

// ── Convoys ───────────────────────────────────────────────────────────────────

export function ConvoysPanel({ r, blocked, onDone, policies }: Props & { policies?: S.InsurancePolicy[] }) {
  const { portName } = useCatalog();
  const s = r.ship;
  const port = s.current_port_id ?? "";
  // Lloyd's may have priced a policy with the consorts: sailing without them can void it (guide 3.4).
  const insured = (policies ?? []).find((p) => p.status === "open" || p.status === "active");
  const { data: forming, reload } = usePoll(
    port && s.status !== "sailing" ? () => kibbGet<S.ConvoyResult[]>("/v1/fleet/convoys", { port_id: port, status: "forming", limit: 50 }) : null,
    30_000,
    [port, s.status],
  );
  const { data: mine } = usePoll(
    s.convoy_id ? () => kibbGet<S.ConvoyResult[]>("/v1/fleet/convoys", { convoy_id: s.convoy_id! }) : null,
    30_000,
    [s.convoy_id],
  );
  const [escort, setEscort] = useState(false);
  const act = useAction<S.ConvoyMembershipResult>(() => {
    onDone();
    void reload();
  });
  const joined = mine?.[0];

  return (
    <Panel title="Convoys" action={<Link href="/convoys" className="text-muted-foreground text-xs hover:text-foreground">Convoys →</Link>}>
      <div className="space-y-3">
        {s.convoy_id ? (
          <>
            <KV
              rows={[
                ["Convoy", joined?.convoy.name ?? "…"],
                ["Bound for", portName(joined?.convoy.dest_port_id)],
                ["Status", joined?.convoy.status ?? "…"],
                ["Departs", fmtIn(joined?.convoy.departs_at)],
              ]}
            />
            {joined?.convoy.status === "forming" && (
              <Button size="sm" variant="outline" disabled={blocked || act.busy}
                onClick={() => {
                  if (
                    insured &&
                    !confirm(
                      `${s.name} holds an ${insured.status} policy to ${portName(insured.dest_port_id)}. If Lloyd's priced it with this convoy's consorts, sailing without them voids it. Leave the convoy anyway?`,
                    )
                  )
                    return;
                  void act.run(() => kibbPost<S.ConvoyMembershipResult>("/v1/fleet/detach-convoy", { convoy_id: s.convoy_id, ship_id: s.id }));
                }}>
                Leave convoy
              </Button>
            )}
          </>
        ) : s.status === "sailing" ? (
          <Empty>At sea.</Empty>
        ) : !forming ? (
          <Loading />
        ) : forming.length === 0 ? (
          <Empty>No convoys forming at {portName(port)}.</Empty>
        ) : (
          <>
            <Table head={["Convoy", "To", "Departs", "Ships", "Escort fee", ""]}>
              {forming.map((c) => (
                <tr key={c.convoy.id}>
                  <td>
                    {c.convoy.name} <span className="text-muted-foreground text-xs">{c.convoy.admission.replace("_", " ")}</span>
                  </td>
                  <td>{portName(c.convoy.dest_port_id)}</td>
                  <td className="text-xs">{fmtIn(c.convoy.departs_at)}</td>
                  <td className="tabular-nums">{c.members.length}</td>
                  <td className="whitespace-nowrap tabular-nums">
                    {c.convoy.escort_fee_pence_per_ton > 0 ? (
                      <>
                        {fmtCr(c.convoy.escort_fee_pence_per_ton, 2)}/t
                        {!escort && (
                          <div className="text-muted-foreground text-xs">{fmtCr(c.convoy.escort_fee_pence_per_ton * r.hold_capacity_tons)} escrowed</div>
                        )}
                      </>
                    ) : (
                      "none"
                    )}
                  </td>
                  <td className="text-right">
                    <Button size="sm" variant="outline" disabled={s.status !== "anchored_roadstead" || blocked || act.busy}
                      onClick={() => void act.run(() => kibbPost<S.ConvoyMembershipResult>("/v1/fleet/join-convoy", { convoy_id: c.convoy.id, ship_id: s.id, as_escort: escort }))}>
                      Join
                    </Button>
                  </td>
                </tr>
              ))}
            </Table>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={escort} disabled={s.cannons_count === 0} onChange={(e) => setEscort(e.target.checked)} />
              Join as escort (pays no fee, shares the fees by guns)
            </label>
            <p className="text-muted-foreground text-xs">
              Other companies&apos; ships pay the fee per ton of hold ({fmtTons(r.hold_capacity_tons)}), refunded if they don&apos;t sail or are lost.
            </p>
            {s.status !== "anchored_roadstead" && <p className="text-muted-foreground text-xs">Move to the roadstead to join.</p>}
          </>
        )}
        <ErrorNote error={act.error} />
        {act.result && <Result>Convoy membership: {act.result.status}{act.result.escort_fee_pence ? `, fee ${fmtCr(act.result.escort_fee_pence)} escrowed` : ""}.</Result>}
        <p className="text-muted-foreground text-xs">A convoy sails at its slowest ship&apos;s speed; members pool guns against pirates and can rescue each other.</p>
      </div>
    </Panel>
  );
}
