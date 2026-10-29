"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Empty, ErrorNote, KV, Loading, Metrics, NativeSelect, PageHeader, Panel, Progress, Table } from "@/components/kibb/bits";
import {
  InsurableCap,
  LaneGuide,
  MAX_PARTIAL_SHARE,
  QuoteGuide,
  capFrom,
  createPolicy,
  createdText,
  floorFor,
  impliedMaxEl,
  isHullOnly,
  laneKey,
  maxSliceFor,
  sliceOk,
  useInsuranceQuote,
  useLaneFloors,
  useOwnCover,
  type InsurableValue,
  type LaneFloors,
} from "@/components/kibb/insurance-common";
import { Field, PortSelect, ShipSelect } from "@/components/kibb/pickers";
import { AutopilotWarning, Checkbox, Pager, PAGE_SIZE, Segmented, num, shortId, useAutopilotShips, useCompanyId, useCursor, useTimeScale } from "@/components/kibb/naval-common";
import { BatchError, postBatch } from "@/components/kibb/trade-common";
import { useAction } from "@/hooks/use-action";
import { useCatalog } from "@/hooks/use-catalog";
import { usePoll } from "@/hooks/use-poll";
import { dash, kibbGet, kibbPost } from "@/lib/kibb/browser";
import { fmtAgo, fmtBps, fmtCr, fmtDateTime, fmtIn } from "@/lib/kibb/format";
import type * as S from "@/lib/kibb/schema";
import type { ShipResult, WorldClock } from "@/lib/kibb/types";

type View = "ours" | "underwriting" | "market";

const STATUS_VARIANT: Record<S.InsuranceStatus, "info" | "success" | "secondary" | "error" | "outline"> = {
  open: "info",
  active: "success",
  settled_safe: "secondary",
  claimed_loss: "error",
  cancelled: "outline",
};

/** Edge over Lloyd's expected loss worth highlighting (bps). */
const GOOD_EDGE = 150;
/** Lloyd's looks at listings about a game hour old: until then the pick is the players'. */
const FIRST_PICK_GAME_MIN = 60;

interface Risk {
  collateral: number;
  premium: number;
  /** What one bad partial loss costs the slice: pirates who let the ship go take up to half the declared cargo (a storm's share varies); 0 for hull-only cover. */
  maxHit: number;
  /** Ceiling on the expected loss (bps), null without anything to go on. */
  elMax: number | null;
  /**
   * Where elMax comes from: Lloyd's own estimate on the listing (an upper bound), the policy's own cover by others
   * (implied by Lloyd's hurdle), or the lane's other policies (a guide).
   */
  basis: "listing" | "policy" | "lane" | null;
  /** premium − elMax (bps): the listing's `premium_margin_bps` when it carries one. */
  edge: number | null;
  /** The edge in pence on the slice. */
  edgePence: number | null;
}

/** `own`: policies our companies hold slices of (their cover is ours, so it proves nothing). */
function riskOf(p: S.InsurancePolicyListing, sliceBps: number, floors: LaneFloors | null | undefined, own: Set<string> | undefined): Risk {
  const listed = typeof p.lloyds_expected_loss_bps === "number";
  // Cover written by someone else (in practice Lloyd's) means this very policy passed its test.
  const vetted = p.covered_bps > 0 && !!own && !own.has(p.id);
  const floor = floorFor(floors, isHullOnly(p));
  const basis = listed ? "listing" : vetted ? "policy" : floor !== null ? "lane" : null;
  const elMax = listed ? p.lloyds_expected_loss_bps! : basis === "policy" ? impliedMaxEl(p.premium_bps) : floor !== null ? impliedMaxEl(floor) : null;
  const edge = listed && typeof p.premium_margin_bps === "number" ? p.premium_margin_bps : elMax === null ? null : p.premium_bps - elMax;
  const cargo = Math.max(0, p.insured_value_pence - p.hull_value_pence);
  return {
    collateral: Math.ceil((p.insured_value_pence * sliceBps) / 10_000),
    premium: Math.floor((p.total_premium_pence * sliceBps) / 10_000),
    maxHit: Math.floor((cargo * MAX_PARTIAL_SHARE * sliceBps) / 10_000),
    elMax,
    basis,
    edge,
    edgePence: edge === null ? null : Math.round((edge * p.insured_value_pence * sliceBps) / 100_000_000),
  };
}

function EdgeText({ edge }: { edge: number | null }) {
  if (edge === null) return <span className="text-muted-foreground">—</span>;
  return <span className={edge >= GOOD_EDGE ? "font-medium text-success-foreground" : undefined}>{fmtBps(Math.round(edge))}</span>;
}

const coverText = (p: S.InsurancePolicy) =>
  isHullOnly(p) ? "hull only" : `${Math.round(((p.insured_value_pence - p.hull_value_pence) / p.insured_value_pence) * 100)}% cargo`;

interface OurSlice {
  slice_bps: number;
  collateral_locked_pence: number;
  premium_share_pence: number;
}

interface OurSlices {
  byPolicy: Map<string, OurSlice>;
  /** Underwriting events read, and how many carried the fields needed. */
  events: number;
  readable: number;
}

type Payload = Record<string, unknown>;

/** A payload field, or the same key one object down (e.g. under `underwriting`). */
function pick(p: Payload, key: string): unknown {
  if (p[key] !== undefined && p[key] !== null) return p[key];
  for (const v of Object.values(p)) {
    if (v && typeof v === "object" && !Array.isArray(v) && (v as Payload)[key] != null) return (v as Payload)[key];
  }
  return undefined;
}

/** Our slices, rebuilt from the company event log (the list doesn't return underwritings; the log keeps 7 days). */
async function loadOurSlices(ourId: string): Promise<OurSlices> {
  const byPolicy = new Map<string, OurSlice>();
  let after = "0";
  let events = 0;
  let readable = 0;
  for (let page = 0; page < 40; page++) {
    const batch = await kibbGet<S.StreamEvent[]>("/v1/event/stream", { event_type: "insurance_underwritten", after_id: after, limit: 500, timeout_ms: 0 });
    if (!batch?.length) break;
    after = batch[batch.length - 1].id;
    for (const e of batch) {
      events++;
      const p = (e.payload && typeof e.payload === "object" ? e.payload : {}) as Payload;
      const nested = p.policy && typeof p.policy === "object" ? (p.policy as Payload).id : undefined;
      const policyId = pick(p, "policy_id") ?? nested;
      const uw = pick(p, "underwriter_company_id");
      const slice = pick(p, "slice_bps");
      const collateral = pick(p, "collateral_locked_pence");
      const premium = pick(p, "premium_share_pence");
      if (typeof policyId !== "string" || typeof uw !== "string" || typeof slice !== "number" || typeof collateral !== "number" || typeof premium !== "number") continue;
      readable++;
      if (uw !== ourId) continue;
      const o = byPolicy.get(policyId) ?? { slice_bps: 0, collateral_locked_pence: 0, premium_share_pence: 0 };
      byPolicy.set(policyId, {
        slice_bps: o.slice_bps + slice,
        collateral_locked_pence: o.collateral_locked_pence + collateral,
        premium_share_pence: o.premium_share_pence + premium,
      });
    }
  }
  return { byPolicy, events, readable };
}

function CreatePolicy({ ships, autopilot, maxPhase, onDone }: { ships: ShipResult[] | undefined; autopilot: Set<string>; maxPhase: number; onDone: () => void }) {
  const { portName } = useCatalog();
  const [shipId, setShipId] = useState("");
  const [dest, setDest] = useState("");
  const [valueCr, setValueCr] = useState("");
  const [premium, setPremium] = useState("");
  const [cap, setCap] = useState<InsurableValue | null>(null);
  const [override, setOverride] = useState(false);
  const act = useAction<S.CreateInsurancePolicyResult>(onDone);

  const ship = ships?.find((s) => s.ship.id === shipId);
  const from = ship?.ship.current_port_id ?? "";
  const value = Math.round(num(valueCr) * 100);
  const bps = num(premium);
  const onAutopilot = !!shipId && autopilot.has(shipId);
  // Quoted first: Lloyd's price for this ship, port and sum insured.
  const { data: quote, error: quoteError } = useInsuranceQuote(ship && dest && dest !== from ? shipId : "", dest, value);
  const quoted = quote && quote.ship_id === shipId && quote.dest_port_id === dest && quote.insured_value_pence === value ? quote : undefined;
  const valid = !!ship && !!dest && dest !== from && value > 0 && bps >= 10 && bps <= 3000;
  const floors = useLaneFloors(from && dest ? [[from, dest]] : []).get(laneKey(from, dest));
  // Cover type: from the quote or a cap once seen; an empty hold can only be hull-only; otherwise unknown.
  const hull = quoted?.hull_value_pence ?? cap?.hull_value_pence;
  const hullOnly = hull !== undefined && value > 0 ? value <= hull : ship && ship.cargo_used_tons <= 0 ? true : null;

  useEffect(() => {
    setCap(null);
    setOverride(false);
  }, [shipId]);

  async function submit() {
    const r = await act.run(async () => {
      try {
        return await createPolicy({ ship_id: shipId, dest_port_id: dest, insured_value_pence: value, premium_bps: Math.round(bps) });
      } catch (e) {
        const c = capFrom(e);
        if (c) setCap(c);
        throw e;
      }
    });
    if (r) setCap(null);
  }

  return (
    <div className="space-y-3">
      <Field label="Ship">
        <ShipSelect
          ships={ships}
          filter={(s) => s.ship.status === "berthed" || s.ship.status === "anchored_roadstead"}
          value={shipId}
          onChange={setShipId}
          placeholder="Choose a ship in port…"
        />
      </Field>
      <AutopilotWarning show={onAutopilot}>
        The fleet autopilot is sailing this ship. Once insured it drops its own plan: it sails for the insured port with what is aboard and loads nothing
        more (cargo added after the policy voids it), and it can&apos;t land guns while insured. Insure it only once it is loaded, or stop it on the dashboard first.
      </AutopilotWarning>
      {onAutopilot && (
        <Checkbox checked={override} onChange={setOverride}>
          I know, act anyway
        </Checkbox>
      )}
      <Field label="Insured voyage to">
        <PortSelect value={dest} onChange={setDest} placeholder="Choose a port…" maxPhase={maxPhase} filter={(p) => p !== from} />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Sum insured (Cr): hull plus all the cargo aboard">
          <Input type="number" min={0.01} step={0.01} value={valueCr} onChange={(e) => setValueCr(e.target.value)} />
        </Field>
        <Field label="Premium (bps)">
          <Input type="number" min={10} max={3000} placeholder="10–3,000" value={premium} onChange={(e) => setPremium(e.target.value)} />
        </Field>
      </div>
      {ship && dest && dest !== from && (
        <QuoteGuide quote={quoted} error={quoteError} valueCr={valueCr} premiumBps={bps} onValue={setValueCr} onPremium={setPremium} />
      )}
      {from && dest && dest !== from && <LaneGuide floors={floors} hullOnly={hullOnly} premiumBps={bps} />}
      <p className="text-muted-foreground text-xs">
        The cap is the hull&apos;s rebuild quote plus 150 Cr a gun plus the cargo aboard. Ask for more and the game refuses with the cap, which then shows here.
      </p>
      {cap && <InsurableCap cap={cap} valueCr={valueCr} onUseMax={setValueCr} />}
      <KV
        rows={[
          ["Premium escrowed", value > 0 && bps > 0 ? fmtCr(Math.ceil((value * bps) / 10_000)) : "—"],
          ["Rate", Number.isFinite(bps) ? fmtBps(bps) : "—"],
        ]}
      />
      <ErrorNote error={act.error} />
      {act.result && (
        <p className="text-sm">
          Policy open: {fmtCr(act.result.insured_value_pence)} on the voyage to {portName(act.result.dest_port_id)}, premium {fmtCr(act.result.total_premium_pence)}.{" "}
          {createdText(act.result)} Wait in port for underwriters, and load nothing more.
        </p>
      )}
      <Button className="w-full" disabled={!valid || act.busy || (onAutopilot && !override)} onClick={submit}>
        {act.busy ? "Requesting…" : "Request policy"}
      </Button>
    </div>
  );
}

function Underwrite({ policy, ourId, mine, onDone }: { policy: S.InsurancePolicyListing; ourId: string | undefined; mine: boolean; onDone: () => void }) {
  const { portName } = useCatalog();
  const uncovered = 10_000 - policy.covered_bps;
  // Steps of 100 from 500, or a remainder under 500 whole.
  const maxSlice = maxSliceFor(policy.covered_bps);
  const [slice, setSlice] = useState(String(uncovered < 500 ? maxSlice : Math.min(1000, maxSlice)));
  const [clamped, setClamped] = useState(false);
  const floors = useLaneFloors([[policy.origin_port_id, policy.dest_port_id]]).get(laneKey(policy.origin_port_id, policy.dest_port_id));
  const own = useOwnCover();
  const act = useAction<S.InsurancePolicyDetailResult>(onDone);
  const s = num(slice);
  const hullOnly = isHullOnly(policy);
  const risk = riskOf(policy, Number.isFinite(s) ? s : 0, floors, own);
  const floor = floorFor(floors, hullOnly);

  // Others may write cover between refreshes: pull the slice back to what is left.
  useEffect(() => {
    const n = num(slice);
    if (Number.isFinite(n) && n > maxSlice) {
      setSlice(String(maxSlice));
      setClamped(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [maxSlice]);

  const why =
    policy.status !== "open" && policy.status !== "active"
      ? `The policy is ${policy.status.replace("_", " ")}: it takes no more slices.`
      : !Number.isFinite(s)
        ? "Enter a slice."
        : uncovered < 500
          ? s !== uncovered
            ? `The ${uncovered} bps left can only be taken whole.`
            : null
          : s < 500
            ? "A slice is at least 500 bps (5%)."
            : s > maxSlice
              ? `Only ${maxSlice} bps are left uncovered.`
              : s % 100 !== 0
                ? "Slices go in steps of 100 bps."
                : null;
  const valid = !mine && why === null && sliceOk(s, uncovered);
  const timeScale = useTimeScale();
  // Lloyd's looks at it about a game hour after listing: until then, the pick is the players'.
  const firstPick = (Date.now() - Date.parse(policy.created_at)) / (60_000 / timeScale) < FIRST_PICK_GAME_MIN;

  return (
    <div className="space-y-3">
      <KV
        rows={[
          ["Voyage", `${portName(policy.origin_port_id)} → ${portName(policy.dest_port_id)}`],
          ["Sum insured", fmtCr(policy.insured_value_pence)],
          ["Hull / declared cargo", `${fmtCr(policy.hull_value_pence)} / ${fmtCr(Math.max(0, policy.insured_value_pence - policy.hull_value_pence))}`],
          ["Premium", `${fmtBps(policy.premium_bps)} = ${fmtCr(policy.total_premium_pence)}`],
          ["Covered", `${fmtBps(policy.covered_bps)} (${fmtBps(uncovered)} open)`],
          [
            "Expected loss ≤",
            risk.basis === "listing"
              ? `${fmtBps(Math.round(risk.elMax ?? 0))} (Lloyd's own estimate, an upper bound)`
              : risk.basis === "policy"
                ? `${fmtBps(Math.round(risk.elMax ?? 0))} (implied by its own cover)`
                : floors === undefined || own === undefined
                  ? "…"
                  : risk.basis === "lane"
                    ? `${fmtBps(Math.round(risk.elMax ?? 0))} (Lloyd's price on the lane's other policies, ${floor} bps: only a guide)`
                    : floors === null
                      ? "couldn't read the lane's open policies"
                      : `no Lloyd's estimate listed (sailed, or no route), and no other open ${hullOnly ? "hull-only" : "with-cargo"} policy on this lane`,
          ],
          ["Lloyd's price", typeof policy.lloyds_min_premium_bps === "number" ? fmtBps(policy.lloyds_min_premium_bps) : "—"],
          ["Edge", <EdgeText key="e" edge={risk.edge} />],
          ["Open for", `${fmtAgo(policy.created_at).replace(/ ago$/, "")}${firstPick ? " (players' first pick: Lloyd's looks after about a game hour)" : ""}`],
          ["Lapses", fmtIn(policy.expires_at)],
        ]}
      />
      <Progress value={policy.covered_bps} max={10_000} />
      {mine ? (
        <p className="text-muted-foreground text-xs">
          {policy.insured_company_id === ourId ? "Your own policy" : "One of your other companies' policies"}: you can&apos;t underwrite it.
        </p>
      ) : maxSlice <= 0 ? (
        <p className="text-muted-foreground text-xs">Fully covered: no slice can be written.</p>
      ) : (
        <>
          <Field label={uncovered < 500 ? `Slice (the ${uncovered} bps left, whole)` : `Slice (bps, 500..${maxSlice}, steps of 100)`}>
            <Input
              type="number"
              min={uncovered < 500 ? uncovered : 500}
              max={maxSlice}
              step={uncovered < 500 ? 1 : 100}
              value={slice}
              onChange={(e) => {
                setSlice(e.target.value);
                setClamped(false);
              }}
            />
          </Field>
          {clamped && <p className="text-muted-foreground text-xs">Cover was written since: the slice is cut to the {maxSlice} bps left.</p>}
          <KV
            rows={[
              ["Collateral locked (lost on a sinking)", Number.isFinite(s) ? fmtCr(risk.collateral) : "—"],
              ["Premium earned", Number.isFinite(s) ? fmtCr(risk.premium) : "—"],
              ["Max partial claim per hit", hullOnly ? "none: hull-only pays only on a total loss" : Number.isFinite(s) ? fmtCr(risk.maxHit) : "—"],
              ["Edge on the slice", risk.edgePence === null || !Number.isFinite(s) ? "—" : fmtCr(risk.edgePence)],
            ]}
          />
          {why && <p className="text-muted-foreground text-xs">{why}</p>}
          <Button
            className="w-full"
            disabled={!valid || act.busy}
            onClick={() => act.run(() => kibbPost<S.InsurancePolicyDetailResult>("/v1/insurance/underwrite", { policy_id: policy.id, slice_bps: Math.round(s) }))}
          >
            {act.busy ? "Underwriting…" : `Underwrite ${Number.isFinite(s) ? fmtBps(s) : ""}`}
          </Button>
        </>
      )}
      <p className="text-muted-foreground text-xs">
        A storm pays the share of the declared cargo it took (storms vary: most are light, a heavy one takes much more), pirates who let the ship go what they
        seized of it (up to 50%), shared by slice; a sinking or a capture takes the whole collateral. The bound is Lloyd&apos;s own estimate on the listing (an upper bound, so the margin is at least the edge shown);
        without one, what the policy&apos;s own cover or the lane&apos;s other policies imply.
      </p>
      <ErrorNote error={act.error} />
      {act.result && (
        <div className="space-y-2">
          <p className="text-sm">Written. The policy is now {fmtBps(act.result.policy.covered_bps)} covered.</p>
          <UnderwritingsTable rows={act.result.underwritings} ourId={ourId} />
        </div>
      )}
    </div>
  );
}

function UnderwritingsTable({ rows, ourId }: { rows: S.InsuranceUnderwriting[]; ourId: string | undefined }) {
  return (
    <Table head={["Underwriter", "Slice", "Collateral", "Premium share"]}>
      {rows.map((u) => (
        <tr key={u.id}>
          <td className="text-xs">{u.underwriter_company_id === ourId ? "You" : <span className="font-mono">{shortId(u.underwriter_company_id)}</span>}</td>
          <td className="tabular-nums">{fmtBps(u.slice_bps)}</td>
          <td className="tabular-nums">{fmtCr(u.collateral_locked_pence)}</td>
          <td className="tabular-nums">{fmtCr(u.premium_share_pence)}</td>
        </tr>
      ))}
    </Table>
  );
}

const LLOYDS_LIST_DAYS = [7, 30, 90, 360];

/** `GET /v1/insurance/lloyds-list` (guide 3.6): what underwriting has paid, for Lloyd's, players as one group, and everyone. */
function LloydsListPanel() {
  const [days, setDays] = useState(30);
  const [period, setPeriod] = useState<"recent" | "all_time">("recent");
  const { data, error } = usePoll(() => kibbGet<S.LloydsListResult>("/v1/insurance/lloyds-list", { days }), 300_000, [days]);
  const groups: Array<[string, S.UnderwriterGroupResults | null | undefined]> = data
    ? [
        ["Lloyd's", data.lloyds],
        ["Player underwriters", data.players],
        ["Everyone", data.all_underwriters],
      ]
    : [];
  const ratio = (bps: number | null | undefined) => (bps === null || bps === undefined ? "—" : fmtBps(bps));
  const funds = data?.lloyds?.funds_pence;

  return (
    <Panel
      title="Lloyd's List"
      action={
        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
          <div className="w-full sm:w-56">
            <Segmented<"recent" | "all_time">
              value={period}
              onChange={setPeriod}
              options={[
                { value: "recent", label: `Last ${days} days` },
                { value: "all_time", label: "This season" },
              ]}
            />
          </div>
          <div className="w-full sm:w-28">
            <NativeSelect value={String(days)} onChange={(e) => setDays(Number(e.target.value))} disabled={period === "all_time"}>
              {LLOYDS_LIST_DAYS.map((d) => (
                <option key={d} value={d}>
                  {d} game days
                </option>
              ))}
            </NativeSelect>
          </div>
        </div>
      }
    >
      <ErrorNote error={error} />
      {!data ? (
        !error && <Loading />
      ) : (
        <div className="space-y-3">
          <Table head={["Underwriters", "Written", "Premiums earned", "Claims paid", "Net", "Loss ratio", "Return on cover", "Safe / lost / void", "With claims", "Locked now", "Open now"]}>
            {groups.map(([label, g]) => {
              const f = g?.[period];
              return (
                <tr key={label}>
                  <td className="font-medium">
                    {label}
                    {f && label !== "Lloyd's" && f.underwriters > 0 && <span className="text-muted-foreground text-xs"> ({f.underwriters} companies)</span>}
                  </td>
                  {!g || !f ? (
                    <td colSpan={10} className="text-muted-foreground">
                      —
                    </td>
                  ) : (
                    <>
                      <td className="tabular-nums">{f.policies_written}</td>
                      <td className="tabular-nums">{fmtCr(f.premiums_earned_pence)}</td>
                      <td className="tabular-nums">{fmtCr(f.claims_paid_pence)}</td>
                      <td className={`tabular-nums ${f.net_pence < 0 ? "text-destructive" : ""}`}>{fmtCr(f.net_pence)}</td>
                      <td className="tabular-nums">{ratio(f.loss_ratio_bps)}</td>
                      <td className="tabular-nums">{ratio(f.return_on_cover_bps)}</td>
                      <td className="whitespace-nowrap tabular-nums">
                        {f.policies_settled_safe} / {f.policies_claimed_loss} / {f.policies_voided}
                      </td>
                      <td className="tabular-nums">{f.policies_with_claims}</td>
                      <td className="tabular-nums">{fmtCr(g.collateral_locked_pence)}</td>
                      <td className="tabular-nums">{g.open_policies}</td>
                    </>
                  )}
                </tr>
              );
            })}
          </Table>
          <p className="text-muted-foreground text-xs">
            Results count once a policy settles (safe, lost, void or lapsed), with every premium its slices earned and every claim they paid. Loss ratio = claims ÷
            premiums; return on cover = net ÷ the collateral locked. {period === "recent" ? `The window opened ${fmtDateTime(data.window_since)}; ` : ""}as of{" "}
            {fmtDateTime(data.as_of)}.
            {funds !== undefined &&
              ` Lloyd's funds ${fmtCr(funds)}: it locks at most ${fmtCr(Math.floor(funds * 0.1))} on one policy and ${fmtCr(Math.floor(funds * 0.2))} across the ships leaving one sea zone.`}
          </p>
        </div>
      )}
    </Panel>
  );
}

export default function InsurancePage() {
  const { portName } = useCatalog();
  const ourId = useCompanyId();
  const autopilot = useAutopilotShips();
  const [view, setView] = useState<View>("ours");
  const [marketStatus, setMarketStatus] = useState<"open" | "active">("open");
  const [selected, setSelected] = useState<S.InsurancePolicyListing | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [batchSlice, setBatchSlice] = useState("1000");
  const [failedId, setFailedId] = useState<string | null>(null);
  const pager = useCursor();
  const { data: clock } = usePoll(() => kibbGet<WorldClock>("/v1/world/clock"));
  const { data: ships, reload: reloadShips } = usePoll(() => kibbGet<ShipResult[]>("/v1/fleet/ships", { limit: 200 }), 15_000);
  const { data: player } = usePoll(() => dash.get<{ companies: Array<{ id: string; name: string }> }>("/api/kibb/companies"));
  // The game refuses underwriting any of the player's companies' policies, not just this one's.
  const playerIds = new Set([...(player?.companies ?? []).map((c) => c.id), ...(ourId ? [ourId] : [])]);
  const isMine = (companyId: string) => playerIds.has(companyId);

  const filter =
    view === "ours"
      ? { insured_company_id: ourId }
      : view === "underwriting"
        ? { underwriter_company_id: ourId }
        : { status: marketStatus };
  const { data: policies, error, reload } = usePoll(
    view !== "market" && !ourId ? null : () => kibbGet<S.InsurancePolicyListing[]>("/v1/insurance/list", { ...filter, cursor: pager.cursor, limit: PAGE_SIZE }),
    20_000,
    [view, marketStatus, ourId, pager.cursor],
  );
  const { data: slices, error: slicesError, reload: reloadSlices } = usePoll(
    view === "underwriting" && ourId ? () => loadOurSlices(ourId) : null,
    60_000,
    [view, ourId],
  );
  const reloadAll = () => {
    void reload();
    void reloadShips();
    if (view === "underwriting" && ourId) void reloadSlices();
  };
  const rows = (policies ?? []).filter((p) => view !== "market" || !isMine(p.insured_company_id));
  const laneFloors = useLaneFloors(view === "market" ? rows.map((p): [string, string] => [p.origin_port_id, p.dest_port_id]) : []);
  const ownCover = useOwnCover();
  const floorsOf = (p: S.InsurancePolicyListing) => laneFloors.get(laneKey(p.origin_port_id, p.dest_port_id));
  const current = selected ? (rows.find((p) => p.id === selected.id) ?? selected) : null;
  const shipName = (id: string) => ships?.find((s) => s.ship.id === id)?.ship.name;
  const batch = useAction<S.InsurancePolicyDetailResult[]>(() => {
    setPicked(new Set());
    reloadAll();
  });

  // Picks are per page: the batch is built from this page's rows only.
  useEffect(() => {
    setPicked(new Set());
    setFailedId(null);
  }, [pager.cursor]);

  function switchView(v: View) {
    setView(v);
    setSelected(null);
    setPicked(new Set());
    setFailedId(null);
    pager.reset();
  }

  function underwritePicked() {
    const items = batchItems;
    if (!confirm(`Lock ${fmtCr(batchRisk.collateral)} of collateral to underwrite ${items.length} policies?`)) return;
    setFailedId(null);
    void batch.run(async () => {
      try {
        return await postBatch<S.InsurancePolicyDetailResult[]>("/v1/insurance/underwrite-batch", { items });
      } catch (e) {
        const bad = e instanceof BatchError && e.batchIndex !== null ? rows.find((p) => p.id === items[e.batchIndex!]?.policy_id) : undefined;
        if (!bad) throw e;
        setFailedId(bad.id);
        throw new Error(
          `Nothing was underwritten: the policy on ship ${shortId(bad.ship_id)} (${portName(bad.origin_port_id)} → ${portName(bad.dest_port_id)}) was refused (${(e as Error).message.replace(/^Item \d+: /, "")}).`,
        );
      }
    });
  }

  // Each picked policy gets the batch slice, cut to what it has left (in 100s); a remainder under 500 is taken whole, anything else under 500 skipped.
  const s = num(batchSlice);
  const pickedRows = rows.filter((p) => picked.has(p.id));
  const batchItems = pickedRows
    .map((p) => {
      const left = 10_000 - p.covered_bps;
      const want = Number.isFinite(s) ? Math.floor(s / 100) * 100 : 0;
      return { policy_id: p.id, slice_bps: left < 500 ? (want > 0 ? left : 0) : Math.min(want, maxSliceFor(p.covered_bps)), left };
    })
    .filter((i) => sliceOk(i.slice_bps, i.left))
    .map(({ policy_id, slice_bps }) => ({ policy_id, slice_bps }));
  const batchRisk = batchItems.reduce(
    (t, i) => {
      const p = rows.find((x) => x.id === i.policy_id)!;
      const r = riskOf(p, i.slice_bps, floorsOf(p), ownCover);
      return {
        collateral: t.collateral + r.collateral,
        premium: t.premium + r.premium,
        maxHit: t.maxHit + r.maxHit,
        edge: t.edge + (r.edgePence ?? 0),
        unknown: t.unknown + (r.edgePence === null && floorsOf(p) !== null ? 1 : 0),
        failed: t.failed + (r.edgePence === null && floorsOf(p) === null ? 1 : 0),
      };
    },
    { collateral: 0, premium: 0, maxHit: 0, edge: 0, unknown: 0, failed: 0 },
  );

  const ourSlice = (p: S.InsurancePolicy) => slices?.byPolicy.get(p.id);
  const slicesKnown = !!slices && slices.readable > 0;
  const sliceTotals = rows.reduce(
    (t, p) => {
      const o = ourSlice(p);
      if (!o) return t;
      const live = p.status === "open" || p.status === "active";
      return {
        known: t.known + 1,
        locked: t.locked + (live ? o.collateral_locked_pence : 0),
        premium: t.premium + o.premium_share_pence,
        maxHit: t.maxHit + (live ? Math.floor((Math.max(0, p.insured_value_pence - p.hull_value_pence) * MAX_PARTIAL_SHARE * o.slice_bps) / 10_000) : 0),
      };
    },
    { known: 0, locked: 0, premium: 0, maxHit: 0 },
  );

  const head =
    view === "market"
      ? ["", "Ship", "Voyage", "Status", "Insured", "Cover", "Premium", "EL ≤", "Edge", "Lloyd's price", "Covered", "Age", "Lapses", ""]
      : view === "underwriting"
        ? ["Ship", "Voyage", "Status", "Insured", "Premium", "Covered", "Our slice", "Collateral pledged", "Premium share", "Lapses", ""]
        : ["Ship", "Voyage", "Status", "Insured", "Premium", "Lloyd's price", "Covered", "Lapses", ""];

  return (
    <div className="space-y-5 pb-8 sm:space-y-6">
      <PageHeader
        title="Insurance"
        subtitle="Lloyd's marine cover: insure a voyage, or underwrite other companies' and earn the premium."
        actions={
          <>
            <div className="w-full sm:w-96">
              <Segmented<View>
                value={view}
                onChange={switchView}
                options={[
                  { value: "ours", label: "Our policies" },
                  { value: "underwriting", label: "We underwrite" },
                  { value: "market", label: "Open market" },
                ]}
              />
            </div>
          </>
        }
      />

      <div className="grid items-start gap-4 xl:grid-cols-3">
        <Panel
          title={view === "ours" ? "Policies on our ships" : view === "underwriting" ? "Policies we hold slices of" : "Policies seeking cover"}
          className="xl:col-span-2"
          action={
            view === "market" && (
              <div className="w-full sm:w-28">
                <NativeSelect
                  value={marketStatus}
                  onChange={(e) => {
                    setMarketStatus(e.target.value as "open" | "active");
                    setPicked(new Set());
                    setFailedId(null);
                    pager.reset();
                  }}
                >
                  <option value="open">Open</option>
                  <option value="active">Active</option>
                </NativeSelect>
              </div>
            )
          }
        >
          <ErrorNote error={error} />
          {view === "underwriting" && (
            <div className="mb-4 space-y-2">
              <ErrorNote error={slicesError} />
              {!slices ? (
                !slicesError && <p className="text-muted-foreground text-xs">Reading our slices from the event log…</p>
              ) : slices.events === 0 ? (
                <p className="text-muted-foreground text-xs">No underwriting in the event log (it keeps 7 days), so our slices show —.</p>
              ) : !slicesKnown ? (
                <p className="text-muted-foreground text-xs">The underwriting events don&apos;t carry slice details, so our slice, collateral and premium share can&apos;t be shown.</p>
              ) : (
                <>
                  <Metrics
                    className="sm:grid-cols-4 xl:grid-cols-4"
                    items={[
                      { label: "Policies with our slice", value: `${sliceTotals.known} of ${rows.length}`, hint: "on this page" },
                      { label: "Collateral pledged", value: fmtCr(sliceTotals.locked), hint: "open and active on this page, as written: less any cover cuts or claims" },
                      { label: "Premium share", value: fmtCr(sliceTotals.premium), hint: "on this page" },
                      { label: "Max partial claims", value: fmtCr(sliceTotals.maxHit), hint: "one hit on each, this page" },
                    ]}
                  />
                  {sliceTotals.known < rows.length && (
                    <p className="text-muted-foreground text-xs">Slices written more than 7 days ago have left the event log and show —.</p>
                  )}
                </>
              )}
            </div>
          )}
          {!policies ? (
            !error && <Loading />
          ) : rows.length === 0 ? (
            <Empty>No policies.</Empty>
          ) : (
            <Table head={head}>
              {rows.map((p) => {
                const ours = p.insured_company_id === ourId;
                const mine = isMine(p.insured_company_id);
                const risk = view === "market" ? riskOf(p, 0, floorsOf(p), ownCover) : null;
                const o = view === "underwriting" && slicesKnown ? ourSlice(p) : undefined;
                return (
                  <tr key={p.id} className={p.id === failedId ? "bg-destructive/10" : current?.id === p.id ? "bg-accent" : undefined}>
                    {view === "market" && (
                      <td>
                        <input
                          type="checkbox"
                          checked={picked.has(p.id)}
                          onChange={(e) =>
                            setPicked((prev) => {
                              const next = new Set(prev);
                              if (e.target.checked) next.add(p.id);
                              else next.delete(p.id);
                              return next;
                            })
                          }
                        />
                      </td>
                    )}
                    <td>
                      {ours ? (
                        <Link href={`/fleet/${p.ship_id}`} className="font-medium hover:underline">{shipName(p.ship_id) ?? shortId(p.ship_id)}</Link>
                      ) : (
                        <span className="font-mono text-xs">{shortId(p.ship_id)}</span>
                      )}
                    </td>
                    <td className="text-xs">{portName(p.origin_port_id)} → {portName(p.dest_port_id)}</td>
                    <td><Badge variant={STATUS_VARIANT[p.status]} size="sm">{p.status.replace("_", " ")}</Badge></td>
                    <td className="tabular-nums">{fmtCr(p.insured_value_pence)}</td>
                    {view === "market" && <td className="whitespace-nowrap text-xs">{coverText(p)}</td>}
                    <td className="tabular-nums">{fmtBps(p.premium_bps)} <span className="text-muted-foreground text-xs">({fmtCr(p.total_premium_pence)})</span></td>
                    {view === "ours" && (
                      <td className="tabular-nums text-xs">
                        {typeof p.lloyds_min_premium_bps === "number" ? (
                          <span
                            title={`Lloyd's expected loss ≤ ${fmtBps(p.lloyds_expected_loss_bps ?? 0)}; its posted price is the hurdle it writes at, an hour or more after the policy is listed`}
                          >
                            {fmtBps(p.lloyds_min_premium_bps)}
                            <span className={p.premium_bps >= p.lloyds_min_premium_bps ? "text-success-foreground" : "text-muted-foreground"}>
                              {p.premium_bps >= p.lloyds_min_premium_bps ? " · Lloyd's fills" : " · players only"}
                            </span>
                          </span>
                        ) : (
                          "—"
                        )}
                      </td>
                    )}
                    {risk && (
                      <>
                        <td className="tabular-nums">
                          {risk.basis === "listing" || risk.basis === "policy" ? (
                            fmtBps(Math.round(risk.elMax ?? 0))
                          ) : floorsOf(p) === undefined || ownCover === undefined ? (
                            "…"
                          ) : risk.elMax === null ? (
                            "—"
                          ) : (
                            <span className="text-muted-foreground" title="From Lloyd's price on the lane's other open policies: other ships, only a guide">
                              ~{fmtBps(Math.round(risk.elMax))}
                            </span>
                          )}
                        </td>
                        <td className="tabular-nums"><EdgeText edge={risk.edge} /></td>
                        <td className="tabular-nums">
                          {typeof p.lloyds_min_premium_bps === "number" ? (
                            <span
                              className={p.premium_bps >= p.lloyds_min_premium_bps ? undefined : "text-muted-foreground"}
                              title={
                                p.premium_bps >= p.lloyds_min_premium_bps
                                  ? "The premium meets Lloyd's price: once the policy is a game hour old, Lloyd's writes what players leave (within its caps)"
                                  : "The premium is under Lloyd's price: only players will write it"
                              }
                            >
                              {fmtBps(p.lloyds_min_premium_bps)}
                            </span>
                          ) : (
                            "—"
                          )}
                        </td>
                      </>
                    )}
                    <td className="w-28">
                      <div className="text-xs tabular-nums">{fmtBps(p.covered_bps)}</div>
                      <Progress value={p.covered_bps} max={10_000} className="h-1.5" />
                    </td>
                    {view === "underwriting" && (
                      <>
                        <td className="tabular-nums">{o ? fmtBps(o.slice_bps) : "—"}</td>
                        <td className="tabular-nums">{o ? fmtCr(o.collateral_locked_pence) : "—"}</td>
                        <td className="tabular-nums">{o ? fmtCr(o.premium_share_pence) : "—"}</td>
                      </>
                    )}
                    {view === "market" && <td className="whitespace-nowrap text-xs">{fmtAgo(p.created_at).replace(/ ago$/, "")}</td>}
                    <td className="text-xs">{p.status === "open" || p.status === "active" ? fmtIn(p.expires_at) : fmtDateTime(p.updated_at)}</td>
                    <td className="text-right">
                      <Button size="sm" variant="outline" onClick={() => setSelected(p)}>
                        {!mine && (p.status === "open" || p.status === "active") ? "Underwrite" : "Details"}
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </Table>
          )}
          <Pager pager={pager} rows={policies} />
          {view === "market" && rows.length > 0 && (
            <p className="mt-3 text-muted-foreground text-xs">
              EL ≤: Lloyd&apos;s own estimate of the claim on each policy still open for underwriting (an upper bound: legs summed, rescues
              undercounted), so a slice earns at least the edge (premium − EL, the listing&apos;s margin). A listing without it (its ship sailed, or no
              route) falls back on its own cover by someone else, which implies EL ≤ premium − 25 (Lloyd&apos;s writes only at ≥ 1.25 × EL + 25, or EL + 25
              for a hull rated for every leg, so the smaller bounds both), or ~ for Lloyd&apos;s price on the lane&apos;s other policies: only a guide.{" "}
              {fmtBps(GOOD_EDGE)} or more is highlighted. Lloyd&apos;s price is its posted hurdle (1.25 × EL + 25, or EL + 25 when the hull is rated for
              the water of every leg): a policy whose premium meets it is written by Lloyd&apos;s for what players leave, once it is about a game hour old, so until
              then the pick is yours; one under it waits on players. The autopilot writes on Lloyd&apos;s listed estimate only (a listing without it is no longer open for underwriting).
            </p>
          )}

          {view === "market" && pickedRows.length > 0 && (
            <div className="mt-4 space-y-3 border-t pt-4">
              <div className="flex flex-wrap items-end gap-3">
                <Field label="Slice for each (bps)" className="w-full sm:w-40">
                  <Input type="number" min={100} step={100} value={batchSlice} onChange={(e) => setBatchSlice(e.target.value)} />
                </Field>
                <div className="text-muted-foreground text-xs">
                  {batchItems.length} of {pickedRows.length} picked can take it
                </div>
                <Button size="sm" disabled={batch.busy || batchItems.length === 0 || batchItems.length > 25} onClick={underwritePicked}>
                  {batch.busy ? "Underwriting…" : `Underwrite ${batchItems.length} (all or nothing)`}
                </Button>
              </div>
              {batchItems.length > 0 && (
                <Metrics
                  className="sm:grid-cols-4 xl:grid-cols-4"
                  items={[
                    { label: "Collateral locked", value: fmtCr(batchRisk.collateral), hint: "lost on sinkings" },
                    { label: "Premium earned", value: fmtCr(batchRisk.premium) },
                    { label: "Max partial claims", value: fmtCr(batchRisk.maxHit), hint: "one hit on each" },
                    {
                      label: "Edge",
                      value: fmtCr(batchRisk.edge),
                      hint:
                        batchRisk.unknown || batchRisk.failed
                          ? [
                              batchRisk.unknown ? `${batchRisk.unknown} without a loss bound left out` : "",
                              batchRisk.failed ? `${batchRisk.failed} whose lane couldn't be read left out` : "",
                            ]
                              .filter(Boolean)
                              .join("; ")
                          : "over the expected loss",
                    },
                  ]}
                />
              )}
              <ErrorNote error={batch.error} className="w-full" />
              {batchItems.length > 25 && <ErrorNote error="A batch takes at most 25 policies." className="w-full" />}
            </div>
          )}
          {batch.result && <p className="mt-2 text-sm">Underwrote {batch.result.length} policies.</p>}
        </Panel>

        <div className="space-y-4">
          {current && (
            <Panel title="Policy" action={<button type="button" className="text-muted-foreground text-xs hover:text-foreground" onClick={() => setSelected(null)}>Close</button>}>
              <Underwrite key={current.id} policy={current} ourId={ourId} mine={isMine(current.insured_company_id)} onDone={reloadAll} />
            </Panel>
          )}
          <Panel title="Insure a voyage">
            <CreatePolicy ships={ships} autopilot={autopilot} maxPhase={clock?.unlocked_phase ?? 1} onDone={reloadAll} />
          </Panel>
          <Panel title="How cover works">
            <ul className="list-disc space-y-1.5 pl-4 text-muted-foreground text-xs">
              <li>One policy per voyage, written in port or the roadstead. It binds at departure and is void (no claim ever) if the ship sails anywhere but the insured port.</li>
              <li>Sum insured ≤ hull rebuild quote + 150 Cr a gun + cargo aboard. Stores are not insurable. Cannons can&apos;t be removed while insured.</li>
              <li>Quote first: Lloyd&apos;s price for the very voyage, from the ship, its guns, the cargo, the season and any convoy. Offer less to draw player underwriters in the hour before Lloyd&apos;s looks, or the price to be sure of cover.</li>
              <li>Declare your whole cargo, and load nothing after the policy is written: if the hold draws more pirates than the declared cargo would, it is void when the ship sails (cargo_exceeds_declared).</li>
              <li>A sinking, or a capture by pirates, pays the full cover; a storm pays the lost share, capped at the share it took of the declared cargo (storms vary, and an ocean-rated hull rides them better); pirates who let the ship go pay what they seized of it, at most half (hull-only cover pays only on a total loss); a convoy rescue caps at 60%.</li>
              <li>Pirates go for the richest prizes and take the ship itself in 5–10% of interceptions (fewer the more guns face them), so rich or dangerous runs cost more to insure.</li>
              <li>Arrival closes it settled safe: collateral goes back to underwriters and unwritten premium to you. Insure each leg anew. A mutiny pays nothing.</li>
              <li>Lloyd&apos;s looks only at policies open about a game hour, every couple of game hours, and writes at the premium offered if it is ≥ ceil(1.25 × its expected loss) + 25 bps, or its expected loss + 25 when your hull is rated for the water of every leg (its price); it locks at most 10% of its funds on one policy and 20% per sea zone.</li>
              <li>Slices are steps of 100 bps from 500 up to what is uncovered; a remainder under 500 may be taken whole.</li>
              <li>A policy can&apos;t be withdrawn: one priced below Lloyd&apos;s price that no player writes just waits, and blocks a new one until the ship sails or it lapses.</li>
              <li>A policy still in port 15 game days after it was written lapses.</li>
            </ul>
          </Panel>
        </div>
      </div>

      <LloydsListPanel />
    </div>
  );
}
