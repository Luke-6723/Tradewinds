"use client";

import { useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Empty, ErrorNote, Loading, Metrics, PageHeader, Panel, Progress, Table } from "@/components/kibb/bits";
import { DESKS, DESK_DAYS, deskLabel, deskShare, useDeskBoard } from "@/components/kibb/desks-common";
import { WarnBox } from "@/components/kibb/finance-common";
import { Segmented } from "@/components/kibb/naval-common";
import { fmtAgo, fmtCr, fmtDateTime } from "@/lib/kibb/format";
import type * as S from "@/lib/kibb/schema";

const pct = (x: number | null) => (x === null ? "—" : `${Math.round(x * 100)}%`);

function Figures({ f }: { f: S.DeskFigures }) {
  return (
    <span className="whitespace-nowrap tabular-nums">
      {fmtCr(f.value_pence)} <span className="text-muted-foreground text-xs">· {f.count}</span>
    </span>
  );
}

function ShareCell({ d }: { d: S.DeskSection }) {
  const byValue = deskShare(d, "value");
  const byCount = deskShare(d, "count");
  if (byValue === null && byCount === null) return <span className="text-muted-foreground">nothing traded</span>;
  return (
    <div className="min-w-28 space-y-1">
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="font-medium tabular-nums">{pct(byValue)}</span>
        <span className="text-muted-foreground">{pct(byCount)} of deals</span>
      </div>
      <Progress value={byValue ?? 0} max={1} className="h-1.5" />
    </div>
  );
}

export default function DesksPage() {
  const [days, setDays] = useState<number>(30);
  const { board, error, loading, reload } = useDeskBoard(days);
  const desks = board?.desks ?? [];
  const bought = desks.reduce((n, d) => n + d.desk_bought.value_pence, 0);
  const traded = desks.reduce((n, d) => n + d.player_trades.value_pence, 0);
  // Where the house does most of the buying, an active player could be taking the business.
  const open = desks.filter((d) => (deskShare(d, "value") ?? 0) > 0.5);

  return (
    <div className="space-y-5 pb-8 sm:space-y-6">
      <PageHeader
        title="NPC desks"
        subtitle="Seven player markets where an NPC house buys as a last resort. Each pays from its house's own funds and takes only what is cheap, so a player who acts first or prices better always beats it."
        actions={
          <>
            <Segmented value={String(days)} onChange={(v) => setDays(Number(v))} options={DESK_DAYS.map((d) => ({ value: String(d), label: `${d} days` }))} />
            <Button variant="outline" disabled={loading} onClick={() => void reload()}>
              Refresh
            </Button>
          </>
        }
      />
      <Metrics
        className="sm:grid-cols-4 xl:grid-cols-4"
        items={[
          { label: "Desks bought", value: board ? fmtCr(bought) : "…", hint: board ? `${desks.reduce((n, d) => n + d.desk_bought.count, 0)} deals` : undefined },
          { label: "Players traded", value: board ? fmtCr(traded) : "…", hint: board ? `${desks.reduce((n, d) => n + d.player_trades.count, 0)} deals` : undefined },
          { label: "Desks' share", value: board ? pct(bought + traded > 0 ? bought / (bought + traded) : null) : "…", hint: "by value, all markets" },
          { label: "Window", value: board ? `${board.window_game_days} game days` : "…", hint: board ? `since ${fmtDateTime(board.window_since)}` : undefined },
        ]}
      />
      <div className="grid items-start gap-4 xl:grid-cols-3">
        <Panel title={`Results, last ${days} game days`} className="xl:col-span-2">
          <ErrorNote error={error} />
          {!board ? (
            !error && <Loading />
          ) : desks.length === 0 ? (
            <Empty>No desks on the board.</Empty>
          ) : (
            <Table head={["Desk", "Market", "Desk bought", "Players traded", "Desk's share"]}>
              {desks.map((d) => (
                <tr key={d.desk}>
                  <td>
                    <Link href={DESKS[d.desk]?.href ?? "/desks"} className="font-medium hover:underline">
                      {deskLabel(d.desk)}
                    </Link>
                    <div className="text-muted-foreground text-xs">{d.house}</div>
                  </td>
                  <td className="max-w-56 text-xs">{d.market}</td>
                  <td>
                    <Figures f={d.desk_bought} />
                  </td>
                  <td>
                    <Figures f={d.player_trades} />
                  </td>
                  <td>
                    <ShareCell d={d} />
                  </td>
                </tr>
              ))}
            </Table>
          )}
          <p className="mt-3 text-muted-foreground text-xs">
            Value and count of what each desk took, beside deals between players in the same market (no NPC house on either side). The share is the desk&apos;s part of
            both, by value (by count after it).{board ? ` As of ${fmtAgo(board.as_of)}.` : ""}
          </p>
        </Panel>
        <div className="space-y-4">
          {open.length > 0 && (
            <WarnBox tone="info">
              Desks doing most of the buying ({open.map((d) => deskLabel(d.desk)).join(", ")}): markets where an active player who bids a little better takes the
              business.
            </WarnBox>
          )}
          <Panel title="What each desk does">
            <dl className="space-y-3 text-sm">
              {(desks.length ? desks.map((d) => d.desk) : (Object.keys(DESKS) as S.DeskKind[])).map((k) => (
                <div key={k}>
                  <dt className="font-medium">
                    {DESKS[k] ? (
                      <Link href={DESKS[k].href} className="hover:underline">
                        {DESKS[k].label}
                      </Link>
                    ) : (
                      deskLabel(k)
                    )}
                  </dt>
                  <dd className="text-muted-foreground text-xs">{DESKS[k]?.text ?? desks.find((d) => d.desk === k)?.market}</dd>
                </div>
              ))}
            </dl>
            <p className="mt-4 text-muted-foreground text-xs">
              Desks answer slowly (only listings at least a game hour old) and their prices, caps and budgets are not published. Selling to a desk beats not selling.
            </p>
          </Panel>
        </div>
      </div>
    </div>
  );
}
