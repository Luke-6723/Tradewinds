"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Empty, ErrorNote, KV, Loading, NativeSelect, PageHeader, Panel, Progress, Table } from "@/components/kibb/bits";
import { Field, PortSelect, ShipSelect } from "@/components/kibb/pickers";
import { AutopilotWarning, Pager, PAGE_SIZE, Segmented, num, shortId, useAutopilotShips, useCompanyId, useCursor } from "@/components/kibb/naval-common";
import { BatchError, postBatch } from "@/components/kibb/trade-common";
import { useAction } from "@/hooks/use-action";
import { useCatalog } from "@/hooks/use-catalog";
import { usePoll } from "@/hooks/use-poll";
import { DashboardApiError, kibbGet, kibbPost } from "@/lib/kibb/browser";
import { fmtBps, fmtCr, fmtDateTime, fmtIn } from "@/lib/kibb/format";
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

interface InsurableValue {
  requested_pence: number;
  max_insurable_pence: number;
  hull_value_pence: number;
}

/**
 * POST through the proxy keeping the whole problem body: an `exceeds_insurable_value` answer
 * carries the cap, which the usual helper drops.
 */
async function createPolicy(body: S.CreateInsurancePolicyRequest): Promise<S.InsurancePolicy> {
  const res = await fetch("/api/kibb/v1/insurance/create", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (res.ok) return data as S.InsurancePolicy;
  const p = (data && typeof data === "object" ? data : {}) as { code?: string; detail?: string; title?: string; insurable_value?: InsurableValue };
  if (res.status === 401 && p.code === "not_signed_in") window.location.href = "/login";
  else if (res.status === 401 && (p.code === "no_company_key" || p.code === "no_company")) window.location.href = "/companies";
  throw Object.assign(new DashboardApiError(res.status, p.code, p.detail ?? p.title ?? (typeof data === "string" && data ? data : res.statusText)), {
    insurableValue: p.insurable_value,
  });
}

function CreatePolicy({ ships, autopilot, maxPhase, onDone }: { ships: ShipResult[] | undefined; autopilot: Set<string>; maxPhase: number; onDone: () => void }) {
  const { portName } = useCatalog();
  const [shipId, setShipId] = useState("");
  const [dest, setDest] = useState("");
  const [valueCr, setValueCr] = useState("");
  const [premium, setPremium] = useState("200");
  const [cap, setCap] = useState<InsurableValue | null>(null);
  const act = useAction<S.InsurancePolicy>(onDone);

  const ship = ships?.find((s) => s.ship.id === shipId);
  const from = ship?.ship.current_port_id ?? "";
  const value = Math.round(num(valueCr) * 100);
  const bps = num(premium);
  const valid = !!ship && !!dest && dest !== from && value > 0 && bps >= 10 && bps <= 3000;

  useEffect(() => setCap(null), [shipId]);

  const capFrom = (e: unknown) => (e as { insurableValue?: InsurableValue }).insurableValue ?? null;

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
      <AutopilotWarning show={!!shipId && autopilot.has(shipId)}>
        The fleet autopilot is sailing this ship and picks its own destinations. A policy is void if the ship sails anywhere but the port you insure.
      </AutopilotWarning>
      <Field label="Insured voyage to">
        <PortSelect value={dest} onChange={setDest} placeholder="Choose a port…" maxPhase={maxPhase} filter={(p) => p !== from} />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Sum insured (Cr)">
          <Input type="number" min={1} step={1} value={valueCr} onChange={(e) => setValueCr(e.target.value)} />
        </Field>
        <Field label="Premium (bps)">
          <Input type="number" min={10} max={3000} value={premium} onChange={(e) => setPremium(e.target.value)} />
        </Field>
      </div>
      <p className="text-muted-foreground text-xs">
        The cap is the hull&apos;s rebuild quote plus 150 Cr a gun plus the cargo aboard. Ask for more and the game refuses with the cap, which then shows here.
      </p>
      {cap && (
        <KV
          rows={[
            ["Hull (rebuild quote + guns)", fmtCr(cap.hull_value_pence)],
            ["Cargo aboard", fmtCr(cap.max_insurable_pence - cap.hull_value_pence)],
            ["Most insurable", fmtCr(cap.max_insurable_pence)],
          ]}
        />
      )}
      <KV
        rows={[
          ["Premium escrowed", value > 0 && bps > 0 ? fmtCr(Math.ceil((value * bps) / 10_000)) : "—"],
          ["Rate", Number.isFinite(bps) ? fmtBps(bps) : "—"],
        ]}
      />
      <ErrorNote error={act.error} />
      {cap && act.error && (
        <Button size="sm" variant="outline" onClick={() => setValueCr(String(cap.max_insurable_pence / 100))}>
          Use the max ({fmtCr(cap.max_insurable_pence)})
        </Button>
      )}
      {act.result && (
        <p className="text-sm">
          Policy open: {fmtCr(act.result.insured_value_pence)} on the voyage to {portName(act.result.dest_port_id)}, premium {fmtCr(act.result.total_premium_pence)}. Wait in port for underwriters.
        </p>
      )}
      <Button className="w-full" disabled={!valid || act.busy} onClick={submit}>
        {act.busy ? "Requesting…" : "Request policy"}
      </Button>
    </div>
  );
}

function Underwrite({ policy, ourId, onDone }: { policy: S.InsurancePolicy; ourId: string | undefined; onDone: () => void }) {
  const { portName } = useCatalog();
  const uncovered = 10_000 - policy.covered_bps;
  const maxSlice = Math.floor(uncovered / 100) * 100;
  const [slice, setSlice] = useState(String(Math.min(1000, maxSlice)));
  const act = useAction<S.InsurancePolicyDetailResult>(onDone);
  const s = num(slice);
  const ours = policy.insured_company_id === ourId;
  const valid = !ours && (policy.status === "open" || policy.status === "active") && s >= 500 && s <= maxSlice && s % 100 === 0;

  return (
    <div className="space-y-3">
      <KV
        rows={[
          ["Voyage", `${portName(policy.origin_port_id)} → ${portName(policy.dest_port_id)}`],
          ["Sum insured", fmtCr(policy.insured_value_pence)],
          ["Hull / declared cargo", `${fmtCr(policy.hull_value_pence)} / ${fmtCr(Math.max(0, policy.insured_value_pence - policy.hull_value_pence))}`],
          ["Premium", `${fmtBps(policy.premium_bps)} = ${fmtCr(policy.total_premium_pence)}`],
          ["Covered", `${fmtBps(policy.covered_bps)} (${fmtBps(uncovered)} open)`],
          ["Lapses", fmtIn(policy.expires_at)],
        ]}
      />
      <Progress value={policy.covered_bps} max={10_000} />
      {ours ? (
        <p className="text-muted-foreground text-xs">Your own policy: you can&apos;t underwrite it.</p>
      ) : maxSlice < 500 ? (
        <p className="text-muted-foreground text-xs">Less than 5% left uncovered: no slice can be written.</p>
      ) : (
        <>
          <Field label={`Slice (bps, 500..${maxSlice}, steps of 100)`}>
            <Input type="number" min={500} max={maxSlice} step={100} value={slice} onChange={(e) => setSlice(e.target.value)} />
          </Field>
          <KV
            rows={[
              ["Collateral locked", Number.isFinite(s) ? fmtCr(Math.ceil((policy.insured_value_pence * s) / 10_000)) : "—"],
              ["Premium earned", Number.isFinite(s) ? fmtCr(Math.floor((policy.total_premium_pence * s) / 10_000)) : "—"],
            ]}
          />
          <Button
            className="w-full"
            disabled={!valid || act.busy}
            onClick={() => act.run(() => kibbPost<S.InsurancePolicyDetailResult>("/v1/insurance/underwrite", { policy_id: policy.id, slice_bps: Math.round(s) }))}
          >
            {act.busy ? "Underwriting…" : `Underwrite ${Number.isFinite(s) ? fmtBps(s) : ""}`}
          </Button>
        </>
      )}
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
  const reloadAll = () => {
    void reload();
    void reloadShips();
  };
  const rows = (policies ?? []).filter((p) => view !== "market" || p.insured_company_id !== ourId);
  const current = selected ? (rows.find((p) => p.id === selected.id) ?? selected) : null;
  const shipName = (id: string) => ships?.find((s) => s.ship.id === id)?.ship.name;
  const batch = useAction<S.InsurancePolicyDetailResult[]>(() => {
    setPicked(new Set());
    reloadAll();
  });

  function switchView(v: View) {
    setView(v);
    setSelected(null);
    setPicked(new Set());
    setFailedId(null);
    pager.reset();
  }

  function underwritePicked() {
    const items = batchItems;
    if (!confirm(`Lock ${fmtCr(batchCollateral)} of collateral to underwrite ${items.length} policies?`)) return;
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
  const batchItems = rows
    .filter((p) => picked.has(p.id))
    .map((p) => ({ policy_id: p.id, slice_bps: Math.min(Number.isFinite(s) ? Math.floor(s / 100) * 100 : 0, Math.floor((10_000 - p.covered_bps) / 100) * 100) }))
    .filter((i) => i.slice_bps >= 500);
  const batchCollateral = batchItems.reduce((n, i) => {
    const p = rows.find((x) => x.id === i.policy_id)!;
    return n + Math.ceil((p.insured_value_pence * i.slice_bps) / 10_000);
  }, 0);

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
          {!policies ? (
            !error && <Loading />
          ) : rows.length === 0 ? (
            <Empty>No policies.</Empty>
          ) : (
            <Table head={[...(view === "market" ? [""] : []), "Ship", "Voyage", "Status", "Insured", "Premium", "Covered", "Lapses", ""]}>
              {rows.map((p) => {
                const ours = p.insured_company_id === ourId;
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
                    <td className="tabular-nums">{fmtBps(p.premium_bps)} <span className="text-muted-foreground text-xs">({fmtCr(p.total_premium_pence)})</span></td>
                    <td className="w-28">
                      <div className="text-xs tabular-nums">{fmtBps(p.covered_bps)}</div>
                      <Progress value={p.covered_bps} max={10_000} className="h-1.5" />
                    </td>
                    <td className="text-xs">{p.status === "open" || p.status === "active" ? fmtIn(p.expires_at) : fmtDateTime(p.updated_at)}</td>
                    <td className="text-right">
                      <Button size="sm" variant="outline" onClick={() => setSelected(p)}>
                        {!ours && (p.status === "open" || p.status === "active") ? "Underwrite" : "Details"}
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </Table>
          )}
          <Pager pager={pager} rows={policies} />

          {view === "market" && picked.size > 0 && (
            <div className="mt-4 flex flex-wrap items-end gap-3 border-t pt-4">
              <Field label="Slice for each (bps)" className="w-full sm:w-40">
                <Input type="number" min={500} step={100} value={batchSlice} onChange={(e) => setBatchSlice(e.target.value)} />
              </Field>
              <div className="text-muted-foreground text-xs">
                {batchItems.length} of {picked.size} can take it · collateral {fmtCr(batchCollateral)}
              </div>
              <Button
                size="sm"
                disabled={batch.busy || batchItems.length === 0 || batchItems.length > 25}
                onClick={underwritePicked}
              >
                {batch.busy ? "Underwriting…" : `Underwrite ${batchItems.length} (all or nothing)`}
              </Button>
              <ErrorNote error={batch.error} className="w-full" />
              {batchItems.length > 25 && <ErrorNote error="A batch takes at most 25 policies." className="w-full" />}
            </div>
          )}
          {batch.result && <p className="mt-2 text-sm">Underwrote {batch.result.length} policies.</p>}
        </Panel>

        <div className="space-y-4">
          {current && (
            <Panel title="Policy" action={<button type="button" className="text-muted-foreground text-xs hover:text-foreground" onClick={() => setSelected(null)}>Close</button>}>
              <Underwrite key={current.id} policy={current} ourId={ourId} onDone={reloadAll} />
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
              <li>A policy still in port 15 game days after it was written lapses.</li>
            </ul>
          </Panel>
        </div>
      </div>
    </div>
  );
}
