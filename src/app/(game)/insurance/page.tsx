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
  capFrom,
  createPolicy,
  floorFor,
  impliedMaxEl,
  isHullOnly,
  laneKey,
  useLaneFloors,
  useOwnCover,
  type InsurableValue,
  type LaneFloors,
} from "@/components/kibb/insurance-common";
import { Field, PortSelect, ShipSelect } from "@/components/kibb/pickers";
import { AutopilotWarning, Checkbox, Pager, PAGE_SIZE, Segmented, num, shortId, useAutopilotShips, useCompanyId, useCursor } from "@/components/kibb/naval-common";
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

/** Edge over Lloyd's-implied expected loss worth highlighting (bps). */
const GOOD_EDGE = 150;

interface Risk {
  collateral: number;
  premium: number;
  /** Most one storm or pirate hit can cost the slice: 25% of declared cargo; 0 for hull-only cover. */
  maxHit: number;
  /** Lloyd's-implied ceiling on the expected loss (bps), null without cover to go on. */
  elMax: number | null;
  /** Where elMax comes from: the policy's own cover by others (a real bound), or the lane's cheapest (a guide). */
  basis: "policy" | "lane" | null;
  /** premium − elMax (bps). */
  edge: number | null;
  /** The edge in pence on the slice. */
  edgePence: number | null;
}

/** `own`: policies our companies hold slices of (their cover is ours, so it proves nothing). */
function riskOf(p: S.InsurancePolicy, sliceBps: number, floors: LaneFloors | null | undefined, own: Set<string> | undefined): Risk {
  // Cover written by someone else (in practice Lloyd's) means this very policy passed its test.
  const vetted = p.covered_bps > 0 && !!own && !own.has(p.id);
  const floor = floorFor(floors, isHullOnly(p));
  const basis = vetted ? "policy" : floor !== null ? "lane" : null;
  const elMax = basis === "policy" ? impliedMaxEl(p.premium_bps) : floor !== null ? impliedMaxEl(floor) : null;
  const edge = elMax === null ? null : p.premium_bps - elMax;
  const cargo = Math.max(0, p.insured_value_pence - p.hull_value_pence);
  return {
    collateral: Math.ceil((p.insured_value_pence * sliceBps) / 10_000),
    premium: Math.floor((p.total_premium_pence * sliceBps) / 10_000),
    maxHit: Math.floor((cargo * 0.25 * sliceBps) / 10_000),
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
  const act = useAction<S.InsurancePolicy>(onDone);

  const ship = ships?.find((s) => s.ship.id === shipId);
  const from = ship?.ship.current_port_id ?? "";
  const value = Math.round(num(valueCr) * 100);
  const bps = num(premium);
  const onAutopilot = !!shipId && autopilot.has(shipId);
  const valid = !!ship && !!dest && dest !== from && value > 0 && bps >= 10 && bps <= 3000;
  const floors = useLaneFloors(from && dest ? [[from, dest]] : []).get(laneKey(from, dest));
  // Cover type: from the cap once seen; an empty hold can only be hull-only; otherwise unknown.
  const hullOnly = cap && value > 0 ? value <= cap.hull_value_pence : ship && ship.cargo_used_tons <= 0 ? true : null;

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
        The fleet autopilot is sailing this ship and picks its own destinations: sailing anywhere but the insured port voids the policy, and its gun refits are
        refused while the ship is insured. Stop it on the dashboard first.
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
        <Field label="Sum insured (Cr)">
          <Input type="number" min={0.01} step={0.01} value={valueCr} onChange={(e) => setValueCr(e.target.value)} />
        </Field>
        <Field label="Premium (bps)">
          <Input type="number" min={10} max={3000} placeholder="10–3,000" value={premium} onChange={(e) => setPremium(e.target.value)} />
        </Field>
      </div>
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
          Policy open: {fmtCr(act.result.insured_value_pence)} on the voyage to {portName(act.result.dest_port_id)}, premium {fmtCr(act.result.total_premium_pence)}. Wait in port for underwriters.
        </p>
      )}
      <Button className="w-full" disabled={!valid || act.busy || (onAutopilot && !override)} onClick={submit}>
        {act.busy ? "Requesting…" : "Request policy"}
      </Button>
    </div>
  );
}

function Underwrite({ policy, ourId, mine, onDone }: { policy: S.InsurancePolicy; ourId: string | undefined; mine: boolean; onDone: () => void }) {
  const { portName } = useCatalog();
  const uncovered = 10_000 - policy.covered_bps;
  const maxSlice = Math.floor(uncovered / 100) * 100;
  const [slice, setSlice] = useState(String(Math.min(1000, maxSlice)));
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
        : s < 500
          ? "A slice is at least 500 bps (5%)."
          : s > maxSlice
            ? `Only ${maxSlice} bps are left uncovered.`
            : s % 100 !== 0
              ? "Slices go in steps of 100 bps."
              : null;
  const valid = !mine && why === null;

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
            "Lloyd's-implied EL ≤",
            risk.basis === "policy"
              ? `${fmtBps(Math.round(risk.elMax ?? 0))} (from its own cover)`
              : floors === undefined || own === undefined
                ? "…"
                : risk.basis === "lane"
                  ? `${fmtBps(Math.round(risk.elMax ?? 0))} (lane floor ${floor} bps: other ships, only a guide)`
                  : floors === null
                    ? "couldn't read past cover on this lane"
                    : `not covered yet, and no covered ${hullOnly ? "hull-only" : "with-cargo"} policy on this lane`,
          ],
          ["Edge", <EdgeText key="e" edge={risk.edge} />],
          ["Open for", fmtAgo(policy.created_at).replace(/ ago$/, "")],
          ["Lapses", fmtIn(policy.expires_at)],
        ]}
      />
      <Progress value={policy.covered_bps} max={10_000} />
      {mine ? (
        <p className="text-muted-foreground text-xs">
          {policy.insured_company_id === ourId ? "Your own policy" : "One of your other companies' policies"}: you can&apos;t underwrite it.
        </p>
      ) : maxSlice < 500 ? (
        <p className="text-muted-foreground text-xs">Less than 5% left uncovered: no slice can be written.</p>
      ) : (
        <>
          <Field label={`Slice (bps, 500..${maxSlice}, steps of 100)`}>
            <Input
              type="number"
              min={500}
              max={maxSlice}
              step={100}
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
              ["Max partial claim per hit", hullOnly ? "none: hull-only pays only on a sinking" : Number.isFinite(s) ? fmtCr(risk.maxHit) : "—"],
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
        A storm or pirate hit pays at most 25% of the declared cargo, shared by slice; a sinking takes the whole collateral. The implied bound comes from the
        cheapest policy of this cover type underwriters have covered on the lane.
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

export default function InsurancePage() {
  const { portName } = useCatalog();
  const ourId = useCompanyId();
  const autopilot = useAutopilotShips();
  const [view, setView] = useState<View>("ours");
  const [marketStatus, setMarketStatus] = useState<"open" | "active">("open");
  const [selected, setSelected] = useState<S.InsurancePolicy | null>(null);
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
    view !== "market" && !ourId ? null : () => kibbGet<S.InsurancePolicy[]>("/v1/insurance/list", { ...filter, cursor: pager.cursor, limit: PAGE_SIZE }),
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
  const floorsOf = (p: S.InsurancePolicy) => laneFloors.get(laneKey(p.origin_port_id, p.dest_port_id));
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

  // Each picked policy gets the batch slice, cut to what it has left (in 100s); under 500 is skipped.
  const s = num(batchSlice);
  const pickedRows = rows.filter((p) => picked.has(p.id));
  const batchItems = pickedRows
    .map((p) => ({ policy_id: p.id, slice_bps: Math.min(Number.isFinite(s) ? Math.floor(s / 100) * 100 : 0, Math.floor((10_000 - p.covered_bps) / 100) * 100) }))
    .filter((i) => i.slice_bps >= 500);
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
        maxHit: t.maxHit + (live ? Math.floor((Math.max(0, p.insured_value_pence - p.hull_value_pence) * 0.25 * o.slice_bps) / 10_000) : 0),
      };
    },
    { known: 0, locked: 0, premium: 0, maxHit: 0 },
  );

  const head =
    view === "market"
      ? ["", "Ship", "Voyage", "Status", "Insured", "Cover", "Premium", "EL ≤", "Edge", "Covered", "Age", "Lapses", ""]
      : view === "underwriting"
        ? ["Ship", "Voyage", "Status", "Insured", "Premium", "Covered", "Our slice", "Collateral pledged", "Premium share", "Lapses", ""]
        : ["Ship", "Voyage", "Status", "Insured", "Premium", "Covered", "Lapses", ""];

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
                    {risk && (
                      <>
                        <td className="tabular-nums">
                          {risk.basis === "policy" ? (
                            fmtBps(Math.round(risk.elMax ?? 0))
                          ) : floorsOf(p) === undefined || ownCover === undefined ? (
                            "…"
                          ) : risk.elMax === null ? (
                            "—"
                          ) : (
                            <span className="text-muted-foreground" title="From the lane's cheapest covered policy: other ships, only a guide">
                              ~{fmtBps(Math.round(risk.elMax))}
                            </span>
                          )}
                        </td>
                        <td className="tabular-nums"><EdgeText edge={risk.edge} /></td>
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
              EL ≤: Lloyd&apos;s writes a policy only if premium ≥ 1.25 × expected loss + 25 bps, so a policy it has covered implies EL ≤ (premium − 25) / 1.25.
              A policy already partly covered by someone else (not you) uses its own premium: a real bound if that was Lloyd&apos;s. Otherwise ~ marks the
              cheapest covered policy on the lane and cover type: other ships, guns and seasons, so only a guide (an uncovered policy past Lloyd&apos;s review
              was likely declined). Edge = premium − that bound; {fmtBps(GOOD_EDGE)} or more is highlighted. The autopilot only writes the first kind.
            </p>
          )}

          {view === "market" && pickedRows.length > 0 && (
            <div className="mt-4 space-y-3 border-t pt-4">
              <div className="flex flex-wrap items-end gap-3">
                <Field label="Slice for each (bps)" className="w-full sm:w-40">
                  <Input type="number" min={500} step={100} value={batchSlice} onChange={(e) => setBatchSlice(e.target.value)} />
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
                              batchRisk.unknown ? `${batchRisk.unknown} without cover history left out` : "",
                              batchRisk.failed ? `${batchRisk.failed} whose lane couldn't be read left out` : "",
                            ]
                              .filter(Boolean)
                              .join("; ")
                          : "over the implied EL",
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
              <li>A sinking pays the full cover; a storm or pirate loss pays the lost share, capped at 25% of declared cargo (hull-only cover pays only on a sinking); a convoy rescue caps at 60%.</li>
              <li>Arrival closes it settled safe: collateral goes back to underwriters and unwritten premium to you. Insure each leg anew. A mutiny pays nothing.</li>
              <li>Lloyd&apos;s writes only policies open about a game hour, every couple of game hours, if the premium ≥ 1.25 × its expected loss + 25 bps; it locks at most 10% of its funds on one policy and 20% per sea zone.</li>
              <li>A policy can&apos;t be withdrawn: one priced below what Lloyd&apos;s accepts on the lane just waits, and blocks a new one until the ship sails or it lapses.</li>
              <li>A policy still in port 15 game days after it was written lapses.</li>
            </ul>
          </Panel>
        </div>
      </div>
    </div>
  );
}
