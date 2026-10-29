"use client";

import { useState } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, ErrorNote, Loading, NativeSelect, PageHeader, Panel, Table, TextArea } from "@/components/kibb/bits";
import { LoadMore, useNextCursorPaged } from "@/components/kibb/company-paged";
import { COLLATERAL_LABEL, WarnBox, lineRateText, regionName } from "@/components/kibb/finance-common";
import { useCompanyId } from "@/components/kibb/naval-common";
import { RegionSelect } from "@/components/kibb/pickers";
import { fetchAll } from "@/components/kibb/trade-common";
import { useAction } from "@/hooks/use-action";
import { useCatalog } from "@/hooks/use-catalog";
import { usePoll } from "@/hooks/use-poll";
import { kibbGet, kibbPost } from "@/lib/kibb/browser";
import { fmtAgo, fmtBps, fmtCr, fmtDateTime, fmtGameHours, fmtIn, fmtTons } from "@/lib/kibb/format";
import type * as S from "@/lib/kibb/schema";

/** Each kind of offer the Exchange lists (guide 3.21), and the page that acts on it. */
const KINDS: Array<{ kind: S.ExchangeKind; label: string; href?: string; act: string }> = [
  { kind: "ship_for_sale", label: "Ships for sale", href: "/ships-market", act: "buy with quay presence at her port" },
  { kind: "commission", label: "Commissions", href: "/ships-market?tab=commissions", act: "accept and build with presence at the yard" },
  { kind: "venture", label: "Ventures", href: "/ventures", act: "invest while it raises" },
  { kind: "ship_shares", label: "Ship shares", href: "/shares", act: "buy the 64ths" },
  { kind: "licence_offer", label: "Licence offers", act: "take units of the design" },
  { kind: "licence_request", label: "Licence requests", act: "fill with a design you hold" },
  { kind: "loan_request", label: "Loan requests", href: "/loans", act: "quote a rate (Lend)" },
  { kind: "bank", label: "Banks", href: "/banks", act: "deposit" },
  { kind: "futures", label: "Futures", href: "/futures", act: "take the other side" },
  { kind: "lending_line", label: "Lending lines", href: "/banks", act: "post a loan request it covers" },
];

const kindOf = (k: S.ExchangeKind) => KINDS.find((x) => x.kind === k)!;

/** At most 200 characters and no digits at all (guide 3.21): the entry already shows the numbers. */
const NOTE_MAX = 200;
const HAS_DIGIT = /\p{Nd}/u;

function noteProblem(note: string): string | null {
  if (HAS_DIGIT.test(note)) return "A note may hold no digits at all: the entry already shows the numbers, so say it in words (\"fair price, sound hull\").";
  if (note.length > NOTE_MAX) return `At most ${NOTE_MAX} characters (${note.length} now).`;
  return null;
}

/** The ids of our own open offers on the Exchange, by kind, read from each offer's own list (every 2 minutes). */
function useOwnEntries(companyId: string | undefined) {
  const { data } = usePoll(
    companyId
      ? async () => {
          const safe = <T,>(p: Promise<T[]>) => p.catch(() => [] as T[]);
          const contracts = (type: string) => safe(fetchAll<S.ContractListing>("/v1/contract/list", { contract_type: type, status: "open" }, 200, 5));
          const [listings, commissions, offers, requests, ventures, shares, loans, futures, lines] = await Promise.all([
            safe(fetchAll<S.ShipListingResult>("/v1/fleet/ship-listings", {}, 200, 5)),
            contracts("commission"),
            contracts("licence_offer"),
            contracts("licence_request"),
            safe(kibbGet<S.Venture[]>("/v1/venture/list", { status: "raising" })),
            safe(kibbGet<S.ShareListing[]>("/v1/ship-shares/listings")),
            safe(kibbGet<S.LoanRequestView[]>("/v1/loan/requests", { mine: true, limit: 50 })),
            safe(fetchAll<S.FuturesContract>("/v1/future/list", { status: "open" }, 200, 5)),
            safe(kibbGet<S.LendingLine[]>("/v1/bank/lending-lines", { company_id: companyId })),
          ]);
          const issued = (rows: S.ContractListing[]) => rows.filter((c) => c.issuer_company_id === companyId).map((c) => c.id);
          return new Set<string>([
            ...listings.filter((l) => l.status === "open").map((l) => `ship_for_sale:${l.id}`),
            ...issued(commissions).map((id) => `commission:${id}`),
            ...issued(offers).map((id) => `licence_offer:${id}`),
            ...issued(requests).map((id) => `licence_request:${id}`),
            ...ventures.filter((v) => v.merchant_company_id === companyId).map((v) => `venture:${v.id}`),
            ...shares.filter((l) => l.seller_company_id === companyId && l.status === "open").map((l) => `ship_shares:${l.id}`),
            ...loans.filter((r) => r.status === "open").map((r) => `loan_request:${r.id}`),
            ...futures.filter((f) => f.creator_company_id === companyId).map((f) => `futures:${f.id}`),
            ...lines.filter((l) => l.bank_company_id === companyId).map((l) => `lending_line:${l.id}`),
            `bank:${companyId}`,
          ]);
        }
      : null,
    120_000,
    [companyId],
  );
  return { known: data !== undefined, isOurs: (e: S.ExchangeEntry) => !!data?.has(`${e.kind}:${e.id}`) };
}

/** What an entry offers, in a line, and its terms in a second (by kind; `details` carries no tag of its own). */
function Summary({ e }: { e: S.ExchangeEntry }) {
  const { portName, goodName, shipClassName } = useCatalog();
  const line = (a: React.ReactNode, b: React.ReactNode) => (
    <>
      <div className="font-medium">{a}</div>
      <div className="text-muted-foreground text-xs">{b}</div>
    </>
  );
  switch (e.kind) {
    case "ship_for_sale": {
      const d = e.details as S.ShipForSaleDetails;
      return line(
        `${d.ship_name} · ${shipClassName(d.ship_class)}`,
        `${fmtCr(d.price_pence)} at ${portName(d.port_id)} · ${d.cannons_count} guns${d.components.length ? ` · ${d.components.map((c) => c.name).join(", ")}` : ""}`,
      );
    }
    case "commission": {
      const d = e.details as S.CommissionDetails;
      return line(
        `${d.admiralty ? "Admiralty: " : ""}${shipClassName(d.ship_class)} built at ${portName(d.port_id)}`,
        `${fmtCr(d.price_pence)}${d.admiralty ? " from the Crown (the hull joins the Royal Navy; a deposit, one at a time)" : ""} · deliver ${fmtIn(d.deadline)}`,
      );
    }
    case "venture": {
      const d = e.details as S.VentureDetails;
      return line(
        `${portName(d.origin_port_id)} → ${portName(d.dest_port_id)}`,
        `investors take ${fmtBps(d.investor_share_bps)} of the profit · ${fmtCr(d.capital_raised_pence)} raised · raises ${fmtIn(d.raise_by)}`,
      );
    }
    case "ship_shares": {
      const d = e.details as S.ShipSharesDetails;
      return line(`${d.sixty_fourths}/64 of ${d.ship_name} · ${shipClassName(d.ship_class)}`, `${fmtCr(d.price_per_64th_pence, 2)} a 64th · ${fmtCr(d.price_per_64th_pence * d.sixty_fourths)} in all`);
    }
    case "licence_offer":
    case "licence_request": {
      const d = e.details as S.LicenceDetails;
      return line(`${d.design_name} (${d.slot})`, `${d.units} unit${d.units === 1 ? "" : "s"} left · ${fmtCr(d.price_pence)} ${d.price_basis === "per_unit" ? "a unit" : "the lot"}`);
    }
    case "loan_request": {
      const d = e.details as S.LoanRequestDetails;
      const r = d.borrower_record;
      return line(
        `${d.borrower_name} asks ${fmtCr(d.principal_pence)} for ${d.term_game_days} game days`,
        `${COLLATERAL_LABEL[d.collateral_kind] ?? d.collateral_kind} · repaid ${r.loans_repaid}, defaulted ${r.loans_defaulted}${r.loans_walked_away ? `, walked away ${r.loans_walked_away}` : ""} · owes ${fmtCr(r.owed_pence)} on ${r.loans_owed}`,
      );
    }
    case "bank": {
      const d = e.details as S.BankDetails;
      const fees = Object.entries(d.exchange_fee_bps ?? {});
      return line(
        d.bank_name,
        `${d.demand_rate_bps} bps/day on demand · ${d.notice_rate_bps} bps/day on ${fmtGameHours(d.notice_game_hours)} notice${fees.length ? ` · exchange ${fees.map(([r, b]) => `${regionName(r)} ${fmtBps(b)}`).join(", ")}` : ""}`,
      );
    }
    case "futures": {
      const d = e.details as S.FuturesDetails;
      return line(
        `${d.side === "ask" ? "Sells" : "Buys"} ${fmtTons(d.lot_tons)} ${goodName(d.commodity_id)} at ${portName(d.port_id)}`,
        `strike ${fmtCr(d.strike_price_pence, 2)}/t · matures ${fmtIn(d.matures_at)}`,
      );
    }
    case "lending_line": {
      const d = e.details as S.LendingLineDetails;
      return line(
        `${d.bank_name} lends at ${lineRateText(d.rate_pct_of_goldsmiths_bps)} rate`,
        `${d.regions.map(regionName).join(", ")} · ${d.collateral_kinds.map((k) => COLLATERAL_LABEL[k] ?? k).join(", ")} · ${d.repayments.join(", ")} · ${fmtCr(d.min_principal_pence)}–${fmtCr(d.max_principal_pence)} up to ${d.max_term_game_days} game days, LTV ≤ ${fmtBps(d.max_ltv_bps)}${d.allow_non_recourse ? ", non-recourse ok" : ""} · ${fmtCr(d.remaining_capacity_pence)} room`,
      );
    }
  }
}

function NoteForm({ entry, onDone, onClose }: { entry: S.ExchangeEntry; onDone: () => void; onClose: () => void }) {
  const [note, setNote] = useState(entry.note_removed ? "" : (entry.note ?? ""));
  const act = useAction<S.ExchangeEntry>(onDone);
  const text = note.trim();
  const why = entry.note_removed ? "The harbourmaster removed this entry's note: it can't be changed." : noteProblem(text);
  return (
    <div className="space-y-3">
      <div className="text-sm">
        <Summary e={entry} />
        <div className="mt-1 text-muted-foreground text-xs">
          {kindOf(entry.kind).label} · <span className="capitalize">{regionName(entry.banking_region)}</span> · posted {fmtDateTime(entry.posted_at)} ·{" "}
          <span className="font-mono">{entry.id}</span>
        </div>
      </div>
      <TextArea value={note} maxLength={NOTE_MAX} onChange={(e) => setNote(e.target.value)} placeholder="In words only: why this offer, what goes with it" disabled={entry.note_removed} />
      <p className={`text-xs ${text.length > NOTE_MAX ? "text-destructive" : "text-muted-foreground"}`}>
        {text.length} / {NOTE_MAX} characters. Plain text and no digits at all. Empty clears the note.
      </p>
      <ErrorNote error={act.error ?? (note ? why : entry.note_removed ? why : null)} />
      {act.result && <p className="text-sm">{act.result.note ? "Note set." : "Note cleared."}</p>}
      <div className="flex gap-2">
        <Button
          className="flex-1"
          disabled={!!why || act.busy}
          onClick={() => void act.run(() => kibbPost<S.ExchangeEntry>("/v1/exchange/note", { kind: entry.kind, id: entry.id, note: text || null }))}
        >
          {act.busy ? "Saving…" : text ? "Set the note" : "Clear the note"}
        </Button>
        <Button variant="outline" onClick={onClose}>
          Close
        </Button>
      </div>
    </div>
  );
}

function EntryRows({ rows, isOurs, onNote, selected }: { rows: S.ExchangeEntry[]; isOurs: (e: S.ExchangeEntry) => boolean; onNote: (e: S.ExchangeEntry) => void; selected: string | null }) {
  return (
    <Table head={["Offer", "Region", "Posted", "Note", ""]}>
      {rows.map((e) => {
        const ours = isOurs(e);
        return (
          <tr key={`${e.kind}:${e.id}`} className={selected === `${e.kind}:${e.id}` ? "bg-accent" : undefined}>
            <td className="min-w-56">
              <Summary e={e} />
              {ours && (
                <Badge variant="secondary" size="sm" className="mt-0.5">
                  yours
                </Badge>
              )}
            </td>
            <td className="whitespace-nowrap capitalize">{regionName(e.banking_region)}</td>
            <td className="whitespace-nowrap text-muted-foreground text-xs" title={fmtDateTime(e.posted_at)}>
              {fmtAgo(e.posted_at)}
            </td>
            <td className="max-w-64 text-xs">
              {e.note_removed ? <span className="text-muted-foreground italic">removed by the harbourmaster</span> : e.note ? <span className="italic">{e.note}</span> : <span className="text-muted-foreground">—</span>}
            </td>
            <td className="text-right">
              <div className="flex justify-end gap-1.5">
                {ours && (
                  <Button size="sm" variant="outline" onClick={() => onNote(e)}>
                    Note
                  </Button>
                )}
                {kindOf(e.kind).href && (
                  <Button size="sm" variant="ghost" render={<Link href={kindOf(e.kind).href!} />}>
                    Open
                  </Button>
                )}
              </div>
            </td>
          </tr>
        );
      })}
    </Table>
  );
}

export default function ExchangePage() {
  const companyId = useCompanyId();
  const own = useOwnEntries(companyId);
  const [kind, setKind] = useState<S.ExchangeKind | "">("");
  const [region, setRegion] = useState("");
  const [picked, setPicked] = useState<S.ExchangeEntry | null>(null);
  const list = useNextCursorPaged<S.ExchangePage, S.ExchangeEntry>(
    (cursor) => kibbGet<S.ExchangePage>("/v1/exchange", { kind, region, cursor, limit: 100 }),
    (p) => p.entries,
    [kind, region],
  );
  const groups = KINDS.map((k) => ({ ...k, rows: list.items.filter((e) => e.kind === k.kind) })).filter((g) => g.rows.length > 0);
  const selectedKey = picked ? `${picked.kind}:${picked.id}` : null;
  const ours = list.items.filter(own.isOurs);

  return (
    <div className="space-y-5 pb-8 sm:space-y-6">
      <PageHeader
        title="The Exchange"
        subtitle="Every player-made offer open right now, world-wide, newest first. Act on one through its own page: its own rules (quay presence to buy a ship, presence at the yard to build) still apply."
        actions={
          <Button variant="outline" disabled={list.loading} onClick={list.reload}>
            Refresh
          </Button>
        }
      />
      <div className="grid items-start gap-4 xl:grid-cols-3">
        <Panel
          title={list.items.length ? `${list.items.length} offer${list.items.length === 1 ? "" : "s"} shown` : "Offers"}
          className="xl:col-span-2"
          action={
            <>
              <div className="w-full sm:w-44">
                <NativeSelect value={kind} onChange={(e) => setKind(e.target.value as S.ExchangeKind | "")}>
                  <option value="">Every kind</option>
                  {KINDS.map((k) => (
                    <option key={k.kind} value={k.kind}>
                      {k.label}
                    </option>
                  ))}
                </NativeSelect>
              </div>
              <div className="w-full sm:w-40">
                <RegionSelect value={region} onChange={setRegion} placeholder="Every region" />
              </div>
            </>
          }
        >
          <ErrorNote error={list.error} />
          {list.items.length === 0 ? (
            list.loading ? <Loading /> : <Empty>No open offers{kind ? ` of this kind` : ""}{region ? ` in ${regionName(region)}` : ""}.</Empty>
          ) : (
            <div className="space-y-6">
              {groups.map((g) => (
                <section key={g.kind}>
                  <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
                    <h3 className="font-medium text-sm">
                      {g.label} <span className="font-normal text-muted-foreground text-xs">({g.rows.length})</span>
                    </h3>
                    <span className="text-muted-foreground text-xs">
                      {g.href ? (
                        <Link href={g.href} className="text-primary hover:underline">
                          {g.act} →
                        </Link>
                      ) : (
                        `${g.act} (by its id, through the API)`
                      )}
                    </span>
                  </div>
                  <EntryRows rows={g.rows} isOurs={own.isOurs} selected={selectedKey} onNote={setPicked} />
                </section>
              ))}
            </div>
          )}
          <LoadMore loading={list.loading} done={list.done} onClick={list.loadMore} count={list.items.length} />
        </Panel>
        <div className="space-y-4">
          <Panel
            title="Your note"
            action={
              picked && (
                <Button size="sm" variant="ghost" onClick={() => setPicked(null)}>
                  Close
                </Button>
              )
            }
          >
            {picked ? (
              <NoteForm
                key={selectedKey}
                entry={picked}
                onDone={list.reload}
                onClose={() => setPicked(null)}
              />
            ) : (
              <div className="space-y-2 text-muted-foreground text-sm">
                <p>
                  Pin one note to an open offer of yours: plain text, at most {NOTE_MAX} characters, and no digits at all. The entry already shows the numbers, so
                  a note says things in words. Only the offer&apos;s owner may set one; a note the harbourmaster removed can&apos;t be changed.
                </p>
                <p>
                  {!own.known
                    ? "Reading your own offers…"
                    : ours.length
                      ? `${ours.length} of the offers shown ${ours.length === 1 ? "is" : "are"} yours: press Note on one.`
                      : "None of the offers shown is yours."}
                </p>
              </div>
            )}
          </Panel>
          <WarnBox tone="info">
            <p>An offer appears the moment it opens and goes the moment it is sold, filled, taken, withdrawn or lapses. Player charters and freight are not listed: they stay port gossip.</p>
            <p>
              Ship listings, commissions and ventures are posted here unless they were opened unlisted, which keeps them to their port&apos;s quay. A bank&apos;s entry is
              dated by its last change of terms, a lending line&apos;s by its last change.
            </p>
            <p>
              A lending line quotes on its own on every new request it covers: to borrow on one, post a loan request in its region against a pledge it takes, within
              its term, principal and loan-to-value. See every column on the{" "}
              <Link href="/banks" className="text-primary hover:underline">
                banks
              </Link>{" "}
              page.
            </p>
          </WarnBox>
        </div>
      </div>
    </div>
  );
}
