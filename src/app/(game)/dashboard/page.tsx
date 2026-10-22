"use client";

import { useState } from "react";
import Link from "next/link";
import { AnchorIcon, CrownIcon, FlagIcon, PlayIcon, ShipIcon, SquareIcon, WalletIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Empty,
  ErrorNote,
  KV,
  Loading,
  NativeSelect,
  Panel,
  Progress,
  ShipStatusBadge,
  StatTile,
  Table,
} from "@/components/kibb/bits";
import { useCatalog } from "@/hooks/use-catalog";
import { usePoll } from "@/hooks/use-poll";
import { dash, kibbGet } from "@/lib/kibb/browser";
import { fmtCr, fmtIn, fmtTime, fmtTons } from "@/lib/kibb/format";
import type { CharterSettings } from "@/lib/kibb/charter-runner";
import type { RunnerView } from "@/lib/kibb/runner-registry";
import type {
  CompanyProfile,
  ContractListing,
  ExpansionStatus,
  LeaderboardResult,
  ShipResult,
} from "@/lib/kibb/types";

// ── Charter runner ────────────────────────────────────────────────────────────

function RunnerPanel({ ships }: { ships: ShipResult[] }) {
  const { catalog, portName, goodName } = useCatalog();
  const { data: view, error, reload } = usePoll(() => dash.get<RunnerView>("/api/kibb/runner"), 4_000);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<CharterSettings | null>(null);

  if (!view) return <Panel title="Charter runner">{error ? <ErrorNote error={error} /> : <Loading />}</Panel>;

  const st = view.state;
  const on = view.enabled;
  const s = view.settings;
  const shipName =
    ships.find((x) => x.ship.id === (s.shipId || st?.shipId))?.ship.name ?? st?.shipName ?? ships[0]?.ship.name ?? "First ship";

  async function send(body: { enabled?: boolean; settings?: Partial<CharterSettings> }) {
    setBusy(true);
    setActionError(null);
    try {
      await dash.post<RunnerView>("/api/kibb/runner", body);
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

  const ports = catalog?.ports.filter((p) => p.phase === 1).sort((a, b) => a.name.localeCompare(b.name)) ?? [];
  const goods = catalog?.commodities.slice().sort((a, b) => a.name.localeCompare(b.name)) ?? [];
  const d = draft ?? s;

  return (
    <Panel
      title="Charter runner"
      action={
        <Button
          size="sm"
          variant={on ? "outline" : "default"}
          disabled={busy}
          onClick={() => void send({ enabled: !on })}
        >
          {on ? <SquareIcon /> : <PlayIcon />}
          {on ? "Stop" : "Start"}
        </Button>
      }
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
          {statusBadge}
          <span>
            {shipName}: buy {goodName(s.commodity)} at {portName(s.sourcePort)} → deliver at {portName(s.charterPort)}
          </span>
          {st?.nextTickAt && (st.status === "running" || st.status === "starting") && (
            <span className="text-muted-foreground text-xs">next check {fmtIn(st.nextTickAt)}</span>
          )}
          <button
            type="button"
            className="ml-auto text-muted-foreground text-xs hover:text-foreground"
            onClick={() => {
              setDraft(s);
              setEditing(!editing);
            }}
          >
            {editing ? "Close settings" : "Settings"}
          </button>
        </div>

        <ErrorNote error={actionError ?? st?.error ?? null} />

        {editing && (
          <form
            className="grid grid-cols-2 gap-3 rounded-lg border p-3 lg:grid-cols-3"
            onSubmit={async (e) => {
              e.preventDefault();
              if (await send({ settings: d })) setEditing(false);
            }}
          >
            <div className="space-y-1">
              <Label>Ship</Label>
              <NativeSelect value={d.shipId} onChange={(e) => setDraft({ ...d, shipId: e.target.value })}>
                <option value="">First ship</option>
                {ships.map((x) => (
                  <option key={x.ship.id} value={x.ship.id}>{x.ship.name}</option>
                ))}
              </NativeSelect>
            </div>
            <div className="space-y-1">
              <Label>Buy at</Label>
              <NativeSelect value={d.sourcePort} onChange={(e) => setDraft({ ...d, sourcePort: e.target.value })}>
                {ports.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </NativeSelect>
            </div>
            <div className="space-y-1">
              <Label>Deliver at</Label>
              <NativeSelect value={d.charterPort} onChange={(e) => setDraft({ ...d, charterPort: e.target.value })}>
                {ports.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </NativeSelect>
            </div>
            <div className="space-y-1">
              <Label>Good</Label>
              <NativeSelect value={d.commodity} onChange={(e) => setDraft({ ...d, commodity: e.target.value })}>
                {goods.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
              </NativeSelect>
            </div>
            <div className="space-y-1">
              <Label>Min margin (Cr/t)</Label>
              <Input
                type="number"
                min={0}
                value={d.minMarginPence / 100}
                onChange={(e) => setDraft({ ...d, minMarginPence: Math.round(Number(e.target.value) * 100) })}
              />
            </div>
            <div className="space-y-1">
              <Label>Cash reserve (Cr)</Label>
              <Input
                type="number"
                min={0}
                value={d.reservePence / 100}
                onChange={(e) => setDraft({ ...d, reservePence: Math.round(Number(e.target.value) * 100) })}
              />
            </div>
            <div className="col-span-full flex justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
              <Button size="sm" type="submit" disabled={busy}>Save{on ? " and restart" : ""}</Button>
            </div>
          </form>
        )}

        {st && (
          <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-5">
            <KV rows={[["Trips", st.stats.trips]]} />
            <KV rows={[["Delivered", fmtTons(st.stats.deliveredTons)]]} />
            <KV rows={[["Reward", fmtCr(st.stats.rewardPence)]]} />
            <KV rows={[["Spent", fmtCr(st.stats.spentPence)]]} />
            <KV rows={[["Net", fmtCr(st.stats.rewardPence - st.stats.spentPence)]]} />
            <p className="col-span-full text-muted-foreground text-xs">
              Since the server started. Spent includes cargo still on its way to the charter.
            </p>
          </div>
        )}

        <div className="h-64 overflow-y-auto rounded-lg bg-muted/40 p-3 font-mono text-xs leading-relaxed">
          {st && st.log.length > 0 ? (
            [...st.log].reverse().map((l, i) => (
              <div key={`${l.at}-${i}`} className={l.msg.startsWith("FATAL") ? "text-destructive" : undefined}>
                <span className="text-muted-foreground">{fmtTime(l.at)}</span> {l.msg}
              </div>
            ))
          ) : (
            <span className="text-muted-foreground">
              {on ? "Waiting for the first log line…" : "Not running since the server started. Press Start to run the loop."}
            </span>
          )}
        </div>
      </div>
    </Panel>
  );
}

// ── Ships ─────────────────────────────────────────────────────────────────────

function ShipsPanel({ ships }: { ships: ShipResult[] | undefined }) {
  const { portName, goodName, shipClassName } = useCatalog();
  return (
    <Panel title="Ships" action={<Link href="/fleet" className="text-muted-foreground text-xs hover:text-foreground">Fleet →</Link>}>
      {!ships ? (
        <Loading />
      ) : ships.length === 0 ? (
        <Empty>No ships.</Empty>
      ) : (
        <div className="space-y-4">
          {ships.map((r) => {
            const s = r.ship;
            const dest = r.route_legs.at(-1)?.to_node;
            const cargo = Object.entries(r.cargo_manifest);
            return (
              <Link key={s.id} href={`/fleet/${s.id}`} className="block rounded-lg border p-3 transition-colors hover:bg-accent/50">
                <div className="flex items-center gap-2">
                  <ShipIcon className="size-4 text-muted-foreground" />
                  <span className="font-medium">{s.name}</span>
                  <span className="text-muted-foreground text-xs">{shipClassName(s.ship_class)} · {s.cannons_count} guns</span>
                  <span className="ml-auto"><ShipStatusBadge status={s.status} /></span>
                </div>
                <div className="mt-2 text-sm">
                  {s.status === "sailing"
                    ? `→ ${portName(dest)}, arrives ${fmtIn(r.voyage?.estimated_arrival_at ?? s.leg_arrives_at)}`
                    : s.status === "sunk"
                      ? "Lost at sea"
                      : `${s.status === "berthed" ? "Berthed at" : "Anchored off"} ${portName(s.current_port_id)}`}
                  {s.status === "berthed" && s.turnaround_unlocks_at && Date.parse(s.turnaround_unlocks_at) > Date.now() && (
                    <span className="text-muted-foreground text-xs"> · turnaround {fmtIn(s.turnaround_unlocks_at)}</span>
                  )}
                </div>
                <div className="mt-1 text-muted-foreground text-xs">
                  Hold {fmtTons(r.cargo_used_tons)} / {fmtTons(r.effective_hold_capacity_tons)}
                  {" · "}stores {fmtTons(r.stores.provisions_tons, 2)}
                  {cargo.length > 0 && ` · ${cargo.map(([g, t]) => `${t} t ${goodName(g)}`).join(", ")}`}
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </Panel>
  );
}

// ── Vaults ────────────────────────────────────────────────────────────────────

function VaultsPanel({ profile }: { profile: CompanyProfile | undefined }) {
  if (!profile) return <Panel title="Vaults"><Loading /></Panel>;
  const regions = [...new Set(profile.vaults.map((v) => v.banking_region))];
  const rows = regions
    .map((region) => ({
      region,
      vault: profile.vaults.find((v) => v.banking_region === region && v.account_type === "vault")?.balance_pence ?? 0,
      escrow: profile.vaults.find((v) => v.banking_region === region && v.account_type === "escrow")?.balance_pence ?? 0,
    }))
    .filter((r) => r.vault !== 0 || r.escrow !== 0);
  return (
    <Panel title="Vaults">
      {rows.length === 0 ? (
        <Empty>All vaults empty.</Empty>
      ) : (
        <Table head={["Region", "Vault", "Escrow"]}>
          {rows.map((r) => (
            <tr key={r.region}>
              <td className="capitalize">{r.region.replace(/_/g, " ")}</td>
              <td className={`tabular-nums ${r.vault < 0 ? "text-destructive" : ""}`}>{fmtCr(r.vault)}</td>
              <td className="text-muted-foreground tabular-nums">{fmtCr(r.escrow)}</td>
            </tr>
          ))}
        </Table>
      )}
    </Panel>
  );
}

// ── Charters ──────────────────────────────────────────────────────────────────

function ChartersPanel({ expansion, charters }: { expansion: ExpansionStatus | undefined; charters: ContractListing[] | undefined }) {
  const { portName, goodName } = useCatalog();
  const tier = expansion?.current_tier;
  const tierIds = new Set(tier?.charters.map((c) => c.contract_id));
  const others = (charters ?? []).filter((c) => !tierIds.has(c.id)).sort((a, b) => (b.reward_per_ton_pence ?? 0) - (a.reward_per_ton_pence ?? 0));

  return (
    <Panel title="Charters">
      {!expansion ? (
        <Loading />
      ) : (
        <div className="space-y-5">
          {tier ? (
            <div className="space-y-2">
              <div className="flex items-baseline justify-between text-sm">
                <span className="font-medium">Phase {tier.target_phase}: {tier.title}</span>
                <span className="text-muted-foreground text-xs">bonus {fmtCr(tier.completion_bonus_pence)} split by tons</span>
              </div>
              <Progress value={tier.tons_delivered} max={tier.target_tons} />
              <div className="text-muted-foreground text-xs">
                {fmtTons(tier.tons_delivered)} of {fmtTons(tier.target_tons)} delivered · {expansion.active_trading_companies} active companies
              </div>
              <Table head={["Deliver to", "Good", "Remaining", "Pay", "Closes"]}>
                {tier.charters.map((c) => (
                  <tr key={c.contract_id}>
                    <td>{portName(c.port_id)}</td>
                    <td>
                      {goodName(c.commodity_id)}
                      {c.beyond_coastal_water && <Badge variant="warning" size="sm" className="ml-1.5">regional hull</Badge>}
                    </td>
                    <td className="tabular-nums">{fmtTons(c.quantity_remaining)}</td>
                    <td className="tabular-nums">{fmtCr(c.reward_per_ton_pence, 2)}/t</td>
                    <td className="text-muted-foreground text-xs">{fmtIn(c.expires_at)}</td>
                  </tr>
                ))}
              </Table>
            </div>
          ) : (
            <Empty>All expansion tiers are complete.</Empty>
          )}

          <div className="space-y-2">
            <div className="font-medium text-sm">Other open charters you can see</div>
            {others.length === 0 ? (
              <Empty>None right now. Governor charters show up when you have a ship or factor in port.</Empty>
            ) : (
              <Table head={["Deliver to", "Good", "Remaining", "Pay", ""]}>
                {others.slice(0, 15).map((c) => (
                  <tr key={c.id}>
                    <td>{portName(c.origin_port_id)}</td>
                    <td>{goodName(c.commodity_id)}</td>
                    <td className="tabular-nums">{fmtTons(c.remaining_quantity)}</td>
                    <td className="tabular-nums">{fmtCr(c.reward_per_ton_pence ?? Math.floor(c.reward_pence / Math.max(1, c.quantity_required)), 2)}/t</td>
                    <td>{c.stale && <Badge variant="outline" size="sm">gossip</Badge>}</td>
                  </tr>
                ))}
              </Table>
            )}
          </div>
        </div>
      )}
    </Panel>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function DashboardPage() {
  const { data: profile, error: profileError } = usePoll(() => kibbGet<CompanyProfile>("/v1/company/profile"), 15_000);
  const { data: ships } = usePoll(() => kibbGet<ShipResult[]>("/v1/fleet/ships", { limit: 200 }), 10_000);
  const { data: expansion } = usePoll(() => kibbGet<ExpansionStatus>("/v1/world/expansion"), 60_000);
  const { data: charters } = usePoll(
    () => kibbGet<ContractListing[]>("/v1/contract/list", { contract_type: "charter", status: "open", limit: 200 }),
    60_000,
  );
  const { data: board } = usePoll(() => kibbGet<LeaderboardResult>("/v1/world/leaderboard"), 300_000);

  const cash = profile?.vaults.filter((v) => v.account_type === "vault").reduce((n, v) => n + v.balance_pence, 0);
  const escrow = profile?.vaults.filter((v) => v.account_type === "escrow").reduce((n, v) => n + v.balance_pence, 0);
  const sailing = ships?.filter((s) => s.ship.status === "sailing").length ?? 0;
  const tier = expansion?.current_tier;

  return (
    <div className="space-y-6 pb-8">
      <div>
        <h1 className="font-bold text-2xl tracking-tight">{profile?.company.name ?? "Dashboard"}</h1>
        <p className="mt-0.5 text-muted-foreground text-sm">
          {profile ? `${profile.company.crown_prestige.toLocaleString()} Crown prestige · founded ${new Date(profile.company.created_at).toLocaleDateString("en-GB")}` : " "}
        </p>
      </div>

      <ErrorNote error={profileError} />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Cash" icon={<WalletIcon className="size-4" />} value={fmtCr(cash)} sub={escrow ? `${fmtCr(escrow)} in escrow` : "nothing in escrow"} />
        <StatTile
          label="Fleet"
          icon={<AnchorIcon className="size-4" />}
          value={ships ? `${ships.length} ship${ships.length === 1 ? "" : "s"}` : "—"}
          sub={ships ? `${sailing} at sea, ${ships.length - sailing} in port` : undefined}
        />
        <StatTile
          label={tier ? `Phase ${tier.target_phase} progress` : "Expansion"}
          icon={<FlagIcon className="size-4" />}
          value={tier ? `${(tier.progress_bps / 100).toFixed(1)}%` : "—"}
          sub={tier ? `${fmtTons(tier.tons_remaining)} to go` : undefined}
        />
        <StatTile
          label="Leaderboard"
          icon={<CrownIcon className="size-4" />}
          value={board?.you ? `#${board.you.rank}` : "Unranked"}
          sub={board?.you ? `net worth ${fmtCr(board.you.net_worth_pence)}` : board ? `${board.ranked_players} ranked · hourly refresh` : undefined}
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <div className="xl:col-span-2">
          <RunnerPanel ships={ships ?? []} />
        </div>
        <VaultsPanel profile={profile} />
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <ShipsPanel ships={ships} />
        <ChartersPanel expansion={expansion} charters={charters} />
      </div>
    </div>
  );
}
