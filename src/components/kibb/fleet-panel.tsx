"use client";

import { useState } from "react";
import Link from "next/link";
import { PlayIcon, Settings2Icon, SquareIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Empty, ErrorNote, Loading, Metrics, NativeSelect, Panel, Table } from "@/components/kibb/bits";
import { Segmented } from "@/components/kibb/naval-common";
import type { AiMode, AiReport } from "@/lib/kibb/ai/advisor";
import { useCatalog } from "@/hooks/use-catalog";
import { usePoll } from "@/hooks/use-poll";
import { dash } from "@/lib/kibb/browser";
import { fmtAgo, fmtBps, fmtCr, fmtDateTime, fmtIn, fmtTime, fmtTons } from "@/lib/kibb/format";
import type { FleetView } from "@/lib/kibb/fleet-registry";
import type { TimeUse } from "@/lib/kibb/fleet/agent";
import type { DealsReport, FinanceLoanRow, FinanceReport, FleetSettings, GunPolicy } from "@/lib/kibb/fleet/manager";
import type { Lane } from "@/lib/kibb/fleet/planner";

const TIME_PARTS: Array<{ key: keyof TimeUse; label: string; className: string }> = [
  { key: "laden", label: "Laden", className: "bg-success" },
  { key: "ballast", label: "Empty at sea", className: "bg-info" },
  { key: "port", label: "In port", className: "bg-warning" },
  { key: "idle", label: "Idle", className: "bg-destructive" },
];

const pct = (part: number, total: number) => (total > 0 ? Math.round((part / total) * 100) : 0);

/** The company key's expiry is shown this long before it. */
const KEY_WARN_MS = 7 * 24 * 3_600_000;

/** One bar split by where the time went. */
function TimeBar({ t }: { t: TimeUse }) {
  const total = t.laden + t.ballast + t.port + t.idle;
  if (!total) return <div className="h-2 w-full rounded-full bg-muted" />;
  return (
    <div className="flex h-2 w-full overflow-hidden rounded-full bg-muted">
      {TIME_PARTS.map((p) => (
        <div key={p.key} className={p.className} style={{ width: `${(t[p.key] / total) * 100}%` }} title={`${p.label} ${pct(t[p.key], total)}%`} />
      ))}
    </div>
  );
}

function SettingsForm({
  settings,
  busy,
  onSave,
  onCancel,
}: {
  settings: FleetSettings;
  busy: boolean;
  /** Only the fields that changed. */
  onSave: (patch: Partial<FleetSettings>) => void;
  onCancel: () => void;
}) {
  const { catalog, shipClassName } = useCatalog();
  const [d, setD] = useState(settings);
  // What the form opened with: the diff is what the user changed here, not what changed elsewhere since.
  const [initial] = useState(settings);
  const crField = (label: string, key: "reservePence" | "minMarginPence" | "underwriteBudgetPence" | "underwriteMaxPerPolicyPence") => (
    <div className="space-y-1">
      <Label>{label}</Label>
      <Input type="number" min={0} value={d[key] / 100} onChange={(e) => setD({ ...d, [key]: Math.round(Number(e.target.value) * 100) })} />
    </div>
  );
  return (
    <form
      className="grid gap-3 rounded-lg border p-3 sm:grid-cols-2 sm:p-4 lg:grid-cols-3"
      onSubmit={(e) => {
        e.preventDefault();
        // Send only what changed: a stale copy of another setting (say, marques) must not overwrite it.
        // The AI interval is typed freely and settled to 15-240 minutes here.
        const out = { ...d, aiIntervalMin: Math.min(240, Math.max(15, Math.floor(d.aiIntervalMin) || 60)) };
        const patch = Object.fromEntries(
          Object.entries(out).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(initial[k as keyof FleetSettings])),
        ) as Partial<FleetSettings>;
        if (patch.underwrite && !confirm(`Let the autopilot underwrite other companies' voyages, locking up to ${fmtCr(d.underwriteBudgetPence)} of collateral?`)) return;
        onSave(patch);
      }}
    >
      {crField("Cash reserve (Cr)", "reservePence")}
      {crField("Min margin (Cr/t)", "minMarginPence")}
      <div className="space-y-1">
        <Label>Max ships</Label>
        <Input type="number" min={1} value={d.maxShips} onChange={(e) => setD({ ...d, maxShips: Math.max(1, Math.floor(Number(e.target.value))) })} />
      </div>
      <div className="space-y-1">
        <Label>Max payback (hours)</Label>
        <Input type="number" min={0.5} step={0.5} value={d.maxPaybackHours} onChange={(e) => setD({ ...d, maxPaybackHours: Number(e.target.value) })} />
      </div>
      <div className="space-y-1">
        <Label>Guns</Label>
        <NativeSelect value={d.guns} onChange={(e) => setD({ ...d, guns: e.target.value as GunPolicy })}>
          <option value="auto">Auto: what each lane&apos;s pirates justify</option>
          <option value="full">Full battery on every ship</option>
          <option value="off">Leave guns as they are</option>
        </NativeSelect>
      </div>
      <div className="space-y-1">
        <Label>Phase bonus counted (%)</Label>
        <Input
          type="number"
          min={0}
          max={100}
          step={5}
          value={d.bonusWeightPct}
          onChange={(e) => setD({ ...d, bonusWeightPct: Math.min(100, Math.max(0, Number(e.target.value))) })}
        />
      </div>
      <div className="space-y-1">
        <Label>Storm losses counted (%)</Label>
        <Input
          type="number"
          min={0}
          max={200}
          step={10}
          value={d.stormWeightPct}
          onChange={(e) => setD({ ...d, stormWeightPct: Math.min(200, Math.max(0, Number(e.target.value))) })}
        />
      </div>
      <div className="space-y-1">
        <Label>Cash due from cargo at sea counted (%)</Label>
        <Input
          type="number"
          min={0}
          max={90}
          step={10}
          disabled={!d.resizeLoads}
          value={d.cashDuePct}
          onChange={(e) => setD({ ...d, cashDuePct: Math.min(90, Math.max(0, Number(e.target.value))) })}
        />
      </div>
      <div className="col-span-full space-y-1.5">
        <Label>Classes the buyer may build</Label>
        <div className="grid gap-x-4 gap-y-1.5 text-sm sm:grid-cols-2 xl:grid-cols-4">
          {(catalog?.ship_classes ?? []).map((c) => {
            // A packet (it can seal dispatches) is a 16 t courier: the buyer never builds one.
            const courier = c.can_seal_dispatches || c.id === "packet";
            return (
              <label key={c.id} className="flex items-center gap-1.5" title={courier ? "A courier that carries almost no cargo: the autopilot never builds one" : undefined}>
                <input
                  type="checkbox"
                  disabled={courier}
                  checked={!courier && d.buyClasses.includes(c.id)}
                  onChange={(e) =>
                    setD({ ...d, buyClasses: e.target.checked ? [...d.buyClasses, c.id] : d.buyClasses.filter((x) => x !== c.id) })
                  }
                />
                {shipClassName(c.id)}{" "}
                <span className="text-muted-foreground text-xs">
                  ({c.hull_category}, {c.hold_capacity_tons} t{courier ? ", courier: never built" : ""})
                </span>
              </label>
            );
          })}
        </div>
      </div>
      <div className="col-span-full flex flex-col gap-2 text-sm sm:flex-row sm:flex-wrap sm:gap-4">
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={d.autoBuy} onChange={(e) => setD({ ...d, autoBuy: e.target.checked })} />
          Buy ships automatically
        </label>
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={d.useFreight} onChange={(e) => setD({ ...d, useFreight: e.target.checked })} />
          Carry freight on empty legs
        </label>
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={d.byomBuilds} onChange={(e) => setD({ ...d, byomBuilds: e.target.checked })} />
          Build ships from materials bought at the yard (skips the 15% markup)
        </label>
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={d.convoys} onChange={(e) => setD({ ...d, convoys: e.target.checked })} />
          Sail in convoys with our other ships when it pays
        </label>
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={d.rivalIntel} onChange={(e) => setD({ ...d, rivalIntel: e.target.checked })} />
          Use rival intel (public policies, convoys, expansion deliveries) in charter races, stall holds and marques
        </label>
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={d.yardFactor} onChange={(e) => setD({ ...d, yardFactor: e.target.checked })} />
          With no ship at a shipyard, hire a factor there for a build (dismissed after)
        </label>
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={d.actOnEvents} onChange={(e) => setD({ ...d, actOnEvents: e.target.checked })} />
          Plan on world events (shortage bids, glut asks, crisis charters before their gossip)
        </label>
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={d.resizeLoads} onChange={(e) => setD({ ...d, resizeLoads: e.target.checked })} />
          Size each load again at its source with the cash there is then
        </label>
      </div>
      <div className="col-span-full space-y-2 rounded-lg border border-dashed p-3">
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="space-y-1">
            <Label>AI model</Label>
            <NativeSelect value={d.aiModel} onChange={(e) => setD({ ...d, aiModel: e.target.value as FleetSettings["aiModel"] })}>
              <option value="claude-opus-5-5">Claude Opus 5.5 (best; $4 / $20 per M tokens)</option>
              <option value="claude-sonnet-5-5">Claude Sonnet 5.5 (half the price; $2 / $10)</option>
            </NativeSelect>
          </div>
          <div className="space-y-1">
            <Label>AI thinking effort</Label>
            <NativeSelect value={d.aiEffort} onChange={(e) => setD({ ...d, aiEffort: e.target.value as FleetSettings["aiEffort"] })}>
              <option value="low">Low (cheapest)</option>
              <option value="medium">Medium</option>
              <option value="high">High (dearest)</option>
            </NativeSelect>
          </div>
          <div className="space-y-1">
            <Label>Minutes between AI calls</Label>
            <Input
              type="number"
              min={15}
              max={240}
              step={5}
              value={d.aiIntervalMin}
              onChange={(e) => setD({ ...d, aiIntervalMin: Number(e.target.value) })}
            />
          </div>
          <div className="space-y-1">
            <Label>AI spend cap per day (US$)</Label>
            <Input type="number" min={0} step="any" value={d.aiDailyCapUsd} onChange={(e) => setD({ ...d, aiDailyCapUsd: Math.max(0, Number(e.target.value) || 0) })} />
          </div>
          <div className="space-y-1">
            <Label>AI spend cap in total (US$)</Label>
            <Input type="number" min={0} step="any" value={d.aiTotalCapUsd} onChange={(e) => setD({ ...d, aiTotalCapUsd: Math.max(0, Number(e.target.value) || 0) })} />
          </div>
        </div>
        <p className="text-muted-foreground text-xs">
          The AI (Claude) is switched on and off on the panel itself. Thinking is most of a call&apos;s cost, so effort matters more than the
          model; calls come half as far apart near a phase turnover, events call sooner, and a routine call is skipped when nothing important
          changed. A call is skipped when its worst case could pass either cap.
        </p>
      </div>
      <div className="col-span-full space-y-2 rounded-lg border border-dashed p-3">
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="space-y-1">
            <Label>Cash kept back near a new phase (%)</Label>
            <Input
              type="number"
              min={0}
              max={90}
              step={5}
              value={d.phaseChestPct}
              onChange={(e) => setD({ ...d, phaseChestPct: Math.min(90, Math.max(0, Number(e.target.value))) })}
            />
          </div>
          <div className="space-y-1 sm:col-span-2">
            <label className="flex items-center gap-1.5 text-sm">
              <input type="checkbox" checked={d.captureEscalations} onChange={(e) => setD({ ...d, captureEscalations: e.target.checked })} />
              Let stalled expansion charters lapse for their richer re-post when that pays (on by default)
            </label>
            <label className="flex items-center gap-1.5 text-sm">
              <input type="checkbox" checked={d.holdForRepost} onChange={(e) => setD({ ...d, holdForRepost: e.target.checked })} />
              Always do so in a posting&apos;s last 4 game hours, whatever the math says (off by default)
            </label>
          </div>
        </div>
        <p className="text-muted-foreground text-xs">
          A posting under a tenth of its expected pace re-posts at about 25% more pay on 75% of the tons, and the higher pay stays for later
          postings; another company&apos;s delivery cancels that, and ours is taken to as well until re-posts show it doesn&apos;t. For each
          stalled posting the fleet weighs the extra pay on the tons it expects to deliver there, times the chance it escalates (from
          stalls seen, rival deliveries there, laden rivals inbound), against what waiting costs. While it lets one lapse, no ship delivers into it (once learned safe: only a whole load that keeps it under 80% of the pace line), the tons a load plans into it that land early wait in the roadstead, and ships take other work until a
          run lands just after the lapse; if a rival delivers, holders deliver at once. Once the tier is 90% done or due within 2 hours,
          and for an hour after it turns over, the buyer leaves the kept-back share of spare cash for the next tier&apos;s charters.
        </p>
      </div>
      <div className="col-span-full space-y-2 rounded-lg border border-dashed p-3">
        <label className="flex items-center gap-1.5 text-sm">
          <input type="checkbox" checked={d.underwrite} onChange={(e) => setD({ ...d, underwrite: e.target.checked })} />
          Underwrite other companies&apos; voyages (off by default)
        </label>
        <div className="grid gap-3 sm:grid-cols-3">
          {crField("Collateral budget (Cr)", "underwriteBudgetPence")}
          {crField("Most per policy (Cr)", "underwriteMaxPerPolicyPence")}
          <div className="space-y-1">
            <Label>Least edge (bps)</Label>
            <Input type="number" min={0} step={10} value={d.underwriteMinEdgeBps} onChange={(e) => setD({ ...d, underwriteMinEdgeBps: Math.max(0, Math.floor(Number(e.target.value))) })} />
          </div>
        </div>
        <p className="text-muted-foreground text-xs">
          Writes small slices only on fresh policies someone else (in practice Lloyd&apos;s) has already partly covered, whose premium
          beats the loss that cover implies by the least edge. A sinking pays out the whole slice of the sum insured. All escrow counts
          against the budget.
        </p>
      </div>
      <div className="col-span-full space-y-2 rounded-lg border border-dashed p-3">
        <label className="flex items-center gap-1.5 text-sm">
          <input type="checkbox" checked={d.leverage} onChange={(e) => setD({ ...d, leverage: e.target.checked })} />
          Borrow to bridge a new ship or a load our cash can&apos;t fund yet, only when it clearly pays (on by default)
        </label>
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="space-y-1">
            <Label>Most owed on loans (% of net worth)</Label>
            <Input
              type="number"
              min={0}
              max={100}
              step={5}
              disabled={!d.leverage}
              value={d.maxDebtPct}
              onChange={(e) => setD({ ...d, maxDebtPct: Math.min(100, Math.max(0, Number(e.target.value) || 0)) })}
            />
          </div>
          <div className="space-y-1">
            <Label>A loan must earn (× its interest)</Label>
            <Input
              type="number"
              min={1}
              max={20}
              step={0.5}
              disabled={!d.leverage}
              value={d.minLoanReturnX}
              onChange={(e) => setD({ ...d, minLoanReturnX: Math.min(20, Math.max(1, Number(e.target.value) || 1)) })}
            />
          </div>
        </div>
        <label className="flex items-center gap-1.5 text-sm">
          <input type="checkbox" checked={d.idleCash} onChange={(e) => setD({ ...d, idleCash: e.target.checked })} />
          Lend idle cash above the wealth levy&apos;s 500,000 Cr threshold on the credit board, secured by ship liens (on by default)
        </label>
        <p className="text-muted-foreground text-xs">
          A loan is taken only for a new ship our own cash can&apos;t cover yet (against cash due from cargo at sea, at most half the
          ship&apos;s cost) or for a load at its source that cash limits (with re-sizing at the source on), when what it earns over the
          loan&apos;s term is at least that multiple of its interest and it pays back within half the term. Lender: the cheapest standing
          credit-board offer in that region (never one of your companies&apos;, never dearer than the Goldsmiths&apos; 50 bps a game day),
          else the Goldsmiths&apos; Company against a lien on one of your ships that isn&apos;t insured, listed, in a convoy or already
          pledged (at most 40% of its value and 7,500 Cr, with recourse; a default seizes the ship and arrests her). What is owed is
          never spent on ships, marques, underwriting or lending, and loads never spend what a repayment counts on unless cash due lands
          first; the autopilot&apos;s loans are repaid early when no ship waits for cash, and every loan in full 2 game days before it
          matures (one of yours with a shorter term, half its term before; short then: all new spending stops until it is). No new loans
          in the season&apos;s last 12 hours, while one is overdue, or while our idle cash is on offer. Idle cash above the threshold, less
          25,000 Cr and anything the fleet needs, is offered at or just under the best rival rate (never under the levy&apos;s own 10 bps a
          game day; loans of at most half the pledged ship&apos;s value, with recourse) and taken back when the fleet needs it (a load cut
          to the cash there included) or we owe; a borrower that defaults hands us its pledged ship or goods. Lent cash isn&apos;t levied.
          Off here is off for Claude too: it may switch either off, never on.
        </p>
      </div>
      <div className="col-span-full space-y-2 rounded-lg border border-dashed p-3">
        <label className="flex items-center gap-1.5 text-sm">
          <input type="checkbox" checked={d.shipDeals} onChange={(e) => setD({ ...d, shipDeals: e.target.checked })} />
          Ship deals: buy ships for sale for less than building them, and build commissions to order (on by default)
        </label>
        <label className="flex items-center gap-1.5 text-sm">
          <input type="checkbox" checked={d.envelopes} onChange={(e) => setD({ ...d, envelopes: e.target.checked })} />
          Sell sealed news from our quays as intelligence envelopes (on by default)
        </label>
        <p className="text-muted-foreground text-xs">
          With ship deals on, the buyer also looks at the ships for sale wherever a ship of yours (or a factor) is in port: one priced under
          what building her class costs (her guns at their refit price) is bought when she passes every check a new ship must (allowed
          classes, max ships, payback on her first lane, upkeep, cash after the fleet&apos;s loads, the season). At yards where you have presence
          it takes a commission (a buyer&apos;s order for a hull) when the price beats your cheapest build there (turnkey, or own materials when
          that saves; own materials only when the turnkey walk draws on players&apos; asks, which a commission&apos;s build passes over for the
          buyer&apos;s) by at least 10% of the price and 1,000 Cr after the collateral&apos;s risk, with the cash for the build and the collateral
          after loads and time before its deadline, and builds and delivers it at once (the price and the collateral come back on delivery; a
          missed deadline forfeits the collateral). Never your own companies&apos; listings or commissions; your ships are never listed for sale.
          Envelopes: every 2 game hours at each of your quays, the port&apos;s coffee-house reports and sailing notices (only when none of
          yours is among them; and its non-public charters, only of goods the fleet isn&apos;t carrying, planning or letting lapse, withdrawn
          once it works one) are sealed and listed at 5-20 Cr an item, halved for every 12 game hours of age (10 Cr at least), for 24 game
          hours; unsold ones are withdrawn after 12. At most 16 open. Envelopes are never bought.
        </p>
      </div>
      <p className="col-span-full text-muted-foreground text-xs">
        Each gun takes 2 t of hold. Auto refits a ship at shipyard calls when it pays: in quiet Channel and North Sea water that means none.
        Expansion charters also earn a share of the phase-completion bonus when the tier fills; the percentage is how much of that
        expected share counts when choosing lanes and buy prices. Storm losses: the cargo storms are expected to destroy on each lane
        (learned from our own voyages; storm season, game months 11-2, roughly doubles it) counts at this percentage; 0 ignores storms.
        Stores are stocked for extra hits either way. A ship sailing to its source is planned on the cash spare when it gets there: cash in
        hand, less what our other ships&apos; loads spend first, plus the cash-due share of what our ships at sea are due to be paid before
        then (less the remittance fee). At the source the load is planned again with the cash there is then; a ship there keeps first
        call on the share of its own load planned on cash in hand, and waits for cash due rather than sail a sliver of a load that counted on it.
      </p>
      <div className="col-span-full flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button size="sm" type="submit" disabled={busy}>Save (applies immediately)</Button>
      </div>
    </form>
  );
}

export function FleetPanel() {
  const { portName, goodName, shipClassName } = useCatalog();
  // "rye flour + timber (sell) + freight", main good first.
  const loadText = (l: Lane) =>
    [
      ...(l.parts ?? []).map((p) => `${goodName(p.good)}${p.kind === "market" ? " (sell)" : ""}`),
      ...((l.freight ?? []).length ? ["freight"] : []),
    ].join(" + ") || goodName(l.good);
  const { data: view, error, reload } = usePoll(() => dash.get<FleetView>("/api/kibb/fleet"), 4_000);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  if (!view) return <Panel title="Fleet autopilot">{error ? <ErrorNote error={error} /> : <Loading />}</Panel>;

  const st = view.state;
  const on = view.enabled;
  const t = st?.totals;
  // The running autopilot's own reading (whoami), else the stored key's (a stopped one's reading may predate a renewal).
  const managerUp = st?.status === "running" || st?.status === "starting";
  const keyExpiresAt = (managerUp ? st?.keyExpiresAt : null) ?? view.keyExpiresAt ?? null;
  const keyLeft = keyExpiresAt ? Date.parse(keyExpiresAt) - Date.now() : null;
  const net = t ? t.rewardPence + t.freightPence - t.spentPence - t.shipSpendPence : 0;

  async function command(ai: "run" | "clear" | "retry") {
    setBusy(true);
    setActionError(null);
    try {
      await dash.post<FleetView>("/api/kibb/fleet", { ai });
      await reload();
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function send(body: { enabled?: boolean; settings?: Partial<FleetSettings> }) {
    setBusy(true);
    setActionError(null);
    try {
      await dash.post<FleetView>("/api/kibb/fleet", body);
      await reload();
      return true;
    } catch (e) {
      setActionError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  const statusBadge =
    st?.status === "running" ? <Badge variant="success">Running</Badge>
    : st?.status === "starting" ? <Badge variant="info">Starting</Badge>
    : st?.status === "failed" ? <Badge variant="error">Failed</Badge>
    : <Badge variant="secondary">Stopped</Badge>;

  const agents = st?.agents ?? [];
  const doing = (a: (typeof agents)[number]) => (a.status === "sailing" ? `→ ${portName(a.dest)} ${fmtIn(a.eta)}` : a.activity);
  const laneText = (a: (typeof agents)[number]) => (a.lane ? `${loadText(a.lane)}: ${portName(a.lane.source)} → ${portName(a.lane.dest)}` : null);
  const agentNet = (a: (typeof agents)[number]) => a.stats.rewardPence + a.stats.freightPence - a.stats.spentPence;
  // The buyer as it runs: the AI may switch it for its horizon, or order one build.
  // (A manager from before this report's shape, kept across a dev reload, reports none.)
  const aiActive = Array.isArray(st?.ai?.active?.settings) ? st!.ai.active : null;
  const aiBuy = aiActive?.settings.find((s) => s.key === "autoBuy")?.to;
  const aiBuild = aiActive?.buy?.build ?? null;
  const buyerOn = (typeof aiBuy === "boolean" ? aiBuy : view.settings.autoBuy) || !!aiBuild;

  return (
    <Panel
      title={
        <span className="flex items-center gap-2">
          Fleet autopilot {statusBadge}
          {st?.paused && (st.status === "running" || st.status === "starting") && (
            <Badge variant="warning" title="The operators paused the world: game time stands still and only reads are served. Ships wait; nothing is bought, sold or sailed until it resumes.">
              World paused
            </Badge>
          )}
        </span>
      }
      action={
        <>
          <Button size="sm" variant="ghost" onClick={() => setEditing(!editing)}>
            <Settings2Icon />
            {editing ? "Close" : "Settings"}
          </Button>
          <Button size="sm" variant={on ? "outline" : "default"} disabled={busy} onClick={() => void send({ enabled: !on })}>
            {on ? <SquareIcon /> : <PlayIcon />}
            {on ? "Stop" : "Start"}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <p className="text-muted-foreground text-sm">
          {st ? `${agents.length} ship${agents.length === 1 ? "" : "s"} under command` : "Not running since the server started"}
          {" · "}
          Buyer: {buyerOn ? (st?.buyer ?? "idle") : "off"}
          {typeof aiBuy === "boolean" ? " (AI)" : aiBuild ? " (AI build order)" : ""}
          {st?.season?.endsAt && (
            <span
              title={`The operators announced the season's end (it is ended by hand on that date). Only work landing at least 30 min before it is planned; in the last 12 h no hull is built.`}
            >
              {" · "}season ends {fmtIn(st.season.endsAt)}
              {st.season.mode === "final" ? ": final hours" : st.season.mode === "endgame" ? ": endgame, no new hulls" : ""}
            </span>
          )}
          {st && st.capitalRate > 0 && (
            <span title="Cash is what limits the fleet: lanes are charged for the money their loads tie up, at part of the fleet's own return on cash">
              {" · "}cash is scarce: loads charged {(st.capitalRate * 100).toFixed(2)}%/h of the money they tie up
            </span>
          )}
          {st?.cash?.levy && st.cash.levy.excessPence > 0 && (
            <span
              className="text-warning-foreground"
              title={`The Crown's wealth levy: idle vault cash above ${fmtCr(st.cash.levy.thresholdPence)} (all regions together) pays 0.1% of the excess every game day, about 6% a real day. Money working isn't levied: loads, escrow, loans out, deposits and venture stakes. While there is an excess, loads aren't charged for the cash they tie up.`}
            >
              {" · "}wealth levy ~{fmtCr(st.cash.levy.perDayPence)}/game day on {fmtCr(st.cash.levy.excessPence)} idle above {fmtCr(st.cash.levy.thresholdPence)}
            </span>
          )}
          {st?.finance && st.finance.debtPence > 0 && (
            <span
              className={st.finance.short ? "text-destructive" : undefined}
              title={`Owed on loans (principal and interest)${st.finance.capPence !== null ? `, within the cap of ${view.settings.maxDebtPct}% of net worth` : ""}; kept back from ships, marques, underwriting and lending, and repaid in full 2 game days before each matures.${st.finance.short ? ` SHORT: ${st.finance.short} (new spending stops until it is paid).` : ""}`}
            >
              {" · "}owe {fmtCr(st.finance.debtPence)}
              {st.finance.capPence !== null ? ` of ${fmtCr(st.finance.capPence)} cap` : ""}
              {st.finance.nextRepayBy ? `, repaid ${fmtIn(st.finance.nextRepayBy)}` : ""}
              {st.finance.short ? ": REPAYMENT SHORT" : ""}
            </span>
          )}
          {st?.finance && st.finance.offers.length > 0 && (
            <span title="Idle cash above the wealth levy's threshold offered on the credit board, secured by ship liens">
              {" · "}
              {fmtCr(st.finance.offers.reduce((n, o) => n + o.availablePence, 0))} offered on the credit board
            </span>
          )}
          {st?.cash && st.cash.duePence > 0 && (
            <span title="Cash pay due from our cargo at sea, at the share counted; loads bought after it lands may count on it">
              {" · "}
              {fmtCr(st.cash.duePence)} due from cargo at sea
            </span>
          )}
          {st?.cash?.bills && (
            <span
              title={`Billed every game day: fleet upkeep (sprawl, factors, oceanic hulls; what the ledger shows was charged when more) and warehouse rent per region${
                st.cash.bills.rent.length ? ` (${st.cash.bills.rent.map(([r, p]) => `${r} ${fmtCr(p)}`).join(", ")})` : ""
              }. The home region keeps 1.5 days of upkeep (or the reserve setting, if more) and every region 1.5 days of its rent; stores to sail safely may dip into that. ${
                st.cash.bills.measuredAt ? `Ledger read ${fmtAgo(new Date(st.cash.bills.measuredAt).toISOString())}.` : "Not read from the ledger yet."
              }${
                st.cash.autoRemit
                  ? st.cash.autoRemit.on
                    ? ` Auto-remit for bills: on${st.cash.autoRemit.reservePence > 0 ? `, keeping ${fmtCr(st.cash.autoRemit.reservePence)} in every region` : ""} (the company page's setting; the autopilot never changes it).`
                    : " Auto-remit for bills: off (each region pays its own; the company page can switch it on). The autopilot keeps the home vault at its floor from the other regions either way."
                  : ""
              }`}
            >
              {" · "}daily bills ~{fmtCr(st.cash.bills.upkeepPerDay + st.cash.bills.rent.reduce((n, [, p]) => n + p, 0))}, home keeps{" "}
              {fmtCr(st.cash.bills.homeFloor)}
            </span>
          )}
          {st?.cash && st.cash.resized.grown + st.cash.resized.shrunk + st.cash.resized.switched > 0 && (
            <span title="Loads planned again at their source with the cash there was then">
              {" · "}re-sized at source: {st.cash.resized.grown} up (+{fmtTons(st.cash.resized.tonsAdded)}),{" "}
              {st.cash.resized.shrunk} down (−{fmtTons(st.cash.resized.tonsCut)})
              {st.cash.resized.switched ? `, ${st.cash.resized.switched} swapped` : ""}
            </span>
          )}
        </p>

        {st?.announcement && (
          <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-destructive text-sm">
            <span className="font-medium">Critical notice from the operators</span> ({fmtAgo(st.announcement.at)}): {st.announcement.message || "no text given"}
          </p>
        )}
        <ErrorNote error={actionError ?? st?.error ?? null} />
        {on && view.resumeError && (
          <ErrorNote error={`The autopilot couldn't be resumed when the server started (${fmtAgo(view.resumeError.at)}): ${view.resumeError.error}`} />
        )}
        {keyLeft !== null && keyLeft < KEY_WARN_MS && (
          <p className="rounded-md bg-warning/10 px-3 py-2 text-sm text-warning-foreground">
            {keyLeft > 0 ? `The company key expires ${fmtIn(keyExpiresAt)}` : "The company key has expired"}: the autopilot stops when it does. The dashboard renews it
            while you are signed in; if this note stays, sign in again and <Link href="/companies" className="underline">select the company</Link>.
          </p>
        )}

        <AiPanel
          mode={view.settings.ai ?? "off"}
          report={st?.ai ?? null}
          running={st?.status === "running"}
          busy={busy}
          caps={{ daily: view.settings.aiDailyCapUsd, total: view.settings.aiTotalCapUsd }}
          ships={agents.map((a) => ({ shipId: a.shipId, name: a.name }))}
          onMode={(m) => {
            if (
              m === "live" &&
              !confirm(
                `Let Claude steer the autopilot for its horizon: any setting within your ceilings (ship limit and budgets never above yours, the reserve only raised, borrowing and idle-cash lending never on while yours are off), ` +
                  `bans on ports, zones, goods and charters, lane bias, stall calls, orders to single ships (a lane, a charter, a port, hold, release), ` +
                  `the ship buyer (hold, one build, classes forbidden), and marques or patrols within your marque budget (${fmtCr(view.settings.marqueBudgetPence)} a day; an issued one can't be withdrawn)? ` +
                  `Every autopilot check still runs. Spend is capped at $${view.settings.aiDailyCapUsd} a day and $${view.settings.aiTotalCapUsd} in total.`,
              )
            )
              return;
            void send({ settings: { ai: m } });
          }}
          onCommand={(cmd) => void command(cmd)}
        />

        {editing && (
          <SettingsForm
            settings={view.settings}
            busy={busy}
            onCancel={() => setEditing(false)}
            onSave={async (s) => {
              if (await send({ settings: s })) setEditing(false);
            }}
          />
        )}

        {t && (
          <div className="space-y-1.5">
            <Metrics
              items={[
                { label: "Net", value: <span className={net < 0 ? "text-destructive" : undefined}>{fmtCr(net)}</span> },
                { label: "Charter pay", value: fmtCr(t.rewardPence) },
                { label: "Freight", value: fmtCr(t.freightPence) },
                { label: "Cargo bought", value: fmtCr(t.spentPence) },
                { label: "Delivered", value: fmtTons(t.deliveredTons), hint: `${t.trips} trip${t.trips === 1 ? "" : "s"}` },
                { label: "Ships bought", value: t.shipsBought, hint: t.shipsBought ? fmtCr(t.shipSpendPence) : undefined },
              ]}
            />
            <p className="text-muted-foreground text-xs">
              Since {st?.progressSince ? fmtDateTime(st.progressSince) : "the autopilot started"}, kept across restarts. Cargo bought includes loads still on
              their way to a charter.
            </p>
          </div>
        )}

        {agents.length > 0 && (
          <>
            {/* Phones: one card per ship. */}
            <div className="space-y-2 md:hidden">
              {agents.map((a) => (
                <Link key={a.shipId} href={`/fleet/${a.shipId}`} className="block rounded-lg border p-3 transition-colors hover:bg-accent/50">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="truncate font-medium">{a.name}</span>
                    <span className="shrink-0 text-muted-foreground text-xs">{shipClassName(a.shipClass)}</span>
                  </div>
                  <div className="mt-1 text-sm">{doing(a)}</div>
                  {laneText(a) && <div className="mt-0.5 text-muted-foreground text-xs">{laneText(a)}</div>}
                  <div className="mt-2 flex justify-between gap-2 text-muted-foreground text-xs tabular-nums">
                    <span>{fmtTons(a.cargoTons)} / {fmtTons(a.hold)}</span>
                    <span>{a.stats.trips} trips</span>
                    <span>{fmtCr(agentNet(a))}</span>
                  </div>
                </Link>
              ))}
            </div>
            <Table head={["Ship", "Doing", "Lane", "Hold", "Trips", "Net"]} className="hidden md:block">
              {agents.map((a) => (
                <tr key={a.shipId} className="align-top">
                  <td className="whitespace-nowrap">
                    <Link href={`/fleet/${a.shipId}`} className="font-medium hover:underline">{a.name}</Link>
                    <div className="text-muted-foreground text-xs">{shipClassName(a.shipClass)}</div>
                    {a.arrested && (
                      <Badge variant="destructive" size="sm" title={`Arrested for a defaulted loan (${a.arrested}): she can't depart or join a convoy until the debt is paid or the lender takes her`}>
                        arrested
                      </Badge>
                    )}
                    {a.dispatchesSealed && (
                      <Badge variant="outline" size="sm" title="Dispatches sealed: this packet posts nothing to the coffee-house boards it calls at, so its news stays ours">
                        sealed
                      </Badge>
                    )}
                  </td>
                  <td className="text-xs">
                    {doing(a)}
                    {a.freight.length > 0 && <div className="text-muted-foreground">+ freight to {a.freight.map((f) => portName(f.dest)).join(", ")}</div>}
                  </td>
                  <td className="text-xs">
                    {a.lane ? (
                      <>
                        {laneText(a)}
                        <div className="text-muted-foreground">
                          ~{fmtCr(a.lane.margin)}/t · ~{fmtCr(a.lane.profitPerHour)}/h
                        </div>
                        {a.lane.resizedFrom !== undefined && a.lane.resizedFrom !== a.lane.tons && (
                          <div className="text-muted-foreground">
                            re-sized at source: {fmtTons(a.lane.resizedFrom)} → {fmtTons(a.lane.tons)}
                          </div>
                        )}
                      </>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="whitespace-nowrap tabular-nums">{fmtTons(a.cargoTons)} / {fmtTons(a.hold)}</td>
                  <td className="tabular-nums">{a.stats.trips}</td>
                  <td className="whitespace-nowrap tabular-nums">{fmtCr(agentNet(a))}</td>
                </tr>
              ))}
            </Table>
          </>
        )}

        {agents.length > 0 && <Efficiency agents={agents} startedAt={st?.progressSince ?? st?.startedAt ?? null} stoppedAt={st?.stoppedAt ?? null} />}

        {st?.expansion && <ExpansionWatchView x={st.expansion} />}

        {st?.worldEvents && <WorldEventsView w={st.worldEvents} />}

        {st?.underwriting && (
          <details className="text-sm">
            <summary className="cursor-pointer text-muted-foreground text-xs">
              Underwriting: {st.underwriting.action} · escrow {fmtCr(st.underwriting.lockedPence)} of {fmtCr(st.underwriting.budgetPence)}
            </summary>
            {st.underwriting.market && (
              <p className="mt-2 text-muted-foreground text-xs" title="From the Lloyd's List a quay of ours posts (display only: each policy is judged on its own listing's Lloyd's estimate and margin).">
                Lloyd&apos;s List, last {st.underwriting.market.windowDays} game days: player underwriters ({st.underwriting.market.players.underwriters}) loss ratio{" "}
                {st.underwriting.market.players.lossRatioBps === null ? "—" : fmtBps(st.underwriting.market.players.lossRatioBps)}, return on cover{" "}
                {st.underwriting.market.players.returnOnCoverBps === null ? "—" : fmtBps(st.underwriting.market.players.returnOnCoverBps)} over{" "}
                {st.underwriting.market.players.written} policies
                {st.underwriting.market.lloyds &&
                  `; Lloyd's loss ratio ${st.underwriting.market.lloyds.lossRatioBps === null ? "—" : fmtBps(st.underwriting.market.lloyds.lossRatioBps)} over ${st.underwriting.market.lloyds.written}`}
                {st.underwriting.market.openHere.length > 0 &&
                  ` · open for underwriting: ${st.underwriting.market.openHere.map(([p, n]) => `${p} ${n}`).join(", ")}`}
                {" "}(read {fmtAgo(new Date(st.underwriting.market.at).toISOString())})
              </p>
            )}
            {st.underwriting.rows.length === 0 ? (
              <Empty>No open policies from other companies.</Empty>
            ) : (
              <Table head={["Policy", "Premium", "Loss bound", "Edge", "Slice", "Verdict"]} className="mt-2">
                {st.underwriting.rows.map((u) => (
                  <tr key={u.policy} className="align-top">
                    <td className="text-xs">
                      <div className="font-medium text-sm">{u.lane}</div>
                      {u.cover === "hull" ? "hull only" : "with cargo"} · {fmtCr(u.insured)}
                    </td>
                    <td className="tabular-nums">{fmtBps(u.premiumBps)}</td>
                    <td className="tabular-nums">{u.lossBoundBps === null ? "—" : fmtBps(u.lossBoundBps)}</td>
                    <td className="tabular-nums">{u.edgeBps === null ? "—" : fmtBps(u.edgeBps)}</td>
                    <td className="whitespace-nowrap tabular-nums">{u.sliceBps ? `${fmtBps(u.sliceBps)} · ${fmtCr(u.collateral)}` : "—"}</td>
                    <td className="text-muted-foreground text-xs">{u.verdict}</td>
                  </tr>
                ))}
              </Table>
            )}
          </details>
        )}

        {st?.finance && <FinanceView f={st.finance} maxDebtPct={view.settings.maxDebtPct} shipName={(id) => agents.find((a) => a.shipId === id)?.name ?? id.slice(0, 8)} />}

        {st?.deals && <DealsView d={st.deals} />}

        <div className="grid items-start gap-5 xl:grid-cols-5">
          <div className="space-y-1.5 xl:col-span-3">
            <div className="text-muted-foreground text-xs">Log</div>
            <div className="max-h-80 min-h-20 overflow-y-auto rounded-lg bg-muted/40 p-3 font-mono text-xs leading-relaxed">
              {st && st.log.length > 0 ? (
                [...st.log].reverse().map((l, i) => (
                  <div key={`${l.at}-${i}`} className={l.msg.startsWith("FATAL") ? "text-destructive" : undefined}>
                    <span className="text-muted-foreground">{fmtTime(l.at)}</span>{" "}
                    <span className="text-primary">{l.source}</span> {l.msg}
                  </div>
                ))
              ) : (
                <Empty>{on ? "Waiting for the first log line…" : "Press Start to put every ship under the autopilot."}</Empty>
              )}
            </div>
          </div>

          <div className="space-y-5 xl:col-span-2">
            {st && st.topLanes.length > 0 && (
              <div className="space-y-1.5">
                <div className="text-muted-foreground text-xs">Best lanes right now (planner&apos;s view)</div>
                <Table head={["Lane", "Load", "Margin", "Piracy", "Storms", "Est. /h"]}>
                  {st.topLanes.map((l) => (
                    <tr key={l.key} className="align-top">
                      <td className="text-xs">
                        <div className="font-medium text-sm">{loadText(l)}</div>
                        {l.speculative && <Badge variant="info" size="sm" className="mr-1">crisis charter expected</Badge>}
                        {portName(l.source)} → {portName(l.dest)}
                        {l.next && <div className="text-muted-foreground">then {l.next}</div>}
                      </td>
                      <td className="tabular-nums">{fmtTons(l.tons)}</td>
                      <td className="whitespace-nowrap tabular-nums">
                        {fmtCr(l.margin)}/t{!l.askKnown && <span className="text-muted-foreground"> est.</span>}
                        {l.bonus > 0 && <div className="text-muted-foreground text-xs">incl. {fmtCr(l.bonus)} bonus</div>}
                      </td>
                      <td className="text-muted-foreground tabular-nums" title="Expected share of the load lost to pirates, priced into the margin">
                        {fmtBps(l.piracyBps ?? 0)}
                      </td>
                      <td className="text-muted-foreground tabular-nums" title="Expected share of the load storms destroy on the laden passage, priced into the margin">
                        {fmtBps(l.stormBps ?? 0)}
                      </td>
                      <td className="whitespace-nowrap tabular-nums">{fmtCr(l.profitPerHour)}</td>
                    </tr>
                  ))}
                </Table>
              </div>
            )}

            {st?.storms && (
              <p className="text-muted-foreground text-xs">
                {st.storms.season ? "Storm season (game months 11-2)" : "Calm season"}
                {st.storms.turnsAt && <>; storm season {st.storms.season ? "ends" : "starts"} {fmtIn(st.storms.turnsAt)}</>}. Storm odds per game day at sea:{" "}
                {st.storms.perDay.calm.toFixed(2)}× each zone&apos;s storm rate ({st.storms.perDay.storm.toFixed(2)}× in storm season), learned from {st.storms.seen} storm
                {st.storms.seen === 1 ? "" : "s"} met against {st.storms.expected} expected; a hit destroys {Math.round(st.storms.take * 100)}% of every stack.
              </p>
            )}

            {st && st.purchases.length > 0 && (
              <div className="space-y-1.5">
                <div className="text-muted-foreground text-xs">Ships bought</div>
                <ul className="space-y-1 text-xs">
                  {[...st.purchases].reverse().map((p) => (
                    <li key={p.shipId}>
                      <span className="text-muted-foreground">{fmtTime(p.at)}</span> {shipClassName(p.shipClass)} “{p.name}” {p.bought ? "bought for sale" : "built"} at{" "}
                      {portName(p.port)} for {fmtCr(p.costPence)} · payback ~{p.paybackHours} h
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>
      </div>
    </Panel>
  );
}

/** Where each ship's time goes, what it earns an hour, and its recent trips against the planner's estimate. */
function Efficiency({
  agents,
  startedAt,
  stoppedAt,
}: {
  agents: NonNullable<FleetView["state"]>["agents"];
  startedAt: string | null;
  stoppedAt: string | null;
}) {
  const { portName, goodName } = useCatalog();
  const zero: TimeUse = { laden: 0, ballast: 0, port: 0, idle: 0 };
  const timeOf = (a: (typeof agents)[number]) => a.time ?? zero;
  const fleet = agents.reduce<TimeUse>((t, a) => {
    const x = timeOf(a);
    return { laden: t.laden + x.laden, ballast: t.ballast + x.ballast, port: t.port + x.port, idle: t.idle + x.idle };
  }, zero);
  const total = fleet.laden + fleet.ballast + fleet.port + fleet.idle;
  const end = stoppedAt ? Date.parse(stoppedAt) : Date.now();
  const hours = startedAt ? Math.max((end - Date.parse(startedAt)) / 3_600_000, 1 / 60) : null;
  const trips = agents
    .flatMap((a) => (a.trips ?? []).map((t) => ({ ...t, ship: a.name })))
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 8);
  const laneLabel = (lane: string) => {
    const m = /^(\S+) (\S+) → (\S+)$/.exec(lane);
    return m ? `${goodName(m[1])}: ${portName(m[2])} → ${portName(m[3])}` : lane;
  };

  return (
    <div className="grid items-start gap-5 lg:grid-cols-2">
      <div className="space-y-2">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <span className="text-muted-foreground text-xs">Where the time goes</span>
          <span className="flex flex-wrap gap-x-3 gap-y-1 text-muted-foreground text-xs">
            {TIME_PARTS.map((p) => (
              <span key={p.key} className="flex items-center gap-1">
                <span className={`inline-block size-2 rounded-full ${p.className}`} />
                {p.label} {pct(fleet[p.key], total)}%
              </span>
            ))}
          </span>
        </div>
        <ul className="space-y-2">
          {agents.map((a) => {
            const net = a.stats.rewardPence + a.stats.freightPence - a.stats.spentPence;
            return (
              <li key={a.shipId} className="space-y-1">
                <div className="flex items-baseline justify-between gap-2 text-xs">
                  <span className="truncate font-medium">
                    {a.name} <span className="font-normal text-muted-foreground">· {a.guns ?? "?"} guns</span>
                  </span>
                  <span className="shrink-0 text-muted-foreground tabular-nums">{hours ? `${fmtCr(net / hours)}/h` : "—"}</span>
                </div>
                <TimeBar t={timeOf(a)} />
              </li>
            );
          })}
        </ul>
        <p className="text-muted-foreground text-xs">Cr/h is net cash since the autopilot started; cargo still aboard counts as spent until it is delivered.</p>
      </div>

      <div className="space-y-1.5">
        <div className="text-muted-foreground text-xs">Recent trips: planner&apos;s cash estimate against what it made (both up to delivery, phase bonus excluded)</div>
        {trips.length === 0 ? (
          <Empty>No completed trips yet.</Empty>
        ) : (
          <Table head={["Trip", "Tons", "Est. /h", "Made /h"]}>
            {trips.map((t) => (
              <tr key={`${t.ship}-${t.at}`}>
                <td className="text-xs">
                  <div className="font-medium text-sm">{t.ship}</div>
                  {laneLabel(t.lane)} · {t.hours} h
                </td>
                <td className="tabular-nums">
                  {fmtTons(t.tons)}
                  {t.resizedTons ? (
                    <div className="text-muted-foreground text-xs">
                      {t.resizedTons > 0 ? "+" : ""}
                      {t.resizedTons} t at source
                    </div>
                  ) : null}
                </td>
                <td className="whitespace-nowrap tabular-nums">{fmtCr(t.estPerHour)}</td>
                <td className={`whitespace-nowrap tabular-nums ${t.actualPerHour < t.estPerHour * 0.7 ? "text-destructive" : ""}`}>
                  {fmtCr(t.actualPerHour)}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </div>
    </div>
  );
}

/** The expansion tier as the autopilot follows it: pace, the cash kept back, and each charter's posting. */
function ExpansionWatchView({ x }: { x: NonNullable<NonNullable<FleetView["state"]>["expansion"]> }) {
  const { portName, goodName } = useCatalog();
  const stalled = x.charters.filter((c) => c.stalled);
  const eta = x.etaMs !== null ? fmtIn(new Date(Date.now() + x.etaMs).toISOString()) : "no pace yet";
  return (
    <details className="text-sm">
      <summary className="cursor-pointer text-muted-foreground text-xs">
        Phase {x.targetPhase} tier: {fmtBps(x.progressBps)} done, completes {eta}
        {x.phaseSoon ? " · buyer keeping cash back for it" : ""}
        {stalled.length > 0 ? ` · ${stalled.length} stalled charter${stalled.length === 1 ? "" : "s"}` : ""}
      </summary>
      {x.charters.length === 0 ? (
        <Empty>No open expansion charters.</Empty>
      ) : (
        <Table head={["Charter", "Pay now", "Tons left", "Lapses", "If it re-posts stalled", "State", "Fleet's call"]} className="mt-2">
          {x.charters.map((c) => {
            const st = x.stakes.find((s) => s.key === `${c.port}|${c.good}`);
            return (
              <tr key={`${c.port}|${c.good}`} className="align-top">
                <td className="text-xs">
                  <div className="font-medium text-sm">
                    {goodName(c.good)} → {portName(c.port)}
                  </div>
                  {c.beyondCoastal && <Badge variant="warning" size="sm">beyond coastal water</Badge>}
                  {c.escalations > 0 && <span className="ml-1 text-muted-foreground">re-posted ×{c.escalations}</span>}
                </td>
                <td className="tabular-nums">{fmtCr(c.rate)}/t</td>
                <td className="tabular-nums">{fmtTons(c.remaining)}</td>
                <td className="whitespace-nowrap text-xs">{c.expiresAt ? fmtIn(new Date(c.expiresAt).toISOString()) : "—"}</td>
                <td className="whitespace-nowrap tabular-nums text-xs">
                  {fmtCr(Math.round(c.rate * x.escalation.pay))}/t on {fmtTons(Math.floor(c.remaining * x.escalation.tons))}
                </td>
                <td className="text-xs">
                  {c.stalled ? (
                    <>
                      <Badge variant="warning" size="sm">stalled</Badge>
                      {c.delivered !== undefined && c.line !== undefined && (
                        <div className="text-muted-foreground">
                          {fmtTons(c.delivered)} of {fmtTons(Math.round(c.line))} pace line
                        </div>
                      )}
                    </>
                  ) : c.underPace && c.rivalDelivered ? (
                    <span className="text-muted-foreground">under pace, but another company delivered</span>
                  ) : c.underPace && (c.ownTons ?? 0) > 0 ? (
                    <span className="text-muted-foreground">under pace, our {fmtTons(c.ownTons)} (taken to cancel it until learned)</span>
                  ) : (
                    <span className="text-muted-foreground">being filled</span>
                  )}
                </td>
                <td className="text-xs">
                  {st ? (
                    <>
                      {st.camp ? <Badge variant="info" size="sm">letting it lapse</Badge> : <span className="text-muted-foreground">delivering</span>}
                      <div className="text-muted-foreground">
                        ~{Math.round(st.p * 100)}% it escalates · worth ~{fmtCr(st.value)} vs ~{fmtCr(st.cost)} waiting
                      </div>
                      <div className="text-muted-foreground">{st.why}</div>
                    </>
                  ) : (
                    "—"
                  )}
                </td>
              </tr>
            );
          })}
        </Table>
      )}
      {x.rivalDeliveries.length > 0 && (
        <div className="mt-2 text-xs">
          <div className="font-medium">Rival deliveries seen this tier</div>
          <ul className="text-muted-foreground">
            {x.rivalDeliveries.slice(0, 8).map((r) => (
              <li key={`${r.at}|${r.port}|${r.good}`}>
                {fmtAgo(new Date(r.at).toISOString())}: {r.company ?? "a rival"}, {fmtTons(r.tons)} {goodName(r.good)} → {portName(r.port)}
              </li>
            ))}
          </ul>
        </div>
      )}
      {x.trickle && (
        <p className="mt-2 text-muted-foreground text-xs">
          Our own small deliveries into a stalled posting:{" "}
          {x.trickle.allowed
            ? `allowed up to 80% of its pace line (re-posts escalated after only ours ${x.trickle.confirmed} times in a row; ${x.trickle.refuted} counter-example${x.trickle.refuted === 1 ? "" : "s"} before)`
            : `assumed to cancel the re-post (${x.trickle.confirmed} of ${x.trickle.needed} confirmations, ${x.trickle.refuted} counter-example${x.trickle.refuted === 1 ? "" : "s"})`}
          .
        </p>
      )}
      <p className="mt-2 text-muted-foreground text-xs">
        Stalled (the guide): under a tenth of its expected pace (its tons spread over its window) delivered in this posting so far, and no other
        company&apos;s delivery in it (any cancels the escalation; our own other companies count as others). Our own deliveries are taken to cancel it
        too, until {x.trickle?.needed ?? 2} re-posts in a row after only ours under the line still escalate; one that doesn&apos;t switches that off
        again. If it lasts until it lapses, it re-posts at about {Math.round((x.escalation.pay - 1) * 100)}% more pay on{" "}
        {Math.round(x.escalation.tons * 100)}% of the tons (learned from escalations seen). Lanes landing after the lapse count that. The fleet&apos;s
        call: let it lapse when the expected extra pay beats waiting (the odds count stalls seen, rival deliveries there and laden rivals due first);
        rival deliveries come from the public contributor board.
      </p>
    </details>
  );
}

/** Leverage and idle cash: what we owe and the cap, each loan, loans we made, our credit-board offers. */
function FinanceView({ f, maxDebtPct, shipName }: { f: FinanceReport; maxDebtPct: number; shipName: (id: string) => string }) {
  const lentOut = f.lent.reduce((n, l) => n + Math.max(0, l.owedPence), 0);
  const offered = f.offers.reduce((n, o) => n + o.availablePence, 0);
  const pledge = (l: FinanceLoanRow) => (l.shipId ? `lien on ${shipName(l.shipId)}` : l.collateral.replace(/_/g, " "));
  return (
    <details className="text-sm">
      <summary className="cursor-pointer text-muted-foreground text-xs">
        Loans: {f.debtPence > 0 ? `owe ${fmtCr(f.debtPence)}` : "nothing owed"}
        {f.capPence !== null && ` (cap ${fmtCr(f.capPence)}: ${maxDebtPct}% of ~${fmtCr(f.netWorthPence)} net worth${f.worthSource === "estimate" ? ", our estimate" : ""})`}
        {f.nextRepayBy && ` · repaid in full ${fmtIn(f.nextRepayBy)}`}
        {` · interest paid ~${fmtCr(f.interestPaidPence)}`}
        {lentOut > 0 && ` · borrowers owe us ${fmtCr(lentOut)}`}
        {f.interestEarnedPence > 0 && ` · interest earned ~${fmtCr(f.interestEarnedPence)}`}
        {offered > 0 && ` · ${fmtCr(offered)} on the credit board`}
        {!f.leverage && " · leverage off"}
        {!f.idleCash && " · idle-cash lending off"}
      </summary>
      {f.short && (
        <p className="mt-2 rounded-md bg-destructive/10 px-3 py-2 text-destructive text-xs">
          A loan due can&apos;t be repaid in full yet ({f.short}): no new loads, ships, marques or lending until it is; cash is remitted to its region.
        </p>
      )}
      <p className="mt-2 text-muted-foreground text-xs">
        {f.action}. Idle cash: {f.idle}.{f.pending > 0 ? ` ${f.pending} credit call${f.pending === 1 ? "" : "s"} with no answer, being looked for among our loans and offers (never sent again).` : ""}
        {f.checkedAt && ` Checked ${fmtAgo(f.checkedAt)}.`}
      </p>
      {f.borrowed.length > 0 && (
        <Table head={["We owe", "Rate", "Repaid by", "For", "Pledge"]} className="mt-2">
          {f.borrowed.map((l) => (
            <tr key={l.id} className="align-top">
              <td className="whitespace-nowrap tabular-nums">
                {fmtCr(l.owedPence)}
                <div className="text-muted-foreground text-xs">of {fmtCr(l.principalPence)} in {l.region.replace(/_/g, " ")}</div>
              </td>
              <td className="whitespace-nowrap tabular-nums">{l.rateBps} bps/day</td>
              <td className="whitespace-nowrap text-xs">
                {l.status === "defaulted" ? <Badge variant="destructive" size="sm">defaulted</Badge> : l.repayBy ? fmtIn(l.repayBy) : "—"}
                {l.maturesAt && <div className="text-muted-foreground">matures {fmtIn(l.maturesAt)}</div>}
              </td>
              <td className="text-xs">{l.purpose ?? <span className="text-muted-foreground">taken by hand</span>}</td>
              <td className="text-xs">{pledge(l)}</td>
            </tr>
          ))}
        </Table>
      )}
      {f.lent.length > 0 && (
        <Table head={["We lent", "Owed to us", "Rate", "Matures", "Pledge", "State"]} className="mt-2">
          {f.lent.map((l) => (
            <tr key={l.id} className="align-top">
              <td className="whitespace-nowrap tabular-nums">{fmtCr(l.principalPence)}</td>
              <td className="whitespace-nowrap tabular-nums">{fmtCr(l.owedPence)}</td>
              <td className="whitespace-nowrap tabular-nums">{l.rateBps} bps/day</td>
              <td className="whitespace-nowrap text-xs">{l.maturesAt ? fmtIn(l.maturesAt) : "—"}</td>
              <td className="text-xs">{l.collateral.replace(/_/g, " ")}</td>
              <td className="text-xs">{l.status === "defaulted" ? <Badge variant="destructive" size="sm">defaulted: its pledge comes to us</Badge> : l.status}</td>
            </tr>
          ))}
        </Table>
      )}
      {f.offers.length > 0 && (
        <Table head={["Our credit-board offer", "Left to lend", "Rate", "Lapses"]} className="mt-2">
          {f.offers.map((o) => (
            <tr key={o.id}>
              <td className="text-xs">{o.region.replace(/_/g, " ")} · ship liens, ≤ 50% of value, with recourse</td>
              <td className="whitespace-nowrap tabular-nums">{fmtCr(o.availablePence)}</td>
              <td className="whitespace-nowrap tabular-nums">{o.rateBps} bps/day</td>
              <td className="whitespace-nowrap text-xs">{o.expiresAt ? fmtIn(o.expiresAt) : "—"}</td>
            </tr>
          ))}
        </Table>
      )}
      <p className="mt-2 text-muted-foreground text-xs">
        Net worth for the cap is the hourly leaderboard&apos;s figure for this company while fresh, else our own estimate (vaults and escrow, ships
        at the cheapest quote seen, goods at base, less what is owed). Interest accrues every game day on what is still owed; repaying early pays
        interest only to date.
      </p>
    </details>
  );
}

/** Ships for sale and commissions at our quays, ours being built, and our sealed-news envelopes. */
function DealsView({ d }: { d: DealsReport }) {
  const { portName, shipClassName } = useCatalog();
  const building = d.ours.filter((c) => c.status !== "delivered" && c.status !== "failed");
  return (
    <details className="text-sm">
      <summary className="cursor-pointer text-muted-foreground text-xs">
        Ship deals: {d.shipsBought} bought for sale · {d.commissionsDelivered} built to order (~{fmtCr(d.commissionNetPence)} over the builds)
        {building.length > 0 && ` · ${building.length} being built`} · envelopes: {d.openEnvelopes.length} open, {d.envelopesSold} sold for {fmtCr(d.envelopeIncomePence)}
        {!d.shipDeals && " · ship deals off"}
        {!d.envelopes && " · envelopes off"}
      </summary>
      <p className="mt-2 text-muted-foreground text-xs">
        {d.action}. Envelopes: {d.envelopeAction}.
      </p>
      {d.listings.length > 0 && (
        <Table head={["For sale", "Price", "Building", "Verdict"]} className="mt-2">
          {d.listings.map((l) => (
            <tr key={l.id} className="align-top">
              <td className="text-xs">
                <div className="font-medium text-sm">{shipClassName(l.cls)} “{l.name}”</div>
                {portName(l.port)}{l.guns > 0 ? ` · ${l.guns} guns` : ""}
              </td>
              <td className="whitespace-nowrap tabular-nums">{fmtCr(l.pricePence)}</td>
              <td className="whitespace-nowrap tabular-nums">{l.buildPence === null ? "—" : fmtCr(l.buildPence)}</td>
              <td className="text-muted-foreground text-xs">{l.verdict}</td>
            </tr>
          ))}
        </Table>
      )}
      {d.listingsAt && d.listings.length === 0 && <p className="mt-2 text-muted-foreground text-xs">No ships for sale at our quays at the buyer&apos;s last look ({fmtAgo(d.listingsAt)}).</p>}
      {d.ours.length > 0 && (
        <Table head={["Commission (ours)", "Price", "Collateral", "Deadline", "State"]} className="mt-2">
          {d.ours.map((c) => (
            <tr key={c.id} className="align-top">
              <td className="text-xs">{shipClassName(c.cls)} at {portName(c.yard)}</td>
              <td className="whitespace-nowrap tabular-nums">{fmtCr(c.pricePence)}</td>
              <td className="whitespace-nowrap tabular-nums">{fmtCr(c.collateralPence)}</td>
              <td className="whitespace-nowrap text-xs">{c.expiresAt ? fmtIn(c.expiresAt) : "—"}</td>
              <td className="text-xs">
                <Badge variant={c.status === "delivered" ? "success" : c.status === "failed" ? "destructive" : "secondary"} size="sm">{c.status}</Badge>
                {c.note && <div className="text-muted-foreground">{c.note}</div>}
              </td>
            </tr>
          ))}
        </Table>
      )}
      {d.commissions.length > 0 && (
        <Table head={["Open commission", "Price", "Collateral", "Our build", "Margin", "Verdict"]} className="mt-2">
          {d.commissions.map((c) => (
            <tr key={c.id} className="align-top">
              <td className="text-xs">
                {shipClassName(c.cls)} at {portName(c.yard)}
                {c.expiresAt && <div className="text-muted-foreground">deadline {fmtIn(c.expiresAt)}</div>}
              </td>
              <td className="whitespace-nowrap tabular-nums">{fmtCr(c.pricePence)}</td>
              <td className="whitespace-nowrap tabular-nums">{fmtCr(c.collateralPence)}</td>
              <td className="whitespace-nowrap tabular-nums">{c.costPence === null ? "—" : fmtCr(c.costPence)}</td>
              <td className="whitespace-nowrap tabular-nums">{c.marginPence === null ? "—" : fmtCr(c.marginPence)}</td>
              <td className="text-muted-foreground text-xs">{c.verdict}</td>
            </tr>
          ))}
        </Table>
      )}
      {d.openEnvelopes.length > 0 && (
        <Table head={["Our envelope", "Price", "Listed", "Lapses"]} className="mt-2">
          {d.openEnvelopes.map((e) => (
            <tr key={e.id}>
              <td className="text-xs">{portName(e.port)} · {e.kind === "news" ? "port reports and sailings" : "non-public charters"}</td>
              <td className="whitespace-nowrap tabular-nums">{fmtCr(e.pricePence)}</td>
              <td className="whitespace-nowrap text-xs">{e.createdAt ? fmtAgo(e.createdAt) : "—"}</td>
              <td className="whitespace-nowrap text-xs">{e.expiresAt ? fmtIn(e.expiresAt) : "—"}</td>
            </tr>
          ))}
        </Table>
      )}
    </details>
  );
}

/** World events in force, what the planner makes of each, and what it has learned from them. */
function WorldEventsView({ w }: { w: NonNullable<FleetView["state"]>["worldEvents"] }) {
  const { catalog, portName, goodName } = useCatalog();
  const zoneName = (id: string | null) => (id ? (catalog?.sea_zones.find((z) => z.id === id)?.name ?? id) : "—");
  const learned = (f: { ratio: number; n: number }) => `${f.ratio.toFixed(2)}×${f.n ? ` (${f.n} seen)` : " (guess)"}`;
  const lapse = (ms: number) => {
    const iso = new Date(ms).toISOString();
    return ms > Date.now() ? fmtIn(iso) : `lapsed ${fmtAgo(iso)}`;
  };
  return (
    <details className="text-sm">
      <summary className="cursor-pointer text-muted-foreground text-xs">
        World events: {w.rows.length} in force{w.enabled ? "" : " · not planned on (setting off)"} · shortage bids {learned(w.shortageBid)} base · glut asks{" "}
        {learned(w.glutAsk)} · crisis pay {learned(w.crisisPay)}, found {Math.round(w.crisisFound.rate * 100)}%
        {w.crisisFound.n ? ` (${w.crisisFound.n} looked for)` : " (guess)"}
      </summary>
      {w.rows.length === 0 ? (
        <Empty>No world events in force.</Empty>
      ) : (
        <Table head={["Event", "Where", "What the planner does", "News lapses"]} className="mt-2">
          {w.rows.map((e) => (
            <tr key={e.id} className="align-top" title={e.title}>
              <td className="text-xs">
                <div className="font-medium text-sm">{e.type.replace(/_/g, " ")}</div>
                {e.good && goodName(e.good)}
              </td>
              <td className="text-xs">{e.port ? portName(e.port) : zoneName(e.zone)}</td>
              <td className="text-xs">
                {e.crisis && (
                  <Badge variant={e.crisis === "found" ? "success" : e.crisis === "expected" ? "info" : "outline"} size="sm" className="mr-1">
                    crisis {e.crisis}
                  </Badge>
                )}
                {e.effect}
              </td>
              <td className="whitespace-nowrap text-xs">{lapse(e.expiresAt)}</td>
            </tr>
          ))}
        </Table>
      )}
      <p className="mt-2 text-muted-foreground text-xs">
        Events say what happened where, never by how much. A shortage&apos;s bid and a glut&apos;s ask are learned from the books our ships read
        while one is on, and fade to nothing by the news&apos; lapse. A shortage&apos;s crisis charter is listed only on its quay or as gossip
        later: until then lanes count it as expected, at most one load at a time. Trips on it show estimate against actual under Recent trips.
      </p>
    </details>
  );
}

const usd = (n: number) => `$${n.toFixed(n < 1 ? 3 : 2)}`;

/** A setting's value as the user would read it. */
function showSetting(key: string, v: unknown, cls: (id: string) => string): string {
  if (typeof v === "boolean") return v ? "on" : "off";
  if (Array.isArray(v)) return v.map((c) => cls(String(c))).join(", ") || "none";
  if (typeof v !== "number") return String(v);
  return key.endsWith("Pence") ? fmtCr(v) : key.endsWith("Pct") ? `${v}%` : key.endsWith("Bps") ? `${v} bps` : key === "maxPaybackHours" ? `${v} h` : String(v);
}

const statusVariant = (s: string) => (s === "active" || s === "done" || s === "issued" ? "success" : s === "refused" || s === "unknown" ? "warning" : "secondary");

/** One directive in force: what, its status (orders), why, and any detail the game gave. */
function DirectiveRow({ what, reason, status, code, note }: { what: string; reason?: string; status?: string; code?: string; note?: string }) {
  return (
    <li className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
      <span>{what}</span>
      {status && (
        <Badge variant={statusVariant(status)} size="sm">
          {status}
          {code ? `: ${code.replace(/_/g, " ")}` : ""}
        </Badge>
      )}
      {reason && <span className="text-muted-foreground">· {reason}</span>}
      {note && <span className="text-muted-foreground">({note})</span>}
    </li>
  );
}

/** AI support (Claude as strategist): the switch, what it costs, what it's doing and why. */
function AiPanel({
  mode,
  report,
  running,
  busy,
  caps,
  ships,
  onMode,
  onCommand,
}: {
  mode: AiMode;
  report: AiReport | null;
  running: boolean;
  busy: boolean;
  caps: { daily: number; total: number };
  /** Our ships' names: the AI only ever sees aliases, the owner sees names. */
  ships: Array<{ shipId: string; name: string }>;
  onMode: (m: AiMode) => void;
  onCommand: (cmd: "run" | "clear" | "retry") => void;
}) {
  const { portName, shipClassName } = useCatalog();
  const r = report;
  // (A manager from before this report's shape, kept across a dev reload, shows none.)
  const a = r?.active && Array.isArray(r.active.settings) ? r.active : null;
  const shipName = (id: string) => ships.find((s) => s.shipId === id)?.name ?? "a ship no longer in the fleet";
  const orderText = (o: { order: string; label: string }) =>
    o.order === "lane" ? `take the lane ${o.label}` : o.order === "charter" ? `fill the ${o.label}` : o.order === "port" ? `go to ${portName(o.label)}` : o.order === "hold" ? "hold in the roadstead" : "drop its planned lane";
  const navalText = (n: { kind: string; bps: number; zone: string; gameHours: number; costPence: number }) =>
    `${n.kind === "marque" ? "letter of marque +" : "naval patrol −"}${n.bps} bps in ${n.zone} for ${n.gameHours} game h, ${n.costPence > 0 ? `~${fmtCr(n.costPence)}` : "at the zone's quoted price"}`;
  // A money order: borrow for a ship's load (named here: the AI only saw an alias), for a hull, repay a loan, build a commission.
  const moneyText = (o: { kind: string; ref: string; pence: number; label: string }) =>
    o.kind === "borrow_load" ? `Borrow up to ${fmtCr(o.pence)} for ${shipName(o.ref)}'s next load` : o.kind === "borrow_hull" ? `Borrow up to ${fmtCr(o.pence)} for a new ship` : o.label.charAt(0).toUpperCase() + o.label.slice(1);
  const status = !r
    ? mode === "off"
      ? "Off."
      : "Starts with the autopilot."
    : r.effective === "off"
      ? "Off."
      : !r.configured
        ? "ANTHROPIC_API_KEY isn't set in .env.local: no calls are made."
        : r.running
          ? "Thinking…"
          : `${!running ? "Paused while the autopilot is stopped. " : ""}${r.demoted ? "Demoted to shadow by its own record. " : ""}${r.model}, ${r.effort} effort, every ${r.intervalMin} min. ` +
            `${r.lastRunAt ? `Last call ${fmtTime(r.lastRunAt)}` : "No call yet"}${running && r.nextRunAt ? `, next ${fmtIn(r.nextRunAt)}` : ""}` +
            `${r.skipped ? ` (${r.skipped} quiet call${r.skipped === 1 ? "" : "s"} skipped)` : ""}.`;
  return (
    <div className="space-y-3 rounded-lg border p-3 sm:p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-0.5">
          <div className="font-medium text-sm">AI support (Claude)</div>
          <div className="text-muted-foreground text-xs">{status}</div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="w-full sm:w-64">
            <Segmented<AiMode>
              value={mode}
              onChange={(m) => m !== mode && !busy && onMode(m)}
              options={[
                { value: "off", label: "Off" },
                { value: "shadow", label: "Shadow" },
                { value: "live", label: "Live" },
              ]}
            />
          </div>
          {running && mode !== "off" && (
            <Button size="sm" variant="outline" disabled={busy || !!r?.running || !r?.configured} onClick={() => onCommand("run")}>
              Ask now
            </Button>
          )}
          {r?.demoted && mode === "live" && (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => onCommand("retry")}>
              Retry live
            </Button>
          )}
          {a && (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => onCommand("clear")}>
              Clear its changes
            </Button>
          )}
        </div>
      </div>
      <p className="text-muted-foreground text-xs">
        Shadow: Claude advises and every answer is logged, nothing changes. Live: its directives apply until they lapse (15-180 min): any
        setting but its own within your ceilings (max ships, the marque and underwriting budgets, the debt cap and the cash due counted
        never above yours, the reserve only raised, borrowing and idle-cash lending never switched on while yours are off), bans on ports, sea zones, goods and charters, a bias on lane ranks, calls on stalled expansion charters, orders to single
        ships (a lane, a charter, a port, hold in the roadstead, drop a planned lane), the ship buyer (hold, one build, classes forbidden),
        marques or patrols within your marque budget (set it to 0 to forbid them; an issued one runs its term and can&apos;t be withdrawn), and
        money orders: borrow for a ship&apos;s load or a new ship (within your debt cap and required return), repay a loan early, build a
        commission to order.
        Every autopilot check still runs; what it refuses goes back to Claude as a status. Held ships count as idle for the tripwire. It
        drops back to shadow by itself if trips under its advice earn clearly less.
      </p>
      {r && (
        <>
          <ErrorNote error={r.lastError} />
          <Metrics
            className="sm:grid-cols-4 xl:grid-cols-4"
            items={[
              { label: "Spent today", value: usd(r.spend.today), hint: `cap ${usd(caps.daily)}${r.avgCostUsd !== null ? ` · ~${usd(r.avgCostUsd)} a call` : ""}` },
              { label: "Spent in total", value: usd(r.spend.total), hint: `cap ${usd(caps.total)}` },
              {
                label: "Trips under its advice",
                value: r.uplift.aiTrips,
                hint: r.uplift.aiPerHour !== null ? `${fmtCr(r.uplift.aiPerHour)}/h on average` : undefined,
              },
              {
                label: "Trips without",
                value: r.uplift.baseTrips,
                hint: r.uplift.basePerHour !== null ? `${fmtCr(r.uplift.basePerHour)}/h on average` : undefined,
              },
            ]}
          />
          {a && (
            <div className="space-y-1 rounded-md bg-accent/40 px-3 py-2 text-sm">
              <div className="font-medium">{running ? `In force until ${fmtTime(a.until)}` : `Paused (autopilot stopped); in force until ${fmtTime(a.until)} if it restarts`}</div>
              <ul className="space-y-1 text-xs">
                {a.settings.map((s) => (
                  <DirectiveRow key={`s:${s.key}`} what={`${s.key}: ${showSetting(s.key, s.from, shipClassName)} → ${showSetting(s.key, s.to, shipClassName)}`} reason={s.reason} />
                ))}
                {a.avoid.map((b, i) => (
                  <DirectiveRow key={`a:${i}`} what={`Avoid ${b.label}`} reason={b.reason} />
                ))}
                {a.biases.map((b, i) => (
                  <DirectiveRow key={`b:${i}`} what={`Lane bias ${b.label} ×${b.factor}`} reason={b.reason} />
                ))}
                {a.stallCalls.map((s, i) => (
                  <DirectiveRow key={`c:${i}`} what={`Stall call ${s.label}: ${s.call}`} reason={s.reason} />
                ))}
                {a.shipOrders.map((o) => (
                  <DirectiveRow key={`o:${o.shipId}`} what={`${shipName(o.shipId)}: ${orderText(o)}`} reason={o.reason} status={o.status} code={o.code} note={o.note} />
                ))}
                {a.buy.hold && <DirectiveRow what="Ship buyer on hold" reason={a.buy.hold} />}
                {a.buy.build && (
                  <DirectiveRow
                    what={`Build a ${shipClassName(a.buy.build.cls)} at ${portName(a.buy.build.yard)}`}
                    reason={a.buy.build.reason}
                    status={a.buy.build.status}
                    code={a.buy.build.code}
                    note={a.buy.build.status === "done" ? undefined : a.buy.build.note}
                  />
                )}
                {a.buy.forbid.length > 0 && <DirectiveRow what={`The buyer may not build: ${a.buy.forbid.map(shipClassName).join(", ")}`} />}
                {a.naval.map((n) => (
                  <DirectiveRow key={`n:${n.id}`} what={navalText(n)} reason={n.reason} status={n.status} code={n.code} note={n.note} />
                ))}
                {(a.finance ?? []).map((o) => (
                  <DirectiveRow key={`f:${o.id}`} what={moneyText(o)} reason={o.reason} status={o.status} code={o.code} note={o.status === "done" ? undefined : o.note} />
                ))}
              </ul>
              {a.naval.length > 0 && (
                <div className="text-muted-foreground text-xs">An issued marque or patrol runs its term (at most this advice&apos;s horizon): clearing the AI&apos;s changes doesn&apos;t withdraw it.</div>
              )}
            </div>
          )}
          {r.decisions.length > 0 && (
            <details className="text-sm">
              <summary className="cursor-pointer text-muted-foreground text-xs">
                Recent advice ({r.decisions.length}): latest {r.decisions[0].posture}, {r.decisions[0].status}
              </summary>
              <div className="mt-2 space-y-2">
                {r.decisions.map((x) => (
                  <div key={x.id} className="space-y-1 rounded-md border px-3 py-2 text-xs">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="font-medium">{fmtTime(x.at)}</span>
                      <Badge variant={x.status === "applied" ? "success" : x.status === "discarded" || x.status === "tripwire" || x.status === "demoted" ? "warning" : "secondary"} size="sm">
                        {x.status}
                      </Badge>
                      <span className="text-muted-foreground">
                        {x.mode} · {x.posture} · {x.trigger} · {usd(x.costUsd)}
                        {x.model !== "claude-opus-5-5" ? ` · answered by ${x.model}` : ""}
                        {x.trips > 0 ? ` · ${x.trips} trips, ${fmtCr(x.profitPence)}` : ""}
                      </span>
                    </div>
                    <div>{x.rationale}</div>
                    {Object.keys(x.settings).length > 0 && (
                      <div className="text-muted-foreground">
                        Settings:{" "}
                        {Object.entries(x.settings)
                          .map(([k, v]) => `${k} ${showSetting(k, v, shipClassName)}${x.settingReasons?.[k as keyof typeof x.settingReasons] ? ` (${x.settingReasons[k as keyof typeof x.settingReasons]})` : ""}`)
                          .join("; ")}
                      </div>
                    )}
                    {(x.avoid ?? []).length > 0 && <div className="text-muted-foreground">Avoid: {(x.avoid ?? []).map((b) => `${b.label} (${b.reason})`).join("; ")}</div>}
                    {x.biases.length > 0 && <div className="text-muted-foreground">Bias: {x.biases.map((b) => `${b.label} x${b.factor} (${b.reason})`).join("; ")}</div>}
                    {x.stallCalls.length > 0 && <div className="text-muted-foreground">Stall calls: {x.stallCalls.map((s) => `${s.label}: ${s.call} (${s.reason})`).join("; ")}</div>}
                    {(x.shipOrders ?? []).length > 0 && (
                      <div className="text-muted-foreground">
                        Ship orders:{" "}
                        {(x.shipOrders ?? [])
                          .map((o) => `${shipName(o.ship)}: ${orderText(o)}${x.mode === "live" ? ` [${o.status}${o.code ? `: ${o.code.replace(/_/g, " ")}` : ""}]` : ""} (${o.reason})`)
                          .join("; ")}
                      </div>
                    )}
                    {x.buy.action === "hold" && <div className="text-muted-foreground">Buyer held: {x.buy.reason}</div>}
                    {x.build && (
                      <div className="text-muted-foreground">
                        Build: a {shipClassName(x.build.cls)} at {portName(x.build.yard)}
                        {x.mode === "live" ? ` [${x.build.status}${x.build.code ? `: ${x.build.code.replace(/_/g, " ")}` : ""}]` : ""} ({x.build.reason})
                      </div>
                    )}
                    {(x.forbid ?? []).length > 0 && <div className="text-muted-foreground">Forbidden classes: {(x.forbid ?? []).map(shipClassName).join(", ")}</div>}
                    {(x.naval ?? []).length > 0 && (
                      <div className="text-muted-foreground">
                        Naval:{" "}
                        {(x.naval ?? [])
                          .map((n) => `${navalText(n)}${x.mode === "live" ? ` [${n.status}${n.code ? `: ${n.code.replace(/_/g, " ")}` : ""}]` : " (would cost that)"} (${n.reason})`)
                          .join("; ")}
                        {x.navalSpentPence ? ` · issued ${fmtCr(x.navalSpentPence)}` : ""}
                      </div>
                    )}
                    {(x.finance ?? []).length > 0 && (
                      <div className="text-muted-foreground">
                        Money:{" "}
                        {(x.finance ?? [])
                          .map((o) => `${moneyText(o)}${x.mode === "live" ? ` [${o.status}${o.code ? `: ${o.code.replace(/_/g, " ")}` : ""}]` : ""} (${o.reason})`)
                          .join("; ")}
                      </div>
                    )}
                    {x.alerts.map((t, i) => (
                      <div key={i} className="text-warning-foreground">Note: {t}</div>
                    ))}
                    {x.note && <div className="text-muted-foreground">{x.note}</div>}
                    {x.dropped > 0 && <div className="text-muted-foreground">{x.dropped} invalid item{x.dropped === 1 ? "" : "s"} dropped</div>}
                  </div>
                ))}
              </div>
            </details>
          )}
          {r.events.length > 0 && (
            <details className="text-sm">
              <summary className="cursor-pointer text-muted-foreground text-xs">Notices it was told about ({r.events.length})</summary>
              <ul className="mt-2 space-y-1 text-xs">
                {r.events.map((e, i) => (
                  <li key={i}>
                    {e.kind.replace(/_/g, " ")}, {e.direction}, {e.severity}
                    {e.ports.length ? ` · ${e.ports.join(", ")}` : ""}
                    {e.goods.length ? ` · ${e.goods.join(", ")}` : ""}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </div>
  );
}
