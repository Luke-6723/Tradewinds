"use client";

import { useState } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Empty, ErrorNote, KV, Loading, Metrics, NativeSelect, PageHeader, Panel, Table } from "@/components/kibb/bits";
import {
  BANK,
  COLLATERAL_LABEL,
  CashLine,
  CompanyLabel,
  CreditRecordView,
  LINE,
  LoanStatusBadge,
  RateText,
  WarnBox,
  bestRatesText,
  crToPence,
  firstProblem,
  lineRateText,
  loansOf,
  num,
  regionName,
  shortId,
  useCompanyDirectory,
  useCompanyNames,
  useFleetFinance,
  useLearnCompanies,
  useVaults,
} from "@/components/kibb/finance-common";
import { Checkbox, useCompanyId, useOurCompanyIds } from "@/components/kibb/naval-common";
import { Field, REGIONS, RegionSelect } from "@/components/kibb/pickers";
import { useAction } from "@/hooks/use-action";
import { usePoll } from "@/hooks/use-poll";
import { kibbGet, kibbPost } from "@/lib/kibb/browser";
import { goldsmithsAnnualBps } from "@/lib/kibb/fleet/finance";
import { fmtAgo, fmtBps, fmtCr, fmtDateTime, fmtGameHours } from "@/lib/kibb/format";
import type * as S from "@/lib/kibb/schema";

type Vaults = ReturnType<typeof useVaults>;
type Rates = S.RegionalAchRateResult[] | undefined;

/** A bank's exchange schedule (region → bps on withdrawals paid there) in words, cheapest first. */
function feesText(fees: Record<string, number> | null | undefined): string {
  const list = Object.entries(fees ?? {}).sort((a, b) => a[1] - b[1]);
  return list.length ? list.map(([r, bps]) => `${regionName(r)} ${fmtBps(bps)}`).join(", ") : "none offered";
}

/** What a withdrawal may take: the balance above what is already asked for and above a loan's lock (guide 3.13.4). */
const freeBalance = (d: S.DepositResult) => Math.max(0, d.balance_pence - d.pending_withdrawal_pence - d.pledged_pence);

/** The Crown's remittance fee from one region to another (bps), if listed. */
const remitBps = (rates: Rates, from: string, to: string) => rates?.find((r) => r.from_region === from && r.to_region === to)?.fee_bps;

/**
 * Routes into `to` where a bank's posted fee there is strictly below the Crown's (guide 3.12 bank drafts): every remittance on
 * them goes to the cheapest such bank while it has the cash in its `to` vault. Client discounts aren't public, so posted fees.
 */
const undercutFrom = (rates: Rates, to: string, feeBps: number) =>
  (rates ?? []).filter((r) => r.to_region === to && r.from_region !== to && feeBps < r.fee_bps).sort((a, b) => b.fee_bps - a.fee_bps);

/** A bank's exchange schedule, cheapest first, each region marked where it undercuts the Crown's remittance fee into it. */
function ExchangeFees({ bank, rates }: { bank: S.BankResult; rates: Rates }) {
  const list = Object.entries(bank.exchange_fee_bps ?? {}).sort((a, b) => a[1] - b[1]);
  if (!list.length) return <span className="text-muted-foreground">—</span>;
  const carries = bank.status === "open" && !bank.failed_at;
  return (
    <span className="flex flex-col gap-0.5">
      {list.map(([r, bps]) => {
        const under = carries ? undercutFrom(rates, r, bps) : [];
        return (
          <span key={r} className="whitespace-nowrap">
            <span className="capitalize">{regionName(r)}</span> {fmtBps(bps)}
            {under.length > 0 && (
              <Badge
                variant="success"
                size="sm"
                className="ml-1"
                title={`Under the Crown's fee into ${regionName(r)} from ${under.map((x) => `${regionName(x.from_region)} (${fmtBps(x.fee_bps)})`).join(", ")}: remittances on those routes go to the cheapest such bank as drafts while it has the cash in its ${regionName(r)} vault.`}
              >
                under Crown
              </Badge>
            )}
          </span>
        );
      })}
    </span>
  );
}

/** Reserves against the Crown's 20% requirement, and anything overdue: the signs of a bank in trouble. */
function health(b: S.BankResult): { label: string; variant: "success" | "warning" | "error" | "outline" } {
  if (b.failed_at) return { label: "failed", variant: "error" };
  if (b.overdue_withdrawals_pence > 0) return { label: "overdue", variant: "error" };
  if (b.status === "winding_down") return { label: "winding down", variant: "warning" };
  if (b.status === "closed") return { label: "closed", variant: "outline" };
  if (b.reserves_pence < b.required_reserve_pence) return { label: "below reserve", variant: "warning" };
  return { label: "sound", variant: "success" };
}

function reserveRatio(b: S.BankResult): string {
  return b.deposits_pence > 0 ? `${Math.round((b.reserves_pence / b.deposits_pence) * 100)}%` : "—";
}

function BankStatus({ bankId }: { bankId: string }) {
  const { data: bank, error } = usePoll(() => kibbGet<S.BankResult>("/v1/bank/status", { company_id: bankId }), 30_000, [bankId]);
  const { data: credit, error: creditError } = usePoll(() => kibbGet<S.CreditReport>("/v1/loan/credit", { company_id: bankId }), 120_000, [bankId]);
  const b = bank?.company_id === bankId ? bank : undefined;
  if (!b) return error ? <ErrorNote error={error} /> : <Loading />;
  const h = health(b);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{b.name}</span>
        <Badge variant={h.variant} size="sm">{h.label}</Badge>
        {b.insured && <Badge variant="info" size="sm">insured</Badge>}
      </div>
      <KV
        rows={[
          ["Home region", <span key="r" className="capitalize">{regionName(b.home_region)}</span>],
          ["Chartered", fmtDateTime(b.chartered_at)],
          ["Demand rate", <RateText key="d" bps={b.demand_rate_bps} />],
          ["Notice rate", <span key="n"><RateText bps={b.notice_rate_bps} /> after {fmtGameHours(b.notice_game_hours)}</span>],
          ["Exchange into other regions", feesText(b.exchange_fee_bps)],
          ["Drafts carried", b.drafts_carried ? `${b.drafts_carried} (${fmtCr(b.draft_fees_pence)} in fees kept)` : "none"],
          ["Lending lines (best rate)", bestRatesText(b.lending_line_best_rates) || "none open"],
          ["Owes depositors", fmtCr(b.deposits_pence)],
          ["Reserves (vault cash)", `${fmtCr(b.reserves_pence)} (${reserveRatio(b)} of deposits)`],
          ["Crown requirement (20%)", fmtCr(b.required_reserve_pence)],
          ["Lent out and on offer", fmtCr(b.loans_out_pence)],
          ["Locked underwriting", fmtCr(b.underwriting_locked_pence)],
          ["Lending headroom", fmtCr(b.lending_headroom_pence)],
          ["Withdrawals overdue", <span key="o" className={b.overdue_withdrawals_pence > 0 ? "text-destructive" : undefined}>{fmtCr(b.overdue_withdrawals_pence)}</span>],
          ...(b.failed_at ? ([["Failed", fmtDateTime(b.failed_at)]] as Array<[string, string]>) : []),
        ]}
      />
      <div>
        <h3 className="mb-2 font-medium text-muted-foreground text-xs">Credit record</h3>
        <ErrorNote error={creditError} />
        {credit && credit.company_id === bankId ? <CreditRecordView report={credit} /> : !creditError && <Loading />}
      </div>
    </div>
  );
}

function DepositForm({ bank, own, vaults, onDone }: { bank: S.BankResult; own: boolean; vaults: Vaults; onDone: () => void }) {
  const [region, setRegion] = useState<string>(bank.home_region);
  const [amount, setAmount] = useState("");
  const [notice, setNotice] = useState(false);
  const act = useAction<S.DepositResult>(onDone);
  const a = crToPence(amount);
  const cash = vaults.cash(region);
  const h = health(bank);
  const why = firstProblem([
    [!own, "You can't deposit with your own bank."],
    [bank.status === "open" && !bank.failed_at, `The bank is ${bank.failed_at ? "failed" : bank.status.replace("_", " ")}: it takes no deposits.`],
    [a >= BANK.minDepositPence, `Deposit at least ${fmtCr(BANK.minDepositPence)}.`],
    [cash === undefined || a <= cash, `Only ${fmtCr(cash)} in your ${regionName(region)} vault.`],
  ]);

  function submit() {
    const risk = bank.insured
      ? `Insured: if it fails the Crown pays up to ${fmtCr(BANK.insuredCoverPence)} per player (capped per bank) on deposits ${BANK.insuredAfterDays}+ game days old.`
      : "Not insured: if it fails you are paid pro rata only as its loans come in.";
    if (
      !confirm(
        `Deposit ${fmtCr(a)} from your ${regionName(region)} vault with ${bank.name} ${notice ? `on notice (${bank.notice_rate_bps} bps a day, ${fmtGameHours(bank.notice_game_hours)} notice)` : `on demand (${bank.demand_rate_bps} bps a day)`}? ${risk}`,
      )
    )
      return;
    void act.run(() => kibbPost<S.DepositResult>("/v1/bank/deposit", { bank_company_id: bank.company_id, banking_region: region, amount_pence: a, notice }));
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{bank.name}</span>
        <Badge variant={h.variant} size="sm">{h.label}</Badge>
        {bank.insured ? <Badge variant="info" size="sm">insured</Badge> : <Badge variant="outline" size="sm">uninsured</Badge>}
      </div>
      {(h.variant === "error" || h.variant === "warning") && (
        <WarnBox tone={h.variant === "error" ? "error" : "warning"}>
          {bank.overdue_withdrawals_pence > 0
            ? `${fmtCr(bank.overdue_withdrawals_pence)} of withdrawals are overdue: a bank that leaves one unpaid for a game day fails.`
            : bank.reserves_pence < bank.required_reserve_pence
              ? `Its reserves (${fmtCr(bank.reserves_pence)}) are below the Crown's 20% requirement (${fmtCr(bank.required_reserve_pence)}).`
              : `The bank is ${h.label}.`}
        </WarnBox>
      )}
      <div className="grid grid-cols-2 gap-3">
        <Field label="Paid from your vault in">
          <RegionSelect value={region} onChange={setRegion} />
        </Field>
        <Field label="Amount (Cr)">
          <Input type="number" min={BANK.minDepositPence / 100} step={0.01} value={amount} onChange={(e) => setAmount(e.target.value)} />
        </Field>
      </div>
      <Checkbox checked={notice} onChange={setNotice}>
        Notice deposit: {bank.notice_rate_bps} bps a day, withdrawn after {fmtGameHours(bank.notice_game_hours)} (on demand: {bank.demand_rate_bps} bps)
      </Checkbox>
      <CashLine region={region} cash={cash} need={a} />
      <p className="text-muted-foreground text-xs">
        Interest is credited daily. Deposits count in your net worth, so the wealth levy applies to them as to cash. {bank.insured
          ? `The Crown's cover is at most ${fmtCr(BANK.insuredCoverPence)} per player, capped per bank, only on deposits ${BANK.insuredAfterDays}+ game days old, and never for a depositor that defaulted on a loan from this bank.`
          : "Uninsured: a failed bank pays depositors pro rata as its loans come in, after secured lenders."}
      </p>
      <ErrorNote error={act.error ?? (amount ? why : own ? why : null)} />
      {act.result && <p className="text-sm">Deposited: balance {fmtCr(act.result.balance_pence)} with {act.result.bank_name}.</p>}
      <Button className="w-full" disabled={!!why || act.busy} onClick={submit}>
        {act.busy ? "Depositing…" : "Deposit"}
      </Button>
    </div>
  );
}

function WithdrawForm({
  deposit,
  bank,
  rates,
  onDone,
  onClose,
}: {
  deposit: S.DepositResult;
  /** The bank, for its exchange schedule (undefined while the list loads). */
  bank: S.BankResult | undefined;
  rates: Rates;
  onDone: () => void;
  onClose: () => void;
}) {
  const [amount, setAmount] = useState("");
  const [to, setTo] = useState("");
  const act = useAction<S.DepositResult>(onDone);
  const free = freeBalance(deposit);
  // Everything: the whole balance when nothing is asked for or locked, else what is free of them.
  const locked = deposit.pending_withdrawal_pence > 0 || deposit.pledged_pence > 0;
  const all = amount.trim() === "";
  const a = all ? free : crToPence(amount);
  const home = deposit.banking_region;
  const elsewhere = !!to && to !== home;
  // The bank's posted fee into that region less our client discount, never below 0, fixed when asked for.
  const posted = elsewhere ? bank?.exchange_fee_bps?.[to] : undefined;
  const feeBps = posted !== undefined ? Math.max(0, posted - deposit.exchange_discount_bps) : undefined;
  const fee = feeBps !== undefined && a > 0 ? Math.round((a * feeBps) / 10_000) : undefined;
  const remit = elsewhere ? remitBps(rates, home, to) : undefined;
  const remitFee = remit !== undefined && a > 0 ? Math.round((a * remit) / 10_000) : undefined;
  const offered = Object.keys(bank?.exchange_fee_bps ?? {}).filter((r) => r !== home);
  const why = firstProblem([
    [free > 0, locked ? `Nothing is free to withdraw: ${fmtCr(deposit.pending_withdrawal_pence, 2)} already asked for, ${fmtCr(deposit.pledged_pence, 2)} locked by a loan.` : "Nothing left to withdraw."],
    [all || a > 0, "Enter an amount, or leave it empty to withdraw everything free."],
    [a <= free, `At most ${fmtCr(free, 2)} is free to withdraw (the balance less what is already asked for and any loan's lock).`],
    [!elsewhere || posted !== undefined, `${deposit.bank_name} doesn't pay withdrawals into ${regionName(to)}.`],
  ]);

  function submit() {
    const when =
      deposit.notice_game_hours > 0
        ? `A notice deposit is paid after its ${fmtGameHours(deposit.notice_game_hours)} notice.`
        : "Paid at once as far as the bank's cash reaches; the rest stays owed and falls due now.";
    const where = elsewhere
      ? ` Paid into your ${regionName(to)} vault less the bank's ${fmtBps(feeBps)} exchange fee (about ${fmtCr(fee, 2)}), fixed now even if it reprices before paying.`
      : ` Paid into your ${regionName(home)} vault, no fee.`;
    if (!confirm(`Withdraw ${all ? `everything free (${fmtCr(free, 2)})` : fmtCr(a, 2)} from ${deposit.bank_name}?${where} ${when}`)) return;
    void act.run(() =>
      kibbPost<S.DepositResult>("/v1/bank/withdraw", {
        deposit_id: deposit.id,
        ...(all && !locked ? {} : { amount_pence: a }),
        ...(elsewhere ? { to_region: to } : {}),
      }),
    );
  }

  return (
    <div className="space-y-3">
      <KV
        rows={[
          ["Bank", deposit.bank_name],
          ["Balance", fmtCr(deposit.balance_pence, 2)],
          ["Kind", deposit.notice_game_hours > 0 ? `notice (${fmtGameHours(deposit.notice_game_hours)})` : "on demand"],
          ["Already asked for", fmtCr(deposit.pending_withdrawal_pence, 2)],
          ...(deposit.pledged_pence > 0 ? ([["Locked by a loan", fmtCr(deposit.pledged_pence, 2)]] as Array<[string, string]>) : []),
          ["Free to withdraw", fmtCr(free, 2)],
          ...(deposit.exchange_discount_bps > 0 ? ([["Your exchange discount", fmtBps(deposit.exchange_discount_bps)]] as Array<[string, string]>) : []),
        ]}
      />
      <div className="grid grid-cols-2 gap-3">
        <Field label="Amount (Cr): empty withdraws all that is free">
          <Input type="number" min={0.01} step={0.01} value={amount} placeholder={(free / 100).toFixed(2)} onChange={(e) => setAmount(e.target.value)} />
        </Field>
        <Field label="Paid into">
          <NativeSelect value={to} onChange={(e) => setTo(e.target.value)}>
            <option value="">{regionName(home)} (its own region, free)</option>
            {offered.map((r) => (
              <option key={r} value={r}>
                {regionName(r)} ({fmtBps(Math.max(0, (bank?.exchange_fee_bps?.[r] ?? 0) - deposit.exchange_discount_bps))})
              </option>
            ))}
          </NativeSelect>
        </Field>
      </div>
      {elsewhere && posted !== undefined && (
        <p className="text-muted-foreground text-xs">
          The bank&apos;s exchange: {fmtBps(feeBps)}
          {deposit.exchange_discount_bps > 0 ? ` (${fmtBps(posted)} posted, less your ${fmtBps(deposit.exchange_discount_bps)} discount)` : ""}
          {fee !== undefined ? `, about ${fmtCr(fee, 2)}` : ""}. Remitting it yourself from {regionName(home)}:{" "}
          {remit === undefined ? "no Crown rate listed" : `${fmtBps(remit)}${remitFee !== undefined ? `, about ${fmtCr(remitFee, 2)}` : ""}`}
          {remit !== undefined && feeBps !== undefined ? (feeBps < remit ? ": the bank is cheaper." : feeBps > remit ? ": remitting is cheaper." : ": the same.") : "."}
        </p>
      )}
      {bank && offered.length === 0 && <p className="text-muted-foreground text-xs">{deposit.bank_name} offers no exchange: withdrawals are paid in {regionName(home)} only.</p>}
      <ErrorNote error={act.error ?? why} />
      {act.result && (
        <p className="text-sm">
          Balance {fmtCr(act.result.balance_pence, 2)}
          {act.result.pending_withdrawal_pence > 0 ? `; ${fmtCr(act.result.pending_withdrawal_pence, 2)} still to be paid` : ""}.
        </p>
      )}
      <div className="flex gap-2">
        <Button className="flex-1" disabled={!!why || act.busy} onClick={submit}>
          {act.busy ? "Withdrawing…" : "Withdraw"}
        </Button>
        <Button variant="outline" onClick={onClose}>
          Close
        </Button>
      </div>
    </div>
  );
}

function DepositsPanel({
  deposits,
  banks,
  rates,
  error,
  companyId,
  onDone,
}: {
  deposits: S.DepositResult[] | undefined;
  banks: S.BankResult[] | undefined;
  rates: Rates;
  error: Error | null;
  companyId: string | undefined;
  onDone: () => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const mine = (deposits ?? []).filter((d) => d.depositor_company_id === companyId);
  const deposit = mine.find((d) => d.id === selected);
  return (
    <div className="grid items-start gap-4 xl:grid-cols-3">
      <Panel title="Your deposits" className="xl:col-span-2">
        <ErrorNote error={error} />
        {!deposits ? (
          !error && <Loading />
        ) : mine.length === 0 ? (
          <Empty>No deposits.</Empty>
        ) : (
          <Table head={["Bank", "Region", "Balance", "Deposited", "Interest", "Rate", "Kind", "Pending", "Status", ""]}>
            {mine.map((d) => (
              <tr key={d.id} className={d.id === selected ? "bg-accent" : undefined}>
                <td>{d.bank_name}</td>
                <td className="capitalize">{regionName(d.banking_region)}</td>
                <td className="font-medium tabular-nums">{fmtCr(d.balance_pence)}</td>
                <td className="text-muted-foreground tabular-nums">{fmtCr(d.deposited_pence)}</td>
                <td className="tabular-nums">{fmtCr(d.interest_credited_pence)}</td>
                <td>
                  <RateText bps={d.effective_rate_bps || d.daily_rate_bps} />
                  {d.rate_bonus_bps > 0 && <div className="text-muted-foreground text-xs">+{d.rate_bonus_bps} client bonus</div>}
                </td>
                <td className="whitespace-nowrap text-xs">{d.notice_game_hours > 0 ? `notice ${fmtGameHours(d.notice_game_hours)}` : "demand"}</td>
                <td className="tabular-nums">{d.pending_withdrawal_pence > 0 ? fmtCr(d.pending_withdrawal_pence) : "—"}</td>
                <td>
                  <span className="inline-flex flex-wrap gap-1">
                    <Badge variant={d.status === "open" ? "secondary" : "outline"} size="sm">{d.status}</Badge>
                    {d.pledged_pence > 0 && <Badge variant="warning" size="sm" title="Locked by a loan this deposit secures: withdrawals may take only the balance above it">{fmtCr(d.pledged_pence)} locked</Badge>}
                    {d.set_off_pence > 0 && <Badge variant="error" size="sm">{fmtCr(d.set_off_pence)} set off</Badge>}
                    {d.exchange_fees_pence > 0 && <Badge variant="outline" size="sm">{fmtCr(d.exchange_fees_pence)} exchange fees</Badge>}
                    {d.written_off_pence > 0 && <Badge variant="error" size="sm">{fmtCr(d.written_off_pence)} written off</Badge>}
                    {d.insured_paid_pence > 0 && <Badge variant="info" size="sm">{fmtCr(d.insured_paid_pence)} from the Crown</Badge>}
                  </span>
                </td>
                <td className="text-right">
                  {d.status === "open" && (
                    <Button size="sm" variant="outline" onClick={() => setSelected(d.id)}>
                      Withdraw
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Panel>
      <Panel title="Withdraw">
        {deposit ? (
          <WithdrawForm
            key={deposit.id}
            deposit={deposit}
            bank={banks?.find((b) => b.company_id === deposit.bank_company_id)}
            rates={rates}
            onDone={onDone}
            onClose={() => setSelected(null)}
          />
        ) : (
          <p className="text-muted-foreground text-sm">
            Pick a deposit. A demand deposit is paid at once as far as the bank&apos;s cash reaches, the rest owed now; a notice deposit after its notice. A bank
            that leaves a withdrawal unpaid for a game day fails. A bank may pay a withdrawal into another region for its exchange fee: compare it with the
            Crown&apos;s remittance fee.
          </p>
        )}
      </Panel>
    </div>
  );
}

interface Terms {
  demand: string;
  notice: string;
  hours: string;
  insured: boolean;
  /** Exchange fee by region (bps typed in); empty: not offered. */
  fees: Record<string, string>;
}

const feesOf = (schedule: Record<string, number> | null | undefined): Record<string, string> =>
  Object.fromEntries(Object.entries(schedule ?? {}).map(([r, bps]) => [r, String(bps)]));

/** The schedule to send: each region with a fee typed in (`{}` offers none). */
const scheduleOf = (t: Terms): Record<string, number> =>
  Object.fromEntries(Object.entries(t.fees).filter(([, v]) => v.trim() !== "").map(([r, v]) => [r, num(v)]));

function termsProblem(t: Terms): string | null {
  const d = num(t.demand);
  const n = num(t.notice);
  const h = num(t.hours);
  const badFee = Object.entries(t.fees).find(([, v]) => v.trim() !== "" && !(Number.isInteger(num(v)) && num(v) >= 0 && num(v) <= BANK.exchangeFeeMaxBps));
  return firstProblem([
    [Number.isInteger(d) && d >= 0 && d <= BANK.rateMaxBps, `Demand rate: 0 to ${BANK.rateMaxBps} bps a game day.`],
    [Number.isInteger(n) && n >= 0 && n <= BANK.rateMaxBps, `Notice rate: 0 to ${BANK.rateMaxBps} bps a game day.`],
    [Number.isInteger(h) && h >= 1 && h <= BANK.noticeHoursMax, `Notice: 1 to ${BANK.noticeHoursMax} game hours.`],
    [!badFee, `Exchange fee into ${regionName(badFee?.[0])}: a whole 0 to ${BANK.exchangeFeeMaxBps} bps, or empty for not offered.`],
  ]);
}

/** Charter and terms take the same body; the exchange schedule is always sent whole, so the form is what the bank offers. */
const termsBody = (t: Terms): S.BankTermsRequest => ({
  demand_rate_bps: num(t.demand),
  notice_rate_bps: num(t.notice),
  notice_game_hours: num(t.hours),
  insured: t.insured,
  exchange_fee_bps: scheduleOf(t),
});

function TermsFields({ value, onChange }: { value: Terms; onChange: (t: Terms) => void }) {
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Field label="Demand rate (bps/day)">
          <Input type="number" min={0} max={BANK.rateMaxBps} step={1} value={value.demand} onChange={(e) => onChange({ ...value, demand: e.target.value })} />
        </Field>
        <Field label="Notice rate (bps/day)">
          <Input type="number" min={0} max={BANK.rateMaxBps} step={1} value={value.notice} onChange={(e) => onChange({ ...value, notice: e.target.value })} />
        </Field>
        <Field label="Notice (game hours)">
          <Input type="number" min={1} max={BANK.noticeHoursMax} step={1} value={value.hours} onChange={(e) => onChange({ ...value, hours: e.target.value })} />
        </Field>
      </div>
      <Checkbox checked={value.insured} onChange={(v) => onChange({ ...value, insured: v })}>
        Crown deposit insurance (costs the bank 1 bps of insured deposits a day)
      </Checkbox>
      <div className="space-y-2">
        <div className="font-medium text-xs">Exchange: fee (bps, 0 to {BANK.exchangeFeeMaxBps}) on withdrawals paid into another region; empty is not offered</div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {REGIONS.map((r) => (
            <Field key={r} label={<span className="capitalize">{regionName(r)}</span>}>
              <Input
                type="number"
                min={0}
                max={BANK.exchangeFeeMaxBps}
                step={1}
                value={value.fees[r] ?? ""}
                placeholder="not offered"
                onChange={(e) => onChange({ ...value, fees: { ...value.fees, [r]: e.target.value } })}
              />
            </Field>
          ))}
        </div>
        <p className="text-muted-foreground text-xs">
          You keep the fee, but pay out of your vault in the destination region first, and bring across by ordinary remittance (paying the Crown&apos;s fee
          yourself) whatever you must draw from another region. A withdrawal into a deposit&apos;s own region is always free.
        </p>
        <p className="text-muted-foreground text-xs">
          The schedule also wins drafts with no work: post a fee below the Crown&apos;s into a region and keep cash in your vault there, and every company&apos;s
          remittances into it come to you (they pay in at their own end, you pay out the rest there and keep the fee). A draft only pays from cash already in that
          vault, so your vaults fill where clients remit from and empty where they remit to: rebalance with silver or by remitting yourself.
        </p>
      </div>
    </div>
  );
}

function feesSummary(t: Terms): string {
  const list = Object.entries(scheduleOf(t));
  return list.length ? `exchange into ${list.map(([r, bps]) => `${regionName(r)} at ${bps} bps`).join(", ")}` : "no exchange offered";
}

function OurBank({
  bank,
  deposits,
  terms: clientTerms,
  onDone,
}: {
  bank: S.BankResult;
  deposits: S.DepositResult[];
  /** The client terms our bank gives (undefined while unread). */
  terms: S.ClientTermsResult[] | undefined;
  onDone: () => void;
}) {
  const [terms, setTerms] = useState<Terms>({
    demand: String(bank.demand_rate_bps),
    notice: String(bank.notice_rate_bps),
    hours: String(bank.notice_game_hours),
    insured: bank.insured,
    fees: feesOf(bank.exchange_fee_bps),
  });
  const act = useAction<S.BankResult>(onDone);
  const why = termsProblem(terms);
  const open = bank.status === "open" && !bank.failed_at;

  return (
    <div className="grid items-start gap-4 xl:grid-cols-3">
      <Panel title={`Your bank · ${bank.name}`} className="xl:col-span-2">
        <BankStatus bankId={bank.company_id} />
        <h3 className="mt-5 mb-2 font-medium text-muted-foreground text-xs">Deposits you hold</h3>
        {deposits.length === 0 ? (
          <Empty>No deposits yet.</Empty>
        ) : (
          <Table head={["Depositor", "Region", "Balance", "Rate", "Kind", "Pending", "Since"]}>
            {deposits.map((d) => (
              <tr key={d.id}>
                <td>
                  <CompanyLabel id={d.depositor_company_id} />
                </td>
                <td className="capitalize">{regionName(d.banking_region)}</td>
                <td className="tabular-nums">
                  {fmtCr(d.balance_pence)}
                  {d.pledged_pence > 0 && <div className="text-muted-foreground text-xs">{fmtCr(d.pledged_pence)} locked by your loan</div>}
                </td>
                <td>
                  <RateText bps={d.effective_rate_bps || d.daily_rate_bps} />
                  {d.rate_bonus_bps > 0 && <div className="text-muted-foreground text-xs">+{d.rate_bonus_bps} client bonus</div>}
                </td>
                <td className="whitespace-nowrap text-xs">{d.notice_game_hours > 0 ? `notice ${fmtGameHours(d.notice_game_hours)}` : "demand"}</td>
                <td className={`tabular-nums ${d.pending_withdrawal_pence > 0 ? "text-destructive" : ""}`}>{d.pending_withdrawal_pence > 0 ? fmtCr(d.pending_withdrawal_pence) : "—"}</td>
                <td className="whitespace-nowrap text-muted-foreground text-xs">{fmtDateTime(d.created_at)}</td>
              </tr>
            ))}
          </Table>
        )}
      </Panel>
      <div className="space-y-4">
        <Panel title="Terms for new deposits">
          <div className="space-y-3">
            <TermsFields value={terms} onChange={setTerms} />
            <ErrorNote error={act.error ?? why} />
            <Button
              className="w-full"
              disabled={!!why || act.busy || !open}
              onClick={() =>
                confirm(
                  `Set new deposits to ${terms.demand} bps on demand and ${terms.notice} bps on ${terms.hours} game hours' notice${terms.insured ? ", insured" : ", uninsured"}, with ${feesSummary(terms)}? Existing deposits keep their rates; the exchange schedule applies at once to withdrawals asked for from now on.`,
                ) &&
                void act.run(() => kibbPost<S.BankResult>("/v1/bank/terms", termsBody(terms)))
              }
            >
              {act.busy ? "Saving…" : "Change terms"}
            </Button>
          </div>
        </Panel>
        <ClientTermsForm bank={bank} deposits={deposits} terms={clientTerms} onDone={onDone} />
        <Panel title="Wind down">
          <div className="space-y-3 text-sm">
            <p className="text-muted-foreground">
              Stops deposits, lending and underwriting, and withdraws every lending line (its open quotes released). Every game day all the bank&apos;s cash goes
              to depositors pro rata as its loans come in; once nothing is lent out it closes, or goes into receivership if it can&apos;t pay everyone. It can&apos;t be
              undone.
            </p>
            <Button
              variant="destructive"
              className="w-full"
              disabled={act.busy || !open}
              onClick={() =>
                confirm(
                  `Wind down ${bank.name}? It stops all new business, withdraws every lending line (releasing their open quotes), and pays out its depositors (${fmtCr(bank.deposits_pence)} owed) pro rata as loans come in. This cannot be undone, and a company whose failed bank still owes depositors can never charter again.`,
                ) && void act.run(() => kibbPost<S.BankResult>("/v1/bank/wind-down", {}))
              }
            >
              {bank.status === "winding_down" ? "Winding down" : "Wind down the bank"}
            </Button>
          </div>
        </Panel>
      </div>
    </div>
  );
}

/** Our bank's private terms for one client (guide 3.13.4): a rate bonus on every deposit it holds with us, and a discount off our exchange fees. */
function ClientTermsForm({
  bank,
  deposits,
  terms,
  onDone,
}: {
  bank: S.BankResult;
  deposits: S.DepositResult[];
  terms: S.ClientTermsResult[] | undefined;
  onDone: () => void;
}) {
  const names = useCompanyNames();
  const ourIds = useOurCompanyIds();
  const [client, setClient] = useState("");
  const [other, setOther] = useState("");
  const [bonus, setBonus] = useState("0");
  const [discount, setDiscount] = useState("0");
  // Resolves to null when the confirmation is declined.
  const act = useAction<S.ClientTermsResult | null>((r) => r && onDone());
  const given = (terms ?? []).filter((t) => t.bank_company_id === bank.company_id);
  // Clients to pick from: our depositors (largest holdings first) and anyone we already give terms to.
  const held = new Map<string, number>();
  for (const d of deposits) if (d.status === "open") held.set(d.depositor_company_id, (held.get(d.depositor_company_id) ?? 0) + d.balance_pence);
  for (const t of given) if (!held.has(t.depositor_company_id)) held.set(t.depositor_company_id, 0);
  const known = [...held.entries()].sort((a, b) => b[1] - a[1]);
  const typed = other.trim();
  const id = client === "other" ? (names.idByName(typed) ?? typed) : client;
  const current = given.find((t) => t.depositor_company_id === id);
  const bo = num(bonus);
  const di = num(discount);
  const why = firstProblem([
    [!!id, client === "other" ? "Enter the company's name (as seen on these pages) or its id." : "Choose a client."],
    [id !== bank.company_id, "Your bank can't give terms to itself."],
    [Number.isInteger(bo) && bo >= 0 && bo <= BANK.clientBonusMaxBps, `Rate bonus: a whole 0 to ${BANK.clientBonusMaxBps} bps a game day.`],
    [Number.isInteger(di) && di >= 0 && di <= BANK.exchangeFeeMaxBps, `Exchange discount: a whole 0 to ${BANK.exchangeFeeMaxBps} bps.`],
    [bank.status === "open" && !bank.failed_at, "Only an open bank may set client terms."],
  ]);

  function pick(v: string) {
    setClient(v);
    const t = given.find((x) => x.depositor_company_id === v);
    setBonus(String(t?.rate_bonus_bps ?? 0));
    setDiscount(String(t?.exchange_discount_bps ?? 0));
    act.reset();
  }

  function submit() {
    const clears = bo === 0 && di === 0;
    const who = names.label(id);
    void act.run(async () => {
      if (
        !confirm(
          clears
            ? `Clear ${who}'s client terms? Its deposits earn your posted rate from now on (interest already credited is kept).`
            : `Give ${who} +${bo} bps a day on every open deposit it holds with ${bank.name} (the sum capped at ${BANK.clientBonusMaxBps} bps), counting from now, and ${di} bps off your posted exchange fees (never below 0)?\n\nIts deposits are first credited their interest to now at the old rate. Pay no more than your lending earns: a discount is cash you would have kept. An effective rate above 25 bps a day is flagged as mispriced${ourIds.has(id) ? ", and terms for your own companies are flagged for review" : ""}.`,
        )
      )
        return null;
      return kibbPost<S.ClientTermsResult>("/v1/bank/client-terms", { depositor_company_id: id, rate_bonus_bps: bo, exchange_discount_bps: di });
    });
  }

  return (
    <Panel title="Client terms">
      <div className="space-y-3">
        {terms === undefined ? (
          <Loading />
        ) : given.length === 0 ? (
          <p className="text-muted-foreground text-sm">You give no client better terms than you post.</p>
        ) : (
          <Table head={["Client", "Rate bonus", "Exchange discount", "Set", ""]}>
            {given.map((t) => (
              <tr key={t.depositor_company_id}>
                <td>{t.depositor_name}</td>
                <td className="tabular-nums">+{t.rate_bonus_bps} bps/day</td>
                <td className="tabular-nums">{t.exchange_discount_bps} bps</td>
                <td className="whitespace-nowrap text-muted-foreground text-xs">{fmtDateTime(t.updated_at)}</td>
                <td className="text-right">
                  <Button size="sm" variant="ghost" onClick={() => pick(t.depositor_company_id)}>
                    Edit
                  </Button>
                </td>
              </tr>
            ))}
          </Table>
        )}
        <Field label="Client">
          <NativeSelect value={client} onChange={(e) => pick(e.target.value)}>
            <option value="">Choose a client…</option>
            {known.map(([cid, pence]) => (
              <option key={cid} value={cid}>
                {names.label(cid)}
                {pence > 0 ? ` · holds ${fmtCr(pence)}` : ""}
              </option>
            ))}
            <option value="other">Another company…</option>
          </NativeSelect>
        </Field>
        {client === "other" && <Input value={other} onChange={(e) => setOther(e.target.value)} placeholder="Company name or id" />}
        <div className="grid grid-cols-2 gap-3">
          <Field label={`Rate bonus (bps/day, 0–${BANK.clientBonusMaxBps})`}>
            <Input type="number" min={0} max={BANK.clientBonusMaxBps} step={1} value={bonus} onChange={(e) => setBonus(e.target.value)} />
          </Field>
          <Field label={`Exchange discount (bps, 0–${BANK.exchangeFeeMaxBps})`}>
            <Input type="number" min={0} max={BANK.exchangeFeeMaxBps} step={1} value={discount} onChange={(e) => setDiscount(e.target.value)} />
          </Field>
        </div>
        {current && <p className="text-muted-foreground text-xs">Now: +{current.rate_bonus_bps} bps, {current.exchange_discount_bps} bps off. Both 0 clears them.</p>}
        <ErrorNote error={act.error ?? (client ? why : null)} />
        {act.result && <p className="text-sm">Terms for {act.result.depositor_name} set.</p>}
        <Button className="w-full" disabled={!!why || act.busy} onClick={submit}>
          {act.busy ? "Saving…" : bo === 0 && di === 0 ? "Clear the client's terms" : "Set the client's terms"}
        </Button>
        <p className="text-muted-foreground text-xs">
          Private: only your bank and the client see them, never the bank list. The bonus is added to every open deposit the client holds with you; the discount
          comes off your posted exchange fee on its withdrawals into another region. Any company but your bank may be offered terms, with a deposit here or not.
        </p>
      </div>
    </Panel>
  );
}

/** Loans secured by a bank deposit (guide 3.13.4): ours against our deposits, and our bank's against its depositors'. */
function DepositLoansPanel({ companyId }: { companyId: string | undefined }) {
  const { data, error } = usePoll(
    companyId
      ? async () => {
          const [owed, lent] = await Promise.all([loansOf("borrower", ["active", "defaulted"]), loansOf("lender", ["active", "defaulted"])]);
          return [...owed, ...lent].filter((l) => l.collateral_kind === "deposit");
        }
      : null,
    60_000,
    [companyId],
  );
  if (!data?.length && !error) return null;
  return (
    <Panel title="Loans against deposits">
      <ErrorNote error={error} />
      {data && (
        <Table head={["Side", "Counterparty", "Region", "Owed", "Deposit locked", "Deposit", "Status"]}>
          {data.map((l) => {
            const borrowed = l.borrower_company_id === companyId;
            return (
              <tr key={l.id}>
                <td>{borrowed ? "You owe" : "Owed to your bank"}</td>
                <td>
                  <CompanyLabel id={borrowed ? l.lender_company_id : l.borrower_company_id} />
                </td>
                <td className="capitalize">{regionName(l.banking_region)}</td>
                <td className="tabular-nums">{fmtCr(l.owed_pence)}</td>
                <td className="tabular-nums">{fmtCr(l.deposit_lock_pence)}</td>
                <td className="font-mono text-xs">{shortId(l.collateral_deposit_id)}</td>
                <td>
                  <LoanStatusBadge status={l.status} />
                </td>
              </tr>
            );
          })}
        </Table>
      )}
      <p className="mt-3 text-muted-foreground text-xs">
        From approval the deposit carries a lock of the total repayable: withdrawals may take only what is above it, it keeps earning interest, and every payment
        shrinks it. Unpaid at default, the bank sets what is owed off against the deposit; the rest stays owed with recourse. Borrow against a deposit on the{" "}
        <Link href="/loans" className="text-primary hover:underline">
          loans
        </Link>{" "}
        page (only the bank holding it may quote).
      </p>
    </Panel>
  );
}

function CharterPanel({ vaults, autopilot, onDone }: { vaults: Vaults; autopilot: boolean; onDone: () => void }) {
  const [terms, setTerms] = useState<Terms>({ demand: "5", notice: "10", hours: "48", insured: true, fees: {} });
  const act = useAction<S.BankResult>(onDone);
  const need = BANK.charterFeePence + BANK.ownFundsPence;
  const why = firstProblem([
    [termsProblem(terms) === null, termsProblem(terms) ?? ""],
    [vaults.total === undefined || vaults.total >= need, `You need ${fmtCr(need)} in your vaults (the ${fmtCr(BANK.charterFeePence)} fee plus ${fmtCr(BANK.ownFundsPence)} of your own funds after it).`],
  ]);

  function submit() {
    if (
      !confirm(
        `Charter a bank? ${fmtCr(BANK.charterFeePence)} goes to the Crown and is not refunded, and you need ${fmtCr(BANK.ownFundsPence)} of your own funds after it.\n\nWhile it is open you can't declare bankruptcy; new loans, board offers and underwriting slices are refused unless your vault cash stays at least 20% of what you owe depositors; and a withdrawal left unpaid for a game day fails the bank.${autopilot ? "\n\nDeposits land in your vaults, where the fleet autopilot treats them as its own cash." : ""}`,
      )
    )
      return;
    void act.run(() => kibbPost<S.BankResult>("/v1/bank/charter", termsBody(terms)));
  }

  return (
    <div className="grid items-start gap-4 xl:grid-cols-2">
      <Panel title="Charter a bank">
        <div className="space-y-3">
          <TermsFields value={terms} onChange={setTerms} />
          <WarnBox>
            <p>
              The charter costs {fmtCr(BANK.charterFeePence)} (paid to the Crown of your home region, not refunded), and you need {fmtCr(BANK.ownFundsPence)} of
              your own funds after it.
            </p>
            {autopilot && (
              <p>
                Deposits land in your vaults, where the fleet autopilot sees them as its own cash and may spend them on ships and cargo: keep 20% in reserve and
                enough to meet withdrawals, or the bank fails.
              </p>
            )}
          </WarnBox>
          <p className={`text-xs ${vaults.total !== undefined && vaults.total < need ? "text-destructive" : "text-muted-foreground"}`}>
            {vaults.total === undefined ? "Reading your vaults…" : `${fmtCr(vaults.total)} in your vaults, of ${fmtCr(need)} needed.`}
          </p>
          <ErrorNote error={act.error ?? why} />
          {act.result && <p className="text-sm">Chartered {act.result.name}.</p>}
          <Button className="w-full" disabled={!!why || act.busy} onClick={submit}>
            {act.busy ? "Chartering…" : `Charter for ${fmtCr(BANK.charterFeePence)}`}
          </Button>
        </div>
      </Panel>
      <Panel title="Running a bank">
        <div className="space-y-2 text-muted-foreground text-sm">
          <p>Rates are 0 to {BANK.rateMaxBps} bps a game day (at most the Goldsmiths&apos; lending rate); notice 1 to {BANK.noticeHoursMax} game hours.</p>
          <p>
            Deposits land in your vault: lend and underwrite with them as usual, but a new loan, board offer or underwriting slice is refused unless your vault cash
            afterwards is still at least 20% of what you owe depositors.
          </p>
          <p>
            A bank that leaves a withdrawal unpaid for a game day fails: it pays depositors pro rata as its loans come in, then through receivership. An open bank
            can&apos;t declare bankruptcy, and a company whose failed bank still owes depositors can&apos;t charter again.
          </p>
        </div>
      </Panel>
    </div>
  );
}

// ── Lending lines (guide 3.13.8) ──────────────────────────────────────────────

const LINE_KINDS: S.CollateralKind[] = ["ship_lien", "warehouse_goods", "contract_receivable", "deposit", "unsecured"];
const LINE_REPAYMENTS: S.LoanRepayment[] = ["balloon", "amortised"];

/** A line's rate as an annual rate for a term: its share of the Goldsmiths' rate for that term, rounded up (bps). */
const lineAnnualBps = (shareBps: number, days: number) => Math.ceil((goldsmithsAnnualBps(days) * shareBps) / 10_000);

const pctYr = (bps: number) => `${(bps / 100).toLocaleString("en-GB", { maximumFractionDigits: 2 })}%/yr`;

/** A line's credit filters in words (on the borrower's record summed with its own and linked companies'). */
function filtersText(l: S.LendingLine): string {
  return [
    l.max_defaults == null ? "any defaults" : l.max_defaults === 0 ? "no defaults" : `≤ ${l.max_defaults} defaults`,
    l.max_walk_aways === 0 ? "no walk-aways" : `≤ ${l.max_walk_aways} walk-aways`,
    l.max_owed_pence == null ? null : `owes ≤ ${fmtCr(l.max_owed_pence)}`,
    l.min_loans_repaid > 0 ? `≥ ${l.min_loans_repaid} repaid` : null,
    l.no_default_within_game_days == null ? null : `no default in ${l.no_default_within_game_days} days`,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** A line's terms as typed: every field of `LendingLineTerms`, in Cr, % and game days. */
interface LineForm {
  regions: S.BankingRegion[];
  kinds: S.CollateralKind[];
  repayments: S.LoanRepayment[];
  /** % of the Goldsmiths' rate. */
  rate: string;
  /** % of the pledge's appraisal. */
  ltv: string;
  term: string;
  minCr: string;
  maxCr: string;
  nonRecourse: boolean;
  perBorrowerCr: string;
  lineCr: string;
  /** Empty: no limit. */
  maxDefaults: string;
  maxWalkAways: string;
  /** Empty: no limit. */
  maxOwedCr: string;
  minRepaid: string;
  /** Empty: no limit. */
  noDefaultDays: string;
}

const crText = (pence: number | null | undefined) => (pence == null ? "" : String(pence / 100));

function lineFormOf(l: S.LendingLine): LineForm {
  return {
    regions: [...l.regions],
    kinds: [...l.collateral_kinds],
    repayments: [...l.repayments],
    rate: String(l.rate_pct_of_goldsmiths_bps / 100),
    ltv: String(l.max_ltv_bps / 100),
    term: String(l.max_term_game_days),
    minCr: crText(l.min_principal_pence),
    maxCr: crText(l.max_principal_pence),
    nonRecourse: l.allow_non_recourse,
    perBorrowerCr: crText(l.max_per_borrower_pence),
    lineCr: crText(l.max_line_pence),
    maxDefaults: l.max_defaults == null ? "" : String(l.max_defaults),
    maxWalkAways: String(l.max_walk_aways),
    maxOwedCr: crText(l.max_owed_pence),
    minRepaid: String(l.min_loans_repaid),
    noDefaultDays: l.no_default_within_game_days == null ? "" : String(l.no_default_within_game_days),
  };
}

const newLineForm = (home: S.BankingRegion): LineForm => ({
  regions: [home],
  kinds: ["ship_lien"],
  repayments: ["balloon", "amortised"],
  rate: "70",
  ltv: "50",
  term: "90",
  minCr: "500",
  maxCr: "5000",
  nonRecourse: false,
  perBorrowerCr: "10000",
  lineCr: "50000",
  maxDefaults: "",
  maxWalkAways: "0",
  maxOwedCr: "",
  minRepaid: "0",
  noDefaultDays: "",
});

const optNum = (v: string) => (v.trim() === "" ? null : num(v));
const isCount = (n: number) => Number.isInteger(n) && n >= 0;

function lineBody(f: LineForm): S.LendingLineTerms {
  const owed = f.maxOwedCr.trim() === "" ? null : crToPence(f.maxOwedCr);
  return {
    regions: f.regions,
    collateral_kinds: f.kinds,
    repayments: f.repayments,
    rate_pct_of_goldsmiths_bps: Math.round(num(f.rate) * 100),
    max_ltv_bps: Math.round(num(f.ltv) * 100),
    max_term_game_days: num(f.term),
    min_principal_pence: crToPence(f.minCr),
    max_principal_pence: crToPence(f.maxCr),
    allow_non_recourse: f.nonRecourse,
    max_per_borrower_pence: crToPence(f.perBorrowerCr),
    max_line_pence: crToPence(f.lineCr),
    max_defaults: optNum(f.maxDefaults),
    max_walk_aways: optNum(f.maxWalkAways) ?? 0,
    max_owed_pence: owed,
    min_loans_repaid: optNum(f.minRepaid) ?? 0,
    no_default_within_game_days: optNum(f.noDefaultDays),
  };
}

function lineProblem(f: LineForm): string | null {
  const b = lineBody(f);
  return firstProblem([
    [b.regions.length > 0, "Choose at least one region it lends in."],
    [b.collateral_kinds.length > 0, "Choose at least one pledge it lends against."],
    [b.repayments.length > 0, "Choose balloon, amortised or both."],
    [Number.isInteger(b.rate_pct_of_goldsmiths_bps) && b.rate_pct_of_goldsmiths_bps >= LINE.rateMinBps && b.rate_pct_of_goldsmiths_bps <= LINE.rateMaxBps, "Rate: 10% to 300% of the Goldsmiths' rate."],
    [b.max_ltv_bps >= 1 && b.max_ltv_bps <= LINE.ltvMaxBps, "Loan-to-value: above 0% and at most 100%."],
    [Number.isInteger(b.max_term_game_days) && b.max_term_game_days >= 1 && b.max_term_game_days <= LINE.termMaxDays, `Longest term: 1 to ${LINE.termMaxDays} game days.`],
    [b.min_principal_pence >= LINE.minPrincipalPence, `Smallest principal: at least ${fmtCr(LINE.minPrincipalPence)}.`],
    [b.max_principal_pence >= b.min_principal_pence, "Largest principal: at least the smallest."],
    [b.max_per_borrower_pence > 0, "Enter the most out to one borrower."],
    [b.max_line_pence > 0, "Enter the most the line has out."],
    [b.max_defaults == null || isCount(b.max_defaults), "Most defaults: a whole number, or empty for no limit."],
    [isCount(b.max_walk_aways ?? 0), "Most walk-aways: a whole number (0: nobody who walked away)."],
    [b.max_owed_pence == null || b.max_owed_pence >= 0, "Most owed: an amount, or empty for no limit."],
    [isCount(b.min_loans_repaid ?? 0), "Fewest loans repaid: a whole number."],
    [
      b.no_default_within_game_days == null || (Number.isInteger(b.no_default_within_game_days) && b.no_default_within_game_days >= 1 && b.no_default_within_game_days <= LINE.noDefaultMaxDays),
      `No default within: 1 to ${LINE.noDefaultMaxDays} game days, or empty for no limit.`,
    ],
  ]);
}

const toggled = <T,>(list: T[], v: T, on: boolean) => (on ? [...list.filter((x) => x !== v), v] : list.filter((x) => x !== v));

function LineFormFields({ value, onChange }: { value: LineForm; onChange: (f: LineForm) => void }) {
  const set = (patch: Partial<LineForm>) => onChange({ ...value, ...patch });
  const share = Math.round(num(value.rate) * 100);
  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <div className="font-medium text-xs">Lends in (requests in these regions; the loan is paid and repaid there)</div>
        <div className="grid grid-cols-2 gap-x-3 gap-y-1 sm:grid-cols-4">
          {REGIONS.map((r) => (
            <Checkbox key={r} checked={value.regions.includes(r)} onChange={(on) => set({ regions: toggled(value.regions, r, on) })}>
              <span className="text-xs capitalize">{regionName(r)}</span>
            </Checkbox>
          ))}
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <div className="font-medium text-xs">Against</div>
          {LINE_KINDS.map((k) => (
            <Checkbox key={k} checked={value.kinds.includes(k)} onChange={(on) => set({ kinds: toggled(value.kinds, k, on) })}>
              <span className="text-xs">{COLLATERAL_LABEL[k]}</span>
            </Checkbox>
          ))}
        </div>
        <div className="space-y-1.5">
          <div className="font-medium text-xs">Repayment</div>
          {LINE_REPAYMENTS.map((r) => (
            <Checkbox key={r} checked={value.repayments.includes(r)} onChange={(on) => set({ repayments: toggled(value.repayments, r, on) })}>
              <span className="text-xs capitalize">{r}</span>
            </Checkbox>
          ))}
          <Checkbox checked={value.nonRecourse} onChange={(v) => set({ nonRecourse: v })}>
            <span className="text-xs">Lend to requests asking for non-recourse</span>
          </Checkbox>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Field label="Rate (% of the Goldsmiths')">
          <Input type="number" min={LINE.rateMinBps / 100} max={LINE.rateMaxBps / 100} step={0.01} value={value.rate} onChange={(e) => set({ rate: e.target.value })} />
        </Field>
        <Field label="Loan-to-value (% at most)">
          <Input type="number" min={0.01} max={100} step={0.01} value={value.ltv} onChange={(e) => set({ ltv: e.target.value })} />
        </Field>
        <Field label={`Longest term (1–${LINE.termMaxDays} days)`}>
          <Input type="number" min={1} max={LINE.termMaxDays} step={1} value={value.term} onChange={(e) => set({ term: e.target.value })} />
        </Field>
        <Field label="Smallest principal (Cr)">
          <Input type="number" min={LINE.minPrincipalPence / 100} step={0.01} value={value.minCr} onChange={(e) => set({ minCr: e.target.value })} />
        </Field>
        <Field label="Largest principal (Cr)">
          <Input type="number" min={LINE.minPrincipalPence / 100} step={0.01} value={value.maxCr} onChange={(e) => set({ maxCr: e.target.value })} />
        </Field>
        <Field label="Most out to one borrower (Cr)">
          <Input type="number" min={0.01} step={0.01} value={value.perBorrowerCr} onChange={(e) => set({ perBorrowerCr: e.target.value })} />
        </Field>
        <Field label="Most the line has out (Cr)">
          <Input type="number" min={0.01} step={0.01} value={value.lineCr} onChange={(e) => set({ lineCr: e.target.value })} />
        </Field>
      </div>
      <div className="space-y-1.5">
        <div className="font-medium text-xs">Credit filters (the borrower&apos;s record summed with its own and linked companies&apos;)</div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Field label="Most defaults">
            <Input type="number" min={0} step={1} value={value.maxDefaults} placeholder="no limit" onChange={(e) => set({ maxDefaults: e.target.value })} />
          </Field>
          <Field label="Most walk-aways">
            <Input type="number" min={0} step={1} value={value.maxWalkAways} onChange={(e) => set({ maxWalkAways: e.target.value })} />
          </Field>
          <Field label="Most owed now (Cr)">
            <Input type="number" min={0} step={0.01} value={value.maxOwedCr} placeholder="no limit" onChange={(e) => set({ maxOwedCr: e.target.value })} />
          </Field>
          <Field label="Fewest loans repaid">
            <Input type="number" min={0} step={1} value={value.minRepaid} onChange={(e) => set({ minRepaid: e.target.value })} />
          </Field>
          <Field label={`No default within (days)`}>
            <Input type="number" min={1} max={LINE.noDefaultMaxDays} step={1} value={value.noDefaultDays} placeholder="no limit" onChange={(e) => set({ noDefaultDays: e.target.value })} />
          </Field>
        </div>
      </div>
      {Number.isFinite(share) && share >= LINE.rateMinBps && share <= LINE.rateMaxBps && (
        <p className="text-muted-foreground text-xs">
          It would quote {pctYr(lineAnnualBps(share, 30))} for 30 game days (the Goldsmiths {pctYr(goldsmithsAnnualBps(30))}) and {pctYr(lineAnnualBps(share, LINE.termMaxDays))} for{" "}
          {LINE.termMaxDays} (the Goldsmiths {pctYr(goldsmithsAnnualBps(LINE.termMaxDays))}).
        </p>
      )}
    </div>
  );
}

/** Our bank's line form: a new line, or `line`'s terms to replace in full. */
function LineEditor({ bank, line, onDone, onClose }: { bank: S.BankResult; line: S.LendingLine | null; onDone: () => void; onClose: () => void }) {
  const [form, setForm] = useState<LineForm>(() => (line ? lineFormOf(line) : newLineForm(bank.home_region)));
  // Resolves to null when the confirmation is declined.
  const act = useAction<S.LendingLine | null>((r) => r && onDone());
  const open = bank.status === "open" && !bank.failed_at;
  const why = firstProblem([[open, "Only an open bank may post or change lending lines."], [lineProblem(form) === null, lineProblem(form) ?? ""]]);
  const b = lineBody(form);
  const neverMatches = b.min_principal_pence > 0 && (b.max_per_borrower_pence < b.min_principal_pence || b.max_line_pence < b.min_principal_pence);

  function submit() {
    const terms = `${lineRateText(b.rate_pct_of_goldsmiths_bps)} rate, in ${b.regions.map(regionName).join(", ")}, against ${b.collateral_kinds.map((k) => COLLATERAL_LABEL[k].toLowerCase()).join(", ")}, ${b.repayments.join(" or ")}, up to ${b.max_term_game_days} game days, ${fmtCr(b.min_principal_pence)}–${fmtCr(b.max_principal_pence)} at most ${fmtBps(b.max_ltv_bps)} of the pledge, ${fmtCr(b.max_per_borrower_pence)} a borrower and ${fmtCr(b.max_line_pence)} in all`;
    void act.run(async () => {
      if (
        !confirm(
          line
            ? `Replace line ${shortId(line.id)}'s terms in full: ${terms}?\n\nQuotes it already made stand; the new terms apply to matches from now on, and every open request in its regions without a line quote is matched again.`
            : `Post a lending line: ${terms}?\n\nIt is public (announced, and listed on the Exchange) and quotes on its own, at once, on every matching request: each quote escrows the principal from your vault in the request's region for up to ${LINE.quoteGameHours} game hours. It stops matching while your vault cash would fall under the Crown's 20% reserve. An open line blocks bankruptcy.`,
        )
      )
        return null;
      return line
        ? kibbPost<S.LendingLine>("/v1/bank/lending-line/update", { line_id: line.id, ...b } satisfies S.UpdateLendingLine)
        : kibbPost<S.LendingLine>("/v1/bank/lending-line", b);
    });
  }

  return (
    <div className="space-y-3">
      <LineFormFields value={form} onChange={setForm} />
      {form.kinds.includes("deposit") && (
        <p className="text-muted-foreground text-xs">
          On a deposit request only the bank holding the deposit can match: the deposit&apos;s free balance must cover the total repayable at your rate (no loan-to-value).
        </p>
      )}
      {form.kinds.includes("ship_lien") && num(form.ltv) > 80 && (
        <WarnBox>A foreclosed ship is credited at 80% of its rebuild value: lending more than that against a ship can lose you money on a default.</WarnBox>
      )}
      {neverMatches && <WarnBox>A cap is under the smallest principal: the line would never match.</WarnBox>}
      <ErrorNote error={act.error ?? why} />
      {act.result && <p className="text-sm">Line {shortId(act.result.id)} {line ? "changed" : "posted"}: {fmtCr(act.result.remaining_capacity_pence)} room left.</p>}
      <div className="flex gap-2">
        <Button className="flex-1" disabled={!!why || act.busy} onClick={submit}>
          {act.busy ? "Saving…" : line ? "Replace the terms" : "Post the line"}
        </Button>
        {line && (
          <Button variant="outline" onClick={onClose}>
            New line
          </Button>
        )}
      </div>
    </div>
  );
}

function LendingLinesSection({
  ours,
  companyId,
  ourIds,
  refreshKey,
  onDone,
}: {
  /** Our own bank, if we run one. */
  ours: S.BankResult | undefined;
  companyId: string | undefined;
  ourIds: Set<string>;
  refreshKey: number;
  onDone: () => void;
}) {
  const [region, setRegion] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  // Tagged with its filter: a poll keeps its last answer across a change, never shown under another region.
  const { data, error, reload } = usePoll(
    () => kibbGet<S.LendingLine[]>("/v1/bank/lending-lines", { banking_region: region }).then((lines) => ({ region, lines })),
    60_000,
    [region, refreshKey],
  );
  const { data: mine, reload: reloadMine } = usePoll(
    ours ? () => kibbGet<S.LendingLine[]>("/v1/bank/lending-lines", { company_id: ours.company_id }) : null,
    60_000,
    [ours?.company_id, refreshKey],
  );
  // Resolves to null when the confirmation is declined.
  const withdraw = useAction<S.WithdrawnLine | null>((r) => {
    if (!r) return;
    void reload();
    void reloadMine();
    onDone();
  });
  const lines = data && data.region === region ? [...data.lines].sort((a, b) => a.rate_pct_of_goldsmiths_bps - b.rate_pct_of_goldsmiths_bps || Date.parse(a.changed_at) - Date.parse(b.changed_at)) : undefined;
  const line = (mine ?? []).find((l) => l.id === editing) ?? null;
  const done = () => {
    void reload();
    void reloadMine();
    onDone();
  };

  function withdrawLine(l: S.LendingLine) {
    void withdraw.run(async () => {
      if (
        !confirm(
          `Withdraw lending line ${shortId(l.id)} (${lineRateText(l.rate_pct_of_goldsmiths_bps)}, ${fmtCr(l.quoted_pence)} in open quotes)? It closes and its open quotes are released, their escrow refunded; loans it made run on.`,
        )
      )
        return null;
      return kibbPost<S.WithdrawnLine>("/v1/bank/lending-line/withdraw", { line_id: l.id });
    });
  }

  return (
    <div className="grid items-start gap-4 xl:grid-cols-3">
      <Panel
        title="Lending lines"
        className="xl:col-span-2"
        action={
          <div className="w-full sm:w-44">
            <RegionSelect value={region} onChange={setRegion} placeholder="Every region" />
          </div>
        }
      >
        <ErrorNote error={error ?? withdraw.error} />
        {withdraw.result && <p className="mb-3 text-sm">Withdrawn: {withdraw.result.quotes_released} open quote{withdraw.result.quotes_released === 1 ? "" : "s"} released.</p>}
        {!lines ? (
          !error && <Loading />
        ) : lines.length === 0 ? (
          <Empty>No open lending lines{region ? ` in ${regionName(region)}` : ""}.</Empty>
        ) : (
          <Table head={["Bank", "Rate", "Lends", "Terms", "Credit filters", "Caps", "Room", "Changed", ""]}>
            {lines.map((l) => {
              const own = !!ours && l.bank_company_id === ours.company_id;
              return (
                <tr key={l.id} className={l.id === editing ? "bg-accent" : undefined}>
                  <td>
                    <CompanyLabel id={l.bank_company_id} companyId={companyId} ourIds={ourIds} />
                    <div className="font-mono text-muted-foreground text-xs">{shortId(l.id)}</div>
                  </td>
                  <td className="whitespace-nowrap text-xs" title={`Rounded up from its share of the Goldsmiths' rate for each request's term: ${pctYr(lineAnnualBps(l.rate_pct_of_goldsmiths_bps, 30))} at 30 game days, ${pctYr(lineAnnualBps(l.rate_pct_of_goldsmiths_bps, LINE.termMaxDays))} at ${LINE.termMaxDays}`}>
                    <span className="font-medium tabular-nums">{fmtBps(l.rate_pct_of_goldsmiths_bps)}</span>
                    <div className="text-muted-foreground">≈ {pctYr(lineAnnualBps(l.rate_pct_of_goldsmiths_bps, 30))} at 30 days</div>
                  </td>
                  <td className="max-w-44 text-xs">
                    <div className="capitalize">{l.regions.map(regionName).join(", ")}</div>
                    <div className="text-muted-foreground">
                      {l.collateral_kinds.map((k) => COLLATERAL_LABEL[k] ?? k).join(", ")} · {l.repayments.join(", ")}
                    </div>
                  </td>
                  <td className="whitespace-nowrap text-xs tabular-nums">
                    {fmtCr(l.min_principal_pence)}–{fmtCr(l.max_principal_pence)}
                    <div className="text-muted-foreground">
                      ≤ {l.max_term_game_days} days · LTV ≤ {fmtBps(l.max_ltv_bps)}
                      {l.allow_non_recourse ? " · non-recourse ok" : ""}
                    </div>
                  </td>
                  <td className="max-w-44 text-xs">{filtersText(l)}</td>
                  <td className="whitespace-nowrap text-xs tabular-nums">
                    {fmtCr(l.max_per_borrower_pence)} a borrower
                    <div className="text-muted-foreground">{fmtCr(l.max_line_pence)} in all</div>
                  </td>
                  <td className="whitespace-nowrap text-xs tabular-nums">
                    <span className="font-medium">{fmtCr(l.remaining_capacity_pence)}</span>
                    <div className="text-muted-foreground">
                      {fmtCr(l.outstanding_pence)} lent · {fmtCr(l.quoted_pence)} quoted
                    </div>
                  </td>
                  <td className="whitespace-nowrap text-muted-foreground text-xs" title={`Posted ${fmtDateTime(l.created_at)}; the earlier change wins a tie on rate`}>
                    {fmtAgo(l.changed_at)}
                  </td>
                  <td>
                    {own && (
                      <div className="flex justify-end gap-1.5">
                        <Button size="sm" variant="ghost" onClick={() => setEditing(l.id)}>
                          Edit
                        </Button>
                        <Button size="sm" variant="outline" disabled={withdraw.busy} onClick={() => withdrawLine(l)}>
                          Withdraw
                        </Button>
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </Table>
        )}
        <p className="mt-3 text-muted-foreground text-xs">
          Cheapest first. A line quotes on its own, at once, on every new request it covers (its region, pledge and repayment; principal, term and loan-to-value within
          its limits; the borrower&apos;s record through its filters; both caps with room). The lowest effective rate wins; on a tie the line posted or changed first.
          To borrow on one, post a request it covers on the <Link href="/loans" className="text-primary hover:underline">loans</Link> page: its quote (
          <span className="italic">auto</span>) stands {LINE.quoteGameHours} game hours at most.
        </p>
      </Panel>
      {ours ? (
        <Panel
          title={line ? `Change line ${shortId(line.id)}` : "Post a lending line"}
          action={
            line && (
              <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                Close
              </Button>
            )
          }
        >
          <LineEditor key={line?.id ?? "new"} bank={ours} line={line} onDone={done} onClose={() => setEditing(null)} />
          {mine && mine.length > 0 && (
            <p className="mt-3 text-muted-foreground text-xs">
              Your bank has {mine.length} open line{mine.length === 1 ? "" : "s"}: {mine.map((l) => `${shortId(l.id)} (${fmtCr(l.remaining_capacity_pence)} room)`).join(", ")}.
            </p>
          )}
        </Panel>
      ) : (
        <Panel title="Lending lines">
          <div className="space-y-2 text-muted-foreground text-sm">
            <p>
              A bank posts standing terms: a rate as a share of the Goldsmiths&apos; rate for each request&apos;s term, a loan-to-value, the longest term, a principal
              range, credit filters and caps. Every matching request draws its quote at once (<span className="italic">auto</span>), so cheap money comes to a
              request without waiting.
            </p>
            <p>A request carries at most one line quote. Approve it before its expiry; at approval the line must still be open and you must still pass its filters.</p>
          </div>
        </Panel>
      )}
    </div>
  );
}

export default function BanksPage() {
  useCompanyDirectory();
  const companyId = useCompanyId();
  const ourIds = useOurCompanyIds();
  const fleet = useFleetFinance();
  const vaults = useVaults();
  const { data: banks, error, reload } = usePoll(() => kibbGet<S.BankResult[]>("/v1/bank/list"), 30_000);
  const { data: deposits, error: depositsError, reload: reloadDeposits } = usePoll(() => kibbGet<S.DepositResult[]>("/v1/bank/deposits"), 30_000);
  const { data: rates } = usePoll(() => kibbGet<S.RegionalAchRateResult[]>("/v1/treasury/rates"), 300_000);
  const { data: clientTerms, reload: reloadTerms } = usePoll(() => kibbGet<S.ClientTermsResult[]>("/v1/bank/client-terms"), 60_000);
  useLearnCompanies([
    ...(banks ?? []).map((b) => [b.company_id, b.name] as [string, string]),
    ...(clientTerms ?? []).flatMap((t) => [[t.bank_company_id, t.bank_name] as [string, string], [t.depositor_company_id, t.depositor_name] as [string, string]]),
  ]);
  const [picked, setPicked] = useState<{ id: string; mode: "deposit" | "status" } | null>(null);
  const [linesKey, setLinesKey] = useState(0);
  const refresh = () => {
    void reload();
    void reloadDeposits();
    void reloadTerms();
    void vaults.reload();
    setLinesKey((k) => k + 1);
  };
  const ours = banks?.find((b) => b.company_id === companyId);
  const bank = banks?.find((b) => b.company_id === picked?.id);
  const mine = (deposits ?? []).filter((d) => d.depositor_company_id === companyId);
  const held = (deposits ?? []).filter((d) => d.bank_company_id === companyId && d.depositor_company_id !== companyId);
  const balance = mine.filter((d) => d.status === "open").reduce((n, d) => n + d.balance_pence, 0);
  const pending = mine.reduce((n, d) => n + d.pending_withdrawal_pence, 0);
  const troubled = (banks ?? []).filter((b) => health(b).variant === "error" || health(b).variant === "warning");
  const toUs = (clientTerms ?? []).filter((t) => t.depositor_company_id === companyId);

  return (
    <div className="space-y-5 pb-8 sm:space-y-6">
      <PageHeader
        title="Banks"
        subtitle="Player banks take deposits at daily rates, lend them out (by hand or through standing lending lines) and carry remittances as drafts. Judge a bank's reserves, insurance and overdue withdrawals before depositing."
      />
      <Metrics
        items={[
          { label: "Banks", value: banks ? String(banks.length) : "…", hint: troubled.length ? `${troubled.length} in trouble` : undefined },
          { label: "Your deposits", value: deposits ? fmtCr(balance) : "…", hint: `${mine.filter((d) => d.status === "open").length} open` },
          { label: "Withdrawals pending", value: deposits ? fmtCr(pending) : "…" },
          { label: "Interest earned", value: deposits ? fmtCr(mine.reduce((n, d) => n + d.interest_credited_pence, 0)) : "…" },
          { label: "Insured cover", value: fmtCr(BANK.insuredCoverPence), hint: "per player, per insured bank" },
          { label: "Your bank", value: ours ? ours.name : "none", hint: ours ? `owes ${fmtCr(ours.deposits_pence)}` : undefined },
        ]}
      />
      <div className="grid items-start gap-4 xl:grid-cols-3">
        <Panel title="Banks" className="xl:col-span-2">
          <ErrorNote error={error} />
          {!banks ? (
            !error && <Loading />
          ) : banks.length === 0 ? (
            <Empty>No banks are open.</Empty>
          ) : (
            <Table head={["Bank", "Region", "Status", "Demand", "Notice", "Exchange", "Drafts", "Lines", "Deposits", "Reserves", "Lent", "Overdue", ""]}>
              {banks.map((b) => {
                const h = health(b);
                const below = b.reserves_pence < b.required_reserve_pence;
                const lines = bestRatesText(b.lending_line_best_rates);
                return (
                  <tr key={b.company_id} className={b.company_id === picked?.id ? "bg-accent" : undefined}>
                    <td>
                      <span className="inline-flex flex-wrap items-center gap-1">
                        <CompanyLabel id={b.company_id} companyId={companyId} ourIds={ourIds} />
                        {b.insured && <Badge variant="info" size="sm">insured</Badge>}
                      </span>
                    </td>
                    <td className="capitalize">{regionName(b.home_region)}</td>
                    <td>
                      <Badge variant={h.variant} size="sm">{h.label}</Badge>
                    </td>
                    <td>
                      <RateText bps={b.demand_rate_bps} />
                    </td>
                    <td className="whitespace-nowrap">
                      <RateText bps={b.notice_rate_bps} /> <span className="text-muted-foreground text-xs">/ {fmtGameHours(b.notice_game_hours)}</span>
                    </td>
                    <td className="text-xs">
                      <ExchangeFees bank={b} rates={rates} />
                    </td>
                    <td className="whitespace-nowrap text-xs tabular-nums">
                      {b.drafts_carried ? (
                        <>
                          {b.drafts_carried}
                          <div className="text-muted-foreground">{fmtCr(b.draft_fees_pence)} fees</div>
                        </>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="max-w-40 text-xs" title={lines ? "Its open lending lines' cheapest rate per pledge, as a share of the Goldsmiths' rate for the term" : undefined}>
                      {lines || <span className="text-muted-foreground">—</span>}
                    </td>
                    <td className="tabular-nums">{fmtCr(b.deposits_pence)}</td>
                    <td className={`whitespace-nowrap tabular-nums ${below ? "text-warning-foreground" : ""}`} title={`Required: ${fmtCr(b.required_reserve_pence)} (20% of deposits)`}>
                      {fmtCr(b.reserves_pence)} <span className="text-muted-foreground text-xs">({reserveRatio(b)})</span>
                    </td>
                    <td className="tabular-nums">{fmtCr(b.loans_out_pence)}</td>
                    <td className={`tabular-nums ${b.overdue_withdrawals_pence > 0 ? "text-destructive" : "text-muted-foreground"}`}>
                      {b.overdue_withdrawals_pence > 0 ? fmtCr(b.overdue_withdrawals_pence) : "—"}
                    </td>
                    <td>
                      <div className="flex justify-end gap-1.5">
                        <Button size="sm" variant="ghost" onClick={() => setPicked({ id: b.company_id, mode: "status" })}>
                          Status
                        </Button>
                        {b.company_id !== companyId && (
                          <Button size="sm" variant="outline" disabled={b.status !== "open" || !!b.failed_at} onClick={() => setPicked({ id: b.company_id, mode: "deposit" })}>
                            Deposit
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </Table>
          )}
          <p className="mt-3 text-muted-foreground text-xs">
            Reserves are the bank&apos;s vault cash against the Crown&apos;s 20% of deposits. A bank that leaves a withdrawal unpaid for a game day fails. Exchange is the
            fee a bank takes to pay a withdrawal into a vault in another region (a region not listed is not offered). The same fee prices drafts: your remittance into
            a region is carried by the cheapest open bank whose fee there (less any client discount it gives you) is strictly below the Crown&apos;s for the route and
            whose vault there can already pay it; &ldquo;under Crown&rdquo; marks such a fee. Lines: its lending lines&apos; best rate per pledge, as a share of the
            Goldsmiths&apos; rate.
          </p>
        </Panel>
        <Panel title={bank ? (picked?.mode === "deposit" ? "Deposit" : "Bank status") : "Deposit"} action={bank && <Button size="sm" variant="ghost" onClick={() => setPicked(null)}>Close</Button>}>
          {bank && picked ? (
            picked.mode === "deposit" ? (
              <DepositForm key={bank.company_id} bank={bank} own={bank.company_id === companyId} vaults={vaults} onDone={refresh} />
            ) : (
              <BankStatus bankId={bank.company_id} />
            )
          ) : (
            <div className="space-y-2 text-muted-foreground text-sm">
              <p>Pick a bank to deposit with, or to see its status and credit record.</p>
              <p>
                Insured banks&apos; depositors are paid by the Crown if the bank fails: up to {fmtCr(BANK.insuredCoverPence)} per player, capped per bank, on deposits{" "}
                {BANK.insuredAfterDays}+ game days old. Otherwise a failed bank pays pro rata as its loans come in.
              </p>
              <p>
                Check credit records on the <Link href="/loans" className="text-primary hover:underline">loans</Link> page.
              </p>
            </div>
          )}
        </Panel>
      </div>
      <DepositsPanel deposits={deposits} banks={banks} rates={rates} error={depositsError} companyId={companyId} onDone={refresh} />
      <LendingLinesSection ours={ours} companyId={companyId} ourIds={ourIds} refreshKey={linesKey} onDone={() => void reload()} />
      {toUs.length > 0 && (
        <Panel title="Client terms banks give you">
          <Table head={["Bank", "Rate bonus", "Exchange discount", "Set"]}>
            {toUs.map((t) => (
              <tr key={t.bank_company_id}>
                <td>{t.bank_name}</td>
                <td className="tabular-nums">+{t.rate_bonus_bps} bps/day on every open deposit there</td>
                <td className="tabular-nums">{t.exchange_discount_bps} bps off its exchange fees</td>
                <td className="whitespace-nowrap text-muted-foreground text-xs">{fmtDateTime(t.updated_at)}</td>
              </tr>
            ))}
          </Table>
          <p className="mt-3 text-muted-foreground text-xs">Private loyalty terms: only you and the bank see them. The bank may change them at any time; interest already credited is kept.</p>
        </Panel>
      )}
      <DepositLoansPanel companyId={companyId} />
      {ours ? (
        <OurBank key={ours.company_id} bank={ours} deposits={held} terms={clientTerms} onDone={refresh} />
      ) : (
        banks && <CharterPanel vaults={vaults} autopilot={fleet.running} onDone={refresh} />
      )}
    </div>
  );
}
