"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Empty, ErrorNote, KV, Loading, PageHeader, Panel, Table } from "@/components/kibb/bits";
import { MONOPOLY } from "@/components/kibb/deals-common";
import { CashLine, WarnBox, crToPence, firstProblem, regionName, useRegionOf, useVaults } from "@/components/kibb/finance-common";
import { Checkbox, Segmented, useCompanyId, useOurCompanyIds } from "@/components/kibb/naval-common";
import { Field, GoodSelect, REGIONS, RegionSelect } from "@/components/kibb/pickers";
import { LoadMore, usePaged } from "@/components/kibb/trade-common";
import { useAction } from "@/hooks/use-action";
import { useCatalog } from "@/hooks/use-catalog";
import { usePoll } from "@/hooks/use-poll";
import { kibbGet, kibbPost } from "@/lib/kibb/browser";
import { fmtBps, fmtCr, fmtDateTime, fmtIn } from "@/lib/kibb/format";
import type * as S from "@/lib/kibb/schema";
import type { CompanyProfile } from "@/lib/kibb/types";

type Term = (typeof MONOPOLY.terms)[number];

/** Every good the Crown may sell a monopoly on (never provisions or silver). */
function useMonopolisable(): string[] {
  const { catalog } = useCatalog();
  return (catalog?.commodities ?? []).map((c) => c.id).filter((id) => !MONOPOLY.never.includes(id));
}

function HolderText({ m, companyId, ourIds }: { m: S.MonopolyResult; companyId: string | undefined; ourIds: Set<string> }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <span>{m.holder_company_name}</span>
      {m.holder_company_id === companyId ? (
        <Badge variant="info" size="sm">you</Badge>
      ) : ourIds.has(m.holder_company_id) ? (
        <Badge variant="secondary" size="sm">your company</Badge>
      ) : null}
    </span>
  );
}

function Grants({ companyId, ourIds }: { companyId: string | undefined; ourIds: Set<string> }) {
  const { goodName } = useCatalog();
  const goods = useMonopolisable();
  const [region, setRegion] = useState("");
  const [good, setGood] = useState("");
  const [history, setHistory] = useState(false);
  const list = usePaged(
    (cursor) =>
      kibbGet<S.MonopolyResult[]>("/v1/world/monopolies", {
        banking_region: region,
        commodity_id: good,
        include_expired: history ? true : undefined,
        cursor,
        limit: 100,
      }),
    100,
    [region, good, history],
  );
  const ours = list.items.filter((m) => m.in_force && ourIds.has(m.holder_company_id));

  return (
    <Panel
      title={history ? "Royal monopolies, in force and ended" : "Royal monopolies in force"}
      action={
        <Checkbox checked={history} onChange={setHistory}>
          <span className="text-xs">Include ended</span>
        </Checkbox>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Banking region">
            <RegionSelect value={region} onChange={setRegion} placeholder="All regions" />
          </Field>
          <Field label="Good">
            <GoodSelect value={good} onChange={setGood} placeholder="All goods" only={goods} />
          </Field>
        </div>
        <ErrorNote error={list.error} />
        {list.items.length === 0 ? (
          list.loading ? <Loading /> : <Empty>No monopolies {history ? "match" : "in force"}{region || good ? " for this filter" : ""}.</Empty>
        ) : (
          <Table head={["Good", "Region", "Holder", "Term", "From", "Until", "Paid", ""]}>
            {list.items.map((m) => (
              <tr key={m.id} className={m.in_force ? undefined : "text-muted-foreground"}>
                <td className="font-medium">{goodName(m.commodity_id)}</td>
                <td className="capitalize">{regionName(m.banking_region)}</td>
                <td>
                  <HolderText m={m} companyId={companyId} ourIds={ourIds} />
                </td>
                <td className="tabular-nums">{m.term_game_days} days</td>
                <td className="whitespace-nowrap text-xs">{fmtDateTime(m.starts_at)}</td>
                <td className="whitespace-nowrap text-xs">{m.in_force ? fmtIn(m.expires_at) : fmtDateTime(m.expires_at)}</td>
                <td className="tabular-nums">{fmtCr(m.price_pence)}</td>
                <td>
                  <Badge variant={m.in_force ? "warning" : "outline"} size="sm">
                    {m.in_force ? "in force" : "ended"}
                  </Badge>
                </td>
              </tr>
            ))}
          </Table>
        )}
        <LoadMore done={list.done} loading={list.loading} onMore={() => void list.more()} />
        {ours.length > 0 && (
          <p className="text-sm">
            Your player holds {ours.length} in force (at most {MONOPOLY.perPlayer} across all your companies and linked ones).
          </p>
        )}
        <p className="text-muted-foreground text-xs">
          While one is in force, only the holder buys the good from the Crown merchants&apos; asks at every port of the region, and only the holder&apos;s resting bids
          are filled by the Crown&apos;s ladder. Everyone else, the holder&apos;s own other companies and linked companies included, buys from the holder&apos;s (or other
          players&apos;) resting asks or brings the goods in: an IOC buy only the monopoly kept from filling is refused (409) naming the holder, a GTC bid just rests,
          and a turnkey build needing the good takes it only from players&apos; asks. Selling to the Crown, provisioning and charters are unaffected.
        </p>
      </div>
    </Panel>
  );
}

function QuoteAndBuy({ homeRegion, onDone }: { homeRegion: string; onDone: () => void }) {
  const { goodName, portName } = useCatalog();
  const goods = useMonopolisable();
  const vaults = useVaults();
  const [region, setRegion] = useState("");
  const [good, setGood] = useState("");
  const [term, setTerm] = useState<Term>(10);
  const [maxPrice, setMaxPrice] = useState("");
  const [ack, setAck] = useState(false);
  const at = region || homeRegion;
  const { data, error } = usePoll(
    at && good ? () => kibbGet<S.MonopolyQuoteResult>("/v1/world/monopoly-quote", { banking_region: at, commodity_id: good, term_game_days: term }) : null,
    30_000,
    [at, good, term],
  );
  // Only a quote for these very inputs.
  const q = data && data.banking_region === at && data.commodity_id === good && data.term_game_days === term ? data : undefined;
  // Resolves to null when the confirmation is declined.
  const act = useAction<S.MonopolyResult | null>((r) => {
    if (!r) return;
    setAck(false);
    void vaults.reload();
    onDone();
  });
  const cash = vaults.cash(at);
  const cap = maxPrice.trim() === "" ? (q?.price_pence ?? Number.NaN) : crToPence(maxPrice);
  const why = firstProblem([
    [!!good, "Choose the good."],
    [!!q, error ? "Couldn't quote it." : "Quoting…"],
    [!q || q.available, `Not available: ${q?.unavailable_reason ?? "the Crown won't sell it now"}.`],
    [!q?.player_cap_reached, `Your player already holds ${q?.player_monopolies_held ?? MONOPOLY.perPlayer} (at most ${q?.max_monopolies_per_player ?? MONOPOLY.perPlayer} across your companies and linked ones).`],
    [Number.isFinite(cap) && cap > 0, "Enter the most you'll pay."],
    [!q || cap >= q.price_pence, `Your most (${fmtCr(cap)}) is under the price now (${fmtCr(q?.price_pence)}): the purchase would be refused.`],
    [cash === undefined || !q || cash >= q.price_pence, `It is paid from your ${regionName(at)} vault, which holds only ${fmtCr(cash)}.`],
    [ack, "Tick the box: a monopoly is dear, never refunded, and only pays if you resell the region's Crown volume."],
  ]);

  function submit() {
    if (!q) return;
    void act.run(async () => {
      if (
        !confirm(
          `BUY the royal monopoly on ${goodName(good)} in ${regionName(at)} for ${q.term_game_days} game days, for ${fmtCr(q.price_pence)} (at most ${fmtCr(cap)}), from your ${regionName(at)} vault?\n\nThis money is NEVER refunded. For the term only this company may buy ${goodName(good)} from the Crown's asks at ${q.market_ports.map(portName).join(", ") || "the region's ports"} — your other companies are barred too. It only pays if you resell that Crown volume to other buyers at a markup of at least ${fmtBps(q.price_bps)} on all of it; imports from neighbouring regions cap markups at roughly 15%. On a quiet good, or one where you are the main buyer, it is money thrown away. You can't renew the same scope until 10 game days after it ends.`,
        )
      )
        return null;
      return kibbPost<S.MonopolyResult>("/v1/market/buy-monopoly", {
        banking_region: at,
        commodity_id: good,
        term_game_days: q.term_game_days,
        max_price_pence: cap,
      });
    });
  }

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <Field label="Banking region">
          <RegionSelect
            value={at}
            onChange={(v) => {
              setRegion(v);
              setAck(false);
            }}
          />
        </Field>
        <Field label="Good">
          <GoodSelect
            value={good}
            onChange={(v) => {
              setGood(v);
              setAck(false);
            }}
            placeholder="Choose…"
            only={goods}
          />
        </Field>
      </div>
      <Field label="Term (game days)">
        <Segmented<string>
          value={String(term)}
          onChange={(v) => {
            setTerm(Number(v) as Term);
            setAck(false);
          }}
          options={MONOPOLY.terms.map((t) => ({ value: String(t), label: `${t} days` }))}
        />
      </Field>
      <ErrorNote error={error} />
      {q && (
        <KV
          rows={[
            ["Price now", <span key="p" className="font-semibold">{fmtCr(q.price_pence)}</span>],
            ["Expected Crown sales", `${fmtCr(q.expected_daily_sales_pence)} a game day (floor ${fmtCr(q.floor_daily_sales_pence)}), ${fmtCr(q.expected_daily_sales_pence * q.term_game_days)} over the term`],
            ["Recent Crown sales", `${fmtCr(q.recent_crown_sales_pence)} over the last ${q.lookback_game_days} game days`],
            ["Price is", `${fmtBps(q.price_bps)} of the expected sales`],
            ["Where it applies", q.market_ports.map(portName).join(", ") || "—"],
            ["Held by", q.held_by ? `${q.held_by.holder_company_name}, until ${fmtDateTime(q.held_by.expires_at)}` : "nobody"],
            ["Available", q.available ? "yes" : `no: ${q.unavailable_reason ?? "—"}`],
            [
              "Your player",
              q.player_monopolies_held === null || q.player_monopolies_held === undefined
                ? `cap ${q.max_monopolies_per_player} in force`
                : `${q.player_monopolies_held} of ${q.max_monopolies_per_player} in force${q.player_cap_reached ? " (cap reached)" : ""}`,
            ],
          ]}
        />
      )}
      {q && (
        <WarnBox tone="error">
          <p className="font-medium">Expensive, never refunded.</p>
          <p>
            You break even only by reselling the region&apos;s whole expected Crown volume of {goodName(good)} at least {fmtBps(q.price_bps)} over the Crown&apos;s price;
            imports from neighbouring regions cap that at roughly 15%. On a quiet good, or one where you are the main buyer, it is money thrown away.
          </p>
        </WarnBox>
      )}
      <Field label="Most you'll pay (Cr; refused if the price has moved above it)">
        <Input type="number" min={1} step={1} value={maxPrice} onChange={(e) => setMaxPrice(e.target.value)} placeholder={q ? String(Math.ceil(q.price_pence / 100)) : undefined} />
      </Field>
      <CashLine region={at} cash={cash} need={q?.price_pence} />
      <Checkbox checked={ack} onChange={setAck}>
        <span className="text-xs">I understand: it is never refunded and only pays if I resell the region&apos;s Crown volume at a markup.</span>
      </Checkbox>
      <ErrorNote error={act.error ?? (good && q ? why : null)} />
      {act.result && (
        <p className="text-sm">
          You hold the monopoly on {goodName(act.result.commodity_id)} in {regionName(act.result.banking_region)} until {fmtDateTime(act.result.expires_at)}, for{" "}
          {fmtCr(act.result.price_pence)}.
        </p>
      )}
      <Button variant="destructive" className="w-full" disabled={!!why || act.busy} onClick={submit}>
        {act.busy ? "Buying…" : q ? `Buy for ${fmtCr(q.price_pence)}` : "Buy the monopoly"}
      </Button>
    </div>
  );
}

export default function MonopoliesPage() {
  const companyId = useCompanyId();
  const ourIds = useOurCompanyIds();
  const regionOf = useRegionOf();
  const { data: profile } = usePoll(() => kibbGet<CompanyProfile>("/v1/company/profile"));
  const homeRegion = regionOf(profile?.company.home_port_id) ?? REGIONS[0];
  const [version, setVersion] = useState(0);

  return (
    <div className="space-y-5 pb-8 sm:space-y-6">
      <PageHeader
        title="Royal monopolies"
        subtitle="The Crown sells, for 5, 10 or 20 game days, the sole right to buy one good from its merchants at every port of one banking region."
      />
      <div className="grid items-start gap-4 xl:grid-cols-3">
        <div className="xl:col-span-2">
          <Grants key={version} companyId={companyId} ourIds={ourIds} />
        </div>
        <div className="space-y-4">
          <Panel title="Quote and buy">
            <QuoteAndBuy homeRegion={homeRegion} onDone={() => setVersion((v) => v + 1)} />
          </Panel>
          <WarnBox tone="info">
            <p>
              The price is a tenth of the Crown&apos;s expected sales of the good in the region over the term: its last 7 game days of sales a day, never below 5 t a day at
              base price per port that trades it. Thousands to tens of thousands of Crowns on a busy good.
            </p>
            <p>
              One holder at a time; no back-to-back renewal (10 game days after a grant ends, for you and linked companies); at most {MONOPOLY.perPlayer} in force per
              player. A holder that goes bankrupt loses its grants. Provisions and silver bullion are never sold.
            </p>
          </WarnBox>
        </div>
      </div>
    </div>
  );
}
