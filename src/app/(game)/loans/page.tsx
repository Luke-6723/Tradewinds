"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsPanel, TabsTab } from "@/components/ui/tabs";
import { Empty, ErrorNote, KV, Loading, Metrics, NativeSelect, PageHeader, Panel, Table } from "@/components/kibb/bits";
import { LoadMore, usePaged } from "@/components/kibb/company-paged";
import {
  AnnualRateText,
  CashLine,
  COLLATERAL_LABEL,
  CollateralText,
  CompanyLabel,
  CreditRecordView,
  DEFAULT_WARNING,
  EMPTY_PLEDGE,
  GOLDSMITHS_DEFAULT_WARNING,
  isGoldsmithsInstant,
  WALK_AWAY_BAN_WARNING,
  type FleetFinance,
  LOAN,
  LoanRateText,
  LoanStatusBadge,
  MortgageBadge,
  type Pledge,
  PledgeFields,
  WarnBox,
  crToPence,
  firstProblem,
  interestFor,
  loansOf,
  num,
  pledgeBody,
  pledgeProblem,
  pledgeableDeposit,
  regionName,
  shortId,
  useCompanyDirectory,
  useCompanyNames,
  useFleetFinance,
  useLearnCompanies,
  usePledgedShips,
  useRegionOf,
  useShips,
  useStock,
  useVaults,
} from "@/components/kibb/finance-common";
import { Checkbox, Segmented, useCompanyId, useOurCompanyIds } from "@/components/kibb/naval-common";
import { Field, RegionSelect, ShipSelect } from "@/components/kibb/pickers";
import { useAction } from "@/hooks/use-action";
import { useCatalog } from "@/hooks/use-catalog";
import { usePoll } from "@/hooks/use-poll";
import { DashboardApiError, kibbGet, kibbPost } from "@/lib/kibb/browser";
import { creditBlemishes, goldsmithsAnnualBps } from "@/lib/kibb/fleet/finance";
import { fmtCr, fmtDateTime, fmtIn, fmtTons } from "@/lib/kibb/format";
import type * as S from "@/lib/kibb/schema";
import type { CompanyProfile, ShipResult } from "@/lib/kibb/types";

type Vaults = ReturnType<typeof useVaults>;
type Pledged = ReturnType<typeof usePledgedShips>;

const STATUSES: S.LoanStatus[] = ["active", "repaid", "defaulted", "recovered", "written_off", "offered", "withdrawn", "declined", "lapsed"];
const REQUEST_KINDS: S.CollateralKind[] = ["ship_lien", "warehouse_goods", "contract_receivable", "deposit", "unsecured"];
const REPAYMENTS: Array<{ value: S.LoanRepayment; label: string }> = [
  { value: "balloon", label: "Balloon" },
  { value: "amortised", label: "Amortised" },
];

/** A rate typed as % a year → annual bps (NaN stays NaN). */
const pctToBps = (v: string) => Math.round(num(v) * 100);

/** "% a year" for a confirm box. */
const pctText = (bps: number) => `${(bps / 100).toLocaleString("en-GB", { maximumFractionDigits: 2 })}% a year`;

/** "matures in …" (active), when it defaulted, or when it closed. */
function whenText(l: S.Loan): string {
  if (l.status === "offered") return `offer lapses ${fmtIn(l.offer_expires_at)}`;
  if (l.status === "active") return l.matures_at ? `matures ${fmtIn(l.matures_at)}` : "—";
  if (l.status === "defaulted") return `defaulted ${l.defaulted_at ? fmtDateTime(l.defaulted_at) : ""}`;
  return l.closed_at ? `closed ${fmtDateTime(l.closed_at)}` : fmtDateTime(l.updated_at);
}

/** Within 2 game days of maturity (1 game day = 24 real min at 60×): the autopilot's must-repay window. */
function soon(l: S.Loan): boolean {
  return l.status === "active" && !!l.matures_at && Date.parse(l.matures_at) - Date.now() < 2 * 24 * 60_000;
}

/** The next payment on an active loan: arrears (with when the loan defaults), else the next installment or what maturity takes. */
function NextPayment({ loan }: { loan: S.Loan }) {
  if (loan.status !== "active") return <span className="text-muted-foreground">—</span>;
  if (loan.arrears_pence > 0) {
    return (
      <span className="text-destructive text-xs">
        {fmtCr(loan.arrears_pence)} in arrears{loan.arrears_due_by ? `: defaults ${fmtIn(loan.arrears_due_by)}` : ""}
      </span>
    );
  }
  if (!loan.next_payment_due_at || loan.next_payment_pence == null) return <span className="text-muted-foreground">—</span>;
  return (
    <span className="whitespace-nowrap text-xs">
      {fmtCr(loan.next_payment_pence)} {fmtIn(loan.next_payment_due_at)}
    </span>
  );
}

/** A request's pledge in words (the borrower's ship is shown by id: other companies' ships aren't public). */
function RequestPledge({ r }: { r: S.LoanRequestView }) {
  const { portName, goodName } = useCatalog();
  return (
    <span className="text-xs">
      {r.collateral_kind === "warehouse_goods"
        ? `${fmtTons(r.collateral_tons ?? 0)} ${goodName(r.collateral_commodity_id)} at ${portName(r.collateral_port_id)}`
        : r.collateral_kind === "ship_lien"
          ? `Lien on ship ${shortId(r.collateral_ship_id)}`
          : r.collateral_kind === "contract_receivable"
            ? `Receivable on contract ${shortId(r.collateral_contract_id)}`
            : r.collateral_kind === "deposit"
              ? `Bank deposit ${shortId(r.collateral_deposit_id)}`
              : COLLATERAL_LABEL[r.collateral_kind]}
      {!r.recourse && <span className="text-muted-foreground"> · non-recourse</span>}
    </span>
  );
}

function AutopilotTag({ fleet, loanId }: { fleet: FleetFinance; loanId: string }) {
  const purpose = fleet.purposeOf(loanId);
  if (!purpose) return null;
  return (
    <Badge variant="warning" size="sm" title={`Taken by the fleet autopilot for ${purpose}`}>
      autopilot
    </Badge>
  );
}

// ── Our loans ─────────────────────────────────────────────────────────────────

function RepayForm({ loan, cash, fleet, onDone, onClose }: { loan: S.Loan; cash: number | undefined; fleet: FleetFinance; onDone: () => void; onClose: () => void }) {
  const names = useCompanyNames();
  const [amount, setAmount] = useState("");
  const act = useAction<S.Loan>(onDone);
  const walk = useAction<S.Loan>(onDone);
  const all = amount.trim() === "";
  const pence = all ? loan.owed_pence : crToPence(amount);
  const purpose = fleet.purposeOf(loan.id);
  const goldsmiths = isGoldsmithsInstant(loan);
  const why = all ? null : firstProblem([
    [pence > 0, "Enter an amount, or leave it empty to repay everything owed."],
    [pence <= loan.owed_pence, `Only ${fmtCr(loan.owed_pence, 2)} is owed.`],
  ]);

  function submit() {
    const ap = purpose
      ? fleet.running
        ? `\n\nThe fleet autopilot took this loan (${purpose}) and repays it itself: early when cash allows, in full 2 game days before maturity. Repay it by hand anyway?`
        : `\n\nThe fleet autopilot took this loan (${purpose}) but is stopped, so it won't repay it.`
      : "";
    if (!confirm(`Repay ${all ? `everything owed (${fmtCr(loan.owed_pence, 2)})` : fmtCr(pence, 2)} to ${names.label(loan.lender_company_id)} from your ${regionName(loan.banking_region)} vault?${ap}`)) return;
    void act.run(() => kibbPost<S.Loan>("/v1/loan/repay", all ? { loan_id: loan.id } : { loan_id: loan.id, amount_pence: pence }));
  }

  function walkAway() {
    const terms = goldsmiths
      ? `This is a Goldsmiths' instant loan. ${GOLDSMITHS_DEFAULT_WARNING} Walking away writes nothing off here: you keep owing the rest.`
      : "The lender takes its collateral as at any default (a liened ship is arrested until it changes hands, credited at 80% of its rebuild value, any surplus paid to you); whatever that leaves owed is written off, recourse or not, and you keep your cash.";
    if (
      !confirm(
        `Walk away from this loan (${fmtCr(loan.owed_pence, 2)} owed to ${names.label(loan.lender_company_id)})?\n\n${terms}\n\nIt is PERMANENT on your public credit record (loans walked away from, and what the lender lost), shown to every lender on each request you post. ${WALK_AWAY_BAN_WARNING}`,
      ) ||
      !confirm("Last check: walking away can't be undone. Walk away?")
    )
      return;
    void walk.run(() => kibbPost<S.Loan>("/v1/loan/default", { loan_id: loan.id }));
  }

  return (
    <div className="space-y-3">
      <KV
        rows={[
          ["Lender", <CompanyLabel key="l" id={loan.lender_company_id} />],
          ["Owed now", fmtCr(loan.owed_pence, 2)],
          ["Principal outstanding", fmtCr(loan.outstanding_principal_pence, 2)],
          ["Interest accrued", fmtCr(loan.accrued_interest_pence, 2)],
          ["Rate", <LoanRateText key="r" loan={loan} />],
          ["Repayment", loan.repayment === "amortised" ? `amortised: ${fmtCr(loan.installment_pence ?? 0)} every ${LOAN.installmentEveryDays} game days` : "balloon: all at maturity"],
          ["Next payment", <NextPayment key="n" loan={loan} />],
          ...(loan.total_repayable_pence != null ? ([["Total repayable on schedule", fmtCr(loan.total_repayable_pence)]] as Array<[string, string]>) : []),
          ["Matures", loan.matures_at ? `${fmtDateTime(loan.matures_at)} (${fmtIn(loan.matures_at)})` : "—"],
        ]}
      />
      {purpose && (
        <WarnBox>
          {fleet.running
            ? `The fleet autopilot took this loan (${purpose}) and repays it itself, in full 2 game days before maturity at the latest.`
            : `The fleet autopilot took this loan (${purpose}) but is stopped: repay it yourself before it matures.`}
        </WarnBox>
      )}
      {loan.is_mortgage && (
        <WarnBox tone="info">
          A ship mortgage, taken with a build: its installments are collected as they fall due. Repaying early costs no penalty and frees the ship to be listed, sold
          or pledged again, and lets you take another mortgage (one at a time).
        </WarnBox>
      )}
      {loan.status === "defaulted" && (
        <WarnBox tone="error">Defaulted: the lender is collecting. Paying it down clears the claim, and paying it off releases a ship arrested for it.</WarnBox>
      )}
      {loan.status === "active" && loan.arrears_pence > 0 && (
        <WarnBox tone="error">
          An installment of {fmtCr(loan.arrears_pence)} is in arrears: unpaid {loan.arrears_due_by ? fmtIn(loan.arrears_due_by) : "after its day of grace"}, the whole loan defaults.
          A payment counts first toward it.
        </WarnBox>
      )}
      <Field label="Amount (Cr): empty repays everything owed">
        <Input type="number" min={0.01} step={0.01} value={amount} placeholder={(loan.owed_pence / 100).toFixed(2)} onChange={(e) => setAmount(e.target.value)} />
      </Field>
      <CashLine region={loan.banking_region} cash={cash} need={pence} />
      <p className="text-muted-foreground text-xs">
        Arrears first, then interest to date, then principal; no penalty for repaying early. Paid in full, the loan closes and its collateral is released.
      </p>
      <ErrorNote error={act.error ?? walk.error ?? why} />
      {act.result && <p className="text-sm">Done: {fmtCr(act.result.owed_pence, 2)} still owed ({act.result.status}).</p>}
      {walk.result && (
        <p className="text-sm">
          {goldsmiths
            ? "Walked away: the Goldsmiths take the ship at its break-up value (35% of rebuild, no surplus); the rest is still owed and collected from your vaults."
            : "Walked away: the lender takes the collateral; the rest is written off."}
        </p>
      )}
      <div className="flex gap-2">
        <Button className="flex-1" disabled={!!why || act.busy} onClick={submit}>
          {act.busy ? "Repaying…" : all ? "Repay in full" : `Repay ${fmtCr(pence, 2)}`}
        </Button>
        <Button variant="outline" onClick={onClose}>
          Close
        </Button>
      </div>
      {!loan.walked_away_at && (
        <div className="border-t pt-3">
          <Button size="sm" variant="ghost" className="text-destructive" disabled={walk.busy} onClick={walkAway}>
            {walk.busy ? "Walking away…" : "Walk away from this loan…"}
          </Button>
          <p className="mt-1 text-muted-foreground text-xs">
            {goldsmiths
              ? "Defaults by choice on a Goldsmiths' instant loan: they take the ship at its break-up value (35% of rebuild, no surplus) and the rest stays owed, with a permanent mark on your credit record."
              : "Defaults by choice: the collateral goes to the lender and the rest is written off for good, at the cost of a permanent mark on your credit record."}{" "}
            The Goldsmiths then lend to none of your companies for a real day. The autopilot never does this.
          </p>
        </div>
      )}
    </div>
  );
}

function OwedPanel({
  loans,
  error,
  vaults,
  fleet,
  shipName,
  onDone,
}: {
  loans: S.Loan[] | undefined;
  error: Error | null;
  vaults: Vaults;
  fleet: FleetFinance;
  shipName: (id: string) => string | undefined;
  onDone: () => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const loan = loans?.find((l) => l.id === selected);
  return (
    <div className="grid items-start gap-4 xl:grid-cols-3">
      <Panel title="What you owe" className="xl:col-span-2">
        <ErrorNote error={error} />
        {!loans ? (
          !error && <Loading />
        ) : loans.length === 0 ? (
          <Empty>You owe no loans.</Empty>
        ) : (
          <Table head={["Lender", "Region", "Owed", "Rate", "Next payment", "Due", "Collateral", "Status", ""]}>
            {loans.map((l) => (
              <tr key={l.id} className={l.id === selected ? "bg-accent" : undefined}>
                <td>
                  <span className="inline-flex flex-wrap items-center gap-1">
                    <CompanyLabel id={l.lender_company_id} />
                    <MortgageBadge loan={l} />
                    <AutopilotTag fleet={fleet} loanId={l.id} />
                  </span>
                </td>
                <td className="capitalize">{regionName(l.banking_region)}</td>
                <td className="tabular-nums">
                  <span className="font-medium">{fmtCr(l.owed_pence)}</span>
                  <div className="text-muted-foreground text-xs">
                    of {fmtCr(l.principal_pence)}
                    {l.total_repayable_pence != null && `; ${fmtCr(l.total_repayable_pence)} in all`}
                  </div>
                </td>
                <td>
                  <LoanRateText loan={l} />
                  <div className="text-muted-foreground text-xs">{l.repayment}</div>
                </td>
                <td>
                  <NextPayment loan={l} />
                </td>
                <td className={`whitespace-nowrap text-xs ${soon(l) ? "text-destructive" : ""}`}>{whenText(l)}</td>
                <td>
                  <CollateralText loan={l} shipName={shipName} />
                </td>
                <td>
                  <LoanStatusBadge status={l.status} />
                </td>
                <td className="text-right">
                  <Button size="sm" variant={l.status === "defaulted" || l.arrears_pence > 0 ? "destructive" : "outline"} onClick={() => setSelected(l.id)}>
                    Repay
                  </Button>
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Panel>
      <Panel title={loan ? "Repay" : "Repaying"}>
        {loan ? (
          <RepayForm key={loan.id} loan={loan} cash={vaults.cash(loan.banking_region)} fleet={fleet} onDone={onDone} onClose={() => setSelected(null)} />
        ) : (
          <div className="space-y-2 text-muted-foreground text-sm">
            <p>
              Pick a loan to repay early: interest is paid only to date. An amortised loan&apos;s installments are taken from your vaults as they fall due; at
              maturity whatever is owed is taken, that region first.
            </p>
            <p>{DEFAULT_WARNING}</p>
            <p>{GOLDSMITHS_DEFAULT_WARNING}</p>
          </div>
        )}
      </Panel>
    </div>
  );
}

function LentPanel({ loans, error, companyId, ourIds, onCredit }: { loans: S.Loan[] | undefined; error: Error | null; companyId: string | undefined; ourIds: Set<string>; onCredit: (id: string) => void }) {
  return (
    <Panel title="What you lent">
      <ErrorNote error={error} />
      {!loans ? (
        !error && <Loading />
      ) : loans.length === 0 ? (
        <Empty>No loans out. Quote on a request under Lend.</Empty>
      ) : (
        <Table head={["Borrower", "Region", "Owed to you", "Rate", "Next payment", "When", "Collateral", "Status", ""]}>
          {loans.map((l) => (
            <tr key={l.id}>
              <td>
                <span className="inline-flex flex-wrap items-center gap-1">
                  <CompanyLabel id={l.borrower_company_id} companyId={companyId} ourIds={ourIds} />
                  <MortgageBadge loan={l} />
                </span>
              </td>
              <td className="capitalize">{regionName(l.banking_region)}</td>
              <td className="tabular-nums">
                {fmtCr(l.owed_pence)}
                <div className="text-muted-foreground text-xs">of {fmtCr(l.principal_pence)}</div>
              </td>
              <td>
                <LoanRateText loan={l} />
              </td>
              <td>
                <NextPayment loan={l} />
              </td>
              <td className="whitespace-nowrap text-xs">{whenText(l)}</td>
              <td>
                <CollateralText loan={l} />
              </td>
              <td>
                <LoanStatusBadge status={l.status} />
              </td>
              <td className="text-right">
                <Button size="sm" variant="ghost" onClick={() => onCredit(l.borrower_company_id)}>
                  Credit
                </Button>
              </td>
            </tr>
          ))}
        </Table>
      )}
      <p className="mt-3 text-muted-foreground text-xs">
        A borrower that misses maturity (or an installment&apos;s day of grace) defaults: you take a liened ship (credited at {LOAN.foreclosureCreditPct}% of its rebuild
        value; you pay the borrower any surplus) or the pledged goods, and with recourse the rest is collected from its vaults daily. A non-recourse shortfall is
        forgiven, and so is anything a borrower that walks away leaves owed. An insured liened ship that is lost pays you first.
      </p>
    </Panel>
  );
}

function HistoryPanel({ refreshKey, companyId, shipName }: { refreshKey: number; companyId: string | undefined; shipName: (id: string) => string | undefined }) {
  const [role, setRole] = useState("");
  const [status, setStatus] = useState("");
  const page = usePaged<S.Loan>((cursor, limit) => kibbGet<S.Loan[]>("/v1/loan/list", { role, status, cursor, limit }), [role, status, refreshKey]);
  return (
    <Panel
      title="All loans"
      action={
        <>
          <div className="w-full sm:w-32">
            <NativeSelect value={role} onChange={(e) => setRole(e.target.value)}>
              <option value="">Both sides</option>
              <option value="borrower">Borrowed</option>
              <option value="lender">Lent</option>
            </NativeSelect>
          </div>
          <div className="w-full sm:w-36">
            <NativeSelect value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">Any status</option>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s.replace("_", " ")}
                </option>
              ))}
            </NativeSelect>
          </div>
        </>
      }
    >
      <ErrorNote error={page.error} />
      {page.items.length === 0 ? (
        page.loading ? <Loading /> : <Empty>No loans.</Empty>
      ) : (
        <Table head={["Side", "Counterparty", "Region", "Principal", "Rate", "Term", "Interest paid", "Collateral", "Status", "When"]}>
          {page.items.map((l) => {
            const borrowed = l.borrower_company_id === companyId;
            return (
              <tr key={l.id}>
                <td>{borrowed ? "Borrowed" : "Lent"}</td>
                <td>
                  <CompanyLabel id={borrowed ? l.lender_company_id : l.borrower_company_id} />
                </td>
                <td className="capitalize">{regionName(l.banking_region)}</td>
                <td className="tabular-nums">{fmtCr(l.principal_pence)}</td>
                <td>
                  <LoanRateText loan={l} />
                </td>
                <td className="whitespace-nowrap">
                  {l.term_game_days} days
                  {l.repayment === "amortised" && <div className="text-muted-foreground text-xs">amortised</div>}
                </td>
                <td className="tabular-nums">{fmtCr(l.interest_paid_pence)}</td>
                <td>
                  <CollateralText loan={l} shipName={shipName} />
                </td>
                <td>
                  <LoanStatusBadge status={l.status} />
                  {l.is_mortgage && (
                    <span className="ml-1">
                      <MortgageBadge loan={l} />
                    </span>
                  )}
                  {l.walked_away_at && (
                    <Badge variant="error" size="sm" className="ml-1">
                      walked away
                    </Badge>
                  )}
                </td>
                <td className="whitespace-nowrap text-muted-foreground text-xs">{whenText(l)}</td>
              </tr>
            );
          })}
        </Table>
      )}
      <LoadMore loading={page.loading} done={page.done} onClick={page.loadMore} count={page.items.length} />
    </Panel>
  );
}

// ── Borrowing: the Goldsmiths' instant quote ──────────────────────────────────

function GoldsmithsPanel({
  ships,
  pledged,
  vaults,
  fleet,
  onDone,
}: {
  ships: ShipResult[] | undefined;
  pledged: Pledged;
  vaults: Vaults;
  fleet: FleetFinance;
  onDone: () => void;
}) {
  const [shipId, setShipId] = useState("");
  const [region, setRegion] = useState("");
  const [principal, setPrincipal] = useState("");
  const [term, setTerm] = useState("30");
  const [repayment, setRepayment] = useState<S.LoanRepayment>("balloon");
  // The ship the shown quote was asked for: choosing another hides it.
  const [askedFor, setAskedFor] = useState("");
  const ask = useAction<S.GoldsmithsQuote>();
  const take = useAction<S.Loan>(() => {
    ask.reset();
    onDone();
  });
  const p = crToPence(principal);
  const t = num(term);
  const lien = pledged.byShip.get(shipId);
  const ship = ships?.find((r) => r.ship.id === shipId);
  const q = ask.result && askedFor === shipId ? ask.result : null;
  const lapsed = q ? Date.parse(q.quote.expires_at) <= Date.now() : false;
  const why = firstProblem([
    [!!shipId, "Choose a ship to pledge."],
    [!lien, "That ship is already under a lien."],
    [p >= LOAN.minPrincipalPence, `Borrow at least ${fmtCr(LOAN.minPrincipalPence)}.`],
    [p <= LOAN.goldsmithsMaxPence, `The Goldsmiths lend at most ${fmtCr(LOAN.goldsmithsMaxPence)} a loan.`],
    [Number.isInteger(t) && t >= 1 && t <= LOAN.termMaxDays, `Term: 1 to ${LOAN.termMaxDays} game days.`],
  ]);
  const est = Number.isInteger(t) && t >= 1 && t <= LOAN.termMaxDays ? goldsmithsAnnualBps(t) : null;

  function quote() {
    setAskedFor(shipId);
    void ask.run(() =>
      kibbGet<S.GoldsmithsQuote>("/v1/loan/quote", { principal_pence: p, term_game_days: t, repayment, ship_id: shipId, ...(region ? { banking_region: region } : {}) }),
    );
  }

  function accept() {
    if (!q) return;
    const x = q.quote;
    if (
      !confirm(
        `Borrow ${fmtCr(x.principal_pence)} from ${x.lender_name} in ${regionName(x.banking_region)} at ${pctText(x.annual_rate_bps)} for ${x.term_game_days} game days, ${x.repayment === "amortised" ? `amortised (${fmtCr(x.installment_pence ?? 0)} every ${LOAN.installmentEveryDays} game days)` : "balloon (all at maturity)"}: ${fmtCr(x.total_repayable_pence)} repaid in all, against a lien on ${ship?.ship.name ?? "this ship"}? With recourse: what the ship doesn't cover is claimed from your vaults.\n\n${GOLDSMITHS_DEFAULT_WARNING}`,
      )
    )
      return;
    void take.run(() => kibbPost<S.Loan>("/v1/loan/accept-quote", { quote_id: x.id }));
  }

  return (
    <Panel title="Borrow from the Goldsmiths' Company">
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Ship to pledge">
            <ShipSelect ships={ships} value={shipId} onChange={setShipId} placeholder="Choose a ship…" filter={(r) => !pledged.byShip.has(r.ship.id)} />
          </Field>
          <Field label="Region (paid into and repaid from)">
            <RegionSelect value={region} onChange={setRegion} placeholder="Home region" />
          </Field>
          <Field label="Principal (Cr)">
            <Input type="number" min={100} max={LOAN.goldsmithsMaxPence / 100} step={0.01} value={principal} onChange={(e) => setPrincipal(e.target.value)} />
          </Field>
          <Field label={`Term (1–${LOAN.termMaxDays} game days)`}>
            <Input type="number" min={1} max={LOAN.termMaxDays} step={1} value={term} onChange={(e) => setTerm(e.target.value)} />
          </Field>
        </div>
        <Segmented value={repayment} onChange={setRepayment} options={REPAYMENTS} />
        {est !== null && (
          <p className="text-muted-foreground text-xs">
            The Goldsmiths charge {pctText(est)} for {t} game days{p > 0 ? `: about ${fmtCr(interestFor(p, est, t))} interest on ${fmtCr(p)} held to maturity` : ""}.
          </p>
        )}
        {shipId && fleet.ships.has(shipId) && (
          <WarnBox>
            The fleet autopilot sails this ship. A lien doesn&apos;t stop it sailing, but the ship can&apos;t be sold, listed or pledged again until repaid. The
            autopilot counts this loan against its debt cap and keeps back what it owes.
          </WarnBox>
        )}
        <ErrorNote error={ask.error ?? take.error ?? (shipId || principal ? why : null)} />
        <Button className="w-full" variant={q ? "outline" : "default"} disabled={!!why || ask.busy} onClick={quote}>
          {ask.busy ? "Asking…" : q ? "Quote again" : "Get a quote"}
        </Button>
        {q && (
          <div className="space-y-3 rounded-md border p-3">
            <KV
              rows={[
                ["Lender", q.quote.lender_name],
                ["Rate", <AnnualRateText key="r" bps={q.quote.annual_rate_bps} />],
                ["Principal", `${fmtCr(q.quote.principal_pence)} for ${q.quote.term_game_days} game days, ${q.quote.repayment}`],
                ...(q.quote.repayment === "amortised" ? ([["Installment", `${fmtCr(q.quote.installment_pence ?? 0)} every ${LOAN.installmentEveryDays} game days`]] as Array<[string, string]>) : []),
                ["Repaid in all", fmtCr(q.quote.total_repayable_pence)],
                ["Ship's rebuild value", fmtCr(q.rebuild_value_pence)],
                ["Lends up to", `${fmtCr(q.max_principal_pence)} on her (${q.loan_to_value_bps / 100}% of rebuild, ${fmtCr(LOAN.goldsmithsMaxPence)} a loan at most)`],
                ["Quote stands", lapsed ? "lapsed: quote again" : fmtIn(q.quote.expires_at)],
              ]}
            />
            <CashLine region={q.quote.banking_region} cash={vaults.cash(q.quote.banking_region)} />
            {take.result && (
              <p className="text-sm">
                Borrowed {fmtCr(take.result.principal_pence)}; it matures {fmtIn(take.result.matures_at)}.
              </p>
            )}
            <Button className="w-full" disabled={lapsed || take.busy || !!lien} onClick={accept}>
              {take.busy ? "Borrowing…" : "Take this quote"}
            </Button>
          </div>
        )}
        <p className="text-muted-foreground text-xs">
          One house per region lends against one of your ships at once: at most {LOAN.goldsmithsLtvBps / 100}% of her rebuild value and {fmtCr(LOAN.goldsmithsMaxPence)} a loan,
          always with recourse, at 45% a year for up to 30 game days sliding to 30% at 360. Dear on purpose: a player lender may quote less on a request. A quote
          stands {LOAN.quoteGameHours} game hours. A liened ship can still sail, but can&apos;t be listed, sold, pledged again or carry a venture until repaid; insured and lost,
          the claim pays the lender first. On a default they take her at only {LOAN.goldsmithsForeclosureCreditPct}% of her rebuild value (the break-up price), pay no
          surplus, and the rest stays owed. After any walk-away (yours or a linked company&apos;s) they quote and lend nothing for a real day.
        </p>
      </div>
    </Panel>
  );
}

// ── Borrowing: requests for quotes ────────────────────────────────────────────

function RequestForm({
  homeRegion,
  ships,
  stock,
  deposits,
  pledged,
  fleet,
  onDone,
}: {
  homeRegion: string;
  ships: ShipResult[] | undefined;
  stock: S.PortWarehouseResult[] | undefined;
  /** Our own open deposits not already pledged. */
  deposits: S.DepositResult[] | undefined;
  pledged: Pledged;
  fleet: FleetFinance;
  onDone: () => void;
}) {
  const [region, setRegion] = useState("");
  const [principal, setPrincipal] = useState("");
  const [term, setTerm] = useState("30");
  const [repayment, setRepayment] = useState<S.LoanRepayment>("balloon");
  const [kind, setKind] = useState<S.CollateralKind>("ship_lien");
  const [pledge, setPledge] = useState<Pledge>(EMPTY_PLEDGE);
  const [recourse, setRecourse] = useState(true);
  const [hours, setHours] = useState(String(LOAN.requestHoursDefault));
  const act = useAction<S.LoanRequestView>(onDone);
  const at = region || homeRegion;
  const p = crToPence(principal);
  const t = num(term);
  const h = num(hours);
  const why = firstProblem([
    [p >= LOAN.minPrincipalPence, `Ask for at least ${fmtCr(LOAN.minPrincipalPence)}.`],
    [Number.isInteger(t) && t >= 1 && t <= LOAN.termMaxDays, `Term: 1 to ${LOAN.termMaxDays} game days.`],
    [pledgeProblem(kind, pledge) === null, pledgeProblem(kind, pledge) ?? ""],
    [Number.isInteger(h) && h >= 1 && h <= LOAN.requestHoursMax, `Open for 1 to ${LOAN.requestHoursMax} game hours.`],
  ]);
  const gs = Number.isInteger(t) && t >= 1 && t <= LOAN.termMaxDays ? goldsmithsAnnualBps(t) : null;

  function submit() {
    if (!confirm(`Ask lenders to quote ${fmtCr(p)} in ${regionName(at)} for ${t} game days, ${repayment}? Nothing is escrowed: you approve a quote (or none) before it lapses.`)) return;
    void act.run(() =>
      kibbPost<S.LoanRequestView>("/v1/loan/request", {
        banking_region: at,
        principal_pence: p,
        term_game_days: t,
        repayment,
        collateral_kind: kind,
        ...pledgeBody(kind, pledge),
        recourse: kind === "unsecured" || kind === "deposit" ? true : recourse,
        open_game_hours: h,
      }),
    );
  }

  return (
    <Panel title="Ask lenders for quotes">
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Region (paid into and repaid from)">
            <RegionSelect value={at} onChange={setRegion} />
          </Field>
          <Field label="Principal (Cr)">
            <Input type="number" min={100} step={0.01} value={principal} onChange={(e) => setPrincipal(e.target.value)} />
          </Field>
          <Field label={`Term (1–${LOAN.termMaxDays} game days)`}>
            <Input type="number" min={1} max={LOAN.termMaxDays} step={1} value={term} onChange={(e) => setTerm(e.target.value)} />
          </Field>
          <Field label={`Open for (1–${LOAN.requestHoursMax} game hours)`}>
            <Input type="number" min={1} max={LOAN.requestHoursMax} step={1} value={hours} onChange={(e) => setHours(e.target.value)} />
          </Field>
          <Field label="Collateral">
            <NativeSelect
              value={kind}
              onChange={(e) => {
                setKind(e.target.value as S.CollateralKind);
                setPledge(EMPTY_PLEDGE);
              }}
            >
              {REQUEST_KINDS.map((k) => (
                <option key={k} value={k}>
                  {COLLATERAL_LABEL[k]}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <div className="flex items-end pb-1.5">
            <Checkbox checked={kind === "unsecured" || kind === "deposit" ? true : recourse} onChange={(v) => kind !== "unsecured" && kind !== "deposit" && setRecourse(v)}>
              With recourse
            </Checkbox>
          </div>
        </div>
        <Segmented value={repayment} onChange={setRepayment} options={REPAYMENTS} />
        <PledgeFields kind={kind} value={pledge} onChange={setPledge} ours ships={ships} stock={stock} pledged={pledged.byShip} deposits={deposits} />
        {kind === "ship_lien" && fleet.ships.has(pledge.shipId) && (
          <WarnBox>The fleet autopilot sails this ship. A lien doesn&apos;t stop it sailing, but it can&apos;t be sold, listed or pledged again until repaid.</WarnBox>
        )}
        {gs !== null && (
          <p className="text-muted-foreground text-xs">
            Quotes must lie within {pctText(Math.round(gs / 10))} and {pctText(gs * 3)} (a tenth to three times the Goldsmiths&apos; {pctText(gs)} for this term). Lenders see your
            borrower record (debt owed, loans repaid, defaulted and walked away from).
          </p>
        )}
        {kind === "contract_receivable" && (
          <p className="text-muted-foreground text-xs">
            Invoice financing: against what you stand to be paid on an accepted freight contract or commission. When it pays you, the lender is paid first; if it
            closes without paying, the receivable is lost (with recourse, the loan stays owed). One financing per contract and party.
          </p>
        )}
        {kind === "deposit" && (
          <p className="text-muted-foreground text-xs">
            Against one of your own bank deposits: only the bank holding it may quote, always with recourse, and the loan may be in any region it lends in. The
            deposit&apos;s free balance must cover the total repayable when you ask, when the bank quotes and when you approve; from approval it carries a lock of
            that much (it keeps earning interest, and every payment shrinks the lock). Unpaid at default, the bank sets what you owe off against the deposit.
          </p>
        )}
        {!recourse && kind !== "unsecured" && kind !== "deposit" && <p className="text-muted-foreground text-xs">Non-recourse: a lender may lend at most the pledge&apos;s appraisal, and a shortfall after it is forgiven.</p>}
        <ErrorNote error={act.error ?? (principal ? why : null)} />
        {act.result && <p className="text-sm">Posted: {fmtCr(act.result.principal_pence)}, open until {fmtIn(act.result.expires_at)}.</p>}
        <Button className="w-full" disabled={!!why || act.busy} onClick={submit}>
          {act.busy ? "Posting…" : `Post request in ${regionName(at)}`}
        </Button>
      </div>
    </Panel>
  );
}

function MyRequestsPanel({
  data,
  error,
  companyId,
  ourIds,
  fleet,
  onCredit,
  onDone,
}: {
  data: S.LoanRequestView[] | undefined;
  error: Error | null;
  companyId: string | undefined;
  ourIds: Set<string>;
  fleet: FleetFinance;
  onCredit: (id: string) => void;
  onDone: () => void;
}) {
  const names = useCompanyNames();
  const act = useAction<S.Loan>(onDone);
  const [showClosed, setShowClosed] = useState(false);
  useLearnCompanies((data ?? []).flatMap((r) => (r.quotes ?? []).map((q) => [q.lender_company_id, q.lender_name] as [string, string])));
  const rows = (data ?? []).filter((r) => showClosed || r.status === "open");

  function approve(r: S.LoanRequestView, q: S.LoanQuote) {
    const ap = fleet.isAutopilotRequest(r.id)
      ? "\n\nThe fleet autopilot posted this request to refinance one of its Goldsmiths' loans and approves a cheaper quote itself. Approved by hand, the loan is yours: the autopilot repays it only in its last 2 game days, and repays its own Goldsmiths' loan as usual."
      : "";
    if (
      !confirm(
        `Approve ${names.label(q.lender_company_id)}'s quote: ${fmtCr(q.principal_pence)} at ${pctText(q.annual_rate_bps)} for ${q.term_game_days} game days, ${q.repayment}${q.repayment === "amortised" ? ` (${fmtCr(q.installment_pence ?? 0)} every ${LOAN.installmentEveryDays} game days)` : ""}, ${fmtCr(q.total_repayable_pence)} repaid in all, into your ${regionName(r.banking_region)} vault? Every other quote is released and the request closes.${ap}\n\n${DEFAULT_WARNING}`,
      )
    )
      return;
    void act.run(() => kibbPost<S.Loan>("/v1/loan/approve", { quote_id: q.id }));
  }

  return (
    <Panel title="Your requests and the quotes on them" action={<Checkbox checked={showClosed} onChange={setShowClosed}>Show closed</Checkbox>}>
      <ErrorNote error={error} />
      <ErrorNote error={act.error} className="mb-3" />
      {!data ? (
        !error && <Loading />
      ) : rows.length === 0 ? (
        <Empty>{data.length ? "No open request." : "You have posted no request."}</Empty>
      ) : (
        <div className="space-y-4">
          {rows.map((r) => {
            const open = (r.quotes ?? []).filter((q) => q.status === "open").sort((a, b) => a.total_repayable_pence - b.total_repayable_pence);
            const closed = (r.quotes ?? []).filter((q) => q.status !== "open");
            return (
              <div key={r.id} className="space-y-2 rounded-md border p-3">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-medium">{fmtCr(r.principal_pence)}</span>
                  <span className="text-muted-foreground">
                    in {regionName(r.banking_region)} for {r.term_game_days} game days, {r.repayment}
                  </span>
                  <RequestPledge r={r} />
                  <Badge variant={r.status === "open" ? "info" : r.status === "funded" ? "success" : "outline"} size="sm">
                    {r.status}
                  </Badge>
                  {fleet.isAutopilotRequest(r.id) && (
                    <Badge variant="warning" size="sm" title="Posted by the fleet autopilot to refinance one of its Goldsmiths' loans">
                      autopilot
                    </Badge>
                  )}
                  <span className="text-muted-foreground text-xs">
                    Goldsmiths {pctText(r.goldsmiths_rate_bps)} · {r.status === "open" ? `lapses ${fmtIn(r.expires_at)}` : fmtDateTime(r.expires_at)}
                  </span>
                </div>
                {open.length === 0 && closed.length === 0 ? (
                  <p className="text-muted-foreground text-xs">No quote yet.</p>
                ) : (
                  <Table head={["Lender", "Rate", "Repaid in all", "Lapses", "Status", ""]}>
                    {[...open, ...closed].map((q) => {
                      const cheaper = q.annual_rate_bps < r.goldsmiths_rate_bps;
                      return (
                        <tr key={q.id}>
                          <td>
                            <CompanyLabel id={q.lender_company_id} companyId={companyId} ourIds={ourIds} />
                          </td>
                          <td>
                            <AnnualRateText bps={q.annual_rate_bps} />
                            {cheaper && <div className="text-success-foreground text-xs">under the Goldsmiths</div>}
                          </td>
                          <td className="tabular-nums">
                            {fmtCr(q.total_repayable_pence)}
                            {q.repayment === "amortised" && q.installment_pence != null && <div className="text-muted-foreground text-xs">{fmtCr(q.installment_pence)} / {LOAN.installmentEveryDays} days</div>}
                          </td>
                          <td className="whitespace-nowrap text-xs">{fmtIn(q.expires_at)}</td>
                          <td className="text-xs">{q.status}</td>
                          <td>
                            <div className="flex justify-end gap-1.5">
                              <Button size="sm" variant="ghost" onClick={() => onCredit(q.lender_company_id)}>
                                Credit
                              </Button>
                              {q.status === "open" && r.status === "open" && (
                                <Button size="sm" disabled={act.busy} onClick={() => approve(r, q)}>
                                  Approve
                                </Button>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </Table>
                )}
              </div>
            );
          })}
        </div>
      )}
      <p className="mt-3 text-muted-foreground text-xs">
        A lender&apos;s principal is escrowed while its quote stands; approving one pays it into your vault and starts the term. A request nobody beats just
        lapses (there is no withdrawing one).
      </p>
    </Panel>
  );
}

// ── Lending: quoting on requests ──────────────────────────────────────────────

function QuoteForm({
  req,
  companyId,
  vaults,
  onDone,
  onClose,
}: {
  req: S.LoanRequestView;
  companyId: string | undefined;
  vaults: Vaults;
  onDone: () => void;
  onClose: () => void;
}) {
  const names = useCompanyNames();
  const [rate, setRate] = useState(String(Math.round(req.goldsmiths_rate_bps * 0.9) / 100));
  const act = useAction<S.LoanQuote>(() => {
    onDone();
    onClose();
  });
  const { data: credit, error: creditError } = usePoll(() => kibbGet<S.CreditReport>("/v1/loan/credit", { company_id: req.borrower_company_id }), 0, [req.borrower_company_id]);
  const r = pctToBps(rate);
  const cash = vaults.cash(req.banking_region);
  const why = firstProblem([
    [req.borrower_company_id !== companyId, "You can't quote on your own company's request."],
    [Number.isFinite(r) && r >= req.rate_floor_bps && r <= req.rate_ceiling_bps, `Rate: ${pctText(req.rate_floor_bps)} to ${pctText(req.rate_ceiling_bps)}.`],
    [cash === undefined || cash >= req.principal_pence, `The principal is escrowed from your ${regionName(req.banking_region)} vault, which holds only ${fmtCr(cash)}.`],
  ]);
  const blemishes = credit && credit.company_id === req.borrower_company_id ? creditBlemishes(credit) : [];
  const interest = Number.isFinite(r) ? interestFor(req.principal_pence, r, req.term_game_days) : 0;

  function submit() {
    if (
      !confirm(
        `Quote ${names.label(req.borrower_company_id)} ${fmtCr(req.principal_pence)} at ${pctText(r)} for ${req.term_game_days} game days, ${req.repayment} (~${fmtCr(interest)} interest held to maturity)? The principal is escrowed from your ${regionName(req.banking_region)} vault until the borrower approves it or another, the request lapses, or you withdraw it.${blemishes.length ? `\n\nTheir credit record shows: ${blemishes.join(", ")}.` : ""}${req.recourse ? "" : "\n\nNON-RECOURSE: a shortfall after the collateral is forgiven."}`,
      )
    )
      return;
    void act.run(() => kibbPost<S.LoanQuote>("/v1/loan/quote-request", { request_id: req.id, annual_rate_bps: r }));
  }

  return (
    <div className="space-y-3">
      <KV
        rows={[
          ["Borrower", <CompanyLabel key="b" id={req.borrower_company_id} companyId={companyId} />],
          ["Asks", `${fmtCr(req.principal_pence)} in ${regionName(req.banking_region)} for ${req.term_game_days} game days, ${req.repayment}`],
          ["Pledge", <RequestPledge key="p" r={req} />],
          ["Goldsmiths' rate for the term", <AnnualRateText key="g" bps={req.goldsmiths_rate_bps} />],
          ["A quote may be", `${pctText(req.rate_floor_bps)} – ${pctText(req.rate_ceiling_bps)}`],
          ["Request lapses", fmtIn(req.expires_at)],
        ]}
      />
      <Field label="Your rate (% a year)">
        <Input type="number" min={req.rate_floor_bps / 100} max={req.rate_ceiling_bps / 100} step={0.1} value={rate} onChange={(e) => setRate(e.target.value)} />
      </Field>
      {Number.isFinite(r) && r > 0 && <p className="text-muted-foreground text-xs">~{fmtCr(interest)} interest if held to maturity; repaying early pays interest only to date.</p>}
      <CashLine region={req.banking_region} cash={cash} need={req.principal_pence} />
      <div className="rounded-md border p-3">
        <p className="mb-2 font-medium text-sm">Borrower&apos;s credit record</p>
        <ErrorNote error={creditError} />
        {credit && credit.company_id === req.borrower_company_id ? <CreditRecordView report={credit} /> : !creditError && <Loading />}
      </div>
      {req.collateral_kind === "unsecured" && <WarnBox>Unsecured: on default only a claim on the borrower&apos;s vaults stands behind it.</WarnBox>}
      {req.collateral_kind === "deposit" && (
        <WarnBox tone="info">
          Secured by the borrower&apos;s deposit with your bank, with recourse: from approval it carries a lock of the total repayable, and on a default you set what
          is owed off against it (no cash moves).
        </WarnBox>
      )}
      <ErrorNote error={act.error ?? why} />
      <div className="flex gap-2">
        <Button className="flex-1" disabled={!!why || act.busy} onClick={submit}>
          {act.busy ? "Quoting…" : "Quote"}
        </Button>
        <Button variant="outline" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function LendTab({
  homeRegion,
  companyId,
  ourIds,
  vaults,
  fleet,
  onCredit,
  onDone,
}: {
  homeRegion: string;
  companyId: string | undefined;
  ourIds: Set<string>;
  vaults: Vaults;
  fleet: FleetFinance;
  onCredit: (id: string) => void;
  onDone: () => void;
}) {
  const [region, setRegion] = useState("");
  const at = region || homeRegion;
  const { data, error, reload } = usePoll(() => kibbGet<S.LoanRequestView[]>("/v1/loan/requests", { banking_region: at, limit: 200 }), 20_000, [at]);
  useLearnCompanies((data ?? []).map((r) => [r.borrower_company_id, r.borrower_name] as [string, string]));
  const [quoting, setQuoting] = useState<string | null>(null);
  const act = useAction<S.LoanQuote>(() => {
    void reload();
    onDone();
  });
  const done = () => {
    void reload();
    onDone();
  };
  const req = data?.find((r) => r.id === quoting);
  const cash = vaults.cash(at);

  function withdraw(q: S.LoanQuote) {
    const ap = fleet.isAutopilotQuote(q.id) ? "\n\nThis is the fleet autopilot's idle-cash quote: it quotes again on its next pass while idle cash is on (turn it off in the autopilot settings to stop)." : "";
    if (!confirm(`Withdraw your quote of ${fmtCr(q.principal_pence)} at ${pctText(q.annual_rate_bps)}? Its escrow returns to your ${regionName(q.banking_region)} vault.${ap}`)) return;
    void act.run(() => kibbPost<S.LoanQuote>("/v1/loan/withdraw-quote", { quote_id: q.id }));
  }

  return (
    <div className="grid items-start gap-4 xl:grid-cols-3">
      <Panel
        title={`Open requests · ${regionName(at)}`}
        className="xl:col-span-2"
        action={
          <div className="w-full sm:w-44">
            <RegionSelect value={at} onChange={setRegion} />
          </div>
        }
      >
        <ErrorNote error={error} />
        <ErrorNote error={act.error} className="mb-3" />
        {!data ? (
          !error && <Loading />
        ) : data.length === 0 ? (
          <Empty>No open loan requests in {regionName(at)}.</Empty>
        ) : (
          <Table head={["Borrower", "Principal", "Term", "Pledge", "Goldsmiths", "Record", "Lapses", ""]}>
            {data.map((r) => {
              const own = r.borrower_company_id === companyId;
              const sibling = !own && ourIds.has(r.borrower_company_id);
              const mine = (r.quotes ?? []).filter((q) => q.lender_company_id === companyId && q.status === "open");
              const rec = r.borrower_record;
              const bad = !!rec && (rec.loans_defaulted > 0 || rec.loans_walked_away > 0);
              return (
                <tr key={r.id} className={r.id === quoting ? "bg-accent" : undefined}>
                  <td>
                    <CompanyLabel id={r.borrower_company_id} companyId={companyId} ourIds={ourIds} />
                  </td>
                  <td className="tabular-nums">{fmtCr(r.principal_pence)}</td>
                  <td className="whitespace-nowrap">
                    {r.term_game_days} days
                    <div className="text-muted-foreground text-xs">{r.repayment}</div>
                  </td>
                  <td>
                    <RequestPledge r={r} />
                  </td>
                  <td>
                    <AnnualRateText bps={r.goldsmiths_rate_bps} />
                  </td>
                  <td className="text-xs">
                    {rec ? (
                      <span className={bad ? "text-destructive" : undefined} title={`Owes ${fmtCr(rec.owed_pence)} on ${rec.loans_owed}; repaid ${rec.loans_repaid}`}>
                        {rec.loans_defaulted > 0 ? `${rec.loans_defaulted} defaulted` : "no defaults"}
                        {rec.loans_walked_away > 0 && `, walked away ${rec.loans_walked_away}`}
                      </span>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="whitespace-nowrap text-xs">{fmtIn(r.expires_at)}</td>
                  <td>
                    <div className="flex justify-end gap-1.5">
                      {!own && (
                        <Button size="sm" variant="ghost" onClick={() => onCredit(r.borrower_company_id)}>
                          Credit
                        </Button>
                      )}
                      {mine.map((q) => (
                        <Button key={q.id} size="sm" variant="outline" disabled={act.busy} onClick={() => withdraw(q)} title={`Your quote: ${pctText(q.annual_rate_bps)}`}>
                          Withdraw {(q.annual_rate_bps / 100).toLocaleString("en-GB", { maximumFractionDigits: 1 })}%
                          {fleet.isAutopilotQuote(q.id) && " (autopilot)"}
                        </Button>
                      ))}
                      {!own && mine.length === 0 && r.collateral_kind === "deposit" && r.collateral_deposit_bank_id !== companyId && (
                        <span className="self-center text-muted-foreground text-xs" title="Secured by a bank deposit: only the bank holding it may quote (guide 3.13.2)">
                          Bank only
                        </span>
                      )}
                      {!own && mine.length === 0 && (r.collateral_kind !== "deposit" || r.collateral_deposit_bank_id === companyId) && (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={cash !== undefined && cash < r.principal_pence}
                          title={cash !== undefined && cash < r.principal_pence ? `Only ${fmtCr(cash)} in your ${regionName(at)} vault` : sibling ? "Another of your companies: dealt with as with any other" : undefined}
                          onClick={() => setQuoting(r.id)}
                        >
                          Quote
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
          Oldest first. Your principal is escrowed while your quote stands; the borrower approves one quote (it becomes the loan) and every other is released.
          Read the borrower&apos;s credit record before quoting.
        </p>
      </Panel>
      <Panel title={req ? "Quote on a request" : "Quoting"}>
        {req ? (
          <QuoteForm key={req.id} req={req} companyId={companyId} vaults={vaults} onDone={done} onClose={() => setQuoting(null)} />
        ) : (
          <div className="space-y-2 text-muted-foreground text-sm">
            <p>
              Pick a request to quote: a fixed annual rate within its bounds (a tenth to three times the Goldsmiths&apos; rate for its term). A quote far from the
              Goldsmiths&apos; rate raises a surveillance alert when approved.
            </p>
            <p>
              Secured requests pledge a ship (a default hands her to you at {LOAN.foreclosureCreditPct}% of her rebuild value, and you pay the borrower any surplus)
              or goods (moved to your warehouse); with recourse the rest is a claim on the borrower&apos;s vaults.
            </p>
            {fleet.running && <p>The fleet autopilot quotes spare cash itself when idle-cash lending is on (its quotes are marked).</p>}
          </div>
        )}
      </Panel>
    </div>
  );
}

// ── Credit records ────────────────────────────────────────────────────────────

/** A company typed as an id or a name we have seen: its id, if known. */
function useResolveCompany(text: string): string | undefined {
  const names = useCompanyNames();
  const t = text.trim();
  if (!t) return undefined;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(t)) return t;
  return names.idByName(t);
}

function CompanyDatalist({ id }: { id: string }) {
  const names = useCompanyNames();
  return (
    <datalist id={id}>
      {names.all().map(([cid, name]) => (
        <option key={cid} value={name} />
      ))}
    </datalist>
  );
}

function CreditTab({ query, onQuery }: { query: string; onQuery: (q: string) => void }) {
  const { portName } = useCatalog();
  const names = useCompanyNames();
  const [input, setInput] = useState(query);
  useEffect(() => setInput(names.nameOf(query) ?? query), [query]); // eslint-disable-line react-hooks/exhaustive-deps
  const id = useResolveCompany(query);
  const { data: report, error } = usePoll(id ? () => kibbGet<S.CreditReport>("/v1/loan/credit", { company_id: id }) : null, 0, [id]);
  // Not seen by name: the public profile says whether it exists (it carries no id).
  const byName = !id && query.trim() ? query.trim() : "";
  const { data: profile, error: profileError } = usePoll(byName ? () => kibbGet<S.PublicCompanyProfile>("/v1/world/company", { name: byName }) : null, 0, [byName]);
  useLearnCompanies(report ? [[report.company_id, report.company_name]] : undefined);

  return (
    <div className="grid items-start gap-4 xl:grid-cols-2">
      <Panel title="Look up a credit record">
        <form
          className="flex flex-col gap-2 sm:flex-row"
          onSubmit={(e) => {
            e.preventDefault();
            onQuery(input.trim());
          }}
        >
          <Input list="credit-companies" value={input} onChange={(e) => setInput(e.target.value)} placeholder="Company name or id" />
          <CompanyDatalist id="credit-companies" />
          <Button type="submit" disabled={!input.trim()}>
            Look up
          </Button>
        </form>
        <div className="mt-4">
          {id ? (
            <>
              <ErrorNote error={error} />
              {report && report.company_id === id ? <CreditRecordView report={report} /> : !error && <Loading />}
            </>
          ) : byName ? (
            profileError ? (
              <ErrorNote error={profileError instanceof DashboardApiError && profileError.status === 404 ? `No company named "${byName}".` : profileError} />
            ) : profile ? (
              <p className="text-sm">
                {profile.company_name} exists (home port {portName(profile.home_port_id)}), but its id isn&apos;t public: find it on a loan request, the banks list or a
                venture, then look it up from there.
              </p>
            ) : (
              <Loading />
            )
          ) : (
            <Empty>Names seen on loan requests, quotes, banks and your loans resolve to their records.</Empty>
          )}
        </div>
      </Panel>
      <Panel title="Reading a record">
        <div className="space-y-2 text-muted-foreground text-sm">
          <p>
            Anyone&apos;s record is public: what it owes now, defaulted debt still open, loans repaid, defaulted, walked away from and written off, futures default
            claims, what it has lent, any bankruptcy, and ships the Crown seized from it for smuggling.
          </p>
          <p>Check it before lending, depositing or investing. Defaults, walk-aways and convictions stay on a record for good.</p>
        </div>
      </Panel>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function LoansPage() {
  useCompanyDirectory();
  const companyId = useCompanyId();
  const ourIds = useOurCompanyIds();
  const regionOf = useRegionOf();
  const { data: profile } = usePoll(() => kibbGet<CompanyProfile>("/v1/company/profile"));
  const { data: ships } = useShips();
  const { data: stock } = useStock();
  const { data: allDeposits } = usePoll(() => kibbGet<S.DepositResult[]>("/v1/bank/deposits"), 60_000);
  const fleet = useFleetFinance();
  const vaults = useVaults();
  const pledged = usePledgedShips();
  const owed = usePoll(() => loansOf("borrower", ["active", "defaulted"]), 20_000);
  const lent = usePoll(() => loansOf("lender", ["active", "defaulted"]), 20_000);
  const mine = usePoll(() => kibbGet<S.LoanRequestView[]>("/v1/loan/requests", { mine: true, limit: 50 }), 20_000);
  // Every open request carries our own quotes on it: what we have escrowed.
  const open = usePoll(() => kibbGet<S.LoanRequestView[]>("/v1/loan/requests", { limit: 200 }), 60_000);
  const [tab, setTab] = useState("loans");
  const [lookup, setLookup] = useState("");
  const [historyKey, setHistoryKey] = useState(0);
  const homeRegion = regionOf(profile?.company.home_port_id) ?? "channel";
  const shipName = (id: string) => ships?.find((r) => r.ship.id === id)?.ship.name;
  const refresh = () => {
    void owed.reload();
    void lent.reload();
    void mine.reload();
    void open.reload();
    void vaults.reload();
    void pledged.reload();
    setHistoryKey((k) => k + 1);
  };
  const credit = (id: string) => {
    setLookup(id);
    setTab("credit");
  };

  const owing = owed.data ?? [];
  const totalOwed = owing.reduce((n, l) => n + l.owed_pence, 0);
  const defaulted = owing.filter((l) => l.status === "defaulted");
  const arrears = owing.filter((l) => l.status === "active" && l.arrears_pence > 0);
  const next = owing
    .filter((l) => l.status === "active" && l.next_payment_due_at)
    .sort((a, b) => Date.parse(a.next_payment_due_at!) - Date.parse(b.next_payment_due_at!))[0];
  const out = (lent.data ?? []).reduce((n, l) => n + l.owed_pence, 0);
  const ourQuotes = (open.data ?? []).flatMap((r) => (r.quotes ?? []).filter((q) => q.lender_company_id === companyId && q.status === "open"));
  const escrowed = ourQuotes.reduce((n, q) => n + q.principal_pence, 0);
  const openRequests = (mine.data ?? []).filter((r) => r.status === "open");
  const quotesIn = openRequests.reduce((n, r) => n + (r.quotes ?? []).filter((q) => q.status === "open").length, 0);
  const f = fleet.finance;
  const apLoans = f?.borrowed.filter((r) => r.purpose) ?? [];
  const apQuotes = f?.quotes ?? [];

  return (
    <div className="space-y-5 pb-8 sm:space-y-6">
      <PageHeader
        title="Loans"
        subtitle="Loans by quote: the Goldsmiths' Company quotes at once against one of your ships; players quote on requests for quotes. Fixed annual rates, terms up to 360 game days, balloon or amortised."
        badges={
          <>
            {defaulted.length > 0 && <Badge variant="error">{defaulted.length} defaulted</Badge>}
            {arrears.length > 0 && <Badge variant="error">{arrears.length} in arrears</Badge>}
          </>
        }
      />
      <Metrics
        items={[
          { label: "You owe", value: owed.data ? fmtCr(totalOwed) : "…", hint: `${owing.length} loan${owing.length === 1 ? "" : "s"}` },
          { label: "Next payment", value: next ? fmtIn(next.next_payment_due_at) : "—", hint: next?.next_payment_pence != null ? fmtCr(next.next_payment_pence) : undefined },
          { label: "Owed to you", value: lent.data ? fmtCr(out) : "…" },
          { label: "Your quotes escrowed", value: open.data ? fmtCr(escrowed) : "…", hint: `${ourQuotes.length} quote${ourQuotes.length === 1 ? "" : "s"}` },
          { label: "Your open requests", value: mine.data ? String(openRequests.length) : "…", hint: openRequests.length ? `${quotesIn} quote${quotesIn === 1 ? "" : "s"} in` : undefined },
          {
            label: "Autopilot debt",
            value: f ? fmtCr(f.debtPence) : "—",
            hint: f ? (f.capPence !== null ? `cap ${fmtCr(f.capPence)}` : "cap unknown") : fleet.running ? "no report yet" : "autopilot off",
          },
        ]}
      />
      {(defaulted.length > 0 || arrears.length > 0) && (
        <WarnBox tone="error">
          {defaulted.length > 0 && (
            <p>
              {defaulted.length} loan{defaulted.length === 1 ? " has" : "s have"} defaulted ({fmtCr(defaulted.reduce((n, l) => n + l.owed_pence, 0))} owed). A ship pledged to it
              is arrested: it can&apos;t depart or join a convoy until the lender has it or you pay. Repay below to clear the claim.
            </p>
          )}
          {arrears.length > 0 && (
            <p>
              {arrears.length} loan{arrears.length === 1 ? " has an installment" : "s have installments"} in arrears ({fmtCr(arrears.reduce((n, l) => n + l.arrears_pence, 0))}):
              unpaid past its day of grace, the whole loan defaults. Repay below.
            </p>
          )}
        </WarnBox>
      )}
      {f && (f.debtPence > 0 || apQuotes.length > 0 || f.short) && (
        <WarnBox tone={f.short ? "error" : "info"}>
          {f.short && <p className="font-medium">Autopilot repayment short: {f.short}. It stops new spending until it is paid.</p>}
          <p>
            The fleet autopilot {fleet.running ? "manages" : "managed (it is stopped now)"} loans too: it owes {fmtCr(f.debtPence)}
            {f.capPence !== null ? ` of a ${fmtCr(f.capPence)} cap` : ""} and keeps {fmtCr(f.fencePence)} back to repay.
            {apLoans.length > 0 &&
              (fleet.running
                ? ` Loans marked "autopilot" (${apLoans.length}) are its own: it repays them itself, early when cash allows and in full 2 game days before maturity, so repaying them by hand is never needed.`
                : ` Loans marked "autopilot" (${apLoans.length}) are its own, but while it is stopped nobody repays them: repay them before they mature.`)}{" "}
            {fleet.running && "Loans you take by hand count against its cap; it repays them only in their last 2 game days, or at once when an installment is in arrears or the loan defaulted. It never walks away from a loan."}
            {apQuotes.length > 0 &&
              ` Its idle-cash quotes on requests (${fmtCr(apQuotes.reduce((n, q) => n + q.principalPence, 0))}) are marked "autopilot": withdrawn by hand, it may quote again on its next pass while idle cash is on.`}
          </p>
        </WarnBox>
      )}
      <Tabs value={tab} onValueChange={(v) => setTab(String(v))}>
        <TabsList>
          <TabsTab value="loans">Your loans</TabsTab>
          <TabsTab value="borrow">Borrow</TabsTab>
          <TabsTab value="lend">Lend</TabsTab>
          <TabsTab value="credit">Credit records</TabsTab>
        </TabsList>
        <TabsPanel value="loans" className="space-y-4 pt-2">
          <OwedPanel loans={owed.data} error={owed.error} vaults={vaults} fleet={fleet} shipName={shipName} onDone={refresh} />
          <LentPanel loans={lent.data} error={lent.error} companyId={companyId} ourIds={ourIds} onCredit={credit} />
          <HistoryPanel refreshKey={historyKey} companyId={companyId} shipName={shipName} />
        </TabsPanel>
        <TabsPanel value="borrow" className="space-y-4 pt-2">
          <div className="grid items-start gap-4 xl:grid-cols-2">
            <GoldsmithsPanel ships={ships} pledged={pledged} vaults={vaults} fleet={fleet} onDone={refresh} />
            <RequestForm
              homeRegion={homeRegion}
              ships={ships}
              stock={stock}
              deposits={allDeposits?.filter((d) => pledgeableDeposit(d, companyId))}
              pledged={pledged}
              fleet={fleet}
              onDone={refresh}
            />
          </div>
          <MyRequestsPanel data={mine.data} error={mine.error} companyId={companyId} ourIds={ourIds} fleet={fleet} onCredit={credit} onDone={refresh} />
        </TabsPanel>
        <TabsPanel value="lend" className="pt-2">
          <LendTab homeRegion={homeRegion} companyId={companyId} ourIds={ourIds} vaults={vaults} fleet={fleet} onCredit={credit} onDone={refresh} />
        </TabsPanel>
        <TabsPanel value="credit" className="pt-2">
          <CreditTab query={lookup} onQuery={setLookup} />
        </TabsPanel>
      </Tabs>
      <p className="text-muted-foreground text-xs">
        Every loan is paid vault to vault in one banking region. Net worth counts what you owe against you and what you are owed for you, so borrowing never lifts
        you up the board. See also <Link href="/banks" className="text-primary hover:underline">banks</Link> and your{" "}
        <Link href="/treasury" className="text-primary hover:underline">vaults</Link>.
      </p>
    </div>
  );
}
