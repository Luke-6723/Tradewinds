"use client";

import { useState } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Empty, ErrorNote, KV, Loading, Metrics, NativeSelect, PageHeader, Panel, Table } from "@/components/kibb/bits";
import { useDeskBoard } from "@/components/kibb/desks-common";
import {
  CashLine,
  CompanyLabel,
  VENTURE,
  WarnBox,
  crToPence,
  firstProblem,
  num,
  regionName,
  shortId,
  useCompanyDirectory,
  useCompanyNames,
  useFleetFinance,
  useLearnCompanies,
  usePledgedShips,
  useRegionOf,
  useShips,
  useVaults,
} from "@/components/kibb/finance-common";
import { Checkbox, useCompanyId, useOurCompanyIds } from "@/components/kibb/naval-common";
import { Field, GoodSelect, PortSelect, ShipSelect } from "@/components/kibb/pickers";
import { useAction } from "@/hooks/use-action";
import { useCatalog } from "@/hooks/use-catalog";
import { usePoll } from "@/hooks/use-poll";
import { kibbGet, kibbPost } from "@/lib/kibb/browser";
import { fmtBps, fmtCr, fmtDateTime, fmtIn, fmtTons } from "@/lib/kibb/format";
import type * as S from "@/lib/kibb/schema";
import type { PortOrderBook, ShipResult, WorldClock } from "@/lib/kibb/types";

type Vaults = ReturnType<typeof useVaults>;

const STATUSES = ["raising", "sailing", "arrived", "settled", "lost", "cancelled"];
const STATUS_VARIANT: Record<string, "info" | "secondary" | "success" | "warning" | "error" | "outline"> = {
  raising: "info",
  sailing: "secondary",
  arrived: "warning",
  settled: "success",
  lost: "error",
  cancelled: "outline",
};
const AT_PORT = new Set(["berthed", "anchored_roadstead"]);

function VentureStatus({ status }: { status: string }) {
  return (
    <Badge variant={STATUS_VARIANT[status] ?? "outline"} size="sm">
      {status}
    </Badge>
  );
}

/** Best price on one side of a port's book for a good (null: none seen). */
function useBest(port: string, good: string, side: "bid" | "ask") {
  const { data } = usePoll(port && good ? () => kibbGet<PortOrderBook>("/v1/market/book", { port_id: port }) : null, 30_000, [port, good]);
  const book = data?.port_id === port ? data.books.find((b) => b.commodity_id === good) : undefined;
  return side === "bid" ? (book?.best_bid ?? null) : (book?.best_ask ?? null);
}

function InvestForm({ venture, companyId, vaults, onDone }: { venture: S.Venture; companyId: string | undefined; vaults: Vaults; onDone: () => void }) {
  const names = useCompanyNames();
  const { portName } = useCatalog();
  const [amount, setAmount] = useState("");
  const act = useAction<S.Venture>(onDone);
  const merchant = venture.merchant_company_id;
  const { data: credit } = usePoll(merchant !== companyId ? () => kibbGet<S.CreditReport>("/v1/loan/credit", { company_id: merchant }) : null, 0, [merchant]);
  const a = crToPence(amount);
  const cash = vaults.cash(venture.banking_region);
  const why = firstProblem([
    [venture.status === "raising", "The venture is no longer raising capital."],
    [Date.parse(venture.raise_by) > Date.now(), "Its raise deadline has passed."],
    [a >= VENTURE.minStakePence, `Invest at least ${fmtCr(VENTURE.minStakePence)}.`],
    [cash === undefined || a <= cash, `Only ${fmtCr(cash)} in your ${regionName(venture.banking_region)} vault.`],
  ]);
  const bad = credit && (credit.loans_defaulted > 0 || credit.defaulted_open_loans > 0 || !!credit.bankrupt_at);

  function submit() {
    if (
      !confirm(
        `Invest ${fmtCr(a)} from your ${regionName(venture.banking_region)} vault in ${names.label(merchant)}'s venture to ${portName(venture.dest_port_id)}? At settlement you get your capital back plus your share of ${fmtBps(venture.investor_share_bps)} of the profit (after 2% stamp duty), or your share of a loss. If the ship is lost, only your part of the cash never spent comes back.${bad ? "\n\nThe merchant's credit record shows defaults." : ""}`,
      )
    )
      return;
    void act.run(() => kibbPost<S.Venture>("/v1/venture/invest", { venture_id: venture.id, amount_pence: a }));
  }

  return (
    <div className="space-y-2">
      <Field label="Invest (Cr)">
        <div className="flex gap-2">
          <Input type="number" min={VENTURE.minStakePence / 100} step={0.01} value={amount} onChange={(e) => setAmount(e.target.value)} />
          <Button disabled={!!why || act.busy} onClick={submit}>
            {act.busy ? "Investing…" : "Invest"}
          </Button>
        </div>
      </Field>
      <CashLine region={venture.banking_region} cash={cash} need={a} />
      {credit && (
        <p className={`text-xs ${bad ? "text-destructive" : "text-muted-foreground"}`}>
          Merchant&apos;s record: {credit.loans_repaid} loans repaid, {credit.loans_defaulted} defaulted{credit.bankrupt_at ? ", went bankrupt" : ""}.
        </p>
      )}
      <ErrorNote error={act.error ?? (amount ? why : null)} />
    </div>
  );
}

function TradeForm({
  venture,
  side,
  ship,
  vaults,
  onDone,
}: {
  venture: S.Venture;
  side: "buy" | "sell";
  ship: ShipResult | undefined;
  vaults: Vaults;
  onDone: () => void;
}) {
  const { goodName } = useCatalog();
  const [good, setGood] = useState(side === "sell" ? (venture.cargo[0]?.commodity_id ?? "") : "");
  const [qty, setQty] = useState("");
  const [price, setPrice] = useState("");
  const act = useAction<S.Venture>(onDone);
  const port = side === "buy" ? venture.origin_port_id : venture.dest_port_id;
  const best = useBest(port, good, side === "buy" ? "ask" : "bid");
  const q = num(qty);
  const limit = crToPence(price);
  const aboard = venture.cargo.find((c) => c.commodity_id === good)?.tons ?? 0;
  const free = ship ? ship.effective_hold_capacity_tons - ship.cargo_used_tons : undefined;
  const spend = Number.isFinite(q) && Number.isFinite(limit) ? Math.round(q * limit) : NaN;
  const cash = vaults.cash(venture.banking_region);
  // The investors' money never buys the merchant's own goods (guide 3.13.5): venture/buy is refused (409) while an ask of ours
  // rests at or under the limit for that good at the origin. A linked company's asks count too, but aren't ours to read.
  const { data: ownAsks } = usePoll(
    side === "buy" && good ? () => kibbGet<S.OrderBook[]>("/v1/market/orders", { port_id: port, commodity_id: good, side: "ask", limit: 200 }).then((rows) => ({ good, rows })) : null,
    30_000,
    [side, port, good],
  );
  const blocking = ownAsks && ownAsks.good === good && limit > 0 ? ownAsks.rows.filter((o) => o.commodity_id === good && o.price_pence <= limit) : [];
  const why = firstProblem([
    [!!good, "Choose a good."],
    [q > 0, "Enter the tons."],
    [limit > 0, side === "buy" ? "Enter the most you'll pay per ton." : "Enter the least you'll take per ton."],
    [side === "buy" || q <= aboard, `The venture has ${fmtTons(aboard, 2)} of it aboard.`],
    [side === "sell" || free === undefined || q <= free, `Only ${fmtTons(free ?? 0)} free in the hold.`],
    [
      blocking.length === 0,
      `You have an ask for ${goodName(good)} resting here at ${fmtCr(Math.min(...blocking.map((o) => o.price_pence)), 2)}/t, at or under your limit: the investors' money never buys your own goods, so the game refuses this. Cancel the ask (Market page) or set a lower limit.`,
    ],
  ]);

  function submit() {
    const msg =
      side === "buy"
        ? `Buy up to ${fmtTons(q, 2)} ${goodName(good)} at no more than ${fmtCr(limit, 2)}/t into the venture's ship (an IOC paid from your ${regionName(venture.banking_region)} vault and reimbursed from the venture at once)? The venture's tons can't be sold, unloaded or delivered except through it.`
        : `Sell up to ${fmtTons(q, 2)} ${goodName(good)} at no less than ${fmtCr(limit, 2)}/t from the venture (an IOC; the proceeds go into the venture)?`;
    if (!confirm(msg)) return;
    void act.run(() =>
      kibbPost<S.Venture>(`/v1/venture/${side}`, { venture_id: venture.id, commodity_id: good, quantity: q, limit_price_pence: limit }),
    );
  }

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Good">
          {side === "sell" ? (
            <NativeSelect value={good} onChange={(e) => setGood(e.target.value)}>
              <option value="">{venture.cargo.length ? "Choose…" : "Nothing aboard"}</option>
              {venture.cargo.map((c) => (
                <option key={c.commodity_id} value={c.commodity_id}>
                  {goodName(c.commodity_id)} · {fmtTons(c.tons, 2)}
                </option>
              ))}
            </NativeSelect>
          ) : (
            <GoodSelect value={good} onChange={setGood} placeholder="Choose…" />
          )}
        </Field>
        <Field label="Tons">
          <Input type="number" min={0} step="any" value={qty} onChange={(e) => setQty(e.target.value)} />
        </Field>
        <Field label={side === "buy" ? "Max price (Cr/t)" : "Min price (Cr/t)"}>
          <Input type="number" min={0.01} step={0.01} value={price} onChange={(e) => setPrice(e.target.value)} />
        </Field>
      </div>
      <p className="text-muted-foreground text-xs">
        {good
          ? best
            ? `Best ${side === "buy" ? "ask" : "bid"} here: ${fmtCr(best.price_pence, 2)}/t for ${fmtTons(best.quantity)}.`
            : `No ${side === "buy" ? "ask" : "bid"} seen here for it.`
          : ""}
        {side === "buy" && free !== undefined && ` ${fmtTons(free)} free in the hold.`}
        {side === "buy" && Number.isFinite(spend) && spend > 0 && ` Up to ${fmtCr(spend)} (venture cash ${fmtCr(venture.cash_pence)}).`}
      </p>
      {side === "buy" && Number.isFinite(spend) && spend > venture.cash_pence && (
        <WarnBox>At that limit the buy could cost more than the {fmtCr(venture.cash_pence)} the venture holds.</WarnBox>
      )}
      {side === "buy" && <CashLine region={venture.banking_region} cash={cash} need={spend} />}
      {side === "buy" && (
        <p className="text-muted-foreground text-xs">
          The investors&apos; money never buys your own goods: the buy is refused while an ask from you, or a company linked to you, rests here at or under your
          limit for this good.
        </p>
      )}
      <ErrorNote error={act.error ?? (qty || price || blocking.length ? why : null)} />
      {act.result && (
        <p className="text-sm">
          Venture cash {fmtCr(act.result.cash_pence)}; aboard: {act.result.cargo.map((c) => `${fmtTons(c.tons, 2)} ${goodName(c.commodity_id)}`).join(", ") || "nothing"}.
        </p>
      )}
      <Button className="w-full" disabled={!!why || act.busy} onClick={submit}>
        {act.busy ? (side === "buy" ? "Buying…" : "Selling…") : side === "buy" ? "Buy into the venture" : "Sell from the venture"}
      </Button>
    </div>
  );
}

function VentureDetail({
  venture,
  companyId,
  ships,
  vaults,
  onDone,
}: {
  venture: S.Venture;
  companyId: string | undefined;
  ships: ShipResult[] | undefined;
  vaults: Vaults;
  onDone: () => void;
}) {
  const { portName, goodName } = useCatalog();
  const act = useAction<S.Venture>(onDone);
  const merchant = venture.merchant_company_id === companyId;
  const ship = ships?.find((r) => r.ship.id === venture.ship_id);
  const stake = venture.stakes.find((s) => s.investor_company_id === companyId);
  const atDest = venture.status === "arrived";

  function settle() {
    const msg =
      venture.status === "raising"
        ? `Cancel this venture before it sails? Its unspent cash goes back to the investors, and venture cargo aboard is sold into ${portName(venture.origin_port_id)}'s bids (no lower than half the Crown merchants' bid).`
        : `Settle the venture now? Venture cargo still aboard is sold into ${portName(venture.dest_port_id)}'s bids (no lower than half the Crown merchants' bid), then the 2% stamp duty, the investors and you are paid. It settles itself a game day after arrival.`;
    if (!confirm(msg)) return;
    void act.run(() => kibbPost<S.Venture>("/v1/venture/settle", { venture_id: venture.id }));
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <VentureStatus status={venture.status} />
        <span className="font-medium">
          {portName(venture.origin_port_id)} → {portName(venture.dest_port_id)}
        </span>
      </div>
      <KV
        rows={[
          ["Merchant", <CompanyLabel key="m" id={venture.merchant_company_id} companyId={companyId} />],
          ["Ship", ship ? <Link key="s" href={`/fleet/${ship.ship.id}`} className="hover:underline">{ship.ship.name}</Link> : shortId(venture.ship_id)],
          ["Region", <span key="r" className="capitalize">{regionName(venture.banking_region)}</span>],
          ["Investors' share of profit", fmtBps(venture.investor_share_bps)],
          ["Raise by", `${fmtDateTime(venture.raise_by)} (${fmtIn(venture.raise_by)})`],
          ["On the Exchange", venture.unlisted ? "no: unlisted, quay only" : "yes"],
          ["Capital raised", fmtCr(venture.capital_pence)],
          ["Cash held", fmtCr(venture.cash_pence)],
          ["Spent on cargo", fmtCr(venture.spent_pence)],
          ["Proceeds", fmtCr(venture.proceeds_pence)],
          ...(venture.closed_at
            ? ([
                ["Stamp duty", fmtCr(venture.stamp_duty_pence)],
                ["Merchant's share", fmtCr(venture.merchant_share_pence)],
              ] as Array<[string, string]>)
            : []),
          ["Aboard", venture.cargo.map((c) => `${fmtTons(c.tons, 2)} ${goodName(c.commodity_id)}`).join(", ") || "nothing"],
          ...(stake ? ([["Your stake", `${fmtCr(stake.capital_pence)}${stake.payout_pence ? `, paid ${fmtCr(stake.payout_pence)}` : ""}`]] as Array<[string, string]>) : []),
        ]}
      />
      {venture.stakes.length > 0 && (
        <div className="space-y-1">
          <Table head={["Investor", "Capital", "Share", "Payout"]}>
            {venture.stakes.map((s) => (
              <tr key={s.investor_company_id}>
                <td>
                  <CompanyLabel id={s.investor_company_id} companyId={companyId} />
                </td>
                <td className="tabular-nums">{fmtCr(s.capital_pence)}</td>
                <td className="tabular-nums" title="Of the capital raised: the investors' share of the profit (or loss) is split pro rata">
                  {venture.capital_pence > 0 ? `${((s.capital_pence / venture.capital_pence) * 100).toLocaleString("en-GB", { maximumFractionDigits: 1 })}%` : "—"}
                </td>
                <td className="tabular-nums">{s.payout_pence ? fmtCr(s.payout_pence) : "—"}</td>
              </tr>
            ))}
          </Table>
          {!venture.unlisted && (
            <p className="text-muted-foreground text-xs">
              An investor shown only by id may be the Merchant Adventurers, who put a modest, capped stake late in the raise of a generous venture on the
              Exchange.
            </p>
          )}
        </div>
      )}
      {venture.status === "raising" && <InvestForm venture={venture} companyId={companyId} vaults={vaults} onDone={onDone} />}
      {merchant && venture.status === "raising" && (
        <>
          <h3 className="font-medium text-muted-foreground text-xs">Buy cargo at {portName(venture.origin_port_id)}</h3>
          <TradeForm key={`b-${venture.id}`} venture={venture} side="buy" ship={ship} vaults={vaults} onDone={onDone} />
          <p className="text-muted-foreground text-xs">
            Then sail the ship alone, only to {portName(venture.dest_port_id)}, before the raise deadline (
            <Link href={`/fleet/${venture.ship_id}`} className="text-primary hover:underline">
              ship page
            </Link>
            ). A venture that never sails is cancelled and its unspent cash returned.
          </p>
        </>
      )}
      {merchant && venture.status === "sailing" && <p className="text-muted-foreground text-sm">At sea to {portName(venture.dest_port_id)}: sell and settle once it arrives.</p>}
      {merchant && atDest && (
        <>
          <h3 className="font-medium text-muted-foreground text-xs">Sell at {portName(venture.dest_port_id)}</h3>
          <TradeForm key={`s-${venture.id}`} venture={venture} side="sell" ship={ship} vaults={vaults} onDone={onDone} />
        </>
      )}
      {merchant && (venture.status === "raising" || atDest) && (
        <Button variant={venture.status === "raising" ? "destructive" : "default"} className="w-full" disabled={act.busy} onClick={settle}>
          {act.busy ? "Settling…" : venture.status === "raising" ? "Cancel the venture" : "Settle now"}
        </Button>
      )}
      <ErrorNote error={act.error} />
    </div>
  );
}

function OpenVenture({
  ships,
  pledged,
  fleet,
  maxPhase,
  onDone,
}: {
  ships: ShipResult[] | undefined;
  pledged: ReturnType<typeof usePledgedShips>;
  fleet: ReturnType<typeof useFleetFinance>;
  maxPhase: number | undefined;
  onDone: () => void;
}) {
  const { portName } = useCatalog();
  const regionOf = useRegionOf();
  const [shipId, setShipId] = useState("");
  const [dest, setDest] = useState("");
  const [share, setShare] = useState("50");
  const [hours, setHours] = useState(String(VENTURE.raiseHoursDefault));
  const [unlisted, setUnlisted] = useState(false);
  const [override, setOverride] = useState(false);
  const act = useAction<S.Venture>(onDone);
  const ship = ships?.find((r) => r.ship.id === shipId);
  const origin = ship?.ship.current_port_id ?? "";
  const bps = Math.round(num(share) * 100);
  const h = num(hours);
  const onAutopilot = !!shipId && fleet.ships.has(shipId);
  const why = firstProblem([
    [!!ship, "Choose a ship lying in port."],
    [!pledged.byShip.has(shipId), "That ship is under a lender's lien: it can't carry a venture until repaid."],
    [!ship?.ship.convoy_id, "That ship is in a convoy."],
    [!!dest && dest !== origin, "Choose a destination other than where it lies."],
    [bps >= VENTURE.shareMinBps && bps <= VENTURE.shareMaxBps, `Investors' share: ${VENTURE.shareMinBps / 100}% to ${VENTURE.shareMaxBps / 100}%.`],
    [Number.isInteger(h) && h >= 1 && h <= VENTURE.raiseHoursMax, `Raise for 1 to ${VENTURE.raiseHoursMax} game hours.`],
    [!onAutopilot || override, "The autopilot sails this ship."],
  ]);

  function submit() {
    if (
      !confirm(
        `Open a venture on ${ship?.ship.name} from ${portName(origin)} to ${portName(dest)}, offering investors ${bps / 100}% of the profit after 2% stamp duty, raising for ${h} game hours?\n\nIts capital buys cargo only into this ship here. The ship may then sail only to ${portName(dest)}, alone, before the deadline, and can't sail again before settling.${unlisted ? " Unlisted: only companies with quay presence there see it, not the Exchange." : " It is posted on the Exchange (route, share, deadline and capital raised, never its cargo)."}`,
      )
    )
      return;
    void act.run(() =>
      kibbPost<S.Venture>("/v1/venture/open", { ship_id: shipId, dest_port_id: dest, investor_share_bps: bps, raise_game_hours: h, ...(unlisted ? { unlisted: true } : {}) }),
    );
  }

  return (
    <div className="space-y-3">
      <Field label="Ship (lying at the origin)">
        <ShipSelect
          ships={ships}
          value={shipId}
          onChange={(v) => {
            setShipId(v);
            setOverride(false);
          }}
          placeholder="Choose a ship in port…"
          filter={(r) => AT_PORT.has(r.ship.status) && !r.ship.convoy_id && !pledged.byShip.has(r.ship.id)}
        />
      </Field>
      {onAutopilot && (
        <>
          <WarnBox>
            The fleet autopilot sails this ship and knows nothing of ventures: it would try to load and sail it on its own plans. Stop the autopilot, or take the
            ship off it, before opening a venture on it.
          </WarnBox>
          <Checkbox checked={override} onChange={setOverride}>
            I know, open it anyway
          </Checkbox>
        </>
      )}
      <Field label="Destination">
        <PortSelect value={dest} onChange={setDest} placeholder="Choose a port…" maxPhase={maxPhase} filter={(p) => p !== origin} />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Investors' share of profit (%)">
          <Input type="number" min={25} max={90} step={0.01} value={share} onChange={(e) => setShare(e.target.value)} />
        </Field>
        <Field label="Raise for (game hours)">
          <Input type="number" min={1} max={VENTURE.raiseHoursMax} step={1} value={hours} onChange={(e) => setHours(e.target.value)} />
        </Field>
      </div>
      <Checkbox checked={unlisted} onChange={setUnlisted}>
        <span className="text-xs">
          Unlisted: keep it off the Exchange, so only companies with quay presence at the origin see it (the Merchant Adventurers then never co-invest)
        </span>
      </Checkbox>
      <p className="text-muted-foreground text-xs">
        Capital is raised in {origin ? `the ${regionName(regionOf(origin))} region` : "the origin's region"}. Profit: investors get their capital plus their
        share pro rata, you the rest; a loss is shared pro rata; if the ship is lost only unspent cash comes back.
      </p>
      <p className="text-muted-foreground text-xs">
        Backer of last resort: on the Exchange, a venture giving investors a large share of the profit draws a modest, capped stake from the region&apos;s
        Merchant Adventurers late in its raise, if your credit record shows no default and no walk-away, and never into two of your open ventures at once.
        Players who invest earlier, or more, take the rest of the investors&apos; share.
      </p>
      <ErrorNote error={act.error ?? (shipId ? why : null)} />
      {act.result && <p className="text-sm">Opened: raising until {fmtDateTime(act.result.raise_by)}.</p>}
      <Button className="w-full" disabled={!!why || act.busy} onClick={submit}>
        {act.busy ? "Opening…" : "Open venture"}
      </Button>
    </div>
  );
}

export default function VenturesPage() {
  useCompanyDirectory();
  const { portName } = useCatalog();
  const companyId = useCompanyId();
  const ourIds = useOurCompanyIds();
  const { data: ships, reload: reloadShips } = useShips();
  const fleet = useFleetFinance();
  const vaults = useVaults();
  const pledged = usePledgedShips();
  const { data: clock } = usePoll(() => kibbGet<WorldClock>("/v1/world/clock"), 300_000);
  const [status, setStatus] = useState("");
  const { data: mine, error, reload } = usePoll(() => kibbGet<S.Venture[]>("/v1/venture/list", { status }), 20_000, [status]);
  const [port, setPort] = useState("");
  const { data: raising, error: raisingError, reload: reloadRaising } = usePoll(
    port ? () => kibbGet<S.Venture[]>("/v1/venture/list", { port_id: port }) : null,
    30_000,
    [port],
  );
  // With no port chosen: every venture raising on the Exchange (guide 3.21), world-wide; picking one opens its origin's list.
  const { data: listed, error: listedError } = usePoll(port ? null : () => kibbGet<S.ExchangePage>("/v1/exchange", { kind: "venture", limit: 200 }), 60_000);
  // The venture co-investor's desk (guide 3.13.5, 3.16): what the Merchant Adventurers put in, beside what players invested.
  const { board } = useDeskBoard(30);
  const coInvestor = board?.desks.find((d) => d.desk === "ventures");
  useLearnCompanies([...(mine ?? []), ...(raising ?? [])].map((v) => [v.merchant_company_id, v.merchant_name] as [string, string]));
  const [selected, setSelected] = useState<string | null>(null);
  const venture = [...(mine ?? []), ...(raising ?? [])].find((v) => v.id === selected);
  const refresh = () => {
    void reload();
    void reloadRaising();
    void reloadShips();
    void vaults.reload();
  };
  const shipName = (id: string) => ships?.find((r) => r.ship.id === id)?.ship.name;
  const portsWithShips = new Set((ships ?? []).filter((r) => AT_PORT.has(r.ship.status)).map((r) => r.ship.current_port_id ?? ""));
  const open = (mine ?? []).filter((v) => ["raising", "sailing", "arrived"].includes(v.status));
  const staked = open.reduce((n, v) => n + (v.stakes.find((s) => s.investor_company_id === companyId)?.capital_pence ?? 0), 0);

  const row = (v: S.Venture) => {
    const merchant = v.merchant_company_id === companyId;
    const stake = v.stakes.find((s) => s.investor_company_id === companyId);
    return (
      <tr key={v.id} className={v.id === selected ? "bg-accent" : undefined}>
        <td>
          <CompanyLabel id={v.merchant_company_id} companyId={companyId} ourIds={ourIds} />
        </td>
        <td>{merchant ? (shipName(v.ship_id) ?? shortId(v.ship_id)) : <span className="font-mono text-xs">{shortId(v.ship_id)}</span>}</td>
        <td className="whitespace-nowrap text-xs">
          {portName(v.origin_port_id)} → {portName(v.dest_port_id)}
          {v.unlisted && (
            <Badge variant="outline" size="sm" className="ml-1.5" title="Kept off the Exchange: only companies with quay presence at the origin see it">
              quay only
            </Badge>
          )}
        </td>
        <td>
          <VentureStatus status={v.status} />
        </td>
        <td className="tabular-nums">{fmtBps(v.investor_share_bps)}</td>
        <td className="tabular-nums">{fmtCr(v.capital_pence)}</td>
        <td className="tabular-nums">{stake ? fmtCr(stake.capital_pence) : "—"}</td>
        <td className="whitespace-nowrap text-xs">{v.status === "raising" ? `raise by ${fmtIn(v.raise_by)}` : v.closed_at ? fmtDateTime(v.closed_at) : v.arrived_at ? `arrived ${fmtDateTime(v.arrived_at)}` : "—"}</td>
        <td className="text-right">
          <Button size="sm" variant="outline" onClick={() => setSelected(v.id)}>
            {merchant ? "Manage" : v.status === "raising" ? "Invest" : "Details"}
          </Button>
        </td>
      </tr>
    );
  };
  const head = ["Merchant", "Ship", "Voyage", "Status", "Investors", "Capital", "Your stake", "When", ""];

  return (
    <div className="space-y-5 pb-8 sm:space-y-6">
      <PageHeader
        title="Ventures"
        subtitle="A commenda: investors fund one voyage's cargo and share its profit. The merchant buys into its own ship at the origin, sails to the declared port and settles there."
      />
      <Metrics
        className="sm:grid-cols-4 xl:grid-cols-4"
        items={[
          { label: "Open ventures", value: mine ? String(open.length) : "…" },
          { label: "Running as merchant", value: mine ? String(open.filter((v) => v.merchant_company_id === companyId).length) : "…" },
          { label: "Your stakes", value: mine ? fmtCr(staked) : "…", hint: "capital in open ventures" },
          { label: "Stamp duty", value: fmtBps(VENTURE.stampDutyBps), hint: "of the profit, to the Crown" },
        ]}
      />
      <div className="grid items-start gap-4 xl:grid-cols-3">
        <div className="space-y-4 xl:col-span-2">
          <Panel
            title="Your ventures"
            action={
              <div className="w-full sm:w-36">
                <NativeSelect value={status} onChange={(e) => setStatus(e.target.value)}>
                  <option value="">Any status</option>
                  {STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </NativeSelect>
              </div>
            }
          >
            <ErrorNote error={error} />
            {!mine ? !error && <Loading /> : mine.length === 0 ? <Empty>No ventures you run or hold a stake in.</Empty> : <Table head={head}>{mine.map(row)}</Table>}
          </Panel>
          <Panel
            title={port ? `Raising capital at ${portName(port)}` : "Raising capital on the Exchange"}
            action={
              <div className="w-full sm:w-48">
                <PortSelect value={port} onChange={setPort} placeholder="Exchange (any port)" />
              </div>
            }
          >
            <ErrorNote error={port ? raisingError : listedError} />
            {!port ? (
              <>
                {!listed ? (
                  !listedError && <Loading />
                ) : listed.entries.length === 0 ? (
                  <Empty>No ventures raising on the Exchange.</Empty>
                ) : (
                  <Table head={["Voyage", "Investors", "Raised", "Raises", "Region", ""]}>
                    {listed.entries.map((e) => {
                      const d = e.details as S.VentureDetails;
                      return (
                        <tr key={e.id}>
                          <td className="whitespace-nowrap text-xs">
                            {portName(d.origin_port_id)} → {portName(d.dest_port_id)}
                            {e.note && <div className="max-w-64 whitespace-normal text-muted-foreground">“{e.note}”</div>}
                          </td>
                          <td className="tabular-nums">{fmtBps(d.investor_share_bps)}</td>
                          <td className="tabular-nums">{fmtCr(d.capital_raised_pence)}</td>
                          <td className="whitespace-nowrap text-xs">{fmtIn(d.raise_by)}</td>
                          <td className="capitalize">{regionName(e.banking_region)}</td>
                          <td className="text-right">
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => {
                                setPort(d.origin_port_id);
                                setSelected(e.id);
                              }}
                            >
                              View
                            </Button>
                          </td>
                        </tr>
                      );
                    })}
                  </Table>
                )}
                <p className="mt-3 text-muted-foreground text-xs">
                  Every venture raising on the Exchange, world-wide (unlisted ones are seen only at their origin: choose the port). Choose a port to see the ventures
                  raising there
                  {portsWithShips.size > 0 ? ` (your ships lie at ${[...portsWithShips].filter(Boolean).map(portName).join(", ")})` : ""}.
                </p>
              </>
            ) : !raising ? (
              !raisingError && <Loading />
            ) : raising.length === 0 ? (
              <Empty>No ventures raising at {portName(port)}.</Empty>
            ) : (
              <Table head={head}>{raising.map(row)}</Table>
            )}
          </Panel>
        </div>
        <div className="space-y-4">
          <Panel title={venture ? "Venture" : "Open a venture"} action={venture && <Button size="sm" variant="ghost" onClick={() => setSelected(null)}>Close</Button>}>
            {venture ? (
              <VentureDetail key={venture.id} venture={venture} companyId={companyId} ships={ships} vaults={vaults} onDone={refresh} />
            ) : (
              <OpenVenture ships={ships} pledged={pledged} fleet={fleet} maxPhase={clock?.unlocked_phase} onDone={refresh} />
            )}
          </Panel>
          <Panel title="How ventures work">
            <div className="space-y-2 text-muted-foreground text-sm">
              <p>
                Open on your ship lying at the origin (not in a convoy, not liened), offering investors 25% to 90% of the profit after the Crown&apos;s 2% stamp duty.
                It is posted on the Exchange (never its cargo) unless you open it unlisted, which keeps it to the origin&apos;s quay.
              </p>
              <p>Anyone may invest, at least {fmtCr(VENTURE.minStakePence)}, the merchant included. The capital buys cargo only into that ship at the origin.</p>
              <p>
                The ship sails alone, only to the declared port, before the raise deadline. There the merchant sells and settles (automatic a game day after arrival;
                leftovers go into the bids at no less than half the Crown merchants&apos; bid). It can&apos;t sail again before settling.
              </p>
              <p>
                The investors&apos; money never buys the merchant&apos;s own goods: a venture buy is refused while an ask from the merchant, or a company linked to
                it, rests at or under its limit for that good there.
              </p>
              <p>
                The Merchant Adventurers co-invest as a backer of last resort: a modest, capped stake late in the raise of a venture on the Exchange that gives
                investors a large share, if the merchant&apos;s credit record shows no default or walk-away, and never in two open ventures of one merchant.
                {coInvestor &&
                  ` Last ${board?.window_game_days ?? 30} game days: they put ${fmtCr(coInvestor.desk_bought.value_pence)} into ${coInvestor.desk_bought.count} venture${coInvestor.desk_bought.count === 1 ? "" : "s"}; players invested ${fmtCr(coInvestor.player_trades.value_pence)} in ${coInvestor.player_trades.count} of each other's.`}{" "}
                <Link href="/desks" className="hover:underline">
                  NPC desks
                </Link>
              </p>
              <p>Stakes count in your net worth, so the wealth levy (net worth over 1,000,000 Cr) applies to them as to cash.</p>
            </div>
          </Panel>
        </div>
      </div>
    </div>
  );
}
