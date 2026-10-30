"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsPanel, TabsTab } from "@/components/ui/tabs";
import { Empty, ErrorNote, KV, Loading, Metrics, NativeSelect, PageHeader, Panel, Progress, Table } from "@/components/kibb/bits";
import {
  CashLine,
  CompanyLabel,
  WarnBox,
  crToPence,
  firstProblem,
  num,
  regionName,
  shortId,
  useAppraisal,
  useCompanyDirectory,
  useLearnCompanies,
  useRegionOf,
  useShips,
  useStock,
  useVaults,
} from "@/components/kibb/finance-common";
import { Segmented, realTime, useAutopilotShips, useCompanyId, useOurCompanyIds, useTimeScale } from "@/components/kibb/naval-common";
import { Field, PortSelect, ShipSelect } from "@/components/kibb/pickers";
import { fetchAll } from "@/components/kibb/trade-common";
import { useAction } from "@/hooks/use-action";
import { useCatalog } from "@/hooks/use-catalog";
import { usePoll } from "@/hooks/use-poll";
import { kibbGet, kibbPost } from "@/lib/kibb/browser";
import { fmtCr, fmtDateTime, fmtIn, fmtTons } from "@/lib/kibb/format";
import type * as S from "@/lib/kibb/schema";
import type { CompanyProfile, ContractListing, ShipResult, WorldClock } from "@/lib/kibb/types";

type Vaults = ReturnType<typeof useVaults>;
type Stock = S.PortWarehouseResult[] | undefined;
type Side = "offer" | "request";

// ── Rules (guide 3.19) ────────────────────────────────────────────────────────

const SLOTS: S.Slot[] = ["hull", "sails", "rigging", "hold", "armament", "helm"];
const GRADES = [1, 2, 3] as const;

/**
 * Licence contracts carry 1..=1,000 units and stay open 6..=1,440 game hours (default 240); up to 10 components are made at
 * once; fitting costs 4% of the ship's rebuild value. A project is abandoned after 3 unpaid game days in a row; a home vault
 * overdrawn after patent upkeep for 5 game days lapses the newest patent to public.
 */
const RND = { unitsMax: 1_000, hoursMin: 6, hoursMax: 1_440, hoursDefault: 240, makeMax: 10, fitFeeBps: 400, unpaidAbandonDays: 3, arrearsLapseDays: 5 } as const;

/** The four stages of a project (`stage` 1..=4), and what moves each. */
const STAGES = [
  { name: "Drawings", text: "Time alone." },
  { name: "Prototype", text: "Waits for the prototype materials in your warehouse at any yard: they are taken the first game day they are all there." },
  { name: "Sea trials", text: "A game day counts only when the trial ship completes a leg." },
  { name: "Admiralty board", text: "Time alone." },
];

/** Which completed legs of the trial ship count in sea trials, by grade. */
const TRIAL_WATER: Record<number, string> = {
  1: "any completed leg",
  2: "a leg ending in regional or rougher water",
  3: "a leg ending in oceanic water",
};

const qtyText = (q: number) => fmtTons(q, Number.isInteger(q) ? 0 : 2);

/** "3 t Timber, 1 t Iron" for a list of materials. */
function useMaterialText() {
  const { goodName } = useCatalog();
  return (lines: S.MaterialLine[] | null | undefined) =>
    lines?.length ? lines.map((m) => `${qtyText(m.quantity)} ${goodName(m.commodity_id)}`).join(", ") : "nothing";
}

/** Free tons of a good in our warehouse at a port (less what resting asks and listings lock). */
function freeAt(stock: Stock, port: string, good: string): number {
  const inv = stock?.find((w) => w.port_id === port)?.inventory.find((i) => i.commodity_id === good);
  return inv ? Math.max(0, inv.quantity - inv.locked_quantity) : 0;
}

/** What our warehouse at a port lacks of `lines` taken `times` over. */
function shortfall(stock: Stock, port: string, lines: S.MaterialLine[], times = 1): S.MaterialLine[] {
  return lines
    .map((m) => ({ commodity_id: m.commodity_id, quantity: m.quantity * times - freeAt(stock, port, m.commodity_id) }))
    .filter((m) => m.quantity > 1e-9);
}

/** Yards where our warehouse holds every one of `lines`, and otherwise the yard that comes closest. */
function yardsHolding(stock: Stock, lines: S.MaterialLine[], isYard: (port: string) => boolean) {
  const yards = (stock ?? []).map((w) => w.port_id).filter(isYard);
  const ready = yards.filter((p) => shortfall(stock, p, lines).length === 0);
  const lack = (p: string) => shortfall(stock, p, lines).reduce((n, m) => n + m.quantity, 0);
  const best = ready.length ? undefined : yards.sort((a, b) => lack(a) - lack(b))[0];
  return { ready, best, bestShort: best ? shortfall(stock, best, lines) : [] };
}

/** A licence contract's money: the price of `units` (per unit) or of the whole lot (total). */
const priceOf = (t: Pick<S.LicenceTerms, "price_basis" | "price_pence">, units: number) => (t.price_basis === "total" ? t.price_pence : t.price_pence * units);

const priceText = (t: Pick<S.LicenceTerms, "price_basis" | "price_pence">) => `${fmtCr(t.price_pence, 2)} ${t.price_basis === "per_unit" ? "a unit" : "the lot"}`;

// ── Small pieces ──────────────────────────────────────────────────────────────

function SlotGrade({ slot, grade }: { slot: string; grade: number }) {
  return (
    <span className="whitespace-nowrap">
      <span className="capitalize">{slot}</span> <span className="text-muted-foreground text-xs">· grade {grade}</span>
    </span>
  );
}

/** A design's effect words (honest directions, never sizes). */
function Effects({ effects }: { effects: string[] }) {
  if (!effects.length) return <span className="text-muted-foreground">—</span>;
  return (
    <span className="inline-flex flex-wrap gap-1">
      {effects.map((e, i) => (
        <Badge key={i} variant="outline" size="sm">
          {e}
        </Badge>
      ))}
    </span>
  );
}

function PatentStatus({ status }: { status: string }) {
  return (
    <Badge variant={status === "held" ? "info" : "secondary"} size="sm">
      {status}
    </Badge>
  );
}

// ── Research ──────────────────────────────────────────────────────────────────

function ProjectCard({
  project,
  companyId,
  ships,
  stock,
  register,
  isYard,
  onDone,
}: {
  project: S.ProjectView;
  companyId: string | undefined;
  ships: ShipResult[] | undefined;
  stock: Stock;
  register: S.PatentView[] | undefined;
  /** Null until the catalog has loaded. */
  isYard: ((port: string) => boolean) | null;
  onDone: () => void;
}) {
  const { portName } = useCatalog();
  const mat = useMaterialText();
  const autopilot = useAutopilotShips();
  const abandon = useAction<S.ProjectView>(onDone);
  const swap = useAction<S.ProjectView>(onDone);
  const [trial, setTrial] = useState("");
  const p = project;
  const ours = p.company_id === companyId;
  const active = p.status === "active";
  const shipName = (id: string | null | undefined) => (id ? (ships?.find((r) => r.ship.id === id)?.ship.name ?? shortId(id)) : "—");
  const granted = p.granted_component_id ? register?.find((x) => x.component_id === p.granted_component_id) : undefined;
  // Where the prototype materials lie (only once our warehouses and the yards are known).
  const proto = active && !p.prototype_consumed && p.prototype_materials.length && stock && isYard ? yardsHolding(stock, p.prototype_materials, isYard) : null;
  const stageIdx = Math.min(Math.max(p.stage, 1), 4) - 1;
  const swapWhy = firstProblem([
    [!!trial, "Choose the new trial ship."],
    [trial !== p.trial_ship_id, "That is the trial ship already."],
  ]);

  function doSwap() {
    if (
      !confirm(
        `Name ${shipName(trial)} the trial ship instead of ${shipName(p.trial_ship_id)}? A project may swap only once. From then on only ${shipName(trial)}'s completed legs count in sea trials (${TRIAL_WATER[p.grade] ?? "a completed leg"}).`,
      )
    )
      return;
    void swap.run(() => kibbPost<S.ProjectView>("/v1/rnd/trial-ship", { trial_ship_id: trial }));
  }

  function doAbandon() {
    if (
      !confirm(
        `Abandon the ${p.slot} grade ${p.grade} project? Nothing is refunded (the ${fmtCr(p.start_fee_pence)} start fee and the ${fmtCr(p.upkeep_paid_pence)} of upkeep paid are gone), no cooldown starts, and the design goes back to the pool unrevealed. This can't be undone.`,
      )
    )
      return;
    void abandon.run(() => kibbPost<S.ProjectView>("/v1/rnd/abandon", {}));
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={active ? "info" : p.status === "granted" ? "success" : "outline"} size="sm">
          {p.status}
        </Badge>
        <span className="font-medium">
          <SlotGrade slot={p.slot} grade={p.grade} />
        </span>
        {!ours && (
          <Badge variant="secondary" size="sm" title="One project at a time per player, across your own and linked companies">
            another of your companies
          </Badge>
        )}
      </div>
      {active && (
        <div className="space-y-2">
          <ol className="grid grid-cols-2 gap-1 sm:grid-cols-4">
            {STAGES.map((s, i) => (
              <li
                key={s.name}
                className={`rounded-md border px-2 py-1.5 text-xs ${i === stageIdx ? "border-primary bg-primary/5 font-medium" : i < stageIdx ? "text-muted-foreground line-through" : "text-muted-foreground"}`}
              >
                {i + 1}. {s.name}
              </li>
            ))}
          </ol>
          <div className="flex items-center justify-between gap-2 text-xs">
            <span>
              {p.stage_name || STAGES[stageIdx].name}: {p.stage_points} of {p.stage_points_required} points
            </span>
            <span className="text-muted-foreground">{STAGES[stageIdx].text}</span>
          </div>
          <Progress value={p.stage_points} max={p.stage_points_required} />
        </div>
      )}
      {active && p.unpaid_days > 0 && (
        <WarnBox tone="error">
          The upkeep has gone unpaid {p.unpaid_days} game day{p.unpaid_days === 1 ? "" : "s"} in a row: progress is paused, and at {RND.unpaidAbandonDays} the project
          is abandoned. Put cash in your home vault.
        </WarnBox>
      )}
      <KV
        rows={[
          ["Started", fmtDateTime(p.started_at)],
          ["Start fee", fmtCr(p.start_fee_pence)],
          ["Upkeep", `${fmtCr(p.upkeep_per_game_day_pence)} a game day (${fmtCr(p.upkeep_paid_pence)} paid so far)`],
          ["Failed reviews", p.failed_reviews],
          [
            "Trial ship",
            p.trial_ship_id && ships?.some((r) => r.ship.id === p.trial_ship_id) ? (
              <Link key="t" href={`/fleet/${p.trial_ship_id}`} className="hover:underline">
                {shipName(p.trial_ship_id)}
              </Link>
            ) : (
              shipName(p.trial_ship_id)
            ),
          ],
          ["Sea trials count", TRIAL_WATER[p.grade] ?? "a completed leg"],
          ["Prototype materials", mat(p.prototype_materials)],
          ["Prototype", p.prototype_consumed ? `built${p.prototype_port_id ? ` at ${portName(p.prototype_port_id)}` : ""}` : "not yet"],
          ...(p.closed_at ? ([["Closed", fmtDateTime(p.closed_at)]] as Array<[string, string]>) : []),
        ]}
      />
      {proto &&
        (proto.ready.length ? (
          <WarnBox tone="info">
            The prototype materials are all in your warehouse at {proto.ready.map(portName).join(", ")}: they are taken when the project reaches the prototype stage.
          </WarnBox>
        ) : (
          <WarnBox>
            No yard warehouse of yours holds all the prototype materials yet ({mat(p.prototype_materials)}).
            {proto.best ? ` Closest: ${portName(proto.best)}, short of ${mat(proto.bestShort)}.` : " You lease no warehouse at a yard."} The prototype stage waits for them
            (upkeep still runs).
          </WarnBox>
        ))}
      {p.status === "granted" && (
        <WarnBox tone="info">
          Patent granted:{" "}
          {granted ? (
            <>
              <span className="font-medium">{granted.name}</span> ({granted.effects.join(", ") || "no effects listed"}).
            </>
          ) : (
            `design ${shortId(p.granted_component_id)}.`
          )}{" "}
          Its upkeep is now charged every game day: see the Patents tab.
        </WarnBox>
      )}
      {p.status === "abandoned" && p.abandon_reason && <p className="text-muted-foreground text-sm">Abandoned: {p.abandon_reason.replace(/_/g, " ")}.</p>}
      {active && ours && (
        <>
          {p.trial_ship_swap_available ? (
            <div className="space-y-2">
              <Field label="Swap the trial ship (once per project)">
                <div className="flex gap-2">
                  <ShipSelect ships={ships} value={trial} onChange={setTrial} placeholder="Choose a ship…" filter={(r) => r.ship.id !== p.trial_ship_id} />
                  <Button variant="outline" disabled={!!swapWhy || swap.busy} onClick={doSwap}>
                    {swap.busy ? "Swapping…" : "Swap"}
                  </Button>
                </div>
              </Field>
              {trial && autopilot.has(trial) && (
                <p className="text-muted-foreground text-xs">The autopilot sails this ship on its own routes: its legs count only when they end in the right water.</p>
              )}
              <ErrorNote error={swap.error} />
            </div>
          ) : (
            <p className="text-muted-foreground text-xs">The trial ship has already been swapped once on this project.</p>
          )}
          <Button variant="destructive" className="w-full" disabled={abandon.busy} onClick={doAbandon}>
            {abandon.busy ? "Abandoning…" : "Abandon the project"}
          </Button>
          <ErrorNote error={abandon.error} />
        </>
      )}
      {active && !ours && <p className="text-muted-foreground text-sm">Manage it from the company that runs it.</p>}
    </div>
  );
}

function StartForm({
  status,
  pool,
  ships,
  homeRegion,
  vaults,
  slot,
  grade,
  onSlot,
  onGrade,
  onDone,
}: {
  status: S.RndStatus;
  pool: S.PoolEntry[] | undefined;
  ships: ShipResult[] | undefined;
  homeRegion: string | null;
  vaults: Vaults;
  slot: S.Slot | "";
  grade: number;
  onSlot: (s: S.Slot | "") => void;
  onGrade: (g: number) => void;
  onDone: () => void;
}) {
  const timeScale = useTimeScale();
  const [trial, setTrial] = useState("");
  const act = useAction<S.ProjectView>(onDone);
  const entry = pool?.find((e) => e.slot === slot && e.grade === grade);
  const cash = vaults.cash(homeRegion);
  const fee = status.start_fee_pence;
  const trialName = ships?.find((r) => r.ship.id === trial)?.ship.name;
  const coolDays = status.cooldown_ends_game_day && status.cooldown_ends_game_day > status.current_game_day ? status.cooldown_ends_game_day - status.current_game_day : 0;
  const why = firstProblem([
    [status.can_start, status.cannot_start_reason ? `You can't start a project now: ${status.cannot_start_reason.replace(/_/g, " ")}.` : "You can't start a project now."],
    [!!slot, "Choose a slot."],
    [!entry || entry.released, `Grade ${grade} opens with Phase ${grade}.`],
    [!entry || entry.free > 0, "No designs are left free in that slot and grade."],
    [!!trial, "Choose the trial ship."],
    [cash === undefined || cash >= fee, `Only ${fmtCr(cash)} in your ${regionName(homeRegion)} vault for the ${fmtCr(fee)} start fee.`],
  ]);

  function submit() {
    if (
      !confirm(
        `Start research on the ${slot} slot, grade ${grade}?\n\nThe ${fmtCr(fee)} start fee is paid now from your ${regionName(homeRegion)} vault and is never refunded, and ${fmtCr(status.upkeep_per_game_day_pence)} of upkeep is charged every game day the project is live. You choose a slot and grade, not a design: the Admiralty assigns one of the ${entry?.free ?? "free"} free designs there at random, and you learn which only when the patent is granted. Most are worth having, some trade one strength for a weakness, and a few disappoint.\n\nThe prototype stage takes materials (shown once it starts) from your warehouse at any yard; sea trials count only ${trialName ?? "the trial ship"}'s completed legs (${TRIAL_WATER[grade]}). Each stage ends in a review that can fail. Expect two to three real days.`,
      )
    )
      return;
    void act.run(() => kibbPost<S.ProjectView>("/v1/rnd/start", { slot, grade, trial_ship_id: trial }));
  }

  return (
    <div className="space-y-3">
      <KV
        rows={[
          [
            "Your player's net worth",
            <span key="nw" className={status.player_net_worth_pence < status.entry_net_worth_pence ? "text-destructive" : undefined}>
              {fmtCr(status.player_net_worth_pence)} (needs {fmtCr(status.entry_net_worth_pence)})
            </span>,
          ],
          ["Start fee", `${fmtCr(fee)}, never refunded`],
          ["Upkeep while live", `${fmtCr(status.upkeep_per_game_day_pence)} a game day`],
          ["Cooldown", coolDays ? `until game day ${status.cooldown_ends_game_day} (${coolDays} game days, ${realTime(coolDays * 24 * 60, timeScale)})` : "none"],
        ]}
      />
      {!status.can_start && <WarnBox>{status.cannot_start_reason ? status.cannot_start_reason.replace(/_/g, " ") : "You can't start a project now."}</WarnBox>}
      <div className="grid grid-cols-2 gap-3">
        <Field label="Slot">
          <NativeSelect value={slot} onChange={(e) => onSlot(e.target.value as S.Slot | "")}>
            <option value="">Choose…</option>
            {SLOTS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field label="Grade">
          <NativeSelect value={String(grade)} onChange={(e) => onGrade(Number(e.target.value))}>
            {GRADES.map((g) => {
              const e = slot ? pool?.find((x) => x.slot === slot && x.grade === g) : undefined;
              return (
                <option key={g} value={g}>
                  Grade {g}
                  {e ? (e.released ? ` · ${e.free} free · ${e.researching} researching` : ` · opens with Phase ${g}`) : ""}
                </option>
              );
            })}
          </NativeSelect>
        </Field>
      </div>
      <Field label="Trial ship (her completed legs count in sea trials)">
        <ShipSelect ships={ships} value={trial} onChange={setTrial} placeholder="Choose a ship…" />
      </Field>
      <p className="text-muted-foreground text-xs">
        Sea trials at grade {grade} count {TRIAL_WATER[grade]}. Only this one ship counts, so a bigger fleet doesn&apos;t help; you may name another once.
      </p>
      <CashLine region={homeRegion} cash={cash} need={fee} />
      <ErrorNote error={act.error ?? (slot || trial ? why : null)} />
      {act.result && <p className="text-sm">Started: {act.result.stage_name}, {act.result.stage_points_required} points to the first review.</p>}
      <Button className="w-full" disabled={!!why || act.busy} onClick={submit}>
        {act.busy ? "Starting…" : "Start research"}
      </Button>
    </div>
  );
}

function PoolPanel({
  pool,
  error,
  slot,
  grade,
  onPick,
}: {
  pool: S.PoolEntry[] | undefined;
  error: Error | null;
  slot: S.Slot | "";
  grade: number;
  onPick: (slot: S.Slot, grade: number) => void;
}) {
  const cell = (s: S.Slot, g: number) => pool?.find((e) => e.slot === s && e.grade === g);
  return (
    <Panel title="The pool">
      <ErrorNote error={error} />
      {!pool ? (
        !error && <Loading />
      ) : (
        <Table head={["Slot", ...GRADES.map((g) => `Grade ${g}`)]}>
          {SLOTS.map((s) => (
            <tr key={s}>
              <td className="font-medium capitalize">{s}</td>
              {GRADES.map((g) => {
                const e = cell(s, g);
                return (
                  <td key={g}>
                    {!e ? (
                      <span className="text-muted-foreground">—</span>
                    ) : !e.released ? (
                      <span className="text-muted-foreground text-xs">opens with Phase {g}</span>
                    ) : (
                      <Button
                        size="sm"
                        variant={slot === s && grade === g ? "default" : "outline"}
                        disabled={e.free === 0}
                        title={e.free === 0 ? "Every design here is granted or being researched" : "Pick this slot and grade to start"}
                        onClick={() => onPick(s, g)}
                      >
                        {e.free} free{e.researching ? ` · ${e.researching} researching` : ""}
                      </Button>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </Table>
      )}
      <p className="mt-3 text-muted-foreground text-xs">
        For each slot and grade: designs still free to draw, and how many houses are researching there now. The designs themselves are never listed. Grade 1 is open
        from the start, grade 2 opens with Phase 2 and grade 3 with Phase 3.
      </p>
    </Panel>
  );
}

// ── Patents ───────────────────────────────────────────────────────────────────

function RegisterPanel({
  register,
  error,
  companyId,
  ourIds,
  onLicence,
  onMake,
}: {
  register: S.PatentView[] | undefined;
  error: Error | null;
  companyId: string | undefined;
  ourIds: Set<string>;
  onLicence: (side: Side, componentId: string) => void;
  onMake: (componentId: string) => void;
}) {
  const [slot, setSlot] = useState("");
  const [grade, setGrade] = useState("");
  const [status, setStatus] = useState("");
  const [holder, setHolder] = useState("");
  const [q, setQ] = useState("");
  const needle = q.trim().toLowerCase();
  const rows = (register ?? [])
    .filter((p) => !slot || p.slot === slot)
    .filter((p) => !grade || p.grade === Number(grade))
    .filter((p) => !status || p.status === status)
    .filter((p) => !holder || (holder === "ours" ? p.holder_company_id === companyId : p.holder_company_id !== companyId))
    .filter((p) => !needle || p.name.toLowerCase().includes(needle) || p.effects.some((e) => e.toLowerCase().includes(needle)) || (p.holder_company_name ?? "").toLowerCase().includes(needle))
    .sort((a, b) => Date.parse(b.granted_at) - Date.parse(a.granted_at));
  return (
    <Panel title="Patent register">
      <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-5">
        <NativeSelect value={slot} onChange={(e) => setSlot(e.target.value)}>
          <option value="">Any slot</option>
          {SLOTS.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </NativeSelect>
        <NativeSelect value={grade} onChange={(e) => setGrade(e.target.value)}>
          <option value="">Any grade</option>
          {GRADES.map((g) => (
            <option key={g} value={g}>
              Grade {g}
            </option>
          ))}
        </NativeSelect>
        <NativeSelect value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">Held or public</option>
          <option value="held">Held</option>
          <option value="public">Public</option>
        </NativeSelect>
        <NativeSelect value={holder} onChange={(e) => setHolder(e.target.value)}>
          <option value="">Any holder</option>
          <option value="ours">Yours</option>
          <option value="others">Others&apos;</option>
        </NativeSelect>
        <Input className="col-span-2 sm:col-span-1" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, effect, holder…" />
      </div>
      <ErrorNote error={error} />
      {!register ? (
        !error && <Loading />
      ) : rows.length === 0 ? (
        <Empty>{register.length ? "No designs match." : "No patents granted yet."}</Empty>
      ) : (
        <Table head={["Design", "Slot", "Effects", "Holder", "Status", "Granted", ""]}>
          {rows.map((p) => {
            const ours = p.holder_company_id === companyId;
            return (
              <tr key={p.component_id}>
                <td className="font-medium">{p.name}</td>
                <td>
                  <SlotGrade slot={p.slot} grade={p.grade} />
                </td>
                <td className="max-w-64">
                  <Effects effects={p.effects} />
                </td>
                <td>{p.holder_company_id ? <CompanyLabel id={p.holder_company_id} companyId={companyId} ourIds={ourIds} /> : (p.holder_company_name ?? "—")}</td>
                <td>
                  <span className="inline-flex flex-col gap-0.5">
                    <PatentStatus status={p.status} />
                    {p.status === "public" && (p.public_reason || p.made_public_at) && (
                      <span className="text-muted-foreground text-xs">
                        {p.public_reason ? p.public_reason.replace(/_/g, " ") : ""}
                        {p.made_public_at ? ` ${fmtDateTime(p.made_public_at)}` : ""}
                      </span>
                    )}
                  </span>
                </td>
                <td className="whitespace-nowrap text-muted-foreground text-xs">{fmtDateTime(p.granted_at)}</td>
                <td className="text-right">
                  {p.status === "public" ? (
                    <Button size="sm" variant="outline" onClick={() => onMake(p.component_id)} title="Anyone may make a public design, with no licence">
                      Make
                    </Button>
                  ) : ours ? (
                    <Button size="sm" variant="outline" onClick={() => onLicence("offer", p.component_id)}>
                      Offer units
                    </Button>
                  ) : (
                    <Button size="sm" variant="outline" onClick={() => onLicence("request", p.component_id)}>
                      Ask for units
                    </Button>
                  )}
                </td>
              </tr>
            );
          })}
        </Table>
      )}
      <p className="mt-3 text-muted-foreground text-xs">
        Every design granted this season, with what it does in words and who holds it. The holder makes it freely; everyone else needs a licence unit for each
        component, until it goes public. Patents last for the season.
        {register && rows.length !== register.length ? ` Showing ${rows.length} of ${register.length}.` : ""}
      </p>
    </Panel>
  );
}

function OurPatentsPanel({
  patents,
  error,
  onOffer,
  onMake,
  onDone,
}: {
  patents: S.OwnPatentView[] | undefined;
  error: Error | null;
  onOffer: (componentId: string) => void;
  onMake: (componentId: string) => void;
  onDone: () => void;
}) {
  const act = useAction<S.PatentView>(onDone);
  const held = (patents ?? []).filter((p) => p.status === "held");
  const upkeep = held.reduce((n, p) => n + p.upkeep_per_game_day_pence, 0);
  const arrears = Math.max(0, ...(patents ?? []).map((p) => p.arrears_days));

  function makePublic(p: S.OwnPatentView) {
    if (
      !confirm(
        `Give up your patent on ${p.name} (${p.slot}, grade ${p.grade}) for good?\n\nIts upkeep of ${fmtCr(p.upkeep_per_game_day_pence)} a game day stops, and anyone may make it from then on with no licence. Your open licence contracts for it close and their requests are refunded; units already sold are simply no longer needed. This can't be undone.`,
      )
    )
      return;
    void act.run(() => kibbPost<S.PatentView>("/v1/rnd/make-public", { component_id: p.component_id }));
  }

  return (
    <Panel title="Your patents" action={held.length > 0 && <span className="text-muted-foreground text-xs">{fmtCr(upkeep)} a game day in all</span>}>
      <ErrorNote error={error} />
      <ErrorNote error={act.error} className="mb-3" />
      {arrears > 0 && (
        <div className="mb-3">
          <WarnBox tone="error">
            Your home vault has stayed overdrawn after patent upkeep for {arrears} game day{arrears === 1 ? "" : "s"}. At {RND.arrearsLapseDays} your newest patent
            lapses to public, then another each further day. Pay cash into your home vault, or give up a patent you don&apos;t need.
          </WarnBox>
        </div>
      )}
      {!patents ? (
        !error && <Loading />
      ) : patents.length === 0 ? (
        <Empty>You hold no patents. Research grants one.</Empty>
      ) : (
        <Table head={["Design", "Slot", "Effects", "Status", "Upkeep / day", "Paid", "Arrears", ""]}>
          {patents.map((p) => (
            <tr key={p.component_id}>
              <td className="font-medium">{p.name}</td>
              <td>
                <SlotGrade slot={p.slot} grade={p.grade} />
              </td>
              <td className="max-w-56">
                <Effects effects={p.effects} />
              </td>
              <td>
                <PatentStatus status={p.status} />
              </td>
              <td className="tabular-nums">{p.status === "held" ? fmtCr(p.upkeep_per_game_day_pence) : "—"}</td>
              <td className="tabular-nums">{fmtCr(p.upkeep_paid_pence)}</td>
              <td className={`tabular-nums ${p.arrears_days > 0 ? "text-destructive" : ""}`}>{p.arrears_days ? `${p.arrears_days} d` : "—"}</td>
              <td className="text-right">
                <span className="inline-flex flex-wrap justify-end gap-1">
                  <Button size="sm" variant="outline" onClick={() => onMake(p.component_id)}>
                    Make
                  </Button>
                  {p.status === "held" && (
                    <>
                      <Button size="sm" variant="outline" onClick={() => onOffer(p.component_id)}>
                        Offer units
                      </Button>
                      <Button size="sm" variant="destructive" disabled={act.busy} onClick={() => makePublic(p)}>
                        Make public
                      </Button>
                    </>
                  )}
                </span>
              </td>
            </tr>
          ))}
        </Table>
      )}
      <p className="mt-3 text-muted-foreground text-xs">
        Every patent held costs upkeep each game day from your home-region vault, charged even into debt: your player&apos;s first is the cheapest and each further one
        costs half again as much as the one before. Nothing gives up a disappointing design for you.
      </p>
    </Panel>
  );
}

// ── Licences ──────────────────────────────────────────────────────────────────

function UnitsPanel({ licences, error, onMake }: { licences: S.LicenceView[] | undefined; error: Error | null; onMake: (componentId: string) => void }) {
  const mat = useMaterialText();
  return (
    <Panel title="Your licence units">
      <ErrorNote error={error} />
      {!licences ? (
        !error && <Loading />
      ) : licences.length === 0 ? (
        <Empty>You hold no licence units. Buy them from a holder&apos;s offer, or post a request.</Empty>
      ) : (
        <Table head={["Design", "Slot", "Effects", "Patent", "Granted", "Used", "Left", "Making one takes", ""]}>
          {licences.map((l) => (
            <tr key={l.component_id}>
              <td className="font-medium">{l.name}</td>
              <td>
                <SlotGrade slot={l.slot} grade={l.grade} />
              </td>
              <td className="max-w-56">
                <Effects effects={l.effects} />
              </td>
              <td>
                <PatentStatus status={l.patent_status} />
              </td>
              <td className="tabular-nums">{l.units_granted}</td>
              <td className="tabular-nums">{l.units_used}</td>
              <td className="font-medium tabular-nums">{l.units_left}</td>
              <td className="text-xs">
                {mat(l.make_materials)} + {fmtCr(l.make_labour_pence)} labour
              </td>
              <td className="text-right">
                {(l.units_left > 0 || l.patent_status === "public") && (
                  <Button size="sm" variant="outline" onClick={() => onMake(l.component_id)}>
                    Make
                  </Button>
                )}
              </td>
            </tr>
          ))}
        </Table>
      )}
      <p className="mt-3 text-muted-foreground text-xs">
        A unit lets this company make one component of the design, at any yard. Units can&apos;t be resold and last the season; once a patent goes public they are no
        longer needed.
      </p>
    </Panel>
  );
}

function DealForm({ c, side, vaults, onDone, onClose }: { c: ContractListing; side: Side; vaults: Vaults; onDone: () => void; onClose: () => void }) {
  const mat = useMaterialText();
  const t = c.licence as S.LicenceTerms;
  const left = c.remaining_quantity;
  const lot = t.price_basis === "total";
  const [units, setUnits] = useState(String(lot ? left : 1));
  const act = useAction<ContractListing>(onDone);
  const n = lot ? left : num(units);
  const money = Number.isFinite(n) ? priceOf(t, n) : Number.NaN;
  const cash = vaults.cash(t.banking_region);
  const why = firstProblem([
    [Number.isInteger(n) && n >= 1 && n <= left, `Take 1 to ${left} units.`],
    [side === "request" || cash === undefined || money <= cash, `Only ${fmtCr(cash)} in your ${regionName(t.banking_region)} vault.`],
  ]);

  function submit() {
    const msg =
      side === "offer"
        ? `Buy ${n} licence unit${n === 1 ? "" : "s"} of ${t.name} (${t.slot}, grade ${t.grade}) for ${fmtCr(money, 2)}, paid from your ${regionName(t.banking_region)} vault straight to the holder?\n\nEach unit lets this company make one component of the design at any yard, from ${mat(t.make_materials)} in your warehouse there plus ${fmtCr(t.make_labour_pence)} of the yard's labour. Units can't be resold and last the season; if the patent goes public they are simply no longer needed.`
        : `Fill ${n} unit${n === 1 ? "" : "s"} of this request for ${t.name} for ${fmtCr(money, 2)}, paid to you from its escrow? The buyer may then make ${n} component${n === 1 ? "" : "s"} of your design.`;
    if (!confirm(msg)) return;
    void act.run(() =>
      kibbPost<ContractListing>(side === "offer" ? "/v1/contract/accept-licence-offer" : "/v1/contract/fill-licence-request", { contract_id: c.id, units: n }),
    );
  }

  return (
    <div className="space-y-3 rounded-lg border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium text-sm">
          {side === "offer" ? "Buy units of" : "Fill the request for"} {t.name}
        </span>
        <Button size="sm" variant="ghost" onClick={onClose}>
          Close
        </Button>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={lot ? "Units (the whole lot)" : `Units (1 to ${left})`}>
          <Input type="number" min={1} max={left} step={1} value={lot ? String(left) : units} disabled={lot} onChange={(e) => setUnits(e.target.value)} />
        </Field>
        <Field label={side === "offer" ? "You pay" : "You are paid"}>
          <div className="flex h-8.5 items-center font-medium tabular-nums sm:h-7.5">{Number.isFinite(money) ? fmtCr(money, 2) : "—"}</div>
        </Field>
      </div>
      {side === "offer" && <CashLine region={t.banking_region} cash={cash} need={money} />}
      <ErrorNote error={act.error ?? (units ? why : null)} />
      {act.result && <p className="text-sm">Done: {act.result.remaining_quantity} units left on the contract.</p>}
      <Button className="w-full" disabled={!!why || act.busy} onClick={submit}>
        {act.busy ? "Sending…" : side === "offer" ? "Buy units" : "Fill"}
      </Button>
    </div>
  );
}

function LicenceBoard({
  side,
  rows,
  error,
  companyId,
  ourIds,
  heldByUs,
  vaults,
  onDone,
}: {
  side: Side;
  rows: ContractListing[] | undefined;
  error: Error | null;
  companyId: string | undefined;
  ourIds: Set<string>;
  /** We hold this design's patent (we may fill requests for it, and need no units of it). */
  heldByUs: (componentId: string) => boolean;
  vaults: Vaults;
  onDone: () => void;
}) {
  const mat = useMaterialText();
  const [selected, setSelected] = useState<string | null>(null);
  const cancel = useAction<ContractListing>(onDone);
  const list = (rows ?? []).filter((c) => c.licence);
  const picked = list.find((c) => c.id === selected);

  function doCancel(c: ContractListing) {
    const t = c.licence as S.LicenceTerms;
    const escrow = priceOf(t, c.remaining_quantity);
    const msg =
      side === "offer"
        ? `Withdraw your offer of ${c.remaining_quantity} units of ${t.name}?`
        : `Withdraw your request for ${c.remaining_quantity} units of ${t.name}? The unfilled escrow (${fmtCr(escrow, 2)}) returns to your ${regionName(t.banking_region)} vault.`;
    if (!confirm(msg)) return;
    void cancel.run(() => kibbPost<ContractListing>("/v1/contract/cancel-licence", { contract_id: c.id }));
  }

  return (
    <Panel title={side === "offer" ? "Licence offers (holders selling)" : "Licence requests (buyers asking)"}>
      <ErrorNote error={error} />
      <ErrorNote error={cancel.error} className="mb-3" />
      {!rows ? (
        !error && <Loading />
      ) : list.length === 0 ? (
        <Empty>No open licence {side === "offer" ? "offers" : "requests"}.</Empty>
      ) : (
        <Table head={["Design", "Effects", side === "offer" ? "Holder" : "Buyer", "Units left", "Price", "Paid in", "Making one takes", "Closes", ""]}>
          {list.map((c) => {
            const t = c.licence as S.LicenceTerms;
            const ours = c.issuer_company_id === companyId;
            const mine = heldByUs(t.component_id);
            return (
              <tr key={c.id} className={c.id === selected ? "bg-accent" : undefined}>
                <td>
                  <div className="font-medium">{t.name}</div>
                  <SlotGrade slot={t.slot} grade={t.grade} />
                </td>
                <td className="max-w-56">
                  <Effects effects={t.effects} />
                </td>
                <td>
                  <CompanyLabel id={c.issuer_company_id} companyId={companyId} ourIds={ourIds} />
                </td>
                <td className="tabular-nums">
                  {c.remaining_quantity}
                  {c.quantity_required !== c.remaining_quantity && <span className="text-muted-foreground text-xs"> of {c.quantity_required}</span>}
                </td>
                <td className="whitespace-nowrap tabular-nums">{priceText(t)}</td>
                <td className="capitalize">{regionName(t.banking_region)}</td>
                <td className="text-xs">
                  {mat(t.make_materials)} + {fmtCr(t.make_labour_pence)}
                </td>
                <td className="whitespace-nowrap text-xs">{fmtIn(c.expires_at)}</td>
                <td className="text-right">
                  {ours ? (
                    <Button size="sm" variant="outline" disabled={cancel.busy} onClick={() => doCancel(c)}>
                      Cancel
                    </Button>
                  ) : side === "offer" ? (
                    mine ? (
                      <span className="text-muted-foreground text-xs" title="You hold this patent: you make it freely">
                        your patent
                      </span>
                    ) : (
                      <Button size="sm" variant="outline" onClick={() => setSelected(c.id)}>
                        Buy units
                      </Button>
                    )
                  ) : mine ? (
                    <Button size="sm" variant="outline" onClick={() => setSelected(c.id)}>
                      Fill
                    </Button>
                  ) : (
                    <span className="text-muted-foreground text-xs" title="Only the patent's holder fills a request">
                      holder only
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </Table>
      )}
      {picked && (
        <div className="mt-3">
          <DealForm key={picked.id} c={picked} side={side} vaults={vaults} onDone={onDone} onClose={() => setSelected(null)} />
        </div>
      )}
      <p className="mt-3 text-muted-foreground text-xs">
        {side === "offer"
          ? "Buyers pay from their vault in the holder's home region, straight to the holder. Per unit: take any number up to what is left; total: the whole lot or nothing."
          : "The buyer's price for every unit asked is escrowed; only the patent's holder fills it, paid from the escrow. Per unit: fill any number up to what is left; total: the whole lot."}{" "}
        Deals between your own or linked companies are allowed and reviewed.
      </p>
    </Panel>
  );
}

function LicenceForm({
  initial,
  ownHeld,
  othersHeld,
  homeRegion,
  vaults,
  onDone,
}: {
  initial: { side: Side; componentId: string } | null;
  /** Our patents still held: what we may offer. */
  ownHeld: S.PatentView[];
  /** Others' patents still held: what we may ask for. */
  othersHeld: S.PatentView[];
  homeRegion: string | null;
  vaults: Vaults;
  onDone: () => void;
}) {
  const [side, setSide] = useState<Side>(initial?.side ?? "offer");
  const [componentId, setComponentId] = useState(initial?.componentId ?? "");
  const [units, setUnits] = useState("10");
  const [price, setPrice] = useState("");
  const [basis, setBasis] = useState<S.PriceBasis>("per_unit");
  const [hours, setHours] = useState(String(RND.hoursDefault));
  const act = useAction<ContractListing>(onDone);
  const options = side === "offer" ? ownHeld : othersHeld;
  const design = options.find((p) => p.component_id === componentId);
  const n = num(units);
  const p = crToPence(price);
  const h = num(hours);
  const total = Number.isFinite(p) && Number.isFinite(n) ? priceOf({ price_basis: basis, price_pence: p }, n) : Number.NaN;
  const cash = vaults.cash(homeRegion);
  const why = firstProblem([
    [!!design, side === "offer" ? "Choose one of your patents." : "Choose a design someone else holds."],
    [Number.isInteger(n) && n >= 1 && n <= RND.unitsMax, `1 to ${RND.unitsMax.toLocaleString("en-GB")} units.`],
    [p > 0, basis === "per_unit" ? "Enter the price of a unit." : "Enter the price of the whole lot."],
    [Number.isInteger(h) && h >= RND.hoursMin && h <= RND.hoursMax, `Open ${RND.hoursMin} to ${RND.hoursMax.toLocaleString("en-GB")} game hours.`],
    [side === "offer" || cash === undefined || total <= cash, `Only ${fmtCr(cash)} in your ${regionName(homeRegion)} vault to escrow ${fmtCr(total, 2)}.`],
  ]);

  function submit() {
    if (!design) return;
    const each = basis === "per_unit" ? `${fmtCr(p, 2)} a unit (${fmtCr(total, 2)} for all ${n})` : `${fmtCr(p, 2)} for the lot of ${n}, all or nothing`;
    const msg =
      side === "offer"
        ? `Offer ${n} licence unit${n === 1 ? "" : "s"} of your ${design.name} at ${each}, open ${h} game hours?\n\nBuyers pay from their vault in your home region (${regionName(homeRegion)}) straight to you. Each unit lets the buyer make one component of the design; units can't be resold. It is posted publicly and on the Exchange.`
        : `Ask ${design.holder_company_name ?? "the holder"} for ${n} licence unit${n === 1 ? "" : "s"} of ${design.name} at ${each}, open ${h} game hours?\n\n${fmtCr(total, 2)} is escrowed now from your ${regionName(homeRegion)} vault; only the holder can fill it, paid from the escrow. Cancelling refunds what is unfilled. It is posted publicly and on the Exchange.`;
    if (!confirm(msg)) return;
    void act.run(() =>
      kibbPost<ContractListing>(side === "offer" ? "/v1/contract/create-licence-offer" : "/v1/contract/create-licence-request", {
        component_id: componentId,
        units: n,
        price_pence: p,
        price_basis: basis,
        open_game_hours: h,
      }),
    );
  }

  return (
    <div className="space-y-3">
      <Segmented
        value={side}
        onChange={(v) => {
          setSide(v);
          setComponentId("");
        }}
        options={[
          { value: "offer", label: "Offer (sell)" },
          { value: "request", label: "Request (buy)" },
        ]}
      />
      <Field label={side === "offer" ? "Your patent" : "Design (held by another company)"}>
        <NativeSelect value={componentId} onChange={(e) => setComponentId(e.target.value)}>
          <option value="">{options.length ? "Choose…" : side === "offer" ? "You hold no patents" : "No design is held by anyone else"}</option>
          {options.map((d) => (
            <option key={d.component_id} value={d.component_id}>
              {d.name} · {d.slot} {d.grade}
              {side === "request" && d.holder_company_name ? ` · ${d.holder_company_name}` : ""}
            </option>
          ))}
        </NativeSelect>
      </Field>
      {design && (
        <p className="text-muted-foreground text-xs">
          {design.effects.join(", ") || "No effects listed"}.
        </p>
      )}
      <div className="grid grid-cols-2 gap-3">
        <Field label="Units">
          <Input type="number" min={1} max={RND.unitsMax} step={1} value={units} onChange={(e) => setUnits(e.target.value)} />
        </Field>
        <Field label="Price basis">
          <NativeSelect value={basis} onChange={(e) => setBasis(e.target.value as S.PriceBasis)}>
            <option value="per_unit">Per unit</option>
            <option value="total">Whole lot</option>
          </NativeSelect>
        </Field>
        <Field label={basis === "per_unit" ? "Price a unit (Cr)" : "Price of the lot (Cr)"}>
          <Input type="number" min={0.01} step={0.01} value={price} onChange={(e) => setPrice(e.target.value)} />
        </Field>
        <Field label="Open (game hours)">
          <Input type="number" min={RND.hoursMin} max={RND.hoursMax} step={1} value={hours} onChange={(e) => setHours(e.target.value)} />
        </Field>
      </div>
      {Number.isFinite(total) && total > 0 && (
        <p className="text-muted-foreground text-xs">
          {side === "offer" ? "Sold in full, it brings" : "Escrowed now"}: {fmtCr(total, 2)}.
        </p>
      )}
      {side === "request" && <CashLine region={homeRegion} cash={cash} need={total} />}
      <ErrorNote error={act.error ?? (componentId || price ? why : null)} />
      {act.result && <p className="text-sm">Posted: open {fmtIn(act.result.expires_at)}.</p>}
      <Button className="w-full" disabled={!!why || act.busy} onClick={submit}>
        {act.busy ? "Posting…" : side === "offer" ? "Post the offer" : "Post the request"}
      </Button>
    </div>
  );
}

// ── Making and fitting ────────────────────────────────────────────────────────

/** A design we may make now, and why. */
interface Makeable {
  componentId: string;
  name: string;
  slot: string;
  grade: number;
  /** `patent`: ours, made freely; `public`: anyone may; `licence`: one unit a component. */
  how: "patent" | "public" | "licence";
  unitsLeft?: number;
}

function makeables(
  patents: S.OwnPatentView[] | undefined,
  register: S.PatentView[] | undefined,
  licences: S.LicenceView[] | undefined,
): Makeable[] {
  const out = new Map<string, Makeable>();
  for (const p of patents ?? []) if (p.status === "held") out.set(p.component_id, { componentId: p.component_id, name: p.name, slot: p.slot, grade: p.grade, how: "patent" });
  for (const p of register ?? [])
    if (p.status === "public" && !out.has(p.component_id)) out.set(p.component_id, { componentId: p.component_id, name: p.name, slot: p.slot, grade: p.grade, how: "public" });
  for (const l of licences ?? [])
    if (l.units_left > 0 && l.patent_status === "held" && !out.has(l.component_id))
      out.set(l.component_id, { componentId: l.component_id, name: l.name, slot: l.slot, grade: l.grade, how: "licence", unitsLeft: l.units_left });
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

const HOW_TEXT: Record<Makeable["how"], string> = { patent: "your patent", public: "public", licence: "licence" };

function MakeForm({
  initial,
  options,
  terms,
  stock,
  phase,
  onDone,
}: {
  initial: string;
  options: Makeable[];
  /** What making one takes, where known (from licence units and licence contracts). */
  terms: Map<string, { materials: S.MaterialLine[]; labour: number }>;
  stock: Stock;
  phase: number | undefined;
  onDone: () => void;
}) {
  const { catalog, portName } = useCatalog();
  const mat = useMaterialText();
  const isYard = (id: string) => !!catalog?.ports.find((x) => x.id === id)?.has_shipyard;
  const [componentId, setComponentId] = useState(initial);
  const [picked, setPicked] = useState("");
  const [qty, setQty] = useState("1");
  const act = useAction<S.MakeComponentResult>(onDone);
  const design = options.find((o) => o.componentId === componentId);
  const need = terms.get(componentId);
  // Default yard: one whose warehouse holds the materials for one already.
  const readyYards = need ? yardsHolding(stock, need.materials, isYard).ready : [];
  const port = picked || readyYards[0] || "";
  const n = num(qty);
  const max = design?.how === "licence" ? Math.min(RND.makeMax, design.unitsLeft ?? 0) : RND.makeMax;
  const short = need && port && Number.isFinite(n) ? shortfall(stock, port, need.materials, n) : [];
  const why = firstProblem([
    [!!design, "Choose a design you may make."],
    [!!port, "Choose a yard."],
    [!port || isYard(port), "That port has no shipyard."],
    [Number.isInteger(n) && n >= 1 && n <= max, `Make 1 to ${max} at once${design?.how === "licence" ? ` (you have ${design.unitsLeft} units left)` : ""}.`],
    [short.length === 0, `Your warehouse at ${portName(port)} is short of ${mat(short)}.`],
  ]);

  function submit() {
    if (!design) return;
    const uses = design.how === "licence" ? ` It uses ${n} of your ${design.unitsLeft} licence units.` : design.how === "public" ? " The design is public: no licence needed." : "";
    if (
      !confirm(
        `Make ${n} × ${design.name} (${design.slot}, grade ${design.grade}) at ${portName(port)}?\n\nThe materials${need ? ` (${mat(need.materials.map((m) => ({ ...m, quantity: m.quantity * n })))})` : ""} are taken from your warehouse there, and the yard's labour${need ? ` (about ${fmtCr(need.labour * n)})` : ""} is paid.${uses} The components lie in your warehouse at ${portName(port)} until you fit them; they can't be traded.`,
      )
    )
      return;
    void act.run(() => kibbPost<S.MakeComponentResult>("/v1/rnd/make", { component_id: componentId, port_id: port, quantity: n }));
  }

  return (
    <div className="space-y-3">
      <Field label="Design">
        <NativeSelect value={componentId} onChange={(e) => setComponentId(e.target.value)}>
          <option value="">{options.length ? "Choose…" : "Nothing you may make yet"}</option>
          {options.map((o) => (
            <option key={o.componentId} value={o.componentId}>
              {o.name} · {o.slot} {o.grade} · {HOW_TEXT[o.how]}
              {o.how === "licence" ? ` (${o.unitsLeft} left)` : ""}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <div className="grid grid-cols-3 gap-3">
        <Field label="Yard" className="col-span-2">
          <PortSelect value={port} onChange={setPicked} placeholder="Choose a yard…" maxPhase={phase} filter={isYard} />
        </Field>
        <Field label={`Quantity (≤ ${max})`}>
          <Input type="number" min={1} max={max} step={1} value={qty} onChange={(e) => setQty(e.target.value)} />
        </Field>
      </div>
      {design && (
        <KV
          rows={[
            ["Each takes", need ? `${mat(need.materials)} + ${fmtCr(need.labour)} labour` : "not listed here (the game checks your warehouse)"],
            ...(need && port
              ? ([
                  [
                    `In your warehouse at ${portName(port)}`,
                    need.materials.map((m) => `${qtyText(freeAt(stock, port, m.commodity_id))} of ${qtyText(m.quantity * (Number.isFinite(n) ? n : 1))}`).join(", ") || "—",
                  ],
                ] as Array<[string, string]>)
              : []),
            ...(need && readyYards.length ? ([["Yards holding one's materials", readyYards.map(portName).join(", ")]] as Array<[string, string]>) : []),
          ]}
        />
      )}
      <ErrorNote error={act.error ?? (componentId ? why : null)} />
      {act.result && (
        <p className="text-sm">
          Made {act.result.items.length}: {mat(act.result.materials)} taken, {fmtCr(act.result.labour_pence)} labour.
        </p>
      )}
      <Button className="w-full" disabled={!!why || act.busy} onClick={submit}>
        {act.busy ? "Making…" : "Make"}
      </Button>
    </div>
  );
}

function FitForm({ initial, components, ships, onDone }: { initial: string; components: S.ComponentItemView[] | undefined; ships: ShipResult[] | undefined; onDone: () => void }) {
  const { portName } = useCatalog();
  const autopilot = useAutopilotShips();
  const [itemId, setItemId] = useState(initial);
  const [shipId, setShipId] = useState("");
  const act = useAction<S.FitComponentResult>(onDone);
  const item = components?.find((c) => c.item_id === itemId);
  const berthedHere = (r: ShipResult) => !!item && r.ship.status === "berthed" && r.ship.current_port_id === item.port_id;
  const ship = ships?.find((r) => r.ship.id === shipId && berthedHere(r));
  const taken = item && ship ? ship.components?.find((c) => c.slot === item.slot) : undefined;
  const { rebuild, error: appraisalError } = useAppraisal(ship ? ship.ship.id : null);
  const fee = rebuild !== undefined ? Math.round((rebuild * RND.fitFeeBps) / 10_000) : undefined;
  const anyHere = (ships ?? []).some(berthedHere);
  const why = firstProblem([
    [!!item, "Choose a component."],
    [!!ship, anyHere ? "Choose a ship berthed there." : `None of your ships is berthed at ${portName(item?.port_id)} (berthed, not in the roadstead).`],
    [!taken, `Her ${item?.slot} slot already carries ${taken?.name}: fitting is permanent, with no swap.`],
  ]);

  function submit() {
    if (!item || !ship) return;
    if (
      !confirm(
        `Fit ${item.name} (${item.slot}, grade ${item.grade}) to ${ship.ship.name} at ${portName(item.port_id)}?\n\nThe yard charges 4% of her rebuild value${fee !== undefined ? ` (about ${fmtCr(fee)} on ${fmtCr(rebuild)})` : ""}.\n\nFitting is PERMANENT: no removal and no swap. The component stays with the ship whoever owns her and is lost with her. Her rebuild value rises by the component's worth plus the fee (sale prices, insurance, loans and share prices follow), and any sale listing of hers lapses. Refused while she has open insurance.`,
      )
    )
      return;
    void act.run(() => kibbPost<S.FitComponentResult>("/v1/shipyard/fit-component", { ship_id: ship.ship.id, item_id: item.item_id }));
  }

  return (
    <div className="space-y-3">
      <Field label="Component (lying in your warehouse)">
        <NativeSelect
          value={itemId}
          onChange={(e) => {
            setItemId(e.target.value);
            setShipId("");
          }}
        >
          <option value="">{components?.length ? "Choose…" : "No components made yet"}</option>
          {(components ?? []).map((c) => (
            <option key={c.item_id} value={c.item_id}>
              {c.name} · {c.slot} {c.grade} · at {portName(c.port_id)}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <Field label={item ? `Ship berthed at ${portName(item.port_id)}` : "Ship"}>
        <ShipSelect ships={ships} value={shipId} onChange={setShipId} placeholder={item ? "Choose a ship…" : "Choose a component first"} filter={berthedHere} disabled={!item} />
      </Field>
      {ship && (
        <KV
          rows={[
            ["Fitted now", ship.components?.length ? ship.components.map((c) => `${c.name} (${c.slot})`).join(", ") : "nothing"],
            ["Rebuild value", rebuild !== undefined ? fmtCr(rebuild) : appraisalError ? "can't be appraised now (liened, listed or on a venture)" : "…"],
            ["Fitting fee (4%)", fee !== undefined ? fmtCr(fee) : "4% of her rebuild value"],
          ]}
        />
      )}
      {ship && autopilot.has(ship.ship.id) && (
        <p className="text-muted-foreground text-xs">The autopilot sails this ship and may take her out before you fit; fitting needs her berthed here.</p>
      )}
      <WarnBox>Fitting is permanent: no removal and no swap. The component stays with the ship whoever owns her, and is lost with her.</WarnBox>
      <ErrorNote error={act.error ?? (itemId ? why : null)} />
      {act.result && (
        <p className="text-sm">
          Fitted {act.result.fitted.name} for {fmtCr(act.result.fitting_fee_pence)}.
        </p>
      )}
      <Button className="w-full" disabled={!!why || act.busy} onClick={submit}>
        {act.busy ? "Fitting…" : "Fit (permanent)"}
      </Button>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

type Tab = "research" | "patents" | "licences" | "make";
const TABS: Tab[] = ["research", "patents", "licences", "make"];

function RndView() {
  const params = useSearchParams();
  const fromUrl = params.get("tab");
  const [tab, setTab] = useState<Tab>(TABS.includes(fromUrl as Tab) ? (fromUrl as Tab) : "research");
  useCompanyDirectory();
  const companyId = useCompanyId();
  const ourIds = useOurCompanyIds();
  const { catalog, portName } = useCatalog();
  const regionOf = useRegionOf();
  const isYard = (id: string) => !!catalog?.ports.find((x) => x.id === id)?.has_shipyard;
  const { data: profile } = usePoll(() => kibbGet<CompanyProfile>("/v1/company/profile"), 300_000);
  const homeRegion = regionOf(profile?.company.home_port_id);
  const { data: clock } = usePoll(() => kibbGet<WorldClock>("/v1/world/clock"), 300_000);
  const vaults = useVaults();
  const { data: ships, reload: reloadShips } = useShips();
  const { data: stock, reload: reloadStock } = useStock();
  const status = usePoll(() => kibbGet<S.RndStatus>("/v1/rnd/status"), 30_000);
  const pool = usePoll(() => kibbGet<S.PoolEntry[]>("/v1/rnd/pool"), 60_000);
  const register = usePoll(() => kibbGet<S.PatentView[]>("/v1/rnd/register"), 60_000);
  const patents = usePoll(() => kibbGet<S.OwnPatentView[]>("/v1/rnd/patents"), 60_000);
  const licences = usePoll(() => kibbGet<S.LicenceView[]>("/v1/rnd/licences"), 60_000);
  const components = usePoll(() => kibbGet<S.ComponentItemView[]>("/v1/rnd/components"), 30_000);
  const market = usePoll(
    () =>
      Promise.all([
        fetchAll<ContractListing>("/v1/contract/list", { contract_type: "licence_offer", status: "open" }, 200, 5),
        fetchAll<ContractListing>("/v1/contract/list", { contract_type: "licence_request", status: "open" }, 200, 5),
      ]).then(([offers, requests]) => ({ offers, requests })),
    30_000,
  );
  useLearnCompanies((register.data ?? []).map((p) => [p.holder_company_id, p.holder_company_name] as [string | null | undefined, string | null | undefined]));

  // Cross-tab presets: a design picked in one table opens its form in another.
  const [slot, setSlot] = useState<S.Slot | "">("");
  const [grade, setGrade] = useState(1);
  const [licencePreset, setLicencePreset] = useState<{ side: Side; componentId: string; n: number } | null>(null);
  const [makePreset, setMakePreset] = useState({ componentId: "", n: 0 });
  const [fitPreset, setFitPreset] = useState({ itemId: "", n: 0 });
  const toLicence = (side: Side, componentId: string) => {
    setLicencePreset((p) => ({ side, componentId, n: (p?.n ?? 0) + 1 }));
    setTab("licences");
  };
  const toMake = (componentId: string) => {
    setMakePreset((p) => ({ componentId, n: p.n + 1 }));
    setTab("make");
  };
  const toFit = (itemId: string) => setFitPreset((p) => ({ itemId, n: p.n + 1 }));

  const refreshResearch = () => {
    void status.reload();
    void pool.reload();
    void vaults.reload();
  };
  const refreshPatents = () => {
    void patents.reload();
    void register.reload();
    void market.reload();
    void licences.reload();
  };
  const refreshLicences = () => {
    void market.reload();
    void licences.reload();
    void vaults.reload();
  };
  const refreshMake = () => {
    void components.reload();
    void licences.reload();
    void reloadStock();
    void vaults.reload();
  };
  const refreshFit = () => {
    void components.reload();
    void reloadShips();
    void vaults.reload();
  };

  const project = status.data?.project ?? null;
  const live = project?.status === "active" ? project : null;
  const held = (patents.data ?? []).filter((p) => p.status === "held");
  const heldIds = new Set(held.map((p) => p.component_id));
  const othersHeld = (register.data ?? []).filter((p) => p.status === "held" && p.holder_company_id !== companyId && !heldIds.has(p.component_id));
  const unitsLeft = (licences.data ?? []).filter((l) => l.patent_status === "held").reduce((n, l) => n + l.units_left, 0);
  const options = makeables(patents.data, register.data, licences.data);
  const terms = new Map<string, { materials: S.MaterialLine[]; labour: number }>();
  for (const c of [...(market.data?.offers ?? []), ...(market.data?.requests ?? [])])
    if (c.licence) terms.set(c.licence.component_id, { materials: c.licence.make_materials, labour: c.licence.make_labour_pence });
  for (const l of licences.data ?? []) terms.set(l.component_id, { materials: l.make_materials, labour: l.make_labour_pence });
  const fitted = (ships ?? []).filter((r) => r.ship.status !== "sunk" && (r.components?.length ?? 0) > 0);

  return (
    <div className="space-y-5 pb-8 sm:space-y-6">
      <PageHeader
        title="R&D"
        subtitle="Research a ship component for a slot and grade, hold its patent, sell licence units to make it, and fit components to your hulls."
      />
      <Metrics
        className="sm:grid-cols-4 xl:grid-cols-4"
        items={[
          {
            label: "Project",
            value: !status.data ? "…" : live ? `${live.stage_name || STAGES[live.stage - 1]?.name} (${live.stage}/4)` : "none",
            hint: live ? `${live.slot} grade ${live.grade} · ${live.stage_points}/${live.stage_points_required} points` : status.data?.can_start ? "you may start one" : undefined,
          },
          {
            label: "Patents held",
            value: patents.data ? String(held.length) : "…",
            hint: held.length ? `${fmtCr(held.reduce((n, p) => n + p.upkeep_per_game_day_pence, 0))} a game day` : undefined,
          },
          { label: "Licence units left", value: licences.data ? String(unitsLeft) : "…", hint: licences.data ? `${licences.data.length} design${licences.data.length === 1 ? "" : "s"}` : undefined },
          { label: "Components to fit", value: components.data ? String(components.data.length) : "…", hint: fitted.length ? `${fitted.length} ship${fitted.length === 1 ? "" : "s"} fitted` : undefined },
        ]}
      />
      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
        <TabsList>
          <TabsTab value="research">Research</TabsTab>
          <TabsTab value="patents">Patents</TabsTab>
          <TabsTab value="licences">Licences</TabsTab>
          <TabsTab value="make">Make and fit</TabsTab>
        </TabsList>

        <TabsPanel value="research" className="pt-2">
          <div className="grid items-start gap-4 xl:grid-cols-3">
            <div className="space-y-4 xl:col-span-2">
              <Panel title="Your project">
                <ErrorNote error={status.error} />
                {!status.data ? (
                  !status.error && <Loading />
                ) : (
                  <div className="space-y-3">
                    {status.data.sibling_project_company_id && status.data.sibling_project_company_id !== companyId && (
                      <WarnBox tone="info">
                        A project is under way at another of your (or a linked) company:{" "}
                        <CompanyLabel id={status.data.sibling_project_company_id} companyId={companyId} ourIds={ourIds} />. One project at a time per player.
                      </WarnBox>
                    )}
                    {project ? (
                      <ProjectCard
                        key={project.project_id}
                        project={project}
                        companyId={companyId}
                        ships={ships}
                        stock={stock}
                        register={register.data}
                        isYard={catalog ? isYard : null}
                        onDone={refreshResearch}
                      />
                    ) : (
                      <Empty>No project under way.</Empty>
                    )}
                  </div>
                )}
              </Panel>
              <PoolPanel
                pool={pool.data}
                error={pool.error}
                slot={slot}
                grade={grade}
                onPick={(s, g) => {
                  setSlot(s);
                  setGrade(g);
                }}
              />
            </div>
            <div className="space-y-4">
              <Panel title="Start a project">
                {!status.data ? (
                  !status.error && <Loading />
                ) : (
                  <StartForm
                    status={status.data}
                    pool={pool.data}
                    ships={ships}
                    homeRegion={homeRegion}
                    vaults={vaults}
                    slot={slot}
                    grade={grade}
                    onSlot={setSlot}
                    onGrade={setGrade}
                    onDone={refreshResearch}
                  />
                )}
              </Panel>
              <Panel title="How research works">
                <div className="space-y-2 text-muted-foreground text-sm">
                  <p>
                    One project at a time per player (your own and linked companies together), and only with a player net worth of at least the entry figure and no
                    cooldown running.
                  </p>
                  <p>
                    You pick a slot and grade; the Admiralty draws the design at random from those still free there. Four stages: drawings, a prototype (materials in
                    your warehouse at any yard), sea trials (the trial ship&apos;s completed legs) and the Admiralty board. Each ends in a review that can fail and send
                    you back part of the way.
                  </p>
                  <p>
                    Upkeep is charged every game day the project is live; unpaid, it pauses, and {RND.unpaidAbandonDays} unpaid days in a row abandon it. Abandoning
                    refunds nothing and starts no cooldown. A grant starts a cooldown before your player may start again, whatever the design turned out to be.
                  </p>
                </div>
              </Panel>
            </div>
          </div>
        </TabsPanel>

        <TabsPanel value="patents" className="pt-2">
          <div className="space-y-4">
            <OurPatentsPanel patents={patents.data} error={patents.error} onOffer={(id) => toLicence("offer", id)} onMake={toMake} onDone={refreshPatents} />
            <RegisterPanel register={register.data} error={register.error} companyId={companyId} ourIds={ourIds} onLicence={toLicence} onMake={toMake} />
          </div>
        </TabsPanel>

        <TabsPanel value="licences" className="pt-2">
          <div className="grid items-start gap-4 xl:grid-cols-3">
            <div className="space-y-4 xl:col-span-2">
              <UnitsPanel licences={licences.data} error={licences.error} onMake={toMake} />
              <LicenceBoard
                side="offer"
                rows={market.data?.offers}
                error={market.error}
                companyId={companyId}
                ourIds={ourIds}
                heldByUs={(id) => heldIds.has(id)}
                vaults={vaults}
                onDone={refreshLicences}
              />
              <LicenceBoard
                side="request"
                rows={market.data?.requests}
                error={market.error}
                companyId={companyId}
                ourIds={ourIds}
                heldByUs={(id) => heldIds.has(id)}
                vaults={vaults}
                onDone={refreshLicences}
              />
            </div>
            <div className="space-y-4">
              <Panel title="Post a licence contract">
                <LicenceForm
                  key={licencePreset ? `${licencePreset.side}-${licencePreset.componentId}-${licencePreset.n}` : "none"}
                  initial={licencePreset}
                  ownHeld={held}
                  othersHeld={othersHeld}
                  homeRegion={homeRegion}
                  vaults={vaults}
                  onDone={refreshLicences}
                />
              </Panel>
              <WarnBox tone="info">
                <p>
                  Components are never traded; the right to make them is. A contract carries 1 to {RND.unitsMax.toLocaleString("en-GB")} units, open {RND.hoursMin}{" "}
                  to {RND.hoursMax.toLocaleString("en-GB")} game hours (default {RND.hoursDefault}), and moves money in its poster&apos;s home region.
                </p>
                <p>When a patent goes public its open licence contracts close and requests are refunded.</p>
                <p>
                  Licence offers and requests are also on the{" "}
                  <Link href="/exchange" className="hover:underline">
                    Exchange
                  </Link>
                  .
                </p>
              </WarnBox>
            </div>
          </div>
        </TabsPanel>

        <TabsPanel value="make" className="pt-2">
          <div className="grid items-start gap-4 xl:grid-cols-3">
            <div className="space-y-4 xl:col-span-2">
              <Panel title="Components in your warehouses">
                <ErrorNote error={components.error} />
                {!components.data ? (
                  !components.error && <Loading />
                ) : components.data.length === 0 ? (
                  <Empty>No components waiting to be fitted.</Empty>
                ) : (
                  <Table head={["Component", "Slot", "Effects", "Lies at", "Made", ""]}>
                    {components.data.map((c) => (
                      <tr key={c.item_id}>
                        <td className="font-medium">{c.name}</td>
                        <td>
                          <SlotGrade slot={c.slot} grade={c.grade} />
                        </td>
                        <td className="max-w-56">
                          <Effects effects={c.effects} />
                        </td>
                        <td>{portName(c.port_id)}</td>
                        <td className="whitespace-nowrap text-muted-foreground text-xs">{fmtDateTime(c.created_at)}</td>
                        <td className="text-right">
                          <Button size="sm" variant="outline" onClick={() => toFit(c.item_id)}>
                            Fit
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </Table>
                )}
                <p className="mt-3 text-muted-foreground text-xs">
                  A component lies in your warehouse at the yard where it was made until you fit it, to a ship berthed at that same yard.
                </p>
              </Panel>
              <Panel title="Fitted to your ships">
                {!ships ? (
                  <Loading />
                ) : fitted.length === 0 ? (
                  <Empty>None of your ships carries a component.</Empty>
                ) : (
                  <Table head={["Ship", "Components", "Free slots"]}>
                    {fitted.map((r) => (
                      <tr key={r.ship.id}>
                        <td>
                          <Link href={`/fleet/${r.ship.id}`} className="font-medium hover:underline">
                            {r.ship.name}
                          </Link>
                        </td>
                        <td className="text-xs">
                          {(r.components ?? []).map((c) => (
                            <div key={c.component_id}>
                              <span className="capitalize">{c.slot}</span>: {c.name}
                              {c.effects.length ? <span className="text-muted-foreground"> ({c.effects.join(", ")})</span> : null}
                            </div>
                          ))}
                        </td>
                        <td className="text-muted-foreground text-xs capitalize">
                          {SLOTS.filter((s) => !(r.components ?? []).some((c) => c.slot === s)).join(", ") || "none"}
                        </td>
                      </tr>
                    ))}
                  </Table>
                )}
              </Panel>
            </div>
            <div className="space-y-4">
              <Panel title="Make components">
                <MakeForm
                  key={`${makePreset.componentId}-${makePreset.n}`}
                  initial={makePreset.componentId}
                  options={options}
                  terms={terms}
                  stock={stock}
                  phase={clock?.unlocked_phase}
                  onDone={refreshMake}
                />
                <p className="mt-3 text-muted-foreground text-xs">
                  The patent&apos;s holder makes freely, a licensee uses one unit a component, and anyone may make a public design. At a yard, from the materials in
                  your warehouse there plus the yard&apos;s labour; up to {RND.makeMax} at once.
                  {options.some((o) => !terms.has(o.componentId)) &&
                    " What some designs take isn't listed here (only licence units and contracts list it); the game shows what it took."}
                </p>
              </Panel>
              <Panel title="Fit a component">
                <FitForm key={`${fitPreset.itemId}-${fitPreset.n}`} initial={fitPreset.itemId} components={components.data} ships={ships} onDone={refreshFit} />
                <p className="mt-3 text-muted-foreground text-xs">
                  The ship must be berthed at the yard where the component lies, with that slot free and no open insurance. Her rebuild value rises by the
                  component&apos;s worth plus the fee, which carries into sales, insurance, loans and share prices. Lloyd&apos;s prices hulls by class and ignores
                  components.
                </p>
              </Panel>
            </div>
          </div>
        </TabsPanel>
      </Tabs>
    </div>
  );
}

export default function RndPage() {
  return (
    <Suspense fallback={<Loading />}>
      <RndView />
    </Suspense>
  );
}
