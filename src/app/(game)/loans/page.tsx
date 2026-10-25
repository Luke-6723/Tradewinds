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
  CashLine,
  COLLATERAL_LABEL,
  CollateralText,
  CompanyLabel,
  CreditRecordView,
  DEFAULT_WARNING,
  EMPTY_PLEDGE,
  type FleetFinance,
  LOAN,
  LoanStatusBadge,
  type Pledge,
  PledgeFields,
  RateText,
  WarnBox,
  crToPence,
  firstProblem,
  interestFor,
  loansOf,
  num,
  pledgeBody,
  pledgeProblem,
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
import { fmtCr, fmtDateTime, fmtIn, fmtTons } from "@/lib/kibb/format";
import type * as S from "@/lib/kibb/schema";
import type { CompanyProfile, ShipResult } from "@/lib/kibb/types";

type Vaults = ReturnType<typeof useVaults>;
type Pledged = ReturnType<typeof usePledgedShips>;

const STATUSES: S.LoanStatus[] = ["offered", "active", "repaid", "defaulted", "recovered", "written_off", "withdrawn", "declined", "lapsed"];
const BOARD_KINDS: S.CollateralKind[] = ["ship_lien", "warehouse_goods", "unsecured"];
const OFFER_KINDS: S.CollateralKind[] = ["ship_lien", "warehouse_goods", "contract_receivable", "unsecured"];

/** "repay by" or "offer lapses" time for a loan row. */
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

function OffersToMe({
  loans,
  error,
  companyId,
  ourIds,
  shipName,
  fleet,
  onDone,
}: {
  loans: S.Loan[] | undefined;
  error: Error | null;
  companyId: string | undefined;
  ourIds: Set<string>;
  shipName: (id: string) => string | undefined;
  fleet: FleetFinance;
  onDone: () => void;
}) {
  const names = useCompanyNames();
  const act = useAction<S.Loan>(onDone);
  if (!loans?.length && !error) return null;

  function accept(l: S.Loan) {
    const pledge =
      l.collateral_kind === "ship_lien"
        ? ` ${shipName(l.collateral_ship_id ?? "") ?? "The ship"} goes under the lender's lien: it may still sail, but can't be sold, listed or pledged again until repaid.`
        : l.collateral_kind === "warehouse_goods"
          ? " The pledged goods are locked in your warehouse until repaid."
          : l.collateral_kind === "contract_receivable"
            ? " When the contract pays you, this lender is paid first."
            : " Unsecured: the lender claims from your vaults on default.";
    const ap = l.collateral_ship_id && fleet.ships.has(l.collateral_ship_id) ? " The fleet autopilot sails that ship and counts this loan against its debt cap." : "";
    if (
      !confirm(
        `Accept ${fmtCr(l.principal_pence)} from ${names.label(l.lender_company_id)} at ${l.daily_rate_bps} bps a game day for ${l.term_game_days} game days (up to ${fmtCr(interestFor(l.principal_pence, l.daily_rate_bps, l.term_game_days))} interest)? It lands in your ${regionName(l.banking_region)} vault.${pledge}${ap}\n\n${DEFAULT_WARNING}`,
      )
    )
      return;
    void act.run(() => kibbPost<S.Loan>("/v1/loan/accept", { loan_id: l.id }));
  }

  return (
    <Panel title="Loans offered to you">
      <ErrorNote error={error} />
      <ErrorNote error={act.error} className="mb-3" />
      {loans && loans.length > 0 && (
        <Table head={["Lender", "Region", "Principal", "Rate", "Term", "Collateral", "Lapses", ""]}>
          {loans.map((l) => (
            <tr key={l.id}>
              <td>
                <CompanyLabel id={l.lender_company_id} companyId={companyId} ourIds={ourIds} />
              </td>
              <td className="capitalize">{regionName(l.banking_region)}</td>
              <td className="tabular-nums">{fmtCr(l.principal_pence)}</td>
              <td>
                <RateText bps={l.daily_rate_bps} />
              </td>
              <td className="whitespace-nowrap">{l.term_game_days} days</td>
              <td>
                <CollateralText loan={l} shipName={shipName} />
              </td>
              <td className="whitespace-nowrap text-xs">{fmtIn(l.offer_expires_at)}</td>
              <td>
                <div className="flex justify-end gap-1.5">
                  <Button size="sm" disabled={act.busy} onClick={() => accept(l)}>
                    Accept
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={act.busy}
                    onClick={() => confirm(`Decline ${names.label(l.lender_company_id)}'s offer of ${fmtCr(l.principal_pence)}?`) && void act.run(() => kibbPost<S.Loan>("/v1/loan/decline", { loan_id: l.id }))}
                  >
                    Decline
                  </Button>
                </div>
              </td>
            </tr>
          ))}
        </Table>
      )}
      <p className="mt-3 text-muted-foreground text-xs">Check the lender&apos;s terms: interest accrues every game day on the outstanding principal, and early repayment pays interest only to date.</p>
    </Panel>
  );
}

function RepayForm({ loan, cash, fleet, onDone, onClose }: { loan: S.Loan; cash: number | undefined; fleet: FleetFinance; onDone: () => void; onClose: () => void }) {
  const names = useCompanyNames();
  const [amount, setAmount] = useState("");
  const act = useAction<S.Loan>(onDone);
  const all = amount.trim() === "";
  const pence = all ? loan.owed_pence : crToPence(amount);
  const purpose = fleet.purposeOf(loan.id);
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

  return (
    <div className="space-y-3">
      <KV
        rows={[
          ["Lender", <CompanyLabel key="l" id={loan.lender_company_id} />],
          ["Owed now", fmtCr(loan.owed_pence, 2)],
          ["Principal outstanding", fmtCr(loan.outstanding_principal_pence, 2)],
          ["Interest accrued", fmtCr(loan.accrued_interest_pence, 2)],
          ["Rate", <RateText key="r" bps={loan.daily_rate_bps} />],
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
      {loan.status === "defaulted" && (
        <WarnBox tone="error">
          Defaulted: the lender is collecting. Paying it down clears the claim, and paying it off releases a ship arrested for it.
        </WarnBox>
      )}
      <Field label="Amount (Cr): empty repays everything owed">
        <Input type="number" min={0.01} step={0.01} value={amount} placeholder={(loan.owed_pence / 100).toFixed(2)} onChange={(e) => setAmount(e.target.value)} />
      </Field>
      <CashLine region={loan.banking_region} cash={cash} need={pence} />
      <p className="text-muted-foreground text-xs">Interest to date is paid first, then principal. Paid in full, the loan closes and its collateral is released.</p>
      <ErrorNote error={act.error ?? why} />
      {act.result && <p className="text-sm">Done: {fmtCr(act.result.owed_pence, 2)} still owed ({act.result.status}).</p>}
      <div className="flex gap-2">
        <Button className="flex-1" disabled={!!why || act.busy} onClick={submit}>
          {act.busy ? "Repaying…" : all ? "Repay in full" : `Repay ${fmtCr(pence, 2)}`}
        </Button>
        <Button variant="outline" onClick={onClose}>
          Close
        </Button>
      </div>
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
          <Table head={["Lender", "Region", "Owed", "Principal", "Rate", "Due", "Collateral", "Status", ""]}>
            {loans.map((l) => (
              <tr key={l.id} className={l.id === selected ? "bg-accent" : undefined}>
                <td>
                  <span className="inline-flex flex-wrap items-center gap-1">
                    <CompanyLabel id={l.lender_company_id} />
                    <AutopilotTag fleet={fleet} loanId={l.id} />
                  </span>
                </td>
                <td className="capitalize">{regionName(l.banking_region)}</td>
                <td className="font-medium tabular-nums">{fmtCr(l.owed_pence)}</td>
                <td className="text-muted-foreground tabular-nums">{fmtCr(l.principal_pence)}</td>
                <td>
                  <RateText bps={l.daily_rate_bps} />
                </td>
                <td className={`whitespace-nowrap text-xs ${soon(l) ? "text-destructive" : ""}`}>{whenText(l)}</td>
                <td>
                  <CollateralText loan={l} shipName={shipName} />
                </td>
                <td>
                  <LoanStatusBadge status={l.status} />
                </td>
                <td className="text-right">
                  <Button size="sm" variant={l.status === "defaulted" ? "destructive" : "outline"} onClick={() => setSelected(l.id)}>
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
            <p>Pick a loan to repay early: interest is paid only to date. At maturity what is owed is taken from your vaults, that region first.</p>
            <p>{DEFAULT_WARNING}</p>
          </div>
        )}
      </Panel>
    </div>
  );
}

function LentPanel({
  loans,
  error,
  companyId,
  ourIds,
  onCredit,
  onDone,
}: {
  loans: S.Loan[] | undefined;
  error: Error | null;
  companyId: string | undefined;
  ourIds: Set<string>;
  onCredit: (id: string) => void;
  onDone: () => void;
}) {
  const names = useCompanyNames();
  const act = useAction<S.Loan>(onDone);
  return (
    <Panel title="What you lent and offered">
      <ErrorNote error={error} />
      <ErrorNote error={act.error} className="mb-3" />
      {!loans ? (
        !error && <Loading />
      ) : loans.length === 0 ? (
        <Empty>No loans out, and no direct offers standing.</Empty>
      ) : (
        <Table head={["Borrower", "Region", "Owed to you", "Principal", "Rate", "When", "Collateral", "Status", ""]}>
          {loans.map((l) => (
            <tr key={l.id}>
              <td>
                <CompanyLabel id={l.borrower_company_id} companyId={companyId} ourIds={ourIds} />
              </td>
              <td className="capitalize">{regionName(l.banking_region)}</td>
              <td className="tabular-nums">{l.status === "offered" ? "—" : fmtCr(l.owed_pence)}</td>
              <td className="text-muted-foreground tabular-nums">{fmtCr(l.principal_pence)}</td>
              <td>
                <RateText bps={l.daily_rate_bps} />
              </td>
              <td className="whitespace-nowrap text-xs">{whenText(l)}</td>
              <td>
                <CollateralText loan={l} />
              </td>
              <td>
                <LoanStatusBadge status={l.status} />
              </td>
              <td>
                <div className="flex justify-end gap-1.5">
                  <Button size="sm" variant="ghost" onClick={() => onCredit(l.borrower_company_id)}>
                    Credit
                  </Button>
                  {l.status === "offered" && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={act.busy}
                      onClick={() =>
                        confirm(`Withdraw your offer of ${fmtCr(l.principal_pence)} to ${names.label(l.borrower_company_id)}? The escrowed principal returns to your ${regionName(l.banking_region)} vault.`) &&
                        void act.run(() => kibbPost<S.Loan>("/v1/loan/withdraw", { loan_id: l.id }))
                      }
                    >
                      Withdraw
                    </Button>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </Table>
      )}
      <p className="mt-3 text-muted-foreground text-xs">
        A borrower that misses maturity defaults: you take a liened ship (credited at half its rebuild value) or the pledged goods, and with recourse the rest is
        collected from its vaults daily. A non-recourse shortfall is forgiven.
      </p>
    </Panel>
  );
}

function HistoryPanel({ refreshKey, companyId, shipName }: { refreshKey: number; companyId: string | undefined; shipName: (id: string) => string | undefined }) {
  const [role, setRole] = useState("");
  const [status, setStatus] = useState("");
  const page = usePaged<S.Loan>(
    (cursor, limit) => kibbGet<S.Loan[]>("/v1/loan/list", { role, status, cursor, limit }),
    [role, status, refreshKey],
  );
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
                  <RateText bps={l.daily_rate_bps} />
                </td>
                <td className="whitespace-nowrap">{l.term_game_days} days</td>
                <td className="tabular-nums">{fmtCr(l.interest_paid_pence)}</td>
                <td>
                  <CollateralText loan={l} shipName={shipName} />
                </td>
                <td>
                  <LoanStatusBadge status={l.status} />
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

// ── Credit board ──────────────────────────────────────────────────────────────

function TakeOfferForm({
  offer,
  ships,
  stock,
  pledged,
  vaults,
  fleet,
  onDone,
  onClose,
}: {
  offer: S.BoardOffer;
  ships: ShipResult[] | undefined;
  stock: S.PortWarehouseResult[] | undefined;
  pledged: Pledged;
  vaults: Vaults;
  fleet: FleetFinance;
  onDone: () => void;
  onClose: () => void;
}) {
  const [principal, setPrincipal] = useState(String(Math.min(offer.available_pence, Math.max(offer.min_principal_pence, LOAN.minPrincipalPence)) / 100));
  const [term, setTerm] = useState(String(Math.min(10, offer.max_term_game_days)));
  const [pledge, setPledge] = useState<Pledge>(EMPTY_PLEDGE);
  const act = useAction<S.Loan>(() => {
    onDone();
    onClose();
  });
  const p = crToPence(principal);
  const t = num(term);
  // The ship's rebuild value (from the Goldsmiths' quote) caps a lien at the offer's loan-to-value.
  const lienShip = offer.collateral_kind === "ship_lien" ? pledge.shipId : "";
  const { data: quote } = usePoll(lienShip ? () => kibbGet<S.BackstopQuote>("/v1/loan/backstop-quote", { ship_id: lienShip }) : null, 0, [lienShip]);
  const ltvCap = quote && quote.ship_id === lienShip && offer.max_ltv_bps ? Math.floor((quote.rebuild_value_pence * offer.max_ltv_bps) / 10_000) : undefined;
  const why = firstProblem([
    [p >= LOAN.minPrincipalPence, `Borrow at least ${fmtCr(LOAN.minPrincipalPence)}.`],
    [p >= offer.min_principal_pence, `This offer lends at least ${fmtCr(offer.min_principal_pence)}.`],
    [p <= offer.available_pence, `This offer has only ${fmtCr(offer.available_pence)} left.`],
    [Number.isInteger(t) && t >= 1 && t <= offer.max_term_game_days, `Term: 1 to ${offer.max_term_game_days} game days.`],
    [pledgeProblem(offer.collateral_kind, pledge) === null, pledgeProblem(offer.collateral_kind, pledge) ?? ""],
    [ltvCap === undefined || p <= ltvCap, `The offer lends at most ${fmtCr(ltvCap)} against this ship (${(offer.max_ltv_bps ?? 0) / 100}% of its rebuild value).`],
  ]);
  const apShip = offer.collateral_kind === "ship_lien" && fleet.ships.has(pledge.shipId);

  function submit() {
    if (
      !confirm(
        `Borrow ${fmtCr(p)} from ${offer.lender_name} at ${offer.daily_rate_bps} bps a game day for ${t} game days (up to ${fmtCr(interestFor(p, offer.daily_rate_bps, t))} interest), into your ${regionName(offer.banking_region)} vault?\n\n${DEFAULT_WARNING}`,
      )
    )
      return;
    void act.run(() =>
      kibbPost<S.Loan>("/v1/loan/take-offer", { offer_id: offer.id, principal_pence: p, term_game_days: t, ...pledgeBody(offer.collateral_kind, pledge) }),
    );
  }

  return (
    <div className="space-y-3">
      <KV
        rows={[
          ["Lender", offer.lender_name],
          ["Region", <span key="r" className="capitalize">{regionName(offer.banking_region)}</span>],
          ["Rate", <RateText key="rt" bps={offer.daily_rate_bps} />],
          ["Lends", `${fmtCr(offer.min_principal_pence)} – ${fmtCr(offer.available_pence)}, up to ${offer.max_term_game_days} days`],
          ["Collateral", `${COLLATERAL_LABEL[offer.collateral_kind]}${offer.max_ltv_bps ? ` ≤ ${offer.max_ltv_bps / 100}% LTV` : ""}${offer.recourse ? ", recourse" : ", non-recourse"}`],
        ]}
      />
      <div className="grid grid-cols-2 gap-3">
        <Field label="Principal (Cr)">
          <Input type="number" min={100} step={0.01} value={principal} onChange={(e) => setPrincipal(e.target.value)} />
        </Field>
        <Field label="Term (game days)">
          <Input type="number" min={1} max={offer.max_term_game_days} step={1} value={term} onChange={(e) => setTerm(e.target.value)} />
        </Field>
      </div>
      <PledgeFields kind={offer.collateral_kind} value={pledge} onChange={setPledge} ours ships={ships} stock={stock} pledged={pledged.byShip} />
      {ltvCap !== undefined && <p className="text-muted-foreground text-xs">Lends at most {fmtCr(ltvCap)} against this ship.</p>}
      {apShip && <WarnBox>The fleet autopilot sails this ship. A lien doesn&apos;t stop it sailing, but the ship can&apos;t be sold, listed or pledged again until repaid.</WarnBox>}
      {Number.isFinite(p) && Number.isFinite(t) && p > 0 && (
        <p className="text-muted-foreground text-xs">
          Up to {fmtCr(interestFor(p, offer.daily_rate_bps, t))} interest over the term; {fmtCr(p + interestFor(p, offer.daily_rate_bps, t))} owed at maturity if nothing is repaid.
        </p>
      )}
      <CashLine region={offer.banking_region} cash={vaults.cash(offer.banking_region)} />
      <ErrorNote error={act.error ?? why} />
      <div className="flex gap-2">
        <Button className="flex-1" disabled={!!why || act.busy} onClick={submit}>
          {act.busy ? "Borrowing…" : "Take this offer"}
        </Button>
        <Button variant="outline" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function PostOfferForm({ region, vaults, onDone }: { region: string; vaults: Vaults; onDone: () => void }) {
  const [available, setAvailable] = useState("");
  const [minimum, setMinimum] = useState("");
  const [rate, setRate] = useState("40");
  const [term, setTerm] = useState("10");
  const [kind, setKind] = useState<S.CollateralKind>("ship_lien");
  const [ltv, setLtv] = useState("50");
  const [recourse, setRecourse] = useState(true);
  const [hours, setHours] = useState(String(LOAN.boardHoursDefault));
  const act = useAction<S.BoardOffer>(onDone);
  const a = crToPence(available);
  const m = minimum.trim() === "" ? null : crToPence(minimum);
  const r = num(rate);
  const t = num(term);
  const l = Math.round(num(ltv) * 100);
  const h = num(hours);
  const secured = kind !== "unsecured";
  const cash = vaults.cash(region);
  const why = firstProblem([
    [a >= LOAN.minPrincipalPence, `Offer at least ${fmtCr(LOAN.minPrincipalPence)}.`],
    [cash === undefined || a <= cash, `Only ${fmtCr(cash)} in your ${regionName(region)} vault.`],
    [m === null || (m >= LOAN.minPrincipalPence && m <= a), `The minimum loan must be ${fmtCr(LOAN.minPrincipalPence)} to the amount offered.`],
    [Number.isInteger(r) && r >= LOAN.rateMinBps && r <= LOAN.rateMaxBps, `Rate: ${LOAN.rateMinBps} to ${LOAN.rateMaxBps} bps a game day.`],
    [Number.isInteger(t) && t >= 1 && t <= LOAN.termMaxDays, `Longest term: 1 to ${LOAN.termMaxDays} game days.`],
    [!secured || (l >= 1 && l <= LOAN.ltvMaxBps), "Secured offers need a loan-to-value cap of 0.01% to 100%."],
    [Number.isInteger(h) && h >= 1 && h <= LOAN.boardHoursMax, `Expiry: 1 to ${LOAN.boardHoursMax} game hours.`],
  ]);

  function submit() {
    if (
      !confirm(
        `Escrow ${fmtCr(a)} from your ${regionName(region)} vault as a standing ${COLLATERAL_LABEL[kind].toLowerCase()} offer at ${r} bps a game day? Any request in ${regionName(region)} that crosses it is matched automatically, without your say: you can't vet the borrower first.`,
      )
    )
      return;
    void act.run(() =>
      kibbPost<S.BoardOffer>("/v1/loan/post-offer", {
        banking_region: region,
        available_pence: a,
        ...(m !== null ? { min_principal_pence: m } : {}),
        daily_rate_bps: r,
        max_term_game_days: t,
        collateral_kind: kind,
        ...(secured ? { max_ltv_bps: l } : {}),
        recourse: secured ? recourse : true,
        expires_in_game_hours: h,
      }),
    );
  }

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <Field label="Amount to lend (Cr)">
          <Input type="number" min={100} step={0.01} value={available} onChange={(e) => setAvailable(e.target.value)} />
        </Field>
        <Field label="Smallest loan (Cr, optional)">
          <Input type="number" min={100} step={0.01} value={minimum} placeholder="all of it" onChange={(e) => setMinimum(e.target.value)} />
        </Field>
        <Field label="Rate (bps a game day)">
          <Input type="number" min={LOAN.rateMinBps} max={LOAN.rateMaxBps} step={1} value={rate} onChange={(e) => setRate(e.target.value)} />
        </Field>
        <Field label="Longest term (game days)">
          <Input type="number" min={1} max={LOAN.termMaxDays} step={1} value={term} onChange={(e) => setTerm(e.target.value)} />
        </Field>
        <Field label="Collateral">
          <NativeSelect value={kind} onChange={(e) => setKind(e.target.value as S.CollateralKind)}>
            {BOARD_KINDS.map((k) => (
              <option key={k} value={k}>
                {COLLATERAL_LABEL[k]}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field label="Max loan-to-value (%)">
          <Input type="number" min={0.01} max={100} step={0.01} value={secured ? ltv : ""} disabled={!secured} onChange={(e) => setLtv(e.target.value)} />
        </Field>
        <Field label="Expires in (game hours)">
          <Input type="number" min={1} max={LOAN.boardHoursMax} step={1} value={hours} onChange={(e) => setHours(e.target.value)} />
        </Field>
        <div className="flex items-end pb-1.5">
          <Checkbox checked={secured ? recourse : true} onChange={(v) => secured && setRecourse(v)}>
            With recourse
          </Checkbox>
        </div>
      </div>
      <CashLine region={region} cash={cash} need={a} />
      <p className="text-muted-foreground text-xs">
        The Goldsmiths charge {LOAN.goldsmithsRateBps} bps; a cheaper offer wins borrowers. Secured offers lend against a ship&apos;s rebuild value or goods at the
        local Crown bid. Lent money is exempt from the wealth levy.
      </p>
      <ErrorNote error={act.error ?? why} />
      {act.result && <p className="text-sm">Posted: {fmtCr(act.result.available_pence)} at {act.result.daily_rate_bps} bps, expires {fmtIn(act.result.expires_at)}.</p>}
      <Button className="w-full" disabled={!!why || act.busy} onClick={submit}>
        {act.busy ? "Posting…" : `Post offer in ${regionName(region)}`}
      </Button>
    </div>
  );
}

function PostRequestForm({
  region,
  ships,
  stock,
  pledged,
  fleet,
  onDone,
}: {
  region: string;
  ships: ShipResult[] | undefined;
  stock: S.PortWarehouseResult[] | undefined;
  pledged: Pledged;
  fleet: FleetFinance;
  onDone: () => void;
}) {
  const [principal, setPrincipal] = useState("");
  const [rate, setRate] = useState("40");
  const [term, setTerm] = useState("10");
  const [kind, setKind] = useState<S.CollateralKind>("ship_lien");
  const [pledge, setPledge] = useState<Pledge>(EMPTY_PLEDGE);
  const [recourse, setRecourse] = useState(true);
  const [hours, setHours] = useState(String(LOAN.boardHoursDefault));
  const act = useAction<S.BoardRequest>(onDone);
  const p = crToPence(principal);
  const r = num(rate);
  const t = num(term);
  const h = num(hours);
  const why = firstProblem([
    [p >= LOAN.minPrincipalPence, `Ask for at least ${fmtCr(LOAN.minPrincipalPence)}.`],
    [Number.isInteger(r) && r >= LOAN.rateMinBps && r <= LOAN.rateMaxBps, `Highest rate: ${LOAN.rateMinBps} to ${LOAN.rateMaxBps} bps a game day.`],
    [Number.isInteger(t) && t >= 1 && t <= LOAN.termMaxDays, `Term: 1 to ${LOAN.termMaxDays} game days.`],
    [pledgeProblem(kind, pledge) === null, pledgeProblem(kind, pledge) ?? ""],
    [Number.isInteger(h) && h >= 1 && h <= LOAN.boardHoursMax, `Expiry: 1 to ${LOAN.boardHoursMax} game hours.`],
  ]);

  function submit() {
    if (
      !confirm(
        `Ask for ${fmtCr(p)} in ${regionName(region)} for ${t} game days at up to ${r} bps a game day? An offer that crosses it is matched at once, without asking you again, and the money lands in your ${regionName(region)} vault.\n\n${DEFAULT_WARNING}`,
      )
    )
      return;
    void act.run(() =>
      kibbPost<S.BoardRequest>("/v1/loan/post-request", {
        banking_region: region,
        principal_pence: p,
        max_daily_rate_bps: r,
        term_game_days: t,
        collateral_kind: kind,
        ...pledgeBody(kind, pledge),
        recourse: kind === "unsecured" ? true : recourse,
        expires_in_game_hours: h,
      }),
    );
  }

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <Field label="Principal (Cr)">
          <Input type="number" min={100} step={0.01} value={principal} onChange={(e) => setPrincipal(e.target.value)} />
        </Field>
        <Field label="Highest rate (bps a game day)">
          <Input type="number" min={LOAN.rateMinBps} max={LOAN.rateMaxBps} step={1} value={rate} onChange={(e) => setRate(e.target.value)} />
        </Field>
        <Field label="Term (game days)">
          <Input type="number" min={1} max={LOAN.termMaxDays} step={1} value={term} onChange={(e) => setTerm(e.target.value)} />
        </Field>
        <Field label="Expires in (game hours)">
          <Input type="number" min={1} max={LOAN.boardHoursMax} step={1} value={hours} onChange={(e) => setHours(e.target.value)} />
        </Field>
        <Field label="Collateral">
          <NativeSelect
            value={kind}
            onChange={(e) => {
              setKind(e.target.value as S.CollateralKind);
              setPledge(EMPTY_PLEDGE);
            }}
          >
            {BOARD_KINDS.map((k) => (
              <option key={k} value={k}>
                {COLLATERAL_LABEL[k]}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <div className="flex items-end pb-1.5">
          <Checkbox checked={kind === "unsecured" ? true : recourse} onChange={(v) => kind !== "unsecured" && setRecourse(v)}>
            With recourse
          </Checkbox>
        </div>
      </div>
      <PledgeFields kind={kind} value={pledge} onChange={setPledge} ours ships={ships} stock={stock} pledged={pledged.byShip} />
      {kind === "ship_lien" && fleet.ships.has(pledge.shipId) && (
        <WarnBox>The fleet autopilot sails this ship. A lien doesn&apos;t stop it sailing, but it can&apos;t be sold, listed or pledged again until repaid.</WarnBox>
      )}
      <p className="text-muted-foreground text-xs">
        Nothing is escrowed. Unticking recourse asks for a non-recourse loan: only a non-recourse offer meets it, and it lends at most the pledge&apos;s appraisal.
      </p>
      <ErrorNote error={act.error ?? why} />
      {act.result && <p className="text-sm">Posted: {fmtCr(act.result.principal_pence)}, expires {fmtIn(act.result.expires_at)}.</p>}
      <Button className="w-full" disabled={!!why || act.busy} onClick={submit}>
        {act.busy ? "Posting…" : `Post request in ${regionName(region)}`}
      </Button>
    </div>
  );
}

function BoardTab({
  homeRegion,
  companyId,
  ourIds,
  ships,
  stock,
  pledged,
  vaults,
  fleet,
  onCredit,
  onDone,
}: {
  homeRegion: string;
  companyId: string | undefined;
  ourIds: Set<string>;
  ships: ShipResult[] | undefined;
  stock: S.PortWarehouseResult[] | undefined;
  pledged: Pledged;
  vaults: Vaults;
  fleet: FleetFinance;
  onCredit: (id: string) => void;
  onDone: () => void;
}) {
  const { portName, goodName } = useCatalog();
  const [region, setRegion] = useState("");
  const at = region || homeRegion;
  const { data: board, error, reload } = usePoll(() => kibbGet<S.CreditBoard>("/v1/loan/board", { banking_region: at }), 20_000, [at]);
  useLearnCompanies([
    ...(board?.offers ?? []).map((o) => [o.lender_company_id, o.lender_name] as [string, string]),
    ...(board?.requests ?? []).map((q) => [q.borrower_company_id, q.borrower_name] as [string, string]),
  ]);
  const [taking, setTaking] = useState<string | null>(null);
  const [form, setForm] = useState<"offer" | "request">("request");
  const act = useAction<unknown>(() => {
    void reload();
    onDone();
  });
  const done = () => {
    void reload();
    onDone();
  };
  const offer = board?.offers.find((o) => o.id === taking);
  const cash = vaults.cash(at);

  function withdraw(id: string, what: string, autopilot: boolean) {
    const ap = autopilot ? "\n\nThis is the fleet autopilot's idle-cash offer: it re-posts one on its next pass while idle cash is on (turn it off in the autopilot settings to stop)." : "";
    if (!confirm(`Withdraw your ${what} from the board?${ap}`)) return;
    void act.run(() => kibbPost<unknown>("/v1/loan/withdraw-board-entry", { entry_id: id }));
  }

  function fund(q: S.BoardRequest) {
    if (
      !confirm(
        `Lend ${fmtCr(q.principal_pence)} to ${q.borrower_name} at ${q.max_daily_rate_bps} bps a game day for ${q.term_game_days} game days from your ${regionName(q.banking_region)} vault${q.recourse ? ", with recourse" : ", WITHOUT recourse (a shortfall is forgiven)"}? Check its credit record first.`,
      )
    )
      return;
    void act.run(() => kibbPost<S.Loan>("/v1/loan/fund-request", { request_id: q.id }));
  }

  return (
    <div className="space-y-4">
      <div className="grid items-start gap-4 xl:grid-cols-3">
        <div className="space-y-4 xl:col-span-2">
          <Panel
            title={`Standing offers · ${regionName(at)}`}
            action={
              <div className="w-full sm:w-44">
                <RegionSelect value={at} onChange={setRegion} />
              </div>
            }
          >
            <ErrorNote error={error} />
            <ErrorNote error={act.error} className="mb-3" />
            {!board ? (
              !error && <Loading />
            ) : board.offers.length === 0 ? (
              <Empty>No standing offers in {regionName(at)}.</Empty>
            ) : (
              <Table head={["Lender", "Available", "Min loan", "Rate", "Max term", "Collateral", "Expires", ""]}>
                {board.offers.map((o) => {
                  const ours = o.lender_company_id === companyId;
                  const sibling = !ours && ourIds.has(o.lender_company_id);
                  const ap = ours && fleet.isAutopilotOffer(o.id);
                  return (
                    <tr key={o.id} className={o.id === taking ? "bg-accent" : undefined}>
                      <td>
                        <span className="inline-flex flex-wrap items-center gap-1">
                          <CompanyLabel id={o.lender_company_id} companyId={companyId} ourIds={ourIds} />
                          {ap && <Badge variant="warning" size="sm">autopilot</Badge>}
                        </span>
                      </td>
                      <td className="tabular-nums">{fmtCr(o.available_pence)}</td>
                      <td className="text-muted-foreground tabular-nums">{fmtCr(o.min_principal_pence)}</td>
                      <td>
                        <RateText bps={o.daily_rate_bps} />
                      </td>
                      <td className="whitespace-nowrap">{o.max_term_game_days} days</td>
                      <td className="text-xs">
                        {COLLATERAL_LABEL[o.collateral_kind]}
                        {o.max_ltv_bps ? ` ≤ ${o.max_ltv_bps / 100}%` : ""}
                        {!o.recourse && <span className="text-muted-foreground"> · non-recourse</span>}
                      </td>
                      <td className="whitespace-nowrap text-xs">{fmtIn(o.expires_at)}</td>
                      <td>
                        <div className="flex justify-end gap-1.5">
                          {!ours && (
                            <Button size="sm" variant="ghost" onClick={() => onCredit(o.lender_company_id)}>
                              Credit
                            </Button>
                          )}
                          {ours ? (
                            <Button size="sm" variant="outline" disabled={act.busy} onClick={() => withdraw(o.id, `offer of ${fmtCr(o.available_pence)}`, ap)}>
                              Withdraw
                            </Button>
                          ) : (
                            <Button size="sm" variant="outline" title={sibling ? "Another of your companies: dealt with as with any other" : undefined} onClick={() => setTaking(o.id)}>
                              Take
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </Table>
            )}
          </Panel>
          <Panel title={`Loan requests · ${regionName(at)}`}>
            {!board ? (
              !error && <Loading />
            ) : board.requests.length === 0 ? (
              <Empty>No loan requests in {regionName(at)}.</Empty>
            ) : (
              <Table head={["Borrower", "Principal", "Up to", "Term", "Pledge", "Expires", ""]}>
                {board.requests.map((q) => {
                  const ours = q.borrower_company_id === companyId;
                  const sibling = !ours && ourIds.has(q.borrower_company_id);
                  return (
                    <tr key={q.id}>
                      <td>
                        <CompanyLabel id={q.borrower_company_id} companyId={companyId} ourIds={ourIds} />
                      </td>
                      <td className="tabular-nums">{fmtCr(q.principal_pence)}</td>
                      <td>
                        <RateText bps={q.max_daily_rate_bps} />
                      </td>
                      <td className="whitespace-nowrap">{q.term_game_days} days</td>
                      <td className="text-xs">
                        {q.collateral_kind === "warehouse_goods"
                          ? `${fmtTons(q.collateral_tons ?? 0)} ${goodName(q.collateral_commodity_id)} at ${portName(q.collateral_port_id)}`
                          : q.collateral_kind === "ship_lien"
                            ? `Lien on ship ${shortId(q.collateral_ship_id)}`
                            : COLLATERAL_LABEL[q.collateral_kind]}
                        {!q.recourse && <span className="text-muted-foreground"> · non-recourse</span>}
                      </td>
                      <td className="whitespace-nowrap text-xs">{fmtIn(q.expires_at)}</td>
                      <td>
                        <div className="flex justify-end gap-1.5">
                          {!ours && (
                            <Button size="sm" variant="ghost" onClick={() => onCredit(q.borrower_company_id)}>
                              Credit
                            </Button>
                          )}
                          {ours ? (
                            <Button size="sm" variant="outline" disabled={act.busy} onClick={() => withdraw(q.id, `request for ${fmtCr(q.principal_pence)}`, false)}>
                              Withdraw
                            </Button>
                          ) : (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={act.busy || (cash !== undefined && cash < q.principal_pence)}
                              title={cash !== undefined && cash < q.principal_pence ? `Only ${fmtCr(cash)} in your ${regionName(at)} vault` : sibling ? "Another of your companies: dealt with as with any other" : undefined}
                              onClick={() => fund(q)}
                            >
                              Fund
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
              A request and an offer cross on their own when the request&apos;s rate reaches the offer&apos;s in the same region and collateral kind, and the
              principal, term, loan-to-value and recourse fit; the older entry sets the rate. Receivables aren&apos;t financed on the board.
            </p>
          </Panel>
        </div>
        <Panel
          title={offer ? "Take an offer" : form === "offer" ? "Post an offer" : "Post a request"}
          action={!offer && <Segmented value={form} onChange={setForm} options={[{ value: "request", label: "Borrow" }, { value: "offer", label: "Lend" }]} />}
        >
          {offer ? (
            <TakeOfferForm key={offer.id} offer={offer} ships={ships} stock={stock} pledged={pledged} vaults={vaults} fleet={fleet} onDone={done} onClose={() => setTaking(null)} />
          ) : form === "offer" ? (
            <PostOfferForm key={`o-${at}`} region={at} vaults={vaults} onDone={done} />
          ) : (
            <PostRequestForm key={`r-${at}`} region={at} ships={ships} stock={stock} pledged={pledged} fleet={fleet} onDone={done} />
          )}
        </Panel>
      </div>
    </div>
  );
}

// ── Goldsmiths ────────────────────────────────────────────────────────────────

function GoldsmithsTab({
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
  const [term, setTerm] = useState("10");
  const {
    data: quote,
    error: quoteError,
    reload,
  } = usePoll(shipId ? () => kibbGet<S.BackstopQuote>("/v1/loan/backstop-quote", { ship_id: shipId, banking_region: region }) : null, 60_000, [shipId, region]);
  useLearnCompanies(quote ? [[quote.lender_company_id, quote.lender_name]] : undefined);
  const q = quote && quote.ship_id === shipId && (!region || quote.banking_region === region) ? quote : undefined;
  const act = useAction<S.Loan>(() => {
    void reload();
    onDone();
  });
  const p = crToPence(principal);
  const t = num(term);
  const maxTerm = Math.min(LOAN.goldsmithsTermMaxDays, q?.max_term_game_days ?? LOAN.goldsmithsTermMaxDays);
  const lien = pledged.byShip.get(shipId);
  const ship = ships?.find((r) => r.ship.id === shipId);
  const why = firstProblem([
    [!!shipId, "Choose a ship to pledge."],
    [!lien, "That ship is already under a lien."],
    [!!q, "Waiting for the Goldsmiths' quote."],
    [p >= LOAN.minPrincipalPence, `Borrow at least ${fmtCr(LOAN.minPrincipalPence)}.`],
    [!q || p <= q.max_principal_pence, `The Goldsmiths lend at most ${fmtCr(q?.max_principal_pence)} against this ship now.`],
    [Number.isInteger(t) && t >= 1 && t <= maxTerm, `Term: 1 to ${maxTerm} game days.`],
  ]);

  function submit() {
    if (!q) return;
    if (
      !confirm(
        `Borrow ${fmtCr(p)} from ${q.lender_name} in ${regionName(q.banking_region)} at ${q.daily_rate_bps} bps a game day for ${t} game days (up to ${fmtCr(interestFor(p, q.daily_rate_bps, t))} interest), against a lien on ${ship?.ship.name ?? "this ship"}? With recourse: what the ship doesn't cover is claimed from your vaults.\n\n${DEFAULT_WARNING}`,
      )
    )
      return;
    void act.run(() =>
      kibbPost<S.Loan>("/v1/loan/borrow-backstop", { ship_id: shipId, ...(region ? { banking_region: region } : {}), principal_pence: p, term_game_days: t }),
    );
  }

  return (
    <div className="grid items-start gap-4 xl:grid-cols-2">
      <Panel title="Borrow from the Goldsmiths' Company">
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Ship to pledge">
              <ShipSelect ships={ships} value={shipId} onChange={setShipId} placeholder="Choose a ship…" filter={(r) => !pledged.byShip.has(r.ship.id)} />
            </Field>
            <Field label="Region (paid into and repaid from)">
              <RegionSelect value={region} onChange={setRegion} placeholder="Home region" />
            </Field>
          </div>
          <ErrorNote error={quoteError} />
          {q && (
            <KV
              rows={[
                ["Lender", q.lender_name],
                ["Ship's rebuild value", fmtCr(q.rebuild_value_pence)],
                ["Lends up to", `${fmtCr(q.max_principal_pence)} (${q.loan_to_value_bps / 100}% of rebuild, ${fmtCr(LOAN.goldsmithsMaxPence)} a loan at most)`],
                ["Rate", <RateText key="r" bps={q.daily_rate_bps} />],
                ["Longest term", `${q.max_term_game_days} game days`],
                ["Any loan's rate bounds", `${q.rate_floor_bps}–${q.rate_ceiling_bps} bps a game day`],
                ["Recourse", q.recourse ? "yes" : "no"],
              ]}
            />
          )}
          {shipId && fleet.ships.has(shipId) && (
            <WarnBox>
              The fleet autopilot sails this ship. A lien doesn&apos;t stop it sailing, but the ship can&apos;t be sold, listed or pledged again until repaid. The
              autopilot counts this loan against its debt cap and keeps back what it owes.
            </WarnBox>
          )}
          <div className="grid grid-cols-2 gap-3">
            <Field label="Principal (Cr)">
              <Input type="number" min={100} max={q ? q.max_principal_pence / 100 : undefined} step={0.01} value={principal} onChange={(e) => setPrincipal(e.target.value)} />
            </Field>
            <Field label={`Term (1–${maxTerm} game days)`}>
              <Input type="number" min={1} max={maxTerm} step={1} value={term} onChange={(e) => setTerm(e.target.value)} />
            </Field>
          </div>
          {q && p > 0 && Number.isFinite(t) && (
            <p className="text-muted-foreground text-xs">
              Up to {fmtCr(interestFor(p, q.daily_rate_bps, t))} interest; {fmtCr(p + interestFor(p, q.daily_rate_bps, t))} owed at maturity if nothing is repaid.
            </p>
          )}
          {q && <CashLine region={q.banking_region} cash={vaults.cash(q.banking_region)} />}
          <ErrorNote error={act.error ?? (shipId ? why : null)} />
          {act.result && (
            <p className="text-sm">
              Borrowed {fmtCr(act.result.principal_pence)}; it matures {fmtIn(act.result.matures_at)}.
            </p>
          )}
          <Button className="w-full" disabled={!!why || act.busy} onClick={submit}>
            {act.busy ? "Borrowing…" : "Borrow"}
          </Button>
        </div>
      </Panel>
      <Panel title="About the Goldsmiths">
        <div className="space-y-2 text-muted-foreground text-sm">
          <p>
            One per region, an NPC house that always lends against one of your ships: at most {LOAN.goldsmithsLtvBps / 100}% of its rebuild value and{" "}
            {fmtCr(LOAN.goldsmithsMaxPence)} a loan, at {LOAN.goldsmithsRateBps} bps a game day (about 15% over 30 days), for 1 to 30 game days, always with recourse.
            Dear on purpose: a player lender on the credit board can beat it.
          </p>
          <p>A liened ship can still sail before any default, but can&apos;t be listed, sold, pledged again or carry a venture until repaid. If it sinks the lien is lost and the loan stays owed.</p>
          <p>{DEFAULT_WARNING} A ship the Goldsmiths foreclose on is listed for sale.</p>
        </div>
      </Panel>
    </div>
  );
}

// ── Direct offers ─────────────────────────────────────────────────────────────

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

function DirectOfferTab({ homeRegion, companyId, vaults, onDone }: { homeRegion: string; companyId: string | undefined; vaults: Vaults; onDone: () => void }) {
  const names = useCompanyNames();
  const [borrower, setBorrower] = useState("");
  const [region, setRegion] = useState("");
  const [principal, setPrincipal] = useState("");
  const [rate, setRate] = useState("40");
  const [term, setTerm] = useState("10");
  const [kind, setKind] = useState<S.CollateralKind>("ship_lien");
  const [pledge, setPledge] = useState<Pledge>(EMPTY_PLEDGE);
  const [recourse, setRecourse] = useState(true);
  const [hours, setHours] = useState(String(LOAN.offerHoursDefault));
  const act = useAction<S.Loan>(onDone);
  const borrowerId = useResolveCompany(borrower);
  const at = region || homeRegion;
  const { data: credit, error: creditError } = usePoll(
    borrowerId ? () => kibbGet<S.CreditReport>("/v1/loan/credit", { company_id: borrowerId }) : null,
    0,
    [borrowerId],
  );
  const p = crToPence(principal);
  const r = num(rate);
  const t = num(term);
  const h = num(hours);
  const cash = vaults.cash(at);
  const why = firstProblem([
    [!!borrowerId, borrower.trim() ? "Unknown company: enter its id, or a name seen on the credit board or the banks list." : "Choose the borrower."],
    // Another of your companies is dealt with as with any other (guide 3: only a company dealing with itself is refused).
    [!borrowerId || borrowerId !== companyId, "You can't lend to this company itself."],
    [p >= LOAN.minPrincipalPence, `Lend at least ${fmtCr(LOAN.minPrincipalPence)}.`],
    [cash === undefined || p <= cash, `Only ${fmtCr(cash)} in your ${regionName(at)} vault.`],
    [Number.isInteger(r) && r >= LOAN.rateMinBps && r <= LOAN.rateMaxBps, `Rate: ${LOAN.rateMinBps} to ${LOAN.rateMaxBps} bps a game day.`],
    [Number.isInteger(t) && t >= 1 && t <= LOAN.termMaxDays, `Term: 1 to ${LOAN.termMaxDays} game days.`],
    [pledgeProblem(kind, pledge) === null, pledgeProblem(kind, pledge) ?? ""],
    [Number.isInteger(h) && h >= 1 && h <= LOAN.offerHoursMax, `The offer stands 1 to ${LOAN.offerHoursMax} game hours.`],
  ]);
  const bad = credit && credit.company_id === borrowerId && (credit.loans_defaulted > 0 || credit.defaulted_open_loans > 0 || !!credit.bankrupt_at);

  function submit() {
    if (
      !confirm(
        `Offer ${names.label(borrowerId)} ${fmtCr(p)} at ${r} bps a game day for ${t} game days (${COLLATERAL_LABEL[kind].toLowerCase()}${kind === "unsecured" || recourse ? ", with recourse" : ", non-recourse"})? The principal is escrowed from your ${regionName(at)} vault until they accept or decline, you withdraw, or it lapses.${bad ? "\n\nTheir credit record shows defaults." : ""}`,
      )
    )
      return;
    void act.run(() =>
      kibbPost<S.Loan>("/v1/loan/offer", {
        borrower_company_id: borrowerId,
        banking_region: at,
        principal_pence: p,
        daily_rate_bps: r,
        term_game_days: t,
        recourse: kind === "unsecured" ? true : recourse,
        collateral_kind: kind,
        ...pledgeBody(kind, pledge),
        offer_game_hours: h,
      }),
    );
  }

  return (
    <div className="grid items-start gap-4 xl:grid-cols-2">
      <Panel title="Offer a loan to a company">
        <div className="space-y-3">
          <Field label="Borrower (name or company id)">
            <Input list="loan-borrowers" value={borrower} onChange={(e) => setBorrower(e.target.value)} placeholder="Company name or id" />
            <CompanyDatalist id="loan-borrowers" />
          </Field>
          {borrowerId && (
            <p className="text-muted-foreground text-xs">
              {names.nameOf(borrowerId) ?? "Name not seen yet"} · <span className="font-mono">{borrowerId}</span>
            </p>
          )}
          <div className="grid grid-cols-2 gap-3">
            <Field label="Region (escrowed from, repaid into)">
              <RegionSelect value={at} onChange={setRegion} />
            </Field>
            <Field label="Principal (Cr)">
              <Input type="number" min={100} step={0.01} value={principal} onChange={(e) => setPrincipal(e.target.value)} />
            </Field>
            <Field label="Rate (bps a game day)">
              <Input type="number" min={LOAN.rateMinBps} max={LOAN.rateMaxBps} step={1} value={rate} onChange={(e) => setRate(e.target.value)} />
            </Field>
            <Field label="Term (game days)">
              <Input type="number" min={1} max={LOAN.termMaxDays} step={1} value={term} onChange={(e) => setTerm(e.target.value)} />
            </Field>
            <Field label="Collateral">
              <NativeSelect
                value={kind}
                onChange={(e) => {
                  setKind(e.target.value as S.CollateralKind);
                  setPledge(EMPTY_PLEDGE);
                }}
              >
                {OFFER_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {COLLATERAL_LABEL[k]}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field label="Offer stands (game hours)">
              <Input type="number" min={1} max={LOAN.offerHoursMax} step={1} value={hours} onChange={(e) => setHours(e.target.value)} />
            </Field>
          </div>
          <PledgeFields kind={kind} value={pledge} onChange={setPledge} ours={false} />
          <Checkbox checked={kind === "unsecured" ? true : recourse} onChange={(v) => kind !== "unsecured" && setRecourse(v)}>
            With recourse (claim what the collateral doesn&apos;t cover)
          </Checkbox>
          {kind === "contract_receivable" && (
            <p className="text-muted-foreground text-xs">
              Invoice financing: against what the borrower stands to be paid on an accepted freight contract or commission (the carrier&apos;s reward or the
              builder&apos;s price, or for the issuer or buyer the collateral its counterparty forfeits on failure). When the contract pays the borrower, you are paid
              first. If it closes without paying, the receivable is lost. One financing per contract and party.
            </p>
          )}
          {!recourse && kind !== "unsecured" && (
            <p className="text-muted-foreground text-xs">A non-recourse loan may lend at most the pledge&apos;s appraisal, and a shortfall after it is forgiven.</p>
          )}
          <CashLine region={at} cash={cash} need={p} />
          <ErrorNote error={act.error ?? (borrower || principal ? why : null)} />
          {act.result && <p className="text-sm">Offered: {fmtCr(act.result.principal_pence)}, lapses {fmtIn(act.result.offer_expires_at)}.</p>}
          <Button className="w-full" disabled={!!why || act.busy} onClick={submit}>
            {act.busy ? "Offering…" : "Offer loan"}
          </Button>
        </div>
      </Panel>
      <Panel title="Borrower's credit record">
        {!borrowerId ? (
          <Empty>Choose a borrower to see its record.</Empty>
        ) : (
          <>
            <ErrorNote error={creditError} />
            {credit && credit.company_id === borrowerId ? <CreditRecordView report={credit} /> : !creditError && <Loading />}
          </>
        )}
      </Panel>
    </div>
  );
}

// ── Credit records ────────────────────────────────────────────────────────────

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
                {profile.company_name} exists (home port {portName(profile.home_port_id)}), but its id isn&apos;t public: find it on a credit board, the banks list
                or a venture, then look it up from there.
              </p>
            ) : (
              <Loading />
            )
          ) : (
            <Empty>Names seen on the credit boards, banks and your loans resolve to their records.</Empty>
          )}
        </div>
      </Panel>
      <Panel title="Reading a record">
        <div className="space-y-2 text-muted-foreground text-sm">
          <p>Anyone&apos;s record is public: what it owes now, defaulted debt still open, loans repaid, defaulted and written off, futures default claims, what it has lent, and any bankruptcy.</p>
          <p>Check it before lending, depositing or investing. Defaults stay on a record for good.</p>
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
  const fleet = useFleetFinance();
  const vaults = useVaults();
  const pledged = usePledgedShips();
  const owed = usePoll(() => loansOf("borrower", ["active", "defaulted"]), 20_000);
  const offered = usePoll(() => loansOf("borrower", ["offered"]), 20_000);
  const lent = usePoll(() => loansOf("lender", ["offered", "active", "defaulted"]), 20_000);
  const [tab, setTab] = useState("loans");
  const [lookup, setLookup] = useState("");
  const [historyKey, setHistoryKey] = useState(0);
  const homeRegion = regionOf(profile?.company.home_port_id) ?? "channel";
  const shipName = (id: string) => ships?.find((r) => r.ship.id === id)?.ship.name;
  const refresh = () => {
    void owed.reload();
    void offered.reload();
    void lent.reload();
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
  const next = owing.filter((l) => l.status === "active" && l.matures_at).sort((a, b) => Date.parse(a.matures_at!) - Date.parse(b.matures_at!))[0];
  const out = (lent.data ?? []).filter((l) => l.status !== "offered").reduce((n, l) => n + l.owed_pence, 0);
  const escrowed = (lent.data ?? []).filter((l) => l.status === "offered").reduce((n, l) => n + l.principal_pence, 0);
  const f = fleet.finance;
  const apLoans = f?.borrowed.filter((r) => r.purpose) ?? [];

  return (
    <div className="space-y-5 pb-8 sm:space-y-6">
      <PageHeader
        title="Loans"
        subtitle="Borrow and lend between companies in one banking region, on the credit board or by direct offer; the Goldsmiths' Company lends against any of your ships."
        badges={defaulted.length > 0 && <Badge variant="error">{defaulted.length} defaulted</Badge>}
      />
      <Metrics
        items={[
          { label: "You owe", value: owed.data ? fmtCr(totalOwed) : "…", hint: `${owing.length} loan${owing.length === 1 ? "" : "s"}` },
          { label: "Next maturity", value: next ? fmtIn(next.matures_at) : "—", hint: next ? fmtCr(next.owed_pence) : undefined },
          { label: "Owed to you", value: lent.data ? fmtCr(out) : "…" },
          { label: "Offers escrowed", value: lent.data ? fmtCr(escrowed) : "…", hint: "your direct offers" },
          { label: "Offers to you", value: offered.data ? String(offered.data.length) : "…" },
          {
            label: "Autopilot debt",
            value: f ? fmtCr(f.debtPence) : "—",
            hint: f ? (f.capPence !== null ? `cap ${fmtCr(f.capPence)}` : "cap unknown") : fleet.running ? "no report yet" : "autopilot off",
          },
        ]}
      />
      {defaulted.length > 0 && (
        <WarnBox tone="error">
          <p>
            {defaulted.length} loan{defaulted.length === 1 ? " has" : "s have"} defaulted ({fmtCr(defaulted.reduce((n, l) => n + l.owed_pence, 0))} owed). A ship
            pledged to it is arrested: it can&apos;t depart or join a convoy until the lender has it or you pay. Repay below to clear the claim.
          </p>
        </WarnBox>
      )}
      {f && (f.debtPence > 0 || f.offers.length > 0 || f.short) && (
        <WarnBox tone={f.short ? "error" : "info"}>
          {f.short && <p className="font-medium">Autopilot repayment short: {f.short}. It stops new spending until it is paid.</p>}
          <p>
            The fleet autopilot {fleet.running ? "manages" : "managed (it is stopped now)"} loans too: it owes {fmtCr(f.debtPence)}
            {f.capPence !== null ? ` of a ${fmtCr(f.capPence)} cap` : ""} and keeps {fmtCr(f.fencePence)} back to repay.
            {apLoans.length > 0 &&
              (fleet.running
                ? ` Loans marked "autopilot" (${apLoans.length}) are its own: it repays them itself, early when cash allows and in full 2 game days before maturity, so repaying them by hand is never needed.`
                : ` Loans marked "autopilot" (${apLoans.length}) are its own, but while it is stopped nobody repays them: repay them before they mature.`)}{" "}
            {fleet.running && "Loans you take by hand count against its cap; it repays them only in their last 2 game days, or once defaulted."}
            {f.offers.length > 0 &&
              ` Its idle-cash offers on the credit board (${fmtCr(f.offers.reduce((n, o) => n + o.availablePence, 0))}) are marked "autopilot": withdrawn by hand, it posts again on its next pass while idle cash is on.`}
          </p>
        </WarnBox>
      )}
      <Tabs value={tab} onValueChange={(v) => setTab(String(v))}>
        <TabsList>
          <TabsTab value="loans">Your loans</TabsTab>
          <TabsTab value="board">Credit board</TabsTab>
          <TabsTab value="goldsmiths">Goldsmiths</TabsTab>
          <TabsTab value="offer">Offer a loan</TabsTab>
          <TabsTab value="credit">Credit records</TabsTab>
        </TabsList>
        <TabsPanel value="loans" className="space-y-4 pt-2">
          <OffersToMe loans={offered.data} error={offered.error} companyId={companyId} ourIds={ourIds} shipName={shipName} fleet={fleet} onDone={refresh} />
          <OwedPanel loans={owed.data} error={owed.error} vaults={vaults} fleet={fleet} shipName={shipName} onDone={refresh} />
          <LentPanel loans={lent.data} error={lent.error} companyId={companyId} ourIds={ourIds} onCredit={credit} onDone={refresh} />
          <HistoryPanel refreshKey={historyKey} companyId={companyId} shipName={shipName} />
        </TabsPanel>
        <TabsPanel value="board" className="pt-2">
          <BoardTab
            homeRegion={homeRegion}
            companyId={companyId}
            ourIds={ourIds}
            ships={ships}
            stock={stock}
            pledged={pledged}
            vaults={vaults}
            fleet={fleet}
            onCredit={credit}
            onDone={refresh}
          />
        </TabsPanel>
        <TabsPanel value="goldsmiths" className="pt-2">
          <GoldsmithsTab ships={ships} pledged={pledged} vaults={vaults} fleet={fleet} onDone={refresh} />
        </TabsPanel>
        <TabsPanel value="offer" className="pt-2">
          <DirectOfferTab homeRegion={homeRegion} companyId={companyId} vaults={vaults} onDone={refresh} />
        </TabsPanel>
        <TabsPanel value="credit" className="pt-2">
          <CreditTab query={lookup} onQuery={setLookup} />
        </TabsPanel>
      </Tabs>
      <p className="text-muted-foreground text-xs">
        Every loan is paid vault to vault in one banking region. Money lent, on deposit or in a venture is exempt from the wealth levy on idle cash above 500,000 Cr.
        See also <Link href="/banks" className="text-primary hover:underline">banks</Link> and your <Link href="/treasury" className="text-primary hover:underline">vaults</Link>.
      </p>
    </div>
  );
}
