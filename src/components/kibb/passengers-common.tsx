"use client";

// Passengers (guide 3.20): pieces shared by the passengers page and the ship page. Groups wait at ports for a passage; we
// offer a ship lying there (fare per head, berths), and every game hour each group takes the best value among the open
// offers for its destination (cheaper wins, and so does faster). Groups never split. The fare is paid on arrival, cut for
// each game day past the promised arrival.

import { useState } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Empty, ErrorNote, KV, Table } from "@/components/kibb/bits";
import { atPort } from "@/components/kibb/deals-common";
import { WarnBox, crToPence, firstProblem, num, regionName, useRegionOf } from "@/components/kibb/finance-common";
import { Checkbox } from "@/components/kibb/naval-common";
import { Field, PortSelect, ShipSelect } from "@/components/kibb/pickers";
import { useAction } from "@/hooks/use-action";
import { useCatalog } from "@/hooks/use-catalog";
import { usePoll } from "@/hooks/use-poll";
import { kibbGet, kibbPost } from "@/lib/kibb/browser";
import { fmtCr, fmtDateTime, fmtIn, fmtTons } from "@/lib/kibb/format";
import type * as S from "@/lib/kibb/schema";
import type { ShipResult, WorldClock } from "@/lib/kibb/types";

/** `max_berths` is 1..=10,000 heads in all. */
export const MAX_BERTHS = 10_000;

/** Why an offer closed (`close_reason`), in words. */
export const CLOSE_REASON: Record<string, string> = {
  cancelled: "cancelled",
  departed: "the ship sailed",
  ship_moved: "the ship moved",
  ship_changed_hands: "the ship changed hands",
  ship_lost: "the ship was lost",
};

/** The median of a list, or null for none. */
export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Passengers a ton of her hold carries: one in a merchant hull, two in a packet (catalog `passengers_per_ton`). */
export function usePerTon() {
  const { catalog } = useCatalog();
  return (shipClass: string | null | undefined) => catalog?.ship_classes.find((c) => c.id === shipClass)?.passengers_per_ton ?? 1;
}

/** Whole passengers her free hold takes now (free hold: after guns, stores, cargo and the passengers already aboard). */
export const berthsFree = (r: ShipResult, perTon: number) => Math.max(0, Math.floor(Math.max(0, r.effective_hold_capacity_tons - r.cargo_used_tons) * perTon + 1e-9));

/** The groups aboard one of our ships, refreshed every 30 s. */
export function useAboard(shipId: string | null | undefined) {
  const { data, error, reload } = usePoll(
    shipId ? () => kibbGet<S.AboardGroupView[]>("/v1/passengers/aboard", { ship_id: shipId }).then((groups) => ({ shipId, groups })) : null,
    30_000,
    [shipId],
  );
  return { groups: data && data.shipId === shipId ? data.groups : undefined, error: shipId ? error : null, reload };
}

/** Our offers, newest first: open only, or every one with why it closed (`shipId` narrows to one ship; `enabled` false waits). */
export function useOffers(openOnly: boolean, shipId?: string, enabled = true) {
  return usePoll(
    enabled ? () => kibbGet<S.PassengerOfferView[]>("/v1/passengers/offers", { open_only: openOnly, ship_id: shipId, limit: 200 }) : null,
    30_000,
    [openOnly, shipId, enabled],
  );
}

/** The groups aboard one ship: heads, route, the fare agreed and the promise it is paid in full by. */
export function AboardTable({ groups }: { groups: S.AboardGroupView[] }) {
  const { portName } = useCatalog();
  if (!groups.length) return <Empty>No passengers aboard.</Empty>;
  return (
    <Table head={["Group", "Route", "Fare / head", "Whole fare", "Hold", "Promised by"]}>
      {groups.map((g) => {
        const late = !!g.promised_arrival_at && Date.parse(g.promised_arrival_at) < Date.now();
        return (
          <tr key={g.id}>
            <td className="whitespace-nowrap">
              {g.size} {g.kind}
            </td>
            <td className="whitespace-nowrap text-xs">
              {portName(g.origin_port_id)} → {portName(g.dest_port_id)}
            </td>
            <td className="tabular-nums">{fmtCr(g.fare_per_head_pence, 2)}</td>
            <td className="tabular-nums">{fmtCr(g.full_fare_pence)}</td>
            <td className="tabular-nums">{fmtTons(g.hold_tons)}</td>
            <td className={`whitespace-nowrap text-xs ${late ? "text-destructive" : ""}`}>
              {g.promised_arrival_at ? (late ? `late since ${fmtDateTime(g.promised_arrival_at)}` : fmtIn(g.promised_arrival_at)) : "—"}
            </td>
          </tr>
        );
      })}
    </Table>
  );
}

/** Our offers with their berths taken and, once closed, why. `onCancel` adds a Cancel button to open ones. */
export function OffersTable({
  offers,
  shipName,
  onCancel,
  busy,
}: {
  offers: S.PassengerOfferView[];
  shipName: (id: string) => string;
  onCancel?: (o: S.PassengerOfferView) => void;
  busy?: boolean;
}) {
  const { portName } = useCatalog();
  return (
    <Table head={["Ship", "Route", "Fare / head", "Berths taken", "Status", "Posted", ""]}>
      {offers.map((o) => (
        <tr key={o.id}>
          <td>
            <Link href={`/fleet/${o.ship_id}`} className="font-medium hover:underline">
              {shipName(o.ship_id)}
            </Link>
          </td>
          <td className="whitespace-nowrap text-xs">
            {portName(o.port_id)} → {portName(o.dest_port_id)}
          </td>
          <td className="tabular-nums">{fmtCr(o.fare_per_head_pence, 2)}</td>
          <td className="tabular-nums">
            {o.berths_taken} / {o.max_berths}
          </td>
          <td>
            <Badge variant={o.status === "open" ? "info" : "outline"} size="sm">
              {o.status}
            </Badge>
            {o.close_reason && <div className="text-muted-foreground text-xs">{CLOSE_REASON[o.close_reason] ?? o.close_reason.replace(/_/g, " ")}</div>}
          </td>
          <td className="whitespace-nowrap text-muted-foreground text-xs">
            {fmtDateTime(o.created_at)}
            {o.closed_at && <div>closed {fmtDateTime(o.closed_at)}</div>}
          </td>
          <td className="text-right">
            {onCancel && o.status === "open" && (
              <Button size="sm" variant="outline" disabled={busy} onClick={() => onCancel(o)}>
                Cancel
              </Button>
            )}
          </td>
        </tr>
      ))}
    </Table>
  );
}

/** Cancels one of our open offers after a confirm (heads already aboard stay aboard). Resolves to null when declined. */
export function useCancelOffer(onDone: () => void) {
  const { portName } = useCatalog();
  const act = useAction<S.PassengerOfferView | null>((r) => r && onDone());
  const cancel = (o: S.PassengerOfferView, shipName: string) =>
    void act.run(async () => {
      if (
        !confirm(
          `Cancel ${shipName}'s offer to ${portName(o.dest_port_id)} at ${fmtCr(o.fare_per_head_pence, 2)} a head (${o.berths_taken} of ${o.max_berths} berths taken)? Groups already aboard stay aboard; no more board on it.`,
        )
      )
        return null;
      return kibbPost<S.PassengerOfferView>("/v1/passengers/cancel-offer", { offer_id: o.id });
    });
  return { ...act, cancel };
}

/** What the rules say a group does, in a few lines (guide 3.20). */
export function PassengerRules() {
  return (
    <div className="space-y-1.5 text-muted-foreground text-xs">
      <p>
        Every game hour each waiting group looks at the open offers at its port for its destination. It ignores any above what it will pay (never shown), any
        without berths left for all of it, and any ship without free hold for all of it: groups never split. Of the rest it takes the best value: cheaper wins,
        and so does faster (a group counts its days at sea against the fare). On a tie the earlier offer wins.
      </p>
      <p>
        Each passenger takes a ton of hold (a packet carries two to the ton) and weighs the ship down like cargo. An offer closes when the ship sails,
        changes hands or is lost. The fare is paid on arrival into that port&apos;s region, cut for each game day past the promised arrival; a group long overdue
        goes ashore unpaid. Lloyd&apos;s does not insure fares, and pirates ransom passengers, so a ship carrying them is a richer prize.
      </p>
    </div>
  );
}

/**
 * Offer one of our ships lying in port for a passage: destination, fare per head, berths. With `ship` the form is for that
 * ship alone (the ship page); otherwise any of `ships` lying at a port can be chosen.
 */
export function OfferForm({
  ships,
  ship,
  initialShip = "",
  initialDest = "",
  autopilotShips,
  openOffers,
  blocked = false,
  onDone,
}: {
  ships?: ShipResult[];
  ship?: ShipResult;
  initialShip?: string;
  initialDest?: string;
  /** Ships the fleet autopilot sails: a warning and an override. */
  autopilotShips: Set<string>;
  /** Our open offers (one per ship and destination). */
  openOffers: S.PassengerOfferView[] | undefined;
  /** Writes are off (the ship page while the autopilot sails her). */
  blocked?: boolean;
  onDone: () => void;
}) {
  const { portName } = useCatalog();
  const regionOf = useRegionOf();
  const perTon = usePerTon();
  const { data: clock } = usePoll(() => kibbGet<WorldClock>("/v1/world/clock"), 300_000);
  const [picked, setPicked] = useState(initialShip);
  const [dest, setDest] = useState(initialDest);
  const [fare, setFare] = useState("");
  const [berths, setBerths] = useState("");
  const [override, setOverride] = useState(false);
  const [insuredOk, setInsuredOk] = useState(false);
  // Resolves to null when the confirmation is declined.
  const act = useAction<S.PassengerOfferView | null>((r) => r && onDone());
  const r = ship ?? (ships ?? []).find((x) => x.ship.id === picked);
  const shipId = r?.ship.id ?? "";
  const port = r?.ship.current_port_id ?? "";
  const lying = !!r && atPort(r);
  const free = r ? berthsFree(r, perTon(r.ship.ship_class)) : 0;
  // Each read tagged with what it was asked for: a poll keeps its last answer across a change (and for good if the new read fails),
  // so another port's groups or another route's fares never show under this one.
  const { data: waitingRead } = usePoll(
    lying && port ? () => kibbGet<S.WaitingGroupView[]>("/v1/passengers/waiting", { port_id: port }).then((groups) => ({ port, groups })) : null,
    60_000,
    [port, lying],
  );
  const waiting = waitingRead && waitingRead.port === port ? waitingRead.groups.filter((g) => g.origin_port_id === port) : undefined;
  const { data: faresRead } = usePoll(
    port && dest ? () => kibbGet<S.FareRecordView[]>("/v1/passengers/fares", { from: port, to: dest, limit: 50 }).then((list) => ({ port, dest, list })) : null,
    300_000,
    [port, dest],
  );
  const fares = faresRead && faresRead.port === port && faresRead.dest === dest ? faresRead.list.filter((f) => f.origin_port_id === port && f.dest_port_id === dest) : undefined;
  // Her insurance (guide 3.6: a policy is void when her hold draws more pirates than the cargo declared, and passengers make her a
  // richer prize, 3.20.9): the autopilot never offers berths on an insured ship (cargo_exceeds_declared); here a warning and an override.
  const { data: policyRead } = usePoll(
    shipId ? () => kibbGet<S.InsurancePolicy[]>("/v1/insurance/list", { ship_id: shipId, limit: 20 }).then((list) => ({ shipId, list })) : null,
    30_000,
    [shipId],
  );
  const policies = policyRead && policyRead.shipId === shipId ? policyRead.list : undefined;
  const insured = (policies ?? []).find((p) => p.status === "open" || p.status === "active");
  const forDest = (waiting ?? []).filter((g) => g.dest_port_id === dest && Date.parse(g.board_by) > Date.now());
  const ref = median((fares ?? []).map((f) => f.fare_per_head_pence));
  const f = crToPence(fare);
  const b = berths.trim() === "" ? free : num(berths);
  const dup = r && dest ? (openOffers ?? []).find((o) => o.ship_id === r.ship.id && o.dest_port_id === dest && o.status === "open") : undefined;
  const autopilot = !!r && autopilotShips.has(r.ship.id);
  const why = firstProblem([
    [!!r, "Choose a ship lying in port."],
    [lying, "She must be lying at a port (berthed or in the roadstead) to take passengers."],
    [!!dest, "Choose the destination."],
    [dest !== port, "The destination must be another port."],
    [!dup, `She already has an open offer to ${portName(dest)} (${fmtCr(dup?.fare_per_head_pence, 2)} a head): cancel it first.`],
    [f >= 1, "Enter the fare per head."],
    [berths.trim() !== "" || free > 0, "She has no free hold for passengers now: enter the berths to offer anyway (a group boards only if her free hold takes all of it)."],
    [Number.isInteger(b) && b >= 1 && b <= MAX_BERTHS, `Berths: 1 to ${MAX_BERTHS.toLocaleString("en-GB")} heads in all.`],
    [!r || policies !== undefined, "Reading her insurance…"],
    [!insured || insuredOk, "She is insured: passengers aboard may void the policy (a richer prize than the cargo declared): tick the box to offer her anyway."],
    [!autopilot || override, "The autopilot sails this ship: tick the box to offer her anyway."],
  ]);
  const fits = forDest.filter((g) => g.size <= Math.min(free, Number.isFinite(b) ? b : free));

  function submit() {
    if (!r) return;
    void act.run(async () => {
      if (
        !confirm(
          `Offer ${r.ship.name} at ${portName(port)} for ${portName(dest)}: ${fmtCr(f, 2)} a head, at most ${b} berth${b === 1 ? "" : "s"}?\n\nA group that takes it boards whole at the next game hour and uses a ton of hold a head${perTon(r.ship.ship_class) > 1 ? " (two to the ton in a packet)" : ""}, leaving that much less room for cargo, stores and freight. The fare is paid on arrival into your ${regionName(regionOf(dest))} vault, cut for each game day late. The offer closes when she sails, changes hands or is lost.${autopilot ? "\n\nThe fleet autopilot sails her and plans her hold itself." : ""}`,
        )
      )
        return null;
      return kibbPost<S.PassengerOfferView>("/v1/passengers/offer", { ship_id: r.ship.id, dest_port_id: dest, fare_per_head_pence: f, max_berths: b });
    });
  }

  return (
    <div className="space-y-3">
      {!ship && (
        <Field label="Ship (lying in port)">
          <ShipSelect
            ships={ships}
            value={picked}
            onChange={(v) => {
              setPicked(v);
              setOverride(false);
              setInsuredOk(false);
              act.reset();
            }}
            placeholder="Choose a ship in port…"
            filter={atPort}
          />
        </Field>
      )}
      <Field label="Destination">
        <PortSelect value={dest} onChange={setDest} placeholder="Choose a port…" maxPhase={clock?.unlocked_phase} filter={(id) => id !== port} />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Fare per head (Cr)">
          <Input type="number" min={0.01} step={0.01} value={fare} onChange={(e) => setFare(e.target.value)} placeholder={ref !== null ? (ref / 100).toFixed(2) : undefined} />
        </Field>
        <Field label={`Max berths${r ? ` (${free} fit now)` : ""}`}>
          <Input type="number" min={1} max={MAX_BERTHS} step={1} value={berths} onChange={(e) => setBerths(e.target.value)} placeholder={r ? String(Math.max(1, free)) : undefined} />
        </Field>
      </div>
      {r && (
        <KV
          rows={[
            ["Lying at", lying ? `${portName(port)} (${r.ship.status === "berthed" ? "berthed" : "roadstead"})` : "at sea"],
            [
              "Free hold",
              `${fmtTons(Math.max(0, r.effective_hold_capacity_tons - r.cargo_used_tons))}: ${free} head${free === 1 ? "" : "s"}${perTon(r.ship.ship_class) > 1 ? " (two to the ton)" : ""}`,
            ],
            ["Aboard already", r.ship.passenger_hold_tons > 0 ? `${fmtTons(r.ship.passenger_hold_tons)} of passengers` : "none"],
            ...(dest
              ? ([
                  ["Accepted fares on this route", fares === undefined ? "…" : ref !== null ? `median ${fmtCr(ref, 2)} a head (${fares.length} recent)` : "none recorded"],
                  [
                    `Waiting here for ${portName(dest)}`,
                    waiting === undefined ? "…" : forDest.length ? `${forDest.length} group${forDest.length === 1 ? "" : "s"} (${forDest.map((g) => `${g.size} ${g.kind}`).join(", ")}); ${fits.length} fit whole` : "none now",
                  ],
                ] as Array<[string, string]>)
              : []),
          ]}
        />
      )}
      {r && Number.isFinite(b) && b > free && (
        <p className="text-muted-foreground text-xs">
          Only {free} head{free === 1 ? "" : "s"} fit in her free hold now: a group larger than that won&apos;t board, however many berths you offer.
        </p>
      )}
      {insured && (
        <div className="space-y-1.5">
          <WarnBox>
            She holds an {insured.status} policy to {portName(insured.dest_port_id)}. Passengers make a ship a richer prize for pirates than the cargo declared, and a
            policy whose hold draws more pirates than that is void at departure (cargo exceeds declared): a group that boards may leave her hull and cargo uninsured.
            The autopilot never offers berths on an insured ship.
          </WarnBox>
          <Checkbox checked={insuredOk} onChange={setInsuredOk}>
            <span className="text-xs">I know, offer her anyway</span>
          </Checkbox>
        </div>
      )}
      {autopilot && (
        <div className="space-y-1.5">
          <WarnBox>The fleet autopilot sails this ship: it may load cargo into the hold the passengers need, or sail her, which closes the offer.</WarnBox>
          <Checkbox checked={override} onChange={setOverride}>
            <span className="text-xs">I know, offer her anyway</span>
          </Checkbox>
        </div>
      )}
      <ErrorNote error={act.error ?? (r || dest || fare ? why : null)} />
      {act.result && (
        <p className="text-sm">
          Offered to {portName(act.result.dest_port_id)} at {fmtCr(act.result.fare_per_head_pence, 2)} a head, {act.result.max_berths} berths.
        </p>
      )}
      <Button className="w-full" disabled={!!why || act.busy || blocked} onClick={submit}>
        {act.busy ? "Offering…" : "Offer the passage"}
      </Button>
    </div>
  );
}
