"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsPanel, TabsTab } from "@/components/ui/tabs";
import { Empty, ErrorNote, KV, Loading, PageHeader, Panel, Progress, Table } from "@/components/kibb/bits";
import { useOurCompanyNames } from "@/components/kibb/naval-common";
import { useAction } from "@/hooks/use-action";
import { useCatalog } from "@/hooks/use-catalog";
import { usePoll } from "@/hooks/use-poll";
import { kibbGet } from "@/lib/kibb/browser";
import { fmtAgo, fmtBps, fmtCr, fmtDateTime, fmtGameHours, fmtIn, fmtTons } from "@/lib/kibb/format";
import { bonusSplit } from "@/lib/kibb/rivals";
import type * as S from "@/lib/kibb/schema";

function Titles({ titles }: { titles: S.HallOfFameTitle[] }) {
  return (
    <>
      {titles.map((t) => (
        <Badge key={`${t.season_number}-${t.title}`} variant="warning" size="sm" className="mr-1">
          {t.title}
        </Badge>
      ))}
    </>
  );
}

/** Growth over the rising board's window: "+12.5%" (10,000 bps = doubled), "−3%" for a loss. */
const growthText = (bps: number) => `${bps < 0 ? "−" : "+"}${fmtBps(Math.abs(bps))}`;

const signedCr = (pence: number) => `${pence < 0 ? "−" : "+"}${fmtCr(Math.abs(pence))}`;

/** The rising board (guide 3.17): growth over the last 7 real days, all of a player's companies added together. Display only. */
function RisingBoard({ board }: { board: S.LeaderboardResult }) {
  const { portName } = useCatalog();
  const rising = board.rising;
  const you = rising?.you;
  return (
    <div>
      {you && (
        <p className="mb-3 rounded-md bg-primary/10 px-3 py-2 text-sm">
          You rank <strong>#{you.rank}</strong> on the rising board with {you.company_name}: {growthText(you.growth_bps)} ({signedCr(you.gained_pence)}) since{" "}
          {fmtDateTime(you.window_start_at)}
          {!you.is_calling_company && " (your best company, not this one)"}.
        </p>
      )}
      {!rising || rising.entries.length === 0 ? (
        <Empty>No one is ranked on the rising board yet: a player first appears one hourly refresh after their first snapshot.</Empty>
      ) : (
        <Table head={["#", "Company", "Home", "Growth", "Gained", "Since"]}>
          {rising.entries.map((e) => (
            <tr key={e.rank} className={you && you.rank === e.rank ? "bg-primary/5 font-medium" : undefined}>
              <td className="tabular-nums">{e.rank}</td>
              <td>{e.company_name}</td>
              <td className="text-muted-foreground">{portName(e.home_port_id)}</td>
              <td className={`tabular-nums ${e.growth_bps < 0 ? "text-destructive" : ""}`}>{growthText(e.growth_bps)}</td>
              <td className="tabular-nums">{signedCr(e.gained_pence)}</td>
              <td className="whitespace-nowrap text-muted-foreground text-xs">{fmtDateTime(e.window_start_at)}</td>
            </tr>
          ))}
        </Table>
      )}
      <p className="mt-3 text-muted-foreground text-xs">
        Ranks players by how much their wealth grew over the last 7 real days, all their companies added together (moving money between them is not growth), as a
        share of what they had at the start of their window, or of 100,000 Cr if they had less. Founding a company inside the window is not growth; borrowing never
        helps. {rising?.ranked_players ?? 0} ranked. Display only: no titles or rewards. Recomputed hourly with the main board.
      </p>
    </div>
  );
}

function BoardPanel() {
  const { portName } = useCatalog();
  const { data: board, error } = usePoll(() => kibbGet<S.LeaderboardResult>("/v1/world/leaderboard"), 300_000);
  if (!board) return <Panel title="Leaderboard">{error ? <ErrorNote error={error} /> : <Loading />}</Panel>;
  const you = board.you;
  return (
    <Panel
      title={`Season ${board.season_number} · ${board.ranked_players} ranked player${board.ranked_players === 1 ? "" : "s"}`}
      action={
        <span className="text-muted-foreground text-xs">
          {board.refreshed_at && `updated ${fmtAgo(board.refreshed_at)}`}
          {board.next_refresh_at && ` · next ${fmtIn(board.next_refresh_at)}`}
        </span>
      }
    >
      <Tabs defaultValue="worth">
        <TabsList>
          <TabsTab value="worth">Net worth</TabsTab>
          <TabsTab value="rising">Rising (7 days)</TabsTab>
        </TabsList>
        <TabsPanel value="rising" className="pt-2">
          <RisingBoard board={board} />
        </TabsPanel>
        <TabsPanel value="worth" className="pt-2">
          {you && (
            <p className="mb-3 rounded-md bg-primary/10 px-3 py-2 text-sm">
              You rank <strong>#{you.rank}</strong> with {you.company_name} at {fmtCr(you.net_worth_pence)}
              {!you.is_calling_company && " (your best company, not this one)"}.
            </p>
          )}
          {board.entries.length === 0 ? (
            <Empty>No one ranked yet.</Empty>
          ) : (
            <Table head={["#", "Company", "Home", "Net worth"]}>
              {board.entries.map((e) => (
                <tr key={e.rank} className={you && you.rank === e.rank ? "bg-primary/5 font-medium" : undefined}>
                  <td className="tabular-nums">{e.rank}</td>
                  <td>
                    {e.company_name} <Titles titles={e.titles} />
                  </td>
                  <td className="text-muted-foreground">{portName(e.home_port_id)}</td>
                  <td className="tabular-nums">{fmtCr(e.net_worth_pence)}</td>
                </tr>
              ))}
            </Table>
          )}
          <p className="mt-3 text-muted-foreground text-xs">
            Net worth: cash and escrow in every region, goods you own at catalog base prices (less freight carried for others), hulls afloat at build value
            (each outside holder&apos;s 64ths count for the holder, not the owner), minus what you owe on loans (principal and interest), plus what you are owed on
            active loans you made, your bank deposits (a bank&apos;s deposits count against it) and your capital in open ventures (a venture&apos;s cargo counts for its
            investors). Borrowing never lifts you up the board. Each player ranks once, by their best company; bankrupt companies never rank. Recomputed hourly.
          </p>
        </TabsPanel>
      </Tabs>
    </Panel>
  );
}

function ExpansionPanel() {
  const { portName, goodName } = useCatalog();
  const { data: exp, error } = usePoll(() => kibbGet<S.ExpansionStatusResult>("/v1/world/expansion"), 60_000);
  const { data: profile } = usePoll(() => kibbGet<S.CompanyProfileResult>("/v1/company/profile"), 300_000);
  const ourNames = useOurCompanyNames(profile?.company.name);
  if (!exp) return <Panel title="Expansion">{error ? <ErrorNote error={error} /> : <Loading />}</Panel>;
  const t = exp.current_tier;
  // The bonus splits by the square root of each player's base-valued tons, a player's companies pooled (guide 3.15).
  const split = bonusSplit(t?.contributors ?? [], ourNames);
  return (
    <Panel title={`Expansion · phase ${exp.unlocked_phase} open · ${exp.active_trading_companies} active companies`}>
      {!t ? (
        <Empty>Every theatre is open.</Empty>
      ) : (
        <div className="space-y-4">
          <div>
            <div className="flex items-baseline justify-between gap-3 text-sm">
              <span className="font-medium">
                {t.title} → phase {t.target_phase}
              </span>
              <span className="text-muted-foreground tabular-nums">
                {fmtTons(t.tons_delivered)} / {fmtTons(t.target_tons)} ({fmtBps(t.progress_bps)})
              </span>
            </div>
            <Progress value={t.tons_delivered} max={t.target_tons} className="mt-2" />
            <div className="mt-3">
              <KV
                rows={[
                  ["Tons still needed", fmtTons(t.tons_remaining)],
                  ["Open charters still take", fmtTons(t.charter_capacity_tons)],
                  ["Completion bonus (split by √ of each player's tons at base value, not by share)", fmtCr(t.completion_bonus_pence)],
                  ["Your bonus as it stands", `${(split.ours * 100).toFixed(1)}% · ~${fmtCr(t.completion_bonus_pence * split.ours)}`],
                  ["Sized for", `${t.active_companies} companies × ${fmtTons(t.tons_per_company)} (min ${fmtTons(t.min_tons)})`],
                ]}
              />
            </div>
          </div>
          {t.charters.length > 0 && (
            <Table head={["Port", "Good", "Pay / t", "Premium", "Delivered", "Left", "Closes"]}>
              {t.charters.map((c) => (
                <tr key={c.contract_id} className={c.status !== "open" ? "text-muted-foreground" : undefined}>
                  <td>
                    {portName(c.port_id)}
                    {c.beyond_coastal_water && <Badge variant="info" size="sm" className="ml-1.5">beyond coastal</Badge>}
                  </td>
                  <td>{goodName(c.commodity_id)}</td>
                  <td className="tabular-nums">{fmtCr(c.reward_per_ton_pence, 2)}</td>
                  <td className="tabular-nums">
                    +{fmtBps(c.premium_bps)}
                    {c.escalations > 0 && <span className="text-muted-foreground"> ×{c.escalations}</span>}
                  </td>
                  <td className="tabular-nums">
                    {fmtTons(c.quantity_delivered)} / {fmtTons(c.quantity_required)}
                  </td>
                  <td className="tabular-nums">{c.status === "open" ? fmtTons(c.quantity_remaining) : "full"}</td>
                  <td className="whitespace-nowrap">{c.status === "open" ? fmtGameHours(c.game_hours_left) : "—"}</td>
                </tr>
              ))}
            </Table>
          )}
          <div>
            <h3 className="mb-2 font-medium text-muted-foreground text-xs">Contributors</h3>
            {t.contributors.length === 0 ? (
              <Empty>No deliveries yet.</Empty>
            ) : (
              <Table head={["Company", "Tons", "Share of value delivered", "Bonus (est., √ split)"]}>
                {t.contributors.map((c) => {
                  const share = split.byCompany.get(c.company_name) ?? 0;
                  return (
                    <tr key={c.company_name} className={ourNames.has(c.company_name) ? "bg-primary/5 font-medium" : undefined}>
                      <td>{c.company_name}</td>
                      <td className="tabular-nums">{fmtTons(c.tons)}</td>
                      <td className="tabular-nums">{fmtBps(c.share_bps)}</td>
                      <td className="tabular-nums">
                        {(share * 100).toFixed(1)}% · ~{fmtCr(t.completion_bonus_pence * share)}
                      </td>
                    </tr>
                  );
                })}
              </Table>
            )}
            {t.contributors.length > 0 && (
              <p className="mt-2 text-muted-foreground text-xs">
                The bonus splits by the square root of each player&apos;s tons at base prices, a player&apos;s companies pooled (and shared among
                them by their own deliveries): the first tons earn the most, so a leader&apos;s share of the bonus is smaller than its share of the
                value. Estimated as the board stands; which company is whose isn&apos;t public, so each other company counts as its own player.
              </p>
            )}
          </div>
        </div>
      )}
      {exp.completed_tiers.length > 0 && (
        <div className="mt-4 border-t pt-3">
          <h3 className="mb-2 font-medium text-muted-foreground text-xs">Completed</h3>
          <Table head={["Tier", "Opened phase", "Tons", "Bonus", "Completed"]}>
            {exp.completed_tiers.map((c) => (
              <tr key={c.target_phase}>
                <td>{c.title}</td>
                <td>{c.target_phase}</td>
                <td className="tabular-nums">{fmtTons(c.tons_delivered)}</td>
                <td className="tabular-nums">{fmtCr(c.completion_bonus_pence)}</td>
                <td className="text-muted-foreground">{fmtDateTime(c.completed_at)}</td>
              </tr>
            ))}
          </Table>
        </div>
      )}
    </Panel>
  );
}

function HallOfFamePanel() {
  const { portName } = useCatalog();
  const { data: seasons, error } = usePoll(() => kibbGet<S.HallOfFameSeason[]>("/v1/world/hall-of-fame"), 3_600_000);
  return (
    <Panel title="Hall of fame">
      <ErrorNote error={error} />
      {!seasons ? (
        !error && <Loading />
      ) : seasons.length === 0 ? (
        <Empty>No season has ended yet.</Empty>
      ) : (
        <div className="space-y-4">
          {seasons.map((s) => (
            <div key={s.season_number}>
              <div className="mb-1 font-medium text-sm">
                Season {s.season_number}
                <span className="ml-2 font-normal text-muted-foreground text-xs">ended {fmtDateTime(s.ended_at)}</span>
              </div>
              <Table head={["#", "Company", "Home", "Net worth", "Title"]}>
                {s.top.map((e) => (
                  <tr key={e.player_rank}>
                    <td className="tabular-nums">{e.player_rank}</td>
                    <td>{e.company_name}</td>
                    <td className="text-muted-foreground">{portName(e.home_port_id)}</td>
                    <td className="tabular-nums">{fmtCr(e.net_worth_pence)}</td>
                    <td>{e.title && <Badge variant="warning" size="sm">{e.title}</Badge>}</td>
                  </tr>
                ))}
              </Table>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

function LookupPanel() {
  const { portName } = useCatalog();
  const [name, setName] = useState("");
  const act = useAction<S.PublicCompanyProfile>();
  return (
    <Panel title="Look up a company">
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) void act.run(() => kibbGet<S.PublicCompanyProfile>("/v1/world/company", { name: name.trim() }));
        }}
      >
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Exact company name" />
        <Button type="submit" size="sm" disabled={act.busy || !name.trim()}>
          {act.busy ? "…" : "Find"}
        </Button>
      </form>
      <ErrorNote error={act.error} className="mt-3" />
      {act.result && (
        <div className="mt-3">
          <KV
            rows={[
              ["Company", act.result.company_name],
              ["Home port", portName(act.result.home_port_id)],
              ["Founded", fmtDateTime(act.result.founded_at)],
              ["Leaderboard", act.result.leaderboard_rank ? `#${act.result.leaderboard_rank}` : "outside the top 20"],
              ["Titles", act.result.titles.length ? <Titles key="t" titles={act.result.titles} /> : "none"],
            ]}
          />
        </div>
      )}
    </Panel>
  );
}

export default function LeaderboardPage() {
  return (
    <div className="space-y-5 pb-8 sm:space-y-6">
      <PageHeader title="Leaderboard" subtitle="Season standings, the rising board, theatre expansion and past champions." />
      <div className="grid items-start gap-4 xl:grid-cols-3">
        <BoardPanel />
        <div className="space-y-4 xl:col-span-2">
          <ExpansionPanel />
        </div>
      </div>
      <div className="grid items-start gap-4 xl:grid-cols-3">
        <LookupPanel />
        <div className="xl:col-span-2">
          <HallOfFamePanel />
        </div>
      </div>
    </div>
  );
}
