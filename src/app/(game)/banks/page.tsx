"use client";

import { useState } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Empty, ErrorNote, KV, Loading, Metrics, PageHeader, Panel, Table } from "@/components/kibb/bits";
import {
  BANK,
  CashLine,
  CompanyLabel,
  CreditRecordView,
  RateText,
  WarnBox,
  crToPence,
  firstProblem,
  num,
  regionName,
  useCompanyDirectory,
  useFleetFinance,
  useLearnCompanies,
  useVaults,
} from "@/components/kibb/finance-common";
import { Checkbox, useCompanyId, useOurCompanyIds } from "@/components/kibb/naval-common";
import { Field, RegionSelect } from "@/components/kibb/pickers";
import { useAction } from "@/hooks/use-action";
import { usePoll } from "@/hooks/use-poll";
import { kibbGet, kibbPost } from "@/lib/kibb/browser";
import { fmtCr, fmtDateTime, fmtGameHours } from "@/lib/kibb/format";
import type * as S from "@/lib/kibb/schema";

type Vaults = ReturnType<typeof useVaults>;

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
        Interest is credited daily. Deposits are exempt from the wealth levy. {bank.insured
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

function WithdrawForm({ deposit, onDone, onClose }: { deposit: S.DepositResult; onDone: () => void; onClose: () => void }) {
  const [amount, setAmount] = useState("");
  const act = useAction<S.DepositResult>(onDone);
  const all = amount.trim() === "";
  const a = all ? deposit.balance_pence : crToPence(amount);
  const why = all
    ? deposit.balance_pence > 0
      ? null
      : "Nothing left to withdraw."
    : firstProblem([
        [a > 0, "Enter an amount, or leave it empty to withdraw everything."],
        [a <= deposit.balance_pence, `The balance is ${fmtCr(deposit.balance_pence, 2)}.`],
      ]);

  function submit() {
    const when =
      deposit.notice_game_hours > 0
        ? `A notice deposit is paid after its ${fmtGameHours(deposit.notice_game_hours)} notice.`
        : "Paid at once as far as the bank's cash reaches; the rest stays owed and falls due now.";
    if (!confirm(`Withdraw ${all ? `everything (${fmtCr(deposit.balance_pence, 2)})` : fmtCr(a, 2)} from ${deposit.bank_name}? ${when}`)) return;
    void act.run(() => kibbPost<S.DepositResult>("/v1/bank/withdraw", all ? { deposit_id: deposit.id } : { deposit_id: deposit.id, amount_pence: a }));
  }

  return (
    <div className="space-y-3">
      <KV
        rows={[
          ["Bank", deposit.bank_name],
          ["Balance", fmtCr(deposit.balance_pence, 2)],
          ["Kind", deposit.notice_game_hours > 0 ? `notice (${fmtGameHours(deposit.notice_game_hours)})` : "on demand"],
          ["Already asked for", fmtCr(deposit.pending_withdrawal_pence, 2)],
        ]}
      />
      <Field label="Amount (Cr): empty withdraws everything">
        <Input type="number" min={0.01} step={0.01} value={amount} placeholder={(deposit.balance_pence / 100).toFixed(2)} onChange={(e) => setAmount(e.target.value)} />
      </Field>
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

function DepositsPanel({ deposits, error, companyId, onDone }: { deposits: S.DepositResult[] | undefined; error: Error | null; companyId: string | undefined; onDone: () => void }) {
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
                  <RateText bps={d.daily_rate_bps} />
                </td>
                <td className="whitespace-nowrap text-xs">{d.notice_game_hours > 0 ? `notice ${fmtGameHours(d.notice_game_hours)}` : "demand"}</td>
                <td className="tabular-nums">{d.pending_withdrawal_pence > 0 ? fmtCr(d.pending_withdrawal_pence) : "—"}</td>
                <td>
                  <span className="inline-flex flex-wrap gap-1">
                    <Badge variant={d.status === "open" ? "secondary" : "outline"} size="sm">{d.status}</Badge>
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
          <WithdrawForm key={deposit.id} deposit={deposit} onDone={onDone} onClose={() => setSelected(null)} />
        ) : (
          <p className="text-muted-foreground text-sm">
            Pick a deposit. A demand deposit is paid at once as far as the bank&apos;s cash reaches, the rest owed now; a notice deposit after its notice. A bank
            that leaves a withdrawal unpaid for a game day fails.
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
}

function termsProblem(t: Terms): string | null {
  const d = num(t.demand);
  const n = num(t.notice);
  const h = num(t.hours);
  return firstProblem([
    [Number.isInteger(d) && d >= 0 && d <= BANK.rateMaxBps, `Demand rate: 0 to ${BANK.rateMaxBps} bps a game day.`],
    [Number.isInteger(n) && n >= 0 && n <= BANK.rateMaxBps, `Notice rate: 0 to ${BANK.rateMaxBps} bps a game day.`],
    [Number.isInteger(h) && h >= 1 && h <= BANK.noticeHoursMax, `Notice: 1 to ${BANK.noticeHoursMax} game hours.`],
  ]);
}

const termsBody = (t: Terms): S.BankTermsRequest => ({
  demand_rate_bps: num(t.demand),
  notice_rate_bps: num(t.notice),
  notice_game_hours: num(t.hours),
  insured: t.insured,
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
    </div>
  );
}

function OurBank({ bank, deposits, onDone }: { bank: S.BankResult; deposits: S.DepositResult[]; onDone: () => void }) {
  const [terms, setTerms] = useState<Terms>({
    demand: String(bank.demand_rate_bps),
    notice: String(bank.notice_rate_bps),
    hours: String(bank.notice_game_hours),
    insured: bank.insured,
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
                <td className="tabular-nums">{fmtCr(d.balance_pence)}</td>
                <td>
                  <RateText bps={d.daily_rate_bps} />
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
                confirm(`Set new deposits to ${terms.demand} bps on demand and ${terms.notice} bps on ${terms.hours} game hours' notice${terms.insured ? ", insured" : ", uninsured"}? Existing deposits keep their terms.`) &&
                void act.run(() => kibbPost<S.BankResult>("/v1/bank/terms", termsBody(terms)))
              }
            >
              {act.busy ? "Saving…" : "Change terms"}
            </Button>
          </div>
        </Panel>
        <Panel title="Wind down">
          <div className="space-y-3 text-sm">
            <p className="text-muted-foreground">
              Stops deposits, lending and underwriting. Every game day all the bank&apos;s cash goes to depositors pro rata as its loans come in; once nothing is lent
              out it closes, or goes into receivership if it can&apos;t pay everyone. It can&apos;t be undone.
            </p>
            <Button
              variant="destructive"
              className="w-full"
              disabled={act.busy || !open}
              onClick={() =>
                confirm(
                  `Wind down ${bank.name}? It stops all new business and pays out its depositors (${fmtCr(bank.deposits_pence)} owed) pro rata as loans come in. This cannot be undone, and a company whose failed bank still owes depositors can never charter again.`,
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

function CharterPanel({ vaults, autopilot, onDone }: { vaults: Vaults; autopilot: boolean; onDone: () => void }) {
  const [terms, setTerms] = useState<Terms>({ demand: "5", notice: "10", hours: "48", insured: true });
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

export default function BanksPage() {
  useCompanyDirectory();
  const companyId = useCompanyId();
  const ourIds = useOurCompanyIds();
  const fleet = useFleetFinance();
  const vaults = useVaults();
  const { data: banks, error, reload } = usePoll(() => kibbGet<S.BankResult[]>("/v1/bank/list"), 30_000);
  const { data: deposits, error: depositsError, reload: reloadDeposits } = usePoll(() => kibbGet<S.DepositResult[]>("/v1/bank/deposits"), 30_000);
  useLearnCompanies(banks?.map((b) => [b.company_id, b.name] as [string, string]));
  const [picked, setPicked] = useState<{ id: string; mode: "deposit" | "status" } | null>(null);
  const refresh = () => {
    void reload();
    void reloadDeposits();
    void vaults.reload();
  };
  const ours = banks?.find((b) => b.company_id === companyId);
  const bank = banks?.find((b) => b.company_id === picked?.id);
  const mine = (deposits ?? []).filter((d) => d.depositor_company_id === companyId);
  const held = (deposits ?? []).filter((d) => d.bank_company_id === companyId && d.depositor_company_id !== companyId);
  const balance = mine.filter((d) => d.status === "open").reduce((n, d) => n + d.balance_pence, 0);
  const pending = mine.reduce((n, d) => n + d.pending_withdrawal_pence, 0);
  const troubled = (banks ?? []).filter((b) => health(b).variant === "error" || health(b).variant === "warning");

  return (
    <div className="space-y-5 pb-8 sm:space-y-6">
      <PageHeader title="Banks" subtitle="Player banks take deposits at daily rates and lend them out. Judge a bank's reserves, insurance and overdue withdrawals before depositing." />
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
            <Table head={["Bank", "Region", "Status", "Demand", "Notice", "Deposits", "Reserves", "Lent", "Overdue", ""]}>
              {banks.map((b) => {
                const h = health(b);
                const below = b.reserves_pence < b.required_reserve_pence;
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
            Reserves are the bank&apos;s vault cash against the Crown&apos;s 20% of deposits. A bank that leaves a withdrawal unpaid for a game day fails.
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
      <DepositsPanel deposits={deposits} error={depositsError} companyId={companyId} onDone={refresh} />
      {ours ? <OurBank key={ours.company_id} bank={ours} deposits={held} onDone={refresh} /> : banks && <CharterPanel vaults={vaults} autopilot={fleet.running} onDone={refresh} />}
    </div>
  );
}
