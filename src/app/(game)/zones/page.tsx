"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Empty, ErrorNote, KV, Loading, PageHeader, Panel, Table } from "@/components/kibb/bits";
import { Field, ZoneSelect } from "@/components/kibb/pickers";
import { Checkbox, Pager, PAGE_SIZE, Segmented, num, realTime, useCursor, useTimeScale } from "@/components/kibb/naval-common";
import { useAction } from "@/hooks/use-action";
import { useCatalog } from "@/hooks/use-catalog";
import { usePoll } from "@/hooks/use-poll";
import { kibbGet, kibbPost } from "@/lib/kibb/browser";
import { fmtBps, fmtCr, fmtDateTime, fmtGameHours, fmtIn } from "@/lib/kibb/format";
import type * as S from "@/lib/kibb/schema";
import type { WorldClock } from "@/lib/kibb/types";

type Kind = "marque" | "patrol";

function piracyVariant(bps: number): "success" | "warning" | "error" {
  return bps < 300 ? "success" : bps < 900 ? "warning" : "error";
}

function SponsorForm({ maxPhase, zone, setZone, onDone }: { maxPhase: number; zone: string; setZone: (z: string) => void; onDone: () => void }) {
  const { catalog } = useCatalog();
  const [kind, setKind] = useState<Kind>("patrol");
  const [bps, setBps] = useState("400");
  const [hours, setHours] = useState("60");
  const timeScale = useTimeScale();
  // Resolves to null when the confirmation is declined.
  const act = useAction<S.LetterOfMarque | S.NavalPatrol | null>((r) => r && onDone());

  const b = num(bps);
  const h = num(hours);
  const valid = !!zone && b >= 50 && b <= 1500 && h >= 5 && h <= 1440;
  // Both are priced by the game per zone (a marque from its player traffic, a patrol from its smuggling traffic, never under
  // 2 Cr a bps-day): the game's quote, re-read as the inputs change.
  const { data: quote, error: marqueQuoteError } = usePoll(
    valid && kind === "marque"
      ? () => kibbGet<S.MarqueQuote>("/v1/fleet/marque-quote", { sea_zone_id: zone, added_piracy_bps: Math.round(b), duration_game_hours: Math.round(h) })
      : null,
    30_000,
    [kind, zone, Math.round(b), Math.round(h), valid],
  );
  const { data: pquote, error: patrolQuoteError } = usePoll(
    valid && kind === "patrol"
      ? () => kibbGet<S.PatrolQuote>("/v1/fleet/patrol-quote", { sea_zone_id: zone, suppressed_piracy_bps: Math.round(b), duration_game_hours: Math.round(h) })
      : null,
    30_000,
    [kind, zone, Math.round(b), Math.round(h), valid],
  );
  const quoteError = kind === "marque" ? marqueQuoteError : patrolQuoteError;
  // Only a quote for these very inputs (an older answer may still be showing).
  const quoted = kind === "marque" && quote?.sea_zone_id === zone && quote.added_piracy_bps === Math.round(b) && quote.duration_game_hours === Math.round(h) ? quote : null;
  const pquoted =
    kind === "patrol" && pquote?.sea_zone_id === zone && pquote.suppressed_piracy_bps === Math.round(b) && pquote.duration_game_hours === Math.round(h) ? pquote : null;
  const cost = !valid ? null : kind === "patrol" ? (pquoted?.cost_pence ?? null) : (quoted?.cost_pence ?? null);
  const price = kind === "patrol" ? (pquoted?.price_per_bps_day_pence ?? null) : (quoted?.price_per_bps_day_pence ?? null);
  const zoneName = catalog?.sea_zones.find((z) => z.id === zone)?.name ?? zone;

  function submit() {
    if (!valid || cost === null) return;
    const what = kind === "marque" ? `a letter of marque adding ${b} bps of piracy` : `a naval patrol suppressing ${b} bps of piracy`;
    void act.run(async () => {
      // issue-marque / fund-patrol charge the zone's quote as it stands then: priced again, and confirmed on that (not the last poll's).
      const args = { sea_zone_id: zone, duration_game_hours: Math.round(h) };
      const fresh =
        kind === "marque"
          ? await kibbGet<S.MarqueQuote>("/v1/fleet/marque-quote", { ...args, added_piracy_bps: Math.round(b) })
          : await kibbGet<S.PatrolQuote>("/v1/fleet/patrol-quote", { ...args, suppressed_piracy_bps: Math.round(b) });
      const pay = fresh.cost_pence;
      const expect =
        "expected_net_prize_pence" in fresh
          ? ` The game expects it to earn ~${fmtCr(fresh.expected_net_prize_pence)} in prize money if the zone's traffic holds.`
          : ` At ${fmtCr(fresh.price_per_bps_day_pence, 2)} per bps a game day; it earns prize money only from smugglers seized at sea in the zone while it is in force.`;
      if (!confirm(`Pay ${fmtCr(pay)} for ${what} in ${zoneName} for ${fmtGameHours(h)}?${expect}`)) return null;
      return kind === "marque"
        ? kibbPost<S.IssueMarqueResult>("/v1/fleet/issue-marque", { sea_zone_id: zone, added_piracy_bps: Math.round(b), duration_game_hours: Math.round(h) })
        : kibbPost<S.NavalPatrol>("/v1/fleet/fund-patrol", { sea_zone_id: zone, suppressed_piracy_bps: Math.round(b), duration_game_hours: Math.round(h) });
    });
  }

  return (
    <div className="space-y-3">
      <Segmented<Kind>
        value={kind}
        onChange={(k) => {
          setKind(k);
          act.reset();
        }}
        options={[
          { value: "patrol", label: "Fund a patrol" },
          { value: "marque", label: "Issue a marque" },
        ]}
      />
      <Field label="Sea zone">
        <ZoneSelect value={zone} onChange={setZone} placeholder="Choose a zone…" maxPhase={maxPhase} />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label={kind === "marque" ? "Added piracy (bps)" : "Suppressed piracy (bps)"}>
          <Input type="number" min={50} max={1500} step={10} value={bps} onChange={(e) => setBps(e.target.value)} />
        </Field>
        <Field label="Term (game hours)">
          <Input type="number" min={5} max={1440} value={hours} onChange={(e) => setHours(e.target.value)} />
        </Field>
      </div>
      <KV
        rows={[
          ["Effect", Number.isFinite(b) ? `${kind === "marque" ? "+" : "−"}${fmtBps(b)} piracy in the zone` : "—"],
          ["Term", Number.isFinite(h) ? `${fmtGameHours(h)} (${realTime(h * 60, timeScale)})` : "—"],
          [
            "Cost",
            !valid
              ? "50..1500 bps, 5..1440 h"
              : cost !== null
                ? `${fmtCr(cost)}${price !== null ? ` (${fmtCr(price, 2)} per bps a game day${quoted?.floor_applied || (pquoted && pquoted.price_per_bps_day_pence <= 200) ? ", the price floor" : ""})` : ""}`
                : quoteError
                  ? "couldn't be quoted"
                  : "quoting…",
          ],
          ...(quoted
            ? ([
                ["Expected prize", `~${fmtCr(quoted.expected_net_prize_pence)} after the Admiral's tenth, if traffic holds`],
                [
                  "Zone traffic",
                  `${quoted.laden_passages} laden passages (${quoted.laden_passages_per_day.toFixed(1)} a game day) over ${quoted.window_game_days} game days, ~${fmtCr(quoted.avg_cargo_base_value_pence)} of cargo each at base; marques in force ${fmtBps(quoted.marque_bps_in_force)}`,
                ],
                ["Prize per bps-day", `~${fmtCr(quoted.expected_net_prize_per_bps_day_pence, 2)} expected, against ${fmtCr(quoted.price_per_bps_day_pence, 2)} charged`],
              ] as Array<[string, string]>)
            : []),
        ]}
      />
      <ErrorNote error={quoteError} />
      <ErrorNote error={act.error} />
      {act.result && (
        <p className="text-sm">
          Paid {fmtCr(act.result.cost_pence)}; in force until {fmtDateTime(act.result.expires_at)} ({fmtIn(act.result.expires_at)}).
        </p>
      )}
      <Button className="w-full" variant={kind === "marque" ? "destructive" : "default"} disabled={!valid || cost === null || act.busy} onClick={submit}>
        {act.busy ? "Paying…" : kind === "marque" ? "Issue letter of marque" : "Fund naval patrol"}
      </Button>
      <p className="text-muted-foreground text-xs">
        {kind === "marque"
          ? "A marque raises piracy for everyone sailing the zone, you included. While in force it pays you prize money: half the seized cargo's base value × the marques' share of the zone's piracy, split pro rata by bps, less the Admiral's tenth, into the region you paid from. The game prices it from the zone's last 7 game days of player traffic (60% of the prize it expects; the price is fixed at issue), so it pays only if that traffic holds."
          : "A patrol lowers piracy for everyone sailing the zone, cheapens Lloyd's cover there and searches ships carrying contraband. The game prices it per zone from the zone's recent smuggling traffic, never under 2 Cr per bps per game day (where nobody smuggles, that floor; 100 Cr at least), fixed once funded. While in force it pays you prize money: every smuggler seized at sea in the zone pays half the base value of her and everything aboard, split among the patrols in force pro rata by bps, less the Admiral's tenth, into the region you paid from (a seizure in port pays none). Sponsoring a patrol where your own ships smuggle always loses money. Sponsors are anonymous."}{" "}
        Paid from the home vault. Each side stacks across companies, capped at 5,000 bps per zone.
      </p>
    </div>
  );
}

export default function ZonesPage() {
  const { catalog } = useCatalog();
  const { data: clock } = usePoll(() => kibbGet<WorldClock>("/v1/world/clock"));
  const { data: zones, error, reload } = usePoll(() => kibbGet<S.SeaZonePiracyResult[]>("/v1/world/zones"), 30_000);
  const [allPhases, setAllPhases] = useState(false);
  const [zone, setZone] = useState("");
  const marquePager = useCursor();
  const patrolPager = useCursor();
  const { data: marques, error: marqueError, reload: reloadMarques } = usePoll(
    () => kibbGet<S.LetterOfMarque[]>("/v1/fleet/marques", { cursor: marquePager.cursor, limit: PAGE_SIZE }),
    30_000,
    [marquePager.cursor],
  );
  const { data: patrols, error: patrolError, reload: reloadPatrols } = usePoll(
    () => kibbGet<S.NavalPatrol[]>("/v1/fleet/patrols", { cursor: patrolPager.cursor, limit: PAGE_SIZE }),
    30_000,
    [patrolPager.cursor],
  );

  const phase = clock?.unlocked_phase ?? 1;
  const zoneInfo = (id: string) => catalog?.sea_zones.find((z) => z.id === id);
  const zoneName = (id: string) => zoneInfo(id)?.name ?? id;
  const rows = (zones ?? []).filter((z) => allPhases || z.phase <= phase).sort((a, b) => b.net_piracy_bps - a.net_piracy_bps);
  const live = (iso: string) => Date.parse(iso) > Date.now();

  return (
    <div className="space-y-5 pb-8 sm:space-y-6">
      <PageHeader title="Sea zones" subtitle="Live piracy in every zone. Letters of marque raise it, Crown naval patrols lower it; every company's contributions stack." />

      <div className="grid items-start gap-4 xl:grid-cols-3">
        <Panel
          title="Piracy by zone"
          className="xl:col-span-2"
          action={
            <Checkbox checked={allPhases} onChange={setAllPhases}>
              <span className="text-xs">Show locked phases</span>
            </Checkbox>
          }
        >
          <ErrorNote error={error} />
          {!zones ? (
            !error && <Loading />
          ) : (
            <Table head={["Zone", "Water", "Base", "Marques", "Patrols", "Net", "Next expiry"]}>
              {rows.map((z) => {
                const info = zoneInfo(z.sea_zone_id);
                const nextExpiry = [z.next_marque_expires_at, z.next_patrol_expires_at]
                  .filter((x): x is string => !!x)
                  .sort()[0];
                return (
                  <tr
                    key={z.sea_zone_id}
                    onClick={() => setZone(z.sea_zone_id)}
                    className={`cursor-pointer hover:bg-accent/50 ${zone === z.sea_zone_id ? "bg-accent" : ""}`}
                  >
                    <td className="font-medium">
                      {z.name}
                      {z.phase > phase && <span className="ml-1.5 text-muted-foreground text-xs">phase {z.phase}</span>}
                    </td>
                    <td className="text-muted-foreground text-xs">{info?.zone_class ?? "—"}</td>
                    <td className="tabular-nums">{fmtBps(z.base_piracy_bps)}</td>
                    <td className="tabular-nums">
                      {z.marque_piracy_bps ? `+${fmtBps(z.marque_piracy_bps)}` : "—"}
                      {z.active_marques > 0 && <span className="text-muted-foreground text-xs"> ({z.active_marques})</span>}
                    </td>
                    <td className="tabular-nums">
                      {z.patrol_suppression_bps ? `−${fmtBps(z.patrol_suppression_bps)}` : "—"}
                      {z.active_patrols > 0 && <span className="text-muted-foreground text-xs"> ({z.active_patrols})</span>}
                    </td>
                    <td>
                      <Badge variant={piracyVariant(z.net_piracy_bps)} size="sm">{fmtBps(z.net_piracy_bps)}</Badge>
                    </td>
                    <td className="text-muted-foreground text-xs">{nextExpiry ? fmtIn(nextExpiry) : "—"}</td>
                  </tr>
                );
              })}
            </Table>
          )}
          <p className="mt-3 text-muted-foreground text-xs">
            Each leg rolls piracy for the zone it ends in; cannons cut interceptions sharply. Net piracy = base + marques − patrols, and is what Lloyd&apos;s prices cover from.
          </p>
        </Panel>

        <Panel title="Sponsor">
          <SponsorForm
            maxPhase={phase}
            zone={zone}
            setZone={setZone}
            onDone={() => {
              void reload();
              void reloadMarques();
              void reloadPatrols();
            }}
          />
        </Panel>
      </div>

      <div className="grid items-start gap-4 xl:grid-cols-2">
        <Panel title="Your letters of marque">
          <ErrorNote error={marqueError} />
          {!marques ? (
            !marqueError && <Loading />
          ) : marques.length === 0 ? (
            <Empty>None issued.</Empty>
          ) : (
            <Table head={["Zone", "Piracy", "Cost", "Prize earned", "Region", "Expires"]}>
              {marques.map((m) => (
                <tr key={m.id} className={live(m.expires_at) ? undefined : "text-muted-foreground"}>
                  <td>{zoneName(m.sea_zone_id)}</td>
                  <td className="tabular-nums">+{fmtBps(m.added_piracy_bps)}</td>
                  <td className="tabular-nums">{fmtCr(m.cost_pence)}</td>
                  <td className="tabular-nums">{fmtCr(m.prize_earned_pence)}</td>
                  <td className="text-xs">{m.banking_region?.replace("_", " ") ?? "—"}</td>
                  <td className="text-xs">{live(m.expires_at) ? fmtIn(m.expires_at) : `ended ${fmtDateTime(m.expires_at)}`}</td>
                </tr>
              ))}
            </Table>
          )}
          <Pager pager={marquePager} rows={marques} />
        </Panel>

        <Panel title="Your naval patrols">
          <ErrorNote error={patrolError} />
          {!patrols ? (
            !patrolError && <Loading />
          ) : patrols.length === 0 ? (
            <Empty>None funded.</Empty>
          ) : (
            <Table head={["Zone", "Suppression", "Cost", "Prize earned", "Region", "Funded", "Expires"]}>
              {patrols.map((p) => (
                <tr key={p.id} className={live(p.expires_at) ? undefined : "text-muted-foreground"}>
                  <td>{zoneName(p.sea_zone_id)}</td>
                  <td className="tabular-nums">−{fmtBps(p.suppressed_piracy_bps)}</td>
                  <td className="tabular-nums">{fmtCr(p.cost_pence)}</td>
                  <td className={`tabular-nums ${(p.prize_earned_pence ?? 0) >= p.cost_pence ? "text-success-foreground" : ""}`}>{fmtCr(p.prize_earned_pence ?? 0)}</td>
                  <td className="text-xs">{p.banking_region?.replace("_", " ") ?? "—"}</td>
                  <td className="text-xs">{fmtDateTime(p.created_at)}</td>
                  <td className="text-xs">{live(p.expires_at) ? fmtIn(p.expires_at) : `ended ${fmtDateTime(p.expires_at)}`}</td>
                </tr>
              ))}
            </Table>
          )}
          <Pager pager={patrolPager} rows={patrols} />
        </Panel>
      </div>
    </div>
  );
}
