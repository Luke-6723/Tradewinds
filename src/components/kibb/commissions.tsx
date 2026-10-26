"use client";

// Commissions (hulls built to order, guide 3.4): the open ones at yards where we have quay presence, ours as buyer
// or builder, posting one, and accepting, delivering or cancelling. Shared by the ship market and contracts pages.

import { useEffect, useState } from "react";
import Link from "next/link";
import { RefreshCwIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Empty, ErrorNote, KV, Loading, NativeSelect, Panel, Table } from "@/components/kibb/bits";
import {
  AutopilotTag,
  COMMISSION,
  GUN_PENCE,
  bandOf,
  pctOf,
  useDeals,
  usePresence,
  type DealsView,
  type Presence,
} from "@/components/kibb/deals-common";
import {
  CashLine,
  CompanyLabel,
  WarnBox,
  crToPence,
  firstProblem,
  num,
  regionName,
  useAppraisal,
  useCompanyDirectory,
  useRegionOf,
  useVaults,
} from "@/components/kibb/finance-common";
import { Checkbox, realTime, useCompanyId, useOurCompanyIds, useTimeScale } from "@/components/kibb/naval-common";
import { Field, PortSelect } from "@/components/kibb/pickers";
import { LoadMore, fetchAll, usePaged } from "@/components/kibb/trade-common";
import { useAction } from "@/hooks/use-action";
import { useCatalog } from "@/hooks/use-catalog";
import { usePoll } from "@/hooks/use-poll";
import { dash, kibbGet, kibbPost } from "@/lib/kibb/browser";
import { fmtAgo, fmtCr, fmtDateTime, fmtGameHours, fmtIn } from "@/lib/kibb/format";
import type * as S from "@/lib/kibb/schema";
import type { WorldClock } from "@/lib/kibb/types";

type Vaults = ReturnType<typeof useVaults>;

const STATUSES: S.ContractStatus[] = ["open", "active", "completed", "cancelled", "defaulted"];

const STATUS_VARIANT: Record<S.ContractStatus, "info" | "warning" | "success" | "outline" | "error"> = {
  open: "info",
  active: "warning",
  completed: "success",
  cancelled: "outline",
  defaulted: "error",
};

const MODE_LABEL: Record<S.BuildMode, string> = { turnkey_cash: "turnkey (the yard buys the materials)", byom: "own materials (your warehouse at the yard)" };

/** A yard's build quote for a class (needs presence there), refreshed every minute: turnkey prices follow the ask book. */
function useBuildQuote(yard: string, cls: string, mode: S.BuildMode, enabled: boolean) {
  const { data, error } = usePoll(
    enabled && yard && cls ? () => kibbGet<S.BuildQuoteResult>("/v1/shipyard/quote", { port_id: yard, ship_class: cls, build_mode: mode }) : null,
    60_000,
    [yard, cls, mode, enabled],
  );
  // Only an answer for these very inputs.
  const quote = data && data.port_id === yard && data.ship_class === cls && data.build_mode === mode ? data : undefined;
  return { quote, error };
}

/** The build cost a quote gives, or null when the yard (or our warehouse) can't build it now. BYOM: the labour only. */
const costOf = (q: S.BuildQuoteResult | undefined) => (q && q.available && q.total_cost_pence != null ? q.total_cost_pence : null);

/**
 * An own-materials build's whole cost: its labour (all the BYOM quote charges) plus the materials it uses up, valued at
 * what a turnkey build would pay for them now (their cost and customs, without the yard's markup). Null when either
 * quote can't be had (the materials aren't valued).
 */
const byomCostOf = (byom: S.BuildQuoteResult | undefined, turnkey: S.BuildQuoteResult | undefined) => {
  const labour = costOf(byom);
  return labour !== null && costOf(turnkey) !== null ? labour + turnkey!.materials_pence + turnkey!.customs_pence : null;
};

// ── One commission ────────────────────────────────────────────────────────────

function DeliverForm({
  c,
  turnkey,
  byom,
  auto,
  onDone,
}: {
  c: S.ContractListing;
  turnkey: S.BuildQuoteResult | undefined;
  byom: S.BuildQuoteResult | undefined;
  auto: boolean;
  onDone: () => void;
}) {
  const { portName, shipClassName } = useCatalog();
  const [name, setName] = useState("");
  const byomCost = byomCostOf(byom, turnkey);
  const [mode, setMode] = useState<S.BuildMode>(byomCost !== null && byomCost < (costOf(turnkey) ?? Infinity) ? "byom" : "turnkey_cash");
  const [override, setOverride] = useState(false);
  const suggest = useAction<{ name: string }>((r) => setName(r.name));
  // Resolves to null when the confirmation is declined.
  const deliver = useAction<S.DeliverCommissionResult | null>((r) => r && onDone());
  useEffect(() => {
    void suggest.run(() => dash.get<{ name: string }>("/api/kibb/ship-name"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const quote = mode === "byom" ? byom : turnkey;
  // Own materials: the labour charged, and the whole cost with the materials used up (null: not valued).
  const charged = costOf(quote);
  const cost = mode === "byom" ? byomCost : charged;
  const cls = c.ship_class ?? "";

  function submit() {
    void deliver.run(async () => {
      // Quote again: the build is charged at whatever the yard asks at that moment.
      const fresh = await kibbGet<S.BuildQuoteResult>("/v1/shipyard/quote", { port_id: c.origin_port_id, ship_class: cls, build_mode: mode });
      const now = costOf(fresh);
      if (now === null) throw new Error(mode === "byom" ? "Your warehouse at the yard doesn't hold every material." : "The yard's ask book can't supply every material right now.");
      // Own materials: the labour is all that is charged, but the materials used up are worth what turnkey would pay now.
      const valued =
        mode === "byom"
          ? byomCostOf(fresh, await kibbGet<S.BuildQuoteResult>("/v1/shipyard/quote", { port_id: c.origin_port_id, ship_class: cls, build_mode: "turnkey_cash" }).catch(() => undefined))
          : now;
      const net = valued !== null ? c.reward_pence - valued : null;
      const over =
        net === null
          ? "the margin can't be told: your materials couldn't be valued (the yard can't quote them turnkey now)"
          : `${net >= 0 ? `a margin of ${fmtCr(net)}` : `a LOSS of ${fmtCr(-net)}`} over the build${mode === "byom" ? ` (your materials counted at ${fmtCr(valued! - now)}, what the yard would pay for them now)` : ""}`;
      if (
        !confirm(
          `Build the ${shipClassName(cls)} "${name.trim()}" at ${portName(c.origin_port_id)} (${MODE_LABEL[mode]}) for ${fmtCr(now)}${mode === "byom" ? " in labour" : ""}, and hand it to the buyer berthed there?\n\nYou are paid ${fmtCr(c.reward_pence)} and your ${fmtCr(c.collateral_pence)} collateral comes back: ${over}.`,
        )
      )
        return null;
      return kibbPost<S.DeliverCommissionResult>("/v1/contract/deliver-commission", { contract_id: c.id, name: name.trim(), build_mode: mode });
    });
  }

  return (
    <div className="space-y-3 border-t pt-3">
      <div className="font-medium text-sm">Build and deliver</div>
      {auto && (
        <div className="space-y-1.5">
          <WarnBox>
            The autopilot accepted this commission and delivers it itself (it builds at once, and retries every couple of minutes while it has presence at the
            yard). Delivering by hand races it; the game refuses a second delivery.
          </WarnBox>
          <Checkbox checked={override} onChange={setOverride}>
            <span className="text-xs">I know, deliver it by hand</span>
          </Checkbox>
        </div>
      )}
      <Field label="Name of the new ship (it becomes the buyer's)">
        <div className="flex gap-2">
          <Input value={name} maxLength={64} onChange={(e) => setName(e.target.value)} placeholder="Ship name" />
          <Button
            type="button"
            variant="outline"
            size="icon"
            title="Another name"
            disabled={suggest.busy}
            onClick={() => void suggest.run(() => dash.get<{ name: string }>("/api/kibb/ship-name"))}
          >
            <RefreshCwIcon />
          </Button>
        </div>
      </Field>
      <Field label="Build mode">
        <NativeSelect value={mode} onChange={(e) => setMode(e.target.value as S.BuildMode)}>
          <option value="turnkey_cash">Turnkey{costOf(turnkey) !== null ? ` · ${fmtCr(costOf(turnkey))}` : turnkey ? " · can't be supplied now" : ""}</option>
          <option value="byom">
            Own materials
            {costOf(byom) !== null ? (byomCost !== null ? ` · ${fmtCr(byomCost)}` : ` · ${fmtCr(costOf(byom))} labour, materials not valued`) : byom ? " · warehouse short" : ""}
          </option>
        </NativeSelect>
      </Field>
      <KV
        rows={[
          [
            "Build cost now",
            cost !== null
              ? `${fmtCr(cost)}${mode === "byom" ? ` (${fmtCr(charged)} labour + your materials at the yard's prices)` : ""}`
              : charged !== null
                ? `${fmtCr(charged)} labour; materials not valued`
                : quote
                  ? "can't be built now"
                  : "quoting…",
          ],
          ["You are paid", `${fmtCr(c.reward_pence)} + your ${fmtCr(c.collateral_pence)} collateral back`],
          ["Margin", cost !== null ? <span className={c.reward_pence - cost < 0 ? "text-destructive" : undefined}>{fmtCr(c.reward_pence - cost)}</span> : "—"],
        ]}
      />
      {mode === "turnkey_cash" && (
        <p className="text-muted-foreground text-xs">Turnkey here also passes over the buyer&apos;s and its sibling companies&apos; asks, and pays customs on every fill.</p>
      )}
      <ErrorNote error={deliver.error} />
      {deliver.result && (
        <p className="text-sm">
          Delivered {deliver.result.ship_name}: built for {fmtCr(deliver.result.build_cost_pence)}, paid {fmtCr(deliver.result.price_paid_pence)}, collateral{" "}
          {fmtCr(deliver.result.collateral_returned_pence)} back.
        </p>
      )}
      <Button className="w-full" disabled={deliver.busy || !name.trim() || charged === null || (auto && !override)} onClick={submit}>
        {deliver.busy ? "Building…" : "Build and deliver"}
      </Button>
    </div>
  );
}

function CommissionDetail({
  c,
  companyId,
  ourIds,
  presence,
  deals,
  vaults,
  onDone,
}: {
  c: S.ContractListing;
  companyId: string | undefined;
  ourIds: Set<string>;
  presence: Presence;
  deals: DealsView;
  vaults: Vaults;
  onDone: () => void;
}) {
  const { portName, shipClassName } = useCatalog();
  const regionOf = useRegionOf();
  const region = regionOf(c.origin_port_id);
  const cls = c.ship_class ?? "";
  const buyerIsUs = !!companyId && c.issuer_company_id === companyId;
  const builderIsUs = !!companyId && c.carrier_company_id === companyId;
  const here = presence.quay.has(c.origin_port_id);
  const live = c.status === "open" || (c.status === "active" && builderIsUs);
  const { quote: turnkey, error: turnkeyError } = useBuildQuote(c.origin_port_id, cls, "turnkey_cash", here && live && !buyerIsUs);
  const { quote: byom } = useBuildQuote(c.origin_port_id, cls, "byom", here && live && !buyerIsUs);
  const auto = deals.ourCommission(c.id);
  const seen = deals.commissionSeen(c.id);
  // Resolves to null when the confirmation is declined.
  const act = useAction<unknown>((r) => r !== null && onDone());
  // Own materials count only valued (labour plus the materials used up): its labour alone isn't the build's cost.
  const byomCost = byomCostOf(byom, turnkey);
  const cheapest = [costOf(turnkey), byomCost].filter((x): x is number => x !== null).sort((a, b) => a - b)[0] ?? null;
  const cash = vaults.cash(region);
  const lapsed = !!c.expires_at && Date.parse(c.expires_at) <= Date.now();

  function accept() {
    void act.run(async () => {
      const margin = cheapest !== null ? c.reward_pence - cheapest : null;
      if (
        !confirm(
          `Accept the commission to build a ${shipClassName(cls)} at ${portName(c.origin_port_id)} for ${fmtCr(c.reward_pence)}?\n\n${fmtCr(c.collateral_pence)} collateral is escrowed now from your ${regionName(region)} vault and forfeited to the buyer if you don't deliver by ${fmtDateTime(c.expires_at)} (${fmtIn(c.expires_at)}).\n\n${margin !== null ? `Building it now costs ${fmtCr(cheapest)}: a margin of ${fmtCr(margin)}.` : "It couldn't be quoted here just now."} Turnkey prices follow the yard's ask book: quote again when you deliver.${deals.running ? "\n\nThe autopilot didn't take this one, so it won't deliver it: you build it by hand." : ""}`,
        )
      )
        return null;
      return kibbPost<S.CommissionResult>("/v1/contract/accept-commission", { contract_id: c.id });
    });
  }

  function cancel() {
    void act.run(async () => {
      if (!confirm(`Withdraw your commission for a ${shipClassName(cls)} at ${portName(c.origin_port_id)}? The ${fmtCr(c.reward_pence)} escrowed comes back to your ${regionName(region)} vault.`)) return null;
      return kibbPost<S.CommissionResult>("/v1/contract/cancel-commission", { contract_id: c.id });
    });
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="font-medium">
          {shipClassName(cls)} at {portName(c.origin_port_id)}
        </span>
        <Badge variant={STATUS_VARIANT[c.status]} size="sm">
          {c.status}
        </Badge>
        {buyerIsUs && <Badge variant="secondary" size="sm">you buy</Badge>}
        {builderIsUs && <Badge variant="secondary" size="sm">you build</Badge>}
        {auto && <AutopilotTag title={`The autopilot's record: ${auto.status}${auto.note ? `, ${auto.note}` : ""}`}>autopilot builds</AutopilotTag>}
      </div>
      <KV
        rows={[
          ["Price (paid on delivery)", fmtCr(c.reward_pence)],
          ["Builder's collateral", `${fmtCr(c.collateral_pence)}${c.reward_pence ? ` (${pctOf(c.collateral_pence, c.reward_pence)} of the price)` : ""}`],
          ["Deadline", c.expires_at ? `${fmtDateTime(c.expires_at)} (${fmtIn(c.expires_at)})` : "—"],
          ["Buyer", <CompanyLabel key="b" id={c.issuer_company_id} companyId={companyId} ourIds={ourIds} />],
          ["Builder", c.carrier_company_id ? <CompanyLabel key="c" id={c.carrier_company_id} companyId={companyId} ourIds={ourIds} /> : "nobody yet"],
          ["Posted", fmtDateTime(c.created_at)],
          ...(here && live && !buyerIsUs
            ? ([
                ["Turnkey build here now", costOf(turnkey) !== null ? fmtCr(costOf(turnkey)) : turnkey ? "can't be supplied now" : turnkeyError ? "couldn't be quoted" : "quoting…"],
                [
                  "Own-materials build",
                  byomCost !== null
                    ? `${fmtCr(byomCost)} (${fmtCr(costOf(byom))} labour + your materials at the yard's prices)`
                    : costOf(byom) !== null
                      ? `${fmtCr(costOf(byom))} labour; materials not valued`
                      : byom
                        ? "your warehouse here is short"
                        : "…",
                ],
                [
                  "Margin over the cheaper",
                  cheapest !== null ? <span className={c.reward_pence - cheapest < 0 ? "text-destructive" : undefined}>{fmtCr(c.reward_pence - cheapest)}</span> : "—",
                ],
              ] as Array<[string, React.ReactNode]>)
            : []),
          ...(seen ? ([["Autopilot's view", `${seen.verdict}${seen.marginPence !== null ? ` (margin ${fmtCr(seen.marginPence)})` : ""}`]] as Array<[string, string]>) : []),
        ]}
      />

      {c.status === "open" && buyerIsUs && (
        <Button variant="outline" className="w-full" disabled={act.busy} onClick={cancel}>
          Withdraw (refund the price)
        </Button>
      )}

      {c.status === "open" && !buyerIsUs && (
        <div className="space-y-2 border-t pt-3">
          {c.issuer_company_id && ourIds.has(c.issuer_company_id) && (
            <p className="text-muted-foreground text-xs">Posted by another of your companies: you may build it for them at these terms.</p>
          )}
          {!here && <p className="text-muted-foreground text-xs">Accepting needs presence at {portName(c.origin_port_id)} (a ship in port or a factor).</p>}
          <CashLine region={region} cash={cash} need={c.collateral_pence} />
          <Button className="w-full" disabled={act.busy || !here || lapsed || (cash !== undefined && cash < c.collateral_pence)} onClick={accept}>
            Accept (escrow {fmtCr(c.collateral_pence)})
          </Button>
          <p className="text-muted-foreground text-xs">Then deliver before the deadline: the build is charged at your cost then, and you collect the price plus your collateral.</p>
        </div>
      )}

      {c.status === "active" && builderIsUs &&
        (here ? (
          <DeliverForm key={c.id} c={c} turnkey={turnkey} byom={byom} auto={!!auto} onDone={onDone} />
        ) : (
          <WarnBox>Delivering needs presence at {portName(c.origin_port_id)}: sail a ship there or hire a factor before {fmtIn(c.expires_at)}, or the collateral is forfeit.</WarnBox>
        ))}

      <ErrorNote error={act.error} />
      {act.result !== null && typeof act.result === "object" && "status" in (act.result as object) && (
        <p className="text-sm">Commission now {(act.result as S.CommissionResult).status}.</p>
      )}
    </div>
  );
}

// ── Posting one ───────────────────────────────────────────────────────────────

function CreateCommission({ presence, vaults, deals, onDone }: { presence: Presence; vaults: Vaults; deals: DealsView; onDone: () => void }) {
  const { catalog, portName, shipClassName } = useCatalog();
  const regionOf = useRegionOf();
  const timeScale = useTimeScale();
  const { data: clock } = usePoll(() => kibbGet<WorldClock>("/v1/world/clock"), 300_000);
  const unlocked = clock?.unlocked_phase ?? 1;
  const [yard, setYard] = useState("");
  const [cls, setCls] = useState("");
  const [price, setPrice] = useState("");
  const [collateral, setCollateral] = useState("");
  const [hours, setHours] = useState(String(COMMISSION.deadlineDefaultH));
  // Resolves to null when the confirmation is declined.
  const act = useAction<S.Contract | null>((r) => r && onDone());
  const region = regionOf(yard);
  const classes = (catalog?.ship_classes ?? []).filter((c) => c.phase <= unlocked);

  // The hull's rebuild value (the class's cheapest turnkey quote at an open yard): exactly, from the Goldsmiths' appraisal of one of
  // our own ships of the class with no component fitted, less her guns; else this yard's own turnkey quote, at least the rebuild value.
  const own = presence.ships?.find((r) => r.ship.ship_class === cls && r.ship.status !== "sunk" && !(r.components ?? []).length);
  const { rebuild: ownRebuild } = useAppraisal(own?.ship.id);
  const exact = own && ownRebuild !== undefined ? Math.max(0, ownRebuild - own.ship.cannons_count * GUN_PENCE) : null;
  const { quote: yardQuote } = useBuildQuote(yard, cls, "turnkey_cash", exact === null && presence.quay.has(yard));
  const upper = exact === null ? (yardQuote?.total_cost_pence ?? null) : null;
  const band = exact !== null ? bandOf(exact) : null;

  const p = crToPence(price);
  const col = collateral.trim() === "" ? 0 : crToPence(collateral);
  const h = num(hours);
  const cash = vaults.cash(region);
  const why = firstProblem([
    [!!yard, "Choose the shipyard."],
    [!!cls, "Choose the hull class."],
    [p > 0, "Enter the price."],
    [!band || (p >= band.min && p <= band.max), `The price must lie within ${fmtCr(band?.min)} – ${fmtCr(band?.max)} (50%–150% of the hull's rebuild value).`],
    [upper === null || p <= Math.floor(upper * 1.5), `Over 150% of ${portName(yard)}'s own turnkey quote (${fmtCr(upper)}), so over 150% of the rebuild value too: it would be refused.`],
    [Number.isFinite(col) && col >= 0, "Enter the collateral (0 for none)."],
    [!(p > 0) || col <= Math.floor(p * COMMISSION.collateralMaxShare), `The builder's collateral is at most 25% of the price (${fmtCr(Math.floor((p || 0) * COMMISSION.collateralMaxShare))}).`],
    [Number.isInteger(h) && h >= COMMISSION.deadlineMinH && h <= COMMISSION.deadlineMaxH, "The deadline is 6..1440 game hours."],
    [cash === undefined || cash >= p, `The price is escrowed from your ${regionName(region)} vault, which holds only ${fmtCr(cash)}.`],
  ]);
  const lowVsUpper = upper !== null && p > 0 && p < Math.ceil(upper * 0.5);

  function submit() {
    void act.run(async () => {
      if (
        !confirm(
          `Commission a ${shipClassName(cls)} at ${portName(yard)} for ${fmtCr(p)}, escrowed now from your ${regionName(region)} vault?\n\nThe builder puts up ${fmtCr(col)} of collateral; deadline ${fmtGameHours(h)} (${realTime(h * 60, timeScale)}). Builders with quay presence at the yard see it. Untaken by the deadline, the price is refunded; taken and not delivered, you get the price back plus the builder's collateral. You can withdraw it while nobody has taken it. The ship is delivered to you berthed at ${portName(yard)}.${deals.running ? "\n\nThe fleet autopilot is running: it takes command of every ship of yours, the new one included." : ""}`,
        )
      )
        return null;
      return kibbPost<S.Contract>("/v1/contract/create-commission", {
        port_id: yard,
        ship_class: cls,
        price_pence: p,
        collateral_pence: col,
        deadline_game_hours: h,
      });
    });
  }

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <Field label="Shipyard" className="col-span-2">
          <PortSelect
            value={yard}
            onChange={setYard}
            placeholder="Choose a yard…"
            maxPhase={unlocked}
            filter={(id) => !!catalog?.ports.find((x) => x.id === id)?.has_shipyard}
          />
        </Field>
        <Field label="Hull class" className="col-span-2">
          <NativeSelect value={cls} onChange={(e) => setCls(e.target.value)}>
            <option value="">Choose a class…</option>
            {classes.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} · {c.hull_category} · {c.hold_capacity_tons} t
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field label="Price (Cr)">
          <Input type="number" min={1} step={1} value={price} onChange={(e) => setPrice(e.target.value)} placeholder={exact ? String(Math.round(exact / 100)) : undefined} />
        </Field>
        <Field label="Builder's collateral (Cr)">
          <Input type="number" min={0} step={1} value={collateral} onChange={(e) => setCollateral(e.target.value)} placeholder="0" />
        </Field>
        <Field label="Deadline (game hours)" className="col-span-2">
          <Input type="number" min={COMMISSION.deadlineMinH} max={COMMISSION.deadlineMaxH} step={1} value={hours} onChange={(e) => setHours(e.target.value)} />
        </Field>
      </div>
      {cls && (
        <KV
          rows={[
            [
              "Hull's rebuild value",
              exact !== null
                ? `${fmtCr(exact)} (appraisal of your ${own?.ship.name})`
                : upper !== null
                  ? `at most ${fmtCr(upper)} (${portName(yard)}'s turnkey quote)`
                  : yard && !presence.quay.has(yard)
                    ? "not known: no presence at this yard to quote it"
                    : "…",
            ],
            ["Allowed price", band ? `${fmtCr(band.min)} – ${fmtCr(band.max)}` : upper !== null ? `at most ${fmtCr(Math.floor(upper * 1.5))}` : "50%–150% of it, checked by the game"],
            ["Price vs rebuild", exact !== null && p > 0 ? pctOf(p, exact) : "—"],
            ["Deadline", Number.isFinite(h) ? `${fmtGameHours(h)} (${realTime(h * 60, timeScale)})` : "—"],
          ]}
        />
      )}
      {lowVsUpper && (
        <WarnBox>
          Under 50% of this yard&apos;s quote. The game checks the band against the class&apos;s cheapest open yard, which may be lower than here, but a price this low may be refused.
        </WarnBox>
      )}
      <CashLine region={region} cash={cash} need={p > 0 ? p : undefined} />
      <ErrorNote error={act.error ?? (yard || cls || price ? why : null)} />
      {act.result && (
        <p className="text-sm">
          Commission posted: a {shipClassName(cls)} at {portName(act.result.origin_port_id)} for {fmtCr(act.result.reward_pence)}, lapsing {fmtIn(act.result.expires_at)}.
        </p>
      )}
      <Button className="w-full" disabled={!!why || act.busy} onClick={submit}>
        {act.busy ? "Posting…" : "Commission the hull"}
      </Button>
    </div>
  );
}

// ── The view ──────────────────────────────────────────────────────────────────

function CommissionRow({
  c,
  companyId,
  ourIds,
  deals,
  selected,
  onSelect,
}: {
  c: S.ContractListing;
  companyId: string | undefined;
  ourIds: Set<string>;
  deals: DealsView;
  selected: boolean;
  onSelect: () => void;
}) {
  const { portName, shipClassName } = useCatalog();
  const auto = deals.ourCommission(c.id);
  const seen = deals.commissionSeen(c.id);
  const buyerIsUs = !!companyId && c.issuer_company_id === companyId;
  const builderIsUs = !!companyId && c.carrier_company_id === companyId;
  return (
    <tr className={selected ? "bg-accent" : undefined}>
      <td>
        <div className="font-medium">{shipClassName(c.ship_class)}</div>
        <div className="mt-0.5 flex flex-wrap gap-1">
          {buyerIsUs && <Badge variant="secondary" size="sm">you buy</Badge>}
          {builderIsUs && <Badge variant="secondary" size="sm">you build</Badge>}
          {!buyerIsUs && c.issuer_company_id && ourIds.has(c.issuer_company_id) && <Badge variant="outline" size="sm">your other company</Badge>}
          {auto && <AutopilotTag title={`${auto.status}${auto.note ? `: ${auto.note}` : ""}`}>autopilot builds</AutopilotTag>}
        </div>
      </td>
      <td>
        <Link href={`/ports/${c.origin_port_id}`} className="hover:underline">
          {portName(c.origin_port_id)}
        </Link>
      </td>
      <td className="tabular-nums">
        {fmtCr(c.reward_pence)}
        {seen && seen.marginPence !== null && <div className="text-muted-foreground text-xs">margin ~{fmtCr(seen.marginPence)}</div>}
      </td>
      <td className="tabular-nums">{fmtCr(c.collateral_pence)}</td>
      <td className="whitespace-nowrap text-xs">{c.status === "open" || c.status === "active" ? fmtIn(c.expires_at) : fmtDateTime(c.updated_at)}</td>
      <td>
        <CompanyLabel id={c.issuer_company_id} companyId={companyId} ourIds={ourIds} />
      </td>
      <td>{c.carrier_company_id ? <CompanyLabel id={c.carrier_company_id} companyId={companyId} ourIds={ourIds} /> : <span className="text-muted-foreground">—</span>}</td>
      <td>
        <Badge variant={STATUS_VARIANT[c.status]} size="sm">
          {c.status}
        </Badge>
      </td>
      <td className="text-right">
        <Button size="sm" variant="outline" onClick={onSelect}>
          Open
        </Button>
      </td>
    </tr>
  );
}

const HEAD = ["Hull", "Yard", "Price", "Collateral", "Deadline", "Buyer", "Builder", "Status", ""];

/** Every commission we can see, ours, and the forms (guide 3.4). */
export function CommissionsView() {
  useCompanyDirectory();
  const { catalog, portName } = useCatalog();
  const companyId = useCompanyId();
  const ourIds = useOurCompanyIds();
  const presence = usePresence();
  const deals = useDeals();
  const vaults = useVaults();
  const [status, setStatus] = useState<S.ContractStatus>("open");
  const [yard, setYard] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const list = usePaged(
    (cursor) => kibbGet<S.ContractListing[]>("/v1/contract/list", { contract_type: "commission", status, port_id: yard, cursor, limit: 100 }),
    100,
    [status, yard],
  );
  // Ours as buyer or builder, still live: every open and active commission we can see.
  const { data: live, error: liveError, reload: reloadLive } = usePoll(
    companyId
      ? async () => {
          const [open, active] = await Promise.all(
            (["open", "active"] as const).map((s) => fetchAll<S.ContractListing>("/v1/contract/list", { contract_type: "commission", status: s }, 200, 10)),
          );
          return [...open, ...active].filter((c) => c.issuer_company_id === companyId || c.carrier_company_id === companyId);
        }
      : null,
    30_000,
    [companyId],
  );
  const refresh = () => {
    void list.reload();
    void reloadLive();
    void vaults.reload();
    presence.reload();
  };
  const all = [...(live ?? []), ...list.items];
  const selected = selectedId ? (all.find((c) => c.id === selectedId) ?? null) : null;
  // Shipyards where we have quay presence: where open commissions are listed to us.
  const yards = new Set([...presence.quay].filter((id) => !!catalog?.ports.find((p) => p.id === id)?.has_shipyard));

  return (
    <div className="grid items-start gap-4 xl:grid-cols-3">
      <div className="space-y-4 xl:col-span-2">
        <Panel title="Your commissions (live)">
          <ErrorNote error={liveError} />
          {!live ? (
            !liveError && <Loading />
          ) : live.length === 0 ? (
            <Empty>None: you have no commission open or being built, as buyer or builder.</Empty>
          ) : (
            <Table head={HEAD}>
              {live.map((c) => (
                <CommissionRow key={c.id} c={c} companyId={companyId} ourIds={ourIds} deals={deals} selected={c.id === selectedId} onSelect={() => setSelectedId(c.id)} />
              ))}
            </Table>
          )}
          {deals.deals && deals.deals.ours.length > 0 && (
            <p className="mt-3 text-muted-foreground text-xs">
              The autopilot is building {deals.deals.ours.filter((c) => c.status !== "delivered" && c.status !== "failed").length} to order and has delivered{" "}
              {deals.deals.commissionsDelivered} (~{fmtCr(deals.deals.commissionNetPence)} over the builds).
            </p>
          )}
        </Panel>
        <Panel
          title="Commissions"
          action={
            <div className="flex w-full flex-wrap gap-2 sm:w-auto">
              <div className="w-full sm:w-44">
                <PortSelect
                  value={yard}
                  onChange={setYard}
                  placeholder="All yards"
                  filter={(id) => yards.has(id) || id === yard}
                />
              </div>
              <div className="w-full sm:w-32">
                <NativeSelect value={status} onChange={(e) => setStatus(e.target.value as S.ContractStatus)}>
                  {STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </NativeSelect>
              </div>
            </div>
          }
        >
          <ErrorNote error={list.error} />
          {list.items.length === 0 ? (
            list.loading ? (
              <Loading />
            ) : (
              <Empty>
                No {status} commissions{yard ? " at this yard" : ""}. Open ones are listed only to companies with quay presence at the yard (a ship in port or a factor).
              </Empty>
            )
          ) : (
            <Table head={HEAD}>
              {list.items.map((c) => (
                <CommissionRow key={c.id} c={c} companyId={companyId} ourIds={ourIds} deals={deals} selected={c.id === selectedId} onSelect={() => setSelectedId(c.id)} />
              ))}
            </Table>
          )}
          <LoadMore done={list.done} loading={list.loading} onMore={() => void list.more()} />
          <p className="mt-3 text-muted-foreground text-xs">
            Shipyards where you have quay presence (your ships in port and factors): {yards.size ? [...yards].map(portName).join(", ") : "none"}.
            {deals.deals?.commissionsAt && ` Margins shown are the autopilot's, from its last look ${fmtAgo(deals.deals.commissionsAt)}.`}
          </p>
        </Panel>
      </div>
      <div className="space-y-4">
        {selected && (
          <Panel
            title="Commission"
            action={
              <button type="button" className="text-muted-foreground text-xs hover:text-foreground" onClick={() => setSelectedId(null)}>
                Close
              </button>
            }
          >
            <CommissionDetail key={selected.id} c={selected} companyId={companyId} ourIds={ourIds} presence={presence} deals={deals} vaults={vaults} onDone={refresh} />
          </Panel>
        )}
        <Panel title="Commission a hull">
          <CreateCommission presence={presence} vaults={vaults} deals={deals} onDone={refresh} />
        </Panel>
        <WarnBox tone="info">
          <p>
            A commission is a hull built to order. The buyer escrows the price (50%–150% of the hull&apos;s rebuild value) and needs no presence; builders with quay
            presence at the yard see it.
          </p>
          <p>
            A builder accepts (escrowing the collateral, at most 25% of the price), then delivers before the deadline: the ship is built there exactly as a
            build-ship would be, at the builder&apos;s cost, and handed to the buyer berthed at the yard. The builder collects the price and its collateral back.
          </p>
          <p>Untaken by the deadline, the price is refunded; taken and not delivered, the buyer is refunded and the builder&apos;s collateral goes to the buyer.</p>
        </WarnBox>
      </div>
    </div>
  );
}
