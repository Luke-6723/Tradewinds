"use client";

import Link from "next/link";
import { AnchorIcon, CrownIcon, FlagIcon, ShipIcon, WalletIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Empty,
  ErrorNote,
  Loading,
  PageHeader,
  Panel,
  Progress,
  ShipStatusBadge,
  StatTile,
  Table,
} from "@/components/kibb/bits";
import { FleetPanel } from "@/components/kibb/fleet-panel";
import { useOurCompanyIds, useOurCompanyNames } from "@/components/kibb/naval-common";
import { useCatalog } from "@/hooks/use-catalog";
import { usePoll } from "@/hooks/use-poll";
import { kibbGet } from "@/lib/kibb/browser";
import { fmtCr, fmtIn, fmtTons } from "@/lib/kibb/format";
import { bonusSplit } from "@/lib/kibb/rivals";
import type {
  CompanyProfile,
  ContractListing,
  ExpansionStatus,
  LeaderboardResult,
  ShipResult,
} from "@/lib/kibb/types";

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
        <div className="space-y-3">
          {ships.map((r) => {
            const s = r.ship;
            const dest = r.route_legs.at(-1)?.to_node;
            const cargo = Object.entries(r.cargo_manifest);
            return (
              <Link key={s.id} href={`/fleet/${s.id}`} className="block rounded-lg border p-3 transition-colors hover:bg-accent/50">
                <div className="flex items-center gap-2">
                  <ShipIcon className="size-4 shrink-0 text-muted-foreground" />
                  <span className="truncate font-medium">{s.name}</span>
                  <span className="ml-auto shrink-0"><ShipStatusBadge status={s.status} /></span>
                </div>
                <div className="mt-0.5 text-muted-foreground text-xs">{shipClassName(s.ship_class)} · {s.cannons_count} guns</div>
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

function ChartersPanel({
  expansion,
  charters,
  ourNames,
}: {
  expansion: ExpansionStatus | undefined;
  charters: ContractListing[] | undefined;
  ourNames: Set<string>;
}) {
  const { portName, goodName } = useCatalog();
  const ourIds = useOurCompanyIds();
  const tier = expansion?.current_tier;
  const tierIds = new Set(tier?.charters.map((c) => c.contract_id));
  const others = (charters ?? []).filter((c) => !tierIds.has(c.id)).sort((a, b) => (b.reward_per_ton_pence ?? 0) - (a.reward_per_ton_pence ?? 0));
  // The bonus splits by the square root of each player's base-valued tons, our companies pooled (guide 3.15).
  const split = bonusSplit(tier?.contributors ?? [], ourNames);

  return (
    <Panel title="Charters">
      {!expansion ? (
        <Loading />
      ) : (
        <div className="space-y-5">
          {tier ? (
            <div className="space-y-2">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 text-sm">
                <span className="font-medium">Phase {tier.target_phase}: {tier.title}</span>
                <span
                  className="text-muted-foreground text-xs"
                  title="Split among everyone who delivered, by the square root of each player's tons valued at base prices (a player's companies pooled): the first tons earn the most. The board's share is of the value delivered, not of the bonus. Estimates as the board stands now; each other company counted as its own player."
                >
                  bonus {fmtCr(tier.completion_bonus_pence)} split by √ of each player&apos;s tons at base value
                </span>
              </div>
              <Progress value={tier.tons_delivered} max={tier.target_tons} />
              <div className="text-muted-foreground text-xs">
                {fmtTons(tier.tons_delivered)} of {fmtTons(tier.target_tons)} delivered · {expansion.active_trading_companies} active companies
              </div>
              {tier.contributors && tier.contributors.length > 0 && (
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
                  {tier.contributors
                    .slice()
                    .sort((a, b) => b.share_bps - a.share_bps)
                    .map((c) => (
                      <span key={c.company_name} className={ourNames.has(c.company_name) ? "font-medium" : "text-muted-foreground"}>
                        {c.company_name} {(c.share_bps / 100).toFixed(1)}% of value delivered · bonus ~{fmtCr(tier.completion_bonus_pence * (split.byCompany.get(c.company_name) ?? 0))}
                      </span>
                    ))}
                </div>
              )}
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
                    <td className="space-x-1 whitespace-nowrap">
                      {c.stale && <Badge variant="outline" size="sm">gossip</Badge>}
                      {/* Posted by one of our companies: the game refuses our deliveries to it. */}
                      {c.issuer_company_id && ourIds.has(c.issuer_company_id) ? (
                        <Badge variant="secondary" size="sm">yours: not deliverable</Badge>
                      ) : (
                        c.funded_by === "issuer" && <Badge variant="outline" size="sm">player charter</Badge>
                      )}
                    </td>
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
  const ourNames = useOurCompanyNames(profile?.company.name);
  // Our player's share of the bonus (our companies pooled, the square-root split), and the largest other company's.
  const split = bonusSplit(tier?.contributors ?? [], ourNames);
  const leader = tier?.contributors?.filter((c) => !ourNames.has(c.company_name)).sort((a, b) => b.share_bps - a.share_bps)[0];
  const leaderShare = leader ? (split.byCompany.get(leader.company_name) ?? 0) : 0;

  return (
    <div className="space-y-5 pb-8 sm:space-y-6">
      <PageHeader
        title={profile?.company.name ?? "Dashboard"}
        subtitle={
          profile
            ? `${profile.company.crown_prestige.toLocaleString()} Crown prestige · founded ${new Date(profile.company.created_at).toLocaleDateString("en-GB")}`
            : undefined
        }
      />

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
          sub={
            tier
              ? `${fmtTons(tier.tons_remaining)} to go · your bonus share ${(split.ours * 100).toFixed(1)}% (~${fmtCr(tier.completion_bonus_pence * split.ours)})${
                  leader && leaderShare > split.ours ? ` (leader ${(leaderShare * 100).toFixed(0)}%)` : ""
                }`
              : undefined
          }
        />
        <StatTile
          label="Leaderboard"
          icon={<CrownIcon className="size-4" />}
          value={board?.you ? `#${board.you.rank}` : "Unranked"}
          sub={
            board?.you
              ? `net worth ${fmtCr(board.you.net_worth_pence)}${
                  board.rising?.you ? ` · rising #${board.rising.you.rank} (${board.rising.you.growth_bps < 0 ? "−" : "+"}${(Math.abs(board.rising.you.growth_bps) / 100).toFixed(1)}% in 7 days)` : ""
                }`
              : board
                ? `${board.ranked_players} ranked · hourly refresh`
                : undefined
          }
        />
      </div>

      <FleetPanel />

      <div className="grid items-start gap-4 lg:grid-cols-3">
        <div className="space-y-4">
          <VaultsPanel profile={profile} />
          <ShipsPanel ships={ships} />
        </div>
        <div className="min-w-0 lg:col-span-2">
          <ChartersPanel expansion={expansion} charters={charters} ourNames={ourNames} />
        </div>
      </div>
    </div>
  );
}
